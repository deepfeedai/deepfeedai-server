/**
 * Discord Bot Integration — send/receive messages via Discord API.
 * Setup: Discord Developer Portal → New Application → Bot → copy token.
 * Add bot to server with scope: bot, permissions: Send Messages, Read Message History, View Channels.
 * Interactions Endpoint URL: https://your-backend/api/webhooks/discord
 */
const db = require('../../db');
const { decryptSetting } = require('../crypto');

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Get the bot token for a tenant.
 */
async function getBotToken(tenantId) {
  const row = await db.prepare(
    "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'discord_bot_token'"
  ).get(tenantId);
  if (!row?.value) return null;
  try { return decryptSetting(row.value); } catch { return row.value; }
}

/**
 * Send a message to a Discord channel.
 */
async function sendDiscordMessage(channelId, text, tenantId) {
  const token = await getBotToken(tenantId);
  if (!token) return;

  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    console.error(`[discord] sendMessage error: ${err.slice(0, 200)}`);
    throw new Error(`Discord API error ${response.status}: ${err.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * List text channels in all guilds the bot is in.
 */
async function listChannels(tenantId) {
  const token = await getBotToken(tenantId);
  if (!token) return [];

  // Get guilds
  const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!guildsRes.ok) throw new Error('Failed to fetch Discord guilds');
  const guilds = await guildsRes.json();

  const channels = [];
  for (const guild of guilds) {
    const chRes = await fetch(`${DISCORD_API}/guilds/${guild.id}/channels`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!chRes.ok) continue;
    const guildChannels = await chRes.json();

    for (const ch of guildChannels) {
      // 0 = text channel, 15 = forum channel
      if (ch.type !== 0 && ch.type !== 15) continue;
      channels.push({
        chat_id: ch.id,
        thread_id: null,
        title: `${guild.name} > #${ch.name}`,
        type: ch.type === 15 ? 'forum' : 'text',
        last_message: ch.topic?.slice(0, 100) || '',
      });
    }
  }

  return channels;
}

/**
 * Parse an incoming Discord interaction/gateway event.
 * For webhook-based interactions (not gateway).
 */
function parseEvent(body) {
  // Interaction verification ping
  if (body.type === 1) return { type: 'ping' };

  // Message component or slash command — not handling these yet
  if (body.type !== 0 && !body.d) return null;

  // Gateway MESSAGE_CREATE event (if using gateway relay)
  const msg = body.d || body;
  if (!msg.content || msg.author?.bot) return null;

  return {
    type: 'message',
    chatId: msg.channel_id,
    threadId: null,
    text: msg.content.replace(/<@!?\d+>/g, '').trim(), // strip @mentions
    senderId: msg.author?.id || '',
    senderName: msg.author?.username || 'Unknown',
    isGroup: true,
  };
}

module.exports = { sendDiscordMessage, listChannels, parseEvent, getBotToken };
