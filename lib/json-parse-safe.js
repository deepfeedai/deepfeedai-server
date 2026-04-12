/**
 * Deep Feed AI — lib/json-parse-safe.js
 * Truncation-safe JSON parsers for AI responses.
 *
 * AI responses sometimes cut off mid-output (token limit, model stop).
 * These helpers strip incomplete trailing entries before parsing so
 * valid prefix data is recovered instead of failing the whole request.
 */
'use strict';

function stripFences(raw) {
  return raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
}

/**
 * Parse a JSON array response that may be truncated mid-string or mid-entry.
 * @param {string} raw - raw AI response
 * @returns {any[]} parsed array
 * @throws if the recoverable prefix still isn't valid JSON
 */
function parseTruncatedJsonArray(raw) {
  let cleaned = stripFences(raw);
  if (!cleaned.endsWith(']')) {
    // Remove incomplete trailing string entry (e.g. `, "bot` or `, "bot"` without comma/bracket)
    cleaned = cleaned.replace(/,\s*"[^"]*"?\s*$/, '');
    // Remove trailing comma/whitespace
    cleaned = cleaned.replace(/,\s*$/, '');
    if (!cleaned.endsWith(']')) cleaned += ']';
  }
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
  return parsed;
}

/**
 * Parse a JSON object response that may be truncated mid-field.
 * Attempts to close dangling strings and missing braces so any complete
 * fields at the start are recovered.
 * @param {string} raw
 * @returns {object}
 */
function parseTruncatedJsonObject(raw) {
  let cleaned = stripFences(raw);
  if (!cleaned.endsWith('}')) {
    // Remove trailing incomplete key-value pair (e.g. `,"foo":"bar`)
    cleaned = cleaned.replace(/,\s*"[^"]*"\s*:\s*("[^"]*|[0-9.]*|\[[^\]]*|\{[^}]*)?$/, '');
    cleaned = cleaned.replace(/,\s*$/, '');
    if (!cleaned.endsWith('}')) cleaned += '}';
  }
  const parsed = JSON.parse(cleaned);
  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    throw new Error('Expected JSON object');
  }
  return parsed;
}

module.exports = { parseTruncatedJsonArray, parseTruncatedJsonObject, stripFences };
