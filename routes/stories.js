/**
 * Deep Feed AI — Public Story Timelines API
 * Mounted at: /api/news (via server.js, alongside news.js and videos.js)
 *
 * GET  /stories                    — list stories (paginated); ?following=true for user's follows
 *                                    ?forArticle=<id> — stories containing a specific article
 * GET  /stories/:slug              — single story + articles + followerCount + isFollowing
 * POST /stories/:slug/follow       — follow a story (user JWT)
 * DELETE /stories/:slug/follow     — unfollow a story (user JWT)
 */
'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { getSecrets }   = require('../lib/secrets');
const {
  listStories,
  getStory,
} = require('../lib/story-timelines');

async function getUserId(req) {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    const { userJwtSecret } = await getSecrets();
    return jwt.verify(auth.slice(7), userJwtSecret).sub;
  } catch { return null; }
}

// GET /stories
router.get('/stories', asyncHandler(async (req, res) => {
  // ?forArticle=<id> — stories containing a specific article (article page widget)
  if (req.query.forArticle) {
    const articleId = parseInt(req.query.forArticle, 10);
    if (!articleId) return res.json({ status: 'ok', stories: [], totalCount: 0, hasMore: false });

    const rows = await db.prepare(`
      SELECT st.id, st.name, st.slug, st.summary, st.status,
             st.article_count, st.image_url, st.last_activity_at, st.created_at,
             a.image_url AS cover_image_url
      FROM story_timeline_articles sta
      JOIN story_timelines st ON st.id = sta.story_id AND st.tenant_id = sta.tenant_id
      LEFT JOIN articles a ON a.id = st.cover_article_id AND a.tenant_id = st.tenant_id
      WHERE sta.article_id = $1 AND sta.tenant_id = $2
        AND st.status != 'archived'
      ORDER BY st.last_activity_at DESC
      LIMIT 5
    `).all(articleId, req.tenantId).catch(() => []);

    return res.json({ status: 'ok', stories: rows.map(r => ({
      ...r,
      imageUrl: r.image_url || r.cover_image_url || null,
    })), totalCount: rows.length, hasMore: false });
  }

  // ?following=true — only stories the authenticated user follows
  if (req.query.following === 'true') {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const limit  = Math.min(parseInt(req.query.limit)  || 20, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);

    const rows = await db.prepare(`
      SELECT st.*, a.image_url AS cover_image_url
      FROM user_story_follows usf
      JOIN story_timelines st ON st.id = usf.story_id AND st.tenant_id = usf.tenant_id
      LEFT JOIN articles a ON a.id = st.cover_article_id AND a.tenant_id = st.tenant_id
      WHERE usf.user_id = $1 AND usf.tenant_id = $2
      ORDER BY st.last_activity_at DESC
      LIMIT $3 OFFSET $4
    `).all(userId, req.tenantId, limit, offset).catch(() => []);

    const total = await db.prepare(
      'SELECT COUNT(*)::int AS cnt FROM user_story_follows WHERE user_id = $1 AND tenant_id = $2'
    ).get(userId, req.tenantId).catch(() => ({ cnt: 0 }));

    const stories = rows.map(r => ({
      id:             r.id,
      name:           r.name,
      slug:           r.slug,
      summary:        r.summary,
      status:         r.status,
      articleCount:   r.article_count,
      imageUrl:       r.image_url || r.cover_image_url || null,
      lastActivityAt: r.last_activity_at,
      createdAt:      r.created_at,
      isFollowing:    true,
    }));

    return res.json({ status: 'ok', stories, totalCount: total?.cnt || 0, hasMore: offset + limit < (total?.cnt || 0) });
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

// GET /stories/catchup — top active stories enriched for the briefing experience
router.get('/stories/catchup', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 20);

  const rows = await db.prepare(`
    SELECT st.id, st.name, st.slug, st.summary, st.status,
           st.article_count, st.image_url, st.last_activity_at,
           a.image_url  AS cover_image_url,
           a.category   AS cover_category,
           w.name       AS writer_name,
           w.slug       AS writer_slug,
           w.avatar_url AS writer_avatar_url,
           w.accent_color AS writer_color
    FROM story_timelines st
    LEFT JOIN articles a  ON a.id = st.cover_article_id AND a.tenant_id = st.tenant_id
    LEFT JOIN writers w   ON w.id = a.writer_id         AND w.tenant_id = a.tenant_id
    WHERE st.tenant_id = $1
      AND st.status    = 'active'
    ORDER BY st.last_activity_at DESC
    LIMIT $2
  `).all(req.tenantId, limit).catch(() => []);

  const now = Date.now();
  const stories = rows.map(r => {
    const hoursSince = (now - new Date(r.last_activity_at).getTime()) / 3600000;
    const count = r.article_count || 0;

    let tier = 'trending';
    if (hoursSince <= 2  && count >= 6) tier = 'breaking';
    else if (hoursSince <= 12 && count >= 3) tier = 'major';

    return {
      id:             r.id,
      name:           r.name,
      slug:           r.slug,
      summary:        r.summary,
      articleCount:   count,
      imageUrl:       r.image_url || r.cover_image_url || null,
      lastActivityAt: r.last_activity_at,
      category:       r.cover_category   || null,
      tier,
      writer: r.writer_name ? {
        name:      r.writer_name,
        slug:      r.writer_slug,
        avatarUrl: r.writer_avatar_url || null,
        color:     r.writer_color      || null,
      } : null,
    };
  });

  res.json({ status: 'ok', stories, count: stories.length });
}));

// GET /stories/:slug
router.get('/stories/:slug', asyncHandler(async (req, res) => {
  const story = await getStory(req.tenantId, req.params.slug);
  if (!story) return res.status(404).json({ error: 'story not found' });

  const followerCount = await db.prepare(
    'SELECT COUNT(*)::int AS cnt FROM user_story_follows WHERE story_id = $1 AND tenant_id = $2'
  ).get(story.id, req.tenantId).then(r => r?.cnt || 0).catch(() => 0);

  let isFollowing = false;
  const userId = await getUserId(req);
  if (userId) {
    const row = await db.prepare(
      'SELECT 1 FROM user_story_follows WHERE user_id = $1 AND story_id = $2'
    ).get(userId, story.id).catch(() => null);
    isFollowing = !!row;
  }

  res.json({ status: 'ok', story: { ...story, followerCount, isFollowing } });
}));

// POST /stories/:slug/follow
router.post('/stories/:slug/follow', asyncHandler(async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const story = await db.prepare(
    'SELECT id FROM story_timelines WHERE slug = $1 AND tenant_id = $2'
  ).get(req.params.slug, req.tenantId);
  if (!story) return res.status(404).json({ error: 'story not found' });

  await db.prepare(
    'INSERT INTO user_story_follows (user_id, story_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING'
  ).run(userId, story.id, req.tenantId);

  const { cnt } = await db.prepare(
    'SELECT COUNT(*)::int AS cnt FROM user_story_follows WHERE story_id = $1 AND tenant_id = $2'
  ).get(story.id, req.tenantId);

  res.json({ ok: true, following: true, followerCount: cnt });
}));

// DELETE /stories/:slug/follow
router.delete('/stories/:slug/follow', asyncHandler(async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const story = await db.prepare(
    'SELECT id FROM story_timelines WHERE slug = $1 AND tenant_id = $2'
  ).get(req.params.slug, req.tenantId);
  if (!story) return res.status(404).json({ error: 'story not found' });

  await db.prepare(
    'DELETE FROM user_story_follows WHERE user_id = $1 AND story_id = $2'
  ).run(userId, story.id);

  const { cnt } = await db.prepare(
    'SELECT COUNT(*)::int AS cnt FROM user_story_follows WHERE story_id = $1 AND tenant_id = $2'
  ).get(story.id, req.tenantId);

  res.json({ ok: true, following: false, followerCount: cnt });
}));

module.exports = router;
