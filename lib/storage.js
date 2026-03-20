/**
 * Deep Feed AI — Unified Storage Abstraction Layer
 *
 * Pluggable backends selected via STORAGE_BACKEND env var:
 *   - 's3'       — S3-compatible (Cloudflare R2, AWS S3, MinIO, etc.)
 *   - 'local'    — local filesystem
 *   - 'database' — PostgreSQL BYTEA (file_storage table)
 *
 * Auto-detection order:
 *   1. STORAGE_BACKEND env var (explicit)
 *   2. S3_* or R2_* env vars present → 's3'
 *   3. 'auto' — tries S3 with DB settings credentials, falls back to 'local'
 *
 * Usage:
 *   const storage = require('./storage');
 *   const url = await storage.upload(buf, 'image/png', 'images/file.png', tenantId);
 *   await storage.remove('images/file.png', tenantId);
 *   storage.backendName; // 's3' | 'local' | 'database'
 */
const fs     = require('fs');
const path   = require('path');
const express = require('express');

/* ------------------------------------------------------------------ */
/*  Helper: mime → extension                                          */
/* ------------------------------------------------------------------ */
function extFromMime(mimeType) {
  if (mimeType === 'image/png')     return 'png';
  if (mimeType === 'image/gif')     return 'gif';
  if (mimeType === 'image/webp')    return 'webp';
  if (mimeType === 'image/svg+xml') return 'svg';
  if (mimeType === 'audio/mpeg')    return 'mp3';
  if (mimeType === 'audio/wav')     return 'wav';
  if (mimeType === 'audio/ogg')     return 'ogg';
  return 'jpg';
}

/* ------------------------------------------------------------------ */
/*  Legacy R2_* → S3_* env var mapping                                */
/* ------------------------------------------------------------------ */
function mapLegacyR2Vars() {
  if (!process.env.S3_ENDPOINT && process.env.R2_ACCOUNT_ID) {
    process.env.S3_ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }
  if (!process.env.S3_ACCESS_KEY_ID && process.env.R2_ACCESS_KEY_ID) {
    process.env.S3_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
  }
  if (!process.env.S3_SECRET_ACCESS_KEY && process.env.R2_SECRET_ACCESS_KEY) {
    process.env.S3_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
  }
  if (!process.env.S3_BUCKET && process.env.R2_BUCKET_NAME) {
    process.env.S3_BUCKET = process.env.R2_BUCKET_NAME;
  }
  if (!process.env.S3_PUBLIC_URL && process.env.R2_PUBLIC_URL) {
    process.env.S3_PUBLIC_URL = process.env.R2_PUBLIC_URL;
  }
}

/* ------------------------------------------------------------------ */
/*  Resolve R2 config from database settings (async, cached)          */
/* ------------------------------------------------------------------ */
let _r2DbConfig = null;
let _r2DbConfigTs = 0;
const R2_DB_TTL = 5 * 60 * 1000; // 5 minutes

async function getR2ConfigFromDb(tenantId = 1) {
  if (_r2DbConfig && Date.now() - _r2DbConfigTs < R2_DB_TTL) return _r2DbConfig;
  try {
    const db = require('../db');
    const { decryptSetting, SENSITIVE_KEYS } = require('./crypto');
    const keys = ['r2_account_id', 'r2_bucket_name', 'r2_public_url', 'r2_access_key_id', 'r2_secret_access_key'];
    const rows = await db.prepare(
      `SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN ($2, $3, $4, $5, $6)`
    ).all(tenantId, ...keys);
    const cfg = {};
    for (const row of rows) {
      cfg[row.key] = SENSITIVE_KEYS.has(row.key) ? decryptSetting(row.value) : row.value;
    }
    if (cfg.r2_account_id && cfg.r2_access_key_id && cfg.r2_secret_access_key && cfg.r2_bucket_name) {
      _r2DbConfig = {
        endpoint:        `https://${cfg.r2_account_id}.r2.cloudflarestorage.com`,
        accessKeyId:     cfg.r2_access_key_id,
        secretAccessKey: cfg.r2_secret_access_key,
        bucket:          cfg.r2_bucket_name,
        publicUrl:       (cfg.r2_public_url || '').replace(/\/$/, ''),
      };
      _r2DbConfigTs = Date.now();
      return _r2DbConfig;
    }
  } catch { /* DB not ready */ }
  return null;
}

function bustR2ConfigCache() {
  _r2DbConfig = null;
  _r2DbConfigTs = 0;
}

/* ------------------------------------------------------------------ */
/*  Validate tenantId                                                 */
/* ------------------------------------------------------------------ */
function validateTenantId(tenantId) {
  const id = parseInt(tenantId, 10);
  if (!Number.isFinite(id) || id < 1) {
    throw new Error(`Invalid tenantId: ${tenantId}`);
  }
  return id;
}

/* ------------------------------------------------------------------ */
/*  Detect backend                                                    */
/* ------------------------------------------------------------------ */
function detectBackend() {
  const explicit = (process.env.STORAGE_BACKEND || '').toLowerCase();
  if (explicit === 's3' || explicit === 'local' || explicit === 'database') return explicit;

  // Auto-detect from env vars
  mapLegacyR2Vars();
  const hasS3 = !!(process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY && process.env.S3_BUCKET);
  return hasS3 ? 's3' : 'auto';
}

/* ------------------------------------------------------------------ */
/*  S3 adapter                                                        */
/* ------------------------------------------------------------------ */
function createS3Adapter() {
  mapLegacyR2Vars();

  let _envClient = null;
  let _dbClient = null;
  let _dbClientEndpoint = null;

  function getEnvClient() {
    if (!_envClient) {
      const { S3Client } = require('@aws-sdk/client-s3');
      _envClient = new S3Client({
        region:      process.env.S3_REGION || 'auto',
        endpoint:    process.env.S3_ENDPOINT,
        credentials: {
          accessKeyId:     process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
      });
    }
    return _envClient;
  }

  function getDbClient(cfg) {
    if (!_dbClient || _dbClientEndpoint !== cfg.endpoint) {
      const { S3Client } = require('@aws-sdk/client-s3');
      _dbClient = new S3Client({
        region:      'auto',
        endpoint:    cfg.endpoint,
        credentials: {
          accessKeyId:     cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        },
      });
      _dbClientEndpoint = cfg.endpoint;
    }
    return _dbClient;
  }

  async function resolveConfig(tenantId) {
    // Priority 1: env vars
    if (process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY && process.env.S3_BUCKET) {
      return {
        client:    getEnvClient(),
        bucket:    process.env.S3_BUCKET,
        publicUrl: (process.env.S3_PUBLIC_URL || '').replace(/\/$/, ''),
      };
    }
    // Priority 2: DB settings
    const dbCfg = await getR2ConfigFromDb(tenantId);
    if (dbCfg) {
      return {
        client:    getDbClient(dbCfg),
        bucket:    dbCfg.bucket,
        publicUrl: dbCfg.publicUrl,
      };
    }
    return null;
  }

  return {
    async upload(buf, mimeType, key, tenantId) {
      const tid = validateTenantId(tenantId);
      const cfg = await resolveConfig(tid);
      if (!cfg) throw new Error('S3/R2 storage not configured — set env vars or configure in Settings > Integrations');
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const fullKey = `tenants/${tid}/${key}`;
      await cfg.client.send(new PutObjectCommand({
        Bucket:      cfg.bucket,
        Key:         fullKey,
        Body:        buf,
        ContentType: mimeType,
      }));
      return `${cfg.publicUrl}/${fullKey}`;
    },

    async remove(key, tenantId) {
      const tid = validateTenantId(tenantId);
      const cfg = await resolveConfig(tid);
      if (!cfg) return;
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const fullKey = `tenants/${tid}/${key}`;
      await cfg.client.send(new DeleteObjectCommand({
        Bucket: cfg.bucket,
        Key:    fullKey,
      }));
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Local filesystem adapter                                          */
/* ------------------------------------------------------------------ */
function createLocalAdapter() {
  const baseDir = process.env.STORAGE_LOCAL_DIR || path.join(__dirname, '..', 'public', 'media');

  function safePath(key, tenantId) {
    const tid = validateTenantId(tenantId);
    const safeKey = key.replace(/\.\./g, '').replace(/^\/+/, '');
    const filePath = path.join(baseDir, 'tenants', String(tid), safeKey);
    const resolved = path.resolve(filePath);
    const base = path.resolve(path.join(baseDir, 'tenants', String(tid)));
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error('Invalid storage key: path traversal detected');
    }
    return filePath;
  }

  return {
    async upload(buf, mimeType, key, tenantId) {
      const tid = validateTenantId(tenantId);
      const filePath = safePath(key, tid);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buf);
      const safeKey = key.replace(/\.\./g, '').replace(/^\/+/, '');
      return `/media/tenants/${tid}/${safeKey}`;
    },

    async remove(key, tenantId) {
      try {
        const tid = validateTenantId(tenantId);
        const filePath = safePath(key, tid);
        fs.unlinkSync(filePath);
      } catch { /* file may not exist or path invalid */ }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Database (PostgreSQL BYTEA) adapter                               */
/* ------------------------------------------------------------------ */
function createDatabaseAdapter() {
  const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

  return {
    async upload(buf, mimeType, key, tenantId) {
      const tid = validateTenantId(tenantId);
      if (buf.length > MAX_SIZE) {
        throw new Error(`File exceeds maximum size of 10MB (got ${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
      }
      const db = require('../db');
      await db.prepare(`
        INSERT INTO file_storage (tenant_id, key, mime_type, data, size, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (tenant_id, key) DO UPDATE
        SET mime_type = EXCLUDED.mime_type, data = EXCLUDED.data, size = EXCLUDED.size, created_at = NOW()
      `).run(tid, key, mimeType, buf, buf.length);
      return `/api/media/file/${tid}/${key}`;
    },

    async remove(key, tenantId) {
      const tid = validateTenantId(tenantId);
      const db = require('../db');
      await db.prepare('DELETE FROM file_storage WHERE tenant_id = $1 AND key = $2').run(tid, key);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Serving route for database backend                                */
/* ------------------------------------------------------------------ */
function createServeRoute() {
  const router = express.Router();

  router.get('/:tenantId/*', async (req, res) => {
    try {
      const tenantId = parseInt(req.params.tenantId, 10);
      const key = req.params[0]; // everything after /:tenantId/
      if (!tenantId || !key) return res.status(400).json({ error: 'Invalid path' });

      // Validate tenant context matches URL tenantId
      if (!req.tenantId) return res.status(403).json({ error: 'Forbidden' });
      if (req.tenantId !== tenantId) return res.status(403).json({ error: 'Forbidden' });

      const db = require('../db');
      const row = await db.prepare(
        'SELECT mime_type, data, size FROM file_storage WHERE tenant_id = $1 AND key = $2'
      ).get(tenantId, key);

      if (!row) return res.status(404).json({ error: 'File not found' });

      res.set('Content-Type', row.mime_type);
      res.set('Content-Length', row.size);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(row.data);
    } catch (err) {
      console.error('[storage] serve error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

/* ------------------------------------------------------------------ */
/*  Initialize singleton                                              */
/* ------------------------------------------------------------------ */
const _detectedBackend = detectBackend();

let s3Adapter, localAdapter, dbAdapter;

if (_detectedBackend === 's3' || _detectedBackend === 'auto') {
  s3Adapter = createS3Adapter();
}
if (_detectedBackend === 'auto' || _detectedBackend === 'local') {
  localAdapter = createLocalAdapter();
}
if (_detectedBackend === 'database') {
  dbAdapter = createDatabaseAdapter();
}

let _resolvedBackendName = _detectedBackend === 'auto' ? 'local' : _detectedBackend;

async function upload(buf, mimeType, key, tenantId) {
  if (_detectedBackend === 'auto') {
    try {
      const url = await s3Adapter.upload(buf, mimeType, key, tenantId);
      _resolvedBackendName = 's3';
      return url;
    } catch {
      return localAdapter.upload(buf, mimeType, key, tenantId);
    }
  }
  if (s3Adapter)  return s3Adapter.upload(buf, mimeType, key, tenantId);
  if (dbAdapter)  return dbAdapter.upload(buf, mimeType, key, tenantId);
  return localAdapter.upload(buf, mimeType, key, tenantId);
}

async function remove(key, tenantId) {
  if (_detectedBackend === 'auto') {
    try { await s3Adapter.remove(key, tenantId); } catch { /* try local */ }
    try { await localAdapter.remove(key, tenantId); } catch { /* best effort */ }
    return;
  }
  if (s3Adapter)  return s3Adapter.remove(key, tenantId);
  if (dbAdapter)  return dbAdapter.remove(key, tenantId);
  return localAdapter.remove(key, tenantId);
}

console.log(`[storage] Backend: ${_detectedBackend === 'auto' ? 'auto (S3 from DB settings → local fallback)' : _detectedBackend}`);

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */
module.exports = {
  get backendName() { return _resolvedBackendName; },
  upload,
  remove,
  extFromMime,
  serveRoute: createServeRoute(),
  bustR2ConfigCache,
};
