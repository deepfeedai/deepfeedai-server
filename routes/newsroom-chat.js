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

// GET /api/newsroom-chat/maxwell — lightweight Maxwell discovery (single editor agent)
router.get('/maxwell', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const row = await db.prepare(`
    SELECT id, name, role, is_system, accent_color, avatar_url
    FROM writers
    WHERE tenant_id = $1 AND is_system = true AND role = 'editor'
    LIMIT 1
  `).get(req.tenantId);
  if (!row) return res.status(404).json({ error: 'Maxwell not configured for this tenant' });
  const { resolveAccent } = require('../lib/writer-colors');
  row.accent = resolveAccent(row);
  res.json({ id: row.id, name: row.name, accent: row.accent, avatar_url: row.avatar_url });
}));

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
// Returns { text, actions, parse_hint? }. parse_hint surfaces when a PITCH
// block was detected but the payload could not be parsed or lacked required
// fields — the UI shows this as a retry banner instead of silently dropping
// the action button.
const { parseTruncatedJsonObject, stripFences } = require('../lib/json-parse-safe');

async function parsePitchAction(text, sourceArticleId, tenantId) {
  const cleaned = stripHallucinatedToolCalls(text);
  const blocks = [...cleaned.matchAll(/<<<PITCH:([\s\S]*?)>>>/g)];
  if (!blocks.length) return { text: cleaned, actions: [] };

  // Strip ALL PITCH blocks from the visible text regardless of parse outcome.
  const stripped = cleaned.replace(/\n*<<<PITCH:[\s\S]*?>>>\s*/g, '').trimEnd();

  // Try each block (last-one-wins); JSON.parse first, then truncation recovery.
  let data = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const raw = stripFences(blocks[i][1].trim());
    try { data = JSON.parse(raw); break; }
    catch {
      try {
        const recovered = parseTruncatedJsonObject(raw);
        if (recovered && Object.keys(recovered).length) { data = recovered; break; }
      } catch { /* try next block */ }
    }
  }

  if (!data || !data.angle_summary || String(data.angle_summary).trim() === '') {
    return {
      text: stripped,
      actions: [],
      parse_hint: 'I had a pitch recommendation but the structured payload was malformed. Tap Retry to regenerate.',
    };
  }

  if (data.writer_name && data.writer_name !== 'null' && tenantId) {
    const writerRow = await db.prepare(
      `SELECT id FROM writers WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) AND is_system = false LIMIT 1`
    ).get(tenantId, data.writer_name).catch(() => null);
    if (writerRow) data.writer_id = writerRow.id;
  }
  delete data.writer_name;

  // Normalise `type` → pitch_type so downstream rendering and apply paths
  // see a single canonical field regardless of what the LLM emitted.
  const { normalisePitchType } = require('../lib/pitch-types');
  const pitchType = normalisePitchType(data.type || data.pitch_type);
  delete data.type;
  data.pitch_type = pitchType;

  return {
    text: stripped,
    actions: [{
      type: 'create_pitch',
      label: '📋 Create Pitch',
      payload: { source_article_id: sourceArticleId, ...data },
    }],
  };
}

// Matches anaphoric references ("that", "it", "this one", "the article") used
// without a fresh context_article_id. Triggers rehydration from the last turn's
// stored context_article_id so follow-ups resolve naturally.
const ANAPHORA_RE = /\b(that|it|this(?:\s+one)?|the\s+(article|piece|story|pitch))\b/i;

// POST /api/newsroom-chat
// body: {
//   writer_id, message, intent?,
//   context_article_id?,                    primary source attached
//   context_attached_article_ids?: number[] additional sources for multi-source pitches
// }
router.post('/', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const { writer_id, message, context_article_id, context_attached_article_ids, intent } = req.body || {};
  if (!writer_id || !message) return res.status(400).json({ error: 'writer_id and message required' });
  const writerId = parseInt(writer_id, 10);
  if (!writerId) return res.status(400).json({ error: 'writer_id must be numeric' });

  const userId = req.user?.sub || 'anon';
  const contextKey = buildWebContextKey(userId, writerId);

  // Resolve article context: fresh attachment wins; otherwise rehydrate from
  // the most recent turn that referenced an article when the user used a
  // demonstrative pronoun ("make that a pitch", "it looks good").
  let resolvedArticleId = null;
  if (context_article_id) {
    resolvedArticleId = parseInt(context_article_id, 10) || null;
  } else if (ANAPHORA_RE.test(message)) {
    resolvedArticleId = await ctx.getLastContextArticleId(contextKey, req.tenantId, writerId);
  }

  // Multi-source: tenant-check any additional attachment ids the editor
  // queued up (feed-inbox "create pitch from selection"). Strip anything
  // foreign; drop the primary if it's duplicated in the list.
  let additionalIds = [];
  if (Array.isArray(context_attached_article_ids) && context_attached_article_ids.length) {
    const ints = context_attached_article_ids.map(n => parseInt(n, 10)).filter(Boolean);
    if (ints.length) {
      const rows = await db.prepare(
        'SELECT id, title, category, source FROM articles WHERE id = ANY($1::int[]) AND tenant_id = $2'
      ).all(ints, req.tenantId).catch(() => []);
      const valid = new Map(rows.map(r => [r.id, r]));
      additionalIds = ints.filter(n => n !== resolvedArticleId && valid.has(n));
      // Stash the lookup for the enrichment block below
      req._additionalArticles = additionalIds.map(id => valid.get(id));
    }
  }

  // Optionally enrich the message with article context (title, summary, category)
  let enrichedMessage = message;
  if (resolvedArticleId) {
    const articleId = resolvedArticleId;
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

  // If the editor queued multi-source context, append a brief block listing
  // each additional source so Maxwell sees the full set and can call
  // proposePitch with source_article_ids[] that covers them all.
  if (additionalIds.length && Array.isArray(req._additionalArticles)) {
    const lines = req._additionalArticles.map(a =>
      `  - #${a.id} "${a.title}"${a.category ? ' (' + a.category + ')' : ''}${a.source ? ' — ' + a.source : ''}`
    ).join('\n');
    enrichedMessage += `\n\n[Additional sources the editor has queued for a multi-source pitch — include their IDs in source_article_ids when you call proposePitch:\n${lines}]`;
  }

  const meta = {
    platform: 'web',
    userId: String(userId),
    userName: req.user?.name || req.user?.email || 'editor',
    contextArticleId: resolvedArticleId,
  };

  // Fetch writer early so we can detect Maxwell for pitch instruction injection.
  const writer = await db.prepare('SELECT id, name, role, is_system, chat_prompt FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, req.tenantId);

  // For Maxwell: inject the writers roster so he knows who to assign to.
  if (writer?.is_system && writer?.role === 'editor') {
    const writerRows = await db.prepare(
      `SELECT name, beat FROM writers WHERE tenant_id = $1 AND is_system = false ORDER BY name ASC`
    ).all(req.tenantId).catch(() => []);
    if (writerRows.length) {
      const rosterLines = writerRows.map(w => `- ${w.name}${w.beat ? ` (beat: ${w.beat})` : ''}`).join('\n');
      enrichedMessage += `\n\n[Newsroom writers available for assignment:\n${rosterLines}]`;
    }

  }

  // Route tool-capable system agents through the native tool-calling path.
  const TOOL_ROLES = ['designer', 'copy-editor', 'editor'];

  if (writer?.is_system && TOOL_ROLES.includes(writer?.role)) {
    let toolResult;
    try {
      toolResult = await agentTools.handleWithTools(
        req.tenantId, writer, enrichedMessage, contextKey, meta, resolvedArticleId,
      );
    } catch (err) {
      return res.status(500).json({ error: err.message || 'agent tool error' });
    }
    if (toolResult.type === 'tool_proposal') {
      return res.json({ text: toolResult.preview_text, proposal: toolResult, resolved_article_id: resolvedArticleId });
    }
    return res.json({ text: toolResult.text, resolved_article_id: resolvedArticleId });
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
  const { text, actions, parse_hint } = await parsePitchAction(rawText, resolvedArticleId, req.tenantId);

  res.json({
    text,
    actions: actions.length ? actions : undefined,
    parse_hint: parse_hint || undefined,
    resolved_article_id: resolvedArticleId || undefined,
    voice: typeof response === 'object' ? !!response?.voice : false,
    cleared: typeof response === 'object' ? !!response?.clearChannel : false,
  });
}));

// POST /api/newsroom-chat/actions/approve — apply an approved tool proposal or action button
router.post('/actions/approve', auth, requirePermission('articles.update'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const proposal = req.body || {};
  if (!proposal.proposal_type && !proposal.type) {
    return res.status(400).json({ error: 'proposal_type or type required' });
  }

  // Action buttons from Maxwell use { type, payload } shape — normalise to proposal shape
  const actionType = proposal.type || proposal.proposal_type;

  if (actionType === 'create_pitch') {
    const payload = proposal.payload || proposal;
    const { source_article_id, angle_summary } = payload;
    if (!source_article_id || !angle_summary) {
      return res.status(400).json({ error: 'source_article_id and angle_summary required' });
    }
    const userId = req.user?.sub || null;
    const { normalisePitchType } = require('../lib/pitch-types');
    const pitchType = normalisePitchType(payload.pitch_type || payload.type);

    // Verify the primary source belongs to this tenant and is a curated article.
    // Pitching from an original/deep-dive creates circular synthesis dependencies.
    const source = await db.prepare(
      'SELECT id, content_type FROM articles WHERE id = $1 AND tenant_id = $2'
    ).get(parseInt(source_article_id, 10), req.tenantId);
    if (!source) return res.status(404).json({ error: 'Source article not found' });
    if (['original', 'deep-dive', 'video'].includes(source.content_type)) {
      return res.status(400).json({ error: `Cannot pitch from a ${source.content_type} article — source must be a curated article` });
    }

    // Multi-source: accept attached_article_ids or source_article_ids[] from
    // the payload; tenant-check, content-type-check, drop the primary/duplicates.
    const rawIds = Array.isArray(payload.attached_article_ids)
      ? payload.attached_article_ids
      : (Array.isArray(payload.source_article_ids) ? payload.source_article_ids : []);
    let attachedIds = [];
    if (rawIds.length) {
      const ints = rawIds.map(n => parseInt(n, 10)).filter(Boolean);
      if (ints.length) {
        const rows = await db.prepare('SELECT id, content_type FROM articles WHERE id = ANY($1::int[]) AND tenant_id = $2').all(ints, req.tenantId);
        const invalid = rows.filter(r => ['original', 'deep-dive', 'video'].includes(r.content_type));
        if (invalid.length) {
          return res.status(400).json({
            error: 'All attached articles must be curated — cannot attach original/deep-dive/video articles',
            invalid_ids: invalid.map(r => r.id),
          });
        }
        const valid = new Set(rows.map(r => r.id));
        attachedIds = [...new Set(ints.filter(n => n !== source.id && valid.has(n)))];
      }
    }

    const row = await db.prepare(`
      INSERT INTO article_pitches
        (tenant_id, source_article_id, attached_article_ids, requested_by_editor_id, angle_summary, pitch_type, status)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'proposed')
      RETURNING id
    `).get(req.tenantId, source.id, JSON.stringify(attachedIds), userId, angle_summary.slice(0, 2000), pitchType);

    const sourceNote = attachedIds.length ? ` (bundling ${attachedIds.length + 1} sources)` : '';
    return res.json({ text: `Pitch created${sourceNote}! It's in the queue and ready for writer assignment.`, pitch_id: row.id, pitch_type: pitchType });
  }

  // Tool proposals (thumbnail, headline, pitch, approve_article, kill_article,
  // assign_writer, feature_article) use the agent-tools apply path. The `pitch`
  // type doesn't carry a direct article_id on the proposal root (the source
  // article id lives under article_id too, populated server-side).
  const needsArticle = ['thumbnail', 'headline', 'approve_article', 'kill_article', 'assign_writer', 'feature_article', 'pitch'];
  if (needsArticle.includes(actionType) && !proposal.article_id) {
    return res.status(400).json({ error: 'article_id required for this proposal type' });
  }
  try {
    const result = await agentTools.applyProposal(proposal, req.tenantId, req.user?.sub || null);
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
