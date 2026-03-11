/**
 * Deep Feed AI — lib/spam.js
 * Spam and abuse detection for user comments.
 *
 * Pipeline (in order):
 *   1. URL flood check      — too many links = likely spam
 *   2. Keyword blocklist    — built-in defaults + admin-configured custom list
 *   3. Perspective API      — Google's ML toxicity scoring (optional, requires API key)
 *
 * Returns a SpamResult:
 *   { action: 'block'|'queue'|'allow', reason: string|null, score: number|null }
 *
 *   block  → reject with 400 (comment never stored)
 *   queue  → store as is_approved=0 for human review
 *   allow  → normal flow (is_approved determined by mod queue settings)
 *
 * Settings keys read from the DB:
 *   spam_blocklist           — comma-separated custom keywords (case-insensitive)
 *   spam_perspective_enabled — '1' to enable Perspective API
 *   spam_perspective_key     — Google API key for Perspective
 *   spam_block_threshold     — Perspective score above which to BLOCK (default 0.85)
 *   spam_queue_threshold     — Perspective score above which to QUEUE (default 0.50)
 */

'use strict';

const https = require('https');

// ── Built-in blocklist ─────────────────────────────────────────────
// Patterns that are always blocked regardless of settings.
const BUILTIN_PATTERNS = [
  // Obvious spam
  /\b(buy\s+now|click\s+here|free\s+money|earn\s+\$|make\s+money\s+fast|work\s+from\s+home|lose\s+weight\s+fast)\b/i,
  /\b(casino|poker|slots|gambling|bet\s+now|sports\s+betting)\b/i,
  /\b(viagra|cialis|levitra|cheap\s+pills|online\s+pharmacy)\b/i,
  /\b(crypto\s+giveaway|bitcoin\s+giveaway|nft\s+drop|airdrop\s+claim)\b/i,
  /\b(seo\s+service|backlink|rank\s+your\s+site|increase\s+traffic)\b/i,
  // Phishing / social engineering
  /\b(verify\s+your\s+account|confirm\s+your\s+password|update\s+your\s+billing)\b/i,
  /(?:https?:\/\/)?(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co\/)\S+/i,
];

// ── URL flood check ────────────────────────────────────────────────
const URL_REGEX    = /https?:\/\/\S+/gi;
const MAX_URLS     = 3; // more than this in one comment = suspicious

// ── Perspective API ────────────────────────────────────────────────
const PERSPECTIVE_URL = 'https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze';

/**
 * Call Google Perspective API and return the highest toxicity score.
 * Uses TOXICITY + SPAM attributes.
 */
function callPerspective(text, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      comment:          { text },
      requestedAttributes: {
        TOXICITY: {},
        SPAM:     {},
      },
      languages: ['en'],
      doNotStore: true,
    });

    const url     = new URL(`${PERSPECTIVE_URL}?key=${apiKey}`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const data   = JSON.parse(raw);
          const scores = data.attributeScores || {};
          const toxicity = scores.TOXICITY?.summaryScore?.value ?? 0;
          const spam     = scores.SPAM?.summaryScore?.value     ?? 0;
          resolve({ toxicity, spam, combined: Math.max(toxicity, spam) });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Perspective timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Main spam check entry point.
 * @param {string} text        — comment body
 * @param {object} settings    — key/value settings from DB
 * @returns {Promise<SpamResult>}
 */
async function checkSpam(text, settings = {}) {
  const clean = (text || '').trim();
  if (!clean) return { action: 'allow', reason: null, score: null };

  // 1. URL flood
  const urlMatches = clean.match(URL_REGEX) || [];
  if (urlMatches.length > MAX_URLS) {
    return { action: 'block', reason: `url_flood:${urlMatches.length}`, score: null };
  }

  // 2. Built-in pattern blocklist
  for (const pattern of BUILTIN_PATTERNS) {
    if (pattern.test(clean)) {
      return { action: 'block', reason: `blocklist:builtin:${pattern.source.slice(0, 40)}`, score: null };
    }
  }

  // 3. Custom admin keyword blocklist
  const customRaw = (settings.spam_blocklist || '').trim();
  if (customRaw) {
    const keywords = customRaw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    const lower    = clean.toLowerCase();
    for (const kw of keywords) {
      if (kw && lower.includes(kw)) {
        return { action: 'block', reason: `blocklist:custom:${kw}`, score: null };
      }
    }
  }

  // 4. Perspective API (optional)
  const perspEnabled = settings.spam_perspective_enabled === '1';
  const perspKey     = (settings.spam_perspective_key || '').trim();

  if (perspEnabled && perspKey) {
    const blockThreshold = parseFloat(settings.spam_block_threshold || '0.85');
    const queueThreshold = parseFloat(settings.spam_queue_threshold || '0.50');

    try {
      const { combined, toxicity, spam: spamScore } = await callPerspective(clean, perspKey);
      const score = Math.round(combined * 1000) / 1000;

      if (combined >= blockThreshold) {
        return { action: 'block', reason: 'perspective:high', score };
      }
      if (combined >= queueThreshold) {
        const dominant = toxicity >= spamScore ? 'toxicity' : 'spam';
        return { action: 'queue', reason: `perspective:${dominant}`, score };
      }
      // Clean but log the score
      return { action: 'allow', reason: null, score };
    } catch (err) {
      // Perspective failed — don't block the comment, just log
      console.warn('[Spam] Perspective API error:', err.message);
    }
  }

  return { action: 'allow', reason: null, score: null };
}

module.exports = { checkSpam };
