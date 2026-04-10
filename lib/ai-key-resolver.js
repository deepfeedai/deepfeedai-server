/**
 * Deep Feed AI — lib/ai-key-resolver.js
 * Multi-provider API key resolution: tenant setting → platform setting → env var.
 * Generalizes the pattern from gemini-config.js to all providers.
 */
'use strict';

const db = require('../db');
const { decryptSetting, SENSITIVE_KEYS } = require('./crypto');
const { getPlatformTenantId } = require('./platform-tenant');

// Provider → { settingKey (or array for fallback lookup), envVar }
const PROVIDER_KEYS = {
  gemini:     { settingKey: ['gemini_api_key', 'imagen_api_key'], envVar: 'GEMINI_API_KEY' },
  openai:     { settingKey: 'openai_api_key',     envVar: 'OPENAI_API_KEY' },
  anthropic:  { settingKey: 'anthropic_api_key',  envVar: 'ANTHROPIC_API_KEY' },
  ollama:     { settingKey: null, envVar: null }, // no key needed
  openrouter: { settingKey: 'openrouter_api_key', envVar: 'OPENROUTER_API_KEY' },
};

const _cache = new Map(); // Map<`${provider}:${tenantId}`, { key, ownKey, ts }>
const CACHE_TTL = 60 * 1000;

/**
 * Look up a setting value for a tenant, decrypting if sensitive.
 */
async function _lookupSetting(settingKey, tenantId) {
  const row = await db.prepare(
    "SELECT value FROM settings WHERE key = $1 AND tenant_id = $2"
  ).get(settingKey, tenantId);
  if (!row || !row.value) return null;
  return SENSITIVE_KEYS.has(settingKey) ? decryptSetting(row.value) : row.value;
}

/**
 * Resolve the API key for a provider and tenant.
 * Falls back: tenant setting → platform setting → env var → null.
 *
 * For Ollama, returns null (no key needed).
 * @returns {Promise<string|null>}
 */
async function resolveKey(provider, tenantId = 1) {
  const config = PROVIDER_KEYS[provider];
  if (!config) return null;
  if (!config.settingKey) return null; // ollama — no key

  const ck = `${provider}:${tenantId}`;
  const cached = _cache.get(ck);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.key;

  // settingKey can be a string or array of fallback keys
  const settingKeys = Array.isArray(config.settingKey) ? config.settingKey : [config.settingKey];

  let key = null;
  let ownKey = false;
  try {
    // 1. Tenant's own setting (try each key in order)
    for (const sk of settingKeys) {
      key = await _lookupSetting(sk, tenantId);
      if (key) { ownKey = true; break; }
    }

    // 2. Platform fallback
    const platformId = await getPlatformTenantId();
    if (!key && tenantId !== platformId) {
      for (const sk of settingKeys) {
        key = await _lookupSetting(sk, platformId);
        if (key) break;
      }
    }
  } catch { /* fall back to env var */ }

  // 3. Env var fallback
  if (!key && config.envVar) {
    key = process.env[config.envVar] || null;
  }

  _cache.set(ck, { key, ownKey, ts: Date.now() });
  return key;
}

/**
 * Resolve the Ollama base URL for a tenant.
 * Falls back: tenant setting → platform setting → env var → default.
 */
async function resolveOllamaBaseUrl(tenantId = 1) {
  const cacheKey = `ollama_url:${tenantId}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.key;

  let url = null;
  try {
    url = await _lookupSetting('ollama_base_url', tenantId);
    if (!url) {
      const platformId = await getPlatformTenantId();
      if (tenantId !== platformId) {
        url = await _lookupSetting('ollama_base_url', platformId);
      }
    }
  } catch { /* fall back */ }

  if (!url) url = process.env.OLLAMA_BASE_URL || null;

  _cache.set(cacheKey, { key: url, ts: Date.now() });
  return url;
}

/**
 * Check if a tenant has their own key configured for a provider (BYAI).
 * Uses the same cache as resolveKey() — no extra DB query.
 * Returns true if the tenant's own setting has a value, false if using platform or env.
 */
async function isTenantOwnKey(provider, tenantId) {
  const config = PROVIDER_KEYS[provider];

  // Ollama: check base URL cache
  if (provider === 'ollama') {
    const ck = `ollama_url:${tenantId}`;
    const cached = _cache.get(ck);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return !!cached.key;
    // Populate cache via resolveOllamaBaseUrl, then check
    await resolveOllamaBaseUrl(tenantId);
    const freshCached = _cache.get(ck);
    return !!(freshCached && freshCached.key);
  }

  if (!config || !config.settingKey) return false;

  // For cloud providers: resolveKey populates the cache with an ownKey flag
  const ck = `${provider}:${tenantId}`;
  const cached = _cache.get(ck);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.ownKey;

  // Populate cache
  await resolveKey(provider, tenantId);
  const freshCached = _cache.get(ck);
  return !!(freshCached && freshCached.ownKey);
}

function bustKeyCache(tenantId) {
  if (tenantId) {
    for (const [k] of _cache) {
      if (k.endsWith(`:${tenantId}`)) _cache.delete(k);
    }
  } else {
    _cache.clear();
  }
}

module.exports = { resolveKey, resolveOllamaBaseUrl, isTenantOwnKey, bustKeyCache, PROVIDER_KEYS };
