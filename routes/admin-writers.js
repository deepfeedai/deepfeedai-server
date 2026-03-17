/**
 * Deep Feed AI Admin — /api/admin/writers
 * Admin CRUD for writer personas (separate from TTS voices).
 */
const express          = require('express');
const path             = require('path');
const router           = express.Router();
const db               = require('../db');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler, toSlug } = require('../lib/utils');
const { writerCreate, writerUpdate, validate } = require('../lib/schemas');
const { extFromMime, upload: r2Upload } = require('../lib/r2');
const { checkPlanLimit }    = require('../lib/plan-limits');
const { logAudit } = require('../middleware/audit');
const { getCategories }     = require('../lib/categories');
const { getGeminiKey }      = require('../lib/gemini-config');

const AVATAR_DIR = path.join(__dirname, '..', 'public', 'media', 'avatars');

async function storeAvatar(buf, mimeType, writerId) {
  const ext = extFromMime(mimeType);
  const filename = `writer-${writerId}.${ext}`;
  return r2Upload(buf, mimeType, `avatars/${filename}`, AVATAR_DIR, `avatars/${filename}`);
}

/** Sync writer_beats junction table from an array of category IDs */
async function syncBeats(writerId, beats, tenantId) {
  await db.prepare('DELETE FROM writer_beats WHERE writer_id = $1 AND tenant_id = $2').run(writerId, tenantId);
  for (const catId of beats) {
    try {
      await db.prepare('INSERT INTO writer_beats (writer_id, category_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING').run(writerId, catId, tenantId);
    } catch { /* skip invalid catId */ }
  }
}

/** Fetch beats for a single writer as [{id, name}] */
async function getBeats(writerId, tenantId) {
  return db.prepare(`
    SELECT c.id, c.name FROM writer_beats wb
    JOIN categories c ON c.id = wb.category_id
    WHERE wb.writer_id = $1 AND wb.tenant_id = $2 ORDER BY c.name
  `).all(writerId, tenantId);
}

// GET /api/admin/writers — list all writers with article + follower counts + beats
router.get('/', requirePermission('writers.read'), asyncHandler(async (req, res) => {
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
    LEFT JOIN articles a ON a.writer_id = w.id AND a.tenant_id = $1
    LEFT JOIN writer_follows wf ON wf.writer_id = w.id AND wf.tenant_id = $1
    LEFT JOIN writer_beats wb ON wb.writer_id = w.id AND wb.tenant_id = $1
    LEFT JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $1
    WHERE w.tenant_id = $1
    GROUP BY w.id, v.name
    ORDER BY w.name ASC
  `).all(req.tenantId);
  res.json(writers);
}));

// POST /api/admin/writers/generate — AI-generate writer personas from categories
router.post('/generate', requirePermission('writers.create'), asyncHandler(async (req, res) => {
  const { categoryIds, uncoveredOnly = true } = req.body || {};
  const tenantId = req.tenantId;

  const apiKey = await getGeminiKey(tenantId);
  if (!apiKey) return res.status(503).json({ error: 'Gemini API key not configured' });

  // Fetch tenant categories
  let categories = await getCategories(tenantId);
  if (Array.isArray(categoryIds) && categoryIds.length) {
    const idSet = new Set(categoryIds);
    categories = categories.filter(c => idSet.has(c.id));
  }
  if (!categories.length) return res.json({ generated: [], message: 'No categories found' });

  // Determine which categories already have writers via writer_beats
  const coverage = await db.prepare(`
    SELECT wb.category_id, array_agg(w.name) AS writer_names
    FROM writer_beats wb
    JOIN writers w ON w.id = wb.writer_id AND w.tenant_id = $1
    WHERE wb.tenant_id = $1
    GROUP BY wb.category_id
  `).all(tenantId);
  const coverageMap = {};
  for (const row of coverage) coverageMap[row.category_id] = row.writer_names;

  let targetCategories = categories.map(c => ({
    ...c,
    hasExistingWriter: !!coverageMap[c.id],
    existingWriters: coverageMap[c.id] || [],
  }));

  if (uncoveredOnly) {
    targetCategories = targetCategories.filter(c => !c.hasExistingWriter);
  }
  if (!targetCategories.length) {
    return res.json({ generated: [], message: 'All categories already have writers' });
  }

  // Build Gemini prompt
  const catList = targetCategories.map(c => {
    const kwStr = (c.keywords || []).slice(0, 10).join(', ');
    return `- "${c.name}"${c.description ? ': ' + c.description : ''}${kwStr ? ' (keywords: ' + kwStr + ')' : ''}`;
  }).join('\n');

  const prompt = [
    'You are helping create AI writer personas for a news aggregation platform.',
    `Generate one unique writer persona for each of the ${targetCategories.length} categories below.`,
    '',
    'Categories:',
    catList,
    '',
    'For EACH category, return a JSON object with these exact fields:',
    '- categoryName: the category name exactly as shown above',
    '- name: a single first name only (no last name). Vary gender and ethnicity across writers for diversity.',
    '- bio: 1-2 sentence professional bio (max 200 chars)',
    '- tone: writing tone, e.g. "analytical", "conversational", "provocative", "authoritative", "casual", "technical"',
    '- expertise_level: one of "beginner-friendly", "intermediate", "technical", "expert"',
    '- style_guide: 1-2 sentences describing their writing style (max 300 chars)',
    '- system_prompt: 2-3 sentence prompt for the AI to adopt this persona when writing articles (max 500 chars). Start with "You are [name]..."',
    '- keywords: array of 5-10 topic keywords relevant to this beat (lowercase)',
    '- gender: one of "male", "female", "non-binary"',
    '- ethnicity: one of "African American", "African", "Asian", "East Asian", "South Asian", "Hispanic/Latino", "Middle Eastern", "Native American", "Pacific Islander", "Caucasian", "Mixed/Multiracial"',
    '',
    'Rules:',
    '- Make names diverse across gender and ethnicity — avoid homogeneity',
    '- Each writer should have a distinct personality and voice',
    '- Keywords should be specific to the category, not generic',
    '- System prompts should establish a clear voice and editorial perspective',
    '',
    'Respond with ONLY a JSON array of objects, one per category, in the same order as listed.',
    'No markdown fences, no explanation, no trailing text.',
  ].join('\n');

  const { logUsage, extractGeminiTokens } = require('../lib/ai-usage');
  const GEMINI_MODEL = 'gemini-2.5-flash-lite';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const maxTokens = Math.min(1024 * targetCategories.length, 8192);
  const _start = Date.now();

  const upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '');
    console.error('[generate-writers] Gemini error:', upstream.status, errBody);
    logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'generate-writer-personas', trigger: 'admin', durationMs: Date.now() - _start, success: false, error: `${upstream.status}`, tenantId }).catch(() => {});
    return res.status(502).json({ error: `Gemini API error: ${upstream.status}` });
  }

  const data = await upstream.json();
  const _tokens = extractGeminiTokens(data);
  logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'generate-writer-personas', trigger: 'admin', inputTokens: _tokens.promptTokenCount, outputTokens: _tokens.candidatesTokenCount, durationMs: Date.now() - _start, tenantId }).catch(() => {});

  const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  let personas;
  try {
    let cleaned = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    if (!cleaned.endsWith(']')) cleaned = cleaned.replace(/,\s*$/, '') + ']';
    personas = JSON.parse(cleaned);
    if (!Array.isArray(personas)) throw new Error('Not an array');
  } catch (err) {
    console.error('[generate-writers] JSON parse error:', err.message, 'raw:', raw.slice(0, 200));
    return res.status(502).json({ error: 'Failed to parse AI response' });
  }

  // Map personas back to categories and enrich with defaults
  const generated = personas.map((p, i) => {
    const cat = targetCategories.find(c => c.name === p.categoryName) || targetCategories[i];
    if (!cat) return null;
    const slug = toSlug(p.name || 'writer');
    return {
      categoryId: cat.id,
      categoryName: cat.name,
      hasExistingWriter: cat.hasExistingWriter,
      name: p.name || cat.name + ' Writer',
      slug,
      bio: p.bio || '',
      beat: cat.name,
      beats: [cat.id],
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      system_prompt: p.system_prompt || '',
      tone: p.tone || '',
      expertise_level: p.expertise_level || '',
      style_guide: p.style_guide || '',
      gender: p.gender || null,
      ethnicity: p.ethnicity || null,
      is_auto: true,
      synthesis_schedule: 'daily',
      synthesis_lookback_hours: 168,
      min_cluster_size: 3,
    };
  }).filter(Boolean);

  res.json({ generated, usage: { inputTokens: _tokens.promptTokenCount || 0, outputTokens: _tokens.candidatesTokenCount || 0 } });
}));

// POST /api/admin/writers — create writer
router.post('/', requirePermission('writers.create'), asyncHandler(async (req, res) => {
  const body = validate(writerCreate, req.body, res);
  if (!body) return;

  const limit = await checkPlanLimit(req.tenantId, 'writers');
  if (!limit.allowed) {
    return res.status(403).json({ error: 'Plan limit reached', resource: 'writers', current: limit.current, max: limit.max });
  }

  const { name, slug, bio, beat, beats, keywords, system_prompt, is_auto,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id,
          tone, expertise_level, style_guide, few_shot_examples, gender, ethnicity } = body;

  const resolvedSlug = (slug || toSlug(name)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  if (voice_id) {
    const voice = await db.prepare('SELECT id FROM voices WHERE id = $1 AND tenant_id = $2').get(voice_id, req.tenantId);
    if (!voice) return res.status(400).json({ error: 'Voice not found' });
  }

  const writer = await db.prepare(`
    INSERT INTO writers (name, slug, bio, beat, keywords, system_prompt, is_auto,
      synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id,
      tone, expertise_level, style_guide, few_shot_examples, gender, ethnicity, tenant_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING *
  `).get(
    name, resolvedSlug, bio || null, beat || null,
    keywords.length ? keywords : null,
    system_prompt || null, is_auto || false,
    synthesis_schedule, synthesis_lookback_hours, min_cluster_size,
    voice_id || null,
    tone || null, expertise_level || null, style_guide || null,
    JSON.stringify(few_shot_examples || []),
    gender || null, ethnicity || null,
    req.tenantId
  );

  if (beats.length) await syncBeats(writer.id, beats, req.tenantId);
  writer.beats = await getBeats(writer.id, req.tenantId);

  logAudit(req, 'writer.create', 'writer', writer.id, { name: writer.name });
  res.json(writer);
}));

// PUT /api/admin/writers/:id — update writer
router.put('/:id', requirePermission('writers.update'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Writer not found' });

  const body = validate(writerUpdate, req.body, res);
  if (!body) return;

  const { name, slug, bio, beat, beats, keywords, system_prompt, is_auto,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id,
          tone, expertise_level, style_guide, few_shot_examples, gender, ethnicity } = body;

  if (voice_id) {
    const voice = await db.prepare('SELECT id FROM voices WHERE id = $1 AND tenant_id = $2').get(voice_id, req.tenantId);
    if (!voice) return res.status(400).json({ error: 'Voice not found' });
  }

  const existingFse = typeof existing.few_shot_examples === 'string'
    ? existing.few_shot_examples : JSON.stringify(existing.few_shot_examples || []);

  const writer = await db.prepare(`
    UPDATE writers SET name = $1, slug = $2, bio = $3, beat = $4, keywords = $5,
      system_prompt = $6, is_auto = $7, synthesis_schedule = $8,
      synthesis_lookback_hours = $9, min_cluster_size = $10, voice_id = $11,
      tone = $12, expertise_level = $13, style_guide = $14, few_shot_examples = $15,
      gender = $16, ethnicity = $17
    WHERE id = $18 AND tenant_id = $19
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
    gender !== undefined ? (gender || null) : existing.gender,
    ethnicity !== undefined ? (ethnicity || null) : existing.ethnicity,
    id,
    req.tenantId
  );

  if (beats !== undefined) await syncBeats(id, beats, req.tenantId);
  writer.beats = await getBeats(id, req.tenantId);

  logAudit(req, 'writer.update', 'writer', parseInt(id), { name: writer.name });
  res.json(writer);
}));

// DELETE /api/admin/writers/:id — delete writer (articles get writer_id = NULL via FK)
router.delete('/:id', requirePermission('writers.delete'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  await db.prepare('DELETE FROM writers WHERE id = $1 AND tenant_id = $2').run(id, req.tenantId);
  logAudit(req, 'writer.delete', 'writer', parseInt(id), { name: writer.name });
  res.json({ message: 'Writer deleted' });
}));

// POST /api/admin/writers/:id/avatar — upload avatar to R2
router.post('/:id/avatar', requirePermission('writers.update'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { dataUrl } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });

  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid dataUrl format' });

  const avatarUrl = await storeAvatar(Buffer.from(match[2], 'base64'), match[1], id);
  await db.prepare('UPDATE writers SET avatar_url = $1 WHERE id = $2 AND tenant_id = $3').run(avatarUrl, id, req.tenantId);
  const updated = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  res.json(updated);
}));

// POST /api/admin/writers/:id/generate-avatar — AI-generate avatar with Imagen
router.post('/:id/generate-avatar', requirePermission('writers.update'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  const { getGeminiKey } = require('../lib/gemini-config');
  const apiKey = await getGeminiKey(req.tenantId);
  if (!apiKey) return res.status(500).json({ error: 'Gemini/Imagen API key not configured' });

  // Build a portrait prompt from the writer's persona
  const beats = await getBeats(id, req.tenantId);
  const beatNames = beats.map(b => b.name).join(', ') || 'news';
  const toneDesc = writer.tone ? `, with a ${writer.tone.toLowerCase()} demeanor` : '';

  const genderDesc = writer.gender ? `${writer.gender} ` : '';
  const ethnicityDesc = writer.ethnicity ? `${writer.ethnicity} ` : '';
  const prompt = `Professional headshot portrait of a ${ethnicityDesc}${genderDesc}journalist who covers ${beatNames}${toneDesc}. `
    + `Clean background, studio lighting, photorealistic, high quality, sharp focus. `
    + `No text, no logos, no watermarks. Square 1:1 aspect ratio.`;

  console.log(`[AvatarGen] Writer ${id} (${writer.name}): ${prompt}`);

  const IMAGEN_URL = 'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict';
  let resolvedUrl = IMAGEN_URL;
  try {
    const modelSetting = await db.prepare("SELECT value FROM settings WHERE key = 'imagen_model' AND tenant_id = $1").get(req.tenantId);
    if (modelSetting?.value) resolvedUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelSetting.value}:predict`;
  } catch {}

  const imagenBody = resolvedUrl.includes(':predict')
    ? { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1', safetyFilterLevel: 'block_few' } }
    : { contents: [{ parts: [{ text: prompt }] }], generationConfig: { imageGenerationConfig: { numberOfImages: 1, aspectRatio: '1:1' } } };

  const imagenRes = await fetch(`${resolvedUrl}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(imagenBody),
    signal: AbortSignal.timeout(30000),
  });

  if (!imagenRes.ok) {
    const err = await imagenRes.text().catch(() => '');
    console.error(`[AvatarGen] Imagen error: ${imagenRes.status}`, err.slice(0, 300));
    return res.status(502).json({ error: `Imagen API error: ${imagenRes.status}` });
  }

  const data = await imagenRes.json();
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded
           || data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data
           || data?.generatedImages?.[0]?.image?.imageBytes
           || data?.images?.[0]?.bytesBase64Encoded;

  if (!b64) {
    console.error('[AvatarGen] No image in response:', JSON.stringify(data).slice(0, 500));
    return res.status(502).json({ error: 'No image returned from Imagen' });
  }

  const avatarUrl = await storeAvatar(Buffer.from(b64, 'base64'), 'image/png', id);
  await db.prepare('UPDATE writers SET avatar_url = $1 WHERE id = $2 AND tenant_id = $3').run(avatarUrl, id, req.tenantId);

  const { logUsage } = require('../lib/ai-usage');
  logUsage({ provider: 'imagen', model: 'imagen-4', operation: 'avatar-generate', trigger: 'manual', imageCount: 1, tenantId: req.tenantId }).catch(() => {});

  const updated = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  res.json({ ...updated, _avatarPrompt: prompt });
}));

// GET /api/admin/writers/performance — per-writer performance metrics
router.get('/performance', requirePermission('writers.read'), asyncHandler(async (req, res) => {
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
        AND tenant_id = $2
        AND created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY writer_id
    ),
    reaction_stats AS (
      SELECT a.writer_id, COUNT(r.id)::int AS total_reactions
      FROM article_reactions r
      JOIN articles a ON a.slug = r.article_slug AND a.tenant_id = $2
      WHERE a.writer_id IS NOT NULL
        AND r.created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY a.writer_id
    ),
    comment_stats AS (
      SELECT a.writer_id, COUNT(cm.id)::int AS total_comments
      FROM comments cm
      JOIN articles a ON a.slug = cm.article_slug AND a.tenant_id = $2
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
      JOIN articles a ON a.slug = e.article_slug AND a.tenant_id = $2
      WHERE a.writer_id IS NOT NULL
        AND e.created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY a.writer_id
    ),
    cost_stats AS (
      SELECT writer_id,
             ROUND(SUM(estimated_cost)::numeric, 4) AS total_cost
      FROM ai_usage
      WHERE writer_id IS NOT NULL
        AND tenant_id = $2
        AND created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY writer_id
    ),
    follow_stats AS (
      SELECT writer_id, COUNT(*)::int AS follower_count
      FROM writer_follows
      WHERE tenant_id = $2
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
    WHERE w.tenant_id = $2
    ORDER BY COALESCE(ast.articles_total, 0) DESC
  `).all(days, req.tenantId);

  res.json(rows);
}));

module.exports = router;
