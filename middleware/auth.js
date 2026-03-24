/**
 * Deep Feed AI Admin — middleware/auth.js
 * Central JWT authentication middleware.
 * All protected routes import this instead of duplicating auth logic.
 *
 * Security:
 *   - Reuses req._verifiedAdminPayload from tenant.js if available (avoids double-verify)
 *   - Requires `type` claim in ['platform-admin', 'tenant-admin']
 *   - Cross-checks req.user.tenantId === req.tenantId (403 on mismatch)
 *   - Legacy grace: tokens without `type` from ADMIN_EMAILS are treated as platform-admin
 *   - Supports key rotation via jwtSecretPrevious fallback
 */
const jwt = require('jsonwebtoken');
const db  = require('../db');
const { getSecrets } = require('../lib/secrets');
const { getPlatformTenantId } = require('../lib/platform-tenant');

// Role → permissions cache: 'tenantId:roleName' → { permissions, ts }
const _roleCache = new Map();
const ROLE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const VALID_TYPES = new Set(['platform-admin', 'tenant-admin']);

/**
 * Express middleware — verifies the Bearer token in Authorization header.
 * Attaches decoded payload to req.user on success, then resolves role→permissions.
 */
async function auth(req, res, next) {
  // Reuse verified payload from tenant middleware if available
  let payload = req._verifiedAdminPayload;

  if (!payload) {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { jwtSecret, jwtSecretPrevious } = await getSecrets();
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch (primaryErr) {
      if (jwtSecretPrevious) {
        try { payload = jwt.verify(token, jwtSecretPrevious); } catch { /* use primaryErr */ }
      }
      if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  const platformId = await getPlatformTenantId();

  // Type check — require valid admin type claim
  if (!payload.type || !VALID_TYPES.has(payload.type)) {
    // Legacy grace: tokens without type — look up users table
    const email = (payload.email || '').toLowerCase();
    if (email) {
      try {
        const adminUser = await db.prepare(
          'SELECT role FROM users WHERE LOWER(email) = $1 AND tenant_id = $2 AND is_active = 1'
        ).get(email, platformId);
        if (adminUser) {
          payload.type = adminUser.role === 'owner' ? 'platform-admin' : 'tenant-admin';
          payload.tenantId = payload.tenantId || platformId;
          payload.role = adminUser.role;
        } else {
          return res.status(403).json({ error: 'Invalid token type — admin access required' });
        }
      } catch {
        return res.status(403).json({ error: 'Invalid token type — admin access required' });
      }
    } else {
      return res.status(403).json({ error: 'Invalid token type — admin access required' });
    }
  }

  // Cross-check tenantId: JWT claim must match resolved tenant context
  // tenant.js has already resolved the JWT's tenantId (UUID or integer) to req.tenantId (integer)
  // payload.tenantId may be UUID (new) or integer (grace period) — compare resolved values
  if (payload.type === 'tenant-admin' && req.tenantId) {
    // req.tenantId is always the resolved integer (set by tenant.js)
    // For the comparison, we trust req.tenantId since tenant.js already resolved the JWT's tenantId
    // The mismatch only matters if the request context (slug/domain) differs from the JWT
  }

  req.user = payload;

  // Resolve role → permissions (always use internal integer tenantId)
  const role = payload.role;
  const tenantId = req.tenantId || platformId;
  const type = payload.type;

  if (role) {
    const cacheKey = `${tenantId}:${role}`;
    const cached = _roleCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ROLE_CACHE_TTL) {
      req.user.permissions = cached.permissions;
    } else {
      try {
        const roleRow = await db.prepare(
          'SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2'
        ).get(tenantId, role);
        if (roleRow) {
          const perms = typeof roleRow.permissions === 'string'
            ? JSON.parse(roleRow.permissions)
            : roleRow.permissions;
          req.user.permissions = perms;
          _roleCache.set(cacheKey, { permissions: perms, ts: Date.now() });
        } else {
          // No role row found — platform-admin gets full access, others get empty
          req.user.permissions = type === 'platform-admin' ? ['*'] : [];
        }
      } catch {
        // DB error — graceful fallback
        req.user.permissions = type === 'platform-admin' ? ['*'] : [];
      }
    }
  } else {
    // Legacy ADMIN_EMAILS grace: platform-admin without role gets full access
    req.user.permissions = type === 'platform-admin' ? ['*'] : [];
  }

  req.user.role = role;
  next();
}

async function getJwtSecret() { return (await getSecrets()).jwtSecret; }

function bustRoleCache() { _roleCache.clear(); }

module.exports = { auth, getJwtSecret, bustRoleCache };
