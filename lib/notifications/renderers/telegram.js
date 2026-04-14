/**
 * Deep Feed AI — Telegram notification renderer (PR-C)
 *
 * Converts a notification event kind + payload into:
 *   - an HTML-formatted text card
 *   - an inline_keyboard (rows of {text, callback_data}) where callback_data is
 *     `act:<token>` — our webhook recognises that prefix and dispatches via
 *     action-tokens + the handler registry.
 *
 * Telegram's `callback_data` limit is 64 bytes. Our raw tokens are 32 base64url
 * chars (24 random bytes) + the 4-char `act:` prefix = 36 bytes — well under.
 */
'use strict';

const WEB_BASE = process.env.ADMIN_PORTAL_URL || 'https://portal.deepfeedai.com';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function webLink(path, label) {
  const href = `${WEB_BASE.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;
  return `<a href="${esc(href)}">${esc(label)}</a>`;
}

function renderPitchCreated(p) {
  const lines = [];
  lines.push('<b>New pitch</b>');
  if (p.source_title) lines.push(`Angle on: <i>${esc(p.source_title)}</i>`);
  if (p.angle_summary) lines.push(esc(String(p.angle_summary).slice(0, 400)));
  if (p.pitched_by_writer_name) lines.push(`By: ${esc(p.pitched_by_writer_name)}`);
  lines.push('');
  lines.push(webLink('/editorial', 'Open in web'));
  return lines.join('\n');
}

function renderReviewNeeded(p) {
  const lines = [];
  lines.push('<b>Review needed</b>');
  if (p.title) lines.push(`<i>${esc(p.title)}</i>`);
  if (typeof p.score !== 'undefined' && p.score !== null) {
    lines.push(`Score: ${esc(p.score)}/10`);
  }
  if (Array.isArray(p.issues) && p.issues.length) {
    lines.push('Issues:');
    for (const i of p.issues.slice(0, 5)) lines.push(`• ${esc(i)}`);
  }
  if (p.suggestion) lines.push(`Suggestion: ${esc(String(p.suggestion).slice(0, 300))}`);
  lines.push('');
  lines.push(webLink('/editorial', 'Open in web'));
  return lines.join('\n');
}

/**
 * @param {string} kind
 * @param {Object} payload - { title?, body?, ...event-specific fields }
 * @returns {{ text: string, parseMode: 'HTML' }}
 */
function renderEventCard(kind, payload = {}) {
  let text;
  switch (kind) {
    case 'pitch_created':
      text = renderPitchCreated(payload);
      break;
    case 'review_needed':
      text = renderReviewNeeded(payload);
      break;
    default: {
      // Generic fallback: title + body + web link
      const parts = [];
      if (payload.title) parts.push(`<b>${esc(payload.title)}</b>`);
      if (payload.body) parts.push(esc(String(payload.body).slice(0, 800)));
      parts.push('');
      parts.push(webLink('/', 'Open in web'));
      text = parts.join('\n');
    }
  }
  return { text, parseMode: 'HTML' };
}

/**
 * Build the inline_keyboard array from the buttons[] that notifications.js
 * attaches (each element already has `token`, `label`, etc.).
 * Layout: 2 buttons per row max.
 *
 * @param {Array} actionable - [{ label, token, action_kind, ... }]
 * @returns {Array<Array<{text:string, callback_data:string}>>}
 */
function renderButtons(actionable) {
  if (!Array.isArray(actionable) || !actionable.length) return [];
  const rows = [];
  let row = [];
  for (const a of actionable) {
    if (!a || !a.token) continue;
    row.push({
      text: String(a.label || 'Action').slice(0, 32),
      callback_data: `act:${a.token}`,
    });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  return rows;
}

module.exports = { renderEventCard, renderButtons };
