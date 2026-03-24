/**
 * Deep Feed AI — lib/platform-tenant.js
 * Cached lookup for the platform tenant's internal ID and UUID.
 * Replaces hardcoded `tenant_id = 1` references throughout the codebase.
 */
'use strict';
const db = require('../db');

let _platformId   = null; // integer
let _platformUuid = null; // string

/**
 * Returns the platform tenant's internal integer ID.
 * Cached permanently (the platform tenant doesn't change).
 */
async function getPlatformTenantId() {
  if (_platformId !== null) return _platformId;
  try {
    const row = await db.prepare(
      'SELECT id FROM tenants WHERE is_platform = true'
    ).get();
    _platformId = row?.id ?? 1;
  } catch {
    _platformId = 1; // fallback during DB init
  }
  return _platformId;
}

/**
 * Returns the platform tenant's UUID string.
 * Cached permanently.
 */
async function getPlatformTenantUuid() {
  if (_platformUuid !== null) return _platformUuid;
  try {
    const row = await db.prepare(
      'SELECT uuid FROM tenants WHERE is_platform = true'
    ).get();
    _platformUuid = row?.uuid ?? null;
  } catch {
    _platformUuid = null;
  }
  return _platformUuid;
}

/**
 * Check if a given internal tenant ID is the platform tenant.
 */
async function isPlatformTenant(tenantId) {
  return tenantId === await getPlatformTenantId();
}

function bustPlatformTenantCache() {
  _platformId = null;
  _platformUuid = null;
}

module.exports = {
  getPlatformTenantId,
  getPlatformTenantUuid,
  isPlatformTenant,
  bustPlatformTenantCache,
};
