/**
 * Writer Memory — extracts and retrieves editorial memories for writer personas.
 * Memories give writers continuity across articles: positions, running threads,
 * source observations, and time-bound predictions.
 */
const db = require('../db');
const { complete: aiComplete } = require('./ai-router');
const { loadPrompt } = require('./prompt-loader');
const { significantWords } = require('./utils');

const MAX_MEMORIES_PER_WRITER = 50;

/**
 * After synthesis, extract 1-3 memory entries from the article just written.
 * Fire-and-forget — never throws to the caller.
 */
async function extractAndStoreMemories(articleId, writerId, tenantId) {
  const article = await db.prepare(
    'SELECT title, full_content, summary, category FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(articleId, tenantId);
  if (!article) return;

  const writer = await db.prepare(
    'SELECT name FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);
  if (!writer) return;

  // Get writer beats for context
  let beat = article.category || 'technology';
  try {
    const beats = await db.prepare(`
      SELECT c.name FROM writer_beats wb JOIN categories c ON c.id = wb.category_id
      WHERE wb.writer_id = $1 AND wb.tenant_id = $2
    `).all(writerId, tenantId);
    if (beats.length) beat = beats.map(b => b.name).join(', ');
  } catch { /* use article category */ }

  const contentText = (article.full_content || article.summary || '')
    .replace(/<[^>]+>/g, '').slice(0, 2000);

  const p = loadPrompt('memory-extract');
  const { messages, ...meta } = p.render({
    writerName: writer.name,
    beat,
    title: article.title,
    content: contentText,
  });

  const result = await aiComplete({
    ...meta, messages, tenantId,
    trigger: 'auto-memory',
    writerId,
  });
  if (!result?.text) return;

  // Parse JSON response
  let entries;
  try {
    const cleaned = result.text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    entries = JSON.parse(cleaned);
    if (!Array.isArray(entries)) return;
  } catch { return; }

  const validTypes = new Set(['position', 'thread', 'source_note', 'prediction']);

  for (const entry of entries.slice(0, 3)) {
    if (!entry.type || !validTypes.has(entry.type) || !entry.subject || !entry.content) continue;

    const expiresAt = entry.expires_in_days
      ? new Date(Date.now() + entry.expires_in_days * 86400000).toISOString()
      : null;

    await db.prepare(`
      INSERT INTO writer_memory (writer_id, tenant_id, memory_type, subject, content, confidence, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `).run(
      writerId, tenantId, entry.type,
      entry.subject.slice(0, 200), entry.content.slice(0, 500),
      entry.confidence ?? 0.80,
      expiresAt,
    );
  }

  // Cap: remove oldest non-position memories beyond limit.
  // Position memories are exempt — they represent durable editorial stances.
  const count = await db.prepare(
    'SELECT COUNT(*)::int AS cnt FROM writer_memory WHERE writer_id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);

  if (count.cnt > MAX_MEMORIES_PER_WRITER) {
    const excess = count.cnt - MAX_MEMORIES_PER_WRITER;
    await db.prepare(`
      DELETE FROM writer_memory WHERE id IN (
        SELECT id FROM writer_memory
        WHERE writer_id = $1 AND tenant_id = $2 AND memory_type != 'position'
        ORDER BY created_at ASC LIMIT $3
      )
    `).run(writerId, tenantId, excess);
  }
}

/**
 * Get memories relevant to a topic for injection into the writer prompt.
 * Uses keyword overlap to rank relevance.
 */
async function getRelevantMemories(writerId, tenantId, topic, limit = 5) {
  // Get all active (non-expired) memories for this writer
  const all = await db.prepare(`
    SELECT id, memory_type, subject, content, confidence, created_at
    FROM writer_memory
    WHERE writer_id = $1 AND tenant_id = $2
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT 30
  `).all(writerId, tenantId);

  if (!all.length) return [];

  // Score by keyword overlap with the topic
  const topicWords = new Set(significantWords(topic));
  if (!topicWords.size) return all.slice(0, limit);

  const scored = all.map(m => {
    const memWords = new Set(significantWords(`${m.subject} ${m.content}`));
    let score = 0;
    for (const w of topicWords) {
      if (memWords.has(w)) score++;
    }
    return { ...m, score };
  });

  // Return top N with score > 0, falling back to most recent if no matches
  const relevant = scored.filter(m => m.score > 0).sort((a, b) => b.score - a.score);
  return relevant.length ? relevant.slice(0, limit) : all.slice(0, Math.min(2, limit));
}

/**
 * Delete a specific memory entry (admin action).
 */
async function deleteMemory(memoryId, tenantId) {
  return db.prepare(
    'DELETE FROM writer_memory WHERE id = $1 AND tenant_id = $2'
  ).run(memoryId, tenantId);
}

module.exports = { extractAndStoreMemories, getRelevantMemories, deleteMemory };
