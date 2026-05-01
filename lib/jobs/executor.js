'use strict';

const { JOB_TYPE } = require('./constants');

// ── Handler registry ─────────────────────────────────────────────────────────
// Each handler receives the full job row and returns a result object (or throws).
// Handlers are lazy-required to avoid circular deps at startup.

const handlers = {

  // ── Content generation ─────────────────────────────────────────────────────

  [JOB_TYPE.SYNTHESIZE]: async (job) => {
    // TODO: migrate synthesis cron to enqueue these jobs
    // Payload: { writerId }
    const { runSynthesisForWriter } = require('../synthesis');
    return await runSynthesisForWriter(job.payload.writerId, { tenantId: job.tenant_id });
  },

  [JOB_TYPE.DEEP_DIVE]: async (job) => {
    // TODO: migrate deep-dive trigger to enqueue these jobs
    // Payload: { articleId, writerId }
    throw new Error('deep_dive handler not yet wired — enqueue not active');
  },

  [JOB_TYPE.TOPIC_BRIEF]: async (job) => {
    // TODO: migrate topic-brief endpoint to enqueue async when needed
    // Payload: { tag }
    throw new Error('topic_brief handler not yet wired — endpoint still handles inline');
  },

  [JOB_TYPE.EDITORIAL_REVIEW]: async (job) => {
    // TODO: migrate editorial.js inline call to enqueue
    // Payload: { articleId }
    const { runEditorialReview } = require('../editorial');
    return await runEditorialReview(job.payload.articleId, job.tenant_id);
  },

  // ── Media ──────────────────────────────────────────────────────────────────

  [JOB_TYPE.GENERATE_IMAGE]: async (job) => {
    // Payload: { articleId, skipThumbnail?, inlineEligible? }
    const { generateAndStoreImage, generateInlineImages } = require('../media-helpers');
    const { articleId, skipThumbnail = false, inlineEligible = false } = job.payload;
    let thumbnailResult = null;
    if (!skipThumbnail) {
      thumbnailResult = await generateAndStoreImage(articleId, job.tenant_id);
    }
    if (inlineEligible) {
      await generateInlineImages(articleId, job.tenant_id).catch(() => {});
    }
    return { articleId, thumbnail: !!thumbnailResult, inline: inlineEligible };
  },

  [JOB_TYPE.GENERATE_AUDIO]: async (job) => {
    // Payload: { articleId }
    const { generateAudioForArticle } = require('../media-helpers');
    const result = await generateAudioForArticle(job.payload.articleId, job.tenant_id);
    return { articleId: job.payload.articleId, generated: !!result };
  },

  [JOB_TYPE.GENERATE_EMBEDDING]: async (job) => {
    // Payload: { articleId }
    const { generateArticleEmbedding } = require('../post-publish');
    const db = require('../../db');
    const article = await db.prepare(
      'SELECT id, title, summary, tldr_overview, content_type FROM articles WHERE id = $1 AND tenant_id = $2'
    ).get(job.payload.articleId, job.tenant_id);
    if (!article) throw new Error(`Article ${job.payload.articleId} not found`);
    await generateArticleEmbedding(article, job.tenant_id);
    return { articleId: job.payload.articleId };
  },

  // ── Writer comms ───────────────────────────────────────────────────────────

  [JOB_TYPE.PITCH_WRITER]: async (job) => {
    // Payload: { pitchId, writerId }
    const { notifyNewPitch } = require('../messaging');
    const db = require('../../db');
    const { pitchId, writerId } = job.payload;
    const [pitch, writer] = await Promise.all([
      db.prepare('SELECT * FROM story_pitches WHERE id = $1 AND tenant_id = $2').get(pitchId, job.tenant_id),
      db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, job.tenant_id),
    ]);
    if (!pitch || !writer) throw new Error(`Pitch ${pitchId} or writer ${writerId} not found`);
    if (pitch.status !== 'pending') return { skipped: true, reason: 'pitch no longer pending' };
    await notifyNewPitch(job.tenant_id, pitch, writer);
    return { pitchId, writerId };
  },

  [JOB_TYPE.WRITER_FOLLOWUP]: async (job) => {
    // Enqueued by pitch_writer handler with scheduledAt = now + 4h.
    // Payload: { pitchId, writerId, followupNumber }
    const { sendMessage } = require('../messaging');
    const db = require('../../db');
    const { pitchId, writerId, followupNumber = 1 } = job.payload;
    const pitch = await db.prepare('SELECT * FROM story_pitches WHERE id = $1 AND tenant_id = $2').get(pitchId, job.tenant_id);
    if (!pitch || pitch.status !== 'pending') return { skipped: true, reason: 'pitch resolved' };
    const writer = await db.prepare('SELECT name FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, job.tenant_id);
    if (!writer) throw new Error(`Writer ${writerId} not found`);
    const reminder = followupNumber === 1
      ? `Reminder: "${pitch.headline}" is still waiting for your response.`
      : `Follow-up #${followupNumber}: pitch "${pitch.headline}" remains open — let your editor know if you need anything.`;
    await sendMessage(job.tenant_id, writerId, reminder);
    return { pitchId, writerId, followupNumber };
  },

  // ── Notifications ──────────────────────────────────────────────────────────
  // All four share the same dispatcher — the channel is in payload.channel.
  // Payload: { channel, notifId, userId, kind, title, body, payload, buttons, allowActions }

  [JOB_TYPE.NOTIFY_TELEGRAM]: async (job) => {
    const { dispatchToChannel } = require('../notifications');
    const { channel, userId, kind, title, body, payload, buttons, allowActions } = job.payload;
    await dispatchToChannel(channel, {
      tenantId: job.tenant_id, userId, kind, title, body,
      payload: payload || {},
      actionable: buttons || [],
      allowActions: !!allowActions,
    });
    return { channel, userId, kind };
  },

  [JOB_TYPE.NOTIFY_DISCORD]: async (job) => {
    const { dispatchToChannel } = require('../notifications');
    const { channel, userId, kind, title, body, payload, buttons, allowActions } = job.payload;
    await dispatchToChannel(channel, {
      tenantId: job.tenant_id, userId, kind, title, body,
      payload: payload || {},
      actionable: buttons || [],
      allowActions: !!allowActions,
    });
    return { channel, userId, kind };
  },

  [JOB_TYPE.NOTIFY_SLACK]: async (job) => {
    const { dispatchToChannel } = require('../notifications');
    const { channel, userId, kind, title, body, payload, buttons, allowActions } = job.payload;
    await dispatchToChannel(channel, {
      tenantId: job.tenant_id, userId, kind, title, body,
      payload: payload || {},
      actionable: buttons || [],
      allowActions: !!allowActions,
    });
    return { channel, userId, kind };
  },

  [JOB_TYPE.NOTIFY_EMAIL]: async (job) => {
    // TODO: wire email channel when Resend is integrated into dispatchToChannel
    // Payload: { to, subject, html, text }
    throw new Error('notify_email handler not yet wired');
  },

  // ── Publishing ─────────────────────────────────────────────────────────────

  [JOB_TYPE.PUBLISH_ARTICLE]: async (job) => {
    // TODO: wire to scheduled-publish flow (scheduledAt in job row controls timing)
    // Payload: { articleId }
    const db = require('../../db');
    const { articleId } = job.payload;
    await db.getPool().query(`
      UPDATE articles
      SET is_published = 1, published_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND is_published = 0
    `, [articleId, job.tenant_id]);
    return { articleId, published: true };
  },

  // ── Ingestion ──────────────────────────────────────────────────────────────

  [JOB_TYPE.INGEST_EXTERNAL]: async (job) => {
    // TODO: migrate external research fetches to enqueue per-source jobs
    // Payload: { source, url, query }
    throw new Error('ingest_external handler not yet wired');
  },

  // ── Maintenance ────────────────────────────────────────────────────────────

  [JOB_TYPE.BACKFILL_TAGS]: async (job) => {
    // Delegates to the existing backfill endpoint logic (extracted into a lib fn when ready)
    // Payload: { limit }
    throw new Error('backfill_tags handler not yet wired');
  },

  [JOB_TYPE.BACKFILL_EMBEDDINGS]: async (job) => {
    // Payload: { limit }
    throw new Error('backfill_embeddings handler not yet wired');
  },

  [JOB_TYPE.MAINTENANCE_PURGE]: async (job) => {
    const { purgeOldJobs } = require('./worker');
    return await purgeOldJobs(job.payload);
  },

  [JOB_TYPE.MAINTENANCE_VACUUM]: async (job) => {
    // No-op — purge is handled by the dedicated cron. This job type exists
    // for ad-hoc admin triggers via the queue.
    return { ok: true };
  },
};

/**
 * Execute a job by dispatching to its registered handler.
 * Throws if no handler is registered (will be caught by worker.js → failJob).
 *
 * @param {object} job - full job row from the database
 * @returns {Promise<object>} - result passed to completeJob()
 */
async function executeJob(job) {
  const handler = handlers[job.job_type];
  if (!handler) throw new Error(`No handler registered for job type "${job.job_type}"`);
  return await handler(job);
}

module.exports = { executeJob };
