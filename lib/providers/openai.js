/**
 * Deep Feed AI — OpenAI provider adapter
 * Implements stream() and complete() for OpenAI-compatible APIs.
 */
'use strict';

const BASE_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Convert unified tool schema to OpenAI's function-calling format.
 */
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

/**
 * Parse OpenAI response.message into unified { text, toolCalls } shape.
 */
function parseOpenAIMessage(msg) {
  const text = msg?.content || '';
  const toolCalls = (msg?.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function?.name,
    args: safeParse(tc.function?.arguments) || {},
  }));
  return { text, toolCalls: toolCalls.length ? toolCalls : null };
}

function safeParse(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return {}; }
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
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${errText.slice(0, 200)}`);
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
    yield { type: 'error', message: `OpenAI API error ${response.status}: ${errText.slice(0, 200)}` };
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
      cachedPromptTokens: lastUsage.prompt_tokens_details?.cached_tokens || 0,
      completionTokens: lastUsage.completion_tokens || 0,
    };
  }

  yield { type: 'done' };
}

/**
 * Generate embeddings via OpenAI /v1/embeddings API.
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

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI embedding API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

module.exports = { complete, stream, embed };
