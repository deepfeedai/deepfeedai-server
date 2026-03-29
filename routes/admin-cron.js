/**
 * Deep Feed AI Admin — routes/admin-cron.js
 * Admin API for managing scheduled cron jobs.
 */
const router              = require('express').Router();
const cron                = require('node-cron');
const db                  = require('../db');
const { asyncHandler }    = require('../lib/utils');
const { auth }            = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAudit }        = require('../middleware/audit');
const { bustAppConfigCache } = require('../lib/app-config');
const { getJobs, runJob, rescheduleJob } = require('../lib/cron-registry');
const cronstrue              = require('cronstrue');
const { CronExpressionParser } = require('cron-parser');

// Minimum interval enforcement (seconds) to prevent DoS via rapid scheduling
const MIN_INTERVALS = {
  newsletter: 3600, 'auto-audio': 1800, 'auto-archive': 3600,
  'purge-archived': 600, 'budget-alert': 3600, default: 300,
};

function estimateIntervalSecs(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 6) return 1; // reject 6-field (seconds) expressions
  const minField = parts[0];
  if (minField === '*') return 60;
  const step = minField.match(/^\*\/(\d+)$/);
  if (step) return parseInt(step[1]) * 60;
  return Infinity; // specific time expressions are fine
}

// Per-job manual run cooldown
const lastManualRun = new Map();
const RUN_COOLDOWNS = {
  newsletter: 600000, 'auto-audio': 300000, 'auto-archive': 300000, default: 60000,
};

// GET /preview — preview a cron expression (human description + next 3 runs)
router.get('/preview', auth, requirePermission('cron.read'), asyncHandler(async (req, res) => {
  const { schedule } = req.query;
  if (!schedule) return res.status(400).json({ error: 'schedule param required' });

  if (!cron.validate(schedule)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  let description = '';
  try { description = cronstrue.toString(schedule); } catch { description = schedule; }

  const nextRuns = [];
  try {
    const interval = CronExpressionParser.parse(schedule);
    for (let i = 0; i < 3; i++) {
      nextRuns.push(interval.next().toISOString());
    }
  } catch { /* unable to compute */ }

  res.json({ schedule, description, nextRuns });
}));

// GET / — list all jobs with status, current schedule, enabled state, last run
router.get('/', auth, requirePermission('cron.read'), asyncHandler(async (req, res) => {
  const jobDefs = getJobs();

  const results = [];
  for (const job of jobDefs) {
    // Get current schedule from settings
    let scheduleSetting = null;
    try {
      scheduleSetting = await db.prepare(
        "SELECT value FROM settings WHERE tenant_id = $1 AND key = $2"
      ).get(req.tenantId, `cron_${job.name}_schedule`);
    } catch { /* use default */ }

    // Get enabled state from settings
    let enabledSetting = null;
    try {
      enabledSetting = await db.prepare(
        "SELECT value FROM settings WHERE tenant_id = $1 AND key = $2"
      ).get(req.tenantId, `cron_${job.name}_enabled`);
    } catch { /* default to enabled */ }

    // Get last run info
    let lastRun = null;
    try {
      lastRun = await db.prepare(
        "SELECT started_at, finished_at, status, summary FROM cron_runs WHERE tenant_id = $1 AND job_name = $2 ORDER BY started_at DESC LIMIT 1"
      ).get(req.tenantId, job.name);
    } catch { /* no runs yet */ }

    const currentSchedule = scheduleSetting?.value || job.defaultSchedule;
    let scheduleDescription = '';
    try { scheduleDescription = cronstrue.toString(currentSchedule); } catch {}

    results.push({
      ...job,
      currentSchedule,
      scheduleDescription,
      enabled: enabledSetting?.value !== '0',
      lastRun: lastRun || null,
    });
  }

  // Get autopilot state for this tenant
  let autopilotRow = null;
  try {
    autopilotRow = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'autopilot_enabled'"
    ).get(req.tenantId);
  } catch { /* default to enabled */ }

  res.json({ jobs: results, autopilotEnabled: autopilotRow?.value !== '0' });
}));

// PUT /autopilot — toggle tenant autopilot master switch
router.put('/autopilot', auth, requirePermission('cron.update'), asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  if (enabled === undefined) return res.status(400).json({ error: 'enabled is required' });

  const val = enabled ? '1' : '0';
  await db.prepare(
    "INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3"
  ).run(req.tenantId, 'autopilot_enabled', val);

  bustAppConfigCache(req.tenantId);
  await logAudit(req, 'cron.autopilot', 'cron', null, { enabled });

  res.json({ success: true, autopilotEnabled: enabled });
}));

// PUT /:name — update schedule or enable/disable
router.put('/:name', auth, requirePermission('cron.update'), asyncHandler(async (req, res) => {
  const { name } = req.params;
  const { schedule, enabled } = req.body;

  // Validate job exists
  const jobDefs = getJobs();
  const job = jobDefs.find(j => j.name === name);
  if (!job) {
    return res.status(404).json({ error: `Unknown job: ${name}` });
  }

  const changes = {};

  // Update schedule if provided
  if (schedule !== undefined) {
    if (!cron.validate(schedule)) {
      return res.status(400).json({ error: `Invalid cron schedule: ${schedule}` });
    }
    const intervalSecs = estimateIntervalSecs(schedule);
    const minSecs = MIN_INTERVALS[name] ?? MIN_INTERVALS.default;
    if (intervalSecs < minSecs) {
      return res.status(400).json({ error: `Schedule too frequent for "${name}". Minimum interval: ${Math.round(minSecs / 60)} minutes.` });
    }
    await db.prepare(
      "INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3"
    ).run(req.tenantId, `cron_${name}_schedule`, schedule);
    changes.schedule = schedule;
  }

  // Update enabled state if provided
  if (enabled !== undefined) {
    const val = enabled ? '1' : '0';
    await db.prepare(
      "INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3"
    ).run(req.tenantId, `cron_${name}_enabled`, val);
    changes.enabled = enabled;
  }

  // Reschedule if schedule changed
  if (schedule !== undefined) {
    await rescheduleJob(name);
  }

  // Bust app config cache
  bustAppConfigCache(req.tenantId);

  // Audit log
  await logAudit(req, 'cron.update', 'cron', null, { job: name, ...changes });

  res.json({ success: true, job: name, changes });
}));

// POST /:name/run — manual trigger
router.post('/:name/run', auth, requirePermission('cron.execute'), asyncHandler(async (req, res) => {
  const { name } = req.params;

  // Validate job exists
  const jobDefs = getJobs();
  const job = jobDefs.find(j => j.name === name);
  if (!job) {
    return res.status(404).json({ error: `Unknown job: ${name}` });
  }

  // Per-job cooldown to prevent rapid repeated triggers
  const cooldown = RUN_COOLDOWNS[name] ?? RUN_COOLDOWNS.default;
  const cooldownKey = `${req.tenantId}:${name}`;
  const lastRun = lastManualRun.get(cooldownKey) || 0;
  if (Date.now() - lastRun < cooldown) {
    const waitSec = Math.ceil((cooldown - (Date.now() - lastRun)) / 1000);
    return res.status(429).json({ error: `Job "${name}" was recently triggered. Wait ${waitSec}s.` });
  }
  lastManualRun.set(cooldownKey, Date.now());

  const results = await runJob(name, req.tenantId);

  // Audit log
  await logAudit(req, 'cron.execute', 'cron', null, { job: name, results });

  res.json({ success: true, job: name, results });
}));

// GET /:name/history — last 20 runs
router.get('/:name/history', auth, requirePermission('cron.read'), asyncHandler(async (req, res) => {
  const { name } = req.params;

  // Validate job exists
  const jobDefs = getJobs();
  const job = jobDefs.find(j => j.name === name);
  if (!job) {
    return res.status(404).json({ error: `Unknown job: ${name}` });
  }

  const runs = await db.prepare(
    "SELECT id, tenant_id, job_name, started_at, finished_at, status, summary, created_at FROM cron_runs WHERE job_name = $1 AND tenant_id = $2 ORDER BY started_at DESC LIMIT 20"
  ).all(name, req.tenantId);

  res.json({ job: name, runs });
}));

module.exports = router;
