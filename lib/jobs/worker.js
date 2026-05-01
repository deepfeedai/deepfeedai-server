'use strict';

const { getPool } = require('../../db');
const { completeJob, failJob } = require('./queue');
const { MAX_CONCURRENT_PER_TENANT } = require('./constants');

/**
 * Claim the next available pending job across all tenants.
 * Safe for multi-instance deployments — uses FOR UPDATE SKIP LOCKED.
 * Enforces per-tenant concurrency cap and respects queue_paused setting.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.types]    - restrict to specific job types
 * @param {number}   [opts.tenantId] - restrict to one tenant
 * @returns {Promise<object|null>}   - claimed job row, or null if nothing available
 */
async function pollJob(opts = {}) {
  const { types, tenantId } = opts;

  const conditions = [];
  const params = [MAX_CONCURRENT_PER_TENANT];

  if (types?.length) {
    params.push(types);
    conditions.push(`j.job_type = ANY($${params.length}::text[])`);
  }
  if (tenantId) {
    params.push(tenantId);
    conditions.push(`j.tenant_id = $${params.length}`);
  }

  const extraWhere = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const result = await getPool().query(`
    WITH candidate AS (
      SELECT j.id
      FROM jobs j
      WHERE j.status = 'pending'
        AND j.scheduled_at <= NOW()
        ${extraWhere}
        AND (
          SELECT COUNT(*) FROM jobs r
          WHERE r.tenant_id = j.tenant_id AND r.status = 'running'
        ) < $1
        AND NOT EXISTS (
          SELECT 1 FROM settings s
          WHERE s.tenant_id = j.tenant_id
            AND s.key = 'queue_paused'
            AND s.value = '1'
        )
      ORDER BY j.priority ASC, j.scheduled_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs SET
      status     = 'running',
      run_at     = NOW(),
      updated_at = NOW()
    FROM candidate
    WHERE jobs.id = candidate.id
    RETURNING jobs.*
  `, params);

  return result.rows[0] || null;
}

/**
 * Recover jobs stuck in 'running' past their stale_after_minutes threshold.
 * - If attempts < max_attempts: reset to 'pending' with exponential backoff delay
 * - If exhausted: mark 'failed'
 *
 * Safe to call concurrently from multiple instances — the UPDATE is atomic.
 */
async function recoverStaleJobs() {
  const result = await getPool().query(`
    UPDATE jobs SET
      status        = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
      last_error    = 'Job exceeded stale_after_minutes without completing',
      error_message = CASE
        WHEN attempts >= max_attempts THEN 'Max retries exceeded after stale recovery'
        ELSE error_message
      END,
      run_at        = NULL,
      scheduled_at  = CASE
        WHEN attempts < max_attempts THEN
          NOW() + make_interval(secs =>
            LEAST(3600, 30 * POWER(4, LEAST(attempts, 4))::int + FLOOR(RANDOM() * 30)::int)
          )
        ELSE scheduled_at
      END,
      finished_at   = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END,
      updated_at    = NOW()
    WHERE status = 'running'
      AND run_at < NOW() - make_interval(mins => stale_after_minutes)
    RETURNING id, tenant_id, job_type, status, attempts, max_attempts
  `);

  if (result.rowCount > 0) {
    const summary = result.rows.map(r =>
      `#${r.id} ${r.job_type} t=${r.tenant_id} → ${r.status} (${r.attempts}/${r.max_attempts})`
    ).join(', ');
    console.warn(`[jobs] Recovered ${result.rowCount} stale jobs: ${summary}`);
  }

  return result.rows;
}

/**
 * Purge completed/cancelled jobs older than retentionDays,
 * and failed jobs older than failedRetentionDays.
 */
async function purgeOldJobs({ retentionDays = 7, failedRetentionDays = 30 } = {}) {
  const [r1, r2] = await Promise.all([
    getPool().query(`
      DELETE FROM jobs
      WHERE status IN ('done', 'cancelled')
        AND finished_at < NOW() - make_interval(days => $1)
    `, [retentionDays]),
    getPool().query(`
      DELETE FROM jobs
      WHERE status = 'failed'
        AND finished_at < NOW() - make_interval(days => $1)
    `, [failedRetentionDays]),
  ]);
  return { purged_done: r1.rowCount, purged_failed: r2.rowCount };
}

/**
 * Poll for one job and execute it via the executor dispatch table.
 * Called by the worker cron. Returns a summary object.
 */
async function pollAndExecute(opts = {}) {
  const job = await pollJob(opts);
  if (!job) return { found: false };

  const { executeJob } = require('./executor');
  const label = `job #${job.id} ${job.job_type} t=${job.tenant_id}`;

  try {
    console.log(`[jobs] Starting ${label}`);
    const result = await executeJob(job);
    await completeJob({ jobId: job.id, tenantId: job.tenant_id, result });
    console.log(`[jobs] Completed ${label}`);
    return { found: true, jobId: job.id, type: job.job_type, status: 'done' };
  } catch (err) {
    console.error(`[jobs] Failed ${label}:`, err.message);
    await failJob({
      jobId:        job.id,
      tenantId:     job.tenant_id,
      errorMessage: err.message,
      errorStack:   err.stack,
      attempts:     job.attempts,
      maxAttempts:  job.max_attempts,
    });
    return { found: true, jobId: job.id, type: job.job_type, status: 'failed', error: err.message };
  }
}

module.exports = { pollJob, pollAndExecute, recoverStaleJobs, purgeOldJobs };
