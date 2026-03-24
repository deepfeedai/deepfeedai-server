/**
 * Deep Feed AI Admin — lib/cron-registry.js
 * Registry-based cron job management with logging, settings-based control,
 * and per-tenant execution.
 */
const cron = require('node-cron');
const db = require('../db');
const { getPlatformTenantId } = require('./platform-tenant');

const jobs = new Map(); // name → { definition, task }
const running = new Set(); // names of currently executing jobs

// Definition shape:
// { name, description, category, defaultSchedule, handler: async (tenantId) => {summary}, settingsKeys: [] }

function registerJob(definition) {
  jobs.set(definition.name, { definition, task: null });
}

async function startAll() {
  for (const [name] of jobs) {
    await scheduleJob(name);
  }
}

async function scheduleJob(name) {
  const entry = jobs.get(name);
  if (!entry) return;

  // Stop existing task if running
  if (entry.task) { entry.task.stop(); entry.task = null; }

  // Get schedule from settings (platform tenant for global cron schedule)
  const platformId = await getPlatformTenantId();
  let scheduleSetting = null;
  try {
    scheduleSetting = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = $2"
    ).get(platformId, `cron_${name}_schedule`);
  } catch { /* use default */ }

  const schedule = scheduleSetting?.value || entry.definition.defaultSchedule;
  if (!cron.validate(schedule)) {
    console.error(`[Cron] Invalid schedule for ${name}: ${schedule}`);
    return;
  }

  entry.task = cron.schedule(schedule, async () => {
    await runJob(name);
  });
  console.log(`[Cron] Scheduled ${name}: ${schedule}`);
}

async function runJob(name, manualTenantId) {
  const entry = jobs.get(name);
  if (!entry) throw new Error(`Unknown job: ${name}`);

  // Prevent concurrent runs of the same job
  if (running.has(name)) return [{ status: 'skipped', reason: 'Already running' }];
  running.add(name);

  try { return await _executeJob(name, entry, manualTenantId); }
  finally { running.delete(name); }
}

async function _executeJob(name, entry, manualTenantId) {
  // Check if enabled (default: true for backward compat)
  const platformId = await getPlatformTenantId();
  let enabledSetting = null;
  try {
    enabledSetting = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = $2"
    ).get(platformId, `cron_${name}_enabled`);
  } catch { /* default to enabled */ }

  if (enabledSetting?.value === '0') {
    return { skipped: 'Job is disabled' };
  }

  const { getActiveTenantIds } = require('./tenant-utils');
  const tenantIds = manualTenantId ? [manualTenantId] : await getActiveTenantIds();

  // Process tenants in parallel batches for scalability
  let batchSizeSetting = null;
  try {
    batchSizeSetting = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'cron_batch_size'"
    ).get(platformId);
  } catch { /* use default */ }
  const BATCH_SIZE = Math.max(1, parseInt(batchSizeSetting?.value) || 5);

  const allResults = [];
  for (let i = 0; i < tenantIds.length; i += BATCH_SIZE) {
    const batch = tenantIds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(tenantId => _executeSingleTenant(name, entry, tenantId))
    );
    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      allResults.push(r.status === 'fulfilled' ? r.value : { tenantId: batch[j], status: 'error', error: r.reason?.message });
    }
  }
  return allResults;
}

async function _executeSingleTenant(name, entry, tenantId) {
  const run = await db.prepare(
    "INSERT INTO cron_runs (tenant_id, job_name, started_at, status) VALUES ($1, $2, NOW(), 'running') RETURNING id"
  ).get(tenantId, name);

  try {
    const summary = await entry.definition.handler(tenantId);
    await db.prepare(
      "UPDATE cron_runs SET finished_at = NOW(), status = 'success', summary = $1 WHERE id = $2"
    ).run(JSON.stringify(summary || {}), run.id);
    return { tenantId, status: 'success', summary };
  } catch (err) {
    await db.prepare(
      "UPDATE cron_runs SET finished_at = NOW(), status = 'error', summary = $1 WHERE id = $2"
    ).run(JSON.stringify({ error: err.message }), run.id);
    console.error(`[Cron] ${name} error (tenant ${tenantId}):`, err.message);
    return { tenantId, status: 'error', error: err.message };
  }
}

function getJobs() {
  return Array.from(jobs.entries()).map(([name, entry]) => ({
    name,
    description: entry.definition.description,
    category: entry.definition.category,
    defaultSchedule: entry.definition.defaultSchedule,
  }));
}

function rescheduleJob(name) { return scheduleJob(name); }

module.exports = { registerJob, startAll, runJob, getJobs, rescheduleJob };
