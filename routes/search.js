/**
 * Deep Feed AI — Public search endpoint
 * GET /api/search?q=<term>
 * Returns articles, stories, and writers matching the query (tenant-scoped).
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');

router.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (q.length < 2) return res.json({ articles: [], stories: [], writers: [] });

  const like      = `%${q}%`;
  const tenantId  = req.tenantId;

  const [articles, stories, writers] = await Promise.all([
    db.prepare(`
      SELECT a.slug, a.title, a.category, a.image_url, a.published_at,
             w.name AS writer_name
      FROM articles a
      LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
        AND a.is_published = 1
        AND (a.title ILIKE $2 OR a.summary ILIKE $2)
      ORDER BY a.published_at DESC
      LIMIT 5
    `).all(tenantId, like).catch(() => []),

    db.prepare(`
      SELECT slug, name, summary, article_count
      FROM story_timelines
      WHERE tenant_id = $1
        AND status = 'active'
        AND (name ILIKE $2 OR summary ILIKE $2)
      ORDER BY last_activity_at DESC
      LIMIT 3
    `).all(tenantId, like).catch(() => []),

    db.prepare(`
      SELECT DISTINCT w.slug, w.name, w.avatar_url,
             COUNT(DISTINCT a.id)::int AS article_count
      FROM writers w
      LEFT JOIN articles a ON a.writer_id = w.id AND a.tenant_id = w.tenant_id
        AND a.is_published = 1
        AND a.content_type IN ('original', 'deep-dive')
      LEFT JOIN writer_beats wb ON wb.writer_id = w.id AND wb.tenant_id = w.tenant_id
      LEFT JOIN categories c ON c.id = wb.category_id AND c.tenant_id = w.tenant_id
      WHERE w.tenant_id = $1
        AND COALESCE(w.role, 'writer') NOT IN ('editor', 'designer', 'copy-editor')
        AND (w.name ILIKE $2 OR w.bio ILIKE $2 OR c.name ILIKE $2)
      GROUP BY w.id, w.slug, w.name, w.avatar_url
      ORDER BY article_count DESC
      LIMIT 3
    `).all(tenantId, like).catch(() => []),
  ]);

  res.json({
    articles: articles.map(a => ({
      slug:        a.slug,
      title:       a.title,
      category:    a.category    || null,
      writerName:  a.writer_name || null,
      imageUrl:    a.image_url   || null,
      publishedAt: a.published_at,
    })),
    stories: stories.map(s => ({
      slug:         s.slug,
      name:         s.name,
      summary:      s.summary      || null,
      articleCount: s.article_count || 0,
    })),
    writers: writers.map(w => ({
      slug:         w.slug,
      name:         w.name,
      avatarUrl:    w.avatar_url   || null,
      articleCount: w.article_count || 0,
    })),
  });
}));

module.exports = router;
