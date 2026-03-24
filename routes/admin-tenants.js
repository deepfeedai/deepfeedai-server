/**
 * Deep Feed AI — /api/admin/tenants
 * Platform admin tenant management endpoints.
 * All routes require platform-admin JWT.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePlatformAdmin } = require('../middleware/permissions');
const { logAudit, logAuditWithDiff } = require('../middleware/audit');
const { invalidateSlugCache, invalidateDomainCache } = require('../middleware/tenant');
const { bustPlanCache } = require('../lib/plan-limits');
const { getPlatformTenantId } = require('../lib/platform-tenant');
const storage = require('../lib/storage');
const dns = require('dns').promises;
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve a tenant route param (integer or UUID) to the internal integer ID.
 * Returns null if not found.
 */
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

/**
 * Resolve an email to a public_users id.
 * Checks public_users first, then local users table, then creates a placeholder.
 */
async function resolveOwnerByEmail(email) {
  const clean = email.trim().toLowerCase();

  // 1. Check public_users
  const pubUser = await db.prepare(
    "SELECT id, email FROM public_users WHERE LOWER(email) = LOWER($1)"
  ).get(clean);
  if (pubUser) return pubUser;

  // 2. Check local users table (platform tenant admins)
  const platformId = await getPlatformTenantId();
  const localUser = await db.prepare(
    "SELECT id, email FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1"
  ).get(clean, platformId);
  if (localUser) {
    // Check if they already have a public_users record by another email variant
    // If not, create one linked to their local account
    const placeholder = await db.prepare(
      "INSERT INTO public_users (provider, provider_id, email, display_name) VALUES ('local', $1, $2, $3) RETURNING id, email",
    ).get(`local-${localUser.id}`, clean, clean.split('@')[0]);
    return placeholder;
  }

  // 3. Create placeholder — will be linked when they sign in via OAuth
  const placeholder = await db.prepare(
    "INSERT INTO public_users (provider, provider_id, email, display_name) VALUES ('platform', $1, $2, $3) RETURNING id, email",
  ).get(`invite-${crypto.randomBytes(8).toString('hex')}`, clean, clean.split('@')[0]);
  return placeholder;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'mail', 'ftp', 'staging', 'dev',
  'test', 'portal', 'portal-staging', 'platform', 'platform-staging',
  'status', 'help', 'support', 'blog',
]);

const DEFAULT_CATEGORIES = [
  { name: 'LLMs', color: '#7c3aed' }, { name: 'Image AI', color: '#0ea5e9' },
  { name: 'Research', color: '#22d3ee' }, { name: 'Tools', color: '#34d399' },
  { name: 'Business', color: '#f59e0b' }, { name: 'Policy', color: '#f97316' },
  { name: 'CyberSecurity', color: '#ef4444' }, { name: 'Industry', color: '#94a3b8' },
];

const DEFAULT_SETTINGS = [
  ['ai_daily_budget', '5.00'],
  ['ai_monthly_budget', '50.00'],
];

// GET /plan-limits — return all plan limit definitions
// NOTE: Must stay above GET /:id to avoid being matched as a tenant ID.
router.get('/plan-limits', asyncHandler(async (req, res) => {
  const limits = await db.prepare(
    `SELECT plan, max_sources, max_writers, max_articles_month, max_ai_cost_month,
            max_storage_mb, audio_enabled, custom_domain_enabled
     FROM plan_limits
     ORDER BY CASE plan WHEN 'free' THEN 1 WHEN 'starter' THEN 2 WHEN 'pro' THEN 3 WHEN 'business' THEN 4 ELSE 99 END`
  ).all();
  res.json({ limits });
}));

// POST / — create a new tenant (platform admin)
router.post('/', asyncHandler(async (req, res) => {
  const { slug, display_name, plan, owner_email } = req.body || {};

  if (!slug || typeof slug !== 'string') return res.status(400).json({ error: 'slug is required' });
  if (!display_name || typeof display_name !== 'string' || !display_name.trim()) {
    return res.status(400).json({ error: 'display_name is required' });
  }

  const cleanSlug = slug.toLowerCase().trim();
  if (!SLUG_RE.test(cleanSlug)) {
    return res.status(400).json({ error: 'Slug must be 3-50 lowercase letters, numbers, and hyphens' });
  }
  if (RESERVED_SLUGS.has(cleanSlug)) {
    return res.status(409).json({ error: 'This subdomain is reserved' });
  }

  const existing = await db.prepare('SELECT id FROM tenants WHERE slug = $1').get(cleanSlug);
  if (existing) return res.status(409).json({ error: 'This subdomain is already taken' });

  // Resolve owner if email provided
  let ownerUserId = null;
  let resolvedOwnerEmail = null;
  if (owner_email) {
    const owner = await resolveOwnerByEmail(owner_email);
    ownerUserId = owner.id;
    resolvedOwnerEmail = owner.email;
  }

  // Validate plan
  const validPlans = ['free', 'starter', 'pro', 'business'];
  const tenantPlan = validPlans.includes(plan) ? plan : 'free';

  // Optional trial period
  const { trial_days } = req.body || {};
  const trialEndsAt = trial_days && parseInt(trial_days) > 0
    ? new Date(Date.now() + parseInt(trial_days) * 86400000).toISOString()
    : null;

  // Create tenant
  const tenant = await db.prepare(
    'INSERT INTO tenants (slug, display_name, owner_user_id, plan, trial_ends_at) VALUES ($1, $2, $3, $4, $5) RETURNING *'
  ).get(cleanSlug, display_name.trim(), ownerUserId, tenantPlan, trialEndsAt);

  // Create tenant_admin entry if owner resolved
  if (ownerUserId) {
    await db.prepare(
      'INSERT INTO tenant_admins (tenant_id, user_id, email, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING'
    ).run(tenant.id, ownerUserId, resolvedOwnerEmail, 'owner');
  }

  // Seed default categories
  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    const c = DEFAULT_CATEGORIES[i];
    try {
      await db.prepare(
        'INSERT INTO categories (name, color, sort_order, tenant_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING'
      ).run(c.name, c.color, i, tenant.id);
    } catch { /* skip */ }
  }

  // Seed default settings (derive URLs from slug + environment)
  const tenantDomain = `${cleanSlug}.deepfeedai.com`;
  const tenantSiteUrl = `https://${tenantDomain}`;
  const adminServerUrl = process.env.BASE_URL || 'https://portal.deepfeedai.com';
  const allSettings = [
    ['site_name', display_name.trim()],
    ['site_domain', tenantDomain],
    ['site_url', tenantSiteUrl],
    ['base_url', adminServerUrl],
    ['main_site_url', tenantSiteUrl],
    ...DEFAULT_SETTINGS,
  ];
  for (const [key, value] of allSettings) {
    try {
      await db.prepare(
        'INSERT INTO settings (key, value, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING'
      ).run(key, value, tenant.id);
    } catch { /* skip */ }
  }

  // Seed default roles
  const defaultRoles = [
    ['owner', 'Full access', '["*"]', true],
    ['admin', 'Full administrative access', '["*"]', true],
    ['editor', 'Content management', '["articles.read","articles.create","articles.update","sources.read","sources.create","sources.update","writers.read","categories.read","media.create","media.read","comments.read","comments.moderate","analytics.read","fetch.execute","newsletter.read"]', true],
    ['viewer', 'Read-only access', '["articles.read","sources.read","writers.read","categories.read","analytics.read","comments.read","audit.read","newsletter.read","media.read"]', true],
  ];
  for (const [name, desc, perms, isSystem] of defaultRoles) {
    try {
      await db.prepare(
        'INSERT INTO roles (tenant_id, name, description, permissions, is_system) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT DO NOTHING'
      ).run(tenant.id, name, desc, perms, isSystem);
    } catch { /* skip */ }
  }

  await logAudit(req, 'tenant.create', 'tenants', tenant.id, {
    slug: cleanSlug, plan: tenantPlan, owner_email: owner_email || null,
  });

  res.status(201).json(tenant);
}));

// GET / — list tenants with search, filter, pagination
router.get('/', asyncHandler(async (req, res) => {
  const {
    search,
    status,
    plan,
    sort = 'created_at',
    order = 'desc',
    page = '1',
    limit = '25',
  } = req.query;

  const allowedSorts = ['created_at', 'display_name', 'slug', 'plan', 'status'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
  const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 25));
  const offset = (pageNum - 1) * pageSize;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (search) {
    conditions.push(`(t.slug ILIKE $${idx} OR t.display_name ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }
  if (status) {
    conditions.push(`t.status = $${idx}`);
    params.push(status);
    idx++;
  } else {
    // Exclude deleted tenants by default — use ?status=deleted to see them
    conditions.push(`t.status != 'deleted'`);
  }
  if (plan) {
    conditions.push(`t.plan = $${idx}`);
    params.push(plan);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM tenants t ${where}`
  ).get(...params);
  const total = parseInt(countRow.cnt);

  const tenants = await db.prepare(`
    SELECT t.id, t.uuid, t.slug, t.display_name, t.plan, t.status, t.custom_domain,
           t.created_at, t.suspended_at, t.suspension_reason, t.deleted_at,
           t.is_platform, pu.email AS owner_email, pu.display_name AS owner_name
    FROM tenants t
    LEFT JOIN public_users pu ON pu.id = t.owner_user_id
    ${where}
    ORDER BY t.${sortCol} ${sortOrder}
    LIMIT $${idx} OFFSET $${idx + 1}
  `).all(...params, pageSize, offset);

  res.json({
    tenants,
    pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
  });
}));

// GET /stats — platform overview
router.get('/stats', asyncHandler(async (req, res) => {
  const [byStatus, byPlan, articleCount, aiSpend, recentSignups, topTenants] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) AS cnt FROM tenants WHERE status != 'deleted' GROUP BY status").all(),
    db.prepare("SELECT plan, COUNT(*) AS cnt FROM tenants WHERE status = 'active' GROUP BY plan").all(),
    db.prepare("SELECT COUNT(*) AS cnt FROM articles a JOIN tenants t ON t.id = a.tenant_id WHERE t.status != 'deleted'").get(),
    db.prepare(`
      SELECT COALESCE(SUM(u.estimated_cost), 0) AS total
      FROM ai_usage u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE t.status != 'deleted' AND u.created_at >= date_trunc('month', NOW())
    `).get(),
    db.prepare(`
      SELECT t.id, t.uuid, t.slug, t.display_name, t.plan, t.created_at,
             pu.email AS owner_email
      FROM tenants t
      LEFT JOIN public_users pu ON pu.id = t.owner_user_id
      WHERE t.status != 'deleted'
      ORDER BY t.created_at DESC LIMIT 10
    `).all(),
    db.prepare(`
      SELECT t.id, t.uuid, t.slug, t.display_name, t.plan,
             COUNT(a.id) AS article_count
      FROM tenants t
      LEFT JOIN articles a ON a.tenant_id = t.id
      WHERE t.status = 'active'
      GROUP BY t.id, t.uuid, t.slug, t.display_name, t.plan
      ORDER BY article_count DESC
      LIMIT 10
    `).all(),
  ]);

  res.json({
    byStatus: Object.fromEntries(byStatus.map(r => [r.status, parseInt(r.cnt)])),
    byPlan: Object.fromEntries(byPlan.map(r => [r.plan, parseInt(r.cnt)])),
    totalArticles: parseInt(articleCount.cnt),
    monthlyAiSpend: parseFloat(aiSpend.total),
    recentSignups,
    topTenants,
  });
}));

// GET /storage-usage — per-tenant storage usage for platform dashboard
router.get('/storage-usage', requirePlatformAdmin, asyncHandler(async (req, res) => {
  const usage = await db.prepare(`
    SELECT su.tenant_id, su.bytes_used, su.file_count, su.updated_at
    FROM tenant_storage_usage su
    ORDER BY su.bytes_used DESC
  `).all();
  res.json({ usage });
}));

// GET /:id — tenant detail
router.get('/:id', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const tenant = await db.prepare(`
    SELECT t.*, pu.email AS owner_email, pu.display_name AS owner_name
    FROM tenants t
    LEFT JOIN public_users pu ON pu.id = t.owner_user_id
    WHERE t.id = $1
  `).get(id);

  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const [resources, adminCount, lastCron, monthAiSpend] = await Promise.all([
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM articles WHERE tenant_id = $1) AS articles,
        (SELECT COUNT(*) FROM sources WHERE tenant_id = $1) AS sources,
        (SELECT COUNT(*) FROM writers WHERE tenant_id = $1) AS writers,
        (SELECT COUNT(*) FROM categories WHERE tenant_id = $1) AS categories
    `).get(id),
    db.prepare("SELECT COUNT(*) AS cnt FROM tenant_admins WHERE tenant_id = $1").get(id),
    db.prepare("SELECT job_name, status, finished_at FROM cron_runs WHERE tenant_id = $1 ORDER BY finished_at DESC LIMIT 1").get(id),
    db.prepare(`
      SELECT COALESCE(SUM(estimated_cost), 0) AS total
      FROM ai_usage WHERE tenant_id = $1 AND created_at >= date_trunc('month', NOW())
    `).get(id),
  ]);

  res.json({
    ...tenant,
    resources: {
      articles: parseInt(resources.articles),
      sources: parseInt(resources.sources),
      writers: parseInt(resources.writers),
      categories: parseInt(resources.categories),
    },
    adminCount: parseInt(adminCount.cnt),
    lastCron: lastCron || null,
    monthlyAiSpend: parseFloat(monthAiSpend.total),
  });
}));

// GET /:id/usage — monthly usage breakdown
router.get('/:id/usage', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const exists = await db.prepare("SELECT id FROM tenants WHERE id = $1").get(id);
  if (!exists) return res.status(404).json({ error: 'Tenant not found' });

  const [articles, aiUsage, cronRuns, storageSize] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) AS cnt FROM articles
      WHERE tenant_id = $1 AND created_at >= date_trunc('month', NOW())
    `).get(id),
    db.prepare(`
      SELECT COALESCE(SUM(estimated_cost), 0) AS total_cost,
             COUNT(*) AS total_calls
      FROM ai_usage
      WHERE tenant_id = $1 AND created_at >= date_trunc('month', NOW())
    `).get(id),
    db.prepare(`
      SELECT job_name, status, COUNT(*) AS cnt
      FROM cron_runs
      WHERE tenant_id = $1 AND started_at >= date_trunc('month', NOW())
      GROUP BY job_name, status
    `).all(id),
    db.prepare(`
      SELECT COALESCE(SUM(size), 0) AS total_bytes FROM file_storage WHERE tenant_id = $1
    `).get(id),
  ]);

  res.json({
    articlesThisMonth: parseInt(articles.cnt),
    aiUsage: {
      totalCost: parseFloat(aiUsage.total_cost),
      totalCalls: parseInt(aiUsage.total_calls),
    },
    cronRuns,
    storageSizeBytes: parseInt(storageSize.total_bytes),
  });
}));

// PUT /:id — update tenant
router.put('/:id', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const before = await db.prepare("SELECT * FROM tenants WHERE id = $1").get(id);
  if (!before) return res.status(404).json({ error: 'Tenant not found' });

  const { display_name, plan, custom_domain, owner_email, trial_days, trial_ends_at } = req.body || {};

  const updates = [];
  const params = [];
  let idx = 1;

  if (display_name !== undefined) {
    if (typeof display_name !== 'string' || !display_name.trim()) {
      return res.status(400).json({ error: 'display_name must be a non-empty string' });
    }
    updates.push(`display_name = $${idx++}`);
    params.push(display_name.trim());
  }
  if (plan !== undefined) {
    const validPlans = ['free', 'starter', 'pro', 'business'];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({ error: `plan must be one of: ${validPlans.join(', ')}` });
    }
    updates.push(`plan = $${idx++}`);
    params.push(plan);
  }
  // Trial: set via trial_days (convenience) or trial_ends_at (explicit date/null)
  if (trial_days !== undefined) {
    const days = parseInt(trial_days);
    updates.push(`trial_ends_at = $${idx++}`);
    params.push(days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null);
  } else if (trial_ends_at !== undefined) {
    updates.push(`trial_ends_at = $${idx++}`);
    params.push(trial_ends_at); // null to clear, ISO string to set
  }
  if (custom_domain !== undefined) {
    if (custom_domain !== null && typeof custom_domain !== 'string') {
      return res.status(400).json({ error: 'custom_domain must be a string or null' });
    }
    const oldDomain = before.custom_domain;
    updates.push(`custom_domain = $${idx++}`);
    params.push(custom_domain ? custom_domain.trim().toLowerCase() : null);
    if (oldDomain) invalidateDomainCache(oldDomain);
    if (custom_domain) invalidateDomainCache(custom_domain.trim().toLowerCase());
  }
  if (owner_email !== undefined) {
    if (owner_email === null || owner_email === '') {
      // Clear owner
      updates.push(`owner_user_id = $${idx++}`);
      params.push(null);
    } else {
      // Resolve email — checks public_users, local users, or creates placeholder
      const owner = await resolveOwnerByEmail(owner_email);
      updates.push(`owner_user_id = $${idx++}`);
      params.push(owner.id);

      // Upsert tenant_admins entry
      await db.prepare(
        "INSERT INTO tenant_admins (tenant_id, user_id, email, role) VALUES ($1, $2, $3, 'owner') ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner'"
      ).run(id, owner.id, owner.email);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  params.push(id);
  const tenant = await db.prepare(
    `UPDATE tenants SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`
  ).get(...params);

  // Bust plan cache if plan or trial changed
  if ((plan !== undefined && plan !== before.plan) || trial_days !== undefined || trial_ends_at !== undefined) {
    bustPlanCache(id);
  }

  await logAuditWithDiff(req, 'tenant.update', 'tenants', id, before, tenant);
  res.json(tenant);
}));

// POST /:id/suspend — suspend tenant
router.post('/:id/suspend', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });
  if (id === 1) return res.status(400).json({ error: 'Cannot suspend the primary tenant' });

  const tenant = await db.prepare("SELECT * FROM tenants WHERE id = $1").get(id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (tenant.status === 'suspended') return res.status(409).json({ error: 'Tenant is already suspended' });
  if (tenant.status !== 'active') return res.status(409).json({ error: `Cannot suspend tenant with status '${tenant.status}'` });

  const { reason } = req.body || {};

  const updated = await db.prepare(`
    UPDATE tenants SET status = 'suspended', suspended_at = NOW(), suspension_reason = $1
    WHERE id = $2 RETURNING *
  `).get(reason || null, id);

  // Invalidate caches so the tenant is immediately unreachable
  invalidateSlugCache(tenant.slug);
  if (tenant.custom_domain) invalidateDomainCache(tenant.custom_domain);

  await logAudit(req, 'tenant.suspend', 'tenants', id, { slug: tenant.slug, reason: reason || null });
  res.json(updated);
}));

// POST /:id/reactivate — reactivate suspended tenant
router.post('/:id/reactivate', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const tenant = await db.prepare("SELECT * FROM tenants WHERE id = $1").get(id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (tenant.status === 'active') return res.status(409).json({ error: 'Tenant is already active' });
  if (tenant.status !== 'suspended' && tenant.status !== 'cancelled') {
    return res.status(409).json({ error: `Cannot reactivate tenant with status '${tenant.status}'` });
  }

  const updated = await db.prepare(`
    UPDATE tenants SET status = 'active', suspended_at = NULL, suspension_reason = NULL
    WHERE id = $1 RETURNING *
  `).get(id);

  // Invalidate caches so the tenant is immediately reachable
  invalidateSlugCache(tenant.slug);
  if (tenant.custom_domain) invalidateDomainCache(tenant.custom_domain);

  await logAudit(req, 'tenant.reactivate', 'tenants', id, { slug: tenant.slug });
  res.json(updated);
}));

// DELETE /:id — soft delete tenant
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });
  if (id === 1) return res.status(400).json({ error: 'Cannot delete the primary tenant' });

  const tenant = await db.prepare("SELECT * FROM tenants WHERE id = $1").get(id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (tenant.status === 'deleted') return res.status(409).json({ error: 'Tenant is already deleted' });

  const updated = await db.prepare(`
    UPDATE tenants SET status = 'deleted', deleted_at = NOW()
    WHERE id = $1 RETURNING *
  `).get(id);

  // Invalidate caches
  invalidateSlugCache(tenant.slug);
  if (tenant.custom_domain) invalidateDomainCache(tenant.custom_domain);

  await logAudit(req, 'tenant.delete', 'tenants', id, { slug: tenant.slug });
  res.json(updated);
}));

// ── Custom Domain Management ─────────────────────────────────────

// POST /:id/domain — set custom domain, return DNS instructions
router.post('/:id/domain', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const tenant = await db.prepare("SELECT * FROM tenants WHERE id = $1").get(id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const { domain } = req.body || {};
  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: 'domain is required' });
  }

  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');

  // Validate domain format
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cleanDomain)) {
    return res.status(400).json({ error: 'Invalid domain format' });
  }

  // Check not already taken by another tenant
  const existing = await db.prepare(
    "SELECT tenant_id FROM tenant_domains WHERE domain = $1 AND tenant_id != $2"
  ).get(cleanDomain, id);
  if (existing) return res.status(409).json({ error: 'Domain is already registered to another tenant' });

  const existingTenant = await db.prepare(
    "SELECT id FROM tenants WHERE custom_domain = $1 AND id != $2"
  ).get(cleanDomain, id);
  if (existingTenant) return res.status(409).json({ error: 'Domain is already in use by another tenant' });

  // Generate verification token
  const token = `dfa-verify=${crypto.randomBytes(16).toString('hex')}`;

  // Upsert into tenant_domains
  await db.prepare(`
    INSERT INTO tenant_domains (tenant_id, domain, status, verification_token)
    VALUES ($1, $2, 'pending', $3)
    ON CONFLICT (domain) DO UPDATE SET
      status = 'pending', verification_token = $3, verified_at = NULL
  `).run(id, cleanDomain, token);

  await logAudit(req, 'tenant.domain.set', 'tenants', id, { domain: cleanDomain });

  res.json({
    domain: cleanDomain,
    status: 'pending',
    verification_token: token,
    instructions: {
      cname: { type: 'CNAME', name: cleanDomain, value: 'tenants.deepfeedai.com' },
      txt: { type: 'TXT', name: cleanDomain, value: token },
    },
  });
}));

// GET /:id/domain — get domain status
router.get('/:id/domain', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const domainRow = await db.prepare(
    "SELECT * FROM tenant_domains WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1"
  ).get(id);

  const tenant = await db.prepare("SELECT custom_domain FROM tenants WHERE id = $1").get(id);

  res.json({
    domain: domainRow || null,
    activeDomain: tenant?.custom_domain || null,
  });
}));

// POST /:id/domain/verify — check DNS records
router.post('/:id/domain/verify', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const domainRow = await db.prepare(
    "SELECT * FROM tenant_domains WHERE tenant_id = $1 AND status != 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(id);

  if (!domainRow) return res.status(404).json({ error: 'No pending domain found' });

  const domain = domainRow.domain;
  const checks = { cname: false, txt: false };
  const errors = [];

  // Check CNAME
  try {
    const cnames = await dns.resolveCname(domain);
    checks.cname = cnames.some(c => c.toLowerCase().includes('deepfeedai.com'));
    if (!checks.cname) errors.push(`CNAME points to ${cnames.join(', ')} — expected tenants.deepfeedai.com`);
  } catch (err) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      errors.push('No CNAME record found');
    } else {
      errors.push(`CNAME lookup failed: ${err.code || err.message}`);
    }
  }

  // Check TXT
  try {
    const txtRecords = await dns.resolveTxt(domain);
    const flat = txtRecords.map(r => r.join('')).join(' ');
    checks.txt = flat.includes(domainRow.verification_token);
    if (!checks.txt) errors.push('TXT verification token not found');
  } catch (err) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      errors.push('No TXT record found');
    } else {
      errors.push(`TXT lookup failed: ${err.code || err.message}`);
    }
  }

  const verified = checks.cname && checks.txt;

  if (verified) {
    // Mark domain as active
    await db.prepare(
      "UPDATE tenant_domains SET status = 'active', verified_at = NOW() WHERE id = $1"
    ).run(domainRow.id);

    // Set on tenants table and invalidate old cache
    const oldDomain = (await db.prepare("SELECT custom_domain FROM tenants WHERE id = $1").get(id))?.custom_domain;
    if (oldDomain) invalidateDomainCache(oldDomain);

    await db.prepare("UPDATE tenants SET custom_domain = $1 WHERE id = $2").run(domain, id);
    invalidateDomainCache(domain);

    await logAudit(req, 'tenant.domain.verified', 'tenants', id, { domain });
  }

  res.json({ verified, checks, errors });
}));

// DELETE /:id/domain — remove custom domain
router.delete('/:id/domain', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const tenant = await db.prepare("SELECT custom_domain FROM tenants WHERE id = $1").get(id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  // Remove from tenant_domains
  await db.prepare("DELETE FROM tenant_domains WHERE tenant_id = $1").run(id);

  // Clear from tenants table
  if (tenant.custom_domain) {
    invalidateDomainCache(tenant.custom_domain);
    await db.prepare("UPDATE tenants SET custom_domain = NULL WHERE id = $1").run(id);
  }

  await logAudit(req, 'tenant.domain.removed', 'tenants', id, { domain: tenant.custom_domain });
  res.json({ success: true });
}));

// POST /:id/purge — hard delete tenant and all data immediately
router.post('/:id/purge', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });
  if (id === 1) return res.status(400).json({ error: 'Cannot purge the primary tenant' });

  const tenant = await db.prepare("SELECT * FROM tenants WHERE id = $1").get(id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  // Require confirmation token in body to prevent accidental purges
  const { confirm } = req.body || {};
  if (confirm !== tenant.slug) {
    return res.status(400).json({ error: `Type the tenant slug "${tenant.slug}" to confirm purge` });
  }

  // Invalidate caches
  invalidateSlugCache(tenant.slug);
  if (tenant.custom_domain) invalidateDomainCache(tenant.custom_domain);
  bustPlanCache(id);

  // Clean up storage (R2 / local filesystem) before DB so credentials remain accessible
  let storageResult = { deleted: 0 };
  try {
    storageResult = await storage.removeAll(id);
    console.log(`[tenants] purge: cleaned up storage for tenant ${id} — ${storageResult.deleted} files`);
  } catch (err) {
    console.warn(`[tenants] purge: storage cleanup failed for tenant ${id}: ${err.message}`);
  }

  // Hard delete in dependency order
  const tables = [
    'comment_reactions', 'article_reactions', 'article_favorites',
    'comments', 'articles', 'sources', 'writers', 'categories', 'voices',
    'settings', 'analytics_events', 'ai_usage', 'file_storage', 'saved_searches',
    'summary_cache', 'thumbnail_cache', 'trends_cache', 'trends_history',
    'synthesis_forecasts', 'synthesis_watchlist', 'tenant_domains',
    'tenant_storage_usage',
    'audit_log', 'cron_runs', 'notifications', 'newsletter_sends',
    'roles', 'users',
    'tenant_admins',
  ];
  let totalRows = 0;
  for (const table of tables) {
    try {
      const result = await db.getPool().query(
        `DELETE FROM ${table} WHERE tenant_id = $1`, [id]
      );
      totalRows += result.rowCount || 0;
    } catch { /* table may not exist or lack tenant_id */ }
  }
  await db.prepare('DELETE FROM tenants WHERE id = $1').run(id);
  totalRows++;

  // Log to audit (on tenant 1 since the tenant is now gone)
  await logAudit(
    { ...req, tenantId: 1 },
    'tenant.purge', 'tenants', id,
    { slug: tenant.slug, rowsDeleted: totalRows, storageFilesDeleted: storageResult.deleted }
  );

  res.json({ success: true, slug: tenant.slug, rowsDeleted: totalRows, storageFilesDeleted: storageResult.deleted });
}));

module.exports = router;
