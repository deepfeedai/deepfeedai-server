/**
 * Deep Feed AI — lib/stripe-config.js
 * Resolves Stripe keys: settings table (encrypted) → env var fallback.
 * Cached for 60s.
 */
'use strict';
const db = require('../db');
const { decryptSetting, SENSITIVE_KEYS } = require('./crypto');
const { getPlatformTenantId } = require('./platform-tenant');

let _cache = null;
const CACHE_TTL = 60 * 1000;

async function _load() {
  const result = { secretKey: null, webhookSecret: null };

  try {
    const platformId = await getPlatformTenantId();
    const rows = await db.prepare(
      `SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN ($2, $3)`
    ).all(platformId, 'stripe_secret_key', 'stripe_webhook_secret');

    for (const row of rows) {
      const val = SENSITIVE_KEYS.has(row.key) ? decryptSetting(row.value) : row.value;
      if (row.key === 'stripe_secret_key' && val) result.secretKey = val;
      if (row.key === 'stripe_webhook_secret' && val) result.webhookSecret = val;
    }
  } catch { /* DB not ready — fall through to env */ }

  // Env var fallback
  if (!result.secretKey) result.secretKey = process.env.STRIPE_SECRET_KEY || null;
  if (!result.webhookSecret) result.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || null;

  _cache = { result, ts: Date.now() };
  return result;
}

async function getStripeConfig() {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.result;
  return _load();
}

function bustStripeConfigCache() { _cache = null; }

module.exports = { getStripeConfig, bustStripeConfigCache };
