/**
 * Deep Feed AI — /api/admin/features
 * Platform admin feature management endpoints.
 * Manages feature definitions, plan-level values, and per-tenant overrides.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePlatformAdmin } = require('../middleware/permissions');
const { logAudit } = require('../middleware/audit');
const { FEATURE_DEFINITIONS, FEATURE_MAP, bustFeatureCache, getAllFeatures } = require('../lib/feature-registry');
const { getPlanInfo } = require('../lib/plan-limits');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolveTenantParam(raw) {
  if (UUID_RE.test(raw)) {
    const row = await db.prepare('SELECT id FROM tenants WHERE uuid = $1').get(raw);
    return row?.id || null;
  }
  const parsed = parseInt(raw, 10);
  return parsed > 0 ? parsed : null;
}

// All routes require platform-admin auth
router.use(auth, requirePlatformAdmin);

// ── GET /api/admin/features — List all features with plan values ──
router.get('/', asyncHandler(async (req, res) => {
  const definitions = await db.prepare(
    'SELECT * FROM feature_definitions ORDER BY sort_order, key'
  ).all();

  const planValues = await db.prepare(
    'SELECT plan, feature_key, value FROM plan_features ORDER BY plan, feature_key'
  ).all();

  // Group plan values by feature key
  const planMap = {};
  for (const pv of planValues) {
    if (!planMap[pv.feature_key]) planMap[pv.feature_key] = {};
    planMap[pv.feature_key][pv.plan] = pv.value;
  }

  const features = definitions.map(d => ({
    ...d,
    plans: planMap[d.key] || {},
  }));

  res.json({ features });
}));

// ── PUT /api/admin/features/:key/plans — Update plan-level values for a feature ──
router.put('/:key/plans', asyncHandler(async (req, res) => {
  const { key } = req.params;

  // Verify feature exists
  const def = await db.prepare('SELECT key FROM feature_definitions WHERE key = $1').get(key);
  if (!def) return res.status(404).json({ error: 'Feature not found' });

  const body = req.body; // { "free": "false", "starter": "true", ... }
  const validPlans = ['free', 'starter', 'pro', 'business', 'internal'];
  const updated = [];

  for (const plan of validPlans) {
    if (body[plan] !== undefined) {
      const value = body[plan] === null ? null : String(body[plan]);
      await db.prepare(
        `INSERT INTO plan_features (plan, feature_key, value) VALUES ($1, $2, $3)
         ON CONFLICT (plan, feature_key) DO UPDATE SET value = $3`
      ).run(plan, key, value);
      updated.push(plan);
    }
  }

  // Bust all tenant caches since plan defaults changed
  bustFeatureCache();

  await logAudit(req, 'features.update_plan', 'feature', key, { plans: body });
  res.json({ ok: true, feature: key, updated });
}));

// ── GET /api/admin/tenants/:id/features — Get resolved features for a tenant ──
router.get('/tenants/:id/features', asyncHandler(async (req, res) => {
  const tenantId = await resolveTenantParam(req.params.id);
  if (!tenantId) return res.status(400).json({ error: 'Invalid tenant ID' });

  const tenant = await db.prepare('SELECT id, plan, trial_ends_at FROM tenants WHERE id = $1').get(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const planInfo = await getPlanInfo(tenantId);
  const features = await getAllFeatures(tenantId);

  // Enrich with definition metadata
  const enriched = {};
  for (const [key, entry] of Object.entries(features)) {
    const def = FEATURE_MAP.get(key);
    enriched[key] = {
      ...entry,
      name: def?.name || key,
      description: def?.description || '',
      category: def?.category || 'other',
      value_type: def?.value_type || 'boolean',
    };
  }

  res.json({
    tenantId,
    plan: planInfo?.plan || 'free',
    effectivePlan: planInfo?.effectivePlan || 'free',
    onTrial: planInfo?.onTrial || false,
    features: enriched,
  });
}));

// ── PUT /api/admin/tenants/:id/features/:key — Set per-tenant override ──
router.put('/tenants/:id/features/:key', asyncHandler(async (req, res) => {
  const tenantId = await resolveTenantParam(req.params.id);
  if (!tenantId) return res.status(400).json({ error: 'Invalid tenant ID' });

  const { key } = req.params;

  // Verify feature exists
  const def = await db.prepare('SELECT key FROM feature_definitions WHERE key = $1').get(key);
  if (!def) return res.status(404).json({ error: 'Feature not found' });

  const { value, reason, expires_at } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value is required' });

  const strValue = value === null ? null : String(value);
  await db.prepare(
    `INSERT INTO tenant_feature_overrides (tenant_id, feature_key, value, reason, granted_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, feature_key)
     DO UPDATE SET value = $3, reason = $4, granted_by = $5, expires_at = $6, created_at = NOW()`
  ).run(tenantId, key, strValue, reason || null, req.user?.id || null, expires_at || null);

  bustFeatureCache(tenantId);

  // Flag-flip hooks — idempotent side-effects that run when a feature is turned on.
  // Kept inline (not a registry) because today there's only one such hook.
  if (key === 'graphic_designer' && (strValue === 'true' || strValue === '1')) {
    try {
      const { ensureDesignerSeeded } = require('../lib/editorial');
      ensureDesignerSeeded(tenantId).catch(err =>
        console.warn('[admin-features] ensureDesignerSeeded failed:', err.message));
    } catch (err) {
      console.warn('[admin-features] designer seed hook dispatch failed:', err.message);
    }
  }

  await logAudit(req, 'features.set_override', 'feature', key, { tenantId, value: strValue, reason, expires_at });
  res.json({ ok: true, feature: key, value: strValue, source: 'override' });
}));

// ── DELETE /api/admin/tenants/:id/features/:key — Remove per-tenant override ──
router.delete('/tenants/:id/features/:key', asyncHandler(async (req, res) => {
  const tenantId = await resolveTenantParam(req.params.id);
  if (!tenantId) return res.status(400).json({ error: 'Invalid tenant ID' });

  const { key } = req.params;

  const result = await db.prepare(
    'DELETE FROM tenant_feature_overrides WHERE tenant_id = $1 AND feature_key = $2'
  ).run(tenantId, key);

  bustFeatureCache(tenantId);

  await logAudit(req, 'features.remove_override', 'feature', key, { tenantId });
  res.json({ ok: true, feature: key, removed: result.changes > 0 });
}));

module.exports = router;
