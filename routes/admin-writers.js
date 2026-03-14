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

/** Sync writer_beats junction table from an array of category IDs */
async function syncBeats(writerId, beats) {
  await db.prepare('DELETE FROM writer_beats WHERE writer_id = $1').run(writerId);
  for (const catId of beats) {
    try {
      await db.prepare('INSERT INTO writer_beats (writer_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING').run(writerId, catId);
    } catch { /* skip invalid catId */ }
  }
}

/** Fetch beats for a single writer as [{id, name}] */
async function getBeats(writerId) {
  return db.prepare(`
    SELECT c.id, c.name FROM writer_beats wb
    JOIN categories c ON c.id = wb.category_id
    WHERE wb.writer_id = $1 ORDER BY c.name
  `).all(writerId);
}

// GET /api/admin/writers — list all writers with article + follower counts + beats
router.get('/', asyncHandler(async (req, res) => {
  const writers = await db.prepare(`
    SELECT w.*, v.name AS voice_name,
           COUNT(DISTINCT a.id)::int AS article_count,
           COUNT(DISTINCT wf.id)::int AS follower_count,
           COALESCE(
             json_agg(DISTINCT jsonb_build_object('id', c.id, 'name', c.name))
             FILTER (WHERE c.id IS NOT NULL), '[]'
           ) AS beats
    FROM writers w
    LEFT JOIN voices v ON v.id = w.voice_id
    LEFT JOIN articles a ON a.writer_id = w.id
    LEFT JOIN writer_follows wf ON wf.writer_id = w.id
    LEFT JOIN writer_beats wb ON wb.writer_id = w.id
    LEFT JOIN categories c ON c.id = wb.category_id
    GROUP BY w.id, v.name
    ORDER BY w.name ASC
  `).all();
  res.json(writers);
}));

// POST /api/admin/writers — create writer
router.post('/', asyncHandler(async (req, res) => {
  const body = validate(writerCreate, req.body, res);
  if (!body) return;

  const { name, slug, bio, beat, beats, keywords, system_prompt, is_auto,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id,
          tone, expertise_level, style_guide, few_shot_examples } = body;

  const resolvedSlug = (slug || toSlug(name)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  if (voice_id) {
    const voice = await db.prepare('SELECT id FROM voices WHERE id = $1').get(voice_id);
    if (!voice) return res.status(400).json({ error: 'Voice not found' });
  }

  const writer = await db.prepare(`
    INSERT INTO writers (name, slug, bio, beat, keywords, system_prompt, is_auto,
      synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id,
      tone, expertise_level, style_guide, few_shot_examples)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING *
  `).get(
    name, resolvedSlug, bio || null, beat || null,
    keywords.length ? keywords : null,
    system_prompt || null, is_auto || false,
    synthesis_schedule, synthesis_lookback_hours, min_cluster_size,
    voice_id || null,
    tone || null, expertise_level || null, style_guide || null,
    JSON.stringify(few_shot_examples || [])
  );

  if (beats.length) await syncBeats(writer.id, beats);
  writer.beats = await getBeats(writer.id);

  res.json(writer);
}));

// PUT /api/admin/writers/:id — update writer
router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT * FROM writers WHERE id = $1').get(id);
  if (!existing) return res.status(404).json({ error: 'Writer not found' });

  const body = validate(writerUpdate, req.body, res);
  if (!body) return;

  const { name, slug, bio, beat, beats, keywords, system_prompt, is_auto,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id,
          tone, expertise_level, style_guide, few_shot_examples } = body;

  if (voice_id) {
    const voice = await db.prepare('SELECT id FROM voices WHERE id = $1').get(voice_id);
    if (!voice) return res.status(400).json({ error: 'Voice not found' });
  }

  const existingFse = typeof existing.few_shot_examples === 'string'
    ? existing.few_shot_examples : JSON.stringify(existing.few_shot_examples || []);

  const writer = await db.prepare(`
    UPDATE writers SET name = $1, slug = $2, bio = $3, beat = $4, keywords = $5,
      system_prompt = $6, is_auto = $7, synthesis_schedule = $8,
      synthesis_lookback_hours = $9, min_cluster_size = $10, voice_id = $11,
      tone = $12, expertise_level = $13, style_guide = $14, few_shot_examples = $15
    WHERE id = $16
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
    tone !== undefined ? (tone || null) : existing.tone,
    expertise_level !== undefined ? (expertise_level || null) : existing.expertise_level,
    style_guide !== undefined ? (style_guide || null) : existing.style_guide,
    few_shot_examples !== undefined ? JSON.stringify(few_shot_examples) : existingFse,
    id
  );

  if (beats !== undefined) await syncBeats(id, beats);
  writer.beats = await getBeats(id);

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

// GET /api/admin/writers/performance — per-writer performance metrics
router.get('/performance', asyncHandler(async (req, res) => {
  const range = req.query.range || '30d';
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;

  const rows = await db.prepare(`
    WITH article_stats AS (
      SELECT writer_id,
             COUNT(*)::int AS articles_total,
             COUNT(*) FILTER (WHERE content_type = 'original')::int AS articles_original,
             ROUND(AVG(editorial_score)::numeric, 1) AS avg_editorial_score
      FROM articles
      WHERE writer_id IS NOT NULL
        AND created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY writer_id
    ),
    reaction_stats AS (
      SELECT a.writer_id, COUNT(r.id)::int AS total_reactions
      FROM article_reactions r
      JOIN articles a ON a.slug = r.article_slug
      WHERE a.writer_id IS NOT NULL
        AND r.created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY a.writer_id
    ),
    comment_stats AS (
      SELECT a.writer_id, COUNT(cm.id)::int AS total_comments
      FROM comments cm
      JOIN articles a ON a.slug = cm.article_slug
      WHERE a.writer_id IS NOT NULL
        AND cm.is_deleted = 0
        AND cm.created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY a.writer_id
    ),
    view_stats AS (
      SELECT a.writer_id,
             COUNT(*) FILTER (WHERE e.event_type = 'view')::int AS total_views,
             COUNT(*) FILTER (WHERE e.event_type = 'audio_play')::int AS total_audio_plays
      FROM analytics_events e
      JOIN articles a ON a.slug = e.article_slug
      WHERE a.writer_id IS NOT NULL
        AND e.created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY a.writer_id
    ),
    cost_stats AS (
      SELECT writer_id,
             ROUND(SUM(estimated_cost)::numeric, 4) AS total_cost
      FROM ai_usage
      WHERE writer_id IS NOT NULL
        AND created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY writer_id
    ),
    follow_stats AS (
      SELECT writer_id, COUNT(*)::int AS follower_count
      FROM writer_follows
      GROUP BY writer_id
    )
    SELECT w.id AS writer_id, w.name, w.slug, w.avatar_url,
           COALESCE(ast.articles_total, 0) AS articles_total,
           COALESCE(ast.articles_original, 0) AS articles_original,
           ast.avg_editorial_score,
           COALESCE(rs.total_reactions, 0) AS total_reactions,
           COALESCE(cs.total_comments, 0) AS total_comments,
           COALESCE(vs.total_views, 0) AS total_views,
           COALESCE(vs.total_audio_plays, 0) AS total_audio_plays,
           COALESCE(fol.follower_count, 0) AS follower_count,
           COALESCE(co.total_cost, 0)::float AS total_cost,
           CASE WHEN COALESCE(ast.articles_total, 0) > 0
                THEN ROUND((COALESCE(co.total_cost, 0) / ast.articles_total)::numeric, 4)::float
                ELSE 0 END AS cost_per_article
    FROM writers w
    LEFT JOIN article_stats ast ON ast.writer_id = w.id
    LEFT JOIN reaction_stats rs ON rs.writer_id = w.id
    LEFT JOIN comment_stats cs ON cs.writer_id = w.id
    LEFT JOIN view_stats vs ON vs.writer_id = w.id
    LEFT JOIN cost_stats co ON co.writer_id = w.id
    LEFT JOIN follow_stats fol ON fol.writer_id = w.id
    ORDER BY COALESCE(ast.articles_total, 0) DESC
  `).all(days);

  res.json(rows);
}));

module.exports = router;
