/**
 * Deep Feed AI — middleware/correlation.js
 * Generates a unique correlation ID per request for tracing.
 */
const crypto = require('crypto');

function correlationMiddleware(req, res, next) {
  // Use incoming header if present (distributed tracing), otherwise generate
  const incoming = req.headers['x-correlation-id'];
  // Validate: alphanumeric, hyphens, underscores, max 64 chars
  req.correlationId = (incoming && /^[\w\-]{1,64}$/.test(incoming))
    ? incoming
    : crypto.randomUUID();
  res.setHeader('X-Correlation-ID', req.correlationId);
  next();
}

module.exports = correlationMiddleware;
