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
const { complete: aiComplete, generateImage, generateVoice } = require('./ai-router');
const { loadPrompt } = require('./prompt-loader');
const { composeImagePrompt } = require('./prompts/composer');

const { getSiteConfig } = require('./site-config');

/**
 * Lightweight fetch for tenant-level art_direction setting (plain key-value).
 *
 * Reads per-target keys with backward-compatible fallback to the legacy
 * `art_direction` setting:
 *   - target='avatars'    → `art_direction_avatars`    → legacy `art_direction`
 *   - target='thumbnails' → `art_direction_thumbnails` → legacy `art_direction`
 *
 * @param {number} tenantId
 * @param {'thumbnails'|'avatars'} [target='thumbnails']
 * @returns {Promise<string|null>}
 */
async function getArtDirection(tenantId, target = 'thumbnails') {
  const primaryKey = target === 'avatars' ? 'art_direction_avatars' : 'art_direction_thumbnails';
  try {
    const row = await db.prepare(
      'SELECT value FROM settings WHERE tenant_id = $1 AND key = $2'
    ).get(tenantId, primaryKey);
    if (row && row.value) return row.value;
  } catch { /* fall through to legacy */ }
  try {
    const legacy = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'art_direction'"
    ).get(tenantId);
    return legacy && legacy.value ? legacy.value : null;
  } catch { return null; }
}

/** Map article story-level / tier hints to composer tier tokens. */
function deriveTier(article) {
  if (!article) return null;
  const lvl = (article.story_level || article.level || '').toString().toLowerCase();
  if (lvl.includes('breaking')) return 'breaking';
  if (lvl.includes('major')) return 'major';
  if (lvl.includes('trending')) return 'trending';
  if (lvl) return 'standard';
  return null;
}

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

    // Parse CONCEPT: / STYLE: / SENTIMENT: format
    const conceptMatch = raw.match(/CONCEPT:\s*(.+?)(?=\nSTYLE:|$)/is);
    const styleMatch = raw.match(/STYLE:\s*(.+?)(?=\nSENTIMENT:|$)/is);
    const sentimentMatch = raw.match(/SENTIMENT:\s*(\w+)/i);
    return {
      concept: conceptMatch ? conceptMatch[1].trim() : raw,
      style: styleMatch ? styleMatch[1].trim() : 'cinematic lighting, sharp focus, vivid colors',
      sentiment: sentimentMatch ? sentimentMatch[1].trim().toLowerCase() : null,
    };
  } catch { return null; }
}

/**
 * Build the full Imagen prompt from a visual concept result.
 *
 * v2: Delegates styling to the composer, which rotates across 8 style
 * families based on category + deterministic jitter, chooses a mood from
 * story tier, and applies a shared negative-trope list. The Gemini
 * pre-pass (getVisualConcept) still provides the concept; this function
 * wraps that concept with stylistic variety.
 *
 * @param {{concept?: string, style?: string}|null} visualResult
 * @param {string} articleTitle
 * @param {object} [opts]
 * @param {string} [opts.category]
 * @param {string} [opts.tier]                breaking|major|trending|standard
 * @param {string|object} [opts.tenantArtDirection]
 * @param {string} [opts.articleType]         'article' | 'inline' | 'writer-avatar'
 * @param {string} [opts.writerTone]
 * @returns {string} final prompt string (legacy callers get the string only)
 */
function buildImagePrompt(visualResult, articleTitle, opts = {}) {
  const concept = visualResult && visualResult.concept
    ? visualResult.concept
    : `A dramatic scene representing: ${articleTitle}`;

  const composed = composeImagePrompt({
    concept,
    category: opts.category,
    tier: opts.tier,
    sentiment: visualResult && visualResult.sentiment ? visualResult.sentiment : null,
    tenantArtDirection: opts.tenantArtDirection,
    articleType: opts.articleType || 'article',
    writerTone: opts.writerTone,
    customNotes: opts.customNotes,
    styleOverride: opts.styleOverride,
    moodOverride: opts.moodOverride,
    compositionOverride: opts.compositionOverride,
  });
  // Attach composed meta non-enumerably on the returned string so legacy
  // callers still get the prompt string but new callers can inspect style.
  // Easier: stash on opts so caller can read it back.
  if (opts && typeof opts === 'object') {
    opts._composed = {
      style: composed.style,
      mood: composed.mood,
      composition: composed.composition,
    };
  }
  return composed.prompt;
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

    const category = article.category || '';

    // Reuse previously generated concept if stored in synthesis_meta (avoids redundant LLM call on regen)
    let visualResult = null;
    const existingMeta = typeof article.synthesis_meta === 'string'
      ? JSON.parse(article.synthesis_meta || '{}')
      : (article.synthesis_meta || {});
    if (existingMeta?.image?.concept) {
      visualResult = {
        concept:   existingMeta.image.concept,
        style:     existingMeta.image.style     || null,
        sentiment: existingMeta.image.sentiment || null,
      };
    } else {
      visualResult = await getVisualConcept(article.title, article.summary || article.full_content, category, tenantId, 'auto');
    }
    const tenantArtDirection = await getArtDirection(tenantId, 'thumbnails');
    const tier = deriveTier(article);
    const buildOpts = {
      category,
      tier,
      tenantArtDirection,
      articleType: 'article',
    };
    const fullPrompt = buildImagePrompt(visualResult, article.title, buildOpts);

    let b64;
    try {
      const result = await generateImage({
        tenantId,
        prompt: fullPrompt,
        operation: 'thumbnail-render',
        aspectRatio: '16:9',
        articleSlug: article.slug,
        trigger: 'auto',
      });
      b64 = result.b64;
    } catch (err) {
      console.error('[media-helpers] thumbnail generateImage failed:', err.message);
      return null;
    }

    const pngBuf   = Buffer.from(b64, 'base64');
    const randHex  = require('crypto').randomBytes(8).toString('hex');
    const filename = `img-${randHex}-${Date.now()}.png`;
    const imageUrl = await storeImage(pngBuf, filename, tenantId);

    await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(imageUrl, articleId, tenantId);

    // Record composed style metadata on synthesis_meta.image so the designer
    // agent can review what's been published. Non-fatal on failure.
    try {
      const meta = buildOpts._composed || null;
      if (meta) {
        await db.prepare(`
          UPDATE articles
          SET synthesis_meta = jsonb_set(
                COALESCE(synthesis_meta, '{}'::jsonb),
                '{image}',
                $1::jsonb,
                true
              ),
              updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3
        `).run(JSON.stringify({ ...meta, concept: visualResult?.concept || null, sentiment: visualResult?.sentiment || null, generated_at: new Date().toISOString() }), articleId, tenantId);
      }
    } catch (metaErr) {
      console.warn('[media-helpers] failed to record synthesis_meta.image:', metaErr.message);
    }

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
    const writer = await db.prepare('SELECT elevenlabs_voice_id, name, avatar_url, beat, tone FROM writers WHERE id = $1 AND tenant_id = $2').get(article.writer_id, tenantId);
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

    await db.prepare("UPDATE articles SET audio_status = 'pending', updated_at = NOW() WHERE id = $1 AND tenant_id = $2").run(articleId, tenantId);

    // Strip HTML/markdown from summary to use as article context for the intro prompt
    const summary = (article.summary || article.full_content || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[\d+\]/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);

    // Build TTS script — writer-voiced intro (hook, stakes, angle) via audio-intro prompt
    let text;
    try {
      const audioPrompt = loadPrompt('audio-intro');
      const { messages: audioMessages, ...audioMeta } = audioPrompt.render({
        writerName: writer.name || 'Your correspondent',
        beats:      writer.beat || 'AI and technology',
        tone:       writer.tone || 'informative and direct',
        title:      (article.title || '').slice(0, 200),
        summary,
      });
      const introResult = await aiComplete({
        ...audioMeta, messages: audioMessages, tenantId,
        skipBudget: false,
        trigger: 'auto-audio',
      });
      text = introResult?.text?.trim() || null;
    } catch { /* fall through to regex fallback */ }

    // Fallback: plain summary when LLM unavailable
    if (!text) {
      text = `${article.title}. ${summary}`.slice(0, 900);
    }

    // Generate speech via ai-router (routes to ElevenLabs by default, honors per-tenant overrides)
    const voiceResult = await generateVoice({
      operation: 'audio',
      tenantId,
      text,
      voiceId: resolvedVoiceId,
      articleSlug: article.slug,
      trigger: 'auto',
      skipBudget: true, // already checked above
    });
    if (!voiceResult) return null;
    const mp3Buf = voiceResult.audio;

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
    // ai-router already logged the per-provider failure; log a thin wrapper failure for visibility.
    logUsage({ provider: 'ai-router', operation: 'audio', trigger: 'auto', success: false, error: err.message, tenantId }).catch(() => {});
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
      // One hero image only — use the first section for context
      const sections = article.full_content.split(/^## /m);
      if (sections.length > 1) {
        const secText = sections[1];
        const nlIdx = secText.indexOf('\n');
        const secTitle = nlIdx !== -1 ? secText.substring(0, nlIdx).trim() : secText.trim();
        const secBody  = nlIdx !== -1 ? secText.substring(nlIdx + 1).trim() : '';
        positions.push({
          position:      0,
          position_type: 'section',
          context_title: secTitle,
          context_body:  secBody.slice(0, 300),
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

    const category = article.category || '';
    const tenantArtDirection = await getArtDirection(tenantId, 'thumbnails');
    const tier = deriveTier(article);
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
        const fullPrompt = buildImagePrompt(visualResult, pos.context_title, {
          category,
          tier,
          tenantArtDirection,
          articleType: 'inline',
        });

        let b64;
        try {
          const result = await generateImage({
            tenantId,
            prompt: fullPrompt,
            operation: 'inline-image',
            aspectRatio: '16:9',
            articleSlug: article.slug,
            trigger: 'auto',
          });
          b64 = result.b64;
        } catch (err) {
          console.error(`[media-helpers] inline-image position ${i} failed:`, err.message);
          resultArray[i].status = 'failed';
          await db.prepare('UPDATE articles SET inline_images = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
            .run(JSON.stringify(resultArray), articleId, tenantId);
          continue;
        }

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

/**
 * Generate a short voice response for chat messaging.
 * Reuses the ElevenLabs TTS integration from article audio.
 * @param {string} text - Response text to speak (capped at 500 chars)
 * @param {number} writerId
 * @param {number} tenantId
 * @returns {Promise<{ buffer: Buffer, contentType: string, charCount: number } | null>}
 */
async function generateVoiceResponse(text, writerId, tenantId) {
  try {
    const writer = await db.prepare(
      'SELECT elevenlabs_voice_id, name FROM writers WHERE id = $1 AND tenant_id = $2'
    ).get(writerId, tenantId);
    if (!writer?.elevenlabs_voice_id) {
      console.log(`[media-helpers] Voice: writer ${writerId} has no elevenlabs_voice_id`);
      return null;
    }

    console.log(`[media-helpers] Voice: generating for writer "${writer.name}" voice=${writer.elevenlabs_voice_id.slice(0, 8)}... text=${text.length} chars`);

    // Cap text for reasonable audio length (~30 seconds max)
    const cleanText = text
      .replace(/https?:\/\/\S+/g, '')     // remove URLs
      .replace(/\[\d+\]/g, '')            // remove citations
      .replace(/\*\*(.+?)\*\*/g, '$1')   // strip bold
      .replace(/\*(.+?)\*/g, '$1')       // strip italic
      .trim()
      .slice(0, 500);

    if (cleanText.length < 10) return null;

    const voiceResult = await generateVoice({
      operation: 'voice-chat',
      tenantId,
      text: cleanText,
      voiceId: writer.elevenlabs_voice_id,
      writerId,
      trigger: 'messaging',
      params: { timeoutMs: 15000 },
      skipBudget: true,
    });
    if (!voiceResult) return null;

    return { buffer: voiceResult.audio, contentType: voiceResult.mime, charCount: voiceResult.charCount };
  } catch (err) {
    console.error('[media-helpers] generateVoiceResponse error:', err.message);
    return null;
  }
}

/**
 * Regenerate an article thumbnail with optional style/mood/composition
 * overrides. Used by the designer agent — bypasses the "already has image"
 * guard on purpose. Goes through the same ai-router.generateImage path; no
 * direct provider calls.
 *
 * @param {number} articleId
 * @param {number} tenantId
 * @param {object} [opts]
 * @param {string} [opts.styleOverride]
 * @param {string} [opts.moodOverride]
 * @param {string} [opts.compositionOverride]
 * @param {string} [opts.customNotes]
 * @returns {Promise<string|null>} new image URL or null
 */
async function regenerateArticleImage(articleId, tenantId, opts = {}) {
  try {
    const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, tenantId);
    if (!article) return null;

    const budgetCheck = await canSpend('thumbnail-render', tenantId);
    if (!budgetCheck.allowed) return null;

    const { checkPlanLimit } = require('./plan-limits');
    const quota = await checkPlanLimit(tenantId, 'storage');
    if (!quota.allowed) return null;

    const category = article.category || '';
    const visualResult = await getVisualConcept(article.title, article.summary || article.full_content, category, tenantId, 'designer');
    const tenantArtDirection = await getArtDirection(tenantId, 'thumbnails');
    const tier = deriveTier(article);
    const buildOpts = {
      category,
      tier,
      tenantArtDirection,
      articleType: 'article',
      styleOverride: opts.styleOverride || null,
      moodOverride: opts.moodOverride || null,
      compositionOverride: opts.compositionOverride || null,
      customNotes: opts.customNotes || null,
    };
    const fullPrompt = buildImagePrompt(visualResult, article.title, buildOpts);

    let b64;
    try {
      const result = await generateImage({
        tenantId,
        prompt: fullPrompt,
        operation: 'thumbnail-render',
        aspectRatio: '16:9',
        articleSlug: article.slug,
        trigger: 'designer',
      });
      b64 = result.b64;
    } catch (err) {
      console.error('[media-helpers] regenerateArticleImage generateImage failed:', err.message);
      return null;
    }

    const pngBuf = Buffer.from(b64, 'base64');
    const randHex = require('crypto').randomBytes(8).toString('hex');
    const filename = `img-${randHex}-${Date.now()}.png`;
    const imageUrl = await storeImage(pngBuf, filename, tenantId);

    // Delete old image (best effort)
    if (article.image_url) {
      deleteImage(article.image_url, tenantId).catch(() => {});
    }

    await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(imageUrl, articleId, tenantId);

    try {
      const meta = buildOpts._composed || null;
      if (meta) {
        await db.prepare(`
          UPDATE articles
          SET synthesis_meta = jsonb_set(
                COALESCE(synthesis_meta, '{}'::jsonb),
                '{image}',
                $1::jsonb,
                true
              ),
              updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3
        `).run(JSON.stringify({ ...meta, sentiment: visualResult?.sentiment || null, generated_at: new Date().toISOString(), regenerated_by: 'designer' }), articleId, tenantId);
      }
    } catch { /* non-fatal */ }

    return imageUrl;
  } catch (err) {
    console.error('[media-helpers] regenerateArticleImage error:', err.message);
    return null;
  }
}

/**
 * Regenerate a writer avatar with optional style override. Uses the same
 * composer + ai-router path as POST /api/admin/writers/:id/generate-avatar.
 *
 * @param {number} writerId
 * @param {number} tenantId
 * @param {object} [opts]
 * @param {string} [opts.styleOverride]
 * @param {string} [opts.customNotes]
 * @returns {Promise<string|null>} new avatar URL or null
 */
async function regenerateWriterAvatarImage(writerId, tenantId, opts = {}) {
  try {
    const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, tenantId);
    if (!writer) return null;

    const budgetCheck = await canSpend('writer-avatar', tenantId);
    if (!budgetCheck.allowed) return null;

    const beats = await db.prepare(`
      SELECT c.name FROM writer_beats wb
      JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $2
      WHERE wb.writer_id = $1 AND wb.tenant_id = $2
    `).all(writerId, tenantId);
    const beatNames = beats.map(b => b.name).join(', ') || 'news';
    const toneDesc = writer.tone ? `, with a ${writer.tone.toLowerCase()} demeanor` : '';
    const genderDesc = writer.gender ? `${writer.gender} ` : '';
    const ethnicityDesc = writer.ethnicity ? `${writer.ethnicity} ` : '';
    const conceptDesc = `Portrait of a ${ethnicityDesc}${genderDesc}journalist who covers ${beatNames}${toneDesc}`;

    const tenantArtDirection = await getArtDirection(tenantId, 'avatars');
    const composed = composeImagePrompt({
      concept: conceptDesc,
      tenantArtDirection,
      articleType: 'writer-avatar',
      writerTone: writer.tone || null,
      // Per-writer overrides (writers.avatar_style_family / avatar_style_notes)
      // take effect when no explicit opts are passed, so single-writer tool calls
      // respect the saved overrides. Explicit opts always win.
      styleOverride: opts.styleOverride || writer.avatar_style_family || null,
      customNotes: opts.customNotes || writer.avatar_style_notes || null,
    });
    const prompt = `${composed.prompt} Square 1:1 aspect ratio.`;

    let imageResult;
    try {
      imageResult = await generateImage({
        tenantId,
        prompt,
        operation: 'writer-avatar',
        aspectRatio: '1:1',
        trigger: 'designer',
      });
    } catch (err) {
      console.error('[media-helpers] regenerateWriterAvatarImage generateImage failed:', err.message);
      return null;
    }

    const { extFromMime } = require('./r2');
    const ext = extFromMime('image/png');
    const filename = `writer-${writerId}-${Date.now()}.${ext}`;
    const avatarUrl = await storage.upload(Buffer.from(imageResult.b64, 'base64'), 'image/png', `avatars/${filename}`, tenantId);

    await db.prepare('UPDATE writers SET avatar_url = $1 WHERE id = $2 AND tenant_id = $3').run(avatarUrl, writerId, tenantId);
    return avatarUrl;
  } catch (err) {
    console.error('[media-helpers] regenerateWriterAvatarImage error:', err.message);
    return null;
  }
}

module.exports = {
  getVisualConcept, buildImagePrompt, storeImage, getArtDirection,
  generateAndStoreImage,
  generateAudioForArticle, generateInlineImages, deleteImage, deleteAudio,
  generateVoiceResponse, regenerateArticleImage, regenerateWriterAvatarImage,
};
