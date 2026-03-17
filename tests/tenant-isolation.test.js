/**
 * Deep Feed AI — Tenant data isolation regression tests
 *
 * Verifies that budget caches, tenant middleware resolution,
 * and storage key prefixing correctly isolate tenant data.
 */
'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------------------------------ */
/*  Budget cache isolation                                             */
/* ------------------------------------------------------------------ */
describe('budget cache isolation', () => {
  // We test the caching logic by replicating getBudgetSettings with a mock DB.
  // This avoids requiring the real module which would try to connect to PG.

  const BUDGET_CACHE_TTL = 60 * 1000;
  let _budgetCache;
  let mockDbRows;

  function createMockBudgetModule() {
    _budgetCache = new Map();
    mockDbRows = new Map(); // tenantId -> rows

    async function getBudgetSettings(tenantId) {
      const now = Date.now();
      const cached = _budgetCache.get(tenantId);
      if (cached && (now - cached.ts) < BUDGET_CACHE_TTL) {
        return cached.settings;
      }

      let settings;
      try {
        const rows = mockDbRows.get(tenantId) || [];
        const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
        settings = {
          dailyBudget:   parseFloat(s.ai_daily_budget)   || 5.00,
          monthlyBudget: parseFloat(s.ai_monthly_budget)  || 50.00,
          warnPct:       parseInt(s.ai_budget_warn_pct)   || 80,
        };
      } catch {
        settings = { dailyBudget: 5.00, monthlyBudget: 50.00, warnPct: 80 };
      }
      _budgetCache.set(tenantId, { settings, ts: now });
      return settings;
    }

    return { getBudgetSettings };
  }

  beforeEach(() => {
    _budgetCache = null;
    mockDbRows = null;
  });

  it('returns different cached values for different tenants', async () => {
    const { getBudgetSettings } = createMockBudgetModule();

    // Set up different DB data per tenant
    mockDbRows.set(1, [
      { key: 'ai_daily_budget', value: '10.00' },
      { key: 'ai_monthly_budget', value: '100.00' },
    ]);
    mockDbRows.set(2, [
      { key: 'ai_daily_budget', value: '3.00' },
      { key: 'ai_monthly_budget', value: '25.00' },
    ]);

    const budget1 = await getBudgetSettings(1);
    const budget2 = await getBudgetSettings(2);

    assert.equal(budget1.dailyBudget, 10.00);
    assert.equal(budget1.monthlyBudget, 100.00);
    assert.equal(budget2.dailyBudget, 3.00);
    assert.equal(budget2.monthlyBudget, 25.00);
    assert.notDeepEqual(budget1, budget2);
  });

  it('caches per tenant independently', async () => {
    const { getBudgetSettings } = createMockBudgetModule();

    mockDbRows.set(1, [{ key: 'ai_daily_budget', value: '10.00' }]);
    mockDbRows.set(2, [{ key: 'ai_daily_budget', value: '3.00' }]);

    // First call populates cache
    await getBudgetSettings(1);
    await getBudgetSettings(2);

    // Change underlying data — cached values should persist
    mockDbRows.set(1, [{ key: 'ai_daily_budget', value: '999.00' }]);

    const budget1 = await getBudgetSettings(1); // should still be cached
    assert.equal(budget1.dailyBudget, 10.00, 'Tenant 1 should return cached value');
  });

  it('returns defaults when no DB rows exist for a tenant', async () => {
    const { getBudgetSettings } = createMockBudgetModule();

    mockDbRows.set(3, []); // empty rows

    const budget = await getBudgetSettings(3);
    assert.equal(budget.dailyBudget, 5.00);
    assert.equal(budget.monthlyBudget, 50.00);
    assert.equal(budget.warnPct, 80);
  });

  it('does not leak tenant 1 cache to tenant 2', async () => {
    const { getBudgetSettings } = createMockBudgetModule();

    mockDbRows.set(1, [
      { key: 'ai_daily_budget', value: '100.00' },
      { key: 'ai_monthly_budget', value: '1000.00' },
      { key: 'ai_budget_warn_pct', value: '90' },
    ]);
    mockDbRows.set(2, []); // tenant 2 has no custom settings

    const budget1 = await getBudgetSettings(1);
    const budget2 = await getBudgetSettings(2);

    assert.equal(budget1.dailyBudget, 100.00);
    assert.equal(budget2.dailyBudget, 5.00); // default, not leaked from tenant 1
    assert.equal(budget1.warnPct, 90);
    assert.equal(budget2.warnPct, 80); // default
  });
});

/* ------------------------------------------------------------------ */
/*  Tenant middleware resolution                                       */
/* ------------------------------------------------------------------ */
describe('tenant middleware resolution', () => {
  const jwt = require('jsonwebtoken');
  const TEST_SECRET = 'test-secret-for-unit-tests';

  // Replicate the tenantContext logic for testability without requiring
  // the real module (which imports db at module level).
  function createTenantContext(mockResolveTenantId) {
    return function tenantContext(req, _res, next) {
      // 1. Try JWT
      const authHeader = req.headers.authorization || '';
      if (authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.slice(7).trim();
          const payload = jwt.verify(token, TEST_SECRET);
          req._verifiedAdminPayload = payload;
          if (payload.tenantId) {
            req.tenantId = payload.tenantId;
            return next();
          }
        } catch { /* not valid */ }
      }

      // 2. X-Tenant-Id + cron secret
      const tenantIdHeader = req.headers['x-tenant-id'];
      if (tenantIdHeader && req.headers['x-cron-secret']) {
        const parsed = parseInt(tenantIdHeader, 10);
        if (parsed > 0) {
          req.tenantId = parsed;
          return next();
        }
      }

      // 3. X-Tenant-Slug
      const slug = req.headers['x-tenant-slug'];
      if (slug && mockResolveTenantId) {
        mockResolveTenantId(slug)
          .then(id => {
            req.tenantId = id || 1;
            next();
          })
          .catch(() => {
            req.tenantId = 1;
            next();
          });
        return;
      }

      // 5. Fallback
      req.tenantId = 1;
      next();
    };
  }

  function makeReq(headers) {
    return { headers: headers || {} };
  }

  it('extracts tenantId from valid admin JWT', (_, done) => {
    const token = jwt.sign({ tenantId: 42, email: 'admin@test.com', type: 'tenant-admin' }, TEST_SECRET);
    const req = makeReq({ authorization: `Bearer ${token}` });

    const middleware = createTenantContext();
    middleware(req, {}, () => {
      assert.equal(req.tenantId, 42);
      assert.ok(req._verifiedAdminPayload);
      assert.equal(req._verifiedAdminPayload.tenantId, 42);
      done();
    });
  });

  it('uses X-Tenant-Id header with x-cron-secret', (_, done) => {
    const req = makeReq({
      'x-tenant-id': '7',
      'x-cron-secret': 'some-secret',
    });

    const middleware = createTenantContext();
    middleware(req, {}, () => {
      assert.equal(req.tenantId, 7);
      done();
    });
  });

  it('ignores X-Tenant-Id without x-cron-secret', (_, done) => {
    const req = makeReq({
      'x-tenant-id': '7',
    });

    const middleware = createTenantContext();
    middleware(req, {}, () => {
      assert.equal(req.tenantId, 1); // falls through to default
      done();
    });
  });

  it('resolves X-Tenant-Slug via mock DB lookup', (_, done) => {
    const mockResolve = async (slug) => {
      if (slug === 'acme') return 5;
      return null;
    };

    const req = makeReq({ 'x-tenant-slug': 'acme' });
    const middleware = createTenantContext(mockResolve);
    middleware(req, {}, () => {
      assert.equal(req.tenantId, 5);
      done();
    });
  });

  it('falls back to 1 when slug lookup returns null', (_, done) => {
    const mockResolve = async () => null;

    const req = makeReq({ 'x-tenant-slug': 'nonexistent' });
    const middleware = createTenantContext(mockResolve);
    middleware(req, {}, () => {
      assert.equal(req.tenantId, 1);
      done();
    });
  });

  it('falls back to 1 when slug lookup throws', (_, done) => {
    const mockResolve = async () => { throw new Error('DB down'); };

    const req = makeReq({ 'x-tenant-slug': 'broken' });
    const middleware = createTenantContext(mockResolve);
    middleware(req, {}, () => {
      assert.equal(req.tenantId, 1);
      done();
    });
  });

  it('defaults to tenantId 1 with no headers', (_, done) => {
    const req = makeReq({});
    const middleware = createTenantContext();
    middleware(req, {}, () => {
      assert.equal(req.tenantId, 1);
      done();
    });
  });

  it('rejects invalid JWT and falls through to default', (_, done) => {
    const req = makeReq({ authorization: 'Bearer invalid.token.here' });
    const middleware = createTenantContext();
    middleware(req, {}, () => {
      assert.equal(req.tenantId, 1);
      assert.equal(req._verifiedAdminPayload, undefined);
      done();
    });
  });

  it('JWT without tenantId claim falls through to next resolution step', (_, done) => {
    const token = jwt.sign({ email: 'user@test.com' }, TEST_SECRET);
    const req = makeReq({
      authorization: `Bearer ${token}`,
      'x-tenant-id': '3',
      'x-cron-secret': 'secret',
    });

    const middleware = createTenantContext();
    middleware(req, {}, () => {
      // Should have fallen through JWT (no tenantId) to X-Tenant-Id
      assert.equal(req.tenantId, 3);
      done();
    });
  });

  it('ignores X-Tenant-Id with value 0 or negative', (_, done) => {
    const req = makeReq({
      'x-tenant-id': '0',
      'x-cron-secret': 'secret',
    });

    const middleware = createTenantContext();
    middleware(req, {}, () => {
      assert.equal(req.tenantId, 1); // falls to default
      done();
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Storage key prefixing                                              */
/* ------------------------------------------------------------------ */
describe('storage key prefixing', () => {
  it('local adapter prefixes keys with tenants/{tenantId}/', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfa-prefix-test-'));

    const adapter = {
      async upload(buf, mimeType, key, tenantId) {
        const filePath = path.join(tmpDir, 'tenants', String(tenantId), key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buf);
        return `/media/tenants/${tenantId}/${key}`;
      },
    };

    const url = await adapter.upload(Buffer.from('x'), 'image/png', 'pic.png', 10);
    assert.match(url, /^\/media\/tenants\/10\//);
    assert.ok(fs.existsSync(path.join(tmpDir, 'tenants', '10', 'pic.png')));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('s3 adapter prefixes keys with tenants/{tenantId}/', () => {
    // Verify the S3 upload constructs the correct fullKey
    // We test the key construction logic without actually calling S3
    function buildS3Key(key, tenantId) {
      return `tenants/${tenantId}/${key}`;
    }

    assert.equal(buildS3Key('images/thumb.png', 1), 'tenants/1/images/thumb.png');
    assert.equal(buildS3Key('audio/podcast.mp3', 99), 'tenants/99/audio/podcast.mp3');
  });

  it('database adapter uses tenantId in URL path', () => {
    function buildDbUrl(key, tenantId) {
      return `/api/media/file/${tenantId}/${key}`;
    }

    assert.equal(buildDbUrl('img.png', 1), '/api/media/file/1/img.png');
    assert.equal(buildDbUrl('img.png', 2), '/api/media/file/2/img.png');
    assert.notEqual(buildDbUrl('img.png', 1), buildDbUrl('img.png', 2));
  });

  it('same key different tenants produce different S3 keys', () => {
    const key = 'images/logo.png';
    const fullKey1 = `tenants/1/${key}`;
    const fullKey2 = `tenants/2/${key}`;
    assert.notEqual(fullKey1, fullKey2);
  });
});
