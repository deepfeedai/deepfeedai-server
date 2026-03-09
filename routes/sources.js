const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'deepfeedai_super_secret_jwt_key_2026';

// Auth middleware
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// GET /api/sources
router.get('/', auth, (req, res) => {
  const sources = db.prepare('SELECT * FROM sources ORDER BY priority ASC, created_at DESC').all();
  res.json(sources);
});

// POST /api/sources
router.post('/', auth, (req, res) => {
  const { name, url, category, priority, is_active } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });

  db.prepare(`
    INSERT INTO sources (name, url, category, priority, is_active)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name,
    url,
    category || 'Industry',
    priority || 1,
    is_active !== undefined ? (is_active ? 1 : 0) : 1
  );

  // Get the last inserted source
  const source = db.prepare('SELECT * FROM sources ORDER BY id DESC LIMIT 1').get();
  res.status(201).json(source);
});

// PUT /api/sources/:id
router.put('/:id', auth, (req, res) => {
  const existing = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Source not found' });

  const { name, url, category, priority, is_active } = req.body;

  db.prepare(`
    UPDATE sources SET name = ?, url = ?, category = ?, priority = ?, is_active = ?
    WHERE id = ?
  `).run(
    name !== undefined ? name : existing.name,
    url !== undefined ? url : existing.url,
    category !== undefined ? category : existing.category,
    priority !== undefined ? priority : existing.priority,
    is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/sources/:id
router.delete('/:id', auth, (req, res) => {
  const existing = db.prepare('SELECT id FROM sources WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Source not found' });

  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  res.json({ message: 'Source deleted' });
});

// PUT /api/sources/:id/toggle — toggle active
router.put('/:id/toggle', auth, (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const newVal = source.is_active ? 0 : 1;
  db.prepare('UPDATE sources SET is_active = ? WHERE id = ?').run(newVal, req.params.id);
  res.json({ id: source.id, is_active: newVal });
});

module.exports = router;
