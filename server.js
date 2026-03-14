require('dotenv').config({ override: true });
const express   = require('express');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const db        = require('./db');
const { toSlug } = require('./lib/utils');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Security Headers ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],
      scriptSrcAttr:  ["'unsafe-inline'"], // allow inline onclick handlers in admin panel
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:', 'https:'],
      mediaSrc:       ["'self'", 'https:'],
      connectSrc:     ["'self'"],
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
  message:        { error: 'Too many summary requests. Please try again later.' },
});

const publicApiLimiter = rateLimit({
  windowMs:       60 * 1000, // 1 minute
  max:            120,
  standardHeaders: true,
  legacyHeaders:   false,
  message:        { error: 'Too many requests. Please slow down.' },
});

// ── CORS ───────────────────────────────────────────────────────────
// Public read routes are open to all origins — they serve the main site
// (deepfeedai.com) and any other consumers. JWT auth protects all write
// and admin endpoints, so open CORS on reads is safe.
//
// For cross-origin write/admin requests the ALLOWED_ORIGINS env var is
// used as an allowlist (set in Railway). Same-origin requests (admin panel
// fetching its own API) are always allowed.
const PUBLIC_PATHS = ['/api/news', '/api/article', '/api/summary', '/api/user-auth', '/api/comments', '/api/subscribe', '/api/unsubscribe', '/api/contact', '/api/thumbnail', '/api/trends', '/api/favorites', '/api/article-reactions', '/api/notifications', '/api/read-history', '/api/site-config', '/api/analytics/event', '/api/writers'];

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:4000', 'http://127.0.0.1:4000');
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // No origin header — curl, server-to-server, same-origin in some browsers
  if (!origin) return next();

  // Always set CORS headers for preflight
  const isPublic = PUBLIC_PATHS.some(p => req.path.startsWith(p));

  // Same-origin check
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const serverOrigin = `${proto}://${req.headers.host}`;
  const isSameOrigin = origin === serverOrigin;

  if (!isSameOrigin && !isPublic && !ALLOWED_ORIGINS.includes(origin)) {
    console.error(`[CORS] Blocked: ${origin}`);
    return res.status(403).json({ error: 'CORS: origin not allowed' });
  }

  // Allow the request — public routes get wildcard, others get reflected origin
  res.setHeader('Access-Control-Allow-Origin', isPublic ? '*' : origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (!isPublic) res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }

  next();
});

// ── Body Parsers ───────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Static files ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/articles',  require('./routes/articles'));
app.use('/api/sources',   require('./routes/sources'));
app.use('/api/article',   publicApiLimiter, require('./routes/article'));    // public — single article by slug
app.use('/api/fetch-url', require('./routes/fetch-url')); // admin — OG scraper
app.use('/api/summary',   summaryLimiter,   require('./routes/summary'));    // public — AI TLDR (rate limited)
app.use('/api/media',     require('./routes/media'));
app.use('/api/voices',    require('./routes/voices'));
app.use('/api/writers',   require('./routes/writers'));
app.use('/api/settings',     require('./routes/settings'));
app.use('/api/categories',   require('./routes/categories'));
app.use('/api/site-config',  require('./routes/site-config'));
app.use('/api/analytics',    require('./routes/analytics'));  // POST /event public, GET /summary auth
app.use('/api/news',      publicApiLimiter, require('./routes/news'));       // public — news feed
app.use('/api/user-auth', require('./routes/user-auth')); // public — OAuth for public users
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

const { auth } = require('./middleware/auth');
app.use('/api/ai-usage', auth, require('./routes/ai-usage'));
app.use('/api/synthesis', auth, require('./routes/synthesis'));

const { router: fetchRouter, fetchAllSources, fetchLiveSources } = require('./routes/fetch');
const cron = require('node-cron');
app.use('/api/fetch', fetchRouter);

// ── SPA fallback ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/media/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── Global error handler ────────────────────────────────────────────
// Catches errors forwarded via next(err) from asyncHandler-wrapped routes.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // Don't leak stack traces in production
  const isDev = process.env.NODE_ENV !== 'production';
  console.error('[Error]', err.message, isDev ? err.stack : '');
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: isDev ? err.message : 'Internal server error' });
});

// ── Cron: send weekly newsletter every Monday at 14:00 UTC ─────────
// Mirrors the previous Vercel Cron schedule: "0 14 * * 1"
cron.schedule('0 14 * * 1', async () => {
  const resendKey  = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!resendKey || !audienceId) return; // skip if not configured
  console.log('[Cron] Sending weekly newsletter...');
  try {
    const res = await fetch(`http://localhost:${PORT}/api/newsletter/send`, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-cron-secret':  process.env.CRON_SECRET || '',
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.success) {
      console.log(`[Cron] Newsletter sent — broadcast ${data.broadcastId}, ${data.articleCount} articles`);
    } else {
      console.error('[Cron] Newsletter failed:', data.error);
    }
  } catch (e) {
    console.error('[Cron] Newsletter error:', e.message);
  }
});

// ── Cron: live news auto-fetch every 60 min (if API keys configured) ─
cron.schedule('0 * * * *', async () => {
  if (!process.env.NEWS_API_KEY && !process.env.BRAVE_API_KEY) return;
  console.log('[Cron] Auto-fetching live news sources...');
  try {
    const autoPublishSetting = await db.prepare("SELECT value FROM settings WHERE key = 'auto_publish_live'").get();
    const autoPublish = autoPublishSetting?.value === '1';
    const result = await fetchLiveSources(autoPublish);
    console.log(`[Cron] Live news done — ${result.inserted} new, ${result.skipped} skipped (auto-publish: ${autoPublish})`);
    if (result.errors.length) console.warn('[Cron] Live news errors:', result.errors);
  } catch (e) {
    console.error('[Cron] Live news error:', e.message);
  }
});

// ── Cron: RSS auto-fetch every 30 min ──────────────────────────────
cron.schedule('*/30 * * * *', async () => {
  console.log('[Cron] Auto-fetching RSS sources...');
  try {
    const result = await fetchAllSources(false);
    console.log(`[Cron] Done — ${result.inserted} new, ${result.skipped} skipped`);
  } catch (e) {
    console.error('[Cron] Fetch error:', e.message);
  }
});

// ── Cron: purge expired/used auth codes every 10 min ──────────────
cron.schedule('*/10 * * * *', async () => {
  try {
    await db.prepare(`
      DELETE FROM auth_codes
      WHERE used = 1 OR expires_at <= NOW()
    `).run();
  } catch (e) {
    console.error('[Cron] Auth code cleanup error:', e.message);
  }
});

// ── Cron: purge archived articles past grace period ────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const graceSetting = await db.prepare(`SELECT value FROM settings WHERE key = 'purge_grace_hours'`).get();
    const graceHours = Math.max(parseInt(graceSetting?.value ?? '24', 10) || 24, 1);
    const result = await db.getPool().query(
      `DELETE FROM articles
       WHERE is_archived = 1
         AND archived_at IS NOT NULL
         AND archived_at <= NOW() - ($1 || ' hours')::INTERVAL`,
      [graceHours]
    );
    if (result.rowCount > 0) {
      console.log(`[Cron] Purged ${result.rowCount} archived article(s) older than ${graceHours}h`);
    }
  } catch (e) {
    console.error('[Cron] Purge error:', e.message);
  }
});

// ── Cron: auto-purge old articles (runs nightly at 2 AM) ───────────
cron.schedule('0 2 * * *', async () => {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings WHERE key LIKE $1').all('purge_%');
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (s.purge_enabled !== '1') return;

    const days            = Math.max(parseInt(s.purge_days) || 30, 7);
    const protectFeatured = s.purge_protect_featured !== '0';
    const protectAudio    = s.purge_protect_audio === '1';
    const protectEngaged  = s.purge_protect_engaged === 'true';
    const engagedDays     = Math.max(parseInt(s.purge_protect_engaged_days) || 7, 1);
    const cutoff          = new Date(Date.now() - days * 86400000).toISOString();

    // Build set of engaged article slugs (comments OR reactions within the lookback window)
    let engagedSlugs = new Set();
    if (protectEngaged) {
      const engagedCutoff = new Date(Date.now() - engagedDays * 86400000).toISOString();
      const commentSlugs = await db.prepare(`
        SELECT DISTINCT article_slug FROM comments
        WHERE created_at > $1 AND is_deleted = 0
      `).all(engagedCutoff);
      const reactionSlugs = await db.prepare(`
        SELECT DISTINCT c.article_slug FROM comment_reactions r
        JOIN comments c ON c.id = r.comment_id
        WHERE r.created_at > $1 AND c.is_deleted = 0
      `).all(engagedCutoff);
      for (const row of commentSlugs)  engagedSlugs.add(row.article_slug);
      for (const row of reactionSlugs) engagedSlugs.add(row.article_slug);
    }

    const candidates = await db.prepare(`
      SELECT id, title, is_featured, audio_status, audio_url
      FROM articles
      WHERE is_archived = 0
        AND (created_at < $1 OR (published_at IS NOT NULL AND published_at < $1))
    `).all(cutoff);

    let purged = 0;
    for (const row of candidates) {
      if (protectFeatured && row.is_featured) continue;
      if (protectAudio && row.audio_status === 'ready' && row.audio_url) continue;
      if (protectEngaged && engagedSlugs.has(toSlug(row.title))) continue;
      await db.prepare(`
        UPDATE articles SET is_archived = 1, is_published = 0, is_featured = 0,
          archived_at = NOW(), updated_at = NOW() WHERE id = $1
      `).run(row.id);
      purged++;
    }
    if (purged > 0) console.log(`[AutoPurge] Archived ${purged} article(s) older than ${days} days`);
  } catch (e) {
    console.error('[AutoPurge] Error:', e.message);
  }
});

// ── Cron: synthesis scheduler — runs hourly, honors each writer's synthesis_schedule ──
cron.schedule('0 * * * *', async () => {
  try {
    const { runSynthesisForWriter } = require('./lib/synthesis');
    const writers = await db.prepare('SELECT id, name, synthesis_schedule FROM voices WHERE is_auto = true').all();
    const hour = new Date().getUTCHours();
    const dow  = new Date().getUTCDay(); // 0 = Sunday, 1 = Monday

    for (const w of writers) {
      const schedule = w.synthesis_schedule || 'daily';

      // Determine if this writer should run at this hour
      let shouldRun = false;
      if (schedule === 'daily')       shouldRun = (hour === 6);
      else if (schedule === 'twice-daily') shouldRun = (hour === 6 || hour === 18);
      else if (schedule === 'weekly')      shouldRun = (hour === 6 && dow === 1); // Monday 6 AM
      // 'manual' — never auto-run

      if (!shouldRun) continue;

      console.log(`[Cron] Running ${schedule} synthesis for ${w.name}...`);
      const result = await runSynthesisForWriter(w.id);
      if (result.generated > 0) {
        console.log(`[Cron] Synthesis for ${w.name}: ${result.generated} articles from ${result.clusters} clusters`);
      } else if (result.skipped) {
        console.log(`[Cron] Synthesis for ${w.name} skipped: ${result.skipped}`);
      }
    }
  } catch (e) {
    console.error('[Cron] Synthesis error:', e.message);
  }
});

// ── Cron: daily budget alert check (9 AM UTC) ───────────────────────
cron.schedule('0 9 * * *', async () => {
  try {
    const { checkBudgetAlerts } = require('./lib/budget');
    const alert = await checkBudgetAlerts();
    if (!alert.warn) return;

    // Only send once per day per level — check if we already sent today
    const today = new Date().toISOString().slice(0, 10);
    const alreadySent = await db.prepare(
      `SELECT id FROM ai_usage
       WHERE operation = 'email' AND trigger = 'cron'
         AND error_message IS NULL
         AND created_at >= $1::DATE
       LIMIT 1`
    ).get(today);
    if (alreadySent) return;

    const { sendBudgetAlert } = require('./lib/notify');
    await sendBudgetAlert(alert);
    console.log(`[Cron] Budget alert sent: ${alert.level} (${alert.pctUsed}%)`);
  } catch (e) {
    console.error('[Cron] Budget alert error:', e.message);
  }
});

// ── Cron: auto-audio generation (daily at 8 AM UTC) ─────────────────
cron.schedule('0 8 * * *', async () => {
  try {
    const enabledSetting = await db.prepare("SELECT value FROM settings WHERE key = 'auto_audio_enabled'").get();
    if (enabledSetting?.value !== '1') return;

    const maxSetting = await db.prepare("SELECT value FROM settings WHERE key = 'auto_audio_daily_max'").get();
    const dailyMax = parseInt(maxSetting?.value) || 3;

    // Find top articles without audio: featured, high editorial score, or original content
    const candidates = await db.prepare(`
      SELECT id, title FROM articles
      WHERE is_published = 1 AND is_archived = 0
        AND (audio_status IS NULL OR audio_status = '')
        AND created_at > NOW() - INTERVAL '3 days'
      ORDER BY
        is_featured DESC,
        editorial_score DESC NULLS LAST,
        CASE WHEN content_type = 'original' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT $1
    `).all(dailyMax);

    if (!candidates.length) return;

    const { generateAudioForArticle } = require('./lib/media-helpers');
    let generated = 0;
    for (const article of candidates) {
      const result = await generateAudioForArticle(article.id);
      if (result) {
        generated++;
        console.log(`[Cron] Auto-audio: "${article.title}" (${result.charCount} chars)`);
      }
    }
    if (generated) console.log(`[Cron] Auto-audio: generated ${generated}/${candidates.length}`);
  } catch (e) {
    console.error('[Cron] Auto-audio error:', e.message);
  }
});

// ── Start ───────────────────────────────────────────────────────────
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`🤖 DeepFeedAI Admin running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
