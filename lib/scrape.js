/**
 * Shared OG/meta scraping utilities for DeepFeedAI Admin.
 * Used by both routes/fetch-url.js (form auto-fill) and routes/fetch.js (RSS image enrichment).
 */
const https = require('https');
const http  = require('http');
const { getSiteConfig } = require('./site-config');

/** Fetch raw HTML from a URL, following up to 3 redirects, 6s hard timeout */
const _botUserAgents = new Map(); // tenantId -> userAgent string
async function getBotUserAgent(tenantId) {
  const cached = _botUserAgents.get(tenantId);
  if (cached) return cached;
  try {
    const site = await getSiteConfig(tenantId);
    const ua = `Mozilla/5.0 (compatible; ${site.short_name || 'DeepFeedAI'}-Bot/1.0)`;
    _botUserAgents.set(tenantId, ua);
    return ua;
  } catch {
    return 'Mozilla/5.0 (compatible; DeepFeedAI-Bot/1.0)';
  }
}

function fetchHtml(url, redirects = 0, userAgent) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('Too many redirects'));
    const lib     = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': userAgent || 'Mozilla/5.0 (compatible; DeepFeedAI-Bot/1.0)',
        'Accept':     'text/html,application/xhtml+xml',
      },
      timeout: 6000,
    };
    const req = lib.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetchHtml(next, redirects + 1, userAgent));
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { html += chunk; if (html.length > 200000) res.destroy(); });
      res.on('end', () => resolve(html));
    });
    // Must destroy the socket on timeout — event alone doesn't abort the request
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
    req.on('error', reject);
  });
}

/** Extract a meta/og tag value from raw HTML */
function getMeta(html, ...names) {
  for (const name of names) {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${name}["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1] && m[1].trim()) return m[1].trim();
    }
  }
  return null;
}

/**
 * Scrape a URL and return { image, title, summary, author }.
 * Returns null if fetch fails.
 */
async function scrapeOgImage(url, tenantId) {
  try {
    const ua = await getBotUserAgent(tenantId);
    const html = await fetchHtml(url, 0, ua);
    return getMeta(html, 'og:image', 'twitter:image') || null;
  } catch {
    return null;
  }
}

module.exports = { fetchHtml, getMeta, scrapeOgImage };
