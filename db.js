const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

let db = null;
const dbPath = path.join(__dirname, 'deepfeedai.db');

// Initialize database
async function initDb() {
  if (db) return db;

  const SQL = await initSqlJs();
  
  // Try to load existing database
  let filebuffer;
  try {
    filebuffer = fs.readFileSync(dbPath);
  } catch (e) {
    filebuffer = null;
  }

  db = new SQL.Database(filebuffer);

  // Create tables
  const schema = `
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      summary TEXT,
      content TEXT,
      category TEXT DEFAULT 'Industry',
      source TEXT,
      source_url TEXT,
      image_url TEXT,
      author TEXT,
      is_featured INTEGER DEFAULT 0,
      is_published INTEGER DEFAULT 1,
      is_archived INTEGER DEFAULT 0,
      archived_at TEXT,
      published_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      priority INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      last_fetched TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `;

  try {
    db.run(schema);
  } catch (e) {
    // Tables might already exist
  }

  // Migrations — add columns to existing DBs safely
  const migrations = [
    "ALTER TABLE articles ADD COLUMN is_archived INTEGER DEFAULT 0",
    "ALTER TABLE articles ADD COLUMN archived_at TEXT",
    "ALTER TABLE articles ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))",
    "ALTER TABLE articles ADD COLUMN audio_url TEXT",
    "ALTER TABLE articles ADD COLUMN audio_status TEXT",
    "ALTER TABLE articles ADD COLUMN media_enabled INTEGER DEFAULT 0",
  ];
  for (const m of migrations) {
    try { db.run(m); } catch {} // silently skip if column already exists
  }

  saveDb();

  // Seed admin user
  try {
    const result = db.exec('SELECT id FROM users WHERE username = ?', ['admin']);
    if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
      const hash = bcrypt.hashSync('deepfeedai2026', 10);
      db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', ['admin', hash]);
      saveDb();
      console.log('✅ Seeded admin user');
    }
  } catch (e) {
    console.log('Admin user already exists or seed skipped');
  }

  // Seed default source
  try {
    const result = db.exec('SELECT id FROM sources WHERE url = ?', ['https://www.theverge.com/rss/ai-artificial-intelligence/index.xml']);
    if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
      db.run(
        'INSERT INTO sources (name, url, priority) VALUES (?, ?, ?)',
        ['The Verge AI', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 1]
      );
      saveDb();
      console.log('✅ Seeded default RSS source');
    }
  } catch (e) {
    console.log('Default source already exists or seed skipped');
  }

  return db;
}

function saveDb() {
  if (db) {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(dbPath, buffer);
    } catch (e) {
      console.error('Failed to save database:', e.message);
    }
  }
}

function prepare(sql) {
  return {
    run: function(...params) {
      try {
        db.run(sql, params);
        saveDb();
        return { changes: 1, lastInsertRowid: null };
      } catch (e) {
        throw new Error(e.message || 'Database error');
      }
    },
    get: function(...params) {
      try {
        const result = db.exec(sql, params);
        if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
          return null;
        }
        const cols = result[0].columns;
        const row = result[0].values[0];
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
      } catch (e) {
        console.error('DB get error:', e.message, 'SQL:', sql);
        return null;
      }
    },
    all: function(...params) {
      try {
        const result = db.exec(sql, params);
        if (!result || result.length === 0) return [];
        const cols = result[0].columns;
        if (!result[0].values) return [];
        return result[0].values.map(row => {
          const obj = {};
          cols.forEach((col, i) => { obj[col] = row[i]; });
          return obj;
        });
      } catch (e) {
        console.error('DB all error:', e.message, 'SQL:', sql);
        return [];
      }
    }
  };
}

module.exports = {
  async init() {
    return await initDb();
  },
  prepare,
  run: (sql, params = []) => {
    try {
      db.run(sql, params);
      saveDb();
    } catch (e) {
      console.error('DB run error:', e.message);
    }
  },
  exec: (sql, params = []) => {
    try {
      return db.exec(sql, params);
    } catch (e) {
      console.error('DB exec error:', e.message);
      return [];
    }
  },
  close: () => {
    saveDb();
    if (db) db.close();
  }
};
