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

  // Inline-keyboard button presses (PR-C of notifications/actions).
  // These never go through the writer chat pipeline.
  if (req.body && req.body.callback_query) {
    await handleTelegramCallback(req.body.callback_query, req.tenantId).catch(err => {
      console.error('[webhook:telegram] callback handler crashed:', err.message);
    });
    return;
  }

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
    const userMeta = { userId: String(parsed.senderId || ''), userName: parsed.senderName, platform: 'telegram' };
    const response = await handleIncoming(channel.tenant_id, writerId, parsed.text, contextKey, userMeta);

    // Voice response: { text, voice: true, writerId }
    if (response && typeof response === 'object' && response.voice) {
      const { generateVoiceResponse } = require('../lib/media-helpers');
      const voiceResult = await generateVoiceResponse(response.text, response.writerId, channel.tenant_id);
      if (voiceResult) {
        const { sendTelegramVoice } = require('../lib/messaging/telegram');
        await sendTelegramVoice(parsed.chatId, voiceResult.buffer, response.text.slice(0, 200) + '...', channel.tenant_id, parsed.threadId);
      } else {
        const { sendTelegramMessage } = require('../lib/messaging/telegram');
        await sendTelegramMessage(parsed.chatId, response.text + '\n\n(Voice not available — no ElevenLabs voice configured)', channel.tenant_id, parsed.threadId);
      }
      return;
    }

    const { sendTelegramMessage } = require('../lib/messaging/telegram');
    const responseText = (typeof response === 'object' && response.text) ? response.text : response;
    await sendTelegramMessage(parsed.chatId, responseText, channel.tenant_id, parsed.threadId);
  } catch (err) {
    console.error('[webhook:telegram] Error:', err.message, err.stack);
    try {
      const { sendTelegramMessage } = require('../lib/messaging/telegram');
      await sendTelegramMessage(parsed.chatId, 'Sorry, something went wrong: ' + err.message, req.tenantId, parsed.threadId);
    } catch {}
  }
}));

/**
 * Handle an inline-keyboard button press. Our buttons have callback_data
 * formatted as `act:<token>`. We verify+burn the token, dispatch via the
 * shared handler registry (same path as POST /api/actions/:token), toast
 * the user, and strip the keyboard off the original message.
 */
async function handleTelegramCallback(cq, tenantId) {
  const {
    answerCallbackQuery,
    editMessageReplyMarkup,
  } = require('../lib/messaging/telegram');

  const data = cq.data || '';
  if (!data.startsWith('act:')) {
    await answerCallbackQuery(cq.id, '', tenantId);
    return;
  }
  const rawToken = data.slice('act:'.length);
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  const { verifyAndBurn } = require('../lib/action-tokens');
  const { getHandler } = require('../lib/actions/handlers');
  const { isFeatureEnabled } = require('../lib/feature-registry');
  const { logAudit } = require('../middleware/audit');

  let row;
  try {
    row = await verifyAndBurn(rawToken, 'telegram');
  } catch (err) {
    const toast =
      err.message === 'already_used' ? 'Already actioned' :
      err.message === 'expired'      ? 'Link expired' :
      'Invalid or unknown action';
    await answerCallbackQuery(cq.id, toast, tenantId);
    return;
  }

  // Feature flag scoped to the token's tenant.
  const enabled = await isFeatureEnabled(row.tenant_id, 'cross_channel_actions').catch(() => false);
  if (!enabled) {
    await answerCallbackQuery(cq.id, 'Cross-channel actions disabled', row.tenant_id);
    return;
  }

  const handler = getHandler(row.action_kind);
  if (!handler) {
    await answerCallbackQuery(cq.id, `Unknown action: ${row.action_kind}`, row.tenant_id);
    return;
  }

  const pseudoReq = {
    user: { sub: row.user_id },
    tenantId: row.tenant_id,
    headers: {},
    ip: 'telegram',
  };

  let result;
  try {
    result = await handler(row, pseudoReq);
  } catch (err) {
    logAudit(pseudoReq, `${row.action_kind}.failed`, row.target_type || 'action',
      row.target_id || row.id, { source: 'telegram', error: err.message }).catch(() => {});
    await answerCallbackQuery(cq.id, `Error: ${err.message}`, row.tenant_id);
    return;
  }

  logAudit(pseudoReq, row.action_kind, row.target_type || 'action',
    row.target_id || row.id, { source: 'telegram', ok: result.ok, via: 'action_token' });

  const toast = result.ok
    ? (result.message || 'Done')
    : (result.message || 'Action not applied');
  await answerCallbackQuery(cq.id, toast, row.tenant_id);

  // Remove the buttons from the original message so it can't be pressed again.
  if (chatId && messageId) {
    await editMessageReplyMarkup(chatId, messageId, row.tenant_id, []);
  }
}

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
    const userMeta = { userId: parsed.senderId || '', userName: parsed.senderName, platform: 'slack' };
    const response = await handleIncoming(channel.tenant_id, channel.writer_id, parsed.text, contextKey, userMeta);

    const { sendSlackMessage } = require('../lib/messaging/slack');
    const responseText = (typeof response === 'object' && response.text) ? response.text : response;
    await sendSlackMessage(parsed.chatId, responseText, channel.tenant_id, parsed.threadId);
  } catch (err) {
    console.error('[webhook:slack] Error:', err.message);
  }
}));

module.exports = router;
