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
 * Best-effort close of a truncated JSON snippet.
 * Walks the characters tracking string/brace/bracket state and appends
 * whatever closers are needed (`"`, `]`, `}`) to make the prefix valid.
 * If the snippet ends with an incomplete key or dangling comma, trims it.
 * Returns a string that is valid JSON (or throws if unrecoverable).
 */
function closeDangling(s) {
  let inString = false;
  let escape = false;
  const stack = []; // '[' or '{'
  let lastCompletedAt = -1; // index after last fully-closed top-level element (or comma for primitives)

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ']' || ch === '}') stack.pop();
    // Track "clean break points": a comma at depth 1 (inside outer array/object)
    if (ch === ',' && stack.length === 1) lastCompletedAt = i;
  }

  let closed = s;
  // Close an open string if any
  if (inString) closed += '"';
  // If there is dangling key/partial value after the last comma at top level,
  // trim back to the last comma to avoid producing a half field/element.
  if (lastCompletedAt >= 0) {
    // Only trim if the tail after the last top-level comma can't itself be a complete item.
    // Cheap heuristic: try parsing the tail; if it fails, trim back.
    const closersTail = buildClosers(stack);
    const attempt = closed.slice(0, closed.length) + closersTail;
    try {
      JSON.parse(attempt);
      return attempt;
    } catch {
      // trim back to last top-level comma and close
      closed = s.slice(0, lastCompletedAt);
      // recompute stack for truncated segment
      const stack2 = [];
      let inStr2 = false, esc2 = false;
      for (let i = 0; i < closed.length; i++) {
        const ch = closed[i];
        if (esc2) { esc2 = false; continue; }
        if (inStr2) {
          if (ch === '\\') { esc2 = true; continue; }
          if (ch === '"') inStr2 = false;
          continue;
        }
        if (ch === '"') { inStr2 = true; continue; }
        if (ch === '[' || ch === '{') stack2.push(ch);
        else if (ch === ']' || ch === '}') stack2.pop();
      }
      return closed + buildClosers(stack2);
    }
  }
  return closed + buildClosers(stack);
}

function buildClosers(stack) {
  let out = '';
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === '[' ? ']' : '}';
  }
  return out;
}

/**
 * Parse a JSON array response that may be truncated mid-string or mid-object.
 * Keeps complete top-level elements; if none complete, best-effort closes
 * the first partial element to recover what it can.
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
  if (end > 0) {
    const snippet = cleaned.slice(start, end);
    const candidate = snippet.endsWith(']') ? snippet : snippet.replace(/,\s*$/, '') + ']';
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
  }

  // No complete top-level element — try best-effort close of the first partial item
  try {
    const closed = closeDangling(cleaned.slice(start));
    const parsed = JSON.parse(closed);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* give up below */ }

  throw new Error('Could not recover any complete JSON array element');
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
