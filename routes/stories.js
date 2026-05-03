/**
 * Deep Feed AI — Public Story Timelines API
 * Mounted at: /api/news (via server.js, alongside news.js and videos.js)
 *
 * GET /stories           — list active stories (paginated)
 * GET /stories/:slug     — single story + articles + intensity sparkline
 */
'use strict';

const express = require('express');
const router  = express.Router();
const { asyncHandler } = require('../lib/utils');
const {
  listStories,
  getStory,
} = require('../lib/story-timelines');

// GET /stories
router.get('/stories', asyncHandler(async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 20, 50);
  const offset = Math.max(parseInt(req.query.offset) || 0,  0);
  const status = req.query.status
    ? String(req.query.status).split(',').map(s => s.trim()).filter(Boolean)
    : ['active'];

  const result = await listStories(req.tenantId, { status, limit, offset });
  res.json({ status: 'ok', ...result });
}));

// GET /stories/:slug
router.get('/stories/:slug', asyncHandler(async (req, res) => {
  const story = await getStory(req.tenantId, req.params.slug);
  if (!story) return res.status(404).json({ error: 'story not found' });
  res.json({ status: 'ok', story });
}));

module.exports = router;
