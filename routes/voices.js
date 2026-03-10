/**
 * Deep Feed AI Admin — /api/voices
 * Full CRUD for voice characters used in ElevenLabs TTS.
 * Avatars stored in Cloudflare R2 (or locally as fallback).
 */
const express = require('express');
const router  = express.Router();
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const db      = require('../db');

const JWT_SECRET   = process.env.JWT_SECRET || 'deepfeedai_super_secret_jwt_key_2026';
const AVATAR_DIR   = path.join(__dirname, '..', 'public', 'media', 'avatars');

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

async function storeAvatar(buf, mimeType, voiceId) {
  const ext = mimeType === 'image/png' ? 'png'
            : mimeType === 'image/gif' ? 'gif'
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

  // Local fallback
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

// GET /api/voices — public (main site may need it)
router.get('/', async (req, res) => {
  try {
    const voices = await db.prepare('SELECT * FROM voices ORDER BY is_default DESC, created_at ASC').all();
    res.json(voices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voices — create voice (auth required)
router.post('/', auth, async (req, res) => {
  const { name, voice_id, description, is_default } = req.body;
  if (!name || !voice_id) return res.status(400).json({ error: 'name and voice_id required' });

  try {
    if (is_default) {
      await db.prepare('UPDATE voices SET is_default = 0').run();
    }
    await db.prepare(
      'INSERT INTO voices (name, voice_id, description, is_default) VALUES (?, ?, ?, ?)'
    ).run(name, voice_id, description || '', is_default ? 1 : 0);

    const voice = await db.prepare('SELECT * FROM voices ORDER BY id DESC LIMIT 1').get();
    res.json(voice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/voices/:id — update voice (auth required)
router.put('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { name, voice_id, description, is_default } = req.body;
  if (!name || !voice_id) return res.status(400).json({ error: 'name and voice_id required' });

  try {
    if (is_default) {
      await db.prepare('UPDATE voices SET is_default = 0').run();
    }
    await db.prepare(
      'UPDATE voices SET name = ?, voice_id = ?, description = ?, is_default = ? WHERE id = ?'
    ).run(name, voice_id, description || '', is_default ? 1 : 0, id);

    const voice = await db.prepare('SELECT * FROM voices WHERE id = ?').get(id);
    if (!voice) return res.status(404).json({ error: 'Voice not found' });
    res.json(voice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/voices/:id — delete voice (auth required)
router.delete('/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const voice = await db.prepare('SELECT * FROM voices WHERE id = ?').get(id);
    if (!voice) return res.status(404).json({ error: 'Voice not found' });

    const count = await db.prepare('SELECT COUNT(*) as cnt FROM voices').get();
    if (parseInt(count.cnt) <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only voice' });
    }

    await db.prepare('DELETE FROM voices WHERE id = ?').run(id);

    // If deleted voice was default, assign default to next voice
    if (voice.is_default) {
      await db.prepare('UPDATE voices SET is_default = 1 WHERE id = (SELECT id FROM voices ORDER BY created_at ASC LIMIT 1)').run();
    }

    res.json({ message: 'Voice deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voices/:id/avatar — upload avatar image (auth required)
router.post('/:id/avatar', auth, async (req, res) => {
  const { id } = req.params;
  const { dataUrl } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });

  try {
    const voice = await db.prepare('SELECT * FROM voices WHERE id = ?').get(id);
    if (!voice) return res.status(404).json({ error: 'Voice not found' });

    // Parse data URL: data:<mime>;base64,<data>
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid dataUrl format' });

    const mimeType = match[1];
    const buf = Buffer.from(match[2], 'base64');

    const avatarUrl = await storeAvatar(buf, mimeType, id);
    await db.prepare('UPDATE voices SET avatar_url = ? WHERE id = ?').run(avatarUrl, id);

    const updated = await db.prepare('SELECT * FROM voices WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voices/preview — TTS preview (auth required)
// Note: this must be defined BEFORE /:id routes to avoid conflict, but Express handles it OK since 'preview' != integer
router.post('/preview', auth, async (req, res) => {
  const { voice_id, api_key } = req.body;
  if (!voice_id) return res.status(400).json({ error: 'voice_id required' });

  try {
    // Resolve API key: param → settings table → env var
    let apiKey = api_key;
    if (!apiKey) {
      const setting = await db.prepare("SELECT value FROM settings WHERE key = 'elevenlabs_api_key'").get();
      apiKey = (setting && setting.value) ? setting.value : (process.env.ELEVENLABS_API_KEY || '');
    }

    const previewText = 'Hello! This is a preview of how I sound as your AI news anchor. Stay tuned for the latest in artificial intelligence.';
    const mp3Buf = await generatePreview(previewText, voice_id, apiKey);
    const base64 = mp3Buf.toString('base64');
    res.json({ audio: base64, mimeType: 'audio/mpeg' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/voices/:id/default — set as default voice (auth required)
router.put('/:id/default', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const voice = await db.prepare('SELECT * FROM voices WHERE id = ?').get(id);
    if (!voice) return res.status(404).json({ error: 'Voice not found' });

    await db.prepare('UPDATE voices SET is_default = 0').run();
    await db.prepare('UPDATE voices SET is_default = 1 WHERE id = ?').run(id);

    const updated = await db.prepare('SELECT * FROM voices WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
