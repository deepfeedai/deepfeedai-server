/**
 * Deep Feed AI Admin — /api/media
 * ElevenLabs audio generation for article summaries.
 * Files saved to public/media/audio/{slug}.mp3 and served statically.
 */
const express = require('express');
const router  = express.Router();
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const db      = require('../db');

const JWT_SECRET      = process.env.JWT_SECRET      || 'deepfeedai_super_secret_jwt_key_2026';
const EL_API_KEY      = process.env.ELEVENLABS_API_KEY;
const EL_VOICE_ID     = process.env.ELEVENLABS_VOICE_ID;
const AUDIO_DIR       = path.join(__dirname, '..', 'public', 'media', 'audio');
const MAX_CHARS        = 900; // ElevenLabs cap per request for summaries
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const GEMINI_MODEL     = 'gemini-2.5-flash-lite';
const GEMINI_URL       = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

/** Convert title to a safe filename slug */
function toSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

/** Get an AI-polished summary from Gemini, with fallback to raw RSS summary */
async function getAiSummary(title, rawSummary) {
  if (!GEMINI_API_KEY) return null;
  const prompt = `You are a professional news anchor. Write a concise 2-3 sentence spoken summary of this AI news article for a text-to-speech audio player. Use natural spoken language — no bullet points, no markdown, no hashtags. Sound engaging and informative.

Article title: ${title}
Article summary: ${(rawSummary || '').replace(/<[^>]+>/g, '').slice(0, 800)}

Spoken summary:`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch { return null; }
}

/** Build TTS text: AI summary preferred, falls back to clean RSS summary */
async function buildTtsText(title, summary, source) {
  const aiSummary = await getAiSummary(title, summary);
  const body = aiSummary
    || (summary || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 700);
  return `From ${source}. ${title}. ${body}`.slice(0, MAX_CHARS);
}

/** Call ElevenLabs TTS API and return a Buffer of MP3 data */
function generateSpeech(text) {
  return new Promise((resolve, reject) => {
    if (!EL_API_KEY || !EL_VOICE_ID) return reject(new Error('ElevenLabs credentials not configured'));

    const body = JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      path:     `/v1/text-to-speech/${EL_VOICE_ID}`,
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'xi-api-key':    EL_API_KEY,
        'Accept':        'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
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

// POST /api/media/generate-audio  { articleId }
router.post('/generate-audio', auth, async (req, res) => {
  const { articleId } = req.body;
  if (!articleId) return res.status(400).json({ error: 'articleId required' });

  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot generate audio for archived article' });

  // Mark as pending
  db.prepare("UPDATE articles SET audio_status = 'pending', updated_at = datetime('now') WHERE id = ?").run(articleId);

  try {
    const text     = await buildTtsText(article.title, article.summary, article.source || 'Deep Feed AI');
    const mp3Buf   = await generateSpeech(text);
    const slug     = toSlug(article.title) || `article-${article.id}`;
    const filename = `${slug}-${article.id}.mp3`;
    const filePath = path.join(AUDIO_DIR, filename);

    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    fs.writeFileSync(filePath, mp3Buf);

    const audioUrl = `/media/audio/${filename}`;
    db.prepare(`
      UPDATE articles
      SET audio_url = ?, audio_status = 'ready', audio_transcript = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(audioUrl, text, articleId);

    res.json({ audioUrl, charCount: text.length, ttsText: text });
  } catch (err) {
    db.prepare("UPDATE articles SET audio_status = 'error', updated_at = datetime('now') WHERE id = ?").run(articleId);
    console.error('[Media] ElevenLabs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/media/audio/:id — remove audio file and clear DB fields
router.delete('/audio/:id', auth, (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  if (article.audio_url) {
    const filePath = path.join(__dirname, '..', 'public', article.audio_url);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  }
  db.prepare("UPDATE articles SET audio_url = NULL, audio_status = NULL, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Audio removed' });
});

// PUT /api/media/toggle/:id — toggle media_enabled
router.put('/toggle/:id', auth, (req, res) => {
  const article = db.prepare('SELECT id, media_enabled FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const newVal = article.media_enabled ? 0 : 1;
  db.prepare("UPDATE articles SET media_enabled = ?, updated_at = datetime('now') WHERE id = ?").run(newVal, req.params.id);
  res.json({ media_enabled: newVal });
});

module.exports = router;
