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
  // Verify writer belongs to this tenant (cross-tenant data leak prevention)
  if (pitched_by_writer_id) {
    const w = await db.prepare('SELECT id FROM writers WHERE id = $1 AND tenant_id = $2').get(pitched_by_writer_id, req.tenantId);
    if (!w) return res.status(404).json({ error: 'Writer not found' });
  }

  // Verify source exists and belongs to tenant
  const source = await db.prepare(
    'SELECT id, title, content_type, writer_id FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(source_article_id, req.tenantId);
  if (!source) return res.status(404).json({ error: 'Source article not found' });

  // Pitching off an original/deep-dive creates circular synthesis — require curated sources
  if (['original', 'deep-dive', 'video'].includes(source.content_type)) {
    return res.status(400).json({ error: `Cannot pitch from a ${source.content_type} article — source must be a curated article` });
  }

  let writerName = null;
  if (pitched_by_writer_id) {
    const w = await db.prepare('SELECT name FROM writers WHERE id = $1 AND tenant_id = $2').get(pitched_by_writer_id, req.tenantId);
    writerName = w?.name || null;
  }

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
    isPublic: true,
    headline: writerName
      ? `${writerName} is investigating: ${(row.angle_summary || source.title || '').slice(0, 160)}`
      : `New investigation: ${(row.angle_summary || source.title || '').slice(0, 180)}`,
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
            pitched_by_writer_name: writerName,
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

// GET /api/pitches
//   status=proposed                  single status (default)
//   status=proposed,approved         comma-separated list (OR match)
//   assigned=true|false|any          filter on pitched_by_writer_id presence
//   orphaned=1                       shortcut: non-terminal status AND no writer
//                                    — the "approved but never assigned" case
//                                    that hides commissioned pitches from the
//                                    normal flow
//   limit=50
router.get('/', auth, requirePermission('articles.read'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  const orphaned = req.query.orphaned === '1' || req.query.orphaned === 'true';
  let statuses;
  if (orphaned) {
    // Non-terminal statuses — rejected/published are excluded so the orphan
    // list only surfaces pitches that are actually stuck.
    statuses = ['proposed', 'approved'];
  } else {
    const rawStatus = String(req.query.status || 'proposed').trim();
    statuses = rawStatus.split(',').map(s => s.trim()).filter(Boolean);
    if (!statuses.length) statuses = ['proposed'];
  }

  const assigned = (req.query.assigned || (orphaned ? 'false' : 'any')).toString().toLowerCase();

  const params = [req.tenantId, statuses, limit];
  let assignedClause = '';
  if (assigned === 'true') assignedClause = 'AND p.pitched_by_writer_id IS NOT NULL';
  else if (assigned === 'false') assignedClause = 'AND p.pitched_by_writer_id IS NULL';

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
    WHERE p.is_editor_assignment=false AND p.tenant_id = $1 AND p.is_editor_assignment=false AND p.status = ANY($2::text[])
      ${assignedClause}
    ORDER BY p.created_at DESC
    LIMIT $3
  `).all(...params);

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


// POST /api/pitches/auto-assign-orphans
// Bulk recovery: iterates all orphaned pitches (non-terminal status AND no
// writer) and auto-assigns each. Returns per-pitch results so the UI can
// report a summary. Capped at 50 to protect budget / DB.
// IMPORTANT: must be registered BEFORE /:id routes so Express doesn't treat
// "auto-assign-orphans" as an :id value.
router.post('/auto-assign-orphans', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT p.id, p.status, p.source_article_id, p.spawned_article_id
    FROM article_pitches p
    WHERE p.is_editor_assignment=false AND p.tenant_id = $1
      AND p.status IN ('proposed', 'approved')
      AND p.pitched_by_writer_id IS NULL
    ORDER BY p.created_at ASC
    LIMIT 50
  `).all(req.tenantId);

  if (!rows.length) return res.json({ assigned: 0, skipped: 0, results: [] });

  const { findWriterWithFallback } = require('../lib/writer-assign');
  const { synthesizeFromPitch } = require('../lib/synthesis');
  const results = [];
  let assigned = 0;
  let skipped = 0;

  for (const p of rows) {
    try {
      const source = await db.prepare(
        'SELECT id, title, summary, category, source FROM articles WHERE id = $1 AND tenant_id = $2'
      ).get(p.source_article_id, req.tenantId);
      if (!source) { skipped++; results.push({ id: p.id, skipped: 'source_missing' }); continue; }

      const writer = await findWriterWithFallback(source, req.tenantId);
      if (!writer || !writer.id) { skipped++; results.push({ id: p.id, skipped: 'no_writer' }); continue; }

      await db.prepare(
        'UPDATE article_pitches SET pitched_by_writer_id = $1 WHERE id = $2 AND tenant_id = $3'
      ).run(writer.id, p.id, req.tenantId);
      assigned++;
      results.push({ id: p.id, writer_id: writer.id, writer_name: writer.name });

      if (p.status === 'approved' && !p.spawned_article_id) {
        setImmediate(() => {
          synthesizeFromPitch(p.id, req.tenantId).catch(err => console.error(`[pitches] bulk synth #${p.id} failed:`, err.message));
        });
      }
    } catch (err) {
      skipped++;
      results.push({ id: p.id, skipped: 'error', message: err.message });
    }
  }

  logAudit(req, 'pitch.bulk_auto_assign', 'article_pitches', null, { assigned, skipped, total: rows.length });
  res.json({ assigned, skipped, results });
}));


// POST /api/pitches/:id/auto-assign
// One-click recovery: run findBestWriter against the pitch's source article
// and assign the winner. Works on both 'proposed' and 'approved' pitches;
// when applied to an already-approved pitch with no spawned article yet,
// synthesis is queued immediately.
router.post('/:id/auto-assign', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const pitch = await db.prepare('SELECT * FROM article_pitches WHERE id = $1 AND tenant_id = $2 AND is_editor_assignment=false').get(req.params.id, req.tenantId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });
  if (pitch.status !== 'proposed' && pitch.status !== 'approved') {
    return res.status(409).json({ error: `Pitch is already ${pitch.status}` });
  }

  const source = await db.prepare(
    'SELECT id, title, summary, category, source FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(pitch.source_article_id, req.tenantId);
  if (!source) return res.status(404).json({ error: 'Source article not found' });

  // Use the fallback variant so a missing beat/keyword match doesn't leave
  // the editor with a "no eligible writer" error when the tenant has
  // writers available. Falls back to the least-busy non-system writer.
  const { findWriterWithFallback } = require('../lib/writer-assign');
  const writer = await findWriterWithFallback(source, req.tenantId);
  if (!writer || !writer.id) {
    return res.status(409).json({ error: 'no_eligible_writer', message: 'No eligible writers in this tenant — add a writer or assign manually.' });
  }

  await db.prepare(
    'UPDATE article_pitches SET pitched_by_writer_id = $1 WHERE id = $2 AND tenant_id = $3'
  ).run(writer.id, pitch.id, req.tenantId);

  logAudit(req, 'pitch.auto_assigned', 'article_pitches', pitch.id, {
    writer_id: writer.id,
    prior_writer_id: pitch.pitched_by_writer_id,
    prior_status: pitch.status,
    via: 'manual_button',
  });

  let synthesisQueued = false;
  if (pitch.status === 'approved' && !pitch.spawned_article_id) {
    synthesisQueued = true;
    const { synthesizeFromPitch } = require('../lib/synthesis');
    setImmediate(() => {
      synthesizeFromPitch(pitch.id, req.tenantId)
        .then(r => {
          if (r.ok) console.log(`[pitches] auto-assigned orphan #${pitch.id} synthesized → article ${r.article.id}`);
          else console.warn(`[pitches] auto-assigned orphan #${pitch.id} synthesis skipped: ${r.reason}`);
        })
        .catch(err => console.error(`[pitches] auto-assigned orphan #${pitch.id} synthesis failed:`, err.message));
    });
  }

  res.json({
    status: 'assigned',
    pitch_id: pitch.id,
    writer: { id: writer.id, name: writer.name },
    synthesis_queued: synthesisQueued,
  });
}));



// PATCH /api/pitches/:id/assign — body: { writer_id }
// Assigns/reassigns the pitching writer. Valid for both 'proposed' and
// 'approved' pitches — the latter is the recovery path for commissioned
// pitches that were approved without a writer (the "orphan" case). When
// assigning to an already-approved orphan with no spawned article yet,
// synthesis is triggered so the pitch unsticks.
router.patch('/:id/assign', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const { writer_id } = req.body || {};
  const writerId = parseInt(writer_id, 10);
  if (!writerId) return res.status(400).json({ error: 'writer_id required (numeric)' });

  const pitch = await db.prepare('SELECT * FROM article_pitches WHERE id = $1 AND tenant_id = $2 AND is_editor_assignment=false').get(req.params.id, req.tenantId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });
  if (pitch.status !== 'proposed' && pitch.status !== 'approved') {
    return res.status(409).json({ error: `Pitch is already ${pitch.status}` });
  }

  const writer = await db.prepare('SELECT id, name FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found in this tenant' });

  await db.prepare(
    'UPDATE article_pitches SET pitched_by_writer_id = $1 WHERE id = $2 AND tenant_id = $3'
  ).run(writerId, pitch.id, req.tenantId);

  logAudit(req, 'pitch.assigned', 'article_pitches', pitch.id, { writer_id: writerId, prior_writer_id: pitch.pitched_by_writer_id, prior_status: pitch.status });

  // Orphan recovery: if the pitch was already approved without a writer and
  // no article has been spawned yet, kick off synthesis now that we have one.
  // Guard: respect the persisted skip_synthesis flag so editors who explicitly
  // opted out during approval don't get synthesis triggered by a later assign.
  let synthesisQueued = false;
  if (pitch.status === 'approved' && !pitch.spawned_article_id && !pitch.skip_synthesis) {
    synthesisQueued = true;
    const { synthesizeFromPitch } = require('../lib/synthesis');
    setImmediate(() => {
      synthesizeFromPitch(pitch.id, req.tenantId)
        .then(r => {
          if (r.ok) console.log(`[pitches] orphan pitch #${pitch.id} synthesized → article ${r.article.id}`);
          else console.warn(`[pitches] orphan pitch #${pitch.id} synthesis skipped: ${r.reason}`);
        })
        .catch(err => console.error(`[pitches] orphan pitch #${pitch.id} synthesis failed:`, err.message));
    });
  }

  res.json({ status: 'assigned', pitch_id: pitch.id, writer: writer, synthesis_queued: synthesisQueued });
}));

// POST /api/pitches/:id/approve — body: { note?, override?: boolean }
router.post('/:id/approve', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const { note, override } = req.body || {};
  const pitch = await db.prepare(
    'SELECT * FROM article_pitches WHERE id = $1 AND tenant_id = $2 AND is_editor_assignment=false'
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

  // Persist skip_synthesis so the intent survives a later /assign call
  const persistSkip = req.body?.skip_synthesis === true;
  await db.prepare(`
    UPDATE article_pitches
    SET status = 'approved',
        decided_by_user_id = $1,
        decided_at = NOW(),
        decision_note = $2,
        skip_synthesis = $3
    WHERE id = $4 AND tenant_id = $5
  `).run(req.user?.sub || null, note || null, persistSkip, pitch.id, req.tenantId);

  // Burn any outstanding action tokens for this pitch so the bell won't show
  // stale Approve/Reject buttons when the decision was made directly here.
  burnTokensByTarget('pitch', pitch.id, req.tenantId, req.user?.sub || null).catch(() => {});

  // Auto-assign a writer when approving a pitch that was commissioned/tipped
  // without one. Previously this left the pitch stranded — synthesis was
  // skipped (because there's no writer) and the pitch quietly vanished from
  // normal flow. Now we run findBestWriter against the source article and
  // assign it in place; only falls through to the no-writer skip path when
  // the tenant has zero eligible writers.
  let assignedWriterId = pitch.pitched_by_writer_id;
  let autoAssigned = false;
  if (!assignedWriterId) {
    try {
      const source = await db.prepare(
        'SELECT id, title, summary, category, source FROM articles WHERE id = $1 AND tenant_id = $2'
      ).get(pitch.source_article_id, req.tenantId);
      if (source) {
        const { findWriterWithFallback } = require('../lib/writer-assign');
        const writer = await findWriterWithFallback(source, req.tenantId);
        if (writer && writer.id) {
          await db.prepare(
            'UPDATE article_pitches SET pitched_by_writer_id = $1 WHERE id = $2 AND tenant_id = $3'
          ).run(writer.id, pitch.id, req.tenantId);
          assignedWriterId = writer.id;
          autoAssigned = true;
          logAudit(req, 'pitch.auto_assigned', 'article_pitches', pitch.id, { writer_id: writer.id, via: 'approve' });
        }
      }
    } catch (err) {
      console.error('[pitches] auto-assign failed on approve:', err.message);
    }
  }

  logAudit(req, 'pitch.approved', 'article_pitches', pitch.id, {
    source_article_id: pitch.source_article_id,
    override: !!override,
    prior_original_count: currentCount,
    auto_assigned_writer_id: autoAssigned ? assignedWriterId : null,
  });
  recordEvent({
    tenantId: req.tenantId, type: 'pitch_approved',
    actorUserId: req.user?.sub || null,
    targetArticleId: pitch.source_article_id,
    targetPitchId: pitch.id,
    payload: { override: !!override, note: note || null, auto_assigned_writer_id: autoAssigned ? assignedWriterId : null },
  });

  // Kick off synthesis in the background unless the editor opted out (persisted
  // to DB above) OR we still don't have a writer. Re-read skip_synthesis from
  // the DB value we just wrote so the check is authoritative.
  const skipSynthesis = persistSkip || !assignedWriterId;
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
    auto_assigned_writer_id: autoAssigned ? assignedWriterId : null,
  });
}));

// POST /api/pitches/:id/retry-synthesis — re-queue synthesis for a stuck approved pitch
router.post('/:id/retry-synthesis', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const pitch = await db.prepare(
    'SELECT * FROM article_pitches WHERE id = $1 AND tenant_id = $2 AND is_editor_assignment=false'
  ).get(req.params.id, req.tenantId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });
  if (pitch.status !== 'approved') return res.status(409).json({ error: `Pitch is ${pitch.status}, not approved` });
  if (pitch.spawned_article_id) return res.status(409).json({ error: 'Pitch already has a spawned article' });

  const { synthesizeFromPitch } = require('../lib/synthesis');
  setImmediate(() => {
    synthesizeFromPitch(pitch.id, req.tenantId)
      .then(r => {
        if (r.ok) console.log(`[pitches] retry #${pitch.id} synthesized → article ${r.article.id}`);
        else console.warn(`[pitches] retry #${pitch.id} synthesis skipped: ${r.reason}`);
      })
      .catch(err => console.error(`[pitches] retry #${pitch.id} synthesis failed:`, err.message));
  });

  res.json({ status: 'ok', queued: true });
}));

// POST /api/pitches/:id/reject — body: { note? }
router.post('/:id/reject', auth, requirePermission('articles.update'), requirePitchesEnabled, asyncHandler(async (req, res) => {
  const { note } = req.body || {};
  const pitch = await db.prepare(
    'SELECT status FROM article_pitches WHERE id = $1 AND tenant_id = $2 AND is_editor_assignment=false'
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
