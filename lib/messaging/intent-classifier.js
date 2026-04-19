/**
 * Messaging — natural-language intent classifier for action messages.
 *
 * Sits in front of the strict slash-command regex in handleIncoming so that
 * phrasings like "please approve 42" or "can you reject pitch 18?" dispatch
 * to the same editorial-action handler as "/approve 42".
 *
 * Gated behind the nl_action_intents feature flag. When off, classify()
 * short-circuits to {intent:'none'} with no LLM call so there's no cost.
 *
 * The classifier only covers approve_article and reject_article today —
 * destructive actions (kill, assign, feature) live behind Maxwell's native
 * tool-calling in the web chat, where they're button-gated with previews.
 */
'use strict';

const { complete: aiComplete } = require('../ai-router');
const { loadPrompt } = require('../prompt-loader');
const { isFeatureEnabled } = require('../feature-registry');

// Skip obvious non-action messages without spending a classifier call.
const SHORT_CHAT_RE = /^\s*(thanks?|thx|ty|nice|cool|ok|okay|lol|nice|great|sure|yep|yeah|no|nope)\b[!?.]*\s*$/i;

async function classify(tenantId, text) {
  if (!text || text.length < 4) return { intent: 'none' };
  if (SHORT_CHAT_RE.test(text)) return { intent: 'none' };
  if (text.startsWith('/')) return { intent: 'none' };

  const on = await isFeatureEnabled(tenantId, 'nl_action_intents').catch(() => false);
  if (!on) return { intent: 'none' };

  // Require at least a digit somewhere — all supported intents need an article
  // id. This avoids classifier calls on most conversational traffic.
  if (!/\d/.test(text)) return { intent: 'none' };

  const p = loadPrompt('messaging-intent');
  const { messages, ...meta } = p.render({ text });

  let result;
  try {
    result = await aiComplete({
      ...meta, messages, tenantId, trigger: 'auto',
    });
  } catch {
    return { intent: 'none' };
  }
  if (!result) return { intent: 'none' };

  const raw = (result.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { intent: 'none' }; }
  if (!parsed || typeof parsed !== 'object') return { intent: 'none' };

  const intent = parsed.intent;
  if (intent !== 'approve_article' && intent !== 'reject_article') {
    return { intent: 'none' };
  }
  const id = parseInt(parsed?.args?.id, 10);
  if (!Number.isFinite(id) || id <= 0) return { intent: 'none' };

  return { intent, args: { id } };
}

module.exports = { classify };
