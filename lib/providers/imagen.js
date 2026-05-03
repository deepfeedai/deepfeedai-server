/**
 * Deep Feed AI — Imagen provider adapter (Google generativelanguage).
 * Non-streaming image generation. Returns base64-encoded PNG bytes.
 */
'use strict';

const ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);

async function callImagen({ apiKey, model, prompt, ratio, numberOfImages, personGeneration, timeoutMs }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: numberOfImages, aspectRatio: ratio, safetyFilterLevel: 'block_few', personGeneration },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`imagen ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.predictions?.[0]?.bytesBase64Encoded || null;
  } finally {
    clearTimeout(t);
  }
}

async function generate({ apiKey, model, prompt, aspectRatio = '16:9', numberOfImages = 1, allowPerson = false, timeoutMs = 30000 }) {
  if (!apiKey) throw new Error('imagen: missing API key');
  if (!prompt) throw new Error('imagen: missing prompt');
  const ratio = ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : '16:9';

  // Try with the requested person setting first; if blocked, retry with allow_adult.
  const personGeneration = allowPerson ? 'allow_adult' : 'dont_allow';
  let b64 = await callImagen({ apiKey, model, prompt, ratio, numberOfImages, personGeneration, timeoutMs });

  if (!b64 && personGeneration === 'dont_allow') {
    b64 = await callImagen({ apiKey, model, prompt, ratio, numberOfImages, personGeneration: 'allow_adult', timeoutMs });
  }

  if (!b64) throw new Error('imagen: no image bytes returned (safety filter blocked the prompt)');
  return { b64, mime: 'image/png' };
}

module.exports = { generate };
