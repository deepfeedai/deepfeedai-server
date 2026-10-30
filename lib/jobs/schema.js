'use strict';
// Additive initialization, shared by fresh installs and existing deployments.
async function initJobSchema(p) {
  await p.query(`CREATE TABLE IF NOT EXISTS jobs (
    id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL, job_type TEXT NOT NULL,
    category TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 30,
    payload JSONB NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), stale_after_minutes INTEGER NOT NULL DEFAULT 15,
    parent_job_id INTEGER, idempotency_key TEXT, created_by INTEGER,
    run_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, result JSONB,
    last_error TEXT, error_message TEXT, error_stack TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idempotency ON jobs(tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(priority,scheduled_at) WHERE status='pending'`);
  await p.query(`CREATE INDEX IF NOT EXISTS jobs_tenant_status ON jobs(tenant_id,status)`);
}
module.exports = {initJobSchema};
