/**
 * Deep Feed AI Admin — GET /api/fetch-url?url=
 * Scrapes a URL server-side and returns Open Graph / meta tag data.
 * Used to auto-populate the Add Article form.
 */
const express  = require('express');
const router   = express.Router();
const https    = require('https');
const http     = require('http');
const jwt      = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'deepfeedai_super_secret_jwt_key_2026';

function authMiddleware(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/** Fetch raw HTML from a URL, following up to 3 redirects */
function fetchHtml(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('Too many redirects'));

    const lib     = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DeepFeedAI-Bot/1.0)',
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
        return resolve(fetchHtml(next, redirects + 1));
      }

      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        html += chunk;
        if (html.length > 200000) res.destroy(); // cap at ~200KB
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
router.get('/', authMiddleware, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const html = await fetchHtml(url);

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
      title:      cleanTitle,
      image:      image,
      summary:    summary.slice(0, 500),
      source:     siteName,
      source_url: url,
      author:     author,
      published_at: pubDate ? new Date(pubDate).toISOString().split('T')[0] : '',
    });

  } catch (err) {
    res.status(500).json({ error: `Failed to fetch URL: ${err.message}` });
  }
});

module.exports = router;
