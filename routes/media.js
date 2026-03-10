/**
 * Deep Feed AI Admin — /api/media
 * ElevenLabs audio generation.
 * Production: uploads MP3 to Cloudflare R2, stores CDN URL in DB.
 * Local dev: saves MP3 to public/media/audio/ (R2 env vars not set).
 */
const express = require('express');
const router  = express.Router();
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const db      = require('../db');

const JWT_SECRET    = process.env.JWT_SECRET      || 'deepfeedai_super_secret_jwt_key_2026';
const EL_API_KEY    = process.env.ELEVENLABS_API_KEY;
const EL_VOICE_ID   = process.env.ELEVENLABS_VOICE_ID;
const { getPool }   = require('../db');
const AUDIO_DIR     = path.join(__dirname, '..', 'public', 'media', 'audio');
const MAX_CHARS     = 900;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL  = 'gemini-2.5-flash-lite';
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// R2 config (optional — falls back to local file storage)
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

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function toSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
}

async function getAiSummary(title, rawSummary) {
  if (!GEMINI_API_KEY) return null;
  const prompt = `You are a professional news anchor. Write a concise 2-3 sentence spoken summary of this AI news article for a text-to-speech audio player. Use natural spoken language — no bullet points, no markdown, no hashtags. Sound engaging and informative.

Article title: ${title}
Article summary: ${(rawSummary || '').replace(/<[^>]+>/g, '').slice(0, 800)}

Spoken summary:`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch { return null; }
}

async function buildTtsText(title, summary, source) {
  const aiSummary = await getAiSummary(title, summary);
  const body = aiSummary || (summary || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 700);
  return `From ${source}. ${title}. ${body}`.slice(0, MAX_CHARS);
}

function generateSpeech(text, voiceId, apiKey) {
  const resolvedVoiceId = voiceId || EL_VOICE_ID;
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

async function storeAudio(mp3Buf, filename) {
  if (R2_CONFIGURED) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = getR2Client();
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         `audio/${filename}`,
      Body:        mp3Buf,
      ContentType: 'audio/mpeg',
    }));
    const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    return `${publicUrl}/audio/${filename}`;
  }
  // Local fallback
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUDIO_DIR, filename), mp3Buf);
  return `/media/audio/${filename}`;
}

async function deleteAudio(audioUrl) {
  if (!audioUrl) return;
  if (audioUrl.startsWith('http')) {
    if (R2_CONFIGURED) {
      try {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        const s3  = getR2Client();
        const key = `audio/${path.basename(audioUrl)}`;
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
      } catch { /* best effort */ }
    }
  } else {
    try { fs.unlinkSync(path.join(__dirname, '..', 'public', audioUrl)); } catch { /* already gone */ }
  }
}

// POST /api/media/generate-audio  { articleId, voiceId? }
router.post('/generate-audio', auth, async (req, res) => {
  const { articleId, voiceId } = req.body;
  if (!articleId) return res.status(400).json({ error: 'articleId required' });

  const article = await db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot generate audio for archived article' });

  await db.prepare("UPDATE articles SET audio_status = 'pending', updated_at = NOW() WHERE id = ?").run(articleId);

  try {
    // Resolve voice: explicit voiceId → default voice → env vars
    let resolvedVoiceId = EL_VOICE_ID;
    let resolvedVoiceName = null;
    let resolvedVoiceAvatarUrl = null;

    if (voiceId) {
      const v = await db.prepare('SELECT * FROM voices WHERE id = ?').get(voiceId);
      if (v) {
        resolvedVoiceId = v.voice_id;
        resolvedVoiceName = v.name;
        resolvedVoiceAvatarUrl = v.avatar_url || null;
      }
    } else {
      const defaultVoice = await db.prepare('SELECT * FROM voices WHERE is_default = 1 LIMIT 1').get();
      if (defaultVoice) {
        resolvedVoiceId = defaultVoice.voice_id;
        resolvedVoiceName = defaultVoice.name;
        resolvedVoiceAvatarUrl = defaultVoice.avatar_url || null;
      }
    }

    // Resolve API key: settings table → env var
    let resolvedApiKey = EL_API_KEY;
    const apiKeySetting = await db.prepare("SELECT value FROM settings WHERE key = 'elevenlabs_api_key'").get();
    if (apiKeySetting && apiKeySetting.value) resolvedApiKey = apiKeySetting.value;

    const text     = await buildTtsText(article.title, article.summary, article.source || 'Deep Feed AI');
    const mp3Buf   = await generateSpeech(text, resolvedVoiceId, resolvedApiKey);
    const slug     = toSlug(article.title) || `article-${article.id}`;
    const filename = `${slug}-${article.id}.mp3`;
    const audioUrl = await storeAudio(mp3Buf, filename);

    await db.prepare(`
      UPDATE articles
      SET audio_url = ?, audio_status = 'ready', audio_transcript = ?,
          audio_voice_name = ?, audio_voice_avatar_url = ?, updated_at = NOW()
      WHERE id = ?
    `).run(audioUrl, text, resolvedVoiceName, resolvedVoiceAvatarUrl, articleId);

    res.json({ audioUrl, charCount: text.length, ttsText: text, voiceName: resolvedVoiceName });
  } catch (err) {
    await db.prepare("UPDATE articles SET audio_status = 'error', updated_at = NOW() WHERE id = ?").run(articleId);
    console.error('[Media] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/media/generate-image  { articleId }
const IMAGEN_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict`;
const IMAGE_DIR  = path.join(__dirname, '..', 'public', 'media', 'images');

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
  const cleanSummary = (summary || '').replace(/<[^>]+>/g, '').slice(0, 400);
  const prompt = `You are a creative director for a tech news site. Write a short visual concept (1-2 sentences, no more than 40 words) describing an abstract, cinematic image that represents this AI news article. Focus on mood, metaphor, and visual elements. No text, no people, no faces, no logos.

Article title: ${title}
Article summary: ${cleanSummary}
Category: ${category || 'Technology'}

Visual concept:`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
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

router.post('/generate-image', auth, async (req, res) => {
  const { articleId } = req.body;
  if (!articleId) return res.status(400).json({ error: 'articleId required' });

  const article = await db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot generate image for archived article' });
  // Resolve API key and model from settings (DB overrides env var)
  let resolvedImageApiKey = GEMINI_API_KEY;
  let resolvedImagenUrl = IMAGEN_URL;
  try {
    const modelSetting  = await db.prepare("SELECT value FROM settings WHERE key = 'imagen_model'").get();
    const apiKeySetting = await db.prepare("SELECT value FROM settings WHERE key = 'imagen_api_key'").get();
    if (modelSetting && modelSetting.value) {
      resolvedImagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelSetting.value}:predict`;
    }
    if (apiKeySetting && apiKeySetting.value) resolvedImageApiKey = apiKeySetting.value;
  } catch { /* fall back to defaults */ }

  if (!resolvedImageApiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    const category = article.category || '';
    const stylePreset = CATEGORY_STYLES[category] || DEFAULT_STYLE;

    // Step 1: Get visual concept from Gemini
    let visualConcept = await getVisualConcept(article.title, article.summary, category);
    if (!visualConcept) {
      visualConcept = `Abstract cinematic representation of ${article.title}, tech news visual`;
    }

    // Step 2: Assemble full prompt and call Imagen
    const fullPrompt = `${visualConcept}. ${stylePreset}. Dark background, cinematic lighting, no text, no words, no logos, no people, editorial quality, ultra detailed.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

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
      throw new Error(`Imagen API ${imagenRes.status}: ${errBody.slice(0, 300)}`);
    }

    const imagenData = await imagenRes.json();
    const b64 = imagenData?.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error('Imagen returned no image data');

    const pngBuf  = Buffer.from(b64, 'base64');
    const randHex  = require('crypto').randomBytes(8).toString('hex');
    const filename = `img-${randHex}-${Date.now()}.png`;
    const imageUrl = await storeImage(pngBuf, filename);

    await db.prepare('UPDATE articles SET image_url = ?, updated_at = NOW() WHERE id = ?').run(imageUrl, articleId);

    res.json({ imageUrl });
  } catch (err) {
    console.error('[Media] Image generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/media/audio/:id
router.delete('/audio/:id', auth, async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  await deleteAudio(article.audio_url);
  await db.prepare("UPDATE articles SET audio_url = NULL, audio_status = NULL, updated_at = NOW() WHERE id = ?").run(req.params.id);
  res.json({ message: 'Audio removed' });
});

// PUT /api/media/toggle/:id
router.put('/toggle/:id', auth, async (req, res) => {
  const article = await db.prepare('SELECT id, media_enabled FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const newVal = article.media_enabled ? 0 : 1;
  await db.prepare("UPDATE articles SET media_enabled = ?, updated_at = NOW() WHERE id = ?").run(newVal, req.params.id);
  res.json({ media_enabled: newVal });
});

module.exports = router;
