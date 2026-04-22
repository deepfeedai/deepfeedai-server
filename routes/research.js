/**
 * Deep Feed AI Admin — /api/research
 * External research search + on-demand ingest of selected results as curated articles.
 * Gated by agent_web_research feature flag; enforces external_research_daily_cap.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { logAudit } = require('../middleware/audit');
const { isFeatureEnabled } = require('../lib/feature-registry');
const { searchAll } = require('../lib/research');
const { ingestExternalResults, getIngestCap, getIngestCountToday } = require('../lib/research/ingest');

async function requireResearchEnabled(req, res, next) {
  const on = await isFeatureEnabled(req.tenantId, 'agent_web_research').catch(() => false);
  if (!on) return res.status(404).json({ error: 'Web research is not enabled for this tenant' });
  next();
}

// POST /api/research/search — body: { query, sources?, count? }
router.post('/search', auth, requirePermission('articles.read'), requireResearchEnabled, asyncHandler(async (req, res) => {
  const { query, sources, count } = req.body || {};
  if (!query || query.trim().length < 4) return res.status(400).json({ error: 'query (4+ chars) required' });
  const r = await searchAll(req.tenantId, query.trim(), { sources, count: count || 10 });
  res.json(r);
}));

// POST /api/research/check-urls — body: { urls: string[] }
// Returns which URLs already exist in the tenant's article library (for dedup UI marking).
router.post('/check-urls', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || !urls.length) return res.json({ existing: [] });
  const rows = await db.prepare(
    'SELECT source_url FROM articles WHERE tenant_id = $1 AND source_url = ANY($2::text[])'
  ).all(req.tenantId, urls);
  res.json({ existing: rows.map(r => r.source_url).filter(Boolean) });
}));

// POST /api/research/ingest — body: { results: [{ url, title, publisher, snippet, source, ... }], pitch_id? }
// Inserts each non-duplicate result as a curated article with ingest_source='enrichment'.
// Returns: { ingested: [...], skipped: [...], cap_reached?: bool }
router.post('/ingest', auth, requirePermission('articles.create'), requireResearchEnabled, asyncHandler(async (req, res) => {
  const { results, pitch_id } = req.body || {};
  if (!Array.isArray(results) || !results.length) {
    return res.status(400).json({ error: 'results array required' });
  }

  const cap  = await getIngestCap(req.tenantId);
  const used = await getIngestCountToday(req.tenantId);
  if (used >= cap) {
    return res.status(429).json({ error: 'daily_cap_reached', message: `Already ingested ${used}/${cap} external articles today.` });
  }

  const r = await ingestExternalResults(req.tenantId, results, {
    pitchId: pitch_id || null,
    trigger: 'enrichment',
  });

  logAudit(req, 'research.ingest', 'articles', null, {
    pitch_id: pitch_id || null,
    ingested: r.ingested.length,
    skipped: r.skipped.length,
    skipped_reasons: r.skipped.map(s => s.reason),
  });

  res.json(r);
}));

module.exports = router;
