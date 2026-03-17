/**
 * Deep Feed AI Admin — /api/categories
 * CRUD for the categories table (replaces site_categories JSON in settings).
 */
const express = require('express');
const router  = express.Router();
const { getPool } = require('../db');
const db          = require('../db');
const { auth: requireAdmin } = require('../middleware/auth');
const { requirePermission }  = require('../middleware/permissions');
const { asyncHandler }       = require('../lib/utils');
const { getCategories, bustCategoryCache } = require('../lib/categories');
const { bustSiteConfigCache } = require('../lib/site-config');
const { getGeminiKey } = require('../lib/gemini-config');

// GET /api/categories — public (frontend filter bar needs this)
router.get('/', asyncHandler(async (req, res) => {
  const cats = await getCategories(req.tenantId);
  res.json(cats);
}));

// PUT /api/categories — admin only, bulk save
// Body: array of { id?, name, color, keywords }
router.put('/', requireAdmin, requirePermission('categories.update'), asyncHandler(async (req, res) => {
  const incoming = req.body;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Expected an array of categories' });
  }

  const pool = getPool();

  // Load current categories for rename/delete detection
  const current = await db.prepare('SELECT id, name, color FROM categories WHERE tenant_id = $1 ORDER BY sort_order, id').all(req.tenantId);
  const currentById = new Map(current.map(c => [c.id, c]));

  // Clean incoming — filter out empty names
  const clean = incoming.filter(c => c.name && c.name.trim());
  const incomingIds = new Set(clean.filter(c => c.id).map(c => c.id));

  // Detect renames and deletes
  for (const old of current) {
    if (incomingIds.has(old.id)) {
      // Exists in new set — check for rename
      const updated = clean.find(c => c.id === old.id);
      if (updated && updated.name !== old.name) {
        await pool.query('UPDATE articles SET category = $1 WHERE category = $2 AND tenant_id = $3', [updated.name, old.name, req.tenantId]);
        await pool.query('UPDATE voices SET beat = $1 WHERE beat = $2 AND tenant_id = $3', [updated.name, old.name, req.tenantId]);
      }
    } else {
      // Deleted — reassign articles and writer beats to first remaining category
      const fallback = clean[0]?.name || 'Industry';
      await pool.query('UPDATE articles SET category = $1 WHERE category = $2 AND tenant_id = $3', [fallback, old.name, req.tenantId]);
      await pool.query('UPDATE voices SET beat = $1 WHERE beat = $2 AND tenant_id = $3', [fallback, old.name, req.tenantId]);
    }
  }

  // Delete removed categories
  const keepIds = clean.filter(c => c.id).map(c => c.id);
  if (keepIds.length > 0) {
    await pool.query(
      `DELETE FROM categories WHERE id != ALL($1::int[]) AND tenant_id = $2`,
      [keepIds, req.tenantId]
    );
  } else if (current.length > 0) {
    // All existing removed (new set has no ids) — delete all, they'll be re-inserted
    await pool.query('DELETE FROM categories WHERE tenant_id = $1', [req.tenantId]);
  }

  // Upsert each category
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    const kw = Array.isArray(c.keywords) ? c.keywords : [];
    const color = c.color || '#94a3b8';

    if (c.id && currentById.has(c.id)) {
      // Update existing
      await pool.query(
        `UPDATE categories SET name = $1, color = $2, keywords = $3, sort_order = $4 WHERE id = $5 AND tenant_id = $6`,
        [c.name.trim(), color, kw, i, c.id, req.tenantId]
      );
    } else {
      // Insert new
      await pool.query(
        `INSERT INTO categories (tenant_id, name, color, keywords, sort_order)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, name) DO UPDATE
         SET color = EXCLUDED.color, keywords = EXCLUDED.keywords, sort_order = EXCLUDED.sort_order`,
        [req.tenantId, c.name.trim(), color, kw, i]
      );
    }
  }

  bustCategoryCache();
  bustSiteConfigCache();

  // Return fresh list
  const cats = await getCategories(req.tenantId);
  res.json(cats);
}));

// POST /api/categories/generate-keywords — AI keyword generation for a category
router.post('/generate-keywords', requireAdmin, requirePermission('categories.update'), asyncHandler(async (req, res) => {
  const { name, existingKeywords } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });

  const apiKey = await getGeminiKey(req.tenantId);
  if (!apiKey) return res.status(503).json({ error: 'Gemini API key not configured' });

  const { logUsage, extractGeminiTokens } = require('../lib/ai-usage');

  const GEMINI_MODEL = 'gemini-2.5-flash-lite';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const existing = Array.isArray(existingKeywords) && existingKeywords.length
    ? `\nThe category currently has these keywords: ${existingKeywords.join(', ')}\nGenerate additional keywords that complement these — avoid duplicates.`
    : '';

  const allCats = await getCategories(req.tenantId);
  const otherNames = allCats.filter(c => c.name.toLowerCase() !== name.toLowerCase()).map(c => c.name);
  const otherContext = otherNames.length
    ? `\nOther categories in the system: ${otherNames.join(', ')}. Generate keywords that are specific to "${name}" and would NOT match articles belonging to those other categories.`
    : '';

  const prompt = [
    `You are helping build a keyword-based article categorization system for an AI news aggregator called Deep Feed AI.`,
    `Generate 30-50 keywords and short phrases for the category "${name}". Do NOT exceed 50 keywords.`,
    `These keywords will be matched using word-boundary regex against article titles and content to auto-categorize incoming news articles.`,
    '',
    'Rules:',
    '- Include company names, product names, technical terms, and common phrases specific to this topic',
    '- Use lowercase',
    '- Include both specific terms (e.g. "openai") and descriptive phrases (e.g. "large language model")',
    '- Avoid generic single words that could match unrelated articles (e.g. "security", "protect", "model")',
    '- Multi-word phrases are fine and encouraged for precision',
    '- Do NOT include keywords that would better fit other categories',
    existing,
    otherContext,
    '',
    'Respond with ONLY a JSON array of strings, no markdown, no explanation. Example: ["keyword1", "keyword two", "three word phrase"]',
  ].filter(Boolean).join('\n');

  const _start = Date.now();
  const upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '');
    console.error('[generate-keywords] Gemini error:', upstream.status, errBody);
    logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'generate-keywords', trigger: 'admin', durationMs: Date.now() - _start, success: false, error: `${upstream.status}` }).catch(() => {});
    return res.status(502).json({ error: `Gemini API error: ${upstream.status}` });
  }

  const data = await upstream.json();
  const _tokens = extractGeminiTokens(data);
  logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'generate-keywords', trigger: 'admin', inputTokens: _tokens.promptTokenCount, outputTokens: _tokens.candidatesTokenCount, durationMs: Date.now() - _start }).catch(() => {});

  const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  let keywords;
  try {
    // Strip markdown fences if present
    let cleaned = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    // Fix truncated JSON: trim trailing comma/whitespace and close the array
    if (!cleaned.endsWith(']')) {
      cleaned = cleaned.replace(/,\s*$/, '') + ']';
    }
    keywords = JSON.parse(cleaned);
    if (!Array.isArray(keywords)) throw new Error('Not an array');
    keywords = keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim().toLowerCase());
  } catch {
    return res.status(502).json({ error: 'Failed to parse AI response', raw });
  }

  res.json({ keywords });
}));

module.exports = router;
