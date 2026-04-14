/**
 * Deep Feed AI — middleware/rate-limit-log.js
 * Shared handler for express-rate-limit that logs the 429 event and then
 * sends the limiter's configured message. Drop-in:
 *   rateLimit({ ..., handler: rateLimitHandler('user.login') })
 */
'use strict';

const logger = require('../lib/logger');
const { logAudit } = require('./audit');

function rateLimitHandler(label) {
  return function handler(req, res, next, options) {
    const ctx = {
      module: 'rate-limit',
      label,
      tenantId: req.tenantId || null,
      correlationId: req.correlationId || null,
      path: req.originalUrl || req.path,
      method: req.method,
      ip: (req.ip || '').replace(/^::ffff:/, ''),
      userId: req.user?.sub || null,
    };
    logger.warn(`rate limit hit: ${label}`, ctx);

    // Security-critical rate limits also land in the audit log so brute-force
    // attempts show up in the admin audit view, not just app logs.
    if (/login|password|register|verify/i.test(label)) {
      logAudit(req, 'rate_limit.hit', 'rate_limiter', null, {
        label,
        path: ctx.path,
        ip: ctx.ip,
      }).catch(() => {});
    }

    res.status(options.statusCode || 429).json(
      options.message || { error: 'Too many requests. Please slow down.' }
    );
  };
}

module.exports = { rateLimitHandler };
