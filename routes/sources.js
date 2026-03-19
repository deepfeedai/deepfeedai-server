const express               = require('express');
const router                = express.Router();
const db                    = require('../db');
const { auth }              = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler }      = require('../lib/utils');
const { sourceCreate, sourceUpdate, validate } = require('../lib/schemas');
const { checkPlanLimit }    = require('../lib/plan-limits');
const { logAudit, logAuditWithDiff } = require('../middleware/audit');

// POST /api/sources/preview-feed — validate RSS URL and return feed metadata
const RSSParser = require('rss-parser');
const feedParser = new RSSParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; DeepFeedAI/1.0; +https://deepfeedai.com)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
});

router.post('/preview-feed', auth, requirePermission('sources.create'), asyncHandler(async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL is required' });

  const maxAttempts = 2;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const feed = await feedParser.parseURL(url);
      return res.json({
        title: feed.title || '',
        description: feed.description || '',
        itemCount: (feed.items || []).length,
      });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  const detail = lastErr.message || 'Unknown error';
  const statusHint = /403/.test(detail) ? 'blocked'
    : /404/.test(detail) ? 'not_found'
    : /ENOTFOUND|ECONNREFUSED/.test(detail) ? 'unreachable'
    : /timeout|ETIMEDOUT/.test(detail) ? 'timeout'
    : 'parse_error';
  res.status(422).json({ error: 'Could not parse RSS feed', detail, statusHint });
}));

// GET /api/sources
router.get('/', auth, requirePermission('sources.read'), asyncHandler(async (req, res) => {
  const sources = await db.prepare('SELECT * FROM sources WHERE tenant_id = $1 ORDER BY priority ASC, created_at DESC').all(req.tenantId);
  res.json(sources);
}));

// POST /api/sources
router.post('/', auth, requirePermission('sources.create'), asyncHandler(async (req, res) => {
  const body = validate(sourceCreate, req.body, res);
  if (!body) return;

  const limit = await checkPlanLimit(req.tenantId, 'sources');
  if (!limit.allowed) {
    return res.status(403).json({ error: 'Plan limit reached', resource: 'sources', current: limit.current, max: limit.max });
  }

  const { name, url, priority, is_active, auto_publish, auto_publish_max, default_category } = body;
  const source = await db.prepare(
    'INSERT INTO sources (name, url, priority, is_active, auto_publish, auto_publish_max, default_category, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *'
  ).get(name, url, priority, is_active ? 1 : 0, auto_publish ? 1 : 0, auto_publish_max, default_category || null, req.tenantId);
  logAudit(req, 'source.create', 'source', source.id, { name: source.name });
  res.status(201).json(source);
}));

// PUT /api/sources/:id
router.put('/:id', auth, requirePermission('sources.update'), asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM sources WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Source not found' });

  const body = validate(sourceUpdate, req.body, res);
  if (!body) return;

  const { name, url, priority, is_active, auto_publish, auto_publish_max, default_category } = body;
  const updated = await db.prepare(
    'UPDATE sources SET name = $1, url = $2, priority = $3, is_active = $4, auto_publish = $5, auto_publish_max = $6, default_category = $7 WHERE id = $8 AND tenant_id = $9 RETURNING *'
  ).get(
    name             ?? existing.name,
    url              ?? existing.url,
    priority         ?? existing.priority,
    is_active        !== undefined ? (is_active ? 1 : 0) : existing.is_active,
    auto_publish     !== undefined ? (auto_publish ? 1 : 0) : existing.auto_publish,
    auto_publish_max ?? existing.auto_publish_max,
    default_category !== undefined ? (default_category || null) : existing.default_category,
    req.params.id,
    req.tenantId
  );
  logAuditWithDiff(req, 'source.update', 'source', parseInt(req.params.id), existing, updated, { name: updated?.name });
  res.json(updated);
}));

// DELETE /api/sources/:id
router.delete('/:id', auth, requirePermission('sources.delete'), asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM sources WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Source not found' });
  await db.prepare('DELETE FROM sources WHERE id = $1 AND tenant_id = $2').run(req.params.id, req.tenantId);
  logAudit(req, 'source.delete', 'source', parseInt(req.params.id));
  res.json({ message: 'Source deleted' });
}));

// PUT /api/sources/:id/toggle
router.put('/:id/toggle', auth, requirePermission('sources.update'), asyncHandler(async (req, res) => {
  const source = await db.prepare('SELECT * FROM sources WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!source) return res.status(404).json({ error: 'Source not found' });
  const newVal = source.is_active ? 0 : 1;
  await db.prepare('UPDATE sources SET is_active = $1 WHERE id = $2 AND tenant_id = $3').run(newVal, req.params.id, req.tenantId);
  res.json({ id: source.id, is_active: newVal });
}));

module.exports = router;
