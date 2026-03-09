/**
 * Shared OG/meta scraping utilities for DeepFeedAI Admin.
 * Used by both routes/fetch-url.js (form auto-fill) and routes/fetch.js (RSS image enrichment).
 */
const https = require('https');
const http  = require('http');

/** Fetch raw HTML from a URL, following up to 3 redirects, 5s timeout */
function fetchHtml(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('Too many redirects'));
    const lib     = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DeepFeedAI-Bot/1.0)',
        'Accept':     'text/html,application/xhtml+xml',
      },
      timeout: 5000,
    };
    lib.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetchHtml(next, redirects + 1));
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { html += chunk; if (html.length > 200000) res.destroy(); });
      res.on('end', () => resolve(html));
    }).on('error', reject).on('timeout', () => reject(new Error('Timed out')));
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
async function scrapeOgImage(url) {
  try {
    const html = await fetchHtml(url);
    return getMeta(html, 'og:image', 'twitter:image') || null;
  } catch {
    return null;
  }
}

module.exports = { fetchHtml, getMeta, scrapeOgImage };
