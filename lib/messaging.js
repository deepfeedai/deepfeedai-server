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
const { cleanInlineMarkdownText } = require('./utils');
const { generateEmbedding, isPgvectorAvailable } = require('./embeddings');
const { isFeatureEnabled } = require('./feature-registry');

/** Cache pgvector availability check (set on first use) */
let _pgvectorAvailable = null;

/** Pending article edits awaiting confirmation: contextKey -> { articleId, newTitle, newContent, newSummary, changes, expiresAt } */
const pendingEdits = new Map();
const PENDING_EDIT_TTL = 5 * 60 * 1000; // 5 minutes

// ── Newsroom Commands (group-level, all writers) ────────────────

/**
 * Handle newsroom-level commands that span all writers.
 * Returns response string or null if not a newsroom command.
 */
async function handleNewsroomCommand(tenantId, text, chatId, agentRole) {
  // Editor agents handle all their own commands — skip newsroom routing
  if (agentRole === 'editor') return null;

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
  const agents = await db.prepare(
    "SELECT id, name, role FROM writers WHERE tenant_id = $1 AND (is_auto = true OR role != 'writer')"
  ).all(tenantId);

  if (!agents.length) return 'No agents configured.';

  let standup = '--- NEWSROOM STANDUP ---\n\n';

  for (const w of agents) {
    const [lastArticle, memCount, pitchCount] = await Promise.all([
      db.prepare("SELECT COALESCE(generated_title, title) AS title FROM articles WHERE writer_id = $1 AND tenant_id = $2 AND content_type IN ('original', 'deep-dive') AND is_published = 1 ORDER BY published_at DESC LIMIT 1").get(w.id, tenantId),
      db.prepare("SELECT COUNT(*)::int AS cnt FROM writer_memory WHERE writer_id = $1 AND tenant_id = $2 AND memory_type = 'thread' AND (expires_at IS NULL OR expires_at > NOW())").get(w.id, tenantId),
      db.prepare("SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE writer_id = $1 AND tenant_id = $2 AND status = 'pending'").get(w.id, tenantId),
    ]);

    const roleLabel = w.role && w.role !== 'writer' ? ` (${w.role})` : '';
    standup += `${w.name}${roleLabel}:\n`;
    standup += `  Last: ${lastArticle ? '"' + lastArticle.title + '"' : 'Nothing yet'}\n`;
    standup += `  Tracking: ${memCount?.cnt || 0} thread(s), ${pitchCount?.cnt || 0} pending pitch(es)\n\n`;
  }

  // Editorial stats
  const reviewCount = await db.prepare(
    "SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id = $1 AND status = 'review'"
  ).get(tenantId);
  if (reviewCount?.cnt > 0) {
    standup += `Editorial: ${reviewCount.cnt} article(s) awaiting review\n`;
  }

  return standup;
}

async function newsroomBrief(tenantId) {
  const articles = await db.prepare(`
    SELECT COALESCE(a.generated_title, a.title) AS title, a.category, w.name AS writer_name FROM articles a
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

  // Add review queue count
  const reviewCount = await db.prepare(
    "SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id = $1 AND status = 'review'"
  ).get(tenantId);
  if (reviewCount?.cnt > 0) {
    brief += `\n${reviewCount.cnt} article(s) awaiting editorial review.`;
  }

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
 * @param {number} tenantId
 * @param {number} writerId
 * @param {string} userMessage
 * @param {string|null} contextKey
 * @param {{ userId?: string, userName?: string, platform?: string }} [meta] - Platform user metadata
 */
async function handleIncoming(tenantId, writerId, userMessage, contextKey = null, meta = {}, storeMessage = null) {
  const writer = await db.prepare(
    'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(writerId, tenantId);
  if (!writer) return 'Agent not found.';

  const text = userMessage.trim();
  const cmd = text.toLowerCase();

  // Check generalized pending-action state (disambiguate / confirm / fill-slot)
  // before any other dispatch so follow-up messages resolve the pending flow
  // cleanly. Article-edit's pendingEdits map is checked later inside its own
  // branch and remains independent.
  if (contextKey) {
    const pending = require('./messaging/pending');
    const pendingResult = await pending.handlePendingResponse(contextKey, text);
    if (pendingResult.handled) return pendingResult.text;
  }

  // Route editor agents to their command handler.
  // On the web admin chat (platform='web'), unrecognized messages skip the full
  // command pipeline (avoiding editPatterns misrouting on enriched context blocks)
  // and go directly to the AI conversation path.
  if (writer.role === 'editor') {
    const editorResult = await handleEditorIncoming(writer, tenantId, text, cmd, meta.platform);
    if (editorResult !== null) return editorResult;
    // null = not a recognized command on web — bypass command pipeline, go straight to AI
    if (meta.platform === 'web') {
      return await askWriterWithContext(writer, tenantId, text, contextKey, meta, storeMessage);
    }
  }

  // Editorial actions (approve/reject articles from any channel). Strict
  // regex first — then, if nl_action_intents is on, a classifier handles
  // natural phrasings like "please approve 42" that miss the regex.
  const approveMatch = cmd.match(/^(?:\/)?approve\s+(\d+)$/);
  if (approveMatch) {
    return await handleEditorialAction('approve', parseInt(approveMatch[1]), tenantId);
  }
  const rejectMatch = cmd.match(/^(?:\/)?reject\s+(\d+)$/);
  if (rejectMatch) {
    return await handleEditorialAction('reject', parseInt(rejectMatch[1]), tenantId);
  }
  if (!cmd.startsWith('/')) {
    try {
      const { classify } = require('./messaging/intent-classifier');
      const intent = await classify(tenantId, text);
      if (intent.intent === 'approve_article') {
        return await handleEditorialAction('approve', intent.args.id, tenantId);
      }
      if (intent.intent === 'reject_article') {
        return await handleEditorialAction('reject', intent.args.id, tenantId);
      }
    } catch (err) {
      console.error('[messaging] intent classify failed (non-fatal):', err.message);
    }
  }

  // Slash commands (no context needed — stateless)
  if (cmd === '/status' || cmd === 'status') {
    return await getWriterStatus(writer, tenantId);
  }

  if (cmd === '/memory' || cmd === '/memories') {
    return await getWriterMemorySummary(writer, tenantId);
  }

  // /pitch with args = counter-angle pitch on a specific source.
  // Bare /pitch keeps the legacy "evaluate sources and auto-pitch" behavior.
  if (cmd.startsWith('/pitch ')) {
    return await handleAnglePitch(writer, tenantId, text.slice(7).trim());
  }
  if (cmd === '/pitch') {
    return await triggerPitch(writer, tenantId);
  }
  if (cmd.startsWith('/tip ')) {
    return await handleEditorTip(writer, tenantId, text.slice(5).trim(), meta);
  }

  if (cmd === '/latest') {
    return await getLatestArticles(writer, tenantId);
  }

  if (cmd === '/help' || cmd === '/commands') {
    return getHelpText(false);
  }

  if (cmd === '/clear') {
    const { clearHistory } = require('./messaging/context');
    if (contextKey) await clearHistory(contextKey, tenantId, writer.id);
    return `${writer.name}: Context cleared. Fresh start!`;
  }

  if (cmd === '/new') {
    const { clearHistory } = require('./messaging/context');
    if (contextKey) await clearHistory(contextKey, tenantId, writer.id);
    return { text: `${writer.name}: Starting fresh!`, clearChannel: true };
  }

  if (cmd.startsWith('/ask ')) {
    const question = text.slice(5).trim();
    if (!question) return 'Usage: /ask <question>';
    return await askWriterWithContext(writer, tenantId, question, contextKey, meta);
  }

  if (cmd.startsWith('/voice ') || cmd === '/voice') {
    const question = text.slice(7).trim();
    if (!question) return 'Usage: /voice <question>\nI\'ll respond with a voice message in my voice.';
    // Generate text response, then flag it for voice synthesis
    const response = await askWriterWithContext(writer, tenantId, question, contextKey, meta);
    return { text: response, voice: true, writerId: writer.id };
  }

  if (cmd.startsWith('/update ')) {
    const instruction = text.slice(8).trim();
    if (!instruction) return 'Usage: /update <article search> — <edit instruction>\nExample: /update nvidia — add the H200 benchmark results';
    return await handleArticleEdit(writer, tenantId, instruction, contextKey);
  }

  if (cmd.startsWith('/resync')) {
    const search = text.slice(7).trim();
    if (!search) return 'Usage: /resync <article keywords>\nRe-runs the full synthesis pipeline for an article using its original sources.';
    return await handleResync(writer, tenantId, search);
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
  return await askWriterWithContext(writer, tenantId, text, contextKey, meta, storeMessage);
}

// ── Intent Classification ──────────────────────────────────────

/** Regex fast-path for common intents — skips AI classification call for ~30-40% of messages */
const GREETING_RE = /^(hey|hi|hello|yo|sup|howdy|good\s+(morning|evening|afternoon|night)|what'?s\s+up|hiya|greetings)\b[!?.]*$/i;
const FOLLOW_UP_RE = /^(tell\s+me\s+more|go\s+on|continue|and\??|what\s+(else|about)|expand\s+on\s+that|more\s+details?|elaborate|how\s+so\??|why\s+is\s+that\??|really\??|interesting)[!?.]*$/i;
const META_RE = /^(what'?s?\s+your\s+beat|what\s+do\s+you\s+cover|how\s+many\s+articles|who\s+are\s+you|what\s+are\s+you|tell\s+me\s+about\s+yourself)\b/i;

/**
 * Classify message intent. Uses regex fast-path for obvious patterns,
 * falls back to AI classification for ambiguous messages.
 * @returns {{ intent: string, entities: string[], confidence: number }}
 */
async function classifyIntent(question, tenantId) {
  const trimmed = question.trim();

  // Regex fast-path — no AI call needed
  if (GREETING_RE.test(trimmed)) {
    return { intent: 'greeting', entities: [], confidence: 1.0 };
  }
  if (FOLLOW_UP_RE.test(trimmed)) {
    return { intent: 'follow_up', entities: [], confidence: 1.0 };
  }
  if (META_RE.test(trimmed)) {
    return { intent: 'meta', entities: [], confidence: 1.0 };
  }

  // AI classification for ambiguous messages
  try {
    const result = await aiComplete({
      operation: 'intent-classify',
      tenantId,
      messages: [
        { role: 'system', content: 'Classify the user\'s chat message intent. Return ONLY a JSON object.\n\nIntents:\n- greeting: casual hello, hi, hey, etc.\n- article_question: asking about specific articles the writer has written\n- topic_question: asking about a topic/news in the writer\'s beat\n- follow_up: continuing the previous topic\n- opinion: asking for the writer\'s take or prediction\n- meta: asking about the writer themselves\n\nReturn: {"intent":"<intent>","entities":[],"confidence":0.9}' },
        { role: 'user', content: trimmed },
      ],
      temperature: 0,
      maxTokens: 100,
      trigger: 'system',
      skipBudget: true,
    });

    if (result?.text) {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          intent: parsed.intent || 'topic_question',
          entities: parsed.entities || [],
          confidence: parsed.confidence || 0.7,
        };
      }
    }
  } catch (err) {
    console.error('[messaging] Intent classification failed (non-fatal):', err.message);
  }

  // Default: treat as topic question (most retrieval, safest fallback)
  return { intent: 'topic_question', entities: [], confidence: 0.5 };
}

/**
 * Ask the writer with conversation context — classifies intent, loads history,
 * calls askWriter with intent-aware context, stores the turn.
 * @param {object} writer
 * @param {number} tenantId
 * @param {string} question
 * @param {string|null} contextKey
 * @param {{ userId?: string }} [meta] - Platform user metadata
 */
async function askWriterWithContext(writer, tenantId, question, contextKey, meta = {}, storeMessage = null) {
  const { getHistory, addTurn, getSummary } = require('./messaging/context');
  const { setPresence } = require('./presence');
  // Mark the writer as actively chatting; auto-resets to idle after the stale window
  setPresence(writer.id, tenantId, 'chatting').catch(() => {});

  // Feature flag: route to LangGraph chat agent if enabled for this tenant.
  // Reads settings.chat_agent_engine = 'langgraph' | 'single-shot' (default).
  let engineRow;
  try {
    engineRow = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'chat_agent_engine'"
    ).get(tenantId);
  } catch (err) {
    console.warn('[messaging] chat_agent_engine lookup failed, using single-shot:', err.message);
  }
  if (engineRow?.value === 'langgraph') {
    try {
      const { runChatAgent } = require('./agents/chat-agent');
      console.log(`[messaging] routing to LangGraph chat agent for writer ${writer.id} on tenant ${tenantId}`);
      return await runChatAgent({ writer, tenantId, question, contextKey, meta });
    } catch (err) {
      // LOUD failure — we explicitly chose LangGraph, something is wrong
      console.error('[messaging] LangGraph chat agent FAILED, falling back to single-shot:', err.stack || err.message);
    }
  }

  // Classify intent (fast-path or AI)
  const intent = await classifyIntent(question, tenantId);

  // Load user profile for personalization (non-blocking)
  let userProfile = null;
  if (meta.userId && meta.platform) {
    userProfile = await _getUserProfile(tenantId, meta.platform, meta.userId);
  }

  // Load conversation history from persistent store
  const history = contextKey ? await getHistory(contextKey, tenantId, writer.id) : [];

  // Load conversation summary for long-term context
  const summary = contextKey ? await getSummary(contextKey, tenantId) : null;

  // Generate response with intent-aware context + user profile
  const response = await askWriter(writer, tenantId, question, history, intent, summary, userProfile);

  // Persist turn (write-through to DB)
  // storeMessage is the clean original user message (without enriched context preamble).
  // Strip <<<PITCH:>>> blocks from stored response so history stays readable.
  let storedResponse = response;
  if (typeof response === 'string') {
    storedResponse = response.replace(/\n*<<<PITCH:[\s\S]*?>>>\s*$/g, '').trim();
  } else if (response?.text) {
    storedResponse = { ...response, text: response.text.replace(/\n*<<<PITCH:[\s\S]*?>>>\s*$/g, '').trim() };
  }
  if (contextKey) {
    await addTurn(contextKey, storeMessage || question, storedResponse, {
      tenantId,
      writerId: writer.id,
      userId: meta.userId,
      contextArticleId: meta.contextArticleId || null,
    });
  }

  // Update user profile with this interaction (non-blocking)
  if (meta.userId && meta.platform) {
    _updateUserProfile(tenantId, meta.platform, meta.userId, meta.userName, intent, writer.id).catch(() => {});
  }

  return response;
}

// ── User Profile Tracking ──────────────────────────────────────

/**
 * Load a user's chat profile for personalization.
 * Returns null if no profile exists yet (fewer than 3 interactions).
 */
async function _getUserProfile(tenantId, platform, platformUserId) {
  try {
    const profile = await db.prepare(
      'SELECT * FROM chat_user_profiles WHERE tenant_id = $1 AND platform = $2 AND platform_user_id = $3'
    ).get(tenantId, platform, platformUserId);
    // Only inject profile context after enough interactions for it to be meaningful
    if (profile && profile.interaction_count >= 3) return profile;
    return null;
  } catch {
    return null;
  }
}

/**
 * Update user profile after an interaction. Fire-and-forget.
 */
async function _updateUserProfile(tenantId, platform, platformUserId, displayName, intent, writerId) {
  try {
    // Extract topic entities from intent classification
    const topics = (intent.entities || []).filter(e => e.length > 2).slice(0, 3);

    await db.prepare(`
      INSERT INTO chat_user_profiles (tenant_id, platform, platform_user_id, display_name, topics_asked, favorite_writers, last_interaction, interaction_count)
      VALUES ($1, $2, $3, $4, $5::text[], ARRAY[$6]::integer[], NOW(), 1)
      ON CONFLICT (tenant_id, platform, platform_user_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, chat_user_profiles.display_name),
        topics_asked = (
          SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(
            array_cat(chat_user_profiles.topics_asked, $5::text[])
          ) LIMIT 20)
        ),
        favorite_writers = (
          SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(
            array_cat(chat_user_profiles.favorite_writers, ARRAY[$6]::integer[])
          ) LIMIT 10)
        ),
        last_interaction = NOW(),
        interaction_count = chat_user_profiles.interaction_count + 1
    `).run(tenantId, platform, platformUserId, displayName || null, topics.length ? topics : null, writerId);
  } catch (err) {
    console.error('[messaging] User profile update failed (non-fatal):', err.message);
  }
}

// ── Hybrid Article Retrieval (Semantic + Keyword) ──────────────

/**
 * Find relevant articles using hybrid search: vector similarity + keyword matching.
 * Falls back to keyword-only if pgvector/embeddings unavailable.
 * @param {number} writerId
 * @param {number} tenantId
 * @param {string} question
 * @param {string} siteUrl
 * @param {number} limit
 * @returns {Promise<Array<{id, title, slug, snippet, link, score}>>}
 */
async function findRelevantArticles(writerId, tenantId, question, siteUrl = '', limit = 5) {
  const isSubstantial = question.replace(/[^\w]/g, '').length >= 10;
  if (!isSubstantial) {
    // Short question — just return latest articles
    return _getLatestArticlesForPersona(writerId, tenantId, siteUrl, 3);
  }

  // Check pgvector availability (cached)
  if (_pgvectorAvailable === null) {
    _pgvectorAvailable = await isPgvectorAvailable();
  }

  // Shared-wire: curated visibility expands from "owned by this writer" to
  // "in this writer's beats", so a writer can find context their colleagues
  // ingested. Synthesis stays writer_id-scoped (enforced elsewhere).
  const sharedWire = await isFeatureEnabled(tenantId, 'curated_shared_wire').catch(() => false);

  let vectorResults = [];
  let keywordResults = [];
  let curatedVectorResults = [];

  // Semantic search — if pgvector is available
  if (_pgvectorAvailable) {
    try {
      const queryVector = await generateEmbedding(tenantId, question);
      const queryJson = JSON.stringify(queryVector);
      vectorResults = await db.prepare(`
        SELECT id, COALESCE(generated_title, title) AS title, slug, COALESCE(tldr_overview, LEFT(summary, 150)) AS snippet,
               1 - (embedding <=> $1::vector) AS similarity
        FROM articles
        WHERE writer_id = $2 AND tenant_id = $3
          AND content_type IN ('original', 'deep-dive') AND is_published = 1
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 10
      `).all(queryJson, writerId, tenantId);

      if (sharedWire) {
        // Beat-scoped curated vector search — surfaces source articles in the
        // writer's beats regardless of which writer was stamped as lead.
        curatedVectorResults = await db.prepare(`
          SELECT a.id, COALESCE(a.generated_title, a.title) AS title, a.slug,
                 COALESCE(a.tldr_overview, LEFT(a.summary, 150)) AS snippet,
                 1 - (a.embedding <=> $1::vector) AS similarity
          FROM articles a
          WHERE a.tenant_id = $3
            AND (a.content_type IS NULL OR a.content_type = 'curated')
            AND a.is_published = 1
            AND a.embedding IS NOT NULL
            AND a.category IN (
              SELECT c.name FROM writer_beats wb
              JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $3
              WHERE wb.writer_id = $2 AND wb.tenant_id = $3
            )
          ORDER BY a.embedding <=> $1::vector
          LIMIT 10
        `).all(queryJson, writerId, tenantId);
      }
    } catch (err) {
      console.error('[messaging] Semantic search failed (falling back to keyword):', err.message);
    }
  }

  // Keyword search — always runs as fallback/boost.
  // Only plain alphanumeric words — enriched messages may contain [brackets] and
  // other special chars that break the PostgreSQL POSIX regex operator (~).
  // With shared_wire: curated items matched by beat, originals still by writer_id.
  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3 && /^[a-z0-9]+$/.test(w)).slice(0, 5);
  if (keywords.length) {
    const pattern = keywords.join('|');
    if (sharedWire) {
      keywordResults = await db.prepare(`
        SELECT id, COALESCE(generated_title, title) AS title, slug, COALESCE(tldr_overview, LEFT(summary, 150)) AS snippet
        FROM articles
        WHERE tenant_id = $2 AND is_published = 1
          AND (LOWER(title) ~ $3 OR LOWER(COALESCE(generated_title, '')) ~ $3 OR LOWER(COALESCE(tldr_overview, summary, '')) ~ $3)
          AND (
            (content_type IN ('original','deep-dive') AND writer_id = $1)
            OR (
              (content_type IS NULL OR content_type = 'curated')
              AND category IN (
                SELECT c.name FROM writer_beats wb
                JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $2
                WHERE wb.writer_id = $1 AND wb.tenant_id = $2
              )
            )
          )
        ORDER BY published_at DESC LIMIT 5
      `).all(writerId, tenantId, pattern);
    } else {
      keywordResults = await db.prepare(`
        SELECT id, COALESCE(generated_title, title) AS title, slug, COALESCE(tldr_overview, LEFT(summary, 150)) AS snippet
        FROM articles WHERE writer_id = $1 AND tenant_id = $2
          AND is_published = 1
          AND (LOWER(title) ~ $3 OR LOWER(COALESCE(generated_title, '')) ~ $3 OR LOWER(COALESCE(tldr_overview, summary, '')) ~ $3)
        ORDER BY published_at DESC LIMIT 5
      `).all(writerId, tenantId, pattern);
    }
  }

  // Merge curated vector results into the vector pool with a dampened similarity
  // score — curated items are sources, not authored work, so they rank below
  // a writer's own originals for the same topic.
  if (curatedVectorResults.length) {
    for (const r of curatedVectorResults) {
      vectorResults.push({ ...r, similarity: (r.similarity || 0) * 0.75 });
    }
  }

  // Hybrid merge
  if (vectorResults.length || keywordResults.length) {
    const merged = _hybridRank(vectorResults, keywordResults, limit);
    return merged.map(a => ({
      ...a,
      link: (siteUrl && a.slug) ? ` ${siteUrl}/article/${a.slug}` : '',
    }));
  }

  // No results from either — fall back to latest
  return _getLatestArticlesForPersona(writerId, tenantId, siteUrl, 3);
}

/**
 * Merge vector and keyword results with weighted scoring.
 */
function _hybridRank(vectorResults, keywordResults, limit) {
  const merged = new Map();

  // Vector results: base score = similarity (0-1)
  for (const r of vectorResults) {
    merged.set(r.id, { ...r, vectorScore: r.similarity || 0, keywordScore: 0 });
  }

  // Keyword results: boost articles found by both methods
  for (const r of keywordResults) {
    if (merged.has(r.id)) {
      merged.get(r.id).keywordScore = 1.0;
    } else {
      merged.set(r.id, { ...r, vectorScore: 0, keywordScore: 1.0 });
    }
  }

  // Final score: weighted combination
  const scored = [...merged.values()].map(r => ({
    ...r,
    finalScore: (r.vectorScore * 0.7) + (r.keywordScore * 0.3),
  }));

  return scored.sort((a, b) => b.finalScore - a.finalScore).slice(0, limit);
}

/**
 * Get latest published articles for persona context (fallback).
 * Includes originals first, then curated articles assigned to the writer.
 */
async function _getLatestArticlesForPersona(writerId, tenantId, siteUrl, limit) {
  // Try originals/deep-dives first
  let recent = await db.prepare(`
    SELECT id, title, slug, COALESCE(tldr_overview, LEFT(summary, 120)) AS snippet
    FROM articles WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive') AND is_published = 1
    ORDER BY published_at DESC LIMIT $3
  `).all(writerId, tenantId, limit);

  // If no originals, fall back to curated articles. With shared_wire,
  // match by writer's beats (not just curated assigned to this writer).
  if (!recent.length) {
    const sharedWire = await isFeatureEnabled(tenantId, 'curated_shared_wire').catch(() => false);
    if (sharedWire) {
      recent = await db.prepare(`
        SELECT id, title, slug, COALESCE(tldr_overview, LEFT(summary, 120)) AS snippet
        FROM articles
        WHERE tenant_id = $2 AND is_published = 1
          AND (content_type IS NULL OR content_type = 'curated')
          AND category IN (
            SELECT c.name FROM writer_beats wb
            JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $2
            WHERE wb.writer_id = $1 AND wb.tenant_id = $2
          )
        ORDER BY published_at DESC LIMIT $3
      `).all(writerId, tenantId, limit);
    } else {
      recent = await db.prepare(`
        SELECT id, title, slug, COALESCE(tldr_overview, LEFT(summary, 120)) AS snippet
        FROM articles WHERE writer_id = $1 AND tenant_id = $2
          AND is_published = 1
        ORDER BY published_at DESC LIMIT $3
      `).all(writerId, tenantId, limit);
    }
  }

  return recent.map(a => ({
    ...a,
    link: (siteUrl && a.slug) ? ` ${siteUrl}/article/${a.slug}` : '',
  }));
}

/**
 * Build a lightweight chat persona — identity and personality only,
 * NO article-writing instructions that conflict with conversational behavior.
 * Intent-aware: skips expensive retrieval for greetings/follow-ups.
 * @param {object} writer
 * @param {number} tenantId
 * @param {string} [question=''] - The user's question, used for relevant article/memory retrieval
 * @param {{ intent: string, entities: string[] }} [intentInfo] - Classified intent
 * @param {string|null} [conversationSummary] - Rolling summary from prior turns
 * @param {object|null} [userProfile] - Chat user profile for personalization
 */
async function buildChatPersona(writer, tenantId, question = '', intentInfo = null, conversationSummary = null, userProfile = null) {
  // Beats
  let beats = 'technology';
  try {
    const rows = await db.prepare(
      'SELECT c.name FROM writer_beats wb JOIN categories c ON c.id = wb.category_id WHERE wb.writer_id = $1 AND wb.tenant_id = $2'
    ).all(writer.id, tenantId);
    if (rows.length) beats = rows.map(b => b.name).join(', ');
  } catch {}

  // The getArticleSources tool only exists on the LangGraph agent path.
  // If this tenant is still on single-shot, nudging the model to call it
  // makes things worse: it emits tool-call syntax as plain text and then
  // invents publisher names anyway.
  let langGraphActive = false;
  try {
    const engineRow = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'chat_agent_engine'"
    ).get(tenantId);
    langGraphActive = engineRow?.value === 'langgraph';
  } catch { /* default false */ }

  let persona = `You are ${writer.name}. You cover ${beats}.`;
  if (langGraphActive) {
    persona += ` When asked what sources are reporting on something, or where a specific figure or claim came from, call getArticleSources — never guess publisher names or invent citations. When quoting specific numbers, attribute them to the source article from the tool.`;
  } else {
    persona += ` If asked what publishers or sources are reporting on a story, and the sources aren't already shown in your context, say honestly that you don't have that information handy rather than guessing publisher names or URLs.`;
  }
  persona += ` If the user asks for a specific format (bullet list, numbered list, table, short answer), honor it — structure wins over your usual narrative voice when the user explicitly asks.`;
  if (writer.tone) persona += ` Your tone is ${writer.tone}.`;
  if (writer.beat_angle) persona += ` Your angle: ${writer.beat_angle}.`;
  if (writer.signature_phrases?.length) {
    persona += ` You sometimes say: "${writer.signature_phrases.slice(0, 3).join('", "')}"`;
  }

  const intent = intentInfo?.intent || 'topic_question';

  // For greetings and follow-ups, skip article/memory retrieval entirely
  if (intent === 'greeting') {
    if (conversationSummary) {
      persona += `\nConversation context: ${conversationSummary}`;
    }
    return persona;
  }

  if (intent === 'follow_up') {
    // Follow-ups rely on conversation history, not fresh retrieval
    if (conversationSummary) {
      persona += `\nConversation context: ${conversationSummary}`;
    }
    return persona;
  }

  // For meta questions, add stats but skip article retrieval
  if (intent === 'meta') {
    const stats = await db.prepare(`
      SELECT COUNT(*)::int AS cnt FROM articles
      WHERE writer_id = $1 AND tenant_id = $2
        AND content_type IN ('original', 'deep-dive') AND is_published = 1
    `).get(writer.id, tenantId);
    persona += `\nYou have published ${stats?.cnt || 0} original articles.`;
    if (conversationSummary) {
      persona += `\nConversation context: ${conversationSummary}`;
    }
    return persona;
  }

  // Article/topic/opinion intents — full retrieval (hybrid: semantic + keyword)
  let siteUrl = '';
  try {
    const config = await getAppConfig(tenantId);
    siteUrl = (config.main_site_url || config.base_url || '').replace(/\/$/, '');
  } catch {}

  const articles = await findRelevantArticles(writer.id, tenantId, question, siteUrl);
  if (articles.length) {
    persona += '\nRelevant stories you wrote:';
    for (const a of articles) {
      persona += `\n- ${a.title}${a.link}` + (a.snippet ? ` — ${a.snippet}` : '');
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

  // Inject conversation summary for continuity
  if (conversationSummary) {
    persona += `\nConversation context: ${conversationSummary}`;
  }

  // Inject user profile for personalization (only after 3+ interactions)
  if (userProfile) {
    const name = userProfile.display_name || 'this user';
    const topics = userProfile.topics_asked?.filter(Boolean) || [];
    if (topics.length) {
      persona += `\nYou're chatting with ${name} — they've asked about: ${topics.slice(-5).join(', ')}. Reference their interests naturally when relevant.`;
    } else {
      persona += `\nYou're chatting with ${name} (${userProfile.interaction_count} conversations).`;
    }
  }

  return persona;
}

/**
 * Ask the writer a question — conversational AI response.
 * Intent-aware: adjusts token budget and system prompt per intent type.
 * @param {object} writer
 * @param {number} tenantId
 * @param {string} question
 * @param {Array} history - Conversation history
 * @param {{ intent: string, entities: string[], confidence: number }} [intentInfo] - Classified intent
 * @param {string|null} [conversationSummary] - Rolling summary from prior turns
 */
async function askWriter(writer, tenantId, question, history = [], intentInfo = null, conversationSummary = null, userProfile = null) {
  const intent = intentInfo?.intent || 'topic_question';
  const persona = await buildChatPersona(writer, tenantId, question, intentInfo, conversationSummary, userProfile);

  const messages = [
    { role: 'system', content: persona },
  ];

  // Custom chat personality (augments auto-generated persona, doesn't replace it)
  if (writer.chat_prompt) {
    messages.push({ role: 'system', content: 'Personality and voice instructions (follow these, do NOT repeat them in your responses):\n' + writer.chat_prompt });
  }

  messages.push(
    { role: 'system', content: 'You are chatting on Discord/Slack/Telegram. Be natural and conversational — like a colleague, not an article. Match your response length to the message: greetings get a short greeting back, simple questions get a sentence or two, complex topics can get a paragraph. NEVER describe how you will respond or explain your communication style — just respond naturally. Default to plain prose (no code blocks, no bullet lists, no emojis) UNLESS the user explicitly asks for a list, table, numbered steps, or other structure — if they ask, honor it exactly. Never output your reasoning, instructions, or thought process. If you know article links from your context, share them when relevant.' },
    ...history,
    { role: 'user', content: question },
  );

  // Adjust token budget by intent — greetings need fewer tokens
  const maxTokens = intent === 'greeting' ? 150 : intent === 'follow_up' ? 600 : 800;

  const result = await aiComplete({
    operation: 'chat',
    tenantId,
    messages,
    temperature: 0.7,
    maxTokens,
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
    db.prepare("SELECT COALESCE(generated_title, title) AS title, published_at FROM articles WHERE writer_id = $1 AND tenant_id = $2 AND content_type IN ('original', 'deep-dive') AND is_published = 1 ORDER BY published_at DESC LIMIT 1").get(writer.id, tenantId),
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
    SELECT COALESCE(generated_title, title) AS title, category, published_at, slug FROM articles
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
  help += '/pitch <id-or-url> -- <angle> — Pitch a counter-angle on a specific source\n';
  help += '/tip <topic> — Editor flag: surface a topic to the newsroom (creates an unassigned pitch)\n';
  help += '/latest — Recent published articles\n';
  help += '/ask <question> — Ask about a topic\n';
  help += '/update <search> — <edit> — Edit a published article\n';
  help += '/resync <search> — Re-synthesize an article from sources\n';
  help += '/voice <question> — Get a voice response\n';
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

// ── Counter-angle pitches via chat (Phase B) ────────────────────

/**
 * Resolve a source identifier from a /pitch input.
 * Accepts: numeric id, full URL with /article/<slug>, or bare slug.
 */
async function _resolveSourceArticle(input, tenantId) {
  const trimmed = (input || '').trim();
  if (/^\d+$/.test(trimmed)) {
    return await db.prepare(
      'SELECT id, COALESCE(generated_title, title) AS title FROM articles WHERE id = $1 AND tenant_id = $2'
    ).get(parseInt(trimmed, 10), tenantId);
  }
  // Try slug match (extract from URL if present)
  const slugMatch = trimmed.match(/\/article\/([a-z0-9-]+)/i);
  const slug = slugMatch ? slugMatch[1] : trimmed.replace(/^https?:\/\/[^/]+\//, '');
  return await db.prepare(
    'SELECT id, COALESCE(generated_title, title) AS title FROM articles WHERE slug = $1 AND tenant_id = $2'
  ).get(slug, tenantId);
}

/**
 * /pitch <id-or-url> -- <angle> — submit a counter-angle pitch on a source.
 * Separator can be `--`, `—` (em dash), or `:`.
 */
async function handleAnglePitch(writer, tenantId, args) {
  const { isFeatureEnabled } = require('./feature-registry');
  const enabled = await isFeatureEnabled(tenantId, 'article_pitches').catch(() => false);
  if (!enabled) return `${writer.name}: Counter-angle pitches aren't enabled for this newsroom.`;

  const m = args.match(/^(\S+)\s*(?:--|—|:)\s*(.+)$/s);
  if (!m) return `${writer.name}: Usage — /pitch <article-id-or-url> -- <your angle>\nExample: /pitch 1234 -- The compliance angle on this breach is what's missing from coverage.`;

  const [, sourceRef, angle] = m;
  if (angle.trim().length < 10) return `${writer.name}: Angle is too short — give me a sentence or two on what makes your take different.`;

  const source = await _resolveSourceArticle(sourceRef, tenantId);
  if (!source) return `${writer.name}: I can't find an article matching "${sourceRef}". Use the article id or full URL.`;

  // Dedupe open pitches by this writer on this source
  const existing = await db.prepare(
    `SELECT id FROM article_pitches WHERE tenant_id = $1 AND source_article_id = $2 AND pitched_by_writer_id = $3 AND status = 'proposed'`
  ).get(tenantId, source.id, writer.id);
  if (existing) return `${writer.name}: You already have an open pitch (#${existing.id}) on "${source.title}". Editor will review.`;

  const row = await db.prepare(`
    INSERT INTO article_pitches (tenant_id, source_article_id, pitched_by_writer_id, angle_summary, status)
    VALUES ($1, $2, $3, $4, 'proposed') RETURNING id
  `).get(tenantId, source.id, writer.id, angle.trim().slice(0, 2000));

  return `${writer.name}: Pitch #${row.id} submitted on "${source.title}". Editor will approve or reject.`;
}

/**
 * /tip <topic> — editor flags a topic worth covering. Finds a recent curated
 * article matching the topic and creates a pitch with no writer assigned;
 * editor picks who claims it from the review UI.
 */
async function handleEditorTip(writer, tenantId, topic, meta) {
  const { isFeatureEnabled } = require('./feature-registry');
  const enabled = await isFeatureEnabled(tenantId, 'article_pitches').catch(() => false);
  if (!enabled) return `Editor tips aren't enabled for this newsroom.`;

  if (!topic || topic.length < 5) return `Usage — /tip <topic>\nExample: /tip Trivy supply chain attack`;

  // Find a recent curated source matching the topic via simple keyword search.
  const keywords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
  const pattern = keywords.length ? keywords.join('|') : topic.toLowerCase();
  const source = await db.prepare(`
    SELECT id, COALESCE(generated_title, title) AS title FROM articles
    WHERE tenant_id = $1
      AND (content_type IS NULL OR content_type = 'curated')
      AND created_at > NOW() - INTERVAL '30 days'
      AND (LOWER(title) ~ $2 OR LOWER(COALESCE(summary, '')) ~ $2)
    ORDER BY created_at DESC LIMIT 1
  `).get(tenantId, pattern);

  // No internal match — try external research if enabled
  if (!source) {
    const researchOn = await isFeatureEnabled(tenantId, 'agent_web_research').catch(() => false);
    if (!researchOn) {
      return `No recent curated source matched "${topic}" in the last 30 days. Ingest one first, or pitch directly with /pitch <id> -- <angle>.`;
    }

    const { searchAll } = require('./research');
    const r = await searchAll(tenantId, topic, { count: 8 });
    if (!r.results.length) {
      return `No internal coverage on "${topic}", and external research returned nothing. Errors: ${r.errors.map(e => e.source + ':' + e.reason).join(', ') || 'none'}.`;
    }

    // Auto-ingest the top 3 non-duplicate results, create pitch on the strongest
    const { toSlug } = require('./utils');
    const { detectCategory } = require('./categorize');
    const { generateEmbedding, isPgvectorAvailable } = require('./embeddings');
    const pgvector = await isPgvectorAvailable().catch(() => false);

    const ingested = [];
    for (const item of r.results) {
      if (ingested.length >= 3) break;
      const dup = await db.prepare(
        'SELECT id FROM articles WHERE tenant_id = $1 AND source_url = $2 LIMIT 1'
      ).get(tenantId, item.url);
      if (dup) { ingested.push({ id: dup.id, title: item.title, dedup: true }); continue; }
      const title = String(item.title).slice(0, 500);
      const summary = String(item.snippet || '').slice(0, 1000);
      const slug = toSlug(title) || `tip-${Date.now()}`;
      let category = 'General';
      try { category = await detectCategory({ title, contentSnippet: summary }, { tenantId }) || 'General'; } catch {}
      const inserted = await db.prepare(`
        INSERT INTO articles
          (tenant_id, title, slug, summary, source, source_url, category, content_type, ingest_source, is_published, status, published_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'curated', 'enrichment', 1, 'published', NOW(), NOW(), NOW())
        RETURNING id
      `).get(tenantId, title, slug, summary, item.publisher || item.source || 'Unknown', item.url, category);
      if (inserted) {
        ingested.push({ id: inserted.id, title, source: item.source });
        if (pgvector) generateEmbedding(tenantId, `${title}\n\n${summary}`)
          .then(v => db.prepare('UPDATE articles SET embedding = $1::vector WHERE id = $2 AND tenant_id = $3').run(JSON.stringify(v), inserted.id, tenantId))
          .catch(() => {});
      }
    }

    if (!ingested.length) return `External search returned results but couldn't ingest any (all duplicates or insert failed).`;

    const anchor = ingested[0];
    // Capture editor identity if meta.userId is a numeric admin user id (web chat).
    // Discord/Telegram userIds are platform snowflakes, not DB user ids — leave NULL there.
    const editorId = meta && /^\d+$/.test(String(meta.userId || '')) ? parseInt(meta.userId, 10) : null;
    const pitchRow = await db.prepare(`
      INSERT INTO article_pitches
        (tenant_id, source_article_id, requested_by_editor_id, angle_summary, status)
      VALUES ($1, $2, $3, $4, 'proposed') RETURNING id
    `).get(tenantId, anchor.id, editorId, `[Editor tip — externally researched] ${topic.slice(0, 1900)}`);

    const lines = ingested.map(i => `  • ${i.title}${i.dedup ? ' (already in feed)' : ''}`).join('\n');
    return `Editor tip #${pitchRow.id} created. No internal source matched, so I ingested ${ingested.length} external candidate(s):\n${lines}\nAssign a writer in the Pitches review queue to start synthesis.`;
  }

  const editorId = meta && /^\d+$/.test(String(meta.userId || '')) ? parseInt(meta.userId, 10) : null;
  const row = await db.prepare(`
    INSERT INTO article_pitches
      (tenant_id, source_article_id, requested_by_editor_id, angle_summary, status)
    VALUES ($1, $2, $3, $4, 'proposed') RETURNING id
  `).get(tenantId, source.id, editorId, `[Editor tip] ${topic.slice(0, 1900)}`);

  return `Editor tip #${row.id} created on "${source.title}". Assign a writer in the Pitches review queue to start synthesis.`;
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
  const keywords = search.toLowerCase().split(/\s+/).filter(w => w.length > 2 && /^[a-z0-9]+$/.test(w)).slice(0, 5);
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

  // Parse the AI response — strip format markers robustly
  const output = result.text;
  const titleMatch = output.match(/^TITLE:\s*(.+)$/m);
  const summaryMatch = output.match(/^SUMMARY:\s*(.+)$/m);
  const changesMatch = output.match(/^CHANGES:\s*(.+)$/m);

  const newTitle = titleMatch ? cleanInlineMarkdownText(titleMatch[1].trim(), 220) : article.title;
  const newSummary = summaryMatch ? cleanInlineMarkdownText(summaryMatch[1].trim(), 500) : article.summary;
  const changes = changesMatch ? changesMatch[1].trim() : (isStub ? 'Full article written from sources' : 'Article updated');

  // Extract the article body — strip all format markers
  let newContent = output;
  // Remove TITLE: line
  newContent = newContent.replace(/^TITLE:\s*.+$/m, '');
  // Remove SUMMARY: line
  newContent = newContent.replace(/^SUMMARY:\s*.+$/m, '');
  // Remove CHANGES: line (and everything after it)
  const changesIdx = newContent.lastIndexOf('CHANGES:');
  if (changesIdx > 0) newContent = newContent.slice(0, changesIdx);
  newContent = newContent.trim();

  if (!newContent || newContent.length < 100) {
    return 'The AI generated too little content. Try a more specific instruction, or try /update with an explicit edit.';
  }

  const contentWords = newContent.split(/\s+/).length;
  const originalWords = (article.full_content || '').split(/\s+/).length;

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
      instruction: effectiveInstruction,
      expiresAt: Date.now() + PENDING_EDIT_TTL,
    });
  }

  // Build informative preview message
  let preview = `Proposed edit for "${article.title}":\n\n`;
  if (newTitle !== article.title) preview += `New title: ${newTitle}\n`;
  preview += `${changes}\n`;
  preview += `${originalWords} words → ${contentWords} words\n`;
  preview += `First line: "${newContent.split('\n')[0].slice(0, 120)}..."\n\n`;
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

/**
 * Handle /resync — re-run the full synthesis pipeline for an article.
 * Finds the article by keyword, loads its source_article_ids, and re-synthesizes.
 */
async function handleResync(writer, tenantId, search) {
  // Find the article
  const keywords = search.toLowerCase().split(/\s+/).filter(w => w.length > 2 && /^[a-z0-9]+$/.test(w)).slice(0, 5);
  const pattern = keywords.join('|');

  const matches = await db.prepare(`
    SELECT id, title, slug, source_article_ids, writer_id
    FROM articles WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive')
      AND LOWER(title) ~ $3
    ORDER BY published_at DESC LIMIT 5
  `).all(writer.id, tenantId, pattern);

  if (!matches.length) {
    return `No articles matching "${search}" found. Try /latest to see your recent articles.`;
  }

  if (matches.length > 1) {
    let response = `Found ${matches.length} articles. Which one to re-synthesize?\n\n`;
    matches.forEach((a, i) => { response += `${i + 1}. ${a.title}\n`; });
    response += '\nUse: /resync <more specific keywords>';
    return response;
  }

  const article = matches[0];

  // Parse source article IDs
  let sourceIds = [];
  try {
    const raw = typeof article.source_article_ids === 'string'
      ? JSON.parse(article.source_article_ids || '[]')
      : (article.source_article_ids || []);
    sourceIds = raw.map(r => (typeof r === 'object' && r !== null) ? r.id : r).filter(Boolean);
  } catch {}

  if (sourceIds.length < 2) {
    return `"${article.title}" has ${sourceIds.length} source(s) — need at least 2 for re-synthesis. Try /update instead for manual edits.`;
  }

  // Load source articles to build a cluster
  const placeholders = sourceIds.map((_, i) => `$${i + 1}`).join(',');
  const sources = await db.prepare(
    `SELECT id, title, summary, enriched_summary, source, source_url, category, created_at
     FROM articles WHERE id IN (${placeholders})`
  ).all(...sourceIds);

  if (sources.length < 2) {
    return `Could only find ${sources.length} of the original source articles. Some may have been deleted.`;
  }

  // Build a cluster object matching what synthesizeCluster expects
  const cluster = {
    topic: article.title.replace(/^(The|A|An)\s+/i, '').slice(0, 100),
    articles: sources,
  };

  // Re-synthesize
  try {
    const { synthesizeCluster } = require('./synthesis');
    const result = await synthesizeCluster(cluster, writer, tenantId);

    if (!result) return `Re-synthesis failed — check AI provider configuration and budget.`;

    const status = result.status === 'published' ? 'published' : 'sent to editorial review';
    return `Re-synthesized "${result.title}" (${status})\n${sources.length} sources used.`;
  } catch (err) {
    console.error('[resync] Error:', err.message);
    return `Re-synthesis error: ${err.message}`;
  }
}

// ── Editor Agent Commands ──────────────────────────────────────

/**
 * Handle incoming messages on an editor agent's channel.
 * Returns null when platform='web' and the message isn't a recognized command,
 * signalling handleIncoming to fall through to the conversational AI path.
 */
async function handleEditorIncoming(editor, tenantId, text, cmd, platform = null) {
  // approve [id]
  const approveMatch = cmd.match(/^(?:\/)?approve\s+(\d+)$/);
  if (approveMatch) {
    return await handleEditorialAction('approve', parseInt(approveMatch[1]), tenantId);
  }

  // reject [id]
  const rejectMatch = cmd.match(/^(?:\/)?reject\s+(\d+)$/);
  if (rejectMatch) {
    return await handleEditorialAction('reject', parseInt(rejectMatch[1]), tenantId);
  }

  // /review — show current review queue
  if (cmd === '/review' || cmd === 'review') {
    return await getReviewQueue(tenantId);
  }

  // /stats — editorial statistics
  if (cmd === '/stats' || cmd === 'stats') {
    return await getEditorStats(editor, tenantId);
  }

  // /help
  if (cmd === '/help' || cmd === 'help') {
    return getEditorHelpText();
  }

  // On web admin chat, fall through to conversational AI for non-command messages
  if (platform === 'web') return null;

  // On Discord/Telegram — editors don't chat, show help
  return `${editor.name}: I'm the editorial reviewer. I don't chat — I review articles.\n\n` + getEditorHelpText();
}

/**
 * Get the current review queue summary for messaging.
 */
async function getReviewQueue(tenantId) {
  const articles = await db.prepare(`
    SELECT a.id, a.title, a.editor_verdict, a.submitted_for_review_at, w.name AS writer_name
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id
    WHERE a.tenant_id = $1 AND a.status = 'review'
    ORDER BY a.submitted_for_review_at ASC
  `).all(tenantId);

  if (!articles.length) return 'Review queue is empty. All clear!';

  let response = `--- REVIEW QUEUE (${articles.length}) ---\n\n`;
  articles.forEach((a) => {
    let verdict = a.editor_verdict;
    if (typeof verdict === 'string') try { verdict = JSON.parse(verdict); } catch { verdict = null; }
    const score = verdict?.score ? ` (score: ${verdict.score}/10)` : '';
    const ago = a.submitted_for_review_at
      ? Math.round((Date.now() - new Date(a.submitted_for_review_at).getTime()) / 3600000) + 'h ago'
      : '';
    response += `#${a.id} — ${a.title}${score}\n`;
    if (a.writer_name) response += `  Writer: ${a.writer_name}`;
    if (ago) response += ` | Submitted: ${ago}`;
    response += '\n\n';
  });
  response += 'Reply "approve [id]" or "reject [id]"';
  return response;
}

/**
 * Get editor performance stats for messaging.
 */
async function getEditorStats(editor, tenantId) {
  const [reviewedToday, reviewedTotal, pendingReview, avgScore] = await Promise.all([
    db.prepare(
      "SELECT COUNT(*)::int AS cnt FROM newsroom_messages WHERE tenant_id = $1 AND from_writer_id = $2 AND message_type = 'editorial-review' AND created_at > NOW() - INTERVAL '24 hours'"
    ).get(tenantId, editor.id),
    db.prepare(
      "SELECT COUNT(*)::int AS cnt FROM newsroom_messages WHERE tenant_id = $1 AND from_writer_id = $2 AND message_type = 'editorial-review'"
    ).get(tenantId, editor.id),
    db.prepare(
      "SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id = $1 AND status = 'review'"
    ).get(tenantId),
    db.prepare(
      "SELECT AVG((editor_verdict->>'score')::numeric)::numeric(3,1) AS avg FROM articles WHERE tenant_id = $1 AND editor_verdict IS NOT NULL AND last_reviewed_at > NOW() - INTERVAL '7 days'"
    ).get(tenantId),
  ]);

  let stats = `${editor.name} — Editorial Stats\n\n`;
  stats += `Reviewed today: ${reviewedToday?.cnt || 0}\n`;
  stats += `Reviewed all time: ${reviewedTotal?.cnt || 0}\n`;
  stats += `Pending review: ${pendingReview?.cnt || 0}\n`;
  stats += `Avg score (7d): ${avgScore?.avg || 'N/A'}/10\n`;

  return stats;
}

/**
 * Editor-specific help text.
 */
function getEditorHelpText() {
  return '--- Editor Commands ---\n\n'
    + 'approve [id] — Publish an article\n'
    + 'reject [id] — Reject article to draft\n'
    + '/review — Show review queue\n'
    + '/stats — Editorial statistics\n'
    + '/help — Show this message\n';
}

/**
 * Handle approve/reject editorial actions from messaging channels.
 */
async function handleEditorialAction(action, articleId, tenantId) {
  const article = await db.prepare(
    'SELECT id, title, status, slug FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(articleId, tenantId);

  if (!article) return `Article #${articleId} not found.`;

  if (action === 'approve') {
    if (article.status === 'published') return `"${article.title}" is already published.`;
    await db.prepare(
      "UPDATE articles SET status = 'published', is_published = 1, reviewed_at = NOW(), published_at = COALESCE(published_at, NOW()), updated_at = NOW() WHERE id = $1 AND tenant_id = $2"
    ).run(articleId, tenantId);

    // Fire post-publish hooks
    try {
      const { onArticlePublished } = require('./post-publish');
      onArticlePublished(articleId, tenantId).catch(() => {});
    } catch {}

    let url = '';
    try {
      const config = await getAppConfig(tenantId);
      const siteUrl = (config.main_site_url || '').replace(/\/$/, '');
      if (siteUrl && article.slug) url = ` ${siteUrl}/article/${article.slug}`;
    } catch {}

    return `Approved and published "${article.title}"${url}`;
  }

  if (action === 'reject') {
    if (article.status === 'draft') return `"${article.title}" is already a draft.`;
    await db.prepare(
      "UPDATE articles SET status = 'draft', is_published = 0, reviewed_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2"
    ).run(articleId, tenantId);
    return `Rejected "${article.title}" — moved back to draft.`;
  }

  return 'Unknown action. Use "approve [id]" or "reject [id]".';
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
 * Send a writer's morning standup to their configured messaging channels.
 */
async function notifyStandup(tenantId, text, writer) {
  const msg = `${writer.name} standup:\n\n${text}`;
  await sendMessage(tenantId, writer.id, msg);
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
 * Record a newsroom message between agents.
 * Circuit breaker: max 20 messages per agent per hour to prevent runaway loops.
 */
const MAX_NEWSROOM_MESSAGES_PER_HOUR = 20;

async function recordNewsroomMessage(tenantId, fromWriterId, toWriterId, type, content, context = {}) {
  // Circuit breaker: check rate for sending agent
  if (fromWriterId) {
    try {
      const hourCount = await db.prepare(
        "SELECT COUNT(*)::int AS cnt FROM newsroom_messages WHERE tenant_id = $1 AND from_writer_id = $2 AND created_at > NOW() - INTERVAL '1 hour'"
      ).get(tenantId, fromWriterId);
      if ((hourCount?.cnt || 0) >= MAX_NEWSROOM_MESSAGES_PER_HOUR) {
        console.warn(`[newsroom] Circuit breaker: agent ${fromWriterId} hit ${MAX_NEWSROOM_MESSAGES_PER_HOUR} messages/hour limit`);
        return null;
      }
    } catch {}
  }

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
  notifyStandup,
  recordNewsroomMessage,
  getHelpText,
  findRelevantArticles,
};
