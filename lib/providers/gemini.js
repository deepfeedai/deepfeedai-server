/**
 * Deep Feed AI — Gemini provider adapter
 * Implements stream() and complete() for Google Gemini (generativelanguage API).
 */
'use strict';

function toGeminiContents(messages) {
  const contents = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
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

function toGeminiTools(tools) {
  if (!tools || !tools.length) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    })),
  }];
}

function parseGeminiCandidate(candidate) {
  const parts = candidate?.content?.parts || [];
  let text = '';
  const toolCalls = [];
  for (const part of parts) {
    if (part.text) text += part.text;
    else if (part.functionCall) {
      toolCalls.push({
        id: `gem_${Math.random().toString(36).slice(2, 10)}`,
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      });
    }
  }
  return { text: text.trim(), toolCalls: toolCalls.length ? toolCalls : null };
}

async function* stream({ apiKey, model, messages, temperature = 0.7, maxTokens = 2048 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

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
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const data = JSON.parse(jsonStr);
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield { type: 'text', content: text };
          if (data.usageMetadata) lastUsage = data.usageMetadata;
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

async function complete({ apiKey, model, messages, temperature = 0.7, maxTokens = 2048, tools }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: toGeminiContents(messages),
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };

  const systemInstruction = getGeminiSystemInstruction(messages);
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const toolSchemas = toGeminiTools(tools);
  if (toolSchemas) body.tools = toolSchemas;

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
  const { text, toolCalls } = parseGeminiCandidate(data.candidates?.[0]);
  const usage = data.usageMetadata || {};

  return {
    text,
    toolCalls,
    usage: {
      promptTokens: usage.promptTokenCount || 0,
      cachedPromptTokens: usage.cachedContentTokenCount || 0,
      completionTokens: usage.candidatesTokenCount || 0,
    },
  };
}

/**
 * Generate embeddings via Gemini batchEmbedContents API.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string[]} opts.input
 * @param {number} [opts.dimensions]
 * @returns {Promise<number[][]>}
 */
async function embed({ apiKey, model, input, dimensions }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;
  const requests = input.map(text => ({
    model: `models/${model}`,
    content: { parts: [{ text }] },
    ...(dimensions ? { outputDimensionality: dimensions } : {}),
  }));

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini embedding API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.embeddings.map(e => e.values);
}

module.exports = { stream, complete, embed };
