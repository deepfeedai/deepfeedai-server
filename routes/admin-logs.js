/**
 * Deep Feed AI Admin — routes/admin-logs.js
 * Unified logging dashboard API: overview, app logs, request logs, errors, cron, AI ops, health.
 */
const router              = require('express').Router();
const crypto              = require('crypto');
const db                  = require('../db');
const { asyncHandler }    = require('../lib/utils');
const { auth }            = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logEmitter }      = require('../lib/logger');

// ── Helpers ─────────────────────────────────────────────────────
function csvSafe(val) {
  let s = String(val ?? '').replace(/"/g, '""');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

const VALID_RANGES = new Set(['1h', '6h', '24h', '7d', '30d', '90d']);

function rangeToInterval(range) {
  const map = { '1h': '1 hour', '6h': '6 hours', '24h': '1 day', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
  return map[range] || '1 day';
}

function timeSeriesBucket(range) {
  // Return appropriate time bucket for grouping
  if (range === '1h' || range === '6h') return 'minute';
  if (range === '24h') return 'hour';
  return 'day';
}

function truncExpr(bucket) {
  if (bucket === 'minute') return "date_trunc('minute', created_at)";
  if (bucket === 'hour') return "date_trunc('hour', created_at)";
  return 'DATE(created_at)';
}

// ── Overview ────────────────────────────────────────────────────
router.get('/overview', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const range = VALID_RANGES.has(req.query.range) ? req.query.range : '24h';
  const interval = rangeToInterval(range);
  const bucket = timeSeriesBucket(range);
  const trunc = truncExpr(bucket);

  const [errorRate, reqVolume, avgDuration, cronActive, aiSuccess, reqChart, errChart] = await Promise.all([
    // Error count in period
    db.prepare(`SELECT COUNT(*) AS cnt FROM app_logs WHERE tenant_id = $1 AND level = 'error' AND created_at >= NOW() - $2::interval`).get(tid, interval),
    // Request volume in period
    db.prepare(`SELECT COUNT(*) AS cnt FROM request_logs WHERE tenant_id = $1 AND created_at >= NOW() - $2::interval`).get(tid, interval),
    // Average response time
    db.prepare(`SELECT COALESCE(AVG(duration_ms), 0)::int AS avg_ms FROM request_logs WHERE tenant_id = $1 AND created_at >= NOW() - $2::interval`).get(tid, interval),
    // Active cron jobs (running right now)
    db.prepare(`SELECT COUNT(*) AS cnt FROM cron_runs WHERE tenant_id = $1 AND status = 'running'`).get(tid),
    // AI success rate
    db.prepare(`SELECT
      COUNT(*) FILTER (WHERE success = true) AS ok,
      COUNT(*) AS total
      FROM ai_usage WHERE tenant_id = $1 AND created_at >= NOW() - $2::interval`).get(tid, interval),
    // Request volume time series
    db.prepare(`SELECT ${trunc} AS t, COUNT(*) AS cnt FROM request_logs WHERE tenant_id = $1 AND created_at >= NOW() - $2::interval GROUP BY t ORDER BY t`).all(tid, interval),
    // Error time series
    db.prepare(`SELECT ${trunc} AS t, COUNT(*) AS cnt FROM app_logs WHERE tenant_id = $1 AND level = 'error' AND created_at >= NOW() - $2::interval GROUP BY t ORDER BY t`).all(tid, interval),
  ]);

  const aiTotal = parseInt(aiSuccess.total) || 0;
  const aiOk = parseInt(aiSuccess.ok) || 0;

  res.json({
    error_count: parseInt(errorRate.cnt),
    request_volume: parseInt(reqVolume.cnt),
    avg_response_ms: parseInt(avgDuration.avg_ms),
    cron_active: parseInt(cronActive.cnt),
    ai_success_rate: aiTotal > 0 ? Math.round(aiOk / aiTotal * 100) : 100,
    ai_total: aiTotal,
    request_chart: reqChart.map(r => ({ time: r.t, count: parseInt(r.cnt) })),
    error_chart: errChart.map(r => ({ time: r.t, count: parseInt(r.cnt) })),
    range,
  });
}));

// ── App Logs ────────────────────────────────────────────────────
router.get('/app', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { level, module: mod, search, correlation_id, from, to } = req.query;
  const page  = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = (page - 1) * limit;

  let where = ['tenant_id = $1'];
  let params = [req.tenantId];
  let idx = 2;

  if (level)          { where.push(`level = $${idx}`); params.push(level); idx++; }
  if (mod)            { where.push(`module = $${idx}`); params.push(mod); idx++; }
  if (search)         { where.push(`message ILIKE $${idx}`); params.push(`%${search}%`); idx++; }
  if (correlation_id) { where.push(`correlation_id = $${idx}`); params.push(correlation_id); idx++; }
  if (from)           { where.push(`created_at >= $${idx}`); params.push(from); idx++; }
  if (to)             { where.push(`created_at <= $${idx}`); params.push(to); idx++; }

  const wc = where.join(' AND ');

  const [countRow, items] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM app_logs WHERE ${wc}`).get(...params),
    db.prepare(`SELECT * FROM app_logs WHERE ${wc} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`).all(...params, limit, offset),
  ]);

  const total = parseInt(countRow.total);
  res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
}));

// GET /app/modules — distinct module names for filter dropdown
router.get('/app/modules', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const rows = await db.prepare(
    'SELECT DISTINCT module FROM app_logs WHERE tenant_id = $1 AND module IS NOT NULL ORDER BY module'
  ).all(req.tenantId);
  res.json({ modules: rows.map(r => r.module) });
}));

// GET /app/export — CSV/JSON export
router.get('/app/export', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { level, module: mod, search, format } = req.query;
  // Default to last 30 days if no date range specified
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to;

  let where = ['tenant_id = $1'];
  let params = [req.tenantId];
  let idx = 2;

  if (level)  { where.push(`level = $${idx}`); params.push(level); idx++; }
  if (mod)    { where.push(`module = $${idx}`); params.push(mod); idx++; }
  if (search) { where.push(`message ILIKE $${idx}`); params.push(`%${search}%`); idx++; }
  where.push(`created_at >= $${idx}`); params.push(from); idx++;
  if (to)     { where.push(`created_at <= $${idx}`); params.push(to); idx++; }

  const wc = where.join(' AND ');
  const items = await db.prepare(
    `SELECT * FROM app_logs WHERE ${wc} ORDER BY created_at DESC LIMIT 50000`
  ).all(...params);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="app-logs-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.json(items);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="app-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
  let csv = 'Time,Level,Module,Message,Correlation ID,Context\n';
  for (const row of items) {
    const time = row.created_at ? new Date(row.created_at).toISOString() : '';
    const ctx = row.context ? JSON.stringify(row.context).replace(/"/g, '""') : '';
    csv += `"${csvSafe(time)}","${csvSafe(row.level)}","${csvSafe(row.module)}","${csvSafe(row.message)}","${csvSafe(row.correlation_id)}","${csvSafe(ctx)}"\n`;
  }
  res.send(csv);
}));

// ── App Log SSE streaming ───────────────────────────────────────
const _logTickets = new Map();

router.post('/app/stream-ticket', auth, requirePermission('audit.read'), (req, res) => {
  const ticket = crypto.randomBytes(32).toString('hex');
  _logTickets.set(ticket, { tenantId: req.tenantId, expires: Date.now() + 60_000 });
  for (const [k, v] of _logTickets) {
    if (v.expires < Date.now()) _logTickets.delete(k);
  }
  res.json({ ticket });
});

router.get('/app/stream', (req, res, next) => {
  const ticket = req.query.ticket;
  if (ticket) {
    const entry = _logTickets.get(ticket);
    if (entry && entry.expires > Date.now()) {
      _logTickets.delete(ticket);
      req.tenantId = entry.tenantId;
      return next();
    }
    return res.status(401).json({ error: 'Invalid or expired stream ticket' });
  }
  if (req.headers.authorization) {
    return auth(req, res, () => requirePermission('audit.read')(req, res, next));
  }
  return res.status(401).json({ error: 'Stream ticket or Authorization required' });
}, (req, res) => {
  const tenantId = req.tenantId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(':\n\n');

  const onLog = (entry) => {
    // Strict tenant isolation: skip entries without a tenant or from other tenants
    if (!entry.tenantId || entry.tenantId !== tenantId) return;
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };
  logEmitter.on('log', onLog);

  const heartbeat = setInterval(() => res.write(':\n\n'), 30000);

  const cleanup = () => {
    logEmitter.removeListener('log', onLog);
    clearInterval(heartbeat);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
});

// ── Request Logs ────────────────────────────────────────────────
router.get('/requests', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { method, status_min, status_max, path: pathFilter, min_duration, from, to } = req.query;
  const page  = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = (page - 1) * limit;

  let where = ['tenant_id = $1'];
  let params = [req.tenantId];
  let idx = 2;

  if (method)       { where.push(`method = $${idx}`); params.push(method); idx++; }
  if (status_min)   { where.push(`status_code >= $${idx}`); params.push(parseInt(status_min)); idx++; }
  if (status_max)   { where.push(`status_code <= $${idx}`); params.push(parseInt(status_max)); idx++; }
  if (pathFilter)   { where.push(`path ILIKE $${idx}`); params.push(`%${pathFilter}%`); idx++; }
  if (min_duration) { where.push(`duration_ms >= $${idx}`); params.push(parseInt(min_duration)); idx++; }
  if (from)         { where.push(`created_at >= $${idx}`); params.push(from); idx++; }
  if (to)           { where.push(`created_at <= $${idx}`); params.push(to); idx++; }

  const wc = where.join(' AND ');

  const [countRow, items, statsRow] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM request_logs WHERE ${wc}`).get(...params),
    db.prepare(`SELECT * FROM request_logs WHERE ${wc} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`).all(...params, limit, offset),
    db.prepare(`SELECT
      COALESCE(AVG(duration_ms), 0)::int AS avg_duration,
      COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS count_4xx,
      COUNT(*) FILTER (WHERE status_code >= 500) AS count_5xx
      FROM request_logs WHERE ${wc}`).get(...params),
  ]);

  const total = parseInt(countRow.total);
  res.json({
    items, total, page, limit, pages: Math.ceil(total / limit),
    stats: {
      avg_duration: parseInt(statsRow.avg_duration),
      count_4xx: parseInt(statsRow.count_4xx),
      count_5xx: parseInt(statsRow.count_5xx),
    },
  });
}));

// GET /requests/distribution — response time buckets
router.get('/requests/distribution', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const interval = rangeToInterval(req.query.range || '24h');

  const rows = await db.prepare(`
    SELECT
      CASE
        WHEN duration_ms < 50 THEN '<50ms'
        WHEN duration_ms < 200 THEN '50-200ms'
        WHEN duration_ms < 500 THEN '200-500ms'
        WHEN duration_ms < 1000 THEN '500ms-1s'
        ELSE '>1s'
      END AS bucket,
      COUNT(*) AS cnt
    FROM request_logs
    WHERE tenant_id = $1 AND created_at >= NOW() - $2::interval
    GROUP BY bucket
    ORDER BY MIN(duration_ms)
  `).all(tid, interval);

  res.json({ buckets: rows.map(r => ({ label: r.bucket, count: parseInt(r.cnt) })) });
}));

// GET /requests/export
router.get('/requests/export', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { method, status_min, status_max, path: pathFilter, format } = req.query;
  const from = req.query.from || new Date(Date.now() - 14 * 86400000).toISOString();
  const to = req.query.to;

  let where = ['tenant_id = $1'];
  let params = [req.tenantId];
  let idx = 2;

  if (method)     { where.push(`method = $${idx}`); params.push(method); idx++; }
  if (status_min) { where.push(`status_code >= $${idx}`); params.push(parseInt(status_min)); idx++; }
  if (status_max) { where.push(`status_code <= $${idx}`); params.push(parseInt(status_max)); idx++; }
  if (pathFilter) { where.push(`path ILIKE $${idx}`); params.push(`%${pathFilter}%`); idx++; }
  where.push(`created_at >= $${idx}`); params.push(from); idx++;
  if (to)         { where.push(`created_at <= $${idx}`); params.push(to); idx++; }

  const wc = where.join(' AND ');
  const items = await db.prepare(
    `SELECT * FROM request_logs WHERE ${wc} ORDER BY created_at DESC LIMIT 50000`
  ).all(...params);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="request-logs-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.json(items);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="request-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
  let csv = 'Time,Method,Path,Status,Duration (ms),IP,User Agent\n';
  for (const row of items) {
    const time = row.created_at ? new Date(row.created_at).toISOString() : '';
    csv += `"${csvSafe(time)}","${csvSafe(row.method)}","${csvSafe(row.path)}","${csvSafe(row.status_code)}","${csvSafe(row.duration_ms)}","${csvSafe(row.ip_address)}","${csvSafe(row.user_agent)}"\n`;
  }
  res.send(csv);
}));

// ── Error Aggregates ────────────────────────────────────────────
router.get('/errors', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { status, module: mod, search } = req.query;
  const page  = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = (page - 1) * limit;

  let where = ['tenant_id = $1'];
  let params = [req.tenantId];
  let idx = 2;

  if (status) { where.push(`status = $${idx}`); params.push(status); idx++; }
  if (mod)    { where.push(`module = $${idx}`); params.push(mod); idx++; }
  if (search) { where.push(`message ILIKE $${idx}`); params.push(`%${search}%`); idx++; }

  const wc = where.join(' AND ');

  const [countRow, items] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM error_aggregates WHERE ${wc}`).get(...params),
    db.prepare(`SELECT * FROM error_aggregates WHERE ${wc} ORDER BY last_seen DESC LIMIT $${idx} OFFSET $${idx + 1}`).all(...params, limit, offset),
  ]);

  const total = parseInt(countRow.total);
  res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
}));

// GET /errors/export — must be before :id routes to avoid param capture
router.get('/errors/export', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { status, module: mod, search, format } = req.query;

  let where = ['tenant_id = $1'];
  let params = [req.tenantId];
  let idx = 2;

  if (status) { where.push(`status = $${idx}`); params.push(status); idx++; }
  if (mod)    { where.push(`module = $${idx}`); params.push(mod); idx++; }
  if (search) { where.push(`message ILIKE $${idx}`); params.push(`%${search}%`); idx++; }

  const wc = where.join(' AND ');
  const items = await db.prepare(
    `SELECT * FROM error_aggregates WHERE ${wc} ORDER BY last_seen DESC LIMIT 50000`
  ).all(...params);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="errors-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.json(items);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="errors-${new Date().toISOString().slice(0, 10)}.csv"`);
  let csv = 'Message,Module,Count,First Seen,Last Seen,Status\n';
  for (const row of items) {
    csv += `"${csvSafe(row.message)}","${csvSafe(row.module)}","${row.count}","${csvSafe(row.first_seen)}","${csvSafe(row.last_seen)}","${csvSafe(row.status)}"\n`;
  }
  res.send(csv);
}));

// PUT /errors/:id/status — update error status
router.put('/errors/:id/status', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['open', 'resolved', 'ignored'].includes(status)) {
    return res.status(400).json({ error: 'Status must be open, resolved, or ignored' });
  }
  await db.prepare('UPDATE error_aggregates SET status = $1 WHERE id = $2 AND tenant_id = $3').run(status, req.params.id, req.tenantId);
  res.json({ success: true });
}));

// GET /errors/:id/trend — 7-day occurrence trend
router.get('/errors/:id/trend', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const errRow = await db.prepare('SELECT error_hash FROM error_aggregates WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!errRow) return res.status(404).json({ error: 'Not found' });

  const rows = await db.prepare(`
    SELECT DATE(created_at) AS day, COUNT(*) AS cnt
    FROM app_logs
    WHERE tenant_id = $1 AND level = 'error'
      AND created_at >= NOW() - INTERVAL '7 days'
      AND message = (SELECT message FROM error_aggregates WHERE id = $2 AND tenant_id = $1)
    GROUP BY DATE(created_at)
    ORDER BY day
  `).all(req.tenantId, req.params.id);

  res.json({ days: rows.map(r => ({ day: r.day, count: parseInt(r.cnt) })) });
}));

// ── Cron Timeline & Duration ────────────────────────────────────
router.get('/cron/timeline', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const interval = rangeToInterval(req.query.range || '24h');

  const rows = await db.prepare(`
    SELECT job_name, started_at, finished_at, status
    FROM cron_runs
    WHERE tenant_id = $1 AND started_at >= NOW() - $2::interval
    ORDER BY started_at
  `).all(tid, interval);

  // Group by job name
  const jobs = {};
  for (const r of rows) {
    if (!jobs[r.job_name]) jobs[r.job_name] = [];
    jobs[r.job_name].push({
      start: r.started_at,
      end: r.finished_at,
      status: r.status,
    });
  }

  res.json({ jobs: Object.entries(jobs).map(([name, runs]) => ({ name, runs })) });
}));

router.get('/cron/duration-trends', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const interval = rangeToInterval(req.query.range || '7d');

  const rows = await db.prepare(`
    SELECT job_name, DATE(started_at) AS day,
      AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::int AS avg_ms
    FROM cron_runs
    WHERE tenant_id = $1 AND status IN ('success', 'error') AND finished_at IS NOT NULL
      AND started_at >= NOW() - $2::interval
    GROUP BY job_name, DATE(started_at)
    ORDER BY day
  `).all(tid, interval);

  const jobs = {};
  for (const r of rows) {
    if (!jobs[r.job_name]) jobs[r.job_name] = [];
    jobs[r.job_name].push({ day: r.day, avg_ms: r.avg_ms });
  }

  res.json({ jobs: Object.entries(jobs).map(([name, data]) => ({ name, data })) });
}));

router.get('/cron/export', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { from, to, format } = req.query;

  let where = ['tenant_id = $1'];
  let params = [req.tenantId];
  let idx = 2;

  if (from) { where.push(`started_at >= $${idx}`); params.push(from); idx++; }
  if (to)   { where.push(`started_at <= $${idx}`); params.push(to); idx++; }

  const wc = where.join(' AND ');
  const items = await db.prepare(
    `SELECT * FROM cron_runs WHERE ${wc} ORDER BY started_at DESC LIMIT 50000`
  ).all(...params);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="cron-logs-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.json(items);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cron-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
  let csv = 'Job,Started At,Finished At,Status,Summary\n';
  for (const row of items) {
    const summary = row.summary ? JSON.stringify(row.summary).replace(/"/g, '""') : '';
    csv += `"${csvSafe(row.job_name)}","${csvSafe(row.started_at)}","${csvSafe(row.finished_at)}","${csvSafe(row.status)}","${csvSafe(summary)}"\n`;
  }
  res.send(csv);
}));

// ── AI Operations ───────────────────────────────────────────────
router.get('/ai/latency', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const interval = rangeToInterval(req.query.range || '7d');

  const rows = await db.prepare(`
    SELECT DATE(created_at) AS day,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS p90,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99
    FROM ai_usage
    WHERE tenant_id = $1 AND duration_ms IS NOT NULL AND created_at >= NOW() - $2::interval
    GROUP BY DATE(created_at)
    ORDER BY day
  `).all(tid, interval);

  res.json({
    data: rows.map(r => ({
      day: r.day,
      p50: Math.round(parseFloat(r.p50) || 0),
      p90: Math.round(parseFloat(r.p90) || 0),
      p99: Math.round(parseFloat(r.p99) || 0),
    })),
  });
}));

router.get('/ai/error-patterns', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;

  const rows = await db.prepare(`
    SELECT error_message, COUNT(*) AS cnt,
      array_agg(DISTINCT operation) AS operations,
      MAX(created_at) AS last_seen
    FROM ai_usage
    WHERE tenant_id = $1 AND success = false AND error_message IS NOT NULL
      AND created_at >= NOW() - INTERVAL '30 days'
    GROUP BY error_message
    ORDER BY cnt DESC
    LIMIT 50
  `).all(tid);

  res.json({
    patterns: rows.map(r => ({
      message: r.error_message,
      count: parseInt(r.cnt),
      operations: r.operations,
      last_seen: r.last_seen,
    })),
  });
}));

// ── Health ──────────────────────────────────────────────────────
router.get('/health', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { getDeploymentHealth } = require('../lib/deployment-health');
  const checks = await getDeploymentHealth(req.tenantId);
  const version = require('../package.json').version;

  res.json({
    checks,
    uptime_seconds: Math.round(process.uptime()),
    server_version: version,
  });
}));

// ── Alerts ──────────────────────────────────────────────────────
router.get('/alerts', auth, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { detectSuspiciousActivity } = require('../lib/audit-alerts');
  const alerts = await detectSuspiciousActivity(req.tenantId);

  // Add error rate spike detection
  try {
    const recent = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM app_logs WHERE tenant_id = $1 AND level = 'error' AND created_at >= NOW() - INTERVAL '15 minutes'`
    ).get(req.tenantId);
    const prior = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM app_logs WHERE tenant_id = $1 AND level = 'error' AND created_at >= NOW() - INTERVAL '30 minutes' AND created_at < NOW() - INTERVAL '15 minutes'`
    ).get(req.tenantId);

    const recentCount = parseInt(recent.cnt);
    const priorCount = parseInt(prior.cnt);
    if (recentCount > 3 && priorCount > 0 && recentCount >= priorCount * 3) {
      alerts.push({
        type: 'error_rate_spike',
        severity: recentCount >= priorCount * 5 ? 'critical' : 'warning',
        message: `Error rate spike: ${recentCount} errors in last 15min (was ${priorCount})`,
        details: { recent: recentCount, prior: priorCount },
      });
    }

    // Cron failure check
    const failedCron = await db.prepare(
      `SELECT DISTINCT job_name FROM cron_runs WHERE tenant_id = $1 AND status = 'error' AND started_at >= NOW() - INTERVAL '30 minutes'`
    ).all(req.tenantId);
    for (const row of failedCron) {
      alerts.push({
        type: 'cron_failure',
        severity: 'warning',
        message: `Cron job "${row.job_name}" failed in the last 30 minutes`,
        details: { job: row.job_name },
      });
    }
  } catch {
    // Non-fatal alert detection
  }

  res.json({ alerts });
}));

module.exports = router;
