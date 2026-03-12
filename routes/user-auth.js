/**
 * Deep Feed AI — routes/user-auth.js
 * Public user OAuth authentication (Google + GitHub).
 *
 * Flow:
 *   1. Browser → GET /api/user-auth/google  (or /github)
 *   2. Server   → 302 to provider OAuth page
 *   3. Provider → 302 to /api/user-auth/google/callback
 *   4. Server   → creates/updates public_users row, issues one-time auth_code
 *   5. Server   → 302 to MAIN_SITE_URL/auth/callback?code=XXXX
 *   6. Main site → POST /api/user-auth/token { code }
 *   7. Server   → returns { token, user }
 *   8. Main site → stores JWT in localStorage, loads user session
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const db      = require('../db');

const router = express.Router();

/* ── Config ──────────────────────────────────────────────────────── */
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// USER_JWT_SECRET is separate from admin JWT_SECRET — keeps auth surfaces isolated
const USER_JWT_SECRET = process.env.USER_JWT_SECRET;
if (!USER_JWT_SECRET) {
  console.warn('[user-auth] WARNING: USER_JWT_SECRET not set. User auth will not work.');
}

// BASE_URL = this server's public URL (Railway URL in production)
const BASE_URL      = (process.env.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
// MAIN_SITE_URL = deepfeedai.com (where we redirect after OAuth)
const MAIN_SITE_URL = (process.env.MAIN_SITE_URL || 'http://localhost:3001').replace(/\/$/, '');

/* ── OAuth state store (in-memory, 10-min TTL) ───────────────────── */
const oauthStates = new Map();

function generateState() {
  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, Date.now());
  // Prune stale states
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of oauthStates) {
    if (v < cutoff) oauthStates.delete(k);
  }
  return state;
}

function validateState(state) {
  const ts = oauthStates.get(state);
  if (!ts) return false;
  oauthStates.delete(state); // one-time use
  return Date.now() - ts < 10 * 60 * 1000;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

/**
 * Find an existing public_users row or create a new one.
 * Updates profile fields on every login so they stay fresh.
 */
async function findOrCreateUser(provider, providerId, email, displayName, avatarUrl) {
  // Sanitize display name — strip HTML, trim
  const safeName = (displayName || email || 'Anonymous')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, 60);

  let user = await db.prepare(
    'SELECT * FROM public_users WHERE provider = $1 AND provider_id = $2'
  ).get(provider, String(providerId));

  if (!user) {
    const notifyToken = crypto.randomBytes(24).toString('hex');
    user = await db.prepare(`
      INSERT INTO public_users (provider, provider_id, email, display_name, avatar_url, notify_token)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `).get(provider, String(providerId), email || null, safeName, avatarUrl || null, notifyToken);
  } else {
    // Backfill notify_token for existing users who don't have one
    const token = user.notify_token || crypto.randomBytes(24).toString('hex');
    user = await db.prepare(`
      UPDATE public_users
      SET email        = $1,
          display_name = $2,
          avatar_url   = $3,
          notify_token = COALESCE(notify_token, $4),
          updated_at   = NOW()
      WHERE id = $5
      RETURNING *
    `).get(email || null, safeName, avatarUrl || null, token, user.id);
  }

  return user;
}

/** Issue a short-lived one-time code to complete the OAuth handoff */
async function createAuthCode(userId) {
  const code      = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString(); // 60 seconds
  await db.prepare(
    'INSERT INTO auth_codes (code, user_id, expires_at) VALUES ($1, $2, $3)'
  ).run(code, userId, expiresAt);
  return code;
}

/** Sign a 7-day JWT for the public user */
function issueJwt(user) {
  return jwt.sign(
    {
      sub:         user.id,
      email:       user.email,
      displayName: user.display_name,
      avatarUrl:   user.avatar_url,
      provider:    user.provider,
    },
    USER_JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/** Redirect to main site with an error code */
function authError(res, code) {
  return res.redirect(`${MAIN_SITE_URL}/?auth_error=${encodeURIComponent(code)}`);
}

/* ── Google OAuth ────────────────────────────────────────────────── */

router.get('/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth not configured' });
  const state = generateState();
  const url   = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id',     GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri',  `${BASE_URL}/api/user-auth/google/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         'openid email profile');
  url.searchParams.set('state',         state);
  url.searchParams.set('access_type',   'online');
  url.searchParams.set('prompt',        'select_account');
  res.redirect(url.toString());
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error)                   return authError(res, error);
  if (!validateState(state))   return authError(res, 'invalid_state');

  try {
    // Exchange code → access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${BASE_URL}/api/user-auth/google/callback`,
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access_token from Google');

    // Fetch user profile
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = await infoRes.json();

    const user = await findOrCreateUser(
      'google', info.id, info.email, info.name, info.picture
    );
    if (user.is_banned) return authError(res, 'banned');

    const authCode = await createAuthCode(user.id);
    res.redirect(`${MAIN_SITE_URL}/auth/callback?code=${authCode}`);
  } catch (err) {
    console.error('[OAuth/Google]', err.message);
    authError(res, 'server_error');
  }
});

/* ── GitHub OAuth ────────────────────────────────────────────────── */

router.get('/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) return res.status(503).json({ error: 'GitHub OAuth not configured' });
  const state = generateState();
  const url   = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id',    GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${BASE_URL}/api/user-auth/github/callback`);
  url.searchParams.set('scope',        'user:email');
  url.searchParams.set('state',        state);
  res.redirect(url.toString());
});

router.get('/github/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error)                  return authError(res, error);
  if (!validateState(state))  return authError(res, 'invalid_state');

  try {
    // Exchange code → access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'application/json',
      },
      body: new URLSearchParams({
        client_id:     GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  `${BASE_URL}/api/user-auth/github/callback`,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access_token from GitHub');

    // Fetch user profile
    const infoRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'User-Agent':  'DeepFeedAI/1.0',
      },
    });
    const info = await infoRes.json();

    // GitHub doesn't always return a public email — fetch the verified primary
    let email = info.email;
    if (!email) {
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'User-Agent':  'DeepFeedAI/1.0',
        },
      });
      const emails = await emailRes.json();
      const primary = Array.isArray(emails)
        ? emails.find(e => e.primary && e.verified)
        : null;
      email = primary ? primary.email : null;
    }

    const user = await findOrCreateUser(
      'github', String(info.id), email, info.name || info.login, info.avatar_url
    );
    if (user.is_banned) return authError(res, 'banned');

    const authCode = await createAuthCode(user.id);
    res.redirect(`${MAIN_SITE_URL}/auth/callback?code=${authCode}`);
  } catch (err) {
    console.error('[OAuth/GitHub]', err.message);
    authError(res, 'server_error');
  }
});

/* ── Token exchange (POST /api/user-auth/token) ─────────────────── */
// Main site calls this after receiving the one-time code from the callback URL.
router.post('/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  try {
    const row = await db.prepare(`
      SELECT * FROM auth_codes
      WHERE code = $1 AND used = 0 AND expires_at > NOW()
    `).get(code);

    if (!row) return res.status(400).json({ error: 'Invalid or expired code' });

    // Mark code as used immediately (single-use)
    await db.prepare('UPDATE auth_codes SET used = 1 WHERE code = $1').run(code);

    const user = await db.prepare('SELECT * FROM public_users WHERE id = $1').get(row.user_id);
    if (!user || user.is_banned) return res.status(403).json({ error: 'Forbidden' });

    const token = issueJwt(user);
    res.json({
      token,
      user: {
        id:          user.id,
        displayName: user.display_name,
        avatarUrl:   user.avatar_url,
        email:       user.email,
        provider:    user.provider,
      },
    });
  } catch (err) {
    console.error('[user-auth/token]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── Me (GET /api/user-auth/me) ──────────────────────────────────── */
// Validates token and returns current user data.
router.get('/me', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });

  try {
    const payload = jwt.verify(auth.slice(7), USER_JWT_SECRET);
    const user    = await db.prepare('SELECT * FROM public_users WHERE id = $1').get(payload.sub);
    if (!user || user.is_banned) return res.status(403).json({ error: 'Forbidden' });

    res.json({
      id:          user.id,
      displayName: user.display_name,
      avatarUrl:   user.avatar_url,
      email:       user.email,
      provider:    user.provider,
    });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

/* ── GET /api/user-auth/preferences ─────────────────────────────── */
router.get('/preferences', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(auth.slice(7), USER_JWT_SECRET);
    const user    = await db.prepare('SELECT notify_replies FROM public_users WHERE id = $1').get(payload.sub);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ notifyReplies: !!user.notify_replies });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/* ── PUT /api/user-auth/preferences ─────────────────────────────── */
router.put('/preferences', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(auth.slice(7), USER_JWT_SECRET);
    const { notifyReplies } = req.body;
    await db.prepare(
      'UPDATE public_users SET notify_replies = $1, updated_at = NOW() WHERE id = $2'
    ).run(notifyReplies ? 1 : 0, payload.sub);
    res.json({ ok: true, notifyReplies: !!notifyReplies });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/* ── GET /api/user-auth/unsubscribe ──────────────────────────────── */
// One-click unsubscribe from reply notifications via tokenized link in emails.
// No auth required — token in URL is the secret.
router.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const user = await db.prepare(
    'SELECT id, display_name FROM public_users WHERE notify_token = $1'
  ).get(token);

  if (!user) return res.status(404).send('Invalid unsubscribe link');

  await db.prepare(
    'UPDATE public_users SET notify_replies = 0, updated_at = NOW() WHERE id = $1'
  ).run(user.id);

  // Friendly HTML response
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Unsubscribed — Deep Feed AI</title>
    <style>body{font-family:sans-serif;background:#0f1117;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .box{text-align:center;padding:40px;max-width:400px;}h1{color:#00d9ff;}a{color:#00d9ff;}</style>
    </head><body><div class="box">
    <h1>✅ Unsubscribed</h1>
    <p>You won't receive reply notifications anymore, ${user.display_name}.</p>
    <p>You can re-enable them anytime from your comment settings on <a href="${process.env.MAIN_SITE_URL || 'https://deepfeedai.com'}">Deep Feed AI</a>.</p>
    </div></body></html>`);
});

/* ── GET /api/user-auth/activity ─────────────────────────────────── */
// Returns the current user's comment history, paginated.
// Each comment includes article title + slug (joined via news route slug logic).
router.get('/activity', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });

  try {
    const payload = jwt.verify(auth.slice(7), USER_JWT_SECRET);
    const userId  = payload.sub;

    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const user = await db.prepare(
      'SELECT id, display_name, avatar_url, email, provider, created_at FROM public_users WHERE id = $1'
    ).get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Two-step: fetch comments, then match article titles by slug
    const commentRows = await db.prepare(`
      SELECT c.id, c.body, c.article_slug, c.parent_id, c.created_at, c.updated_at
      FROM comments c
      WHERE c.user_id = $1 AND c.is_deleted = 0 AND c.is_approved = 1
      ORDER BY c.created_at DESC
      LIMIT $2 OFFSET $3
    `).all(userId, limit, offset);

    // Fetch total count
    const countRow = await db.prepare(`
      SELECT COUNT(*) AS cnt FROM comments
      WHERE user_id = $1 AND is_deleted = 0 AND is_approved = 1
    `).get(userId);
    const total = parseInt(countRow?.cnt ?? 0, 10);

    // Fetch all articles to match slugs → titles (mirrors /api/article approach)
    let articleTitleMap = {};
    if (commentRows.length > 0) {
      const allArticles = await db.prepare(
        'SELECT title FROM articles WHERE is_published = 1'
      ).all();
      const { toSlug } = require('../lib/utils');
      for (const a of allArticles) {
        articleTitleMap[toSlug(a.title)] = a.title;
      }
    }

    const result = commentRows.map(c => ({
      id:           c.id,
      body:         c.body,
      articleSlug:  c.article_slug,
      articleTitle: articleTitleMap[c.article_slug] || null,
      parentId:     c.parent_id,
      createdAt:    c.created_at,
      updatedAt:    c.updated_at,
    }));

    res.json({
      user: {
        id:          user.id,
        displayName: user.display_name,
        avatarUrl:   user.avatar_url,
        email:       user.email,
        provider:    user.provider,
        memberSince: user.created_at,
      },
      comments:     result,
      commentCount: total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[user-auth/activity]', err.message);
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
