'use strict';

const db = require('../db');

/**
 * Generate today's news budget for a tenant using Maxwell.
 * Returns the created news_budgets row, or null on failure.
 */
async function generateDailyBudget(tenantId) {
  const today = new Date().toISOString().slice(0, 10);

  // Idempotent — don't regenerate if one already exists for today
  const existing = await db.prepare(
    "SELECT id FROM news_budgets WHERE tenant_id = $1 AND budget_date = $2"
  ).get(tenantId, today);
  if (existing) return { skipped: 'already_exists', budget_id: existing.id };

  try {
    const { complete: aiComplete } = require('./ai-router');
    const { loadPrompt } = require('./prompt-loader');
    const { getSiteConfig } = require('./site-config');

    const site = await getSiteConfig(tenantId);
    const persona = site.ai_persona || 'You are the editorial director of a tech news publication.';

    // --- Gather context ---

    // 1. Pulse clusters (top 10 by momentum)
    const pulseClusters = await _getPulseClusters(tenantId);

    // 2. Pending pitches
    const pendingPitches = await db.prepare(`
      SELECT ap.id, ap.angle_summary, ap.status, a.title AS source_title,
             w.name AS writer_name
      FROM article_pitches ap
      LEFT JOIN articles a ON a.id = ap.source_article_id
      LEFT JOIN writers w ON w.id = ap.pitched_by_writer_id AND w.tenant_id = ap.tenant_id
      WHERE ap.tenant_id = $1
        AND ap.status IN ('proposed', 'approved')
        AND ap.spawned_article_id IS NULL
      ORDER BY ap.created_at DESC
      LIMIT 15
    `).all(tenantId);

    // 3. Beat gaps (writers silent for 3+ days)
    const beatGaps = await db.prepare(`
      SELECT w.id, w.name,
             EXTRACT(DAY FROM NOW() - MAX(a.published_at))::int AS days_silent
      FROM writers w
      LEFT JOIN articles a ON a.writer_id = w.id
        AND a.tenant_id = w.tenant_id
        AND a.is_published = 1
      WHERE w.tenant_id = $1 AND w.is_auto = true
      GROUP BY w.id, w.name
      HAVING MAX(a.published_at) < NOW() - INTERVAL '3 days'
          OR MAX(a.published_at) IS NULL
      ORDER BY days_silent DESC NULLS FIRST
      LIMIT 5
    `).all(tenantId);

    // 4. Active story threads
    const activeThreads = await db.prepare(`
      SELECT topic_tag, name, article_count, last_update_at
      FROM story_threads
      WHERE tenant_id = $1 AND status = 'active'
        AND last_update_at > NOW() - INTERVAL '48 hours'
      ORDER BY last_update_at DESC
      LIMIT 8
    `).all(tenantId);

    // --- Format context for prompt ---
    const pulseSummary = pulseClusters.length
      ? pulseClusters.map(c =>
          `- [${c.topic_tag}] ${c.article_count} articles, ${c.source_count} sources, momentum: ${c.momentum}, tier: ${c.tier}` +
          (c.articles?.length ? `\n  Recent: ${c.articles.slice(0, 2).map(a => `[${a.id}] "${a.generated_title || a.title}"`).join('; ')}` : '')
        ).join('\n')
      : 'No active clusters at this time.';

    const pendingPitchesStr = pendingPitches.length
      ? pendingPitches.map(p =>
          `- [pitch:${p.id}] "${p.angle_summary}" (${p.status})${p.source_title ? ` — source: "${p.source_title}"` : ''}${p.writer_name ? ` — writer: ${p.writer_name}` : ''}`
        ).join('\n')
      : 'No pending pitches.';

    const beatGapsStr = beatGaps.length
      ? beatGaps.map(w => `- ${w.name} (id:${w.id}) — silent ${w.days_silent ?? '?'} days`).join('\n')
      : 'All writers active recently.';

    const activeThreadsStr = activeThreads.length
      ? activeThreads.map(t =>
          `- [${t.topic_tag}] "${t.name || t.topic_tag}" — ${t.article_count} articles, last updated ${new Date(t.last_update_at).toLocaleString()}`
        ).join('\n')
      : 'No active threads.';

    const p = loadPrompt('daily-news-budget');
    const { messages } = p.render({
      persona,
      today,
      pulseSummary,
      pendingPitches: pendingPitchesStr,
      beatGaps: beatGapsStr,
      activeThreads: activeThreadsStr,
    });

    const result = await aiComplete({
      operation: 'daily-news-budget',
      tenantId,
      messages,
      temperature: 0.4,
      maxTokens: 2000,
      trigger: 'cron',
    });

    if (!result?.text) throw new Error('AI returned no content');

    const cleaned = result.text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    // Find Maxwell's writer row
    const maxwell = await db.prepare(
      "SELECT id FROM writers WHERE tenant_id = $1 AND role = 'editor' AND is_system = true LIMIT 1"
    ).get(tenantId);

    // Insert budget
    const budget = await db.prepare(`
      INSERT INTO news_budgets (tenant_id, budget_date, status, editorial_note, coverage_gaps, beat_alerts, created_by_writer_id)
      VALUES ($1, $2, 'draft', $3, $4::jsonb, $5::jsonb, $6)
      RETURNING *
    `).get(
      tenantId, today,
      (parsed.editorial_note || '').slice(0, 1000),
      JSON.stringify(parsed.coverage_gaps || []),
      JSON.stringify(parsed.beat_alerts || []),
      maxwell?.id || null,
    );

    // Insert slots
    const slots = (parsed.slots || []).slice(0, 15);
    const PRIORITY_ORDER = { lead: 0, standard: 1, brief: 2, hold: 3 };
    slots.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1));

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];

      // Resolve target_publish_at from window string "HH:MM-HH:MM"
      let targetPublishAt = null;
      if (s.target_publish_window) {
        const startTime = s.target_publish_window.split('-')[0];
        if (startTime && /^\d{2}:\d{2}$/.test(startTime)) {
          targetPublishAt = `${today}T${startTime}:00Z`;
        }
      }

      // Validate source_ids are integers
      const sourceIds = (s.source_ids || []).filter(id => Number.isInteger(id));

      await db.prepare(`
        INSERT INTO news_budget_slots
          (budget_id, tenant_id, priority, pitch_type, topic_tag, headline_suggestion,
           rationale, recommended_writer_id, target_publish_at, source_article_ids, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
      `).run(
        budget.id, tenantId,
        s.priority || 'standard',
        s.pitch_type || 'original',
        (s.topic_tag || '').slice(0, 200) || null,
        (s.headline_suggestion || '').slice(0, 500),
        (s.rationale || '').slice(0, 1000) || null,
        s.recommended_writer_id || null,
        targetPublishAt,
        JSON.stringify(sourceIds),
        i,
      );
    }

    console.log(`[news-budget] Generated budget for tenant ${tenantId}: ${slots.length} slots`);
    return { ok: true, budget_id: budget.id, slot_count: slots.length };
  } catch (err) {
    console.error(`[news-budget] generateDailyBudget failed (tenant ${tenantId}):`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Fetch top pulse clusters for budget context.
 * Re-uses the same query logic as the topic-pulse API.
 */
async function _getPulseClusters(tenantId) {
  try {
    const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
    const rows = await db.prepare(`
      SELECT
        a.topic_tag,
        COUNT(*) FILTER (WHERE a.content_type IN ('original','deep-dive') AND a.is_published = 1)::int AS article_count,
        COUNT(*) FILTER (WHERE a.content_type = 'curated')::int AS source_count,
        MAX(COALESCE(a.published_at, a.created_at)) AS latest_at,
        JSON_AGG(
          JSON_BUILD_OBJECT('id', a.id, 'title', a.title, 'generated_title', a.generated_title)
          ORDER BY COALESCE(a.published_at, a.created_at) DESC
        ) FILTER (WHERE a.content_type IN ('original','deep-dive') AND a.is_published = 1) AS articles
      FROM articles a
      WHERE a.tenant_id = $1
        AND a.topic_tag IS NOT NULL
        AND COALESCE(a.published_at, a.created_at) > $2
        AND (a.is_archived = 0 OR a.is_archived IS NULL)
      GROUP BY a.topic_tag
      HAVING COUNT(*) FILTER (WHERE a.content_type = 'curated') >= 2
          OR COUNT(*) FILTER (WHERE a.content_type IN ('original','deep-dive') AND a.is_published = 1) >= 1
      ORDER BY article_count DESC, source_count DESC
      LIMIT 12
    `).all(tenantId, cutoff);

    return rows.map(r => ({
      ...r,
      momentum: Math.min(5, (r.source_count || 0) + Math.min(2, r.article_count || 0)),
      tier: r.article_count >= 2 ? 'major' : r.article_count >= 1 ? 'trending' : 'forming',
      articles: r.articles ? (typeof r.articles === 'string' ? JSON.parse(r.articles) : r.articles).slice(0, 3) : [],
    }));
  } catch (err) {
    console.error('[news-budget] _getPulseClusters failed:', err.message);
    return [];
  }
}

/**
 * Auto-promote pending slots on budgets whose auto_promote_at has passed.
 * Creates a story_pitches row for each slot that can be promoted (has a writer).
 * Should be called from a cron job or inline after budget generation.
 *
 * @param {number} tenantId
 * @returns {Promise<{ promoted: number, skipped: number, errors: number }>}
 */
async function autoPromoteSlots(tenantId) {
  let promoted = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // Find budgets past their auto_promote_at threshold that are still in draft
    const budgets = await db.prepare(`
      SELECT id FROM news_budgets
      WHERE tenant_id = $1
        AND status = 'draft'
        AND auto_promote_at IS NOT NULL
        AND auto_promote_at <= NOW()
    `).all(tenantId);

    if (!budgets.length) return { promoted, skipped, errors };

    const budgetIds = budgets.map(b => b.id);

    // Fetch all pending slots for these budgets
    const slots = await db.prepare(`
      SELECT * FROM news_budget_slots
      WHERE budget_id = ANY($1::int[])
        AND tenant_id = $2
        AND status = 'pending'
    `).all(JSON.stringify(budgetIds), tenantId);

    for (const slot of slots) {
      const writerId = slot.assigned_writer_id || slot.recommended_writer_id;
      if (!writerId) {
        skipped++;
        continue;
      }

      try {
        const pitch = await db.prepare(`
          INSERT INTO story_pitches
            (tenant_id, writer_id, pitch_type, headline, reasoning, source_article_ids, status)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'proposed')
          RETURNING *
        `).get(
          tenantId,
          writerId,
          slot.pitch_type || 'original',
          (slot.headline_suggestion || '').slice(0, 300),
          (slot.rationale || '').slice(0, 500),
          JSON.stringify(
            Array.isArray(slot.source_article_ids)
              ? slot.source_article_ids
              : (typeof slot.source_article_ids === 'string' ? JSON.parse(slot.source_article_ids || '[]') : [])
          ),
        );

        await db.prepare(`
          UPDATE news_budget_slots
          SET status = 'auto_promoted', spawned_pitch_id = $3, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2
        `).run(slot.id, tenantId, pitch.id);

        promoted++;
      } catch (err) {
        console.error(`[news-budget] autoPromoteSlots: slot ${slot.id} failed:`, err.message);
        errors++;
      }
    }

    console.log(`[news-budget] autoPromoteSlots tenant=${tenantId}: promoted=${promoted} skipped=${skipped} errors=${errors}`);
  } catch (err) {
    console.error(`[news-budget] autoPromoteSlots failed (tenant ${tenantId}):`, err.message);
  }

  return { promoted, skipped, errors };
}

module.exports = { generateDailyBudget, autoPromoteSlots };
