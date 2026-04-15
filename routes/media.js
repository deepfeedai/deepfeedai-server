/**
 * Deep Feed AI Admin — /api/media
 * Media generation (audio, images) and user image uploads.
 * Production: uploads to Cloudflare R2, stores CDN URL in DB.
 * Local dev: saves to public/media/ (R2 env vars not set).
 */
const express = require('express');
const router  = require('express').Router();
const crypto  = require('crypto');
const multer  = require('multer');
const db      = require('../db');

const { auth }               = require('../middleware/auth');
const { requirePermission }  = require('../middleware/permissions');
const { toSlug, asyncHandler } = require('../lib/utils');
const storage = require('../lib/storage');
const { getAppConfig } = require('../lib/app-config');
const { logUsage } = require('../lib/ai-usage');
const { complete: aiComplete, generateVoice, generateImage: aiGenerateImage } = require('../lib/ai-router');
const { checkPlanLimit } = require('../lib/plan-limits');
const { requireFeature }               = require('../middleware/feature-gate');
const { logAudit }                      = require('../middleware/audit');

// Multer config for user image uploads
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_MIMES.has(file.mimetype));
  },
});
const MAX_CHARS     = 900;

async function getAiSummary(title, rawSummary, tenantId) {
  const prompt = `You are a professional news anchor. Write a concise 2-3 sentence spoken summary of this AI news article for a text-to-speech audio player. Use natural spoken language — no bullet points, no markdown, no hashtags. Sound engaging and informative.

Article title: ${title}
Article summary: ${(rawSummary || '').replace(/<[^>]+>/g, '').slice(0, 800)}

Spoken summary:`;

  try {
    const result = await aiComplete({
      operation: 'audio-script',
      tenantId,
      messages: [{ role: 'user', content: prompt }],
      trigger: 'manual',
    });
    if (!result) return null; // budget denied or no API key
    return result.text?.trim() || null;
  } catch { return null; }
}

async function buildTtsText(title, summary, source, tenantId) {
  const aiSummary = await getAiSummary(title, summary, tenantId);
  const body = aiSummary || (summary || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 700);
  return `From ${source}. ${title}. ${body}`.slice(0, MAX_CHARS);
}

/**
 * Generate TTS through ai-router. voiceId is required. tenantId + operation drive
 * provider selection + usage logging. Returns the raw mp3 Buffer for backward compat.
 */
async function generateSpeech(text, voiceId, tenantId, operation = 'voice-chat', articleSlug = null) {
  if (!voiceId) throw new Error('Voice ID not configured');
  const result = await generateVoice({
    operation,
    tenantId,
    text,
    voiceId,
    articleSlug,
    trigger: 'manual',
    skipBudget: true,
  });
  if (!result) throw new Error('Voice generation denied by budget');
  return result.audio;
}

async function storeAudio(mp3Buf, filename, tenantId) {
  return storage.upload(mp3Buf, 'audio/mpeg', `audio/${filename}`, tenantId);
}

// deleteAudio delegated to lib/media-helpers.js (canonical location)
async function deleteAudio(audioUrl, tenantId) {
  return deleteAudioHelper(audioUrl, tenantId);
}

// POST /api/media/upload — upload a user-provided image
router.post('/upload', auth, requirePermission('media.create'), imageUpload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No valid image file provided. Accepted: PNG, JPEG, WebP, GIF (max 10MB)' });
  }

  // Validate actual file content via magic bytes — don't trust client-reported MIME
  const fileType = require('file-type');
  const detected = await fileType.fromBuffer(req.file.buffer);
  if (!detected || !ALLOWED_MIMES.has(detected.mime)) {
    return res.status(400).json({ error: 'Invalid file type. File content does not match an allowed image format.' });
  }
  // Override client-reported MIME with detected MIME for storage
  req.file.mimetype = detected.mime;

  const quota = await checkPlanLimit(req.tenantId, 'storage');
  if (!quota.allowed) {
    return res.status(403).json({ error: 'Storage limit reached. Upgrade your plan for more space.', current: quota.current, max: quota.max });
  }

  const ext = storage.extFromMime(req.file.mimetype);
  const randHex = crypto.randomBytes(8).toString('hex');
  const filename = `upload-${randHex}-${Date.now()}.${ext}`;
  const imageUrl = await storage.upload(req.file.buffer, req.file.mimetype, `images/${filename}`, req.tenantId);

  await logAudit(req, 'media.upload', 'media', null, { filename, size: req.file.size, mime: req.file.mimetype });
  res.json({ imageUrl, size: req.file.size });
}));

// POST /api/media/generate-audio  { articleId, voiceId? }
router.post('/generate-audio', auth, requirePermission('media.create'), requireFeature('audio'), asyncHandler(async (req, res) => {
  const storageQuota = await checkPlanLimit(req.tenantId, 'storage');
  if (!storageQuota.allowed) {
    return res.status(403).json({ error: 'Storage limit reached. Upgrade your plan for more space.', current: storageQuota.current, max: storageQuota.max });
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

    const text   = await buildTtsText(article.title, article.summary, article.source || 'Deep Feed AI', req.tenantId);
    const mp3Buf = await generateSpeech(text, resolvedVoiceId, req.tenantId, 'audio', article.slug);
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
    // ai-router already logged the underlying provider failure — log a thin wrapper failure for visibility.
    logUsage({ provider: 'ai-router', operation: 'audio', articleSlug: article.slug, trigger: 'manual', success: false, error: err.message, tenantId: req.tenantId }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
}));

// POST /api/media/preview-voice  { voice_id, text? }
router.post('/preview-voice', auth, requirePermission('writers.read'), asyncHandler(async (req, res) => {
  const { voice_id, text } = req.body || {};
  if (!voice_id) return res.status(400).json({ error: 'voice_id required' });

  const previewText = (text && text.trim()) ? text.trim().slice(0, 500) : 'Hello! This is a preview of how I sound as your AI news anchor. Stay tuned for the latest updates.';
  const mp3Buf = await generateSpeech(previewText, voice_id, req.tenantId, 'voice-chat', null);
  res.json({ audio: mp3Buf.toString('base64'), mimeType: 'audio/mpeg' });
}));

// POST /api/media/generate-image  { articleId }
const { getVisualConcept, buildImagePrompt, storeImage, deleteImage, deleteAudio: deleteAudioHelper } = require('../lib/media-helpers');

router.post('/generate-image', auth, requirePermission('media.create'), requireFeature('image_generation'), asyncHandler(async (req, res) => {
  const imgStorageQuota = await checkPlanLimit(req.tenantId, 'storage');
  if (!imgStorageQuota.allowed) {
    return res.status(403).json({ error: 'Storage limit reached. Upgrade your plan for more space.', current: imgStorageQuota.current, max: imgStorageQuota.max });
  }

  const { articleId } = req.body;
  if (!articleId) return res.status(400).json({ error: 'articleId required' });

  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot generate image for archived article' });

  try {
    // Clean up old image if replacing
    await deleteImage(article.image_url, req.tenantId);

    const category = article.category || '';

    // Step 1: Get visual concept + style from Gemini
    const visualResult = await getVisualConcept(article.title, article.summary, category, req.tenantId, 'manual');

    // Step 2: Assemble full Imagen prompt
    const fullPrompt = buildImagePrompt(visualResult, article.title);

    console.log(`[ImageGen] Article ${articleId}: "${article.title}"`);
    console.log(`[ImageGen] Visual concept: ${visualResult ? visualResult.concept : 'fallback'}`);
    console.log(`[ImageGen] Full prompt: ${fullPrompt}`);

    let imageResult;
    try {
      imageResult = await aiGenerateImage({
        tenantId: req.tenantId,
        prompt: fullPrompt,
        operation: 'thumbnail-render',
        aspectRatio: '16:9',
        articleSlug: article.slug,
        trigger: 'manual',
      });
    } catch (err) {
      if (err.code === 'MISSING_KEY') {
        return res.status(500).json({ error: 'Gemini/Imagen API key not configured — set it in Settings > Integrations or GEMINI_API_KEY env var' });
      }
      throw err;
    }
    const b64 = imageResult.b64;

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

// POST /api/media/regenerate-local-images — find articles with local image paths and re-generate via R2
router.post('/regenerate-local-images', auth, requirePermission('media.create'), asyncHandler(async (req, res) => {
  const { generateAndStoreImage } = require('../lib/media-helpers');
  const limit = Math.min(parseInt(req.body.limit) || 20, 50);
  const dryRun = req.body.dry_run === true;

  // Find articles with local filesystem image paths (lost on Railway redeploy)
  const articles = await db.prepare(`
    SELECT id, title, image_url FROM articles
    WHERE tenant_id = $1
      AND image_url IS NOT NULL
      AND image_url LIKE '/media/%'
      AND (is_archived = 0 OR is_archived IS NULL)
    ORDER BY is_featured DESC, is_published DESC, created_at DESC
    LIMIT $2
  `).all(req.tenantId, limit);

  if (dryRun) {
    return res.json({
      dry_run: true,
      count: articles.length,
      articles: articles.map(a => ({ id: a.id, title: a.title, image_url: a.image_url })),
    });
  }

  let regenerated = 0, failed = 0;
  const results = [];

  for (const article of articles) {
    try {
      // Clear local image_url so generateAndStoreImage will process it
      await db.prepare('UPDATE articles SET image_url = NULL, updated_at = NOW() WHERE id = $1 AND tenant_id = $2')
        .run(article.id, req.tenantId);

      const newUrl = await generateAndStoreImage(article.id, req.tenantId);
      if (newUrl) {
        regenerated++;
        results.push({ id: article.id, title: article.title, old_url: article.image_url, new_url: newUrl, status: 'ok' });
      } else {
        // Restore old URL if generation failed (better than nothing for non-ephemeral hosts)
        await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
          .run(article.image_url, article.id, req.tenantId);
        failed++;
        results.push({ id: article.id, title: article.title, status: 'failed' });
      }
    } catch (err) {
      await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
        .run(article.image_url, article.id, req.tenantId).catch(() => {});
      failed++;
      results.push({ id: article.id, title: article.title, status: 'error', error: err.message });
    }
  }

  await logAudit(req, 'media.regenerate-local-images', 'articles', null, { regenerated, failed, total: articles.length });
  res.json({ regenerated, failed, total: articles.length, results });
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
