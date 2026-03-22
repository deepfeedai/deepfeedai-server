/**
 * Deep Feed AI — Security validation regression tests
 *
 * Tests for rate limiter key generation, CORS validation,
 * auth middleware tenant mismatch rejection, and tenant slug validation.
 */
'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------------------------------ */
/*  Rate limiter key generation                                        */
/* ------------------------------------------------------------------ */
describe('rate limiter key generation', () => {
  // Replicate the keyGenerator functions from server.js
  const summaryKeyGenerator = (req) => `${req.tenantId || 1}:${req.ip}`;
  const publicApiKeyGenerator = (req) => `${req.tenantId || 1}:${req.ip}`;

  it('produces tenant-scoped keys for summary limiter', () => {
    const key1 = summaryKeyGenerator({ tenantId: 1, ip: '1.2.3.4' });
    const key2 = summaryKeyGenerator({ tenantId: 2, ip: '1.2.3.4' });

    assert.equal(key1, '1:1.2.3.4');
    assert.equal(key2, '2:1.2.3.4');
    assert.notEqual(key1, key2);
  });

  it('produces tenant-scoped keys for public API limiter', () => {
    const key1 = publicApiKeyGenerator({ tenantId: 5, ip: '10.0.0.1' });
    const key2 = publicApiKeyGenerator({ tenantId: 6, ip: '10.0.0.1' });

    assert.notEqual(key1, key2);
    assert.equal(key1, '5:10.0.0.1');
  });

  it('defaults to tenant 1 when tenantId is not set', () => {
    const key = summaryKeyGenerator({ ip: '1.2.3.4' });
    assert.equal(key, '1:1.2.3.4');
  });

  it('same tenant + same IP produce identical keys', () => {
    const req = { tenantId: 3, ip: '5.6.7.8' };
    assert.equal(summaryKeyGenerator(req), summaryKeyGenerator(req));
  });

  it('same tenant + different IPs produce different keys', () => {
    const key1 = summaryKeyGenerator({ tenantId: 1, ip: '1.1.1.1' });
    const key2 = summaryKeyGenerator({ tenantId: 1, ip: '2.2.2.2' });
    assert.notEqual(key1, key2);
  });
});

/* ------------------------------------------------------------------ */
/*  CORS validation                                                    */
/* ------------------------------------------------------------------ */
describe('CORS validation', () => {
  // Replicate the CORS check logic from server.js
  const isTenantSubdomain = (origin) => /^https?:\/\/[a-z0-9-]+\.deepfeedai\.com$/.test(origin);

  const PUBLIC_PATHS = ['/api/news', '/api/article', '/api/summary', '/api/user-auth',
    '/api/comments', '/api/subscribe', '/api/unsubscribe', '/api/contact',
    '/api/thumbnail', '/api/trends', '/api/favorites', '/api/article-reactions',
    '/api/notifications', '/api/read-history', '/api/site-config',
    '/api/analytics/event', '/api/writers'];

  function isPublicPath(reqPath) {
    return PUBLIC_PATHS.some(p => reqPath.startsWith(p));
  }

  /**
   * Simplified CORS check: returns 'allowed' or 'blocked'
   * for non-public, non-same-origin requests.
   */
  function checkCors(origin, reqPath, allowedOrigins, serverOrigin) {
    if (!origin) return 'allowed'; // no origin header
    const isPublic = isPublicPath(reqPath);
    const isSameOrigin = origin === serverOrigin;
    const isTenantSub = isTenantSubdomain(origin);

    if (!isSameOrigin && !isPublic && !allowedOrigins.includes(origin) && !isTenantSub) {
      return 'blocked';
    }
    return 'allowed';
  }

  it('allows *.deepfeedai.com subdomains for admin endpoints', () => {
    assert.equal(
      checkCors('https://acme.deepfeedai.com', '/api/articles', [], 'https://portal.deepfeedai.com'),
      'allowed'
    );
    assert.equal(
      checkCors('https://my-site.deepfeedai.com', '/api/settings', [], 'https://portal.deepfeedai.com'),
      'allowed'
    );
  });

  it('allows http subdomains too', () => {
    assert.equal(
      checkCors('http://test.deepfeedai.com', '/api/articles', [], 'https://portal.deepfeedai.com'),
      'allowed'
    );
  });

  it('blocks random external origins on non-public paths', () => {
    assert.equal(
      checkCors('https://evil.example.com', '/api/sources', [], 'https://portal.deepfeedai.com'),
      'blocked'
    );
    assert.equal(
      checkCors('https://attacker.io', '/api/settings', [], 'https://portal.deepfeedai.com'),
      'blocked'
    );
  });

  it('allows external origins on public paths', () => {
    assert.equal(
      checkCors('https://external.com', '/api/news', [], 'https://portal.deepfeedai.com'),
      'allowed'
    );
    assert.equal(
      checkCors('https://external.com', '/api/article/some-slug', [], 'https://portal.deepfeedai.com'),
      'allowed'
    );
  });

  it('allows same-origin requests on any path', () => {
    assert.equal(
      checkCors('https://portal.deepfeedai.com', '/api/articles', [], 'https://portal.deepfeedai.com'),
      'allowed'
    );
  });

  it('allows explicitly listed origins', () => {
    const allowed = ['https://my-custom-domain.com'];
    assert.equal(
      checkCors('https://my-custom-domain.com', '/api/articles', allowed, 'https://portal.deepfeedai.com'),
      'allowed'
    );
  });

  it('allows requests with no origin header', () => {
    assert.equal(checkCors(null, '/api/articles', [], 'https://portal.deepfeedai.com'), 'allowed');
    assert.equal(checkCors(undefined, '/api/articles', [], 'https://portal.deepfeedai.com'), 'allowed');
  });

  it('blocks subdomains that do not match the pattern', () => {
    // Uppercase not matched by the regex
    assert.equal(
      checkCors('https://ACME.deepfeedai.com', '/api/sources', [], 'https://portal.deepfeedai.com'),
      'blocked'
    );
    // Extra dots
    assert.equal(
      checkCors('https://sub.sub.deepfeedai.com', '/api/sources', [], 'https://portal.deepfeedai.com'),
      'blocked'
    );
  });

  it('tenant subdomain regex requires deepfeedai.com domain', () => {
    assert.equal(isTenantSubdomain('https://acme.deepfeedai.com'), true);
    assert.equal(isTenantSubdomain('https://acme.notdeepfeed.com'), false);
    assert.equal(isTenantSubdomain('https://deepfeedai.com'), false); // no subdomain
  });
});

/* ------------------------------------------------------------------ */
/*  Auth middleware — tenant mismatch rejection                        */
/* ------------------------------------------------------------------ */
describe('auth middleware tenant mismatch', () => {
  const jwt = require('jsonwebtoken');
  const TEST_SECRET = 'test-jwt-secret-security';

  // Replicate auth middleware logic for isolated testing
  const VALID_TYPES = new Set(['platform-admin', 'tenant-admin']);

  function createAuthMiddleware(jwtSecret, adminEmails) {
    return function auth(req, res, next) {
      let payload = req._verifiedAdminPayload;

      if (!payload) {
        const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
        if (!token) return res.status(401).json({ error: 'Unauthorized' });
        try {
          payload = jwt.verify(token, jwtSecret);
        } catch {
          return res.status(401).json({ error: 'Invalid or expired token' });
        }
      }

      if (!payload.type || !VALID_TYPES.has(payload.type)) {
        const email = (payload.email || '').toLowerCase();
        if (email && adminEmails.includes(email)) {
          payload.type = 'platform-admin';
          payload.tenantId = payload.tenantId || 1;
        } else {
          return res.status(403).json({ error: 'Invalid token type — admin access required' });
        }
      }

      // Cross-check tenantId
      if (payload.type === 'tenant-admin' && payload.tenantId && req.tenantId) {
        if (payload.tenantId !== req.tenantId) {
          return res.status(403).json({ error: 'Tenant mismatch — token does not match request context' });
        }
      }

      req.user = payload;
      next();
    };
  }

  function makeReq(headers, tenantId) {
    return { headers: headers || {}, tenantId };
  }

  function makeRes() {
    let statusCode = 200;
    let body = null;
    return {
      status(code) { statusCode = code; return this; },
      json(data) { body = data; return this; },
      get statusCode() { return statusCode; },
      get body() { return body; },
    };
  }

  it('rejects tenant-admin JWT when tenantId does not match request context', () => {
    const auth = createAuthMiddleware(TEST_SECRET, []);
    const token = jwt.sign({ tenantId: 5, email: 'user@test.com', type: 'tenant-admin' }, TEST_SECRET);
    const req = makeReq({ authorization: `Bearer ${token}` }, 10); // request context is tenant 10
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /Tenant mismatch/);
  });

  it('allows tenant-admin JWT when tenantId matches request context', () => {
    const auth = createAuthMiddleware(TEST_SECRET, []);
    const token = jwt.sign({ tenantId: 5, email: 'user@test.com', type: 'tenant-admin' }, TEST_SECRET);
    const req = makeReq({ authorization: `Bearer ${token}` }, 5);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.user.tenantId, 5);
  });

  it('allows platform-admin even when tenantIds differ', () => {
    const auth = createAuthMiddleware(TEST_SECRET, []);
    const token = jwt.sign({ tenantId: 1, email: 'superadmin@test.com', type: 'platform-admin' }, TEST_SECRET);
    const req = makeReq({ authorization: `Bearer ${token}` }, 99);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.user.type, 'platform-admin');
  });

  it('returns 401 when no token is provided', () => {
    const auth = createAuthMiddleware(TEST_SECRET, []);
    const req = makeReq({}, 1);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 for expired token', () => {
    const auth = createAuthMiddleware(TEST_SECRET, []);
    const token = jwt.sign({ tenantId: 1, type: 'tenant-admin' }, TEST_SECRET, { expiresIn: '-1s' });
    const req = makeReq({ authorization: `Bearer ${token}` }, 1);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 for token with invalid type', () => {
    const auth = createAuthMiddleware(TEST_SECRET, []);
    const token = jwt.sign({ tenantId: 1, email: 'user@random.com', type: 'user' }, TEST_SECRET);
    const req = makeReq({ authorization: `Bearer ${token}` }, 1);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /admin access required/);
  });

  it('grants legacy grace to ADMIN_EMAILS tokens without type claim', () => {
    const auth = createAuthMiddleware(TEST_SECRET, ['legacy@admin.com']);
    const token = jwt.sign({ email: 'legacy@admin.com' }, TEST_SECRET); // no type claim
    const req = makeReq({ authorization: `Bearer ${token}` }, 1);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.user.type, 'platform-admin');
    assert.equal(req.user.tenantId, 1);
  });

  it('reuses _verifiedAdminPayload from tenant middleware', () => {
    const auth = createAuthMiddleware(TEST_SECRET, []);
    const payload = { tenantId: 3, email: 'admin@site.com', type: 'tenant-admin' };
    const req = { headers: {}, tenantId: 3, _verifiedAdminPayload: payload };
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.user.tenantId, 3);
  });
});

/* ------------------------------------------------------------------ */
/*  Tenant signup validation                                           */
/* ------------------------------------------------------------------ */
describe('tenant slug validation', () => {
  // Replicate validation constants from routes/tenants.js
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
  const RESERVED_SLUGS = new Set([
    'www', 'api', 'admin', 'app', 'mail', 'ftp', 'staging', 'dev',
    'test', 'portal', 'portal-staging', 'status', 'help', 'support', 'blog',
  ]);

  function validateSlug(slug) {
    const clean = slug.toLowerCase().trim();
    if (!SLUG_RE.test(clean)) return { valid: false, reason: 'format' };
    if (RESERVED_SLUGS.has(clean)) return { valid: false, reason: 'reserved' };
    return { valid: true };
  }

  it('accepts valid slugs', () => {
    assert.ok(validateSlug('acme').valid);
    assert.ok(validateSlug('my-site').valid);
    assert.ok(validateSlug('tech-news-42').valid);
    assert.ok(validateSlug('abc').valid); // minimum 3 chars
  });

  it('rejects slugs shorter than 3 characters', () => {
    assert.equal(validateSlug('ab').valid, false);
    assert.equal(validateSlug('a').valid, false);
  });

  it('rejects slugs starting or ending with hyphen', () => {
    assert.equal(validateSlug('-abc').valid, false);
    assert.equal(validateSlug('abc-').valid, false);
    assert.equal(validateSlug('-abc-').valid, false);
  });

  it('rejects slugs with uppercase letters', () => {
    // The regex only matches lowercase
    assert.equal(SLUG_RE.test('ABC'), false);
    assert.equal(SLUG_RE.test('Acme'), false);
  });

  it('rejects slugs with special characters', () => {
    assert.equal(SLUG_RE.test('my_site'), false);
    assert.equal(SLUG_RE.test('my.site'), false);
    assert.equal(SLUG_RE.test('my site'), false);
    assert.equal(SLUG_RE.test('my@site'), false);
  });

  it('rejects slugs longer than 50 characters', () => {
    const longSlug = 'a' + 'b'.repeat(50) + 'c'; // 52 chars
    assert.equal(SLUG_RE.test(longSlug), false);
  });

  it('accepts slugs at max length (50 characters)', () => {
    const maxSlug = 'a' + 'b'.repeat(48) + 'c'; // exactly 50 chars
    assert.equal(SLUG_RE.test(maxSlug), true);
  });

  it('blocks all reserved slugs', () => {
    for (const reserved of RESERVED_SLUGS) {
      const result = validateSlug(reserved);
      assert.equal(result.valid, false, `"${reserved}" should be reserved`);
      assert.equal(result.reason, 'reserved');
    }
  });

  it('does not block non-reserved slugs', () => {
    assert.ok(validateSlug('my-company').valid);
    assert.ok(validateSlug('news-site').valid);
    assert.ok(validateSlug('techblog42').valid);
  });

  it('allows hyphens in the middle', () => {
    assert.ok(SLUG_RE.test('my-cool-site'));
    assert.ok(SLUG_RE.test('a-b'));
    assert.ok(SLUG_RE.test('a-b-c-d-e'));
  });

  it('allows numbers', () => {
    assert.ok(SLUG_RE.test('site123'));
    assert.ok(SLUG_RE.test('123site'));
    assert.ok(SLUG_RE.test('12345'));
  });
});
