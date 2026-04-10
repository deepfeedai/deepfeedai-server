/**
 * Shared OG/meta scraping utilities for DeepFeedAI Admin.
 * Used by both routes/fetch-url.js (form auto-fill) and routes/fetch.js (RSS image enrichment).
 */
const https = require('https');
const http  = require('http');
const dns   = require('dns').promises;
const { getSiteConfig } = require('./site-config');

const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|fc|fd)/;

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
        // SSRF: validate redirect target before following
        return (async () => {
          try {
            const parsed = new URL(next);
            const resolved = await dns.lookup(parsed.hostname);
            if (PRIVATE_IP_RE.test(resolved.address)) return reject(new Error('Redirect to private IP blocked'));
          } catch (e) { return reject(e); }
          return resolve(fetchHtml(next, redirects + 1, userAgent));
        })();
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

/**
 * Extract article body text from HTML using readability-style heuristics.
 * Strips navigation, ads, scripts, and boilerplate. Returns cleaned text (max 5000 chars).
 * @param {string} url
 * @param {number} tenantId
 * @returns {Promise<string|null>}
 */
async function scrapeArticleText(url, tenantId) {
  try {
    const ua = await getBotUserAgent(tenantId);
    const html = await fetchHtml(url, 0, ua);
    if (!html || html.length < 200) return null;

    // Strip non-content elements
    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<form[\s\S]*?<\/form>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    // Try to find the article body container
    const articleMatch = cleaned.match(/<article[\s\S]*?<\/article>/i)
      || cleaned.match(/<div[^>]*(?:class|id)="[^"]*(?:article|post|entry|content|story)[^"]*"[\s\S]*?<\/div>/i)
      || cleaned.match(/<main[\s\S]*?<\/main>/i);

    const body = articleMatch ? articleMatch[0] : cleaned;

    // Extract text from paragraphs
    const paragraphs = [];
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = pRegex.exec(body)) !== null) {
      const text = match[1]
        .replace(/<[^>]+>/g, '')         // strip remaining HTML tags
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#\d+;/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 30) paragraphs.push(text); // skip short fragments
    }

    if (paragraphs.length === 0) return null;

    const result = paragraphs.join('\n\n').slice(0, 5000);
    return result.length > 100 ? result : null; // reject very short extractions
  } catch {
    return null;
  }
}

module.exports = { fetchHtml, getMeta, scrapeOgImage, scrapeArticleText };
