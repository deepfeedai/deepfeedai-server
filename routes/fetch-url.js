/**
 * Deep Feed AI Admin — GET /api/fetch-url?url=
 * Scrapes a URL server-side and returns Open Graph / meta tag data.
 * Used to auto-populate the Add Article form.
 */
const express               = require('express');
const router                = express.Router();
const https                 = require('https');
const http                  = require('http');
const dns                   = require('dns').promises;
const { auth }              = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler, decodeEntities } = require('../lib/utils');
const { getSiteConfig }     = require('../lib/site-config');

const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|fc|fd)/;

/** Fetch raw HTML from a URL, following up to 3 redirects */
function fetchHtml(url, redirects = 0, userAgent) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('Too many redirects'));

    const lib     = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': userAgent || 'Mozilla/5.0 (compatible; DeepFeedAI-Bot/1.0)',
        'Accept':     'text/html,application/xhtml+xml',
      },
      timeout: 8000,
    };

    lib.get(url, options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetchHtml(next, redirects + 1, userAgent));
      }

      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        html += chunk;
        if (html.length > 200000) { res.destroy(); resolve(html); } // cap at ~200KB, resolve with what we have
      });
      res.on('end', () => resolve(html));
    }).on('error', reject).on('timeout', () => reject(new Error('Request timed out')));
  });
}

/** Extract a meta/og tag value from raw HTML */
function getMeta(html, ...names) {
  for (const name of names) {
    // og:xxx / twitter:xxx / name="description" etc.
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

/** Extract <title> tag */
function getTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}

/** Guess source name from hostname */
function hostToSource(hostname) {
  return hostname
    .replace(/^www\./, '')
    .split('.')
    .slice(0, -1)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// GET /api/fetch-url?url=https://...
router.get('/', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // SSRF protection: only allow http/https, block private/internal IPs
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http and https URLs are allowed' });
  }
  try {
    const resolved = await dns.lookup(parsedUrl.hostname);
    if (PRIVATE_IP_RE.test(resolved.address)) {
      return res.status(400).json({ error: 'Private/internal URLs are not allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Unable to resolve hostname' });
  }

  const site = await getSiteConfig(req.tenantId);
  const botUA = `Mozilla/5.0 (compatible; ${site.short_name || 'DeepFeedAI'}-Bot/1.0)`;
  const html = await fetchHtml(url, 0, botUA);

    const title   = getMeta(html, 'og:title', 'twitter:title')          || getTitle(html)          || '';
    const image   = getMeta(html, 'og:image', 'twitter:image')           || '';
    const summary = getMeta(html, 'og:description', 'twitter:description', 'description') || '';
    const siteName= getMeta(html, 'og:site_name')                        || hostToSource(parsedUrl.hostname);
    const pubDate = getMeta(html, 'article:published_time', 'article:modified_time', 'datePublished') || '';

    // Author: try meta tags first, then JSON-LD structured data
    let author = getMeta(html, 'author', 'article:author', 'twitter:creator') || '';
    if (!author) {
      try {
        const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const block of jsonLdMatches) {
          const json = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').trim();
          const data = JSON.parse(json);
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            const a = item.author;
            if (a) {
              author = Array.isArray(a) ? a.map(x => x.name || x).join(', ') : (a.name || a);
              break;
            }
          }
          if (author) break;
        }
      } catch { /* ignore JSON-LD parse errors */ }
    }

    // Strip site name suffix from title (e.g. "My Article | The Verge" → "My Article")
    const cleanTitle = title.replace(/\s*[|\-–—]\s*[^|\-–—]+$/, '').trim() || title;

    res.json({
      title:      decodeEntities(cleanTitle),
      image:      image,
      summary:    decodeEntities(summary.slice(0, 500)),
      source:     decodeEntities(siteName),
      source_url: url,
      author:     decodeEntities(author),
      published_at: pubDate ? new Date(pubDate).toISOString().split('T')[0] : '',
    });
}));

module.exports = router;
