/**
 * Discord Gateway — persistent WebSocket connection for receiving regular channel messages.
 * Complements the slash-command Interactions Endpoint (routes/discord-webhook.js).
 * One discord.js Client per tenant, managed via a Map.
 *
 * Replies are sent via Discord channel webhooks so each writer's response shows
 * with the writer's name and avatar image instead of the generic bot identity.
 */
const { Client, GatewayIntentBits, Events } = require('discord.js');
const db = require('../../db');
const { getBotToken } = require('./discord');
const { handleIncoming, handleNewsroomCommand } = require('../messaging');
const { buildContextKey } = require('./context');
const { getAppConfig } = require('../app-config');
const { splitMessage } = require('./split');

const DISCORD_MSG_LIMIT = 2000;
const DISCORD_CHUNK_DELAY = 300; // ms between multi-message sends

/** Cache of channel webhook instances: channelId -> Webhook */
const webhookCache = new Map();

/** @type {Map<number, { client: Client, tenantId: number }>} */
const clients = new Map();

/**
 * Start Gateway connections for all tenants that have a Discord bot token.
 * Called once on server startup.
 */
async function startAllGateways() {
  const rows = await db.prepare(
    "SELECT DISTINCT s.tenant_id FROM settings s WHERE s.key = 'discord_bot_token' AND s.value IS NOT NULL AND s.value != ''"
  ).all();

  for (const row of rows) {
    try {
      await startGateway(row.tenant_id);
      // Stagger connections to respect Discord's identify rate limit (1 per 5s)
      if (rows.length > 1) await new Promise(r => setTimeout(r, 5500));
    } catch (err) {
      console.error(`[discord-gw] Failed to start gateway for tenant ${row.tenant_id}:`, err.message);
    }
  }
}

/**
 * Start a Gateway connection for a single tenant.
 */
async function startGateway(tenantId) {
  const token = await getBotToken(tenantId);
  if (!token) {
    console.log(`[discord-gw] No bot token for tenant ${tenantId}, skipping`);
    return;
  }

  // Stop existing connection if any
  if (clients.has(tenantId)) {
    await stopGateway(tenantId);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.ClientReady, () => {
    console.log(`[discord-gw] Connected as ${client.user.tag} for tenant ${tenantId}`);
  });

  client.on(Events.Error, (err) => {
    console.error(`[discord-gw] Client error (tenant ${tenantId}):`, err.message);
  });

  client.on(Events.MessageCreate, (message) => {
    handleMessage(tenantId, message).catch(err => {
      console.error(`[discord-gw] Message handler error:`, err.message);
    });
  });

  await client.login(token);
  clients.set(tenantId, { client, tenantId });
}

/**
 * Stop a Gateway connection for a tenant.
 */
async function stopGateway(tenantId) {
  const entry = clients.get(tenantId);
  if (!entry) return;
  try {
    entry.client.destroy();
  } catch {}
  clients.delete(tenantId);
  console.log(`[discord-gw] Disconnected gateway for tenant ${tenantId}`);
}

/**
 * Restart a Gateway connection (e.g. after token change).
 */
async function restartGateway(tenantId) {
  await stopGateway(tenantId);
  await startGateway(tenantId);
}

/**
 * Handle an incoming Discord message from the Gateway.
 */
async function handleMessage(tenantId, message) {
  // Ignore bots (including self)
  if (message.author.bot) return;

  // Ignore messages with no text content
  const text = message.content?.replace(/<@!?\d+>/g, '').trim();
  if (!text) return;

  const channelId = message.channel.id;

  // Look up channel → writer mapping
  const channel = await db.prepare(
    "SELECT mc.*, w.name AS writer_name, w.avatar_url AS writer_avatar, w.role AS writer_role FROM messaging_channels mc LEFT JOIN writers w ON w.id = mc.writer_id WHERE mc.platform = 'discord' AND mc.channel_id = $1 AND mc.is_active = true"
  ).get(channelId);

  // Only respond in configured channels (don't spam unconfigured ones with gateway)
  if (!channel) return;

  if (!channel.writer_id) {
    await sendReply(message, 'No writer assigned to this channel. Set one in Settings > Messaging.');
    return;
  }

  console.log(`[discord-gw] ${message.author.username} (channel: ${channelId}): ${text}`);

  // Resolve avatar to absolute URL if needed
  const avatarUrl = await resolveAvatarUrl(channel.writer_avatar, tenantId);

  // Check for newsroom commands first (editors skip this — they handle their own commands)
  const newsroomResponse = await handleNewsroomCommand(tenantId, text, channelId, channel.writer_role);
  if (newsroomResponse) {
    await sendWriterReply(message, newsroomResponse, channel.writer_name, avatarUrl);
    return;
  }

  // Route to writer with conversation context
  const contextKey = buildContextKey('discord', channelId);
  const response = await handleIncoming(channel.tenant_id, channel.writer_id, text, contextKey);

  // /new returns an object with clearChannel flag
  if (response && typeof response === 'object' && response.clearChannel) {
    await bulkDeleteMessages(message.channel);
    await sendWriterReply(message, response.text, channel.writer_name, avatarUrl);
    return;
  }

  await sendWriterReply(message, response, channel.writer_name, avatarUrl);
}

/**
 * Get or create a Discord webhook for a channel.
 * Webhooks let us send messages with a custom username + avatar per writer.
 */
async function getOrCreateWebhook(channel) {
  const channelId = channel.id;
  if (webhookCache.has(channelId)) return webhookCache.get(channelId);

  try {
    // Check for an existing webhook we created
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(w => w.name === 'DeepFeed Writer');

    if (!webhook) {
      webhook = await channel.createWebhook({ name: 'DeepFeed Writer' });
      console.log(`[discord-gw] Created webhook for channel ${channelId}`);
    }

    webhookCache.set(channelId, webhook);
    return webhook;
  } catch (err) {
    console.error(`[discord-gw] Failed to get/create webhook for ${channelId}:`, err.message);
    return null;
  }
}

/**
 * Resolve a writer's avatar_url to an absolute URL that Discord can use.
 * Storage backends may return relative paths (local: /media/..., db: /api/media/...).
 */
async function resolveAvatarUrl(avatarUrl, tenantId) {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith('http')) return avatarUrl;

  // Relative path — prepend the backend's base_url
  try {
    const config = await getAppConfig(tenantId);
    const baseUrl = (config.base_url || '').replace(/\/$/, '');
    if (baseUrl) return baseUrl + avatarUrl;
  } catch {}

  return null; // Can't resolve — Discord won't show an avatar
}

/**
 * Send a reply as the writer (using webhook for custom name + avatar).
 * Falls back to regular channel.send if webhook creation fails.
 */
async function sendWriterReply(message, text, writerName, avatarURL) {
  const chunks = splitMessage(text, 'discord');

  try {
    const webhook = await getOrCreateWebhook(message.channel);
    if (webhook && writerName) {
      console.log(`[discord-gw] Sending as "${writerName}" avatar=${avatarURL || 'none'} chunks=${chunks.length} total_length=${text.length}`);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, DISCORD_CHUNK_DELAY));
        const result = await webhook.send({
          content: chunks[i],
          username: writerName,
          avatarURL: avatarURL || undefined,
        });
        console.log(`[discord-gw] Webhook send chunk ${i + 1}/${chunks.length}: msg_id=${result?.id}`);
      }
      return;
    }
    console.warn(`[discord-gw] No webhook or writerName — webhook=${!!webhook} writerName=${writerName}`);
  } catch (err) {
    console.error(`[discord-gw] Webhook send failed (${err.code || 'unknown'}), falling back:`, err.message, err.stack);
  }

  // Fallback to regular bot message
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, DISCORD_CHUNK_DELAY));
      await message.channel.send(chunks[i]);
    }
  } catch (err) {
    console.error(`[discord-gw] Failed to send reply:`, err.message);
  }
}

/**
 * Bulk delete recent messages in a Discord channel.
 * Discord API allows deleting messages less than 14 days old, up to 100 at a time.
 */
async function bulkDeleteMessages(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const deletable = messages.filter(m => m.createdTimestamp > twoWeeksAgo);
    if (deletable.size > 1) {
      await channel.bulkDelete(deletable);
      console.log(`[discord-gw] Bulk deleted ${deletable.size} messages in ${channel.id}`);
    } else if (deletable.size === 1) {
      await deletable.first().delete();
    }
  } catch (err) {
    console.error(`[discord-gw] Bulk delete failed:`, err.message);
  }
}

/**
 * Send a plain reply (no writer identity — used for error/config messages).
 */
async function sendReply(message, text) {
  const chunks = splitMessage(text, 'discord');
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, DISCORD_CHUNK_DELAY));
      await message.channel.send(chunks[i]);
    }
  } catch (err) {
    console.error(`[discord-gw] Failed to send reply:`, err.message);
  }
}

/**
 * Graceful shutdown — destroy all clients.
 */
function destroyAll() {
  for (const [tenantId, entry] of clients) {
    try { entry.client.destroy(); } catch {}
  }
  clients.clear();
}

/**
 * Get the client map for diagnostics.
 */
function getClients() {
  return clients;
}

module.exports = {
  startAllGateways,
  startGateway,
  stopGateway,
  restartGateway,
  destroyAll,
  getClients,
};
