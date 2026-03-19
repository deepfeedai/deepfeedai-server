/**
 * Deep Feed AI — lib/audit-alerts.js
 * Suspicious activity pattern detection for audit logs.
 */
const db = require('../db');

/**
 * Detect suspicious patterns in recent audit log entries.
 * Returns an array of alert objects: { type, severity, message, details }
 */
async function detectSuspiciousActivity(tenantId) {
  const alerts = [];
  const now = new Date();

  // 1. Failed logins in the last 15 minutes
  const failedLogins = await db.prepare(`
    SELECT COUNT(*) AS cnt, ip_address
    FROM audit_log
    WHERE tenant_id = $1
      AND action IN ('auth.login-failed', 'auth.oauth-denied')
      AND created_at >= NOW() - INTERVAL '15 minutes'
    GROUP BY ip_address
    HAVING COUNT(*) >= 3
  `).all(tenantId);

  for (const row of failedLogins) {
    alerts.push({
      type: 'failed-logins',
      severity: parseInt(row.cnt) >= 10 ? 'critical' : 'warning',
      message: `${row.cnt} failed login attempts from ${row.ip_address} in the last 15 minutes`,
      details: { ip: row.ip_address, count: parseInt(row.cnt) },
    });
  }

  // 2. Bulk deletes in the last 15 minutes
  const bulkDeletes = await db.prepare(`
    SELECT COUNT(*) AS cnt, user_email
    FROM audit_log
    WHERE tenant_id = $1
      AND action LIKE '%.delete%'
      AND created_at >= NOW() - INTERVAL '15 minutes'
    GROUP BY user_email
    HAVING COUNT(*) >= 5
  `).all(tenantId);

  for (const row of bulkDeletes) {
    alerts.push({
      type: 'bulk-deletes',
      severity: parseInt(row.cnt) >= 20 ? 'critical' : 'warning',
      message: `${row.cnt} delete operations by ${row.user_email || 'unknown'} in the last 15 minutes`,
      details: { email: row.user_email, count: parseInt(row.cnt) },
    });
  }

  // 3. Off-hours activity (between 1am and 5am local — use UTC as approximation)
  const hour = now.getUTCHours();
  if (hour >= 1 && hour < 5) {
    const offHoursCount = await db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM audit_log
      WHERE tenant_id = $1
        AND created_at >= NOW() - INTERVAL '15 minutes'
        AND action NOT LIKE 'audit.%'
    `).get(tenantId);

    if (parseInt(offHoursCount.cnt) >= 5) {
      alerts.push({
        type: 'off-hours',
        severity: 'info',
        message: `${offHoursCount.cnt} admin actions detected during off-hours (1-5 AM UTC)`,
        details: { count: parseInt(offHoursCount.cnt), hour },
      });
    }
  }

  // 4. Settings changes — multiple sensitive key changes
  const settingsChanges = await db.prepare(`
    SELECT COUNT(*) AS cnt, user_email
    FROM audit_log
    WHERE tenant_id = $1
      AND action = 'settings.update'
      AND created_at >= NOW() - INTERVAL '15 minutes'
    GROUP BY user_email
    HAVING COUNT(*) >= 5
  `).all(tenantId);

  for (const row of settingsChanges) {
    alerts.push({
      type: 'mass-settings-change',
      severity: 'warning',
      message: `${row.cnt} settings changes by ${row.user_email || 'unknown'} in the last 15 minutes`,
      details: { email: row.user_email, count: parseInt(row.cnt) },
    });
  }

  return alerts;
}

module.exports = { detectSuspiciousActivity };
