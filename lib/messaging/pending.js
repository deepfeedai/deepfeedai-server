/**
 * Messaging — generalized pending-action state machine.
 *
 * Allows any handler to set a short-lived (5 min) follow-up state on a
 * contextKey so the user's next message resolves it. Used by the intent
 * classifier and Maxwell's broadened action vocabulary to support:
 *
 *   - disambiguate:   "Pick 1-3 or cancel"           (multi-match resolution)
 *   - confirm-action: "Reply 'yes' to confirm"       (destructive confirms)
 *   - fill-slot:      "Which writer?" → user replies (missing argument)
 *
 * The existing pendingEdits map in lib/messaging.js is scoped to the article
 * edit flow and is kept untouched; new callers use this module.
 */
'use strict';

const TTL_MS = 5 * 60 * 1000;
const pending = new Map(); // contextKey → { type, payload, resolver, expiresAt }

function setPending(key, state) {
  if (!key) return;
  pending.set(key, { ...state, expiresAt: Date.now() + TTL_MS });
}

function getPending(key) {
  if (!key) return null;
  const p = pending.get(key);
  if (!p) return null;
  if (Date.now() > p.expiresAt) { pending.delete(key); return null; }
  return p;
}

function clearPending(key) { if (key) pending.delete(key); }

const CANCEL_RE  = /^\s*(cancel|nvm|nevermind|never\s*mind|no\s*thanks|stop|abort)\s*[!.?]*$/i;
const CONFIRM_RE = /^\s*(yes|y|yep|yeah|confirm|do\s*it|ok|okay|go\s*ahead|sure|please)\s*[!.?]*$/i;

/**
 * Attempt to resolve a pending state using the user's next message.
 * Returns:
 *   { handled: false }              — no pending state, caller proceeds normally
 *   { handled: true, text }         — pending state consumed; return `text` to the user
 *
 * `resolver` callbacks receive the user's choice (option object for
 * disambiguate, raw text for fill-slot, nothing for confirm-action) and must
 * return a string (the reply to show the user).
 */
async function handlePendingResponse(key, text) {
  const p = getPending(key);
  if (!p) return { handled: false };

  if (CANCEL_RE.test(text)) {
    clearPending(key);
    return { handled: true, text: 'Cancelled.' };
  }

  if (p.type === 'disambiguate') {
    const n = parseInt(text.trim(), 10);
    const options = p.payload?.options || [];
    if (Number.isFinite(n) && n >= 1 && n <= options.length) {
      clearPending(key);
      const reply = await p.resolver(options[n - 1]);
      return { handled: true, text: reply };
    }
    return { handled: true, text: `Pick a number 1–${options.length}, or reply 'cancel'.` };
  }

  if (p.type === 'confirm-action') {
    if (CONFIRM_RE.test(text)) {
      clearPending(key);
      const reply = await p.resolver();
      return { handled: true, text: reply };
    }
    return { handled: true, text: "Reply 'yes' to confirm or 'cancel' to abort." };
  }

  if (p.type === 'fill-slot') {
    clearPending(key);
    const reply = await p.resolver(text.trim());
    return { handled: true, text: reply };
  }

  // Unknown pending type — drop it rather than leaking state.
  clearPending(key);
  return { handled: false };
}

module.exports = { setPending, getPending, clearPending, handlePendingResponse };
