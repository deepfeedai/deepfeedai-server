/**
 * Deep Feed AI — routes/article-reactions.js
 * Article-level 👍 / ❤️ reactions for signed-in public users.
 *
 * POST /api/article-reactions       { slug, emoji } — toggle (add/swap/remove)
 * GET  /api/article-reactions?slugs=a,b,c           — batch fetch counts + viewer's reaction
 */

'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../db');

const router = express.Router();

const { getSecrets } = require('../lib/secrets');
const ALLOWED_EMOJIS  = new Set(['👍', '❤️']);

/* ── Auth helper ─────────────────────────────────────────────────── */

async function getUserId(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const { userJwtSecret } = await getSecrets();
    const payload = jwt.verify(auth.slice(7), userJwtSecret);
    return payload.sub;
  } catch {
    return null;
  }
}

/* ── POST /api/article-reactions ─────────────────────────────────── */
// Toggle logic:
//   • No existing reaction → INSERT with given emoji
//   • Same emoji → DELETE (toggle off)
//   • Different emoji → UPDATE to new emoji (swap)
// Returns updated counts + viewer's current reaction (null if removed).
router.post('/', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { slug, emoji } = req.body;
  if (!slug || typeof slug !== 'string') return res.status(400).json({ error: 'Missing slug' });
  if (!emoji || !ALLOWED_EMOJIS.has(emoji)) return res.status(400).json({ error: 'Invalid emoji' });
  const cleanSlug = slug.trim().slice(0, 200);

  try {
    const existing = await db.prepare(
      'SELECT id, emoji FROM article_reactions WHERE user_id = $1 AND article_slug = $2 AND tenant_id = $3'
    ).get(userId, cleanSlug, req.tenantId);

    if (!existing) {
      // Add new reaction
      await db.prepare(
        'INSERT INTO article_reactions (user_id, article_slug, emoji, tenant_id) VALUES ($1, $2, $3, $4)'
      ).run(userId, cleanSlug, emoji, req.tenantId);
    } else if (existing.emoji === emoji) {
      // Same emoji — remove (toggle off)
      await db.prepare(
        'DELETE FROM article_reactions WHERE user_id = $1 AND article_slug = $2 AND tenant_id = $3'
      ).run(userId, cleanSlug, req.tenantId);
    } else {
      // Different emoji — swap
      await db.prepare(
        'UPDATE article_reactions SET emoji = $1 WHERE user_id = $2 AND article_slug = $3 AND tenant_id = $4'
      ).run(emoji, userId, cleanSlug, req.tenantId);
    }

    // Return fresh counts for this slug
    const counts = await _getCounts([cleanSlug], userId, req.tenantId);
    res.json({ ok: true, ...counts[cleanSlug] });
  } catch (err) {
    console.error('[article-reactions/toggle]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── GET /api/article-reactions?slugs=a,b,c ─────────────────────── */
// Batch fetch reaction counts for multiple slugs.
// Optionally accepts viewer_id query param for unauthenticated callers
// who want to show their own reaction (pass user id from localStorage).
// viewer_id is NOT verified — it's display-only, not a security boundary.
router.get('/', async (req, res) => {
  const rawSlugs = (req.query.slugs || '').split(',').map(s => s.trim()).filter(Boolean);
  if (rawSlugs.length === 0) return res.json({ reactions: {} });
  if (rawSlugs.length > 100) return res.status(400).json({ error: 'Too many slugs (max 100)' });

  // Viewer id: from JWT (if provided) or viewer_id query param
  let viewerId = await getUserId(req);
  if (!viewerId && req.query.viewer_id) {
    viewerId = parseInt(req.query.viewer_id, 10) || null;
  }

  try {
    const counts = await _getCounts(rawSlugs, viewerId, req.tenantId);
    res.json({ reactions: counts });
  } catch (err) {
    console.error('[article-reactions/batch]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── Helper: fetch counts for an array of slugs ─────────────────── */
async function _getCounts(slugs, viewerId, tenantId) {
  const ph = slugs.map((_, i) => `$${i + 1}`).join(', ');
  const tenantParam = `$${slugs.length + 1}`;

  // Aggregate counts per slug per emoji
  const rows = await db.prepare(`
    SELECT article_slug, emoji, COUNT(*) AS cnt
    FROM article_reactions
    WHERE article_slug IN (${ph}) AND tenant_id = ${tenantParam}
    GROUP BY article_slug, emoji
  `).all(...slugs, tenantId);

  // Viewer's own reactions
  let myMap = {};
  if (viewerId) {
    const myRows = await db.prepare(`
      SELECT article_slug, emoji FROM article_reactions
      WHERE article_slug IN (${ph}) AND tenant_id = ${tenantParam} AND user_id = $${slugs.length + 2}
    `).all(...slugs, tenantId, viewerId);
    for (const r of myRows) myMap[r.article_slug] = r.emoji;
  }

  // Build result map
  const result = {};
  for (const slug of slugs) {
    result[slug] = { '👍': 0, '❤️': 0, myReaction: myMap[slug] || null };
  }
  for (const r of rows) {
    if (result[r.article_slug]) {
      result[r.article_slug][r.emoji] = parseInt(r.cnt, 10);
    }
  }
  return result;
}

module.exports = router;
