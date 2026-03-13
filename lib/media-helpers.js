/**
 * Deep Feed AI — Media helper functions
 * Extracted from routes/media.js for reuse in synthesis pipeline.
 */
const fs   = require('fs');
const path = require('path');
const db   = require('../db');
const { toSlug }              = require('./utils');
const { decryptSetting }      = require('./crypto');
const { logUsage, extractGeminiTokens } = require('./ai-usage');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-2.5-flash-lite';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const IMAGEN_URL     = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict`;
const IMAGE_DIR      = path.join(__dirname, '..', 'public', 'media', 'images');

const R2_CONFIGURED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME
);

function getR2Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region:   'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

const CATEGORY_STYLES = {
  'LLMs':          'glowing neural network nodes, synaptic connections, deep blue and cyan tones, abstract digital art',
  'Research':      'abstract scientific data visualization, clean geometric forms, cool blue and white palette',
  'Tools':         'holographic software interface, floating UI panels, dark theme, neon accent lines',
  'Policy':        'dramatic government architecture with digital light overlay, serious and authoritative',
  'Business':      'modern corporate technology landscape, clean lines, glass and steel aesthetic',
  'CyberSecurity': 'digital security matrix, glowing lock symbol, high contrast red and blue, cyber aesthetic',
  'Image AI':      'vibrant generative art canvas, colorful abstract shapes emerging from darkness',
  'Industry':      'sweeping circuit board landscape, warm amber and gold tones, macro detail',
  'Agents':        'autonomous robotic forms, interconnected decision nodes, silver and blue glow',
  'Hardware':      'close-up microchip architecture, copper traces, dramatic macro photography style',
};
const DEFAULT_STYLE = 'futuristic technology abstract, dark background, cool blue tones';

async function getVisualConcept(title, summary, category) {
  if (!GEMINI_API_KEY) return null;
  const cleanSummary = (summary || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const prompt = `You are a creative director for a tech news site. Your job is to write a highly specific visual concept for an AI-generated thumbnail image.

Rules:
- Be SPECIFIC to this article — reference the actual subject matter, not generic tech visuals
- 2-3 sentences, max 60 words
- Describe a metaphorical or symbolic scene — NOT literal (no offices, computers, phones)
- Think cinematic: lighting, mood, color, atmosphere
- No text, no people, no faces, no hands, no logos, no screens, no devices
- Use the article details to inspire unique visual metaphors (e.g. "lawsuit" → scales of justice made of circuit boards; "AI model release" → a glowing entity emerging from darkness)

Article title: ${title}
Article summary: ${cleanSummary}
Category: ${category || 'Technology'}

Specific visual concept for this article:`;

  try {
    const _start = Date.now();
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) {
      logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'thumbnail-concept', trigger: 'auto', durationMs: Date.now() - _start, success: false, error: `${res.status}` }).catch(() => {});
      return null;
    }
    const data = await res.json();
    const _tokens = extractGeminiTokens(data);
    logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'thumbnail-concept', trigger: 'auto', inputTokens: _tokens.promptTokenCount, outputTokens: _tokens.candidatesTokenCount, durationMs: Date.now() - _start }).catch(() => {});
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch { return null; }
}

async function storeImage(pngBuf, filename) {
  if (R2_CONFIGURED) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = getR2Client();
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         `images/${filename}`,
      Body:        pngBuf,
      ContentType: 'image/png',
    }));
    const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    return `${publicUrl}/images/${filename}`;
  }
  // Local fallback
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGE_DIR, filename), pngBuf);
  return `/media/images/${filename}`;
}

/**
 * Generate and store a thumbnail for an article.
 * @param {number} articleId
 * @returns {string|null} imageUrl or null on failure
 */
async function generateAndStoreImage(articleId) {
  try {
    const article = await db.prepare('SELECT * FROM articles WHERE id = $1').get(articleId);
    if (!article || article.image_url) return null; // already has image

    // Resolve API key and model from settings
    let resolvedImageApiKey = GEMINI_API_KEY;
    let resolvedImagenUrl = IMAGEN_URL;
    try {
      const modelSetting  = await db.prepare("SELECT value FROM settings WHERE key = 'imagen_model'").get();
      const apiKeySetting = await db.prepare("SELECT value FROM settings WHERE key = 'imagen_api_key'").get();
      if (modelSetting?.value) {
        resolvedImagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelSetting.value}:predict`;
      }
      if (apiKeySetting?.value) resolvedImageApiKey = decryptSetting(apiKeySetting.value);
    } catch { /* fall back to defaults */ }

    if (!resolvedImageApiKey) return null;

    const category    = article.category || '';
    const stylePreset = CATEGORY_STYLES[category] || DEFAULT_STYLE;

    let visualConcept = await getVisualConcept(article.title, article.summary || article.full_content, category);
    if (!visualConcept) {
      visualConcept = `A dramatic symbolic scene representing: ${article.title}`;
    }

    const fullPrompt = `${visualConcept} ${stylePreset}. Photorealistic digital art, dark background, cinematic dramatic lighting, no text, no words, no letters, no logos, no people, no faces, no hands, no screens, no devices, sharp focus, 8K quality.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const _imgStart = Date.now();

    let imagenRes;
    try {
      imagenRes = await fetch(`${resolvedImagenUrl}?key=${resolvedImageApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt: fullPrompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio: '16:9',
            safetyFilterLevel: 'block_few',
            personGeneration: 'dont_allow',
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!imagenRes.ok) {
      const errBody = await imagenRes.text().catch(() => '');
      logUsage({ provider: 'imagen', model: 'imagen-4', operation: 'thumbnail-render', articleSlug: article.slug, trigger: 'auto', imageCount: 0, durationMs: Date.now() - _imgStart, success: false, error: `${imagenRes.status}: ${errBody.slice(0, 200)}` }).catch(() => {});
      return null;
    }

    const imagenData = await imagenRes.json();
    const b64 = imagenData?.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return null;

    logUsage({ provider: 'imagen', model: 'imagen-4', operation: 'thumbnail-render', articleSlug: article.slug, trigger: 'auto', imageCount: 1, durationMs: Date.now() - _imgStart }).catch(() => {});

    const pngBuf   = Buffer.from(b64, 'base64');
    const randHex  = require('crypto').randomBytes(8).toString('hex');
    const filename = `img-${randHex}-${Date.now()}.png`;
    const imageUrl = await storeImage(pngBuf, filename);

    await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2').run(imageUrl, articleId);
    return imageUrl;
  } catch (err) {
    console.error('[media-helpers] generateAndStoreImage error:', err.message);
    return null;
  }
}

module.exports = { getVisualConcept, storeImage, generateAndStoreImage, CATEGORY_STYLES, DEFAULT_STYLE };
