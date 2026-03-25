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
const { getSiteConfig } = require('../lib/site-config');

const router = express.Router();

/* ── Config ──────────────────────────────────────────────────────── */
const { getOAuthConfig } = require('../lib/oauth-config');
const { getAppConfig }   = require('../lib/app-config');

const { getSecrets } = require('../lib/secrets');

/* ── OAuth state store (in-memory, 10-min TTL) ───────────────────── */
const oauthStates = new Map();

// Allowed return_to values for OAuth redirects (prevents open redirect)
const ALLOWED_RETURN_TO = new Set(['signup', 'login']);

function generateState(meta) {
  const stateId = crypto.randomBytes(32).toString('hex');
  oauthStates.set(stateId, { ts: Date.now(), ...(meta || {}) });
  // Prune stale states
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of oauthStates) {
    if (v.ts < cutoff) oauthStates.delete(k);
  }
  return stateId;
}

function validateState(state) {
  const entry = oauthStates.get(state);
  if (!entry) return null;
  oauthStates.delete(state); // one-time use
  if (Date.now() - entry.ts > 10 * 60 * 1000) return null;
  return entry;
}

/** Resolve redirect URL after OAuth, based on state metadata */
function getRedirectUrl(stateMeta, authCode, baseUrl, mainSiteUrl) {
  if (stateMeta.return_to === 'signup') {
    return `${baseUrl}/signup.html?code=${authCode}`;
  }
  if (stateMeta.return_to === 'login') {
    return `${baseUrl}/login.html?code=${authCode}`;
  }
  return `${mainSiteUrl}/auth/callback?code=${authCode}`;
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

  if (!user && email) {
    // Check for a placeholder record created via platform admin invite
    const placeholder = await db.prepare(
      "SELECT * FROM public_users WHERE LOWER(email) = LOWER($1) AND provider IN ('platform', 'local')"
    ).get(email);
    if (placeholder) {
      // Upgrade placeholder to real OAuth user — preserves the same id so tenant_admins links stay valid
      user = await db.prepare(`
        UPDATE public_users
        SET provider     = $1,
            provider_id  = $2,
            display_name = $3,
            avatar_url   = $4,
            notify_token = COALESCE(notify_token, $5),
            updated_at   = NOW()
        WHERE id = $6
        RETURNING *
      `).get(provider, String(providerId), safeName, avatarUrl || null, crypto.randomBytes(24).toString('hex'), placeholder.id);
    }
  }

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
async function issueJwt(user) {
  const { userJwtSecret } = await getSecrets();
  return jwt.sign(
    {
      sub:         user.id,
      email:       user.email,
      displayName: user.display_name,
      avatarUrl:   user.avatar_url,
      provider:    user.provider,
      emailVerified: !!user.email_verified,
    },
    userJwtSecret,
    { expiresIn: '7d' }
  );
}

/** Redirect to main site with an error code */
function authError(res, code, mainSiteUrl) {
  return res.redirect(`${mainSiteUrl}/?auth_error=${encodeURIComponent(code)}`);
}

/* ── Google OAuth ────────────────────────────────────────────────── */

router.get('/google', async (req, res) => {
  const oauth = await getOAuthConfig();
  if (!oauth.googleClientId) return res.status(503).json({ error: 'Google OAuth not configured' });
  const appCfg = await getAppConfig(req.tenantId);
  const baseUrl = (appCfg.base_url || 'http://localhost:4000').replace(/\/$/, '');
  const returnTo = ALLOWED_RETURN_TO.has(req.query.return_to) ? req.query.return_to : undefined;
  const state = generateState({ return_to: returnTo });
  const url   = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id',     oauth.googleClientId);
  url.searchParams.set('redirect_uri',  `${baseUrl}/api/user-auth/google/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         'openid email profile');
  url.searchParams.set('state',         state);
  url.searchParams.set('access_type',   'online');
  url.searchParams.set('prompt',        'select_account');
  res.redirect(url.toString());
});

router.get('/google/callback', async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const baseUrl = (appCfg.base_url || 'http://localhost:4000').replace(/\/$/, '');
  const mainSiteUrl = (appCfg.main_site_url || 'http://localhost:3001').replace(/\/$/, '');
  const { code, state, error } = req.query;
  if (error)                   return authError(res, error, mainSiteUrl);
  const stateMeta = validateState(state);
  if (!stateMeta)              return authError(res, 'invalid_state', mainSiteUrl);

  try {
    const oauth = await getOAuthConfig();
    // Exchange code → access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     oauth.googleClientId,
        client_secret: oauth.googleClientSecret,
        redirect_uri:  `${baseUrl}/api/user-auth/google/callback`,
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
    if (user.is_banned) return authError(res, 'banned', mainSiteUrl);

    const authCode = await createAuthCode(user.id);
    res.redirect(getRedirectUrl(stateMeta, authCode, baseUrl, mainSiteUrl));
  } catch (err) {
    console.error('[OAuth/Google]', err.message);
    authError(res, 'server_error', mainSiteUrl);
  }
});

/* ── GitHub OAuth ────────────────────────────────────────────────── */

router.get('/github', async (req, res) => {
  const oauth = await getOAuthConfig();
  if (!oauth.githubClientId) return res.status(503).json({ error: 'GitHub OAuth not configured' });
  const appCfg = await getAppConfig(req.tenantId);
  const baseUrl = (appCfg.base_url || 'http://localhost:4000').replace(/\/$/, '');
  const returnTo = ALLOWED_RETURN_TO.has(req.query.return_to) ? req.query.return_to : undefined;
  const state = generateState({ return_to: returnTo });
  const url   = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id',    oauth.githubClientId);
  url.searchParams.set('redirect_uri', `${baseUrl}/api/user-auth/github/callback`);
  url.searchParams.set('scope',        'user:email');
  url.searchParams.set('state',        state);
  res.redirect(url.toString());
});

router.get('/github/callback', async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const baseUrl = (appCfg.base_url || 'http://localhost:4000').replace(/\/$/, '');
  const mainSiteUrl = (appCfg.main_site_url || 'http://localhost:3001').replace(/\/$/, '');
  const { code, state, error } = req.query;
  if (error)                  return authError(res, error, mainSiteUrl);
  const stateMeta = validateState(state);
  if (!stateMeta)             return authError(res, 'invalid_state', mainSiteUrl);

  try {
    const oauth = await getOAuthConfig();
    // Exchange code → access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'application/json',
      },
      body: new URLSearchParams({
        client_id:     oauth.githubClientId,
        client_secret: oauth.githubClientSecret,
        code,
        redirect_uri:  `${baseUrl}/api/user-auth/github/callback`,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access_token from GitHub');

    // Fetch user profile
    const ghSite = await getSiteConfig(req.tenantId);
    const ghUserAgent = `${ghSite.short_name || 'DeepFeedAI'}/1.0`;
    const infoRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'User-Agent':  ghUserAgent,
      },
    });
    const info = await infoRes.json();

    // GitHub doesn't always return a public email — fetch the verified primary
    let email = info.email;
    if (!email) {
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'User-Agent':  ghUserAgent,
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
    if (user.is_banned) return authError(res, 'banned', mainSiteUrl);

    const authCode = await createAuthCode(user.id);
    res.redirect(getRedirectUrl(stateMeta, authCode, baseUrl, mainSiteUrl));
  } catch (err) {
    console.error('[OAuth/GitHub]', err.message);
    authError(res, 'server_error', mainSiteUrl);
  }
});

/* ── Email/Password Registration (POST /api/user-auth/register) ─── */
const bcrypt   = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const requireUser = require('../middleware/user-jwt');
const { sendVerificationEmail } = require('../lib/notify');

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many registration attempts. Please try again later.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', registerLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const safeName = name.replace(/<[^>]*>/g, '').trim().slice(0, 60);

  try {
    // Check if email already registered as local user
    const existing = await db.prepare(
      "SELECT id FROM public_users WHERE LOWER(email) = $1 AND provider = 'local'"
    ).get(cleanEmail);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead — you can create a new site after logging in.' });
    }

    // Check for OAuth user with same email — they should use OAuth instead
    const oauthUser = await db.prepare(
      "SELECT provider FROM public_users WHERE LOWER(email) = $1 AND provider != 'local' AND provider != 'platform'"
    ).get(cleanEmail);
    if (oauthUser) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead — you can create a new site after logging in.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const notifyToken = crypto.randomBytes(24).toString('hex');
    const providerId = crypto.randomBytes(16).toString('hex'); // unique ID for local users

    // Check for placeholder record from platform admin invite
    const placeholder = await db.prepare(
      "SELECT id FROM public_users WHERE LOWER(email) = $1 AND provider = 'platform'"
    ).get(cleanEmail);

    let user;
    if (placeholder) {
      // Upgrade placeholder to local user
      user = await db.prepare(`
        UPDATE public_users
        SET provider = 'local', provider_id = $1, display_name = $2,
            password_hash = $3, notify_token = COALESCE(notify_token, $4), updated_at = NOW()
        WHERE id = $5
        RETURNING *
      `).get(providerId, safeName, passwordHash, notifyToken, placeholder.id);
    } else {
      user = await db.prepare(`
        INSERT INTO public_users (provider, provider_id, email, display_name, password_hash, notify_token)
        VALUES ('local', $1, $2, $3, $4, $5)
        RETURNING *
      `).get(providerId, cleanEmail, safeName, passwordHash, notifyToken);
    }

    const token = await issueJwt(user);

    // Generate 6-digit verification code and send email
    const verifyCode = String(crypto.randomInt(100000, 1000000));
    const verifyExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await db.prepare(
      "INSERT INTO auth_codes (code, user_id, expires_at, type) VALUES ($1, $2, $3, 'email_verify')"
    ).run(verifyCode, user.id, verifyExpires);

    // Send verification email (non-blocking — don't fail registration if email fails)
    sendVerificationEmail({ toEmail: cleanEmail, toName: safeName, code: verifyCode })
      .catch(err => console.error('[user-auth/register] verification email failed:', err.message));

    res.status(201).json({
      token,
      email_verified: false,
      user: {
        id: user.id,
        displayName: user.display_name,
        email: user.email,
        provider: 'local',
      },
    });
  } catch (err) {
    console.error('[user-auth/register]', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/* ── Email/Password Login (POST /api/user-auth/login) ────────────── */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { error: 'Too many login attempts. Please try again later.' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await db.prepare(
      "SELECT * FROM public_users WHERE LOWER(email) = LOWER($1) AND provider = 'local'"
    ).get(email.toLowerCase().trim());

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.is_banned) {
      return res.status(403).json({ error: 'Account suspended' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = await issueJwt(user);
    res.json({
      token,
      email_verified: !!user.email_verified,
      user: {
        id: user.id,
        displayName: user.display_name,
        email: user.email,
        provider: 'local',
      },
    });
  } catch (err) {
    console.error('[user-auth/login]', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

/* ── Email Verification (POST /api/user-auth/verify-email) ──────── */
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.sub || req.ip,
  message: { error: 'Too many verification attempts. Please try again later.' },
  validate: false,
});

router.post('/verify-email', requireUser, verifyLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Verification code is required' });
  }

  try {
    // Already verified?
    const pu = await db.prepare('SELECT email_verified FROM public_users WHERE id = $1').get(req.user.sub);
    if (pu && pu.email_verified) {
      const freshUser = await db.prepare('SELECT * FROM public_users WHERE id = $1').get(req.user.sub);
      const token = await issueJwt(freshUser);
      return res.json({ verified: true, already: true, token });
    }

    const row = await db.prepare(`
      SELECT code FROM auth_codes
      WHERE code = $1 AND user_id = $2 AND type = 'email_verify' AND used = 0 AND expires_at > NOW()
    `).get(code.trim(), req.user.sub);

    if (!row) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    await db.prepare('UPDATE auth_codes SET used = 1 WHERE code = $1').run(row.code);
    await db.prepare('UPDATE public_users SET email_verified = 1, updated_at = NOW() WHERE id = $1').run(req.user.sub);

    const freshUser = await db.prepare('SELECT * FROM public_users WHERE id = $1').get(req.user.sub);
    const token = await issueJwt(freshUser);
    res.json({ verified: true, token });
  } catch (err) {
    console.error('[user-auth/verify-email]', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

/* ── Resend Verification Code (POST /api/user-auth/resend-verification) ── */
const resendVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.user?.sub || req.ip,
  message: { error: 'Too many resend attempts. Please try again later.' },
  validate: false,
});

router.post('/resend-verification', requireUser, resendVerifyLimiter, async (req, res) => {
  try {
    const user = await db.prepare(
      "SELECT * FROM public_users WHERE id = $1 AND provider = 'local'"
    ).get(req.user.sub);

    if (!user) {
      return res.status(400).json({ error: 'Only email accounts require verification' });
    }
    if (user.email_verified) {
      return res.json({ sent: false, already_verified: true });
    }

    // Invalidate any previous unused codes
    await db.prepare(
      "UPDATE auth_codes SET used = 1 WHERE user_id = $1 AND type = 'email_verify' AND used = 0"
    ).run(user.id);

    // Generate new code
    const verifyCode = String(crypto.randomInt(100000, 1000000));
    const verifyExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await db.prepare(
      "INSERT INTO auth_codes (code, user_id, expires_at, type) VALUES ($1, $2, $3, 'email_verify')"
    ).run(verifyCode, user.id, verifyExpires);

    try {
      await sendVerificationEmail({ toEmail: user.email, toName: user.display_name, code: verifyCode });
    } catch (emailErr) {
      console.error('[user-auth/resend-verification] email delivery failed:', emailErr.message);
      return res.json({ sent: false, error: 'Email delivery failed. Please try again.' });
    }

    res.json({ sent: true });
  } catch (err) {
    console.error('[user-auth/resend-verification]', err.message);
    res.status(500).json({ error: 'Failed to resend verification code' });
  }
});

/* ── Forgot Password (POST /api/user-auth/forgot-password) ───────── */
const { sendPasswordResetEmail } = require('../lib/notify');

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts. Please try again later.' },
  validate: false,
});

router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body || {};
  const successMsg = { message: 'If an account with that email exists, we sent a reset link.' };

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  try {
    const user = await db.prepare(
      "SELECT * FROM public_users WHERE LOWER(email) = LOWER($1) AND provider = 'local'"
    ).get(email.toLowerCase().trim());

    // Always return success to prevent email enumeration
    if (!user) return res.json(successMsg);

    // Invalidate previous unused reset tokens
    await db.prepare(
      "UPDATE auth_codes SET used = 1 WHERE user_id = $1 AND type = 'password_reset' AND used = 0"
    ).run(user.id);

    // Generate secure reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await db.prepare(
      "INSERT INTO auth_codes (code, user_id, expires_at, type) VALUES ($1, $2, $3, 'password_reset')"
    ).run(resetToken, user.id, expires);

    // Build reset URL from trusted server config (never from request headers)
    const { getPlatformTenantId } = require('../lib/platform-tenant');
    const platformId = await getPlatformTenantId();
    const appCfg = await getAppConfig(platformId);
    const baseUrl = (appCfg.base_url || 'https://portal.deepfeedai.com').replace(/\/$/, '');
    const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}`;

    sendPasswordResetEmail({ toEmail: user.email, toName: user.display_name, resetUrl })
      .catch(err => console.error('[user-auth/forgot-password] email failed:', err.message));

    res.json(successMsg);
  } catch (err) {
    console.error('[user-auth/forgot-password]', err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/* ── Reset Password (POST /api/user-auth/reset-password) ─────────── */
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts. Please try again later.' },
  validate: false,
});

router.post('/reset-password', resetPasswordLimiter, async (req, res) => {
  const { token, password } = req.body || {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Reset token is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const row = await db.prepare(`
      SELECT * FROM auth_codes
      WHERE code = $1 AND type = 'password_reset' AND used = 0 AND expires_at > NOW()
    `).get(token);

    if (!row) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    // Hash password first (CPU-bound), then atomically mark token used + update password
    const passwordHash = await bcrypt.hash(password, 12);
    await db.prepare('UPDATE auth_codes SET used = 1 WHERE code = $1').run(token);
    await db.prepare(
      'UPDATE public_users SET password_hash = $1, updated_at = NOW() WHERE id = $2'
    ).run(passwordHash, row.user_id);

    res.json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (err) {
    console.error('[user-auth/reset-password]', err.message);
    res.status(500).json({ error: 'Reset failed' });
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
      WHERE code = $1 AND used = 0 AND expires_at > NOW() AND (type IS NULL OR type = 'oauth')
    `).get(code);

    if (!row) return res.status(400).json({ error: 'Invalid or expired code' });

    // Mark code as used immediately (single-use)
    await db.prepare('UPDATE auth_codes SET used = 1 WHERE code = $1').run(code);

    const user = await db.prepare('SELECT * FROM public_users WHERE id = $1').get(row.user_id);
    if (!user || user.is_banned) return res.status(403).json({ error: 'Forbidden' });

    const token = await issueJwt(user);
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
    const { userJwtSecret } = await getSecrets();
    const payload = jwt.verify(auth.slice(7), userJwtSecret);
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
    const { userJwtSecret } = await getSecrets();
    const payload = jwt.verify(auth.slice(7), userJwtSecret);
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
    const { userJwtSecret } = await getSecrets();
    const payload = jwt.verify(auth.slice(7), userJwtSecret);
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

  const site     = await getSiteConfig(req.tenantId);
  const appCfg   = await getAppConfig(req.tenantId);
  const siteName = site.name || 'Deep Feed AI';
  const siteUrl  = site.url || appCfg.main_site_url || 'https://deepfeedai.com';

  // Friendly HTML response
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Unsubscribed — ${siteName}</title>
    <style>body{font-family:sans-serif;background:#0f1117;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .box{text-align:center;padding:40px;max-width:400px;}h1{color:#00d9ff;}a{color:#00d9ff;}</style>
    </head><body><div class="box">
    <h1>✅ Unsubscribed</h1>
    <p>You won't receive reply notifications anymore, ${user.display_name}.</p>
    <p>You can re-enable them anytime from your comment settings on <a href="${siteUrl}">${siteName}</a>.</p>
    </div></body></html>`);
});

/* ── GET /api/user-auth/activity ─────────────────────────────────── */
// Returns the current user's comment history, paginated.
// Each comment includes article title + slug (joined via news route slug logic).
router.get('/activity', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });

  try {
    const { userJwtSecret } = await getSecrets();
    const payload = jwt.verify(auth.slice(7), userJwtSecret);
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
      WHERE c.user_id = $1 AND c.tenant_id = $2 AND c.is_deleted = 0 AND c.is_approved = 1
      ORDER BY c.created_at DESC
      LIMIT $3 OFFSET $4
    `).all(userId, req.tenantId, limit, offset);

    // Fetch total count
    const countRow = await db.prepare(`
      SELECT COUNT(*) AS cnt FROM comments
      WHERE user_id = $1 AND tenant_id = $2 AND is_deleted = 0 AND is_approved = 1
    `).get(userId, req.tenantId);
    const total = parseInt(countRow?.cnt ?? 0, 10);

    // Fetch tenant-scoped articles to match slugs → titles
    let articleTitleMap = {};
    if (commentRows.length > 0) {
      const allArticles = await db.prepare(
        'SELECT title FROM articles WHERE tenant_id = $1 AND is_published = 1'
      ).all(req.tenantId);
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

/* ── DELETE /api/user-auth/account ─────────────────────────────────
   Delete the current user's account and all associated data.
   CASCADE constraints handle: comments, favorites, reactions,
   notifications, auth_codes, writer_follows, comment_reports.
   Requires confirmation body: { confirm: "DELETE" }
 ─────────────────────────────────────────────────────────────────── */
router.delete('/account', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });

  try {
    const { userJwtSecret } = await getSecrets();
    const payload = jwt.verify(auth.slice(7), userJwtSecret);
    const userId  = payload.sub;

    const { confirm } = req.body || {};
    if (confirm !== 'DELETE') {
      return res.status(400).json({ error: 'Send { confirm: "DELETE" } to confirm account deletion' });
    }

    // Check if user owns any tenants — require ownership transfer first
    const ownedTenants = await db.prepare(
      "SELECT t.slug FROM tenants t WHERE t.owner_user_id = $1 AND t.status = 'active'"
    ).all(userId);
    if (ownedTenants.length > 0) {
      return res.status(409).json({
        error: 'You own active tenants. Transfer ownership before deleting your account.',
        tenants: ownedTenants.map(t => t.slug),
      });
    }

    // Verify user exists
    const user = await db.prepare('SELECT id FROM public_users WHERE id = $1').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // CASCADE handles: comments (soft-delete body first for audit trail),
    // article_favorites, article_reactions, notifications, auth_codes,
    // writer_follows, comment_reports, tenant_admins
    // Soft-delete comment bodies before hard-deleting user (preserves thread structure)
    await db.prepare(
      "UPDATE comments SET body = '[deleted]', is_deleted = 1 WHERE user_id = $1"
    ).run(userId);

    // Hard-delete the user (CASCADE cleans up FK references)
    await db.prepare('DELETE FROM public_users WHERE id = $1').run(userId);

    res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    console.error('[user-auth/delete-account]', err.message);
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
