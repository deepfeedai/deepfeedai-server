/**
 * Discord Interactions Webhook — /api/webhooks/discord
 * Handles slash commands via Discord Application Commands.
 * Mounted BEFORE express.json() body parser (needs raw body for Ed25519 signature verification).
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getTenantByAppId, getAppSettings, verifyInteraction, sendFollowup } = require('../lib/messaging/discord');
const { handleIncoming, handleNewsroomCommand } = require('../lib/messaging');

const NEWSROOM_COMMANDS = new Set(['standup', 'brief', 'assign', 'help']);

// GET health check
router.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Discord interactions endpoint is active' });
});

// POST — Discord interactions (raw body for signature verification)
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // ── Resolve tenant from application_id ──
  const appId = body.application_id;
  if (!appId) return res.status(400).json({ error: 'Missing application_id' });

  const tenantId = await getTenantByAppId(appId);
  if (!tenantId) {
    // Still handle PING for initial setup (Discord sends ping before tenant is fully configured)
    if (body.type === 1) return res.json({ type: 1 });
    return res.status(404).json({ error: 'Unknown application' });
  }

  // ── Verify Ed25519 signature ──
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const { publicKey } = await getAppSettings(tenantId);

  if (!publicKey || !signature || !timestamp) {
    return res.status(401).json({ error: 'Missing signature or public key' });
  }

  if (!verifyInteraction(req.body.toString(), signature, timestamp, publicKey)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // ── Type 1: PING ──
  if (body.type === 1) {
    return res.json({ type: 1 });
  }

  // ── Type 2: APPLICATION_COMMAND ──
  if (body.type === 2) {
    const data = body.data || {};
    const commandName = data.name;
    const channelId = body.channel_id;
    const interactionToken = body.token;
    const userId = body.member?.user?.id || body.user?.id || '';
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

    // Writer commands — look up channel→writer mapping
    const channel = await db.prepare(
      "SELECT * FROM messaging_channels WHERE platform = 'discord' AND channel_id = $1 AND is_active = true"
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

    const response = await handleIncoming(channel.tenant_id, channel.writer_id, commandText);
    await sendFollowup(appId, interactionToken, response);
  } catch (err) {
    console.error('[discord] follow-up error:', err.message, err.stack);
    try {
      await sendFollowup(appId, interactionToken, 'Sorry, something went wrong processing that command.');
    } catch {}
  }
}

module.exports = router;
