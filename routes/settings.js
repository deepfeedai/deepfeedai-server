/**
 * Deep Feed AI Admin — /api/settings
 * Key-value settings store (e.g. ElevenLabs API key override).
 */
const express          = require('express');
const router           = express.Router();
const { getPool }      = require('../db');
const db               = require('../db');
const { auth }         = require('../middleware/auth');
const { asyncHandler } = require('../lib/utils');
const { settingsUpdate, validate } = require('../lib/schemas');

// GET /api/settings — return all settings as key/value object
router.get('/', auth, asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  res.json(result);
}));

// PUT /api/settings — upsert key/value pairs
router.put('/', auth, asyncHandler(async (req, res) => {
  const body = validate(settingsUpdate, req.body, res);
  if (!body) return;

  const pool = getPool();
  for (const [key, value] of Object.entries(body)) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  }

  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  res.json(result);
}));

module.exports = router;
