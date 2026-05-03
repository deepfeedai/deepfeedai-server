/**
 * Deep Feed AI — Admin Story Timelines API
 * Mounted at: /api/story-timelines (auth-guarded)
 *
 * GET    /                     — list all stories (any status)
 * POST   /                     — manually create a story
 * GET    /:id                  — single story with articles
 * PATCH  /:id                  — update name / summary / status
 * DELETE /:id                  — archive a story
 * POST   /:id/regenerate       — re-run Maxwell name + summary
 * POST   /:id/articles         — manually add article to story
 * DELETE /:id/articles/:aid    — remove article from story
 * PATCH  /:id/articles/:aid    — toggle is_key_moment
 * POST   /backfill             — one-shot backfill from existing articles
 * POST   /lifecycle            — run dormant/archive lifecycle (cron-callable)
 */
'use strict';

const express = require('express');
const router  = express.Router();
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  listStories,
  getStoryById,
  createStory,
  updateStory,
  addArticleToStory,
  removeArticleFromStory,
  setKeyMoment,
  generateStoryNameAndSummary,
  runLifecycle,
  backfill,
} = require('../lib/story-timelines');

// All routes require auth
router.use(auth);

// GET / — list stories
router.get('/', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
  const offset = Math.max(parseInt(req.query.offset) || 0,  0);
  const status = req.query.status
    ? String(req.query.status).split(',').map(s => s.trim()).filter(Boolean)
    : ['active', 'dormant', 'archived'];

  const result = await listStories(req.tenantId, { status, limit, offset });
  res.json(result);
}));

// POST / — create story manually
router.post('/', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { name, summary, articleIds } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const story = await createStory(req.tenantId, {
    name,
    summary,
    articleIds: Array.isArray(articleIds) ? articleIds.map(Number).filter(Boolean) : [],
  });
  res.status(201).json({ story });
}));

// GET /:id
router.get('/:id', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const story = await getStoryById(req.tenantId, parseInt(req.params.id));
  if (!story) return res.status(404).json({ error: 'story not found' });
  res.json({ story });
}));

// PATCH /:id — update metadata
router.patch('/:id', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { name, summary, status } = req.body || {};
  const updated = await updateStory(req.tenantId, parseInt(req.params.id), { name, summary, status });
  if (!updated) return res.status(404).json({ error: 'story not found' });
  res.json({ story: updated });
}));

// DELETE /:id — archive
router.delete('/:id', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const updated = await updateStory(req.tenantId, parseInt(req.params.id), { status: 'archived' });
  if (!updated) return res.status(404).json({ error: 'story not found' });
  res.json({ ok: true });
}));

// POST /:id/regenerate — re-run Maxwell
router.post('/:id/regenerate', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const storyId = parseInt(req.params.id);
  generateStoryNameAndSummary(storyId, req.tenantId).catch(() => {});
  res.json({ ok: true, message: 'regeneration queued' });
}));

// POST /:id/articles — add article
router.post('/:id/articles', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { articleId, isKeyMoment = false } = req.body || {};
  if (!articleId) return res.status(400).json({ error: 'articleId is required' });
  await addArticleToStory(parseInt(req.params.id), parseInt(articleId), req.tenantId, { isKeyMoment });
  res.json({ ok: true });
}));

// DELETE /:id/articles/:aid — remove article
router.delete('/:id/articles/:aid', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  await removeArticleFromStory(parseInt(req.params.id), parseInt(req.params.aid), req.tenantId);
  res.json({ ok: true });
}));

// PATCH /:id/articles/:aid — toggle key moment
router.patch('/:id/articles/:aid', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { isKeyMoment } = req.body || {};
  await setKeyMoment(parseInt(req.params.id), parseInt(req.params.aid), req.tenantId, !!isKeyMoment);
  res.json({ ok: true });
}));

// POST /backfill — one-shot backfill
router.post('/backfill', requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const dryRun = req.query.dry === 'true' || req.body?.dryRun === true;
  const result = await backfill(req.tenantId, { dryRun });
  res.json({ ok: true, dryRun, ...result });
}));

// POST /lifecycle — cron-callable
router.post('/lifecycle', asyncHandler(async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const result = await runLifecycle(req.tenantId);
  res.json({ ok: true, ...result });
}));

module.exports = router;
