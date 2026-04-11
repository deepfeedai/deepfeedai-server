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

  console.log(`[webhook:telegram] Message from ${parsed.senderName} (chat: ${parsed.chatId}): ${parsed.text}`);

  try {
    // Find the messaging channel for this chat — try exact match first, then any platform-wide channel
    let channel = await db.prepare(
      "SELECT * FROM messaging_channels WHERE platform = 'telegram' AND channel_id = $1 AND is_active = true"
    ).get(parsed.chatId);

    // If no exact chat match, try a channel with no specific chat_id assigned (wildcard)
    if (!channel) {
      channel = await db.prepare(
        "SELECT * FROM messaging_channels WHERE platform = 'telegram' AND is_active = true AND tenant_id = $1 ORDER BY writer_id IS NOT NULL DESC LIMIT 1"
      ).get(req.tenantId);
    }

    if (!channel) {
      console.log(`[webhook:telegram] No channel configured for chat ${parsed.chatId} (tenant ${req.tenantId})`);
      // Send a helpful reply
      const { sendTelegramMessage, getBotToken } = require('../lib/messaging/telegram');
      const token = await getBotToken(req.tenantId);
      if (token) {
        await sendTelegramMessage(parsed.chatId,
          'This chat is not configured yet. Add this chat ID in Settings > Messaging:\n\n`' + parsed.chatId + '`',
          req.tenantId
        );
      }
      return;
    }

    const writerId = channel.writer_id;
    if (!writerId) {
      console.log('[webhook:telegram] Channel has no writer assigned');
      const { sendTelegramMessage } = require('../lib/messaging/telegram');
      await sendTelegramMessage(parsed.chatId, 'No writer is assigned to this channel. Assign one in Settings > Messaging.', channel.tenant_id);
      return;
    }

    console.log(`[webhook:telegram] Routing to writer ${writerId} (tenant ${channel.tenant_id})`);

    // Handle the message
    const { handleIncoming } = require('../lib/messaging');
    const response = await handleIncoming(channel.tenant_id, writerId, parsed.text);

    // Send response back
    const { sendTelegramMessage } = require('../lib/messaging/telegram');
    await sendTelegramMessage(parsed.chatId, response, channel.tenant_id);
    console.log(`[webhook:telegram] Response sent to ${parsed.chatId}`);
  } catch (err) {
    console.error('[webhook:telegram] Error:', err.message, err.stack);
  }
}));

module.exports = router;
