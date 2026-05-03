/**
 * Deep Feed AI — Public Story Timelines API
 * Mounted at: /api/news (via server.js, alongside news.js and videos.js)
 *
 * GET /stories              — list active stories (paginated)
 *                             ?forArticle=<id> — stories containing a specific article
 * GET /stories/:slug        — single story + articles + intensity sparkline
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const {
  listStories,
  getStory,
} = require('../lib/story-timelines');

// GET /stories
router.get('/stories', asyncHandler(async (req, res) => {
  // ?forArticle=<id> — return stories that contain this article (for article page widget)
  if (req.query.forArticle) {
    const articleId = parseInt(req.query.forArticle, 10);
    if (!articleId) return res.json({ status: 'ok', stories: [], totalCount: 0, hasMore: false });

    const rows = await db.prepare(`
      SELECT st.id, st.name, st.slug, st.summary, st.status,
             st.article_count, st.last_activity_at, st.created_at,
             a.slug  AS cover_slug,
             a.image_url AS cover_image_url
      FROM story_timeline_articles sta
      JOIN story_timelines st ON st.id = sta.story_id AND st.tenant_id = sta.tenant_id
      LEFT JOIN articles a ON a.id = st.cover_article_id AND a.tenant_id = st.tenant_id
      WHERE sta.article_id = $1 AND sta.tenant_id = $2
        AND st.status != 'archived'
      ORDER BY st.last_activity_at DESC
      LIMIT 5
    `).all(articleId, req.tenantId).catch(() => []);

    return res.json({ status: 'ok', stories: rows, totalCount: rows.length, hasMore: false });
  }

  const limit  = Math.min(parseInt(req.query.limit)  || 20, 50);
  const offset = Math.max(parseInt(req.query.offset) || 0,  0);
  const status = req.query.status
    ? String(req.query.status).split(',').map(s => s.trim()).filter(Boolean)
    : ['active'];
  const search = req.query.q ? String(req.query.q).slice(0, 200).trim() : null;

  const result = await listStories(req.tenantId, { status, limit, offset, search });
  res.json({ status: 'ok', ...result });
}));

// GET /stories/:slug
router.get('/stories/:slug', asyncHandler(async (req, res) => {
  const story = await getStory(req.tenantId, req.params.slug);
  if (!story) return res.status(404).json({ error: 'story not found' });
  res.json({ status: 'ok', story });
}));

module.exports = router;
