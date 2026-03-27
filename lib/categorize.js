/**
 * Deep Feed AI Admin — lib/categorize.js
 * Data-driven category detection using keywords, RSS tags, source defaults,
 * source affinity, few-shot examples, and AI fallback (via ai-router).
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
 * Fetch the 3 most recent published article titles per category for few-shot examples.
 */
async function getRecentExamples(tenantId, limit = 3) {
  const db = require('../db');
  try {
    const rows = await db.prepare(`
      SELECT category, title FROM articles
      WHERE tenant_id = $1 AND is_published = 1 AND category IS NOT NULL
      ORDER BY published_at DESC
      LIMIT 100
    `).all(tenantId);

    // Group by category, take first N per category
    const byCategory = {};
    for (const row of rows) {
      if (!byCategory[row.category]) byCategory[row.category] = [];
      if (byCategory[row.category].length < limit) {
        byCategory[row.category].push(row.title);
      }
    }
    return byCategory;
  } catch { return {}; }
}

/**
 * Check historical categorization for a source to find dominant category.
 */
async function getSourceAffinity(sourceUrl, tenantId) {
  const db = require('../db');
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./, '');
    const rows = await db.prepare(`
      SELECT category, COUNT(*) as cnt FROM articles
      WHERE tenant_id = $1 AND source LIKE $2 AND category IS NOT NULL
      GROUP BY category ORDER BY cnt DESC LIMIT 3
    `).all(tenantId, '%' + hostname + '%');

    if (rows.length && rows[0].cnt >= 5) {
      const total = rows.reduce((sum, r) => sum + parseInt(r.cnt), 0);
      if (parseInt(rows[0].cnt) / total >= 0.6) {
        return { category: rows[0].category, confidence: parseInt(rows[0].cnt) / total };
      }
    }
    return null;
  } catch { return null; }
}

/**
 * Learn from manual category corrections by extracting keywords from the title
 * and adding them to the new category's keyword list.
 */
async function learnFromCorrection(articleTitle, newCategory, tenantId) {
  const db = require('../db');
  const STOP_WORDS = new Set(['the','and','for','are','but','not','you','all','can','had','her','was','one','our','out','has','its','let','may','who','how','did','get','got','new','now','old','see','way','day','too','use','set','say','she','two','big','few','top','end','any','own','off','add','ago','run','try','ask','put','low','key','via','per']);

  const words = articleTitle.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  if (!words.length) return;

  try {
    const cat = await db.prepare(
      'SELECT id, keywords FROM categories WHERE tenant_id = $1 AND name = $2'
    ).get(tenantId, newCategory);
    if (!cat) return;

    const existing = Array.isArray(cat.keywords) ? cat.keywords : [];
    const existingLower = new Set(existing.map(k => k.toLowerCase()));

    // Add new unique keywords (max 5 from this correction)
    const newKeywords = words
      .filter(w => !existingLower.has(w))
      .slice(0, 5);

    if (newKeywords.length) {
      const updated = [...existing, ...newKeywords];
      await db.prepare(
        'UPDATE categories SET keywords = $1 WHERE id = $2 AND tenant_id = $3'
      ).run(JSON.stringify(updated), cat.id, tenantId);
      console.log(`[Categorize] Learned ${newKeywords.length} keywords for "${newCategory}" from correction: ${newKeywords.join(', ')}`);
    }
  } catch (err) {
    console.error('[Categorize] Learn error:', err.message);
  }
}

/**
 * Detect the most likely category for an RSS feed item.
 *
 * Flow:
 *  1. Keyword scoring (fast, free)
 *  2. Source affinity boost (+2 for dominant category)
 *  3. If score >= CONFIDENCE_THRESHOLD (3), return winner
 *  4. If score < threshold, call AI with descriptions + few-shot examples
 *  5. If AI returns a match, return it
 *  6. Fall back to best keyword score or first category
 *
 * @param {object} item — RSS item with title, categories, contentSnippet, content fields.
 * @param {{ defaultCategory?: string, tenantId?: number }} [opts]
 * @returns {Promise<string>} Category name.
 */
async function detectCategory(item, { defaultCategory, tenantId = 1 } = {}) {
  const title = (item.title || '').toLowerCase();
  const body  = [
    item.contentSnippet || '',
    item.content        || '',
  ].join(' ').toLowerCase();

  // Extract RSS <category> tags separately for dedicated scoring
  const rssTags = (item.categories || []).map(t => t.toLowerCase());

  const categories = await getCategories(tenantId);
  if (!categories.length) return 'General';

  const scores = {};
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

    scores[cat.name] = score;
  }

  // Source affinity boost
  const sourceUrl = item.sourceUrl || item.link;
  if (sourceUrl) {
    const affinity = await getSourceAffinity(sourceUrl, tenantId);
    if (affinity && scores[affinity.category] !== undefined) {
      scores[affinity.category] += 2;
    }
  }

  // Find best scoring category
  let best = null;
  let bestScore = 0;
  for (const [catName, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = catName;
    }
  }

  // Low confidence — try AI fallback with descriptions + few-shot examples
  if (bestScore < CONFIDENCE_THRESHOLD) {
    const examples = await getRecentExamples(tenantId);
    const aiCategory = await classifyWithAI(item.title || '', body, categories, examples, tenantId);
    if (aiCategory) return aiCategory;

    // Neither keywords nor AI produced a confident match — leave uncategorized
    // for manual review rather than forcing a low-confidence guess
    return 'Uncategorized';
  }

  return best || categories[0]?.name || 'General';
}

/**
 * AI fallback for low-confidence categorization.
 * Uses category descriptions and few-shot examples for better accuracy.
 * Routes through ai-router for multi-provider support.
 * @returns {Promise<string|null>} Category name or null on failure.
 */
async function classifyWithAI(title, body, allCategories, examples, tenantId = 1) {
  const { complete } = require('./ai-router');
  const categoryNames = allCategories.map(c => c.name);

  const lines = ['You are a news article classifier. Classify the following article into exactly ONE of these categories, OR respond with "NONE" if the article does not clearly fit any category.', ''];

  for (const catName of categoryNames) {
    let line = `- ${catName}`;
    const catObj = allCategories.find(c => c.name === catName);
    if (catObj?.description) line += `: ${catObj.description}`;
    if (examples[catName]?.length) {
      line += ` (examples: "${examples[catName].join('", "')}")`;
    }
    lines.push(line);
  }
  lines.push('- NONE: The article does not fit any of the above categories');

  lines.push('');
  lines.push(`Article title: ${title}`);
  if (body) lines.push(`Article excerpt: ${body.slice(0, 600)}`);
  lines.push('');
  lines.push('Respond with ONLY the category name or "NONE", nothing else.');

  const prompt = lines.join('\n');

  try {
    const result = await complete({
      operation: 'categorize',
      tenantId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: 20,
      trigger: 'auto',
    });

    if (!result) return null; // budget denied

    const raw = (result.text || '').trim();
    const match = categoryNames.find(n => n.toLowerCase() === raw.toLowerCase());
    return match || null;
  } catch {
    return null;
  }
}

module.exports = { detectCategory, learnFromCorrection };
