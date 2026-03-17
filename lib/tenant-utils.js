/**
 * Deep Feed AI Admin — lib/tenant-utils.js
 * Shared tenant utility functions.
 */
const db = require('../db');

const SINGLE_TENANT = process.env.DEPLOYMENT_MODE === 'single';

/** Get all active tenant IDs for cron job iteration */
async function getActiveTenantIds() {
  if (SINGLE_TENANT) return [1];
  try {
    const rows = await db.prepare("SELECT id FROM tenants WHERE status = 'active'").all();
    const ids = rows.map(r => r.id);
    // Always include tenant 1 (original site) even if no tenants table row exists
    if (!ids.includes(1)) ids.unshift(1);
    return ids;
  } catch {
    return [1]; // fallback
  }
}

module.exports = { getActiveTenantIds };
