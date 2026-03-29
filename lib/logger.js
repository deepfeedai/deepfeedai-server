/**
 * Deep Feed AI — lib/logger.js
 * Structured logging with batch DB persistence, SSE support, and error aggregation.
 *
 * Usage:
 *   const logger = require('./lib/logger');
 *   logger.info('Something happened', { module: 'cron', tenantId: 1 });
 *   logger.error('Oops', { module: 'auth', error: err, correlationId: req.correlationId });
 *
 *   // Child logger with preset context
 *   const log = logger.createChild({ module: 'cron', tenantId: 1 });
 *   log.info('RSS fetch started');
 */
const crypto = require('crypto');
const EventEmitter = require('events');

// ── Log levels ──────────────────────────────────────────────────
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_NAMES = Object.keys(LEVELS);

const isDev = process.env.NODE_ENV !== 'production';
const stdoutLevel = LEVELS[process.env.LOG_LEVEL || (isDev ? 'debug' : 'info')] ?? LEVELS.info;
const dbMinLevel = LEVELS[process.env.LOG_DB_MIN_LEVEL || 'warn'] ?? LEVELS.warn;

// ── SSE emitter ─────────────────────────────────────────────────
const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

// ── Batch DB insert buffer ──────────────────────────────────────
let _db = null; // lazy-loaded to avoid circular deps
let _appLogBuffer = [];
let _reqLogBuffer = [];
const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFER_SIZE = 50;
let _flushTimer = null;

function getDb() {
  if (!_db) {
    try { _db = require('../db'); } catch { /* not available yet */ }
  }
  return _db;
}

function startFlushTimer() {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => flush(), FLUSH_INTERVAL_MS);
  _flushTimer.unref(); // don't prevent process exit
}

async function flush() {
  await Promise.all([flushAppLogs(), flushReqLogs()]);
}

async function flushAppLogs() {
  if (_appLogBuffer.length === 0) return;
  const batch = _appLogBuffer.splice(0);
  const db = getDb();
  if (!db || !db.isDbReady()) return;

  try {
    const pool = db.getPool();
    if (!pool) return;

    // Batch insert via unnest
    const tenantIds = [], levels = [], messages = [], modules = [],
          correlationIds = [], contexts = [], errorStacks = [], createdAts = [];

    for (const entry of batch) {
      tenantIds.push(entry.tenantId || null);
      levels.push(entry.level);
      messages.push((entry.message || '').slice(0, 2000));
      modules.push(entry.module || null);
      correlationIds.push(entry.correlationId || null);
      contexts.push(entry.context ? JSON.stringify(entry.context) : null);
      errorStacks.push(entry.errorStack || null);
      createdAts.push(entry.timestamp);
    }

    await pool.query(`
      INSERT INTO app_logs (tenant_id, level, message, module, correlation_id, context, error_stack, created_at)
      SELECT * FROM unnest(
        $1::int[], $2::text[], $3::text[], $4::text[],
        $5::text[], $6::jsonb[], $7::text[], $8::timestamptz[]
      )
    `, [tenantIds, levels, messages, modules, correlationIds, contexts, errorStacks, createdAts]);

    // Aggregate errors
    const errors = batch.filter(e => e.level === 'error');
    for (const entry of errors) {
      await upsertErrorAggregate(pool, entry);
    }
  } catch (err) {
    // Re-queue failed entries for next flush (cap to prevent unbounded growth)
    if (_appLogBuffer.length < 500) {
      _appLogBuffer.unshift(...batch);
    }
    process.stderr.write('[logger] app_logs flush failed: ' + err.message + '\n');
  }
}

async function flushReqLogs() {
  if (_reqLogBuffer.length === 0) return;
  const batch = _reqLogBuffer.splice(0);
  const db = getDb();
  if (!db || !db.isDbReady()) return;

  try {
    const pool = db.getPool();
    if (!pool) return;

    const tenantIds = [], correlationIds = [], methods = [], paths = [],
          statusCodes = [], durations = [], ips = [], userAgents = [],
          userIds = [], contentLengths = [], createdAts = [];

    for (const r of batch) {
      tenantIds.push(r.tenantId || null);
      correlationIds.push(r.correlationId || null);
      methods.push(r.method);
      paths.push((r.path || '').slice(0, 500));
      statusCodes.push(r.statusCode);
      durations.push(r.durationMs || null);
      ips.push(r.ip || null);
      userAgents.push(r.userAgent ? r.userAgent.slice(0, 512) : null);
      userIds.push(r.userId || null);
      contentLengths.push(r.contentLength || null);
      createdAts.push(r.timestamp);
    }

    await pool.query(`
      INSERT INTO request_logs (tenant_id, correlation_id, method, path, status_code, duration_ms, ip_address, user_agent, user_id, content_length, created_at)
      SELECT * FROM unnest(
        $1::int[], $2::text[], $3::text[], $4::text[],
        $5::int[], $6::int[], $7::text[], $8::text[],
        $9::int[], $10::int[], $11::timestamptz[]
      )
    `, [tenantIds, correlationIds, methods, paths, statusCodes, durations, ips, userAgents, userIds, contentLengths, createdAts]);
  } catch (err) {
    if (_reqLogBuffer.length < 500) {
      _reqLogBuffer.unshift(...batch);
    }
    process.stderr.write('[logger] request_logs flush failed: ' + err.message + '\n');
  }
}

async function upsertErrorAggregate(pool, entry) {
  try {
    const normalizedMsg = (entry.message || 'Unknown error').slice(0, 500);
    const firstFrame = (entry.errorStack || '').split('\n').slice(0, 3).join('\n');
    const hash = crypto.createHash('sha256')
      .update(normalizedMsg + '\n' + (firstFrame || ''))
      .digest('hex')
      .slice(0, 32);

    await pool.query(`
      INSERT INTO error_aggregates (tenant_id, error_hash, message, stack_sample, module, count, first_seen, last_seen)
      VALUES ($1, $2, $3, $4, $5, 1, NOW(), NOW())
      ON CONFLICT (tenant_id, error_hash) DO UPDATE SET
        count = error_aggregates.count + 1,
        last_seen = NOW(),
        stack_sample = COALESCE(EXCLUDED.stack_sample, error_aggregates.stack_sample)
    `, [entry.tenantId || null, hash, normalizedMsg, firstFrame || null, entry.module || null]);
  } catch {
    // Non-fatal
  }
}

// ── Core logging function ───────────────────────────────────────
function log(level, message, context) {
  const levelNum = LEVELS[level] ?? LEVELS.info;
  const now = new Date();

  const entry = {
    timestamp: now.toISOString(),
    level,
    message: typeof message === 'string' ? message : String(message),
    module: context?.module || null,
    correlationId: context?.correlationId || null,
    tenantId: context?.tenantId || null,
    errorStack: null,
    context: null,
  };

  // Extract error stack if an Error object is provided
  if (context?.error instanceof Error) {
    entry.errorStack = context.error.stack || null;
    entry.message = entry.message || context.error.message;
  } else if (context?.stack) {
    entry.errorStack = context.stack;
  }

  // Build clean context (exclude fields already in top-level)
  if (context) {
    const { module: _m, correlationId: _c, tenantId: _t, error: _e, stack: _s, ...rest } = context;
    if (Object.keys(rest).length > 0) {
      entry.context = rest;
    }
  }

  // ── Stdout ──
  if (levelNum >= stdoutLevel) {
    if (isDev) {
      // Pretty format for development
      const prefix = `[${level.toUpperCase()}]`;
      const modStr = entry.module ? ` [${entry.module}]` : '';
      const parts = [`${prefix}${modStr} ${entry.message}`];
      if (entry.context) parts.push(JSON.stringify(entry.context, null, 2));
      if (entry.errorStack) parts.push(entry.errorStack);
      const writer = levelNum >= LEVELS.error ? console.error
        : levelNum >= LEVELS.warn ? console.warn : console.log;
      writer(...parts);
    } else {
      // Structured JSON for production
      const out = {
        time: entry.timestamp,
        level,
        msg: entry.message,
      };
      if (entry.module) out.module = entry.module;
      if (entry.correlationId) out.cid = entry.correlationId;
      if (entry.tenantId) out.tid = entry.tenantId;
      if (entry.context) out.ctx = entry.context;
      if (entry.errorStack) out.stack = entry.errorStack;
      const writer = levelNum >= LEVELS.error ? process.stderr : process.stdout;
      writer.write(JSON.stringify(out) + '\n');
    }
  }

  // ── DB persistence ──
  if (levelNum >= dbMinLevel) {
    _appLogBuffer.push(entry);
    startFlushTimer();
    if (_appLogBuffer.length >= MAX_BUFFER_SIZE) {
      flushAppLogs().catch(() => {});
    }
  }

  // ── SSE emit ──
  if (levelNum >= LEVELS.info) {
    logEmitter.emit('log', {
      timestamp: entry.timestamp,
      level,
      message: entry.message,
      module: entry.module,
      correlationId: entry.correlationId,
      tenantId: entry.tenantId,
    });
  }
}

// ── Public API ──────────────────────────────────────────────────
function createChild(defaults) {
  return {
    debug: (msg, ctx) => log('debug', msg, { ...defaults, ...ctx }),
    info:  (msg, ctx) => log('info',  msg, { ...defaults, ...ctx }),
    warn:  (msg, ctx) => log('warn',  msg, { ...defaults, ...ctx }),
    error: (msg, ctx) => log('error', msg, { ...defaults, ...ctx }),
  };
}

function logRequest(data) {
  _reqLogBuffer.push({ ...data, timestamp: new Date().toISOString() });
  startFlushTimer();
  if (_reqLogBuffer.length >= MAX_BUFFER_SIZE) {
    flushReqLogs().catch(() => {});
  }
}

// ── Graceful shutdown ───────────────────────────────────────────
function drain() {
  if (_flushTimer) clearInterval(_flushTimer);
  return flush();
}

process.on('SIGTERM', () => { drain().catch(() => {}); });
process.on('SIGINT',  () => { drain().catch(() => {}); });

module.exports = {
  debug: (msg, ctx) => log('debug', msg, ctx),
  info:  (msg, ctx) => log('info',  msg, ctx),
  warn:  (msg, ctx) => log('warn',  msg, ctx),
  error: (msg, ctx) => log('error', msg, ctx),
  createChild,
  logRequest,
  logEmitter,
  flush,
  drain,
};
