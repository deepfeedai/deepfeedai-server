/**
 * Deep Feed AI — lib/research/ingest.js
 *
 * Core ingest logic for external research results. Extracted from
 * routes/research.js so cron jobs (agent-scan, proactive beat search)
 * can call it directly without going through HTTP.
 *
 * Enforces the per-tenant daily ingest cap (external_research_daily_cap,
 * default 50) and dedupes by source_url within the tenant.
 */
'use strict';

const crypto  = require('crypto');
const db      = require('../../db');
const { getAllFeatures } = require('../feature-registry');
const { toSlug } = require('../utils');
const { detectCategory } = require('../categorize');
const { generateEmbedding, isPgvectorAvailable } = require('../embeddings');
const { recordEvent } = require('../newsroom-events');

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

/**
 * Ingest external research results as curated articles.
 *
 * @param {number} tenantId
 * @param {Array<{url, title, snippet?, publisher?, source?, published?}>} results
 * @param {object} [opts]
 * @param {number|null} [opts.pitchId]   — attach ingested article IDs to this pitch
 * @param {string}      [opts.trigger]   — label for logging ('agent-scan' | 'admin' | etc.)
 * @returns {Promise<{ ingested: Array, skipped: Array, cap_reached: boolean, daily_cap: number, daily_used: number }>}
 */
async function ingestExternalResults(tenantId, results, opts = {}) {
  const { pitchId = null, trigger = 'enrichment' } = opts;

  const cap      = await getIngestCap(tenantId);
  const used     = await getIngestCountToday(tenantId);
  const remaining = Math.max(0, cap - used);

  if (remaining <= 0) {
    return { ingested: [], skipped: [], cap_reached: true, daily_cap: cap, daily_used: used };
  }

  const pgvector = await isPgvectorAvailable().catch(() => false);

  async function embedAndStore(articleId, text) {
    if (!pgvector) return;
    try {
      const v = await generateEmbedding(tenantId, text);
      await db.prepare('UPDATE articles SET embedding = $1::vector WHERE id = $2 AND tenant_id = $3')
        .run(JSON.stringify(v), articleId, tenantId);
    } catch { /* embeddings best-effort */ }
  }

  const ingested = [];
  const skipped  = [];
  let cap_reached = false;

  for (const item of results.slice(0, remaining)) {
    if (!item.url || !item.title) {
      skipped.push({ url: item.url, reason: 'missing url or title' });
      continue;
    }

    // Dedupe by source_url within tenant
    const dup = await db.prepare(
      'SELECT id FROM articles WHERE tenant_id = $1 AND source_url = $2 LIMIT 1'
    ).get(tenantId, item.url);
    if (dup) {
      skipped.push({ url: item.url, reason: 'duplicate', existing_id: dup.id });
      continue;
    }

    const title     = String(item.title).slice(0, 500);
    const summary   = String(item.snippet || '').slice(0, 1000);
    const publisher = String(item.publisher || item.source || 'Unknown').slice(0, 200);
    const baseSlug  = toSlug(title) || 'enrich';
    const slug      = `${baseSlug}-${crypto.randomBytes(3).toString('hex')}`;

    let category = 'General';
    try {
      category = await detectCategory({ title, contentSnippet: summary }, { tenantId }) || 'General';
    } catch { /* fallback */ }

    const inserted = await db.prepare(`
      INSERT INTO articles
        (tenant_id, title, slug, summary, source, source_url, category,
         content_type, ingest_source, is_published, status, published_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'curated', $8, 1, 'published', NOW(), NOW(), NOW())
      RETURNING id
    `).get(tenantId, title, slug, summary, publisher, item.url, category, trigger);

    if (inserted) {
      ingested.push({ id: inserted.id, url: item.url, title, source: item.source });
      embedAndStore(inserted.id, `${title}\n\n${summary}`).catch(() => {});
    }
  }

  if (results.length > remaining) cap_reached = true;

  // Attach ingested article IDs to a pitch if provided.
  // Update both tables — one will match (article_pitches for commissions, story_pitches for
  // agent pitches), the other is a no-op. Avoids needing a pitch_type param from callers.
  if (pitchId && ingested.length) {
    const newIds = JSON.stringify(ingested.map(i => i.id));
    await db.prepare(`
      UPDATE article_pitches
      SET attached_article_ids = COALESCE(attached_article_ids, '[]'::jsonb) || $1::jsonb
      WHERE id = $2 AND tenant_id = $3
    `).run(newIds, pitchId, tenantId).catch(err => console.warn('[research/ingest] article_pitches attach failed:', err.message));
    await db.prepare(`
      UPDATE story_pitches
      SET attached_article_ids = COALESCE(attached_article_ids, '[]'::jsonb) || $1::jsonb
      WHERE id = $2 AND tenant_id = $3
    `).run(newIds, pitchId, tenantId).catch(err => console.warn('[research/ingest] story_pitches attach failed:', err.message));
  }

  if (ingested.length) {
    recordEvent({
      tenantId,
      type: 'enriched',
      payload: {
        trigger,
        ingested_count: ingested.length,
        sample_titles: ingested.slice(0, 3).map(i => i.title),
      },
    });
  }

  return { ingested, skipped, cap_reached, daily_cap: cap, daily_used: used + ingested.length };
}

module.exports = { ingestExternalResults, getIngestCap, getIngestCountToday };
