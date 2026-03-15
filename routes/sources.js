const express               = require('express');
const router                = express.Router();
const db                    = require('../db');
const { auth }              = require('../middleware/auth');
const { asyncHandler }      = require('../lib/utils');
const { sourceCreate, sourceUpdate, validate } = require('../lib/schemas');

// GET /api/sources
router.get('/', auth, asyncHandler(async (req, res) => {
  const sources = await db.prepare('SELECT * FROM sources ORDER BY priority ASC, created_at DESC').all();
  res.json(sources);
}));

// POST /api/sources
router.post('/', auth, asyncHandler(async (req, res) => {
  const body = validate(sourceCreate, req.body, res);
  if (!body) return;

  const { name, url, priority, is_active, auto_publish, auto_publish_max, default_category } = body;
  const source = await db.prepare(
    'INSERT INTO sources (name, url, priority, is_active, auto_publish, auto_publish_max, default_category) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *'
  ).get(name, url, priority, is_active ? 1 : 0, auto_publish ? 1 : 0, auto_publish_max, default_category || null);
  res.status(201).json(source);
}));

// PUT /api/sources/:id
router.put('/:id', auth, asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM sources WHERE id = $1').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Source not found' });

  const body = validate(sourceUpdate, req.body, res);
  if (!body) return;

  const { name, url, priority, is_active, auto_publish, auto_publish_max, default_category } = body;
  const updated = await db.prepare(
    'UPDATE sources SET name = $1, url = $2, priority = $3, is_active = $4, auto_publish = $5, auto_publish_max = $6, default_category = $7 WHERE id = $8 RETURNING *'
  ).get(
    name             ?? existing.name,
    url              ?? existing.url,
    priority         ?? existing.priority,
    is_active        !== undefined ? (is_active ? 1 : 0) : existing.is_active,
    auto_publish     !== undefined ? (auto_publish ? 1 : 0) : existing.auto_publish,
    auto_publish_max ?? existing.auto_publish_max,
    default_category !== undefined ? (default_category || null) : existing.default_category,
    req.params.id
  );
  res.json(updated);
}));

// DELETE /api/sources/:id
router.delete('/:id', auth, asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM sources WHERE id = $1').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Source not found' });
  await db.prepare('DELETE FROM sources WHERE id = $1').run(req.params.id);
  res.json({ message: 'Source deleted' });
}));

// PUT /api/sources/:id/toggle
router.put('/:id/toggle', auth, asyncHandler(async (req, res) => {
  const source = await db.prepare('SELECT * FROM sources WHERE id = $1').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Source not found' });
  const newVal = source.is_active ? 0 : 1;
  await db.prepare('UPDATE sources SET is_active = $1 WHERE id = $2').run(newVal, req.params.id);
  res.json({ id: source.id, is_active: newVal });
}));

module.exports = router;
