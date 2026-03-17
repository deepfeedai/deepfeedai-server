/**
 * Deep Feed AI — middleware/audit.js
 * Lightweight audit logging for admin actions.
 */
const db = require('../db');

function normalizeIp(ip) {
  if (!ip) return null;
  // Strip IPv6-mapped IPv4 prefix (::ffff:192.168.1.100 → 192.168.1.100)
  return ip.replace(/^::ffff:/, '');
}

async function logAudit(req, action, resource, resourceId, details) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.id || null;
    const userEmail = user.email || user.username || user.displayName || null;

    await db.prepare(`
      INSERT INTO audit_log (tenant_id, user_id, user_email, action, resource, resource_id, details, ip_address, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `).run(
      req.tenantId || 1,
      userId,
      userEmail,
      action,
      resource,
      resourceId || null,
      details ? JSON.stringify(details) : null,
      normalizeIp(req.ip)
    );
  } catch (err) {
    console.error('[audit] Failed to log:', err.message);
  }
}

module.exports = { logAudit };
