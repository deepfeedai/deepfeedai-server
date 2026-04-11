/**
 * Discord Gateway — persistent WebSocket connection for receiving regular channel messages.
 * Complements the slash-command Interactions Endpoint (routes/discord-webhook.js).
 * One discord.js Client per tenant, managed via a Map.
 */
const { Client, GatewayIntentBits, Events } = require('discord.js');
const db = require('../../db');
const { getBotToken } = require('./discord');
const { handleIncoming, handleNewsroomCommand } = require('../messaging');
const { buildContextKey } = require('./context');

const DISCORD_MSG_LIMIT = 2000;

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
    "SELECT * FROM messaging_channels WHERE platform = 'discord' AND channel_id = $1 AND is_active = true"
  ).get(channelId);

  // Only respond in configured channels (don't spam unconfigured ones with gateway)
  if (!channel) return;

  if (!channel.writer_id) {
    await sendReply(message, 'No writer assigned to this channel. Set one in Settings > Messaging.');
    return;
  }

  console.log(`[discord-gw] ${message.author.username} (channel: ${channelId}): ${text}`);

  // Check for newsroom commands first
  const newsroomResponse = await handleNewsroomCommand(tenantId, text, channelId);
  if (newsroomResponse) {
    await sendReply(message, newsroomResponse);
    return;
  }

  // Route to writer with conversation context
  const contextKey = buildContextKey('discord', channelId);
  const response = await handleIncoming(channel.tenant_id, channel.writer_id, text, contextKey);
  await sendReply(message, response);
}

/**
 * Send a reply in the same channel, truncated to Discord's limit.
 */
async function sendReply(message, text) {
  const content = text.length > DISCORD_MSG_LIMIT
    ? text.slice(0, DISCORD_MSG_LIMIT - 3) + '...'
    : text;
  try {
    await message.channel.send(content);
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
