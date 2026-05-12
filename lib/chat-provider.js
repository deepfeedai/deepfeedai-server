/**
 * Deep Feed AI — lib/chat-provider.js
 * Provider abstraction layer for AI chat completions.
 * Supports Gemini, OpenAI, Anthropic, and Ollama.
 *
 * Each provider implements:
 *   stream({ apiKey, model, messages, temperature, maxTokens }) → AsyncGenerator<Chunk>
 *   complete({ apiKey, model, messages, temperature, maxTokens }) → { text, usage }
 *
 * Chunk types:
 *   { type: 'text',  content: string }
 *   { type: 'usage', promptTokens: number, completionTokens: number }
 *   { type: 'done' }
 *   { type: 'error', message: string }
 */
'use strict';

const openaiProvider      = require('./providers/openai');
const anthropicProvider   = require('./providers/anthropic');
const ollamaProvider      = require('./providers/ollama');
const openrouterProvider  = require('./providers/openrouter');
const geminiProvider      = require('./providers/gemini');

// ── Provider Registry ────────────────────────────────────────────────

const PROVIDERS = {
  gemini:     { stream: geminiProvider.stream,      complete: geminiProvider.complete },
  openai:     { stream: openaiProvider.stream,      complete: openaiProvider.complete },
  anthropic:  { stream: anthropicProvider.stream,   complete: anthropicProvider.complete },
  ollama:     { stream: ollamaProvider.stream,      complete: ollamaProvider.complete },
  openrouter: { stream: openrouterProvider.stream,  complete: openrouterProvider.complete },
};

const DEFAULT_MODELS = {
  gemini:     'gemini-2.5-flash',
  openai:     'gpt-4o-mini',
  anthropic:  'claude-sonnet-4-20250514',
  ollama:     'llama3',
  openrouter: 'openrouter/auto',
};

/**
 * Model capability tiers — maps abstract tiers to concrete models per provider.
 */
const MODEL_TIERS = {
  fast: {
    gemini:     'gemini-2.5-flash-lite',
    openai:     'gpt-4o-mini',
    anthropic:  'claude-haiku-4-5-20251001',
    ollama:     'llama3',
    openrouter: 'openrouter/auto',
  },
  balanced: {
    gemini:     'gemini-2.5-flash',
    openai:     'gpt-4o-mini',
    anthropic:  'claude-sonnet-4-20250514',
    ollama:     'llama3',
    openrouter: 'openrouter/auto',
  },
  powerful: {
    gemini:     'gemini-2.5-flash',
    openai:     'gpt-4o',
    anthropic:  'claude-sonnet-4-20250514',
    ollama:     'llama3:70b',
    openrouter: 'openrouter/auto',
  },
};

/**
 * Maps operations to their recommended tier.
 */
const OPERATION_TIERS = {
  categorize:                 'fast',
  'writer-tldr':              'fast',
  summary:                    'fast',
  'thumbnail-concept':        'fast',
  'visual-concept':           'fast',
  trends:                     'fast',
  'category-suggest':         'fast',
  'generate-keywords':        'fast',
  'generate-writer-personas': 'fast',
  'audio-script':             'fast',
  'briefing-script':          'balanced',
  'scrape-summarize':         'fast',
  'audio-clean':              'fast',
  'memory-extract':           'fast',
  'followup-qa':              'fast',
  'agent-pitch':              'fast',
  synthesis:                  'balanced',
  chat:                       'balanced',
  'article-assist':           'balanced',
  'deep-dive':                'powerful',
  'article-edit':             'powerful',
  'editorial-review':         'fast',
  'intent-classify':          'fast',
  'conversation-summary':     'fast',
  'writing-style-preview':    'fast',
  'writing-style-restyle':    'balanced',
  'newsletter-intro':         'balanced',
  'newsletter-subject':       'fast',
  'newsletter-story-arc':     'balanced',
};

/**
 * Stream a chat completion from the configured provider.
 * @param {object} opts
 * @param {string} opts.provider - Provider name (e.g. 'gemini')
 * @param {string} [opts.model] - Model name (uses default for provider if omitted)
 * @param {string} opts.apiKey - API key for the provider
 * @param {Array<{role: string, content: string}>} opts.messages - Conversation messages
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=2048]
 * @returns {AsyncGenerator<{type: string, content?: string, message?: string, promptTokens?: number, completionTokens?: number}>}
 */
function streamChat(opts) {
  const provider = PROVIDERS[opts.provider];
  if (!provider) {
    return (async function* () {
      yield { type: 'error', message: `Unknown provider: ${opts.provider}` };
    })();
  }
  return provider.stream({
    ...opts,
    model: opts.model || DEFAULT_MODELS[opts.provider],
  });
}

/**
 * Non-streaming chat completion from the configured provider.
 * @param {object} opts - Same as streamChat
 * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number } }>}
 */
async function completeChat(opts) {
  const provider = PROVIDERS[opts.provider];
  if (!provider) {
    throw new Error(`Unknown provider: ${opts.provider}`);
  }
  // `tools` flows through if caller passed them; providers that don't support
  // tool calling simply ignore the option.
  return provider.complete({
    ...opts,
    model: opts.model || DEFAULT_MODELS[opts.provider],
  });
}

function getSupportedProviders() {
  return Object.keys(PROVIDERS);
}

function getDefaultModel(provider) {
  return DEFAULT_MODELS[provider] || null;
}

/**
 * Get the recommended model for a provider + operation based on tier mapping.
 */
function getModelForOperation(provider, operation) {
  const tier = OPERATION_TIERS[operation] || 'balanced';
  return MODEL_TIERS[tier]?.[provider] || DEFAULT_MODELS[provider] || null;
}

module.exports = {
  streamChat,
  completeChat,
  getSupportedProviders,
  getDefaultModel,
  getModelForOperation,
  DEFAULT_MODELS,
  MODEL_TIERS,
  OPERATION_TIERS,
};
