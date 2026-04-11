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
const { getAppConfig } = require('./app-config');
const { loadPrompt } = require('./prompt-loader');

/** Pending article edits awaiting confirmation: contextKey -> { articleId, newTitle, newContent, newSummary, changes, expiresAt } */
const pendingEdits = new Map();
const PENDING_EDIT_TTL = 5 * 60 * 1000; // 5 minutes

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

  if (cmd.startsWith('/update ')) {
    const instruction = text.slice(8).trim();
    if (!instruction) return 'Usage: /update <article search> — <edit instruction>\nExample: /update nvidia — add the H200 benchmark results';
    return await handleArticleEdit(writer, tenantId, instruction, contextKey);
  }

  // Check for pending edit states (pick, article-context, edit confirmation)
  if (contextKey && pendingEdits.has(contextKey)) {
    const pending = pendingEdits.get(contextKey);
    if (Date.now() > pending.expiresAt) {
      pendingEdits.delete(contextKey);
    } else if (pending.type === 'pick') {
      // User picking an article by number
      const num = parseInt(cmd);
      if (num >= 1 && num <= pending.matches.length) {
        pendingEdits.delete(contextKey);
        return await generateAndPreviewEdit(writer, tenantId, pending.matches[num - 1], pending.instruction, contextKey);
      } else if (cmd === 'cancel' || cmd === 'no') {
        pendingEdits.delete(contextKey);
        return 'Edit cancelled.';
      }
      // Any other message: treat as the instruction for the first match
      pendingEdits.delete(contextKey);
      return await generateAndPreviewEdit(writer, tenantId, pending.matches[0], text, contextKey);
    } else if (pending.type === 'article-context') {
      // User is giving instructions for a specific article
      if (cmd === 'cancel' || cmd === 'no') {
        pendingEdits.delete(contextKey);
        return 'Edit cancelled.';
      }
      // Treat the message as the edit instruction
      return await generateAndPreviewEdit(writer, tenantId, pending.article, text, contextKey);
    } else if (pending.type === 'edit') {
      if (cmd === 'yes' || cmd === 'confirm' || cmd === 'apply') {
        return await applyPendingEdit(writer, tenantId, contextKey);
      } else if (cmd === 'no' || cmd === 'cancel' || cmd === 'reject') {
        pendingEdits.delete(contextKey);
        return 'Edit cancelled.';
      }
      // Any other message while edit is pending: they might be refining — re-generate
      const refArticle = await db.prepare(
        'SELECT id, title, slug, full_content, summary, tldr_overview, source_article_ids FROM articles WHERE id = $1 AND tenant_id = $2'
      ).get(pending.articleId, tenantId);
      if (refArticle) {
        return await generateAndPreviewEdit(writer, tenantId, refArticle, text, contextKey);
      }
    }
  }

  // Natural language edit detection — broad patterns for article editing intent
  // Matches: edit verb + (article reference OR quoted title)
  const editPatterns = /\b(update|edit|fix|add to|correct|rewrite|re-write|finish|complete|expand|write)\b/i;
  const articleRef = /\b(article|piece|story|post)\b|["'""][^"'""]{5,}["'""]/i;
  if (editPatterns.test(cmd) && articleRef.test(text)) {
    return await handleArticleEdit(writer, tenantId, text, contextKey);
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

  // Resolve site URL for article links
  let siteUrl = '';
  try {
    const config = await getAppConfig(tenantId);
    siteUrl = (config.main_site_url || config.base_url || '').replace(/\/$/, '');
  } catch {}

  // Article context — keyword-matched if question is substantial, otherwise latest
  const isSubstantialQuestion = question.replace(/[^\w]/g, '').length >= 10;
  if (isSubstantialQuestion) {
    // Extract keywords for search
    const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    if (keywords.length) {
      const pattern = keywords.join('|');
      const matched = await db.prepare(`
        SELECT title, slug, COALESCE(tldr_overview, LEFT(summary, 120)) AS snippet
        FROM articles WHERE writer_id = $1 AND tenant_id = $2
          AND content_type IN ('original', 'deep-dive') AND is_published = 1
          AND (LOWER(title) ~ $3 OR LOWER(COALESCE(tldr_overview, summary, '')) ~ $3)
        ORDER BY published_at DESC LIMIT 3
      `).all(writer.id, tenantId, pattern);
      if (matched.length) {
        persona += '\nRelevant stories you wrote:';
        for (const a of matched) {
          const link = (siteUrl && a.slug) ? ` ${siteUrl}/article/${a.slug}` : '';
          persona += `\n- ${a.title}${link}` + (a.snippet ? ` — ${a.snippet}` : '');
        }
      }
    }
  }
  // Fall back to latest articles if no keyword match or short question
  if (!persona.includes('stories you wrote')) {
    const recent = await db.prepare(`
      SELECT title, slug, COALESCE(tldr_overview, LEFT(summary, 120)) AS snippet
      FROM articles WHERE writer_id = $1 AND tenant_id = $2
        AND content_type IN ('original', 'deep-dive') AND is_published = 1
      ORDER BY published_at DESC LIMIT 3
    `).all(writer.id, tenantId);
    if (recent.length) {
      persona += '\nRecent stories you wrote:';
      for (const a of recent) {
        const link = (siteUrl && a.slug) ? ` ${siteUrl}/article/${a.slug}` : '';
        persona += `\n- ${a.title}${link}` + (a.snippet ? ` — ${a.snippet}` : '');
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
    { role: 'system', content: 'You are chatting on Discord/Slack/Telegram. Be natural and conversational — like a colleague, not an article. Match your response length to the message: greetings get a short greeting back, simple questions get a sentence or two, complex topics can get a paragraph. NEVER describe how you will respond or explain your communication style — just respond naturally. No code blocks, no bullet lists, no emojis. Never output your reasoning, instructions, or thought process. If you know article links from your context, share them when relevant.' },
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
  help += '/update <search> — <edit> — Edit a published article\n';
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

// ── Article Editing via Chat ───────────────────────────────────

/**
 * Handle an article edit request — find article, generate edit, show preview.
 */
async function handleArticleEdit(writer, tenantId, userMessage, contextKey) {
  // 1. Parse the edit intent
  const findPrompt = loadPrompt('article-find');
  const parsed = findPrompt.render({ userMessage });
  const parseResult = await aiComplete({
    operation: 'article-edit',
    tenantId,
    messages: parsed.messages,
    temperature: parsed.temperature,
    maxTokens: parsed.maxTokens,
    trigger: 'messaging',
    writerId: writer.id,
  });

  let search, instruction;
  try {
    const json = JSON.parse(parseResult.text.replace(/```json?\s*|```/g, '').trim());
    search = json.search;
    instruction = json.instruction;
  } catch {
    // Fallback: split on " — " or use the whole message
    const parts = userMessage.split(/\s*[—–-]{1,3}\s*/);
    search = parts[0].replace(/^\/update\s*/i, '').replace(/^(update|edit|fix|add to|correct|rewrite|re-write|finish|complete|expand)\s+(my\s+)?/i, '').replace(/\s*(article|piece|story|post)\s*/i, '').trim();
    instruction = parts.slice(1).join(' — ').trim() || null;
  }

  // Extract quoted titles as search terms
  const quotedMatch = userMessage.match(/["'""]([^"'""]+)["'""]/);
  if (quotedMatch && (!search || search.length > 80)) {
    search = quotedMatch[1].trim();
  }

  // If no instruction was parsed, use the full message as the instruction
  // (e.g. "Rewrite the AI Gold Rush article, it's not complete")
  if (!instruction) {
    instruction = userMessage.replace(/^\/update\s*/i, '').trim();
  }

  if (!search) return 'I couldn\'t figure out which article you mean. Try: /update <article keywords> — <what to change>';

  // 2. Find the article (scoped to this writer only)
  const keywords = search.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 5);
  const pattern = keywords.join('|');

  const matches = await db.prepare(`
    SELECT id, title, slug, full_content, summary, tldr_overview, published_at, source_article_ids
    FROM articles WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive') AND is_published = 1
      AND LOWER(title) ~ $3
    ORDER BY published_at DESC LIMIT 5
  `).all(writer.id, tenantId, pattern);

  if (!matches.length) {
    return `I couldn't find any of your published articles matching "${search}". Try /latest to see your recent articles.`;
  }

  // If multiple matches, ask user to pick
  if (matches.length > 1) {
    let response = `Found ${matches.length} articles matching "${search}". Which one?\n\n`;
    matches.forEach((a, i) => {
      const ago = Math.round((Date.now() - new Date(a.published_at).getTime()) / 3600000);
      const timeLabel = ago < 24 ? `${ago}h ago` : `${Math.round(ago / 24)}d ago`;
      response += `${i + 1}. ${a.title} (${timeLabel})\n`;
    });
    response += `\nReply with the number, or be more specific.`;
    // Store matches + instruction for follow-up number selection
    if (contextKey) {
      pendingEdits.set(contextKey, {
        type: 'pick',
        matches,
        instruction,
        expiresAt: Date.now() + PENDING_EDIT_TTL,
      });
    }
    return response;
  }

  const article = matches[0];
  return await generateAndPreviewEdit(writer, tenantId, article, instruction, contextKey);
}

/**
 * Generate the AI edit and show a preview for confirmation.
 */
async function generateAndPreviewEdit(writer, tenantId, article, instruction, contextKey) {
  // Build writer persona for the edit
  const persona = await buildChatPersona(writer, tenantId, instruction);

  // Load source articles if available (for rewrites/completions)
  let sourcesText = '';
  try {
    const raw = typeof article.source_article_ids === 'string'
      ? JSON.parse(article.source_article_ids || '[]')
      : (article.source_article_ids || []);
    const sourceIds = raw.map(r => (typeof r === 'object' && r !== null) ? r.id : r).filter(Boolean);
    if (sourceIds.length) {
      const placeholders = sourceIds.map((_, i) => `$${i + 1}`).join(',');
      const sources = await db.prepare(
        `SELECT id, title, summary, source FROM articles WHERE id IN (${placeholders})`
      ).all(...sourceIds);
      if (sources.length) {
        sourcesText = '\nSource articles used for this piece:';
        sources.forEach((s, i) => {
          sourcesText += `\n[${i + 1}] ${s.title}`;
          if (s.summary) sourcesText += `\n    ${s.summary.slice(0, 300)}`;
          if (s.source) sourcesText += `\n    Source: ${s.source}`;
        });
      }
    }
  } catch {}

  // Detect if article is a stub (very short content)
  const contentLength = (article.full_content || '').length;
  const isStub = contentLength < 500;

  if (isStub && !sourcesText) {
    return `"${article.title}" appears incomplete (${contentLength} chars) and has no source articles linked. I need source material to write the full article. Try editing it in the admin dashboard where you can add sources.`;
  }

  // For stubs, default instruction to "complete the article"
  const effectiveInstruction = isStub && !/\b(rewrite|re-write|finish|complete|expand|write)\b/i.test(instruction)
    ? `${instruction}. The article is currently just a stub — write the full article using the sources provided.`
    : instruction;

  // Generate the edit
  const editPrompt = loadPrompt('article-edit');
  const rendered = editPrompt.render({
    persona,
    title: article.title,
    fullContent: article.full_content || '(Article body is empty — write the full article)',
    sources: sourcesText || '(No source articles linked)',
    instruction: effectiveInstruction,
  });

  const result = await aiComplete({
    operation: 'article-edit',
    tenantId,
    messages: rendered.messages,
    temperature: rendered.temperature,
    maxTokens: rendered.maxTokens,
    trigger: 'messaging',
    writerId: writer.id,
  });

  if (!result?.text) return 'Sorry, I couldn\'t generate the edit. Try again with a more specific instruction.';

  // Parse the AI response
  const output = result.text;
  const titleMatch = output.match(/^TITLE:\s*(.+)$/m);
  const summaryMatch = output.match(/^SUMMARY:\s*(.+)$/m);
  const changesMatch = output.match(/^CHANGES:\s*(.+)$/m);

  const newTitle = titleMatch ? titleMatch[1].trim() : article.title;
  const newSummary = summaryMatch ? summaryMatch[1].trim() : article.summary;
  const changes = changesMatch ? changesMatch[1].trim() : 'Article updated';

  // Extract the article body (between SUMMARY and CHANGES lines)
  let newContent = output;
  const summaryEnd = output.indexOf('\n', output.indexOf('SUMMARY:'));
  const changesStart = output.lastIndexOf('CHANGES:');
  if (summaryEnd > 0 && changesStart > summaryEnd) {
    newContent = output.slice(summaryEnd + 1, changesStart).trim();
  }

  // Store pending edit for confirmation
  if (contextKey) {
    pendingEdits.set(contextKey, {
      type: 'edit',
      articleId: article.id,
      originalTitle: article.title,
      newTitle,
      newContent,
      newSummary,
      changes,
      instruction,
      expiresAt: Date.now() + PENDING_EDIT_TTL,
    });
  }

  // Build preview message
  let preview = `Proposed edit for "${article.title}":\n\n`;
  if (newTitle !== article.title) preview += `New title: ${newTitle}\n`;
  preview += `Changes: ${changes}\n\n`;
  preview += `Reply "yes" to apply or "no" to cancel.`;

  return preview;
}

/**
 * Apply a confirmed pending edit — snapshot revision, update article, invalidate caches.
 */
async function applyPendingEdit(writer, tenantId, contextKey) {
  const pending = pendingEdits.get(contextKey);
  if (!pending || pending.type !== 'edit') {
    pendingEdits.delete(contextKey);
    return 'No pending edit to apply.';
  }
  pendingEdits.delete(contextKey);

  const article = await db.prepare(
    'SELECT * FROM articles WHERE id = $1 AND tenant_id = $2 AND writer_id = $3'
  ).get(pending.articleId, tenantId, writer.id);

  if (!article) return 'Article not found or you don\'t have permission to edit it.';

  // Snapshot current state to revisions table
  await db.prepare(`
    INSERT INTO article_revisions (article_id, tenant_id, title, full_content, summary, tldr_overview, edited_via, edited_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `).run(
    article.id, tenantId, article.title, article.full_content,
    article.summary, article.tldr_overview, 'chat', `writer:${writer.id}`
  );

  // Apply the edit
  await db.prepare(`
    UPDATE articles SET title = $1, full_content = $2, summary = $3, tldr_overview = $4
    WHERE id = $5 AND tenant_id = $6
  `).run(pending.newTitle, pending.newContent, pending.newSummary, pending.newSummary, article.id, tenantId);

  // Invalidate summary cache for this article
  try {
    await db.prepare(
      "DELETE FROM summary_cache WHERE tenant_id = $1 AND cache_key LIKE $2"
    ).run(tenantId, `%${article.slug}%`);
  } catch {}

  // Resolve site URL for the link
  let articleUrl = '';
  try {
    const config = await getAppConfig(tenantId);
    const siteUrl = (config.main_site_url || '').replace(/\/$/, '');
    if (siteUrl && article.slug) articleUrl = ` ${siteUrl}/article/${article.slug}`;
  } catch {}

  return `Updated "${pending.newTitle}"${articleUrl}\n\nChanges: ${pending.changes}`;
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
