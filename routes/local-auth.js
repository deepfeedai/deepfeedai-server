/**
 * Deep Feed AI Admin — routes/local-auth.js
 * Local username/password authentication for admin users.
 */
const express          = require('express');
const router           = express.Router();
const bcrypt           = require('bcryptjs');
const jwt              = require('jsonwebtoken');
const rateLimit        = require('express-rate-limit');
const { getJwtSecret } = require('../middleware/auth');
const { asyncHandler } = require('../lib/utils');
const { loginSchema, validate } = require('../lib/schemas');
const { logAudit }     = require('../middleware/audit');
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
  const tenantId = req.tenantId || 1;

  // Look up user
  const user = await db.prepare(
    'SELECT * FROM users WHERE username = $1 AND tenant_id = $2'
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

  // Determine type
  const type = (tenantId === 1 && user.role === 'owner') ? 'platform-admin' : 'tenant-admin';

  // Look up role permissions
  let permissions = ['*']; // default for owner
  if (user.role !== 'owner' || tenantId !== 1) {
    try {
      const roleRow = await db.prepare('SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2').get(tenantId, user.role);
      if (roleRow) {
        permissions = typeof roleRow.permissions === 'string' ? JSON.parse(roleRow.permissions) : roleRow.permissions;
      } else {
        permissions = [];
      }
    } catch { permissions = []; }
  }

  // Sign JWT
  const jwtSecret = await getJwtSecret();
  const token = jwt.sign(
    {
      sub:        user.id,
      username:   user.username,
      displayName: user.display_name,
      email:      user.email,
      tenantId,
      role:       user.role,
      type,
      authMethod: 'local',
      permissions,
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
      tenantId,
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

module.exports = router;
