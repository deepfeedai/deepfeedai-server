/**
 * Deep Feed AI — OpenRouter provider adapter
 * Implements stream() and complete() for the OpenRouter API.
 * OpenRouter uses an OpenAI-compatible format with additional headers.
 */
'use strict';

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

function toOpenAITools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

function parseOpenAIMessage(msg) {
  const text = msg?.content || '';
  const toolCalls = (msg?.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function?.name,
    args: (typeof tc.function?.arguments === 'string'
      ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
      : tc.function?.arguments) || {},
  }));
  return { text, toolCalls: toolCalls.length ? toolCalls : null };
}

/**
 * Non-streaming completion.
 */
async function complete({ apiKey, model, messages, temperature = 0.7, maxTokens = 2048, tools }) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  const toolSchemas = toOpenAITools(tools);
  if (toolSchemas) body.tools = toolSchemas;

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://deepfeedai.com',
      'X-Title': 'Deep Feed AI',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenRouter API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const { text, toolCalls } = parseOpenAIMessage(data.choices?.[0]?.message);
  return {
    text,
    toolCalls,
    usage: {
      promptTokens: data.usage?.prompt_tokens || 0,
      cachedPromptTokens: data.usage?.prompt_tokens_details?.cached_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Streaming completion via SSE.
 * @yields {{ type: 'text'|'usage'|'done'|'error', content?: string, promptTokens?: number, completionTokens?: number }}
 */
async function* stream({ apiKey, model, messages, temperature = 0.7, maxTokens = 2048 }) {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://deepfeedai.com',
      'X-Title': 'Deep Feed AI',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    yield { type: 'error', message: `OpenRouter API error ${response.status}: ${errText.slice(0, 200)}` };
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
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const data = JSON.parse(jsonStr);
          const text = data.choices?.[0]?.delta?.content;
          if (text) {
            yield { type: 'text', content: text };
          }
          if (data.usage) {
            lastUsage = data.usage;
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (lastUsage) {
    yield {
      type: 'usage',
      promptTokens: lastUsage.prompt_tokens || 0,
      completionTokens: lastUsage.completion_tokens || 0,
    };
  }

  yield { type: 'done' };
}

/**
 * Generate embeddings via OpenRouter /v1/embeddings API.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string[]} opts.input
 * @param {number} [opts.dimensions]
 * @returns {Promise<number[][]>}
 */
async function embed({ apiKey, model, input, dimensions }) {
  const body = { model, input };
  if (dimensions) body.dimensions = dimensions;

  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://deepfeedai.com',
      'X-Title': 'Deep Feed AI',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenRouter embedding API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

module.exports = { complete, stream, embed };
