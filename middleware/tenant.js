/**
 * Deep Feed AI — middleware/tenant.js
 * Resolves tenant context from the incoming request.
 *
 * Resolution order:
 *   1. JWT claim (tenantId) — verified via jwt.verify(), not base64 peek
 *   2. X-Tenant-Id header — for internal cron requests (requires x-cron-secret)
 *   3. X-Tenant-Slug header — for frontend requests
 *   4. Origin/Referer — subdomain (*.deepfeedai.com) or custom domain lookup
 *   5. Fallback to tenant_id = 1 (original site)
 *
 * Attaches req.tenantId to every request.
 * Caches verified JWT payload on req._verifiedAdminPayload for auth.js reuse.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { timingSafeEqual } = require('crypto');
const db  = require('../db');
const { getSecrets } = require('../lib/secrets');

// Cache slug → id lookups (5-min TTL)
const slugCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function resolveTenantId(slug) {
  const cached = slugCache.get(slug);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.id;

  const row = await db.prepare(
    "SELECT id FROM tenants WHERE slug = $1 AND status = 'active'"
  ).get(slug);

  const id = row ? row.id : null;
  slugCache.set(slug, { id, ts: Date.now() });
  return id;
}

// Cache custom_domain → id lookups (5-min TTL)
const domainCache = new Map();

async function resolveCustomDomain(hostname) {
  const cached = domainCache.get(hostname);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.id;

  const row = await db.prepare(
    "SELECT id FROM tenants WHERE custom_domain = $1 AND status = 'active'"
  ).get(hostname);

  const id = row ? row.id : null;
  domainCache.set(hostname, { id, ts: Date.now() });
  return id;
}

/**
 * Express middleware — attaches req.tenantId to every request.
 * Verifies JWT to extract tenantId (not just base64 peek).
 * Does NOT block requests if tenant can't be resolved — falls back to 1.
 */
async function tenantContext(req, _res, next) {
  const { jwtSecret, jwtSecretPrevious, cronSecret } = await getSecrets();

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
          req.tenantId = payload.tenantId;
          return next();
        }
      }
    } catch { /* not a valid admin JWT — may be a user JWT, continue */ }
  }

  // 2. Check X-Tenant-Id header (internal cron requests — validate cron secret)
  const tenantIdHeader = req.headers['x-tenant-id'];
  if (tenantIdHeader && cronSecret && safeCompare(req.headers['x-cron-secret'], cronSecret)) {
    const parsed = parseInt(tenantIdHeader, 10);
    if (parsed > 0) {
      req.tenantId = parsed;
      return next();
    }
  }

  // 3. Check X-Tenant-Slug header (sent by frontend)
  const slug = req.headers['x-tenant-slug'];
  if (slug) {
    resolveTenantId(slug)
      .then(id => {
        req.tenantId = id || 1;
        next();
      })
      .catch(() => {
        req.tenantId = 1;
        next();
      });
    return;
  }

  // 4. Check Origin/Referer for custom domain resolution
  const origin = req.headers.origin || req.headers.referer || '';
  if (origin) {
    try {
      const hostname = new URL(origin).hostname;
      // Check *.deepfeedai.com subdomains
      const subMatch = hostname.match(/^([a-z0-9-]+)\.deepfeedai\.com$/);
      if (subMatch && subMatch[1] !== 'www' && subMatch[1] !== 'staging') {
        resolveTenantId(subMatch[1])
          .then(id => {
            req.tenantId = id || 1;
            next();
          })
          .catch(() => {
            req.tenantId = 1;
            next();
          });
        return;
      }
      // Check custom domains
      if (!hostname.includes('deepfeedai.com') && !hostname.includes('localhost') && !hostname.match(/^(127\.|192\.168\.|10\.)/)) {
        resolveCustomDomain(hostname)
          .then(id => {
            req.tenantId = id || 1;
            next();
          })
          .catch(() => {
            req.tenantId = 1;
            next();
          });
        return;
      }
    } catch { /* invalid URL, ignore */ }
  }

  // 5. Fallback to original site
  req.tenantId = 1;
  next();
}

module.exports = { tenantContext };
