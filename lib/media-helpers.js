/**
 * Deep Feed AI — Media helper functions
 * Extracted from routes/media.js for reuse in synthesis pipeline.
 */
const db   = require('../db');
const { toSlug }              = require('./utils');
const { decryptSetting }      = require('./crypto');
const { logUsage, extractGeminiTokens } = require('./ai-usage');
const { canSpend } = require('./budget');
const storage = require('./storage');
const { getAppConfig } = require('./app-config');
const { getGeminiKey } = require('./gemini-config');

const GEMINI_MODEL   = 'gemini-2.5-flash-lite';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const IMAGEN_URL     = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict`;

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

async function getVisualConcept(title, summary, category, tenantId) {
  const apiKey = await getGeminiKey(tenantId);
  if (!apiKey) return null;
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
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
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

async function storeImage(pngBuf, filename, tenantId) {
  return storage.upload(pngBuf, 'image/png', `images/${filename}`, tenantId || 1);
}

/**
 * Generate and store a thumbnail for an article.
 * @param {number} articleId
 * @param {number} tenantId
 * @returns {string|null} imageUrl or null on failure
 */
async function generateAndStoreImage(articleId, tenantId) {
  try {
    const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, tenantId);
    if (!article || article.image_url) return null; // already has image

    // Budget check
    const budgetCheck = await canSpend('thumbnail-render', tenantId);
    if (!budgetCheck.allowed) return null;

    // Resolve API key and model from settings
    let resolvedImageApiKey = await getGeminiKey(tenantId);
    let resolvedImagenUrl = IMAGEN_URL;
    try {
      const modelSetting  = await db.prepare("SELECT value FROM settings WHERE key = 'imagen_model' AND tenant_id = $1").get(tenantId);
      if (modelSetting?.value) {
        resolvedImagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelSetting.value}:predict`;
      }
    } catch { /* fall back to defaults */ }

    if (!resolvedImageApiKey) return null;

    const category    = article.category || '';
    const stylePreset = CATEGORY_STYLES[category] || DEFAULT_STYLE;

    let visualConcept = await getVisualConcept(article.title, article.summary || article.full_content, category, tenantId);
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
    const imageUrl = await storeImage(pngBuf, filename, tenantId);

    await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(imageUrl, articleId, tenantId);
    return imageUrl;
  } catch (err) {
    console.error('[media-helpers] generateAndStoreImage error:', err.message);
    return null;
  }
}

/**
 * Generate and store audio for an article (extracted from routes/media.js).
 * @param {number} articleId
 * @param {number} tenantId
 * @returns {{ audioUrl: string, charCount: number }|null}
 */
async function generateAudioForArticle(articleId, tenantId) {
  try {
    const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, tenantId);
    if (!article || article.is_archived || article.audio_status === 'ready') return null;

    // Budget check
    const budgetCheck = await canSpend('audio', tenantId);
    if (!budgetCheck.allowed) return null;

    const https = require('https');
    const EL_API_KEY  = process.env.ELEVENLABS_API_KEY;
    const appCfg = await getAppConfig(tenantId);

    // Resolve voice: writer's voice → default voice → settings/env
    let resolvedVoiceId = appCfg.elevenlabs_voice_id;
    let resolvedVoiceName = null;
    let resolvedVoiceAvatarUrl = null;

    if (article.writer_id) {
      // Look up writer, then their linked TTS voice
      const writer = await db.prepare('SELECT voice_id FROM writers WHERE id = $1 AND tenant_id = $2').get(article.writer_id, tenantId);
      if (writer?.voice_id) {
        const writerVoice = await db.prepare('SELECT voice_id, name, avatar_url FROM voices WHERE id = $1 AND tenant_id = $2').get(writer.voice_id, tenantId);
        if (writerVoice) {
          resolvedVoiceId = writerVoice.voice_id;
          resolvedVoiceName = writerVoice.name;
          resolvedVoiceAvatarUrl = writerVoice.avatar_url || null;
        }
      }
    }
    if (!resolvedVoiceName) {
      const defaultVoice = await db.prepare('SELECT voice_id, name, avatar_url FROM voices WHERE tenant_id = $1 AND is_default = 1 LIMIT 1').get(tenantId);
      if (defaultVoice) {
        resolvedVoiceId = resolvedVoiceId || defaultVoice.voice_id;
        resolvedVoiceName = defaultVoice.name;
        resolvedVoiceAvatarUrl = defaultVoice.avatar_url || null;
      }
    }

    // Resolve API key from settings
    let resolvedApiKey = EL_API_KEY;
    try {
      const apiKeySetting = await db.prepare("SELECT value FROM settings WHERE key = 'elevenlabs_api_key' AND tenant_id = $1").get(tenantId);
      if (apiKeySetting?.value) resolvedApiKey = decryptSetting(apiKeySetting.value);
    } catch { /* use env var */ }

    if (!resolvedApiKey || !resolvedVoiceId) return null;

    await db.prepare("UPDATE articles SET audio_status = 'pending', updated_at = NOW() WHERE id = $1 AND tenant_id = $2").run(articleId, tenantId);

    // Build TTS text (simplified — no Gemini call for auto-audio to save budget)
    const rawSummary = (article.summary || article.full_content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 700);
    const text = `From ${article.source || 'Deep Feed AI'}. ${article.title}. ${rawSummary}`.slice(0, 900);

    // Generate speech via ElevenLabs
    const _elStart = Date.now();
    const mp3Buf = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
      });
      const req = https.request({
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${resolvedVoiceId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': resolvedApiKey,
          'Accept': 'audio/mpeg',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let err = '';
          res.on('data', c => err += c);
          res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${err.slice(0, 200)}`)));
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('ElevenLabs timeout')); });
      req.write(body);
      req.end();
    });

    logUsage({ provider: 'elevenlabs', model: 'eleven_turbo_v2', operation: 'audio', articleSlug: article.slug, trigger: 'auto', characters: text.length, durationMs: Date.now() - _elStart }).catch(() => {});

    // Store audio
    const slug = toSlug(article.title) || `article-${article.id}`;
    const filename = `${slug}-${article.id}.mp3`;

    const audioUrl = await storage.upload(mp3Buf, 'audio/mpeg', `audio/${filename}`, tenantId);

    await db.prepare(`
      UPDATE articles
      SET audio_url = $1, audio_status = 'ready', audio_transcript = $2,
          audio_voice_name = $3, audio_voice_avatar_url = $4, updated_at = NOW()
      WHERE id = $5 AND tenant_id = $6
    `).run(audioUrl, text, resolvedVoiceName, resolvedVoiceAvatarUrl, articleId, tenantId);

    return { audioUrl, charCount: text.length };
  } catch (err) {
    console.error('[media-helpers] generateAudioForArticle error:', err.message);
    await db.prepare("UPDATE articles SET audio_status = 'error', updated_at = NOW() WHERE id = $1 AND tenant_id = $2").run(articleId, tenantId).catch(() => {});
    logUsage({ provider: 'elevenlabs', model: 'eleven_turbo_v2', operation: 'audio', trigger: 'auto', success: false, error: err.message }).catch(() => {});
    return null;
  }
}

module.exports = { getVisualConcept, storeImage, generateAndStoreImage, generateAudioForArticle, CATEGORY_STYLES, DEFAULT_STYLE };
