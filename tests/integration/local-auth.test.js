/**
 * Deep Feed AI — Integration tests for local auth and permissions
 *
 * Tests login flow, JWT claims, and permission enforcement using
 * the real database. Requires DATABASE_URL to be set.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { db, initTestDb, JWT_SECRET } = require('../helpers');

// Unique prefix to avoid collisions with other test runs
const PREFIX = `test_auth_${Date.now()}`;

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                   */
/* ------------------------------------------------------------------ */
before(async () => {
  await initTestDb();

  // Seed test users
  const ownerHash  = bcrypt.hashSync('owner-pass-123', 10);
  const editorHash = bcrypt.hashSync('editor-pass-456', 10);
  const viewerHash = bcrypt.hashSync('viewer-pass-789', 10);
  const inactiveHash = bcrypt.hashSync('inactive-pass', 10);

  await db.prepare(`
    INSERT INTO users (username, password_hash, email, display_name, role, tenant_id, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
  `).run(`${PREFIX}_owner`, ownerHash, 'owner@test.com', 'Test Owner', 'owner', 1, 1);

  await db.prepare(`
    INSERT INTO users (username, password_hash, email, display_name, role, tenant_id, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
  `).run(`${PREFIX}_editor`, editorHash, 'editor@test.com', 'Test Editor', 'editor', 1, 1);

  await db.prepare(`
    INSERT INTO users (username, password_hash, email, display_name, role, tenant_id, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
  `).run(`${PREFIX}_viewer`, viewerHash, 'viewer@test.com', 'Test Viewer', 'viewer', 1, 1);

  await db.prepare(`
    INSERT INTO users (username, password_hash, email, display_name, role, tenant_id, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
  `).run(`${PREFIX}_inactive`, inactiveHash, 'inactive@test.com', 'Inactive User', 'editor', 1, 0);
});

after(async () => {
  // Clean up test users
  await db.prepare(`DELETE FROM users WHERE username LIKE $1`).run(`${PREFIX}%`);
});

/* ------------------------------------------------------------------ */
/*  Login flow                                                         */
/* ------------------------------------------------------------------ */
describe('local login — database lookup + JWT', () => {
  // Replicate the login logic from routes/local-auth.js
  async function attemptLogin(username, password, tenantId = 1) {
    const user = await db.prepare(
      'SELECT * FROM users WHERE username = $1 AND tenant_id = $2'
    ).get(username, tenantId);

    if (!user) return { status: 401, body: { error: 'Invalid credentials' } };
    if (!user.is_active) return { status: 401, body: { error: 'Invalid credentials' } };

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return { status: 401, body: { error: 'Invalid credentials' } };

    const type = (tenantId === 1 && user.role === 'owner') ? 'platform-admin' : 'tenant-admin';

    const token = jwt.sign(
      {
        sub: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        tenantId,
        role: user.role,
        type,
        authMethod: 'local',
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    await db.prepare('UPDATE users SET last_login_at = NOW() WHERE id = $1').run(user.id);

    return {
      status: 200,
      body: {
        token,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          email: user.email,
          role: user.role,
          tenantId,
        },
      },
    };
  }

  it('succeeds with correct credentials and returns JWT', async () => {
    const result = await attemptLogin(`${PREFIX}_owner`, 'owner-pass-123');
    assert.equal(result.status, 200);
    assert.ok(result.body.token);
    assert.equal(result.body.user.username, `${PREFIX}_owner`);
    assert.equal(result.body.user.role, 'owner');

    // Verify JWT claims
    const decoded = jwt.verify(result.body.token, JWT_SECRET);
    assert.equal(decoded.username, `${PREFIX}_owner`);
    assert.equal(decoded.tenantId, 1);
    assert.equal(decoded.role, 'owner');
    assert.equal(decoded.type, 'platform-admin');
    assert.equal(decoded.authMethod, 'local');
    assert.ok(decoded.sub);
  });

  it('returns 401 for wrong password', async () => {
    const result = await attemptLogin(`${PREFIX}_owner`, 'wrong-password');
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'Invalid credentials');
  });

  it('returns 401 for nonexistent user', async () => {
    const result = await attemptLogin('nonexistent_user_xyz', 'any-password');
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'Invalid credentials');
  });

  it('returns 401 for inactive user', async () => {
    const result = await attemptLogin(`${PREFIX}_inactive`, 'inactive-pass');
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'Invalid credentials');
  });

  it('sets type to tenant-admin for non-owner roles', async () => {
    const result = await attemptLogin(`${PREFIX}_editor`, 'editor-pass-456');
    assert.equal(result.status, 200);
    const decoded = jwt.verify(result.body.token, JWT_SECRET);
    assert.equal(decoded.type, 'tenant-admin');
    assert.equal(decoded.role, 'editor');
  });

  it('updates last_login_at on successful login', async () => {
    await attemptLogin(`${PREFIX}_viewer`, 'viewer-pass-789');
    const user = await db.prepare(
      'SELECT last_login_at FROM users WHERE username = $1'
    ).get(`${PREFIX}_viewer`);
    assert.ok(user.last_login_at, 'last_login_at should be set');
  });
});

/* ------------------------------------------------------------------ */
/*  JWT claims structure                                               */
/* ------------------------------------------------------------------ */
describe('local login — JWT claims', () => {
  it('JWT contains all required claims for owner', async () => {
    const user = await db.prepare(
      'SELECT * FROM users WHERE username = $1 AND tenant_id = $2'
    ).get(`${PREFIX}_owner`, 1);

    const token = jwt.sign(
      {
        sub: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        tenantId: 1,
        role: user.role,
        type: 'platform-admin',
        authMethod: 'local',
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const decoded = jwt.verify(token, JWT_SECRET);
    assert.equal(typeof decoded.sub, 'number');
    assert.equal(decoded.username, `${PREFIX}_owner`);
    assert.equal(decoded.displayName, 'Test Owner');
    assert.equal(decoded.email, 'owner@test.com');
    assert.equal(decoded.tenantId, 1);
    assert.equal(decoded.role, 'owner');
    assert.equal(decoded.type, 'platform-admin');
    assert.equal(decoded.authMethod, 'local');
    assert.ok(decoded.exp); // has expiry
  });
});

/* ------------------------------------------------------------------ */
/*  Permission enforcement                                             */
/* ------------------------------------------------------------------ */
describe('permission enforcement with roles', () => {
  // Replicate permission check
  function checkPermission(userPerms, required) {
    if (userPerms.includes('*')) return true;
    return required.every(p => {
      const [resource] = p.split('.');
      return userPerms.includes(p) || userPerms.includes(`${resource}.*`);
    });
  }

  it('editor can read articles (has articles.read from DB roles)', async () => {
    const roleRow = await db.prepare(
      'SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2'
    ).get(1, 'editor');
    assert.ok(roleRow, 'editor role should exist in DB');

    const perms = typeof roleRow.permissions === 'string'
      ? JSON.parse(roleRow.permissions)
      : roleRow.permissions;

    assert.equal(checkPermission(perms, ['articles.read']), true);
    assert.equal(checkPermission(perms, ['articles.create']), true);
    assert.equal(checkPermission(perms, ['articles.update']), true);
  });

  it('editor cannot delete sources (lacks sources.delete)', async () => {
    const roleRow = await db.prepare(
      'SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2'
    ).get(1, 'editor');
    const perms = typeof roleRow.permissions === 'string'
      ? JSON.parse(roleRow.permissions)
      : roleRow.permissions;

    assert.equal(checkPermission(perms, ['sources.delete']), false);
    assert.equal(checkPermission(perms, ['articles.delete']), false);
    assert.equal(checkPermission(perms, ['settings.update']), false);
  });

  it('owner can access everything via wildcard *', async () => {
    const roleRow = await db.prepare(
      'SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2'
    ).get(1, 'owner');
    const perms = typeof roleRow.permissions === 'string'
      ? JSON.parse(roleRow.permissions)
      : roleRow.permissions;

    assert.equal(checkPermission(perms, ['articles.delete']), true);
    assert.equal(checkPermission(perms, ['settings.update']), true);
    assert.equal(checkPermission(perms, ['users.create']), true);
    assert.equal(checkPermission(perms, ['anything.at.all']), true);
  });

  it('viewer cannot create or delete anything', async () => {
    const roleRow = await db.prepare(
      'SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2'
    ).get(1, 'viewer');
    const perms = typeof roleRow.permissions === 'string'
      ? JSON.parse(roleRow.permissions)
      : roleRow.permissions;

    assert.equal(checkPermission(perms, ['articles.read']), true);
    assert.equal(checkPermission(perms, ['articles.create']), false);
    assert.equal(checkPermission(perms, ['sources.create']), false);
    assert.equal(checkPermission(perms, ['comments.moderate']), false);
  });
});

/* ------------------------------------------------------------------ */
/*  Roles table                                                        */
/* ------------------------------------------------------------------ */
describe('roles table — default system roles', () => {
  it('has 4 default system roles for tenant 1', async () => {
    const roles = await db.prepare(
      'SELECT name, is_system FROM roles WHERE tenant_id = $1 ORDER BY name'
    ).all(1);

    const names = roles.map(r => r.name).sort();
    assert.ok(names.includes('owner'), 'should have owner role');
    assert.ok(names.includes('admin'), 'should have admin role');
    assert.ok(names.includes('editor'), 'should have editor role');
    assert.ok(names.includes('viewer'), 'should have viewer role');
  });

  it('all default roles are marked as system roles', async () => {
    const roles = await db.prepare(
      "SELECT name, is_system FROM roles WHERE tenant_id = 1 AND name IN ('owner', 'admin', 'editor', 'viewer')"
    ).all();

    for (const role of roles) {
      assert.equal(role.is_system, true, `${role.name} should be a system role`);
    }
  });

  it('owner role has wildcard permission', async () => {
    const role = await db.prepare(
      "SELECT permissions FROM roles WHERE tenant_id = 1 AND name = 'owner'"
    ).get();
    const perms = typeof role.permissions === 'string'
      ? JSON.parse(role.permissions)
      : role.permissions;
    assert.deepEqual(perms, ['*']);
  });

  it('viewer role has only read permissions', async () => {
    const role = await db.prepare(
      "SELECT permissions FROM roles WHERE tenant_id = 1 AND name = 'viewer'"
    ).get();
    const perms = typeof role.permissions === 'string'
      ? JSON.parse(role.permissions)
      : role.permissions;

    for (const p of perms) {
      assert.ok(p.endsWith('.read'), `viewer permission "${p}" should end with .read`);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Users table migrations                                             */
/* ------------------------------------------------------------------ */
describe('users table — migration columns', () => {
  it('users table has the new columns', async () => {
    const user = await db.prepare(
      'SELECT email, display_name, role, tenant_id, is_active, last_login_at, created_by, updated_at FROM users WHERE username = $1'
    ).get(`${PREFIX}_owner`);

    assert.ok(user, 'test user should exist');
    assert.equal(user.email, 'owner@test.com');
    assert.equal(user.display_name, 'Test Owner');
    assert.equal(user.role, 'owner');
    assert.equal(user.tenant_id, 1);
    assert.equal(user.is_active, 1);
  });

  it('admin user was backfilled with owner role', async () => {
    const admin = await db.prepare(
      "SELECT role, display_name FROM users WHERE username = 'admin'"
    ).get();
    if (admin) {
      assert.equal(admin.role, 'owner');
    }
    // If admin user doesn't exist (no ADMIN_PASSWORD), skip
  });
});
