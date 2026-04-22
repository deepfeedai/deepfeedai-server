/**
 * Deep Feed AI — routes/feed-groups.js
 * Feed inbox folder/group management.
 */
const router  = require('express').Router();
const { getPool } = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { complete } = require('../lib/ai-router');

const FOLDER_NAME_MAX   = 30;  // chars — keeps panel + chips readable
const FOLDER_NEW_MAX    = 8;   // new folders per AI run
const FOLDER_TOTAL_SOFT = 25;  // soft cap per tenant

function sanitizeFolderName(name) {
  return String(name || '').trim().slice(0, FOLDER_NAME_MAX);
}

// POST /api/feed-groups/auto-sort
// Body: { article_ids?, seeds?, dry_run? }
//   article_ids — explicit list; omit to target all ungrouped categorized articles (≤200)
//   seeds       — string[] of editor-supplied folder names; AI assigns to these only
//   dry_run     — true (default) = preview only; false = create folders + assign
router.post('/auto-sort', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const { article_ids, dry_run = true } = req.body || {};
  const seeds = Array.isArray(req.body?.seeds)
    ? req.body.seeds.map(sanitizeFolderName).filter(Boolean)
    : [];

  // 1. Fetch existing folders + enforce soft cap
  const groupRows = await getPool().query(
    `SELECT id, name FROM feed_groups WHERE tenant_id = $1 ORDER BY name ASC`, [tid]
  );
  const existingGroups = groupRows.rows;
  const remainingSlots = FOLDER_TOTAL_SOFT - existingGroups.length;

  if (!dry_run && remainingSlots <= 0) {
    return res.status(400).json({
      error: `Folder limit reached (${FOLDER_TOTAL_SOFT}). Delete some folders before creating more.`,
    });
  }

  // 2. Fetch articles — exclude uncategorized, cap at 200
  const BASE_FILTER = `(content_type IS NULL OR content_type = 'curated') AND is_archived = 0
    AND category IS NOT NULL AND category != 'Uncategorized'`;

  let articleRows;
  if (Array.isArray(article_ids) && article_ids.length) {
    const ids = article_ids.map(Number).filter(Boolean);
    articleRows = await getPool().query(
      `SELECT id, title, category FROM articles
       WHERE tenant_id = $1 AND id = ANY($2::int[]) AND ${BASE_FILTER}
       LIMIT 200`,
      [tid, ids]
    );
  } else {
    articleRows = await getPool().query(
      `SELECT id, title, category FROM articles
       WHERE tenant_id = $1 AND group_id IS NULL AND ${BASE_FILTER}
       ORDER BY created_at DESC LIMIT 200`,
      [tid]
    );
  }

  const articles = articleRows.rows;
  const totalUngrouped = Array.isArray(article_ids) ? article_ids.length : null;
  const skipped = totalUngrouped ? Math.max(0, totalUngrouped - articles.length) : 0;

  if (!articles.length) return res.json({ proposals: [], new_folders: [], applied: 0, skipped: 0 });

  // 3. Build prompt — three distinct modes
  const isColdStart = existingGroups.length === 0 && seeds.length === 0;
  const isSeeded    = seeds.length > 0;
  const maxNew      = Math.min(FOLDER_NEW_MAX, Math.max(0, remainingSlots));

  const articleList = articles
    .map(a => `${a.id}: ${a.title}${a.category ? ` [${a.category}]` : ''}`)
    .join('\n');

  let systemPrompt, userPrompt;

  if (isSeeded) {
    // Editor provided folder names — AI assigns only, never invents new names
    systemPrompt =
      `You are an editorial assistant assigning news articles to predefined folders.\n` +
      `Assign every article to exactly one of the provided folders — the best topical match.\n` +
      `Never invent new folder names. If an article fits none well, pick the closest one.\n` +
      `Respond ONLY with a JSON object — no prose, no markdown fences.\n` +
      `Schema: { "assignments": [ { "id": <number>, "folder": "<folder name>" } ], "new_folders": [] }\n` +
      `Folder names must be used exactly as given (spelling and capitalisation).`;
    userPrompt =
      `Folders to use:\n${seeds.map(s => `- ${s}`).join('\n')}\n\nArticles:\n${articleList}`;

  } else if (isColdStart) {
    // No existing folders — AI invents the taxonomy from scratch
    systemPrompt =
      `You are an editorial assistant building a folder taxonomy for a journalist's research inbox.\n` +
      `Analyse the article titles and invent ${maxNew} or fewer meaningful topic folders, then assign every article.\n` +
      `Respond ONLY with a JSON object — no prose, no markdown fences.\n` +
      `Schema: { "assignments": [ { "id": <number>, "folder": "<folder name>" } ], "new_folders": ["<name>", ...] }\n` +
      `Rules:\n` +
      `- Create between 3 and ${maxNew} folders — no more, no fewer.\n` +
      `- Folder names: 2–4 words, title-case, ≤${FOLDER_NAME_MAX} characters.\n` +
      `- Group by recurring topic, not by category label.\n` +
      `- Every article must appear in assignments exactly once.`;
    userPrompt = `Articles to organise:\n${articleList}`;

  } else {
    // Existing folders — assign to them, propose new only if truly needed
    systemPrompt =
      `You are an editorial assistant organising news articles into topic folders.\n` +
      `Prefer existing folders. Propose a new folder only when no existing folder fits a clear cluster of articles.\n` +
      `Respond ONLY with a JSON object — no prose, no markdown fences.\n` +
      `Schema: { "assignments": [ { "id": <number>, "folder": "<folder name>" } ], "new_folders": ["<name>", ...] }\n` +
      `Rules:\n` +
      `- Propose at most ${maxNew} new folder${maxNew === 1 ? '' : 's'} total.\n` +
      `- Folder names: 2–4 words, title-case, ≤${FOLDER_NAME_MAX} characters.\n` +
      `- Every article must appear in assignments exactly once.`;
    userPrompt =
      `Existing folders:\n${existingGroups.map(g => `- ${g.name}`).join('\n')}\n\nArticles:\n${articleList}`;
  }

  // 4. Call AI
  // Each assignment is ~25 tokens; 200 articles → ~5000 tokens output. Give headroom.
  const neededTokens = Math.min(4000, 500 + articles.length * 25);

  const aiResult = await complete({
    operation: 'categorize',
    tenantId: tid,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens: neededTokens,
    trigger: 'manual',
  });

  if (!aiResult) {
    return res.status(402).json({ error: 'AI request blocked — credit budget exhausted or provider not configured.' });
  }
  if (!aiResult.text) {
    return res.status(502).json({ error: 'AI returned an empty response.', provider: aiResult.provider, model: aiResult.model });
  }

  // 5. Parse response — three-stage approach: clean JSON → repaired JSON → regex fallback
  let parsed;
  const rawText = aiResult.text;

  const tryParseJson = (s) => {
    const start = s.indexOf('{');
    const end   = s.lastIndexOf('}');
    if (start === -1 || end < start) throw new Error('no JSON object');
    return JSON.parse(s.slice(start, end + 1));
  };

  try {
    // Stage 1: direct extraction
    parsed = tryParseJson(rawText);
  } catch {
    try {
      // Stage 2: repair trailing commas + close truncated structure
      let repaired = rawText
        .replace(/,\s*([}\]])/g, '$1')              // trailing commas
        .replace(/[\x00-\x1f]/g, ' ');              // control chars
      const unclosedArrays  = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
      const unclosedObjects = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
      // If truncated mid-string, drop the last incomplete token
      repaired = repaired.replace(/,?\s*\{[^}]*$/, '');
      for (let i = 0; i < Math.max(0, unclosedArrays);  i++) repaired += ']';
      for (let i = 0; i < Math.max(0, unclosedObjects); i++) repaired += '}';
      parsed = tryParseJson(repaired);
    } catch {
      // Stage 3: regex — pull out whatever assignments and folder names exist
      console.warn('[auto-sort] JSON parse failed, falling back to regex extraction. Raw:', rawText.slice(0, 400));
      const assignMatches = [...rawText.matchAll(/"id"\s*:\s*(\d+)[^}]*?"folder"\s*:\s*"([^"]+)"/g)];
      const folderMatches = [...rawText.matchAll(/"new_folders"\s*:\s*\[([^\]]*)\]/s)];
      if (!assignMatches.length) {
        console.error('[auto-sort] Regex fallback found nothing. Raw:', rawText.slice(0, 800));
        return res.status(502).json({ error: 'AI returned unrecoverable JSON', raw: rawText.slice(0, 500) });
      }
      const rawFolders = folderMatches[0]?.[1] || '';
      parsed = {
        assignments: assignMatches.map(m => ({ id: Number(m[1]), folder: m[2] })),
        new_folders: [...rawFolders.matchAll(/"([^"]+)"/g)].map(m => m[1]),
      };
    }
  }

  // Validate assignments — only keep known article IDs, sanitize folder names
  const validIds = new Set(articles.map(a => a.id));
  const assignments = (Array.isArray(parsed.assignments) ? parsed.assignments : [])
    .filter(p => p?.id && validIds.has(Number(p.id)) && p.folder)
    .map(p => ({ id: Number(p.id), folder: sanitizeFolderName(p.folder) }));

  // Enforce new-folder cap; seed mode never gets new folders
  let newFolderNames = isSeeded ? [] : (Array.isArray(parsed.new_folders) ? parsed.new_folders : [])
    .map(sanitizeFolderName)
    .filter(Boolean)
    .slice(0, maxNew);

  // Deduplicate against existing (case-insensitive)
  const existingLower = new Set(existingGroups.map(g => g.name.toLowerCase()));
  newFolderNames = newFolderNames.filter(n => !existingLower.has(n.toLowerCase()));

  const assignedIds = new Set(assignments.map(a => a.id));
  const missedCount = articles.filter(a => !assignedIds.has(a.id)).length;

  if (dry_run) {
    return res.json({ proposals: assignments, new_folders: newFolderNames, skipped, missed: missedCount, applied: 0 });
  }

  // 6. Apply — create new folders then bulk-assign
  const pool = getPool();
  const folderMap = Object.fromEntries(existingGroups.map(g => [g.name.toLowerCase(), g.id]));

  // Assign colors cycling through a palette
  const PALETTE = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444','#14b8a6'];
  let colorIdx = existingGroups.length % PALETTE.length;

  for (const name of newFolderNames) {
    const key = name.toLowerCase();
    if (folderMap[key]) continue;
    const ins = await pool.query(
      `INSERT INTO feed_groups (tenant_id, name, color, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [tid, name, PALETTE[colorIdx % PALETTE.length], req.user?.sub || null]
    );
    folderMap[key] = ins.rows[0].id;
    colorIdx++;
  }

  const allGroupRows = await pool.query(`SELECT id, name FROM feed_groups WHERE tenant_id = $1`, [tid]);
  const allGroupMap = Object.fromEntries(allGroupRows.rows.map(g => [g.name.toLowerCase(), g.id]));

  let applied = 0;
  for (const { id, folder } of assignments) {
    const gid = allGroupMap[folder.toLowerCase()];
    if (!gid) continue;
    await pool.query(
      `UPDATE articles SET group_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
      [gid, id, tid]
    );
    applied++;
  }

  res.json({ proposals: assignments, new_folders: newFolderNames, skipped, missed: missedCount, applied });
}));

// GET /api/feed-groups — list all groups with article count
router.get('/', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const rows = await getPool().query(
    `SELECT g.id, g.name, g.color, g.created_at,
            COUNT(a.id)::int AS article_count
     FROM feed_groups g
     LEFT JOIN articles a ON a.group_id = g.id AND a.tenant_id = g.tenant_id AND a.is_archived = 0
     WHERE g.tenant_id = $1
     GROUP BY g.id
     ORDER BY g.name ASC`,
    [tid]
  );
  // Also return ungrouped count
  const ungrouped = await getPool().query(
    `SELECT COUNT(*)::int AS cnt FROM articles
     WHERE tenant_id = $1 AND group_id IS NULL
       AND (content_type IS NULL OR content_type = 'curated') AND is_archived = 0`,
    [tid]
  );
  res.json({ groups: rows.rows, ungrouped_count: ungrouped.rows[0].cnt });
}));

// POST /api/feed-groups — create group
router.post('/', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const row = await getPool().query(
    `INSERT INTO feed_groups (tenant_id, name, color, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING *`,
    [tid, name.trim(), color || '#6366f1', req.user?.sub || null]
  );
  if (!row.rows[0]) return res.status(409).json({ error: 'A group with that name already exists' });
  res.status(201).json(row.rows[0]);
}));

// PUT /api/feed-groups/:id — rename / recolor
router.put('/:id', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const { name, color } = req.body || {};
  const existing = await getPool().query(
    'SELECT * FROM feed_groups WHERE id = $1 AND tenant_id = $2', [req.params.id, tid]
  );
  if (!existing.rows[0]) return res.status(404).json({ error: 'Group not found' });

  const newName  = name  !== undefined ? name.trim()  : existing.rows[0].name;
  const newColor = color !== undefined ? color         : existing.rows[0].color;
  if (!newName) return res.status(400).json({ error: 'name cannot be empty' });

  const row = await getPool().query(
    `UPDATE feed_groups SET name = $1, color = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *`,
    [newName, newColor, req.params.id, tid]
  );
  res.json(row.rows[0]);
}));

// DELETE /api/feed-groups/:id — delete group (articles become ungrouped)
router.delete('/:id', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const existing = await getPool().query(
    'SELECT id FROM feed_groups WHERE id = $1 AND tenant_id = $2', [req.params.id, tid]
  );
  if (!existing.rows[0]) return res.status(404).json({ error: 'Group not found' });
  // Articles get NULL group_id via ON DELETE SET NULL
  await getPool().query('DELETE FROM feed_groups WHERE id = $1 AND tenant_id = $2', [req.params.id, tid]);
  res.json({ message: 'Group deleted' });
}));

// PUT /api/feed-groups/:id/articles — move articles into group
router.put('/:id/articles', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const { article_ids } = req.body || {};
  if (!Array.isArray(article_ids) || !article_ids.length) {
    return res.status(400).json({ error: 'article_ids must be a non-empty array' });
  }
  const group = await getPool().query(
    'SELECT id FROM feed_groups WHERE id = $1 AND tenant_id = $2', [req.params.id, tid]
  );
  if (!group.rows[0]) return res.status(404).json({ error: 'Group not found' });

  const ids = article_ids.map(Number).filter(Boolean);
  await getPool().query(
    `UPDATE articles SET group_id = $1, updated_at = NOW()
     WHERE id = ANY($2::int[]) AND tenant_id = $3`,
    [req.params.id, ids, tid]
  );
  res.json({ moved: ids.length });
}));

// DELETE /api/feed-groups/:id/articles — remove articles from group (ungrouped)
router.delete('/:id/articles', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const { article_ids } = req.body || {};
  if (!Array.isArray(article_ids) || !article_ids.length) {
    return res.status(400).json({ error: 'article_ids must be a non-empty array' });
  }
  const ids = article_ids.map(Number).filter(Boolean);
  await getPool().query(
    `UPDATE articles SET group_id = NULL, updated_at = NOW()
     WHERE id = ANY($2::int[]) AND tenant_id = $3 AND group_id = $1`,
    [req.params.id, ids, tid]
  );
  res.json({ removed: ids.length });
}));

module.exports = router;
