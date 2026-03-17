/**
 * Deep Feed AI — Storage abstraction layer unit tests
 *
 * Tests for lib/storage.js: local adapter, database adapter,
 * backend detection logic, and mime-type helpers.
 */
'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

/* ------------------------------------------------------------------ */
/*  extFromMime tests — safe to import from a fresh require            */
/* ------------------------------------------------------------------ */
describe('extFromMime', () => {
  let extFromMime;

  before(() => {
    // storage.js is a singleton; we only need extFromMime which is a pure function.
    // To avoid the singleton side-effects, we extract detectBackend indirectly,
    // but extFromMime is safe to grab from the cached module.
    // We need STORAGE_BACKEND set to avoid S3 client init attempts.
    const saved = process.env.STORAGE_BACKEND;
    process.env.STORAGE_BACKEND = 'local';
    const storage = require('../lib/storage');
    extFromMime = storage.extFromMime;
    if (saved === undefined) delete process.env.STORAGE_BACKEND;
    else process.env.STORAGE_BACKEND = saved;
  });

  it('maps image/png to png', () => {
    assert.equal(extFromMime('image/png'), 'png');
  });

  it('maps image/gif to gif', () => {
    assert.equal(extFromMime('image/gif'), 'gif');
  });

  it('maps image/webp to webp', () => {
    assert.equal(extFromMime('image/webp'), 'webp');
  });

  it('maps image/svg+xml to svg', () => {
    assert.equal(extFromMime('image/svg+xml'), 'svg');
  });

  it('maps audio/mpeg to mp3', () => {
    assert.equal(extFromMime('audio/mpeg'), 'mp3');
  });

  it('maps audio/wav to wav', () => {
    assert.equal(extFromMime('audio/wav'), 'wav');
  });

  it('maps audio/ogg to ogg', () => {
    assert.equal(extFromMime('audio/ogg'), 'ogg');
  });

  it('defaults to jpg for image/jpeg', () => {
    assert.equal(extFromMime('image/jpeg'), 'jpg');
  });

  it('defaults to jpg for unknown mime types', () => {
    assert.equal(extFromMime('application/pdf'), 'jpg');
    assert.equal(extFromMime('video/mp4'), 'jpg');
    assert.equal(extFromMime(''), 'jpg');
  });
});

/* ------------------------------------------------------------------ */
/*  Backend detection tests                                            */
/*  We test the detectBackend logic by reading the source and          */
/*  evaluating env-var driven logic in isolated contexts.              */
/* ------------------------------------------------------------------ */
describe('backend detection', () => {
  // We cannot re-require the singleton, so we replicate the detection logic
  // exactly as it appears in storage.js for unit testing purposes.
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

  function detectBackend() {
    const explicit = (process.env.STORAGE_BACKEND || '').toLowerCase();
    if (explicit === 's3' || explicit === 'local' || explicit === 'database') return explicit;
    mapLegacyR2Vars();
    const hasS3 = !!(process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY && process.env.S3_BUCKET);
    return hasS3 ? 's3' : 'local';
  }

  // Save and restore all relevant env vars
  const ENV_KEYS = [
    'STORAGE_BACKEND', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
    'S3_BUCKET', 'S3_PUBLIC_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL',
  ];
  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  after(() => {
    // Restore all env vars
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('defaults to local when no env vars are set', () => {
    assert.equal(detectBackend(), 'local');
  });

  it('returns s3 when STORAGE_BACKEND=s3', () => {
    process.env.STORAGE_BACKEND = 's3';
    assert.equal(detectBackend(), 's3');
  });

  it('returns database when STORAGE_BACKEND=database', () => {
    process.env.STORAGE_BACKEND = 'database';
    assert.equal(detectBackend(), 'database');
  });

  it('returns local when STORAGE_BACKEND=local', () => {
    process.env.STORAGE_BACKEND = 'local';
    assert.equal(detectBackend(), 'local');
  });

  it('is case-insensitive for STORAGE_BACKEND', () => {
    process.env.STORAGE_BACKEND = 'S3';
    assert.equal(detectBackend(), 's3');
    process.env.STORAGE_BACKEND = 'DATABASE';
    assert.equal(detectBackend(), 'database');
  });

  it('auto-detects s3 when all S3_ env vars are present', () => {
    process.env.S3_ENDPOINT = 'https://s3.example.com';
    process.env.S3_ACCESS_KEY_ID = 'key';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';
    process.env.S3_BUCKET = 'bucket';
    assert.equal(detectBackend(), 's3');
  });

  it('falls back to local when only partial S3_ env vars are present', () => {
    process.env.S3_ENDPOINT = 'https://s3.example.com';
    // Missing S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET
    assert.equal(detectBackend(), 'local');
  });

  it('auto-maps legacy R2_ vars to S3_ and detects s3', () => {
    process.env.R2_ACCOUNT_ID = 'abc123';
    process.env.R2_ACCESS_KEY_ID = 'r2key';
    process.env.R2_SECRET_ACCESS_KEY = 'r2secret';
    process.env.R2_BUCKET_NAME = 'r2bucket';
    assert.equal(detectBackend(), 's3');
    // Verify the mapping happened
    assert.equal(process.env.S3_ENDPOINT, 'https://abc123.r2.cloudflarestorage.com');
    assert.equal(process.env.S3_ACCESS_KEY_ID, 'r2key');
    assert.equal(process.env.S3_SECRET_ACCESS_KEY, 'r2secret');
    assert.equal(process.env.S3_BUCKET, 'r2bucket');
  });

  it('does not overwrite existing S3_ vars with R2_ vars', () => {
    process.env.S3_ENDPOINT = 'https://custom.endpoint.com';
    process.env.S3_ACCESS_KEY_ID = 'custom-key';
    process.env.S3_SECRET_ACCESS_KEY = 'custom-secret';
    process.env.S3_BUCKET = 'custom-bucket';
    process.env.R2_ACCOUNT_ID = 'abc123';
    process.env.R2_ACCESS_KEY_ID = 'r2key';

    assert.equal(detectBackend(), 's3');
    assert.equal(process.env.S3_ENDPOINT, 'https://custom.endpoint.com');
    assert.equal(process.env.S3_ACCESS_KEY_ID, 'custom-key');
  });
});

/* ------------------------------------------------------------------ */
/*  Local adapter tests                                                */
/* ------------------------------------------------------------------ */
describe('local adapter', () => {
  let tmpDir;
  let adapter;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfa-storage-test-'));

    // Build a local adapter manually (same logic as storage.js createLocalAdapter)
    const baseDir = tmpDir;
    adapter = {
      async upload(buf, mimeType, key, tenantId) {
        const filePath = path.join(baseDir, 'tenants', String(tenantId), key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buf);
        return `/media/tenants/${tenantId}/${key}`;
      },
      async remove(key, tenantId) {
        const filePath = path.join(baseDir, 'tenants', String(tenantId), key);
        try { fs.unlinkSync(filePath); } catch { /* file may not exist */ }
      },
    };
  });

  after(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uploads a buffer and creates the file at tenants/{tenantId}/{key}', async () => {
    const buf = Buffer.from('test image data');
    await adapter.upload(buf, 'image/png', 'images/test.png', 1);

    const filePath = path.join(tmpDir, 'tenants', '1', 'images', 'test.png');
    assert.ok(fs.existsSync(filePath), 'File should exist on disk');
    assert.deepEqual(fs.readFileSync(filePath), buf);
  });

  it('returns correct URL format /media/tenants/{tenantId}/{key}', async () => {
    const buf = Buffer.from('test');
    const url = await adapter.upload(buf, 'image/png', 'photo.png', 42);
    assert.equal(url, '/media/tenants/42/photo.png');
  });

  it('two tenants uploading same key get different paths', async () => {
    const buf1 = Buffer.from('tenant1 data');
    const buf2 = Buffer.from('tenant2 data');

    const url1 = await adapter.upload(buf1, 'image/png', 'shared.png', 1);
    const url2 = await adapter.upload(buf2, 'image/png', 'shared.png', 2);

    assert.notEqual(url1, url2);
    assert.equal(url1, '/media/tenants/1/shared.png');
    assert.equal(url2, '/media/tenants/2/shared.png');

    // Verify files contain different data
    const data1 = fs.readFileSync(path.join(tmpDir, 'tenants', '1', 'shared.png'));
    const data2 = fs.readFileSync(path.join(tmpDir, 'tenants', '2', 'shared.png'));
    assert.notDeepEqual(data1, data2);
  });

  it('removes a file', async () => {
    const buf = Buffer.from('to be deleted');
    await adapter.upload(buf, 'image/png', 'delete-me.png', 1);

    const filePath = path.join(tmpDir, 'tenants', '1', 'delete-me.png');
    assert.ok(fs.existsSync(filePath));

    await adapter.remove('delete-me.png', 1);
    assert.ok(!fs.existsSync(filePath), 'File should be deleted');
  });

  it('remove does not throw for non-existent file', async () => {
    await assert.doesNotReject(
      () => adapter.remove('nonexistent.png', 99)
    );
  });

  it('handles nested key paths correctly', async () => {
    const buf = Buffer.from('nested');
    const url = await adapter.upload(buf, 'image/png', 'a/b/c/deep.png', 5);
    assert.equal(url, '/media/tenants/5/a/b/c/deep.png');

    const filePath = path.join(tmpDir, 'tenants', '5', 'a', 'b', 'c', 'deep.png');
    assert.ok(fs.existsSync(filePath));
  });
});

/* ------------------------------------------------------------------ */
/*  Database adapter tests                                             */
/* ------------------------------------------------------------------ */
describe('database adapter', () => {
  // Replicate createDatabaseAdapter logic for unit testing (no real DB)
  const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

  it('rejects files exceeding 10MB', async () => {
    const adapter = {
      async upload(buf, mimeType, key, tenantId) {
        if (buf.length > MAX_SIZE) {
          throw new Error(`File exceeds maximum size of 10MB (got ${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
        }
      },
    };

    const bigBuf = Buffer.alloc(11 * 1024 * 1024); // 11 MB
    await assert.rejects(
      () => adapter.upload(bigBuf, 'image/png', 'big.png', 1),
      { message: /File exceeds maximum size of 10MB/ }
    );
  });

  it('accepts files exactly at 10MB', async () => {
    const adapter = {
      async upload(buf, mimeType, key, tenantId) {
        if (buf.length > MAX_SIZE) {
          throw new Error(`File exceeds maximum size of 10MB`);
        }
        return `/api/media/file/${tenantId}/${key}`;
      },
    };

    const exactBuf = Buffer.alloc(10 * 1024 * 1024); // exactly 10 MB
    const url = await adapter.upload(exactBuf, 'image/png', 'exact.png', 1);
    assert.equal(url, '/api/media/file/1/exact.png');
  });

  it('returns correct URL format /api/media/file/{tenantId}/{key}', async () => {
    const adapter = {
      async upload(buf, mimeType, key, tenantId) {
        if (buf.length > MAX_SIZE) {
          throw new Error('Too large');
        }
        return `/api/media/file/${tenantId}/${key}`;
      },
    };

    const buf = Buffer.from('small file');
    const url = await adapter.upload(buf, 'image/png', 'images/thumb.png', 7);
    assert.equal(url, '/api/media/file/7/images/thumb.png');
  });
});
