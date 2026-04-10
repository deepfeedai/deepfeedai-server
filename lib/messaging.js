/**
 * Messaging — platform-agnostic layer for writer agent communications.
 * Supports outbound notifications (writer → admin) and inbound commands (admin → writer).
 */
const db = require('../db');
const { complete: aiComplete } = require('./ai-router');
const { buildWriterPrompt } = require('./writer-assign');
const { getRelevantMemories } = require('./writer-memory');

/**
 * Send a message from a writer to all configured channels.
 */
async function sendMessage(tenantId, writerId, message, opts = {}) {
  const channels = await db.prepare(`
    SELECT * FROM messaging_channels
    WHERE tenant_id = $1 AND is_active = true
      AND (writer_id IS NULL OR writer_id = $2)
  `).all(tenantId, writerId);

  for (const channel of channels) {
    try {
      if (channel.platform === 'telegram') {
        const { sendTelegramMessage } = require('./messaging/telegram');
        await sendTelegramMessage(channel.channel_id, message, tenantId);
      }
      // Future: slack, discord, webhook
    } catch (err) {
      console.error(`[messaging] Failed to send to ${channel.platform}:${channel.channel_id}:`, err.message);
    }
  }
}

/**
 * Handle an incoming message directed at a writer.
 * Responds in the writer's voice using their persona and memory.
 */
async function handleIncoming(tenantId, writerId, userMessage) {
  const writer = await db.prepare(
    'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);
  if (!writer) return 'Writer not found.';

  // Check for commands
  const cmd = userMessage.trim().toLowerCase();

  if (cmd === '/status' || cmd === 'status') {
    return await getWriterStatus(writer, tenantId);
  }

  if (cmd === '/memory' || cmd === 'memory' || cmd === 'memories') {
    return await getWriterMemorySummary(writer, tenantId);
  }

  // Conversational response in writer's voice
  const memories = await getRelevantMemories(writerId, tenantId, userMessage, 5);
  const recentArticles = await db.prepare(`
    SELECT title, summary FROM articles
    WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive') AND is_published = 1
    ORDER BY published_at DESC LIMIT 3
  `).all(writerId, tenantId);

  const persona = await buildWriterPrompt(writer, { recentArticles, memories });

  const result = await aiComplete({
    operation: 'chat',
    tenantId,
    messages: [
      { role: 'system', content: persona + '\n\nRespond conversationally as this writer. Keep responses concise (2-3 sentences max). If asked about a topic in your beat, draw on your memories and recent coverage.' },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.7,
    maxTokens: 300,
    trigger: 'messaging',
    writerId,
  });

  return result?.text || 'Sorry, I couldn\'t process that right now.';
}

/**
 * Get a writer's current status summary.
 */
async function getWriterStatus(writer, tenantId) {
  const [articleCount, pendingPitches, memoryCount, lastArticle] = await Promise.all([
    db.prepare('SELECT COUNT(*)::int AS cnt FROM articles WHERE writer_id = $1 AND tenant_id = $2 AND content_type IN (\'original\', \'deep-dive\')').get(writer.id, tenantId),
    db.prepare('SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE writer_id = $1 AND tenant_id = $2 AND status = \'pending\'').get(writer.id, tenantId),
    db.prepare('SELECT COUNT(*)::int AS cnt FROM writer_memory WHERE writer_id = $1 AND tenant_id = $2 AND (expires_at IS NULL OR expires_at > NOW())').get(writer.id, tenantId),
    db.prepare('SELECT title, published_at FROM articles WHERE writer_id = $1 AND tenant_id = $2 AND content_type IN (\'original\', \'deep-dive\') AND is_published = 1 ORDER BY published_at DESC LIMIT 1').get(writer.id, tenantId),
  ]);

  let status = `*${writer.name}* — Status Report\n\n`;
  status += `Articles: ${articleCount?.cnt || 0}\n`;
  status += `Active memories: ${memoryCount?.cnt || 0}\n`;
  status += `Pending pitches: ${pendingPitches?.cnt || 0}\n`;
  status += `Mode: ${writer.is_auto ? 'Auto' : 'Manual'} (${writer.synthesis_schedule || 'daily'})\n`;
  if (lastArticle) {
    const ago = Math.round((Date.now() - new Date(lastArticle.published_at).getTime()) / 3600000);
    status += `Last published: "${lastArticle.title}" (${ago}h ago)`;
  } else {
    status += 'Last published: Never';
  }

  return status;
}

/**
 * Get a summary of a writer's active memories.
 */
async function getWriterMemorySummary(writer, tenantId) {
  const memories = await db.prepare(`
    SELECT memory_type, subject, content FROM writer_memory
    WHERE writer_id = $1 AND tenant_id = $2
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC LIMIT 15
  `).all(writer.id, tenantId);

  if (!memories.length) return `*${writer.name}* has no active memories yet.`;

  let summary = `*${writer.name}* — Active Memories (${memories.length})\n\n`;
  memories.forEach(m => {
    summary += `[${m.memory_type}] *${m.subject}*: ${m.content}\n\n`;
  });

  return summary;
}

/**
 * Send a story pitch notification to configured channels.
 */
async function notifyNewPitch(tenantId, pitch, writer) {
  const typeLabel = { new_story: 'New Story', follow_up: 'Follow-Up', roundup: 'Roundup', prediction_check: 'Prediction Check' };
  const msg = `*${writer.name}* pitched a story:\n\n`
    + `*${pitch.headline}*\n`
    + `Type: ${typeLabel[pitch.pitch_type] || pitch.pitch_type}\n`
    + `Priority: ${'*'.repeat(Math.round(pitch.priority / 2))}\n\n`
    + `${pitch.reasoning}`;

  await sendMessage(tenantId, pitch.writer_id, msg);
}

/**
 * Record a newsroom message between writers.
 */
async function recordNewsroomMessage(tenantId, fromWriterId, toWriterId, type, content, context = {}) {
  return db.prepare(`
    INSERT INTO newsroom_messages (tenant_id, from_writer_id, to_writer_id, message_type, content, context)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `).get(tenantId, fromWriterId, toWriterId, type, content, JSON.stringify(context));
}

module.exports = {
  sendMessage,
  handleIncoming,
  notifyNewPitch,
  recordNewsroomMessage,
};
