/**
 * Deep Feed AI — lib/categories.js
 * Single source of truth for categories.
 * Reads from `categories` table with 60s cache.
 * Falls back to legacy site_categories JSON setting if table is empty.
 */
'use strict';

const db = require('../db');

const _cache = new Map();   // tenantId -> { rows, ts }
const CACHE_TTL = 60 * 1000;

/**
 * @param {number|string} tenantId
 * @returns {Promise<Array<{id: number, name: string, color: string, keywords: string[]}>>}
 */
async function getCategories(tenantId) {
  const cached = _cache.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.rows;

  let rows = [];
  try {
    rows = await db.prepare(
      'SELECT id, name, color, keywords FROM categories WHERE tenant_id = $1 ORDER BY name ASC'
    ).all(tenantId);
  } catch { /* table may not exist yet */ }

  // Fallback: read from legacy site_categories JSON setting
  if (!rows.length) {
    try {
      const row = await db.prepare(
        "SELECT value FROM settings WHERE tenant_id = $1 AND key = $2"
      ).get(tenantId, 'site_categories');
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

  _cache.set(tenantId, { rows, ts: Date.now() });
  return rows;
}

/**
 * @param {number|string} tenantId
 * @returns {Promise<string[]>}
 */
async function getCategoryNames(tenantId) {
  const cats = await getCategories(tenantId);
  return cats.map(c => c.name);
}

function bustCategoryCache() {
  _cache.clear();
}

module.exports = { getCategories, getCategoryNames, bustCategoryCache };
