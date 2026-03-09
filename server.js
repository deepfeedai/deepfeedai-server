require('dotenv').config({ override: true });
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Middleware ──────────────────────────────────────────────────────
const allowedOrigins = [
  'https://deepfeedai.com',
  'https://www.deepfeedai.com',
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / same-origin
    const ok = allowedOrigins.some(o => typeof o === 'string' ? o === origin : o.test(origin));
    cb(ok ? null : new Error('CORS: origin not allowed'), ok);
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const { router: fetchRouter, fetchAllSources } = require('./routes/fetch');
const cron = require('node-cron');
app.use('/api/fetch', fetchRouter);

// ── Public: news feed ───────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  try {
    const { category, limit: lim, featured } = req.query;
    let query = 'SELECT * FROM articles WHERE is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)';
    const params = [];

    if (category) {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }
    if (featured !== undefined) {
      params.push(parseInt(featured));
      query += ` AND is_featured = $${params.length}`;
    }

    query += ' ORDER BY is_featured DESC, published_at DESC';

    if (lim) {
      params.push(parseInt(lim));
      query += ` LIMIT $${params.length}`;
    }

    const { getPool } = require('./db');
    const result = await getPool().query(query, params.length ? params : undefined);
    const items = result.rows.map(row => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = v instanceof Date ? v.toISOString() : v;
      }
      return out;
    });

    res.json({ status: 'ok', items, count: items.length });
  } catch (err) {
    console.error('[/api/news]', err.message);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// ── Public: cache-bust timestamp ───────────────────────────────────
app.get('/api/news/updated-at', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const row = await db.prepare(
      'SELECT MAX(COALESCE(updated_at, created_at, published_at)) AS ts FROM articles'
    ).get();
    res.json({ updatedAt: row?.ts || null });
  } catch {
    res.json({ updatedAt: null });
  }
});

// ── SPA fallback ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/media/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
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
      console.log(`[Cron] Purged archived articles older than 24h`);
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
