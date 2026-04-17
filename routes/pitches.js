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
const { recordEvent } = require('../lib/newsroom-events');
const { notify } = require('../lib/notifications');
const { burnTokensByTarget } = require('../lib/action-tokens');

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
  recordEvent({
    tenantId: req.tenantId, type: 'pitched',
    actorWriterId: pitched_by_writer_id || null,
    actorUserId: requested_by_editor_id || req.user?.sub || null,
    targetArticleId: source_article_id,
    targetPitchId: row.id,
    payload: { angle_summary: row.angle_summary, source_title: source.title || null },
  });
  if (pitched_by_writer_id) {
    require('../lib/presence').setPresence(pitched_by_writer_id, req.tenantId, 'waiting-on-editor').catch(() => {});
  }

  // Fire `pitch_created` notifications to every editor/admin/owner in this tenant.
  // Fire-and-forget — response must not wait on delivery. Flags gate dispatch.
  (async () => {
    try {
      const editors = await db.prepare(`
        SELECT id FROM users
        WHERE tenant_id = $1
          AND is_active = 1
          AND role IN ('owner', 'admin', 'editor')
      `).all(req.tenantId);
      const sourceTitle = source.title || null;
      for (const ed of editors) {
        notify({
          tenantId: req.tenantId,
          userId:   ed.id,
          kind:     'pitch_created',
          title:    'New pitch',
          body:     row.angle_summary,
          payload: {
            pitch_id: row.id,
            source_article_id: source_article_id,
            source_title: sourceTitle,
            angle_summary: row.angle_summary,
            pitched_by_writer_name: null,
          },
          actionable: [
            { label: 'Approve', actionKind: 'pitch.approve', targetId: row.id, targetType: 'pitch' },
            { label: 'Reject',  actionKind: 'pitch.reject',  targetId: row.id, targetType: 'pitch' },
          ],
        }).catch(err => console.error('[pitches] notify pitch_created failed:', err.message));
      }
    } catch (err) {
      console.error('[pitches] pitch_created fanout failed:', err.message);
    }
  })();

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
           u.username AS requested_by_editor_name,
           1 + COALESCE(jsonb_array_length(p.attached_article_ids), 0) AS source_count
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

// PATCH /api/pitches/:id/assign — body: { writer_id }
// Assigns/reassigns the pitching writer on a proposed pitch. Useful for editor-tip
// pitches (created with NULL writer) before approval triggers synthesis.
router.patch('/:id/assign', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const { writer_id } = req.body || {};
  const writerId = parseInt(writer_id, 10);
  if (!writerId) return res.status(400).json({ error: 'writer_id required (numeric)' });

  const pitch = await db.prepare('SELECT * FROM article_pitches WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });
  if (pitch.status !== 'proposed') return res.status(409).json({ error: `Pitch is already ${pitch.status}` });

  const writer = await db.prepare('SELECT id, name FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found in this tenant' });

  await db.prepare(
    'UPDATE article_pitches SET pitched_by_writer_id = $1 WHERE id = $2 AND tenant_id = $3'
  ).run(writerId, pitch.id, req.tenantId);

  logAudit(req, 'pitch.assigned', 'article_pitches', pitch.id, { writer_id: writerId, prior_writer_id: pitch.pitched_by_writer_id });
  res.json({ status: 'assigned', pitch_id: pitch.id, writer: writer });
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

  // Burn any outstanding action tokens for this pitch so the bell won't show
  // stale Approve/Reject buttons when the decision was made directly here.
  burnTokensByTarget('pitch', pitch.id, req.tenantId, req.user?.sub || null).catch(() => {});

  logAudit(req, 'pitch.approved', 'article_pitches', pitch.id, {
    source_article_id: pitch.source_article_id,
    override: !!override,
    prior_original_count: currentCount,
  });
  recordEvent({
    tenantId: req.tenantId, type: 'pitch_approved',
    actorUserId: req.user?.sub || null,
    targetArticleId: pitch.source_article_id,
    targetPitchId: pitch.id,
    payload: { override: !!override, note: note || null },
  });

  // Kick off synthesis in the background unless the editor opted out (e.g.,
  // for editor-tip pitches that need a writer assigned first). Returns
  // immediately so the UI doesn't block on AI generation.
  const skipSynthesis = req.body?.skip_synthesis === true || !pitch.pitched_by_writer_id;
  if (!skipSynthesis) {
    const { synthesizeFromPitch } = require('../lib/synthesis');
    setImmediate(() => {
      synthesizeFromPitch(pitch.id, req.tenantId)
        .then(r => {
          if (r.ok) console.log(`[pitches] pitch #${pitch.id} synthesized → article ${r.article.id}`);
          else console.warn(`[pitches] pitch #${pitch.id} synthesis skipped: ${r.reason}`);
        })
        .catch(err => console.error(`[pitches] pitch #${pitch.id} synthesis failed:`, err.message));
    });
  }

  res.json({
    status: 'approved',
    pitch_id: pitch.id,
    synthesis_queued: !skipSynthesis,
  });
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

  burnTokensByTarget('pitch', Number(req.params.id), req.tenantId, req.user?.sub || null).catch(() => {});

  logAudit(req, 'pitch.rejected', 'article_pitches', req.params.id, { note: note || null });
  recordEvent({
    tenantId: req.tenantId, type: 'pitch_rejected',
    actorUserId: req.user?.sub || null,
    targetPitchId: Number(req.params.id),
    payload: { note: note || null },
  });
  res.json({ status: 'rejected', pitch_id: Number(req.params.id) });
}));

module.exports = router;
