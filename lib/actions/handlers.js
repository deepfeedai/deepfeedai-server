/**
 * Deep Feed AI — Action Handlers Registry (PR-B of notifications/actions)
 *
 * Maps `action_kind` strings to handler functions. Each handler receives the
 * action_tokens row (pre-burn snapshot from verifyAndBurn) plus the Express req,
 * and performs the same DB mutations the existing REST endpoints perform —
 * verifying the target row belongs to the token's tenant before mutating.
 *
 * Handlers return `{ ok, message, data? }`. Errors throw; routes/actions.js
 * maps them to HTTP responses.
 *
 * Intentionally minimal: no framework-style abstractions, just a map + guards.
 */
'use strict';

const db = require('../../db');

/**
 * Ensure a target row's tenant_id matches the token row's tenant_id.
 * Throws 'cross_tenant' on mismatch; 'not_found' if no row.
 */
function assertSameTenant(targetRow, tokenRow, label) {
  if (!targetRow) throw new Error(`${label}_not_found`);
  if (Number(targetRow.tenant_id) !== Number(tokenRow.tenant_id)) {
    throw new Error('cross_tenant');
  }
}

/* ── pitch.approve ──────────────────────────────────────────────────── */
async function pitchApprove(row /*, req */) {
  const pitch = await db.prepare(
    'SELECT * FROM article_pitches WHERE id = $1'
  ).get(row.target_id);
  assertSameTenant(pitch, row, 'pitch');
  if (pitch.status !== 'proposed') {
    return { ok: false, message: `Pitch is already ${pitch.status}` };
  }

  const note = row.payload?.note || null;
  await db.prepare(`
    UPDATE article_pitches
    SET status = 'approved',
        decided_by_user_id = $1,
        decided_at = NOW(),
        decision_note = $2
    WHERE id = $3 AND tenant_id = $4
  `).run(row.user_id, note, pitch.id, row.tenant_id);

  // Mirror routes/pitches.js: kick off synthesis in the background unless
  // the pitch has no writer assigned yet (editor-tip case).
  const skipSynthesis = !pitch.pitched_by_writer_id;
  if (!skipSynthesis) {
    const { synthesizeFromPitch } = require('../synthesis');
    setImmediate(() => {
      synthesizeFromPitch(pitch.id, row.tenant_id)
        .then(r => {
          if (r?.ok) console.log(`[actions] pitch #${pitch.id} synthesized → article ${r.article.id}`);
          else console.warn(`[actions] pitch #${pitch.id} synthesis skipped: ${r?.reason}`);
        })
        .catch(err => console.error(`[actions] pitch #${pitch.id} synthesis failed:`, err.message));
    });
  }

  try {
    const { recordEvent } = require('../newsroom-events');
    recordEvent({
      tenantId: row.tenant_id, type: 'pitch_approved',
      actorUserId: row.user_id,
      targetArticleId: pitch.source_article_id,
      targetPitchId: pitch.id,
      payload: { note, via: 'action_token' },
    });
  } catch { /* non-fatal */ }

  return {
    ok: true,
    message: 'Pitch approved',
    data: { pitch_id: pitch.id, synthesis_queued: !skipSynthesis },
  };
}

/* ── pitch.reject ───────────────────────────────────────────────────── */
async function pitchReject(row) {
  const pitch = await db.prepare(
    'SELECT * FROM article_pitches WHERE id = $1'
  ).get(row.target_id);
  assertSameTenant(pitch, row, 'pitch');
  if (pitch.status !== 'proposed') {
    return { ok: false, message: `Pitch is already ${pitch.status}` };
  }
  const note = row.payload?.note || null;
  await db.prepare(`
    UPDATE article_pitches
    SET status = 'rejected',
        decided_by_user_id = $1,
        decided_at = NOW(),
        decision_note = $2
    WHERE id = $3 AND tenant_id = $4
  `).run(row.user_id, note, pitch.id, row.tenant_id);

  try {
    const { recordEvent } = require('../newsroom-events');
    recordEvent({
      tenantId: row.tenant_id, type: 'pitch_rejected',
      actorUserId: row.user_id,
      targetPitchId: pitch.id,
      payload: { note, via: 'action_token' },
    });
  } catch { /* non-fatal */ }

  return { ok: true, message: 'Pitch rejected', data: { pitch_id: pitch.id } };
}

/* ── pitch.assign ───────────────────────────────────────────────────── */
async function pitchAssign(row) {
  const pitch = await db.prepare(
    'SELECT * FROM article_pitches WHERE id = $1'
  ).get(row.target_id);
  assertSameTenant(pitch, row, 'pitch');
  if (pitch.status !== 'proposed') {
    return { ok: false, message: `Pitch is already ${pitch.status}` };
  }
  const writerId = parseInt(row.payload?.writer_id, 10);
  if (!writerId) throw new Error('writer_id_required');

  const writer = await db.prepare(
    'SELECT id, name, tenant_id FROM writers WHERE id = $1'
  ).get(writerId);
  assertSameTenant(writer, row, 'writer');

  await db.prepare(
    'UPDATE article_pitches SET pitched_by_writer_id = $1 WHERE id = $2 AND tenant_id = $3'
  ).run(writerId, pitch.id, row.tenant_id);

  return {
    ok: true,
    message: `Pitch assigned to ${writer.name}`,
    data: { pitch_id: pitch.id, writer_id: writerId },
  };
}

/* ── article.publish ────────────────────────────────────────────────── */
async function articlePublish(row) {
  const article = await db.prepare(
    'SELECT * FROM articles WHERE id = $1'
  ).get(row.target_id);
  assertSameTenant(article, row, 'article');

  await db.prepare(`
    UPDATE articles
    SET status = 'published', is_published = 1, is_archived = 0,
        published_at = COALESCE(published_at, NOW()),
        reviewed_by = COALESCE(reviewed_by, $1), reviewed_at = COALESCE(reviewed_at, NOW()),
        updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3
  `).run(row.user_id, article.id, row.tenant_id);

  try {
    const { onArticlePublished } = require('../post-publish');
    onArticlePublished(article.id, row.tenant_id).catch(() => {});
  } catch { /* non-fatal */ }

  return { ok: true, message: 'Article published', data: { article_id: article.id } };
}

/* ── article.revise ─────────────────────────────────────────────────── */
async function articleRevise(row) {
  const article = await db.prepare(
    'SELECT * FROM articles WHERE id = $1'
  ).get(row.target_id);
  assertSameTenant(article, row, 'article');

  const feedback = row.payload?.feedback || null;
  await db.prepare(`
    UPDATE articles
    SET status = 'revision_requested',
        is_published = 0,
        review_notes = $1,
        editorial_revision_count = COALESCE(editorial_revision_count, 0) + 1,
        updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3
  `).run(feedback, article.id, row.tenant_id);

  return {
    ok: true,
    message: 'Revision requested',
    data: { article_id: article.id },
  };
}

/* ── article.kill ───────────────────────────────────────────────────── */
async function articleKill(row) {
  const article = await db.prepare(
    'SELECT * FROM articles WHERE id = $1'
  ).get(row.target_id);
  assertSameTenant(article, row, 'article');

  await db.prepare(`
    UPDATE articles
    SET status = 'killed', is_published = 0, is_archived = 1,
        archived_at = COALESCE(archived_at, NOW()),
        updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
  `).run(article.id, row.tenant_id);

  return { ok: true, message: 'Article killed', data: { article_id: article.id } };
}

/* ── notification.dismiss ───────────────────────────────────────────── */
async function notificationDismiss(row) {
  const notif = await db.prepare(
    'SELECT id, tenant_id, user_id FROM user_notifications WHERE id = $1'
  ).get(row.target_id);
  assertSameTenant(notif, row, 'notification');
  if (Number(notif.user_id) !== Number(row.user_id)) {
    throw new Error('cross_user');
  }
  await db.prepare(
    'UPDATE user_notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2'
  ).run(notif.id, row.user_id);
  return { ok: true, message: 'Notification dismissed', data: { id: notif.id } };
}

const HANDLERS = {
  'pitch.approve': pitchApprove,
  'pitch.reject':  pitchReject,
  'pitch.assign':  pitchAssign,
  'article.publish': articlePublish,
  'article.revise':  articleRevise,
  'article.kill':    articleKill,
  'notification.dismiss': notificationDismiss,
};

function getHandler(actionKind) {
  return HANDLERS[actionKind] || null;
}

module.exports = { HANDLERS, getHandler };
