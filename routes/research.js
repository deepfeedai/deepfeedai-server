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
const { isFeatureEnabled, getAllFeatures } = require('../lib/feature-registry');
const { searchAll } = require('../lib/research');

async function requireResearchEnabled(req, res, next) {
  const on = await isFeatureEnabled(req.tenantId, 'agent_web_research').catch(() => false);
  if (!on) return res.status(404).json({ error: 'Web research is not enabled for this tenant' });
  next();
}

async function getIngestCap(tenantId) {
  try {
    const feats = await getAllFeatures(tenantId);
    const n = parseInt(feats.external_research_daily_cap, 10);
    return Number.isFinite(n) && n > 0 ? n : 50;
  } catch { return 50; }
}

async function getIngestCountToday(tenantId) {
  const row = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM articles
    WHERE tenant_id = $1 AND ingest_source = 'enrichment'
      AND created_at > NOW() - INTERVAL '24 hours'
  `).get(tenantId);
  return row?.cnt || 0;
}

// POST /api/research/search — body: { query, sources?, count? }
router.post('/search', auth, requirePermission('articles.read'), requireResearchEnabled, asyncHandler(async (req, res) => {
  const { query, sources, count } = req.body || {};
  if (!query || query.trim().length < 4) return res.status(400).json({ error: 'query (4+ chars) required' });
  const r = await searchAll(req.tenantId, query.trim(), { sources, count: count || 10 });
  res.json(r);
}));

// POST /api/research/ingest — body: { results: [{ url, title, publisher, snippet, source, ... }], pitch_id? }
// Inserts each non-duplicate result as a curated article with ingest_source='enrichment'.
// Returns: { ingested: [...], skipped: [...], cap_reached?: bool }
router.post('/ingest', auth, requirePermission('articles.create'), requireResearchEnabled, asyncHandler(async (req, res) => {
  const { results, pitch_id } = req.body || {};
  if (!Array.isArray(results) || !results.length) {
    return res.status(400).json({ error: 'results array required' });
  }

  const cap = await getIngestCap(req.tenantId);
  const used = await getIngestCountToday(req.tenantId);
  const remaining = Math.max(0, cap - used);
  if (remaining <= 0) {
    return res.status(429).json({ error: 'daily_cap_reached', message: `Already ingested ${used}/${cap} external articles today.` });
  }

  const { toSlug } = require('../lib/utils');
  const { detectCategory } = require('../lib/categorize');
  const { generateEmbedding, isPgvectorAvailable } = require('../lib/embeddings');
  const pgvector = await isPgvectorAvailable().catch(() => false);
  async function embedAndStore(articleId, text) {
    if (!pgvector) return;
    try {
      const v = await generateEmbedding(req.tenantId, text);
      await db.prepare('UPDATE articles SET embedding = $1::vector WHERE id = $2 AND tenant_id = $3')
        .run(JSON.stringify(v), articleId, req.tenantId);
    } catch { /* embeddings best-effort */ }
  }

  const ingested = [];
  const skipped = [];
  let cap_reached = false;

  for (const item of results.slice(0, remaining)) {
    if (!item.url || !item.title) {
      skipped.push({ url: item.url, reason: 'missing url or title' });
      continue;
    }
    // Dedupe: same source_url within tenant
    const dup = await db.prepare(
      'SELECT id FROM articles WHERE tenant_id = $1 AND source_url = $2 LIMIT 1'
    ).get(req.tenantId, item.url);
    if (dup) {
      skipped.push({ url: item.url, reason: 'duplicate', existing_id: dup.id });
      continue;
    }

    const title = String(item.title).slice(0, 500);
    const summary = String(item.snippet || '').slice(0, 1000);
    const publisher = String(item.publisher || item.source || 'Unknown').slice(0, 200);
    const slug = toSlug(title) || `enrich-${Date.now()}`;

    let category = 'General';
    try {
      category = await detectCategory({ title, contentSnippet: summary }, { tenantId: req.tenantId }) || 'General';
    } catch { /* fallback */ }

    const inserted = await db.prepare(`
      INSERT INTO articles
        (tenant_id, title, slug, summary, source, source_url, category, content_type, ingest_source, is_published, status, published_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'curated', 'enrichment', 1, 'published', NOW(), NOW(), NOW())
      RETURNING id
    `).get(req.tenantId, title, slug, summary, publisher, item.url, category);

    if (inserted) {
      ingested.push({ id: inserted.id, url: item.url, title, source: item.source });
      embedAndStore(inserted.id, `${title}\n\n${summary}`).catch(() => {});
    }
  }

  if (results.length > remaining) cap_reached = true;

  // If a pitch_id was provided, the caller wants these attached. We don't
  // have a junction table for this — the existing pitch's synthesizeFromPitch
  // does cluster expansion via embeddings, so freshly-ingested articles in
  // the writer's beat will be picked up automatically. Just record the link
  // in audit + a synthesis_meta hint if the pitch is still proposed.
  if (pitch_id && ingested.length) {
    try {
      await db.prepare(`
        UPDATE article_pitches
        SET decision_note = COALESCE(decision_note, '') || E'\\n[enrichment]: attached articles ' || $1
        WHERE id = $2 AND tenant_id = $3
      `).run(ingested.map(i => i.id).join(','), pitch_id, req.tenantId);
    } catch { /* non-fatal */ }
  }

  logAudit(req, 'research.ingest', 'articles', null, {
    pitch_id: pitch_id || null,
    ingested: ingested.length,
    skipped: skipped.length,
    skipped_reasons: skipped.map(s => s.reason),
  });

  if (ingested.length) {
    const { recordEvent } = require('../lib/newsroom-events');
    recordEvent({
      tenantId: req.tenantId, type: 'enriched',
      actorUserId: req.user?.sub || null,
      targetPitchId: pitch_id || null,
      payload: {
        ingested_count: ingested.length,
        sample_titles: ingested.slice(0, 3).map(i => i.title),
      },
    });
  }

  res.json({ ingested, skipped, cap_reached, daily_cap: cap, daily_used: used + ingested.length });
}));

module.exports = router;
