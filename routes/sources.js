const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const db      = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'deepfeedai_super_secret_jwt_key_2026';

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// GET /api/sources
router.get('/', auth, async (req, res) => {
  const sources = await db.prepare('SELECT * FROM sources ORDER BY priority ASC, created_at DESC').all();
  res.json(sources);
});

// POST /api/sources
router.post('/', auth, async (req, res) => {
  const { name, url, priority, is_active, auto_publish, auto_publish_max } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });

  const source = await db.prepare(
    'INSERT INTO sources (name, url, priority, is_active, auto_publish, auto_publish_max) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
  ).get(
    name, url,
    priority         || 1,
    is_active        !== undefined ? (is_active ? 1 : 0) : 1,
    auto_publish     ? 1 : 0,
    auto_publish_max !== undefined ? parseInt(auto_publish_max, 10) : 5
  );
  res.status(201).json(source);
});

// PUT /api/sources/:id
router.put('/:id', auth, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Source not found' });

  const { name, url, priority, is_active, auto_publish, auto_publish_max } = req.body;
  const updated = await db.prepare(
    'UPDATE sources SET name = ?, url = ?, priority = ?, is_active = ?, auto_publish = ?, auto_publish_max = ? WHERE id = ? RETURNING *'
  ).get(
    name             !== undefined ? name             : existing.name,
    url              !== undefined ? url              : existing.url,
    priority         !== undefined ? priority         : existing.priority,
    is_active        !== undefined ? (is_active ? 1 : 0) : existing.is_active,
    auto_publish     !== undefined ? (auto_publish ? 1 : 0) : existing.auto_publish,
    auto_publish_max !== undefined ? parseInt(auto_publish_max, 10) : existing.auto_publish_max,
    req.params.id
  );
  res.json(updated);
});

// DELETE /api/sources/:id
router.delete('/:id', auth, async (req, res) => {
  const existing = await db.prepare('SELECT id FROM sources WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Source not found' });
  await db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  res.json({ message: 'Source deleted' });
});

// PUT /api/sources/:id/toggle
router.put('/:id/toggle', auth, async (req, res) => {
  const source = await db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Source not found' });
  const newVal = source.is_active ? 0 : 1;
  await db.prepare('UPDATE sources SET is_active = ? WHERE id = ?').run(newVal, req.params.id);
  res.json({ id: source.id, is_active: newVal });
});

module.exports = router;
