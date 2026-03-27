/**
 * Deep Feed AI Admin — lib/tenant-utils.js
 * Shared tenant utility functions.
 */
const db = require('../db');
const { getPlatformTenantId } = require('./platform-tenant');

/** Dynamic getter — re-evaluates process.env so runtime changes (e.g. setup wizard) take effect */
function isMultiTenant() {
  return process.env.DEPLOYMENT_MODE === 'multi';
}

/** Get all active tenant IDs for cron job iteration */
async function getActiveTenantIds() {
  const platformId = await getPlatformTenantId();
  if (!isMultiTenant()) return [platformId];
  try {
    const rows = await db.prepare("SELECT id FROM tenants WHERE status = 'active'").all();
    const ids = rows.map(r => r.id);
    // Always include platform tenant even if no tenants table row exists
    if (!ids.includes(platformId)) ids.unshift(platformId);
    return ids;
  } catch {
    return [platformId]; // fallback
  }
}

// Expose MULTI_TENANT as a getter so importers always get the live value
Object.defineProperty(module.exports, 'MULTI_TENANT', { get: isMultiTenant });
module.exports.getActiveTenantIds = getActiveTenantIds;
