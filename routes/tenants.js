/**
 * Deep Feed AI — /api/tenants
 * Tenant signup and management for multi-tenancy onboarding.
 */
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const requireUser = require('../middleware/user-jwt');
const { getJwtSecret } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const { invalidateSlugCache, invalidateDomainCache } = require('../middleware/tenant');
const { getSecrets } = require('../lib/secrets');
const { getPlatformTenantId, isPlatformTenant } = require('../lib/platform-tenant');
const { getStripeConfig } = require('../lib/stripe-config');

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
        // No roles row — owners still get full access; others get empty
        switchPermissions = admin.role === 'owner' ? ['*'] : [];
      }
    } catch { switchPermissions = admin.role === 'owner' ? ['*'] : []; }
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
  if (process.env.SIGNUPS_ENABLED !== 'true') {
    return res.status(503).json({ error: 'signups_disabled', message: 'Signups are not currently open.' });
  }

  // Block unverified local users from creating tenants
  if (req.user.provider === 'local') {
    const pu = await db.prepare('SELECT email_verified FROM public_users WHERE id = $1').get(req.user.sub);
    if (!pu || !pu.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before creating a site' });
    }
  }

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

  // Check tenant creation limit based on plan_limits (only count active tenants)
  // Delete any stale pending_payment tenants for this user (abandoned checkouts)
  await db.prepare(`
    DELETE FROM tenants WHERE id IN (
      SELECT t.id FROM tenants t
      JOIN tenant_admins ta ON ta.tenant_id = t.id
      WHERE ta.user_id = $1 AND ta.role = 'owner'
        AND t.status = 'pending_payment'
        AND t.created_at < NOW() - INTERVAL '2 hours'
    )
  `).run(req.user.sub);

  const ownedCount = await db.prepare(`
    SELECT COUNT(*) AS cnt FROM tenant_admins ta
    JOIN tenants t ON t.id = ta.tenant_id
    WHERE ta.user_id = $1 AND ta.role = $2 AND t.status = 'active'
  `).get(req.user.sub, 'owner');
  const owned = parseInt(ownedCount.cnt);

  // Find the user's highest plan by looking at active tenants they own
  const highestPlan = await db.prepare(`
    SELECT pl.max_tenants, pl.plan FROM tenant_admins ta
    JOIN tenants t ON t.id = ta.tenant_id
    JOIN plan_limits pl ON pl.plan = t.plan
    WHERE ta.user_id = $1 AND ta.role = 'owner' AND t.status = 'active'
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

  // Validate plan selection (default to free for self-service)
  const VALID_PLANS = ['free', 'starter', 'pro', 'business'];
  const plan = VALID_PLANS.includes(req.body.plan) ? req.body.plan : 'free';

  // For paid plans, check if Stripe price is configured before creating
  const requiresPayment = plan !== 'free';
  if (requiresPayment) {
    const planRow = await db.prepare('SELECT stripe_price_id FROM plan_limits WHERE plan = $1').get(plan);
    if (!planRow?.stripe_price_id) {
      return res.status(400).json({ error: `The ${plan} plan is not yet available for purchase` });
    }
  }

  // Paid plans start as pending_payment until Stripe checkout completes
  const status = requiresPayment ? 'pending_payment' : 'active';

  // Create tenant
  const tenant = await db.prepare(
    'INSERT INTO tenants (slug, display_name, owner_user_id, plan, status) VALUES ($1, $2, $3, $4, $5) RETURNING *'
  ).get(cleanSlug, display_name.trim(), req.user.sub, plan, status);

  // Create local admin user for the tenant owner
  const ownerEmail = (req.user.email || '').toLowerCase();
  const ownerUsername = ownerEmail || req.user.displayName || 'owner';
  const unusableHash = '$2a$12$' + crypto.randomBytes(40).toString('base64').slice(0, 53);
  const localUser = await db.prepare(
    'INSERT INTO users (username, password_hash, email, display_name, role, tenant_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id'
  ).get(ownerUsername, unusableHash, ownerEmail || null, req.user.displayName || ownerUsername, 'owner', tenant.id);

  // Create tenant_admin entry (link to both public user and local user)
  await db.prepare(
    'INSERT INTO tenant_admins (tenant_id, user_id, email, role, local_user_id) VALUES ($1, $2, $3, $4, $5)'
  ).run(tenant.id, req.user.sub, req.user.email, 'owner', localUser?.id || null);

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
    ['deployment_mode', 'multi'],
  ];
  for (const [key, value] of DEFAULT_SETTINGS) {
    try {
      await db.prepare(
        'INSERT INTO settings (key, value, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING'
      ).run(key, value, tenant.id);
    } catch { /* skip */ }
  }

  // Seed default roles for the new tenant
  const DEFAULT_ROLES = [
    ['owner', 'Full access', '["*"]', true],
    ['admin', 'Full administrative access', '["*"]', true],
    ['editor', 'Content management', '["articles.read","articles.create","articles.update","sources.read","sources.create","sources.update","writers.read","categories.read","media.create","media.read","comments.read","comments.moderate","analytics.read","fetch.execute","newsletter.read"]', true],
    ['viewer', 'Read-only access', '["articles.read","sources.read","writers.read","categories.read","analytics.read","comments.read","audit.read","newsletter.read","media.read"]', true],
  ];
  for (const [name, desc, perms, isSystem] of DEFAULT_ROLES) {
    try {
      await db.prepare(
        'INSERT INTO roles (tenant_id, name, description, permissions, is_system) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT DO NOTHING'
      ).run(tenant.id, name, desc, perms, isSystem);
    } catch { /* skip */ }
  }

  // Issue a tenant-admin JWT (same secret as admin, but with tenantId claim)
  const token = jwt.sign(
    {
      sub: req.user.sub,
      email: req.user.email,
      displayName: req.user.displayName,
      avatarUrl: req.user.avatarUrl,
      tenantId: tenant.uuid,
      tenantSlug: tenant.slug,
      role: 'owner',
      type: 'tenant-admin',
      permissions: ['*'],
    },
    await getJwtSecret(),
    { expiresIn: '24h' }
  );

  logAudit(req, 'tenant.create', 'tenants', tenant.id, { slug: cleanSlug });

  res.status(201).json({ tenant, token, requires_payment: requiresPayment });
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

  // Auto-provision local user record if missing (backfill for OAuth tenant owners)
  const userEmail = (req.user.email || '').toLowerCase();
  if (admin.tenant_id !== platformId) {
    const existingLocal = userEmail
      ? await db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2').get(userEmail, admin.tenant_id)
      : await db.prepare('SELECT id FROM users WHERE tenant_id = $1 AND role = $2').get(admin.tenant_id, admin.role);
    if (!existingLocal) {
      try {
        const provUsername = userEmail || req.user.displayName || 'owner';
        const unusableHash = '$2a$12$' + crypto.randomBytes(40).toString('base64').slice(0, 53);
        const newUser = await db.prepare(
          'INSERT INTO users (username, password_hash, email, display_name, role, tenant_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id'
        ).get(provUsername, unusableHash, userEmail || null, req.user.displayName || provUsername, admin.role, admin.tenant_id);
        if (newUser) {
          await db.prepare(
            'UPDATE tenant_admins SET local_user_id = $1 WHERE tenant_id = $2 AND user_id = $3'
          ).run(newUser.id, admin.tenant_id, req.user.sub);
        }
      } catch { /* skip — username conflict or other constraint */ }
    } else if (userEmail) {
      // Fix existing records missing email
      await db.prepare(
        'UPDATE users SET email = $1, display_name = COALESCE(NULLIF(display_name, username), $2, display_name) WHERE id = $3 AND (email IS NULL OR email = $4)'
      ).run(userEmail, req.user.displayName, existingLocal.id, '').catch(() => {});
    }
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
        // No roles row — owners still get full access; others get empty
        permissions = admin.role === 'owner' ? ['*'] : [];
      }
    } catch { permissions = admin.role === 'owner' ? ['*'] : []; }
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

  const tenantRow = await db.prepare("SELECT custom_domain, stripe_subscription_id FROM tenants WHERE id = $1").get(tenantId);

  // Cancel Stripe subscription if active (prevent continued billing)
  if (tenantRow?.stripe_subscription_id) {
    try {
      const { getStripeConfig } = require('../lib/stripe-config');
      const { secretKey } = await getStripeConfig();
      if (secretKey) {
        const stripe = require('stripe')(secretKey);
        await stripe.subscriptions.cancel(tenantRow.stripe_subscription_id);
      }
    } catch (err) {
      console.warn(`[tenants/cancel] Stripe cancellation failed for tenant ${tenantId}: ${err.message}`);
      // Non-fatal — still cancel the tenant
    }
  }

  await db.prepare("UPDATE tenants SET status = 'cancelled' WHERE id = $1").run(tenantId);

  // Invalidate caches so the tenant is immediately unreachable
  invalidateSlugCache(admin.slug);
  if (tenantRow?.custom_domain) invalidateDomainCache(tenantRow.custom_domain);

  logAudit(req, 'tenant.cancel', 'tenants', tenantId, { slug: admin.slug });
  res.json({ success: true, status: 'cancelled' });
}));

// ── Stripe product cache (5 min TTL) ──────────────────────────────
let _stripeProductCache = null;
const STRIPE_CACHE_TTL = 5 * 60 * 1000;

async function fetchStripeProducts() {
  if (_stripeProductCache && Date.now() - _stripeProductCache.ts < STRIPE_CACHE_TTL) {
    return _stripeProductCache.data;
  }
  const { secretKey } = await getStripeConfig();
  if (!secretKey) return null;

  try {
    const stripe = require('stripe')(secretKey);
    const products = await stripe.products.list({ active: true, limit: 100, expand: ['data.default_price'] });
    const deepfeedProducts = products.data.filter(p => p.metadata?.app === 'deepfeed' && p.metadata?.plan);

    // Build map: plan name → { product_id, name, description, features, default_price }
    const map = {};
    for (const prod of deepfeedProducts) {
      const planKey = prod.metadata.plan;
      const entry = {
        product_id: prod.id,
        name: planKey.charAt(0).toUpperCase() + planKey.slice(1),
        description: prod.description || null,
        features: (prod.features || []).map(f => f.name),
      };

      // Resolve default price for interval + amount
      if (prod.default_price) {
        try {
          const price = typeof prod.default_price === 'string'
            ? await stripe.prices.retrieve(prod.default_price)
            : prod.default_price;
          entry.price_id = price.id;
          entry.price_cents = price.unit_amount;
          entry.interval = price.recurring?.interval || null;
        } catch { /* price lookup failed — skip pricing info */ }
      }

      map[prod.metadata.plan] = entry;
    }

    _stripeProductCache = { data: map, ts: Date.now() };
    return map;
  } catch {
    return null;
  }
}

// GET /api/tenants/plans — public plan info for signup page (no auth required)
router.get('/plans', asyncHandler(async (req, res) => {
  const [dbPlans, stripeMap] = await Promise.all([
    db.prepare(`
      SELECT plan, max_sources, max_writers, max_credits_month,
             audio_enabled, custom_domain_enabled, COALESCE(price_cents, 0) AS price_cents
      FROM plan_limits
      WHERE plan IN ('free', 'starter', 'pro', 'business')
      ORDER BY CASE plan WHEN 'free' THEN 1 WHEN 'starter' THEN 2 WHEN 'pro' THEN 3 WHEN 'business' THEN 4 END
    `).all(),
    fetchStripeProducts(),
  ]);

  const plans = dbPlans.map(p => ({
    ...p,
    stripe: stripeMap?.[p.plan] || null,
  }));

  res.json({ plans });
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
    db.prepare(`
      SELECT value FROM settings
      WHERE tenant_id = $1
        AND key IN ('openai_api_key','anthropic_api_key','gemini_api_key','openrouter_api_key','ollama_base_url')
        AND value IS NOT NULL AND value != ''
      LIMIT 1
    `).get(tid),
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

// POST /api/tenants/checkout — create Stripe Checkout Session for a pending tenant's subscription
router.post('/checkout', requireUser, asyncHandler(async (req, res) => {
  const { tenantId } = req.body || {};
  if (!tenantId || typeof tenantId !== 'number') {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  // Verify user owns the tenant and it's pending payment
  const tenant = await db.prepare(`
    SELECT t.id, t.slug, t.display_name, t.plan, t.status, t.stripe_customer_id
    FROM tenants t
    JOIN tenant_admins ta ON ta.tenant_id = t.id
    WHERE t.id = $1 AND ta.user_id = $2 AND ta.role = 'owner'
  `).get(tenantId, req.user.sub);

  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (tenant.status !== 'pending_payment') {
    return res.status(400).json({ error: 'Tenant does not require payment' });
  }

  // Look up Stripe price for the plan
  const planRow = await db.prepare('SELECT stripe_price_id FROM plan_limits WHERE plan = $1').get(tenant.plan);
  if (!planRow?.stripe_price_id) {
    return res.status(400).json({ error: 'Plan pricing is not configured' });
  }

  const { secretKey: stripeKey } = await getStripeConfig();
  if (!stripeKey) {
    return res.status(503).json({ error: 'Payment processing is not configured' });
  }

  const stripe = require('stripe')(stripeKey);

  // Get or create Stripe customer
  let customerId = tenant.stripe_customer_id;
  if (!customerId) {
    const user = await db.prepare('SELECT email, display_name FROM public_users WHERE id = $1').get(req.user.sub);
    const customer = await stripe.customers.create({
      email: user?.email || req.user.email,
      name: user?.display_name || req.user.displayName,
      metadata: { tenant_id: String(tenant.id), tenant_slug: tenant.slug },
    });
    customerId = customer.id;
    await db.prepare('UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2').run(customerId, tenant.id);
  }

  // Validate origin against known portal hosts to prevent open redirect
  const ALLOWED_ORIGINS = [
    'https://portal.deepfeedai.com',
    'https://portal-staging.deepfeedai.com',
    'http://localhost:4000',
  ];
  const rawOrigin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || '';
  const origin = ALLOWED_ORIGINS.includes(rawOrigin) ? rawOrigin : 'https://portal.deepfeedai.com';

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{
      price: planRow.stripe_price_id,
      quantity: 1,
    }],
    metadata: {
      tenant_id: String(tenant.id),
      signup: 'true',
    },
    success_url: `${origin}/checkout-success.html?tenant_id=${tenant.id}`,
    cancel_url: `${origin}/signup.html?cancelled=true&tenant_id=${tenant.id}`,
  });

  res.json({ checkout_url: session.url });
}));

// GET /api/tenants/checkout-status — poll tenant activation status after Stripe checkout
// Uses requireAnyAuth because after signup the stored token is a tenant-admin JWT, not a public user JWT
router.get('/checkout-status', requireAnyAuth, asyncHandler(async (req, res) => {
  const tenantId = parseInt(req.query.tenantId);
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

  const tenant = await db.prepare(`
    SELECT t.status FROM tenants t
    JOIN tenant_admins ta ON ta.tenant_id = t.id
    WHERE t.id = $1 AND ta.user_id = $2
  `).get(tenantId, req.user.sub);

  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  res.json({ status: tenant.status });
}));

module.exports = router;
