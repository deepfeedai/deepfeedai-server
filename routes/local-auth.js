/**
 * Deep Feed AI Admin — routes/local-auth.js
 * Local username/password authentication for admin users.
 */
const express          = require('express');
const router           = express.Router();
const bcrypt           = require('bcryptjs');
const jwt              = require('jsonwebtoken');
const rateLimit        = require('express-rate-limit');
const { getJwtSecret, auth } = require('../middleware/auth');
const { asyncHandler } = require('../lib/utils');
const { loginSchema, validate } = require('../lib/schemas');
const { logAudit }     = require('../middleware/audit');
const { isPlatformTenant } = require('../lib/platform-tenant');
const db               = require('../db');

// ── Rate limit: 5 attempts per 15 min per IP ─────────────────────
const loginLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             process.env.NODE_ENV === 'production' ? 5 : 50,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// ── POST /api/auth/login ─────────────────────────────────────────
router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const data = validate(loginSchema, req.body, res);
  if (!data) return;

  const { username, password } = data;
  const tenantId = req.tenantId;

  // Look up user by username or email
  const user = await db.prepare(
    'SELECT * FROM users WHERE (username = $1 OR LOWER(email) = LOWER($1)) AND tenant_id = $2'
  ).get(username, tenantId);

  if (!user) {
    logAudit(req, 'auth.login-failed', 'users', null, { username, reason: 'invalid_credentials' }).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Check active
  if (!user.is_active) {
    logAudit(req, 'auth.login-failed', 'users', null, { username, reason: 'inactive_user' }).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Verify password
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    logAudit(req, 'auth.login-failed', 'users', null, { username, reason: 'invalid_credentials' }).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Determine type — platform-admin for owners on the platform tenant
  const isPlatform = await isPlatformTenant(tenantId);
  const type = (isPlatform && user.role === 'owner') ? 'platform-admin' : 'tenant-admin';

  // Look up tenant UUID + slug for the JWT payload
  const tenant = await db.prepare('SELECT uuid, slug FROM tenants WHERE id = $1').get(tenantId);
  const tenantUuid = tenant?.uuid || tenantId; // grace fallback

  // Sign JWT — permissions resolved from DB on each request via middleware/auth.js
  const jwtSecret = await getJwtSecret();
  const token = jwt.sign(
    {
      sub:        user.id,
      username:   user.username,
      displayName: user.display_name,
      email:      user.email,
      tenantId:   tenantUuid,
      tenantSlug: tenant?.slug || null,
      role:       user.role,
      type,
      authMethod: 'local',
    },
    jwtSecret,
    { expiresIn: '24h' }
  );

  // Update last login
  await db.prepare('UPDATE users SET last_login_at = NOW() WHERE id = $1').run(user.id);

  // Audit log
  await logAudit(req, 'auth.local-login', 'users', user.id, { username: user.username });

  res.json({
    token,
    user: {
      id:          user.id,
      username:    user.username,
      displayName: user.display_name,
      email:       user.email,
      role:        user.role,
      tenantId:    tenantUuid,
    },
  });
}));

// ── GET /api/auth/methods ────────────────────────────────────────
const { getOAuthConfig } = require('../lib/oauth-config');

router.get('/methods', asyncHandler(async (_req, res) => {
  const oauth = await getOAuthConfig();
  res.json({
    google: !!oauth.googleClientId,
    github: !!oauth.githubClientId,
    local:  true,
  });
}));

// ── GET /api/auth/me ─────────────────────────────────────────────
// Current admin user profile (self). Used by settings page + newsroom chat.
router.get('/me', auth, asyncHandler(async (req, res) => {
  const user = await db.prepare(
    'SELECT id, username, email, display_name, role, avatar_url FROM users WHERE id = $1'
  ).get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
}));

// ── PATCH /api/auth/me ───────────────────────────────────────────
// Self-service update: display_name + avatar_url. Scoped to req.user.sub.
router.patch('/me', auth, asyncHandler(async (req, res) => {
  const { display_name, avatar_url } = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  if (display_name !== undefined) {
    if (typeof display_name !== 'string' || display_name.length > 120) {
      return res.status(400).json({ error: 'display_name must be a string up to 120 chars' });
    }
    sets.push(`display_name = $${i++}`);
    vals.push(display_name.trim() || null);
  }
  if (avatar_url !== undefined) {
    if (avatar_url !== null && (typeof avatar_url !== 'string' || avatar_url.length > 2048)) {
      return res.status(400).json({ error: 'avatar_url must be a string up to 2048 chars or null' });
    }
    sets.push(`avatar_url = $${i++}`);
    vals.push(avatar_url ? String(avatar_url).trim() : null);
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  sets.push(`updated_at = NOW()`);
  vals.push(req.user.sub);
  await db.prepare(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`
  ).run(...vals);
  const user = await db.prepare(
    'SELECT id, username, email, display_name, role, avatar_url FROM users WHERE id = $1'
  ).get(req.user.sub);
  logAudit(req, 'user.self-update', 'users', req.user.sub, { fields: Object.keys(req.body || {}) }).catch(() => {});
  res.json(user);
}));

module.exports = router;
