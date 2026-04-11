/**
 * Webhook endpoints for messaging integrations (Telegram, Slack, etc.)
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../lib/utils');

// GET /api/webhooks/telegram — health check
router.get('/telegram', (req, res) => {
  res.json({ status: 'ok', message: 'Telegram webhook endpoint is active' });
});

// POST /api/webhooks/telegram — incoming Telegram updates
router.post('/telegram', asyncHandler(async (req, res) => {
  res.json({ ok: true });

  const { parseUpdate } = require('../lib/messaging/telegram');
  const parsed = parseUpdate(req.body);
  if (!parsed) return;

  console.log(`[webhook:telegram] ${parsed.senderName} (chat: ${parsed.chatId}, thread: ${parsed.threadId || 'none'}): ${parsed.text}`);

  try {
    // Find channel → writer mapping first (need agent role for command routing)
    let channel = null;

    if (parsed.threadId) {
      channel = await db.prepare(
        "SELECT mc.*, w.role AS writer_role FROM messaging_channels mc LEFT JOIN writers w ON w.id = mc.writer_id WHERE mc.platform = 'telegram' AND mc.channel_id = $1 AND mc.thread_id = $2 AND mc.is_active = true"
      ).get(parsed.chatId, parsed.threadId);
    }

    if (!channel) {
      channel = await db.prepare(
        "SELECT mc.*, w.role AS writer_role FROM messaging_channels mc LEFT JOIN writers w ON w.id = mc.writer_id WHERE mc.platform = 'telegram' AND mc.channel_id = $1 AND (mc.thread_id IS NULL OR mc.thread_id = '') AND mc.is_active = true"
      ).get(parsed.chatId);
    }

    // Check for newsroom commands (editors skip this — they handle their own)
    const { handleNewsroomCommand } = require('../lib/messaging');
    const newsroomResponse = await handleNewsroomCommand(req.tenantId, parsed.text, parsed.chatId, channel?.writer_role);
    if (newsroomResponse) {
      const { sendTelegramMessage } = require('../lib/messaging/telegram');
      await sendTelegramMessage(parsed.chatId, newsroomResponse, req.tenantId, parsed.threadId);
      return;
    }

    if (!channel) {
      const { sendTelegramMessage, getBotToken } = require('../lib/messaging/telegram');
      const token = await getBotToken(req.tenantId);
      if (token) {
        let helpMsg = 'This chat is not configured. Add this chat ID in Settings > Messaging:\n\n' + parsed.chatId;
        if (parsed.threadId) helpMsg += '\nTopic thread ID: ' + parsed.threadId;
        await sendTelegramMessage(parsed.chatId, helpMsg, req.tenantId, parsed.threadId);
      }
      return;
    }

    const writerId = channel.writer_id;
    if (!writerId) {
      const { sendTelegramMessage } = require('../lib/messaging/telegram');
      await sendTelegramMessage(parsed.chatId, 'No writer assigned to this channel. Set one in Settings > Messaging.', channel.tenant_id, parsed.threadId);
      return;
    }

    // Route to writer (with conversation context)
    const { handleIncoming } = require('../lib/messaging');
    const { buildContextKey } = require('../lib/messaging/context');
    const contextKey = buildContextKey('telegram', parsed.chatId, parsed.threadId);
    const response = await handleIncoming(channel.tenant_id, writerId, parsed.text, contextKey);

    const { sendTelegramMessage } = require('../lib/messaging/telegram');
    await sendTelegramMessage(parsed.chatId, response, channel.tenant_id, parsed.threadId);
  } catch (err) {
    console.error('[webhook:telegram] Error:', err.message, err.stack);
    try {
      const { sendTelegramMessage } = require('../lib/messaging/telegram');
      await sendTelegramMessage(parsed.chatId, 'Sorry, something went wrong: ' + err.message, req.tenantId, parsed.threadId);
    } catch {}
  }
}));

// ── Slack Webhook ───────────────────────────────────────────────

router.post('/slack', asyncHandler(async (req, res) => {
  const { parseEvent } = require('../lib/messaging/slack');
  const parsed = parseEvent(req.body);

  // URL verification challenge
  if (parsed?.type === 'challenge') {
    return res.json({ challenge: parsed.challenge });
  }

  res.json({ ok: true });
  if (!parsed || parsed.type !== 'message') return;

  console.log(`[webhook:slack] ${parsed.senderName} (channel: ${parsed.chatId}): ${parsed.text}`);

  try {
    // Find channel first (need agent role for command routing)
    let channel = await db.prepare(
      "SELECT mc.*, w.role AS writer_role FROM messaging_channels mc LEFT JOIN writers w ON w.id = mc.writer_id WHERE mc.platform = 'slack' AND mc.channel_id = $1 AND mc.is_active = true"
    ).get(parsed.chatId);

    // Check for newsroom commands (editors skip this)
    const { handleNewsroomCommand } = require('../lib/messaging');
    const newsroomResponse = await handleNewsroomCommand(req.tenantId, parsed.text, parsed.chatId, channel?.writer_role);
    if (newsroomResponse) {
      const { sendSlackMessage } = require('../lib/messaging/slack');
      await sendSlackMessage(parsed.chatId, newsroomResponse, req.tenantId, parsed.threadId);
      return;
    }

    if (!channel) {
      const { sendSlackMessage } = require('../lib/messaging/slack');
      await sendSlackMessage(parsed.chatId, 'This channel is not configured. Add channel ID `' + parsed.chatId + '` in Settings > Messaging.', req.tenantId);
      return;
    }

    if (!channel.writer_id) {
      const { sendSlackMessage } = require('../lib/messaging/slack');
      await sendSlackMessage(parsed.chatId, 'No writer assigned to this channel.', channel.tenant_id);
      return;
    }

    const { handleIncoming } = require('../lib/messaging');
    const { buildContextKey } = require('../lib/messaging/context');
    const contextKey = buildContextKey('slack', parsed.chatId);
    const response = await handleIncoming(channel.tenant_id, channel.writer_id, parsed.text, contextKey);

    const { sendSlackMessage } = require('../lib/messaging/slack');
    await sendSlackMessage(parsed.chatId, response, channel.tenant_id, parsed.threadId);
  } catch (err) {
    console.error('[webhook:slack] Error:', err.message);
  }
}));

module.exports = router;
