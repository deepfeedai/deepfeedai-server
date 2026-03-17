/**
 * Deep Feed AI — Unit tests for local auth and permissions
 *
 * Tests permission matching logic, auth methods response shape,
 * and bcrypt password validation. Uses replicated logic for isolated testing.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

/* ------------------------------------------------------------------ */
/*  Permission matching                                                */
/* ------------------------------------------------------------------ */
describe('requirePermission — permission matching', () => {
  // Replicate the permission check logic from middleware/permissions.js
  function checkPermission(userPerms, required) {
    if (userPerms.includes('*')) return true;
    return required.every(p => {
      const [resource] = p.split('.');
      return userPerms.includes(p) || userPerms.includes(`${resource}.*`);
    });
  }

  it('passes with exact permission match', () => {
    assert.equal(checkPermission(['articles.read'], ['articles.read']), true);
  });

  it('passes with wildcard *', () => {
    assert.equal(checkPermission(['*'], ['articles.read']), true);
    assert.equal(checkPermission(['*'], ['settings.update']), true);
    assert.equal(checkPermission(['*'], ['anything.at.all']), true);
  });

  it('passes with resource wildcard (articles.*)', () => {
    assert.equal(checkPermission(['articles.*'], ['articles.read']), true);
    assert.equal(checkPermission(['articles.*'], ['articles.create']), true);
    assert.equal(checkPermission(['articles.*'], ['articles.delete']), true);
  });

  it('denies when user lacks permission', () => {
    assert.equal(checkPermission(['articles.read'], ['articles.delete']), false);
    assert.equal(checkPermission(['sources.read'], ['articles.read']), false);
  });

  it('denies when resource wildcard does not match resource', () => {
    assert.equal(checkPermission(['articles.*'], ['sources.read']), false);
  });

  it('requires all permissions when multiple are specified', () => {
    assert.equal(
      checkPermission(['articles.read', 'sources.read'], ['articles.read', 'sources.read']),
      true
    );
    assert.equal(
      checkPermission(['articles.read'], ['articles.read', 'sources.read']),
      false
    );
  });

  it('denies with empty permissions array', () => {
    assert.equal(checkPermission([], ['articles.read']), false);
  });

  it('passes when no permissions are required (empty required array)', () => {
    assert.equal(checkPermission([], []), true);
    assert.equal(checkPermission(['articles.read'], []), true);
  });

  it('resource wildcard only matches its own resource', () => {
    assert.equal(checkPermission(['comments.*'], ['comments.moderate']), true);
    assert.equal(checkPermission(['comments.*'], ['articles.read']), false);
  });

  it('mixed exact and wildcard permissions', () => {
    const perms = ['articles.*', 'sources.read', 'analytics.read'];
    assert.equal(checkPermission(perms, ['articles.create']), true);
    assert.equal(checkPermission(perms, ['sources.read']), true);
    assert.equal(checkPermission(perms, ['sources.delete']), false);
    assert.equal(checkPermission(perms, ['analytics.read']), true);
  });
});

/* ------------------------------------------------------------------ */
/*  requirePermission middleware behavior                              */
/* ------------------------------------------------------------------ */
describe('requirePermission — middleware integration', () => {
  // Replicate the full middleware for testing HTTP-like behavior
  function requirePermission(...required) {
    return (req, res, next) => {
      const perms = req.user?.permissions || [];
      if (perms.includes('*')) return next();
      const hasAll = required.every(p => {
        const [resource] = p.split('.');
        return perms.includes(p) || perms.includes(`${resource}.*`);
      });
      if (!hasAll) return res.status(403).json({ error: 'Insufficient permissions', required });
      next();
    };
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

  it('returns 403 with required permissions in the response', () => {
    const mw = requirePermission('articles.delete');
    const req = { user: { permissions: ['articles.read'] } };
    const res = makeRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'Insufficient permissions');
    assert.deepEqual(res.body.required, ['articles.delete']);
  });

  it('calls next() when permission is satisfied', () => {
    const mw = requirePermission('articles.read');
    const req = { user: { permissions: ['articles.read'] } };
    const res = makeRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
  });

  it('handles missing req.user gracefully', () => {
    const mw = requirePermission('articles.read');
    const req = {};
    const res = makeRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it('handles req.user with no permissions array', () => {
    const mw = requirePermission('articles.read');
    const req = { user: {} };
    const res = makeRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });
});

/* ------------------------------------------------------------------ */
/*  Auth methods endpoint                                              */
/* ------------------------------------------------------------------ */
describe('auth methods response', () => {
  // Replicate the logic from routes/local-auth.js GET /methods
  function getAuthMethods(env) {
    return {
      google: !!env.GOOGLE_CLIENT_ID,
      github: !!env.GITHUB_CLIENT_ID,
      local: true,
    };
  }

  it('returns google: true when GOOGLE_CLIENT_ID is set', () => {
    const result = getAuthMethods({ GOOGLE_CLIENT_ID: 'some-id' });
    assert.equal(result.google, true);
  });

  it('returns google: false when GOOGLE_CLIENT_ID is not set', () => {
    const result = getAuthMethods({});
    assert.equal(result.google, false);
  });

  it('returns github: true when GITHUB_CLIENT_ID is set', () => {
    const result = getAuthMethods({ GITHUB_CLIENT_ID: 'some-id' });
    assert.equal(result.github, true);
  });

  it('returns github: false when GITHUB_CLIENT_ID is not set', () => {
    const result = getAuthMethods({});
    assert.equal(result.github, false);
  });

  it('local is always true', () => {
    assert.equal(getAuthMethods({}).local, true);
    assert.equal(getAuthMethods({ GOOGLE_CLIENT_ID: 'x' }).local, true);
  });
});

/* ------------------------------------------------------------------ */
/*  Password validation                                                */
/* ------------------------------------------------------------------ */
describe('bcrypt password validation', () => {
  it('compareSync returns true for correct password', () => {
    const hash = bcrypt.hashSync('correct-password', 10);
    assert.equal(bcrypt.compareSync('correct-password', hash), true);
  });

  it('compareSync returns false for wrong password', () => {
    const hash = bcrypt.hashSync('correct-password', 10);
    assert.equal(bcrypt.compareSync('wrong-password', hash), false);
  });

  it('compareSync returns false for empty password', () => {
    const hash = bcrypt.hashSync('correct-password', 10);
    assert.equal(bcrypt.compareSync('', hash), false);
  });
});

/* ------------------------------------------------------------------ */
/*  Role permission seeding                                            */
/* ------------------------------------------------------------------ */
describe('default role permissions', () => {
  // Validate the seeded role permissions structure
  const ROLES = {
    owner: ['*'],
    admin: ['articles.*', 'sources.*', 'writers.*', 'categories.*', 'media.*', 'voices.*', 'settings.read', 'analytics.*', 'comments.*', 'newsletter.*', 'users.read'],
    editor: ['articles.read', 'articles.create', 'articles.update', 'sources.read', 'writers.read', 'categories.read', 'media.create', 'media.read', 'comments.read', 'comments.moderate', 'analytics.read'],
    viewer: ['articles.read', 'sources.read', 'writers.read', 'categories.read', 'analytics.read', 'comments.read'],
  };

  function checkPermission(userPerms, required) {
    if (userPerms.includes('*')) return true;
    return required.every(p => {
      const [resource] = p.split('.');
      return userPerms.includes(p) || userPerms.includes(`${resource}.*`);
    });
  }

  it('owner can do everything', () => {
    assert.equal(checkPermission(ROLES.owner, ['articles.delete']), true);
    assert.equal(checkPermission(ROLES.owner, ['settings.update']), true);
    assert.equal(checkPermission(ROLES.owner, ['users.create']), true);
  });

  it('admin can manage articles but only read settings', () => {
    assert.equal(checkPermission(ROLES.admin, ['articles.read']), true);
    assert.equal(checkPermission(ROLES.admin, ['articles.create']), true);
    assert.equal(checkPermission(ROLES.admin, ['articles.delete']), true);
    assert.equal(checkPermission(ROLES.admin, ['settings.read']), true);
    assert.equal(checkPermission(ROLES.admin, ['settings.update']), false);
  });

  it('editor can read and create articles but not delete sources', () => {
    assert.equal(checkPermission(ROLES.editor, ['articles.read']), true);
    assert.equal(checkPermission(ROLES.editor, ['articles.create']), true);
    assert.equal(checkPermission(ROLES.editor, ['articles.update']), true);
    assert.equal(checkPermission(ROLES.editor, ['articles.delete']), false);
    assert.equal(checkPermission(ROLES.editor, ['sources.read']), true);
    assert.equal(checkPermission(ROLES.editor, ['sources.delete']), false);
  });

  it('viewer can only read', () => {
    assert.equal(checkPermission(ROLES.viewer, ['articles.read']), true);
    assert.equal(checkPermission(ROLES.viewer, ['articles.create']), false);
    assert.equal(checkPermission(ROLES.viewer, ['sources.read']), true);
    assert.equal(checkPermission(ROLES.viewer, ['sources.create']), false);
    assert.equal(checkPermission(ROLES.viewer, ['settings.read']), false);
  });

  it('editor can moderate comments but viewer cannot', () => {
    assert.equal(checkPermission(ROLES.editor, ['comments.moderate']), true);
    assert.equal(checkPermission(ROLES.viewer, ['comments.moderate']), false);
  });
});
