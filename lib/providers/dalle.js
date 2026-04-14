/**
 * Deep Feed AI — DALL-E provider adapter (OpenAI /images/generations).
 * Returns base64-encoded PNG bytes.
 *
 * Models:
 *   dall-e-3       — standard quality, $0.04 (1024) / $0.08 (1792x1024)
 *   dall-e-3-hd    — HD quality,       $0.08 (1024) / $0.12 (1792x1024)
 *
 * Aspect-ratio mapping: DALL-E 3 only supports fixed sizes, so we pick the
 * closest match: 16:9 / 4:3 → 1792x1024, 9:16 / 3:4 → 1024x1792, else 1024x1024.
 */
'use strict';

function mapSize(aspectRatio) {
  switch (aspectRatio) {
    case '16:9':
    case '4:3':
      return '1792x1024';
    case '9:16':
    case '3:4':
      return '1024x1792';
    default:
      return '1024x1024';
  }
}

async function generate({ apiKey, model = 'dall-e-3', prompt, aspectRatio = '16:9', timeoutMs = 60000 }) {
  if (!apiKey) throw new Error('dalle: missing API key');
  if (!prompt) throw new Error('dalle: missing prompt');

  // dall-e-3-hd is our internal alias — OpenAI takes model=dall-e-3, quality=hd
  const isHd = /-hd$/i.test(model);
  const apiModel = isHd ? 'dall-e-3' : model;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: apiModel,
        prompt: prompt.slice(0, 3900), // DALL-E 3 limit is 4000
        n: 1,
        size: mapSize(aspectRatio),
        quality: isHd ? 'hd' : 'standard',
        response_format: 'b64_json',
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`dalle ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error('dalle: no image bytes returned');
    return { b64, mime: 'image/png', revisedPrompt: data.data[0].revised_prompt || null };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { generate };
