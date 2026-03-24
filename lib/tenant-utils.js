/**
 * Deep Feed AI Admin — lib/tenant-utils.js
 * Shared tenant utility functions.
 */
const db = require('../db');
const { getPlatformTenantId } = require('./platform-tenant');

const SINGLE_TENANT = process.env.DEPLOYMENT_MODE === 'single';

/** Get all active tenant IDs for cron job iteration */
async function getActiveTenantIds() {
  const platformId = await getPlatformTenantId();
  if (SINGLE_TENANT) return [platformId];
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

module.exports = { getActiveTenantIds };
