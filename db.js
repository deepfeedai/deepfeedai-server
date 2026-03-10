/**
 * Deep Feed AI Admin — db.js
 * Postgres wrapper (production) via pg + Neon.
 * Exposes the same prepare().run/get/all API as the previous sql.js wrapper,
 * but all methods return Promises — callers must await them.
 */
const { Pool }  = require('pg');
const bcrypt    = require('bcryptjs');

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL environment variable is not set');
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }, // required for Neon / Railway Postgres
      max: 10,
    });
  }
  return pool;
}

// Serialize Date objects to ISO strings so callers get consistent string values
function serializeRow(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

// Convert SQLite-style ? placeholders → Postgres $N
// Convert SQLite datetime() calls → Postgres equivalents
function normalizeSql(sql) {
  let i = 0;
  return sql
    // datetime('now', '-24 hours') → NOW() - INTERVAL '24 hours'
    .replace(/datetime\('now',\s*'([^']+)'\)/gi, (_, offset) => {
      const m = offset.trim().match(/^([+-])(\d+)\s+(\w+)$/);
      if (m) return `NOW() ${m[1] === '-' ? '-' : '+'} INTERVAL '${m[2]} ${m[3]}'`;
      return 'NOW()';
    })
    // datetime('now') → NOW()
    .replace(/datetime\('now'\)/gi, 'NOW()')
    // ? → $1, $2, ...
    .replace(/\?/g, () => `$${++i}`);
}

/**
 * prepare(sql) — mirrors the sql.js synchronous API but returns async methods.
 * Usage: await db.prepare('SELECT ...').all(param1, param2)
 */
function prepare(sql) {
  const pgSql = normalizeSql(sql);
  return {
    run: async function (...params) {
      await getPool().query(pgSql, params.length ? params : undefined);
      return { changes: 1 };
    },
    get: async function (...params) {
      const result = await getPool().query(pgSql, params.length ? params : undefined);
      return serializeRow(result.rows[0] || null);
    },
    all: async function (...params) {
      const result = await getPool().query(pgSql, params.length ? params : undefined);
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
  const existingAdmin = await prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!existingAdmin) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'deepfeedai2026', 10);
    await prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', hash);
    console.log('✅ Seeded admin user');
  }

  // Seed default voice character
  const voiceCount = await prepare('SELECT COUNT(*) as cnt FROM voices').get();
  if (parseInt(voiceCount.cnt) === 0) {
    const defaultVoiceId = process.env.ELEVENLABS_VOICE_ID || '';
    if (defaultVoiceId) {
      await prepare('INSERT INTO voices (name, voice_id, description, is_default) VALUES (?, ?, ?, 1)')
        .run('Default Anchor', defaultVoiceId, 'Default ElevenLabs voice');
      console.log('✅ Seeded default voice');
    }
  }

  // Seed default RSS source
  const existingSource = await prepare('SELECT id FROM sources WHERE url = ?').get(
    'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'
  );
  if (!existingSource) {
    await prepare('INSERT INTO sources (name, url, priority) VALUES (?, ?, ?)').run(
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
