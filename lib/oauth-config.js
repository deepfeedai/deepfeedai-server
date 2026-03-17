/**
 * Deep Feed AI — lib/oauth-config.js
 * Centralized OAuth credential resolver.
 * Resolution order: settings table (encrypted) → env var → null
 * Cache: 60s TTL, busted on settings save.
 */
'use strict';
const db = require('../db');
const { decryptSetting, SENSITIVE_KEYS } = require('./crypto');

let _cache = null;  // { config, ts }
const CACHE_TTL = 60 * 1000;

async function getOAuthConfig() {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.config;

  // Read OAuth settings from tenant_id=1 (platform-level)
  const rows = await db.prepare(
    `SELECT key, value FROM settings WHERE tenant_id = 1 AND key IN ($1, $2, $3, $4)`
  ).all(
    'oauth_google_client_id',
    'oauth_google_client_secret',
    'oauth_github_client_id',
    'oauth_github_client_secret'
  );

  const settings = {};
  for (const row of rows) {
    settings[row.key] = SENSITIVE_KEYS.has(row.key) ? decryptSetting(row.value) : row.value;
  }

  const config = {
    googleClientId:     settings.oauth_google_client_id     || process.env.GOOGLE_CLIENT_ID     || null,
    googleClientSecret: settings.oauth_google_client_secret || process.env.GOOGLE_CLIENT_SECRET || null,
    githubClientId:     settings.oauth_github_client_id     || process.env.GITHUB_CLIENT_ID     || null,
    githubClientSecret: settings.oauth_github_client_secret || process.env.GITHUB_CLIENT_SECRET || null,
  };

  _cache = { config, ts: Date.now() };
  return config;
}

function bustOAuthConfigCache() { _cache = null; }

module.exports = { getOAuthConfig, bustOAuthConfigCache };
