/**
 * Deep Feed AI — Writing Styles API (admin)
 *
 * GET    /admin/writing-styles              — list system + tenant styles
 * POST   /admin/writing-styles              — create tenant style
 * GET    /admin/writing-styles/:id          — single style
 * PUT    /admin/writing-styles/:id          — update (own styles only)
 * DELETE /admin/writing-styles/:id          — delete (own styles only)
 * POST   /admin/writing-styles/preview      — AI preview of a style
 * POST   /admin/writing-styles/:id/fork     — fork system style into tenant
 * POST   /admin/writing-styles/restyle/:articleId — restyle article with style
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { complete }     = require('../lib/ai-router');

const SAMPLE_TEXT = `Researchers at MIT have developed a new technique that reduces the energy consumption of large language models by 40 percent without degrading output quality. The method, called selective activation pruning, identifies and disables redundant neural pathways during inference. The team tested the approach across five leading open-source models and published their findings in Nature. Industry observers say the technique could significantly lower the cost of running AI at scale.`;

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
}

// ── List ─────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, tenant_id, name, slug, description, category, is_system, sort_order, created_at, updated_at
    FROM writing_styles
    WHERE tenant_id = 0 OR tenant_id = $1
    ORDER BY is_system DESC, sort_order ASC, name ASC
  `).all(req.tenantId);
  res.json(rows);
}));

// ── Single ───────────────────────────────────────────────────────
router.get('/preview', (req, res) => res.status(400).json({ error: 'Use POST for preview' }));

router.get('/:id', asyncHandler(async (req, res) => {
  const row = await db.prepare(
    'SELECT * FROM writing_styles WHERE id = $1 AND (tenant_id = 0 OR tenant_id = $2)'
  ).get(parseInt(req.params.id), req.tenantId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
}));

// ── Create ───────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  const { name, description, prompt, category = 'general' } = req.body;
  if (!name?.trim() || !prompt?.trim()) return res.status(400).json({ error: 'name and prompt required' });
  const slug = slugify(name.trim());
  const row = await db.prepare(`
    INSERT INTO writing_styles (tenant_id, name, slug, description, prompt, category, is_system, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, false, 100) RETURNING *
  `).get(req.tenantId, name.trim().slice(0, 100), slug, description || null, prompt.trim(), category);
  res.status(201).json(row);
}));

// ── Update ───────────────────────────────────────────────────────
router.put('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const style = await db.prepare('SELECT * FROM writing_styles WHERE id = $1').get(id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (style.tenant_id !== req.tenantId) return res.status(403).json({ error: 'Cannot modify system or other-tenant styles — fork it first' });

  const { name, description, prompt, category } = req.body;
  const sets = ['updated_at = NOW()'];
  const params = [id, req.tenantId];

  if (name?.trim())    { params.push(name.trim().slice(0, 100)); sets.push(`name = $${params.length}`); }
  if (description !== undefined) { params.push(description || null); sets.push(`description = $${params.length}`); }
  if (prompt?.trim()) { params.push(prompt.trim()); sets.push(`prompt = $${params.length}`); }
  if (category)       { params.push(category); sets.push(`category = $${params.length}`); }

  const row = await db.prepare(
    `UPDATE writing_styles SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`
  ).get(...params);
  res.json(row);
}));

// ── Delete ───────────────────────────────────────────────────────
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const style = await db.prepare('SELECT tenant_id FROM writing_styles WHERE id = $1').get(id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (style.tenant_id !== req.tenantId) return res.status(403).json({ error: 'Cannot delete system styles' });

  await db.prepare('UPDATE writers SET style_id = NULL WHERE style_id = $1 AND tenant_id = $2').run(id, req.tenantId);
  await db.prepare('DELETE FROM writing_styles WHERE id = $1 AND tenant_id = $2').run(id, req.tenantId);
  res.json({ ok: true });
}));

// ── Preview ──────────────────────────────────────────────────────
router.post('/preview', asyncHandler(async (req, res) => {
  const { styleId, prompt: customPrompt, text } = req.body;
  let stylePrompt = customPrompt?.trim();

  if (!stylePrompt && styleId) {
    const row = await db.prepare(
      'SELECT prompt FROM writing_styles WHERE id = $1 AND (tenant_id = 0 OR tenant_id = $2)'
    ).get(parseInt(styleId), req.tenantId);
    if (!row) return res.status(404).json({ error: 'Style not found' });
    stylePrompt = row.prompt;
  }

  if (!stylePrompt) return res.status(400).json({ error: 'styleId or prompt required' });

  const sourceText = (text?.trim()) || SAMPLE_TEXT;

  const result = await complete({
    operation:   'writing-style-preview',
    tenantId:    req.tenantId,
    messages: [
      { role: 'system', content: stylePrompt },
      {
        role: 'user',
        content: `Rewrite the following news paragraph in your assigned writing style. Preserve all facts. Output only the rewritten text — no preamble, no labels.\n\n---\n${sourceText}`,
      },
    ],
    maxTokens:   600,
    temperature: 0.7,
    trigger:     'admin',
  });

  res.json({ preview: result?.content || result?.text || '' });
}));

// ── Fork ─────────────────────────────────────────────────────────
router.post('/:id/fork', asyncHandler(async (req, res) => {
  const source = await db.prepare(
    'SELECT * FROM writing_styles WHERE id = $1 AND (tenant_id = 0 OR tenant_id = $2)'
  ).get(parseInt(req.params.id), req.tenantId);
  if (!source) return res.status(404).json({ error: 'Style not found' });

  const baseName = `${source.name} (custom)`;
  let slug = slugify(baseName);
  // Ensure uniqueness within tenant
  const existing = await db.prepare(
    'SELECT id FROM writing_styles WHERE tenant_id = $1 AND slug = $2'
  ).get(req.tenantId, slug);
  if (existing) slug = slug + '-' + Date.now().toString(36);

  const row = await db.prepare(`
    INSERT INTO writing_styles (tenant_id, name, slug, description, prompt, category, is_system, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, false, 100) RETURNING *
  `).get(req.tenantId, baseName.slice(0, 100), slug, source.description, source.prompt, source.category);

  res.status(201).json(row);
}));

// ── Restyle article ──────────────────────────────────────────────
router.post('/restyle/:articleId', asyncHandler(async (req, res) => {
  const articleId = parseInt(req.params.articleId);
  const { styleId } = req.body;
  if (!styleId) return res.status(400).json({ error: 'styleId required' });

  const [article, style] = await Promise.all([
    db.prepare('SELECT id, title, generated_title, full_content, summary FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, req.tenantId),
    db.prepare('SELECT * FROM writing_styles WHERE id = $1 AND (tenant_id = 0 OR tenant_id = $2)').get(parseInt(styleId), req.tenantId),
  ]);

  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (!style)   return res.status(404).json({ error: 'Style not found' });

  const title   = article.generated_title || article.title || '';
  const content = article.full_content || article.summary || '';
  if (!content) return res.status(400).json({ error: 'Article has no content to restyle' });

  const result = await complete({
    operation:   'writing-style-restyle',
    tenantId:    req.tenantId,
    messages: [
      { role: 'system', content: style.prompt },
      {
        role: 'user',
        content: `Rewrite this article in your assigned writing style. Preserve all facts and information exactly — only the voice, structure, and presentation should change. Output only the rewritten article body — no title, no preamble, no labels.\n\nTitle: ${title}\n\n---\n${content}`,
      },
    ],
    maxTokens:   2000,
    temperature: 0.7,
    trigger:     'admin',
  });

  const restyled = result?.content || result?.text || '';

  await db.prepare(
    'UPDATE articles SET restyled_content = $1, restyle_style_id = $2 WHERE id = $3 AND tenant_id = $4'
  ).run(restyled, style.id, articleId, req.tenantId);

  res.json({ ok: true, restyled, styleId: style.id, styleName: style.name });
}));

module.exports = router;
