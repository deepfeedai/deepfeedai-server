/**
 * Discord Interactions Webhook — /api/webhooks/discord
 * Handles slash commands via Discord Application Commands.
 * Mounted BEFORE express.json() body parser (needs raw body for Ed25519 signature verification).
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getTenantByAppId, getAppSettings, verifyInteraction, sendFollowup, deleteFollowup, sendAsWriter } = require('../lib/messaging/discord');
const { handleIncoming, handleNewsroomCommand } = require('../lib/messaging');
const { getAppConfig } = require('../lib/app-config');

const NEWSROOM_COMMANDS = new Set(['standup', 'brief', 'assign', 'help']);

// GET health check
router.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Discord interactions endpoint is active' });
});

// POST — Discord interactions (raw body for signature verification)
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    let body;
    try {
      body = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    console.log(`[webhook:discord] Interaction type=${body.type} app=${body.application_id}`);

    // ── Resolve tenant from application_id ──
    const appId = body.application_id;
    if (!appId) return res.status(400).json({ error: 'Missing application_id' });

    const tenantId = await getTenantByAppId(appId);
    if (!tenantId) {
      // Still handle PING for initial setup (Discord sends ping before tenant is fully configured)
      if (body.type === 1) return res.json({ type: 1 });
      console.error(`[webhook:discord] No tenant found for app_id=${appId}`);
      return res.status(404).json({ error: 'Unknown application' });
    }

    // ── Verify Ed25519 signature ──
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const { publicKey } = await getAppSettings(tenantId);

    if (!publicKey || !signature || !timestamp) {
      console.error(`[webhook:discord] Missing sig/key: publicKey=${!!publicKey} sig=${!!signature} ts=${!!timestamp}`);
      return res.status(401).json({ error: 'Missing signature or public key' });
    }

    if (!verifyInteraction(req.body.toString(), signature, timestamp, publicKey)) {
      console.error('[webhook:discord] Signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── Type 1: PING ──
    if (body.type === 1) {
      console.log('[webhook:discord] PING — responding with PONG');
      return res.json({ type: 1 });
    }

    // ── Type 2: APPLICATION_COMMAND ──
    if (body.type === 2) {
      const data = body.data || {};
      const commandName = data.name;
      const channelId = body.channel_id;
      const interactionToken = body.token;
      const userName = body.member?.user?.username || body.user?.username || 'Unknown';

      // Extract options (for /ask and /assign)
      const options = {};
      for (const opt of (data.options || [])) {
        options[opt.name] = opt.value;
      }

      // Build the text command that messaging.js expects
      let commandText;
      if (commandName === 'ask') {
        commandText = '/ask ' + (options.question || '');
      } else if (commandName === 'assign') {
        commandText = '/assign ' + (options.topic || '');
      } else if (commandName === 'update') {
        commandText = '/update ' + (options.instruction || '');
      } else if (commandName === 'resync') {
        commandText = '/resync ' + (options.search || '');
      } else {
        commandText = '/' + commandName;
      }

      console.log(`[webhook:discord] ${userName} (channel: ${channelId}): ${commandText}`);

      // /help can respond immediately (fast, no AI)
      if (commandName === 'help') {
        const { getHelpText } = require('../lib/messaging');
        // Type 4 = CHANNEL_MESSAGE_WITH_SOURCE (immediate response)
        return res.json({ type: 4, data: { content: getHelpText(true) } });
      }

      // All other commands: defer, then process async
      // Type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      res.json({ type: 5 });

      // Fire-and-forget async processing
      processCommand(tenantId, channelId, commandName, commandText, appId, interactionToken).catch(err => {
        console.error('[discord] command processing error:', err.message, err.stack);
      });
      return;
    }

    // Unhandled interaction type
    res.status(400).json({ error: 'Unhandled interaction type' });
  } catch (err) {
    console.error('[webhook:discord] Unhandled error:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Process a slash command asynchronously after deferring the interaction response.
 */
async function processCommand(tenantId, channelId, commandName, commandText, appId, interactionToken) {
  try {
    // Check newsroom commands first
    if (NEWSROOM_COMMANDS.has(commandName)) {
      const response = await handleNewsroomCommand(tenantId, commandText, channelId);
      if (response) {
        await sendFollowup(appId, interactionToken, response);
        return;
      }
    }

    // Writer commands — look up channel→writer mapping (with writer info for avatar)
    const channel = await db.prepare(
      "SELECT mc.*, w.name AS writer_name, w.avatar_url AS writer_avatar FROM messaging_channels mc LEFT JOIN writers w ON w.id = mc.writer_id WHERE mc.platform = 'discord' AND mc.channel_id = $1 AND mc.is_active = true"
    ).get(channelId);

    if (!channel) {
      await sendFollowup(appId, interactionToken,
        'This channel is not configured. Add channel ID `' + channelId + '` in Settings > Messaging.');
      return;
    }

    if (!channel.writer_id) {
      await sendFollowup(appId, interactionToken,
        'No writer assigned to this channel. Set one in Settings > Messaging.');
      return;
    }

    const { buildContextKey } = require('../lib/messaging/context');
    const contextKey = buildContextKey('discord', channelId);
    const response = await handleIncoming(channel.tenant_id, channel.writer_id, commandText, contextKey);

    // /new returns an object with clearChannel flag — bulk delete via REST
    if (response && typeof response === 'object' && response.clearChannel) {
      try {
        const botToken = await require('../lib/messaging/discord').getBotToken(tenantId);
        if (botToken) {
          // Fetch recent messages
          const fetchRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=50`, {
            headers: { Authorization: `Bot ${botToken}` },
            signal: AbortSignal.timeout(10000),
          });
          if (fetchRes.ok) {
            const msgs = await fetchRes.json();
            const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
            const ids = msgs.filter(m => new Date(m.timestamp).getTime() > twoWeeksAgo).map(m => m.id);
            if (ids.length > 1) {
              await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/bulk-delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
                body: JSON.stringify({ messages: ids }),
                signal: AbortSignal.timeout(10000),
              });
            }
          }
        }
      } catch (err) {
        console.error('[discord] bulk delete failed:', err.message);
      }
      // Delete the deferred message and send confirmation via webhook
      await deleteFollowup(appId, interactionToken).catch(() => {});
      if (channel.writer_name) {
        await sendAsWriter(channelId, response.text, tenantId, channel.writer_name, channel.writer_avatar);
      }
      return;
    }

    // Try sending as the writer (with name + avatar) via channel webhook
    if (channel.writer_name) {
      // Resolve relative avatar URLs
      let avatarUrl = channel.writer_avatar;
      if (avatarUrl && !avatarUrl.startsWith('http')) {
        try {
          const config = await getAppConfig(tenantId);
          const baseUrl = (config.base_url || '').replace(/\/$/, '');
          if (baseUrl) avatarUrl = baseUrl + avatarUrl;
          else avatarUrl = null;
        } catch { avatarUrl = null; }
      }

      const sent = await sendAsWriter(channelId, response, tenantId, channel.writer_name, avatarUrl);
      if (sent) {
        // Delete the deferred "thinking" message since we sent via webhook
        await deleteFollowup(appId, interactionToken).catch(() => {});
        return;
      }
    }

    // Fallback: send as bot via interaction follow-up
    await sendFollowup(appId, interactionToken, response);
  } catch (err) {
    console.error('[discord] follow-up error:', err.message, err.stack);
    try {
      await sendFollowup(appId, interactionToken, 'Sorry, something went wrong processing that command.');
    } catch {}
  }
}

module.exports = router;
