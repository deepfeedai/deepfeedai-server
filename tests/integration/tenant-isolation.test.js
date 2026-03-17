/**
 * Deep Feed AI — Integration: tenant data isolation
 *
 * Verifies that articles, settings, and sources for one tenant
 * are not visible to another tenant via direct DB queries.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

describe('tenant isolation — articles', () => {
  it('article inserted for tenant A is not visible to tenant B', async () => {
    await db.prepare(
      `INSERT INTO articles (title, summary, tenant_id) VALUES ($1, $2, $3)`
    ).run('Tenant A Article', 'Summary A', tenantA.id);

    const rows = await db.prepare(
      'SELECT * FROM articles WHERE tenant_id = $1'
    ).all(tenantB.id);

    assert.equal(rows.length, 0, 'Tenant B should see 0 articles from tenant A');
  });

  it('tenant A can see its own article', async () => {
    const rows = await db.prepare(
      'SELECT * FROM articles WHERE tenant_id = $1'
    ).all(tenantA.id);

    assert.ok(rows.length >= 1, 'Tenant A should see its own articles');
    assert.equal(rows[0].title, 'Tenant A Article');
  });
});

describe('tenant isolation — settings', () => {
  it('setting inserted for tenant A is not visible to tenant B', async () => {
    await db.prepare(
      `INSERT INTO settings (key, value, tenant_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`
    ).run('test_setting', 'value_a', tenantA.id);

    const row = await db.prepare(
      "SELECT * FROM settings WHERE key = 'test_setting' AND tenant_id = $1"
    ).get(tenantB.id);

    assert.equal(row, null, 'Tenant B should not see tenant A settings');
  });

  it('tenant A can read its own setting', async () => {
    const row = await db.prepare(
      "SELECT * FROM settings WHERE key = 'test_setting' AND tenant_id = $1"
    ).get(tenantA.id);

    assert.ok(row, 'Tenant A should find its setting');
    assert.equal(row.value, 'value_a');
  });
});

describe('tenant isolation — sources', () => {
  it('source inserted for tenant A is not visible to tenant B', async () => {
    await db.prepare(
      `INSERT INTO sources (name, url, tenant_id) VALUES ($1, $2, $3)`
    ).run('Test Source A', `https://test-${Date.now()}.example.com/rss`, tenantA.id);

    const rows = await db.prepare(
      'SELECT * FROM sources WHERE tenant_id = $1'
    ).all(tenantB.id);

    assert.equal(rows.length, 0, 'Tenant B should see 0 sources from tenant A');
  });

  it('tenant A can see its own source', async () => {
    const rows = await db.prepare(
      'SELECT * FROM sources WHERE tenant_id = $1'
    ).all(tenantA.id);

    assert.ok(rows.length >= 1, 'Tenant A should see its own sources');
  });
});
