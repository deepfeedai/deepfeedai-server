/**
 * Deep Feed AI — middleware/tenant.js
 * Resolves tenant context from the incoming request.
 *
 * Resolution order:
 *   1. JWT claim (tenantId) — verified via jwt.verify(), not base64 peek
 *   2. X-Tenant-Id header — for internal cron requests (requires x-cron-secret)
 *   3. X-Tenant-Slug header — for frontend requests
 *   4. Origin/Referer — subdomain (*.deepfeedai.com) or custom domain lookup
 *   5. Fallback to platform tenant
 *
 * Attaches req.tenantId (internal integer) to every request.
 * Caches verified JWT payload on req._verifiedAdminPayload for auth.js reuse.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { timingSafeEqual } = require('crypto');
const db  = require('../db');
const { getSecrets } = require('../lib/secrets');
const { getPlatformTenantId } = require('../lib/platform-tenant');

// UUID v4 validation regex
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Cache slug → id lookups (5-min TTL)
const slugCache = new Map();
// Cache uuid → id lookups (5-min TTL)
const uuidCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Returns { id, suspended } — id is null for unknown slugs, suspended=true for non-active tenants
async function resolveTenantId(slug) {
  const cached = slugCache.get(slug);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

  const row = await db.prepare(
    "SELECT id, status FROM tenants WHERE slug = $1"
  ).get(slug);

  let result;
  if (!row) {
    result = { id: null, suspended: false };
  } else if (row.status !== 'active') {
    result = { id: null, suspended: true };
  } else {
    result = { id: row.id, suspended: false };
  }
  slugCache.set(slug, { ...result, ts: Date.now() });
  return result;
}

// Cache custom_domain → id lookups (5-min TTL)
const domainCache = new Map();

// Returns { id, suspended } — same pattern as resolveTenantId
async function resolveCustomDomain(hostname) {
  const cached = domainCache.get(hostname);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

  const row = await db.prepare(
    "SELECT id, status FROM tenants WHERE custom_domain = $1"
  ).get(hostname);

  let result;
  if (!row) {
    result = { id: null, suspended: false };
  } else if (row.status !== 'active') {
    result = { id: null, suspended: true };
  } else {
    result = { id: row.id, suspended: false };
  }
  domainCache.set(hostname, { ...result, ts: Date.now() });
  return result;
}

/**
 * Resolve a tenant UUID to internal integer ID.
 * Cached with 5-min TTL (same as slug/domain caches).
 * Returns { id, suspended } — same pattern as other resolvers.
 */
async function resolveUuidToId(uuid) {
  const cached = uuidCache.get(uuid);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

  const row = await db.prepare(
    "SELECT id, status FROM tenants WHERE uuid = $1"
  ).get(uuid);

  let result;
  if (!row) {
    result = { id: null, suspended: false };
  } else if (row.status !== 'active') {
    result = { id: null, suspended: true };
  } else {
    result = { id: row.id, suspended: false };
  }
  uuidCache.set(uuid, { ...result, ts: Date.now() });
  return result;
}

/**
 * Express middleware — attaches req.tenantId to every request.
 * Verifies JWT to extract tenantId (not just base64 peek).
 * Does NOT block requests if tenant can't be resolved — falls back to platform tenant.
 */
async function tenantContext(req, res, next) {
  const { jwtSecret, jwtSecretPrevious, cronSecret } = await getSecrets();
  const platformId = await getPlatformTenantId();

  // 1. Try to extract tenantId from Bearer JWT (fully verified)
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ') && jwtSecret) {
    try {
      const token = authHeader.slice(7).trim();
      let payload;
      try {
        payload = jwt.verify(token, jwtSecret);
      } catch {
        if (jwtSecretPrevious) {
          try { payload = jwt.verify(token, jwtSecretPrevious); } catch { /* neither key works */ }
        }
      }
      if (payload) {
        req._verifiedAdminPayload = payload;
        if (payload.tenantId) {
          // UUID tenantId: resolve to internal integer
          if (typeof payload.tenantId === 'string' && UUID_RE.test(payload.tenantId)) {
            try {
              const resolved = await resolveUuidToId(payload.tenantId);
              if (resolved.id) {
                req.tenantId = resolved.id;
                return next();
              }
            } catch { /* fall through */ }
          }
          // Grace period: accept integer tenantId from old JWTs
          if (typeof payload.tenantId === 'number' && payload.tenantId > 0) {
            req.tenantId = payload.tenantId;
            return next();
          }
        }
      }
    } catch { /* not a valid admin JWT — may be a user JWT, continue */ }
  }

  // 2. Check X-Tenant-Id header (internal cron requests — validate cron secret)
  const tenantIdHeader = req.headers['x-tenant-id'];
  if (tenantIdHeader && cronSecret && safeCompare(req.headers['x-cron-secret'], cronSecret)) {
    // Accept UUID format
    if (UUID_RE.test(tenantIdHeader)) {
      try {
        const resolved = await resolveUuidToId(tenantIdHeader);
        if (resolved.id) {
          req.tenantId = resolved.id;
          return next();
        }
      } catch { /* fall through */ }
    }
    // Grace period: accept integer format from old cron callers
    const parsed = parseInt(tenantIdHeader, 10);
    if (parsed > 0) {
      req.tenantId = parsed;
      return next();
    }
  }

  // Helper: handle resolve result { id, suspended }
  function handleResolved(result) {
    if (result.suspended) {
      return res.status(403).json({ error: 'This site has been suspended' });
    }
    req.tenantId = result.id || platformId;
    next();
  }

  // 3. Check X-Tenant-Slug header (sent by frontend)
  const slug = req.headers['x-tenant-slug'];
  if (slug) {
    resolveTenantId(slug)
      .then(handleResolved)
      .catch(() => { req.tenantId = platformId; next(); });
    return;
  }

  // 4. Check Origin/Referer for custom domain resolution
  const origin = req.headers.origin || req.headers.referer || '';
  if (origin) {
    try {
      const hostname = new URL(origin).hostname;
      // Check *.deepfeedai.com subdomains
      const subMatch = hostname.match(/^([a-z0-9-]+)\.deepfeedai\.com$/);
      if (subMatch && subMatch[1] !== 'www' && subMatch[1] !== 'staging' && subMatch[1] !== 'portal' && subMatch[1] !== 'portal-staging' && subMatch[1] !== 'platform' && subMatch[1] !== 'platform-staging') {
        resolveTenantId(subMatch[1])
          .then(handleResolved)
          .catch(() => { req.tenantId = platformId; next(); });
        return;
      }
      // Check custom domains
      if (!hostname.includes('deepfeedai.com') && !hostname.includes('localhost') && !hostname.match(/^(127\.|192\.168\.|10\.)/)) {
        resolveCustomDomain(hostname)
          .then(handleResolved)
          .catch(() => { req.tenantId = platformId; next(); });
        return;
      }
    } catch { /* invalid URL, ignore */ }
  }

  // 5. Fallback to platform tenant
  req.tenantId = platformId;
  next();
}

function invalidateSlugCache(slug) {
  if (slug) slugCache.delete(slug);
}

function invalidateDomainCache(domain) {
  if (domain) domainCache.delete(domain);
}

function invalidateUuidCache(uuid) {
  if (uuid) uuidCache.delete(uuid);
}

module.exports = { tenantContext, invalidateSlugCache, invalidateDomainCache, invalidateUuidCache, resolveUuidToId, UUID_RE };
