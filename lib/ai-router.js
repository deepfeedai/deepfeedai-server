/**
 * Deep Feed AI — lib/ai-router.js
 * Central dispatcher for all AI operations.
 *
 * Handles: provider/model resolution, API key resolution, budget gate,
 * call dispatch, response normalization, usage logging, BYOK credit bypass,
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

  // Determine if this is a BYOK call (tenant is using their own key/endpoint)
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
// Known max output tokens per model — prevents requesting more than a model can produce
const MODEL_OUTPUT_LIMITS = {
  'gemini-2.5-flash':           65536,
  'gemini-2.5-flash-lite':      65536,
  'gpt-4o':                     16384,
  'gpt-4o-mini':                16384,
  'claude-sonnet-4-20250514':   16000,
  'claude-haiku-4-5-20251001':   4096,
  'llama3':                      4096,
  'llama3:70b':                  4096,
};

async function complete(opts) {
  const {
    operation, tenantId, messages,
    temperature, maxTokens: requestedMaxTokens,
    trigger = 'manual', articleSlug, writerId,
    skipBudget = false,
    providerOverride, modelOverride,
    agentSessionId = null,
    tools,
  } = opts;

  const resolved = await resolveProvider(operation, tenantId, providerOverride ? { provider: providerOverride, model: modelOverride } : undefined);

  // Clamp maxTokens to model's known output limit
  let maxTokens = requestedMaxTokens;
  const outputLimit = MODEL_OUTPUT_LIMITS[resolved.model];
  if (outputLimit && maxTokens && maxTokens > outputLimit) {
    console.log(`[ai-router] Clamping maxTokens ${maxTokens} → ${outputLimit} for ${resolved.model}`);
    maxTokens = outputLimit;
  }

  // Budget gate — skip for BYOK and free operations
  if (!skipBudget && !resolved.isByai) {
    const budget = await canSpend(operation, tenantId);
    if (!budget.allowed) {
      return null; // caller handles null as budget-denied
    }
  }

  console.log(`[ai-router] ${operation} → ${resolved.provider}/${resolved.model} maxTokens=${maxTokens} byok=${resolved.isByai}`);

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
      tools,
    });
  } catch (err) {
    success = false;
    error = err.message;

    // Attempt fallback to platform default (gemini) if not already gemini
    if (resolved.provider !== 'gemini') {
      try {
        const geminiKey = await resolveKey('gemini', tenantId);
        if (geminiKey) {
          // Log the primary failure as its own row (visibility into which provider failed)
          logUsage({
            provider: resolved.provider, model: resolved.model, operation,
            articleSlug, writerId, trigger,
            durationMs: Date.now() - _start,
            success: false, error: err.message,
            tenantId, isByai: resolved.isByai,
            agentSessionId,
          }).catch(() => {});

          const fallbackModel = getModelForOperation('gemini', operation);
          console.warn(`[ai-router] ${resolved.provider} failed, falling back to gemini: ${err.message}`);
          result = await completeChat({
            provider: 'gemini',
            model: fallbackModel,
            apiKey: geminiKey,
            messages,
            temperature,
            maxTokens,
            tools,
          });
          // Switch resolved to track the fallback row below
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
        agentSessionId,
      }).catch(() => {});
      throw new Error(error);
    }
  }

  const durationMs = Date.now() - _start;
  console.log(`[ai-router] ${operation} complete: ${result.usage.completionTokens} tokens, ${durationMs}ms, ${result.text.length} chars`);

  // Log usage (fire-and-forget)
  logUsage({
    provider: resolved.provider,
    model: resolved.model,
    operation,
    articleSlug,
    writerId,
    trigger,
    inputTokens: result.usage.promptTokens,
    inputTokensCached: result.usage.cachedPromptTokens || 0,
    outputTokens: result.usage.completionTokens,
    durationMs,
    success: true,
    tenantId,
    isByai: resolved.isByai,
    agentSessionId,
  }).catch(() => {});

  return {
    text: result.text,
    toolCalls: result.toolCalls || null,
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
    temperature, maxTokens: requestedMaxTokens,
    trigger = 'manual', articleSlug, writerId,
    skipBudget = false,
    providerOverride, modelOverride,
    agentSessionId = null,
  } = opts;

  const resolved = await resolveProvider(operation, tenantId, providerOverride ? { provider: providerOverride, model: modelOverride } : undefined);

  // Clamp maxTokens to model's known output limit
  let maxTokens = requestedMaxTokens;
  const outputLimit = MODEL_OUTPUT_LIMITS[resolved.model];
  if (outputLimit && maxTokens && maxTokens > outputLimit) {
    maxTokens = outputLimit;
  }

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
    inputTokensCached: lastUsage?.cachedPromptTokens || 0,
    outputTokens: lastUsage?.completionTokens || null,
    agentSessionId,
    durationMs: Date.now() - _start,
    success: !hadError,
    error: hadError ? 'stream_error' : null,
    tenantId,
    isByai: resolved.isByai,
  }).catch(() => {});
}

// ── Image generation ────────────────────────────────────────────────
//
// Unified entry point for image providers. Resolves provider + model from
// settings.image_provider_config (falls back to imagen + settings.imagen_model
// for backward compat), then dispatches to the right adapter. Logs usage.

const imagenProvider = require('./providers/imagen');
const dalleProvider  = require('./providers/dalle');

const IMAGE_PROVIDERS = {
  imagen: { generate: imagenProvider.generate, keyProvider: 'gemini', defaultModel: 'imagen-4.0-generate-001' },
  dalle:  { generate: dalleProvider.generate,  keyProvider: 'openai', defaultModel: 'dall-e-3' },
};

// Known image operations — used as the lookup key against
// settings.image_provider_config.operations. Unrecognised operations fall
// through to `default` provider (currently imagen). `standalone-design` is
// the designer agent's ad-hoc generator (Iris.generateStandaloneImage); it
// shares thumbnail-render's default provider unless overridden per-tenant.
const IMAGE_OPERATION_TIERS = {
  'thumbnail-render':  'default',
  'inline-image':      'default',
  'standalone-design': 'default',
};

const _imageConfigCache = new Map();

async function _getImageConfig(tenantId) {
  const cached = _imageConfigCache.get(tenantId);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) return cached.config;
  let config = null;
  try {
    const row = await db.prepare(
      "SELECT value FROM settings WHERE key = 'image_provider_config' AND tenant_id = $1"
    ).get(tenantId);
    if (row?.value) config = JSON.parse(row.value);
  } catch { /* use defaults */ }
  _imageConfigCache.set(tenantId, { config, ts: Date.now() });
  return config;
}

async function _resolveImageProvider(operation, tenantId) {
  const config = await _getImageConfig(tenantId);
  let provider = 'imagen';
  let model = null;

  // 1. Operation-specific override
  if (config?.operations?.[operation]?.provider && IMAGE_PROVIDERS[config.operations[operation].provider]) {
    provider = config.operations[operation].provider;
    model = config.operations[operation].model || null;
  }
  // 2. Default override
  else if (config?.default?.provider && IMAGE_PROVIDERS[config.default.provider]) {
    provider = config.default.provider;
    model = config.default.model || null;
  }

  // Backward compat: legacy `imagen_model` setting when provider is imagen and no model chosen
  if (provider === 'imagen' && !model) {
    try {
      const row = await db.prepare(
        "SELECT value FROM settings WHERE key = 'imagen_model' AND tenant_id = $1"
      ).get(tenantId);
      if (row?.value && /^[a-zA-Z0-9._-]{3,80}$/.test(row.value)) model = row.value;
    } catch { /* fallback below */ }
  }
  if (!model) model = IMAGE_PROVIDERS[provider].defaultModel;

  return { provider, model };
}

/**
 * Generate one image.
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.prompt
 * @param {string} [opts.operation='thumbnail-render'] — for logging + per-op override
 * @param {string} [opts.aspectRatio='16:9']
 * @param {string} [opts.articleSlug] — for usage logging
 * @param {string} [opts.trigger='auto']
 * @returns {Promise<{ b64, provider, model, durationMs }>}
 */
async function generateImage({ tenantId, prompt, operation = 'thumbnail-render', aspectRatio = '16:9', articleSlug, trigger = 'auto' }) {
  const { provider, model } = await _resolveImageProvider(operation, tenantId);
  const adapter = IMAGE_PROVIDERS[provider];
  const apiKey = await resolveKey(adapter.keyProvider, tenantId);
  if (!apiKey) {
    const err = new Error(`No API key configured for image provider '${provider}' (needs ${adapter.keyProvider} key)`);
    err.code = 'MISSING_KEY';
    throw err;
  }

  const start = Date.now();
  try {
    const result = await adapter.generate({ apiKey, model, prompt, aspectRatio });
    const durationMs = Date.now() - start;
    logUsage({
      provider, model, operation, articleSlug, trigger, tenantId,
      imageCount: 1, durationMs,
    }).catch(() => {});
    return { b64: result.b64, provider, model, durationMs, revisedPrompt: result.revisedPrompt || null };
  } catch (err) {
    const durationMs = Date.now() - start;
    logUsage({
      provider, model, operation, articleSlug, trigger, tenantId,
      imageCount: 0, durationMs, success: false, error: err.message?.slice(0, 500),
    }).catch(() => {});
    throw err;
  }
}

// ── Voice generation (TTS) ──────────────────────────────────────────
//
// Unified entry point for voice providers. Today only ElevenLabs is wired
// up, but everything routes through this so per-tenant operation overrides
// and usage logging work the same as text/image.

const elevenlabsProvider = require('./providers/elevenlabs');
const { getAppConfig } = require('./app-config');

const VOICE_PROVIDERS = {
  elevenlabs: {
    generate: elevenlabsProvider.generate,
    getSubscription: elevenlabsProvider.getSubscription,
    // Voice API keys don't live in PROVIDER_KEYS — resolved via getAppConfig().
    resolveKey: async (tenantId) => {
      const cfg = await getAppConfig(tenantId);
      return cfg.elevenlabs_api_key || null;
    },
    defaultModel: elevenlabsProvider.DEFAULT_MODEL,
  },
};

const VOICE_MODEL_TIERS = {
  fast:     { elevenlabs: 'eleven_turbo_v2' },
  balanced: { elevenlabs: 'eleven_turbo_v2' },
  powerful: { elevenlabs: 'eleven_multilingual_v2' },
};

const VOICE_OPERATION_TIERS = {
  audio:        'fast',
  'voice-chat': 'fast',
};

const _voiceConfigCache = new Map();

async function _getVoiceConfig(tenantId) {
  const cached = _voiceConfigCache.get(tenantId);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) return cached.config;
  let config = null;
  try {
    const row = await db.prepare(
      "SELECT value FROM settings WHERE key = 'voice_provider_config' AND tenant_id = $1"
    ).get(tenantId);
    if (row?.value) config = JSON.parse(row.value);
  } catch { /* use defaults */ }
  // Also read operations.audio / operations.voice-chat off ai_provider_config
  // so the existing per-op override table (chat providers) can also drive voice
  // if a tenant set it there.
  const chatCfg = await _getProviderConfig(tenantId);
  if (chatCfg?.operations) {
    if (!config) config = {};
    if (!config.operations) config.operations = {};
    for (const op of Object.keys(VOICE_OPERATION_TIERS)) {
      if (chatCfg.operations[op]?.provider && VOICE_PROVIDERS[chatCfg.operations[op].provider]) {
        if (!config.operations[op]) config.operations[op] = { ...chatCfg.operations[op] };
      }
    }
  }
  _voiceConfigCache.set(tenantId, { config, ts: Date.now() });
  return config;
}

async function _resolveVoiceProvider(operation, tenantId) {
  const config = await _getVoiceConfig(tenantId);
  let provider = 'elevenlabs';
  let model = null;

  if (config?.operations?.[operation]?.provider && VOICE_PROVIDERS[config.operations[operation].provider]) {
    provider = config.operations[operation].provider;
    model = config.operations[operation].model || null;
  } else if (config?.default?.provider && VOICE_PROVIDERS[config.default.provider]) {
    provider = config.default.provider;
    model = config.default.model || null;
  }

  if (!model) {
    const tier = VOICE_OPERATION_TIERS[operation] || 'fast';
    model = VOICE_MODEL_TIERS[tier]?.[provider] || VOICE_PROVIDERS[provider].defaultModel;
  }
  return { provider, model };
}

/**
 * Generate TTS audio. Returns { audio: Buffer, mime, provider, model, durationMs, charCount }.
 * Falls back to alternate voice providers if the primary fails.
 *
 * @param {object} opts
 * @param {string} opts.operation          'audio' | 'voice-chat' (used for logging + override)
 * @param {number} opts.tenantId
 * @param {string} opts.text
 * @param {string} opts.voiceId            Voice identifier (provider-specific)
 * @param {object} [opts.params]           Passed through to provider.generate
 * @param {string} [opts.articleSlug]      For logging
 * @param {number} [opts.writerId]         For logging
 * @param {string} [opts.trigger='auto']
 * @param {'buffer'|'base64'} [opts.returnFormat='buffer']
 * @param {boolean} [opts.skipBudget=false]
 */
async function generateVoice({ operation, tenantId, text, voiceId, params, articleSlug, writerId, trigger = 'auto', returnFormat = 'buffer', skipBudget = false }) {
  const { provider, model } = await _resolveVoiceProvider(operation, tenantId);
  const adapter = VOICE_PROVIDERS[provider];
  const apiKey = await adapter.resolveKey(tenantId);
  if (!apiKey) {
    const err = new Error(`No API key configured for voice provider '${provider}'`);
    err.code = 'MISSING_KEY';
    throw err;
  }

  // Budget gate (non-BYOK semantics — elevenlabs key is stored in tenant settings, so we
  // treat "key present" as tenant-own for the purposes of budget. Simpler: skip budget
  // check here unless explicitly requested; callers that want a check use canSpend
  // before calling — preserves existing behavior.)
  if (!skipBudget) {
    const budget = await canSpend(operation, tenantId);
    if (!budget.allowed) return null;
  }

  const start = Date.now();
  try {
    const result = await adapter.generate({ apiKey, voiceId, text, params: { ...params, model }, returnFormat });
    const durationMs = Date.now() - start;
    logUsage({
      provider, model: result.model || model, operation,
      articleSlug, writerId, trigger, tenantId,
      characters: result.characters ?? text.length,
      durationMs,
      success: true,
    }).catch(() => {});
    return {
      audio: result.audio,
      mime: result.mime,
      provider,
      model: result.model || model,
      charCount: result.characters ?? text.length,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    logUsage({
      provider, model, operation,
      articleSlug, writerId, trigger, tenantId,
      characters: text.length,
      durationMs,
      success: false, error: err.message?.slice(0, 500),
    }).catch(() => {});

    // Fallback chain — try any other configured voice provider
    const others = Object.keys(VOICE_PROVIDERS).filter(p => p !== provider);
    for (const fp of others) {
      try {
        const fAdapter = VOICE_PROVIDERS[fp];
        const fKey = await fAdapter.resolveKey(tenantId);
        if (!fKey) continue;
        const tier = VOICE_OPERATION_TIERS[operation] || 'fast';
        const fModel = VOICE_MODEL_TIERS[tier]?.[fp] || fAdapter.defaultModel;
        console.warn(`[ai-router] voice ${provider} failed, falling back to ${fp}: ${err.message}`);
        const fStart = Date.now();
        const fResult = await fAdapter.generate({ apiKey: fKey, voiceId, text, params: { ...params, model: fModel }, returnFormat });
        logUsage({
          provider: fp, model: fResult.model || fModel, operation,
          articleSlug, writerId, trigger, tenantId,
          characters: fResult.characters ?? text.length,
          durationMs: Date.now() - fStart,
          success: true,
        }).catch(() => {});
        return {
          audio: fResult.audio, mime: fResult.mime,
          provider: fp, model: fResult.model || fModel,
          charCount: fResult.characters ?? text.length,
          durationMs: Date.now() - fStart,
        };
      } catch { /* try next */ }
    }
    throw err;
  }
}

// ── Embedding generation ────────────────────────────────────────────
//
// Unified entry point for embedding providers. Resolves provider + model
// from ai_provider_config.operations.embedding (or default), with a
// fallback chain: configured → openrouter → gemini → openai.
// Standardizes on 768 dimensions (Gemini native).

const geminiProvider = require('./providers/gemini');
const openaiProvider = require('./providers/openai');
const openrouterProvider = require('./providers/openrouter');

const DEFAULT_EMBED_DIMENSIONS = 768;

const EMBED_PROVIDERS = {
  gemini:     { embed: geminiProvider.embed,     defaultModel: 'text-embedding-004' },
  openai:     { embed: openaiProvider.embed,     defaultModel: 'text-embedding-3-small' },
  openrouter: { embed: openrouterProvider.embed, defaultModel: 'openai/text-embedding-3-small' },
};

const _embedConfigCache = new Map();

async function _resolveEmbeddingProvider(tenantId) {
  const cached = _embedConfigCache.get(tenantId);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) return cached.value;

  const config = await _getProviderConfig(tenantId);
  let provider = null;
  let model = null;

  const opConfig = config?.operations?.embedding;
  if (opConfig?.provider && EMBED_PROVIDERS[opConfig.provider]) {
    provider = opConfig.provider;
    model = opConfig.model || null;
  }
  if (!provider && config?.default?.provider && EMBED_PROVIDERS[config.default.provider]) {
    provider = config.default.provider;
    model = config.default.model || null;
  }

  // Fallback chain: configured → openrouter → gemini → openai
  const chain = provider ? [provider, 'openrouter', 'gemini', 'openai'] : ['openrouter', 'gemini', 'openai'];
  let apiKey = null;
  let chosen = null;
  for (const p of chain) {
    const key = await resolveKey(p, tenantId);
    if (key) {
      chosen = p;
      apiKey = key;
      break;
    }
  }

  if (!chosen || !apiKey) {
    throw new Error('No embedding provider available — configure an API key for OpenRouter, Gemini, or OpenAI');
  }

  // If we fell back off the configured provider, reset model to default for chosen.
  if (chosen !== provider) model = null;
  if (!model) model = EMBED_PROVIDERS[chosen].defaultModel;

  const result = { provider: chosen, apiKey, model };
  _embedConfigCache.set(tenantId, { value: result, ts: Date.now() });
  return result;
}

/**
 * Generate embedding vectors for one or more texts.
 * @param {object} opts
 * @param {string} [opts.operation='embedding']
 * @param {number} opts.tenantId
 * @param {string|string[]} opts.input
 * @param {number} [opts.dimensions=768]
 * @returns {Promise<number[]|number[][]>} — single vector when input is a string, array when an array
 */
async function generateEmbedding({ operation = 'embedding', tenantId, input, dimensions = DEFAULT_EMBED_DIMENSIONS }) {
  const isSingle = typeof input === 'string';
  const inputs = isSingle ? [input] : input;
  if (!inputs || !inputs.length) return isSingle ? null : [];

  const { provider, apiKey, model } = await _resolveEmbeddingProvider(tenantId);
  const adapter = EMBED_PROVIDERS[provider];

  const start = Date.now();
  const vectors = await adapter.embed({ apiKey, model, input: inputs, dimensions });
  const durationMs = Date.now() - start;

  logUsage({
    provider,
    model,
    operation,
    tenantId,
    trigger: 'system',
    durationMs,
    inputTokens: inputs.reduce((sum, t) => sum + Math.ceil((t || '').length / 4), 0),
    outputTokens: 0,
  }).catch(() => {});

  return isSingle ? vectors[0] : vectors;
}

// ── Cache Busting ────────────────────────────────────────────────────

function bustProviderConfigCache(tenantId) {
  if (tenantId) {
    _configCache.delete(tenantId);
    _imageConfigCache.delete(tenantId);
    _voiceConfigCache.delete(tenantId);
    _embedConfigCache.delete(tenantId);
  } else {
    _configCache.clear();
    _imageConfigCache.clear();
    _voiceConfigCache.clear();
    _embedConfigCache.clear();
  }
}

module.exports = {
  complete, stream, generateImage, generateVoice, generateEmbedding,
  resolveProvider, bustProviderConfigCache,
  IMAGE_PROVIDERS, IMAGE_OPERATION_TIERS, VOICE_PROVIDERS, VOICE_MODEL_TIERS, VOICE_OPERATION_TIERS, EMBED_PROVIDERS,
};
