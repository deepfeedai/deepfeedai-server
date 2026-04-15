/**
 * Deep Feed AI Admin — /api/admin/writers
 * Admin CRUD for writer personas (separate from TTS voices).
 */
const express          = require('express');
const router           = express.Router();
const db               = require('../db');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler, toSlug } = require('../lib/utils');
const { writerCreate, writerUpdate, validate } = require('../lib/schemas');
const { extFromMime } = require('../lib/r2');
const storage = require('../lib/storage');
const { checkPlanLimit }    = require('../lib/plan-limits');
const { logAudit } = require('../middleware/audit');
const { getCategories }     = require('../lib/categories');
const { complete: aiComplete } = require('../lib/ai-router');
const { parseTruncatedJsonArray, parseTruncatedJsonObject } = require('../lib/json-parse-safe');
const { loadPrompt } = require('../lib/prompt-loader');

async function storeAvatar(buf, mimeType, writerId, tenantId) {
  const ext = extFromMime(mimeType);
  const filename = `writer-${writerId}.${ext}`;
  return storage.upload(buf, mimeType, `avatars/${filename}`, tenantId);
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
    SELECT w.*,
           COUNT(DISTINCT a.id)::int AS article_count,
           COUNT(DISTINCT wf.id)::int AS follower_count,
           COALESCE(
             json_agg(DISTINCT jsonb_build_object('id', c.id, 'name', c.name))
             FILTER (WHERE c.id IS NOT NULL), '[]'
           ) AS beats
    FROM writers w
    LEFT JOIN articles a ON a.writer_id = w.id AND a.tenant_id = $1
    LEFT JOIN writer_follows wf ON wf.writer_id = w.id AND wf.tenant_id = $1
    LEFT JOIN writer_beats wb ON wb.writer_id = w.id AND wb.tenant_id = $1
    LEFT JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $1
    WHERE w.tenant_id = $1
    GROUP BY w.id
    ORDER BY w.name ASC
  `).all(req.tenantId);
  res.json(writers);
}));

// POST /api/admin/writers/generate — AI-generate writer personas from categories
router.post('/generate', requirePermission('writers.create'), asyncHandler(async (req, res) => {
  const { categoryIds, uncoveredOnly = true } = req.body || {};
  const tenantId = req.tenantId;

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

  // Build prompt
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

  const maxTokens = Math.min(1024 * targetCategories.length, 8192);

  const aiResult = await aiComplete({
    operation: 'generate-writer-personas',
    tenantId,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    maxTokens,
    trigger: 'admin',
  });

  if (!aiResult) return res.status(503).json({ error: 'AI service unavailable or budget denied' });

  const raw = aiResult.text.trim();
  let personas;
  try {
    personas = parseTruncatedJsonArray(raw);
    if (!personas.length) throw new Error('Empty array');
  } catch (err) {
    console.error('[generate-writers] JSON parse error:', err.message, 'raw:', raw.slice(0, 500));
    return res.status(502).json({ error: 'Failed to parse AI response', raw: raw.slice(0, 1000) });
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
      min_cluster_size: 2,
    };
  }).filter(Boolean);

  res.json({ generated, usage: { inputTokens: aiResult.usage?.promptTokens || 0, outputTokens: aiResult.usage?.completionTokens || 0 } });
}));

// POST /api/admin/writers — create writer
router.post('/', requirePermission('writers.create'), asyncHandler(async (req, res) => {
  const body = validate(writerCreate, req.body, res);
  if (!body) return;

  const limit = await checkPlanLimit(req.tenantId, 'writers');
  if (!limit.allowed) {
    return res.status(403).json({ error: 'Plan limit reached', resource: 'writers', current: limit.current, max: limit.max });
  }

  const { name, slug, bio, beat, beats, keywords, system_prompt, chat_prompt, is_auto,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size, elevenlabs_voice_id,
          tone, expertise_level, style_guide, few_shot_examples, gender, ethnicity,
          signature_phrases, contrarian_level, beat_angle, role, team_id, is_system } = body;

  const resolvedSlug = (slug || toSlug(name)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  const writer = await db.prepare(`
    INSERT INTO writers (name, slug, bio, beat, keywords, system_prompt, chat_prompt, is_auto,
      synthesis_schedule, synthesis_lookback_hours, min_cluster_size, elevenlabs_voice_id,
      tone, expertise_level, style_guide, few_shot_examples, gender, ethnicity,
      signature_phrases, contrarian_level, beat_angle, role, team_id, is_system, tenant_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
    RETURNING *
  `).get(
    name, resolvedSlug, bio || null, beat || null,
    keywords.length ? keywords : null,
    system_prompt || null, chat_prompt || null, is_auto || false,
    synthesis_schedule, synthesis_lookback_hours, min_cluster_size,
    elevenlabs_voice_id || null,
    tone || null, expertise_level || null, style_guide || null,
    JSON.stringify(few_shot_examples || []),
    gender || null, ethnicity || null,
    signature_phrases || null, contrarian_level ?? 0.5, beat_angle || null,
    role || 'writer', team_id || null, is_system || false,
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

  const { name, slug, bio, beat, beats, keywords, system_prompt, chat_prompt, is_auto,
          synthesis_schedule, synthesis_lookback_hours, min_cluster_size, elevenlabs_voice_id,
          tone, expertise_level, style_guide, few_shot_examples, gender, ethnicity,
          signature_phrases, contrarian_level, beat_angle, role, team_id, is_system,
          accent_color } = body;

  const existingFse = typeof existing.few_shot_examples === 'string'
    ? existing.few_shot_examples : JSON.stringify(existing.few_shot_examples || []);

  const writer = await db.prepare(`
    UPDATE writers SET name = $1, slug = $2, bio = $3, beat = $4, keywords = $5,
      system_prompt = $6, chat_prompt = $7, is_auto = $8, synthesis_schedule = $9,
      synthesis_lookback_hours = $10, min_cluster_size = $11, elevenlabs_voice_id = $12,
      tone = $13, expertise_level = $14, style_guide = $15, few_shot_examples = $16,
      gender = $17, ethnicity = $18,
      signature_phrases = $19, contrarian_level = $20, beat_angle = $21,
      role = $22, team_id = $23, is_system = $24,
      accent_color = $27
    WHERE id = $25 AND tenant_id = $26
    RETURNING *
  `).get(
    name,
    slug !== undefined ? (slug || null) : (existing.slug || toSlug(name || existing.name)),
    bio !== undefined ? (bio || null) : existing.bio,
    beat !== undefined ? (beat || null) : existing.beat,
    keywords !== undefined ? (keywords.length ? keywords : null) : existing.keywords,
    system_prompt !== undefined ? (system_prompt || null) : existing.system_prompt,
    chat_prompt !== undefined ? (chat_prompt || null) : existing.chat_prompt,
    is_auto !== undefined ? (is_auto || false) : existing.is_auto,
    synthesis_schedule !== undefined ? synthesis_schedule : existing.synthesis_schedule,
    synthesis_lookback_hours !== undefined ? synthesis_lookback_hours : existing.synthesis_lookback_hours,
    min_cluster_size !== undefined ? min_cluster_size : existing.min_cluster_size,
    elevenlabs_voice_id !== undefined ? (elevenlabs_voice_id || null) : existing.elevenlabs_voice_id,
    tone !== undefined ? (tone || null) : existing.tone,
    expertise_level !== undefined ? (expertise_level || null) : existing.expertise_level,
    style_guide !== undefined ? (style_guide || null) : existing.style_guide,
    few_shot_examples !== undefined ? JSON.stringify(few_shot_examples) : existingFse,
    gender !== undefined ? (gender || null) : existing.gender,
    ethnicity !== undefined ? (ethnicity || null) : existing.ethnicity,
    signature_phrases !== undefined ? signature_phrases : existing.signature_phrases,
    contrarian_level !== undefined ? contrarian_level : existing.contrarian_level,
    beat_angle !== undefined ? (beat_angle || null) : existing.beat_angle,
    role !== undefined ? (role || 'writer') : (existing.role || 'writer'),
    team_id !== undefined ? (team_id || null) : existing.team_id,
    is_system !== undefined ? (is_system || false) : (existing.is_system || false),
    id,
    req.tenantId,
    accent_color !== undefined ? (accent_color || null) : (existing.accent_color || null),
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

  const avatarUrl = await storeAvatar(Buffer.from(match[2], 'base64'), match[1], id, req.tenantId);
  await db.prepare('UPDATE writers SET avatar_url = $1 WHERE id = $2 AND tenant_id = $3').run(avatarUrl, id, req.tenantId);
  const updated = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  res.json(updated);
}));

// POST /api/admin/writers/:id/generate-avatar — AI-generate avatar with Imagen
router.post('/:id/generate-avatar', requirePermission('writers.update'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

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

  const { generateImage: aiGenerateImage } = require('../lib/ai-router');
  let imageResult;
  try {
    imageResult = await aiGenerateImage({
      tenantId: req.tenantId,
      prompt,
      operation: 'writer-avatar',
      aspectRatio: '1:1',
      trigger: 'manual',
    });
  } catch (err) {
    if (err.code === 'MISSING_KEY') {
      return res.status(500).json({ error: 'Gemini/Imagen API key not configured' });
    }
    console.error(`[AvatarGen] Image generation error:`, err.message);
    return res.status(502).json({ error: `Image generation error: ${err.message}` });
  }

  const avatarUrl = await storeAvatar(Buffer.from(imageResult.b64, 'base64'), 'image/png', id, req.tenantId);
  await db.prepare('UPDATE writers SET avatar_url = $1 WHERE id = $2 AND tenant_id = $3').run(avatarUrl, id, req.tenantId);

  const updated = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  res.json({ ...updated, _avatarPrompt: prompt });
}));

// POST /api/admin/writers/:id/generate-chat-prompt — AI-generate chat persona
router.post('/:id/generate-chat-prompt', requirePermission('writers.update'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  // Gather context for the generation
  const beats = await getBeats(id, req.tenantId);
  const beatNames = beats.map(b => b.name).join(', ') || 'general news';

  const articles = await db.prepare(`
    SELECT title, COALESCE(tldr_overview, LEFT(summary, 200)) AS snippet
    FROM articles WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive') AND is_published = 1
    ORDER BY published_at DESC LIMIT 10
  `).all(id, req.tenantId);

  const { getRelevantMemories } = require('../lib/writer-memory');
  const memories = await getRelevantMemories(parseInt(id), req.tenantId, '', 10);

  let context = `Writer: ${writer.name}\nBeats: ${beatNames}`;
  if (writer.tone) context += `\nTone: ${writer.tone}`;
  if (writer.beat_angle) context += `\nAngle: ${writer.beat_angle}`;
  if (writer.bio) context += `\nBio: ${writer.bio}`;
  if (writer.signature_phrases?.length) context += `\nSignature phrases: ${writer.signature_phrases.join(', ')}`;
  if (articles.length) {
    context += '\n\nRecent articles:';
    for (const a of articles) context += `\n- ${a.title}` + (a.snippet ? `: ${a.snippet}` : '');
  }
  if (memories.length) {
    context += '\n\nEditorial memories:';
    for (const m of memories) context += `\n- ${m.subject}` + (m.content ? `: ${m.content.slice(0, 150)}` : '');
  }

  const result = await aiComplete({
    operation: 'chat',
    tenantId: req.tenantId,
    messages: [
      { role: 'system', content: 'You write behavioral instructions for AI chat personas. Your output will be injected as a system prompt — it must be INSTRUCTIONS ABOUT how the persona behaves, NOT example content or articles the persona would write. Never generate sample dialogue or article text.' },
      { role: 'user', content: `Write a chat persona instruction for an AI writer who will respond to messages on Discord/Slack/Telegram.

IMPORTANT: This is a SYSTEM PROMPT that tells the AI how to behave. It is NOT a sample response. Do NOT write example articles, talking points, or sample dialogue. Write ONLY behavioral instructions.

Good example:
"You're blunt and impatient with marketing fluff — you've reviewed enough product launches to spot recycled claims instantly. You explain technical concepts through supply chain economics, not spec sheets. When someone mentions a company, you instinctively compare it to 2-3 competitors. You drop phrases like 'follow the silicon' and 'that's a rebrand, not a breakthrough.' You're generous with your analysis but skeptical of press releases."

Bad example (DO NOT do this):
"In the ever-evolving landscape of technology, we must consider the implications of AI..."

The instruction should describe:
- Personality and attitude (how they react to hype, skepticism, excitement)
- How they explain things (analogies, depth level, references)
- Conversational quirks (catchphrases, habits, tone shifts)
- What makes them sound like a real person, not a press release

Write in second person ("You're..."). 4-6 complete sentences. Output ONLY the persona instruction, nothing else.

${context}` },
    ],
    temperature: 0.8,
    maxTokens: 1024,
    trigger: 'manual',
    writerId: parseInt(id),
  });

  if (!result?.text) return res.status(502).json({ error: 'AI generation returned no result' });

  // Save to DB
  await db.prepare('UPDATE writers SET chat_prompt = $1 WHERE id = $2 AND tenant_id = $3').run(result.text, id, req.tenantId);

  logAudit(req, 'writer.generate-chat-prompt', 'writer', parseInt(id), { name: writer.name });
  res.json({ chat_prompt: result.text });
}));

// POST /api/admin/writers/:id/regenerate-persona — refresh or fully rewrite persona
router.post('/:id/regenerate-persona', requirePermission('writers.update'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const mode = req.body?.mode === 'rewrite' ? 'rewrite' : 'refresh';
  const preserveName = req.body?.preserveName !== false; // default true

  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  const beats = await getBeats(id, req.tenantId);
  if (!beats.length) {
    return res.status(400).json({ error: 'Assign at least one beat before regenerating the persona' });
  }

  // Build beats context with category descriptions + keywords
  const cats = await getCategories(req.tenantId);
  const catById = new Map(cats.map(c => [c.id, c]));
  const beatLines = beats.map(b => {
    const c = catById.get(b.id) || {};
    const kw = (c.keywords || []).slice(0, 8).join(', ');
    return `- "${b.name}"${c.description ? ': ' + c.description : ''}${kw ? ' (keywords: ' + kw + ')' : ''}`;
  }).join('\n');

  let promptName, vars;
  if (mode === 'refresh') {
    promptName = 'regenerate-writer-refresh';
    vars = {
      name: writer.name || '',
      tone: writer.tone || '(not set)',
      expertise_level: writer.expertise_level || '(not set)',
      bio: writer.bio || '(none)',
      style_guide: writer.style_guide || '(none)',
      system_prompt: writer.system_prompt || '(none)',
      signature_phrases: Array.isArray(writer.signature_phrases) && writer.signature_phrases.length
        ? writer.signature_phrases.join(', ') : '(none)',
      keywords: Array.isArray(writer.keywords) && writer.keywords.length
        ? writer.keywords.join(', ') : '(none)',
      beats: beatLines,
    };
  } else {
    promptName = 'regenerate-writer-rewrite';
    vars = {
      beats: beatLines,
      nameConstraint: preserveName
        ? `Keep the existing name: "${writer.name}".`
        : 'Generate a new single first name (no last name).',
      nameInstruction: preserveName
        ? `must be exactly "${writer.name}"`
        : 'a single first name only (no last name)',
    };
  }

  const p = loadPrompt(promptName);
  const { messages, ...meta } = p.render(vars);

  const aiResult = await aiComplete({
    ...meta, messages, tenantId: req.tenantId,
    trigger: 'admin', writerId: parseInt(id),
  });

  if (!aiResult) return res.status(503).json({ error: 'AI service unavailable or budget denied' });

  let persona;
  try {
    persona = parseTruncatedJsonObject(aiResult.text.trim());
  } catch (err) {
    console.error('[regenerate-persona] parse error:', err.message, 'raw:', aiResult.text.slice(0, 200));
    return res.status(502).json({ error: 'Failed to parse AI response', raw: aiResult.text });
  }

  // Build update set based on mode
  const updates = {};
  const allowed = {
    refresh: ['bio', 'tone', 'expertise_level', 'style_guide', 'system_prompt', 'keywords', 'beat_angle'],
    rewrite: ['bio', 'tone', 'expertise_level', 'style_guide', 'system_prompt', 'keywords', 'beat_angle',
              'gender', 'ethnicity', 'signature_phrases'],
  };
  for (const field of allowed[mode]) {
    if (persona[field] !== undefined && persona[field] !== null) {
      updates[field] = persona[field];
    }
  }
  if (mode === 'rewrite' && !preserveName && persona.name && typeof persona.name === 'string') {
    updates.name = persona.name.trim();
  }

  const changedFields = Object.keys(updates);
  if (!changedFields.length) {
    return res.status(502).json({ error: 'AI response contained no valid fields', raw: aiResult.text });
  }

  // Build dynamic UPDATE
  const setClauses = [];
  const values = [];
  let idx = 1;
  for (const field of changedFields) {
    setClauses.push(`${field} = $${idx++}`);
    values.push(updates[field]);
  }
  values.push(id, req.tenantId);
  await db.prepare(
    `UPDATE writers SET ${setClauses.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx}`
  ).run(...values);

  logAudit(req, 'writer.regenerate-persona', 'writer', parseInt(id), { mode, fields: changedFields });

  const updated = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  res.json({ writer: updated, mode, fields: changedFields });
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
        AND created_at > NOW() - make_interval(days => $1)
      GROUP BY writer_id
    ),
    reaction_stats AS (
      SELECT a.writer_id, COUNT(r.id)::int AS total_reactions
      FROM article_reactions r
      JOIN articles a ON a.slug = r.article_slug AND a.tenant_id = $2
      WHERE a.writer_id IS NOT NULL
        AND r.created_at > NOW() - make_interval(days => $1)
      GROUP BY a.writer_id
    ),
    comment_stats AS (
      SELECT a.writer_id, COUNT(cm.id)::int AS total_comments
      FROM comments cm
      JOIN articles a ON a.slug = cm.article_slug AND a.tenant_id = $2
      WHERE a.writer_id IS NOT NULL
        AND cm.is_deleted = 0
        AND cm.created_at > NOW() - make_interval(days => $1)
      GROUP BY a.writer_id
    ),
    view_stats AS (
      SELECT a.writer_id,
             COUNT(*) FILTER (WHERE e.event_type = 'view')::int AS total_views,
             COUNT(*) FILTER (WHERE e.event_type = 'audio_play')::int AS total_audio_plays
      FROM analytics_events e
      JOIN articles a ON a.slug = e.article_slug AND a.tenant_id = $2
      WHERE a.writer_id IS NOT NULL
        AND e.created_at > NOW() - make_interval(days => $1)
      GROUP BY a.writer_id
    ),
    cost_stats AS (
      SELECT writer_id,
             ROUND(SUM(estimated_cost)::numeric, 4) AS total_cost
      FROM ai_usage
      WHERE writer_id IS NOT NULL
        AND tenant_id = $2
        AND created_at > NOW() - make_interval(days => $1)
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

// ── Writer Memory endpoints ────────────────────────────────────────────

// GET /api/admin/writers/:id/memories — list memories for a writer
router.get('/:id/memories', requirePermission('writers.read'), asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const offset = (page - 1) * limit;

  const memories = await db.prepare(`
    SELECT id, memory_type, subject, content, confidence, created_at, expires_at
    FROM writer_memory
    WHERE writer_id = $1 AND tenant_id = $2
    ORDER BY created_at DESC
    LIMIT $3 OFFSET $4
  `).all(parseInt(req.params.id), req.tenantId, limit, offset);

  const { cnt } = await db.prepare(
    'SELECT COUNT(*)::int AS cnt FROM writer_memory WHERE writer_id = $1 AND tenant_id = $2'
  ).get(parseInt(req.params.id), req.tenantId);

  res.json({ memories, total: cnt, page, limit });
}));

// POST /api/admin/writers/:id/memories — manually add a memory entry
router.post('/:id/memories', requirePermission('writers.update'), asyncHandler(async (req, res) => {
  const { memory_type, subject, content, confidence, expires_in_days } = req.body;
  const validTypes = ['position', 'thread', 'source_note', 'prediction'];
  if (!validTypes.includes(memory_type)) return res.status(400).json({ error: 'Invalid memory_type' });
  if (!subject || !content) return res.status(400).json({ error: 'subject and content required' });
  const conf = confidence ?? 0.80;
  if (typeof conf !== 'number' || conf < 0 || conf > 1) return res.status(400).json({ error: 'confidence must be between 0 and 1' });

  const expiresAt = expires_in_days
    ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
    : null;

  const row = await db.prepare(`
    INSERT INTO writer_memory (writer_id, tenant_id, memory_type, subject, content, confidence, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
  `).get(
    parseInt(req.params.id), req.tenantId, memory_type,
    String(subject).slice(0, 200), String(content).slice(0, 500),
    conf, expiresAt
  );

  logAudit(req, 'writer.memory.create', 'writer_memory', row.id, { memory_type, subject });
  res.json(row);
}));

// DELETE /api/admin/writers/:id/memories/:memoryId — delete a memory
router.delete('/:id/memories/:memoryId', requirePermission('writers.update'), asyncHandler(async (req, res) => {
  // Verify memory belongs to this writer + tenant
  const mem = await db.prepare(
    'SELECT id FROM writer_memory WHERE id = $1 AND writer_id = $2 AND tenant_id = $3'
  ).get(parseInt(req.params.memoryId), parseInt(req.params.id), req.tenantId);
  if (!mem) return res.status(404).json({ error: 'Memory not found' });

  const { deleteMemory } = require('../lib/writer-memory');
  await deleteMemory(parseInt(req.params.memoryId), req.tenantId);
  logAudit(req, 'writer.memory.delete', 'writer_memory', parseInt(req.params.memoryId), {});
  res.json({ ok: true });
}));

// ── Teams ─────────────────────────────────────────────────────

// GET /api/admin/writers/teams — list teams
router.get('/teams', requirePermission('writers.read'), asyncHandler(async (req, res) => {
  const teams = await db.prepare(
    'SELECT * FROM teams WHERE tenant_id = $1 ORDER BY name'
  ).all(req.tenantId);
  // Attach agent counts per team
  for (const team of teams) {
    const count = await db.prepare(
      'SELECT COUNT(*)::int AS cnt FROM writers WHERE team_id = $1 AND tenant_id = $2'
    ).get(team.id, req.tenantId);
    team.agent_count = count?.cnt || 0;
  }
  res.json(teams);
}));

// POST /api/admin/writers/teams — create team
router.post('/teams', requirePermission('writers.create'), asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Team name is required' });
  const team = await db.prepare(
    'INSERT INTO teams (tenant_id, name, description) VALUES ($1, $2, $3) RETURNING *'
  ).get(req.tenantId, name, description || null);
  logAudit(req, 'team.create', 'team', team.id, { name });
  res.json(team);
}));

// PUT /api/admin/writers/teams/:id — update team
router.put('/teams/:id', requirePermission('writers.update'), asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const team = await db.prepare(
    'UPDATE teams SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3 AND tenant_id = $4 RETURNING *'
  ).get(name || null, description !== undefined ? description : null, req.params.id, req.tenantId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json(team);
}));

// DELETE /api/admin/writers/teams/:id — delete team (agents get team_id = NULL)
router.delete('/teams/:id', requirePermission('writers.delete'), asyncHandler(async (req, res) => {
  await db.prepare('UPDATE writers SET team_id = NULL WHERE team_id = $1 AND tenant_id = $2').run(req.params.id, req.tenantId);
  const result = await db.prepare('DELETE FROM teams WHERE id = $1 AND tenant_id = $2 RETURNING *').get(req.params.id, req.tenantId);
  if (!result) return res.status(404).json({ error: 'Team not found' });
  logAudit(req, 'team.delete', 'team', parseInt(req.params.id), { name: result.name });
  res.json({ ok: true });
}));

module.exports = router;
