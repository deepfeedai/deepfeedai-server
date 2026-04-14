/**
 * Brave Search backend for external research.
 * Reuses the per-tenant brave_api_key from app-config (already used in routes/discover.js).
 */
const { getAppConfig } = require('../app-config');

async function search(tenantId, query, opts = {}) {
  const config = await getAppConfig(tenantId);
  const apiKey = config.brave_api_key;
  if (!apiKey) {
    return { ok: false, reason: 'no_brave_api_key', results: [] };
  }
  const count = Math.min(Math.max(opts.count || 10, 1), 20);
  const freshness = opts.freshness || 'pw'; // past week default for research
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=${count}&freshness=${encodeURIComponent(freshness)}`;
  try {
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { ok: false, reason: `brave_${res.status}`, results: [] };
    }
    const data = await res.json();
    const results = (data.results || []).map(item => {
      let host = '';
      try { host = item.meta_url?.hostname || new URL(item.url).hostname; } catch {}
      return {
        source: 'brave',
        url: item.url,
        title: item.title,
        snippet: item.description || '',
        publisher: host,
        published: item.age || item.page_age || null,
        score: null, // Brave doesn't expose a numeric score
      };
    });
    return { ok: true, results };
  } catch (err) {
    return { ok: false, reason: err.message || 'fetch_failed', results: [] };
  }
}

module.exports = { search };
