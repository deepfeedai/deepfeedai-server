/**
 * Writer Agent — proactive story evaluation and pitching.
 * Agents scan incoming sources against their beats, memories, and recent coverage
 * to pitch stories worth writing.
 */
const db = require('../db');
const { complete: aiComplete } = require('./ai-router');
const { loadPrompt } = require('./prompt-loader');
const { buildWriterPrompt } = require('./writer-assign');
const { getRelevantMemories } = require('./writer-memory');
const { searchAll } = require('./research');
const { ingestExternalResults } = require('./research/ingest');
const { isFeatureEnabled } = require('./feature-registry');
const { recordEvent } = require('./newsroom-events');
const { PITCH_TYPE_KEYS, normalisePitchType } = require('./pitch-types');

// LLMs occasionally emit markdown markers (**bold**, _italic_, # headings,
// `code`, > quotes) inside the brief's prose/headline despite the prompt
// asking for plain text. The UI HTML-escapes these fields, so the markers
// would otherwise render as literal characters — the source of intermittent
// "brief doesn't format correctly" reports. Strip the common markers so
// rendered output is consistent regardless of model output.
function stripMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/```[\s\S]*?```/g, '')           // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')              // inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '')            // blockquote markers
    // Inline bullet markers: LLMs sometimes emit "Sentence. * Next bullet."
    // all on one line. Detect "[.!?] [-*+] [A-Z]" and turn it into a real
    // paragraph break before the line-start stripper runs.
    .replace(/([.!?])\s+[*\-+]\s+(?=[A-Z])/g, '$1\n\n')
    .replace(/^\s*[-*+]\s+/gm, '')            // line-start bullet markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')        // **bold**
    .replace(/__([^_]+)__/g, '$1')            // __bold__
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, '$1$2')  // *italic*
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1$2')    // _italic_
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](link) → text
    .replace(/\n{3,}/g, '\n\n')               // collapse runs of blank lines
    .trim();
}

/**
 * Evaluate incoming source articles and generate story pitches for a writer.
 * Called by the agent-scan cron job.
 *
 * @param {number} writerId
 * @param {number} tenantId
 * @returns {Promise<{ pitches: Array, reason: string|null }>}
 */
async function evaluateIncomingArticles(writerId, tenantId) {
  const writer = await db.prepare(
    'SELECT id, name, keywords FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);
  if (!writer) return { pitches: [], reason: 'no_writer' };

  // Parse keywords — stored as native TEXT[] in PostgreSQL; may arrive as a
  // JS array already, or occasionally as a JSON string on older rows.
  let writerKeywords = null;
  if (writer.keywords) {
    if (Array.isArray(writer.keywords)) {
      writerKeywords = writer.keywords.filter(Boolean);
    } else if (typeof writer.keywords === 'string') {
      try { writerKeywords = JSON.parse(writer.keywords).filter(Boolean); } catch { writerKeywords = null; }
    }
    if (writerKeywords && !writerKeywords.length) writerKeywords = null;
  }

  // Get writer's beat categories
  const beats = await db.prepare(`
    SELECT c.name FROM writer_beats wb
    JOIN categories c ON c.id = wb.category_id
    WHERE wb.writer_id = $1 AND wb.tenant_id = $2
  `).all(writerId, tenantId);
  const beatNames = beats.map(b => b.name);
  if (!beatNames.length) return { pitches: [], reason: 'no_beats' };

  // Get recent source articles in writer's beats (last 6 hours, not yet pitched).
  // Fix 2: also match on writer keywords so miscategorised articles surface.
  const sources = await db.prepare(`
    SELECT a.id, a.title, a.summary, a.category, a.source, a.created_at
    FROM articles a
    WHERE a.tenant_id = $1
      AND (a.content_type IS NULL OR a.content_type = 'curated')
      AND a.is_archived = 0
      AND (
        a.category = ANY($2)
        OR ($3::text[] IS NOT NULL AND array_length($3::text[], 1) > 0
            AND EXISTS (
              SELECT 1 FROM unnest($3::text[]) AS k
              WHERE a.title ILIKE '%' || k || '%'
                 OR a.summary ILIKE '%' || k || '%'
            ))
      )
      AND a.created_at > NOW() - INTERVAL '6 hours'
      AND a.id NOT IN (
        SELECT DISTINCT jsonb_array_elements_text(sp.source_article_ids)::int
        FROM story_pitches sp
        WHERE sp.tenant_id = $1 AND sp.writer_id = $4
          AND sp.created_at > NOW() - INTERVAL '24 hours'
      )
    ORDER BY a.created_at DESC
    LIMIT 30
  `).all(tenantId, beatNames, writerKeywords, writerId);

  if (sources.length < 2) return { pitches: [], reason: 'pool_too_small' }; // Not enough material to evaluate

  // Get writer's active memories
  const memories = await getRelevantMemories(writerId, tenantId, beatNames.join(' '), 10);

  // Get recent published articles by this writer
  const recentArticles = await db.prepare(`
    SELECT COALESCE(generated_title, title) AS title, summary, category FROM articles
    WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive')
      AND is_published = 1
    ORDER BY published_at DESC LIMIT 5
  `).all(writerId, tenantId);

  // Re-fetch writer with all columns needed for persona building
  const writerFull = await db.prepare(
    'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);

  // Build persona
  const persona = await buildWriterPrompt(writerFull, { recentArticles, memories });

  // Format sources for prompt
  const sourcesText = sources.map((s, i) => {
    const summary = (s.summary || '').replace(/<[^>]+>/g, '').slice(0, 200);
    return `[${s.id}] "${s.title}" (${s.source}, ${s.category}) — ${summary}`;
  }).join('\n');

  const memoriesText = memories.length
    ? memories.map(m => `- [${m.memory_type}] ${m.subject}: ${m.content}`).join('\n')
    : 'No active memories yet.';

  const recentText = recentArticles.length
    ? recentArticles.map(a => `- "${a.title}" (${a.category})`).join('\n')
    : 'No recent articles.';

  // Call AI
  const p = loadPrompt('agent-pitch');
  const { messages, ...meta } = p.render({
    persona,
    sources: sourcesText,
    memories: memoriesText,
    recentArticles: recentText,
  });

  const result = await aiComplete({
    ...meta, messages, tenantId,
    trigger: 'agent-scan',
    writerId,
  });

  if (!result?.text) return { pitches: [], reason: 'no_sources' };

  // Parse pitches
  let pitches;
  try {
    const cleaned = result.text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    pitches = JSON.parse(cleaned);
    if (!Array.isArray(pitches)) return { pitches: [], reason: 'ai_parse_fail' };
  } catch { return { pitches: [], reason: 'ai_parse_fail' }; }

  const validTypes = new Set(PITCH_TYPE_KEYS);
  const stored = [];

  for (const pitch of pitches.slice(0, 3)) {
    if (!pitch.headline || !pitch.reasoning) continue;
    const pitchType = normalisePitchType(pitch.type);
    if (!validTypes.has(pitchType)) continue;

    const sourceIds = Array.isArray(pitch.source_ids) ? pitch.source_ids.filter(id => typeof id === 'number') : [];
    const memoryRefs = Array.isArray(pitch.memory_refs) ? pitch.memory_refs : [];
    const priority = Math.min(10, Math.max(1, parseFloat(pitch.priority) || 5));

    // Fix 3: cross-writer dedup — skip if another writer already pitched the
    // same source article set (overlap check) in the last 24 hours.
    // story_pitches has no topic_tag column, so use source_article_ids overlap.
    if (sourceIds.length > 0) {
      const dupCheck = await db.prepare(`
        SELECT id FROM story_pitches
        WHERE tenant_id = $1
          AND writer_id != $2
          AND created_at > NOW() - INTERVAL '24 hours'
          AND source_article_ids ?| $3::text[]
        LIMIT 1
      `).get(tenantId, writerId, sourceIds.map(String));
      if (dupCheck) continue; // another writer already pitched these sources
    }

    const row = await db.prepare(`
      INSERT INTO story_pitches (tenant_id, writer_id, pitch_type, headline, reasoning, source_article_ids, memory_refs, priority)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `).get(
      tenantId, writerId, pitchType,
      pitch.headline.slice(0, 300),
      pitch.reasoning.slice(0, 500),
      JSON.stringify(sourceIds),
      JSON.stringify(memoryRefs),
      priority
    );

    if (row) {
      stored.push(row);
      require('./newsroom-events').emitPitchProposed(row, tenantId).catch(() => {});
    }
  }

  // Notify all editors/admins/owners so new pitches show a bell badge.
  if (stored.length) {
    const { notify } = require('./notifications');
    try {
      const editors = await db.prepare(
        `SELECT id FROM users WHERE tenant_id = $1 AND is_active = 1 AND role IN ('owner','admin','editor')`
      ).all(tenantId);
      for (const ed of editors) {
        for (const pitch of stored) {
          notify({
            tenantId, userId: ed.id, kind: 'pitch_created',
            title: 'New pitch',
            body: pitch.headline,
            payload: { pitch_id: pitch.id, pitch_type: pitch.pitch_type, writer_id: writerId },
            actionable: [
              { label: 'Approve', actionKind: 'story_pitch.approve', targetId: pitch.id, targetType: 'story_pitch' },
              { label: 'Dismiss', actionKind: 'story_pitch.dismiss', targetId: pitch.id, targetType: 'story_pitch' },
            ],
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[writer-agent] notify pitches failed:', err.message);
    }
  }

  return { pitches: stored, reason: null };
}

/**
 * Check writer predictions approaching expiry against recent sources.
 */
async function checkPredictions(writerId, tenantId) {
  const predictions = await db.prepare(`
    SELECT * FROM writer_memory
    WHERE writer_id = $1 AND tenant_id = $2
      AND memory_type = 'prediction'
      AND expires_at IS NOT NULL
      AND expires_at > NOW()
      AND expires_at < NOW() + INTERVAL '14 days'
    ORDER BY expires_at ASC
  `).all(writerId, tenantId);

  if (!predictions.length) return [];

  // Look for recent sources that mention prediction subjects
  const pitches = [];
  for (const pred of predictions) {
    const keywords = pred.subject.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (!keywords.length) continue;

    const pattern = keywords.map(k => `%${k}%`).join('|');
    const related = await db.prepare(`
      SELECT id, title FROM articles
      WHERE tenant_id = $1
        AND (content_type IS NULL OR content_type = 'curated')
        AND created_at > NOW() - INTERVAL '7 days'
        AND (${keywords.map((_, i) => `LOWER(title) LIKE $${i + 2}`).join(' OR ')})
      LIMIT 5
    `).all(tenantId, ...keywords.map(k => `%${k}%`));

    if (related.length >= 2) {
      const row = await db.prepare(`
        INSERT INTO story_pitches (tenant_id, writer_id, pitch_type, headline, reasoning, source_article_ids, memory_refs, priority)
        VALUES ($1, $2, 'prediction_check', $3, $4, $5, $6, 7.0)
        RETURNING *
      `).get(
        tenantId, writerId,
        `Prediction Check: ${pred.subject}`,
        `My prediction "${pred.content}" is approaching its expiry. ${related.length} recent sources may validate or invalidate it.`,
        JSON.stringify(related.map(r => r.id)),
        JSON.stringify([pred.subject])
      );
      if (row) pitches.push(row);
    }
  }

  return pitches;
}

/**
 * Get pending pitch count for a tenant (for badge display).
 */
async function getPendingPitchCount(tenantId) {
  const row = await db.prepare(
    'SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE tenant_id = $1 AND status = $2'
  ).get(tenantId, 'pending');
  return row?.cnt || 0;
}

/**
 * Proactively search external sources (Brave/HN/Reddit) for each of a writer's
 * beats and ingest the top results as curated articles. Called by agent-scan
 * before evaluateIncomingArticles so the evaluation pool is always fresh.
 *
 * Gated by the agent_web_research feature flag. No-ops silently if disabled.
 *
 * @param {number} writerId
 * @param {number} tenantId
 * @returns {Promise<{ searched: number, ingested: number }>}
 */
async function proactiveBeatSearch(writerId, tenantId) {
  const enabled = await isFeatureEnabled(tenantId, 'agent_web_research').catch(() => false);
  if (!enabled) return { searched: 0, ingested: 0 };

  // Fetch writer keywords for Fix 1 (keyword-based search queries) and Fix 4 (per-writer cap)
  const writer = await db.prepare(
    'SELECT id, keywords FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);

  // Fix 1: parse keywords — native TEXT[] may arrive as a JS array or JSON string
  let writerKeywords = null;
  if (writer?.keywords) {
    if (Array.isArray(writer.keywords)) {
      writerKeywords = writer.keywords.filter(Boolean);
    } else if (typeof writer.keywords === 'string') {
      try { writerKeywords = JSON.parse(writer.keywords).filter(Boolean); } catch { writerKeywords = null; }
    }
    if (writerKeywords && !writerKeywords.length) writerKeywords = null;
  }

  const beats = await db.prepare(`
    SELECT c.name FROM writer_beats wb
    JOIN categories c ON c.id = wb.category_id
    WHERE wb.writer_id = $1 AND wb.tenant_id = $2
  `).all(writerId, tenantId);

  if (!beats.length) return { searched: 0, ingested: 0 };

  // Fix 4: per-writer daily ingest cap
  const { getAllFeatures } = require('./feature-registry');
  let perWriterCap = 20;
  try {
    const feats = await getAllFeatures(tenantId);
    const n = parseInt(feats.external_research_per_writer_daily_cap, 10);
    if (Number.isFinite(n) && n > 0) perWriterCap = n;
  } catch { /* use default */ }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const perWriterCounterKey = `${tenantId}:${writerId}:${today}`;

  // Count how many articles this writer has already caused to be ingested today
  // (tracked via ingest_source = 'agent-scan' on the article row is tenant-level,
  //  so we use a best-effort estimate: curated articles created today that were
  //  ingested during any agent-scan run within this tenant, apportioned to this
  //  writer by checking against our in-process counter stored in module scope).
  if (!proactiveBeatSearch._writerCounters) proactiveBeatSearch._writerCounters = {};
  const writerIngestedToday = proactiveBeatSearch._writerCounters[perWriterCounterKey] || 0;

  if (writerIngestedToday >= perWriterCap) {
    console.log(`[agent-scan] per-writer cap (${perWriterCap}) reached for writer ${writerId} — skipping proactive search`);
    return { searched: 0, ingested: 0 };
  }

  let totalIngested = 0;

  for (const beat of beats) {
    // Re-check per-writer cap before each beat
    const currentCount = (proactiveBeatSearch._writerCounters[perWriterCounterKey] || 0);
    if (currentCount >= perWriterCap) {
      console.log(`[agent-scan] per-writer cap reached mid-loop for writer ${writerId} — stopping`);
      break;
    }

    try {
      // Fix 1: use writer keywords as search query if available, fall back to beat name
      const query = (writerKeywords && writerKeywords.length > 0)
        ? writerKeywords.slice(0, 5).join(' OR ')
        : beat.name;

      const { results } = await searchAll(tenantId, query, {
        sources: ['brave', 'hackernews'],
        count: 15,
      });
      if (!results.length) continue;

      const r = await ingestExternalResults(tenantId, results, { trigger: 'agent-scan' });
      totalIngested += r.ingested.length;

      // Update per-writer counter
      proactiveBeatSearch._writerCounters[perWriterCounterKey] =
        (proactiveBeatSearch._writerCounters[perWriterCounterKey] || 0) + r.ingested.length;

      if (r.ingested.length) {
        console.log(`[agent-scan] proactive search "${query}" (writer ${writerId}, beat "${beat.name}"): ${r.ingested.length} new articles ingested`);
      }
    } catch (err) {
      console.warn(`[agent-scan] proactive search failed for beat "${beat.name}" (writer ${writerId}):`, err.message);
    }
  }

  return { searched: beats.length, ingested: totalIngested };
}

/**
 * Generate a daily standup for a writer — a brief first-person summary of what
 * they're tracking, what pitches are pending, and what they plan to cover today.
 * Posted to the newsroom feed and optionally to messaging channels.
 *
 * @param {number} writerId
 * @param {number} tenantId
 * @returns {Promise<string|null>} — standup text, or null if skipped
 */
async function generateStandup(writerId, tenantId) {
  const writer = await db.prepare(
    'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);
  if (!writer) return null;

  // Build persona
  const beats = await db.prepare(`
    SELECT c.name FROM writer_beats wb
    JOIN categories c ON c.id = wb.category_id
    WHERE wb.writer_id = $1 AND wb.tenant_id = $2
  `).all(writerId, tenantId);
  const beatNames = beats.map(b => b.name);

  // Pending pitches
  const pendingPitches = await db.prepare(`
    SELECT headline, pitch_type, priority FROM story_pitches
    WHERE writer_id = $1 AND tenant_id = $2 AND status = 'pending'
    ORDER BY priority DESC LIMIT 5
  `).all(writerId, tenantId);

  // Published articles in last 24h
  const recentArticles = await db.prepare(`
    SELECT COALESCE(generated_title, title) AS title, category FROM articles
    WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive')
      AND is_published = 1
      AND published_at > NOW() - INTERVAL '24 hours'
    ORDER BY published_at DESC LIMIT 3
  `).all(writerId, tenantId);

  // Top curated sources in beat from last 24h (what's in the wire)
  const topSources = await db.prepare(`
    SELECT title, source, category FROM articles
    WHERE tenant_id = $1
      AND (content_type IS NULL OR content_type = 'curated')
      AND is_archived = 0
      AND category = ANY($2)
      AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC LIMIT 10
  `).all(tenantId, beatNames);

  if (!topSources.length && !pendingPitches.length) return null; // nothing to talk about

  const persona = await buildWriterPrompt(writer, {}).catch(() => `You are ${writer.name}.`);

  const pendingText = pendingPitches.length
    ? pendingPitches.map(p => `- [${p.pitch_type}] "${p.headline}" (priority ${p.priority})`).join('\n')
    : 'No pitches pending.';

  const recentText = recentArticles.length
    ? recentArticles.map(a => `- "${a.title}" (${a.category})`).join('\n')
    : 'No articles published in the last 24 hours.';

  const sourcesText = topSources.length
    ? topSources.map(s => `- "${s.title}" (${s.source}, ${s.category})`).join('\n')
    : 'No new sources in beat.';

  const p = loadPrompt('writer-standup');
  const { messages, ...meta } = p.render({
    persona,
    beats: beatNames.join(', '),
    pendingPitches: pendingText,
    recentArticles: recentText,
    topSources: sourcesText,
  });

  const result = await aiComplete({
    ...meta, messages, tenantId,
    trigger: 'daily-standup',
    writerId,
  });

  const standup = result?.text?.trim() || null;
  return standup ? stripMarkdown(standup) : null;
}

/**
 * Generate the end-of-day editorial brief (written by Maxwell).
 * Gathers today's output across all writers and pipeline runs, then calls
 * Maxwell's LLM to produce a 3-5 paragraph narrative recap.
 *
 * @param {number} tenantId
 * @returns {Promise<string|null>}
 */
/**
 * Build the daily-metric baselines so each "today" number can be shown with
 * a trend arrow instead of naked. Baseline = rolling 7-day average per-day,
 * excluding today (NOW - 8d .. NOW - 1d).
 */
async function computeDailyBaselines(tenantId) {
  const q = async (sql) => {
    try { const r = await db.prepare(sql).get(tenantId); return Number(r?.v || 0); }
    catch { return 0; }
  };
  return {
    articles_published: await q(`
      SELECT (COUNT(*)::numeric / 7) AS v FROM articles
      WHERE tenant_id = $1 AND is_published = 1
        AND content_type IN ('original','deep-dive')
        AND published_at BETWEEN NOW() - INTERVAL '8 days' AND NOW() - INTERVAL '1 day'
    `),
    pitches_created: await q(`
      SELECT (COUNT(*)::numeric / 7) AS v FROM story_pitches
      WHERE tenant_id = $1
        AND created_at BETWEEN NOW() - INTERVAL '8 days' AND NOW() - INTERVAL '1 day'
    `),
    ai_spend_usd: await q(`
      SELECT (COALESCE(SUM(estimated_cost), 0)::numeric / 7) AS v FROM ai_usage
      WHERE tenant_id = $1
        AND created_at BETWEEN NOW() - INTERVAL '8 days' AND NOW() - INTERVAL '1 day'
    `),
    research_ingested: await q(`
      SELECT (COUNT(*)::numeric / 7) AS v FROM articles
      WHERE tenant_id = $1 AND (content_type IS NULL OR content_type = 'curated')
        AND created_at BETWEEN NOW() - INTERVAL '8 days' AND NOW() - INTERVAL '1 day'
    `),
  };
}

/**
 * Compute a metric object with trend arrow against a baseline.
 * Returns { value, baseline, trend: 'up'|'down'|'flat', delta_pct }.
 * Null baseline (rare — totally new tenant) renders as no-trend.
 */
function metric(value, baseline) {
  const v = Number(value || 0);
  const b = Number(baseline || 0);
  if (b <= 0) {
    return { value: v, baseline: b, trend: 'flat', delta_pct: null };
  }
  const deltaPct = Math.round(((v - b) / b) * 100);
  const trend = Math.abs(deltaPct) < 5 ? 'flat' : (deltaPct > 0 ? 'up' : 'down');
  return { value: v, baseline: Math.round(b * 100) / 100, trend, delta_pct: deltaPct };
}

/**
 * Generate the end-of-day editorial brief (written by Maxwell).
 *
 * Returns a STRUCTURED payload:
 *   {
 *     version: 2,
 *     period: 'daily',
 *     headline, generated_at, period_range,
 *     metrics: { articles_published, pitches_pending, review_queue, ai_spend_usd, orphaned_pitches },
 *     top_priority: { label, link, cta? } | null,
 *     highlights: [{ type, title, link?, writer?, ... }],
 *     gaps: [{ beat, days? }],
 *     action_items: [{ label, link }],
 *     prose
 *   }
 *
 * Metric numbers are computed server-side; Maxwell contributes narrative
 * (headline, top_priority, highlights rationale, prose). Eliminates the
 * old hallucination risk where the LLM could invent counts.
 *
 * @param {number} tenantId
 * @returns {Promise<object|null>}
 */
async function generateDailyBrief(tenantId) {
  // ── Server-computed metrics ────────────────────────────────
  const articles = await db.prepare(`
    SELECT a.id, COALESCE(a.generated_title, a.title) AS title, a.slug,
           w.name AS writer_name, a.category, a.content_type
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1 AND a.is_published = 1
      AND a.published_at > NOW() - INTERVAL '24 hours'
      AND a.content_type IN ('original','deep-dive')
    ORDER BY a.published_at DESC LIMIT 20
  `).all(tenantId);

  const pitches = await db.prepare(`
    SELECT status, COUNT(*)::int AS cnt FROM story_pitches
    WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
    GROUP BY status
  `).all(tenantId);
  const pitchesByStatus = Object.fromEntries(pitches.map(p => [p.status, p.cnt]));
  const pitchesCreatedToday = pitches.reduce((s, p) => s + p.cnt, 0);
  const pitchesPending = pitchesByStatus.pending || 0;

  const reviewRow = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM articles
    WHERE tenant_id = $1 AND status = 'review' AND is_published = 0
  `).get(tenantId);
  const reviewCount = reviewRow?.cnt || 0;

  const researchRow = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM articles
    WHERE tenant_id = $1 AND (content_type IS NULL OR content_type = 'curated')
      AND created_at > NOW() - INTERVAL '24 hours'
  `).get(tenantId);
  const researchCount = researchRow?.cnt || 0;

  const budgetRow = await db.prepare(`
    SELECT COALESCE(SUM(estimated_cost), 0)::numeric(10,4) AS total,
           COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0)::int AS tokens
    FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
  `).get(tenantId);
  const aiSpend = Number(budgetRow?.total || 0);

  const pipeline = await db.prepare(`
    SELECT status, COUNT(*)::int AS cnt FROM pipeline_runs
    WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
    GROUP BY status
  `).all(tenantId);

  // Orphan pitches — commissioned/tipped pitches stuck without a writer.
  // Surfaces the new orphan filter as a first-class daily metric.
  const orphanRow = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM article_pitches
    WHERE tenant_id = $1
      AND status IN ('proposed','approved')
      AND pitched_by_writer_id IS NULL
  `).get(tenantId);
  const orphanCount = orphanRow?.cnt || 0;

  // Stalled pitches — pending for > 2 days
  const stalledRows = await db.prepare(`
    SELECT id, headline, EXTRACT(EPOCH FROM (NOW() - created_at))::int / 86400 AS days
    FROM story_pitches
    WHERE tenant_id = $1 AND status = 'pending' AND created_at < NOW() - INTERVAL '2 days'
    ORDER BY created_at ASC LIMIT 3
  `).all(tenantId);

  // Orphan article_pitches — pick a few so we can render per-pitch
  // auto-assign buttons inline in the brief.
  const orphanPitches = await db.prepare(`
    SELECT p.id, COALESCE(a.title, 'Source #' || p.source_article_id) AS title
    FROM article_pitches p
    LEFT JOIN articles a ON a.id = p.source_article_id AND a.tenant_id = p.tenant_id
    WHERE p.tenant_id = $1
      AND p.status IN ('proposed','approved')
      AND p.pitched_by_writer_id IS NULL
    ORDER BY p.created_at ASC LIMIT 3
  `).all(tenantId);

  const budgetSlotRow = await db.prepare(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE nbs.status = 'approved')::int AS approved,
      COUNT(*) FILTER (WHERE nbs.status = 'rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE nbs.status = 'auto_promoted')::int AS auto_promoted,
      COUNT(*) FILTER (WHERE nbs.status = 'pending')::int AS pending
    FROM news_budgets nb
    JOIN news_budget_slots nbs ON nbs.budget_id = nb.id
    WHERE nb.tenant_id = $1 AND nb.budget_date = CURRENT_DATE
  `).get(tenantId).catch(() => null);
  const budgetSlots = budgetSlotRow || { total: 0, approved: 0, rejected: 0, auto_promoted: 0, pending: 0 };
  const budgetPublished = budgetSlots.approved + budgetSlots.auto_promoted;

  const baselines = await computeDailyBaselines(tenantId);

  // ── Structured metrics with baselines ──────────────────────
  const metrics = {
    articles_published: metric(articles.length, baselines.articles_published),
    pitches_created:    metric(pitchesCreatedToday, baselines.pitches_created),
    pitches_pending:    metric(pitchesPending, null),  // snapshot — no baseline
    review_queue:       metric(reviewCount, null),
    ai_spend_usd:       metric(aiSpend, baselines.ai_spend_usd),
    research_ingested:  metric(researchCount, baselines.research_ingested),
    orphaned_pitches:   metric(orphanCount, null),
    budget_performance: budgetSlots.total > 0
      ? metric(budgetPublished, null)  // no baseline yet — just current value
      : null,
  };

  // ── Narrative (LLM) ────────────────────────────────────────
  const articlesText = articles.length
    ? articles.map(a => `- "${a.title}" by ${a.writer_name || 'Unknown'} (${a.category || 'general'}, ${a.content_type})`).join('\n')
    : 'No articles published today.';
  const pitchText = pitches.length
    ? pitches.map(p => `${p.cnt} ${p.status}`).join(', ')
    : 'No pitch activity today.';
  const reviewText = reviewCount > 0 ? `${reviewCount} article(s) awaiting editorial review.` : 'Review queue is clear.';
  const researchText = `${researchCount} external source(s) ingested in the last 24 hours.`;
  const budgetText = `$${Number(aiSpend).toFixed(4)} across ${budgetRow?.tokens || 0} tokens.`;
  const pipelineText = pipeline.length
    ? pipeline.map(p => `${p.cnt} ${p.status}`).join(', ')
    : 'No pipeline runs today.';
  const stalledText = stalledRows.length
    ? stalledRows.map(s => `"${s.headline}" (${s.days}d old)`).join('; ')
    : 'No stalled pitches.';

  const budgetPerformanceText = budgetSlots.total > 0
    ? `Budget: ${budgetPublished}/${budgetSlots.total} slots approved or promoted (${budgetSlots.rejected} rejected, ${budgetSlots.pending} still pending).`
    : 'No news budget generated today.';

  const p = loadPrompt('maxwell-daily-brief');
  const { messages, ...meta } = p.render({
    articlesPublished: articlesText,
    pitchSummary: pitchText,
    reviewQueue: reviewText,
    researchSummary: researchText,
    budgetSummary: budgetText,
    pipelineSummary: pipelineText,
    stalledPitches: stalledText,
    orphanCount: String(orphanCount),
    budgetPerformance: budgetPerformanceText,
  });

  const result = await aiComplete({
    ...meta, messages, tenantId,
    trigger: 'daily-brief',
  });
  const raw = (result?.text || '').trim();
  if (!raw) return null;


  // Strip markdown fences the LLM sometimes wraps around JSON, then parse.
  const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
  let llm = {};
  try { llm = JSON.parse(cleaned); }
  catch {
    try {
      const { parseTruncatedJsonObject } = require('./json-parse-safe');
      llm = parseTruncatedJsonObject(cleaned);

    } catch { llm = {}; }
  }

  // Server synthesises the top_priority when the LLM didn't produce a
  // clear one (or hallucinated a bad link). Prioritise the most actionable
  // situation automatically.
  const fallbackPriority = (() => {
    if (orphanCount > 0) return { label: `${orphanCount} commissioned pitch${orphanCount === 1 ? ' is' : 'es are'} orphaned — assign writer${orphanCount === 1 ? '' : 's'}`, link: '/pitches.html', cta: 'Open Needs-writer tab' };
    if (reviewCount >= 5) return { label: `${reviewCount} articles stacked up for review`, link: '/editorial.html', cta: 'Review queue' };
    if (stalledRows.length) return { label: `${stalledRows.length} pitch${stalledRows.length === 1 ? '' : 'es'} stalled for 2+ days`, link: '/pitches.html', cta: 'Open pitches' };
    return null;
  })();

  // Server-computed action_items — authoritative. These carry real API
  // endpoints so the UI can render clickable buttons that execute the
  // action without leaving the brief. Takes precedence over any LLM
  // suggestions (the LLM doesn't know our endpoints).
  const actionItems = [];
  if (orphanPitches.length >= 2) {
    actionItems.push({
      label: `🎯 Auto-assign all ${orphanCount} orphan pitch${orphanCount === 1 ? '' : 'es'}`,
      action: { endpoint: '/api/pitches/auto-assign-orphans', method: 'POST', success_message: 'Orphans assigned.', confirm: `Run auto-assign on ${orphanCount} orphaned pitches?` },
    });
  }
  orphanPitches.slice(0, orphanPitches.length >= 2 ? 0 : 2).forEach(op => {
    actionItems.push({
      label: `🎯 Auto-assign: "${op.title.slice(0, 60)}"`,
      action: { endpoint: `/api/pitches/${op.id}/auto-assign`, method: 'POST', success_message: 'Writer assigned.' },
    });
  });
  if (reviewCount >= 5) {
    actionItems.push({ label: `📚 Review ${reviewCount} pending articles`, link: '/editorial.html' });
  }
  if (stalledRows.length) {
    actionItems.push({ label: `⏱ Open ${stalledRows.length} stalled pitch${stalledRows.length === 1 ? '' : 'es'}`, link: '/pitches.html' });
  }

  return {
    version: 2,
    period: 'daily',
    generated_at: new Date().toISOString(),
    period_range: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    headline: stripMarkdown(llm.headline) || buildFallbackHeadline(metrics),
    metrics,
    top_priority: llm.top_priority || fallbackPriority,
    highlights: Array.isArray(llm.highlights)
      ? llm.highlights.slice(0, 6).map(h => ({ ...h, title: stripMarkdown(h.title), note: stripMarkdown(h.note) }))
      : buildFallbackHighlights(articles, stalledRows),
    gaps: Array.isArray(llm.gaps) ? llm.gaps.slice(0, 4) : [],
    action_items: actionItems.length ? actionItems.slice(0, 5) : (Array.isArray(llm.action_items) ? llm.action_items.slice(0, 4) : []),

    prose: llm.prose ? stripMarkdown(String(llm.prose)) : '',

    budget_performance: budgetSlots.total > 0
      ? { total: budgetSlots.total, approved: budgetPublished, rejected: budgetSlots.rejected, pending: budgetSlots.pending }
      : null,
  };
}

function buildFallbackHeadline(m) {
  const parts = [];
  parts.push(`${m.articles_published.value} published`);
  if (m.orphaned_pitches.value > 0) parts.push(`${m.orphaned_pitches.value} orphan${m.orphaned_pitches.value === 1 ? '' : 's'}`);
  if (m.review_queue.value > 0) parts.push(`${m.review_queue.value} in review`);
  parts.push(`$${m.ai_spend_usd.value.toFixed(2)} AI`);
  return parts.join(' · ');
}

function buildFallbackHighlights(articles, stalled) {
  const out = [];
  articles.slice(0, 3).forEach(a => {
    out.push({ type: 'published', title: a.title, link: `/article-editor.html?id=${a.id}`, writer: a.writer_name || null });
  });
  stalled.slice(0, 2).forEach(s => {
    out.push({ type: 'stalled_pitch', title: s.headline, link: `/pitches.html`, note: `${s.days}d old` });
  });
  return out;
}

/**
 * Generate the Friday week-in-review editorial digest (written by Maxwell).
 * Broader than the daily brief — covers 7 days, coverage gaps, engagement.
 *
 * @param {number} tenantId
 * @returns {Promise<string|null>}
 */
/**
 * Baselines for the weekly digest — trailing 4 weeks (excluding current week).
 * These are weekly totals so they're directly comparable to "this week" counts.
 */
async function computeWeeklyBaselines(tenantId) {
  const q = async (sql) => {
    try { const r = await db.prepare(sql).get(tenantId); return Number(r?.v || 0); }
    catch { return 0; }
  };
  return {
    articles_published: await q(`
      SELECT (COUNT(*)::numeric / 4) AS v FROM articles
      WHERE tenant_id = $1 AND is_published = 1
        AND content_type IN ('original','deep-dive')
        AND published_at BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '7 days'
    `),
    pitches_created: await q(`
      SELECT (COUNT(*)::numeric / 4) AS v FROM story_pitches
      WHERE tenant_id = $1
        AND created_at BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '7 days'
    `),
    ai_spend_usd: await q(`
      SELECT (COALESCE(SUM(estimated_cost), 0)::numeric / 4) AS v FROM ai_usage
      WHERE tenant_id = $1
        AND created_at BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '7 days'
    `),
  };
}

async function generateWeeklyDigest(tenantId) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  // Articles published this week
  const articles = await db.prepare(`
    SELECT a.id, COALESCE(a.generated_title, a.title) AS title, a.slug,
           w.name AS writer_name, a.category, a.content_type
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1 AND a.is_published = 1
      AND a.published_at > NOW() - INTERVAL '7 days'
      AND a.content_type IN ('original','deep-dive')
    ORDER BY a.published_at DESC LIMIT 50
  `).all(tenantId);

  const articlesText = articles.length
    ? articles.map(a => `- "${a.title}" by ${a.writer_name || 'Unknown'} (${a.category || 'general'})`).join('\n')
    : 'No articles published this week.';

  // Beat coverage — count originals per category this week
  const beats = await db.prepare(`
    SELECT category, COUNT(*)::int AS cnt FROM articles
    WHERE tenant_id = $1 AND is_published = 1
      AND published_at > NOW() - INTERVAL '7 days'
      AND content_type IN ('original','deep-dive')
      AND category IS NOT NULL
    GROUP BY category ORDER BY cnt DESC
  `).all(tenantId);

  // Coverage gaps: beats that have active writers but 0 originals this week
  const allBeats = await db.prepare(`
    SELECT DISTINCT c.name FROM writer_beats wb
    JOIN categories c ON c.id = wb.category_id
    WHERE wb.tenant_id = $1
  `).all(tenantId);
  const coveredSet = new Set(beats.map(b => b.category?.toLowerCase()));
  const gaps = allBeats.filter(b => !coveredSet.has(b.name?.toLowerCase())).map(b => b.name);

  const beatText = beats.length
    ? beats.map(b => `${b.category}: ${b.cnt} article(s)`).join(', ')
    : 'No beat breakdown available.';
  const gapText = gaps.length ? gaps.join(', ') : 'All active beats had coverage this week.';

  // Pitches this week
  const pitches = await db.prepare(`
    SELECT status, COUNT(*)::int AS cnt FROM story_pitches
    WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY status
  `).all(tenantId);
  const pitchText = pitches.length
    ? pitches.map(p => `${p.cnt} ${p.status}`).join(', ')
    : 'No pitches this week.';

  // Engagement highlights (top 5 by views if available)
  const topArticles = await db.prepare(`
    SELECT COALESCE(a.generated_title, a.title) AS title,
           COUNT(ae.id)::int AS views
    FROM articles a
    LEFT JOIN analytics_events ae ON ae.article_slug = a.slug AND ae.tenant_id = a.tenant_id AND ae.event_type = 'view'
    WHERE a.tenant_id = $1 AND a.is_published = 1
      AND a.published_at > NOW() - INTERVAL '7 days'
      AND a.content_type IN ('original','deep-dive')
    GROUP BY a.id, a.title, a.generated_title
    HAVING COUNT(ae.id) > 0
    ORDER BY views DESC LIMIT 5
  `).all(tenantId);
  const engagementText = topArticles.length
    ? topArticles.map(a => `"${a.title}" (${a.views} views)`).join(', ')
    : 'No engagement data available for this week.';

  // AI budget this week
  const budget = await db.prepare(`
    SELECT COALESCE(SUM(estimated_cost), 0)::numeric(10,4) AS total,
           COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0)::int AS tokens,
           operation, COUNT(*)::int AS calls
    FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY operation ORDER BY SUM(estimated_cost) DESC LIMIT 8
  `).all(tenantId);
  const budgetText = budget.length
    ? budget.map(b => `${b.operation}: $${Number(b.total || 0).toFixed(4)} (${b.calls} calls)`).join(', ')
    : 'No AI usage this week.';

  // Pipeline health
  const pipeline = await db.prepare(`
    SELECT status, COUNT(*)::int AS cnt FROM pipeline_runs
    WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY status
  `).all(tenantId);
  const pipelineText = pipeline.length
    ? pipeline.map(p => `${p.cnt} ${p.status}`).join(', ')
    : 'No pipeline activity this week.';

  // Next week queue
  const nextPitches = await db.prepare(`
    SELECT sp.headline, w.name AS writer_name FROM story_pitches sp
    LEFT JOIN writers w ON w.id = sp.writer_id AND w.tenant_id = sp.tenant_id
    WHERE sp.tenant_id = $1 AND sp.status = 'pending'
    ORDER BY sp.priority DESC, sp.created_at DESC LIMIT 10
  `).all(tenantId);
  const nextText = nextPitches.length
    ? nextPitches.map(p => `"${p.headline}" (${p.writer_name || 'unassigned'})`).join(', ')
    : 'No pending pitches queued.';

  const baselines = await computeWeeklyBaselines(tenantId);

  const pitchesCreated = pitches.reduce((s, p) => s + p.cnt, 0);
  const aiSpend = budget.reduce((s, b) => s + Number(b.total || 0), 0);

  const metrics = {
    articles_published: metric(articles.length, baselines.articles_published),
    pitches_created:    metric(pitchesCreated, baselines.pitches_created),
    ai_spend_usd:       metric(aiSpend, baselines.ai_spend_usd),
    coverage_gaps:      metric(gaps.length, null),
    top_article_views:  metric(topArticles[0]?.views || 0, null),
  };

  const p = loadPrompt('maxwell-weekly-digest');
  const { messages, ...meta } = p.render({
    weekRange,
    articlesPublished: articlesText,
    beatCoverage: beatText,
    pitchSummary: pitchText,
    coverageGaps: gapText,
    engagementHighlights: engagementText,
    budgetSummary: budgetText,
    pipelineSummary: pipelineText,
    nextWeekQueue: nextText,
  });

  const result = await aiComplete({
    ...meta, messages, tenantId,
    trigger: 'weekly-digest',
  });
  const raw = (result?.text || '').trim();
  if (!raw) return null;


  const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
  let llm = {};
  try { llm = JSON.parse(cleaned); }
  catch {
    try {
      const { parseTruncatedJsonObject } = require('./json-parse-safe');
      llm = parseTruncatedJsonObject(cleaned);

    } catch { llm = {}; }
  }

  // Fallback priority: the most significant coverage gap, or the biggest
  // unfulfilled pitch queue.
  const fallbackPriority = (() => {
    if (gaps.length >= 2) return { label: `${gaps.length} beats had no originals this week`, link: '/editorial.html', cta: 'Open editorial' };
    if (nextPitches.length >= 5) return { label: `${nextPitches.length} pitches queued for next week`, link: '/pitches.html', cta: 'Review queue' };
    return null;
  })();

  // Server-computed weekly action items
  const weeklyActions = [];
  const weeklyOrphanRow = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM article_pitches
    WHERE tenant_id = $1 AND status IN ('proposed','approved') AND pitched_by_writer_id IS NULL
  `).get(tenantId);
  const weeklyOrphans = weeklyOrphanRow?.cnt || 0;
  if (weeklyOrphans > 0) {
    weeklyActions.push({
      label: `🎯 Auto-assign ${weeklyOrphans} orphan pitch${weeklyOrphans === 1 ? '' : 'es'}`,
      action: { endpoint: '/api/pitches/auto-assign-orphans', method: 'POST', success_message: 'Orphans assigned.' },
    });
  }
  if (nextPitches.length >= 3) {
    weeklyActions.push({ label: `📋 Review ${nextPitches.length} queued pitches`, link: '/pitches.html' });
  }
  if (gaps.length >= 2) {
    weeklyActions.push({ label: `○ Address ${gaps.length} coverage gaps`, link: '/editorial.html' });
  }

  return {
    version: 2,
    period: 'weekly',
    generated_at: new Date().toISOString(),
    period_range: weekRange,
    headline: stripMarkdown(llm.headline) || buildFallbackWeeklyHeadline(metrics, gaps),
    metrics,
    top_priority: llm.top_priority || fallbackPriority,
    highlights: Array.isArray(llm.highlights)
      ? llm.highlights.slice(0, 8).map(h => ({ ...h, title: stripMarkdown(h.title), note: stripMarkdown(h.note) }))
      : buildFallbackWeeklyHighlights(articles, topArticles),
    gaps: Array.isArray(llm.gaps) ? llm.gaps.slice(0, 6) : gaps.slice(0, 6).map(g => ({ beat: g })),
    action_items: weeklyActions.length ? weeklyActions.slice(0, 5) : (Array.isArray(llm.action_items) ? llm.action_items.slice(0, 5) : []),

    prose: llm.prose ? stripMarkdown(String(llm.prose)) : '',

  };
}

function buildFallbackWeeklyHeadline(m, gaps) {
  const parts = [`${m.articles_published.value} published`];
  if (gaps && gaps.length) parts.push(`${gaps.length} gap${gaps.length === 1 ? '' : 's'}`);
  parts.push(`$${m.ai_spend_usd.value.toFixed(2)} AI`);
  return parts.join(' · ');
}

function buildFallbackWeeklyHighlights(articles, topArticles) {
  const out = [];
  topArticles.slice(0, 3).forEach(a => {
    out.push({ type: 'top_engagement', title: a.title, note: `${a.views} views` });
  });
  articles.slice(0, 3).forEach(a => {
    out.push({ type: 'published', title: a.title, link: `/article-editor.html?id=${a.id}`, writer: a.writer_name || null });
  });
  return out;
}

module.exports = { evaluateIncomingArticles, checkPredictions, getPendingPitchCount, proactiveBeatSearch, generateStandup, generateDailyBrief, generateWeeklyDigest };
