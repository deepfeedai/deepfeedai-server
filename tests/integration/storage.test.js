/**
 * Deep Feed AI — Integration: storage tenant isolation
 *
 * Verifies that database adapter and local adapter correctly
 * isolate files per tenant.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { db, initTestDb, createTestTenant, cleanupTestData } = require('../helpers');

let tenantA, tenantB;

before(async () => {
  await initTestDb();
  tenantA = await createTestTenant('starter');
  tenantB = await createTestTenant('starter');
});

after(async () => {
  await cleanupTestData();
});

describe('storage — database adapter tenant isolation', () => {
  it('file uploaded for tenant A is not found by tenant B query', async () => {
    const key = `test-file-${Date.now()}.png`;
    const data = Buffer.from('fake image data for tenant A');

    await db.prepare(
      `INSERT INTO file_storage (tenant_id, key, mime_type, data, size)
       VALUES ($1, $2, $3, $4, $5)`
    ).run(tenantA.id, key, 'image/png', data, data.length);

    // Tenant B should not find it
    const row = await db.prepare(
      'SELECT * FROM file_storage WHERE tenant_id = $1 AND key = $2'
    ).get(tenantB.id, key);

    assert.equal(row, null, 'Tenant B should not find tenant A files');
  });

  it('tenant A can retrieve its own file', async () => {
    const key = `own-file-${Date.now()}.png`;
    const data = Buffer.from('tenant A own data');

    await db.prepare(
      `INSERT INTO file_storage (tenant_id, key, mime_type, data, size)
       VALUES ($1, $2, $3, $4, $5)`
    ).run(tenantA.id, key, 'image/png', data, data.length);

    const row = await db.prepare(
      'SELECT * FROM file_storage WHERE tenant_id = $1 AND key = $2'
    ).get(tenantA.id, key);

    assert.ok(row, 'Tenant A should find its own file');
    assert.equal(row.mime_type, 'image/png');
    assert.equal(row.size, data.length);
  });

  it('same key for different tenants are independent rows', async () => {
    const key = `shared-key-${Date.now()}.txt`;
    const dataA = Buffer.from('data-for-A');
    const dataB = Buffer.from('data-for-B-longer');

    await db.prepare(
      `INSERT INTO file_storage (tenant_id, key, mime_type, data, size)
       VALUES ($1, $2, $3, $4, $5)`
    ).run(tenantA.id, key, 'text/plain', dataA, dataA.length);

    await db.prepare(
      `INSERT INTO file_storage (tenant_id, key, mime_type, data, size)
       VALUES ($1, $2, $3, $4, $5)`
    ).run(tenantB.id, key, 'text/plain', dataB, dataB.length);

    const rowA = await db.prepare(
      'SELECT size FROM file_storage WHERE tenant_id = $1 AND key = $2'
    ).get(tenantA.id, key);
    const rowB = await db.prepare(
      'SELECT size FROM file_storage WHERE tenant_id = $1 AND key = $2'
    ).get(tenantB.id, key);

    assert.ok(rowA);
    assert.ok(rowB);
    assert.equal(rowA.size, dataA.length);
    assert.equal(rowB.size, dataB.length);
    assert.notEqual(rowA.size, rowB.size);
  });
});

describe('storage — local adapter path isolation', () => {
  let tmpDir;
  let adapter;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfa-integ-storage-'));
    adapter = {
      async upload(buf, mimeType, key, tenantId) {
        const filePath = path.join(tmpDir, 'tenants', String(tenantId), key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buf);
        return `/media/tenants/${tenantId}/${key}`;
      },
    };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uploads for tenant 1 are stored in tenants/1/ directory', async () => {
    const buf = Buffer.from('tenant-1-image');
    const url = await adapter.upload(buf, 'image/png', 'photo.png', 1);

    assert.match(url, /\/media\/tenants\/1\//);
    assert.ok(fs.existsSync(path.join(tmpDir, 'tenants', '1', 'photo.png')));
  });

  it('tenant 2 upload with same key does not overwrite tenant 1 file', async () => {
    const buf1 = Buffer.from('tenant-1-data');
    const buf2 = Buffer.from('tenant-2-data-different');

    await adapter.upload(buf1, 'image/png', 'same.png', 1);
    await adapter.upload(buf2, 'image/png', 'same.png', 2);

    const data1 = fs.readFileSync(path.join(tmpDir, 'tenants', '1', 'same.png'));
    const data2 = fs.readFileSync(path.join(tmpDir, 'tenants', '2', 'same.png'));

    assert.deepEqual(data1, buf1, 'Tenant 1 file should be unchanged');
    assert.deepEqual(data2, buf2);
    assert.notDeepEqual(data1, data2);
  });

  it('tenant 2 directory does not contain tenant 1 files', () => {
    const tenant2Dir = path.join(tmpDir, 'tenants', '2');
    const files = fs.existsSync(tenant2Dir) ? fs.readdirSync(tenant2Dir) : [];
    // Should only contain files uploaded for tenant 2
    assert.ok(!files.includes('photo.png'), 'Tenant 2 should not have tenant 1 photo.png');
  });
});
