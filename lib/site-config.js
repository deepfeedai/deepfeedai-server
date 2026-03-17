/**
 * Deep Feed AI — lib/site-config.js
 * In-memory cached accessor for all site_* settings.
 * TTL: 60 seconds. Cache busted on settings save via bustSiteConfigCache().
 */
'use strict';

const db = require('../db');
const { getCategories } = require('./categories');

const _cache = new Map();   // tenantId -> { config, ts }
const CACHE_TTL = 60 * 1000; // 60 seconds

async function getSiteConfig(tenantId = 1) {
  const cached = _cache.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.config;

  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE tenant_id = $1 AND key LIKE $2"
  ).all(tenantId, 'site_%');

  const config = {};
  for (const row of rows) {
    const shortKey = row.key.replace(/^site_/, '');
    // Skip legacy site_categories JSON — we read from the categories table now
    if (shortKey === 'categories') continue;
    config[shortKey] = row.value;
  }

  // Read categories from the dedicated table
  config.categories = await getCategories(tenantId);

  _cache.set(tenantId, { config, ts: Date.now() });
  return config;
}

function bustSiteConfigCache() {
  _cache.clear();
}

module.exports = { getSiteConfig, bustSiteConfigCache };
