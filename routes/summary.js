/**
 * Deep Feed AI Admin — GET /api/summary
 * Generates a structured AI TLDR using Gemini Flash.
 * In-memory cache (per process) — same interface as the Vercel /api/summary function.
 *
 * Query params:
 *   title       — article headline
 *   description — existing snippet (optional)
 */
const express = require('express');
const router  = express.Router();

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Simple in-memory cache (slug → structured summary)
const summaryCache = new Map();

function cacheKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
}

// GET /api/summary?title=...&description=...
router.get('/', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured.' });

  const { title = '', description = '' } = req.query;
  if (!title) return res.status(400).json({ error: 'title param required.' });

  const key = cacheKey(title);

  // Serve from in-memory cache
  if (summaryCache.has(key)) {
    res.setHeader('X-Cache', 'HIT');
    return res.json({ summary: summaryCache.get(key) });
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

  try {
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

    // Cache it (cap at 500 entries)
    if (summaryCache.size >= 500) summaryCache.delete(summaryCache.keys().next().value);
    summaryCache.set(key, structured);

    res.setHeader('X-Cache', 'MISS');
    return res.json({ summary: structured });

  } catch (err) {
    console.error('[Summary] Error:', err.message);
    return res.status(502).json({ error: 'Failed to generate summary.' });
  }
});

module.exports = router;
