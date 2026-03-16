/**
 * Deep Feed AI — lib/categories.js
 * Single source of truth for categories.
 * Reads from `categories` table with 60s cache.
 * Falls back to legacy site_categories JSON setting if table is empty.
 */
'use strict';

const db = require('../db');

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 60 * 1000;

/**
 * @returns {Promise<Array<{id: number, name: string, color: string, keywords: string[]}>>}
 */
async function getCategories() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

  let rows = [];
  try {
    rows = await db.prepare(
      'SELECT id, name, color, keywords FROM categories ORDER BY name ASC'
    ).all();
  } catch { /* table may not exist yet */ }

  // Fallback: read from legacy site_categories JSON setting
  if (!rows.length) {
    try {
      const row = await db.prepare(
        "SELECT value FROM settings WHERE key = $1"
      ).get('site_categories');
      if (row && row.value) {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) rows = parsed;
      }
    } catch { /* ignore */ }
  }

  // Ensure every category has a keywords array
  for (const c of rows) {
    if (!Array.isArray(c.keywords)) c.keywords = [];
  }

  _cache = rows;
  _cacheTs = Date.now();
  return rows;
}

/** @returns {Promise<string[]>} */
async function getCategoryNames() {
  const cats = await getCategories();
  return cats.map(c => c.name);
}

function bustCategoryCache() {
  _cache = null;
  _cacheTs = 0;
}

module.exports = { getCategories, getCategoryNames, bustCategoryCache };
