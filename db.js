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

  // article_favorites — user bookmarks (one row per user+slug)
  await p.query(`
    CREATE TABLE IF NOT EXISTS article_favorites (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      article_slug TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, article_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_article_favorites_user ON article_favorites(user_id);
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

  // notifications — in-app notification center
  await p.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      type       TEXT NOT NULL DEFAULT 'reply',
      payload    JSONB NOT NULL,
      read_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
      ON notifications(user_id, read_at) WHERE read_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created
      ON notifications(user_id, created_at DESC);
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
    // Featured articles priority (1–3); NULL = not featured
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS featured_priority       INTEGER DEFAULT NULL`,
    // Analytics events — lightweight time-series for views, audio plays, shares
    `CREATE TABLE IF NOT EXISTS analytics_events (
      id           SERIAL PRIMARY KEY,
      event_type   TEXT        NOT NULL,
      article_slug TEXT,
      category     TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_analytics_created  ON analytics_events (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_analytics_slug     ON analytics_events (article_slug)`,
    `CREATE INDEX IF NOT EXISTS idx_analytics_type     ON analytics_events (event_type)`,
    // Newsletter send history
    `CREATE TABLE IF NOT EXISTS newsletter_sends (
      id           SERIAL PRIMARY KEY,
      sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      subject      TEXT,
      article_count INTEGER,
      broadcast_id TEXT,
      status       TEXT NOT NULL DEFAULT 'sent'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_newsletter_sends_sent_at ON newsletter_sends (sent_at DESC)`,
    // Lifecycle settings: seed defaults if not already present
    `INSERT INTO settings (key, value) VALUES ('purge_grace_hours', '24')         ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('purge_protect_engaged', 'false')   ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('purge_protect_engaged_days', '7')  ON CONFLICT (key) DO NOTHING`,
    // Site customization defaults (white-label)
    `INSERT INTO settings (key, value) VALUES ('site_name', 'Deep Feed AI') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_short_name', 'DeepFeedAI') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_tagline', 'Your daily signal in the AI noise') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_description', 'Curated AI news powered by machine learning and human curation.') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_logo_emoji', '🤖') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_logo_html', '🤖&nbsp;Deep Feed<span class="accent">AI</span>') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_domain', 'deepfeedai.com') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_url', 'https://deepfeedai.com') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_og_image', '/og-preview.png') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_twitter_handle', '@deepfeedai') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_copyright', 'Deep Feed AI') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_footer_tagline', 'Built with ❤️ for the AI-curious') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_ga_id', 'G-WEJ64FE38R') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_adsense_id', 'ca-pub-5739407654850583') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_categories', '${JSON.stringify([{"name":"LLMs","color":"#7c3aed"},{"name":"Image AI","color":"#0ea5e9"},{"name":"Research","color":"#22d3ee"},{"name":"Tools","color":"#34d399"},{"name":"Business","color":"#f59e0b"},{"name":"Policy","color":"#f97316"},{"name":"CyberSecurity","color":"#ef4444"},{"name":"Industry","color":"#94a3b8"}])}') ON CONFLICT (key) DO NOTHING`,
    // AI budget settings
    `INSERT INTO settings (key, value) VALUES ('ai_daily_budget', '5.00') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('ai_monthly_budget', '50.00') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('ai_budget_warn_pct', '80') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_accent_color', '#4F8EF7') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_bg_color', '#0d1117') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_ai_persona', 'You are a tech news analyst for Deep Feed AI, an AI news aggregator.') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_newsletter_subject', '🤖 Deep Feed AI — Your Weekly AI Digest') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_email_from_name', 'Deep Feed AI') ON CONFLICT (key) DO NOTHING`,
    // Writer persona columns on voices
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS bio TEXT`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS beat TEXT`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS keywords TEXT[]`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS system_prompt TEXT`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS is_auto BOOLEAN DEFAULT false`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS synthesis_schedule TEXT DEFAULT 'daily'`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS synthesis_lookback_hours INTEGER DEFAULT 168`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS min_cluster_size INTEGER DEFAULT 3`,
    // AI usage tracking table
    `CREATE TABLE IF NOT EXISTS ai_usage (
      id              SERIAL PRIMARY KEY,
      provider        TEXT NOT NULL,
      model           TEXT,
      operation       TEXT NOT NULL,
      article_slug    TEXT,
      writer_id       INTEGER,
      trigger         TEXT DEFAULT 'manual',
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      characters      INTEGER,
      image_count     INTEGER,
      email_count     INTEGER,
      estimated_cost  NUMERIC(10,6),
      duration_ms     INTEGER,
      success         BOOLEAN DEFAULT true,
      error_message   TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_provider  ON ai_usage (provider)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_operation ON ai_usage (operation)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_created   ON ai_usage (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_writer    ON ai_usage (writer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_slug      ON ai_usage (article_slug)`,
    // Writer persona columns on articles
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS slug TEXT`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS writer_id INTEGER REFERENCES voices(id) ON DELETE SET NULL`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_type TEXT DEFAULT 'curated'`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS source_article_ids JSONB DEFAULT '[]'`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS full_content TEXT`,
    // Editorial scoring for quality gate
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS editorial_score INTEGER`,
    // Quality gate settings
    `INSERT INTO settings (key, value) VALUES ('daily_publish_target', '20') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('auto_editorial_scoring', '1') ON CONFLICT (key) DO NOTHING`,
    // Phase 3: Full autonomy settings
    `INSERT INTO settings (key, value) VALUES ('auto_publish_live', '0') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('auto_publish_quality_gate', '1') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('auto_audio_enabled', '0') ON CONFLICT (key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('auto_audio_daily_max', '3') ON CONFLICT (key) DO NOTHING`,
    // TLDR column for writer analysis
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS tldr_overview TEXT`,
    // Phase 4: Writer follows
    `CREATE TABLE IF NOT EXISTS writer_follows (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      writer_id  INTEGER NOT NULL REFERENCES voices(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, writer_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_writer_follows_user   ON writer_follows(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_writer_follows_writer ON writer_follows(writer_id)`,
  ];
  for (const sql of migrations) {
    try { await p.query(sql); } catch { /* already exists */ }
  }

  // Backfill slugs for any voices missing one
  try {
    const noSlug = await prepare('SELECT id, name FROM voices WHERE slug IS NULL OR slug = \'\'').all();
    for (const v of noSlug) {
      const slug = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      try { await prepare('UPDATE voices SET slug = $1 WHERE id = $2').run(slug, v.id); } catch { /* slug conflict, skip */ }
    }
  } catch { /* non-fatal */ }

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
