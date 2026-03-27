/**
 * Deep Feed AI — routes/article-assist.js
 * AI-assisted article editing with SSE streaming.
 * Requires admin auth (articles.update or articles.create permission).
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeature } = require('../middleware/feature-gate');
const { stream: aiStream } = require('../lib/ai-router');
const { buildArticleAssistPrompt, parseAction } = require('../lib/article-assist-prompt');

const MAX_HISTORY_MESSAGES = 10; // shorter context for focused edits
const MAX_CONTEXT_LENGTH = 50000; // 50 KB cap on article context
const MAX_HISTORY_ITEM_LENGTH = 10000; // 10 KB per history message

// ── POST /api/article-assist — stream article editing assistance ────

router.post('/', auth, requirePermission('articles.update'), requireFeature('article_assist'), asyncHandler(async (req, res) => {
  const { message, articleContext, history, provider: providerOverride, model: modelOverride } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (message.length > 10000) {
    return res.status(400).json({ error: 'Message too long (max 10,000 characters)' });
  }

  // Cap article context size to prevent prompt injection / cost abuse
  if (articleContext && JSON.stringify(articleContext).length > MAX_CONTEXT_LENGTH) {
    return res.status(400).json({ error: 'Article context too large (max 50 KB)' });
  }

  // Cap history item sizes
  if (Array.isArray(history)) {
    for (const item of history) {
      if (item.content && item.content.length > MAX_HISTORY_ITEM_LENGTH) {
        return res.status(400).json({ error: 'History message too large (max 10 KB per message)' });
      }
    }
  }

  // Look up writer context if article has a writer assigned
  let writerContext = null;
  if (articleContext?.writerId) {
    const writer = await db.prepare(
      'SELECT name, tone, beat, style_guide FROM writers WHERE id = $1 AND tenant_id = $2'
    ).get(articleContext.writerId, req.tenantId);
    if (writer) writerContext = writer;
  }

  // Build system prompt with article content
  const systemPrompt = buildArticleAssistPrompt(articleContext || {}, writerContext);

  // Build conversation history (keep it short for focused editing)
  const historyMessages = Array.isArray(history)
    ? history.slice(-MAX_HISTORY_MESSAGES).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }))
    : [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: message.trim() },
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

  try {
    // Use ai-router for streaming (handles budget, key resolution, logging)
    const assistStream = aiStream({
      operation: 'article-assist',
      tenantId: req.tenantId,
      messages,
      temperature: 0.7,
      maxTokens: 4096,
      trigger: 'manual',
      providerOverride: providerOverride || undefined,
      modelOverride: modelOverride || undefined,
    });

    for await (const chunk of assistStream) {
      if (chunk.type === 'text') {
        fullResponse += chunk.content;
        res.write(`data: ${JSON.stringify({ type: 'text', content: chunk.content })}\n\n`);
      } else if (chunk.type === 'error') {
        res.write(`data: ${JSON.stringify({ type: 'error', message: chunk.message })}\n\n`);
        res.end();
        return;
      }
    }

    // Parse action from the completed response
    const { text, action } = parseAction(fullResponse);

    if (action) {
      res.write(`data: ${JSON.stringify({ type: 'action', action })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  } catch (err) {
    console.error('[ArticleAssist] Stream error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'An error occurred while generating a response.' })}\n\n`);
  }

  res.end();
}));

module.exports = router;
