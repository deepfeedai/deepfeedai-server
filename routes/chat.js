/**
 * Deep Feed AI — routes/chat.js
 * Platform AI chatbot with SSE streaming.
 * All endpoints require platform-admin auth.
 * Supports two contexts: "portal" (tenant-scoped) and "platform" (cross-tenant).
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { isFeatureEnabled } = require('../lib/feature-registry');
const { stream: aiStream, resolveProvider } = require('../lib/ai-router');
const { streamChat } = require('../lib/chat-provider');
const { buildSystemPrompt, resolveQueries } = require('../lib/chat-system-prompt');

const MAX_HISTORY_MESSAGES = 30;
const VALID_SOURCES = ['portal', 'platform'];

// ── Middleware: require platform-admin + feature flag ────────────────

function requirePlatformAdmin(req, res, next) {
  if (!req.user || req.user.type !== 'platform-admin') {
    return res.status(403).json({ error: 'Platform admin access required' });
  }
  next();
}

const chatAuth = [auth, requirePlatformAdmin];

async function requireChatFeature(req, res, next) {
  const enabled = await isFeatureEnabled(req.tenantId, 'platform_chat');
  if (!enabled) {
    return res.status(403).json({ error: 'Platform AI Chat is not enabled for this tenant' });
  }
  next();
}

/**
 * Look up tenant info for system prompt context.
 */
async function getTenantContext(tenantId) {
  const tenant = await db.prepare(
    "SELECT display_name, slug, plan FROM tenants WHERE id = $1"
  ).get(tenantId);
  if (!tenant) return {};
  return {
    tenantName: tenant.display_name,
    tenantSlug: tenant.slug,
    tenantPlan: tenant.plan,
  };
}

// ── GET /api/chat/conversations — List conversations ────────────────

router.get('/conversations', ...chatAuth, requireChatFeature, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = parseInt(req.query.offset) || 0;
  const userId = req.user.sub || req.user.id;
  const source = VALID_SOURCES.includes(req.query.source) ? req.query.source : null;

  // Filter by source if provided, otherwise return all
  const sourceFilter = source ? 'AND c.source = $5' : '';
  const params = [req.tenantId, userId, limit, offset];
  if (source) params.push(source);

  const conversations = await db.prepare(`
    SELECT c.id, c.title, c.source, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) AS message_count
    FROM chat_conversations c
    WHERE c.tenant_id = $1 AND c.user_id = $2 ${sourceFilter}
    ORDER BY c.updated_at DESC
    LIMIT $3 OFFSET $4
  `).all(...params);

  res.json({ conversations });
}));

// ── POST /api/chat/conversations — Create conversation ──────────────

router.post('/conversations', ...chatAuth, requireChatFeature, asyncHandler(async (req, res) => {
  const userId = req.user.sub || req.user.id;
  const title = (req.body.title || 'New conversation').slice(0, 200);
  const source = VALID_SOURCES.includes(req.body.source) ? req.body.source : 'platform';

  const row = await db.prepare(`
    INSERT INTO chat_conversations (tenant_id, user_id, title, source)
    VALUES ($1, $2, $3, $4)
    RETURNING id, title, source, created_at, updated_at
  `).get(req.tenantId, userId, title, source);

  res.status(201).json({ conversation: row });
}));

// ── GET /api/chat/conversations/:id/messages — Get messages ─────────

router.get('/conversations/:id/messages', ...chatAuth, requireChatFeature, asyncHandler(async (req, res) => {
  const userId = req.user.sub || req.user.id;
  const conversationId = parseInt(req.params.id);
  if (!conversationId || conversationId <= 0) return res.status(400).json({ error: 'Invalid conversation ID' });

  // Ownership check
  const conv = await db.prepare(
    'SELECT id FROM chat_conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3'
  ).get(conversationId, req.tenantId, userId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const messages = await db.prepare(`
    SELECT id, role, content, created_at
    FROM chat_messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC
  `).all(conversationId);

  res.json({ messages });
}));

// ── POST /api/chat/conversations/:id/messages — Send + stream ───────

router.post('/conversations/:id/messages', ...chatAuth, requireChatFeature, asyncHandler(async (req, res) => {
  const userId = req.user.sub || req.user.id;
  const conversationId = parseInt(req.params.id);
  if (!conversationId || conversationId <= 0) return res.status(400).json({ error: 'Invalid conversation ID' });
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message content required' });
  if (content.length > 10000) return res.status(400).json({ error: 'Message too long (max 10,000 characters)' });

  // Optional per-request provider/model override (from UI model selector)
  const providerOverride = req.body.provider || null;
  const modelOverride = req.body.model || null;

  // Ownership check — also fetch source for context-aware prompting
  const conv = await db.prepare(
    'SELECT id, title, source FROM chat_conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3'
  ).get(conversationId, req.tenantId, userId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const source = conv.source || 'platform';

  // Provider resolution (for re-generation calls via streamChat)
  const resolved = await resolveProvider('chat', req.tenantId, providerOverride ? { provider: providerOverride, model: modelOverride } : undefined);

  // Save user message
  await db.prepare(`
    INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2)
  `).run(conversationId, content);

  // Auto-title on first message
  if (conv.title === 'New conversation') {
    const autoTitle = content.slice(0, 80) + (content.length > 80 ? '...' : '');
    await db.prepare(
      'UPDATE chat_conversations SET title = $1, updated_at = NOW() WHERE id = $2'
    ).run(autoTitle, conversationId);
  } else {
    await db.prepare(
      'UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1'
    ).run(conversationId);
  }

  // Load conversation history
  const history = await db.prepare(`
    SELECT role, content FROM chat_messages
    WHERE conversation_id = $1
    ORDER BY created_at DESC LIMIT $2
  `).all(conversationId, MAX_HISTORY_MESSAGES);
  history.reverse();

  // Build context-aware system prompt
  const tenantContext = source === 'portal' ? await getTenantContext(req.tenantId) : {};
  const systemPrompt = buildSystemPrompt(source, tenantContext);

  // Build messages array for the provider
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const startTime = Date.now();
  let fullResponse = '';
  let usageData = null;

  try {
    // Use ai-router for the primary stream (handles budget, key resolution, logging)
    const chatStream = aiStream({
      operation: 'chat',
      tenantId: req.tenantId,
      messages,
      temperature: 0.7,
      maxTokens: 2048,
      trigger: 'manual',
      providerOverride,
      modelOverride,
    });

    for await (const chunk of chatStream) {
      if (chunk.type === 'text') {
        fullResponse += chunk.content;
        res.write(`data: ${JSON.stringify({ type: 'text', content: chunk.content })}\n\n`);
      } else if (chunk.type === 'usage') {
        usageData = chunk;
      } else if (chunk.type === 'error') {
        res.write(`data: ${JSON.stringify({ type: 'error', message: chunk.message })}\n\n`);
        res.end();
        return;
      }
    }

    // Check if the response contains data queries that need resolution
    if (fullResponse.includes('[QUERY:')) {
      const queryData = await resolveQueries(fullResponse, req.tenantId, source);
      if (queryData) {
        // Re-generate with query data injected as context
        const messagesWithData = [
          ...messages,
          { role: 'assistant', content: fullResponse },
          { role: 'user', content: `Here is the data you requested:\n\n${queryData}\n\nNow provide your complete answer using this data. Do not include [QUERY:...] tags in your response.` },
        ];

        // Stream the data-informed response (use streamChat directly for the re-gen since ai-router already handled budget)
        fullResponse = '';
        res.write(`data: ${JSON.stringify({ type: 'clear' })}\n\n`);

        const dataStream = streamChat({
          provider: resolved.provider,
          model: resolved.model,
          apiKey: resolved.apiKey,
          baseUrl: resolved.baseUrl,
          messages: messagesWithData,
          temperature: 0.7,
          maxTokens: 2048,
        });

        for await (const chunk of dataStream) {
          if (chunk.type === 'text') {
            fullResponse += chunk.content;
            res.write(`data: ${JSON.stringify({ type: 'text', content: chunk.content })}\n\n`);
          } else if (chunk.type === 'usage') {
            // Combine usage from both calls
            if (usageData) {
              usageData.promptTokens += chunk.promptTokens;
              usageData.completionTokens += chunk.completionTokens;
            } else {
              usageData = chunk;
            }
          } else if (chunk.type === 'error') {
            res.write(`data: ${JSON.stringify({ type: 'error', message: chunk.message })}\n\n`);
            res.end();
            return;
          }
        }
      }
    }

    // Save assistant message
    const msgRow = await db.prepare(`
      INSERT INTO chat_messages (conversation_id, role, content, input_tokens, output_tokens, duration_ms)
      VALUES ($1, 'assistant', $2, $3, $4, $5)
      RETURNING id
    `).get(
      conversationId,
      fullResponse,
      usageData?.promptTokens || null,
      usageData?.completionTokens || null,
      Date.now() - startTime,
    );

    res.write(`data: ${JSON.stringify({ type: 'done', messageId: msgRow?.id })}\n\n`);
  } catch (err) {
    console.error('[Chat] Stream error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'An error occurred while generating a response.' })}\n\n`);
  }

  res.end();
}));

// ── DELETE /api/chat/conversations/:id — Delete conversation ────────

router.delete('/conversations/:id', ...chatAuth, requireChatFeature, asyncHandler(async (req, res) => {
  const userId = req.user.sub || req.user.id;
  const conversationId = parseInt(req.params.id);
  if (!conversationId || conversationId <= 0) return res.status(400).json({ error: 'Invalid conversation ID' });

  const conv = await db.prepare(
    'SELECT id FROM chat_conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3'
  ).get(conversationId, req.tenantId, userId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  await db.prepare('DELETE FROM chat_conversations WHERE id = $1').run(conversationId);
  res.json({ success: true });
}));

module.exports = router;
