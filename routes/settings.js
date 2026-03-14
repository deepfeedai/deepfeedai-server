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
const { bustSiteConfigCache } = require('../lib/site-config');
const { extFromMime, upload: r2Upload } = require('../lib/r2');
const path = require('path');

const BRANDING_DIR = path.join(__dirname, '..', 'public', 'media', 'branding');

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
  let hasSiteKey = false;

  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith('site_')) hasSiteKey = true;
    const stored = SENSITIVE_KEYS.has(key) && value ? encryptSetting(value) : value;
    await pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, stored]
    );
  }

  if (hasSiteKey) bustSiteConfigCache();

  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = SENSITIVE_KEYS.has(row.key) ? decryptSetting(row.value) : row.value;
  }
  res.json(result);
}));

// POST /api/settings/logo — upload site branding image (base64 dataUrl)
// Supports type: 'logo', 'favicon', 'ogimage'
const BRANDING_TYPES = {
  logo:    { filename: 'site-logo',    settingKey: 'site_logo_url' },
  favicon: { filename: 'site-favicon', settingKey: 'site_favicon_url' },
  ogimage: { filename: 'site-og',      settingKey: 'site_og_image' },
};

router.post('/logo', requireAdmin, asyncHandler(async (req, res) => {
  const { dataUrl, type } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid dataUrl format' });

  const mimeType = match[1];
  const buf = Buffer.from(match[2], 'base64');

  if (buf.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'File too large (max 2MB)' });
  }

  const bt = BRANDING_TYPES[type] || BRANDING_TYPES.logo;
  const ext = extFromMime(mimeType);
  const filename = `${bt.filename}.${ext}`;
  const r2Key = `branding/${filename}`;

  const url = await r2Upload(buf, mimeType, r2Key, BRANDING_DIR, filename);

  const pool = getPool();
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [bt.settingKey, url]
  );

  bustSiteConfigCache();
  res.json({ url, key: bt.settingKey });
}));

module.exports = router;
