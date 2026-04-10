/**
 * Deep Feed AI — Media helper functions
 * Extracted from routes/media.js for reuse in synthesis pipeline.
 */
const db   = require('../db');
const { toSlug }              = require('./utils');
const { decryptSetting }      = require('./crypto');
const { logUsage } = require('./ai-usage');
const { canSpend } = require('./budget');
const storage = require('./storage');
const { getAppConfig } = require('./app-config');
const { getGeminiKey, getImagenModel, getImagenUrl } = require('./gemini-config');
const { complete: aiComplete } = require('./ai-router');

const { getSiteConfig } = require('./site-config');

/**
 * Ask Gemini to produce a visual concept + color/mood direction for an article thumbnail.
 * Returns { concept, style } or null on failure.
 */
async function getVisualConcept(title, summary, category, tenantId, trigger = 'auto') {
  // Pull site name for niche context
  let siteName = 'a news site';
  try {
    const sc = await getSiteConfig(tenantId);
    if (sc.name) siteName = sc.name;
  } catch { /* use default */ }

  const cleanSummary = (summary || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const { loadPrompt } = require('./prompt-loader');
  const p = loadPrompt('thumbnail-concept');
  const { messages, ...meta } = p.render({
    siteName, title, cleanSummary,
    category: category || 'General',
  });

  try {
    const result = await aiComplete({
      ...meta, messages, tenantId, trigger,
    });

    if (!result) return null; // budget denied
    const raw = (result.text || '').trim();
    if (!raw) return null;

    // Parse CONCEPT: / STYLE: format
    const conceptMatch = raw.match(/CONCEPT:\s*(.+?)(?=\nSTYLE:|$)/is);
    const styleMatch = raw.match(/STYLE:\s*(.+)/is);
    return {
      concept: conceptMatch ? conceptMatch[1].trim() : raw,
      style: styleMatch ? styleMatch[1].trim() : 'cinematic lighting, sharp focus, vivid colors',
    };
  } catch { return null; }
}

/**
 * Build the full Imagen prompt from a visual concept result.
 */
function buildImagePrompt(visualResult, articleTitle) {
  const concept = visualResult
    ? visualResult.concept
    : `A dramatic scene representing: ${articleTitle}`;
  const style = visualResult
    ? visualResult.style
    : 'cinematic lighting, vivid colors, sharp focus';
  return `${concept}. ${style}, photorealistic digital art, no text, no words, no letters, no logos, sharp focus, 8K quality.`;
}

async function storeImage(pngBuf, filename, tenantId) {
  return storage.upload(pngBuf, 'image/png', `images/${filename}`, tenantId);
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

    // Storage quota check
    const { checkPlanLimit } = require('./plan-limits');
    const quota = await checkPlanLimit(tenantId, 'storage');
    if (!quota.allowed) return null;

    // Resolve API key and model (tenant → platform → env var)
    const resolvedImageApiKey = await getGeminiKey(tenantId);
    if (!resolvedImageApiKey) return null;
    const resolvedModel = await getImagenModel(tenantId);
    const resolvedImagenUrl = getImagenUrl(resolvedModel);

    const category = article.category || '';

    const visualResult = await getVisualConcept(article.title, article.summary || article.full_content, category, tenantId, 'auto');
    const fullPrompt = buildImagePrompt(visualResult, article.title);

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

    // Require a writer with an ElevenLabs voice
    if (!article.writer_id) return null;
    const writer = await db.prepare('SELECT elevenlabs_voice_id, name, avatar_url FROM writers WHERE id = $1 AND tenant_id = $2').get(article.writer_id, tenantId);
    if (!writer?.elevenlabs_voice_id) return null;

    const resolvedVoiceId = writer.elevenlabs_voice_id;
    const resolvedVoiceName = writer.name;
    const resolvedVoiceAvatarUrl = writer.avatar_url || null;

    // Budget check
    const budgetCheck = await canSpend('audio', tenantId);
    if (!budgetCheck.allowed) return null;

    // Storage quota check
    const { checkPlanLimit: checkStorageLimit } = require('./plan-limits');
    const audioQuota = await checkStorageLimit(tenantId, 'storage');
    if (!audioQuota.allowed) return null;

    const https = require('https');
    const appCfg = await getAppConfig(tenantId);
    const resolvedApiKey = appCfg.elevenlabs_api_key;

    if (!resolvedApiKey || !resolvedVoiceId) return null;

    await db.prepare("UPDATE articles SET audio_status = 'pending', updated_at = NOW() WHERE id = $1 AND tenant_id = $2").run(articleId, tenantId);

    // Build TTS text — use LLM to clean for natural speech
    const rawText = (article.summary || article.full_content || '').replace(/<[^>]+>/g, '').trim().slice(0, 1500);
    let text;
    try {
      const audioPrompt = loadPrompt('audio-clean');
      const { messages: audioMessages, ...audioMeta } = audioPrompt.render({
        title: (article.title || '').slice(0, 200),
        rawText,
      });
      const cleanResult = await aiComplete({
        ...audioMeta, messages: audioMessages, tenantId,
        skipBudget: false,
        trigger: 'auto-audio',
      });
      text = cleanResult?.text?.trim() || null;
    } catch { /* fall through to regex fallback */ }

    // Fallback: basic regex cleanup if LLM unavailable
    if (!text) {
      text = rawText
        .replace(/\[\d+\]/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/#\w+/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 900);
      text = `${article.title}. ${text}`.slice(0, 900);
    }

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

/**
 * Generate and store inline images for original and deep-dive articles.
 * @param {number} articleId
 * @param {number} tenantId
 * @returns {Array|null} final inline_images array
 */
async function generateInlineImages(articleId, tenantId) {
  try {
    const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, tenantId);
    if (!article || !article.full_content) return null;
    if (article.content_type !== 'original' && article.content_type !== 'deep-dive') return null;

    // Storage quota check
    const { checkPlanLimit: checkInlineQuota } = require('./plan-limits');
    const inlineQuota = await checkInlineQuota(tenantId, 'storage');
    if (!inlineQuota.allowed) return null;

    // Idempotent — bail if already has ready entries
    let existing = article.inline_images;
    if (typeof existing === 'string') try { existing = JSON.parse(existing); } catch { existing = []; }
    if (Array.isArray(existing) && existing.some(e => e.status === 'ready')) return existing;

    // Determine positions based on content type
    const positions = [];
    if (article.content_type === 'deep-dive') {
      const sections = article.full_content.split(/^## /m);
      // Skip intro (index 0), one image per section
      for (let si = 1; si < sections.length; si++) {
        const secText = sections[si];
        const nlIdx = secText.indexOf('\n');
        const secTitle = nlIdx !== -1 ? secText.substring(0, nlIdx).trim() : secText.trim();
        const secBody = nlIdx !== -1 ? secText.substring(nlIdx + 1).trim() : '';
        positions.push({
          position: si - 1,
          position_type: 'section',
          context_title: secTitle,
          context_body: secBody.slice(0, 300),
        });
      }
    } else {
      // Originals — split on double newlines
      const paragraphs = article.full_content.split(/\n\n+/).filter(p => p.trim());
      const count = paragraphs.length;
      let imagePositions = [];
      if (count <= 3) imagePositions = [0];
      else if (count === 4) imagePositions = [1];
      else imagePositions = [1, 3];

      for (const pos of imagePositions) {
        if (pos < count) {
          positions.push({
            position: pos,
            position_type: 'paragraph',
            context_title: article.title,
            context_body: paragraphs[pos].slice(0, 300),
          });
        }
      }
    }

    if (!positions.length) return null;

    // Write pending array to DB immediately
    const pendingArray = positions.map(p => ({
      position: p.position,
      position_type: p.position_type,
      url: null,
      alt: null,
      status: 'pending',
    }));
    await db.prepare('UPDATE articles SET inline_images = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
      .run(JSON.stringify(pendingArray), articleId, tenantId);

    // Resolve API key and Imagen model (tenant → platform → env var)
    const resolvedImageApiKey = await getGeminiKey(tenantId);
    if (!resolvedImageApiKey) return pendingArray;
    const resolvedInlineModel = await getImagenModel(tenantId);
    const resolvedImagenUrl = getImagenUrl(resolvedInlineModel);

    const category = article.category || '';
    const resultArray = [...pendingArray];

    // Generate each image sequentially (budget check before each)
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];

      // Budget check
      const budgetCheck = await canSpend('inline-image', tenantId);
      if (!budgetCheck.allowed) {
        // Mark remaining as skipped
        for (let j = i; j < positions.length; j++) {
          resultArray[j].status = 'skipped';
        }
        await db.prepare('UPDATE articles SET inline_images = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
          .run(JSON.stringify(resultArray), articleId, tenantId);
        break;
      }

      try {
        // Get visual concept using section-specific context
        const visualResult = await getVisualConcept(pos.context_title, pos.context_body, category, tenantId, 'auto');
        const fullPrompt = buildImagePrompt(visualResult, pos.context_title);

        // Imagen API call
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
          logUsage({ provider: 'imagen', model: 'imagen-4', operation: 'inline-image', articleSlug: article.slug, trigger: 'auto', imageCount: 0, durationMs: Date.now() - _imgStart, success: false, error: `${imagenRes.status}: ${errBody.slice(0, 200)}`, tenantId }).catch(() => {});
          resultArray[i].status = 'failed';
          await db.prepare('UPDATE articles SET inline_images = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
            .run(JSON.stringify(resultArray), articleId, tenantId);
          continue;
        }

        const imagenData = await imagenRes.json();
        const b64 = imagenData?.predictions?.[0]?.bytesBase64Encoded;
        if (!b64) {
          resultArray[i].status = 'failed';
          await db.prepare('UPDATE articles SET inline_images = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
            .run(JSON.stringify(resultArray), articleId, tenantId);
          continue;
        }

        logUsage({ provider: 'imagen', model: 'imagen-4', operation: 'inline-image', articleSlug: article.slug, trigger: 'auto', imageCount: 1, durationMs: Date.now() - _imgStart, tenantId }).catch(() => {});

        const pngBuf = Buffer.from(b64, 'base64');
        const randHex = require('crypto').randomBytes(8).toString('hex');
        const filename = `inline-${randHex}-${Date.now()}.png`;
        const imageUrl = await storeImage(pngBuf, filename, tenantId);

        resultArray[i].url = imageUrl;
        resultArray[i].alt = visualResult ? visualResult.concept : pos.context_title;
        resultArray[i].status = 'ready';

        // Progressive persistence
        await db.prepare('UPDATE articles SET inline_images = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
          .run(JSON.stringify(resultArray), articleId, tenantId);
      } catch (err) {
        console.error(`[media-helpers] generateInlineImages position ${i} error:`, err.message);
        resultArray[i].status = 'failed';
        await db.prepare('UPDATE articles SET inline_images = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
          .run(JSON.stringify(resultArray), articleId, tenantId);
      }
    }

    return resultArray;
  } catch (err) {
    console.error('[media-helpers] generateInlineImages error:', err.message);
    return null;
  }
}

async function deleteImage(imageUrl, tenantId) {
  if (!imageUrl) return;
  const match = imageUrl.match(/images\/([^/?#]+)/);
  if (match) {
    try { await storage.remove(`images/${match[1]}`, tenantId); } catch { /* best effort */ }
  }
}

async function deleteAudio(audioUrl, tenantId) {
  if (!audioUrl) return;
  const match = audioUrl.match(/audio\/([^/?#]+)/);
  if (match) {
    try { await storage.remove(`audio/${match[1]}`, tenantId); } catch { /* best effort */ }
  }
}

module.exports = { getVisualConcept, buildImagePrompt, storeImage, generateAndStoreImage, generateAudioForArticle, generateInlineImages, deleteImage, deleteAudio };
