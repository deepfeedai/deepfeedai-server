/**
 * Deep Feed AI Admin — lib/categorize.js
 * Data-driven category detection using keywords, RSS tags, source defaults,
 * and Gemini AI fallback for low-confidence results.
 * Single source of truth — imported by routes/fetch.js (server-side RSS ingestion).
 */
'use strict';

const { getCategories } = require('./categories');

const CONFIDENCE_THRESHOLD = 3;

/** Escape special regex characters so keywords can be used in RegExp safely. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a word-boundary regex for a keyword (case-insensitive). */
function buildKeywordRegex(keyword) {
  return new RegExp('\\b' + escapeRegExp(keyword) + '\\b', 'i');
}

/**
 * Detect the most likely category for an RSS feed item.
 *
 * Scoring:
 *  - +2 per keyword match in title (word-boundary)
 *  - +1 per keyword match in body  (word-boundary)
 *  - +1 per keyword match in RSS <category> tags
 *  - +3 if source has a default_category matching this category
 *
 * When confidence is low (score < 3), falls back to Gemini AI classification.
 *
 * @param {object} item — RSS item with title, categories, contentSnippet, content fields.
 * @param {{ defaultCategory?: string }} [opts]
 * @returns {Promise<string>} Category name.
 */
async function detectCategory(item, { defaultCategory } = {}) {
  const title = (item.title || '').toLowerCase();
  const body  = [
    item.contentSnippet || '',
    item.content        || '',
  ].join(' ').toLowerCase();

  // Extract RSS <category> tags separately for dedicated scoring
  const rssTags = (item.categories || []).map(t => t.toLowerCase());

  const categories = await getCategories();
  if (!categories.length) return 'Industry';

  let best = null;
  let bestScore = 0;

  for (const cat of categories) {
    let score = 0;

    // Source-level default category bias
    if (defaultCategory && cat.name.toLowerCase() === defaultCategory.toLowerCase()) {
      score += 3;
    }

    if (cat.keywords && cat.keywords.length) {
      for (const kw of cat.keywords) {
        if (kw.length < 2) continue; // skip single-char keywords
        const regex = buildKeywordRegex(kw);
        if (regex.test(title)) score += 2;
        if (regex.test(body))  score += 1;
        for (const tag of rssTags) {
          if (regex.test(tag)) { score += 1; break; } // +1 per keyword, not per tag
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = cat.name;
    }
  }

  // Low confidence — try Gemini AI fallback
  if (bestScore < CONFIDENCE_THRESHOLD) {
    const categoryNames = categories.map(c => c.name);
    const aiCategory = await classifyWithGemini(item.title || '', body, categoryNames);
    if (aiCategory) return aiCategory;
  }

  return best || categories[categories.length - 1]?.name || 'Industry';
}

/**
 * Gemini AI fallback for low-confidence categorization.
 * Budget-checked and fire-and-forget logged.
 * @returns {Promise<string|null>} Category name or null on failure.
 */
async function classifyWithGemini(title, body, categoryNames) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const { canSpend } = require('./budget');
    const budgetCheck = await canSpend('categorize');
    if (!budgetCheck.allowed) return null;
  } catch { return null; }

  const { logUsage, extractGeminiTokens } = require('./ai-usage');

  const GEMINI_MODEL = 'gemini-2.5-flash-lite';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const prompt = [
    'Classify this article into exactly one of these categories: ' + categoryNames.join(', '),
    'Respond with ONLY the category name, nothing else.',
    '',
    `Title: ${title}`,
    body ? `Content: ${body.slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');

  const _start = Date.now();
  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 20 },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'categorize', trigger: 'auto', durationMs: Date.now() - _start, success: false, error: `${res.status}` }).catch(() => {});
      return null;
    }

    const data = await res.json();
    const _tokens = extractGeminiTokens(data);
    logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'categorize', trigger: 'auto', inputTokens: _tokens.promptTokenCount, outputTokens: _tokens.candidatesTokenCount, durationMs: Date.now() - _start }).catch(() => {});

    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    const match = categoryNames.find(n => n.toLowerCase() === raw.toLowerCase());
    return match || null;
  } catch {
    return null;
  }
}

module.exports = { detectCategory };
