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

// ── Gemini Provider ──────────────────────────────────────────────────

/**
 * Convert our generic messages format to Gemini's contents array.
 * Gemini expects: [{ role: 'user'|'model', parts: [{ text }] }]
 * System instructions are handled separately.
 */
function toGeminiContents(messages) {
  const contents = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled via systemInstruction
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }
  return contents;
}

function getGeminiSystemInstruction(messages) {
  const systemMsgs = messages.filter(m => m.role === 'system');
  if (systemMsgs.length === 0) return undefined;
  return { parts: [{ text: systemMsgs.map(m => m.content).join('\n\n') }] };
}

async function* geminiStream({ apiKey, model, messages, temperature = 0.7, maxTokens = 2048 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const body = {
    contents: toGeminiContents(messages),
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  const systemInstruction = getGeminiSystemInstruction(messages);
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    yield { type: 'error', message: `Gemini API error ${response.status}: ${errText.slice(0, 200)}` };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastUsage = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const data = JSON.parse(jsonStr);
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            yield { type: 'text', content: text };
          }
          if (data.usageMetadata) {
            lastUsage = data.usageMetadata;
          }
        } catch {
          // skip malformed JSON chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (lastUsage) {
    yield {
      type: 'usage',
      promptTokens: lastUsage.promptTokenCount || 0,
      completionTokens: lastUsage.candidatesTokenCount || 0,
    };
  }

  yield { type: 'done' };
}

/**
 * Non-streaming Gemini completion (consolidates the pattern used by 10+ call sites).
 */
async function geminiComplete({ apiKey, model, messages, temperature = 0.7, maxTokens = 2048 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: toGeminiContents(messages),
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };

  const systemInstruction = getGeminiSystemInstruction(messages);
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  const usage = data.usageMetadata || {};

  return {
    text,
    usage: {
      promptTokens: usage.promptTokenCount || 0,
      completionTokens: usage.candidatesTokenCount || 0,
    },
  };
}

// ── Provider Registry ────────────────────────────────────────────────

const PROVIDERS = {
  gemini:     { stream: geminiStream,              complete: geminiComplete },
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
  trends:                     'fast',
  'category-suggest':         'fast',
  'generate-keywords':        'fast',
  'generate-writer-personas': 'fast',
  'audio-script':             'fast',
  'scrape-summarize':         'fast',
  'audio-clean':              'fast',
  synthesis:                  'balanced',
  chat:                       'balanced',
  'article-assist':           'balanced',
  'deep-dive':                'powerful',
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
