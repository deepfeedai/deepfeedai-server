/**
 * Deep Feed AI Admin — /api/settings
 * Key-value settings store (e.g. ElevenLabs API key override).
 */
const express          = require('express');
const router           = express.Router();
const { getPool }      = require('../db');
const db               = require('../db');
const { auth: requireAdmin } = require('../middleware/auth');
const { asyncHandler }       = require('../lib/utils');
const { settingsUpdate, validate } = require('../lib/schemas');
const { encryptSetting, decryptSetting, SENSITIVE_KEYS } = require('../lib/crypto');

// GET /api/settings — return all settings as key/value object (decrypt sensitive values)
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = SENSITIVE_KEYS.has(row.key) ? decryptSetting(row.value) : row.value;
  }
  res.json(result);
}));

// PUT /api/settings — upsert key/value pairs (encrypt sensitive values)
router.put('/', requireAdmin, asyncHandler(async (req, res) => {
  const body = validate(settingsUpdate, req.body, res);
  if (!body) return;

  const pool = getPool();
  for (const [key, value] of Object.entries(body)) {
    const stored = SENSITIVE_KEYS.has(key) && value ? encryptSetting(value) : value;
    await pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, stored]
    );
  }

  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = SENSITIVE_KEYS.has(row.key) ? decryptSetting(row.value) : row.value;
  }
  res.json(result);
}));

module.exports = router;
