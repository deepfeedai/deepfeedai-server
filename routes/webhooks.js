/**
 * Webhook endpoints for messaging integrations (Telegram, Slack, etc.)
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../lib/utils');

// POST /api/webhooks/telegram — incoming Telegram updates
router.post('/telegram', asyncHandler(async (req, res) => {
  // Respond immediately to avoid Telegram retries
  res.json({ ok: true });

  const { parseUpdate } = require('../lib/messaging/telegram');
  const parsed = parseUpdate(req.body);
  if (!parsed) {
    console.log('[webhook:telegram] No parseable message in update');
    return;
  }

  console.log(`[webhook:telegram] Message from ${parsed.senderName} (chat: ${parsed.chatId}, thread: ${parsed.threadId || 'none'}): ${parsed.text}`);

  try {
    let channel = null;

    // 1. If message is in a topic thread, look up by chat_id + thread_id
    if (parsed.threadId) {
      channel = await db.prepare(
        "SELECT * FROM messaging_channels WHERE platform = 'telegram' AND channel_id = $1 AND thread_id = $2 AND is_active = true"
      ).get(parsed.chatId, parsed.threadId);
    }

    // 2. Fall back to chat-level channel (no thread_id)
    if (!channel) {
      channel = await db.prepare(
        "SELECT * FROM messaging_channels WHERE platform = 'telegram' AND channel_id = $1 AND (thread_id IS NULL OR thread_id = '') AND is_active = true"
      ).get(parsed.chatId);
    }

    // 3. Last resort: any active telegram channel for this tenant
    if (!channel) {
      channel = await db.prepare(
        "SELECT * FROM messaging_channels WHERE platform = 'telegram' AND is_active = true AND tenant_id = $1 ORDER BY writer_id IS NOT NULL DESC LIMIT 1"
      ).get(req.tenantId);
    }

    if (!channel) {
      console.log(`[webhook:telegram] No channel configured for chat ${parsed.chatId} (tenant ${req.tenantId})`);
      const { sendTelegramMessage, getBotToken } = require('../lib/messaging/telegram');
      const token = await getBotToken(req.tenantId);
      if (token) {
        let helpMsg = 'This chat is not configured yet. Add this chat ID in Settings > Messaging:\n\n`' + parsed.chatId + '`';
        if (parsed.threadId) helpMsg += '\nTopic thread ID: `' + parsed.threadId + '`';
        await sendTelegramMessage(parsed.chatId, helpMsg, req.tenantId, parsed.threadId);
      }
      return;
    }

    const writerId = channel.writer_id;
    if (!writerId) {
      console.log('[webhook:telegram] Channel has no writer assigned');
      const { sendTelegramMessage } = require('../lib/messaging/telegram');
      await sendTelegramMessage(parsed.chatId, 'No writer is assigned to this channel. Assign one in Settings > Messaging.', channel.tenant_id, parsed.threadId);
      return;
    }

    console.log(`[webhook:telegram] Routing to writer ${writerId} (tenant ${channel.tenant_id})`);

    // Handle the message
    const { handleIncoming } = require('../lib/messaging');
    const response = await handleIncoming(channel.tenant_id, writerId, parsed.text);

    // Send response back to the same chat/thread
    const { sendTelegramMessage } = require('../lib/messaging/telegram');
    await sendTelegramMessage(parsed.chatId, response, channel.tenant_id, parsed.threadId);
    console.log(`[webhook:telegram] Response sent to ${parsed.chatId} (thread: ${parsed.threadId || 'none'})`);
  } catch (err) {
    console.error('[webhook:telegram] Error:', err.message, err.stack);
    // Try to send error feedback to the user
    try {
      const { sendTelegramMessage } = require('../lib/messaging/telegram');
      await sendTelegramMessage(parsed.chatId, 'Sorry, something went wrong: ' + err.message, req.tenantId, parsed.threadId);
    } catch {}
  }
}));

module.exports = router;
