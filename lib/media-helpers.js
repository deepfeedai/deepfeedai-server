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
const {replaceImage} = require('./image-persistence');
const {assertImageAllowed} = require('./image-policy');
const {imageError, publicImageError, decodePng} = require('./image-errors');
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
  const article = await db.prepare('SELECT * FROM articles WHERE id=$1 AND tenant_id=$2').get(articleId,tenantId);
  if (!article || article.is_archived || article.image_url) return null;
  return regenerateArticleImage(articleId,tenantId,{trigger:'auto'});
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
async function generateInlineImages(articleId, tenantId, {replace=false} = {}) {
  const article=await db.prepare('SELECT * FROM articles WHERE id=$1 AND tenant_id=$2').get(articleId,tenantId);
  if (!article || article.is_archived || !article.full_content || !['original','deep-dive'].includes(article.content_type)) return [];
  await assertImageAllowed(tenantId,'inline-image');
  let previous=article.inline_images;
  if (typeof previous==='string') previous=JSON.parse(previous || '[]');
  previous=Array.isArray(previous)?previous:[];
  if (!replace && previous.some(e=>e.status==='ready')) return previous;
  const paragraphs=article.content_type==='deep-dive'
    ? article.full_content.split(/^## /m).slice(1,2)
    : article.full_content.split(/\n\n+/).filter(p=>p.trim());
  const positions=article.content_type==='deep-dive'?[0]:paragraphs.length<=3?[0]:paragraphs.length===4?[1]:[1,3];
  const stored=[...previous]; const outcomes=[]; const uploaded=[];
  const art=await getArtDirection(tenantId,'thumbnails');
  try {
    for (const position of positions.filter(p=>p<paragraphs.length)) {
      const position_type=article.content_type==='deep-dive'?'section':'paragraph';
      try {
        const visual=await getVisualConcept(article.title,paragraphs[position].slice(0,300),article.category,tenantId,'manual');
        const prompt=buildImagePrompt(visual,article.title,{category:article.category,tier:deriveTier(article),tenantArtDirection:art,articleType:'inline'});
        const result=await generateImage({tenantId,prompt,operation:'inline-image',aspectRatio:'16:9',articleSlug:article.slug,trigger:'manual'});
        const key='images/inline-'+require('crypto').randomUUID()+'.png';
        const url=await storage.upload(decodePng(result.b64),'image/png',key,tenantId);
        uploaded.push(key);
        const entry={position,position_type,url,alt:visual?.concept || article.title,status:'ready'};
        const index=stored.findIndex(e=>e.position===position && e.position_type===position_type);
        if(index>=0) stored[index]=entry; else stored.push(entry);
        outcomes.push({position,status:'ready'});
      } catch(e) {
        const safe=publicImageError(e);
        outcomes.push({position,status:['BUDGET_EXCEEDED','IMAGE_STORAGE','IMAGE_FEATURE'].includes(safe.code)?'skipped':'failed',...safe});
      }
    }
    if (uploaded.length) {
      const row=await db.prepare('UPDATE articles SET inline_images=$1::jsonb,updated_at=NOW() WHERE id=$2 AND tenant_id=$3 AND inline_images IS NOT DISTINCT FROM $4::jsonb RETURNING id').get(JSON.stringify(stored),articleId,tenantId,article.inline_images==null?null:JSON.stringify(typeof article.inline_images==='string'?JSON.parse(article.inline_images):article.inline_images));
      if(!row) throw imageError('IMAGE_CONFLICT');
    }
  } catch(e) {if(e.code==='IMAGE_CONFLICT') for(const key of uploaded) await storage.remove(key,tenantId).catch(()=>{});throw imageError(e.code==='IMAGE_CONFLICT'?e.code:'IMAGE_FAILED');}
  // Preserve old files until a successful DB update; only unreferenced local assets are removed.
  if(uploaded.length) for(const old of previous) if(old.url?.startsWith(`/media/tenants/${tenantId}/images/`) && !stored.some(e=>e.url===old.url)) await deleteImage(old.url,tenantId);
  return {images:stored,outcomes,generated:outcomes.filter(e=>e.status==='ready').length,failed:outcomes.filter(e=>e.status==='failed').length,skipped:outcomes.filter(e=>e.status==='skipped').length};
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
    if (!article || article.is_archived) return null;
    await assertImageAllowed(tenantId,'thumbnail-render');





    const category = article.category || '';
    const visualResult = await getVisualConcept(article.title, article.summary || article.full_content, category, tenantId, opts.trigger || 'manual');
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
        trigger: opts.trigger || 'manual',
      });
      b64 = result.b64;
    } catch (err) {
      throw err;
    }

    const imageUrl = await replaceImage({table:'articles',id:articleId,tenantId,oldUrl:article.image_url,b64});

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
        `).run(JSON.stringify({ ...meta, sentiment: visualResult?.sentiment || null, generated_at: new Date().toISOString(), regenerated_by: opts.trigger || 'manual' }), articleId, tenantId);
      }
    } catch { /* non-fatal */ }

    return imageUrl;
  } catch (err) {
    throw err;
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

    await assertImageAllowed(tenantId,'writer-avatar');

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
      throw err;
    }

    const avatarUrl = await replaceImage({table:'writers',id:writerId,tenantId,oldUrl:writer.avatar_url,b64:imageResult.b64});

    return avatarUrl;
  } catch (err) {
    throw err;
  }
}

module.exports = {
  getVisualConcept, buildImagePrompt, storeImage, getArtDirection,
  generateAndStoreImage,
  generateAudioForArticle, generateInlineImages, deleteImage, deleteAudio,
  generateVoiceResponse, regenerateArticleImage, regenerateWriterAvatarImage,
};
