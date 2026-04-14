/**
 * Deep Feed AI Admin — /api/pitches
 * Counter-angle pitches + editor-initiated research requests (hybrid newsroom Phase B).
 * Gated by the article_pitches feature flag.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { logAudit } = require('../middleware/audit');
const { isFeatureEnabled, getAllFeatures } = require('../lib/feature-registry');

async function requirePitchesEnabled(req, res, next) {
  const on = await isFeatureEnabled(req.tenantId, 'article_pitches').catch(() => false);
  if (!on) return res.status(404).json({ error: 'Pitches feature is not enabled for this tenant' });
  next();
}

async function getMaxOriginalsCap(tenantId) {
  try {
    const feats = await getAllFeatures(tenantId);
    const raw = feats.max_originals_per_source;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 2;
  } catch { return 2; }
}

async function countOriginalsForSource(tenantId, sourceArticleId) {
  // Originals where source_article_ids JSONB contains this id
  const row = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM articles
    WHERE tenant_id = $1
      AND content_type IN ('original', 'deep-dive')
      AND source_article_ids @> $2::jsonb
  `).get(tenantId, JSON.stringify([sourceArticleId]));
  return row?.cnt || 0;
}

// POST /api/pitches — create a pitch (human or agent)
// Body: { source_article_id, angle_summary, pitched_by_writer_id?, requested_by_editor_id? }
router.post('/', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const { source_article_id, angle_summary, pitched_by_writer_id, requested_by_editor_id } = req.body || {};
  if (!source_article_id || !angle_summary) {
    return res.status(400).json({ error: 'source_article_id and angle_summary are required' });
  }
  if (!pitched_by_writer_id && !requested_by_editor_id) {
    return res.status(400).json({ error: 'pitched_by_writer_id or requested_by_editor_id must be set' });
  }
  // Verify source exists and belongs to tenant
  const source = await db.prepare(
    'SELECT id, content_type, writer_id FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(source_article_id, req.tenantId);
  if (!source) return res.status(404).json({ error: 'Source article not found' });

  const row = await db.prepare(`
    INSERT INTO article_pitches
      (tenant_id, source_article_id, pitched_by_writer_id, requested_by_editor_id, angle_summary, status)
    VALUES ($1, $2, $3, $4, $5, 'proposed')
    RETURNING *
  `).get(
    req.tenantId, source_article_id,
    pitched_by_writer_id || null,
    requested_by_editor_id || null,
    angle_summary.slice(0, 2000),
  );

  logAudit(req, 'pitch.created', 'article_pitches', row.id, {
    source_article_id, pitched_by_writer_id, requested_by_editor_id,
  });
  res.status(201).json(row);
}));

// GET /api/pitches?status=proposed|approved|rejected&limit=50
router.get('/', auth, requirePermission('articles.read'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const status = req.query.status || 'proposed';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  const rows = await db.prepare(`
    SELECT p.*,
           a.title   AS source_title,
           a.slug    AS source_slug,
           a.source  AS source_publisher,
           a.source_url,
           a.category AS source_category,
           w.name    AS pitched_by_writer_name,
           u.name    AS requested_by_editor_name
    FROM article_pitches p
    LEFT JOIN articles a ON a.id = p.source_article_id AND a.tenant_id = p.tenant_id
    LEFT JOIN writers w  ON w.id = p.pitched_by_writer_id
    LEFT JOIN users   u  ON u.id = p.requested_by_editor_id
    WHERE p.tenant_id = $1 AND p.status = $2
    ORDER BY p.created_at DESC
    LIMIT $3
  `).all(req.tenantId, status, limit);

  res.json({ pitches: rows, count: rows.length });
}));

// GET /api/pitches/:id
router.get('/:id', auth, requirePermission('articles.read'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const row = await db.prepare(`
    SELECT p.*, a.title AS source_title, a.source AS source_publisher, a.source_url
    FROM article_pitches p
    LEFT JOIN articles a ON a.id = p.source_article_id AND a.tenant_id = p.tenant_id
    WHERE p.id = $1 AND p.tenant_id = $2
  `).get(req.params.id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'Pitch not found' });
  res.json(row);
}));

// POST /api/pitches/:id/approve — body: { note?, override?: boolean }
router.post('/:id/approve', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const { note, override } = req.body || {};
  const pitch = await db.prepare(
    'SELECT * FROM article_pitches WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });
  if (pitch.status !== 'proposed') {
    return res.status(409).json({ error: `Pitch is already ${pitch.status}` });
  }

  // Soft cap check
  const cap = await getMaxOriginalsCap(req.tenantId);
  const currentCount = await countOriginalsForSource(req.tenantId, pitch.source_article_id);
  if (currentCount >= cap && !override) {
    return res.status(409).json({
      error: 'cap_reached',
      message: `This source already has ${currentCount} original(s) (cap: ${cap}). Send override=true with a justification note to approve anyway.`,
      current_count: currentCount,
      cap,
    });
  }

  await db.prepare(`
    UPDATE article_pitches
    SET status = 'approved',
        decided_by_user_id = $1,
        decided_at = NOW(),
        decision_note = $2
    WHERE id = $3 AND tenant_id = $4
  `).run(req.user?.sub || null, note || null, pitch.id, req.tenantId);

  logAudit(req, 'pitch.approved', 'article_pitches', pitch.id, {
    source_article_id: pitch.source_article_id,
    override: !!override,
    prior_original_count: currentCount,
  });
  res.json({ status: 'approved', pitch_id: pitch.id });
}));

// POST /api/pitches/:id/reject — body: { note? }
router.post('/:id/reject', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const { note } = req.body || {};
  const pitch = await db.prepare(
    'SELECT status FROM article_pitches WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });
  if (pitch.status !== 'proposed') {
    return res.status(409).json({ error: `Pitch is already ${pitch.status}` });
  }

  await db.prepare(`
    UPDATE article_pitches
    SET status = 'rejected',
        decided_by_user_id = $1,
        decided_at = NOW(),
        decision_note = $2
    WHERE id = $3 AND tenant_id = $4
  `).run(req.user?.sub || null, note || null, req.params.id, req.tenantId);

  logAudit(req, 'pitch.rejected', 'article_pitches', req.params.id, { note: note || null });
  res.json({ status: 'rejected', pitch_id: Number(req.params.id) });
}));

module.exports = router;
