/**
 * Deep Feed AI — routes/favorites.js
 * Article favorites (bookmarks) for signed-in public users.
 *
 * All endpoints require a valid user JWT (Authorization: Bearer <token>).
 *
 * POST /api/favorites          { slug } — toggle (add if absent, remove if present)
 * GET  /api/favorites          — { slugs: [...] } for current user
 * GET  /api/favorites/articles — full article rows for all saved slugs
 */

'use strict';

const express  = require('express');
const jwt      = require('jsonwebtoken');
const db       = require('../db');
const { toSlug } = require('../lib/utils');
const { requireFeature } = require('../middleware/feature-gate');

const router = express.Router();

const { getSecrets } = require('../lib/secrets');

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

/* ── POST /api/favorites ─────────────────────────────────────────── */
// Toggle: adds the favorite if absent, removes it if present.
// Returns { saved: true|false, slug } so the client knows the new state.
router.post('/', requireFeature('favorites'), async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { slug } = req.body;
  if (!slug || typeof slug !== 'string') return res.status(400).json({ error: 'Missing slug' });
  const cleanSlug = slug.trim().slice(0, 200);

  try {
    const existing = await db.prepare(
      'SELECT id FROM article_favorites WHERE user_id = $1 AND article_slug = $2 AND tenant_id = $3'
    ).get(userId, cleanSlug, req.tenantId);

    if (existing) {
      await db.prepare(
        'DELETE FROM article_favorites WHERE user_id = $1 AND article_slug = $2 AND tenant_id = $3'
      ).run(userId, cleanSlug, req.tenantId);
      return res.json({ saved: false, slug: cleanSlug });
    } else {
      await db.prepare(
        'INSERT INTO article_favorites (user_id, article_slug, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING'
      ).run(userId, cleanSlug, req.tenantId);
      return res.json({ saved: true, slug: cleanSlug });
    }
  } catch (err) {
    console.error('[favorites/toggle]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── GET /api/favorites ──────────────────────────────────────────── */
// Returns the list of saved article slugs for the current user.
// Used on sign-in to hydrate the in-memory favorites set in the browser.
router.get('/', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const rows = await db.prepare(
      'SELECT article_slug FROM article_favorites WHERE user_id = $1 AND tenant_id = $2 ORDER BY created_at DESC'
    ).all(userId, req.tenantId);
    res.json({ slugs: rows.map(r => r.article_slug) });
  } catch (err) {
    console.error('[favorites/list]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── GET /api/favorites/articles ─────────────────────────────────── */
// Returns full article rows for all of the user's saved slugs.
// Used to render the "Saved Articles" panel on the main site.
// Slugs are computed from article titles (toSlug) — matched in JS like /api/article does.
router.get('/articles', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const slugRows = await db.prepare(
      'SELECT article_slug FROM article_favorites WHERE user_id = $1 AND tenant_id = $2 ORDER BY created_at DESC'
    ).all(userId, req.tenantId);

    if (slugRows.length === 0) return res.json({ articles: [] });

    const savedSlugs  = slugRows.map(r => r.article_slug);
    const savedSet    = new Set(savedSlugs);
    const savedOrder  = Object.fromEntries(savedSlugs.map((s, i) => [s, i]));

    // Fetch all published non-archived articles and filter to saved slugs
    const allArticles = await db.prepare(`
      SELECT id, title, summary, category, source, source_url, image_url,
             author, is_featured, is_published, is_archived, published_at,
             audio_url, audio_status, media_enabled
      FROM articles
      WHERE is_archived = 0 AND is_published = 1 AND tenant_id = $1
    `).all(req.tenantId);

    const matched = allArticles.filter(a => savedSet.has(toSlug(a.title)));

    // Fetch comment counts for matched articles
    const matchedSlugs = matched.map(a => toSlug(a.title));
    let countMap = {};
    if (matchedSlugs.length > 0) {
      const ph = matchedSlugs.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await db.prepare(`
        SELECT article_slug, COUNT(*) AS cnt FROM comments
        WHERE article_slug IN (${ph}) AND tenant_id = $${matchedSlugs.length + 1} AND is_deleted = 0 AND is_approved = 1
        GROUP BY article_slug
      `).all(...matchedSlugs, req.tenantId);
      for (const r of rows) countMap[r.article_slug] = parseInt(r.cnt, 10);
    }

    // Sort by saved order (newest saved first) and attach comment count + slug
    matched.sort((a, b) => {
      const sa = toSlug(a.title), sb = toSlug(b.title);
      return (savedOrder[sa] ?? 999) - (savedOrder[sb] ?? 999);
    });

    const articles = matched.map(a => {
      const slug = toSlug(a.title);
      return { ...a, slug, comment_count: countMap[slug] ?? 0 };
    });

    res.json({ articles });
  } catch (err) {
    console.error('[favorites/articles]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
