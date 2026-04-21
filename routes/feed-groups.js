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

// POST /api/feed-groups/auto-sort — AI proposes folder assignments for ungrouped articles
// Body: { article_ids?: number[], dry_run?: bool }
//   article_ids — if omitted, targets all ungrouped curated articles (max 200)
//   dry_run — if true (default), returns proposals without writing; false applies immediately
router.post('/auto-sort', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const tid = req.tenantId;
  const { article_ids, dry_run = true } = req.body || {};

  // 1. Fetch existing folders
  const groupRows = await getPool().query(
    `SELECT id, name FROM feed_groups WHERE tenant_id = $1 ORDER BY name ASC`, [tid]
  );
  const existingGroups = groupRows.rows; // [{ id, name }]

  // 2. Fetch ungrouped articles to sort
  let articleRows;
  if (Array.isArray(article_ids) && article_ids.length) {
    const ids = article_ids.map(Number).filter(Boolean);
    articleRows = await getPool().query(
      `SELECT id, title, category, summary FROM articles
       WHERE tenant_id = $1 AND id = ANY($2::int[])
         AND (content_type IS NULL OR content_type = 'curated') AND is_archived = 0
       LIMIT 200`,
      [tid, ids]
    );
  } else {
    articleRows = await getPool().query(
      `SELECT id, title, category, summary FROM articles
       WHERE tenant_id = $1 AND group_id IS NULL
         AND (content_type IS NULL OR content_type = 'curated') AND is_archived = 0
       ORDER BY created_at DESC LIMIT 200`,
      [tid]
    );
  }

  const articles = articleRows.rows;
  if (!articles.length) return res.json({ proposals: [], new_folders: [], applied: 0 });

  // 3. Build AI prompt
  const folderList = existingGroups.length
    ? existingGroups.map(g => `- ${g.name}`).join('\n')
    : '(none yet)';

  const articleList = articles
    .map(a => `${a.id}: ${a.title}${a.category ? ` [${a.category}]` : ''}`)
    .join('\n');

  const systemPrompt =
    `You are an editorial assistant helping a journalist organise their research inbox into topic folders.\n` +
    `Assign each article to the most relevant folder. You may also propose new folder names if no existing folder fits.\n` +
    `Respond ONLY with a JSON object — no prose, no markdown fences.\n` +
    `Schema: { "assignments": [ { "id": <number>, "folder": "<folder name>" } ], "new_folders": ["<name>", ...] }\n` +
    `Rules:\n` +
    `- Prefer existing folders when a good match exists.\n` +
    `- Propose a new folder name only when no existing folder fits multiple articles.\n` +
    `- Keep folder names short (2–4 words), title-case.\n` +
    `- Every article must appear in assignments exactly once.`;

  const userPrompt =
    `Existing folders:\n${folderList}\n\nArticles to sort:\n${articleList}`;

  const aiResult = await complete({
    operation: 'categorize',
    tenantId: tid,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens: 2000,
    trigger: 'manual',
  });

  if (!aiResult?.content) {
    return res.status(502).json({ error: 'AI did not return a response. Check provider configuration.' });
  }

  // 4. Parse AI JSON response (strip any accidental fencing)
  let parsed;
  try {
    const raw = aiResult.content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(raw);
  } catch {
    return res.status(502).json({ error: 'AI returned invalid JSON', raw: aiResult.content.slice(0, 500) });
  }

  const assignments = Array.isArray(parsed.assignments) ? parsed.assignments : [];
  const newFolderNames = Array.isArray(parsed.new_folders) ? parsed.new_folders : [];

  if (dry_run) {
    return res.json({
      proposals: assignments,
      new_folders: newFolderNames,
      applied: 0,
    });
  }

  // 5. Apply: create new folders, then assign articles
  const pool = getPool();
  const folderMap = Object.fromEntries(existingGroups.map(g => [g.name.toLowerCase(), g.id]));

  for (const name of newFolderNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!folderMap[key]) {
      const ins = await pool.query(
        `INSERT INTO feed_groups (tenant_id, name, color, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name`,
        [tid, trimmed, '#6366f1', req.user?.sub || null]
      );
      folderMap[key] = ins.rows[0].id;
    }
  }

  // Re-fetch all groups to include any we just created
  const allGroupRows = await pool.query(
    `SELECT id, name FROM feed_groups WHERE tenant_id = $1`, [tid]
  );
  const allGroupMap = Object.fromEntries(allGroupRows.rows.map(g => [g.name.toLowerCase(), g.id]));

  let applied = 0;
  for (const { id, folder } of assignments) {
    if (!id || !folder) continue;
    const gid = allGroupMap[folder.toLowerCase()];
    if (!gid) continue;
    await pool.query(
      `UPDATE articles SET group_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
      [gid, id, tid]
    );
    applied++;
  }

  res.json({ proposals: assignments, new_folders: newFolderNames, applied });
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
