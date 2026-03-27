/**
 * Deep Feed AI — lib/chat-provider.js
 * Provider abstraction layer for AI chat completions.
 * Currently supports Gemini; designed for future providers (Ollama, OpenAI, etc).
 *
 * Each provider implements:
 *   streamChat({ apiKey, model, messages, temperature, maxTokens }) → AsyncGenerator<Chunk>
 *
 * Chunk types:
 *   { type: 'text',  content: string }
 *   { type: 'usage', promptTokens: number, completionTokens: number }
 *   { type: 'done' }
 *   { type: 'error', message: string }
 */
'use strict';

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

// ── Provider Registry ────────────────────────────────────────────────

const PROVIDERS = {
  gemini: { stream: geminiStream },
  // Future providers:
  // ollama: { stream: ollamaStream },
  // openai: { stream: openaiStream },
};

const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash',
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

function getSupportedProviders() {
  return Object.keys(PROVIDERS);
}

function getDefaultModel(provider) {
  return DEFAULT_MODELS[provider] || null;
}

module.exports = { streamChat, getSupportedProviders, getDefaultModel, DEFAULT_MODELS };
