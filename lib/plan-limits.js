/**
 * Deep Feed AI — Plan limit enforcement
 * Checks tenant plan limits before allowing resource creation.
 */
'use strict';

const db = require('../db');

// Cache tenant plan info for 60s to avoid repeated lookups
const _planCache = new Map(); // Map<tenantId, { info, ts }>
const PLAN_CACHE_TTL = 60 * 1000;

/**
 * Load tenant plan + limits from DB (cached per tenant).
 * If the tenant has an active trial (trial_ends_at in the future),
 * the effective plan is 'pro' regardless of the actual plan.
 * @param {number} tenantId
 * @returns {Promise<{ plan: string, effectivePlan: string, limits: object, onTrial: boolean, trialEndsAt: string|null } | null>}
 */
async function getPlanInfo(tenantId) {
  const now = Date.now();
  const cached = _planCache.get(tenantId);
  if (cached && (now - cached.ts) < PLAN_CACHE_TTL) {
    return cached.info;
  }

  const tenant = await db.prepare('SELECT plan, trial_ends_at FROM tenants WHERE id = $1').get(tenantId);
  if (!tenant) {
    _planCache.set(tenantId, { info: null, ts: now });
    return null;
  }

  const onTrial = !!(tenant.trial_ends_at && new Date(tenant.trial_ends_at) > new Date());
  const effectivePlan = onTrial ? 'pro' : tenant.plan;

  const limits = await db.prepare('SELECT * FROM plan_limits WHERE plan = $1').get(effectivePlan);
  const info = {
    plan: tenant.plan,
    effectivePlan,
    limits: limits || null,
    onTrial,
    trialEndsAt: tenant.trial_ends_at || null,
  };
  _planCache.set(tenantId, { info, ts: now });
  return info;
}

/**
 * Count current resources for a tenant.
 * @param {number} tenantId
 * @param {string} resource — 'sources' | 'writers' | 'storage'
 * @returns {Promise<number>}
 */
async function countResource(tenantId, resource) {
  switch (resource) {
    case 'sources': {
      const row = await db.prepare('SELECT COUNT(*)::int AS cnt FROM sources WHERE tenant_id = $1 AND removed_at IS NULL').get(tenantId);
      return parseInt(row.cnt);
    }
    case 'writers': {
      const row = await db.prepare('SELECT COUNT(*)::int AS cnt FROM writers WHERE tenant_id = $1').get(tenantId);
      return parseInt(row.cnt);
    }
    case 'storage': {
      const row = await db.prepare(
        'SELECT COALESCE(bytes_used, 0) AS bytes FROM tenant_storage_usage WHERE tenant_id = $1'
      ).get(tenantId);
      // Return value in MB to compare against max_storage_mb
      return row ? Math.floor(row.bytes / (1024 * 1024)) : 0;
    }
    default:
      throw new Error(`Unknown resource: ${resource}`);
  }
}

/** Map resource name to the corresponding plan_limits column */
const RESOURCE_TO_COLUMN = {
  sources: 'max_sources',
  writers: 'max_writers',
  storage: 'max_storage_mb',
};

/**
 * Check if a tenant can create another resource.
 * @param {number} tenantId
 * @param {'sources'|'writers'|'storage'} resource
 * @returns {Promise<{ allowed: boolean, current: number, max: number|null }>}
 */
async function checkPlanLimit(tenantId, resource) {
  const info = await getPlanInfo(tenantId);
  if (!info || !info.limits) {
    // No plan info found — allow by default (graceful fallback)
    return { allowed: true, current: 0, max: null };
  }

  const column = RESOURCE_TO_COLUMN[resource];
  if (!column) throw new Error(`Unknown resource: ${resource}`);

  const max = info.limits[column];

  // NULL max means unlimited (business plan)
  if (max === null || max === undefined) {
    return { allowed: true, current: 0, max: null };
  }

  const current = await countResource(tenantId, resource);
  return { allowed: current < max, current, max };
}

// Legacy column name → new feature key mapping
const _legacyFeatureMap = {
  audio_enabled: 'audio',
  custom_domain_enabled: 'custom_domain',
  seo_titles_enabled: 'seo_titles',
};

/**
 * Check if a boolean feature is enabled for a tenant's plan.
 * Delegates to the feature registry for centralized resolution.
 * Accepts both legacy column names (audio_enabled) and new keys (audio).
 * @param {number} tenantId
 * @param {string} feature
 * @returns {Promise<boolean>}
 */
async function checkFeatureEnabled(tenantId, feature) {
  try {
    const { isFeatureEnabled } = require('./feature-registry');
    const featureKey = _legacyFeatureMap[feature] || feature;
    return await isFeatureEnabled(tenantId, featureKey);
  } catch {
    // Fallback to plan_limits if feature registry not yet available (fresh DB)
    const info = await getPlanInfo(tenantId);
    if (!info || !info.limits) return false;
    return !!info.limits[feature];
  }
}

function bustPlanCache(tenantId) {
  if (tenantId) _planCache.delete(tenantId);
  else _planCache.clear();
}

function purgeStaleEntries() {
  const cutoff = Date.now() - PLAN_CACHE_TTL;
  for (const [k, v] of _planCache) {
    if (v.ts < cutoff) _planCache.delete(k);
  }
}

module.exports = { getPlanInfo, checkPlanLimit, checkFeatureEnabled, bustPlanCache, purgeStaleEntries };
