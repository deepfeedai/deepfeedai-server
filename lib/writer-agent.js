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

module.exports = { evaluateIncomingArticles, checkPredictions, getPendingPitchCount };
