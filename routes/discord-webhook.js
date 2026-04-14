/**
 * Discord Interactions Webhook — /api/webhooks/discord
 * Handles slash commands via Discord Application Commands.
 * Mounted BEFORE express.json() body parser (needs raw body for Ed25519 signature verification).
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getTenantByAppId, getAppSettings, verifyInteraction, sendFollowup, deleteFollowup, sendAsWriter, sendVoiceMessage, sendVoiceFollowup } = require('../lib/messaging/discord');
const { handleIncoming, handleNewsroomCommand } = require('../lib/messaging');
const { generateVoiceResponse } = require('../lib/media-helpers');
const { getAppConfig } = require('../lib/app-config');

const NEWSROOM_COMMANDS = new Set(['standup', 'brief', 'assign', 'help']);

// GET health check + diagnostic
router.get('/', async (req, res) => {
  let diag = {};
  try {
    const db = require('../db');
    // Find the tenant that has the Discord app configured
    const appIdRow = await db.prepare(
      "SELECT tenant_id, value FROM settings WHERE key = 'discord_app_id' AND value IS NOT NULL AND value != '' LIMIT 1"
    ).get();
    const diagTenantId = appIdRow?.tenant_id || 1;
    diag._tenant_id = diagTenantId;
    const rows = await db.prepare(
      "SELECT key, value FROM settings WHERE key IN ('discord_app_id', 'discord_public_key', 'discord_bot_token') AND tenant_id = $1"
    ).all(diagTenantId);
    for (const r of rows) {
      if (r.key === 'discord_bot_token') {
        diag[r.key] = r.value ? (r.value.startsWith('enc:') ? 'encrypted ✓' : `plain (${r.value.length} chars)`) : '(empty)';
      } else if (r.key === 'discord_public_key') {
        diag[r.key] = r.value ? `${r.value.length} chars, starts=${r.value.slice(0, 8)}` : '(empty)';
      } else {
        diag[r.key] = r.value || '(empty)';
      }
    }
    // Tenant lookup
    const appIdRaw = rows.find(r => r.key === 'discord_app_id')?.value;
    if (appIdRaw) {
      const tid = await getTenantByAppId(appIdRaw);
      diag.tenant_lookup = tid ? `tenant ${tid}` : 'NOT FOUND';
    }
    // List registered commands from Discord API
    try {
      const { getBotToken } = require('../lib/messaging/discord');
      const token = await getBotToken(diagTenantId);
      if (token && appIdRaw) {
        const cmdRes = await fetch(`https://discord.com/api/v10/applications/${appIdRaw}/commands`, {
          headers: { Authorization: `Bot ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (cmdRes.ok) {
          const cmds = await cmdRes.json();
          diag.registered_commands = cmds.map(c => c.name);
          diag.command_count = cmds.length;
        } else {
          diag.commands_error = `HTTP ${cmdRes.status}`;
        }
      }
    } catch (err) { diag.commands_error = err.message; }
    // Check messaging channels + writer info (all tenants to find mismatches)
    const channels = await db.prepare(
      "SELECT mc.channel_id, mc.writer_id, mc.tenant_id, w.name, w.elevenlabs_voice_id FROM messaging_channels mc LEFT JOIN writers w ON w.id = mc.writer_id WHERE mc.platform = 'discord' AND mc.is_active = true"
    ).all();
    diag.messaging_channels = channels.map(c => ({
      channel_id: c.channel_id,
      tenant_id: c.tenant_id,
      writer: c.name || 'none',
      writer_id: c.writer_id,
      has_voice: !!c.elevenlabs_voice_id,
    }));
    // Check if ElevenLabs API key is set for each tenant that has channels
    const tenantIds = [...new Set(channels.map(c => c.tenant_id))];
    diag.elevenlabs_by_tenant = {};
    for (const tid of [diagTenantId, ...tenantIds]) {
      const elKey = await db.prepare(
        "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'elevenlabs_api_key'"
      ).get(tid);
      diag.elevenlabs_by_tenant[`tenant_${tid}`] = elKey?.value ? (elKey.value.startsWith('enc:') ? 'encrypted ✓' : `plain`) : '(NOT SET)';
    }
    // Count articles for each writer (using the channel's tenant, not the app tenant)
    for (const ch of diag.messaging_channels) {
      if (ch.writer_id) {
        const cnt = await db.prepare(
          "SELECT COUNT(*)::int AS total, SUM(CASE WHEN content_type IN ('original','deep-dive') THEN 1 ELSE 0 END)::int AS originals FROM articles WHERE writer_id = $1 AND tenant_id = $2 AND is_published = 1"
        ).get(ch.writer_id, ch.tenant_id);
        ch.articles_total = cnt?.total || 0;
        ch.articles_originals = cnt?.originals || 0;
      }
    }
  } catch (err) { diag.error = err.message; }
  res.json({ status: 'ok', config: diag });
});

// POST — Discord interactions (raw body for signature verification)
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBodyStr = req.body?.toString?.() || '';
    console.log(`[webhook:discord] POST received, body type=${typeof req.body}, isBuffer=${Buffer.isBuffer(req.body)}, length=${rawBodyStr.length}`);

    let body;
    try {
      body = JSON.parse(rawBodyStr);
    } catch (parseErr) {
      console.error(`[webhook:discord] JSON parse failed: ${parseErr.message}, raw=${rawBodyStr.slice(0, 100)}`);
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
      } else if (commandName === 'voice') {
        commandText = '/voice ' + (options.question || '');
      } else {
        commandText = '/' + commandName;
      }

      console.log(`[webhook:discord] ${userName} (channel: ${channelId}): ${commandText}`);

      // /help can respond immediately (fast, no AI) — check agent role for correct help text
      if (commandName === 'help') {
        const channelRow = await db.prepare(
          "SELECT w.role FROM messaging_channels mc JOIN writers w ON w.id = mc.writer_id WHERE mc.platform = 'discord' AND mc.channel_id = $1 AND mc.is_active = true"
        ).get(channelId);
        if (channelRow?.role === 'editor') {
          return res.json({ type: 4, data: { content: '--- Editor Commands ---\n\napprove [id] — Publish an article\nreject [id] — Reject article to draft\n/review — Show review queue\n/stats — Editorial statistics\n/help — Show this message\n' } });
        }
        const { getHelpText } = require('../lib/messaging');
        return res.json({ type: 4, data: { content: getHelpText(true) } });
      }

      // All other commands: defer, then process async
      // Type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      res.json({ type: 5 });

      // Fire-and-forget async processing
      const userId = body.member?.user?.id || body.user?.id || null;
      processCommand(tenantId, channelId, commandName, commandText, appId, interactionToken, { userId, userName, platform: 'discord' }).catch(err => {
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
async function processCommand(tenantId, channelId, commandName, commandText, appId, interactionToken, userMeta = {}) {
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
    const response = await handleIncoming(channel.tenant_id, channel.writer_id, commandText, contextKey, userMeta);

    // /voice returns { text, voice: true, writerId } — generate audio and send as attachment
    if (response && typeof response === 'object' && response.voice) {
      const voiceResult = await generateVoiceResponse(response.text, response.writerId, tenantId);
      if (voiceResult) {
        await sendVoiceFollowup(appId, interactionToken, voiceResult.buffer, response.text.slice(0, 200) + '...');
      } else {
        // Voice unavailable — fall back to text with explanation
        await sendFollowup(appId, interactionToken, response.text + '\n\n(Voice not available — no ElevenLabs voice configured for this writer)');
      }
      return;
    }

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
    const responseText = (typeof response === 'object' && response.text) ? response.text : response;
    if (channel.writer_name) {
      let avatarUrl = channel.writer_avatar;
      if (avatarUrl && !avatarUrl.startsWith('http')) {
        try {
          const config = await getAppConfig(tenantId);
          const baseUrl = (config.base_url || '').replace(/\/$/, '');
          if (baseUrl) avatarUrl = baseUrl + avatarUrl;
          else avatarUrl = null;
        } catch { avatarUrl = null; }
      }

      console.log(`[discord] Slash cmd: sending as "${channel.writer_name}" avatar=${avatarUrl || 'none'}`);
      const sent = await sendAsWriter(channelId, responseText, tenantId, channel.writer_name, avatarUrl);
      if (sent) {
        // Delete the deferred "thinking" message since we sent via webhook
        await deleteFollowup(appId, interactionToken).catch(() => {});
        return;
      }
      console.warn(`[discord] sendAsWriter failed — falling back to bot followup`);
    }

    // Fallback: send as bot via interaction follow-up
    await sendFollowup(appId, interactionToken, responseText);
  } catch (err) {
    console.error('[discord] follow-up error:', err.message, err.stack);
    try {
      await sendFollowup(appId, interactionToken, 'Sorry, something went wrong processing that command.');
    } catch {}
  }
}

module.exports = router;
