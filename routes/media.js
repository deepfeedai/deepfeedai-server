/**
 * Deep Feed AI Admin — /api/media
 * ElevenLabs audio generation.
 * Production: uploads MP3 to Cloudflare R2, stores CDN URL in DB.
 * Local dev: saves MP3 to public/media/audio/ (R2 env vars not set).
 */
const express = require('express');
const router  = require('express').Router();
const https   = require('https');
const db      = require('../db');

const { auth }               = require('../middleware/auth');
const { requirePermission }  = require('../middleware/permissions');
const { toSlug, asyncHandler } = require('../lib/utils');
const { decryptSetting }     = require('../lib/crypto');
const storage = require('../lib/storage');
const { getGeminiKey } = require('../lib/gemini-config');
const { getAppConfig } = require('../lib/app-config');
const EL_API_KEY    = process.env.ELEVENLABS_API_KEY;
const { logUsage, extractGeminiTokens } = require('../lib/ai-usage');
const { checkFeatureEnabled }           = require('../lib/plan-limits');
const { logAudit }                      = require('../middleware/audit');
const MAX_CHARS     = 900;
const GEMINI_MODEL  = 'gemini-2.5-flash-lite';
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;



async function getAiSummary(title, rawSummary, tenantId) {
  const apiKey = await getGeminiKey(tenantId);
  if (!apiKey) return null;
  const prompt = `You are a professional news anchor. Write a concise 2-3 sentence spoken summary of this AI news article for a text-to-speech audio player. Use natural spoken language — no bullet points, no markdown, no hashtags. Sound engaging and informative.

Article title: ${title}
Article summary: ${(rawSummary || '').replace(/<[^>]+>/g, '').slice(0, 800)}

Spoken summary:`;

  try {
    const _start = Date.now();
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) {
      logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'audio-script', trigger: 'manual', durationMs: Date.now() - _start, success: false, error: `${res.status}`, tenantId }).catch(() => {});
      return null;
    }
    const data = await res.json();
    const _tokens = extractGeminiTokens(data);
    logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'audio-script', trigger: 'manual', inputTokens: _tokens.promptTokenCount, outputTokens: _tokens.candidatesTokenCount, durationMs: Date.now() - _start, tenantId }).catch(() => {});
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch { return null; }
}

async function buildTtsText(title, summary, source, tenantId) {
  const aiSummary = await getAiSummary(title, summary, tenantId);
  const body = aiSummary || (summary || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 700);
  return `From ${source}. ${title}. ${body}`.slice(0, MAX_CHARS);
}

function generateSpeech(text, voiceId, apiKey) {
  const resolvedVoiceId = voiceId;
  const resolvedApiKey  = apiKey  || EL_API_KEY;
  return new Promise((resolve, reject) => {
    if (!resolvedApiKey || !resolvedVoiceId) return reject(new Error('ElevenLabs credentials not configured'));
    const body = JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path:     `/v1/text-to-speech/${resolvedVoiceId}`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'xi-api-key':     resolvedApiKey,
        'Accept':         'audio/mpeg',
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
    req.write(body);
    req.end();
  });
}

async function storeAudio(mp3Buf, filename, tenantId) {
  return storage.upload(mp3Buf, 'audio/mpeg', `audio/${filename}`, tenantId || 1);
}

async function deleteAudio(audioUrl, tenantId) {
  if (!audioUrl) return;
  // Extract the key from the URL and delegate to storage.remove
  const match = audioUrl.match(/audio\/([^/?#]+)/);
  if (match) {
    try { await storage.remove(`audio/${match[1]}`, tenantId || 1); } catch { /* best effort */ }
  }
}

// POST /api/media/generate-audio  { articleId, voiceId? }
router.post('/generate-audio', auth, requirePermission('media.create'), asyncHandler(async (req, res) => {
  const audioEnabled = await checkFeatureEnabled(req.tenantId, 'audio_enabled');
  if (!audioEnabled) {
    return res.status(403).json({ error: 'Feature not available on your plan', feature: 'audio_enabled' });
  }

  const { articleId, voiceId } = req.body;
  if (!articleId) return res.status(400).json({ error: 'articleId required' });

  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot generate audio for archived article' });

  await db.prepare("UPDATE articles SET audio_status = 'pending', updated_at = NOW() WHERE id = $1 AND tenant_id = $2").run(articleId, req.tenantId);

  try {
    // Resolve voice: explicit voiceId → writer's ElevenLabs voice → app config
    const appCfg = await getAppConfig(req.tenantId);
    let resolvedVoiceId = appCfg.elevenlabs_voice_id;
    let resolvedVoiceName = null;
    let resolvedVoiceAvatarUrl = null;

    if (voiceId) {
      // voiceId is now a direct ElevenLabs voice ID string
      resolvedVoiceId = voiceId;
    } else if (article.writer_id) {
      const writer = await db.prepare('SELECT elevenlabs_voice_id, name, avatar_url FROM writers WHERE id = $1 AND tenant_id = $2').get(article.writer_id, req.tenantId);
      if (writer?.elevenlabs_voice_id) {
        resolvedVoiceId = writer.elevenlabs_voice_id;
        resolvedVoiceName = writer.name;
        resolvedVoiceAvatarUrl = writer.avatar_url || null;
      }
    }

    // Resolve API key: settings table → env var
    let resolvedApiKey = EL_API_KEY;
    const apiKeySetting = await db.prepare("SELECT value FROM settings WHERE key = 'elevenlabs_api_key' AND tenant_id = $1").get(req.tenantId);
    if (apiKeySetting && apiKeySetting.value) resolvedApiKey = decryptSetting(apiKeySetting.value);

    const text     = await buildTtsText(article.title, article.summary, article.source || 'Deep Feed AI', req.tenantId);
    const _elStart = Date.now();
    const mp3Buf   = await generateSpeech(text, resolvedVoiceId, resolvedApiKey);
    logUsage({ provider: 'elevenlabs', model: 'eleven_turbo_v2', operation: 'audio', articleSlug: article.slug, trigger: 'manual', characters: text.length, durationMs: Date.now() - _elStart, tenantId: req.tenantId }).catch(() => {});
    const slug     = toSlug(article.title) || `article-${article.id}`;
    const filename = `${slug}-${article.id}.mp3`;
    const audioUrl = await storeAudio(mp3Buf, filename, req.tenantId);

    await db.prepare(`
      UPDATE articles
      SET audio_url = $1, audio_status = 'ready', audio_transcript = $2,
          audio_voice_name = $3, audio_voice_avatar_url = $4, updated_at = NOW()
      WHERE id = $5 AND tenant_id = $6
    `).run(audioUrl, text, resolvedVoiceName, resolvedVoiceAvatarUrl, articleId, req.tenantId);

    await logAudit(req, 'media.generate-audio', 'article', articleId, { title: article.title, charCount: text.length, voiceName: resolvedVoiceName });
    res.json({ audioUrl, charCount: text.length, ttsText: text, voiceName: resolvedVoiceName });
  } catch (err) {
    await db.prepare("UPDATE articles SET audio_status = 'error', updated_at = NOW() WHERE id = $1 AND tenant_id = $2").run(articleId, req.tenantId);
    console.error('[Media] Error:', err.message);
    logUsage({ provider: 'elevenlabs', model: 'eleven_turbo_v2', operation: 'audio', articleSlug: article.slug, trigger: 'manual', success: false, error: err.message, tenantId: req.tenantId }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
}));

// POST /api/media/preview-voice  { voice_id, text? }
router.post('/preview-voice', auth, requirePermission('writers.read'), asyncHandler(async (req, res) => {
  const { voice_id, text } = req.body || {};
  if (!voice_id) return res.status(400).json({ error: 'voice_id required' });

  let apiKey = EL_API_KEY;
  const setting = await db.prepare("SELECT value FROM settings WHERE key = 'elevenlabs_api_key' AND tenant_id = $1").get(req.tenantId);
  if (setting?.value) apiKey = decryptSetting(setting.value);

  const previewText = (text && text.trim()) ? text.trim().slice(0, 500) : 'Hello! This is a preview of how I sound as your AI news anchor. Stay tuned for the latest updates.';
  const mp3Buf = await generateSpeech(previewText, voice_id, apiKey);
  res.json({ audio: mp3Buf.toString('base64'), mimeType: 'audio/mpeg' });
}));

// POST /api/media/generate-image  { articleId }
const IMAGEN_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict`;
const { getVisualConcept, buildImagePrompt, storeImage } = require('../lib/media-helpers');

router.post('/generate-image', auth, requirePermission('media.create'), asyncHandler(async (req, res) => {
  const { articleId } = req.body;
  if (!articleId) return res.status(400).json({ error: 'articleId required' });

  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot generate image for archived article' });
  // Resolve API key and model from settings (DB overrides env var)
  const resolvedImageApiKey = await getGeminiKey(req.tenantId);
  let resolvedImagenUrl = IMAGEN_URL;
  try {
    const modelSetting = await db.prepare("SELECT value FROM settings WHERE key = 'imagen_model' AND tenant_id = $1").get(req.tenantId);
    const MODEL_RE = /^[a-zA-Z0-9._-]{3,80}$/;
    if (modelSetting?.value && MODEL_RE.test(modelSetting.value)) {
      resolvedImagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelSetting.value}:predict`;
    }
  } catch { /* fall back to default */ }

  if (!resolvedImageApiKey) return res.status(500).json({ error: 'Gemini/Imagen API key not configured — set it in Settings > Integrations or GEMINI_API_KEY env var' });

  try {
    const category = article.category || '';

    // Step 1: Get visual concept + style from Gemini
    const visualResult = await getVisualConcept(article.title, article.summary, category, req.tenantId, 'manual');

    // Step 2: Assemble full Imagen prompt
    const fullPrompt = buildImagePrompt(visualResult, article.title);

    console.log(`[ImageGen] Article ${articleId}: "${article.title}"`);
    console.log(`[ImageGen] Visual concept: ${visualResult ? visualResult.concept : 'fallback'}`);
    console.log(`[ImageGen] Full prompt: ${fullPrompt}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const _imgStart = Date.now();

    let imagenRes;
    try {
      const imagenBody = resolvedImagenUrl.includes(':predict')
        ? { instances: [{ prompt: fullPrompt }], parameters: { sampleCount: 1, aspectRatio: '16:9', safetyFilterLevel: 'block_few', personGeneration: 'dont_allow' } }
        : { contents: [{ parts: [{ text: fullPrompt }] }], generationConfig: { imageGenerationConfig: { numberOfImages: 1, aspectRatio: '16:9' } } };

      console.log(`[ImageGen] URL: ${resolvedImagenUrl}?key=***`);

      imagenRes = await fetch(`${resolvedImagenUrl}?key=${resolvedImageApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imagenBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!imagenRes.ok) {
      const errBody = await imagenRes.text().catch(() => '');
      logUsage({ provider: 'imagen', model: 'imagen-4', operation: 'thumbnail-render', articleSlug: article.slug, trigger: 'manual', imageCount: 0, durationMs: Date.now() - _imgStart, success: false, error: `${imagenRes.status}: ${errBody.slice(0, 200)}`, tenantId: req.tenantId }).catch(() => {});
      throw new Error(`Imagen API ${imagenRes.status}: ${errBody.slice(0, 300)}`);
    }

    const imagenData = await imagenRes.json();
    console.log('[ImageGen] Response keys:', Object.keys(imagenData));
    // Try all known response shapes:
    // 1. Imagen predict API: predictions[].bytesBase64Encoded
    // 2. Gemini generateContent: candidates[].content.parts[].inlineData.data
    // 3. Imagen generate: generatedImages[].image.imageBytes
    const b64 = imagenData?.predictions?.[0]?.bytesBase64Encoded
             || imagenData?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data
             || imagenData?.generatedImages?.[0]?.image?.imageBytes
             || imagenData?.images?.[0]?.bytesBase64Encoded;
    if (!b64) {
      console.error('[ImageGen] Unexpected response shape:', JSON.stringify(imagenData).slice(0, 1000));
      throw new Error('Imagen returned no image data');
    }

    logUsage({ provider: 'imagen', model: 'imagen-4', operation: 'thumbnail-render', articleSlug: article.slug, trigger: 'manual', imageCount: 1, durationMs: Date.now() - _imgStart, tenantId: req.tenantId }).catch(() => {});

    const pngBuf  = Buffer.from(b64, 'base64');
    const randHex  = require('crypto').randomBytes(8).toString('hex');
    const filename = `img-${randHex}-${Date.now()}.png`;
    const imageUrl = await storeImage(pngBuf, filename, req.tenantId);

    await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(imageUrl, articleId, req.tenantId);

    await logAudit(req, 'media.generate-image', 'article', articleId, { title: article.title });
    res.json({ imageUrl, visualConcept: visualResult ? visualResult.concept : null, fullPrompt });
  } catch (err) {
    console.error('[Media] Image generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// DELETE /api/media/audio/:id
router.delete('/audio/:id', auth, requirePermission('media.delete'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  await deleteAudio(article.audio_url, req.tenantId);
  await db.prepare("UPDATE articles SET audio_url = NULL, audio_status = NULL, updated_at = NOW() WHERE id = $1 AND tenant_id = $2").run(req.params.id, req.tenantId);
  await logAudit(req, 'media.delete-audio', 'article', parseInt(req.params.id), { title: article.title });
  res.json({ message: 'Audio removed' });
}));

// PUT /api/media/toggle/:id
router.put('/toggle/:id', auth, requirePermission('media.create'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT id, media_enabled FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const newVal = article.media_enabled ? 0 : 1;
  await db.prepare("UPDATE articles SET media_enabled = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3").run(newVal, req.params.id, req.tenantId);
  res.json({ media_enabled: newVal });
}));

module.exports = router;
