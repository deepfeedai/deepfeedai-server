/**
 * Deep Feed AI — Integration: plan limit enforcement
 *
 * Verifies that checkPlanLimit correctly enforces limits
 * per plan and that unlimited (business) plans always allow.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, initTestDb, createTestTenant, cleanupTestData } = require('../helpers');
const { checkPlanLimit } = require('../../lib/plan-limits');

let starterTenant, businessTenant;
let starterMaxSources;

before(async () => {
  await initTestDb();
  starterTenant  = await createTestTenant('starter');
  businessTenant = await createTestTenant('business');

  // Read plan_limits to find max_sources for starter
  const limits = await db.prepare(
    "SELECT * FROM plan_limits WHERE plan = 'starter'"
  ).get();
  starterMaxSources = limits.max_sources;
  assert.ok(starterMaxSources > 0, 'Starter plan should have a max_sources limit');
});

after(async () => {
  await cleanupTestData();
});

describe('plan limits — starter plan', () => {
  it('allows creating sources up to the limit', async () => {
    // Insert sources up to max
    for (let i = 0; i < starterMaxSources; i++) {
      await db.prepare(
        'INSERT INTO sources (name, url, tenant_id) VALUES ($1, $2, $3)'
      ).run(`Limit Source ${i}`, `https://limit-test-${Date.now()}-${i}.example.com/rss`, starterTenant.id);
    }

    // Check: at exactly the limit, should be disallowed
    const result = await checkPlanLimit(starterTenant.id, 'sources');
    assert.equal(result.allowed, false, 'Should be disallowed at max_sources');
    assert.equal(result.current, starterMaxSources);
    assert.equal(result.max, starterMaxSources);
  });

  it('returns allowed=false when over the limit', async () => {
    const result = await checkPlanLimit(starterTenant.id, 'sources');
    assert.equal(result.allowed, false);
  });
});

describe('plan limits — business plan (unlimited)', () => {
  it('always allows source creation (NULL max)', async () => {
    // Insert a few sources for the business tenant
    for (let i = 0; i < 5; i++) {
      await db.prepare(
        'INSERT INTO sources (name, url, tenant_id) VALUES ($1, $2, $3)'
      ).run(`Biz Source ${i}`, `https://biz-test-${Date.now()}-${i}.example.com/rss`, businessTenant.id);
    }

    const result = await checkPlanLimit(businessTenant.id, 'sources');
    assert.equal(result.allowed, true, 'Business plan should always allow');
    assert.equal(result.max, null, 'Business plan max should be null (unlimited)');
  });
});

describe('plan limits — nonexistent tenant', () => {
  it('gracefully allows when tenant not found', async () => {
    const result = await checkPlanLimit(999999, 'sources');
    assert.equal(result.allowed, true, 'Should allow by default when tenant not found');
  });
});
