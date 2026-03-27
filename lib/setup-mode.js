/**
 * Deep Feed AI — lib/setup-mode.js
 * Detects first-boot state and caches the result.
 *
 * Setup mode is active when BOTH:
 *  - Database not connected OR no admin/owner user exists
 *  - For brand-new installs the setup wizard guides through first-time config
 *  - Existing deployments (admin user already exists) skip setup mode automatically
 */
'use strict';

const db = require('../db');

let _needsSetup = null; // null = not checked yet, boolean after first check

/**
 * Returns true if the server is in setup mode.
 * Result is cached — call bustSetupCache() after state changes.
 */
async function isSetupMode() {
  if (_needsSetup !== null) return _needsSetup;

  // No database connection — definitely need setup
  if (!db.isDbReady()) {
    _needsSetup = true;
    return true;
  }

  try {
    // If an admin/owner user exists, the instance is operational — no setup needed.
    // This handles existing deployments that predate the setup wizard.
    const userRow = await db.prepare(
      "SELECT COUNT(*)::int AS count FROM users WHERE role IN ('owner', 'admin')"
    ).get();
    _needsSetup = !userRow || userRow.count === 0;
  } catch {
    // DB error — assume setup needed
    _needsSetup = true;
  }
  return _needsSetup;
}

/** Call after admin user is created, DB connected, or setup completed to re-check. */
function bustSetupCache() {
  _needsSetup = null;
}

module.exports = { isSetupMode, bustSetupCache };
