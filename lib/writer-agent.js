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

/**
 * Evaluate incoming source articles and generate story pitches for a writer.
 * Called by the agent-scan cron job.
 */
async function evaluateIncomingArticles(writerId, tenantId) {
  const writer = await db.prepare(
    'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);
  if (!writer) return [];

  // Get writer's beat categories
  const beats = await db.prepare(`
    SELECT c.name FROM writer_beats wb
    JOIN categories c ON c.id = wb.category_id
    WHERE wb.writer_id = $1 AND wb.tenant_id = $2
  `).all(writerId, tenantId);
  const beatNames = beats.map(b => b.name);
  if (!beatNames.length) return [];

  // Get recent source articles in writer's beats (last 6 hours, not yet pitched)
  const sources = await db.prepare(`
    SELECT a.id, a.title, a.summary, a.category, a.source, a.created_at
    FROM articles a
    WHERE a.tenant_id = $1
      AND (a.content_type IS NULL OR a.content_type = 'curated')
      AND a.is_archived = 0
      AND a.category = ANY($2)
      AND a.created_at > NOW() - INTERVAL '6 hours'
      AND a.id NOT IN (
        SELECT DISTINCT jsonb_array_elements_text(sp.source_article_ids)::int
        FROM story_pitches sp
        WHERE sp.tenant_id = $1 AND sp.writer_id = $3
          AND sp.created_at > NOW() - INTERVAL '24 hours'
      )
    ORDER BY a.created_at DESC
    LIMIT 30
  `).all(tenantId, beatNames, writerId);

  if (sources.length < 2) return []; // Not enough material to evaluate

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

  // Build persona
  const persona = await buildWriterPrompt(writer, { recentArticles, memories });

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

  if (!result?.text) return [];

  // Parse pitches
  let pitches;
  try {
    const cleaned = result.text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    pitches = JSON.parse(cleaned);
    if (!Array.isArray(pitches)) return [];
  } catch { return []; }

  const validTypes = new Set(['new_story', 'follow_up', 'roundup', 'prediction_check']);
  const stored = [];

  for (const pitch of pitches.slice(0, 3)) {
    if (!pitch.type || !validTypes.has(pitch.type) || !pitch.headline || !pitch.reasoning) continue;

    const sourceIds = Array.isArray(pitch.source_ids) ? pitch.source_ids.filter(id => typeof id === 'number') : [];
    const memoryRefs = Array.isArray(pitch.memory_refs) ? pitch.memory_refs : [];
    const priority = Math.min(10, Math.max(1, parseFloat(pitch.priority) || 5));

    const row = await db.prepare(`
      INSERT INTO story_pitches (tenant_id, writer_id, pitch_type, headline, reasoning, source_article_ids, memory_refs, priority)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `).get(
      tenantId, writerId, pitch.type,
      pitch.headline.slice(0, 300),
      pitch.reasoning.slice(0, 500),
      JSON.stringify(sourceIds),
      JSON.stringify(memoryRefs),
      priority
    );

    if (row) stored.push(row);
  }

  return stored;
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

  const beats = await db.prepare(`
    SELECT c.name FROM writer_beats wb
    JOIN categories c ON c.id = wb.category_id
    WHERE wb.writer_id = $1 AND wb.tenant_id = $2
  `).all(writerId, tenantId);

  if (!beats.length) return { searched: 0, ingested: 0 };

  let totalIngested = 0;

  for (const beat of beats) {
    try {
      const { results } = await searchAll(tenantId, beat.name, {
        sources: ['brave', 'hackernews'],
        count: 15,
      });
      if (!results.length) continue;

      const r = await ingestExternalResults(tenantId, results, { trigger: 'agent-scan' });
      totalIngested += r.ingested.length;

      if (r.ingested.length) {
        console.log(`[agent-scan] proactive search "${beat.name}" (writer ${writerId}): ${r.ingested.length} new articles ingested`);
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

  return result?.text?.trim() || null;
}

/**
 * Generate the end-of-day editorial brief (written by Maxwell).
 * Gathers today's output across all writers and pipeline runs, then calls
 * Maxwell's LLM to produce a 3-5 paragraph narrative recap.
 *
 * @param {number} tenantId
 * @returns {Promise<string|null>}
 */
async function generateDailyBrief(tenantId) {
  // Articles published today
  const articles = await db.prepare(`
    SELECT COALESCE(generated_title, title) AS title, w.name AS writer_name, category, content_type
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1 AND a.is_published = 1
      AND a.published_at > NOW() - INTERVAL '24 hours'
      AND a.content_type IN ('original','deep-dive')
    ORDER BY a.published_at DESC LIMIT 20
  `).all(tenantId);

  const articlesText = articles.length
    ? articles.map(a => `- "${a.title}" by ${a.writer_name || 'Unknown'} (${a.category || 'general'}, ${a.content_type})`).join('\n')
    : 'No articles published today.';

  // Pitch activity today
  const pitches = await db.prepare(`
    SELECT status, COUNT(*)::int AS cnt FROM story_pitches
    WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
    GROUP BY status
  `).all(tenantId);
  const pitchText = pitches.length
    ? pitches.map(p => `${p.cnt} ${p.status}`).join(', ')
    : 'No pitch activity today.';

  // Review queue
  const reviewCount = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM articles
    WHERE tenant_id = $1 AND status = 'review' AND is_published = 0
  `).get(tenantId);
  const reviewText = (reviewCount?.cnt || 0) > 0
    ? `${reviewCount.cnt} article(s) awaiting editorial review.`
    : 'Review queue is clear.';

  // Research ingested today
  const research = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM articles
    WHERE tenant_id = $1 AND (content_type IS NULL OR content_type = 'curated')
      AND created_at > NOW() - INTERVAL '24 hours'
  `).get(tenantId);
  const researchText = `${research?.cnt || 0} external source(s) ingested in the last 24 hours.`;

  // AI spend today
  const budget = await db.prepare(`
    SELECT COALESCE(SUM(estimated_cost_usd), 0)::numeric(10,4) AS total,
           COALESCE(SUM(total_tokens), 0)::int AS tokens
    FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
  `).get(tenantId);
  const budgetText = `$${budget?.total || '0.0000'} across ${budget?.tokens || 0} tokens.`;

  // Pipeline runs today
  const pipeline = await db.prepare(`
    SELECT status, COUNT(*)::int AS cnt FROM pipeline_runs
    WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
    GROUP BY status
  `).all(tenantId);
  const pipelineText = pipeline.length
    ? pipeline.map(p => `${p.cnt} ${p.status}`).join(', ')
    : 'No pipeline runs today.';

  const p = loadPrompt('maxwell-daily-brief');
  const { messages, ...meta } = p.render({
    articlesPublished: articlesText,
    pitchSummary: pitchText,
    reviewQueue: reviewText,
    researchSummary: researchText,
    budgetSummary: budgetText,
    pipelineSummary: pipelineText,
  });

  const result = await aiComplete({
    ...meta, messages, tenantId,
    trigger: 'daily-brief',
  });

  return result?.text?.trim() || null;
}

/**
 * Generate the Friday week-in-review editorial digest (written by Maxwell).
 * Broader than the daily brief — covers 7 days, coverage gaps, engagement.
 *
 * @param {number} tenantId
 * @returns {Promise<string|null>}
 */
async function generateWeeklyDigest(tenantId) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  // Articles published this week
  const articles = await db.prepare(`
    SELECT COALESCE(a.generated_title, a.title) AS title, w.name AS writer_name, a.category, a.content_type
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
    SELECT COALESCE(SUM(estimated_cost_usd), 0)::numeric(10,4) AS total,
           COALESCE(SUM(total_tokens), 0)::int AS tokens,
           operation, COUNT(*)::int AS calls
    FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY operation ORDER BY SUM(estimated_cost_usd) DESC LIMIT 8
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

  return result?.text?.trim() || null;
}

module.exports = { evaluateIncomingArticles, checkPredictions, getPendingPitchCount, proactiveBeatSearch, generateStandup, generateDailyBrief, generateWeeklyDigest };
