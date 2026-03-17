/**
 * Deep Feed AI — Unified Storage Abstraction Layer
 *
 * Pluggable backends selected via STORAGE_BACKEND env var:
 *   - 's3'       — S3-compatible (Cloudflare R2, AWS S3, MinIO, etc.)
 *   - 'local'    — local filesystem
 *   - 'database' — PostgreSQL BYTEA (file_storage table)
 *
 * Auto-detection when STORAGE_BACKEND is not set:
 *   S3_* or R2_* env vars present → 's3', otherwise → 'local'
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
/*  Detect backend                                                    */
/* ------------------------------------------------------------------ */
function detectBackend() {
  const explicit = (process.env.STORAGE_BACKEND || '').toLowerCase();
  if (explicit === 's3' || explicit === 'local' || explicit === 'database') return explicit;

  // Auto-detect
  mapLegacyR2Vars();
  const hasS3 = !!(process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY && process.env.S3_BUCKET);
  return hasS3 ? 's3' : 'local';
}

/* ------------------------------------------------------------------ */
/*  S3 adapter                                                        */
/* ------------------------------------------------------------------ */
function createS3Adapter() {
  mapLegacyR2Vars();

  let _client = null;
  function getClient() {
    if (!_client) {
      const { S3Client } = require('@aws-sdk/client-s3');
      _client = new S3Client({
        region:      process.env.S3_REGION || 'auto',
        endpoint:    process.env.S3_ENDPOINT,
        credentials: {
          accessKeyId:     process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
      });
    }
    return _client;
  }

  return {
    async upload(buf, mimeType, key, tenantId) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const fullKey = `tenants/${tenantId}/${key}`;
      await getClient().send(new PutObjectCommand({
        Bucket:      process.env.S3_BUCKET,
        Key:         fullKey,
        Body:        buf,
        ContentType: mimeType,
      }));
      const publicUrl = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');
      return `${publicUrl}/${fullKey}`;
    },

    async remove(key, tenantId) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const fullKey = `tenants/${tenantId}/${key}`;
      await getClient().send(new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET,
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
    const safeKey = key.replace(/\.\./g, '').replace(/^\/+/, '');
    const filePath = path.join(baseDir, 'tenants', String(tenantId), safeKey);
    const resolved = path.resolve(filePath);
    const base = path.resolve(path.join(baseDir, 'tenants', String(tenantId)));
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error('Invalid storage key: path traversal detected');
    }
    return filePath;
  }

  return {
    async upload(buf, mimeType, key, tenantId) {
      const filePath = safePath(key, tenantId);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buf);
      const safeKey = key.replace(/\.\./g, '').replace(/^\/+/, '');
      return `/media/tenants/${tenantId}/${safeKey}`;
    },

    async remove(key, tenantId) {
      try {
        const filePath = safePath(key, tenantId);
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
      if (buf.length > MAX_SIZE) {
        throw new Error(`File exceeds maximum size of 10MB (got ${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
      }
      const db = require('../db');
      await db.prepare(`
        INSERT INTO file_storage (tenant_id, key, mime_type, data, size, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (tenant_id, key) DO UPDATE
        SET mime_type = EXCLUDED.mime_type, data = EXCLUDED.data, size = EXCLUDED.size, created_at = NOW()
      `).run(tenantId, key, mimeType, buf, buf.length);
      return `/api/media/file/${tenantId}/${key}`;
    },

    async remove(key, tenantId) {
      const db = require('../db');
      await db.prepare('DELETE FROM file_storage WHERE tenant_id = $1 AND key = $2').run(tenantId, key);
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
const backendName = detectBackend();

let adapter;
switch (backendName) {
  case 's3':       adapter = createS3Adapter();       break;
  case 'database': adapter = createDatabaseAdapter(); break;
  default:         adapter = createLocalAdapter();     break;
}

console.log(`[storage] Backend: ${backendName}`);

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */
module.exports = {
  backendName,
  upload:     adapter.upload.bind(adapter),
  remove:     adapter.remove.bind(adapter),
  extFromMime,
  serveRoute: createServeRoute(),
};
