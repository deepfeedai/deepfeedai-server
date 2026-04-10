/**
 * Admin Pitches API — manage writer agent story pitches.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getPool } = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');

// GET /api/admin/pitches — list pitches
router.get('/', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const { status = 'pending', writer_id, limit: lim, offset: off } = req.query;
  const limit = Math.min(parseInt(lim) || 50, 200);
  const offset = Math.max(parseInt(off) || 0, 0);

  let query = `
    SELECT sp.*, w.name AS writer_name, w.avatar_url AS writer_avatar_url
    FROM story_pitches sp
    LEFT JOIN writers w ON w.id = sp.writer_id
    WHERE sp.tenant_id = $1
  `;
  let countQuery = 'SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE tenant_id = $1';
  const params = [req.tenantId];
  const countParams = [req.tenantId];

  if (status && status !== 'all') {
    params.push(status);
    countParams.push(status);
    query += ` AND sp.status = $${params.length}`;
    countQuery += ` AND status = $${countParams.length}`;
  }
  if (writer_id) {
    params.push(parseInt(writer_id));
    countParams.push(parseInt(writer_id));
    query += ` AND sp.writer_id = $${params.length}`;
    countQuery += ` AND writer_id = $${countParams.length}`;
  }

  query += ' ORDER BY sp.priority DESC, sp.created_at DESC';
  params.push(limit);
  query += ` LIMIT $${params.length}`;
  params.push(offset);
  query += ` OFFSET $${params.length}`;

  const [result, countResult] = await Promise.all([
    getPool().query(query, params),
    getPool().query(countQuery, countParams),
  ]);

  // Parse JSONB fields
  const pitches = result.rows.map(p => ({
    ...p,
    source_article_ids: typeof p.source_article_ids === 'string' ? JSON.parse(p.source_article_ids) : (p.source_article_ids || []),
    memory_refs: typeof p.memory_refs === 'string' ? JSON.parse(p.memory_refs) : (p.memory_refs || []),
  }));

  res.json({
    pitches,
    total: parseInt(countResult.rows[0]?.cnt || 0),
    hasMore: offset + pitches.length < parseInt(countResult.rows[0]?.cnt || 0),
  });
}));

// POST /api/admin/pitches/:id/approve — approve and trigger synthesis
router.post('/:id/approve', auth, requirePermission('articles.create'), asyncHandler(async (req, res) => {
  const pitch = await db.prepare(
    'SELECT * FROM story_pitches WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);

  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });
  if (pitch.status !== 'pending') return res.status(400).json({ error: 'Pitch already resolved' });

  // Mark as approved
  await db.prepare(
    "UPDATE story_pitches SET status = 'approved', resolved_at = NOW() WHERE id = $1"
  ).run(pitch.id);

  // Get source articles for synthesis
  const sourceIds = typeof pitch.source_article_ids === 'string'
    ? JSON.parse(pitch.source_article_ids) : (pitch.source_article_ids || []);

  let synthesized = null;
  if (sourceIds.length >= 2) {
    try {
      // Build a cluster from the pitched source articles and synthesize
      const { synthesizeCluster } = require('../lib/synthesis');
      const sources = await db.prepare(
        `SELECT * FROM articles WHERE id = ANY($1) AND tenant_id = $2`
      ).all(sourceIds, req.tenantId);

      if (sources.length >= 2) {
        const writer = await db.prepare(
          'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
        ).get(pitch.writer_id, req.tenantId);

        if (writer) {
          const cluster = {
            topic: pitch.headline,
            articles: sources,
          };
          synthesized = await synthesizeCluster(cluster, writer, req.tenantId);

          // Update pitch with synthesized article reference
          if (synthesized) {
            await db.prepare(
              "UPDATE story_pitches SET status = 'synthesized' WHERE id = $1"
            ).run(pitch.id);
          }
        }
      }
    } catch (err) {
      console.error('[pitches] synthesis from pitch failed:', err.message);
    }
  }

  res.json({
    status: 'ok',
    pitch: { ...pitch, status: synthesized ? 'synthesized' : 'approved' },
    article: synthesized ? { id: synthesized.id, title: synthesized.title, slug: synthesized.slug } : null,
  });
}));

// POST /api/admin/pitches/:id/dismiss — dismiss a pitch
router.post('/:id/dismiss', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const result = await db.prepare(
    "UPDATE story_pitches SET status = 'dismissed', resolved_at = NOW() WHERE id = $1 AND tenant_id = $2 AND status = 'pending' RETURNING *"
  ).get(req.params.id, req.tenantId);

  if (!result) return res.status(404).json({ error: 'Pitch not found or already resolved' });
  res.json({ status: 'ok', pitch: result });
}));

// DELETE /api/admin/pitches/:id
router.delete('/:id', auth, requirePermission('articles.delete'), asyncHandler(async (req, res) => {
  await db.prepare(
    'DELETE FROM story_pitches WHERE id = $1 AND tenant_id = $2'
  ).run(req.params.id, req.tenantId);
  res.json({ status: 'ok' });
}));

// GET /api/admin/pitches/count — pending count for badge
router.get('/count', auth, asyncHandler(async (req, res) => {
  const row = await db.prepare(
    "SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE tenant_id = $1 AND status = 'pending'"
  ).get(req.tenantId);
  res.json({ count: row?.cnt || 0 });
}));

// GET /api/admin/newsroom — recent newsroom messages
router.get('/newsroom', auth, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const messages = await getPool().query(`
    SELECT nm.*,
      fw.name AS from_writer_name, fw.avatar_url AS from_writer_avatar,
      tw.name AS to_writer_name
    FROM newsroom_messages nm
    LEFT JOIN writers fw ON fw.id = nm.from_writer_id
    LEFT JOIN writers tw ON tw.id = nm.to_writer_id
    WHERE nm.tenant_id = $1
    ORDER BY nm.created_at DESC
    LIMIT $2
  `, [req.tenantId, limit]);

  res.json({ messages: messages.rows });
}));

module.exports = router;
