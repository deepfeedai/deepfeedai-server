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

  // SSRF protection: validate URL does not resolve to private/internal IP
  const dns = require('dns').promises;
  const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|fc|fd)/;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http and https URLs are allowed' });
    }
    const resolved = await dns.lookup(parsed.hostname);
    if (PRIVATE_IP_RE.test(resolved.address)) {
      return res.status(400).json({ error: 'Private/internal URLs are not allowed' });
    }
  } catch (err) {
    if (err.code === 'ENOTFOUND') return res.status(400).json({ error: 'Unable to resolve hostname' });
    if (err.message?.includes('Invalid URL')) return res.status(400).json({ error: 'Invalid URL' });
    // Don't block on DNS failures for other reasons — let rss-parser handle it
  }

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
// Two-step: first call (no ?confirmed=true) returns article count if any exist.
// Second call with ?confirmed=true proceeds with deletion.
router.delete('/:id', auth, requirePermission('sources.delete'), asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT id, name FROM sources WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Source not found' });

  if (!req.query.confirmed) {
    const count = await db.prepare(
      `SELECT COUNT(*)::int AS n FROM articles WHERE tenant_id = $1 AND source = $2 AND content_type = 'curated'`
    ).get(req.tenantId, existing.name);
    if (count?.n > 0) {
      return res.json({ requires_confirmation: true, article_count: count.n, source_name: existing.name });
    }
  }

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

// ── Bulk helpers ──────────────────────────────────────────────────────────────

async function _bulkInsertSources(items, tenantId, planLimit) {
  const currentCount = planLimit.max != null
    ? ((await db.prepare('SELECT COUNT(*)::int AS n FROM sources WHERE tenant_id = $1').get(tenantId))?.n ?? 0)
    : 0;

  let added = 0, skipped = 0, runningCount = currentCount;
  const errors = [];

  for (const item of items.slice(0, 500)) {
    const name = String(item.name || '').trim().slice(0, 200);
    const url  = String(item.url  || '').trim();
    if (!name || !url) { errors.push({ url: url || '(empty)', reason: 'missing name or url' }); continue; }

    if (planLimit.max != null && runningCount >= planLimit.max) {
      errors.push({ url, reason: 'plan limit reached' });
      continue;
    }

    try {
      const row = await db.prepare(
        `INSERT INTO sources (name, url, priority, is_active, auto_publish, auto_publish_max, tenant_id)
         VALUES ($1, $2, 1, 1, 0, 5, $3)
         ON CONFLICT (tenant_id, url) DO NOTHING
         RETURNING id`
      ).get(name, url, tenantId);

      if (row?.id) { added++; runningCount++; }
      else skipped++;
    } catch (err) {
      errors.push({ url, reason: err.message });
    }
  }

  return { added, skipped, total: items.length, errors: errors.slice(0, 20) };
}

// POST /api/sources/bulk-add — batch-insert sources (used by "Add All" in the suggested panel)
router.post('/bulk-add', auth, requirePermission('sources.create'), asyncHandler(async (req, res) => {
  const { sources: items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'sources array is required' });
  }
  const limit = await checkPlanLimit(req.tenantId, 'sources');
  const result = await _bulkInsertSources(items, req.tenantId, limit);
  if (result.added > 0) logAudit(req, 'source.bulk_add', 'source', null, { added: result.added });
  res.json(result);
}));

// POST /api/sources/import-opml — parse OPML XML and bulk-insert all RSS feeds found
router.post('/import-opml', auth, requirePermission('sources.create'), asyncHandler(async (req, res) => {
  const content = req.body?.content;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content (OPML XML string) is required' });
  }
  if (content.length > 500_000) {
    return res.status(400).json({ error: 'OPML file too large (max 500 KB)' });
  }

  // Extract <outline> elements that carry an xmlUrl (RSS feed entries)
  const items = [];
  const outlineRe = /<outline\s([^>]*?)(?:\/>|>)/gi;
  let m;
  while ((m = outlineRe.exec(content)) !== null) {
    const attrs = m[1];
    const urlMatch  = attrs.match(/xmlUrl="([^"]+)"/i);
    if (!urlMatch) continue;
    const nameMatch = attrs.match(/title="([^"]+)"/i) || attrs.match(/text="([^"]+)"/i);
    items.push({ url: urlMatch[1], name: nameMatch ? nameMatch[1] : urlMatch[1] });
  }

  if (items.length === 0) {
    return res.status(422).json({ error: 'No RSS feeds found in OPML file' });
  }

  const limit = await checkPlanLimit(req.tenantId, 'sources');
  const result = await _bulkInsertSources(items, req.tenantId, limit);
  if (result.added > 0) logAudit(req, 'source.import_opml', 'source', null, { added: result.added, total: result.total });
  res.json(result);
}));

module.exports = router;
