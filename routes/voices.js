/**
 * Deep Feed AI Admin — /api/voices
 * Full CRUD for voice characters used in ElevenLabs TTS.
 * Avatars stored in Cloudflare R2 (or locally as fallback).
 */
const express               = require('express');
const router                = express.Router();
const https                 = require('https');
const fs                    = require('fs');
const path                  = require('path');
const db                    = require('../db');
const { auth }              = require('../middleware/auth');
const { asyncHandler }      = require('../lib/utils');
const { voiceCreate, voiceUpdate, validate } = require('../lib/schemas');
const { decryptSetting }    = require('../lib/crypto');

const AVATAR_DIR = path.join(__dirname, '..', 'public', 'media', 'avatars');
const { extFromMime, upload: r2Upload } = require('../lib/r2');

async function storeAvatar(buf, mimeType, voiceId) {
  const ext = extFromMime(mimeType);
  const filename = `voice-${voiceId}.${ext}`;
  return r2Upload(buf, mimeType, `avatars/${filename}`, AVATAR_DIR, `avatars/${filename}`);
}

function generatePreview(text, voiceId, apiKey) {
  return new Promise((resolve, reject) => {
    if (!apiKey || !voiceId) return reject(new Error('ElevenLabs credentials not configured'));
    const body = JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.75 },
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path:     `/v1/text-to-speech/${voiceId}`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'xi-api-key':     apiKey,
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

// GET /api/voices — public
router.get('/', asyncHandler(async (req, res) => {
  const voices = await db.prepare('SELECT * FROM voices ORDER BY is_default DESC, created_at ASC').all();
  res.json(voices);
}));

// POST /api/voices
router.post('/', auth, asyncHandler(async (req, res) => {
  const body = validate(voiceCreate, req.body, res);
  if (!body) return;

  const { name, voice_id, description, is_default } = body;

  if (is_default) await db.prepare('UPDATE voices SET is_default = 0').run();
  const voice = await db.prepare(`
    INSERT INTO voices (name, voice_id, description, is_default)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `).get(name, voice_id, description || '', is_default ? 1 : 0);
  res.json(voice);
}));

// PUT /api/voices/:id
router.put('/:id', auth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT * FROM voices WHERE id = $1').get(id);
  if (!existing) return res.status(404).json({ error: 'Voice not found' });

  const body = validate(voiceUpdate, req.body, res);
  if (!body) return;

  const { name, voice_id, description, is_default } = body;

  if (is_default) await db.prepare('UPDATE voices SET is_default = 0').run();
  const voice = await db.prepare(`
    UPDATE voices SET name = $1, voice_id = $2, description = $3, is_default = $4
    WHERE id = $5
    RETURNING *
  `).get(name, voice_id, description || '', is_default ? 1 : 0, id);
  res.json(voice);
}));

// DELETE /api/voices/:id
router.delete('/:id', auth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const voice = await db.prepare('SELECT * FROM voices WHERE id = $1').get(id);
  if (!voice) return res.status(404).json({ error: 'Voice not found' });

  const count = await db.prepare('SELECT COUNT(*) as cnt FROM voices').get();
  if (parseInt(count.cnt) <= 1) return res.status(400).json({ error: 'Cannot delete the only voice' });

  await db.prepare('DELETE FROM voices WHERE id = $1').run(id);
  if (voice.is_default) {
    await db.prepare('UPDATE voices SET is_default = 1 WHERE id = (SELECT id FROM voices ORDER BY created_at ASC LIMIT 1)').run();
  }
  res.json({ message: 'Voice deleted' });
}));

// POST /api/voices/:id/avatar
router.post('/:id/avatar', auth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { dataUrl } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });

  const voice = await db.prepare('SELECT * FROM voices WHERE id = $1').get(id);
  if (!voice) return res.status(404).json({ error: 'Voice not found' });

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid dataUrl format' });

  const avatarUrl = await storeAvatar(Buffer.from(match[2], 'base64'), match[1], id);
  await db.prepare('UPDATE voices SET avatar_url = $1 WHERE id = $2').run(avatarUrl, id);
  const updated = await db.prepare('SELECT * FROM voices WHERE id = $1').get(id);
  res.json(updated);
}));

// POST /api/voices/preview
router.post('/preview', auth, asyncHandler(async (req, res) => {
  const { voice_id, api_key } = req.body;
  if (!voice_id) return res.status(400).json({ error: 'voice_id required' });

  let apiKey = api_key;
  if (!apiKey) {
    const setting = await db.prepare("SELECT value FROM settings WHERE key = 'elevenlabs_api_key'").get();
    apiKey = (setting && setting.value) ? decryptSetting(setting.value) : (process.env.ELEVENLABS_API_KEY || '');
  }

  const DEFAULT_PREVIEW = 'Hello! This is a preview of how I sound as your AI news anchor. Stay tuned for the latest in artificial intelligence.';
  const previewText = (req.body.text && req.body.text.trim()) ? req.body.text.trim().slice(0, 500) : DEFAULT_PREVIEW;
  const mp3Buf = await generatePreview(previewText, voice_id, apiKey);
  res.json({ audio: mp3Buf.toString('base64'), mimeType: 'audio/mpeg' });
}));

// PUT /api/voices/:id/default
router.put('/:id/default', auth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const voice = await db.prepare('SELECT * FROM voices WHERE id = $1').get(id);
  if (!voice) return res.status(404).json({ error: 'Voice not found' });

  await db.prepare('UPDATE voices SET is_default = 0').run();
  await db.prepare('UPDATE voices SET is_default = 1 WHERE id = $1').run(id);
  const updated = await db.prepare('SELECT * FROM voices WHERE id = $1').get(id);
  res.json(updated);
}));

module.exports = router;
