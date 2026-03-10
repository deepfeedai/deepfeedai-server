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
      ssl: { rejectUnauthorized: false }, // required for Neon / Railway Postgres
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
  `);

  // Migrations — add columns that may not exist on older DBs
  const migrations = [
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS auto_publish     INTEGER DEFAULT 0`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS auto_publish_max INTEGER DEFAULT 5`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS audio_voice_name TEXT`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS audio_voice_avatar_url TEXT`,
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
