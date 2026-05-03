/**
 * Deep Feed AI — GET /api/news/videos
 * Public endpoint — paginated list of YouTube video articles.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');

router.get('/videos', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const limit    = Math.min(parseInt(req.query.limit)  || 30, 100);
  const offset   = parseInt(req.query.offset) || 0;
  const category = req.query.category || null;

  const params = [tenantId];
  const conditions = [
    'a.tenant_id = $1',
    "a.embed_type = 'youtube'",
    'a.is_published = 1',
    '(a.is_archived = 0 OR a.is_archived IS NULL)',
  ];

  if (category) {
    params.push(category);
    conditions.push(`a.category = $${params.length}`);
  }

  const where = conditions.join(' AND ');

  // Total count + distinct categories in one round-trip
  const [countRow, categoryRows] = await Promise.all([
    db.prepare(`SELECT COUNT(*)::int AS total FROM articles a WHERE ${where}`)
      .get(...params),
    db.prepare(
      `SELECT DISTINCT a.category FROM articles a
       WHERE a.tenant_id = $1 AND a.embed_type = 'youtube' AND a.is_published = 1
         AND (a.is_archived = 0 OR a.is_archived IS NULL)
         AND a.category IS NOT NULL AND a.category != 'Uncategorized'
       ORDER BY a.category`
    ).all(tenantId),
  ]);

  const total      = countRow?.total || 0;
  const categories = categoryRows.map(r => r.category);

  params.push(limit, offset);
  const items = await db.prepare(`
    SELECT a.id, a.title, a.slug, a.summary, a.tldr_overview,
           a.category, a.source, a.source_url, a.image_url,
           a.published_at, a.embed_url, a.embed_type,
           a.video_duration, a.video_key_moments, a.video_transcript,
           a.topic_tag, a.importance,
           w.name AS writer_name, w.slug AS writer_slug, w.avatar_url AS writer_avatar_url
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id
    WHERE ${where}
    ORDER BY a.published_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `).all(...params);

  res.json({
    status:     'ok',
    items:      items.map(serializeVideo),
    totalCount: total,
    hasMore:    offset + items.length < total,
    categories,
  });
}));

function serializeVideo(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) {
      out[k] = v.toISOString();
    } else if (k === 'video_key_moments' && typeof v === 'string') {
      try { out[k] = JSON.parse(v); } catch { out[k] = null; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = router;
