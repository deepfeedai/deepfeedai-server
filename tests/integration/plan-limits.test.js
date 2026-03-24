/**
 * Deep Feed AI — Integration: plan limit enforcement
 *
 * Verifies that checkPlanLimit correctly enforces limits
 * per plan and that unlimited (business) plans always allow.
 * Also tests trial override and free plan restrictions.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, initTestDb, createTestTenant, cleanupTestData } = require('../helpers');
const { checkPlanLimit, checkFeatureEnabled, getPlanInfo, bustPlanCache } = require('../../lib/plan-limits');

let starterTenant, businessTenant, freeTenant, trialTenant;
let starterMaxSources, freeMaxSources;

before(async () => {
  await initTestDb();
  starterTenant  = await createTestTenant('starter');
  businessTenant = await createTestTenant('business');
  freeTenant     = await createTestTenant('free');

  // Create a tenant on free plan with an active trial
  trialTenant = await createTestTenant('free');
  await db.prepare(
    "UPDATE tenants SET trial_ends_at = NOW() + INTERVAL '14 days' WHERE id = $1"
  ).run(trialTenant.id);
  bustPlanCache(trialTenant.id);

  // Read plan_limits to find max_sources for starter
  const starterLimits = await db.prepare(
    "SELECT * FROM plan_limits WHERE plan = 'starter'"
  ).get();
  starterMaxSources = starterLimits.max_sources;
  assert.ok(starterMaxSources > 0, 'Starter plan should have a max_sources limit');

  const freeLimits = await db.prepare(
    "SELECT * FROM plan_limits WHERE plan = 'free'"
  ).get();
  freeMaxSources = freeLimits.max_sources;
  assert.ok(freeMaxSources > 0, 'Free plan should have a max_sources limit');
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

describe('plan limits — free plan', () => {
  it('enforces low source limit', async () => {
    // Insert sources up to free max
    for (let i = 0; i < freeMaxSources; i++) {
      await db.prepare(
        'INSERT INTO sources (name, url, tenant_id) VALUES ($1, $2, $3)'
      ).run(`Free Source ${i}`, `https://free-test-${Date.now()}-${i}.example.com/rss`, freeTenant.id);
    }

    const result = await checkPlanLimit(freeTenant.id, 'sources');
    assert.equal(result.allowed, false, 'Free plan should be disallowed at max_sources');
    assert.equal(result.max, freeMaxSources);
  });

  it('has $0 AI budget', async () => {
    const info = await getPlanInfo(freeTenant.id);
    assert.equal(parseFloat(info.limits.max_ai_cost_month), 0, 'Free plan AI budget should be $0');
  });
});

describe('plan limits — trial override', () => {
  it('applies pro limits during active trial', async () => {
    const info = await getPlanInfo(trialTenant.id);
    assert.equal(info.plan, 'free', 'Actual plan should be free');
    assert.equal(info.effectivePlan, 'pro', 'Effective plan should be pro during trial');
    assert.equal(info.onTrial, true);
  });

  it('allows pro-level source count during trial', async () => {
    const proLimits = await db.prepare(
      "SELECT max_sources FROM plan_limits WHERE plan = 'pro'"
    ).get();

    // Insert more sources than free allows but within pro limit
    for (let i = 0; i < freeMaxSources + 1; i++) {
      await db.prepare(
        'INSERT INTO sources (name, url, tenant_id) VALUES ($1, $2, $3)'
      ).run(`Trial Source ${i}`, `https://trial-test-${Date.now()}-${i}.example.com/rss`, trialTenant.id);
    }

    const result = await checkPlanLimit(trialTenant.id, 'sources');
    assert.equal(result.allowed, true, 'Trial tenant should get pro-level limits');
    assert.equal(result.max, proLimits.max_sources);
  });

  it('reverts to free limits when trial expires', async () => {
    // Expire the trial
    await db.prepare(
      "UPDATE tenants SET trial_ends_at = NOW() - INTERVAL '1 day' WHERE id = $1"
    ).run(trialTenant.id);
    bustPlanCache(trialTenant.id);

    const info = await getPlanInfo(trialTenant.id);
    assert.equal(info.effectivePlan, 'free', 'Should revert to free plan after trial');
    assert.equal(info.onTrial, false);

    // Now the tenant has more sources than free allows, so should be blocked
    const result = await checkPlanLimit(trialTenant.id, 'sources');
    assert.equal(result.allowed, false, 'Should be blocked under free limits after trial expiry');
    assert.equal(result.max, freeMaxSources);
  });
});

describe('plan limits — articles_month no longer enforced', () => {
  it('rejects articles_month as unknown resource', async () => {
    await assert.rejects(
      () => checkPlanLimit(starterTenant.id, 'articles_month'),
      { message: /Unknown resource/ },
      'articles_month should no longer be a valid resource'
    );
  });
});

describe('plan limits — seo_titles_enabled feature flag', () => {
  it('blocks SEO titles on free plan', async () => {
    const enabled = await checkFeatureEnabled(freeTenant.id, 'seo_titles_enabled');
    assert.equal(enabled, false, 'Free plan should not have SEO titles');
  });

  it('allows SEO titles on pro plan', async () => {
    // Use a pro tenant — the trial tenant had its trial expired, so create a fresh check
    const proTenant = await createTestTenant('pro');
    const enabled = await checkFeatureEnabled(proTenant.id, 'seo_titles_enabled');
    assert.equal(enabled, true, 'Pro plan should have SEO titles enabled');
  });
});

describe('plan limits — nonexistent tenant', () => {
  it('gracefully allows when tenant not found', async () => {
    const result = await checkPlanLimit(999999, 'sources');
    assert.equal(result.allowed, true, 'Should allow by default when tenant not found');
  });
});
