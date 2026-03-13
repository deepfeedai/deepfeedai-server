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

async function storeAvatar(buf, mimeType, voiceId) {
  const ext = mimeType === 'image/png'  ? 'png'
            : mimeType === 'image/gif'  ? 'gif'
            : mimeType === 'image/webp' ? 'webp'
            : 'jpg';
  const filename = `voice-${voiceId}.${ext}`;

  if (R2_CONFIGURED) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = getR2Client();
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         `avatars/${filename}`,
      Body:        buf,
      ContentType: mimeType,
    }));
    const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    return `${publicUrl}/avatars/${filename}`;
  }
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  fs.writeFileSync(path.join(AVATAR_DIR, filename), buf);
  return `/media/avatars/${filename}`;
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

  const { name, voice_id, description, is_default,
          bio, beat, keywords, system_prompt, is_auto, slug,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size } = body;

  if (is_default) await db.prepare('UPDATE voices SET is_default = 0').run();
  const voice = await db.prepare(`
    INSERT INTO voices (name, voice_id, description, is_default,
      bio, beat, keywords, system_prompt, is_auto, slug,
      synthesis_schedule, synthesis_lookback_hours, min_cluster_size)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *
  `).get(
    name, voice_id, description || '', is_default ? 1 : 0,
    bio || null, beat || null, keywords.length ? keywords : null,
    system_prompt || null, is_auto || false, slug || null,
    synthesis_schedule, synthesis_lookback_hours, min_cluster_size
  );
  res.json(voice);
}));

// PUT /api/voices/:id
router.put('/:id', auth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT * FROM voices WHERE id = $1').get(id);
  if (!existing) return res.status(404).json({ error: 'Voice not found' });

  const body = validate(voiceUpdate, req.body, res);
  if (!body) return;

  const { name, voice_id, description, is_default,
          bio, beat, keywords, system_prompt, is_auto, slug,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size } = body;

  if (is_default) await db.prepare('UPDATE voices SET is_default = 0').run();
  const voice = await db.prepare(`
    UPDATE voices SET name = $1, voice_id = $2, description = $3, is_default = $4,
      bio = $5, beat = $6, keywords = $7, system_prompt = $8, is_auto = $9, slug = $10,
      synthesis_schedule = $11, synthesis_lookback_hours = $12, min_cluster_size = $13
    WHERE id = $14
    RETURNING *
  `).get(
    name, voice_id, description || '', is_default ? 1 : 0,
    bio !== undefined ? (bio || null) : existing.bio,
    beat !== undefined ? (beat || null) : existing.beat,
    keywords !== undefined ? (keywords.length ? keywords : null) : existing.keywords,
    system_prompt !== undefined ? (system_prompt || null) : existing.system_prompt,
    is_auto !== undefined ? (is_auto || false) : existing.is_auto,
    slug !== undefined ? (slug || null) : existing.slug,
    synthesis_schedule !== undefined ? synthesis_schedule : existing.synthesis_schedule,
    synthesis_lookback_hours !== undefined ? synthesis_lookback_hours : existing.synthesis_lookback_hours,
    min_cluster_size !== undefined ? min_cluster_size : existing.min_cluster_size,
    id
  );
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
