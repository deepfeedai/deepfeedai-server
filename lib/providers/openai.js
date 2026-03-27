/**
 * Deep Feed AI — OpenAI provider adapter
 * Implements stream() and complete() for OpenAI-compatible APIs.
 */
'use strict';

const BASE_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Non-streaming completion.
 * @returns {{ text: string, usage: { promptTokens: number, completionTokens: number } }}
 */
async function complete({ apiKey, model, messages, temperature = 0.7, maxTokens = 2048 }) {
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
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  return {
    text,
    usage: {
      promptTokens: data.usage?.prompt_tokens || 0,
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
      completionTokens: lastUsage.completion_tokens || 0,
    };
  }

  yield { type: 'done' };
}

module.exports = { complete, stream };
