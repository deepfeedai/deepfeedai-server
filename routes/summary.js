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

const GEMINI_MODEL  = 'gemini-2.5-flash-lite';
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const CACHE_TTL_DAYS = 7;
const CACHE_MAX_ROWS = 1000; // hard cap — prune oldest beyond this

function cacheKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
}

async function getCached(key) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT payload FROM summary_cache
     WHERE cache_key = $1
       AND created_at > NOW() - INTERVAL '${CACHE_TTL_DAYS} days'`,
    [key]
  );
  return result.rows[0]?.payload || null;
}

async function setCached(key, payload) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO summary_cache (cache_key, payload, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
    [key, JSON.stringify(payload)]
  );
  // Prune stale entries and enforce hard row cap — best effort, non-blocking
  pool.query(
    `DELETE FROM summary_cache
     WHERE cache_key IN (
       SELECT cache_key FROM summary_cache
       WHERE created_at <= NOW() - INTERVAL '${CACHE_TTL_DAYS} days'
          OR cache_key IN (
               SELECT cache_key FROM summary_cache
               ORDER BY created_at DESC
               OFFSET ${CACHE_MAX_ROWS}
             )
       LIMIT 200
     )`
  ).catch(() => {});
}

// GET /api/summary?title=...&description=...
router.get('/', asyncHandler(async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured.' });

  const { title = '', description = '' } = req.query;
  if (!title) return res.status(400).json({ error: 'title param required.' });

  const key = cacheKey(title);

  const cached = await getCached(key);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json({ summary: cached });
  }

  const prompt = [
    'You are a tech news analyst for Deep Feed AI, an AI news aggregator.',
    'Analyze this article and respond with ONLY valid JSON (no markdown, no code fences) in this exact shape:',
    '{',
    '  "overview": "2 clear sentences summarizing what happened and who is involved.",',
    '  "keyPoints": ["specific fact or detail", "specific number, date, or technical detail", "notable reaction, implication, or next step"],',
    '  "whyItMatters": "One sentence on the broader significance for the AI industry."',
    '}',
    'Rules: Be specific and factual. No fluff. No "In this article..." opener. keyPoints must be 3 concise bullet strings.',
    '',
    `Title: ${title}`,
    description ? `Context: ${description}` : '',
  ].filter(Boolean).join('\n');

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
    return res.status(upstream.status).json({ error: 'Summary generation failed.' });
  }

  const data = await upstream.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!raw) return res.status(502).json({ error: 'No summary returned.' });

  let structured;
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    structured = JSON.parse(cleaned);
  } catch {
    structured = { overview: raw, keyPoints: [], whyItMatters: '' };
  }

  await setCached(key, structured);

  res.setHeader('X-Cache', 'MISS');
  return res.json({ summary: structured });
}));

module.exports = router;
