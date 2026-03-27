/**
 * Deep Feed AI — Ollama provider adapter
 * Implements stream() and complete() for self-hosted Ollama instances.
 * Ollama uses an OpenAI-compatible chat API with NDJSON streaming.
 */
'use strict';

const DEFAULT_BASE_URL = 'http://localhost:11434';

function chatUrl(baseUrl) {
  return `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/api/chat`;
}

/**
 * Non-streaming completion.
 */
async function complete({ baseUrl, model, messages, temperature = 0.7, maxTokens = 2048 }) {
  const response = await fetch(chatUrl(baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(120000), // longer timeout for local inference
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Ollama API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.message?.content || '';
  return {
    text,
    usage: {
      promptTokens: data.prompt_eval_count || 0,
      completionTokens: data.eval_count || 0,
    },
  };
}

/**
 * Streaming completion via NDJSON.
 */
async function* stream({ baseUrl, model, messages, temperature = 0.7, maxTokens = 2048 }) {
  const response = await fetch(chatUrl(baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: { temperature, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(300000), // 5 min for large local models
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    yield { type: 'error', message: `Ollama API error ${response.status}: ${errText.slice(0, 200)}` };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            yield { type: 'text', content: data.message.content };
          }
          if (data.done) {
            promptTokens = data.prompt_eval_count || 0;
            completionTokens = data.eval_count || 0;
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (promptTokens || completionTokens) {
    yield { type: 'usage', promptTokens, completionTokens };
  }

  yield { type: 'done' };
}

/**
 * List available models on an Ollama instance.
 * @param {string} baseUrl
 * @returns {Promise<Array<{ name: string, size: number }>>}
 */
async function listModels(baseUrl) {
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/api/tags`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Ollama list models error ${response.status}`);
  const data = await response.json();
  return (data.models || []).map(m => ({ name: m.name, size: m.size }));
}

module.exports = { complete, stream, listModels };
