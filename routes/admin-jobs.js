/**
 * Deep Feed AI Admin — routes/admin-jobs.js
 * Admin API for the job queue: visibility, retry, cancel, pause.
 */
'use strict';

const router = require('express').Router();
const { getPool } = require('../db');
const db = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAudit } = require('../middleware/audit');
const { bustAppConfigCache } = require('../lib/app-config');
const { enqueueJob } = require('../lib/jobs/queue');
const { JOB_TYPE, CATEGORY_MAP } = require('../lib/jobs/constants');

// Job types allowed for manual admin enqueue (maintenance/utility only)
const ENQUEUEABLE_TYPES = new Set([
  'backfill_tags', 'backfill_embeddings',
  'maintenance_purge', 'maintenance_vacuum',
  'generate_embedding', 'ingest_external',
]);

// GET / — queue status summary + recent failed/active jobs
router.get('/', auth, requirePermission('cron.read'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;

  // Status counts
  const counts = await getPool().query(`
    SELECT status, COUNT(*)::int AS cnt
    FROM jobs
    WHERE tenant_id = $1
    GROUP BY status
  `, [tenantId]);

  const byStatus = {};
  for (const row of counts.rows) byStatus[row.status] = row.cnt;

  // Done count in last 24h
  const doneRecent = await getPool().query(`
    SELECT COUNT(*)::int AS cnt FROM jobs
    WHERE tenant_id = $1 AND status = 'done' AND finished_at > NOW() - INTERVAL '24 hours'
  `, [tenantId]);

  // Recent active + failed jobs (last 50, newest first)
  const jobs = await getPool().query(`
    SELECT id, job_type, category, priority, status,
           payload, error_message, last_error,
           attempts, max_attempts,
           scheduled_at, run_at, finished_at, created_at,
           idempotency_key
    FROM jobs
    WHERE tenant_id = $1
      AND status IN ('pending', 'running', 'failed')
    ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      created_at DESC
    LIMIT 50
  `, [tenantId]);

  // Recent completed/cancelled jobs for history view
  let history = [];
  if (req.query.history === 'true') {
    const histRes = await getPool().query(`
      SELECT id, job_type, category, status,
             attempts, error_message, result,
             run_at, finished_at, created_at,
             EXTRACT(EPOCH FROM (finished_at - run_at)) * 1000 AS duration_ms
      FROM jobs
      WHERE tenant_id = $1
        AND status IN ('done', 'cancelled')
        AND finished_at > NOW() - INTERVAL '24 hours'
      ORDER BY finished_at DESC
      LIMIT 100
    `, [tenantId]);
    history = histRes.rows;
  }

  // Queue paused state
  let pausedRow = null;
  try {
    pausedRow = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'queue_paused'"
    ).get(tenantId);
  } catch { /* default: not paused */ }

  res.json({
    summary: {
      pending:    byStatus.pending    || 0,
      running:    byStatus.running    || 0,
      failed:     byStatus.failed     || 0,
      done:       byStatus.done       || 0,
      cancelled:  byStatus.cancelled  || 0,
      doneRecent: doneRecent.rows[0]?.cnt || 0,
    },
    paused:  pausedRow?.value === '1',
    jobs:    jobs.rows,
    history: history,
  });
}));

// PUT /pause — toggle queue_paused for this tenant
router.put('/pause', auth, requirePermission('cron.update'), asyncHandler(async (req, res) => {
  const { paused } = req.body;
  if (paused === undefined) return res.status(400).json({ error: 'paused required' });

  const val = paused ? '1' : '0';
  await db.prepare(
    "INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3"
  ).run(req.tenantId, 'queue_paused', val);

  bustAppConfigCache(req.tenantId);
  await logAudit(req, 'jobs.pause', 'jobs', null, { paused });

  res.json({ success: true, paused });
}));

// POST /:id/retry — reset a failed job back to pending
router.post('/:id/retry', auth, requirePermission('cron.execute'), asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  if (!jobId) return res.status(400).json({ error: 'invalid job id' });

  const result = await getPool().query(`
    UPDATE jobs SET
      status       = 'pending',
      attempts     = GREATEST(0, attempts - 1),
      last_error   = NULL,
      run_at       = NULL,
      finished_at  = NULL,
      scheduled_at = NOW(),
      updated_at   = NOW()
    WHERE id = $1 AND tenant_id = $2 AND status = 'failed'
    RETURNING id, job_type, status
  `, [jobId, req.tenantId]);

  if (!result.rowCount) {
    return res.status(404).json({ error: 'Job not found or not in failed state' });
  }

  await logAudit(req, 'jobs.retry', 'jobs', jobId, { job_type: result.rows[0].job_type });
  res.json({ success: true, job: result.rows[0] });
}));

// DELETE /:id — cancel a pending or running job
router.delete('/:id', auth, requirePermission('cron.update'), asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  if (!jobId) return res.status(400).json({ error: 'invalid job id' });

  const result = await getPool().query(`
    UPDATE jobs SET
      status      = 'cancelled',
      finished_at = NOW(),
      updated_at  = NOW()
    WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'running')
    RETURNING id, job_type, status
  `, [jobId, req.tenantId]);

  if (!result.rowCount) {
    return res.status(404).json({ error: 'Job not found or not cancellable' });
  }

  await logAudit(req, 'jobs.cancel', 'jobs', jobId, { job_type: result.rows[0].job_type });
  res.json({ success: true, job: result.rows[0] });
}));

// GET /types — list enqueueable job types for the UI
router.get('/types', auth, requirePermission('cron.execute'), asyncHandler(async (req, res) => {
  res.json({
    types: [...ENQUEUEABLE_TYPES].map(t => ({ type: t, category: CATEGORY_MAP[t] })),
  });
}));

// POST /enqueue — manually enqueue a job (maintenance/utility types only)
router.post('/enqueue', auth, requirePermission('cron.execute'), asyncHandler(async (req, res) => {
  const { type, payload = {} } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  if (!ENQUEUEABLE_TYPES.has(type)) {
    return res.status(400).json({ error: `Type "${type}" cannot be manually enqueued` });
  }

  const { job, created } = await enqueueJob({
    tenantId: req.tenantId,
    type,
    payload,
    createdBy: req.user?.id ?? null,
  });

  await logAudit(req, 'jobs.enqueue', 'jobs', job.id, { type, created });
  res.json({ success: true, job, created });
}));

module.exports = router;
