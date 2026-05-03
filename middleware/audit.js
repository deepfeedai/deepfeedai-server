/**
 * Deep Feed AI — middleware/audit.js
 * Lightweight audit logging for admin actions.
 */
const db = require('../db');
const EventEmitter = require('events');

const auditEmitter = new EventEmitter();
auditEmitter.setMaxListeners(50);

function normalizeIp(ip) {
  if (!ip) return null;
  // Strip IPv6-mapped IPv4 prefix (::ffff:192.168.1.100 → 192.168.1.100)
  return ip.replace(/^::ffff:/, '');
}

async function logAudit(req, action, resource, resourceId, details) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      process.stderr.write(`[audit] logAudit called with no tenantId (action=${action}) — dropping entry\n`);
      return;
    }

    const user = req.user || {};
    const userId = user.sub || user.id || null;
    const userEmail = user.email || user.username || user.displayName || null;

    const userAgent = req.headers ? (req.headers['user-agent'] || '').slice(0, 512) : null;

    await db.prepare(`
      INSERT INTO audit_log (tenant_id, user_id, user_email, action, resource, resource_id, details, ip_address, user_agent, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `).run(
      tenantId,
      userId,
      userEmail,
      action,
      resource,
      resourceId || null,
      details ? JSON.stringify(details) : null,
      normalizeIp(req.ip),
      userAgent || null
    );

    // Emit for SSE listeners
    auditEmitter.emit('entry', {
      tenant_id: tenantId,
      user_email: userEmail,
      action,
      resource,
      resource_id: resourceId || null,
      details: details || null,
      ip_address: normalizeIp(req.ip),
      user_agent: userAgent || null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] Failed to log:', err.message);
  }
}

/**
 * logAuditWithDiff — logs an audit event with before/after diff of changed fields.
 * Performs a shallow comparison and stores only changed keys in details.changes.
 */
async function logAuditWithDiff(req, action, resource, resourceId, before, after, extraDetails) {
  const changes = {};
  if (before && after) {
    for (const key of Object.keys(after)) {
      const oldVal = before[key];
      const newVal = after[key];
      if (String(oldVal ?? '') !== String(newVal ?? '')) {
        changes[key] = { from: oldVal ?? null, to: newVal ?? null };
      }
    }
  }
  const details = { ...(extraDetails || {}), changes };
  return logAudit(req, action, resource, resourceId, details);
}

module.exports = { logAudit, logAuditWithDiff, auditEmitter };
