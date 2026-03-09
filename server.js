require('dotenv').config({ override: true }); // ensure .env takes precedence over system env
const express = require('express');
const cors = require('cors');
const path = require('path');

// Initialize DB
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static admin frontend
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/articles', require('./routes/articles'));
app.use('/api/sources', require('./routes/sources'));
app.use('/api/article',   require('./routes/article'));   // public — single article by slug
app.use('/api/fetch-url', require('./routes/fetch-url')); // autofill article form from URL
app.use('/api/summary',   require('./routes/summary'));   // public — AI TLDR for article page

const { router: fetchRouter, fetchAllSources } = require('./routes/fetch');
const cron = require('node-cron');

app.use('/api/fetch', fetchRouter);
app.use('/api/media', require('./routes/media'));

// Auto-fetch every 30 minutes — articles saved as drafts (is_published=0)
cron.schedule('*/30 * * * *', async () => {
  console.log('[Cron] Auto-fetching RSS sources...');
  const result = await fetchAllSources(false);
  console.log(`[Cron] Done — ${result.inserted} new, ${result.skipped} skipped`);
});

// Purge archived articles older than 24 hours — runs every hour
cron.schedule('0 * * * *', () => {
  try {
    const result = db.prepare(`
      DELETE FROM articles
      WHERE is_archived = 1
        AND archived_at IS NOT NULL
        AND archived_at <= datetime('now', '-24 hours')
    `).run();
    if (result.changes > 0) {
      console.log(`[Cron] Purged ${result.changes} archived article(s) older than 24h`);
    }
  } catch (e) {
    console.error('[Cron] Purge error:', e.message);
  }
});

// Public API — no auth — for the main Deep Feed AI site
app.get('/api/news', (req, res) => {
  const { category, limit: lim, featured } = req.query;
  let query = 'SELECT * FROM articles WHERE is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)';
  const params = [];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (featured !== undefined) {
    query += ' AND is_featured = ?';
    params.push(parseInt(featured));
  }

  // Featured articles always float to the top, then sort by date
  query += ' ORDER BY is_featured DESC, published_at DESC';

  if (lim) {
    query += ' LIMIT ?';
    params.push(parseInt(lim));
  }

  const articles = db.prepare(query).all(...params);
  res.json({ status: 'ok', items: articles, count: articles.length });
});

// Lightweight cache-bust check — returns the latest updated_at across ALL articles
// (including archived/unpublished) so any admin action busts the main site cache
app.get('/api/news/updated-at', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const row = db.prepare(
      `SELECT MAX(COALESCE(updated_at, created_at, published_at)) AS ts FROM articles`
    ).get();
    res.json({ updatedAt: row?.ts || null });
  } catch {
    res.json({ updatedAt: null });
  }
});

// Fallback — serve index.html for unknown routes (SPA-style)
app.get('*', (req, res) => {
  // Only fallback for non-API routes
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Initialize DB and start server
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`🤖 DeepFeedAI Admin running at http://localhost:${PORT}`);
    console.log(`   Dashboard: http://localhost:${PORT}/index.html`);
    console.log(`   API:       http://localhost:${PORT}/api/`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
