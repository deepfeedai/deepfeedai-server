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
    SELECT w.id, w.name, w.slug, w.avatar_url, w.beat, w.accent_color,
           w.presence_state, w.presence_updated_at, w.role, w.is_system,
           (SELECT COUNT(*)::int FROM articles a
              WHERE a.writer_id = w.id AND a.tenant_id = w.tenant_id
                AND a.content_type IN ('original','deep-dive') AND a.is_published = 1) AS published_count
    FROM writers w
    WHERE w.tenant_id = $1
    ORDER BY w.name ASC
  `).all(req.tenantId);
  // Resolve the effective accent (explicit or deterministic palette fallback)
  // server-side so the chat UI doesn't have to duplicate the palette logic.
  const { resolveAccent } = require('../lib/writer-colors');
  for (const w of rows) w.accent = resolveAccent(w);
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

// POST /api/newsroom-chat — body: { writer_id, message, context_article_id? }
router.post('/', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const { writer_id, message, context_article_id } = req.body || {};
  if (!writer_id || !message) return res.status(400).json({ error: 'writer_id and message required' });
  const writerId = parseInt(writer_id, 10);
  if (!writerId) return res.status(400).json({ error: 'writer_id must be numeric' });

  // Optionally enrich the message with article context (title, summary, category)
  let enrichedMessage = message;
  if (context_article_id) {
    const articleId = parseInt(context_article_id, 10);
    if (articleId) {
      const article = await db.prepare(
        'SELECT title, summary, full_content, category, source, source_url, content_type FROM articles WHERE id = $1 AND tenant_id = $2'
      ).get(articleId, req.tenantId).catch(() => null);
      if (article) {
        const isExternal = article.content_type === 'curated' || !article.content_type;
        // Include up to 2000 chars of full content when available (covers most RSS articles)
        const bodyText = (article.full_content || '').trim();
        const bodySnippet = bodyText.length > 2000
          ? bodyText.slice(0, 2000) + '… [truncated]'
          : bodyText;
        if (isExternal) {
          const lines = [
            `[External source article shared by editor — this is NOT one of your published articles]`,
            `Title: "${article.title}"`,
            `Category: ${article.category || 'Unknown'} | Source: ${article.source || 'Unknown'}`,
            article.source_url ? `URL: ${article.source_url}` : null,
            `Summary: ${article.summary || 'No summary available.'}`,
            bodySnippet ? `\nFull text:\n${bodySnippet}` : null,
            `\nRespond based on the article content above. Do not search your own published articles for this.`,
          ].filter(Boolean).join('\n');
          enrichedMessage = `${lines}\n\nEditor: ${message}`;
        } else {
          const lines = [
            `[Your article: "${article.title}"]`,
            `Category: ${article.category || 'Unknown'}`,
            `Summary: ${article.summary || 'No summary available.'}`,
          ].filter(Boolean).join('\n');
          enrichedMessage = `${lines}\n\nEditor: ${message}`;
        }
      }
    }
  }

  const userId = req.user?.sub || 'anon';
  const contextKey = buildWebContextKey(userId, writerId);
  const meta = {
    platform: 'web',
    userId: String(userId),
    userName: req.user?.name || req.user?.email || 'editor',
  };

  let response;
  try {
    response = await messaging.handleIncoming(req.tenantId, writerId, enrichedMessage, contextKey, meta);
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
