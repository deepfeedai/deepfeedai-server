/**
 * Deep Feed AI — /api/story-threads
 * Tenant-scoped CRUD for story threads (N3).
 *
 * Endpoints:
 *   GET    /                         — list threads (default: active+dormant)
 *   GET    /:topicTag                — fetch a single thread + its articles
 *   PATCH  /:topicTag                — update name / summary / status / owner
 *   POST   /mark-dormant             — admin-cron-callable: flip stale active → dormant
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAudit } = require('../middleware/audit');
const {
  getThread, listThreads, updateThread, markDormantThreads,
} = require('../lib/story-threads');

// GET / — list threads
router.get('/', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const status = req.query.status
    ? String(req.query.status).split(',').map(s => s.trim()).filter(Boolean)
    : ['active', 'dormant'];
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const ownerWriterId = req.query.owner ? parseInt(req.query.owner, 10) : null;
  const threads = await listThreads(req.tenantId, { status, limit, ownerWriterId });
  res.json({ threads, count: threads.length });
}));

// GET /:topicTag — thread + its articles (latest first)
router.get('/:topicTag', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const thread = await getThread(req.tenantId, req.params.topicTag);
  if (!thread) return res.status(404).json({ error: 'thread not found' });

  const articles = await db.prepare(`
    SELECT id, title, generated_title, slug, summary, content_type,
           writer_id, published_at, importance, source_article_ids
    FROM articles
    WHERE tenant_id = $1 AND topic_tag = $2
      AND content_type IN ('original', 'deep-dive')
      AND is_published = 1
      AND (is_archived = 0 OR is_archived IS NULL)
    ORDER BY published_at DESC
    LIMIT 100
  `).all(req.tenantId, req.params.topicTag).catch(() => []);

  res.json({ thread, articles });
}));

// PATCH /:topicTag — update metadata
router.patch('/:topicTag', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { name, summary, status, ownerWriterId } = req.body || {};
  try {
    const updated = await updateThread(req.tenantId, req.params.topicTag, {
      name, summary, status,
      ownerWriterId: ownerWriterId === undefined ? undefined : ownerWriterId,
    });
    if (!updated) return res.status(404).json({ error: 'thread not found' });
    logAudit(req, 'story_threads.update', 'story_threads', updated.id,
      { topic_tag: req.params.topicTag, patch: { name, summary, status, ownerWriterId } });
    res.json({ thread: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// POST /mark-dormant — flip stale 'active' threads to 'dormant'
router.post('/mark-dormant', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const days = Math.max(parseInt(req.body?.dormancyDays) || 14, 1);
  const result = await markDormantThreads(req.tenantId, { dormancyDays: days });
  logAudit(req, 'story_threads.mark_dormant', 'story_threads', null, { ...result, dormancyDays: days });
  res.json({ ok: true, ...result });
}));

module.exports = router;
