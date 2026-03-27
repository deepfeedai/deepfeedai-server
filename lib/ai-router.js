/**
 * Deep Feed AI — lib/ai-router.js
 * Central dispatcher for all AI operations.
 *
 * Handles: provider/model resolution, API key resolution, budget gate,
 * call dispatch, response normalization, usage logging, BYAI credit bypass,
 * and fallback on provider failure.
 *
 * Usage:
 *   const { complete, stream } = require('./ai-router');
 *
 *   // Non-streaming (replaces direct Gemini fetch calls)
 *   const result = await complete({ operation: 'categorize', tenantId, messages, temperature: 0.1 });
 *   console.log(result.text);
 *
 *   // Streaming (replaces streamChat in chat.js, article-assist.js)
 *   for await (const chunk of stream({ operation: 'chat', tenantId, messages })) { ... }
 */
'use strict';

const db = require('../db');
const { completeChat, streamChat, getModelForOperation, getSupportedProviders } = require('./chat-provider');
const { resolveKey, resolveOllamaBaseUrl, isTenantOwnKey } = require('./ai-key-resolver');
const { logUsage } = require('./ai-usage');
const { canSpend } = require('./budget');

// ── Provider Config Resolution ───────────────────────────────────────

const _configCache = new Map(); // Map<tenantId, { config, ts }>
const CONFIG_CACHE_TTL = 60 * 1000;

/**
 * Load tenant's ai_provider_config from settings.
 * Returns { default?: { provider, model }, operations?: { [op]: { provider, model } } } or null.
 */
async function _getProviderConfig(tenantId) {
  const cached = _configCache.get(tenantId);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) return cached.config;

  let config = null;
  try {
    const row = await db.prepare(
      "SELECT value FROM settings WHERE key = 'ai_provider_config' AND tenant_id = $1"
    ).get(tenantId);
    if (row && row.value) {
      config = JSON.parse(row.value);
    }
  } catch { /* no config — use defaults */ }

  _configCache.set(tenantId, { config, ts: Date.now() });
  return config;
}

/**
 * Resolve which provider, model, and API key to use for a given operation + tenant.
 *
 * Resolution order:
 * 0. Per-request override (providerOverride/modelOverride) — highest priority
 * 1. Tenant's operation-specific override (ai_provider_config.operations[op])
 * 2. Tenant's default provider (ai_provider_config.default)
 * 3. Platform default (gemini with tier-based model)
 *
 * @param {string} operation
 * @param {number} tenantId
 * @param {{ provider?: string, model?: string }} [overrides] - Per-request overrides from the user
 * @returns {{ provider: string, model: string, apiKey: string|null, baseUrl: string|null, isByai: boolean }}
 */
async function resolveProvider(operation, tenantId, overrides) {
  const config = await _getProviderConfig(tenantId);
  const supported = getSupportedProviders();

  let provider = 'gemini';
  let model = null;

  // 0. Per-request override (user selected a specific model in the UI)
  if (overrides?.provider && supported.includes(overrides.provider)) {
    provider = overrides.provider;
    model = overrides.model || null;
  }
  // 1. Check operation-specific override
  else if (config?.operations?.[operation]) {
    const opConfig = config.operations[operation];
    if (opConfig.provider && supported.includes(opConfig.provider)) {
      provider = opConfig.provider;
      model = opConfig.model || null;
    }
  }
  // 2. Check tenant default
  else if (config?.default?.provider && supported.includes(config.default.provider)) {
    provider = config.default.provider;
    model = config.default.model || null;
  }

  // Resolve model from tier if not explicitly set
  if (!model) {
    model = getModelForOperation(provider, operation);
  }

  // Resolve API key
  const apiKey = await resolveKey(provider, tenantId);
  const baseUrl = provider === 'ollama' ? await resolveOllamaBaseUrl(tenantId) : null;

  // Determine if this is a BYAI call (tenant is using their own key/endpoint)
  const isByai = await isTenantOwnKey(provider, tenantId);

  // If we can't get a key for a cloud provider, fall back to gemini
  if (!apiKey && provider !== 'ollama') {
    const geminiKey = await resolveKey('gemini', tenantId);
    if (geminiKey && provider !== 'gemini') {
      console.warn(`[ai-router] No API key for ${provider}, falling back to gemini`);
      provider = 'gemini';
      model = getModelForOperation('gemini', operation);
      return { provider, model, apiKey: geminiKey, baseUrl: null, isByai: false };
    }
  }

  // Ollama without a base URL — fall back to gemini
  if (provider === 'ollama' && !baseUrl) {
    const geminiKey = await resolveKey('gemini', tenantId);
    if (geminiKey) {
      console.warn('[ai-router] No Ollama base URL configured, falling back to gemini');
      return { provider: 'gemini', model: getModelForOperation('gemini', operation), apiKey: geminiKey, baseUrl: null, isByai: false };
    }
  }

  return { provider, model, apiKey, baseUrl, isByai };
}

// ── Non-Streaming Completion ─────────────────────────────────────────

/**
 * Run a non-streaming AI completion.
 * Replaces all direct Gemini fetch() calls.
 *
 * @param {object} opts
 * @param {string} opts.operation - e.g. 'categorize', 'synthesis', 'summary'
 * @param {number} opts.tenantId
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=2048]
 * @param {string} [opts.trigger='manual'] - What triggered this call
 * @param {string} [opts.articleSlug] - For usage logging
 * @param {number} [opts.writerId] - For usage logging
 * @param {number} [opts.timeoutMs] - Custom timeout (overrides provider default)
 * @param {boolean} [opts.skipBudget=false] - Skip budget check (for free operations)
 * @param {string} [opts.providerOverride] - Per-request provider override (from user selection)
 * @param {string} [opts.modelOverride] - Per-request model override (from user selection)
 * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number }, provider: string, model: string }>}
 */
async function complete(opts) {
  const {
    operation, tenantId, messages,
    temperature, maxTokens,
    trigger = 'manual', articleSlug, writerId,
    skipBudget = false,
    providerOverride, modelOverride,
  } = opts;

  const resolved = await resolveProvider(operation, tenantId, providerOverride ? { provider: providerOverride, model: modelOverride } : undefined);

  // Budget gate — skip for BYAI and free operations
  if (!skipBudget && !resolved.isByai) {
    const budget = await canSpend(operation, tenantId);
    if (!budget.allowed) {
      return null; // caller handles null as budget-denied
    }
  }

  const _start = Date.now();
  let result;
  let success = true;
  let error = null;

  try {
    result = await completeChat({
      provider: resolved.provider,
      model: resolved.model,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      messages,
      temperature,
      maxTokens,
    });
  } catch (err) {
    success = false;
    error = err.message;

    // Attempt fallback to platform default (gemini) if not already gemini
    if (resolved.provider !== 'gemini') {
      try {
        const geminiKey = await resolveKey('gemini', tenantId);
        if (geminiKey) {
          const fallbackModel = getModelForOperation('gemini', operation);
          console.warn(`[ai-router] ${resolved.provider} failed, falling back to gemini: ${err.message}`);
          result = await completeChat({
            provider: 'gemini',
            model: fallbackModel,
            apiKey: geminiKey,
            messages,
            temperature,
            maxTokens,
          });
          // Log the fallback
          resolved.provider = 'gemini';
          resolved.model = fallbackModel;
          resolved.isByai = false;
          success = true;
          error = null;
        }
      } catch (fallbackErr) {
        error = `Primary: ${err.message}; Fallback: ${fallbackErr.message}`;
      }
    }

    if (!success) {
      // Log failure
      logUsage({
        provider: resolved.provider, model: resolved.model, operation,
        articleSlug, writerId, trigger,
        durationMs: Date.now() - _start,
        success: false, error,
        tenantId, isByai: resolved.isByai,
      }).catch(() => {});
      throw new Error(error);
    }
  }

  const durationMs = Date.now() - _start;

  // Log usage (fire-and-forget)
  logUsage({
    provider: resolved.provider,
    model: resolved.model,
    operation,
    articleSlug,
    writerId,
    trigger,
    inputTokens: result.usage.promptTokens,
    outputTokens: result.usage.completionTokens,
    durationMs,
    success: true,
    tenantId,
    isByai: resolved.isByai,
  }).catch(() => {});

  return {
    text: result.text,
    usage: result.usage,
    provider: resolved.provider,
    model: resolved.model,
  };
}

// ── Streaming Completion ─────────────────────────────────────────────

/**
 * Run a streaming AI completion.
 * Replaces direct streamChat + getGeminiKey calls in chat.js and article-assist.js.
 *
 * Yields the same chunk types as chat-provider.js, plus logs usage on completion.
 *
 * @param {object} opts - Same as complete() but returns AsyncGenerator
 * @yields {{ type: string, content?: string, message?: string, promptTokens?: number, completionTokens?: number }}
 */
async function* stream(opts) {
  const {
    operation, tenantId, messages,
    temperature, maxTokens,
    trigger = 'manual', articleSlug, writerId,
    skipBudget = false,
    providerOverride, modelOverride,
  } = opts;

  const resolved = await resolveProvider(operation, tenantId, providerOverride ? { provider: providerOverride, model: modelOverride } : undefined);

  // Budget gate
  if (!skipBudget && !resolved.isByai) {
    const budget = await canSpend(operation, tenantId);
    if (!budget.allowed) {
      yield { type: 'error', message: budget.reason || 'Budget exhausted' };
      return;
    }
  }

  const _start = Date.now();
  let lastUsage = null;
  let hadError = false;

  try {
    const gen = streamChat({
      provider: resolved.provider,
      model: resolved.model,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      messages,
      temperature,
      maxTokens,
    });

    for await (const chunk of gen) {
      if (chunk.type === 'usage') {
        lastUsage = chunk;
      }
      if (chunk.type === 'error') {
        hadError = true;
      }
      yield chunk;
    }
  } catch (err) {
    hadError = true;
    yield { type: 'error', message: err.message };
  }

  // Log usage on completion
  logUsage({
    provider: resolved.provider,
    model: resolved.model,
    operation,
    articleSlug,
    writerId,
    trigger,
    inputTokens: lastUsage?.promptTokens || null,
    outputTokens: lastUsage?.completionTokens || null,
    durationMs: Date.now() - _start,
    success: !hadError,
    error: hadError ? 'stream_error' : null,
    tenantId,
    isByai: resolved.isByai,
  }).catch(() => {});
}

// ── Cache Busting ────────────────────────────────────────────────────

function bustProviderConfigCache(tenantId) {
  if (tenantId) _configCache.delete(tenantId);
  else _configCache.clear();
}

module.exports = { complete, stream, resolveProvider, bustProviderConfigCache };
