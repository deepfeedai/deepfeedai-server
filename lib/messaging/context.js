/**
 * Conversation Context Buffer — persistent, DB-backed multi-turn history
 * with in-memory hot cache for low-latency reads.
 *
 * Context is keyed by platform + channel (+ thread for Telegram topics).
 * Each channel maps to exactly one writer, so channel-scoped = writer-scoped.
 *
 * Write-through: every turn is written to both in-memory cache and DB.
 * On cold start or cache miss, history is loaded from DB.
 * Rolling summaries are generated every SUMMARY_THRESHOLD turns.
 */

const db = require('../../db');
const { complete: aiComplete } = require('../ai-router');

const MAX_MESSAGES = 20;          // 10 user + 10 assistant turns
const EXPIRY_MS = 60 * 60 * 1000; // 1 hour of inactivity (cache only)
const CLEANUP_INTERVAL = 10 * 60 * 1000;
const SUMMARY_THRESHOLD = 20;     // generate summary every N turns

/** @type {Map<string, { messages: Array<{role: string, content: string}>, updatedAt: number, turnCount: number, summary: string|null, loaded: boolean }>} */
const buffers = new Map();

/** Tracks context keys currently generating summaries to prevent races */
const summarizing = new Set();

// ── Periodic cleanup ───────────────────────────────────────────

let cleanupTimer = null;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buffers) {
      if (now - entry.updatedAt > EXPIRY_MS) {
        buffers.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);
  cleanupTimer.unref();
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Build a context key for a messaging channel.
 */
function buildContextKey(platform, channelId, threadId) {
  if (threadId) return `${platform}:${channelId}:${threadId}`;
  return `${platform}:${channelId}`;
}

/**
 * Parse a context key back into its components.
 */
function parseContextKey(contextKey) {
  const parts = contextKey.split(':');
  return { platform: parts[0], channelId: parts[1], threadId: parts[2] || null };
}

/**
 * Get conversation history for a context key.
 * Loads from DB on cache miss. Returns messages array.
 * @param {string} contextKey
 * @param {number} [tenantId] - Required for DB fallback
 * @param {number} [writerId] - Required for DB fallback
 */
async function getHistory(contextKey, tenantId, writerId) {
  let entry = buffers.get(contextKey);

  // Cache hit and not expired
  if (entry && Date.now() - entry.updatedAt < EXPIRY_MS) {
    return entry.messages;
  }

  // Cache miss or expired — try loading from DB
  if (tenantId && writerId) {
    entry = await _loadFromDb(contextKey, tenantId, writerId);
    if (entry) {
      buffers.set(contextKey, entry);
      return entry.messages;
    }
  }

  // Nothing in DB either
  if (entry) buffers.delete(contextKey);
  return [];
}

/**
 * Synchronous version for backward compatibility — returns cached history only.
 * Use async getHistory() when possible.
 */
function getHistorySync(contextKey) {
  const entry = buffers.get(contextKey);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > EXPIRY_MS) {
    buffers.delete(contextKey);
    return [];
  }
  return entry.messages;
}

/**
 * Get the conversation summary for a context key.
 */
async function getSummary(contextKey, tenantId) {
  const entry = buffers.get(contextKey);
  if (entry?.summary) return entry.summary;

  // Try loading from DB
  if (tenantId) {
    try {
      const row = await db.prepare(
        'SELECT summary FROM conversation_summaries WHERE tenant_id = $1 AND context_key = $2'
      ).get(tenantId, contextKey);
      if (row?.summary) {
        if (entry) entry.summary = row.summary;
        return row.summary;
      }
    } catch (err) {
      console.error('[context] Failed to load summary from DB:', err.message);
    }
  }

  return null;
}

/**
 * Append a user/assistant turn to the conversation buffer.
 * Writes through to DB. Triggers summary generation at threshold.
 * @param {string} contextKey
 * @param {string} userMessage
 * @param {string} assistantMessage
 * @param {{ tenantId?: number, writerId?: number, userId?: string, contextArticleId?: number }} [meta]
 */
async function addTurn(contextKey, userMessage, assistantMessage, meta = {}) {
  ensureCleanupTimer();
  let entry = buffers.get(contextKey);
  if (!entry) {
    entry = { messages: [], updatedAt: Date.now(), turnCount: 0, summary: null, loaded: false, contextArticleId: null };
    buffers.set(contextKey, entry);
  }

  entry.messages.push(
    { role: 'user', content: userMessage },
    { role: 'assistant', content: assistantMessage },
  );

  // Trim to MAX_MESSAGES (remove oldest pairs from the front)
  while (entry.messages.length > MAX_MESSAGES) {
    entry.messages.shift();
  }

  entry.updatedAt = Date.now();
  entry.turnCount += 1;
  if (meta.contextArticleId) entry.contextArticleId = meta.contextArticleId;

  // Write-through to DB (non-blocking, never fails the response)
  if (meta.tenantId && meta.writerId) {
    const { platform, channelId, threadId } = parseContextKey(contextKey);
    _persistTurn(
      meta.tenantId, meta.writerId, platform, channelId, threadId, meta.userId,
      userMessage, assistantMessage, meta.contextArticleId || null,
    );

    // Trigger summary generation at threshold
    if (entry.turnCount > 0 && entry.turnCount % SUMMARY_THRESHOLD === 0) {
      _generateSummary(contextKey, meta.tenantId, meta.writerId, entry);
    }
  }
}

/**
 * Look up the most recent article id referenced in this conversation.
 * Checks in-memory cache first; falls back to DB. Used by the chat route to
 * resolve anaphora ("make that a pitch") when no fresh article is attached.
 */
async function getLastContextArticleId(contextKey, tenantId, writerId) {
  const cached = buffers.get(contextKey);
  if (cached?.contextArticleId) return cached.contextArticleId;
  if (!tenantId || !writerId) return null;
  try {
    const { channelId } = parseContextKey(contextKey);
    const row = await db.prepare(`
      SELECT context_article_id FROM conversation_history
      WHERE tenant_id = $1 AND writer_id = $2 AND channel_id = $3
        AND context_article_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(tenantId, writerId, channelId);
    return row?.context_article_id || null;
  } catch (err) {
    console.error('[context] getLastContextArticleId failed:', err.message);
    return null;
  }
}

/**
 * Clear conversation history for a context key — both the in-memory
 * buffer AND the DB rows, otherwise the next turn reloads prior history
 * from conversation_history / conversation_summaries.
 */
async function clearHistory(contextKey, tenantId, writerId) {
  buffers.delete(contextKey);
  if (!tenantId || !writerId) return;
  try {
    const { channelId, threadId } = parseContextKey(contextKey);
    await db.prepare(`
      DELETE FROM conversation_history
      WHERE tenant_id = $1 AND writer_id = $2 AND channel_id = $3
        AND (thread_id IS NOT DISTINCT FROM $4)
    `).run(tenantId, writerId, channelId, threadId);
    await db.prepare(
      'DELETE FROM conversation_summaries WHERE tenant_id = $1 AND context_key = $2'
    ).run(tenantId, contextKey);
  } catch (err) {
    console.error('[context] clearHistory DB delete failed:', err.message);
  }
}

/**
 * Get buffer stats for diagnostics.
 */
function getBufferStats() {
  return { activeConversations: buffers.size };
}

// ── DB Persistence (internal) ──────────────────────────────────

/**
 * Load conversation history from DB on cache miss.
 */
async function _loadFromDb(contextKey, tenantId, writerId) {
  try {
    const { channelId } = parseContextKey(contextKey);

    // Load summary first
    const summaryRow = await db.prepare(
      'SELECT summary, turn_count FROM conversation_summaries WHERE tenant_id = $1 AND context_key = $2'
    ).get(tenantId, contextKey);

    // Load last MAX_MESSAGES rows
    const rows = await db.prepare(`
      SELECT role, content FROM conversation_history
      WHERE tenant_id = $1 AND writer_id = $2 AND channel_id = $3
      ORDER BY created_at DESC LIMIT $4
    `).all(tenantId, writerId, channelId, MAX_MESSAGES);

    if (!rows.length && !summaryRow) return null;

    // Rows come in DESC order, reverse to chronological
    const messages = rows.reverse().map(r => ({ role: r.role, content: r.content }));

    return {
      messages,
      updatedAt: Date.now(),
      turnCount: summaryRow?.turn_count || Math.floor(messages.length / 2),
      summary: summaryRow?.summary || null,
      loaded: true,
    };
  } catch (err) {
    console.error('[context] Failed to load from DB:', err.message);
    return null;
  }
}

/**
 * Persist a conversation turn to DB. Fire-and-forget — never throws.
 */
function _persistTurn(tenantId, writerId, platform, channelId, threadId, userId, userMessage, assistantMessage, contextArticleId = null) {
  const insertSql = `
    INSERT INTO conversation_history (tenant_id, writer_id, platform, channel_id, thread_id, user_id, role, content, context_article_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `;
  Promise.all([
    db.prepare(insertSql).run(tenantId, writerId, platform, channelId, threadId || null, userId || null, 'user', userMessage, contextArticleId),
    db.prepare(insertSql).run(tenantId, writerId, platform, channelId, threadId || null, userId || null, 'assistant', assistantMessage, contextArticleId),
  ]).catch(err => {
    console.error('[context] DB persist failed (non-fatal):', err.message);
  });
}

/**
 * Generate a rolling conversation summary. Guarded against races.
 */
async function _generateSummary(contextKey, tenantId, writerId, entry) {
  if (summarizing.has(contextKey)) return;
  summarizing.add(contextKey);

  try {
    // Build conversation text from current messages
    const convoText = entry.messages
      .map(m => `${m.role === 'user' ? 'User' : 'Writer'}: ${m.content}`)
      .join('\n');

    const priorSummary = entry.summary ? `Previous context: ${entry.summary}\n\n` : '';

    const result = await aiComplete({
      operation: 'conversation-summary',
      tenantId,
      messages: [
        { role: 'system', content: 'Summarize this conversation between a user and an AI writer. Extract key topics, user interests, and important facts. Be concise — max 3-4 sentences.' },
        { role: 'user', content: priorSummary + convoText },
      ],
      temperature: 0.1,
      maxTokens: 200,
      trigger: 'system',
      skipBudget: false,
    });

    const summary = result?.text;
    if (!summary) return;

    // Update in-memory
    entry.summary = summary;

    // Upsert to DB
    await db.prepare(`
      INSERT INTO conversation_summaries (tenant_id, writer_id, context_key, summary, turn_count, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (tenant_id, context_key) DO UPDATE SET summary = $4, turn_count = $5, updated_at = NOW()
    `).run(tenantId, writerId, contextKey, summary, entry.turnCount);

  } catch (err) {
    console.error('[context] Summary generation failed (non-fatal):', err.message);
  } finally {
    summarizing.delete(contextKey);
  }
}

module.exports = {
  buildContextKey,
  parseContextKey,
  getHistory,
  getHistorySync,
  getSummary,
  addTurn,
  clearHistory,
  getBufferStats,
  getLastContextArticleId,
};
