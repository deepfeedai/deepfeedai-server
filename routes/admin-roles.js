/**
 * Deep Feed AI Admin — routes/admin-roles.js
 * CRUD for roles (tenant-scoped).
 */
const router              = require('express').Router();
const db                  = require('../db');
const { asyncHandler }    = require('../lib/utils');
const { auth }            = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAudit }        = require('../middleware/audit');
const { validate, roleCreate, roleUpdate } = require('../lib/schemas');

// GET / — list roles
router.get('/', auth, requirePermission('roles.read'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || req.user.tenantId || 1;
  const roles = await db.prepare(
    'SELECT * FROM roles WHERE tenant_id = $1 ORDER BY is_system DESC, name'
  ).all(tenantId);
  res.json(roles);
}));

// POST / — create custom role (owner only)
router.post('/', auth, requirePermission('roles.create'), asyncHandler(async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can create roles' });

  const body = validate(roleCreate, req.body, res);
  if (!body) return;

  const tenantId = req.tenantId || req.user.tenantId || 1;
  const role = await db.prepare(
    'INSERT INTO roles (tenant_id, name, description, permissions, is_system) VALUES ($1, $2, $3, $4, false) RETURNING *'
  ).get(tenantId, body.name, body.description || null, JSON.stringify(body.permissions));

  await logAudit(req, 'roles.create', 'roles', role.id, { name: body.name });

  res.status(201).json(role);
}));

// PUT /:id — update role
router.put('/:id', auth, requirePermission('roles.update'), asyncHandler(async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can update roles' });

  const body = validate(roleUpdate, req.body, res);
  if (!body) return;

  const tenantId = req.tenantId || req.user.tenantId || 1;
  const existing = await db.prepare(
    'SELECT * FROM roles WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, tenantId);
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  if (existing.is_system) return res.status(400).json({ error: 'Cannot modify system roles' });

  const updated = await db.prepare(
    'UPDATE roles SET description = $1, permissions = $2 WHERE id = $3 AND tenant_id = $4 AND is_system = false RETURNING *'
  ).get(
    body.description !== undefined ? body.description : existing.description,
    body.permissions ? JSON.stringify(body.permissions) : existing.permissions,
    req.params.id,
    tenantId
  );

  await logAudit(req, 'roles.update', 'roles', parseInt(req.params.id), body);

  res.json(updated);
}));

// DELETE /:id — delete role
router.delete('/:id', auth, requirePermission('roles.delete'), asyncHandler(async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can delete roles' });

  const tenantId = req.tenantId || req.user.tenantId || 1;
  const existing = await db.prepare(
    'SELECT * FROM roles WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, tenantId);
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  if (existing.is_system) return res.status(400).json({ error: 'Cannot delete system roles' });

  // Check no users assigned to this role
  const userCount = await db.prepare(
    'SELECT COUNT(*) AS cnt FROM users WHERE tenant_id = $1 AND role = $2'
  ).get(tenantId, existing.name);
  if (parseInt(userCount.cnt) > 0) {
    return res.status(400).json({ error: `Cannot delete role "${existing.name}" — ${userCount.cnt} user(s) still assigned` });
  }

  await db.prepare(
    'DELETE FROM roles WHERE id = $1 AND tenant_id = $2 AND is_system = false'
  ).run(req.params.id, tenantId);

  await logAudit(req, 'roles.delete', 'roles', parseInt(req.params.id), { name: existing.name });

  res.json({ message: 'Role deleted' });
}));

module.exports = router;
