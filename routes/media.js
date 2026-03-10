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
