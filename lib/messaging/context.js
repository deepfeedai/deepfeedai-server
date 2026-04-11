/**
 * Conversation Context Buffer — platform-agnostic, in-memory multi-turn history.
 * Each messaging channel maintains a rolling window of recent messages so that
 * writer AI responses can reference prior conversation turns.
 *
 * Context is keyed by platform + channel (+ thread for Telegram topics).
 * Each channel maps to exactly one writer, so channel-scoped = writer-scoped.
 */

const MAX_MESSAGES = 20;          // 10 user + 10 assistant turns
const EXPIRY_MS = 60 * 60 * 1000; // 1 hour of inactivity
const CLEANUP_INTERVAL = 10 * 60 * 1000; // run cleanup every 10 minutes

/** @type {Map<string, { messages: Array<{role: string, content: string}>, updatedAt: number }>} */
const buffers = new Map();

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
  cleanupTimer.unref(); // don't prevent process exit
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Build a context key for a messaging channel.
 * @param {string} platform - 'telegram', 'slack', or 'discord'
 * @param {string} channelId - Platform-specific channel/chat ID
 * @param {string|null} threadId - Optional thread/topic ID (Telegram topics, Slack threads)
 * @returns {string}
 */
function buildContextKey(platform, channelId, threadId) {
  if (threadId) return `${platform}:${channelId}:${threadId}`;
  return `${platform}:${channelId}`;
}

/**
 * Get conversation history for a context key.
 * Returns empty array if expired or not found.
 * @param {string} contextKey
 * @returns {Array<{role: string, content: string}>}
 */
function getHistory(contextKey) {
  const entry = buffers.get(contextKey);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > EXPIRY_MS) {
    buffers.delete(contextKey);
    return [];
  }
  return entry.messages;
}

/**
 * Append a user/assistant turn to the conversation buffer.
 * Trims oldest messages when exceeding MAX_MESSAGES.
 * @param {string} contextKey
 * @param {string} userMessage
 * @param {string} assistantMessage
 */
function addTurn(contextKey, userMessage, assistantMessage) {
  ensureCleanupTimer();
  let entry = buffers.get(contextKey);
  if (!entry) {
    entry = { messages: [], updatedAt: Date.now() };
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
}

/**
 * Clear conversation history for a context key.
 * @param {string} contextKey
 * @returns {boolean} true if there was history to clear
 */
function clearHistory(contextKey) {
  return buffers.delete(contextKey);
}

/**
 * Get buffer stats for diagnostics.
 */
function getBufferStats() {
  return { activeConversations: buffers.size };
}

module.exports = {
  buildContextKey,
  getHistory,
  addTurn,
  clearHistory,
  getBufferStats,
};
