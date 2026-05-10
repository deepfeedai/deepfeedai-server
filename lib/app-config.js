/**
 * Deep Feed AI — lib/app-config.js
 * Resolves app configuration from settings table → env var.
 * 60s cache. For non-secret config values (no encryption needed for most).
 */
'use strict';
const db = require('../db');
const { decryptSetting, SENSITIVE_KEYS } = require('./crypto');

const _cacheMap = new Map(); // tenantId → { config, ts }
const CACHE_TTL = 60 * 1000;

// Map of setting keys → env var fallbacks
const CONFIG_MAP = {
  gemini_api_key:          'GEMINI_API_KEY',
  imagen_api_key:          'IMAGEN_API_KEY',
  resend_api_key:          'RESEND_API_KEY',
  resend_audience_id:      'RESEND_AUDIENCE_ID',
  news_api_key:            'NEWS_API_KEY',
  brave_api_key:           'BRAVE_API_KEY',
  youtube_api_key:         'YOUTUBE_API_KEY',
  elevenlabs_api_key:      'ELEVENLABS_API_KEY',
  elevenlabs_voice_id:     'ELEVENLABS_VOICE_ID',
  base_url:                'BASE_URL',
  main_site_url:           'MAIN_SITE_URL',
  allowed_origins:         'ALLOWED_ORIGINS',
  newsroom_timezone:       'NEWSROOM_TIMEZONE',       // IANA tz string, e.g. America/New_York
  budget_autopilot_hours:  'BUDGET_AUTOPILOT_HOURS',  // hours before pending slots auto-promote
  publish_mode:            'PUBLISH_MODE',             // 'continuous' (default) | 'scheduled'
  drop_windows:            'DROP_WINDOWS',             // JSON array of "HH:MM" strings, e.g. '["07:00","12:00","18:00"]'
  daily_publish_cap:       'DAILY_PUBLISH_CAP',        // max articles published per calendar day (0 = unlimited)
  daily_publish_burst:     'DAILY_PUBLISH_BURST',      // extra slots admins can force-publish beyond the cap (0 = no burst)
  writer_daily_budget:     'WRITER_DAILY_BUDGET',      // global default: max articles a writer can produce per day (default 2)
};

async function getAppConfig(tenantId = 1) {
  const cached = _cacheMap.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.config;

  const keys = Object.keys(CONFIG_MAP);
  let dbSettings = {};
  try {
    // Build parameterized query
    const placeholders = keys.map((_, i) => `$${i + 2}`).join(', ');
    const rows = await db.prepare(
      `SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN (${placeholders})`
    ).all(tenantId, ...keys);
    for (const row of rows) {
      dbSettings[row.key] = SENSITIVE_KEYS.has(row.key) ? decryptSetting(row.value) : row.value;
    }
  } catch { /* DB not ready — fall back to env */ }

  const config = {};
  for (const [settingKey, envKey] of Object.entries(CONFIG_MAP)) {
    config[settingKey] = dbSettings[settingKey] || process.env[envKey] || null;
  }

  _cacheMap.set(tenantId, { config, ts: Date.now() });
  return config;
}

function bustAppConfigCache(tenantId) {
  if (tenantId !== undefined) _cacheMap.delete(tenantId);
  else _cacheMap.clear();
}

module.exports = { getAppConfig, bustAppConfigCache };
