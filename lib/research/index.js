/**
 * External research aggregator — orchestrates Brave + HN + Reddit searches
 * with per-tenant daily quota, in-memory response cache, and a single
 * normalized result shape across backends.
 *
 * Result shape:
 *   { source, url, title, snippet, publisher, published, score?, comments?, author? }
 */
const db = require('../../db');
const { isFeatureEnabled, getAllFeatures } = require('../feature-registry');

const brave = require('./brave');
const hackernews = require('./hackernews');
const reddit = require('./reddit');

const BACKENDS = { brave, hackernews, reddit };

// Response cache — 12h TTL, keyed by (tenant, source, query)
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();

// Daily call counter per tenant — { [tenantId]: { date: 'YYYY-MM-DD', count: N } }
const callCounter = new Map();

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _quotaUsed(tenantId) {
  const entry = callCounter.get(tenantId);
  if (!entry || entry.date !== _today()) return 0;
  return entry.count;
}

function _bumpQuota(tenantId) {
  const today = _today();
  const entry = callCounter.get(tenantId);
  if (!entry || entry.date !== today) {
    callCounter.set(tenantId, { date: today, count: 1 });
  } else {
    entry.count++;
  }
}

async function _quotaCap(tenantId) {
  try {
    const feats = await getAllFeatures(tenantId);
    const n = parseInt(feats.external_search_daily_cap, 10);
    return Number.isFinite(n) && n > 0 ? n : 200;
  } catch { return 200; }
}

/**
 * Run an external search across selected backends.
 * @param {number} tenantId
 * @param {string} query
 * @param {object} [opts]
 * @param {string[]} [opts.sources] — subset of ['brave','hackernews','reddit'] (default all)
 * @param {number} [opts.count] — per-backend result count (default 10)
 * @returns {Promise<{ results: Array, errors: Array, quota_used: number, quota_cap: number }>}
 */
async function searchAll(tenantId, query, opts = {}) {
  const enabled = await isFeatureEnabled(tenantId, 'agent_web_research').catch(() => false);
  if (!enabled) {
    return { results: [], errors: [{ source: 'all', reason: 'feature_disabled' }], quota_used: 0, quota_cap: 0 };
  }

  const cap = await _quotaCap(tenantId);
  const used = _quotaUsed(tenantId);
  if (used >= cap) {
    return { results: [], errors: [{ source: 'all', reason: 'daily_cap_reached' }], quota_used: used, quota_cap: cap };
  }

  const sources = (opts.sources && opts.sources.length ? opts.sources : Object.keys(BACKENDS))
    .filter(s => BACKENDS[s]);
  const errors = [];
  const all = [];

  await Promise.all(sources.map(async (sourceKey) => {
    const cacheKey = `${tenantId}:${sourceKey}:${query.toLowerCase().trim()}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.t < CACHE_TTL_MS) {
      all.push(...cached.results);
      return;
    }
    const r = await BACKENDS[sourceKey].search(tenantId, query, opts);
    if (!r.ok) {
      errors.push({ source: sourceKey, reason: r.reason });
      return;
    }
    cache.set(cacheKey, { t: Date.now(), results: r.results });
    all.push(...r.results);
    _bumpQuota(tenantId);
  }));

  // Stable ordering: high-score social first within score tier, then news by recency
  all.sort((a, b) => {
    const sa = a.score ?? -1, sb = b.score ?? -1;
    if (sb !== sa) return sb - sa;
    return (b.published || '').localeCompare(a.published || '');
  });

  return {
    results: all,
    errors,
    quota_used: _quotaUsed(tenantId),
    quota_cap: cap,
  };
}

module.exports = { searchAll };
