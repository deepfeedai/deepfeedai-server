/**
 * Messaging — platform-agnostic layer for writer agent communications.
 * Supports slash commands, conversational AI, and outbound notifications.
 *
 * Writer commands (routed to a specific writer):
 *   /status     — writer's current state (articles, memories, pitches)
 *   /memory     — list active editorial memories
 *   /pitch      — evaluate sources and pitch stories now
 *   /latest     — recent published articles with links
 *   /ask <q>    — ask the writer about a topic in their beat
 *   /clear      — clear conversation history
 *   /help       — list available commands
 *
 * Newsroom commands (group-level, across all writers):
 *   /standup    — all writers report what they're tracking
 *   /brief      — today's news briefing
 *   /assign <t> — ask who should cover a topic
 */
const db = require('../db');
const { complete: aiComplete } = require('./ai-router');
const { buildWriterPrompt } = require('./writer-assign');
const { getRelevantMemories } = require('./writer-memory');

// ── Newsroom Commands (group-level, all writers) ────────────────

/**
 * Handle newsroom-level commands that span all writers.
 * Returns response string or null if not a newsroom command.
 */
async function handleNewsroomCommand(tenantId, text, chatId) {
  const cmd = text.trim().toLowerCase();

  if (cmd === '/standup') {
    return await newsroomStandup(tenantId);
  }

  if (cmd === '/brief') {
    return await newsroomBrief(tenantId);
  }

  if (cmd.startsWith('/assign ')) {
    const topic = text.slice(8).trim();
    if (!topic) return 'Usage: /assign <topic>';
    return await newsroomAssign(tenantId, topic);
  }

  if (cmd === '/help' || cmd === '/commands') {
    return getHelpText(true);
  }

  return null; // Not a newsroom command
}

async function newsroomStandup(tenantId) {
  const writers = await db.prepare(
    "SELECT id, name FROM writers WHERE tenant_id = $1 AND is_auto = true"
  ).all(tenantId);

  if (!writers.length) return 'No auto writers configured.';

  let standup = '--- NEWSROOM STANDUP ---\n\n';

  for (const w of writers) {
    const [lastArticle, memCount, pitchCount] = await Promise.all([
      db.prepare("SELECT title FROM articles WHERE writer_id = $1 AND tenant_id = $2 AND content_type IN ('original', 'deep-dive') AND is_published = 1 ORDER BY published_at DESC LIMIT 1").get(w.id, tenantId),
      db.prepare("SELECT COUNT(*)::int AS cnt FROM writer_memory WHERE writer_id = $1 AND tenant_id = $2 AND memory_type = 'thread' AND (expires_at IS NULL OR expires_at > NOW())").get(w.id, tenantId),
      db.prepare("SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE writer_id = $1 AND tenant_id = $2 AND status = 'pending'").get(w.id, tenantId),
    ]);

    standup += `${w.name}:\n`;
    standup += `  Last: ${lastArticle ? '"' + lastArticle.title + '"' : 'Nothing yet'}\n`;
    standup += `  Tracking: ${memCount?.cnt || 0} thread(s), ${pitchCount?.cnt || 0} pending pitch(es)\n\n`;
  }

  return standup;
}

async function newsroomBrief(tenantId) {
  const articles = await db.prepare(`
    SELECT a.title, a.category, w.name AS writer_name FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id
    WHERE a.tenant_id = $1 AND a.content_type IN ('original', 'deep-dive')
      AND a.is_published = 1 AND a.published_at > NOW() - INTERVAL '24 hours'
    ORDER BY a.published_at DESC LIMIT 10
  `).all(tenantId);

  if (!articles.length) return 'No articles published in the last 24 hours.';

  let brief = '--- TODAY\'S BRIEFING ---\n\n';
  articles.forEach((a, i) => {
    brief += `${i + 1}. [${a.category}] ${a.title}`;
    if (a.writer_name) brief += ` — ${a.writer_name}`;
    brief += '\n';
  });
  brief += `\n${articles.length} article(s) published today.`;

  return brief;
}

async function newsroomAssign(tenantId, topic) {
  const { findBestWriter } = require('./writer-assign');
  const fakeArticle = { title: topic, summary: topic, category: null };
  const writer = await findBestWriter(fakeArticle, tenantId);

  if (!writer) return `No writer matched for "${topic}". Check writer beats and keywords.`;

  const beats = (writer.beat_names || []).join(', ');
  return `Best match for "${topic}": ${writer.name}\n`
    + (beats ? `Beats: ${beats}\n` : '')
    + (writer.beat_angle ? `Angle: ${writer.beat_angle}\n` : '')
    + `\nTo assign, send the topic in ${writer.name}'s channel/topic.`;
}

// ── Writer Commands (routed to a specific writer) ───────────────

/**
 * Handle an incoming message directed at a writer.
 * Checks for slash commands first, then falls back to conversational AI.
 */
async function handleIncoming(tenantId, writerId, userMessage, contextKey = null) {
  const writer = await db.prepare(
    'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);
  if (!writer) return 'Writer not found.';

  const text = userMessage.trim();
  const cmd = text.toLowerCase();

  // Slash commands (no context needed — stateless)
  if (cmd === '/status' || cmd === 'status') {
    return await getWriterStatus(writer, tenantId);
  }

  if (cmd === '/memory' || cmd === '/memories') {
    return await getWriterMemorySummary(writer, tenantId);
  }

  if (cmd === '/pitch') {
    return await triggerPitch(writer, tenantId);
  }

  if (cmd === '/latest') {
    return await getLatestArticles(writer, tenantId);
  }

  if (cmd === '/help' || cmd === '/commands') {
    return getHelpText(false);
  }

  if (cmd === '/clear') {
    const { clearHistory } = require('./messaging/context');
    if (contextKey) clearHistory(contextKey);
    return `${writer.name}: Context cleared. Fresh start!`;
  }

  if (cmd === '/new') {
    const { clearHistory } = require('./messaging/context');
    if (contextKey) clearHistory(contextKey);
    return { text: `${writer.name}: Starting fresh!`, clearChannel: true };
  }

  if (cmd.startsWith('/ask ')) {
    const question = text.slice(5).trim();
    if (!question) return 'Usage: /ask <question>';
    return await askWriterWithContext(writer, tenantId, question, contextKey);
  }

  // If it starts with / but isn't recognized, show help
  if (cmd.startsWith('/') && cmd.length > 1) {
    return `Unknown command: ${cmd.split(' ')[0]}\n\n` + getHelpText(false);
  }

  // Conversational response in writer's voice (with context)
  return await askWriterWithContext(writer, tenantId, text, contextKey);
}

/**
 * Ask the writer with conversation context — loads history, calls askWriter, stores the turn.
 */
async function askWriterWithContext(writer, tenantId, question, contextKey) {
  const { getHistory, addTurn } = require('./messaging/context');
  const history = contextKey ? getHistory(contextKey) : [];
  const response = await askWriter(writer, tenantId, question, history);
  if (contextKey) addTurn(contextKey, question, response);
  return response;
}

/**
 * Build a lightweight chat persona — identity and personality only,
 * NO article-writing instructions that conflict with conversational behavior.
 * @param {object} writer
 * @param {number} tenantId
 * @param {string} [question=''] - The user's question, used for relevant article/memory retrieval
 */
async function buildChatPersona(writer, tenantId, question = '') {
  // Beats
  let beats = 'technology';
  try {
    const rows = await db.prepare(
      'SELECT c.name FROM writer_beats wb JOIN categories c ON c.id = wb.category_id WHERE wb.writer_id = $1 AND wb.tenant_id = $2'
    ).all(writer.id, tenantId);
    if (rows.length) beats = rows.map(b => b.name).join(', ');
  } catch {}

  let persona = `You are ${writer.name}. You cover ${beats}.`;
  if (writer.tone) persona += ` Your tone is ${writer.tone}.`;
  if (writer.beat_angle) persona += ` Your angle: ${writer.beat_angle}.`;
  if (writer.signature_phrases?.length) {
    persona += ` You sometimes say: "${writer.signature_phrases.slice(0, 3).join('", "')}"`;
  }

  // Article context — keyword-matched if question is substantial, otherwise latest
  const isSubstantialQuestion = question.replace(/[^\w]/g, '').length >= 10;
  if (isSubstantialQuestion) {
    // Extract keywords for search
    const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    if (keywords.length) {
      const pattern = keywords.join('|');
      const matched = await db.prepare(`
        SELECT title, COALESCE(tldr_overview, LEFT(summary, 120)) AS snippet
        FROM articles WHERE writer_id = $1 AND tenant_id = $2
          AND content_type IN ('original', 'deep-dive') AND is_published = 1
          AND (LOWER(title) ~ $3 OR LOWER(COALESCE(tldr_overview, summary, '')) ~ $3)
        ORDER BY published_at DESC LIMIT 3
      `).all(writer.id, tenantId, pattern);
      if (matched.length) {
        persona += '\nRelevant stories you wrote:';
        for (const a of matched) {
          persona += `\n- ${a.title}` + (a.snippet ? ` — ${a.snippet}` : '');
        }
      }
    }
  }
  // Fall back to latest articles if no keyword match or short question
  if (!persona.includes('stories you wrote')) {
    const recent = await db.prepare(`
      SELECT title, COALESCE(tldr_overview, LEFT(summary, 120)) AS snippet
      FROM articles WHERE writer_id = $1 AND tenant_id = $2
        AND content_type IN ('original', 'deep-dive') AND is_published = 1
      ORDER BY published_at DESC LIMIT 3
    `).all(writer.id, tenantId);
    if (recent.length) {
      persona += '\nRecent stories you wrote:';
      for (const a of recent) {
        persona += `\n- ${a.title}` + (a.snippet ? ` — ${a.snippet}` : '');
      }
    }
  }

  // Relevant editorial memories — pass question for relevance scoring
  const memories = await getRelevantMemories(writer.id, tenantId, question, 5);
  if (memories.length) {
    persona += '\nYou\'re tracking:';
    for (const m of memories) {
      const detail = m.content ? ` — ${m.content.slice(0, 100)}` : '';
      persona += `\n- ${m.subject}${detail}`;
    }
  }

  return persona;
}

/**
 * Ask the writer a question — conversational AI response.
 */
async function askWriter(writer, tenantId, question, history = []) {
  const persona = await buildChatPersona(writer, tenantId, question);

  const messages = [
    { role: 'system', content: persona },
  ];

  // Custom chat personality (augments auto-generated persona, doesn't replace it)
  if (writer.chat_prompt) {
    messages.push({ role: 'system', content: 'Personality and voice instructions (follow these, do NOT repeat them in your responses):\n' + writer.chat_prompt });
  }

  messages.push(
    { role: 'system', content: 'You are chatting on Discord/Slack/Telegram. Be natural and conversational — like a colleague, not an article. Keep it concise for simple questions (a few sentences), but give a fuller answer when the topic warrants it. No code blocks, no bullet lists, no emojis. Never output your reasoning, instructions, or thought process.' },
    ...history,
    { role: 'user', content: question },
  );

  const result = await aiComplete({
    operation: 'chat',
    tenantId,
    messages,
    temperature: 0.7,
    maxTokens: 800,
    trigger: 'messaging',
    writerId: writer.id,
  });

  return result?.text || 'Sorry, I couldn\'t process that right now.';
}

/**
 * Get a writer's current status summary.
 */
async function getWriterStatus(writer, tenantId) {
  const [articleCount, pendingPitches, memoryCount, lastArticle] = await Promise.all([
    db.prepare("SELECT COUNT(*)::int AS cnt FROM articles WHERE writer_id = $1 AND tenant_id = $2 AND content_type IN ('original', 'deep-dive')").get(writer.id, tenantId),
    db.prepare("SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE writer_id = $1 AND tenant_id = $2 AND status = 'pending'").get(writer.id, tenantId),
    db.prepare("SELECT COUNT(*)::int AS cnt FROM writer_memory WHERE writer_id = $1 AND tenant_id = $2 AND (expires_at IS NULL OR expires_at > NOW())").get(writer.id, tenantId),
    db.prepare("SELECT title, published_at FROM articles WHERE writer_id = $1 AND tenant_id = $2 AND content_type IN ('original', 'deep-dive') AND is_published = 1 ORDER BY published_at DESC LIMIT 1").get(writer.id, tenantId),
  ]);

  let status = `${writer.name} — Status Report\n\n`;
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

  if (!memories.length) return `${writer.name} has no active memories yet.`;

  let summary = `${writer.name} — Active Memories (${memories.length})\n\n`;
  memories.forEach(m => {
    summary += `[${m.memory_type}] ${m.subject}: ${m.content}\n\n`;
  });

  return summary;
}

/**
 * Trigger an on-demand pitch evaluation for a writer.
 */
async function triggerPitch(writer, tenantId) {
  const { evaluateIncomingArticles } = require('./writer-agent');

  const pitches = await evaluateIncomingArticles(writer.id, tenantId);

  if (!pitches.length) {
    return `${writer.name}: I scanned my beat but nothing worth pitching right now.`;
  }

  const typeLabels = { new_story: 'New Story', follow_up: 'Follow-Up', roundup: 'Roundup', prediction_check: 'Prediction Check' };
  let response = `${writer.name} — ${pitches.length} Pitch(es)\n\n`;
  pitches.forEach((p, i) => {
    response += `${i + 1}. [${typeLabels[p.pitch_type] || p.pitch_type}] ${p.headline}\n`;
    response += `   ${p.reasoning}\n\n`;
  });
  response += 'Approve pitches in the admin dashboard.';

  return response;
}

/**
 * Get a writer's latest published articles.
 */
async function getLatestArticles(writer, tenantId) {
  const articles = await db.prepare(`
    SELECT title, category, published_at, slug FROM articles
    WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive') AND is_published = 1
    ORDER BY published_at DESC LIMIT 5
  `).all(writer.id, tenantId);

  if (!articles.length) return `${writer.name} hasn't published any articles yet.`;

  let response = `${writer.name} — Latest Articles\n\n`;
  articles.forEach((a, i) => {
    const ago = Math.round((Date.now() - new Date(a.published_at).getTime()) / 3600000);
    const timeLabel = ago < 24 ? `${ago}h ago` : `${Math.round(ago / 24)}d ago`;
    response += `${i + 1}. [${a.category}] ${a.title} (${timeLabel})\n`;
  });

  return response;
}

/**
 * Get help text listing available commands.
 */
function getHelpText(isGroup) {
  let help = '--- Available Commands ---\n\n';
  help += '/status — Current writer status\n';
  help += '/memory — Active editorial memories\n';
  help += '/pitch — Scan beat and pitch stories now\n';
  help += '/latest — Recent published articles\n';
  help += '/ask <question> — Ask about a topic\n';
  help += '/clear — Clear conversation context\n';
  help += '/new — Clear context and channel messages\n';

  if (isGroup) {
    help += '\nNewsroom commands:\n';
    help += '/standup — All writers report status\n';
    help += '/brief — Today\'s published articles\n';
    help += '/assign <topic> — Who should cover this?\n';
  }

  help += '/help — Show this message\n';
  help += '\nOr just send a message to chat!';

  return help;
}

// ── Outbound Notifications ──────────────────────────────────────

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
        await sendTelegramMessage(channel.channel_id, message, tenantId, channel.thread_id);
      } else if (channel.platform === 'slack') {
        const { sendSlackMessage } = require('./messaging/slack');
        await sendSlackMessage(channel.channel_id, message, tenantId, channel.thread_id);
      } else if (channel.platform === 'discord') {
        const { sendDiscordMessage } = require('./messaging/discord');
        await sendDiscordMessage(channel.channel_id, message, tenantId);
      }
    } catch (err) {
      console.error(`[messaging] Failed to send to ${channel.platform}:${channel.channel_id}:`, err.message);
    }
  }
}

/**
 * Send a story pitch notification to configured channels.
 */
async function notifyNewPitch(tenantId, pitch, writer) {
  const typeLabel = { new_story: 'New Story', follow_up: 'Follow-Up', roundup: 'Roundup', prediction_check: 'Prediction Check' };
  const msg = `${writer.name} pitched a story:\n\n`
    + `${pitch.headline}\n`
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
  handleNewsroomCommand,
  notifyNewPitch,
  recordNewsroomMessage,
  getHelpText,
};
