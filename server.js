require('dotenv').config();
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

// Public API — no auth — for the main Deep Feed AI site
app.get('/api/news', (req, res) => {
  const { category, limit: lim, featured } = req.query;
  let query = 'SELECT * FROM articles WHERE is_published = 1';
  const params = [];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (featured !== undefined) {
    query += ' AND is_featured = ?';
    params.push(parseInt(featured));
  }

  query += ' ORDER BY published_at DESC';

  if (lim) {
    query += ' LIMIT ?';
    params.push(parseInt(lim));
  }

  const articles = db.prepare(query).all(...params);
  res.json({ status: 'ok', items: articles, count: articles.length });
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
