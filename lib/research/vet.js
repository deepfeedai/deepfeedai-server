/**
 * Deep Feed AI — Source vetting helper (editor-commissioned stories)
 *
 * Takes raw `enrichSources` candidates and returns the top N vetted sources
 * ranked by a combined score of credibility + recency + (optional) authority.
 *
 * Soft-degrades:
 *   - No `source_credibility` table in this codebase → credibility filter is
 *     skipped; every candidate is treated as neutral (0.5).
 *   - No tenant allowlist setting exists → authority boost is skipped.
 *
 * Intentionally dependency-free beyond the shared db module so it can be
 * called from tools, routes, and action handlers alike.
 */
'use strict';

const db = require('../../db');

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
]);

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    // Lowercase host, strip default ports, strip trailing slash, drop tracking params
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.hash = '';
    let out = `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, '')}`;
    const qs = u.searchParams.toString();
    if (qs) out += `?${qs}`;
    return out.toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function tokenizeTitle(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w && w.length > 2)
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function recencyBoost(published) {
  if (!published) return 0.1;
  const t = new Date(published).getTime();
  if (!Number.isFinite(t)) return 0.1;
  const ageMs = Date.now() - t;
  const hour = 60 * 60 * 1000;
  if (ageMs < 24 * hour) return 1.0;
  if (ageMs < 7 * 24 * hour) return 0.5;
  return 0.1;
}

/**
 * Attempt a credibility score lookup. Returns a Map<publisher,score> (0..1).
 * Gracefully returns an empty map if the table doesn't exist.
 */
async function loadCredibilityMap(tenantId, publishers) {
  if (!publishers.length) return new Map();
  try {
    const rows = await db.prepare(`
      SELECT publisher, score
      FROM source_credibility
      WHERE tenant_id = $1 AND publisher = ANY($2::text[])
    `).all(tenantId, publishers);
    const m = new Map();
    for (const r of rows) m.set(String(r.publisher).toLowerCase(), Number(r.score));
    return m;
  } catch {
    return new Map(); // table missing or query failed → skip credibility filter
  }
}

/**
 * Vet a list of search-result candidates.
 *
 * @param {Array<object>} candidates       Raw results from enrichSources.
 * @param {object} opts
 * @param {number} opts.tenantId           Required for credibility lookup.
 * @param {number} [opts.maxResults=4]     Top N to return.
 * @param {number} [opts.minCredibility=0] Drop candidates whose credibility is
 *                                         below this threshold (only applied
 *                                         when credibility data is present).
 * @param {number} [opts.nearDupThreshold=0.85]
 * @returns {Promise<Array<object>>}       Sorted list with `vet_score` attached.
 */
async function vetSources(candidates, { tenantId, maxResults = 4, minCredibility = 0, nearDupThreshold = 0.85 } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return [];

  // Step 1 — URL dedupe
  const seen = new Set();
  const deduped = [];
  for (const c of candidates) {
    if (!c || !c.url || !c.title) continue;
    const key = normalizeUrl(c.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...c, _norm_url: key });
  }

  // Step 2 — near-dup title filter
  const kept = [];
  for (const c of deduped) {
    const tokens = tokenizeTitle(c.title);
    let isDup = false;
    for (const k of kept) {
      if (jaccard(tokens, k._title_tokens) > nearDupThreshold) { isDup = true; break; }
    }
    if (!isDup) kept.push({ ...c, _title_tokens: tokens });
  }

  // Step 3 — credibility lookup (graceful degrade)
  const publishers = Array.from(new Set(
    kept.map(c => String(c.publisher || c.source || '').toLowerCase()).filter(Boolean)
  ));
  const credMap = await loadCredibilityMap(tenantId, publishers);
  const credibilityAvailable = credMap.size > 0;

  // Step 4 — score + filter
  const scored = [];
  for (const c of kept) {
    const pubKey = String(c.publisher || c.source || '').toLowerCase();
    const credRaw = credMap.get(pubKey);
    const credibility = Number.isFinite(credRaw) ? credRaw : 0.5; // neutral when unknown
    if (credibilityAvailable && Number.isFinite(credRaw) && credRaw < minCredibility) continue;

    const recency = recencyBoost(c.published);
    // Authority boost: no per-tenant publisher allowlist setting exists in the
    // codebase, so this degrades to 0. Left in the formula for future wiring.
    const authority = 0;
    const vet_score = credibility + recency + authority;

    // Strip internal helpers before returning
    const { _norm_url, _title_tokens, ...clean } = c;
    scored.push({ ...clean, vet_score, credibility, recency_boost: recency });
  }

  scored.sort((a, b) => b.vet_score - a.vet_score);
  return scored.slice(0, Math.max(1, maxResults));
}

module.exports = { vetSources, normalizeUrl, _internal: { jaccard, tokenizeTitle, recencyBoost } };
