/**
 * Deep Feed AI — Integration test harness
 *
 * Provides helpers for creating test tenants, tokens, and cleanup.
 * Requires DATABASE_URL to be set (reads from .env if present).
 */
'use strict';

const path = require('path');
const jwt  = require('jsonwebtoken');

// Load .env from the admin root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Use the real db module — connects to the DATABASE_URL from .env
const db = require('../db');

const JWT_SECRET      = process.env.JWT_SECRET || 'test-jwt-secret-integration';
const USER_JWT_SECRET = process.env.USER_JWT_SECRET || 'test-user-jwt-secret';

let _testTenantCounter = 0;

/**
 * Initialize the database (runs CREATE TABLE IF NOT EXISTS + migrations).
 * Call once before all tests.
 */
async function initTestDb() {
  await db.init();
}

/**
 * Create a test tenant with a unique slug.
 * @param {string} plan — 'free' | 'starter' | 'pro' | 'business'
 * @returns {Promise<{ id: number, slug: string }>}
 */
async function createTestTenant(plan = 'starter') {
  _testTenantCounter++;
  const slug = `test-${Date.now()}-${_testTenantCounter}`;
  const row = await db.prepare(
    `INSERT INTO tenants (slug, display_name, plan, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id, slug`
  ).get(slug, `Test Tenant ${_testTenantCounter}`, plan);
  return { id: row.id, slug: row.slug };
}

/**
 * Sign an admin JWT with the same structure used in routes/tenants.js.
 * @param {number} tenantId
 * @param {'tenant-admin'|'platform-admin'} type
 * @param {string} email
 * @param {object} [opts] — extra JWT options (e.g. { expiresIn: '-1s' })
 * @returns {string} signed JWT
 */
function createTestToken(tenantId, type = 'tenant-admin', email = 'test@example.com', opts = {}) {
  return jwt.sign(
    { tenantId, type, email, role: 'owner' },
    JWT_SECRET,
    { expiresIn: '1h', ...opts }
  );
}

/**
 * Clean up all test data created during the test run.
 * Deletes tenants with slug LIKE 'test-%' and cascades.
 */
async function cleanupTestData() {
  // Get test tenant IDs first
  const tenants = await db.prepare(
    "SELECT id FROM tenants WHERE slug LIKE 'test-%'"
  ).all();
  const ids = tenants.map(t => t.id);

  if (ids.length > 0) {
    // Clean up tenanted data in dependency order
    for (const id of ids) {
      await db.prepare('DELETE FROM ai_usage WHERE tenant_id = $1').run(id);
      await db.prepare('DELETE FROM settings WHERE tenant_id = $1').run(id);
      await db.prepare('DELETE FROM sources WHERE tenant_id = $1').run(id);
      await db.prepare('DELETE FROM articles WHERE tenant_id = $1').run(id);
      await db.prepare('DELETE FROM writers WHERE tenant_id = $1').run(id);
      await db.prepare('DELETE FROM categories WHERE tenant_id = $1').run(id);
      await db.prepare('DELETE FROM file_storage WHERE tenant_id = $1').run(id);
    }
    // Delete the tenants themselves
    await db.prepare("DELETE FROM tenants WHERE slug LIKE 'test-%'").run();
  }
}

module.exports = {
  db,
  initTestDb,
  createTestTenant,
  createTestToken,
  cleanupTestData,
  JWT_SECRET,
  USER_JWT_SECRET,
};
