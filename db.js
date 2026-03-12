/**
 * Deep Feed AI Admin — db.js
 * Postgres wrapper (production) via pg + Neon.
 * Exposes the same prepare().run/get/all API as the previous sql.js wrapper,
 * but all methods return Promises — callers must await them.
 */
const { Pool }        = require('pg');
const bcrypt          = require('bcryptjs');
const { serializeRow } = require('./lib/utils');

if (!process.env.ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD environment variable is not set. Refusing to start.');
  process.exit(1);
}

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL environment variable is not set');
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }, // required for Neon / Railway Postgres
      max: 10,
      idleTimeoutMillis: 30000,  // release idle clients after 30s
      connectionTimeoutMillis: 5000,
      keepAlive: true,
    });
    // Swallow pool-level errors so one bad connection doesn't crash the process
    pool.on('error', (err) => {
      console.error('[DB] Pool client error:', err.message);
    });
  }
  return pool;
}

/**
 * prepare(sql) — thin Postgres query wrapper with a familiar API.
 * Accepts native Postgres $N placeholders — no SQLite translation.
 * Usage: await db.prepare('SELECT * FROM t WHERE id = $1').get(id)
 */
function prepare(sql) {
  return {
    run: async function (...params) {
      const result = await getPool().query(sql, params.length ? params : undefined);
      return { changes: result.rowCount ?? 0 };
    },
    get: async function (...params) {
      const result = await getPool().query(sql, params.length ? params : undefined);
      return serializeRow(result.rows[0] || null);
    },
    all: async function (...params) {
      const result = await getPool().query(sql, params.length ? params : undefined);
      return result.rows.map(serializeRow);
    },
  };
}

async function initDb() {
  const p = getPool();

  // Create tables (idempotent — all columns included upfront, no migrations needed)
  await p.query(`
    CREATE TABLE IF NOT EXISTS articles (
      id            SERIAL PRIMARY KEY,
      title         TEXT NOT NULL,
      summary       TEXT,
      content       TEXT,
      category      TEXT DEFAULT 'Industry',
      source        TEXT,
      source_url    TEXT,
      image_url     TEXT,
      author        TEXT,
      is_featured   INTEGER DEFAULT 0,
      is_published  INTEGER DEFAULT 1,
      is_archived   INTEGER DEFAULT 0,
      archived_at   TIMESTAMPTZ,
      published_at  TIMESTAMPTZ DEFAULT NOW(),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      audio_url     TEXT,
      audio_status  TEXT,
      audio_transcript TEXT,
      media_enabled INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sources (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      url              TEXT NOT NULL UNIQUE,
      priority         INTEGER DEFAULT 1,
      is_active        INTEGER DEFAULT 1,
      auto_publish     INTEGER DEFAULT 0,
      auto_publish_max INTEGER DEFAULT 5,
      last_fetched     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public_users (
      id           SERIAL PRIMARY KEY,
      provider     TEXT NOT NULL,
      provider_id  TEXT NOT NULL,
      email        TEXT,
      display_name TEXT NOT NULL,
      avatar_url   TEXT,
      is_banned    INTEGER DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(provider, provider_id)
    );

    CREATE TABLE IF NOT EXISTS auth_codes (
      code        TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used        INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_auth_codes_user_id ON auth_codes(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes(expires_at);

    CREATE TABLE IF NOT EXISTS comments (
      id           SERIAL PRIMARY KEY,
      article_slug TEXT NOT NULL,
      user_id      INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      body         TEXT,
      parent_id    INTEGER REFERENCES comments(id) ON DELETE SET NULL,
      is_deleted   INTEGER DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_comments_slug    ON comments(article_slug);
    CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id);
    CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments(parent_id);

    CREATE TABLE IF NOT EXISTS comment_reports (
      id         SERIAL PRIMARY KEY,
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      reason     TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(comment_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS voices (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      voice_id    TEXT NOT NULL,
      description TEXT,
      avatar_url  TEXT,
      is_default  INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS summary_cache (
      cache_key  TEXT PRIMARY KEY,
      payload    JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS thumbnail_cache (
      cache_key  TEXT PRIMARY KEY,
      payload    JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS trends_cache (
      id         SERIAL PRIMARY KEY,
      payload    JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS trends_history (
      snapshot_date DATE PRIMARY KEY,
      payload       JSONB NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // article_reactions — 👍/❤️ reactions on articles (one per user per article)
  await p.query(`
    CREATE TABLE IF NOT EXISTS article_reactions (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      article_slug TEXT NOT NULL,
      emoji        TEXT NOT NULL CHECK (emoji IN ('👍', '❤️')),
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, article_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_article_reactions_slug ON article_reactions(article_slug);
    CREATE INDEX IF NOT EXISTS idx_article_reactions_user ON article_reactions(user_id);
  `);

  // comment_reactions table — one emoji reaction per user per comment
  await p.query(`
    CREATE TABLE IF NOT EXISTS comment_reactions (
      id         SERIAL PRIMARY KEY,
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      emoji      TEXT NOT NULL DEFAULT '👍',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(comment_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_comment ON comment_reactions(comment_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_user    ON comment_reactions(user_id);
  `);

  // Migrations — add columns that may not exist on older DBs
  const migrations = [
    `ALTER TABLE sources  ADD COLUMN IF NOT EXISTS auto_publish            INTEGER DEFAULT 0`,
    `ALTER TABLE sources  ADD COLUMN IF NOT EXISTS auto_publish_max        INTEGER DEFAULT 5`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS audio_voice_name        TEXT`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS audio_voice_avatar_url  TEXT`,
    // Moderation queue: 0 = pending review, 1 = approved (default 1 = legacy rows stay visible)
    `ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_approved             INTEGER DEFAULT 1`,
    // Spam detection: score 0.0–1.0 from Perspective API; reason = matched rule or 'perspective'
    `ALTER TABLE comments ADD COLUMN IF NOT EXISTS spam_score              NUMERIC(4,3)`,
    `ALTER TABLE comments ADD COLUMN IF NOT EXISTS spam_reason             TEXT`,
    // Reply notifications: opt-in flag + unsubscribe token
    `ALTER TABLE public_users ADD COLUMN IF NOT EXISTS notify_replies      INTEGER DEFAULT 1`,
    `ALTER TABLE public_users ADD COLUMN IF NOT EXISTS notify_token        TEXT`,
    // Phase 3: track article origin — 'rss' | 'newsapi' | 'brave'
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS source_type             TEXT DEFAULT 'rss'`,
    // Lifecycle settings: seed defaults if not already present
    `INSERT INTO settings (key, value) VALUES ('purge_grace_hours', '24')         ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('purge_protect_engaged', 'false')   ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('purge_protect_engaged_days', '7')  ON CONFLICT (key) DO NOTHING`,
  ];
  for (const sql of migrations) {
    try { await p.query(sql); } catch { /* already exists */ }
  }

  // Seed admin user
  const existingAdmin = await prepare('SELECT id FROM users WHERE username = $1').get('admin');
  if (!existingAdmin) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    await prepare('INSERT INTO users (username, password_hash) VALUES ($1, $2)').run('admin', hash);
    console.log('✅ Seeded admin user');
  }

  // Seed default voice character
  const voiceCount = await prepare('SELECT COUNT(*) as cnt FROM voices').get();
  if (parseInt(voiceCount.cnt) === 0) {
    const defaultVoiceId = process.env.ELEVENLABS_VOICE_ID || '';
    if (defaultVoiceId) {
      await prepare('INSERT INTO voices (name, voice_id, description, is_default) VALUES ($1, $2, $3, 1)')
        .run('Default Anchor', defaultVoiceId, 'Default ElevenLabs voice');
      console.log('✅ Seeded default voice');
    }
  }

  // Seed default RSS source
  const existingSource = await prepare('SELECT id FROM sources WHERE url = $1').get(
    'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'
  );
  if (!existingSource) {
    await prepare('INSERT INTO sources (name, url, priority) VALUES ($1, $2, $3)').run(
      'The Verge AI',
      'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
      1
    );
    console.log('✅ Seeded default RSS source');
  }

  console.log('✅ Postgres database initialized');
  return p;
}

module.exports = { init: initDb, prepare, getPool };
