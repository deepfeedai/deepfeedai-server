/**
 * Deep Feed AI — /api/orchestrator
 * Pipeline management endpoints for the newsroom orchestration layer.
 */
const express  = require('express');
const router   = express.Router();
const { getPool } = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  runOrchestrator,
  runScoutPass,
  advanceRun,
  approveRun,
  rejectRun,
  STAGE,
} = require('../lib/orchestrator');

router.use(auth);

// ── GET /api/orchestrator/runs ────────────────────────────────────────────────
// List pipeline runs with optional status filter
router.get('/runs', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const tid  = req.tenantId;

  const { status, limit = 50, offset = 0 } = req.query;

  let query = `
    SELECT
      pr.*,
      w.name  AS writer_name,
      a.title AS article_title,
      a.slug  AS article_slug,
      a.is_published AS article_published
    FROM pipeline_runs pr
    LEFT JOIN writers  w ON w.id  = pr.writer_id
    LEFT JOIN articles a ON a.id  = pr.article_id
    WHERE pr.tenant_id = $1
  `;
  const params = [tid];

  if (status) {
    params.push(status);
    query += ` AND pr.status = $${params.length}`;
  }

  query += ` ORDER BY pr.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(Number(limit), Number(offset));

  const [runsResult, countResult] = await Promise.all([
    pool.query(query, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE tenant_id = $1${status ? ' AND status = $2' : ''}`,
      status ? [tid, status] : [tid]
    ),
  ]);

  res.json({
    runs: runsResult.rows.map(formatRun),
    total: countResult.rows[0].total,
  });
}));

// ── GET /api/orchestrator/runs/:id ────────────────────────────────────────────
router.get('/runs/:id', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const tid  = req.tenantId;

  const result = await pool.query(`
    SELECT
      pr.*,
      w.name AS writer_name, w.avatar_url AS writer_avatar,
      a.title AS article_title, a.slug AS article_slug,
      a.is_published AS article_published, a.status AS article_status
    FROM pipeline_runs pr
    LEFT JOIN writers  w ON w.id  = pr.writer_id
    LEFT JOIN articles a ON a.id  = pr.article_id
    WHERE pr.id = $1 AND pr.tenant_id = $2
  `, [req.params.id, tid]);

  if (!result.rows.length) return res.status(404).json({ error: 'Run not found' });
  res.json(formatRun(result.rows[0]));
}));

// ── POST /api/orchestrator/trigger ────────────────────────────────────────────
// Manually trigger a full orchestration cycle
router.post('/trigger', requirePermission('articles.write'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const result = await runOrchestrator(tid);
  res.json({ triggered: true, result });
}));

// ── POST /api/orchestrator/scout ─────────────────────────────────────────────
// Run just the scout pass (discover new stories without advancing existing runs)
router.post('/scout', requirePermission('articles.write'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const { lookback_hours } = req.body;
  const created = await runScoutPass(tid, { lookbackHours: lookback_hours || 12 });
  res.json({ scout_created: created });
}));

// ── POST /api/orchestrator/runs/:id/advance ───────────────────────────────────
// Manually advance a single run by one stage (for debugging/testing)
router.post('/runs/:id/advance', requirePermission('articles.write'), asyncHandler(async (req, res) => {
  const result = await advanceRun(Number(req.params.id), req.tenantId);
  res.json(result);
}));

// ── POST /api/orchestrator/runs/:id/approve ───────────────────────────────────
// Approve a paused run (admin overrides the human gate)
router.post('/runs/:id/approve', requirePermission('articles.publish'), asyncHandler(async (req, res) => {
  const { note } = req.body;
  const result = await approveRun(Number(req.params.id), req.tenantId, note);
  res.json(result);
}));

// ── POST /api/orchestrator/runs/:id/reject ────────────────────────────────────
// Reject a paused run and archive any draft article
router.post('/runs/:id/reject', requirePermission('articles.publish'), asyncHandler(async (req, res) => {
  const { note } = req.body;
  const result = await rejectRun(Number(req.params.id), req.tenantId, note);
  res.json(result);
}));

// ── GET /api/orchestrator/stats ───────────────────────────────────────────────
// Summary counts for dashboard widget
router.get('/stats', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const tid  = req.tenantId;

  const result = await pool.query(`
    SELECT
      COUNT(*)                                                      AS total,
      COUNT(*) FILTER (WHERE status = 'paused')                    AS paused,
      COUNT(*) FILTER (WHERE status = 'published')                  AS published,
      COUNT(*) FILTER (WHERE status = 'rejected')                   AS rejected,
      COUNT(*) FILTER (WHERE status = 'error')                      AS errors,
      COUNT(*) FILTER (WHERE status NOT IN
        ('paused','approved','rejected','published','error'))        AS in_progress,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS today
    FROM pipeline_runs
    WHERE tenant_id = $1
  `, [tid]);

  const s = result.rows[0];
  res.json({
    total:       Number(s.total),
    paused:      Number(s.paused),
    published:   Number(s.published),
    rejected:    Number(s.rejected),
    errors:      Number(s.errors),
    in_progress: Number(s.in_progress),
    today:       Number(s.today),
  });
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRun(row) {
  let stageData = null;
  try {
    stageData = typeof row.stage_data === 'string'
      ? JSON.parse(row.stage_data)
      : row.stage_data;
  } catch {}

  let articleIds = [];
  try {
    articleIds = typeof row.article_ids === 'string'
      ? JSON.parse(row.article_ids)
      : (row.article_ids || []);
  } catch {}

  return {
    id:                  row.id,
    status:              row.status,
    stage:               row.stage,
    topic:               row.topic,
    article_ids:         articleIds,
    article_id:          row.article_id || null,
    article_title:       row.article_title || null,
    article_slug:        row.article_slug || null,
    article_published:   row.article_published === 1 || row.article_published === true,
    article_status:      row.article_status || null,
    writer_id:           row.writer_id || null,
    writer_name:         row.writer_name || null,
    writer_avatar:       row.writer_avatar || null,
    human_gate_required: !!(row.human_gate_required),
    human_gate_reason:   row.human_gate_reason || null,
    resume_stage:        row.resume_stage || null,
    error_message:       row.error_message || null,
    stage_data:          stageData,
    created_at:          row.created_at,
    updated_at:          row.updated_at,
    finished_at:         row.finished_at || null,
  };
}

module.exports = router;
