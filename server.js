require('dotenv').config({ override: true });

// LangGraph agent tool loops can stack multiple AbortSignal.timeout listeners
// per request. Default Node max is 10; bump to 100 to silence the warning
// while still catching genuine listener leaks.
require('events').setMaxListeners(100);

// Agent tracing bootstrap — no-op if OTEL_EXPORTER_OTLP_ENDPOINT is unset.
// Must run before other requires so OTel can instrument them.
try {
  const { initTracing } = require('./lib/agents/tracing');
  initTracing();
} catch (err) {
  console.warn('[server] agent tracing bootstrap failed:', err?.message);
}

const express   = require('express');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { rateLimitHandler } = require('./middleware/rate-limit-log');
const path      = require('path');
const db        = require('./db');
const { toSlug } = require('./lib/utils');
const { getSecrets } = require('./lib/secrets');
const { getAppConfig } = require('./lib/app-config');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Deployment Mode ──────────────────────────────────────────────
// Single-tenant is the default (self-hosted). Set DEPLOYMENT_MODE=multi for SaaS multi-tenant.
const tenantUtils = require('./lib/tenant-utils');

app.set('trust proxy', 1);

// ── Security Headers ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],
      scriptSrcAttr:  ["'unsafe-inline'"], // TODO: migrate inline onclick handlers to addEventListener, then remove
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:', 'https:'],
      mediaSrc:       ["'self'", 'https:', 'blob:'],
      connectSrc:     ["'self'"],
      frameSrc:       ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      frameAncestors: ["'none'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // not needed for admin panel
}));

// ── Public endpoint rate limits ────────────────────────────────────
// Protect expensive AI endpoints and prevent scraping / quota exhaustion.
const summaryLimiter = rateLimit({
  windowMs:       60 * 60 * 1000, // 1 hour
  max:            30,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:   (req) => `${req.tenantId || 0}:${req.ip}`,
  message:        { error: 'Too many summary requests. Please try again later.' },
  validate:       false,
  handler:        rateLimitHandler('public.summary'),
});

const publicApiLimiter = rateLimit({
  windowMs:       60 * 1000, // 1 minute
  max:            120,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:   (req) => `${req.tenantId || 0}:${req.ip}`,
  message:        { error: 'Too many requests. Please slow down.' },
  validate:       false,
  handler:        rateLimitHandler('public.api'),
});

// Admin write rate limiter — protects mutation endpoints and AI-budget endpoints
const adminWriteLimiter = rateLimit({
  windowMs:       60 * 1000, // 1 minute
  max:            60,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:   (req) => req.user?.sub ? `admin:${req.user.sub}` : `ip:${req.ip}`,
  message:        { error: 'Too many admin write requests. Please slow down.' },
  validate:       false,
  skip:           (req) => req.method === 'GET' || req.method === 'OPTIONS',
  handler:        rateLimitHandler('admin.write'),
});

// Tight limiter for AI-budget-consuming endpoints
const aiLimiter = rateLimit({
  windowMs:       60 * 1000,
  max:            10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:   (req) => req.user?.sub ? `ai:${req.user.sub}` : `ip:${req.ip}`,
  message:        { error: 'Too many AI generation requests. Please slow down.' },
  validate:       false,
  handler:        rateLimitHandler('ai.generate'),
});

// ── CORS ───────────────────────────────────────────────────────────
// Public read routes are open to all origins — they serve the main site
// (deepfeedai.com) and any other consumers. JWT auth protects all write
// and admin endpoints, so open CORS on reads is safe.
//
// For cross-origin write/admin requests the ALLOWED_ORIGINS env var is
// used as an allowlist (set in Railway). Same-origin requests (admin panel
// fetching its own API) are always allowed.
const PUBLIC_PATHS = ['/api/news', '/api/article', '/api/summary', '/api/user-auth', '/api/comments', '/api/subscribe', '/api/unsubscribe', '/api/contact', '/api/thumbnail', '/api/trends', '/api/favorites', '/api/article-reactions', '/api/notifications', '/api/read-history', '/api/site-config', '/api/analytics/event', '/api/analytics/client-logs', '/api/writers', '/api/newsletter/preview', '/api/banners/active', '/api/features', '/api/instance-info', '/api/setup'];

const DEFAULT_LOCAL_ORIGINS = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:4000', 'http://127.0.0.1:4000'];

app.use(async (req, res, next) => {
  const origin = req.headers.origin;

  // No origin header — curl, server-to-server, same-origin in some browsers
  if (!origin) return next();

  // Always set CORS headers for preflight
  const isPublic = PUBLIC_PATHS.some(p => req.path.startsWith(p));

  // Same-origin check
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const serverOrigin = `${proto}://${req.headers.host}`;
  const isSameOrigin = origin === serverOrigin;

  // Resolve allowed origins from settings → env var → defaults
  let allowedOrigins;
  try {
    const { getAppConfig } = require('./lib/app-config');
    const config = await getAppConfig(req.tenantId || 1);
    const raw = config.allowed_origins || '';
    allowedOrigins = raw.split(',').map(o => o.trim()).filter(Boolean);
  } catch {
    allowedOrigins = [];
  }
  if (allowedOrigins.length === 0 && process.env.NODE_ENV !== 'production') allowedOrigins = DEFAULT_LOCAL_ORIGINS;

  // Allow *.deepfeedai.com subdomains and validated custom domains for tenant access
  const isTenantSubdomain = /^https:\/\/[a-z0-9-]+\.deepfeedai\.com$/.test(origin);
  let isCustomDomain = false;
  if (!isSameOrigin && !isPublic && !allowedOrigins.includes(origin) && !isTenantSubdomain) {
    // Check if origin matches a tenant's custom_domain
    try {
      const originHost = new URL(origin).hostname;
      const tenant = await db.prepare(
        "SELECT id FROM tenants WHERE custom_domain = $1 AND status = 'active'"
      ).get(originHost);
      if (tenant) {
        isCustomDomain = true;
      }
    } catch { /* invalid URL */ }
    if (!isCustomDomain) {
      console.error(`[CORS] Blocked: ${origin}`);
      return res.status(403).json({ error: 'CORS: origin not allowed' });
    }
  }

  // Allow the request — public routes get wildcard, others get reflected origin
  res.setHeader('Access-Control-Allow-Origin', isPublic ? '*' : origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Tenant-Slug');
  if (!isPublic) res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }

  next();
});

// ── Stripe Webhook (raw body — must be BEFORE json parser) ─────────
app.use('/api/webhooks/stripe', require('./routes/stripe-webhooks'));

// ── Discord Webhook (raw body — Ed25519 signature verification) ────
app.use('/api/webhooks/discord', require('./routes/discord-webhook'));

// ── Body Parsers ───────────────────────────────────────────────────
// Routes that need larger payloads get a higher limit applied first.
// The global 64kb parser below will skip them because body-parser
// does not re-parse if req.body is already set.
const largeBodyParser = express.json({ limit: '2mb' });
const xlBodyParser    = express.json({ limit: '10mb' });

// Apply larger limit to specific admin paths BEFORE the global parser
app.use('/api/admin/writers', xlBodyParser);
app.use('/api/synthesis', largeBodyParser);

// Default: small limit for everything else (DoS mitigation)
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

// ── Correlation ID ─────────────────────────────────────────────────
app.use(require('./middleware/correlation'));

// ── Signup subdomain routing ────────────────────────────────────────
// Must be BEFORE express.static so index.html doesn't get served for '/'.
// When accessed via signup.deepfeedai.com or signup.staging.deepfeedai.com,
// serve signup.html as the default page instead of index.html.
const SIGNUP_HOSTS = new Set([
  'signup.deepfeedai.com',
  'signup.staging.deepfeedai.com',
]);
app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  if (SIGNUP_HOSTS.has(host) && !req.path.startsWith('/api') && !req.path.includes('.')) {
    return res.sendFile(path.join(__dirname, 'public', 'signup.html'));
  }
  next();
});

// ── Static files ────────────────────────────────────────────────────
// Allow cross-origin loading of media files (audio, images) from frontend
app.use('/media', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// In setup mode, redirect HTML page requests to setup.html
// (must come before express.static so index.html doesn't get served)
const { isSetupMode: _isSetupMode } = require('./lib/setup-mode');
app.use(async (req, res, next) => {
  // Only intercept navigation requests (not JS, CSS, images, API calls)
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/media/')) return next();
  // Let setup.html and its assets through
  if (req.path === '/setup.html' || req.path === '/setup-page.js') return next();
  // Let static assets through (has a file extension that isn't .html)
  if (/\.\w+$/.test(req.path) && !req.path.endsWith('.html')) return next();

  if (await _isSetupMode()) {
    return res.sendFile(path.join(__dirname, 'public', 'setup.html'));
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Tenant Context ──────────────────────────────────────────────────
const { tenantContext } = require('./middleware/tenant');
const { getPlatformTenantId } = require('./lib/platform-tenant');
if (tenantUtils.MULTI_TENANT) {
  app.use('/api', tenantContext);
} else {
  app.use('/api', async (req, _res, next) => {
    req.tenantId = await getPlatformTenantId();
    next();
  });
}

// ── Request Logger ─────────────────────────────────────────────────
app.use(require('./middleware/request-logger'));

// ── First-Boot Setup Mode ────────────────────────────────────────
const { isSetupMode } = require('./lib/setup-mode');
app.use('/api/setup', require('./routes/setup'));

// ── Instance Info (public, no auth, available even in setup mode) ─
app.get('/api/instance-info', (_req, res) => {
  res.json({
    name:    process.env.INSTANCE_NAME || 'default',
    mode:    tenantUtils.MULTI_TENANT ? 'multi' : 'single',
    version: require('./package.json').version,
    tenant_base_domain: process.env.TENANT_BASE_DOMAIN || null,
  });
});

// Gate all other API routes when in setup mode (no admin user yet)
app.use('/api', async (req, res, next) => {
  if (await isSetupMode()) {
    return res.status(503).json({ error: 'Server is in setup mode. Please complete setup at /setup.' });
  }
  next();
});

// ── Per-tenant aggregate rate limiting ──────────────────────────────
const tenantRateBuckets = new Map(); // tenantId → { count, windowStart }
const PLAN_RATE_LIMITS = { free: 300, starter: 600, pro: 1200 }; // requests per minute
const { getPlanInfo } = require('./lib/plan-limits');

app.use('/api', async (req, res, next) => {
  const tid = req.tenantId;
  if (!tid) return next();

  // Look up tenant effective plan (trial-aware, cached)
  let plan = 'free';
  try {
    const info = await getPlanInfo(tid);
    if (info) plan = info.effectivePlan;
  } catch { /* fallback to free */ }

  const limit = PLAN_RATE_LIMITS[plan];
  if (!limit) return next(); // business = unlimited

  const now = Date.now();
  let bucket = tenantRateBuckets.get(tid);
  if (!bucket || now - bucket.windowStart > 60000) {
    bucket = { count: 0, windowStart: now };
    tenantRateBuckets.set(tid, bucket);
  }

  bucket.count++;
  if (bucket.count > limit) {
    return res.status(429).json({ error: 'Tenant rate limit exceeded. Please try again later.' });
  }
  next();
});

// ── Rate limiter cleanup — evict stale buckets every 5 min ──────────
setInterval(() => {
  const now = Date.now();
  for (const [tid, bucket] of tenantRateBuckets) {
    if (now - bucket.windowStart > 120000) tenantRateBuckets.delete(tid);
  }
}, 5 * 60 * 1000);

// ── Database storage file serving (after tenant middleware) ─────────
const { serveRoute: storageServeRoute } = require('./lib/storage');
app.use('/api/media/file', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, storageServeRoute);

// ── API Routes ──────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/local-auth'));
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/articles',  largeBodyParser, require('./routes/articles'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/pitches',   require('./routes/pitches'));
app.use('/api/actions',   require('./routes/actions'));   // cross-channel signed-token action dispatch (PR-B)
app.use('/api/admin-notifications', require('./routes/admin-notifications')); // admin bell + notifications page (PR-D)
app.use('/api/research',  require('./routes/research'));
app.use('/api/newsroom-chat', require('./routes/newsroom-chat'));
app.use('/api/newsroom-feed', require('./routes/newsroom-feed'));
app.use('/api/sources',   require('./routes/sources'));
app.use('/api/article',   publicApiLimiter, require('./routes/article'));    // public — single article by slug
app.use('/api/fetch-url', require('./routes/fetch-url')); // admin — OG scraper
app.use('/api/summary',   summaryLimiter,   require('./routes/summary'));    // public — AI TLDR (rate limited)
app.use('/api/media',     aiLimiter, require('./routes/media'));
// voices route deprecated — ElevenLabs voice IDs now stored directly on writers
app.use('/api/writers',   require('./routes/writers'));
app.use('/api/settings',     largeBodyParser, require('./routes/settings'));
app.use('/api/categories',   require('./routes/categories'));
app.use('/api/site-config',  require('./routes/site-config'));
app.use('/api/analytics',    require('./routes/analytics'));  // POST /event public, GET /summary auth
app.use('/api/news',      publicApiLimiter, require('./routes/news'));       // public — news feed
app.use('/api/user-auth', require('./routes/user-auth')); // public — OAuth for public users
if (tenantUtils.MULTI_TENANT) {
  app.use('/api/tenants', require('./routes/tenants'));    // tenant signup + slug check
}
app.use('/api/comments',   require('./routes/comments'));    // public read, user write, admin mod
app.use('/api/subscribe',    require('./routes/subscribe'));    // public — newsletter signup
app.use('/api/unsubscribe', require('./routes/unsubscribe')); // public — newsletter unsubscribe
app.use('/api/contact',    require('./routes/contact'));     // public — contact form
app.use('/api/thumbnail',  require('./routes/thumbnail'));   // public — AI thumbnail generation
app.use('/api/trends',     require('./routes/trends'));      // public — trending analysis
app.use('/api/newsletter',        require('./routes/newsletter'));           // admin — newsletter send
app.use('/api/favorites',         require('./routes/favorites'));            // user — article bookmarks
app.use('/api/article-reactions', require('./routes/article-reactions'));    // user — article 👍❤️ reactions
app.use('/api/notifications',     require('./routes/notifications').router); // user — in-app notifications
app.use('/api/banners',           require('./routes/banners').router);         // public active + tenant admin CRUD

const { auth } = require('./middleware/auth');
app.use('/api/admin/users',   adminWriteLimiter, require('./routes/admin-users'));
app.use('/api/admin/roles',   require('./routes/admin-roles'));
app.use('/api/admin/audit-log', require('./routes/admin-audit'));
app.use('/api/admin/tenants', auth, require('./routes/admin-tenants'));
app.use('/api/admin/writers', auth, require('./routes/admin-writers'));
app.use('/api/admin/pitches', require('./routes/admin-pitches'));
app.use('/api/admin/discover', require('./routes/discover'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/admin/features', require('./routes/admin-features'));
app.use('/api/features',       require('./routes/features'));          // public — tenant feature flags
app.use('/api/ai-usage', auth, require('./routes/ai-usage'));
app.use('/api/promo',    auth, require('./routes/promo'));
app.use('/api/credits',  auth, require('./routes/credit-purchases'));
app.use('/api/synthesis',     auth, largeBodyParser, require('./routes/synthesis'));
app.use('/api/orchestrator', auth, require('./routes/orchestrator'));
app.use('/api/platform/banners', auth, require('./routes/platform-banners')); // platform admin — global banners
app.use('/api/chat', aiLimiter, require('./routes/chat'));                     // platform admin — AI chatbot
app.use('/api/article-assist', aiLimiter, require('./routes/article-assist')); // admin — AI article editor assistant

const { router: fetchRouter, fetchAllSources, fetchLiveSources } = require('./routes/fetch');
const cron = require('node-cron');
app.use('/api/fetch', fetchRouter);
app.use('/api/admin/cron', require('./routes/admin-cron'));
app.use('/api/admin/metrics', require('./routes/admin-metrics'));
app.use('/api/admin/logs', require('./routes/admin-logs'));

const { getActiveTenantIds } = require('./lib/tenant-utils');
const { registerJob, startAll } = require('./lib/cron-registry');

// ── SPA fallback ────────────────────────────────────────────────────
app.get('*', async (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Redirect to setup page on first boot
  if (await isSetupMode()) {
    return res.sendFile(path.join(__dirname, 'public', 'setup.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ────────────────────────────────────────────
// Catches errors forwarded via next(err) from asyncHandler-wrapped routes.
const logger = require('./lib/logger');
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const isDev = process.env.NODE_ENV !== 'production';
  const status = err.status || err.statusCode || 500;
  logger.error(err.message, {
    module: 'http',
    error: err,
    correlationId: req.correlationId,
    tenantId: req.tenantId,
    method: req.method,
    path: req.path,
    statusCode: status,
  });
  res.status(status).json({ error: isDev ? err.message : 'Internal server error' });
});

// ── Cron Job Registration ───────────────────────────────────────────
// All 9 cron jobs are registered via the cron registry for centralized
// management, logging, and admin API control.

registerJob({
  name: 'rss-fetch',
  description: 'RSS auto-fetch',
  category: 'Content',
  defaultSchedule: '*/30 * * * *',
  handler: async (tenantId) => {
    console.log(`[Cron] Auto-fetching RSS sources (tenant ${tenantId})...`);
    const result = await fetchAllSources(false, tenantId);
    if (result.inserted > 0) console.log(`[Cron] RSS fetch (tenant ${tenantId}) — ${result.inserted} new, ${result.skipped} skipped`);
    return { inserted: result.inserted, skipped: result.skipped };
  },
});

registerJob({
  name: 'live-news',
  description: 'Live news fetch',
  category: 'Content',
  defaultSchedule: '0 * * * *',
  handler: async (tenantId) => {
    const appCfg = await getAppConfig(tenantId);
    if (!appCfg.news_api_key && !appCfg.brave_api_key) return { skipped: 'No API keys configured' };
    console.log(`[Cron] Auto-fetching live news sources (tenant ${tenantId})...`);
    const autoPublishSetting = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'auto_publish_live'").get(tenantId);
    const autoPublish = autoPublishSetting?.value === '1';
    const result = await fetchLiveSources(autoPublish, tenantId);
    if (result.inserted > 0) console.log(`[Cron] Live news (tenant ${tenantId}) — ${result.inserted} new, ${result.skipped} skipped`);
    if (result.errors.length) console.warn(`[Cron] Live news errors (tenant ${tenantId}):`, result.errors);
    return { inserted: result.inserted, skipped: result.skipped, errors: result.errors.length };
  },
});

registerJob({
  name: 'synthesis',
  description: 'Synthesis scheduler',
  category: 'Content',
  defaultSchedule: '0 */2 * * *',
  handler: async (tenantId) => {
    const { runSynthesisForWriter } = require('./lib/synthesis');
    const hour = new Date().getUTCHours();
    const dow  = new Date().getUTCDay();

    const writers = await db.prepare('SELECT id, name, synthesis_schedule FROM writers WHERE tenant_id = $1 AND is_auto = true').all(tenantId);
    const results = [];

    for (const w of writers) {
      const schedule = w.synthesis_schedule || 'daily';
      let shouldRun = false;
      if (schedule === 'frequent')         shouldRun = true; // every 2 hours
      else if (schedule === 'daily')       shouldRun = (hour === 6);
      else if (schedule === 'twice-daily') shouldRun = (hour === 6 || hour === 18);
      else if (schedule === 'weekly')      shouldRun = (hour === 6 && dow === 1);

      if (!shouldRun) continue;

      console.log(`[Cron] Running ${schedule} synthesis for ${w.name} (tenant ${tenantId})...`);
      const result = await runSynthesisForWriter(w.id, { tenantId });
      if (result.generated > 0) {
        console.log(`[Cron] Synthesis for ${w.name}: ${result.generated} articles from ${result.clusters} clusters`);
      } else if (result.skipped) {
        console.log(`[Cron] Synthesis for ${w.name} skipped: ${result.skipped}`);
      }
      results.push({ writer: w.name, ...result });
    }
    return { writers: results.length, results };
  },
});

registerJob({
  name: 'deep-dive',
  description: 'Twice-weekly deep dive roundups',
  category: 'Content',
  defaultSchedule: '0 20 * * 0,3',  // Sunday + Wednesday 8 PM UTC
  handler: async (tenantId) => {
    const { runWeeklyDeepDives } = require('./lib/synthesis');
    const result = await runWeeklyDeepDives(tenantId);
    if (result.generated > 0) {
      console.log(`[Cron] Deep dives (tenant ${tenantId}): generated ${result.generated} for ${result.categories.join(', ')}`);
    }
    return result;
  },
});

registerJob({
  name: 'synthesis-forecast',
  description: 'Pre-synthesis forecast and admin notification',
  category: 'Content',
  defaultSchedule: '0 */2 * * *',  // every 2 hours, same cadence as synthesis
  handler: async (tenantId) => {
    const { generateForecast } = require('./lib/synthesis');
    const { sendForecastNotification } = require('./lib/notify');
    const hour = new Date().getUTCHours();
    const dow  = new Date().getUTCDay();

    const writers = await db.prepare('SELECT id, name, synthesis_schedule FROM writers WHERE tenant_id = $1 AND is_auto = true').all(tenantId);
    const forecasts = [];

    for (const w of writers) {
      const schedule = w.synthesis_schedule || 'daily';
      // Run forecast 1 hour before synthesis would fire
      let shouldForecast = false;
      if (schedule === 'frequent')         shouldForecast = (hour % 2 === 1); // odd hours (1h before even-hour synthesis)
      else if (schedule === 'daily')       shouldForecast = (hour === 5);
      else if (schedule === 'twice-daily') shouldForecast = (hour === 5 || hour === 17);
      else if (schedule === 'weekly')      shouldForecast = (hour === 5 && dow === 1);

      if (!shouldForecast) continue;

      console.log(`[Cron] Generating synthesis forecast for ${w.name} (tenant ${tenantId})...`);
      const forecast = await generateForecast(w.id, tenantId);
      if (forecast) forecasts.push(forecast);
    }

    if (forecasts.length > 0) {
      await sendForecastNotification(forecasts, tenantId).catch(err => {
        console.error('[Cron] Forecast notification error:', err.message);
      });
    }

    return { forecasts: forecasts.length };
  },
});

registerJob({
  name: 'agent-scan',
  description: 'Writer agent proactive beat search + story pitch evaluation',
  category: 'Content',
  defaultSchedule: '30 */2 * * *', // every 2 hours at :30 (offset from synthesis at :00)
  handler: async (tenantId) => {
    const { evaluateIncomingArticles, checkPredictions, proactiveBeatSearch } = require('./lib/writer-agent');
    const writers = await db.prepare(
      "SELECT id FROM writers WHERE tenant_id = $1 AND is_auto = true"
    ).all(tenantId);

    let totalPitches = 0;
    let totalIngested = 0;

    for (const w of writers) {
      try {
        // Step 1: proactively search external sources for the writer's beats
        // and ingest fresh results before evaluating. No-ops if agent_web_research
        // feature flag is off.
        const searchResult = await proactiveBeatSearch(w.id, tenantId);
        totalIngested += searchResult.ingested;

        // Step 2: evaluate the (now-enriched) pool and generate pitches
        const pitches = await evaluateIncomingArticles(w.id, tenantId);
        totalPitches += pitches.length;

        // Notify on new pitches
        if (pitches.length) {
          const { notifyNewPitch } = require('./lib/messaging');
          const writer = await db.prepare('SELECT * FROM writers WHERE id = $1').get(w.id);
          for (const p of pitches) {
            notifyNewPitch(tenantId, p, writer).catch(() => {});
          }
        }
      } catch (err) {
        console.error(`[agent-scan] writer ${w.id}:`, err.message);
      }
    }

    // Weekly prediction checks (Mondays)
    if (new Date().getDay() === 1) {
      for (const w of writers) {
        try { await checkPredictions(w.id, tenantId); } catch {}
      }
    }

    return { writers: writers.length, pitches: totalPitches, ingested: totalIngested };
  },
});

registerJob({
  name: 'daily-standup',
  description: 'Morning writer standup — each agent summarises what they\'re tracking today',
  category: 'Content',
  defaultSchedule: '30 7 * * *', // 7:30 AM UTC — after synthesis (6:00) and agent-scan (6:30)
  handler: async (tenantId) => {
    const { isFeatureEnabled } = require('./lib/feature-registry');
    const planEnabled = await isFeatureEnabled(tenantId, 'daily_standups').catch(() => false);
    if (!planEnabled) return { skipped: 'daily_standups feature not enabled on plan' };

    const { generateStandup } = require('./lib/writer-agent');
    const { recordEvent } = require('./lib/newsroom-events');

    const writers = await db.prepare(
      "SELECT id, name FROM writers WHERE tenant_id = $1 AND is_auto = true AND role != 'designer'"
    ).all(tenantId);

    let posted = 0;
    for (const w of writers) {
      try {
        const text = await generateStandup(w.id, tenantId);
        if (!text) continue;

        // Post to newsroom feed
        await recordEvent({
          tenantId,
          type: 'standup',
          actorWriterId: w.id,
          payload: { text },
        });

        // Send to messaging channels if configured
        const { notifyStandup } = require('./lib/messaging');
        if (notifyStandup) {
          notifyStandup(tenantId, text, w).catch(() => {});
        }

        console.log(`[daily-standup] ${w.name} (tenant ${tenantId}): posted standup`);
        posted++;
      } catch (err) {
        console.error(`[daily-standup] writer ${w.id}:`, err.message);
      }
    }

    return { writers: writers.length, posted };
  },
});

registerJob({
  name: 'daily-brief',
  description: 'End-of-day editorial brief — Maxwell summarises the day\'s output, pitches, and AI spend',
  category: 'Content',
  defaultSchedule: '0 18 * * *', // 6 PM UTC — after the editorial window closes
  handler: async (tenantId) => {
    const { isFeatureEnabled } = require('./lib/feature-registry');
    const enabled = await isFeatureEnabled(tenantId, 'daily_brief').catch(() => false);
    if (!enabled) return { skipped: 'daily_brief feature not enabled' };

    const { generateDailyBrief } = require('./lib/writer-agent');
    const { recordEvent } = require('./lib/newsroom-events');

    // Get Maxwell's writer row to credit the brief to him
    const maxwell = await db.prepare(
      "SELECT id FROM writers WHERE tenant_id = $1 AND role = 'editor' AND is_system = true LIMIT 1"
    ).get(tenantId).catch(() => null);

    const text = await generateDailyBrief(tenantId);
    if (!text) return { skipped: 'no data for brief' };

    await recordEvent({
      tenantId,
      type: 'daily_brief',
      actorWriterId: maxwell?.id || null,
      payload: { text },
    });

    console.log(`[daily-brief] Posted for tenant ${tenantId}`);
    return { ok: true };
  },
});

registerJob({
  name: 'weekly-digest',
  description: 'Friday week-in-review — Maxwell covers output, beat gaps, engagement, and next-week outlook',
  category: 'Content',
  defaultSchedule: '0 17 * * 5', // 5 PM UTC every Friday
  handler: async (tenantId) => {
    const { isFeatureEnabled } = require('./lib/feature-registry');
    const enabled = await isFeatureEnabled(tenantId, 'weekly_digest').catch(() => false);
    if (!enabled) return { skipped: 'weekly_digest feature not enabled' };

    const { generateWeeklyDigest } = require('./lib/writer-agent');
    const { recordEvent } = require('./lib/newsroom-events');

    const maxwell = await db.prepare(
      "SELECT id FROM writers WHERE tenant_id = $1 AND role = 'editor' AND is_system = true LIMIT 1"
    ).get(tenantId).catch(() => null);

    const text = await generateWeeklyDigest(tenantId);
    if (!text) return { skipped: 'no data for digest' };

    await recordEvent({
      tenantId,
      type: 'weekly_digest',
      actorWriterId: maxwell?.id || null,
      payload: { text },
    });

    console.log(`[weekly-digest] Posted for tenant ${tenantId}`);
    return { ok: true };
  },
});

registerJob({
  name: 'orchestrator-cycle',
  description: 'Newsroom orchestration pipeline — scout, verify, research, write',
  category: 'Content',
  defaultSchedule: '*/30 * * * *',
  handler: async (tenantId) => {
    const { runOrchestrator } = require('./lib/orchestrator');
    return runOrchestrator(tenantId);
  },
});

registerJob({
  name: 'auto-audio',
  description: 'Auto-audio generation',
  category: 'Media',
  defaultSchedule: '0 8 * * *',
  handler: async (tenantId) => {
    const enabledSetting = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'auto_audio_enabled'").get(tenantId);
    if (enabledSetting?.value !== '1') return { skipped: 'Auto-audio not enabled' };

    const maxSetting = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'auto_audio_daily_max'").get(tenantId);
    const dailyMax = parseInt(maxSetting?.value) || 3;

    const candidates = await db.prepare(`
      SELECT a.id, a.title FROM articles a
      JOIN writers w ON w.id = a.writer_id AND w.tenant_id = $1
      WHERE a.tenant_id = $1 AND a.is_published = 1 AND a.is_archived = 0
        AND (a.audio_status IS NULL OR a.audio_status = '')
        AND a.created_at > NOW() - INTERVAL '3 days'
        AND w.elevenlabs_voice_id IS NOT NULL AND w.elevenlabs_voice_id != ''
      ORDER BY
        a.is_featured DESC,
        a.editorial_score DESC NULLS LAST,
        CASE WHEN a.content_type = 'original' THEN 0 ELSE 1 END,
        a.created_at DESC
      LIMIT $2
    `).all(tenantId, dailyMax);

    if (!candidates.length) return { skipped: 'No candidates', candidates: 0 };

    const { generateAudioForArticle } = require('./lib/media-helpers');
    let generated = 0;
    for (const article of candidates) {
      const result = await generateAudioForArticle(article.id, tenantId);
      if (result) {
        generated++;
        console.log(`[Cron] Auto-audio (tenant ${tenantId}): "${article.title}"`);
      }
    }
    if (generated) console.log(`[Cron] Auto-audio (tenant ${tenantId}): generated ${generated}/${candidates.length}`);
    return { generated, candidates: candidates.length };
  },
});

registerJob({
  name: 'newsletter',
  description: 'Weekly newsletter',
  category: 'Notifications',
  defaultSchedule: '0 14 * * 1',
  handler: async (tenantId) => {
    const appCfg     = await getAppConfig(tenantId);
    const resendKey  = appCfg.resend_api_key;
    const audienceId = appCfg.resend_audience_id;
    if (!resendKey || !audienceId) return { skipped: 'Resend not configured' };
    console.log(`[Cron] Sending weekly newsletter (tenant ${tenantId})...`);
    const { cronSecret } = await getSecrets();
    // Look up tenant UUID for the X-Tenant-Id header
    const tenantRow = await db.prepare('SELECT uuid FROM tenants WHERE id = $1').get(tenantId);
    const tenantIdHeader = tenantRow?.uuid || String(tenantId); // grace fallback
    const res = await fetch(`http://localhost:${PORT}/api/newsletter/send`, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-cron-secret':  cronSecret || '',
        'X-Tenant-Id':    tenantIdHeader,
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.success) {
      console.log(`[Cron] Newsletter (tenant ${tenantId}) sent — broadcast ${data.broadcastId}, ${data.articleCount} articles`);
      return { broadcastId: data.broadcastId, articleCount: data.articleCount };
    } else {
      console.error(`[Cron] Newsletter (tenant ${tenantId}) failed:`, data.error);
      throw new Error(data.error || 'Newsletter send failed');
    }
  },
});

registerJob({
  name: 'featured-rotation',
  description: 'Featured article rotation',
  category: 'Content',
  defaultSchedule: '0 * * * *',  // hourly check; actual interval controlled by settings
  handler: async (tenantId) => {
    const { rotateFeatured } = require('./lib/featured-rotation');
    const result = await rotateFeatured(tenantId);
    if (result.rotated && result.slotsFilled > 0) {
      console.log(`[Cron] Featured rotation (tenant ${tenantId}): ${result.slotsFilled} slots filled (${result.strategy})`);
    }
    return result;
  },
});

registerJob({
  name: 'auto-archive',
  description: 'Auto-archive articles',
  category: 'Maintenance',
  defaultSchedule: '0 2 * * *',
  handler: async (tenantId) => {
    const rows = await db.prepare('SELECT key, value FROM settings WHERE tenant_id = $1 AND key LIKE $2').all(tenantId, 'purge_%');
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (s.purge_enabled !== '1') return { skipped: 'Auto-archive not enabled' };

    const days            = Math.max(parseInt(s.purge_days) || 30, 7);
    const protectFeatured = s.purge_protect_featured !== '0';
    const protectAudio    = s.purge_protect_audio === '1';
    const protectEngaged  = s.purge_protect_engaged === 'true';
    const engagedDays     = Math.max(parseInt(s.purge_protect_engaged_days) || 7, 1);
    const cutoff          = new Date(Date.now() - days * 86400000).toISOString();

    let engagedSlugs = new Set();
    if (protectEngaged) {
      const engagedCutoff = new Date(Date.now() - engagedDays * 86400000).toISOString();
      const commentSlugs = await db.prepare(`
        SELECT DISTINCT article_slug FROM comments
        WHERE tenant_id = $1 AND created_at > $2 AND is_deleted = 0
      `).all(tenantId, engagedCutoff);
      const reactionSlugs = await db.prepare(`
        SELECT DISTINCT c.article_slug FROM comment_reactions r
        JOIN comments c ON c.id = r.comment_id
        WHERE c.tenant_id = $1 AND r.created_at > $2 AND c.is_deleted = 0
      `).all(tenantId, engagedCutoff);
      for (const row of commentSlugs)  engagedSlugs.add(row.article_slug);
      for (const row of reactionSlugs) engagedSlugs.add(row.article_slug);
    }

    const candidates = await db.prepare(`
      SELECT id, title, is_featured, audio_status, audio_url
      FROM articles
      WHERE tenant_id = $1 AND is_archived = 0
        AND (created_at < $2 OR (published_at IS NOT NULL AND published_at < $2))
    `).all(tenantId, cutoff);

    let purged = 0;
    for (const row of candidates) {
      if (protectFeatured && row.is_featured) continue;
      if (protectAudio && row.audio_status === 'ready' && row.audio_url) continue;
      if (protectEngaged && engagedSlugs.has(toSlug(row.title))) continue;
      await db.prepare(`
        UPDATE articles SET is_archived = 1, is_published = 0, is_featured = 0,
          featured_priority = NULL, is_pinned = 0, featured_source = NULL, featured_until = NULL,
          archived_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2
      `).run(row.id, tenantId);
      purged++;
    }
    if (purged > 0) console.log(`[AutoPurge] Archived ${purged} article(s) older than ${days} days (tenant ${tenantId})`);
    return { purged, candidates: candidates.length, days };
  },
});

registerJob({
  name: 'purge-archived',
  description: 'Purge archived articles',
  category: 'Maintenance',
  defaultSchedule: '0 * * * *',
  handler: async (tenantId) => {
    const graceSetting = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'purge_grace_hours'").get(tenantId);
    const graceHours = Math.max(parseInt(graceSetting?.value ?? '24', 10) || 24, 1);
    const result = await db.getPool().query(
      `DELETE FROM articles
       WHERE tenant_id = $1
         AND is_archived = 1
         AND archived_at IS NOT NULL
         AND archived_at <= NOW() - make_interval(hours => $2)`,
      [tenantId, graceHours]
    );
    if (result.rowCount > 0) {
      console.log(`[Cron] Purged ${result.rowCount} archived article(s) (tenant ${tenantId}, grace ${graceHours}h)`);
    }
    return { purged: result.rowCount, graceHours };
  },
});

registerJob({
  name: 'auth-cleanup',
  description: 'Auth code cleanup',
  category: 'Maintenance',
  defaultSchedule: '*/10 * * * *',
  handler: async (_tenantId) => {
    await db.prepare(`
      DELETE FROM auth_codes
      WHERE used = 1 OR expires_at <= NOW()
    `).run();
    return { cleaned: true };
  },
});

registerJob({
  name: 'budget-alert',
  description: 'Budget alert check',
  category: 'Notifications',
  defaultSchedule: '0 9 * * *',
  handler: async (tenantId) => {
    const { checkBudgetAlerts } = require('./lib/budget');
    const alert = await checkBudgetAlerts(tenantId);
    if (!alert.warn) return { warn: false };

    const today = new Date().toISOString().slice(0, 10);
    const alreadySent = await db.prepare(
      `SELECT id FROM ai_usage
       WHERE tenant_id = $1 AND operation = 'email' AND trigger = 'cron'
         AND error_message IS NULL
         AND created_at >= $2::DATE
       LIMIT 1`
    ).get(tenantId, today);
    if (alreadySent) return { warn: true, alreadySent: true };

    const { sendBudgetAlert } = require('./lib/notify');
    await sendBudgetAlert(alert, tenantId);
    console.log(`[Cron] Budget alert sent (tenant ${tenantId}): ${alert.level} (${alert.pctUsed}%)`);
    return { warn: true, level: alert.level, pctUsed: alert.pctUsed, sent: true };
  },
});

registerJob({
  name: 'audit-alerts',
  description: 'Suspicious activity check',
  category: 'Monitoring',
  defaultSchedule: '*/15 * * * *',
  handler: async (tenantId) => {
    const { detectSuspiciousActivity } = require('./lib/audit-alerts');
    const alerts = await detectSuspiciousActivity(tenantId);
    if (alerts.length > 0) {
      console.warn(`[Cron] Audit alerts (tenant ${tenantId}): ${alerts.length} suspicious patterns detected`);
    }
    return { alertCount: alerts.length, alerts: alerts.map(a => a.type) };
  },
});

registerJob({
  name: 'audit-retention',
  description: 'Audit log retention cleanup',
  category: 'Maintenance',
  defaultSchedule: '0 3 * * 0',
  handler: async (tenantId) => {
    const { logAudit } = require('./middleware/audit');
    const retentionSetting = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'audit_retention_days'").get(tenantId);
    const retentionDays = Math.max(parseInt(retentionSetting?.value) || 90, 30);

    const result = await db.getPool().query(
      `DELETE FROM audit_log WHERE tenant_id = $1 AND created_at < NOW() - make_interval(days => $2)`,
      [tenantId, retentionDays]
    );
    const deleted = result.rowCount;

    if (deleted > 0) {
      // Log the retention cleanup itself
      await logAudit({ tenantId, user: { type: 'cron' }, ip: '127.0.0.1' }, 'audit.retention', 'audit_log', null, { retentionDays, deleted });
      console.log(`[Cron] Audit retention (tenant ${tenantId}): deleted ${deleted} entries older than ${retentionDays} days`);
    }
    return { deleted, retentionDays };
  },
});

registerJob({
  name: 'log-retention',
  description: 'App + request + analytics log retention cleanup',
  category: 'Maintenance',
  defaultSchedule: '15 3 * * *',
  handler: async (tenantId) => {
    // Retention tiers (days). Configurable per-tenant via settings keys.
    const settings = await db.prepare(`
      SELECT key, value FROM settings WHERE tenant_id = $1
        AND key IN ('app_log_retention_days', 'request_log_retention_days', 'analytics_retention_days')
    `).all(tenantId);
    const byKey = Object.fromEntries((settings || []).map(s => [s.key, parseInt(s.value)]));
    const appDays       = Math.max(byKey.app_log_retention_days       || 30, 7);
    const reqDays       = Math.max(byKey.request_log_retention_days   || 30, 7);
    const analyticsDays = Math.max(byKey.analytics_retention_days     || 90, 30);

    const pool = db.getPool();
    const results = {};
    for (const [table, days, key] of [
      ['app_logs',         appDays,       'app'],
      ['request_logs',     reqDays,       'request'],
      ['analytics_events', analyticsDays, 'analytics'],
    ]) {
      try {
        const r = await pool.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND created_at < NOW() - make_interval(days => $2)`,
          [tenantId, days]
        );
        results[key] = { deleted: r.rowCount, days };
      } catch (err) {
        results[key] = { error: err.message, days };
      }
    }

    const total = Object.values(results).reduce((sum, r) => sum + (r.deleted || 0), 0);
    if (total > 0) {
      console.log(`[Cron] Log retention (tenant ${tenantId}): ${JSON.stringify(results)}`);
    }
    return results;
  },
});

registerJob({
  name: 'tenant-cleanup',
  description: 'Clean up deleted tenant data after retention period',
  category: 'Maintenance',
  defaultSchedule: '0 3 * * *',
  handler: async (_tenantId) => {
    // This job runs globally (not per-tenant) — find tenants past retention
    const RETENTION_DAYS = 30;
    const expired = await db.prepare(`
      SELECT id, slug FROM tenants
      WHERE status = 'deleted' AND deleted_at IS NOT NULL
        AND deleted_at < NOW() - make_interval(days => $1)
      LIMIT 1
    `).get(RETENTION_DAYS);

    if (!expired) return { cleaned: 0 };

    const tid = expired.id;

    // Clean up storage (R2 / local filesystem) before DB so credentials remain accessible
    const storage = require('./lib/storage');
    let storageResult = { deleted: 0 };
    try {
      storageResult = await storage.removeAll(tid);
    } catch (err) {
      console.warn(`[Cron] Tenant cleanup: storage cleanup failed for tenant ${tid}: ${err.message}`);
    }

    // Delete in dependency order
    const tables = [
      'comment_reactions', 'article_reactions', 'article_favorites',
      'comments', 'articles', 'sources', 'writers', 'categories', 'voices',
      'settings', 'analytics_events', 'ai_usage', 'file_storage', 'saved_searches',
      'summary_cache', 'thumbnail_cache', 'trends_cache', 'trends_history',
      'synthesis_forecasts', 'synthesis_watchlist', 'tenant_domains',
      'tenant_storage_usage',
      'banners',
      'audit_log', 'cron_runs', 'notifications', 'newsletter_sends',
      'app_logs', 'request_logs', 'error_aggregates',
      'roles', 'users',
      'tenant_admins',
    ];
    let totalRows = 0;
    for (const table of tables) {
      try {
        const result = await db.getPool().query(
          `DELETE FROM ${table} WHERE tenant_id = $1`, [tid]
        );
        totalRows += result.rowCount || 0;
      } catch { /* table may not exist or have tenant_id */ }
    }
    // Finally delete the tenant row
    await db.prepare('DELETE FROM tenants WHERE id = $1').run(tid);
    totalRows++;
    console.log(`[Cron] Tenant cleanup: purged tenant ${expired.slug} (id ${tid}), ${totalRows} rows deleted, ${storageResult.deleted} storage files removed`);
    return { cleaned: 1, slug: expired.slug, rowsDeleted: totalRows, storageFilesDeleted: storageResult.deleted };
  },
});

registerJob({
  name: 'tenant-health',
  description: 'Compute tenant health metrics',
  category: 'Monitoring',
  defaultSchedule: '0 4 * * *',
  handler: async (tenantId) => {
    const [articleCount, sourceCount, writerCount, aiSpend, planInfo, lastCron, storageSize] = await Promise.all([
      db.prepare("SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id = $1 AND created_at >= date_trunc('month', NOW())").get(tenantId),
      db.prepare("SELECT COUNT(*)::int AS cnt FROM sources WHERE tenant_id = $1").get(tenantId),
      db.prepare("SELECT COUNT(*)::int AS cnt FROM writers WHERE tenant_id = $1").get(tenantId),
      db.prepare("SELECT COALESCE(SUM(estimated_cost), 0) AS total FROM ai_usage WHERE tenant_id = $1 AND created_at >= date_trunc('month', NOW())").get(tenantId),
      db.prepare("SELECT t.plan, pl.max_ai_cost_month FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan WHERE t.id = $1").get(tenantId),
      db.prepare("SELECT status, finished_at FROM cron_runs WHERE tenant_id = $1 ORDER BY finished_at DESC LIMIT 1").get(tenantId),
      db.prepare("SELECT COALESCE(SUM(size), 0)::bigint AS total FROM file_storage WHERE tenant_id = $1").get(tenantId),
    ]);

    const metrics = {
      articles_month: parseInt(articleCount.cnt),
      ai_spend_month: parseFloat(aiSpend.total),
      ai_limit: planInfo?.max_ai_cost_month ? parseFloat(planInfo.max_ai_cost_month) : null,
      sources: parseInt(sourceCount.cnt),
      writers: parseInt(writerCount.cnt),
      storage_bytes: parseInt(storageSize.total),
      last_cron_status: lastCron?.status || null,
      last_cron_at: lastCron?.finished_at || null,
    };

    // Store as a settings key for easy retrieval
    await db.prepare(
      "INSERT INTO settings (tenant_id, key, value) VALUES ($1, 'tenant_health_metrics', $2) ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2"
    ).run(tenantId, JSON.stringify(metrics));

    // Log warnings for tenants approaching limits
    const warnings = [];
    if (metrics.ai_limit && metrics.ai_spend_month >= metrics.ai_limit * 0.9) {
      warnings.push(`AI spend at ${Math.round(metrics.ai_spend_month / metrics.ai_limit * 100)}% of limit`);
    }
    if (warnings.length) console.log(`[Cron] Tenant health (${tenantId}): ${warnings.join(', ')}`);

    return metrics;
  },
});

registerJob({
  name: 'conversation-retention',
  description: 'Clean up old conversation history',
  category: 'Maintenance',
  defaultSchedule: '0 4 * * *',
  handler: async (tenantId) => {
    const RETENTION_DAYS = 90;
    const result = await db.getPool().query(
      `DELETE FROM conversation_history WHERE tenant_id = $1 AND created_at < NOW() - make_interval(days => $2)`,
      [tenantId, RETENTION_DAYS]
    );
    const deleted = result.rowCount;
    if (deleted > 0) {
      console.log(`[Cron] Conversation retention (tenant ${tenantId}): deleted ${deleted} messages older than ${RETENTION_DAYS} days`);
    }
    // Also clean up orphaned summaries where no recent history exists
    await db.getPool().query(
      `DELETE FROM conversation_summaries WHERE tenant_id = $1 AND updated_at < NOW() - make_interval(days => $2)`,
      [tenantId, RETENTION_DAYS]
    );
    return { deleted, retentionDays: RETENTION_DAYS };
  },
});

registerJob({
  name: 'sweepExpiredActionTokens',
  description: 'Delete action_tokens rows whose expiry is more than 7 days old',
  category: 'Maintenance',
  // Daily at 03:15 — off-peak, after most other maintenance has run.
  defaultSchedule: '15 3 * * *',
  handler: async (tenantId) => {
    const result = await db.getPool().query(
      `DELETE FROM action_tokens
        WHERE tenant_id = $1
          AND expires_at < NOW() - INTERVAL '7 days'`,
      [tenantId]
    );
    const deleted = result.rowCount || 0;
    if (deleted > 0) {
      console.log(`[Cron] sweepExpiredActionTokens (tenant ${tenantId}): deleted ${deleted}`);
      try {
        const { logAudit } = require('./middleware/audit');
        await logAudit(
          { user: { sub: 0 }, tenantId, headers: {}, ip: 'cron' },
          'action_tokens.sweep', 'action_tokens', null,
          { deleted }
        );
      } catch { /* non-fatal */ }
    }
    return { deleted };
  },
});

registerJob({
  name: 'presence-sweep',
  description: 'Reset stale agent presence states to idle',
  category: 'Maintenance',
  defaultSchedule: '*/5 * * * *',
  handler: async (tenantId) => {
    await require('./lib/presence').clearStale(tenantId);
    return { ok: true };
  },
});

registerJob({
  name: 'recomputeImportanceDecay',
  description: 'Decay story-level importance for aging articles (last 72h window)',
  category: 'Content',
  defaultSchedule: '0 * * * *',
  handler: async (tenantId) => {
    const { recomputeDecay } = require('./lib/story-levels');
    return await recomputeDecay(tenantId);
  },
});

// ── Start ───────────────────────────────────────────────────────────
db.init().then(async () => {
  // ── Load saved deployment mode from DB if env var not set ────
  if (db.isDbReady() && !process.env.DEPLOYMENT_MODE) {
    try {
      const row = await db.prepare(
        "SELECT value FROM settings WHERE key = 'deployment_mode' LIMIT 1"
      ).get();
      if (row && (row.value === 'single' || row.value === 'multi')) {
        process.env.DEPLOYMENT_MODE = row.value;
      }
    } catch { /* ignore — table may not exist yet */ }
  }

  // Only start cron jobs if setup is complete (not in first-boot mode)
  if (db.isDbReady() && !(await isSetupMode())) {
    await startAll();
  } else if (db.isDbReady()) {
    console.log('[info] Cron jobs deferred — setup not yet complete');
  }

  // ── Storage health check ─────────────────────────────────────
  let storageBackend = 'unknown';
  try {
    const storage = require('./lib/storage');
    storageBackend = storage.backendName || 'local';
    const health = await storage.healthCheck();
    if (health.ok) {
      console.log(`[storage] Health check passed: ${health.message}`);
    } else {
      console.error(`[storage] Health check FAILED: ${health.message}`);
      console.error('[storage] Image uploads will fail until R2/S3 connectivity is restored. Check SETTINGS_ENCRYPTION_KEY and R2 credentials in Platform Settings.');
    }
  } catch (err) {
    console.error(`[storage] Health check error: ${err.message}`);
  }

  // ── Config warnings ───────────────────────────────────────────
  const { isKeyAutoGenerated: _isAutoKey } = require('./lib/crypto');
  if (_isAutoKey()) {
    console.warn('[warn] SETTINGS_ENCRYPTION_KEY not set — using auto-generated key. Set in .env for persistence across restarts.');
  }
  if (tenantUtils.MULTI_TENANT && !process.env.TENANT_BASE_DOMAIN) {
    console.warn('[warn] Multi-tenant mode active but TENANT_BASE_DOMAIN not set — subdomain routing will not work.');
  }
  if (!tenantUtils.MULTI_TENANT && process.env.TENANT_BASE_DOMAIN) {
    console.warn('[warn] TENANT_BASE_DOMAIN is set but running in single-tenant mode — this variable is ignored.');
  }

  // Check if setup is needed
  const setupNeeded = await isSetupMode();
  if (setupNeeded) {
    console.log('[info] No admin user found — setup wizard available at /setup');
  }

  app.listen(PORT, async () => {
    const version  = require('./package.json').version;
    const mode     = tenantUtils.MULTI_TENANT ? 'MULTI-TENANT' : 'SINGLE-TENANT';
    const instance = process.env.INSTANCE_NAME || 'default';
    console.log('');
    console.log('  ========================================');
    console.log(`  Deep Feed AI v${version}`);
    console.log(`  Mode:     ${mode}`);
    console.log(`  Instance: ${instance}`);
    console.log(`  Port:     ${PORT}`);
    console.log(`  Database: ${db.isDbReady() ? 'connected' : 'NOT CONFIGURED'}`);
    console.log(`  Storage:  ${storageBackend}`);
    if (setupNeeded) console.log('  Status:   SETUP REQUIRED');
    console.log('  ========================================');
    console.log('');

    // Auto-restore Telegram webhook on startup
    try {
      const rows = await db.prepare(
        "SELECT s.tenant_id, s.value AS url FROM settings s WHERE s.key = 'telegram_webhook_url' AND s.value IS NOT NULL AND s.value != ''"
      ).all();
      for (const row of rows) {
        const { setWebhook } = require('./lib/messaging/telegram');
        await setWebhook(row.tenant_id, row.url);
        console.log(`  [telegram] Webhook restored: ${row.url}`);
      }
    } catch (err) {
      console.error('  [telegram] Webhook restore failed:', err.message);
    }

    // Auto-connect Discord Gateway bots on startup
    try {
      const { startAllGateways } = require('./lib/messaging/discord-gateway');
      await startAllGateways();
    } catch (err) {
      console.error('  [discord-gw] Gateway startup failed:', err.message);
    }
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
