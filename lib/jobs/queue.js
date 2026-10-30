'use strict';

const { getPool } = require('../../db');
const { nextRunAt } = require('./backoff');
const {
  CATEGORY_MAP,
  JOB_PRIORITY,
  JOB_MAX_ATTEMPTS,
  JOB_STALE_MINUTES,
} = require('./constants');

/**
 * Enqueue a job. Idempotent when idempotencyKey is provided — a second call
 * with the same (tenantId, idempotencyKey) while the job is pending/running
 * returns the existing job and created=false.
 *
 * @param {object}  opts
 * @param {number}  opts.tenantId
 * @param {string}  opts.type           - JOB_TYPE constant
 * @param {object}  [opts.payload]
 * @param {number}  [opts.priority]     - overrides default
 * @param {Date}    [opts.scheduledAt]  - delay execution until this time
 * @param {string}  [opts.idempotencyKey]
 * @param {number}  [opts.parentJobId]
 * @param {number}  [opts.maxAttempts]  - overrides default
 * @param {number}  [opts.createdBy]    - user id, null for system
 * @returns {Promise<{ job: object, created: boolean }>}
 */
async function enqueueJob(opts) {
  const {
    tenantId,
    type,
    payload        = {},
    priority,
    scheduledAt    = new Date(),
    idempotencyKey = null,
    parentJobId    = null,
    maxAttempts,
    createdBy      = null,
  } = opts;

  if (!tenantId) throw new Error('enqueueJob: tenantId required');
  if (!CATEGORY_MAP[type]) throw new Error(`enqueueJob: unknown job type "${type}"`);

  const effectivePriority    = priority    ?? JOB_PRIORITY[type]    ?? 30;
  const effectiveMaxAttempts = maxAttempts ?? JOB_MAX_ATTEMPTS[type] ?? 3;
  const staleAfterMinutes    = JOB_STALE_MINUTES[type] ?? 15;
  const category             = CATEGORY_MAP[type];

  const result = await getPool().query(`
    INSERT INTO jobs
      (tenant_id, job_type, category, priority,
       payload, status, attempts, max_attempts,
       scheduled_at, stale_after_minutes,
       parent_job_id, idempotency_key, created_by,
       created_at, updated_at)
    VALUES
      ($1, $2, $3, $4,
       $5::jsonb, 'pending', 0, $6,
       $7, $8,
       $9, $10, $11,
       NOW(), NOW())
    ON CONFLICT (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    DO UPDATE SET updated_at = jobs.updated_at
    RETURNING *, (xmax = 0) AS inserted
  `, [
    tenantId, type, category, effectivePriority,
    JSON.stringify(payload), effectiveMaxAttempts,
    scheduledAt, staleAfterMinutes,
    parentJobId, idempotencyKey, createdBy,
  ]);

  const row = result.rows[0];
  return { job: row, created: String(row.inserted) === 'true' || row.inserted === true };
}

/**
 * Mark a job as completed.
 */
async function completeJob({ jobId, tenantId, result = null }) {
  await getPool().query(`
    UPDATE jobs SET
      status      = 'done',
      result      = $3::jsonb,
      finished_at = NOW(),
      updated_at  = NOW()
    WHERE id = $1 AND tenant_id = $2
  `, [jobId, tenantId, result ? JSON.stringify(result) : null]);
}

/**
 * Mark a job as failed. If retries remain, resets to 'pending' with backoff.
 * If exhausted, sets status='failed'.
 *
 * @param {object} opts
 * @param {number} opts.jobId
 * @param {number} opts.tenantId
 * @param {string} opts.errorMessage
 * @param {string} [opts.errorStack]
 * @param {number} opts.attempts    - attempts value on the job row (before this run)
 * @param {number} opts.maxAttempts
 */
async function failJob({ jobId, tenantId, errorMessage, errorStack, attempts, maxAttempts, retryable = true }) {
  const nextAttempts = attempts + 1;
  const exhausted    = !retryable || nextAttempts >= maxAttempts;
  const nextScheduled = exhausted ? null : nextRunAt(nextAttempts);

  await getPool().query(`
    UPDATE jobs SET
      status        = CASE WHEN $3 THEN 'failed' ELSE 'pending' END,
      attempts      = $4,
      last_error    = $5,
      error_message = CASE WHEN $3 THEN $5 ELSE error_message END,
      error_stack   = CASE WHEN $3 THEN $6 ELSE error_stack END,
      scheduled_at  = CASE WHEN $3 THEN scheduled_at ELSE $7 END,
      run_at        = NULL,
      finished_at   = CASE WHEN $3 THEN NOW() ELSE NULL END,
      updated_at    = NOW()
    WHERE id = $1 AND tenant_id = $2
  `, [jobId, tenantId, exhausted, nextAttempts, errorMessage, errorStack ?? null, nextScheduled]);
  return {status:exhausted?'failed':'pending',attempts:nextAttempts};
}

/**
 * Cancel a job (and optionally all its children).
 */
async function cancelJob({ jobId, tenantId, cascade = false }) {
  await getPool().query(`
    UPDATE jobs SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'running')
  `, [jobId, tenantId]);

  if (cascade) {
    await getPool().query(`
      UPDATE jobs SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
      WHERE parent_job_id = $1 AND tenant_id = $2 AND status IN ('pending', 'running')
    `, [jobId, tenantId]);
  }
}

module.exports = { enqueueJob, completeJob, failJob, cancelJob };
