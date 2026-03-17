/**
 * Deep Feed AI — lib/gemini-config.js
 * Resolves Gemini API key from settings table → env var.
 * 60s cache.
 */
'use strict';
const db = require('../db');
const { decryptSetting, SENSITIVE_KEYS } = require('./crypto');

let _cache = null; // { key, ts }
const CACHE_TTL = 60 * 1000;

async function getGeminiKey(tenantId = 1) {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.key;

  let key = null;
  try {
    // Check gemini_api_key first, then imagen_api_key (same key, different setting name)
    for (const settingKey of ['gemini_api_key', 'imagen_api_key']) {
      const row = await db.prepare(
        "SELECT value FROM settings WHERE key = $1 AND tenant_id = $2"
      ).get(settingKey, tenantId);
      if (row && row.value) {
        key = SENSITIVE_KEYS.has(settingKey) ? decryptSetting(row.value) : row.value;
        break;
      }
    }
  } catch { /* fall back */ }

  if (!key) key = process.env.GEMINI_API_KEY || null;

  _cache = { key, ts: Date.now() };
  return key;
}

function bustGeminiKeyCache() { _cache = null; }

module.exports = { getGeminiKey, bustGeminiKeyCache };
