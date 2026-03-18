/**
 * Deep Feed AI Admin — routes/admin-audit.js
 * Query and manage the audit log.
 */
const router              = require('express').Router();
const db                  = require('../db');
const { asyncHandler }    = require('../lib/utils');
const { auth }            = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAudit, auditEmitter } = require('../middleware/audit');

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

// GET /export — CSV export with filters
router.get('/export', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { action, resource, user_id: userId, search, from, to } = req.query;

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
  const items = await db.prepare(
    `SELECT * FROM audit_log WHERE ${whereClause} ORDER BY created_at DESC LIMIT 10000`
  ).all(...params);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);

  // CSV header — sanitize formula-starting characters to prevent CSV injection
  function csvSafe(val) {
    let s = String(val ?? '').replace(/"/g, '""');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // prefix formula chars with single quote
    return s;
  }

  let csv = 'Time,User,Action,Resource,Resource ID,Details,IP Address\n';
  for (const row of items) {
    const time = row.created_at ? new Date(row.created_at).toISOString() : '';
    const details = row.details ? JSON.stringify(row.details).replace(/"/g, '""') : '';
    csv += `"${csvSafe(time)}","${csvSafe(row.user_email)}","${csvSafe(row.action)}","${csvSafe(row.resource)}","${csvSafe(row.resource_id)}","${csvSafe(details)}","${csvSafe(row.ip_address)}"\n`;
  }

  res.send(csv);
}));

// GET /stats — summary stats for dashboard
router.get('/stats', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const period = req.query.period || '7d';
  const periodDays = period === '90d' ? 90 : period === '30d' ? 30 : 7;

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

  // Time-series: events per day for the selected period
  const timeSeriesRows = await db.prepare(
    `SELECT DATE(created_at) AS day, COUNT(*) AS cnt
     FROM audit_log WHERE tenant_id = $1 AND created_at >= NOW() - make_interval(days => $2)
     GROUP BY DATE(created_at) ORDER BY day`
  ).all(tenantId, periodDays);

  // Top users by event count
  const topUserRows = await db.prepare(
    `SELECT user_email, COUNT(*) AS cnt
     FROM audit_log WHERE tenant_id = $1 AND user_email IS NOT NULL AND created_at >= NOW() - make_interval(days => $2)
     GROUP BY user_email ORDER BY cnt DESC LIMIT 10`
  ).all(tenantId, periodDays);

  const byAction = {};
  for (const r of actionRows) byAction[r.action] = parseInt(r.cnt);

  const byResource = {};
  for (const r of resourceRows) byResource[r.resource] = parseInt(r.cnt);

  const timeSeries = timeSeriesRows.map(r => ({ day: r.day, count: parseInt(r.cnt) }));
  const topUsers = topUserRows.map(r => ({ email: r.user_email, count: parseInt(r.cnt) }));

  res.json({
    total: parseInt(totalRow.total),
    today: parseInt(todayRow.today),
    byAction,
    byResource,
    timeSeries,
    topUsers,
    period,
  });
}));

// POST /stream-ticket — issue a short-lived opaque ticket for SSE (avoids JWT in URL)
const crypto = require('crypto');
const _streamTickets = new Map(); // ticket → { tenantId, expires }
router.post('/stream-ticket', auth, requirePermission('audit.read'), (req, res) => {
  const ticket = crypto.randomBytes(32).toString('hex');
  _streamTickets.set(ticket, { tenantId: req.tenantId, expires: Date.now() + 60_000 });
  // Prune expired tickets
  for (const [k, v] of _streamTickets) {
    if (v.expires < Date.now()) _streamTickets.delete(k);
  }
  res.json({ ticket });
});

// GET /stream — SSE live tail (requires stream ticket, not raw JWT)
router.get('/stream', (req, res, next) => {
  const ticket = req.query.ticket;
  if (ticket) {
    const entry = _streamTickets.get(ticket);
    if (entry && entry.expires > Date.now()) {
      _streamTickets.delete(ticket); // one-time use
      req.tenantId = entry.tenantId;
      req._streamAuth = true;
      return next();
    }
    return res.status(401).json({ error: 'Invalid or expired stream ticket' });
  }
  // Fallback: standard auth header (for non-browser clients)
  if (req.headers.authorization) {
    return auth(req, res, () => requirePermission('audit.read')(req, res, next));
  }
  return res.status(401).json({ error: 'Stream ticket or Authorization header required' });
}, (req, res) => {
  const tenantId = req.tenantId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial heartbeat
  res.write(':\n\n');

  const onEntry = (entry) => {
    if (entry.tenant_id !== tenantId) return;
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  auditEmitter.on('entry', onEntry);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':\n\n');
  }, 30000);

  req.on('close', () => {
    auditEmitter.removeListener('entry', onEntry);
    clearInterval(heartbeat);
  });
});

// GET /alerts — suspicious activity detection
router.get('/alerts', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { detectSuspiciousActivity } = require('../lib/audit-alerts');
  const alerts = await detectSuspiciousActivity(req.tenantId);
  res.json({ alerts });
}));

// DELETE /archive — clear old entries (requires audit.delete permission)
router.delete('/archive', auth, requirePermission('audit.delete'), asyncHandler(async (req, res) => {
  const olderThanDays = parseInt(req.body?.olderThanDays);
  if (!olderThanDays || olderThanDays < 30) {
    return res.status(400).json({ error: 'olderThanDays is required (minimum 30)' });
  }

  const result = await db.getPool().query(
    `DELETE FROM audit_log WHERE tenant_id = $1 AND created_at < NOW() - make_interval(days => $2)`,
    [req.tenantId, olderThanDays]
  );
  const deleted = result.rowCount;

  await logAudit(req, 'audit.archive', 'audit_log', null, { olderThanDays, deleted });

  res.json({ deleted });
}));

module.exports = router;
