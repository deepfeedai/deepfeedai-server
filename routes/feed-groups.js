/**
 * Deep Feed AI — routes/feed-groups.js
 * Feed inbox folder/group management.
 */
const router  = require('express').Router();
const { getPool } = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');

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
