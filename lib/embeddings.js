/**
 * Deep Feed AI — lib/embeddings.js
 * Unified embedding generation for semantic search (RAG).
 *
 * Routes through tenant's configured AI provider:
 *   - OpenRouter: POST /api/v1/embeddings
 *   - Gemini: POST /v1beta/models/{model}:embedContent
 *   - OpenAI: POST /api/v1/embeddings
 *
 * Standardizes on 768 dimensions (Gemini native). OpenAI/OpenRouter
 * use the `dimensions` param to truncate at the model level.
 *
 * Usage:
 *   const { generateEmbedding, generateEmbeddings } = require('./embeddings');
 *   const vector = await generateEmbedding(tenantId, 'search text');
 *   const vectors = await generateEmbeddings(tenantId, ['text1', 'text2']);
 */
'use strict';

const db = require('../db');
const { resolveKey } = require('./ai-key-resolver');
const { logUsage } = require('./ai-usage');

const TARGET_DIMENSIONS = 768;

/** Default embedding models per provider */
const EMBEDDING_MODELS = {
  gemini:     'text-embedding-004',
  openai:     'text-embedding-3-small',
  openrouter: 'openai/text-embedding-3-small',
};

// ── Provider-specific embedding implementations ─────────────────

async function _geminiEmbed(apiKey, texts) {
  // Gemini embedding API: batch via batchEmbedContents
  const model = EMBEDDING_MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;

  const requests = texts.map(text => ({
    model: `models/${model}`,
    content: { parts: [{ text }] },
    outputDimensionality: TARGET_DIMENSIONS,
  }));

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini embedding API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.embeddings.map(e => e.values);
}

async function _openaiEmbed(apiKey, texts, baseUrl = 'https://api.openai.com') {
  const model = EMBEDDING_MODELS.openai;
  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: texts,
      dimensions: TARGET_DIMENSIONS,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI embedding API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

async function _openrouterEmbed(apiKey, texts) {
  const model = EMBEDDING_MODELS.openrouter;
  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://deepfeedai.com',
      'X-Title': 'Deep Feed AI',
    },
    body: JSON.stringify({
      model,
      input: texts,
      dimensions: TARGET_DIMENSIONS,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenRouter embedding API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

const EMBED_FUNCTIONS = {
  gemini: _geminiEmbed,
  openai: _openaiEmbed,
  openrouter: _openrouterEmbed,
};

// ── Provider Resolution ─────────────────────────────────────────

const _configCache = new Map();
const CONFIG_CACHE_TTL = 60 * 1000;

/**
 * Resolve the best embedding provider for a tenant.
 * Priority: tenant operation override > tenant default > fallback chain (openrouter > gemini)
 */
async function _resolveEmbeddingProvider(tenantId) {
  // Check tenant's AI provider config for embedding-specific override
  const cacheKey = `embed:${tenantId}`;
  const cached = _configCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) return cached.value;

  let provider = null;
  let apiKey = null;

  try {
    const row = await db.prepare(
      "SELECT value FROM settings WHERE key = 'ai_provider_config' AND tenant_id = $1"
    ).get(tenantId);
    if (row?.value) {
      const config = JSON.parse(row.value);
      // Check for embedding-specific override
      const opConfig = config.operations?.embedding;
      if (opConfig?.provider && EMBED_FUNCTIONS[opConfig.provider]) {
        provider = opConfig.provider;
      }
      // Fall back to tenant default
      if (!provider && config.default?.provider && EMBED_FUNCTIONS[config.default.provider]) {
        provider = config.default.provider;
      }
    }
  } catch {}

  // Resolve API key for chosen provider, with fallback chain
  const providers = provider ? [provider, 'openrouter', 'gemini', 'openai'] : ['openrouter', 'gemini', 'openai'];
  for (const p of providers) {
    const key = await resolveKey(p, tenantId);
    if (key) {
      provider = p;
      apiKey = key;
      break;
    }
  }

  if (!provider || !apiKey) {
    throw new Error('No embedding provider available — configure an API key for OpenRouter, Gemini, or OpenAI');
  }

  const result = { provider, apiKey };
  _configCache.set(cacheKey, { value: result, ts: Date.now() });
  return result;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Generate an embedding vector for a single text string.
 * @param {number} tenantId
 * @param {string} text
 * @returns {Promise<number[]>} - Array of TARGET_DIMENSIONS floats
 */
async function generateEmbedding(tenantId, text) {
  const vectors = await generateEmbeddings(tenantId, [text]);
  return vectors[0];
}

/**
 * Generate embedding vectors for multiple texts (batch).
 * @param {number} tenantId
 * @param {string[]} texts
 * @returns {Promise<number[][]>} - Array of vectors
 */
async function generateEmbeddings(tenantId, texts) {
  if (!texts.length) return [];

  const { provider, apiKey } = await _resolveEmbeddingProvider(tenantId);
  const embedFn = EMBED_FUNCTIONS[provider];

  const start = Date.now();
  const vectors = await embedFn(apiKey, texts);
  const durationMs = Date.now() - start;

  // Log usage (non-blocking)
  logUsage({
    provider,
    model: EMBEDDING_MODELS[provider],
    operation: 'embedding',
    tenantId,
    trigger: 'system',
    durationMs,
    promptTokens: texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
    completionTokens: 0,
  }).catch(() => {});

  return vectors;
}

/**
 * Check if pgvector is available in the database.
 * @returns {Promise<boolean>}
 */
async function isPgvectorAvailable() {
  try {
    const result = await db.prepare(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
    ).get();
    return !!result;
  } catch {
    return false;
  }
}

function bustEmbeddingConfigCache(tenantId) {
  if (tenantId) _configCache.delete(`embed:${tenantId}`);
  else _configCache.clear();
}

module.exports = {
  generateEmbedding,
  generateEmbeddings,
  isPgvectorAvailable,
  bustEmbeddingConfigCache,
  TARGET_DIMENSIONS,
  EMBEDDING_MODELS,
};
