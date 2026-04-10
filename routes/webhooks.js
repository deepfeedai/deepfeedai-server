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
  const { handleIncoming } = require('../lib/messaging');

  const parsed = parseUpdate(req.body);
  if (!parsed) return;

  try {
    // Find the messaging channel for this chat
    const channel = await db.prepare(
      "SELECT * FROM messaging_channels WHERE platform = 'telegram' AND channel_id = $1 AND is_active = true"
    ).get(parsed.chatId);

    if (!channel) return; // Unknown chat, ignore

    const writerId = channel.writer_id;
    if (!writerId) return; // No writer assigned to this channel

    // Handle the message
    const response = await handleIncoming(channel.tenant_id, writerId, parsed.text);

    // Send response back
    const { sendTelegramMessage } = require('../lib/messaging/telegram');
    await sendTelegramMessage(parsed.chatId, response, channel.tenant_id);
  } catch (err) {
    console.error('[webhook:telegram] Error:', err.message);
  }
}));

module.exports = router;
