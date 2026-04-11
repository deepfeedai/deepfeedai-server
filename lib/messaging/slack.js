/**
 * Slack Bot Integration — send/receive messages via Slack Bot API.
 * Setup: Create Slack App → Bot Token Scopes (chat:write, channels:read, groups:read) → Install → copy Bot OAuth Token.
 * Event Subscriptions URL: https://your-backend/api/webhooks/slack
 * Subscribe to bot events: message.channels, message.groups, app_mention
 */
const db = require('../../db');
const { decryptSetting } = require('../crypto');
const { splitMessage } = require('./split');

const SLACK_API = 'https://slack.com/api';

/**
 * Get the bot token for a tenant.
 */
async function getBotToken(tenantId) {
  const row = await db.prepare(
    "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'slack_bot_token'"
  ).get(tenantId);
  if (!row?.value) return null;
  try { return decryptSetting(row.value); } catch { return row.value; }
}

/**
 * Send a message to a Slack channel (optionally in a thread).
 */
async function sendSlackMessage(channelId, text, tenantId, threadTs) {
  const token = await getBotToken(tenantId);
  if (!token) return;

  const chunks = splitMessage(text, 'slack');
  let lastData;

  for (let i = 0; i < chunks.length; i++) {
    const body = { channel: channelId, text: chunks[i] };
    // First chunk uses provided threadTs; subsequent chunks reply in the same thread
    if (threadTs) body.thread_ts = threadTs;
    else if (i > 0 && lastData?.ts) body.thread_ts = lastData.ts;

    const response = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    lastData = await response.json();
    if (!lastData.ok) {
      console.error(`[slack] sendMessage error: ${lastData.error}`);
      throw new Error(`Slack API error: ${lastData.error}`);
    }
  }
  return lastData;
}

/**
 * List channels the bot has access to.
 */
async function listChannels(tenantId) {
  const token = await getBotToken(tenantId);
  if (!token) return [];

  const channels = [];
  let cursor = '';

  do {
    const url = `${SLACK_API}/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200${cursor ? '&cursor=' + cursor : ''}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);

    for (const ch of (data.channels || [])) {
      if (ch.is_member) {
        channels.push({
          chat_id: ch.id,
          thread_id: null,
          title: ch.name || ch.id,
          type: ch.is_private ? 'private_channel' : 'public_channel',
          last_message: ch.topic?.value?.slice(0, 100) || '',
        });
      }
    }
    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);

  return channels;
}

/**
 * Parse an incoming Slack event.
 */
function parseEvent(body) {
  // URL verification challenge
  if (body.type === 'url_verification') return { type: 'challenge', challenge: body.challenge };

  const event = body.event;
  if (!event || !event.text) return null;
  // Ignore bot's own messages
  if (event.bot_id || event.subtype === 'bot_message') return null;

  return {
    type: 'message',
    chatId: event.channel,
    threadId: event.thread_ts || null,
    text: event.text.replace(/<@[A-Z0-9]+>/g, '').trim(), // strip @mentions
    senderId: event.user || '',
    senderName: event.user || 'Unknown',
    isGroup: true, // Slack channels are always group-like
  };
}

module.exports = { sendSlackMessage, listChannels, parseEvent, getBotToken };
