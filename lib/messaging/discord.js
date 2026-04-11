/**
 * Discord Bot Integration — send/receive via Discord Application Commands (slash commands).
 * Setup: Discord Developer Portal > New Application > Bot > copy token.
 * Add bot to server with scope: bot + applications.commands, permissions: Send Messages, Read Message History, View Channels.
 * Interactions Endpoint URL: https://your-backend/api/webhooks/discord
 * After saving tokens in settings, click "Register Commands" to push slash commands to Discord.
 */
const db = require('../../db');
const { decryptSetting } = require('../crypto');
const nacl = require('tweetnacl');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_MSG_LIMIT = 2000;

/**
 * Slash command definitions registered with Discord.
 */
const SLASH_COMMANDS = [
  { name: 'status',  description: 'Current writer status',          type: 1 },
  { name: 'memory',  description: 'Active editorial memories',      type: 1 },
  { name: 'pitch',   description: 'Scan beat and pitch stories now', type: 1 },
  { name: 'latest',  description: 'Recent published articles',      type: 1 },
  { name: 'help',    description: 'List available commands',         type: 1 },
  { name: 'clear',   description: 'Clear conversation history',     type: 1 },
  { name: 'standup', description: 'All writers report status',       type: 1 },
  { name: 'brief',   description: "Today's published articles",     type: 1 },
  { name: 'ask',     description: 'Ask about a topic', type: 1, options: [
    { name: 'question', description: 'Your question', type: 3, required: true },
  ]},
  { name: 'assign',  description: 'Who should cover this topic?', type: 1, options: [
    { name: 'topic', description: 'The topic to assign', type: 3, required: true },
  ]},
];

// ── Token / Settings Helpers ───────────────────────────────────

/**
 * Get the bot token for a tenant (decrypted from settings).
 */
async function getBotToken(tenantId) {
  const row = await db.prepare(
    "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'discord_bot_token'"
  ).get(tenantId);
  if (!row?.value) return null;
  try { return decryptSetting(row.value); } catch { return row.value; }
}

/**
 * Get Discord application settings for a tenant.
 */
async function getAppSettings(tenantId) {
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN ('discord_app_id', 'discord_public_key')"
  ).all(tenantId);
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return { appId: map.discord_app_id || null, publicKey: map.discord_public_key || null };
}

/**
 * Reverse lookup: find tenant by Discord application ID.
 */
async function getTenantByAppId(appId) {
  const row = await db.prepare(
    "SELECT tenant_id FROM settings WHERE key = 'discord_app_id' AND value = $1"
  ).get(String(appId));
  return row?.tenant_id || null;
}

// ── Signature Verification ─────────────────────────────────────

/**
 * Verify a Discord interaction signature (Ed25519).
 * @param {string} rawBody - Raw request body as string
 * @param {string} signature - X-Signature-Ed25519 header
 * @param {string} timestamp - X-Signature-Timestamp header
 * @param {string} publicKey - Hex-encoded public key from Discord app settings
 * @returns {boolean}
 */
function verifyInteraction(rawBody, signature, timestamp, publicKey) {
  try {
    const msg = Buffer.from(timestamp + rawBody);
    const sig = Buffer.from(signature, 'hex');
    const key = Buffer.from(publicKey, 'hex');
    return nacl.sign.detached.verify(msg, sig, key);
  } catch {
    return false;
  }
}

// ── Sending Messages ───────────────────────────────────────────

/**
 * Send a message to a Discord channel (used for outbound notifications).
 */
async function sendDiscordMessage(channelId, text, tenantId) {
  const token = await getBotToken(tenantId);
  if (!token) return;

  const content = text.length > DISCORD_MSG_LIMIT
    ? text.slice(0, DISCORD_MSG_LIMIT - 3) + '...'
    : text;

  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
    body: JSON.stringify({ content }),
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
 * Send a follow-up response to a deferred interaction.
 */
async function sendFollowup(appId, interactionToken, text) {
  const content = text.length > DISCORD_MSG_LIMIT
    ? text.slice(0, DISCORD_MSG_LIMIT - 3) + '...'
    : text;

  const response = await fetch(`${DISCORD_API}/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    console.error(`[discord] followup error: ${err.slice(0, 200)}`);
    throw new Error(`Discord followup error ${response.status}: ${err.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Delete the deferred interaction response (the "thinking" message).
 */
async function deleteFollowup(appId, interactionToken) {
  const response = await fetch(`${DISCORD_API}/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => '');
    console.error(`[discord] deleteFollowup error: ${err.slice(0, 200)}`);
  }
}

/** Cache of channel webhook IDs: channelId -> { id, token } */
const _webhookCache = new Map();

/**
 * Get or create a channel webhook via REST API (for use outside the gateway).
 * Returns { id, token } or null.
 */
async function getOrCreateChannelWebhook(channelId, tenantId) {
  if (_webhookCache.has(channelId)) return _webhookCache.get(channelId);

  const botToken = await getBotToken(tenantId);
  if (!botToken) return null;

  try {
    // List existing webhooks for this channel
    const listRes = await fetch(`${DISCORD_API}/channels/${channelId}/webhooks`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!listRes.ok) return null;
    const webhooks = await listRes.json();
    let wh = webhooks.find(w => w.name === 'DeepFeed Writer');

    if (!wh) {
      // Create one
      const createRes = await fetch(`${DISCORD_API}/channels/${channelId}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
        body: JSON.stringify({ name: 'DeepFeed Writer' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!createRes.ok) return null;
      wh = await createRes.json();
    }

    const entry = { id: wh.id, token: wh.token };
    _webhookCache.set(channelId, entry);
    return entry;
  } catch (err) {
    console.error(`[discord] getOrCreateChannelWebhook error:`, err.message);
    return null;
  }
}

/**
 * Send a message via channel webhook with custom writer name + avatar (REST API).
 * Used by slash commands to show writer identity instead of bot identity.
 */
async function sendAsWriter(channelId, text, tenantId, writerName, avatarUrl) {
  const wh = await getOrCreateChannelWebhook(channelId, tenantId);
  if (!wh) return false;

  const content = text.length > DISCORD_MSG_LIMIT
    ? text.slice(0, DISCORD_MSG_LIMIT - 3) + '...'
    : text;

  const body = { content, username: writerName };
  if (avatarUrl?.startsWith('http')) body.avatar_url = avatarUrl;

  const response = await fetch(`${DISCORD_API}/webhooks/${wh.id}/${wh.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    console.error(`[discord] sendAsWriter error: ${err.slice(0, 200)}`);
    return false;
  }
  return true;
}

// ── Channel Discovery ──────────────────────────────────────────

/**
 * List text channels in all guilds the bot is in.
 */
async function listChannels(tenantId) {
  const token = await getBotToken(tenantId);
  if (!token) return [];

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

// ── Command Registration ───────────────────────────────────────

/**
 * Register (or update) slash commands with Discord for this tenant's app.
 * Uses PUT to replace all global commands (idempotent).
 */
async function registerCommands(tenantId) {
  const token = await getBotToken(tenantId);
  const { appId } = await getAppSettings(tenantId);
  if (!token) throw new Error('No Discord bot token configured');
  if (!appId) throw new Error('No Discord Application ID configured');

  const response = await fetch(`${DISCORD_API}/applications/${appId}/commands`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
    body: JSON.stringify(SLASH_COMMANDS),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Discord command registration error ${response.status}: ${err.slice(0, 300)}`);
  }

  const result = await response.json();
  console.log(`[discord] Registered ${result.length} slash commands for tenant ${tenantId}`);
  return result;
}

module.exports = {
  sendDiscordMessage,
  sendFollowup,
  deleteFollowup,
  sendAsWriter,
  listChannels,
  getBotToken,
  getAppSettings,
  getTenantByAppId,
  verifyInteraction,
  registerCommands,
  SLASH_COMMANDS,
};
