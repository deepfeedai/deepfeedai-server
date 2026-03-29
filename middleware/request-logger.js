/**
 * Deep Feed AI — middleware/request-logger.js
 * Logs HTTP requests on response finish (non-blocking).
 */
const logger = require('../lib/logger');

// Paths to skip logging (health checks, static assets, preflight)
const SKIP_PREFIXES = ['/api/setup/health', '/api/instance-info'];
const SKIP_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/;

function normalizeIp(ip) {
  if (!ip) return null;
  return ip.replace(/^::ffff:/, '');
}

function requestLoggerMiddleware(req, res, next) {
  // Skip non-API static files and health checks
  if (req.method === 'OPTIONS') return next();
  if (SKIP_EXTENSIONS.test(req.path)) return next();
  if (SKIP_PREFIXES.some(p => req.path.startsWith(p))) return next();

  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const statusCode = res.statusCode;

    // Log to structured logger for stdout
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    const msg = `${req.method} ${req.path} ${statusCode} ${durationMs}ms`;

    logger[level](msg, {
      module: 'http',
      correlationId: req.correlationId,
      tenantId: req.tenantId,
      method: req.method,
      path: req.path,
      statusCode,
      durationMs,
    });

    // Batch insert to request_logs table
    logger.logRequest({
      tenantId: req.tenantId || null,
      correlationId: req.correlationId || null,
      method: req.method,
      path: req.path,
      statusCode,
      durationMs,
      ip: normalizeIp(req.ip),
      userAgent: req.headers['user-agent'] || null,
      userId: req.user?.sub || req.user?.id || null,
      contentLength: parseInt(res.getHeader('content-length')) || null,
    });
  });

  next();
}

module.exports = requestLoggerMiddleware;
