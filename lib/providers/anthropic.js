/**
 * Deep Feed AI — Anthropic provider adapter
 * Implements stream() and complete() for the Anthropic Messages API.
 */
'use strict';

const BASE_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Extract system message from the messages array.
 * Anthropic uses a top-level `system` parameter instead of a system role message.
 */
function extractSystem(messages) {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const otherMsgs = messages.filter(m => m.role !== 'system');
  const system = systemMsgs.length > 0
    ? systemMsgs.map(m => m.content).join('\n\n')
    : undefined;
  return { system, messages: otherMsgs };
}

/**
 * Convert unified tool schema to Anthropic's tool format.
 * Unified: [{ name, description, parameters: zodSchemaJSON }]
 * Anthropic: [{ name, description, input_schema }]
 */
function toAnthropicTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters || t.input_schema || { type: 'object', properties: {} },
  }));
}

/**
 * Parse Anthropic response content blocks into unified { text, toolCalls } shape.
 */
function parseAnthropicResponse(data) {
  const blocks = data.content || [];
  let text = '';
  const toolCalls = [];
  for (const block of blocks) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
    }
  }
  return { text, toolCalls: toolCalls.length ? toolCalls : null };
}

/**
 * Non-streaming completion.
 */
async function complete({ apiKey, model, messages, temperature = 0.7, maxTokens = 2048, tools }) {
  const { system, messages: cleanMessages } = extractSystem(messages);

  const body = {
    model,
    messages: cleanMessages,
    max_tokens: maxTokens,
    temperature,
  };
  if (system) body.system = system;
  const toolSchemas = toAnthropicTools(tools);
  if (toolSchemas) body.tools = toolSchemas;

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const { text, toolCalls } = parseAnthropicResponse(data);
  // Anthropic prompt caching: cache_read_input_tokens (hits) + cache_creation_input_tokens (writes).
  const cachedRead = data.usage?.cache_read_input_tokens || 0;
  const cachedWrite = data.usage?.cache_creation_input_tokens || 0;
  const freshInput = data.usage?.input_tokens || 0;
  return {
    text,
    toolCalls,
    usage: {
      promptTokens: freshInput + cachedRead + cachedWrite,
      cachedPromptTokens: cachedRead,
      completionTokens: data.usage?.output_tokens || 0,
    },
  };
}

/**
 * Streaming completion via SSE.
 */
async function* stream({ apiKey, model, messages, temperature = 0.7, maxTokens = 2048 }) {
  const { system, messages: cleanMessages } = extractSystem(messages);

  const body = {
    model,
    messages: cleanMessages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
  };
  if (system) body.system = system;

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    yield { type: 'error', message: `Anthropic API error ${response.status}: ${errText.slice(0, 200)}` };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

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
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);

          if (event.type === 'content_block_delta' && event.delta?.text) {
            yield { type: 'text', content: event.delta.text };
          }
          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0;
          }
          if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens || 0;
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (inputTokens || outputTokens) {
    yield { type: 'usage', promptTokens: inputTokens, completionTokens: outputTokens };
  }

  yield { type: 'done' };
}

module.exports = { complete, stream };
