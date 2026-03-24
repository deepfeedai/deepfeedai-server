/**
 * Deep Feed AI — /api/tenants
 * Tenant signup and management for multi-tenancy onboarding.
 */
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const requireUser = require('../middleware/user-jwt');
const { getJwtSecret } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const { invalidateSlugCache, invalidateDomainCache } = require('../middleware/tenant');
const { getSecrets } = require('../lib/secrets');
const { getPlatformTenantId, isPlatformTenant } = require('../lib/platform-tenant');

// Middleware that accepts either a public user JWT or an admin JWT.
// Needed for /mine and /switch which are called from the admin panel
// (admin JWT) and during signup/login flows (public user JWT).
async function requireAnyAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = auth.slice(7);
  const secrets = await getSecrets();

  // Try admin JWT first (most common path from admin panel)
  for (const secret of [secrets.jwtSecret, secrets.jwtSecretPrevious, secrets.userJwtSecret]) {
    if (!secret) continue;
    try {
      req.user = jwt.verify(token, secret);
      return next();
    } catch (_) { /* try next */ }
  }
  return res.status(401).json({ error: 'Invalid token' });
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'mail', 'ftp', 'staging', 'dev',
  'test', 'portal', 'portal-staging', 'platform', 'platform-staging',
  'status', 'help', 'support', 'blog',
]);

// GET /api/tenants/mine — list tenants the current user is an admin of
router.get('/mine', requireAnyAuth, asyncHandler(async (req, res) => {
  const tenants = await db.prepare(`
    SELECT ta.tenant_id, ta.role, t.slug, t.display_name, t.status, t.plan
    FROM tenant_admins ta
    JOIN tenants t ON t.id = ta.tenant_id
    WHERE ta.user_id = $1 AND t.status = 'active'
    ORDER BY ta.created_at ASC
  `).all(req.user.sub);

  res.json({ tenants });
}));

// POST /api/tenants/switch — switch to a different tenant
router.post('/switch', requireAnyAuth, asyncHandler(async (req, res) => {
  const { tenantId } = req.body || {};

  if (!tenantId || typeof tenantId !== 'number') {
    return res.status(400).json({ error: 'tenantId is required and must be a number' });
  }

  // Verify user is an admin of the requested tenant
  const admin = await db.prepare(`
    SELECT ta.role, t.id, t.slug, t.display_name, t.plan, t.uuid
    FROM tenant_admins ta
    JOIN tenants t ON t.id = ta.tenant_id
    WHERE ta.user_id = $1 AND ta.tenant_id = $2 AND t.status = 'active'
  `).get(req.user.sub, tenantId);

  if (!admin) {
    return res.status(403).json({ error: 'You do not have access to this tenant' });
  }

  // Determine token type: platform-admin for users table owners on platform tenant
  const platformId = await getPlatformTenantId();
  const platformUser = await db.prepare(
    'SELECT id, role FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(req.user.email || '', platformId);
  const isPlatformAdmin = platformUser && platformUser.role === 'owner';

  // Look up role permissions
  let switchPermissions = ['*'];
  if (!isPlatformAdmin) {
    try {
      const roleRow = await db.prepare('SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2').get(admin.id, admin.role);
      if (roleRow) {
        switchPermissions = typeof roleRow.permissions === 'string' ? JSON.parse(roleRow.permissions) : roleRow.permissions;
      } else {
        switchPermissions = [];
      }
    } catch { switchPermissions = []; }
  }

  // Get full user info from public_users
  const user = await db.prepare('SELECT email, display_name FROM public_users WHERE id = $1').get(req.user.sub);

  const token = jwt.sign(
    {
      sub: req.user.sub,
      email: user?.email || req.user.email,
      displayName: user?.display_name || req.user.displayName,
      avatarUrl: req.user.avatarUrl,
      tenantId: admin.uuid,
      tenantSlug: admin.slug,
      role: admin.role,
      type: isPlatformAdmin ? 'platform-admin' : 'tenant-admin',
      permissions: switchPermissions,
    },
    await getJwtSecret(),
    { expiresIn: '24h' }
  );

  logAudit(req, 'tenant.switch', 'tenants', admin.id, { slug: admin.slug });

  res.json({
    token,
    tenant: { uuid: admin.uuid, slug: admin.slug, displayName: admin.display_name, plan: admin.plan },
  });
}));

// POST /api/tenants — create a new tenant (requires public user JWT)
router.post('/', requireUser, asyncHandler(async (req, res) => {
  const { slug, display_name } = req.body || {};

  if (!slug || typeof slug !== 'string') {
    return res.status(400).json({ error: 'slug is required' });
  }
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

  // Check if slug is taken
  const existing = await db.prepare('SELECT id FROM tenants WHERE slug = $1').get(cleanSlug);
  if (existing) {
    return res.status(409).json({ error: 'This subdomain is already taken' });
  }

  // Check tenant creation limit based on plan_limits
  const ownedCount = await db.prepare(
    'SELECT COUNT(*) AS cnt FROM tenant_admins WHERE user_id = $1 AND role = $2'
  ).get(req.user.sub, 'owner');
  const owned = parseInt(ownedCount.cnt);

  // Find the user's highest plan by looking at tenants they own
  const highestPlan = await db.prepare(`
    SELECT pl.max_tenants, pl.plan FROM tenant_admins ta
    JOIN tenants t ON t.id = ta.tenant_id
    JOIN plan_limits pl ON pl.plan = t.plan
    WHERE ta.user_id = $1 AND ta.role = 'owner'
    ORDER BY pl.max_tenants DESC NULLS FIRST
    LIMIT 1
  `).get(req.user.sub);

  // Default limit for new users (no existing tenants): starter plan allows 1
  const maxTenants = highestPlan ? highestPlan.max_tenants : 1;

  // max_tenants NULL means unlimited (business plan)
  if (maxTenants !== null && owned >= maxTenants) {
    return res.status(409).json({
      error: `You already own ${owned} site(s). Your plan allows ${maxTenants}. Upgrade to create more.`,
    });
  }

  // Create tenant
  const tenant = await db.prepare(
    'INSERT INTO tenants (slug, display_name, owner_user_id) VALUES ($1, $2, $3) RETURNING *'
  ).get(cleanSlug, display_name.trim(), req.user.sub);

  // Create tenant_admin entry
  await db.prepare(
    'INSERT INTO tenant_admins (tenant_id, user_id, email, role) VALUES ($1, $2, $3, $4)'
  ).run(tenant.id, req.user.sub, req.user.email, 'owner');

  // Seed default categories for the new tenant
  const DEFAULT_CATEGORIES = [
    { name: 'LLMs',          color: '#7c3aed' },
    { name: 'Image AI',      color: '#0ea5e9' },
    { name: 'Research',      color: '#22d3ee' },
    { name: 'Tools',         color: '#34d399' },
    { name: 'Business',      color: '#f59e0b' },
    { name: 'Policy',        color: '#f97316' },
    { name: 'CyberSecurity', color: '#ef4444' },
    { name: 'Industry',      color: '#94a3b8' },
  ];
  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    const c = DEFAULT_CATEGORIES[i];
    try {
      await db.prepare(
        'INSERT INTO categories (name, color, sort_order, tenant_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING'
      ).run(c.name, c.color, i, tenant.id);
    } catch { /* skip */ }
  }

  // Seed default settings for the new tenant
  const DEFAULT_SETTINGS = [
    ['site_name', display_name.trim()],
    ['ai_daily_budget', '5.00'],
    ['ai_monthly_budget', '50.00'],
  ];
  for (const [key, value] of DEFAULT_SETTINGS) {
    try {
      await db.prepare(
        'INSERT INTO settings (key, value, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING'
      ).run(key, value, tenant.id);
    } catch { /* skip */ }
  }

  // Issue a tenant-admin JWT (same secret as admin, but with tenantId claim)
  const token = jwt.sign(
    {
      sub: req.user.sub,
      email: req.user.email,
      displayName: req.user.displayName,
      avatarUrl: req.user.avatarUrl,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      role: 'owner',
      type: 'tenant-admin',
      permissions: ['*'],
    },
    await getJwtSecret(),
    { expiresIn: '24h' }
  );

  logAudit(req, 'tenant.create', 'tenants', tenant.id, { slug: cleanSlug });

  res.status(201).json({ tenant, token });
}));

// POST /api/tenants/login — exchange a public user JWT for a tenant-admin JWT
// Called after OAuth when any user logs into the admin panel.
// Resolution order:
//   1. Existing tenant_admins record → issue tenant JWT
//   2. Email in ADMIN_EMAILS → auto-provision as admin of tenant_id=1 (original site)
//   3. Neither → 404 with signup hint
router.post('/login', requireUser, asyncHandler(async (req, res) => {
  // 1. Check tenant_admins table
  const platformId = await getPlatformTenantId();

  let admin = await db.prepare(`
    SELECT ta.tenant_id, ta.role, t.slug, t.display_name, t.status, t.uuid
    FROM tenant_admins ta
    JOIN tenants t ON t.id = ta.tenant_id
    WHERE ta.user_id = $1 AND t.status = 'active'
    ORDER BY ta.created_at ASC
    LIMIT 1
  `).get(req.user.sub);

  // 2. If not a tenant admin, check if they're a platform super-admin (users table)
  if (!admin) {
    const userEmail = (req.user.email || '').toLowerCase();
    const adminUser = await db.prepare(
      'SELECT id, role FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
    ).get(userEmail, platformId);

    if (userEmail && adminUser && adminUser.role === 'owner') {
      // Auto-provision as admin of the platform tenant
      const existing = await db.prepare(
        'SELECT id FROM tenant_admins WHERE tenant_id = $1 AND user_id = $2'
      ).get(platformId, req.user.sub);

      if (!existing) {
        await db.prepare(
          'INSERT INTO tenant_admins (tenant_id, user_id, email, role) VALUES ($1, $2, $3, $4)'
        ).run(platformId, req.user.sub, userEmail, 'owner');
      }

      admin = await db.prepare(`
        SELECT ta.tenant_id, ta.role, t.slug, t.display_name, t.status, t.uuid
        FROM tenant_admins ta
        JOIN tenants t ON t.id = ta.tenant_id
        WHERE ta.user_id = $1 AND ta.tenant_id = $2
      `).get(req.user.sub, platformId);
    }
  }

  if (!admin) {
    return res.status(404).json({ error: 'No site found for this account', signup: true });
  }

  // Determine JWT type: users table owners on platform tenant get platform-admin
  const loginPlatformUser = await db.prepare(
    'SELECT id, role FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(req.user.email || '', platformId);
  const isPlatformAdminLogin = admin.tenant_id === platformId && loginPlatformUser && loginPlatformUser.role === 'owner';

  // Look up role permissions
  let permissions = ['*'];
  if (!isPlatformAdminLogin) {
    try {
      const roleRow = await db.prepare('SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2').get(admin.tenant_id, admin.role);
      if (roleRow) {
        permissions = typeof roleRow.permissions === 'string' ? JSON.parse(roleRow.permissions) : roleRow.permissions;
      } else {
        permissions = [];
      }
    } catch { permissions = []; }
  }

  const token = jwt.sign(
    {
      sub: req.user.sub,
      email: req.user.email,
      displayName: req.user.displayName,
      avatarUrl: req.user.avatarUrl,
      tenantId: admin.uuid,
      tenantSlug: admin.slug,
      role: admin.role,
      type: isPlatformAdminLogin ? 'platform-admin' : 'tenant-admin',
      permissions,
    },
    await getJwtSecret(),
    { expiresIn: '24h' }
  );

  res.json({
    token,
    tenant: { uuid: admin.uuid, slug: admin.slug, display_name: admin.display_name },
  });
}));

// POST /api/tenants/cancel — owner cancels their own tenant
router.post('/cancel', requireUser, asyncHandler(async (req, res) => {
  const { tenantId } = req.body || {};
  if (!tenantId || typeof tenantId !== 'number') {
    return res.status(400).json({ error: 'tenantId is required and must be a number' });
  }
  if (await isPlatformTenant(tenantId)) {
    return res.status(400).json({ error: 'Cannot cancel the primary site' });
  }

  // Verify user is owner of the tenant
  const admin = await db.prepare(`
    SELECT ta.role, t.id, t.slug, t.status
    FROM tenant_admins ta
    JOIN tenants t ON t.id = ta.tenant_id
    WHERE ta.user_id = $1 AND ta.tenant_id = $2
  `).get(req.user.sub, tenantId);

  if (!admin) return res.status(404).json({ error: 'Tenant not found' });
  if (admin.role !== 'owner') return res.status(403).json({ error: 'Only the owner can cancel a tenant' });
  if (admin.status !== 'active') return res.status(409).json({ error: `Tenant is already ${admin.status}` });

  const tenantRow = await db.prepare("SELECT custom_domain FROM tenants WHERE id = $1").get(tenantId);
  await db.prepare("UPDATE tenants SET status = 'cancelled' WHERE id = $1").run(tenantId);

  // Invalidate caches so the tenant is immediately unreachable
  invalidateSlugCache(admin.slug);
  if (tenantRow?.custom_domain) invalidateDomainCache(tenantRow.custom_domain);

  logAudit(req, 'tenant.cancel', 'tenants', tenantId, { slug: admin.slug });
  res.json({ success: true, status: 'cancelled' });
}));

// GET /api/tenants/check-slug?slug= — check if slug is available (public)
router.get('/check-slug', asyncHandler(async (req, res) => {
  const slug = (req.query.slug || '').toLowerCase().trim();
  if (!slug || !SLUG_RE.test(slug)) {
    return res.json({ available: false, reason: 'Invalid format' });
  }
  if (RESERVED_SLUGS.has(slug)) {
    return res.json({ available: false, reason: 'Reserved' });
  }
  const existing = await db.prepare('SELECT id FROM tenants WHERE slug = $1').get(slug);
  res.json({ available: !existing });
}));

// GET /api/tenants/onboarding-status — onboarding checklist for current tenant
const { auth: authMiddleware } = require('../middleware/auth');

router.get('/onboarding-status', authMiddleware, asyncHandler(async (req, res) => {
  const tid = req.tenantId || 1;

  const [sources, writers, articles, aiKey, domain] = await Promise.all([
    db.prepare("SELECT COUNT(*)::int AS cnt FROM sources WHERE tenant_id = $1").get(tid),
    db.prepare("SELECT COUNT(*)::int AS cnt FROM writers WHERE tenant_id = $1").get(tid),
    db.prepare("SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id = $1 AND is_published = 1").get(tid),
    db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'openai_api_key'").get(tid),
    db.prepare("SELECT custom_domain FROM tenants WHERE id = $1").get(tid),
  ]);

  const steps = [
    { key: 'add_source', label: 'Add your first RSS source', done: parseInt(sources.cnt) > 0 },
    { key: 'add_writer', label: 'Create a writer persona', done: parseInt(writers.cnt) > 0 },
    { key: 'configure_ai', label: 'Set up an AI API key', done: !!(aiKey?.value) },
    { key: 'publish_article', label: 'Publish your first article', done: parseInt(articles.cnt) > 0 },
    { key: 'custom_domain', label: 'Set up a custom domain', done: !!domain?.custom_domain, optional: true },
  ];

  const required = steps.filter(s => !s.optional);
  const doneCount = required.filter(s => s.done).length;
  const completionPct = required.length > 0 ? Math.round((doneCount / required.length) * 100) : 100;

  res.json({ steps, completionPct });
}));

module.exports = router;
