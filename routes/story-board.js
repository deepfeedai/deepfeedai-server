/**
 * Deep Feed AI Admin — /api/story-board
 * Node-graph visualization of synthesized articles and their source connections.
 *
 * GET  /          — graph data (nodes + edges)
 * GET  /pitches   — pitch graph data (pitch nodes + connected articles)
 * POST /links     — create manual source↔original link
 * DELETE /links/:id — remove a manual link
 * GET  /search    — search articles for the link picker
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');

// All story-board routes require authentication
router.use(auth);

// ── GET / — graph data ────────────────────────────────────────────────────────

router.get('/', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const days     = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 365);
  const limit    = Math.min(Math.max(parseInt(req.query.limit) || 60, 1), 200);
  const category = req.query.category || null;
  const writerId = req.query.writer_id ? parseInt(req.query.writer_id) : null;
  const status   = req.query.status || 'published'; // 'published' | 'draft' | 'all'

  // ── Phase A: fetch originals in time window ───────────────────────────────
  const conditions = [
    `a.tenant_id = $1`,
    `a.content_type IN ('original','deep-dive')`,
    `(a.is_archived = 0 OR a.is_archived IS NULL)`,
  ];
  const params = [tenantId];
  let idx = 2;

  if (status === 'draft') {
    conditions.push(`a.published_at IS NULL`);
  } else {
    params.push(days); // $idx = days
    const timeCondition = status === 'all'
      ? `(a.published_at >= NOW() - make_interval(days => $${idx}) OR a.published_at IS NULL)`
      : `a.published_at >= NOW() - make_interval(days => $${idx})`;
    conditions.push(timeCondition);
    idx++;
  }

  if (category) {
    conditions.push(`a.category = $${idx}`);
    params.push(category);
    idx++;
  }
  if (writerId) {
    conditions.push(`a.writer_id = $${idx}`);
    params.push(writerId);
    idx++;
  }
  params.push(limit);

  const originalsRows = await db.prepare(`
    SELECT a.id, a.title, a.summary, a.category, a.source, a.source_url,
           a.image_url, a.published_at, a.content_type, a.source_article_ids,
           a.editorial_score, a.writer_id,
           w.name AS writer_name, w.accent_color, w.avatar_url AS writer_avatar
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = $1
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.published_at DESC LIMIT $${idx}
  `).all(...params);

  // ── Phase B: collect source IDs from JSONB ────────────────────────────────
  const originalIds = originalsRows.map(r => r.id);
  const sourceIdSet = new Set();

  for (const row of originalsRows) {
    const sources = row.source_article_ids || [];
    const list = typeof sources === 'string' ? JSON.parse(sources) : sources;
    for (const s of (Array.isArray(list) ? list : [])) {
      if (s && s.id) sourceIdSet.add(parseInt(s.id));
    }
  }

  // ── Phase C: fetch manual links ───────────────────────────────────────────
  const manualLinks = originalIds.length
    ? await db.prepare(
        `SELECT id, original_article_id, source_article_id
         FROM article_links WHERE tenant_id = $1 AND original_article_id = ANY($2::int[])`
      ).all(tenantId, originalIds)
    : [];

  for (const link of manualLinks) {
    sourceIdSet.add(link.source_article_id);
  }

  // ── Phase D: fetch source article rows ───────────────────────────────────
  const sourceMap = new Map();
  if (sourceIdSet.size) {
    const sourceRows = await db.prepare(
      `SELECT id, title, summary, category, source, source_url, image_url, published_at
       FROM articles WHERE tenant_id = $1 AND id = ANY($2::int[])`
    ).all(tenantId, [...sourceIdSet]);
    for (const s of sourceRows) sourceMap.set(s.id, s);
  }

  // ── Build nodes + edges ───────────────────────────────────────────────────
  const nodes = [];
  const edges = [];
  const originalIdSet = new Set(originalIds);

  for (const row of originalsRows) {
    nodes.push({
      id: `a_${row.id}`,
      data: {
        articleId: row.id,
        type: 'original',
        title: row.title || '',
        summary: row.summary || '',
        category: row.category || '',
        source: row.source || '',
        imageUrl: row.image_url || '',
        publishedAt: row.published_at,
        editorialScore: row.editorial_score ?? null,
        writerId: row.writer_id,
        writerName: row.writer_name || '',
        writerAvatar: row.writer_avatar || '',
        accentColor: row.accent_color || '#6366f1',
        contentType: row.content_type,
      },
    });

    // Auto edges from JSONB
    const sources = row.source_article_ids || [];
    const list = typeof sources === 'string' ? JSON.parse(sources) : sources;
    for (const s of (Array.isArray(list) ? list : [])) {
      if (!s || !s.id) continue;
      const srcId = parseInt(s.id);
      if (!sourceMap.has(srcId)) continue; // orphaned reference — skip
      edges.push({
        id: `e_${row.id}_${srcId}_auto`,
        data: { source: `a_${row.id}`, target: `a_${srcId}`, linkType: 'auto' },
      });
    }
  }

  // Manual edges
  for (const link of manualLinks) {
    if (!sourceMap.has(link.source_article_id)) continue;
    edges.push({
      id: `e_${link.original_article_id}_${link.source_article_id}_manual`,
      data: {
        source: `a_${link.original_article_id}`,
        target: `a_${link.source_article_id}`,
        linkType: 'manual',
        linkId: link.id,
      },
    });
  }

  // Source nodes (deduplicated)
  const addedSources = new Set();
  for (const edge of edges) {
    const targetId = parseInt(edge.data.target.replace('a_', ''));
    if (addedSources.has(targetId) || originalIdSet.has(targetId)) continue;
    const s = sourceMap.get(targetId);
    if (!s) continue;
    addedSources.add(targetId);
    nodes.push({
      id: `a_${s.id}`,
      data: {
        articleId: s.id,
        type: 'source',
        title: s.title || '',
        summary: s.summary || '',
        category: s.category || '',
        source: s.source || '',
        sourceUrl: s.source_url || '',
        imageUrl: s.image_url || '',
        publishedAt: s.published_at,
      },
    });
  }

  res.json({
    nodes,
    edges,
    stats: {
      originals: originalsRows.length,
      sources: addedSources.size,
      edges: edges.length,
    },
  });
}));

// ── GET /pitches — pitch graph data ──────────────────────────────────────────

router.get('/pitches', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const days     = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 365);
  const limit    = Math.min(Math.max(parseInt(req.query.limit) || 60, 1), 200);
  const status   = req.query.status || '';   // 'proposed'|'approved'|'rejected'|''=all
  const writerId = req.query.writer_id ? parseInt(req.query.writer_id) : null;

  // ── Phase A: fetch pitches in time window ─────────────────────────────────
  const conditions = [
    `p.tenant_id = $1`,
    `p.created_at >= NOW() - make_interval(days => $2)`,
  ];
  const params = [tenantId, days];
  let idx = 3;

  if (status && status !== 'all') {
    conditions.push(`p.status = $${idx}`);
    params.push(status);
    idx++;
  }
  if (writerId) {
    conditions.push(`p.pitched_by_writer_id = $${idx}`);
    params.push(writerId);
    idx++;
  }
  params.push(limit);

  const pitches = await db.prepare(`
    SELECT p.id, p.status, p.angle_summary, p.created_at, p.decided_at, p.decision_note,
           p.source_article_id, p.spawned_article_id, p.attached_article_ids,
           p.pitched_by_writer_id,
           w.name AS writer_name, w.accent_color, w.avatar_url AS writer_avatar
    FROM article_pitches p
    LEFT JOIN writers w ON w.id = p.pitched_by_writer_id AND w.tenant_id = $1
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.created_at DESC LIMIT $${idx}
  `).all(...params);

  // ── Phase B: collect all referenced article IDs ───────────────────────────
  const articleIdSet = new Set();
  for (const p of pitches) {
    if (p.source_article_id)  articleIdSet.add(p.source_article_id);
    if (p.spawned_article_id) articleIdSet.add(p.spawned_article_id);
    const attached = p.attached_article_ids || [];
    const list = typeof attached === 'string' ? JSON.parse(attached) : attached;
    for (const id of (Array.isArray(list) ? list : [])) {
      if (id) articleIdSet.add(parseInt(id));
    }
  }

  // ── Phase C: batch-fetch referenced articles ──────────────────────────────
  const articleMap = new Map();
  if (articleIdSet.size) {
    const articles = await db.prepare(
      `SELECT id, title, summary, category, source, source_url, image_url, published_at, content_type
       FROM articles WHERE tenant_id = $1 AND id = ANY($2::int[])`
    ).all(tenantId, [...articleIdSet]);
    for (const a of articles) articleMap.set(a.id, a);
  }

  // ── Phase D: build nodes + edges ─────────────────────────────────────────
  const nodes = [];
  const edges = [];
  const addedArticles = new Set();

  const statusColors = { proposed: '#f59e0b', approved: '#22c55e', rejected: '#6b7280' };

  function addArticleNode(a, nodeType) {
    if (addedArticles.has(a.id)) return;
    addedArticles.add(a.id);
    nodes.push({
      id: `a_${a.id}`,
      data: {
        articleId: a.id,
        type: nodeType,
        title: a.title || '',
        summary: a.summary || '',
        category: a.category || '',
        source: a.source || '',
        sourceUrl: a.source_url || '',
        imageUrl: a.image_url || '',
        publishedAt: a.published_at,
        contentType: a.content_type || '',
      },
    });
  }

  for (const p of pitches) {
    nodes.push({
      id: `p_${p.id}`,
      data: {
        pitchId: p.id,
        type: 'pitch',
        status: p.status || 'proposed',
        title: p.angle_summary ? p.angle_summary.slice(0, 120) : 'Untitled pitch',
        summary: p.angle_summary || '',
        writerId: p.pitched_by_writer_id,
        writerName: p.writer_name || '',
        writerAvatar: p.writer_avatar || '',
        accentColor: p.accent_color || statusColors[p.status] || '#f59e0b',
        createdAt: p.created_at,
        decidedAt: p.decided_at,
        decisionNote: p.decision_note || '',
      },
    });

    // Edge: pitch → triggering source article
    if (p.source_article_id && articleMap.has(p.source_article_id)) {
      const a = articleMap.get(p.source_article_id);
      addArticleNode(a, 'source');
      edges.push({
        id: `e_p${p.id}_src_${p.source_article_id}`,
        data: { source: `p_${p.id}`, target: `a_${p.source_article_id}`, linkType: 'source' },
      });
    }

    // Edges: pitch → attached enrichment articles
    const attached = p.attached_article_ids || [];
    const list = typeof attached === 'string' ? JSON.parse(attached) : attached;
    for (const id of (Array.isArray(list) ? list : [])) {
      const aId = parseInt(id);
      if (!aId || !articleMap.has(aId) || aId === p.source_article_id) continue;
      addArticleNode(articleMap.get(aId), 'source');
      edges.push({
        id: `e_p${p.id}_att_${aId}`,
        data: { source: `p_${p.id}`, target: `a_${aId}`, linkType: 'attached' },
      });
    }

    // Edge: pitch → spawned original (outcome)
    if (p.spawned_article_id && articleMap.has(p.spawned_article_id)) {
      const a = articleMap.get(p.spawned_article_id);
      addArticleNode(a, 'original');
      edges.push({
        id: `e_p${p.id}_spawned_${p.spawned_article_id}`,
        data: { source: `p_${p.id}`, target: `a_${p.spawned_article_id}`, linkType: 'spawned' },
      });
    }
  }

  const byStatus = { proposed: 0, approved: 0, rejected: 0 };
  for (const p of pitches) byStatus[p.status] = (byStatus[p.status] || 0) + 1;

  res.json({
    nodes,
    edges,
    stats: {
      pitches: pitches.length,
      proposed: byStatus.proposed,
      approved: byStatus.approved,
      rejected: byStatus.rejected,
      articles: addedArticles.size,
    },
  });
}));

// ── POST /links ───────────────────────────────────────────────────────────────

router.post('/links', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const { original_article_id, source_article_id } = req.body || {};

  const origId = parseInt(original_article_id);
  const srcId  = parseInt(source_article_id);

  if (!origId || !srcId || isNaN(origId) || isNaN(srcId)) {
    return res.status(400).json({ error: 'original_article_id and source_article_id are required' });
  }
  if (origId === srcId) {
    return res.status(400).json({ error: 'An article cannot link to itself' });
  }

  // Validate both articles belong to tenant
  const [orig, src] = await Promise.all([
    db.prepare('SELECT id, content_type FROM articles WHERE id = $1 AND tenant_id = $2').get(origId, tenantId),
    db.prepare('SELECT id FROM articles WHERE id = $1 AND tenant_id = $2').get(srcId, tenantId),
  ]);

  if (!orig) return res.status(404).json({ error: 'Original article not found' });
  if (!src)  return res.status(404).json({ error: 'Source article not found' });
  if (!['original', 'deep-dive'].includes(orig.content_type)) {
    return res.status(400).json({ error: 'Target must be an original or deep-dive article' });
  }

  try {
    const link = await db.prepare(
      `INSERT INTO article_links (original_article_id, source_article_id, tenant_id, created_by_user_id)
       VALUES ($1, $2, $3, $4) RETURNING *`
    ).get(origId, srcId, tenantId, req.userId || null);
    res.status(201).json(link);
  } catch (err) {
    if (err.code === '23505' || /unique/i.test(err.message)) {
      return res.status(409).json({ error: 'Link already exists' });
    }
    throw err;
  }
}));

// ── DELETE /links/:id ─────────────────────────────────────────────────────────

router.delete('/links/:id', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const linkId   = parseInt(req.params.id);

  if (!linkId) return res.status(400).json({ error: 'Invalid link id' });

  const link = await db.prepare(
    'SELECT id FROM article_links WHERE id = $1 AND tenant_id = $2'
  ).get(linkId, tenantId);

  if (!link) return res.status(404).json({ error: 'Link not found' });

  await db.prepare('DELETE FROM article_links WHERE id = $1 AND tenant_id = $2').run(linkId, tenantId);
  res.json({ ok: true });
}));

// ── GET /search ───────────────────────────────────────────────────────────────

router.get('/search', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const q        = (req.query.q || '').trim();
  const limit    = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);

  if (q.length < 2) return res.json([]);

  const rows = await db.prepare(
    `SELECT id, title, category, content_type, published_at, source
     FROM articles
     WHERE tenant_id = $1
       AND (is_archived = 0 OR is_archived IS NULL)
       AND LOWER(title) LIKE LOWER($2)
     ORDER BY published_at DESC LIMIT $3`
  ).all(tenantId, `%${q}%`, limit);

  res.json(rows);
}));

module.exports = router;
