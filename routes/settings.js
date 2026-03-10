/**
 * Deep Feed AI Admin — /api/settings
 * Key-value settings store (e.g. ElevenLabs API key override).
 */
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { getPool } = require('../db');
const db      = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'deepfeedai_super_secret_jwt_key_2026';

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// GET /api/settings — return all settings as key/value object
router.get('/', auth, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings — upsert key/value pairs
router.put('/', auth, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body must be a key/value object' });
  }

  try {
    const pool = getPool();
    for (const [key, value] of Object.entries(body)) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
    }
    // Return updated settings
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
