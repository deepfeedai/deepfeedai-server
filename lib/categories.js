/**
 * Deep Feed AI — lib/categories.js
 * Single source of truth for categories.
 * Reads from `categories` table with 60s cache.
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

  const rows = await db.prepare(
    'SELECT id, name, color, keywords FROM categories ORDER BY sort_order, id'
  ).all();

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
