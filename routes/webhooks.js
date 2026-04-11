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
    // Check for newsroom commands first (group-level, no specific writer needed)
    const { handleNewsroomCommand } = require('../lib/messaging');
    const newsroomResponse = await handleNewsroomCommand(req.tenantId, parsed.text, parsed.chatId);
    if (newsroomResponse) {
      const { sendTelegramMessage } = require('../lib/messaging/telegram');
      await sendTelegramMessage(parsed.chatId, newsroomResponse, req.tenantId, parsed.threadId);
      return;
    }

    // Find channel → writer mapping
    let channel = null;

    if (parsed.threadId) {
      // Topic message — match by chat_id + thread_id
      channel = await db.prepare(
        "SELECT * FROM messaging_channels WHERE platform = 'telegram' AND channel_id = $1 AND thread_id = $2 AND is_active = true"
      ).get(parsed.chatId, parsed.threadId);
    }

    if (!channel) {
      // DM or general group message — match by chat_id with no thread_id
      channel = await db.prepare(
        "SELECT * FROM messaging_channels WHERE platform = 'telegram' AND channel_id = $1 AND (thread_id IS NULL OR thread_id = '') AND is_active = true"
      ).get(parsed.chatId);
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

    // Route to writer
    const { handleIncoming } = require('../lib/messaging');
    const response = await handleIncoming(channel.tenant_id, writerId, parsed.text);

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

module.exports = router;
