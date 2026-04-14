/**
 * Deep Feed AI — Imagen provider adapter (Google generativelanguage).
 * Non-streaming image generation. Returns base64-encoded PNG bytes.
 */
'use strict';

const ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);

async function generate({ apiKey, model, prompt, aspectRatio = '16:9', timeoutMs = 30000 }) {
  if (!apiKey) throw new Error('imagen: missing API key');
  if (!prompt) throw new Error('imagen: missing prompt');
  const ratio = ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : '16:9';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: ratio,
          safetyFilterLevel: 'block_few',
          personGeneration: 'dont_allow',
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`imagen ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error('imagen: no image bytes returned');
    return { b64, mime: 'image/png' };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { generate };
