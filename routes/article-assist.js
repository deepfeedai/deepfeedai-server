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
const { logUsage } = require('../lib/ai-usage');
const { canSpend } = require('../lib/budget');
const { getGeminiKey } = require('../lib/gemini-config');
const { streamChat, getDefaultModel } = require('../lib/chat-provider');
const { buildArticleAssistPrompt, parseAction } = require('../lib/article-assist-prompt');

const MAX_HISTORY_MESSAGES = 10; // shorter context for focused edits
const PROVIDER = 'gemini';

// ── POST /api/article-assist — stream article editing assistance ────

router.post('/', auth, asyncHandler(async (req, res) => {
  const { message, articleContext, history } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (message.length > 10000) {
    return res.status(400).json({ error: 'Message too long (max 10,000 characters)' });
  }

  // Budget check
  const budget = await canSpend('chat', req.tenantId);
  if (!budget.allowed) {
    return res.status(429).json({ error: budget.reason });
  }

  // API key
  const apiKey = await getGeminiKey(req.tenantId);
  if (!apiKey) return res.status(500).json({ error: 'AI API key not configured' });

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
  const model = getDefaultModel(PROVIDER);
  let fullResponse = '';
  let usageData = null;

  try {
    const stream = streamChat({
      provider: PROVIDER,
      model,
      apiKey,
      messages,
      temperature: 0.7,
      maxTokens: 4096,
    });

    for await (const chunk of stream) {
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

    // Parse action from the completed response
    const { text, action } = parseAction(fullResponse);

    if (action) {
      res.write(`data: ${JSON.stringify({ type: 'action', action })}\n\n`);
    }

    // Log AI usage
    logUsage({
      provider: PROVIDER,
      model,
      operation: 'article-assist',
      trigger: 'manual',
      inputTokens: usageData?.promptTokens,
      outputTokens: usageData?.completionTokens,
      durationMs: Date.now() - startTime,
      tenantId: req.tenantId,
    }).catch(() => {});

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  } catch (err) {
    console.error('[ArticleAssist] Stream error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'An error occurred while generating a response.' })}\n\n`);
  }

  res.end();
}));

module.exports = router;
