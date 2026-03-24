/**
 * Deep Feed AI Admin — /api/auth
 * Admin authentication via Google OAuth.
 *
 * Flow:
 *   1. GET  /api/auth/google            → redirect to Google consent screen
 *   2. GET  /api/auth/google/callback   → exchange code, verify email allowlist,
 *                                         issue one-time admin code, redirect to /login.html?code=XXX
 *   3. POST /api/auth/code              → exchange one-time code for 24h admin JWT
 *
 * Authorization: ADMIN_EMAILS env var (comma-separated, case-insensitive).
 * Only Google accounts whose verified email appears in that list may log in.
 */
const express          = require('express');
const router           = express.Router();
const crypto           = require('crypto');
const jwt              = require('jsonwebtoken');
const rateLimit        = require('express-rate-limit');
const { getJwtSecret } = require('../middleware/auth');
const { asyncHandler } = require('../lib/utils');

const { getOAuthConfig } = require('../lib/oauth-config');
const { getAppConfig }   = require('../lib/app-config');
const { logAudit }       = require('../middleware/audit');
const { getPlatformTenantId, getPlatformTenantUuid } = require('../lib/platform-tenant');
const db                   = require('../db');

// ── In-memory stores (short TTL — no DB needed) ────────────────────
// Map<state, timestamp>
const oauthStates = new Map();
// Map<code, { email, displayName, ts }>
const adminCodes  = new Map();

const TTL = 60_000; // 60 seconds

function pruneExpired(map) {
  const cutoff = Date.now() - TTL;
  for (const [k, v] of map) {
    if ((typeof v === 'number' ? v : v.ts) < cutoff) map.delete(k);
  }
}

// ── Rate limit for code exchange ───────────────────────────────────
const codeLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many attempts. Please try again in 15 minutes.' },
});

// ── GET /api/auth/google ───────────────────────────────────────────
// Redirect admin to Google OAuth consent screen.
router.get('/google', asyncHandler(async (req, res) => {
  const oauth = await getOAuthConfig();
  if (!oauth.googleClientId) {
    return res.status(503).send('Google OAuth is not configured (GOOGLE_CLIENT_ID missing).');
  }
  pruneExpired(oauthStates);
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, Date.now());

  const appCfg = await getAppConfig();
  const params = new URLSearchParams({
    client_id:     oauth.googleClientId,
    redirect_uri:  `${appCfg.base_url}/api/auth/google/callback`,
    response_type: 'code',
    scope:         'openid email profile',
    state,
    prompt:        'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}));

// ── GET /api/auth/google/callback ──────────────────────────────────
// Handles the OAuth callback from Google.
router.get('/google/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.warn('[Admin OAuth] Google returned error:', error);
    return res.redirect('/login.html?error=oauth');
  }

  // Validate state
  const stateTs = oauthStates.get(state);
  oauthStates.delete(state);
  if (!stateTs || Date.now() - stateTs > TTL) {
    return res.redirect('/login.html?error=state');
  }

  const oauth = await getOAuthConfig();
  const appCfg = await getAppConfig();

  // Exchange code for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     oauth.googleClientId,
      client_secret: oauth.googleClientSecret,
      redirect_uri:  `${appCfg.base_url}/api/auth/google/callback`,
      grant_type:    'authorization_code',
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error('[Admin OAuth] Token exchange failed:', tokenData);
    return res.redirect('/login.html?error=token');
  }

  // Fetch user info
  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const userInfo = await userRes.json();

  if (!userRes.ok || !userInfo.email) {
    console.error('[Admin OAuth] Userinfo fetch failed:', userInfo);
    return res.redirect('/login.html?error=userinfo');
  }

  // Require verified email
  if (!userInfo.email_verified) {
    return res.redirect('/login.html?error=unverified');
  }

  // Check users table for admin access (platform tenant)
  const platformId = await getPlatformTenantId();
  const adminUser = await db.prepare(
    'SELECT id, role, display_name FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(userInfo.email, platformId);

  if (!adminUser) {
    console.warn(`[Admin OAuth] No admin user found for: ${userInfo.email}`);
    logAudit(req, 'auth.oauth-denied', 'users', null, { email: userInfo.email, provider: 'google' }).catch(() => {});
    return res.redirect('/login.html?error=unauthorized');
  }

  // Issue one-time admin code
  pruneExpired(adminCodes);
  const adminCode = crypto.randomBytes(24).toString('hex');
  adminCodes.set(adminCode, {
    email:       userInfo.email,
    displayName: userInfo.name || userInfo.email,
    userId:      adminUser.id,
    role:        adminUser.role,
    ts:          Date.now(),
  });

  console.log(`[Admin OAuth] Login authorized: ${userInfo.email}`);
  res.redirect(`/login.html?code=${adminCode}`);
}));

// ── POST /api/auth/code ────────────────────────────────────────────
// Exchange a one-time admin code for a signed 24h admin JWT.
router.post('/code', codeLimiter, asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  const entry = adminCodes.get(code);
  adminCodes.delete(code); // one-time use regardless of validity

  if (!entry || Date.now() - entry.ts > TTL) {
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  const type = (entry.role === 'owner') ? 'platform-admin' : 'tenant-admin';

  // Use platform tenant UUID in the JWT
  const platformUuid = await getPlatformTenantUuid();

  // Permissions resolved from DB on each request via middleware/auth.js
  const jwtSecret = await getJwtSecret();
  const token = jwt.sign(
    { sub: entry.userId, email: entry.email, displayName: entry.displayName, provider: 'google', type, tenantId: platformUuid, role: entry.role, authMethod: 'oauth' },
    jwtSecret,
    { expiresIn: '24h' }
  );

  res.json({ token, displayName: entry.displayName, email: entry.email });
}));

// ── POST /api/auth/logout ──────────────────────────────────────────
// Stateless JWT — logout is handled client-side. No-op kept for compatibility.
router.post('/logout', (_req, res) => res.json({ ok: true }));

module.exports = router;
