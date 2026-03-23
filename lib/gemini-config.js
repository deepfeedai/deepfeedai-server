/**
 * Deep Feed AI — lib/gemini-config.js
 * Resolves Gemini API key: tenant settings → platform settings (tenant_id=1) → env var.
 * Per-tenant cache, 60s TTL.
 */
'use strict';
const db = require('../db');
const { decryptSetting, SENSITIVE_KEYS } = require('./crypto');

const _cache = new Map(); // Map<tenantId, { key, ts }>
const CACHE_TTL = 60 * 1000;

async function _lookupKey(tenantId) {
  for (const settingKey of ['gemini_api_key', 'imagen_api_key']) {
    const row = await db.prepare(
      "SELECT value FROM settings WHERE key = $1 AND tenant_id = $2"
    ).get(settingKey, tenantId);
    if (row && row.value) {
      return SENSITIVE_KEYS.has(settingKey) ? decryptSetting(row.value) : row.value;
    }
  }
  return null;
}

async function getGeminiKey(tenantId = 1) {
  const cached = _cache.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.key;

  let key = null;
  try {
    // 1. Check tenant's own settings
    key = await _lookupKey(tenantId);
    // 2. Fall back to platform settings (tenant_id=1) if different tenant
    if (!key && tenantId !== 1) {
      key = await _lookupKey(1);
    }
  } catch { /* fall back */ }

  // 3. Fall back to env var
  if (!key) key = process.env.GEMINI_API_KEY || null;

  _cache.set(tenantId, { key, ts: Date.now() });
  return key;
}

function bustGeminiKeyCache(tenantId) {
  if (tenantId) { _cache.delete(tenantId); _modelCache.delete(tenantId); }
  else { _cache.clear(); _modelCache.clear(); }
}

// ── Imagen model resolution ────────────────────────────────
const DEFAULT_IMAGEN_MODEL = 'imagen-4.0-generate-001';
const DEFAULT_IMAGEN_URL = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_IMAGEN_MODEL}:predict`;
const MODEL_RE = /^[a-zA-Z0-9._-]{3,80}$/;
const _modelCache = new Map(); // Map<tenantId, { model, ts }>

async function getImagenModel(tenantId = 1) {
  const cached = _modelCache.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.model;

  let model = null;
  try {
    // 1. Check tenant's own setting
    const row = await db.prepare(
      "SELECT value FROM settings WHERE key = 'imagen_model' AND tenant_id = $1"
    ).get(tenantId);
    if (row?.value && MODEL_RE.test(row.value)) model = row.value;

    // 2. Fall back to platform setting (tenant_id=1)
    if (!model && tenantId !== 1) {
      const platformRow = await db.prepare(
        "SELECT value FROM settings WHERE key = 'imagen_model' AND tenant_id = 1"
      ).get();
      if (platformRow?.value && MODEL_RE.test(platformRow.value)) model = platformRow.value;
    }
  } catch { /* fall back to default */ }

  if (!model) model = DEFAULT_IMAGEN_MODEL;

  _modelCache.set(tenantId, { model, ts: Date.now() });
  return model;
}

function getImagenUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;
}

module.exports = { getGeminiKey, bustGeminiKeyCache, getImagenModel, getImagenUrl, DEFAULT_IMAGEN_URL };
