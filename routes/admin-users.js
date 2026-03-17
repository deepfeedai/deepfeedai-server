/**
 * Deep Feed AI Admin — routes/admin-users.js
 * CRUD for local admin users (tenant-scoped).
 */
const router              = require('express').Router();
const bcrypt              = require('bcryptjs');
const db                  = require('../db');
const { asyncHandler }    = require('../lib/utils');
const { auth }            = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAudit }        = require('../middleware/audit');
const { validate, userCreate, userUpdate, passwordReset, passwordChange } = require('../lib/schemas');

// GET / — list local users for current tenant
router.get('/', auth, requirePermission('users.read'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || req.user.tenantId || 1;
  const users = await db.prepare(
    'SELECT id, username, email, display_name, role, is_active, last_login_at, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at'
  ).all(tenantId);
  res.json(users);
}));

// PUT /me/password — change own password (must be before /:id routes)
router.put('/me/password', auth, asyncHandler(async (req, res) => {
  const body = validate(passwordChange, req.body, res);
  if (!body) return;

  const tenantId = req.tenantId || req.user.tenantId || 1;
  const user = await db.prepare(
    'SELECT id, password_hash FROM users WHERE id = $1 AND tenant_id = $2'
  ).get(req.user.sub, tenantId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const valid = await bcrypt.compare(body.currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = bcrypt.hashSync(body.newPassword, 10);
  await db.prepare(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3'
  ).run(hash, user.id, tenantId);

  await logAudit(req, 'users.change-password', 'users', user.id, {});

  res.json({ message: 'Password changed' });
}));

// GET /:id — get single user (exclude password_hash)
router.get('/:id', auth, requirePermission('users.read'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || req.user.tenantId || 1;
  const user = await db.prepare(
    'SELECT id, username, email, display_name, role, is_active, last_login_at, created_at, created_by, updated_at FROM users WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, tenantId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
}));

// POST / — create local user
router.post('/', auth, requirePermission('users.create'), asyncHandler(async (req, res) => {
  const body = validate(userCreate, req.body, res);
  if (!body) return;

  const tenantId = req.tenantId || req.user.tenantId || 1;
  const { username, password, display_name, email, role } = body;

  // Verify role exists
  const roleRow = await db.prepare(
    'SELECT id FROM roles WHERE tenant_id = $1 AND name = $2'
  ).get(tenantId, role);
  if (!roleRow) return res.status(400).json({ error: `Role "${role}" does not exist` });

  // Hash password
  const password_hash = bcrypt.hashSync(password, 10);

  // Insert
  const user = await db.prepare(
    'INSERT INTO users (username, password_hash, email, display_name, role, tenant_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, username, email, display_name, role, is_active, created_at'
  ).get(username, password_hash, email || null, display_name, role, tenantId, req.user.sub);

  await logAudit(req, 'users.create', 'users', user.id, { username, role });

  res.status(201).json(user);
}));

// PUT /:id — update user (display_name, email, role, is_active)
router.put('/:id', auth, requirePermission('users.update'), asyncHandler(async (req, res) => {
  const body = validate(userUpdate, req.body, res);
  if (!body) return;

  const tenantId = req.tenantId || req.user.tenantId || 1;
  const existing = await db.prepare(
    'SELECT * FROM users WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, tenantId);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  // Cannot change own role to non-owner if you're the last owner
  if (body.role && body.role !== 'owner' && existing.role === 'owner') {
    const ownerCount = await db.prepare(
      "SELECT COUNT(*) AS cnt FROM users WHERE tenant_id = $1 AND role = 'owner' AND is_active = 1"
    ).get(tenantId);
    if (parseInt(ownerCount.cnt) <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last owner role' });
    }
  }

  // Validate role exists if changing
  if (body.role) {
    const roleRow = await db.prepare(
      'SELECT id FROM roles WHERE tenant_id = $1 AND name = $2'
    ).get(tenantId, body.role);
    if (!roleRow) return res.status(400).json({ error: `Role "${body.role}" does not exist` });
  }

  const updated = await db.prepare(
    'UPDATE users SET display_name = $1, email = $2, role = $3, is_active = $4, updated_at = NOW() WHERE id = $5 AND tenant_id = $6 RETURNING id, username, email, display_name, role, is_active, last_login_at, created_at, updated_at'
  ).get(
    body.display_name !== undefined ? body.display_name : existing.display_name,
    body.email !== undefined ? (body.email || null) : existing.email,
    body.role || existing.role,
    body.is_active !== undefined ? body.is_active : existing.is_active,
    req.params.id,
    tenantId
  );

  await logAudit(req, 'users.update', 'users', parseInt(req.params.id), body);

  res.json(updated);
}));

// DELETE /:id/permanent — hard delete user (must be before /:id to avoid param matching)
router.delete('/:id/permanent', auth, requirePermission('users.delete'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || req.user.tenantId || 1;
  const existing = await db.prepare(
    'SELECT * FROM users WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, tenantId);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  // Cannot delete the default admin account
  if (existing.username === 'admin') {
    return res.status(400).json({ error: 'Cannot delete the default admin account' });
  }

  // Cannot delete last active owner
  if (existing.role === 'owner' && existing.is_active) {
    const ownerCount = await db.prepare(
      "SELECT COUNT(*) AS cnt FROM users WHERE tenant_id = $1 AND role = 'owner' AND is_active = 1"
    ).get(tenantId);
    if (parseInt(ownerCount.cnt) <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last owner' });
    }
  }

  const isSelf = existing.id === parseInt(req.user.sub);

  await db.prepare('DELETE FROM users WHERE id = $1 AND tenant_id = $2').run(req.params.id, tenantId);
  await logAudit(req, 'users.delete-permanent', 'users', parseInt(req.params.id), { username: existing.username });

  res.json({ message: 'User permanently deleted', logout: isSelf });
}));

// DELETE /:id — soft deactivate
router.delete('/:id', auth, requirePermission('users.delete'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || req.user.tenantId || 1;
  const existing = await db.prepare(
    'SELECT * FROM users WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, tenantId);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  // Cannot deactivate the default admin account
  if (existing.username === 'admin') {
    return res.status(400).json({ error: 'Cannot deactivate the default admin account' });
  }

  // Cannot deactivate last owner
  if (existing.role === 'owner') {
    const ownerCount = await db.prepare(
      "SELECT COUNT(*) AS cnt FROM users WHERE tenant_id = $1 AND role = 'owner' AND is_active = 1"
    ).get(tenantId);
    if (parseInt(ownerCount.cnt) <= 1) {
      return res.status(400).json({ error: 'Cannot deactivate the last owner' });
    }
  }

  await db.prepare(
    'UPDATE users SET is_active = 0, updated_at = NOW() WHERE id = $1 AND tenant_id = $2'
  ).run(req.params.id, tenantId);

  await logAudit(req, 'users.deactivate', 'users', parseInt(req.params.id), { username: existing.username });

  res.json({ message: 'User deactivated' });
}));

// POST /:id/reset-password — admin resets password
router.post('/:id/reset-password', auth, requirePermission('users.update'), asyncHandler(async (req, res) => {
  const body = validate(passwordReset, req.body, res);
  if (!body) return;

  const tenantId = req.tenantId || req.user.tenantId || 1;
  const existing = await db.prepare(
    'SELECT id, username FROM users WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, tenantId);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const hash = bcrypt.hashSync(body.password, 10);
  await db.prepare(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3'
  ).run(hash, req.params.id, tenantId);

  await logAudit(req, 'users.reset-password', 'users', parseInt(req.params.id), { username: existing.username });

  res.json({ message: 'Password reset' });
}));

module.exports = router;
