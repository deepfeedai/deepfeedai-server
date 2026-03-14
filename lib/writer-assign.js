/**
 * Deep Feed AI — Writer auto-assignment helpers
 */
const db = require('../db');

const { logUsage, extractGeminiTokens } = require('./ai-usage');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-2.5-flash-lite';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Common abbreviation map for normalized matching
const ABBREVIATIONS = {
  'ai':   ['artificial intelligence'],
  'ml':   ['machine learning'],
  'llm':  ['large language model', 'large language models'],
  'nlp':  ['natural language processing'],
  'cv':   ['computer vision'],
  'rl':   ['reinforcement learning'],
  'gpu':  ['graphics processing unit'],
  'api':  ['application programming interface'],
  'saas': ['software as a service'],
  'iot':  ['internet of things'],
  'ar':   ['augmented reality'],
  'vr':   ['virtual reality'],
  'xr':   ['extended reality'],
};

// Build reverse map: full phrase → abbreviation
const REVERSE_ABBREV = {};
for (const [abbr, expansions] of Object.entries(ABBREVIATIONS)) {
  for (const exp of expansions) {
    REVERSE_ABBREV[exp] = abbr;
  }
}

/**
 * Find the best auto-assign writer for an article based on beat + keyword scoring.
 * Returns the writer row or null.
 */
async function findBestWriter(article) {
  try {
    const writers = await db.prepare('SELECT * FROM writers WHERE is_auto = true').all();
    if (!writers.length) return null;

    const titleLower   = (article.title || '').toLowerCase();
    const summaryLower = (article.summary || '').toLowerCase();
    const catLower     = (article.category || '').toLowerCase();
    const combined     = titleLower + ' ' + summaryLower;

    let best = null;
    let bestScore = 0;
    let bestCount = Infinity;

    for (const w of writers) {
      let score = 0;

      // +3 if beat matches category
      if (w.beat && catLower === w.beat.toLowerCase()) score += 3;

      // Keyword matching with abbreviation expansion
      const keywords = w.keywords ? (Array.isArray(w.keywords) ? w.keywords : JSON.parse(w.keywords)) : [];
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();

        // Title matches weighted +2 (more relevant than summary)
        if (titleLower.includes(kwLower)) { score += 2; continue; }
        if (summaryLower.includes(kwLower)) { score += 1; continue; }

        // Check abbreviation expansions
        const expansions = ABBREVIATIONS[kwLower];
        if (expansions) {
          if (expansions.some(exp => combined.includes(exp))) { score += 1; continue; }
        }
        // Check reverse: keyword is a full phrase, look for abbreviation in text
        const abbr = REVERSE_ABBREV[kwLower];
        if (abbr) {
          // Match abbreviation as whole word to avoid false positives
          const abbrRegex = new RegExp(`\\b${abbr}\\b`, 'i');
          if (abbrRegex.test(combined)) { score += 1; continue; }
        }
      }

      if (score <= 0) continue;

      // Tiebreak: fewer assigned articles wins
      if (score > bestScore || (score === bestScore)) {
        const { count } = await db.prepare('SELECT COUNT(*) AS count FROM articles WHERE writer_id = $1').get(w.id);
        if (score > bestScore || count < bestCount) {
          best = w;
          bestScore = score;
          bestCount = count;
        }
      }
    }

    return best;
  } catch (err) {
    console.error('[writer-assign] findBestWriter error:', err.message);
    return null;
  }
}

/**
 * Generate a writer-styled TLDR for an article using Gemini.
 * Returns the text string or null (never throws).
 */
async function generateWriterTldr(article, writer) {
  try {
    if (!GEMINI_API_KEY) return null;

    const systemPrompt = writer.system_prompt
      || `You are ${writer.name}, a tech journalist covering ${writer.beat || 'technology'}.`;

    const prompt = `${systemPrompt}

Write a 2-3 sentence analysis of this article in your distinctive voice and style.

Article title: ${article.title}
Article summary: ${(article.summary || '').replace(/<[^>]+>/g, '').slice(0, 800)}
Source: ${article.source || 'Unknown'}
Category: ${article.category || 'Technology'}

Your analysis:`;

    const _start = Date.now();
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) {
      logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'writer-tldr', articleSlug: article.slug, writerId: writer.id, trigger: 'auto-assign', durationMs: Date.now() - _start, success: false, error: `${res.status}` }).catch(() => {});
      return null;
    }
    const data = await res.json();
    const _tokens = extractGeminiTokens(data);
    logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'writer-tldr', articleSlug: article.slug, writerId: writer.id, trigger: 'auto-assign', inputTokens: _tokens.promptTokenCount, outputTokens: _tokens.candidatesTokenCount, durationMs: Date.now() - _start }).catch(() => {});
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error('[writer-assign] generateWriterTldr error:', err.message);
    return null;
  }
}

module.exports = { findBestWriter, generateWriterTldr };
