/**
 * Deep Feed AI Admin — /api/admin/writers
 * Admin CRUD for writer personas (separate from TTS voices).
 */
const express          = require('express');
const path             = require('path');
const router           = express.Router();
const db               = require('../db');
const { asyncHandler, toSlug } = require('../lib/utils');
const { writerCreate, writerUpdate, validate } = require('../lib/schemas');
const { extFromMime, upload: r2Upload } = require('../lib/r2');

const AVATAR_DIR = path.join(__dirname, '..', 'public', 'media', 'avatars');

async function storeAvatar(buf, mimeType, writerId) {
  const ext = extFromMime(mimeType);
  const filename = `writer-${writerId}.${ext}`;
  return r2Upload(buf, mimeType, `avatars/${filename}`, AVATAR_DIR, `avatars/${filename}`);
}

// GET /api/admin/writers — list all writers with article + follower counts
router.get('/', asyncHandler(async (req, res) => {
  const writers = await db.prepare(`
    SELECT w.*, v.name AS voice_name,
           COUNT(DISTINCT a.id)::int AS article_count,
           COUNT(DISTINCT wf.id)::int AS follower_count
    FROM writers w
    LEFT JOIN voices v ON v.id = w.voice_id
    LEFT JOIN articles a ON a.writer_id = w.id
    LEFT JOIN writer_follows wf ON wf.writer_id = w.id
    GROUP BY w.id, v.name
    ORDER BY w.name ASC
  `).all();
  res.json(writers);
}));

// POST /api/admin/writers — create writer
router.post('/', asyncHandler(async (req, res) => {
  const body = validate(writerCreate, req.body, res);
  if (!body) return;

  const { name, slug, bio, beat, keywords, system_prompt, is_auto,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id } = body;

  const resolvedSlug = (slug || toSlug(name)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  // Validate voice_id if provided
  if (voice_id) {
    const voice = await db.prepare('SELECT id FROM voices WHERE id = $1').get(voice_id);
    if (!voice) return res.status(400).json({ error: 'Voice not found' });
  }

  const writer = await db.prepare(`
    INSERT INTO writers (name, slug, bio, beat, keywords, system_prompt, is_auto,
      synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `).get(
    name, resolvedSlug, bio || null, beat || null,
    keywords.length ? keywords : null,
    system_prompt || null, is_auto || false,
    synthesis_schedule, synthesis_lookback_hours, min_cluster_size,
    voice_id || null
  );
  res.json(writer);
}));

// PUT /api/admin/writers/:id — update writer
router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT * FROM writers WHERE id = $1').get(id);
  if (!existing) return res.status(404).json({ error: 'Writer not found' });

  const body = validate(writerUpdate, req.body, res);
  if (!body) return;

  const { name, slug, bio, beat, keywords, system_prompt, is_auto,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id } = body;

  // Validate voice_id if provided
  if (voice_id) {
    const voice = await db.prepare('SELECT id FROM voices WHERE id = $1').get(voice_id);
    if (!voice) return res.status(400).json({ error: 'Voice not found' });
  }

  const writer = await db.prepare(`
    UPDATE writers SET name = $1, slug = $2, bio = $3, beat = $4, keywords = $5,
      system_prompt = $6, is_auto = $7, synthesis_schedule = $8,
      synthesis_lookback_hours = $9, min_cluster_size = $10, voice_id = $11
    WHERE id = $12
    RETURNING *
  `).get(
    name,
    slug !== undefined ? (slug || null) : (existing.slug || toSlug(name || existing.name)),
    bio !== undefined ? (bio || null) : existing.bio,
    beat !== undefined ? (beat || null) : existing.beat,
    keywords !== undefined ? (keywords.length ? keywords : null) : existing.keywords,
    system_prompt !== undefined ? (system_prompt || null) : existing.system_prompt,
    is_auto !== undefined ? (is_auto || false) : existing.is_auto,
    synthesis_schedule !== undefined ? synthesis_schedule : existing.synthesis_schedule,
    synthesis_lookback_hours !== undefined ? synthesis_lookback_hours : existing.synthesis_lookback_hours,
    min_cluster_size !== undefined ? min_cluster_size : existing.min_cluster_size,
    voice_id !== undefined ? (voice_id || null) : existing.voice_id,
    id
  );
  res.json(writer);
}));

// DELETE /api/admin/writers/:id — delete writer (articles get writer_id = NULL via FK)
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1').get(id);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  await db.prepare('DELETE FROM writers WHERE id = $1').run(id);
  res.json({ message: 'Writer deleted' });
}));

// POST /api/admin/writers/:id/avatar — upload avatar to R2
router.post('/:id/avatar', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { dataUrl } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });

  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1').get(id);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid dataUrl format' });

  const avatarUrl = await storeAvatar(Buffer.from(match[2], 'base64'), match[1], id);
  await db.prepare('UPDATE writers SET avatar_url = $1 WHERE id = $2').run(avatarUrl, id);
  const updated = await db.prepare('SELECT * FROM writers WHERE id = $1').get(id);
  res.json(updated);
}));

module.exports = router;
