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
 * Walk the string tracking string/brace/bracket state.
 * Returns the index (exclusive) up to which the string is a valid prefix
 * of a JSON array, ending right after the last complete top-level element.
 * Returns -1 if no complete element was found.
 */
function findLastCompleteTopLevelItem(s) {
  // Find opening [
  let start = s.indexOf('[');
  if (start < 0) return -1;

  let depth = 0;          // bracket depth inside the outer array (0 = at top level of array)
  let inString = false;
  let escape = false;
  let lastCompleteEnd = -1; // index AFTER the last complete top-level element

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }

    if (i === start) { depth = 1; continue; } // consume opening [

    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 1) {
        // Just closed a top-level element
        lastCompleteEnd = i + 1;
      } else if (depth === 0) {
        // Closed the outer array — full valid array
        return i + 1;
      }
    } else if (ch === ',' && depth === 1) {
      // Comma at top level marks end of a complete primitive element (e.g. string, number)
      lastCompleteEnd = i;
    }
  }

  return lastCompleteEnd;
}

/**
 * Parse a JSON array response that may be truncated mid-string or mid-object.
 * Keeps only the complete top-level elements; silently drops any incomplete trailing entry.
 * @param {string} raw
 * @returns {any[]}
 */
function parseTruncatedJsonArray(raw) {
  const cleaned = stripFences(raw);

  // Try direct parse first (happy path)
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    throw new Error('Expected JSON array');
  } catch {
    // fall through to recovery
  }

  const start = cleaned.indexOf('[');
  if (start < 0) throw new Error('No JSON array found');

  const end = findLastCompleteTopLevelItem(cleaned);
  if (end < 0) {
    // No complete element — return empty array
    return [];
  }

  // If the returned end already points past the closing ], parse as-is
  const snippet = cleaned.slice(start, end);
  const candidate = snippet.endsWith(']') ? snippet : snippet.replace(/,\s*$/, '') + ']';
  const parsed = JSON.parse(candidate);
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
  return parsed;
}

/**
 * Parse a JSON object response that may be truncated mid-field.
 * Keeps only the complete top-level key-value pairs; drops any incomplete trailing pair.
 * @param {string} raw
 * @returns {object}
 */
function parseTruncatedJsonObject(raw) {
  const cleaned = stripFences(raw);

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new Error('Expected JSON object');
  } catch {
    // fall through
  }

  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('No JSON object found');

  // Walk chars, track depth, find last complete top-level key:value
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastCommaAtTop = -1;
  let closedAt = -1;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (i === start) { depth = 1; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { closedAt = i + 1; break; }
      if (depth === 1) lastCommaAtTop = i + 1; // treat just-closed nested value as completable
    } else if (ch === ',' && depth === 1) {
      lastCommaAtTop = i; // comma ending a complete top-level pair
    }
  }

  let snippet;
  if (closedAt > 0) {
    snippet = cleaned.slice(start, closedAt);
  } else if (lastCommaAtTop > 0) {
    snippet = cleaned.slice(start, lastCommaAtTop) + '}';
  } else {
    // Nothing complete — return empty object
    return {};
  }

  const parsed = JSON.parse(snippet);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed;
}

module.exports = { parseTruncatedJsonArray, parseTruncatedJsonObject, stripFences };
