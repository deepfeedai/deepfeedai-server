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
const { bustFeatureCache } = require('../lib/feature-registry');
const { getPlatformTenantId } = require('../lib/platform-tenant');
const { getMonthlyCredits } = require('../lib/ai-usage');
const { getBonusCredits } = require('../lib/promo');
const { getPurchasedCreditsBalance } = require('../lib/credits');
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
  ['autopilot_enabled', '1'],
];

// GET /plan-limits — return all plan limit definitions
// NOTE: Must stay above GET /:id to avoid being matched as a tenant ID.
router.get('/plan-limits', asyncHandler(async (req, res) => {
  const limits = await db.prepare(
    `SELECT plan, max_sources, max_writers, max_ai_cost_month,
            max_credits_month, max_credits_day, max_storage_mb,
            audio_enabled, custom_domain_enabled, COALESCE(seo_titles_enabled, false) AS seo_titles_enabled,
            stripe_price_id, COALESCE(price_cents, 0) AS price_cents
     FROM plan_limits
     ORDER BY CASE plan WHEN 'free' THEN 1 WHEN 'starter' THEN 2 WHEN 'pro' THEN 3 WHEN 'business' THEN 4 WHEN 'internal' THEN 5 ELSE 99 END`
  ).all();
  res.json({ limits });
}));

// PUT /plan-limits — update credit allocations and Stripe pricing per plan
router.put('/plan-limits', asyncHandler(async (req, res) => {
  const { plan, max_credits_month, max_credits_day, stripe_price_id, price_cents } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'plan is required' });

  const updates = [];
  const params = [];
  let paramIdx = 1;

  if (max_credits_month !== undefined) {
    updates.push(`max_credits_month = $${paramIdx++}`);
    params.push(parseInt(max_credits_month));
  }
  if (max_credits_day !== undefined) {
    updates.push(`max_credits_day = $${paramIdx++}`);
    params.push(parseInt(max_credits_day));
  }
  if (stripe_price_id !== undefined) {
    updates.push(`stripe_price_id = $${paramIdx++}`);
    params.push(stripe_price_id || null);
  }
  if (price_cents !== undefined) {
    updates.push(`price_cents = $${paramIdx++}`);
    params.push(parseInt(price_cents) || 0);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(plan);
  await db.prepare(`UPDATE plan_limits SET ${updates.join(', ')} WHERE plan = $${paramIdx}`).run(...params);
  bustPlanCache();
  bustFeatureCache(); // feature cache depends on plan values
  res.json({ success: true });
}));

// ── Promo Code CRUD (platform admin) ─────────────────────────────
router.get('/promo-codes', asyncHandler(async (req, res) => {
  const codes = await db.prepare(
    'SELECT * FROM promo_codes ORDER BY created_at DESC'
  ).all();
  res.json({ codes });
}));

router.post('/promo-codes', asyncHandler(async (req, res) => {
  const { code, description, type, value, max_redemptions, expires_at } = req.body || {};
  if (!code || !value) return res.status(400).json({ error: 'code and value are required' });

  const validTypes = ['flat', 'percentage', 'multiplier'];
  const promoType = validTypes.includes(type) ? type : 'flat';

  const row = await db.prepare(`
    INSERT INTO promo_codes (code, description, type, value, max_redemptions, expires_at, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `).get(
    code.trim().toUpperCase(),
    description || null,
    promoType,
    parseFloat(value),
    max_redemptions ? parseInt(max_redemptions) : null,
    expires_at || null,
    req.user?.sub || null,
  );
  res.status(201).json(row);
}));

router.put('/promo-codes/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { description, is_active, max_redemptions, expires_at } = req.body || {};

  const updates = [];
  const params = [];
  let idx = 1;

  if (description !== undefined) { updates.push(`description = $${idx++}`); params.push(description); }
  if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); params.push(!!is_active); }
  if (max_redemptions !== undefined) { updates.push(`max_redemptions = $${idx++}`); params.push(max_redemptions ? parseInt(max_redemptions) : null); }
  if (expires_at !== undefined) { updates.push(`expires_at = $${idx++}`); params.push(expires_at || null); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(parseInt(id));
  await db.prepare(`UPDATE promo_codes SET ${updates.join(', ')} WHERE id = $${idx}`).run(...params);
  res.json({ success: true });
}));

router.delete('/promo-codes/:id', asyncHandler(async (req, res) => {
  await db.prepare('UPDATE promo_codes SET is_active = false WHERE id = $1').run(parseInt(req.params.id));
  res.json({ success: true });
}));

router.get('/promo-codes/:id/redemptions', asyncHandler(async (req, res) => {
  const redemptions = await db.prepare(`
    SELECT pr.id, pr.tenant_id, pr.bonus_credits, pr.redeemed_at, pr.expires_at,
           t.slug AS tenant_slug, t.display_name AS tenant_name
    FROM promo_redemptions pr
    JOIN tenants t ON t.id = pr.tenant_id
    WHERE pr.promo_code_id = $1
    ORDER BY pr.redeemed_at DESC
  `).all(parseInt(req.params.id));
  res.json({ redemptions });
}));

// ── Credit Pack CRUD (platform admin) ─────────────────────────────
router.get('/credit-packs', asyncHandler(async (req, res) => {
  const packs = await db.prepare('SELECT * FROM credit_packs ORDER BY sort_order, id').all();
  res.json({ packs });
}));

router.post('/credit-packs', asyncHandler(async (req, res) => {
  const { name, credits, price_cents, sort_order } = req.body || {};
  if (!name || !credits || !price_cents) {
    return res.status(400).json({ error: 'name, credits, and price_cents are required' });
  }
  const row = await db.prepare(`
    INSERT INTO credit_packs (name, credits, price_cents, sort_order) VALUES ($1, $2, $3, $4) RETURNING *
  `).get(name, parseInt(credits), parseInt(price_cents), parseInt(sort_order) || 0);
  res.status(201).json(row);
}));

router.put('/credit-packs/:id', asyncHandler(async (req, res) => {
  const { name, credits, price_cents, is_active, sort_order } = req.body || {};
  const updates = [];
  const params = [];
  let idx = 1;

  if (name !== undefined) { updates.push(`name = $${idx++}`); params.push(name); }
  if (credits !== undefined) { updates.push(`credits = $${idx++}`); params.push(parseInt(credits)); }
  if (price_cents !== undefined) { updates.push(`price_cents = $${idx++}`); params.push(parseInt(price_cents)); }
  if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); params.push(!!is_active); }
  if (sort_order !== undefined) { updates.push(`sort_order = $${idx++}`); params.push(parseInt(sort_order)); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(parseInt(req.params.id));
  await db.prepare(`UPDATE credit_packs SET ${updates.join(', ')} WHERE id = $${idx}`).run(...params);
  res.json({ success: true });
}));

router.delete('/credit-packs/:id', asyncHandler(async (req, res) => {
  await db.prepare('UPDATE credit_packs SET is_active = false WHERE id = $1').run(parseInt(req.params.id));
  res.json({ success: true });
}));

// POST /:id/grant-credits — manually grant credits to a tenant (no Stripe)
router.post('/:id/grant-credits', asyncHandler(async (req, res) => {
  const tenantId = await resolveTenantParam(req.params.id);
  if (!tenantId) return res.status(404).json({ error: 'Tenant not found' });

  const { credits, reason } = req.body || {};
  if (!credits || parseInt(credits) <= 0) {
    return res.status(400).json({ error: 'credits must be a positive integer' });
  }

  await db.prepare(`
    INSERT INTO credit_purchases (tenant_id, credits, amount_cents, status, purchased_by, completed_at)
    VALUES ($1, $2, 0, 'completed', $3, NOW())
  `).run(tenantId, parseInt(credits), req.user?.sub || null);

  logAudit(req, 'grant_credits', 'tenant', tenantId, { credits: parseInt(credits), reason });
  res.json({ success: true, credits: parseInt(credits) });
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
  const validPlans = ['free', 'starter', 'pro', 'business', 'internal'];
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
  const tenantBaseDomain = process.env.TENANT_BASE_DOMAIN || 'deepfeedai.com';
  const tenantDomain = `${cleanSlug}.${tenantBaseDomain}`;
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

// ── Public Users Management ──────────────────────────────────────

// GET /public-users — list public users with search/filter/pagination
router.get('/public-users', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  const provider = (req.query.provider || '').trim();
  const banned = req.query.banned;

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (search) {
    conditions.push(`(LOWER(pu.email) LIKE $${paramIdx} OR LOWER(pu.display_name) LIKE $${paramIdx})`);
    params.push(`%${search.toLowerCase()}%`);
    paramIdx++;
  }
  if (provider) {
    conditions.push(`pu.provider = $${paramIdx}`);
    params.push(provider);
    paramIdx++;
  }
  if (banned === '1' || banned === '0') {
    conditions.push(`pu.is_banned = $${paramIdx}`);
    params.push(parseInt(banned));
    paramIdx++;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const countRow = await db.prepare(
    `SELECT COUNT(DISTINCT pu.id)::int AS total FROM public_users pu ${where}`
  ).get(...params);
  const total = countRow.total;

  const users = await db.prepare(`
    SELECT pu.id, pu.provider, pu.email, pu.display_name, pu.avatar_url,
           pu.is_banned, pu.email_verified, pu.created_at,
           COUNT(ta.id)::int AS tenant_count
    FROM public_users pu
    LEFT JOIN tenant_admins ta ON ta.user_id = pu.id
    ${where}
    GROUP BY pu.id
    ORDER BY pu.created_at DESC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
  `).all(...params, limit, offset);

  res.json({
    users,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}));

// GET /public-users/:id — single user detail
router.get('/public-users/:id', asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  if (!userId || userId < 1) return res.status(400).json({ error: 'Invalid user ID' });

  const user = await db.prepare('SELECT * FROM public_users WHERE id = $1').get(userId);
  if (!user) return res.status(404).json({ error: 'Public user not found' });

  delete user.password_hash;
  delete user.notify_token;

  const tenants = await db.prepare(`
    SELECT ta.role, t.id, t.uuid, t.slug, t.display_name, t.status, t.plan
    FROM tenant_admins ta
    JOIN tenants t ON t.id = ta.tenant_id
    WHERE ta.user_id = $1
    ORDER BY ta.created_at ASC
  `).all(userId);

  const recentComments = await db.prepare(`
    SELECT c.id, c.body, c.created_at, c.is_deleted, c.tenant_id,
           a.slug AS article_slug, a.title AS article_title
    FROM comments c
    LEFT JOIN articles a ON a.id = c.article_id
    WHERE c.user_id = $1
    ORDER BY c.created_at DESC
    LIMIT 10
  `).all(userId);

  res.json({ user, tenants, recentComments });
}));

// PUT /public-users/:id/ban — toggle ban status
router.put('/public-users/:id/ban', asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  if (!userId || userId < 1) return res.status(400).json({ error: 'Invalid user ID' });

  const user = await db.prepare('SELECT id, email, is_banned FROM public_users WHERE id = $1').get(userId);
  if (!user) return res.status(404).json({ error: 'Public user not found' });

  const newBanned = user.is_banned ? 0 : 1;
  await db.prepare('UPDATE public_users SET is_banned = $1, updated_at = NOW() WHERE id = $2').run(newBanned, userId);

  await logAudit(req, newBanned ? 'public_user.ban' : 'public_user.unban', 'public_users', userId, { email: user.email });
  res.json({ success: true, is_banned: newBanned });
}));

// DELETE /public-users/:id — permanently delete a public_users record
router.delete('/public-users/:id', asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  if (!userId || userId < 1) return res.status(400).json({ error: 'Invalid user ID' });

  const user = await db.prepare('SELECT id, email, display_name, provider FROM public_users WHERE id = $1').get(userId);
  if (!user) return res.status(404).json({ error: 'Public user not found' });

  const ownedTenants = await db.prepare(`
    SELECT t.id, t.slug FROM tenant_admins ta
    JOIN tenants t ON t.id = ta.tenant_id
    WHERE ta.user_id = $1 AND ta.role = 'owner' AND t.status = 'active'
  `).all(userId);

  if (ownedTenants.length > 0) {
    return res.status(409).json({
      error: `User owns ${ownedTenants.length} active tenant(s). Cancel or transfer ownership first.`,
      tenants: ownedTenants.map(t => t.slug),
    });
  }

  await db.prepare("UPDATE comments SET body = '[deleted]', is_deleted = 1 WHERE user_id = $1").run(userId);
  await db.prepare('DELETE FROM public_users WHERE id = $1').run(userId);

  await logAudit(req, 'public_user.delete', 'public_users', userId, { email: user.email, provider: user.provider });
  res.json({ success: true, message: `Deleted public user ${user.email || user.display_name}` });
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

  const [resources, adminCount, lastCron, monthAiSpend, autopilotRow] = await Promise.all([
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
    db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'autopilot_enabled'").get(id).catch(() => null),
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
    autopilotEnabled: autopilotRow?.value !== '0',
  });
}));

// GET /:id/usage — monthly usage breakdown
router.get('/:id/usage', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const exists = await db.prepare("SELECT id FROM tenants WHERE id = $1").get(id);
  if (!exists) return res.status(404).json({ error: 'Tenant not found' });

  const [articles, aiUsage, cronRuns, storageSize, creditsUsed, bonus, purchased] = await Promise.all([
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
    getMonthlyCredits(id),
    getBonusCredits(id),
    getPurchasedCreditsBalance(id),
  ]);

  res.json({
    articlesThisMonth: parseInt(articles.cnt),
    aiUsage: {
      totalCost: parseFloat(aiUsage.total_cost),
      totalCalls: parseInt(aiUsage.total_calls),
    },
    credits: {
      usedThisMonth: creditsUsed,
      bonusCredits: bonus,
      purchasedBalance: purchased,
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
    const validPlans = ['free', 'starter', 'pro', 'business', 'internal'];
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

  // Bust plan + feature cache if plan or trial changed
  if ((plan !== undefined && plan !== before.plan) || trial_days !== undefined || trial_ends_at !== undefined) {
    bustPlanCache(id);
    bustFeatureCache(id);
  }

  await logAuditWithDiff(req, 'tenant.update', 'tenants', id, before, tenant);
  res.json(tenant);
}));

// PUT /:id/autopilot — toggle tenant autopilot
router.put('/:id/autopilot', asyncHandler(async (req, res) => {
  const id = await resolveTenantParam(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid tenant ID' });

  const { enabled } = req.body;
  if (enabled === undefined) return res.status(400).json({ error: 'enabled is required' });

  const val = enabled ? '1' : '0';
  await db.prepare(
    "INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3"
  ).run(id, 'autopilot_enabled', val);

  await logAudit(req, 'tenant.autopilot', 'tenants', id, { enabled });

  res.json({ success: true, autopilotEnabled: enabled });
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
  bustFeatureCache(id);

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
    'comment_reports', 'comment_reactions', 'article_reactions', 'article_favorites',
    'writer_follows', 'writer_beats',
    'comments', 'articles', 'sources', 'writers', 'categories', 'voices',
    'settings', 'analytics_events', 'ai_usage', 'file_storage', 'saved_searches',
    'summary_cache', 'thumbnail_cache', 'trends_cache', 'trends_history',
    'synthesis_forecasts', 'synthesis_watchlist', 'tenant_domains',
    'tenant_storage_usage',
    'audit_log', 'cron_runs', 'notifications', 'newsletter_sends',
    'auth_codes',
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
