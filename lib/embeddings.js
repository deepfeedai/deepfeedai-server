/**
 * Deep Feed AI — lib/embeddings.js
 * Back-compat shim. Embeddings now route through lib/ai-router.js.
 *
 * All new code should import { generateEmbedding } from './ai-router'.
 * This module is preserved for existing callers:
 *   - generateEmbedding(tenantId, text) → number[]
 *   - generateEmbeddings(tenantId, texts) → number[][]
 *   - isPgvectorAvailable() → boolean
 *   - bustEmbeddingConfigCache(tenantId?) — delegates to ai-router.bustProviderConfigCache
 *   - TARGET_DIMENSIONS, EMBEDDING_MODELS
 */
'use strict';

const db = require('../db');
const aiRouter = require('./ai-router');

const TARGET_DIMENSIONS = 768;

/** Default embedding models per provider — retained for back-compat imports. */
const EMBEDDING_MODELS = {
  gemini:     'text-embedding-004',
  openai:     'text-embedding-3-small',
  openrouter: 'openai/text-embedding-3-small',
};

/**
 * Generate an embedding vector for a single text string.
 * @param {number} tenantId
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function generateEmbedding(tenantId, text) {
  return aiRouter.generateEmbedding({
    operation: 'embedding',
    tenantId,
    input: text,
    dimensions: TARGET_DIMENSIONS,
  });
}

/**
 * Generate embedding vectors for multiple texts (batch).
 * @param {number} tenantId
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function generateEmbeddings(tenantId, texts) {
  if (!texts || !texts.length) return [];
  return aiRouter.generateEmbedding({
    operation: 'embedding',
    tenantId,
    input: texts,
    dimensions: TARGET_DIMENSIONS,
  });
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

/**
 * Bust the embedding provider config cache. Delegates to ai-router.
 */
function bustEmbeddingConfigCache(tenantId) {
  aiRouter.bustProviderConfigCache(tenantId);
}

module.exports = {
  generateEmbedding,
  generateEmbeddings,
  isPgvectorAvailable,
  bustEmbeddingConfigCache,
  TARGET_DIMENSIONS,
  EMBEDDING_MODELS,
};
