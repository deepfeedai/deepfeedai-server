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

const crypto = require('crypto');
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
  if (article.status === 'published') {
    return { ok: false, message: 'Already published', data: { article_id: article.id } };
  }

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
  if (article.status === 'revision_requested' || article.status === 'draft') {
    return { ok: false, message: 'Already in revision', data: { article_id: article.id } };
  }

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
  if (article.status === 'killed') {
    return { ok: false, message: 'Already killed', data: { article_id: article.id } };
  }

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

/* ── editor_brief.ingest_and_pitch ──────────────────────────────────── */
/**
 * Second-stage confirmation for editor-commissioned stories. The payload
 * attached to the minted token carries the already-vetted source list, the
 * chosen writer, the angle summary, and the original brief topic — so this
 * handler can run the ingest + pitch creation atomically without re-invoking
 * the LLM.
 *
 * Payload shape (set by vetAndIngestWithConfirmation):
 *   {
 *     sources:       [{ url, title, publisher, snippet, published, ... }],
 *     writer_id:     number | null,
 *     angle:         string,
 *     brief_topic:   string,
 *     requested_by_editor_id: number | null,
 *   }
 */
async function editorBriefIngestAndPitch(row) {
  const payload = row.payload || {};
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const angle = String(payload.angle || '').trim();
  const briefTopic = String(payload.brief_topic || '').trim();
  const writerId = payload.writer_id ? parseInt(payload.writer_id, 10) : null;
  const requestedByEditorId = payload.requested_by_editor_id
    ? parseInt(payload.requested_by_editor_id, 10)
    : (row.user_id || null);

  if (!sources.length) throw new Error('editor_brief_no_sources');
  if (angle.length < 10) throw new Error('editor_brief_angle_too_short');

  // Cross-tenant guard for the chosen writer
  if (writerId) {
    const writer = await db.prepare(
      'SELECT id, tenant_id FROM writers WHERE id = $1'
    ).get(writerId);
    assertSameTenant(writer, row, 'writer');
  }

  const { toSlug } = require('../utils');
  const { detectCategory } = require('../categorize');
  let generateEmbedding = null, isPgvectorAvailable = null;
  try {
    const emb = require('../embeddings');
    generateEmbedding = emb.generateEmbedding;
    isPgvectorAvailable = emb.isPgvectorAvailable;
  } catch { /* embeddings optional */ }
  const pgvector = isPgvectorAvailable ? await isPgvectorAvailable().catch(() => false) : false;

  // Ingest each source as a curated article (skip duplicates).
  const ingested = [];
  const skipped = [];
  for (const item of sources) {
    if (!item || !item.url || !item.title) { skipped.push({ url: item?.url, reason: 'missing_url_or_title' }); continue; }
    try {
      const dup = await db.prepare(
        'SELECT id FROM articles WHERE tenant_id = $1 AND source_url = $2 LIMIT 1'
      ).get(row.tenant_id, item.url);
      if (dup) { skipped.push({ url: item.url, reason: 'duplicate', existing_id: dup.id }); continue; }

      const title = String(item.title).slice(0, 500);
      const summary = String(item.snippet || '').slice(0, 1000);
      const publisher = String(item.publisher || item.source || 'Unknown').slice(0, 200);
      // Append random suffix to avoid (title -> slug) collisions when multiple
      // ingest paths or multiple briefs converge on the same headline.
      const baseSlug = toSlug(title) || 'enrich';
      const slug = `${baseSlug}-${crypto.randomBytes(3).toString('hex')}`;
      let category = 'General';
      try { category = await detectCategory({ title, contentSnippet: summary }, { tenantId: row.tenant_id }) || 'General'; } catch {}

      const inserted = await db.prepare(`
        INSERT INTO articles
          (tenant_id, title, slug, summary, source, source_url, category, content_type, ingest_source, is_published, status, published_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'curated', 'enrichment', 1, 'published', NOW(), NOW(), NOW())
        RETURNING id
      `).get(row.tenant_id, title, slug, summary, publisher, item.url, category);

      if (inserted) {
        ingested.push({ id: inserted.id, title, url: item.url });
        if (pgvector && generateEmbedding) {
          generateEmbedding(row.tenant_id, `${title}\n\n${summary}`)
            .then(v => db.prepare('UPDATE articles SET embedding = $1::vector WHERE id = $2 AND tenant_id = $3')
              .run(JSON.stringify(v), inserted.id, row.tenant_id))
            .catch(() => {});
        }
      }
    } catch (err) {
      skipped.push({ url: item.url, reason: `insert_failed: ${err.message}` });
    }
  }

  if (!ingested.length) {
    return { ok: false, message: 'No sources could be ingested (all duplicates or invalid)', data: { skipped } };
  }

  // Create the pitch. Primary source = first successfully ingested article;
  // the rest are tracked via source_article_ids-style attachment in decision_note.
  const primarySourceId = ingested[0].id;
  const attachedIds = ingested.slice(1).map(i => i.id);

  const pitch = await db.prepare(`
    INSERT INTO article_pitches
      (tenant_id, source_article_id, pitched_by_writer_id, requested_by_editor_id, angle_summary, status)
    VALUES ($1, $2, $3, $4, $5, 'proposed')
    RETURNING id
  `).get(
    row.tenant_id,
    primarySourceId,
    writerId || null,
    requestedByEditorId || null,
    angle.slice(0, 2000),
  );

  if (attachedIds.length) {
    try {
      await db.prepare(`
        UPDATE article_pitches
        SET decision_note = COALESCE(decision_note, '') || E'\\n[editor_brief]: additional sources ' || $1
        WHERE id = $2 AND tenant_id = $3
      `).run(attachedIds.join(','), pitch.id, row.tenant_id);
    } catch { /* non-fatal */ }
  }

  try {
    const { recordEvent } = require('../newsroom-events');
    recordEvent({
      tenantId: row.tenant_id,
      type: 'editor_brief_commissioned',
      actorUserId: row.user_id,
      targetArticleId: primarySourceId,
      targetPitchId: pitch.id,
      payload: {
        brief_topic: briefTopic,
        writer_id: writerId,
        ingested_ids: ingested.map(i => i.id),
        via: 'action_token',
      },
    });
  } catch { /* non-fatal */ }

  return {
    ok: true,
    message: `Commissioned: ingested ${ingested.length} source${ingested.length === 1 ? '' : 's'}, created pitch #${pitch.id}`,
    data: {
      pitch_id: pitch.id,
      ingested_ids: ingested.map(i => i.id),
      skipped,
    },
  };
}

/* ── editor_brief.cancel ────────────────────────────────────────────── */
async function editorBriefCancel(row) {
  try {
    const { recordEvent } = require('../newsroom-events');
    recordEvent({
      tenantId: row.tenant_id,
      type: 'editor_brief_cancelled',
      actorUserId: row.user_id,
      payload: { brief_topic: row.payload?.brief_topic || null, via: 'action_token' },
    });
  } catch { /* non-fatal */ }
  return { ok: true, message: 'Editor brief cancelled', data: { brief_topic: row.payload?.brief_topic || null } };
}

/* ── breaking.dispatch ──────────────────────────────────────────────── */
async function breakingDispatch(row) {
  const article = await db.prepare(
    'SELECT id, tenant_id FROM articles WHERE id = $1'
  ).get(row.target_id);
  assertSameTenant(article, row, 'article');
  const { queueBreakingDispatch } = require('../breaking-dispatch');
  const result = await queueBreakingDispatch(article.id, row.tenant_id, row.user_id);
  return {
    ok: true,
    message: `Breaking alert queued (${result.subscriber_count} subscriber${result.subscriber_count === 1 ? '' : 's'})`,
    data: result,
  };
}

/* ── breaking.skip ──────────────────────────────────────────────────── */
async function breakingSkip(row) {
  const article = await db.prepare(
    'SELECT id, tenant_id FROM articles WHERE id = $1'
  ).get(row.target_id);
  assertSameTenant(article, row, 'article');
  const { recordBreakingSkipped } = require('../breaking-dispatch');
  await recordBreakingSkipped(article.id, row.tenant_id, row.user_id);
  return { ok: true, message: 'Breaking alert skipped', data: { article_id: article.id } };
}

/* ── style_pivot.approve ────────────────────────────────────────────── */
/**
 * Approve a designer-proposed style pivot. Writes the new `family` (+ optional
 * notes) to settings.art_direction as a JSON object so future image generations
 * pick it up automatically.
 */
async function stylePivotApprove(row) {
  const payload = row.payload || {};
  const family = String(payload.family || '').trim();
  const notes = payload.notes ? String(payload.notes).slice(0, 2000) : null;
  if (!family) throw new Error('style_pivot_family_required');

  const { ALL_FAMILY_NAMES } = require('../prompts/style-library');
  if (!ALL_FAMILY_NAMES.includes(family)) {
    throw new Error('style_pivot_unknown_family');
  }

  const value = JSON.stringify({ style: family, notes: notes || undefined });

  await db.prepare(`
    INSERT INTO settings (tenant_id, key, value)
    VALUES ($1, 'art_direction', $2)
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = $2
  `).run(row.tenant_id, value);

  try {
    await db.prepare(`
      INSERT INTO audit_log (tenant_id, user_id, action, resource, resource_id, details, created_at)
      VALUES ($1, $2, 'designer.style_pivot_approved', 'settings', 'art_direction', $3, NOW())
    `).run(row.tenant_id, row.user_id, JSON.stringify({ family, notes, via: 'action_token' }));
  } catch { /* non-fatal */ }

  return {
    ok: true,
    message: `Style pivot approved: ${family}`,
    data: { family, notes },
  };
}

/* ── style_pivot.reject ─────────────────────────────────────────────── */
async function stylePivotReject(row) {
  const payload = row.payload || {};
  try {
    await db.prepare(`
      INSERT INTO audit_log (tenant_id, user_id, action, resource, resource_id, details, created_at)
      VALUES ($1, $2, 'designer.style_pivot_rejected', 'settings', 'art_direction', $3, NOW())
    `).run(row.tenant_id, row.user_id, JSON.stringify({ family: payload.family || null, via: 'action_token' }));
  } catch { /* non-fatal */ }
  return { ok: true, message: 'Style pivot rejected', data: { family: payload.family || null } };
}

const HANDLERS = {
  'pitch.approve': pitchApprove,
  'pitch.reject':  pitchReject,
  'pitch.assign':  pitchAssign,
  'article.publish': articlePublish,
  'article.revise':  articleRevise,
  'article.kill':    articleKill,
  'notification.dismiss': notificationDismiss,
  'editor_brief.ingest_and_pitch': editorBriefIngestAndPitch,
  'editor_brief.cancel': editorBriefCancel,
  'breaking.dispatch': breakingDispatch,
  'breaking.skip':     breakingSkip,
  'style_pivot.approve': stylePivotApprove,
  'style_pivot.reject':  stylePivotReject,
};

function getHandler(actionKind) {
  return HANDLERS[actionKind] || null;
}

module.exports = { HANDLERS, getHandler };
