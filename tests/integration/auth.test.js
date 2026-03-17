/**
 * Deep Feed AI — Integration: auth middleware tenant enforcement
 *
 * Verifies JWT validation, tenant mismatch rejection,
 * platform-admin cross-tenant access, and expired token handling.
 * Uses the replicated middleware pattern from tests/security.test.js.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// Use a dedicated test secret — matches the pattern in security.test.js
const TEST_SECRET = 'test-jwt-secret-auth-integration';

const VALID_TYPES = new Set(['platform-admin', 'tenant-admin']);

function createAuthMiddleware(jwtSecret, adminEmails = []) {
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

describe('auth — tenant mismatch rejection', () => {
  it('rejects tenant-admin JWT for tenant 5 when request context is tenant 10', () => {
    const auth = createAuthMiddleware(TEST_SECRET);
    const token = jwt.sign({ tenantId: 5, email: 'user@test.com', type: 'tenant-admin' }, TEST_SECRET);
    const req = makeReq({ authorization: `Bearer ${token}` }, 10);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false, 'next() should not be called on mismatch');
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /Tenant mismatch/);
  });

  it('allows tenant-admin JWT when tenantId matches', () => {
    const auth = createAuthMiddleware(TEST_SECRET);
    const token = jwt.sign({ tenantId: 5, email: 'user@test.com', type: 'tenant-admin' }, TEST_SECRET);
    const req = makeReq({ authorization: `Bearer ${token}` }, 5);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.user.tenantId, 5);
  });
});

describe('auth — platform-admin cross-tenant access', () => {
  it('allows platform-admin even when tenantIds differ', () => {
    const auth = createAuthMiddleware(TEST_SECRET);
    const token = jwt.sign({ tenantId: 1, email: 'super@admin.com', type: 'platform-admin' }, TEST_SECRET);
    const req = makeReq({ authorization: `Bearer ${token}` }, 99);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.user.type, 'platform-admin');
  });

  it('platform-admin can access any tenant', () => {
    const auth = createAuthMiddleware(TEST_SECRET);
    for (const tenantId of [1, 5, 42, 999]) {
      const token = jwt.sign({ tenantId: 1, email: 'admin@site.com', type: 'platform-admin' }, TEST_SECRET);
      const req = makeReq({ authorization: `Bearer ${token}` }, tenantId);
      const res = makeRes();
      let nextCalled = false;

      auth(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, true, `Should allow platform-admin access to tenant ${tenantId}`);
    }
  });
});

describe('auth — expired token', () => {
  it('returns 401 for expired token', () => {
    const auth = createAuthMiddleware(TEST_SECRET);
    const token = jwt.sign(
      { tenantId: 1, type: 'tenant-admin' },
      TEST_SECRET,
      { expiresIn: '-1s' }
    );
    const req = makeReq({ authorization: `Bearer ${token}` }, 1);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.match(res.body.error, /Invalid or expired/);
  });
});

describe('auth — missing / invalid token', () => {
  it('returns 401 when no token provided', () => {
    const auth = createAuthMiddleware(TEST_SECRET);
    const req = makeReq({}, 1);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 for malformed token', () => {
    const auth = createAuthMiddleware(TEST_SECRET);
    const req = makeReq({ authorization: 'Bearer garbage.token.here' }, 1);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 for token with invalid type', () => {
    const auth = createAuthMiddleware(TEST_SECRET);
    const token = jwt.sign({ tenantId: 1, email: 'user@random.com', type: 'user' }, TEST_SECRET);
    const req = makeReq({ authorization: `Bearer ${token}` }, 1);
    const res = makeRes();
    let nextCalled = false;

    auth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });
});
