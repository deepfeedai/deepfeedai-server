require('dotenv').config({ override: true });
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Security Headers ───────────────────────────────────────────────
app.use(helmet());

// ── CORS ───────────────────────────────────────────────────────────
// Restrict to known origins. Public API routes (/api/news, /api/article,
// /api/summary) need to allow the main site; admin routes are JWT-protected
// but we still limit origins as a defence-in-depth measure.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Always allow localhost in dev when no env var is set
if (ALLOWED_ORIGINS.length === 0) {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:4000', 'http://127.0.0.1:4000');
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, mobile apps, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Body Parsers ───────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Static files ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/articles',  require('./routes/articles'));
app.use('/api/sources',   require('./routes/sources'));
app.use('/api/article',   require('./routes/article'));    // public — single article by slug
app.use('/api/fetch-url', require('./routes/fetch-url')); // admin — OG scraper
app.use('/api/summary',   require('./routes/summary'));    // public — AI TLDR
app.use('/api/media',     require('./routes/media'));
app.use('/api/voices',    require('./routes/voices'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/news',      require('./routes/news'));       // public — news feed

const { router: fetchRouter, fetchAllSources } = require('./routes/fetch');
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

// ── Cron: purge archived articles older than 24h ───────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const result = await db.prepare(`
      DELETE FROM articles
      WHERE is_archived = 1
        AND archived_at IS NOT NULL
        AND archived_at <= NOW() - INTERVAL '24 hours'
    `).run();
    if (result.changes > 0) {
      console.log(`[Cron] Purged ${result.changes} archived article(s) older than 24h`);
    }
  } catch (e) {
    console.error('[Cron] Purge error:', e.message);
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
