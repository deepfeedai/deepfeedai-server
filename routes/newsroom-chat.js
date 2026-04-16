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
const messaging   = require('../lib/messaging');
const ctx         = require('../lib/messaging/context');
const agentTools  = require('../lib/agent-tools');

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

// Strip hallucinated [called tool ...] lines the LLM may emit when it has no real tools.
function stripHallucinatedToolCalls(text) {
  return text.replace(/\[called tool [^\]]+\]\s*/gi, '').trim();
}

// Parse <<<PITCH:{...}>>> blocks Maxwell appends when proposing a pitch.
// Returns { text: cleaned, actions: [] } — actions is empty when no block is found.
// Also resolves writer_name → writer_id via DB lookup.
async function parsePitchAction(text, sourceArticleId, tenantId) {
  const cleaned = stripHallucinatedToolCalls(text);
  const match = cleaned.match(/\n*<<<PITCH:([\s\S]*?)>>>\s*$/);
  if (!match) return { text: cleaned, actions: [] };
  try {
    const data = JSON.parse(match[1]);
    const cleanText = cleaned.slice(0, cleaned.lastIndexOf('<<<PITCH:')).trimEnd();
    if (data.writer_name && data.writer_name !== 'null' && tenantId) {
      const writerRow = await db.prepare(
        `SELECT id FROM writers WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) AND is_system = false LIMIT 1`
      ).get(tenantId, data.writer_name).catch(() => null);
      if (writerRow) data.writer_id = writerRow.id;
    }
    delete data.writer_name;
    return {
      text: cleanText,
      actions: [{
        type: 'create_pitch',
        label: '📋 Create Pitch',
        payload: { source_article_id: sourceArticleId, ...data },
      }],
    };
  } catch {
    return { text: cleaned.slice(0, cleaned.lastIndexOf('<<<PITCH:')).trimEnd(), actions: [] };
  }
}

// POST /api/newsroom-chat — body: { writer_id, message, context_article_id?, intent? }
router.post('/', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const { writer_id, message, context_article_id, intent } = req.body || {};
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

  // Fetch writer early so we can detect Maxwell for pitch instruction injection.
  const writer = await db.prepare('SELECT id, role, is_system, chat_prompt FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, req.tenantId);

  // For Maxwell (editor agent): always inject the writers roster so he knows who to assign to.
  // Inject the full pitch instruction + <<<PITCH:>>> format whenever an article is attached,
  // regardless of the intent param — so manual pitch requests work the same as the 📋 button.
  if (writer?.is_system && writer?.role === 'editor') {
    const writerRows = await db.prepare(
      `SELECT name, beat FROM writers WHERE tenant_id = $1 AND is_system = false ORDER BY name ASC`
    ).all(req.tenantId).catch(() => []);
    if (writerRows.length) {
      const rosterLines = writerRows.map(w => `- ${w.name}${w.beat ? ` (beat: ${w.beat})` : ''}`).join('\n');
      enrichedMessage += `\n\n[Newsroom writers available for assignment:\n${rosterLines}]`;
    }
    if (context_article_id) {
      enrichedMessage += `\n\n[ROLE REMINDER — do not display this: You are the editorial director. You do NOT write articles — you assess stories and assign them to writers. Your job is to evaluate this story's news value and recommend which writer from the roster above should cover it and why. Never say you will write or pitch the story yourself. When you have a clear recommendation, append exactly this block on its own line at the very end of your response: <<<PITCH:{"angle_summary":"one sentence angle here","writer_name":"Exact Writer Name from the roster"}>>> — only include it when you have a concrete recommendation, not in exploratory replies.]`;
    }
  }

  // Route tool-capable system agents (Iris, Vera) through the tool-calling path
  // when an article context is attached. All other agents use the standard path.
  const TOOL_ROLES = ['designer', 'copy-editor'];
  if (writer?.is_system && TOOL_ROLES.includes(writer?.role)) {
    let toolResult;
    try {
      toolResult = await agentTools.handleWithTools(
        req.tenantId, writer, enrichedMessage, contextKey, meta,
        context_article_id ? parseInt(context_article_id, 10) : null,
      );
    } catch (err) {
      return res.status(500).json({ error: err.message || 'agent tool error' });
    }
    if (toolResult.type === 'tool_proposal') {
      return res.json({ text: toolResult.preview_text, proposal: toolResult });
    }
    return res.json({ text: toolResult.text });
  }

  let response;
  try {
    response = await messaging.handleIncoming(req.tenantId, writerId, enrichedMessage, contextKey, meta, message);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'chat failed' });
  }

  const rawText = stripHallucinatedToolCalls(
    typeof response === 'string' ? response : (response?.text || '')
  );
  const sourceId = context_article_id ? parseInt(context_article_id, 10) : null;
  const { text, actions } = await parsePitchAction(rawText, sourceId, req.tenantId);

  res.json({
    text,
    actions: actions.length ? actions : undefined,
    voice: typeof response === 'object' ? !!response?.voice : false,
    cleared: typeof response === 'object' ? !!response?.clearChannel : false,
  });
}));

// POST /api/newsroom-chat/actions/approve — apply an approved tool proposal or action button
router.post('/actions/approve', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const proposal = req.body || {};
  if (!proposal.proposal_type && !proposal.type) {
    return res.status(400).json({ error: 'proposal_type or type required' });
  }

  // Action buttons from Maxwell use { type, payload } shape — normalise to proposal shape
  const actionType = proposal.type || proposal.proposal_type;

  if (actionType === 'create_pitch') {
    const { source_article_id, angle_summary } = proposal.payload || proposal;
    if (!source_article_id || !angle_summary) {
      return res.status(400).json({ error: 'source_article_id and angle_summary required' });
    }
    const userId = req.user?.sub || null;
    // Verify the source article belongs to this tenant
    const source = await db.prepare(
      'SELECT id FROM articles WHERE id = $1 AND tenant_id = $2'
    ).get(parseInt(source_article_id, 10), req.tenantId);
    if (!source) return res.status(404).json({ error: 'Source article not found' });

    const row = await db.prepare(`
      INSERT INTO article_pitches
        (tenant_id, source_article_id, requested_by_editor_id, angle_summary, status)
      VALUES ($1, $2, $3, $4, 'proposed')
      RETURNING id
    `).get(req.tenantId, source.id, userId, angle_summary.slice(0, 2000));

    return res.json({ text: `Pitch created! It's in the queue and ready for writer assignment.`, pitch_id: row.id });
  }

  // Existing tool proposals (thumbnail, headline) use the agent-tools path
  if (!proposal.article_id) {
    return res.status(400).json({ error: 'article_id required for this proposal type' });
  }
  try {
    const result = await agentTools.applyProposal(proposal, req.tenantId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'apply failed' });
  }
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
