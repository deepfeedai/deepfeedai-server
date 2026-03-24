/**
 * Deep Feed AI — lib/secrets.js
 * Centralized secret resolver for JWT and cron secrets.
 * Resolution: settings table (encrypted, tenant_id=1) → env var → auto-generate
 * Cache: 60s TTL. Auto-generates and persists if no source exists.
 */
'use strict';
const crypto = require('crypto');
const db = require('../db');
const { encryptSetting, decryptSetting, SENSITIVE_KEYS } = require('./crypto');
const { getPlatformTenantId } = require('./platform-tenant');

let _cache    = null; // { secrets, ts }
let _inflight = null; // Promise | null — deduplicate concurrent cache misses
const CACHE_TTL = 60 * 1000;

const SECRET_KEYS = [
  { settingKey: 'jwt_secret',          envKey: 'JWT_SECRET',      gen: () => crypto.randomBytes(48).toString('base64') },
  { settingKey: 'user_jwt_secret',     envKey: 'USER_JWT_SECRET', gen: () => crypto.randomBytes(48).toString('base64') },
  { settingKey: 'cron_secret',         envKey: 'CRON_SECRET',     gen: () => crypto.randomBytes(32).toString('hex') },
  { settingKey: 'jwt_secret_previous', envKey: null,              gen: null }, // rotation only
];

async function _loadSecrets() {
  const secrets = {};

  // Read all secret settings from DB (platform tenant)
  const platformId = await getPlatformTenantId();
  let dbSettings = {};
  try {
    const rows = await db.prepare(
      `SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN ($2, $3, $4, $5)`
    ).all(platformId, 'jwt_secret', 'user_jwt_secret', 'cron_secret', 'jwt_secret_previous');
    for (const row of rows) {
      dbSettings[row.key] = SENSITIVE_KEYS.has(row.key) ? decryptSetting(row.value) : row.value;
    }
  } catch { /* DB not ready yet — fall back to env */ }

  // Resolve each secret: DB → env var → auto-generate
  for (const sk of SECRET_KEYS) {
    let value = dbSettings[sk.settingKey] || null;

    // Fallback to env var
    if (!value && sk.envKey) {
      value = process.env[sk.envKey] || null;
    }

    // Auto-generate if still null and generator exists
    if (!value && sk.gen) {
      value = sk.gen();
      // Persist to settings table
      try {
        const stored = encryptSetting(value);
        const isEncrypted = stored !== value; // encryptSetting returns plaintext if no key configured
        if (!isEncrypted) {
          console.warn(`[secrets] WARNING: SETTINGS_ENCRYPTION_KEY not set — ${sk.settingKey} will be stored as plaintext`);
        }
        await db.prepare(
          `INSERT INTO settings (tenant_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (tenant_id, key) DO NOTHING`
        ).run(platformId, sk.settingKey, stored);
        console.log(`  ✅ Auto-generated ${sk.settingKey} (stored ${isEncrypted ? 'encrypted' : 'plaintext'} in settings)`);
      } catch { /* non-fatal — use the generated value for this session */ }
    }

    // Convert settingKey to camelCase for the return object
    const camel = sk.settingKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    secrets[camel] = value;
  }

  _cache = { secrets, ts: Date.now() };
  return secrets;
}

async function getSecrets() {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.secrets;

  // Deduplicate concurrent cache misses — all waiters share one DB round-trip
  if (!_inflight) {
    _inflight = _loadSecrets().finally(() => { _inflight = null; });
  }
  return _inflight;
}

function bustSecretsCache() { _cache = null; }

module.exports = { getSecrets, bustSecretsCache };
