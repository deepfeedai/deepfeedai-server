/**
 * Deep Feed AI Admin — GET /api/summary
 * Generates a structured AI TLDR using Gemini Flash.
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
const { logUsage, extractGeminiTokens } = require('../lib/ai-usage');
const { canSpend } = require('../lib/budget');
const { getGeminiKey } = require('../lib/gemini-config');
const db               = require('../db');
const { buildWriterPrompt } = require('../lib/writer-assign');

const GEMINI_MODEL  = 'gemini-2.5-flash-lite';
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const CACHE_TTL_DAYS = 7;
const CACHE_MAX_ROWS = 1000; // hard cap — prune oldest beyond this

function cacheKey(title, writerId) {
  const base = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
  return writerId ? `w${writerId}_${base}` : base;
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

// GET /api/summary?title=...&description=...
router.get('/', asyncHandler(async (req, res) => {
  const apiKey = await getGeminiKey(req.tenantId);
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured.' });

  const { title = '', description = '', writer_id } = req.query;
  if (!title) return res.status(400).json({ error: 'title param required.' });

  const writerId = writer_id ? parseInt(writer_id) : null;
  const key = cacheKey(title, writerId);

  const cached = await getCached(key, req.tenantId);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json({ summary: cached });
  }

  // Build persona: use writer's style if writer_id provided, otherwise site-level
  let persona;
  if (writerId) {
    try {
      const writer = await db.prepare(
        'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
      ).get(writerId, req.tenantId);
      if (writer) {
        persona = await buildWriterPrompt(writer);
      }
    } catch { /* fall back to site persona */ }
  }
  if (!persona) {
    const site = await getSiteConfig(req.tenantId);
    persona = site.ai_persona || 'You are a tech news analyst for Deep Feed AI, an AI news aggregator.';
  }

  const isWriterStyled = !!writerId && persona !== undefined;
  const prompt = [
    persona,
    '',
    isWriterStyled
      ? 'Write your analysis in your own voice and style as described above. Respond with ONLY valid JSON (no markdown, no code fences) in this exact shape:'
      : 'Analyze this article and respond with ONLY valid JSON (no markdown, no code fences) in this exact shape:',
    '{',
    '  "overview": "2 clear sentences summarizing what happened and who is involved.",',
    '  "keyPoints": ["specific fact or detail", "specific number, date, or technical detail", "notable reaction, implication, or next step"],',
    isWriterStyled
      ? '  "whyItMatters": "One sentence on why this matters, written in your distinctive voice."'
      : '  "whyItMatters": "One sentence on the broader significance for the AI industry."',
    '}',
    isWriterStyled
      ? 'Rules: Stay in character. Use your tone and style throughout. No generic language. keyPoints must be 3 concise bullet strings.'
      : 'Rules: Be specific and factual. No fluff. No "In this article..." opener. keyPoints must be 3 concise bullet strings.',
    '',
    `Title: ${title.replace(/[\x00-\x1F]/g, '').slice(0, 300)}`,
    description ? `Context: ${description.replace(/[\x00-\x1F]/g, '').slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');

  const _start = Date.now();
  const upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
    }),
  });

  if (!upstream.ok) {
    const err = await upstream.text();
    console.error('[Summary] Gemini error:', err);
    logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'summary', trigger: 'page-load', durationMs: Date.now() - _start, success: false, error: err, tenantId: req.tenantId }).catch(() => {});
    return res.status(upstream.status).json({ error: 'Summary generation failed.' });
  }

  const data = await upstream.json();
  const _tokens = extractGeminiTokens(data);
  logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'summary', trigger: 'page-load', inputTokens: _tokens.promptTokenCount, outputTokens: _tokens.candidatesTokenCount, durationMs: Date.now() - _start, tenantId: req.tenantId }).catch(() => {});
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!raw) return res.status(502).json({ error: 'No summary returned.' });

  let structured;
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    structured = JSON.parse(cleaned);
  } catch {
    structured = { overview: raw, keyPoints: [], whyItMatters: '' };
  }

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
    const apiKey = await getGeminiKey(tenantId);
    if (!apiKey || !title) return null;

    const key = cacheKey(title, writerId);
    const existing = await getCached(key, tenantId);
    if (existing) return existing; // already cached

    // Budget check for automated pre-warming
    const budgetCheck = await canSpend('summary', tenantId);
    if (!budgetCheck.allowed) return null;

    // Build persona: use writer's style if writerId provided
    let persona;
    if (writerId) {
      try {
        const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, tenantId);
        if (writer) persona = await buildWriterPrompt(writer);
      } catch { /* fall back */ }
    }
    if (!persona) {
      const site = await getSiteConfig(tenantId);
      persona = site.ai_persona || 'You are a tech news analyst for Deep Feed AI, an AI news aggregator.';
    }

    const isWriterStyled = !!writerId && persona !== undefined;
    const prompt = [
      persona,
      '',
      isWriterStyled
        ? 'Write your analysis in your own voice and style as described above. Respond with ONLY valid JSON (no markdown, no code fences) in this exact shape:'
        : 'Analyze this article and respond with ONLY valid JSON (no markdown, no code fences) in this exact shape:',
      '{',
      '  "overview": "2 clear sentences summarizing what happened and who is involved.",',
      '  "keyPoints": ["specific fact or detail", "specific number, date, or technical detail", "notable reaction, implication, or next step"],',
      isWriterStyled
        ? '  "whyItMatters": "One sentence on why this matters, written in your distinctive voice."'
        : '  "whyItMatters": "One sentence on the broader significance for the AI industry."',
      '}',
      isWriterStyled
        ? 'Rules: Stay in character. Use your tone and style throughout. No generic language. keyPoints must be 3 concise bullet strings.'
        : 'Rules: Be specific and factual. No fluff. No "In this article..." opener. keyPoints must be 3 concise bullet strings.',
      '',
      `Title: ${title}`,
      description ? `Context: ${description.slice(0, 800)}` : '',
    ].filter(Boolean).join('\n');

    const _pwStart = Date.now();
    const upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
      }),
    });
    if (!upstream.ok) {
      logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'summary', trigger: 'auto-assign', durationMs: Date.now() - _pwStart, success: false, error: `${upstream.status}`, tenantId }).catch(() => {});
      return null;
    }

    const data = await upstream.json();
    const _pwTokens = extractGeminiTokens(data);
    logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'summary', trigger: 'auto-assign', inputTokens: _pwTokens.promptTokenCount, outputTokens: _pwTokens.candidatesTokenCount, durationMs: Date.now() - _pwStart, tenantId }).catch(() => {});
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) return null;

    let structured;
    try {
      const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      structured = JSON.parse(cleaned);
    } catch {
      structured = { overview: raw, keyPoints: [], whyItMatters: '' };
    }

    await setCached(key, structured, tenantId);
    return structured;
  } catch { return null; }
}

module.exports = router;
module.exports.prewarmSummary = prewarmSummary;
