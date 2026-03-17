/**
 * Deep Feed AI Admin — routes/admin-audit.js
 * Query and manage the audit log.
 */
const router              = require('express').Router();
const db                  = require('../db');
const { asyncHandler }    = require('../lib/utils');
const { auth }            = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAudit }        = require('../middleware/audit');

// GET / — query audit log with filters
router.get('/', auth, requirePermission('audit.read', 'analytics.read'), asyncHandler(async (req, res) => {
  const { action, resource, user_id: userId, search, from, to } = req.query;
  const page  = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = (page - 1) * limit;

  let where = ['tenant_id = $1'];
  let params = [req.tenantId];
  let idx = 2;

  if (action) { where.push(`action LIKE $${idx}`); params.push(action.endsWith('.') ? action + '%' : action); idx++; }
  if (resource) { where.push(`resource = $${idx}`); params.push(resource); idx++; }
  if (userId) { where.push(`user_id = $${idx}`); params.push(parseInt(userId)); idx++; }
  if (search) { where.push(`details::text ILIKE $${idx}`); params.push(`%${search}%`); idx++; }
  if (from) { where.push(`created_at >= $${idx}`); params.push(from); idx++; }
  if (to) { where.push(`created_at <= $${idx}`); params.push(to); idx++; }

  const whereClause = where.join(' AND ');

  const countRow = await db.prepare(
    `SELECT COUNT(*) AS total FROM audit_log WHERE ${whereClause}`
  ).get(...params);
  const total = parseInt(countRow.total);

  const items = await db.prepare(
    `SELECT * FROM audit_log WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`
  ).all(...params, limit, offset);

  res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
}));

// GET /stats — summary stats for dashboard
router.get('/stats', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;

  const totalRow = await db.prepare(
    'SELECT COUNT(*) AS total FROM audit_log WHERE tenant_id = $1'
  ).get(tenantId);

  const todayRow = await db.prepare(
    "SELECT COUNT(*) AS today FROM audit_log WHERE tenant_id = $1 AND created_at >= CURRENT_DATE"
  ).get(tenantId);

  const actionRows = await db.prepare(
    'SELECT action, COUNT(*) AS cnt FROM audit_log WHERE tenant_id = $1 GROUP BY action ORDER BY cnt DESC'
  ).all(tenantId);

  const resourceRows = await db.prepare(
    'SELECT resource, COUNT(*) AS cnt FROM audit_log WHERE tenant_id = $1 AND resource IS NOT NULL GROUP BY resource ORDER BY cnt DESC'
  ).all(tenantId);

  const byAction = {};
  for (const r of actionRows) byAction[r.action] = parseInt(r.cnt);

  const byResource = {};
  for (const r of resourceRows) byResource[r.resource] = parseInt(r.cnt);

  res.json({
    total: parseInt(totalRow.total),
    today: parseInt(todayRow.today),
    byAction,
    byResource,
  });
}));

// DELETE /archive — clear old entries (owner only)
router.delete('/archive', auth, asyncHandler(async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can archive audit logs' });
  }

  const olderThanDays = parseInt(req.body?.olderThanDays);
  if (!olderThanDays || olderThanDays < 30) {
    return res.status(400).json({ error: 'olderThanDays is required (minimum 30)' });
  }

  const result = await db.getPool().query(
    `DELETE FROM audit_log WHERE tenant_id = $1 AND created_at < NOW() - ($2 || ' days')::INTERVAL`,
    [req.tenantId, olderThanDays]
  );
  const deleted = result.rowCount;

  await logAudit(req, 'audit.archive', 'audit_log', null, { olderThanDays, deleted });

  res.json({ deleted });
}));

module.exports = router;
