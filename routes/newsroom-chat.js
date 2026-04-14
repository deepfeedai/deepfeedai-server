/**
 * Deep Feed AI Admin — /api/newsroom-chat
 * In-admin web chat with writer agents (Editor's Workspace Phase 1).
 * Mirrors Discord/Telegram messaging path via lib/messaging.handleIncoming
 * so single-shot vs LangGraph routing works identically.
 *
 * ContextKey scheme: web:<userId>:<writerId> — each editor↔writer pair
 * is its own thread, separate from external-platform conversations.
 *
 * Gated by editor_workspace feature flag.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { isFeatureEnabled } = require('../lib/feature-registry');
const messaging = require('../lib/messaging');
const ctx = require('../lib/messaging/context');

async function requireWorkspaceEnabled(req, res, next) {
  const on = await isFeatureEnabled(req.tenantId, 'editor_workspace').catch(() => false);
  if (!on) return res.status(404).json({ error: 'Editor workspace is not enabled for this tenant' });
  next();
}

function buildWebContextKey(userId, writerId) {
  return ctx.buildContextKey('web', String(userId || 'anon'), String(writerId));
}

// GET /api/newsroom-chat/writers — roster for the chat sidebar
router.get('/writers', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT w.id, w.name, w.slug, w.avatar_url, w.beat,
           w.presence_state, w.presence_updated_at,
           (SELECT COUNT(*)::int FROM articles a
              WHERE a.writer_id = w.id AND a.tenant_id = w.tenant_id
                AND a.content_type IN ('original','deep-dive') AND a.is_published = 1) AS published_count
    FROM writers w
    WHERE w.tenant_id = $1
    ORDER BY w.name ASC
  `).all(req.tenantId);
  res.json({ writers: rows });
}));

// GET /api/newsroom-chat/history?writer_id=N — recent turns for this editor↔writer thread
router.get('/history', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const writerId = parseInt(req.query.writer_id, 10);
  if (!writerId) return res.status(400).json({ error: 'writer_id required' });
  const userId = req.user?.sub || 'anon';
  const contextKey = buildWebContextKey(userId, writerId);
  const messages = await ctx.getHistory(contextKey, req.tenantId, writerId);
  res.json({ messages: messages || [], context_key: contextKey });
}));

// POST /api/newsroom-chat — body: { writer_id, message }
router.post('/', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const { writer_id, message } = req.body || {};
  if (!writer_id || !message) return res.status(400).json({ error: 'writer_id and message required' });
  const writerId = parseInt(writer_id, 10);
  if (!writerId) return res.status(400).json({ error: 'writer_id must be numeric' });

  const userId = req.user?.sub || 'anon';
  const contextKey = buildWebContextKey(userId, writerId);
  const meta = {
    platform: 'web',
    userId: String(userId),
    userName: req.user?.name || req.user?.email || 'editor',
  };

  let response;
  try {
    response = await messaging.handleIncoming(req.tenantId, writerId, message, contextKey, meta);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'chat failed' });
  }

  const text = typeof response === 'string' ? response : (response?.text || '');
  res.json({
    text,
    voice: typeof response === 'object' ? !!response?.voice : false,
    cleared: typeof response === 'object' ? !!response?.clearChannel : false,
  });
}));

// POST /api/newsroom-chat/clear — body: { writer_id }
router.post('/clear', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const { writer_id } = req.body || {};
  const writerId = parseInt(writer_id, 10);
  if (!writerId) return res.status(400).json({ error: 'writer_id required' });
  const userId = req.user?.sub || 'anon';
  const contextKey = buildWebContextKey(userId, writerId);
  await ctx.clearHistory(contextKey, req.tenantId, writerId);
  res.json({ ok: true });
}));

module.exports = router;
