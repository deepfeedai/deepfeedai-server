/**
 * Deep Feed AI — Admin Story Timelines API
 * Mounted at: /api/story-timelines (auth-guarded)
 *
 * GET    /                     — list all stories (any status)
 * GET    /articles-search      — search published articles to attach
 * POST   /                     — manually create a story
 * GET    /:id                  — single story with articles
 * PATCH  /:id                  — update name / summary / status
 * DELETE /:id                  — permanently delete an archived story
 * POST   /:id/regenerate       — re-run Maxwell name + summary
 * POST   /:id/articles         — manually add article to story
 * DELETE /:id/articles/:aid    — remove article from story
 * PATCH  /:id/articles/:aid    — toggle is_key_moment
 * POST   /backfill             — one-shot backfill from existing articles
 * POST   /regenerate-all       — bulk re-run Maxwell name+summary (?filter=generic|all, ?dry=true)
 * POST   /lifecycle            — run dormant/archive lifecycle (cron-callable)
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const storyAi = require('../lib/story-ai');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  listStories,
  getStoryById,
  createStory,
  updateStory,
  deleteStory,
  addArticleToStory,
  removeArticleFromStory,
  setKeyMoment,
  generateStoryNameAndSummary,
  runLifecycle,
  backfill,
  retroBackfillUnassigned,
} = require('../lib/story-timelines');

// GET / — list stories
router.get('/', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
  const offset = Math.max(parseInt(req.query.offset) || 0,  0);
  const status = req.query.status
    ? String(req.query.status).split(',').map(s => s.trim()).filter(Boolean)
    : ['active', 'dormant', 'archived'];
  const search = req.query.q ? String(req.query.q).slice(0, 200).trim() : null;

  const result = await listStories(req.tenantId, { status, limit, offset, search });
  res.json(result);
}));

// GET /articles-search — search published articles to attach to a story
router.get('/articles-search', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const q             = (req.query.q || '').trim();
  const excludeStory  = parseInt(req.query.exclude_story) || null;
  const limit         = Math.min(parseInt(req.query.limit) || 20, 50);

  const params = [req.tenantId, limit];
  let excludeClause = '';
  if (excludeStory) {
    excludeClause = `AND a.id NOT IN (SELECT article_id FROM story_timeline_articles WHERE tenant_id = $1 AND story_id = ${params.length + 1})`;
    params.push(excludeStory);
  }

  let searchClause = '';
  if (q) {
    searchClause = `AND (a.title ILIKE $${params.length + 1} OR a.source ILIKE $${params.length + 1})`;
    params.push(`%${q}%`);
  }

  const rows = await db.prepare(`
    SELECT a.id, a.title, a.source, a.source_url, a.category, a.content_type, a.published_at, w.name AS writer_name
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1
      AND a.is_published = 1
      AND (a.is_archived = 0 OR a.is_archived IS NULL)
      ${excludeClause}
      ${searchClause}
    ORDER BY a.published_at DESC
    LIMIT $2
  `).all(...params);

  res.json({ articles: rows || [] });
}));

// POST / — create story manually
router.post('/', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { name, summary, articleIds } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const story = await createStory(req.tenantId, {
    name,
    summary,
    articleIds: Array.isArray(articleIds) ? articleIds.map(Number) : [],
  });
  res.status(201).json({ story });
}));

// GET /:id
router.get('/:id', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const story = await getStoryById(req.tenantId, parseInt(req.params.id));
  if (!story) return res.status(404).json({ error: 'story not found' });
  res.json({ story });
}));

// PATCH /:id — update metadata
router.patch('/:id', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { name, summary, status } = req.body || {};
  const updated = await updateStory(req.tenantId, parseInt(req.params.id), { name, summary, status });
  if (!updated) return res.status(404).json({ error: 'story not found' });
  res.json({ story: updated });
}));

// DELETE /:id — permanently delete (must be archived first)
router.delete('/:id', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const story = await getStoryById(req.tenantId, parseInt(req.params.id));
  if (!story) return res.status(404).json({ error: 'story not found' });
  if (story.status !== 'archived') return res.status(400).json({ error: 'story must be archived before it can be deleted' });
  const deleted = await deleteStory(req.tenantId, parseInt(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'story not found' });
  res.json({ ok: true });
}));

// POST /:id/regenerate — re-run Maxwell
router.post('/:id/regenerate', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const storyId = parseInt(req.params.id);
  const task = await storyAi.start(req.tenantId,storyId,req.body || {});
  res.status(task.run ? 202 : 200).json({ok:true,job:task.job});
  if(task.run) setImmediate(()=>task.run().catch(()=>{}));
}));

// POST /:id/articles — add article
router.post('/:id/articles', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { articleId, isKeyMoment = false } = req.body || {};
  if (!articleId) return res.status(400).json({ error: 'articleId is required' });
  await addArticleToStory(parseInt(req.params.id), parseInt(articleId), req.tenantId, { isKeyMoment });
  res.json({ ok: true });
}));

// DELETE /:id/articles/:aid — remove article
router.delete('/:id/articles/:aid', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  await removeArticleFromStory(parseInt(req.params.id), parseInt(req.params.aid), req.tenantId);
  res.json({ ok: true });
}));

// PATCH /:id/articles/:aid — toggle key moment
router.patch('/:id/articles/:aid', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { isKeyMoment } = req.body || {};
  await setKeyMoment(parseInt(req.params.id), parseInt(req.params.aid), req.tenantId, !!isKeyMoment);
  res.json({ ok: true });
}));

// Accepts a valid cron secret OR an admin JWT with articles.update permission.
function cronOrAuth(req, res, next) {
  const { getSecrets } = require('../lib/secrets');
  getSecrets().then(({ cronSecret }) => {
    const provided = req.headers['x-cron-secret'];
    if (provided && cronSecret && provided === cronSecret) {
      req.user = { permissions: ['*'], type: 'cron' };
      return next();
    }
    auth(req, res, next);
  }).catch(next);
}

// POST /backfill — JWT (articles.update) or cron-secret
router.post('/backfill', cronOrAuth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const dryRun = req.query.dry === 'true' || req.body?.dryRun === true;
  const result = await backfill(req.tenantId, { dryRun });
  res.json({ ok: true, dryRun, ...result });
}));

// POST /lifecycle — JWT (articles.update) or cron-secret
router.post('/lifecycle', cronOrAuth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const result = await runLifecycle(req.tenantId);
  res.json({ ok: true, ...result });
}));

// POST /retro-backfill — sweep recent unassigned articles into matching stories
router.post('/retro-backfill', cronOrAuth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const windowHours = Math.min(parseInt(req.query.hours) || 48, 168);
  const result = await retroBackfillUnassigned(req.tenantId, { windowHours });
  res.json({ ok: true, windowHours, ...result });
}));

// POST /regenerate-all — bulk re-run Maxwell name+summary for existing stories
// ?filter=generic (default) — only stories with short/missing names or no summary
// ?filter=all               — every story regardless of name quality
// ?dry=true                 — count only, don't queue
router.post('/regenerate-all', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const filter = req.query.filter === 'all' ? 'all' : 'generic';
  const dryRun = req.query.dry === 'true' || req.body?.dryRun === true;

  const genericClause = `AND (summary IS NULL OR array_length(string_to_array(trim(name), ' '), 1) <= 3)`;
  const rows = await db.prepare(`
    SELECT id FROM story_timelines
    WHERE tenant_id = $1
    ${filter === 'generic' ? genericClause : ''}
    ORDER BY last_activity_at DESC
  `).all(req.tenantId).catch(() => []);

  // Always return the generic count so the UI can show both numbers regardless of filter
  const genericCount = filter === 'all'
    ? (await db.prepare(`SELECT COUNT(*)::int AS cnt FROM story_timelines WHERE tenant_id = $1 ${genericClause}`).get(req.tenantId).catch(() => ({ cnt: 0 }))).cnt
    : rows.length;

  if (dryRun) {
    return res.json({ ok: true, dryRun: true, filter, count: rows.length, genericCount });
  }

  res.status(409).json({error:'Open a story and explicitly generate its summary. Each story shows its own cost confirmation and durable result.'});


}));

module.exports = router;
