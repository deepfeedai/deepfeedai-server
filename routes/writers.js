/**
 * Deep Feed AI Admin — /api/writers
 * Public read-only routes for writer personas + follow/unfollow for signed-in users.
 */
const express          = require('express');
const jwt              = require('jsonwebtoken');
const router           = express.Router();
const db               = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth }         = require('../middleware/auth');
const { findBestWriter } = require('../lib/writer-assign');

const USER_JWT_SECRET = process.env.USER_JWT_SECRET;

function getUserId(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(authHeader.slice(7), USER_JWT_SECRET);
    return payload.sub;
  } catch {
    return null;
  }
}

// GET /api/writers — public list of writers (includes follower_count)
router.get('/', asyncHandler(async (req, res) => {
  const userId = getUserId(req);

  const writers = await db.prepare(`
    SELECT w.id, w.name, w.slug, w.avatar_url, w.bio,
           COUNT(DISTINCT a.id)::int AS article_count,
           COUNT(DISTINCT wf.id)::int AS follower_count,
           COALESCE(json_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL), '[]') AS beats
    FROM writers w
    LEFT JOIN articles a ON a.writer_id = w.id
    LEFT JOIN writer_follows wf ON wf.writer_id = w.id
    LEFT JOIN writer_beats wb ON wb.writer_id = w.id
    LEFT JOIN categories c ON c.id = wb.category_id
    GROUP BY w.id
    ORDER BY w.name ASC
  `).all();

  // If user is signed in, annotate which writers they follow
  if (userId) {
    const follows = await db.prepare(
      'SELECT writer_id FROM writer_follows WHERE user_id = $1'
    ).all(userId);
    const followSet = new Set(follows.map(f => f.writer_id));
    for (const w of writers) {
      w.is_following = followSet.has(w.id);
    }
  }

  res.json(writers);
}));

// GET /api/writers/following — list of writers the current user follows
router.get('/following', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const writers = await db.prepare(`
    SELECT w.id, w.name, w.slug, w.avatar_url, w.bio,
           COUNT(DISTINCT a.id)::int AS article_count,
           COUNT(DISTINCT wf2.id)::int AS follower_count,
           COALESCE(json_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL), '[]') AS beats
    FROM writer_follows wf
    JOIN writers w ON w.id = wf.writer_id
    LEFT JOIN articles a ON a.writer_id = w.id
    LEFT JOIN writer_follows wf2 ON wf2.writer_id = w.id
    LEFT JOIN writer_beats wb ON wb.writer_id = w.id
    LEFT JOIN categories c ON c.id = wb.category_id
    WHERE wf.user_id = $1
    GROUP BY w.id
    ORDER BY w.name ASC
  `).all(userId);

  for (const w of writers) w.is_following = true;

  res.json(writers);
}));

// GET /api/writers/:slug — single writer by slug
router.get('/:slug', asyncHandler(async (req, res) => {
  const userId = getUserId(req);

  const writer = await db.prepare(`
    SELECT w.id, w.name, w.slug, w.avatar_url, w.bio,
           COUNT(DISTINCT a.id)::int AS article_count,
           COUNT(DISTINCT a.id) FILTER (WHERE a.content_type = 'original')::int AS original_count,
           COUNT(DISTINCT wf.id)::int AS follower_count,
           COALESCE(json_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL), '[]') AS beats
    FROM writers w
    LEFT JOIN articles a ON a.writer_id = w.id
    LEFT JOIN writer_follows wf ON wf.writer_id = w.id
    LEFT JOIN writer_beats wb ON wb.writer_id = w.id
    LEFT JOIN categories c ON c.id = wb.category_id
    WHERE w.slug = $1
    GROUP BY w.id
  `).get(req.params.slug);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  if (userId) {
    const follow = await db.prepare(
      'SELECT id FROM writer_follows WHERE user_id = $1 AND writer_id = $2'
    ).get(userId, writer.id);
    writer.is_following = !!follow;
  }

  res.json(writer);
}));

// POST /api/writers/:slug/follow — follow a writer (user JWT auth)
router.post('/:slug/follow', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const writer = await db.prepare('SELECT id FROM writers WHERE slug = $1').get(req.params.slug);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  await db.prepare(
    'INSERT INTO writer_follows (user_id, writer_id) VALUES ($1, $2) ON CONFLICT (user_id, writer_id) DO NOTHING'
  ).run(userId, writer.id);

  const { cnt } = await db.prepare(
    'SELECT COUNT(*)::int AS cnt FROM writer_follows WHERE writer_id = $1'
  ).get(writer.id);

  res.json({ ok: true, follower_count: parseInt(cnt, 10) });
}));

// DELETE /api/writers/:slug/follow — unfollow a writer (user JWT auth)
router.delete('/:slug/follow', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const writer = await db.prepare('SELECT id FROM writers WHERE slug = $1').get(req.params.slug);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  await db.prepare(
    'DELETE FROM writer_follows WHERE user_id = $1 AND writer_id = $2'
  ).run(userId, writer.id);

  const { cnt } = await db.prepare(
    'SELECT COUNT(*)::int AS cnt FROM writer_follows WHERE writer_id = $1'
  ).get(writer.id);

  res.json({ ok: true, follower_count: parseInt(cnt, 10) });
}));

// POST /api/writers/:id/assign-articles — bulk auto-assign unassigned articles to this writer's beat
router.post('/:id/assign-articles', auth, asyncHandler(async (req, res) => {
  const days = parseInt(req.body.days) || 7;
  const articles = await db.prepare(
    `SELECT id, title, summary, category FROM articles
     WHERE writer_id IS NULL AND is_published = 1 AND is_archived = 0
       AND created_at > NOW() - INTERVAL '${days} days'`
  ).all();

  let assigned = 0;
  for (const article of articles) {
    const writer = await findBestWriter(article);
    if (writer) {
      await db.prepare('UPDATE articles SET writer_id = $1 WHERE id = $2').run(writer.id, article.id);
      assigned++;
    }
  }

  res.json({ assigned });
}));

module.exports = router;
