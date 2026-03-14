/**
 * Deep Feed AI Admin — /api/categories
 * CRUD for the categories table (replaces site_categories JSON in settings).
 */
const express = require('express');
const router  = express.Router();
const { getPool } = require('../db');
const db          = require('../db');
const { auth: requireAdmin } = require('../middleware/auth');
const { asyncHandler }       = require('../lib/utils');
const { getCategories, bustCategoryCache } = require('../lib/categories');
const { bustSiteConfigCache } = require('../lib/site-config');

// GET /api/categories — public (frontend filter bar needs this)
router.get('/', asyncHandler(async (_req, res) => {
  const cats = await getCategories();
  res.json(cats);
}));

// PUT /api/categories — admin only, bulk save
// Body: array of { id?, name, color, keywords }
router.put('/', requireAdmin, asyncHandler(async (req, res) => {
  const incoming = req.body;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Expected an array of categories' });
  }

  const pool = getPool();

  // Load current categories for rename/delete detection
  const current = await db.prepare('SELECT id, name, color FROM categories ORDER BY sort_order, id').all();
  const currentById = new Map(current.map(c => [c.id, c]));

  // Clean incoming — filter out empty names
  const clean = incoming.filter(c => c.name && c.name.trim());
  const incomingIds = new Set(clean.filter(c => c.id).map(c => c.id));

  // Detect renames and deletes
  for (const old of current) {
    if (incomingIds.has(old.id)) {
      // Exists in new set — check for rename
      const updated = clean.find(c => c.id === old.id);
      if (updated && updated.name !== old.name) {
        await pool.query('UPDATE articles SET category = $1 WHERE category = $2', [updated.name, old.name]);
        await pool.query('UPDATE voices SET beat = $1 WHERE beat = $2', [updated.name, old.name]);
      }
    } else {
      // Deleted — reassign articles and writer beats to first remaining category
      const fallback = clean[0]?.name || 'Industry';
      await pool.query('UPDATE articles SET category = $1 WHERE category = $2', [fallback, old.name]);
      await pool.query('UPDATE voices SET beat = $1 WHERE beat = $2', [fallback, old.name]);
    }
  }

  // Delete removed categories
  const keepIds = clean.filter(c => c.id).map(c => c.id);
  if (keepIds.length > 0) {
    await pool.query(
      `DELETE FROM categories WHERE id != ALL($1::int[])`,
      [keepIds]
    );
  } else if (current.length > 0) {
    // All existing removed (new set has no ids) — delete all, they'll be re-inserted
    await pool.query('DELETE FROM categories');
  }

  // Upsert each category
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    const kw = Array.isArray(c.keywords) ? c.keywords : [];
    const color = c.color || '#94a3b8';

    if (c.id && currentById.has(c.id)) {
      // Update existing
      await pool.query(
        `UPDATE categories SET name = $1, color = $2, keywords = $3, sort_order = $4 WHERE id = $5`,
        [c.name.trim(), color, kw, i, c.id]
      );
    } else {
      // Insert new
      await pool.query(
        `INSERT INTO categories (name, color, keywords, sort_order)
         VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO UPDATE
         SET color = EXCLUDED.color, keywords = EXCLUDED.keywords, sort_order = EXCLUDED.sort_order`,
        [c.name.trim(), color, kw, i]
      );
    }
  }

  bustCategoryCache();
  bustSiteConfigCache();

  // Return fresh list
  const cats = await getCategories();
  res.json(cats);
}));

module.exports = router;
