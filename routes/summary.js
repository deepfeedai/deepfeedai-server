/**
 * Deep Feed AI Admin — GET /api/summary
 * Generates a structured AI TLDR using the configured AI provider.
 * Cache stored in Postgres summary_cache table (survives deploys, shared across instances).
 * TTL: 7 days — old entries pruned on each cache miss.
 *
 * Query params:
 *   title       — article headline
 *   description — existing snippet (optional)
 */
const express          = require('express');
const router           = express.Router();
const { getPool }      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { getSiteConfig } = require('../lib/site-config');
const db               = require('../db');
const { buildWriterPrompt } = require('../lib/writer-assign');
const { complete: aiComplete } = require('../lib/ai-router');

const CACHE_TTL_DAYS = 7;
const CACHE_MAX_ROWS = 1000; // hard cap — prune oldest beyond this

function cacheKey(title, writerId) {
  const base = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
  return writerId ? `v2_w${writerId}_${base}` : `v2_${base}`;
}

async function getCached(key, tenantId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT payload FROM summary_cache
     WHERE tenant_id = $1 AND cache_key = $2
       AND created_at > NOW() - INTERVAL '7 days'`,
    [tenantId, key]
  );
  return result.rows[0]?.payload || null;
}

async function setCached(key, payload, tenantId) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO summary_cache (tenant_id, cache_key, payload, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id, cache_key) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
    [tenantId, key, JSON.stringify(payload)]
  );
  // Prune stale entries and enforce hard row cap — best effort, non-blocking
  pool.query(
    `DELETE FROM summary_cache
     WHERE tenant_id = $1 AND cache_key IN (
       SELECT cache_key FROM summary_cache
       WHERE tenant_id = $1 AND (created_at <= NOW() - INTERVAL '7 days'
          OR cache_key IN (
               SELECT cache_key FROM summary_cache
               WHERE tenant_id = $1
               ORDER BY created_at DESC
               OFFSET 1000
             ))
       LIMIT 200
     )`,
    [tenantId]
  ).catch(() => {});
}

/**
 * Build the summary prompt for a given title/description and persona.
 */
function buildSummaryPrompt(title, description, persona, isWriterStyled) {
  return [
    persona,
    '',
    isWriterStyled
      ? 'Write your analysis in your own voice and style as described above. Respond with ONLY valid JSON (no markdown, no code fences) in this exact shape:'
      : 'Analyze this article and respond with ONLY valid JSON (no markdown, no code fences) in this exact shape:',
    '{',
    '  "headline": "Rewritten headline — clear, specific, max 90 chars. Not clickbait.",',
    '  "overview": "2 clear sentences summarizing what happened and who is involved.",',
    '  "context": "One sentence of backstory or context a reader needs to understand why this matters.",',
    '  "keyPoints": ["specific fact or detail", "another key detail (1-4 items, as many as the story warrants)"],',
    '  "topicTag": "2-4 word story thread label, e.g. \'OpenAI Safety\', \'Chip Export Controls\'",',
    isWriterStyled
      ? '  "whyItMatters": "One sentence on why this matters, written in your distinctive voice."'
      : '  "whyItMatters": "One sentence on the broader significance for the AI industry."',
    '}',
    'Rules:',
    '- headline: rewrite the title for clarity — no clickbait, no "How...", no "Why...", max 90 chars',
    '- keyPoints: 1-4 items based on substance — not always 3. Include numbers, dates, names when available.',
    '- topicTag: a short label for the ongoing story thread (used to group related articles). Use title case.',
    '- No "In this article..." or "This article discusses..." openers.',
    isWriterStyled
      ? '- Stay in character. Use your tone and style throughout. No generic language.'
      : '- Be specific and factual. No fluff.',
    '',
    `Title: ${title.replace(/[\x00-\x1F]/g, '').slice(0, 300)}`,
    description ? `Context: ${description.replace(/[\x00-\x1F]/g, '').slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Parse raw AI response into structured summary.
 */
function parseStructured(raw) {
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { overview: raw, keyPoints: [], whyItMatters: '' };
  }
}

/**
 * Resolve persona for a summary request.
 */
async function resolvePersona(writerId, tenantId) {
  let persona;
  if (writerId) {
    try {
      const writer = await db.prepare(
        'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
      ).get(writerId, tenantId);
      if (writer) {
        persona = await buildWriterPrompt(writer);
      }
    } catch { /* fall back to site persona */ }
  }
  if (!persona) {
    const site = await getSiteConfig(tenantId);
    persona = site.ai_persona || 'You are a tech news analyst for Deep Feed AI, an AI news aggregator.';
  }
  return persona;
}

// GET /api/summary?title=...&description=...
router.get('/', asyncHandler(async (req, res) => {
  const { title = '', description = '', writer_id } = req.query;
  if (!title) return res.status(400).json({ error: 'title param required.' });

  const writerId = writer_id ? parseInt(writer_id) : null;
  const key = cacheKey(title, writerId);

  const cached = await getCached(key, req.tenantId);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json({ summary: cached });
  }

  const persona = await resolvePersona(writerId, req.tenantId);
  const isWriterStyled = !!writerId;
  const prompt = buildSummaryPrompt(title, description, persona, isWriterStyled);

  const result = await aiComplete({
    operation: 'summary',
    tenantId: req.tenantId,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    maxTokens: 600,
    trigger: 'page-load',
  });

  if (!result) {
    return res.status(429).json({ error: 'Budget exhausted.' });
  }

  const raw = (result.text || '').trim();
  if (!raw) return res.status(502).json({ error: 'No summary returned.' });

  const structured = parseStructured(raw);
  await setCached(key, structured, req.tenantId);

  res.setHeader('X-Cache', 'MISS');
  return res.json({ summary: structured });
}));

/**
 * Pre-warm the summary cache for a given title + description.
 * Used by synthesis pipeline to ensure the first page visitor never waits.
 * Returns the structured summary or null on failure.
 */
async function prewarmSummary(title, description, tenantId, writerId) {
  try {
    if (!title) return null;

    const key = cacheKey(title, writerId);
    const existing = await getCached(key, tenantId);
    if (existing) return existing; // already cached

    const persona = await resolvePersona(writerId, tenantId);
    const isWriterStyled = !!writerId;
    const prompt = buildSummaryPrompt(title, description || '', persona, isWriterStyled);

    const result = await aiComplete({
      operation: 'summary',
      tenantId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: 500,
      trigger: 'auto-assign',
    });

    if (!result) return null; // budget denied
    const raw = (result.text || '').trim();
    if (!raw) return null;

    const structured = parseStructured(raw);
    await setCached(key, structured, tenantId);
    return structured;
  } catch { return null; }
}

module.exports = router;
module.exports.prewarmSummary = prewarmSummary;
