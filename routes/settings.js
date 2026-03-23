/**
 * Deep Feed AI Admin — /api/settings
 * Key-value settings store (e.g. ElevenLabs API key override).
 */
const express          = require('express');
const router           = express.Router();
const { getPool }      = require('../db');
const db               = require('../db');
const { auth: requireAdmin } = require('../middleware/auth');
const { requirePermission }  = require('../middleware/permissions');
const { asyncHandler }       = require('../lib/utils');
const { settingsUpdate, validate } = require('../lib/schemas');
const { encryptSetting, decryptSetting, SENSITIVE_KEYS } = require('../lib/crypto');
const { bustSiteConfigCache } = require('../lib/site-config');
const { bustAppConfigCache } = require('../lib/app-config');
const { requirePlatformAdmin } = require('../middleware/permissions');

// Keys that are managed by lib/secrets.js and must never be returned to the frontend
const SECRET_MANAGER_KEYS = new Set(['jwt_secret', 'user_jwt_secret', 'cron_secret', 'jwt_secret_previous']);
// Platform-level keys in multi-tenant mode — managed via platform dashboard
const R2_KEYS = ['r2_account_id', 'r2_bucket_name', 'r2_public_url', 'r2_access_key_id', 'r2_secret_access_key'];
const AI_KEYS = ['gemini_api_key', 'imagen_api_key', 'imagen_model'];
const PLATFORM_KEYS = [...R2_KEYS, ...AI_KEYS];
const { extFromMime } = require('../lib/r2');
const storage = require('../lib/storage');
const { logAudit } = require('../middleware/audit');

// GET /api/settings — return all settings as key/value object (decrypt sensitive values)
// JWT and cron secrets are excluded — they are managed via lib/secrets.js and must
// never be returned to the frontend (prevents credential extraction via admin session).
router.get('/', requireAdmin, requirePermission('settings.read'), asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT key, value FROM settings WHERE tenant_id = $1').all(req.tenantId);
  // Check if caller has permission to see decrypted sensitive values
  const perms = req.user?.permissions || [];
  const canReadSensitive = perms.includes('*') || perms.includes('settings.read.sensitive');
  const result = {};
  for (const row of rows) {
    if (SECRET_MANAGER_KEYS.has(row.key)) continue; // never expose JWT/cron secrets
    if (SENSITIVE_KEYS.has(row.key)) {
      result[row.key] = canReadSensitive ? decryptSetting(row.value) : (row.value ? '********' : '');
    } else {
      result[row.key] = row.value;
    }
  }
  res.json(result);
}));

// PUT /api/settings — upsert key/value pairs (encrypt sensitive values)
router.put('/', requireAdmin, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  const body = validate(settingsUpdate, req.body, res);
  if (!body) return;

  // Block writes to JWT/cron secrets — these are managed exclusively by lib/secrets.js
  for (const key of Object.keys(body)) {
    if (SECRET_MANAGER_KEYS.has(key)) {
      return res.status(400).json({ error: `Setting '${key}' cannot be updated via this endpoint` });
    }
  }

  // Block non-platform-admins from writing platform-level keys
  if (req.user?.type !== 'platform-admin') {
    for (const key of Object.keys(body)) {
      if (PLATFORM_KEYS.includes(key)) {
        return res.status(403).json({ error: 'This setting requires platform admin access. Configure via Platform Dashboard > Settings.' });
      }
    }
  }

  const pool = getPool();
  let hasSiteKey = false;

  // Capture before values for diff
  const beforeKeys = Object.keys(body);
  const beforeResult = beforeKeys.length > 0
    ? await pool.query('SELECT key, value FROM settings WHERE tenant_id = $1 AND key = ANY($2)', [req.tenantId, beforeKeys])
    : { rows: [] };
  const beforeMap = {};
  for (const r of beforeResult.rows) {
    beforeMap[r.key] = SENSITIVE_KEYS.has(r.key) ? '***' : r.value;
  }

  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith('site_')) hasSiteKey = true;
    const stored = SENSITIVE_KEYS.has(key) && value ? encryptSetting(value) : value;
    await pool.query(
      `INSERT INTO settings (tenant_id, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [req.tenantId, key, stored]
    );
  }

  if (hasSiteKey) bustSiteConfigCache();
  bustAppConfigCache(req.tenantId);
  const r2Keys = ['r2_account_id', 'r2_bucket_name', 'r2_public_url', 'r2_access_key_id', 'r2_secret_access_key'];
  if (r2Keys.some(k => k in body)) storage.bustR2ConfigCache();

  // Audit log with before/after diff
  const changes = {};
  for (const key of Object.keys(body)) {
    const fromVal = SENSITIVE_KEYS.has(key) ? '***' : (beforeMap[key] ?? null);
    const toVal = SENSITIVE_KEYS.has(key) ? '***' : body[key];
    if (fromVal !== toVal) changes[key] = { from: fromVal, to: toVal };
  }
  logAudit(req, 'settings.update', 'settings', null, { changes });


  const rows = await db.prepare('SELECT key, value FROM settings WHERE tenant_id = $1').all(req.tenantId);
  const perms = req.user?.permissions || [];
  const canReadSensitive = perms.includes('*') || perms.includes('settings.read.sensitive');
  const result = {};
  for (const row of rows) {
    if (SECRET_MANAGER_KEYS.has(row.key)) continue;
    if (SENSITIVE_KEYS.has(row.key)) {
      result[row.key] = canReadSensitive ? decryptSetting(row.value) : (row.value ? '********' : '');
    } else {
      result[row.key] = row.value;
    }
  }
  res.json(result);
}));

// ── Platform-level config (always tenant_id=1) ────────────────────
// In multi-tenant mode, R2/S3 credentials and AI API keys are platform-wide.
// These endpoints read/write from tenant_id=1 regardless of the caller's tenant.
const { bustGeminiKeyCache } = require('../lib/gemini-config');

// GET /api/settings/platform-storage — platform admin reads platform config
router.get('/platform-storage', requireAdmin, requirePlatformAdmin, asyncHandler(async (req, res) => {
  const placeholders = PLATFORM_KEYS.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await db.prepare(
    `SELECT key, value FROM settings WHERE tenant_id = 1 AND key IN (${placeholders})`
  ).all(...PLATFORM_KEYS);

  const result = { backend: storage.backendName };
  for (const row of rows) {
    if (SENSITIVE_KEYS.has(row.key)) {
      result[row.key] = row.value ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : '';
    } else {
      result[row.key] = row.value;
    }
  }
  res.json(result);
}));

// PUT /api/settings/platform-storage — platform admin saves platform config
router.put('/platform-storage', requireAdmin, requirePlatformAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const pool = getPool();

  const savedKeys = [];
  for (const [key, value] of Object.entries(body)) {
    if (!PLATFORM_KEYS.includes(key)) continue;
    const stored = SENSITIVE_KEYS.has(key) && value ? encryptSetting(value) : value;
    await pool.query(
      `INSERT INTO settings (tenant_id, key, value, updated_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, stored]
    );
    savedKeys.push(key);
  }

  // Bust relevant caches
  if (savedKeys.some(k => R2_KEYS.includes(k))) storage.bustR2ConfigCache();
  if (savedKeys.some(k => AI_KEYS.includes(k))) bustGeminiKeyCache();

  logAudit(req, 'settings.platform-config', 'settings', null, { keys: savedKeys });

  res.json({ message: 'Platform storage settings saved' });
}));

// GET /api/settings/storage-status — any admin reads storage status (no credentials)
router.get('/storage-status', requireAdmin, asyncHandler(async (req, res) => {
  const backend = storage.backendName;
  // Check if R2 is configured (platform-level, tenant_id=1)
  const r2Row = await db.prepare(
    `SELECT value FROM settings WHERE tenant_id = 1 AND key = 'r2_bucket_name'`
  ).get();
  const r2Configured = !!(r2Row && r2Row.value);

  // Get tenant storage usage
  const usage = await db.prepare(
    'SELECT bytes_used, file_count FROM tenant_storage_usage WHERE tenant_id = $1'
  ).get(req.tenantId);

  res.json({
    backend,
    r2Configured,
    bytesUsed: usage ? Number(usage.bytes_used) : 0,
    fileCount: usage ? usage.file_count : 0,
  });
}));

// POST /api/settings/logo — upload site branding image (base64 dataUrl)
// Supports type: 'logo', 'favicon', 'ogimage'
const BRANDING_TYPES = {
  logo:    { filename: 'site-logo',    settingKey: 'site_logo_url' },
  favicon: { filename: 'site-favicon', settingKey: 'site_favicon_url' },
  ogimage: { filename: 'site-og',      settingKey: 'site_og_image' },
};

router.post('/logo', requireAdmin, requirePermission('settings.update'), asyncHandler(async (req, res) => {
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

  const url = await storage.upload(buf, mimeType, r2Key, req.tenantId);

  const pool = getPool();
  await pool.query(
    `INSERT INTO settings (tenant_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [req.tenantId, bt.settingKey, url]
  );

  bustSiteConfigCache();
  res.json({ url, key: bt.settingKey });
}));

module.exports = router;
