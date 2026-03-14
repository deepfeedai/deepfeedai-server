/**
 * Deep Feed AI — lib/site-config.js
 * In-memory cached accessor for all site_* settings.
 * TTL: 60 seconds. Cache busted on settings save via bustSiteConfigCache().
 */
'use strict';

const db = require('../db');
const { getCategories } = require('./categories');

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

async function getSiteConfig() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE key LIKE $1"
  ).all('site_%');

  const config = {};
  for (const row of rows) {
    const shortKey = row.key.replace(/^site_/, '');
    // Skip legacy site_categories JSON — we read from the categories table now
    if (shortKey === 'categories') continue;
    config[shortKey] = row.value;
  }

  // Read categories from the dedicated table
  config.categories = await getCategories();

  _cache = config;
  _cacheTs = Date.now();
  return config;
}

function bustSiteConfigCache() {
  _cache = null;
  _cacheTs = 0;
}

module.exports = { getSiteConfig, bustSiteConfigCache };
