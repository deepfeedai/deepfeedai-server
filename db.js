/**
 * Deep Feed AI Admin — db.js
 * Postgres wrapper (production) via pg + Neon.
 * Exposes the same prepare().run/get/all API as the previous sql.js wrapper,
 * but all methods return Promises — callers must await them.
 */
const { Pool }        = require('pg');
const crypto          = require('crypto');
const bcrypt          = require('bcryptjs');
const { serializeRow } = require('./lib/utils');

// ADMIN_PASSWORD is optional — if not set, the first-boot setup wizard handles admin creation.

let pool = null;
let _dbReady = false; // true once initDb() has completed successfully

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) return null;
    pool = _createPool(connectionString);
  }
  return pool;
}

function _createPool(connectionString) {
  const p = new Pool({
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
  p.on('error', (err) => {
    console.error('[DB] Pool client error:', err.message);
  });
  return p;
}

/** Returns true if the database is connected and initialized. */
function isDbReady() { return _dbReady; }

/**
 * Connect to a database at runtime (from setup wizard).
 * Sets DATABASE_URL, creates the pool, runs initDb(), and writes to .env.
 */
async function connectAndInit(url) {
  // Test the connection first
  const testPool = _createPool(url);
  try {
    await testPool.query('SELECT 1');
  } finally {
    await testPool.end();
  }

  // Set the env var so getPool() and other modules pick it up
  process.env.DATABASE_URL = url;
  pool = _createPool(url);
  await initDb();

  // Write to .env for persistence
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  try {
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
    }
    // Replace existing DATABASE_URL or append
    if (/^DATABASE_URL=/m.test(content)) {
      content = content.replace(/^DATABASE_URL=.*/m, `DATABASE_URL="${url}"`);
    } else {
      content = `DATABASE_URL="${url}"\n` + content;
    }
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err) {
    console.warn('[DB] Could not write DATABASE_URL to .env:', err.message);
  }
}

/**
 * prepare(sql) — thin Postgres query wrapper with a familiar API.
 * Accepts native Postgres $N placeholders — no SQLite translation.
 * Usage: await db.prepare('SELECT * FROM t WHERE id = $1').get(id)
 */
function prepare(sql) {
  return {
    run: async function (...params) {
      const p = getPool();
      if (!p) throw new Error('Database not connected');
      const result = await p.query(sql, params.length ? params : undefined);
      return { changes: result.rowCount ?? 0 };
    },
    get: async function (...params) {
      const p = getPool();
      if (!p) throw new Error('Database not connected');
      const result = await p.query(sql, params.length ? params : undefined);
      return serializeRow(result.rows[0] || null);
    },
    all: async function (...params) {
      const p = getPool();
      if (!p) throw new Error('Database not connected');
      const result = await p.query(sql, params.length ? params : undefined);
      return result.rows.map(serializeRow);
    },
  };
}

async function initDb() {
  const p = getPool();
  if (!p) {
    console.warn('[DB] DATABASE_URL not set — skipping initialization. Setup wizard will configure the database.');
    return null;
  }

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
      key        TEXT NOT NULL,
      value      TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      tenant_id  INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (tenant_id, key)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      color       TEXT DEFAULT '#94a3b8',
      keywords    TEXT[] DEFAULT '{}',
      sort_order  INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS writers (
      id                       SERIAL PRIMARY KEY,
      name                     TEXT NOT NULL,
      slug                     TEXT UNIQUE,
      avatar_url               TEXT,
      bio                      TEXT,
      beat                     TEXT,
      keywords                 TEXT[] DEFAULT '{}',
      system_prompt            TEXT,
      is_auto                  BOOLEAN DEFAULT false,
      synthesis_schedule       TEXT DEFAULT 'daily',
      synthesis_lookback_hours INTEGER DEFAULT 168,
      min_cluster_size         INTEGER DEFAULT 2,
      voice_id                 INTEGER REFERENCES voices(id) ON DELETE SET NULL,
      created_at               TIMESTAMPTZ DEFAULT NOW()
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
    `ALTER TABLE sources  ADD COLUMN IF NOT EXISTS default_category        TEXT`,
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
    `INSERT INTO settings (key, value) VALUES ('purge_grace_hours', '24')         ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('purge_protect_engaged', 'false')   ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('purge_protect_engaged_days', '7')  ON CONFLICT (tenant_id, key) DO NOTHING`,
    // Site customization defaults (white-label)
    `INSERT INTO settings (key, value) VALUES ('site_name', 'Deep Feed AI') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_short_name', 'DeepFeedAI') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_tagline', 'Your daily signal in the AI noise') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_description', 'Curated AI news powered by machine learning and human curation.') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_logo_emoji', '🤖') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_logo_html', '🤖&nbsp;Deep Feed<span class="accent">AI</span>') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_domain', 'deepfeedai.com') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_url', 'https://deepfeedai.com') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_og_image', '/og-preview.png') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_twitter_handle', '@deepfeedai') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_copyright', 'Deep Feed AI') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_footer_tagline', 'Built with ❤️ for the AI-curious') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_ga_id', 'G-WEJ64FE38R') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_adsense_id', 'ca-pub-5739407654850583') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_categories', '${JSON.stringify([
      {"name":"LLMs","color":"#7c3aed","keywords":["gpt-3","gpt-4","gpt4o","gpt-5","o1-preview","o1-mini","o3","o3-mini","o4-mini","claude","sonnet","opus","haiku","gemini","gemini pro","gemini ultra","llama","mistral","mixtral","falcon","phi","qwen","deepseek","grok","command r","llm","llms","large language model","language model","foundation model","base model","multimodal model","vision language","text generation","context window","system prompt","prompt engineering","few-shot","zero-shot","chain of thought","retrieval augmented","rag","tokenizer","transformer","attention mechanism","token limit","inference","openai","anthropic","cohere","ai21","mistral ai","together ai","perplexity","xai","inflection","groq"]},
      {"name":"Image AI","color":"#0ea5e9","keywords":["midjourney","dall-e","stable diffusion","stability ai","ideogram","firefly","leonardo","flux","sora","runway","kling","pika","gen-2","gen-3","veo","lumiere","cogvideo","imagen","text to image","text to video","image generation","video generation","image synthesis","diffusion model","latent diffusion","generative image","ai art","ai generated image","text to speech","speech synthesis","voice cloning","tts","audio generation","music generation","suno","udio","synthetic media","ai video","ai image","visual generation","inpainting","outpainting","img2img"]},
      {"name":"Research","color":"#22d3ee","keywords":["arxiv","neurips","icml","iclr","acl","emnlp","cvpr","iccv","naacl","preprint","research paper","new paper","paper proposes","paper introduces","dataset","benchmark","evaluation framework","evals","ablation","hyperparameter","alignment","interpretability","mechanistic interpretability","scaling law","emergent ability","adversarial robustness","pretraining","fine-tuning","rlhf","dpo","reward model","constitutional ai","ai safety research","ai alignment","hallucination","hallucinations","researchers found","researchers developed","researchers propose","university researchers","deepmind research","google brain","openai research","meta research","peer review","state of the art","novel approach","breakthrough"]},
      {"name":"Tools","color":"#34d399","keywords":["github copilot","cursor ai","codeium","tabnine","codex","devin","replit","aider","mcp","model context protocol","function calling","tool use","ai agent","agentic","multi-agent","autonomous agent","chatbot","ai assistant","virtual assistant","copilot","workflow automation","ai coding","code generation","ai developer tool","no-code","low-code","zapier","n8n","automation platform","langchain","llamaindex","vector database","pinecone","weaviate","chroma","ai search","semantic search","ai api","developer platform"]},
      {"name":"Business","color":"#f59e0b","keywords":["series a","series b","series c","seed round","venture round","funding round","raised $","secures $","acquisition","merger","ipo","valuation","unicorn","spac","ai funding","ai investment","ai investor","venture capital","andreessen","sequoia","a16z","softbank","revenue","earnings","quarterly earnings","fiscal quarter","market share","share price","ai startup","ai company","layoff","laid off","job cuts","restructuring","downsizing","ai partnership","ai deal","enterprise ai","billion dollar","market cap"]},
      {"name":"Policy","color":"#f97316","keywords":["eu ai act","ai act","executive order","ai regulation","ai bill","ai law","ai legislation","ai lawsuit","sued over ai","ai litigation","court ruling","ai settlement","ftc","doj","congress","senate","parliament","ai regulation","ai legislation","ai policy","ai compliance","gdpr","ccpa","biometric","ai copyright","intellectual property","fair use","training data lawsuit","ai ethics","algorithmic bias","ai fairness","ai transparency","misinformation","disinformation","deepfake legislation","ai governance","ai oversight","ai moratorium","ai accountability","data privacy"]},
      {"name":"CyberSecurity","color":"#ef4444","keywords":["cyberattack","cyber attack","ransomware","malware","phishing","zero day","zero-day","exploit","vulnerability","cve","ai security","llm security","prompt injection","jailbreak","adversarial attack","model theft","model extraction","hacker","hacking","data breach","intrusion","threat actor","apt","nation state","cybersecurity","infosec","soc","siem","threat intelligence","penetration testing","red team security","ai powered attack","ai generated phishing","deepfake fraud","voice clone fraud","security vulnerability","security flaw","cybercrime","botnet","supply chain attack","credential stuffing"]},
      {"name":"Industry","color":"#94a3b8","keywords":["ai in healthcare","ai in education","ai in finance","ai in entertainment","ai in gaming","ai in manufacturing","ai in retail","ai in agriculture","ai in legal","ai in automotive","self-driving","autonomous vehicle","robotics","robot","humanoid","ai adoption","digital transformation","ai strategy","ai workforce","ai jobs","ai replace","ai impact","ai powered","artificial intelligence","generative ai","machine learning","deep learning","neural network","computer vision","natural language processing","nlp","ai chip","ai hardware","gpu","tpu","nvidia","amd","intel ai","qualcomm ai","edge ai","on-device ai","ai infrastructure","cloud ai","ai market","ai industry","ai trend","ai forecast","ai report"]}
    ])}') ON CONFLICT (tenant_id, key) DO NOTHING`,
    // AI budget settings
    `INSERT INTO settings (key, value) VALUES ('ai_daily_budget', '5.00') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('ai_monthly_budget', '50.00') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('ai_budget_warn_pct', '80') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_accent_color', '#4F8EF7') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_bg_color', '#0d1117') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_ai_persona', 'You are a tech news analyst for Deep Feed AI, an AI news aggregator.') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_newsletter_subject', '🤖 Deep Feed AI — Your Weekly AI Digest') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('site_email_from_name', 'Deep Feed AI') ON CONFLICT (tenant_id, key) DO NOTHING`,
    // Writer persona columns on voices
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS bio TEXT`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS beat TEXT`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS keywords TEXT[]`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS system_prompt TEXT`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS is_auto BOOLEAN DEFAULT false`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS synthesis_schedule TEXT DEFAULT 'daily'`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS synthesis_lookback_hours INTEGER DEFAULT 168`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS min_cluster_size INTEGER DEFAULT 2`,
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
    // YouTube/video embed support
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS embed_url TEXT`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS embed_type TEXT`,
    // Inline AI images for originals & deep dives
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS inline_images JSONB DEFAULT '[]'`,
    // Editorial scoring for quality gate
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS editorial_score INTEGER`,
    // Quality gate settings
    `INSERT INTO settings (key, value) VALUES ('daily_publish_target', '20') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('auto_editorial_scoring', '1') ON CONFLICT (tenant_id, key) DO NOTHING`,
    // Phase 3: Full autonomy settings
    `INSERT INTO settings (key, value) VALUES ('auto_publish_live', '0') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('auto_publish_quality_gate', '1') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('auto_audio_enabled', '0') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('auto_audio_daily_max', '3') ON CONFLICT (tenant_id, key) DO NOTHING`,
    // TLDR column for writer analysis
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS tldr_overview TEXT`,
    // Synthesis metadata (source count, names, timespan, word count)
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS synthesis_meta JSONB`,
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
    // Phase 2: Multi-beat writers junction table
    `CREATE TABLE IF NOT EXISTS writer_beats (
      id          SERIAL PRIMARY KEY,
      writer_id   INTEGER NOT NULL REFERENCES writers(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      UNIQUE(writer_id, category_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_writer_beats_writer   ON writer_beats(writer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_writer_beats_category ON writer_beats(category_id)`,
    // ── Multi-tenancy: tenant_id columns on all tenanted tables ──
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE voices ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS elevenlabs_voice_id TEXT`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE comments ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE comment_reactions ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE comment_reports ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE article_favorites ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE article_reactions ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE writer_follows ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE writer_beats ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE summary_cache ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE thumbnail_cache ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE trends_cache ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE trends_history ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `CREATE UNIQUE INDEX IF NOT EXISTS trends_history_tenant_date ON trends_history(tenant_id, snapshot_date)`,
    // Indexes for tenant_id on high-volume tables
    `CREATE INDEX IF NOT EXISTS idx_articles_tenant ON articles(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sources_tenant ON sources(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_categories_tenant ON categories(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_writers_tenant ON writers(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_tenant ON comments(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_settings_tenant ON settings(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_analytics_events_tenant ON analytics_events(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant ON ai_usage(tenant_id)`,
    // Update unique constraints to include tenant_id
    // categories: (name) → (tenant_id, name) — drop old, add new
    `ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS categories_tenant_name ON categories(tenant_id, name)`,
    // settings: (key) → (tenant_id, key)
    `ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey`,
    `ALTER TABLE settings ADD CONSTRAINT settings_pkey PRIMARY KEY (tenant_id, key)`,
    // sources: (url) → (tenant_id, url)
    `ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_url_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sources_tenant_url ON sources(tenant_id, url)`,
    // Multi-tenancy platform tables
    `CREATE TABLE IF NOT EXISTS tenants (
      id                     SERIAL PRIMARY KEY,
      uuid                   UUID DEFAULT gen_random_uuid(),
      slug                   TEXT NOT NULL UNIQUE,
      display_name           TEXT NOT NULL,
      owner_user_id          INTEGER REFERENCES public_users(id) ON DELETE SET NULL,
      custom_domain          TEXT,
      plan                   TEXT NOT NULL DEFAULT 'starter',
      status                 TEXT NOT NULL DEFAULT 'active',
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      deleted_at             TIMESTAMPTZ,
      suspended_at           TIMESTAMPTZ,
      suspension_reason      TEXT,
      trial_ends_at          TIMESTAMPTZ,
      is_platform            BOOLEAN DEFAULT false
    )`,
    `CREATE TABLE IF NOT EXISTS plan_limits (
      plan                   TEXT PRIMARY KEY,
      max_sources            INTEGER,
      max_writers            INTEGER,
      max_articles_month     INTEGER,
      max_ai_cost_month      NUMERIC(10,2),
      audio_enabled          BOOLEAN DEFAULT false,
      custom_domain_enabled  BOOLEAN DEFAULT false
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_admins (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      email      TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'owner',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, user_id)
    )`,
    `INSERT INTO plan_limits (plan, max_sources, max_writers, max_articles_month, max_ai_cost_month, audio_enabled, custom_domain_enabled) VALUES
      ('free', 3, 1, 25, 0.00, false, false),
      ('starter', 10, 4, 250, 5.00, false, false),
      ('pro', 50, 20, 2000, 20.00, true, true),
      ('business', NULL, NULL, NULL, 50.00, true, true),
      ('internal', NULL, NULL, NULL, NULL, true, true)
     ON CONFLICT (plan) DO NOTHING`,
    // Seed the original site as tenant_id=1 so existing data (DEFAULT 1) maps correctly
    `INSERT INTO tenants (id, slug, display_name, plan, status, is_platform)
     VALUES (1, 'deepfeedai', 'Deep Feed AI', 'business', 'active', true)
     ON CONFLICT (id) DO UPDATE SET is_platform = true`,
    // Fix cache table PKs: cache_key alone → (tenant_id, cache_key) compound PK
    `ALTER TABLE summary_cache DROP CONSTRAINT IF EXISTS summary_cache_pkey`,
    `DO $$ BEGIN
       ALTER TABLE summary_cache ADD CONSTRAINT summary_cache_pkey PRIMARY KEY (tenant_id, cache_key);
     EXCEPTION WHEN others THEN NULL;
     END $$`,
    `ALTER TABLE thumbnail_cache DROP CONSTRAINT IF EXISTS thumbnail_cache_pkey`,
    `DO $$ BEGIN
       ALTER TABLE thumbnail_cache ADD CONSTRAINT thumbnail_cache_pkey PRIMARY KEY (tenant_id, cache_key);
     EXCEPTION WHEN others THEN NULL;
     END $$`,
    // File storage table for database storage backend
    `CREATE TABLE IF NOT EXISTS file_storage (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL DEFAULT 1,
      key        TEXT NOT NULL,
      mime_type  TEXT NOT NULL,
      data       BYTEA NOT NULL,
      size       INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, key)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_file_storage_tenant ON file_storage(tenant_id)`,
    // Phase 3: Writer style profile columns
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS tone TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS expertise_level TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS style_guide TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS few_shot_examples JSONB DEFAULT '[]'`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS gender TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS ethnicity TEXT`,
    // ── Local auth & permissions migrations ──────────────────────────
    // 1a. Evolve users table
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active INTEGER DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    // PR-C notifications: per-user Telegram DM target. Linking UI lands in PR-E.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT`,
    // Self-service profile: admin users can set their own avatar.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_username ON users(tenant_id, username)`,
    // 1b. Create roles table
    `CREATE TABLE IF NOT EXISTS roles (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL DEFAULT 1,
      name        TEXT NOT NULL,
      description TEXT,
      permissions JSONB NOT NULL DEFAULT '[]',
      is_system   BOOLEAN DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, name)
    )`,
    // Seed default roles
    `INSERT INTO roles (tenant_id, name, description, permissions, is_system) VALUES
      (1, 'owner', 'Full platform access', '["*"]', true),
      (1, 'admin', 'Full administrative access', '["*"]', true),
      (1, 'editor', 'Content management', '["articles.read","articles.create","articles.update","sources.read","sources.create","sources.update","writers.read","categories.read","media.create","media.read","comments.read","comments.moderate","analytics.read","fetch.execute","newsletter.read"]', true),
      (1, 'viewer', 'Read-only access', '["articles.read","sources.read","writers.read","categories.read","analytics.read","comments.read","audit.read","newsletter.read","media.read"]', true)
     ON CONFLICT (tenant_id, name) DO NOTHING`,
    // Backfill: seed default roles for any tenant that is missing them
    `INSERT INTO roles (tenant_id, name, description, permissions, is_system)
     SELECT t.id, r.name, r.description, r.permissions::jsonb, true
     FROM tenants t
     CROSS JOIN (VALUES
       ('owner', 'Full access', '["*"]'),
       ('admin', 'Full administrative access', '["*"]'),
       ('editor', 'Content management', '["articles.read","articles.create","articles.update","sources.read","sources.create","sources.update","writers.read","categories.read","media.create","media.read","comments.read","comments.moderate","analytics.read","fetch.execute","newsletter.read"]'),
       ('viewer', 'Read-only access', '["articles.read","sources.read","writers.read","categories.read","analytics.read","comments.read","audit.read","newsletter.read","media.read"]')
     ) AS r(name, description, permissions)
     WHERE NOT EXISTS (SELECT 1 FROM roles WHERE roles.tenant_id = t.id AND roles.name = r.name)`,
    // 1c. Add local_user_id column to tenant_admins
    `ALTER TABLE tenant_admins ADD COLUMN IF NOT EXISTS local_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`,
    `CREATE UNIQUE INDEX IF NOT EXISTS tenant_admins_tenant_local ON tenant_admins(tenant_id, local_user_id) WHERE local_user_id IS NOT NULL`,
    // Phase 4: max_tenants column on plan_limits
    `ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS max_tenants INTEGER`,
    `UPDATE plan_limits SET max_tenants = 1 WHERE plan = 'demo' AND max_tenants IS NULL`,
    `UPDATE plan_limits SET max_tenants = 1 WHERE plan = 'trial' AND max_tenants IS NULL`,
    `UPDATE plan_limits SET max_tenants = 1 WHERE plan = 'starter' AND max_tenants IS NULL`,
    `UPDATE plan_limits SET max_tenants = 3 WHERE plan = 'pro' AND max_tenants IS NULL`,
    // Audit log table (referenced by middleware/audit.js)
    `CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL DEFAULT 1,
      user_id     INTEGER,
      user_email  TEXT,
      action      TEXT NOT NULL,
      resource    TEXT,
      resource_id INTEGER,
      details     JSONB,
      ip_address  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(tenant_id, action, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(tenant_id, user_id, created_at DESC)`,
    // Saved searches for Discover
    `CREATE TABLE IF NOT EXISTS saved_searches (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL DEFAULT 1,
      name        TEXT NOT NULL,
      query       TEXT NOT NULL,
      sources     TEXT NOT NULL DEFAULT 'brave,newsapi',
      period      TEXT NOT NULL DEFAULT '24h',
      created_by  INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      last_run_at TIMESTAMPTZ,
      UNIQUE(tenant_id, name)
    )`,
    `ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS results JSONB`,
    `ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS result_count INTEGER DEFAULT 0`,
    `ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS from_date TEXT`,
    `ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS to_date TEXT`,
    // Cron runs tracking table
    `CREATE TABLE IF NOT EXISTS cron_runs (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL DEFAULT 1,
      job_name    TEXT NOT NULL,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      status      TEXT NOT NULL DEFAULT 'running',
      summary     JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs (tenant_id, job_name, started_at DESC)`,
    // Upgrade admin role to full wildcard permissions (same as owner)
    `UPDATE roles SET permissions = '["*"]'::jsonb, description = 'Full administrative access' WHERE name = 'admin' AND is_system = true AND NOT (permissions @> '["*"]'::jsonb)`,
    // Clean up orphaned cron_runs rows from server crashes
    `UPDATE cron_runs SET status = 'crashed', finished_at = NOW() WHERE status = 'running'`,
    // ── Editorial workflow: status column + review metadata ──
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft'`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS submitted_for_review_at TIMESTAMPTZ`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS reviewed_by INTEGER`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
    // Backfill status from legacy is_published / is_archived flags
    `UPDATE articles SET status = 'published' WHERE is_published = 1 AND (is_archived = 0 OR is_archived IS NULL) AND (status IS NULL OR status = 'draft')`,
    `UPDATE articles SET status = 'archived' WHERE is_archived = 1 AND (status IS NULL OR status = 'draft')`,
    `CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(tenant_id, status)`,
    // Synthesis forecasts table
    `CREATE TABLE IF NOT EXISTS synthesis_forecasts (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL DEFAULT 1,
      writer_id   INTEGER NOT NULL,
      forecast_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      clusters    JSONB NOT NULL,
      summary     JSONB NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_synth_forecasts_tenant ON synthesis_forecasts(tenant_id, forecast_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_synth_forecasts_writer ON synthesis_forecasts(tenant_id, writer_id, forecast_at DESC)`,
    // Synthesis watchlist table
    `CREATE TABLE IF NOT EXISTS synthesis_watchlist (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL DEFAULT 1,
      keyword     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'blocked',
      created_by  INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, keyword, type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_synth_watchlist_tenant ON synthesis_watchlist(tenant_id, type)`,
    // Tenant lifecycle columns
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspension_reason TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status)`,
    `CREATE INDEX IF NOT EXISTS idx_tenants_custom_domain ON tenants(custom_domain) WHERE custom_domain IS NOT NULL`,
    // Custom domain verification tracking
    `CREATE TABLE IF NOT EXISTS tenant_domains (
      id                 SERIAL PRIMARY KEY,
      tenant_id          INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      domain             TEXT NOT NULL UNIQUE,
      status             TEXT NOT NULL DEFAULT 'pending',
      verification_token TEXT NOT NULL,
      verified_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant ON tenant_domains(tenant_id)`,
    // Composite indexes for common tenant-scoped queries
    `CREATE INDEX IF NOT EXISTS idx_articles_tenant_published ON articles(tenant_id, is_published, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_articles_tenant_category ON articles(tenant_id, category, published_at DESC)`,
    // Phase 5: Storage quota tracking
    `CREATE TABLE IF NOT EXISTS tenant_storage_usage (
      tenant_id   INTEGER PRIMARY KEY REFERENCES tenants(id),
      bytes_used  BIGINT NOT NULL DEFAULT 0,
      file_count  INTEGER NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS max_storage_mb INTEGER`,
    `UPDATE plan_limits SET max_storage_mb = 100  WHERE plan = 'demo'    AND max_storage_mb IS NULL`,
    `UPDATE plan_limits SET max_storage_mb = 500  WHERE plan = 'trial'   AND max_storage_mb IS NULL`,
    `UPDATE plan_limits SET max_storage_mb = 500  WHERE plan = 'starter' AND max_storage_mb IS NULL`,
    `UPDATE plan_limits SET max_storage_mb = 5000 WHERE plan = 'pro'     AND max_storage_mb IS NULL`,
    // Phase 6: Plan restructure — free/starter/pro/business (remove demo + trial)
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ`,
    `UPDATE tenants SET plan = 'free' WHERE plan = 'demo'`,
    `UPDATE tenants SET plan = 'starter' WHERE plan = 'trial'`,
    `ALTER TABLE tenants ALTER COLUMN plan SET DEFAULT 'free'`,
    `INSERT INTO plan_limits (plan, max_sources, max_writers, max_articles_month, max_ai_cost_month, audio_enabled, custom_domain_enabled, max_tenants, max_storage_mb)
     VALUES ('free', 3, 1, 25, 0.00, false, false, 1, 50)
     ON CONFLICT (plan) DO NOTHING`,
    `UPDATE plan_limits SET max_sources = 10, max_writers = 4, max_articles_month = 250 WHERE plan = 'starter'`,
    `DELETE FROM plan_limits WHERE plan IN ('demo', 'trial')`,
    // Phase 7: Tenant UUID + is_platform for IDOR prevention
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS uuid UUID DEFAULT gen_random_uuid()`,
    `UPDATE tenants SET uuid = gen_random_uuid() WHERE uuid IS NULL`,
    `ALTER TABLE tenants ALTER COLUMN uuid SET NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_uuid ON tenants(uuid)`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_platform BOOLEAN DEFAULT false`,
    `UPDATE tenants SET is_platform = true WHERE id = 1`,
    // Phase 8: Email/password registration for public users
    `ALTER TABLE public_users ADD COLUMN IF NOT EXISTS password_hash TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_public_users_email_local ON public_users(LOWER(email)) WHERE provider = 'local'`,
    // Phase 9: AI Credit System
    `ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS max_credits_month INTEGER`,
    `ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS max_credits_day INTEGER`,
    `UPDATE plan_limits SET max_credits_month = 0,     max_credits_day = 0    WHERE plan = 'free'     AND max_credits_month IS NULL`,
    `UPDATE plan_limits SET max_credits_month = 5000,  max_credits_day = 500  WHERE plan = 'starter'  AND max_credits_month IS NULL`,
    `UPDATE plan_limits SET max_credits_month = 20000, max_credits_day = 2000 WHERE plan = 'pro'      AND max_credits_month IS NULL`,
    `UPDATE plan_limits SET max_credits_month = 50000, max_credits_day = 5000 WHERE plan = 'business'  AND max_credits_month IS NULL`,
    `UPDATE plan_limits SET max_credits_month = NULL,  max_credits_day = NULL WHERE plan = 'internal'  AND max_credits_month IS NULL`,
    `ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS credits_used INTEGER DEFAULT 0`,
    // Backfill: 1000 = CREDIT_RATE from lib/ai-usage.js (1 credit = $0.001)
    `UPDATE ai_usage SET credits_used = ROUND(estimated_cost * 1000) WHERE credits_used = 0 AND estimated_cost > 0`,
    `CREATE TABLE IF NOT EXISTS promo_codes (
      id               SERIAL PRIMARY KEY,
      code             TEXT NOT NULL UNIQUE,
      description      TEXT,
      type             TEXT NOT NULL DEFAULT 'flat',
      value            NUMERIC(10,2) NOT NULL,
      max_redemptions  INTEGER,
      redemption_count INTEGER DEFAULT 0,
      expires_at       TIMESTAMPTZ,
      is_active        BOOLEAN DEFAULT true,
      created_by       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS promo_redemptions (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      bonus_credits INTEGER NOT NULL,
      redeemed_at   TIMESTAMPTZ DEFAULT NOW(),
      expires_at    TIMESTAMPTZ,
      UNIQUE(tenant_id, promo_code_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_promo_redemptions_tenant ON promo_redemptions (tenant_id)`,
    `CREATE TABLE IF NOT EXISTS credit_purchases (
      id                    SERIAL PRIMARY KEY,
      tenant_id             INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      credits               INTEGER NOT NULL,
      amount_cents          INTEGER NOT NULL,
      stripe_session_id     TEXT UNIQUE,
      stripe_payment_intent TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      purchased_by          INTEGER,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      completed_at          TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_credit_purchases_tenant ON credit_purchases (tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_credit_purchases_session ON credit_purchases (stripe_session_id)`,
    `CREATE TABLE IF NOT EXISTS credit_packs (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      credits     INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      is_active   BOOLEAN DEFAULT true,
      sort_order  INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `INSERT INTO credit_packs (name, credits, price_cents, sort_order) VALUES
      ('Starter Pack',  5000,   500,  1),
      ('Growth Pack',   20000,  1800, 2),
      ('Power Pack',    50000,  4000, 3)
     ON CONFLICT (name) WHERE is_active = true DO NOTHING`,
    // Phase 10: Plan limit tuning — fill gaps + rebalance storage/credits
    // 10a: Set missing Business/Internal storage and tenant caps
    `UPDATE plan_limits SET max_storage_mb = 51200 WHERE plan = 'business' AND max_storage_mb IS NULL`,
    `UPDATE plan_limits SET max_tenants = 10     WHERE plan = 'business' AND max_tenants IS NULL`,
    `UPDATE plan_limits SET max_storage_mb = NULL WHERE plan = 'internal' AND max_storage_mb IS NOT NULL`,
    `UPDATE plan_limits SET max_tenants = NULL    WHERE plan = 'internal' AND max_tenants IS NOT NULL`,
    // 10b: Rebalance storage — Starter 500→1024 MB, Pro 5000→10240 MB
    `UPDATE plan_limits SET max_storage_mb = 1024  WHERE plan = 'starter' AND max_storage_mb = 500`,
    `UPDATE plan_limits SET max_storage_mb = 10240 WHERE plan = 'pro'     AND max_storage_mb = 5000`,
    // 10c: Give Free plan taster credits (250/month, 25/day)
    `UPDATE plan_limits SET max_credits_month = 250, max_credits_day = 25 WHERE plan = 'free' AND max_credits_month = 0`,
    // Phase 11: Fix duplicate credit packs (ON CONFLICT DO NOTHING had no unique constraint)
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_packs_name ON credit_packs (name) WHERE is_active = true`,
    `DELETE FROM credit_packs WHERE id NOT IN (SELECT MIN(id) FROM credit_packs GROUP BY name)`,
    // Phase 12: Plan simplification — remove daily credit limits for paid plans, add seo_titles_enabled
    `UPDATE plan_limits SET max_credits_day = NULL WHERE plan IN ('starter', 'pro', 'business') AND max_credits_day IS NOT NULL`,
    `ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS seo_titles_enabled BOOLEAN DEFAULT false`,
    `UPDATE plan_limits SET seo_titles_enabled = true WHERE plan IN ('pro', 'business', 'internal')`,
    // Phase 13: Stripe subscription checkout — store price IDs and display prices per plan
    `ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS stripe_price_id TEXT`,
    `ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS price_cents INTEGER DEFAULT 0`,
    // Phase 14: Slug index + backfill + composite indexes for performance
    `CREATE INDEX IF NOT EXISTS idx_articles_tenant_slug ON articles (tenant_id, slug)`,
    `CREATE INDEX IF NOT EXISTS idx_articles_tenant_source_url ON articles (tenant_id, source_url)`,
    `CREATE INDEX IF NOT EXISTS idx_analytics_events_tenant_type_created ON analytics_events (tenant_id, event_type, created_at DESC)`,
    // Phase 15: Email verification for local registration
    `ALTER TABLE public_users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0`,
    `ALTER TABLE auth_codes ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'oauth'`,
    // Backfill: OAuth/platform users are always verified; existing local users grandfathered
    `UPDATE public_users SET email_verified = 1 WHERE email_verified = 0 AND provider != 'local'`,
    `UPDATE public_users SET email_verified = 1 WHERE email_verified = 0 AND provider = 'local' AND created_at < '2026-03-25'`,
    // Phase 16: Banner notification system (global + tenant)
    `CREATE TABLE IF NOT EXISTS banners (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      message     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'info',
      link_text   TEXT,
      link_url    TEXT,
      dismissible BOOLEAN NOT NULL DEFAULT true,
      is_active   BOOLEAN NOT NULL DEFAULT true,
      starts_at   TIMESTAMPTZ,
      expires_at  TIMESTAMPTZ,
      priority    INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_banners_active ON banners (is_active, starts_at, expires_at) WHERE is_active = true`,
    `CREATE INDEX IF NOT EXISTS idx_banners_tenant ON banners (tenant_id)`,
    // Phase 17: Featured article rotation
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS last_featured_at TIMESTAMPTZ DEFAULT NULL`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS featured_until TIMESTAMPTZ DEFAULT NULL`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_pinned INTEGER DEFAULT 0`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS featured_source TEXT DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS featured_rotation_log (
      id                  SERIAL PRIMARY KEY,
      tenant_id           INTEGER NOT NULL DEFAULT 1,
      rotated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      slots_filled        INTEGER NOT NULL DEFAULT 0,
      articles_featured   JSONB DEFAULT '[]',
      articles_unfeatured JSONB DEFAULT '[]',
      strategy_used       TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_featured_rotation_log_tenant ON featured_rotation_log(tenant_id, rotated_at DESC)`,
    // Backfill: existing manually featured articles get featured_source = 'manual'
    `UPDATE articles SET featured_source = 'manual' WHERE is_featured = 1 AND featured_source IS NULL`,
    // Featured rotation settings defaults
    `INSERT INTO settings (key, value) VALUES ('featured_rotation_enabled', '0')        ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('featured_rotation_interval_hours', '12') ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('featured_rotation_strategy', 'score')    ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('featured_rotation_pool_days', '7')       ON CONFLICT (tenant_id, key) DO NOTHING`,
    `INSERT INTO settings (key, value) VALUES ('featured_rotation_cooldown_days', '3')   ON CONFLICT (tenant_id, key) DO NOTHING`,
    // Phase 18: Feature toggle system — centralized feature registry with plan defaults + tenant overrides
    `CREATE TABLE IF NOT EXISTS feature_definitions (
      key           TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      category      TEXT NOT NULL,
      value_type    TEXT NOT NULL DEFAULT 'boolean',
      default_value TEXT NOT NULL DEFAULT 'false',
      sort_order    NUMERIC DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS plan_features (
      plan        TEXT NOT NULL,
      feature_key TEXT NOT NULL REFERENCES feature_definitions(key) ON DELETE CASCADE,
      value       TEXT,
      PRIMARY KEY (plan, feature_key)
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_feature_overrides (
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      feature_key TEXT NOT NULL REFERENCES feature_definitions(key) ON DELETE CASCADE,
      value       TEXT,
      reason      TEXT,
      granted_by  INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, feature_key)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tenant_feature_overrides_tenant ON tenant_feature_overrides(tenant_id)`,
    // Block editor: structured content storage
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_blocks JSONB DEFAULT NULL`,
    // ── Platform AI Chat ──────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS chat_conversations (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL DEFAULT 1,
      user_id    INTEGER NOT NULL,
      title      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(tenant_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated ON chat_conversations(updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id              SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content         TEXT NOT NULL,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      duration_ms     INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at)`,
    // Chat context: separate portal vs platform conversations
    `ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'platform'`,
    // Per-article AI summary opt-out
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS disable_summary INTEGER NOT NULL DEFAULT 0`,
    // BYAI (Bring Your AI) — track whether an AI call used the tenant's own key
    `ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS is_byai BOOLEAN DEFAULT false`,
    // Agent session correlation + cached/fresh input token split (PR A: usage tracking rework)
    `ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS agent_session_id UUID`,
    `ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS input_tokens_cached INTEGER DEFAULT 0`,
    `ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS input_tokens_fresh INTEGER DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_session ON ai_usage(agent_session_id) WHERE agent_session_id IS NOT NULL`,
    // Fix platform tenant site URLs — admin-tenants.js was generating slug.domain (e.g. deepfeedai.deepfeedai.com)
    `UPDATE settings SET value = 'deepfeedai.com' WHERE tenant_id = 1 AND key = 'site_domain' AND value LIKE '%.deepfeedai.com' AND value != 'deepfeedai.com'`,
    `UPDATE settings SET value = 'https://deepfeedai.com' WHERE tenant_id = 1 AND key = 'site_url' AND value LIKE '%deepfeedai.deepfeedai.com%'`,
    `UPDATE settings SET value = 'https://deepfeedai.com' WHERE tenant_id = 1 AND key = 'main_site_url' AND value LIKE '%deepfeedai.deepfeedai.com%'`,
    // SEO: AI-rewritten headline and story thread label for related article matching
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS generated_title TEXT`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS topic_tag TEXT`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS tldr_context TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_articles_tenant_topic_tag ON articles(tenant_id, topic_tag)`,
    // ── Source-first pipeline ───────────────────────────────────────
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS followups JSONB DEFAULT NULL`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS enriched_summary TEXT DEFAULT NULL`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS scrape_status TEXT DEFAULT NULL`,
    // ── Enterprise Logging System ─────────────────────────────────
    `CREATE TABLE IF NOT EXISTS app_logs (
      id             BIGSERIAL PRIMARY KEY,
      tenant_id      INTEGER,
      level          TEXT NOT NULL,
      message        TEXT NOT NULL,
      module         TEXT,
      correlation_id TEXT,
      context        JSONB,
      error_stack    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_app_logs_tenant_time ON app_logs (tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs (level, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_app_logs_module ON app_logs (module, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_app_logs_correlation ON app_logs (correlation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs (created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS request_logs (
      id             BIGSERIAL PRIMARY KEY,
      tenant_id      INTEGER,
      correlation_id TEXT,
      method         TEXT NOT NULL,
      path           TEXT NOT NULL,
      status_code    INTEGER NOT NULL,
      duration_ms    INTEGER,
      ip_address     TEXT,
      user_agent     TEXT,
      user_id        INTEGER,
      content_length INTEGER,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_req_logs_tenant_time ON request_logs (tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_req_logs_status ON request_logs (status_code, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_req_logs_path ON request_logs (path, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_req_logs_created ON request_logs (created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS error_aggregates (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER,
      error_hash  TEXT NOT NULL,
      message     TEXT NOT NULL,
      stack_sample TEXT,
      module      TEXT,
      count       INTEGER NOT NULL DEFAULT 1,
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status      TEXT DEFAULT 'open',
      UNIQUE(tenant_id, error_hash)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_error_agg_tenant ON error_aggregates (tenant_id, last_seen DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_error_agg_status ON error_aggregates (tenant_id, status, count DESC)`,
    // Phase: Writer memory system — editorial positions, running threads, predictions
    `CREATE TABLE IF NOT EXISTS writer_memory (
      id          SERIAL PRIMARY KEY,
      writer_id   INTEGER NOT NULL REFERENCES writers(id) ON DELETE CASCADE,
      tenant_id   INTEGER NOT NULL,
      memory_type TEXT NOT NULL,
      subject     TEXT NOT NULL,
      content     TEXT NOT NULL,
      confidence  NUMERIC(3,2) DEFAULT 0.80,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_writer_memory_lookup ON writer_memory(writer_id, tenant_id, memory_type)`,
    // Writer personality enhancements
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS signature_phrases TEXT[]`,
    // Newsroom chat personality (2026-04): per-writer accent color for chat bubbles
    // and username highlight. Nullable — falls back to a deterministic hash of writer.id
    // into a fixed palette (see lib/writer-colors.js).
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS accent_color TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS contrarian_level NUMERIC(2,1) DEFAULT 0.5`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS beat_angle TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS chat_prompt TEXT`,
    // Agent roles & teams (Newsroom)
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'writer'`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS team_id INTEGER`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS teams (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_teams_tenant ON teams(tenant_id)`,
    // Editorial workflow tracking on articles
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS editorial_revision_count INTEGER DEFAULT 0`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS editor_verdict JSONB`,
    // Copy editor (Vera) — structured copy-editing suggestions before Maxwell's gate
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS copy_edit_result JSONB`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS copy_edited_at TIMESTAMPTZ`,
    // Future: writer voice fingerprint (analyzed from 20+ articles)
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS style_fingerprint JSONB`,
    // Writer agent: story pitches
    `CREATE TABLE IF NOT EXISTS story_pitches (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      writer_id   INTEGER NOT NULL REFERENCES writers(id) ON DELETE CASCADE,
      pitch_type  TEXT NOT NULL,
      headline    TEXT NOT NULL,
      reasoning   TEXT NOT NULL,
      source_article_ids JSONB DEFAULT '[]',
      memory_refs JSONB DEFAULT '[]',
      status      TEXT DEFAULT 'pending',
      priority    NUMERIC(3,1) DEFAULT 5.0,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_story_pitches_lookup ON story_pitches(tenant_id, writer_id, status)`,
    // Article revision history (snapshot before chat/API edits)
    `CREATE TABLE IF NOT EXISTS article_revisions (
      id            SERIAL PRIMARY KEY,
      article_id    INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      tenant_id     INTEGER NOT NULL,
      title         TEXT,
      full_content  TEXT,
      summary       TEXT,
      tldr_overview TEXT,
      edited_via    TEXT,
      edited_by     TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_article_revisions_lookup ON article_revisions(article_id, tenant_id)`,
    // Messaging channels (Telegram, Slack, etc.)
    `CREATE TABLE IF NOT EXISTS messaging_channels (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      platform    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      writer_id   INTEGER REFERENCES writers(id) ON DELETE SET NULL,
      config      JSONB DEFAULT '{}',
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Newsroom inter-writer messages
    `CREATE TABLE IF NOT EXISTS newsroom_messages (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL,
      from_writer_id  INTEGER REFERENCES writers(id) ON DELETE SET NULL,
      to_writer_id    INTEGER REFERENCES writers(id) ON DELETE SET NULL,
      message_type    TEXT NOT NULL,
      content         TEXT NOT NULL,
      context         JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_newsroom_messages_tenant ON newsroom_messages(tenant_id, created_at DESC)`,
    // Telegram group topics: thread_id column for per-topic writer mapping
    `ALTER TABLE messaging_channels ADD COLUMN IF NOT EXISTS thread_id TEXT`,
    // Phase 17: pgvector for semantic article search (RAG)
    // Note: CREATE EXTENSION may require superuser — Neon supports it natively
    `DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS vector; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pgvector extension not available — semantic search disabled'; END $$`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS embedding vector(768)`,
    // External research Phase 1 — provenance for how a curated article entered the system.
    // Values: 'rss' (default, scheduled feed ingest) | 'live' (live news APIs) | 'manual' (admin add) | 'enrichment' (Brave/HN/Reddit on-demand ingest)
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS ingest_source TEXT DEFAULT 'rss'`,
    `CREATE INDEX IF NOT EXISTS idx_articles_ingest_source ON articles(tenant_id, ingest_source, created_at DESC)`,
    // HNSW index: better cold-start behavior than IVFFlat, no minimum row requirement
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
         EXECUTE 'CREATE INDEX IF NOT EXISTS idx_articles_embedding ON articles USING hnsw (embedding vector_cosine_ops)';
       END IF;
     END $$`,
    // Track which embedding model was used per tenant
    `INSERT INTO settings (tenant_id, key, value)
     SELECT t.id, 'embedding_model', 'text-embedding-004'
     FROM tenants t
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE tenant_id = t.id AND key = 'embedding_model')
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    // Phase 17b: Conversational AI — persistent conversation history
    `CREATE TABLE IF NOT EXISTS conversation_history (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      writer_id   INTEGER NOT NULL,
      platform    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      thread_id   TEXT,
      user_id     TEXT,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_convo_history_lookup ON conversation_history(tenant_id, writer_id, channel_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_convo_history_cleanup ON conversation_history(created_at)`,
    // Per-turn article context pointer — enables anaphora resolution on
    // follow-up messages like "make that a pitch" when no fresh article is
    // attached. Populated by the web chat route when context_article_id is
    // supplied; null on messaging-channel turns.
    `ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS context_article_id INTEGER`,
    // Conversation summaries for long-term context
    `CREATE TABLE IF NOT EXISTS conversation_summaries (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      writer_id   INTEGER NOT NULL,
      context_key TEXT NOT NULL,
      summary     TEXT NOT NULL,
      turn_count  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_convo_summaries_key ON conversation_summaries(tenant_id, context_key)`,
    // Phase 17c: Chat user profiles for personalization
    `CREATE TABLE IF NOT EXISTS chat_user_profiles (
      id                SERIAL PRIMARY KEY,
      tenant_id         INTEGER NOT NULL,
      platform          TEXT NOT NULL,
      platform_user_id  TEXT NOT NULL,
      display_name      TEXT,
      topics_asked      TEXT[] DEFAULT '{}',
      favorite_writers  INTEGER[] DEFAULT '{}',
      last_interaction  TIMESTAMPTZ DEFAULT NOW(),
      interaction_count INTEGER DEFAULT 0,
      UNIQUE(tenant_id, platform, platform_user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_user_profiles_lookup ON chat_user_profiles(tenant_id, platform, platform_user_id)`,
    // Hybrid newsroom Phase B — pitches + editor-initiated research requests.
    // Either pitched_by_writer_id (writer-initiated) or requested_by_editor_id
    // (editor tip) is populated. Status lifecycle: proposed → approved | rejected;
    // approved pitches eventually publish and populate spawned_article_id.
    `CREATE TABLE IF NOT EXISTS article_pitches (
      id                      SERIAL PRIMARY KEY,
      tenant_id               INTEGER NOT NULL,
      source_article_id       INTEGER NOT NULL,
      pitched_by_writer_id    INTEGER,
      requested_by_editor_id  INTEGER,
      angle_summary           TEXT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'proposed',
      decided_by_user_id      INTEGER,
      decided_at              TIMESTAMPTZ,
      decision_note           TEXT,
      spawned_article_id      INTEGER,
      created_at              TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_article_pitches_tenant_status ON article_pitches(tenant_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_article_pitches_source ON article_pitches(source_article_id)`,
    `CREATE INDEX IF NOT EXISTS idx_article_pitches_writer ON article_pitches(pitched_by_writer_id) WHERE pitched_by_writer_id IS NOT NULL`,
    // Phase B follow-up — enriched articles explicitly attached to a pitch so synthesis
    // includes them regardless of embedding-similarity / beat-category / timing
    `ALTER TABLE article_pitches ADD COLUMN IF NOT EXISTS attached_article_ids JSONB DEFAULT '[]'`,
    // Pitch type — aligns article_pitches with the existing story_pitches.pitch_type
    // so commissioned and writer-generated pitches can be filtered/grouped the same way.
    // Default 'original' so pre-existing rows keep working.
    `ALTER TABLE article_pitches ADD COLUMN IF NOT EXISTS pitch_type TEXT DEFAULT 'original'`,
    // Social newsroom Phase 2 — activity feed events
    // event_type values: published | pitched | pitch_approved | pitch_rejected | drafted | enriched | reviewed
    // payload holds card-renderable fields (title, slug, snippet, etc.) so feed reads don't need joins
    `CREATE TABLE IF NOT EXISTS newsroom_events (
      id                   SERIAL PRIMARY KEY,
      tenant_id            INTEGER NOT NULL,
      event_type           TEXT NOT NULL,
      actor_writer_id      INTEGER,
      actor_user_id        INTEGER,
      target_article_id    INTEGER,
      target_pitch_id      INTEGER,
      payload              JSONB DEFAULT '{}',
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_newsroom_events_tenant_time ON newsroom_events(tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_newsroom_events_type ON newsroom_events(tenant_id, event_type, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_newsroom_events_actor ON newsroom_events(actor_writer_id) WHERE actor_writer_id IS NOT NULL`,
    `ALTER TABLE newsroom_events ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ`,
    // Newsroom Glass — public live feed columns
    `ALTER TABLE newsroom_events ADD COLUMN IF NOT EXISTS is_public   BOOLEAN DEFAULT false`,
    `ALTER TABLE newsroom_events ADD COLUMN IF NOT EXISTS headline    TEXT`,
    `ALTER TABLE newsroom_events ADD COLUMN IF NOT EXISTS entity_slug TEXT`,
    `ALTER TABLE newsroom_events ADD COLUMN IF NOT EXISTS is_terminal BOOLEAN DEFAULT false`,
    `CREATE INDEX IF NOT EXISTS idx_newsroom_events_public ON newsroom_events(tenant_id, created_at DESC) WHERE is_public = true`,
    // Newsroom Glass backfill — promote pre-existing events to is_public=true.
    // Safe to run on every boot (WHERE is_public = false guards re-execution).
    `UPDATE newsroom_events
       SET is_public   = true,
           is_terminal = true,
           headline    = 'Published: ' || LEFT(payload->>'title', 200),
           entity_slug = payload->>'slug'
       WHERE event_type = 'published'
         AND is_public  = false
         AND payload->>'title' IS NOT NULL`,
    `UPDATE newsroom_events
       SET is_public = true,
           headline  = CASE
             WHEN payload->>'angle_summary' IS NOT NULL
               THEN 'New investigation: ' || LEFT(payload->>'angle_summary', 180)
             ELSE 'New investigation: ' || LEFT(payload->>'source_title', 180)
           END
       WHERE event_type = 'pitched'
         AND is_public  = false
         AND (payload->>'angle_summary' IS NOT NULL OR payload->>'source_title' IS NOT NULL)`,
    // Editor thumbs-up/down feedback on individual briefs + digests. Used
    // immediately to show the user their prior vote; will later feed into
    // the brief prompt so Maxwell can adjust tone based on trailing feedback.
    `CREATE TABLE IF NOT EXISTS brief_feedback (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      event_id    INTEGER NOT NULL,
      user_id     TEXT NOT NULL,
      vote        TEXT NOT NULL CHECK (vote IN ('up','down')),
      note        TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, event_id, user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_brief_feedback_event ON brief_feedback(tenant_id, event_id)`,
    // Social newsroom Phase 3 — reactions + threading on feed cards.
    // Reactions: signal-bearing emoji (🔥💡🚩👀). Unique per (event, actor, emoji)
    // so an actor can't double-react with the same emoji but can use multiple.
    `CREATE TABLE IF NOT EXISTS newsroom_reactions (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL,
      event_id        INTEGER NOT NULL,
      actor_writer_id INTEGER,
      actor_user_id   INTEGER,
      emoji           TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_newsroom_reactions_event ON newsroom_reactions(event_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_newsroom_reactions_unique
       ON newsroom_reactions(event_id, COALESCE(actor_writer_id, 0), COALESCE(actor_user_id, 0), emoji)`,
    // Replies: threaded under each event card. Self-referential parent_reply_id allows nested replies.
    `CREATE TABLE IF NOT EXISTS newsroom_replies (
      id                SERIAL PRIMARY KEY,
      tenant_id         INTEGER NOT NULL,
      event_id          INTEGER NOT NULL,
      parent_reply_id   INTEGER,
      author_writer_id  INTEGER,
      author_user_id    INTEGER,
      content           TEXT NOT NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_newsroom_replies_event ON newsroom_replies(event_id, created_at ASC)`,
    // Social newsroom Phase 4 — agent presence indicators.
    // States: idle | chatting | drafting | researching | waiting-on-editor
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS presence_state TEXT DEFAULT 'idle'`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS presence_updated_at TIMESTAMPTZ`,
    // Story levels — importance signal for the article + frontend rails.
    // Values: 'standard' (default) | 'trending' | 'major' | 'breaking'
    // Computed by lib/story-levels.js from velocity + source diversity + editorial score; editor can manually override.
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS importance TEXT DEFAULT 'standard'`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS importance_locked BOOLEAN DEFAULT false`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS importance_updated_at TIMESTAMPTZ`,
    `CREATE INDEX IF NOT EXISTS idx_articles_importance ON articles(tenant_id, importance, published_at DESC)`,
    // Notifications / Actions system — PR-A foundation.
    // user_notifications: per-user feed of events (in-web bell + cross-channel).
    // event_id optionally links to newsroom_events; payload holds renderable fields so reads don't require joins.
    `CREATE TABLE IF NOT EXISTS user_notifications (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      event_id    INTEGER,
      kind        TEXT NOT NULL,
      title       TEXT,
      body        TEXT,
      payload     JSONB DEFAULT '{}',
      read_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_notifications_inbox
       ON user_notifications(tenant_id, user_id, read_at NULLS FIRST, created_at DESC)`,
    // notification_preferences: per-user, per-event-kind channel routing (web/email/discord/telegram/slack).
    `CREATE TABLE IF NOT EXISTS notification_preferences (
      tenant_id   INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      event_kind  TEXT NOT NULL,
      channels    TEXT[] DEFAULT ARRAY['web'],
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, user_id, event_kind)
    )`,
    // action_tokens: single-use HMAC-signed tokens for cross-channel actions (approve/reject/assign from
    // Discord/Telegram/Slack/email). token_hash = HMAC-SHA256 of the raw token; raw is never persisted.
    `CREATE TABLE IF NOT EXISTS action_tokens (
      id            SERIAL PRIMARY KEY,
      token_hash    TEXT UNIQUE NOT NULL,
      tenant_id     INTEGER NOT NULL,
      user_id       INTEGER NOT NULL,
      action_kind   TEXT NOT NULL,
      target_id     INTEGER,
      target_type   TEXT,
      payload       JSONB DEFAULT '{}',
      expires_at    TIMESTAMPTZ NOT NULL,
      used_at       TIMESTAMPTZ,
      source        TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_action_tokens_hash ON action_tokens(token_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_action_tokens_expires ON action_tokens(expires_at)`,
    // Stale-action cleanup (2026-04): cohort_id groups siblings minted in the same notify()
    // fanout so a successful action can cascade "used_by_source=cascade" to the rest.
    // notification_id back-links each token to the user_notifications row it lives on so
    // we can rewrite payload.actionable[] entries in place.
    // telegram_chat_id / telegram_message_id let the Telegram callback handler strip the
    // inline keyboard off sibling messages when a cohort cascade fires.
    `ALTER TABLE action_tokens ADD COLUMN IF NOT EXISTS cohort_id TEXT`,
    `ALTER TABLE action_tokens ADD COLUMN IF NOT EXISTS notification_id BIGINT`,
    `ALTER TABLE action_tokens ADD COLUMN IF NOT EXISTS used_by_source TEXT`,
    `ALTER TABLE action_tokens ADD COLUMN IF NOT EXISTS used_by_user_id INTEGER`,
    `ALTER TABLE action_tokens ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT`,
    `ALTER TABLE action_tokens ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT`,
    `CREATE INDEX IF NOT EXISTS idx_action_tokens_cohort ON action_tokens(cohort_id)`,
    `CREATE INDEX IF NOT EXISTS idx_action_tokens_notification ON action_tokens(notification_id)`,
    // PR-B: revise action needs a place to record editor feedback.
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS review_notes TEXT`,
    // feature_definitions.sort_order was INTEGER; decimals (29.5, 29.7, ...) silently
    // failed to seed because INSERT would floor-cast. Widen to NUMERIC.
    `ALTER TABLE feature_definitions ALTER COLUMN sort_order TYPE NUMERIC`,
    // Per-writer avatar style overrides — designer can pin a specific style
    // family + freeform notes for each writer so regenerations stay consistent.
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS avatar_style_family TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS avatar_style_notes TEXT`,
    // Newsroom orchestration pipeline — multi-stage story pipeline state machine
    `CREATE TABLE IF NOT EXISTS pipeline_runs (
      id                  SERIAL PRIMARY KEY,
      tenant_id           INTEGER NOT NULL,
      status              TEXT NOT NULL DEFAULT 'scout',
      stage               TEXT NOT NULL DEFAULT 'scout',
      topic               TEXT,
      article_ids         JSONB DEFAULT '[]',
      writer_id           INTEGER REFERENCES writers(id) ON DELETE SET NULL,
      article_id          INTEGER REFERENCES articles(id) ON DELETE SET NULL,
      stage_data          JSONB DEFAULT '{}',
      human_gate_required BOOLEAN DEFAULT false,
      human_gate_reason   TEXT,
      resume_stage        TEXT,
      error_message       TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      finished_at         TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_tenant_status ON pipeline_runs(tenant_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created ON pipeline_runs(tenant_id, created_at DESC)`,
    // Story Board — manual source↔original links
    `CREATE TABLE IF NOT EXISTS article_links (
      id                  SERIAL PRIMARY KEY,
      original_article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      source_article_id   INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      link_type           TEXT NOT NULL DEFAULT 'manual',
      created_by_user_id  INTEGER,
      tenant_id           INTEGER NOT NULL,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(original_article_id, source_article_id, tenant_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_article_links_tenant   ON article_links(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_article_links_original ON article_links(original_article_id)`,
    `CREATE INDEX IF NOT EXISTS idx_article_links_source   ON article_links(source_article_id)`,
    // Feed inbox folders/groups
    `CREATE TABLE IF NOT EXISTS feed_groups (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#6366f1',
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, name)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_groups_tenant ON feed_groups(tenant_id)`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES feed_groups(id) ON DELETE SET NULL`,
    // Writing system: headline variants for different distribution surfaces
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS headline_seo    TEXT DEFAULT NULL`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS headline_social TEXT DEFAULT NULL`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS headline_push   TEXT DEFAULT NULL`,
    // Writing system: article subtype drives structural brief selection during synthesis
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS article_subtype TEXT DEFAULT NULL`,
    // Writing system: follow-up articles link back to their parent
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS parent_article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_articles_parent ON articles(parent_article_id) WHERE parent_article_id IS NOT NULL`,
    // Beat/category following — users follow topic categories
    `CREATE TABLE IF NOT EXISTS user_category_follows (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      tenant_id     INTEGER NOT NULL DEFAULT 1,
      category_name TEXT    NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, tenant_id, category_name)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_category_follows_user   ON user_category_follows(user_id, tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_user_category_follows_name   ON user_category_follows(tenant_id, category_name)`,
    // Topic (pulse) following — users follow topic_tag clusters
    `CREATE TABLE IF NOT EXISTS user_topic_follows (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      tenant_id  INTEGER NOT NULL DEFAULT 1,
      topic_tag  TEXT    NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, tenant_id, topic_tag)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_topic_follows_user ON user_topic_follows(user_id, tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_user_topic_follows_tag  ON user_topic_follows(tenant_id, topic_tag)`,
    // Video Hub — YouTube video metadata columns
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS video_duration    INTEGER DEFAULT NULL`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS video_key_moments JSONB   DEFAULT NULL`,
    `ALTER TABLE articles ADD COLUMN IF NOT EXISTS video_transcript  TEXT    DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_articles_embed_type ON articles(tenant_id, embed_type, published_at DESC) WHERE embed_type IS NOT NULL`,
    // Backfill: mark existing YouTube embeds as content_type='video' so they're excluded from Feed Inbox
    `UPDATE articles SET content_type = 'video' WHERE embed_type = 'youtube' AND (content_type IS NULL OR content_type != 'video')`,

    // Living Story Timelines
    `CREATE TABLE IF NOT EXISTS story_timelines (
      id               SERIAL PRIMARY KEY,
      tenant_id        INTEGER NOT NULL,
      name             VARCHAR(300) NOT NULL,
      slug             VARCHAR(320) NOT NULL,
      summary          TEXT,
      status           VARCHAR(20) NOT NULL DEFAULT 'active',
      article_count    INTEGER NOT NULL DEFAULT 0,
      cover_article_id INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      last_activity_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      archived_at      TIMESTAMPTZ,
      UNIQUE(tenant_id, slug)
    )`,
    `ALTER TABLE story_timelines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE story_timelines ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)`,
    `CREATE TABLE IF NOT EXISTS user_story_follows (
      user_id    INTEGER NOT NULL REFERENCES public_users(id) ON DELETE CASCADE,
      story_id   INTEGER NOT NULL REFERENCES story_timelines(id) ON DELETE CASCADE,
      tenant_id  INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, story_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_story_follows_user  ON user_story_follows(user_id, tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_user_story_follows_story ON user_story_follows(story_id, tenant_id)`,
    `CREATE TABLE IF NOT EXISTS story_timeline_articles (
      story_id      INTEGER NOT NULL REFERENCES story_timelines(id) ON DELETE CASCADE,
      article_id    INTEGER NOT NULL,
      tenant_id     INTEGER NOT NULL,
      is_key_moment BOOLEAN NOT NULL DEFAULT FALSE,
      added_at      TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (story_id, article_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_story_timelines_tenant_status
       ON story_timelines(tenant_id, status, last_activity_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_story_timeline_articles_article
       ON story_timeline_articles(article_id, tenant_id)`,

    // Story threads — one metadata row per topic_tag, aggregating article/source counts,
    // lead/last article, dominant writer, and lifecycle status.
    // This table was referenced by lib/story-threads.js but was missing from migrations.
    `CREATE TABLE IF NOT EXISTS story_threads (
      id               SERIAL PRIMARY KEY,
      tenant_id        INTEGER NOT NULL,
      topic_tag        VARCHAR(200) NOT NULL,
      name             VARCHAR(200),
      summary          TEXT,
      status           VARCHAR(20) NOT NULL DEFAULT 'active',
      article_count    INTEGER NOT NULL DEFAULT 0,
      source_count     INTEGER NOT NULL DEFAULT 0,
      lead_article_id  INTEGER,
      last_article_id  INTEGER,
      owner_writer_id  INTEGER,
      first_seen_at    TIMESTAMPTZ,
      last_update_at   TIMESTAMPTZ,
      closed_at        TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, topic_tag)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_story_threads_tenant_status
       ON story_threads(tenant_id, status, last_update_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_story_threads_topic_tag
       ON story_threads(tenant_id, topic_tag)`,

    // Persist skip_synthesis intent so it survives the approve → assign two-step flow
    `ALTER TABLE article_pitches ADD COLUMN IF NOT EXISTS skip_synthesis BOOLEAN NOT NULL DEFAULT FALSE`,

    // Daily news budget — Maxwell's forward-looking editorial plan (generated at 7 AM)
    `CREATE TABLE IF NOT EXISTS news_budgets (
      id                    SERIAL PRIMARY KEY,
      tenant_id             INTEGER NOT NULL,
      budget_date           DATE NOT NULL,
      status                TEXT NOT NULL DEFAULT 'draft',
      editorial_note        TEXT,
      coverage_gaps         JSONB DEFAULT '[]',
      beat_alerts           JSONB DEFAULT '[]',
      auto_promote_at       TIMESTAMPTZ,
      created_by_writer_id  INTEGER,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, budget_date)
    )`,
    `CREATE TABLE IF NOT EXISTS news_budget_slots (
      id                     SERIAL PRIMARY KEY,
      budget_id              INTEGER NOT NULL REFERENCES news_budgets(id) ON DELETE CASCADE,
      tenant_id              INTEGER NOT NULL,
      priority               TEXT NOT NULL DEFAULT 'standard',
      pitch_type             TEXT NOT NULL DEFAULT 'original',
      topic_tag              TEXT,
      headline_suggestion    TEXT NOT NULL,
      rationale              TEXT,
      recommended_writer_id  INTEGER,
      assigned_writer_id     INTEGER,
      target_publish_at      TIMESTAMPTZ,
      source_article_ids     JSONB DEFAULT '[]',
      status                 TEXT NOT NULL DEFAULT 'pending',
      spawned_pitch_id       INTEGER,
      spawned_article_id     INTEGER,
      editorial_note         TEXT,
      sort_order             INTEGER DEFAULT 0,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_news_budgets_tenant_date
       ON news_budgets(tenant_id, budget_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_budget_slots_budget
       ON news_budget_slots(budget_id, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_news_budget_slots_tenant_status
       ON news_budget_slots(tenant_id, status)`,

    // Waitlist — pre-signup interest capture for closed-beta period
    `CREATE TABLE IF NOT EXISTS waitlist (
      id           SERIAL PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      name         TEXT,
      source       TEXT DEFAULT 'signup',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      notified_at  TIMESTAMPTZ,
      converted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_waitlist_notified ON waitlist (notified_at) WHERE notified_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS newsroom_prefs (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      tenant_id  INTEGER NOT NULL,
      skin       TEXT NOT NULL DEFAULT 'ink',
      font       TEXT NOT NULL DEFAULT 'system',
      pinned     JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, tenant_id)
    )`,
  ];
  for (const sql of migrations) {
    try { await p.query(sql); } catch (err) {
      // Log unexpected errors (not just "already exists" / "duplicate" noise)
      if (!/already exists|duplicate|cannot alter/i.test(err.message)) {
        console.error('[DB migration]', err.message, '—', sql.slice(0, 80));
      }
    }
  }

  // Backfill: populate slug column for articles that don't have one
  try {
    const { toSlug } = require('./lib/utils');
    const unsluggedCount = await prepare("SELECT COUNT(*) AS cnt FROM articles WHERE slug IS NULL OR slug = ''").get();
    if (parseInt(unsluggedCount.cnt) > 0) {
      const unslugged = await prepare("SELECT id, title FROM articles WHERE slug IS NULL OR slug = ''").all();
      for (const a of unslugged) {
        if (!a.title) continue;
        const slug = toSlug(a.title);
        if (slug) await p.query('UPDATE articles SET slug = $1 WHERE id = $2', [slug, a.id]);
      }
      console.log(`[DB] Backfilled slug for ${unslugged.length} articles`);
    }
  } catch (err) { console.error('[DB] Slug backfill error:', err.message); }

  // Backfill: set admin user role to 'owner' if not already set
  try {
    await p.query(`UPDATE users SET role = 'owner', display_name = 'Admin' WHERE username = 'admin' AND display_name IS NULL`);
  } catch { /* non-fatal */ }

  // Seed categories table from legacy site_categories JSON setting (one-time migration)
  try {
    const catCount = await prepare('SELECT COUNT(*) AS cnt FROM categories').get();
    if (parseInt(catCount.cnt) === 0) {
      const row = await prepare("SELECT value FROM settings WHERE key = $1").get('site_categories');
      if (row && row.value) {
        let cats = [];
        try { cats = JSON.parse(row.value); } catch { /* ignore */ }
        for (let i = 0; i < cats.length; i++) {
          const c = cats[i];
          if (!c.name) continue;
          const kw = Array.isArray(c.keywords) ? c.keywords : [];
          try {
            await p.query(
              `INSERT INTO categories (name, color, keywords, sort_order)
               VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING`,
              [c.name, c.color || '#94a3b8', kw, i]
            );
          } catch { /* skip duplicates */ }
        }
        console.log(`✅ Seeded ${cats.length} categories from site_categories setting`);
      }
    }
  } catch (err) { console.error('[DB] category seed error:', err.message); }

  // One-time: refresh category keywords from updated site_categories seed (v1.10.2)
  try {
    const migFlag = await prepare("SELECT value FROM settings WHERE key = $1").get('_migrated_cat_keywords_v2');
    if (!migFlag) {
      const row = await prepare("SELECT value FROM settings WHERE key = $1").get('site_categories');
      if (row && row.value) {
        let cats = [];
        try { cats = JSON.parse(row.value); } catch { /* ignore */ }
        for (const c of cats) {
          if (!c.name) continue;
          const kw = Array.isArray(c.keywords) ? c.keywords : [];
          try {
            await p.query(
              `UPDATE categories SET keywords = $1 WHERE name = $2`,
              [kw, c.name]
            );
          } catch { /* skip */ }
        }
        // Ensure Industry category exists
        try {
          await p.query(
            `INSERT INTO categories (name, color, keywords, sort_order)
             VALUES ('Industry', '#94a3b8', $1, 99) ON CONFLICT (name) DO UPDATE SET keywords = $1`,
            [cats.find(c => c.name === 'Industry')?.keywords || []]
          );
        } catch { /* skip */ }
        await prepare("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (tenant_id, key) DO NOTHING").run('_migrated_cat_keywords_v2', '1');
        console.log('✅ Refreshed category keywords (v2)');
      }
    }
  } catch (err) { console.error('[DB] category keyword refresh error:', err.message); }

  // Backfill slugs for any voices missing one
  try {
    const noSlug = await prepare('SELECT id, name FROM voices WHERE slug IS NULL OR slug = \'\'').all();
    for (const v of noSlug) {
      const slug = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      try { await prepare('UPDATE voices SET slug = $1 WHERE id = $2').run(slug, v.id); } catch { /* slug conflict, skip */ }
    }
  } catch { /* non-fatal */ }

  // ── Writers table migration: seed from voices + re-point FKs ──
  try {
    const migDone = await prepare("SELECT value FROM settings WHERE key = 'writers_migration_done'").get();
    if (!migDone) {
      const vCount = await prepare('SELECT COUNT(*) AS cnt FROM voices').get();
      const wCount = await prepare('SELECT COUNT(*) AS cnt FROM writers').get();
      // Seed writers from voices if voices exist and writers table is empty
      if (parseInt(vCount.cnt) > 0 && parseInt(wCount.cnt) === 0) {
        await p.query(`
          INSERT INTO writers (name, slug, avatar_url, bio, beat, keywords, system_prompt,
            is_auto, synthesis_schedule, synthesis_lookback_hours, min_cluster_size, voice_id, created_at)
          SELECT name, slug, avatar_url, bio, beat, keywords, system_prompt,
            is_auto, synthesis_schedule, synthesis_lookback_hours, min_cluster_size, id, created_at
          FROM voices
        `);
        console.log('  Writers seeded from voices table');

        // Build old voice_id → new writer_id mapping and update FKs
        const mapping = await prepare('SELECT id AS writer_id, voice_id AS old_voice_id FROM writers').all();
        for (const m of mapping) {
          await p.query('UPDATE articles SET writer_id = $1 WHERE writer_id = $2', [m.writer_id, m.old_voice_id]);
          await p.query('UPDATE writer_follows SET writer_id = $1 WHERE writer_id = $2', [m.writer_id, m.old_voice_id]);
        }
      }

      // Always re-point FK constraints to writers table (fixes fresh installs where
      // the initial schema creates writer_id REFERENCES voices(id))
      const artFks = await p.query(`
        SELECT con.conname FROM pg_constraint con
        JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
        WHERE con.conrelid = 'articles'::regclass AND con.contype = 'f' AND att.attname = 'writer_id'
      `);
      for (const row of artFks.rows) {
        await p.query(`ALTER TABLE articles DROP CONSTRAINT "${row.conname}"`);
      }
      const wfFks = await p.query(`
        SELECT con.conname FROM pg_constraint con
        JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
        WHERE con.conrelid = 'writer_follows'::regclass AND con.contype = 'f' AND att.attname = 'writer_id'
      `);
      for (const row of wfFks.rows) {
        await p.query(`ALTER TABLE writer_follows DROP CONSTRAINT "${row.conname}"`);
      }
      try { await p.query('ALTER TABLE articles ADD CONSTRAINT articles_writer_id_writers_fkey FOREIGN KEY (writer_id) REFERENCES writers(id) ON DELETE SET NULL'); } catch { /* already exists */ }
      try { await p.query('ALTER TABLE writer_follows ADD CONSTRAINT writer_follows_writer_id_writers_fkey FOREIGN KEY (writer_id) REFERENCES writers(id) ON DELETE CASCADE'); } catch { /* already exists */ }
      await p.query("INSERT INTO settings (key, value) VALUES ('writers_migration_done', '1') ON CONFLICT (tenant_id, key) DO NOTHING");
      console.log('✅ Writers migration complete');
    }
  } catch (err) { console.error('[DB] writers migration error:', err.message); }

  // Seed writer_beats junction from legacy writers.beat column (one-time migration)
  try {
    const wbDone = await prepare("SELECT value FROM settings WHERE key = 'writer_beats_migration_done'").get();
    if (!wbDone) {
      const writersWithBeat = await prepare("SELECT id, beat FROM writers WHERE beat IS NOT NULL AND beat != ''").all();
      let seeded = 0;
      for (const w of writersWithBeat) {
        const cat = await prepare("SELECT id FROM categories WHERE name = $1").get(w.beat);
        if (cat) {
          try {
            await p.query('INSERT INTO writer_beats (writer_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [w.id, cat.id]);
            seeded++;
          } catch { /* skip */ }
        }
      }
      await p.query("INSERT INTO settings (key, value) VALUES ('writer_beats_migration_done', '1') ON CONFLICT (tenant_id, key) DO NOTHING");
      if (seeded > 0) console.log(`✅ Seeded ${seeded} writer_beats from legacy beat column`);
    }
  } catch (err) { console.error('[DB] writer_beats seed error:', err.message); }

  // ── Voice deprecation: copy ElevenLabs voice IDs directly to writers ──
  try {
    const vdDone = await prepare("SELECT value FROM settings WHERE key = 'voice_deprecation_done'").get();
    if (!vdDone) {
      // Copy ElevenLabs voice_id string from voices table to writers that reference them
      await p.query(`
        UPDATE writers w
        SET elevenlabs_voice_id = v.voice_id
        FROM voices v
        WHERE w.voice_id = v.id AND w.elevenlabs_voice_id IS NULL
      `);
      await p.query("INSERT INTO settings (key, value) VALUES ('voice_deprecation_done', '1') ON CONFLICT (tenant_id, key) DO NOTHING");
      console.log('✅ Voice deprecation migration: copied ElevenLabs voice IDs to writers');
    }
  } catch (err) { console.error('[DB] voice deprecation migration error:', err.message); }

  // Backfill is_system=true for system agent roles that predate the flag
  try {
    await prepare(
      "UPDATE writers SET is_system = true WHERE role IN ('editor', 'designer', 'copy-editor') AND (is_system = false OR is_system IS NULL)"
    ).run();
  } catch { /* non-fatal */ }

  // Backfill slugs for writers missing one
  try {
    const noSlug = await prepare("SELECT id, name FROM writers WHERE slug IS NULL OR slug = ''").all();
    for (const w of noSlug) {
      const slug = w.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      try { await prepare('UPDATE writers SET slug = $1 WHERE id = $2').run(slug, w.id); } catch { /* slug conflict, skip */ }
    }
  } catch { /* non-fatal */ }

  // ── Seed feature definitions + plan features ──────────────────────
  try {
    const { FEATURE_DEFINITIONS, PLAN_FEATURE_SEEDS } = require('./lib/feature-registry');
    // Seed feature definitions (idempotent)
    for (const fd of FEATURE_DEFINITIONS) {
      await p.query(
        `INSERT INTO feature_definitions (key, name, description, category, value_type, default_value, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (key) DO UPDATE SET name = $2, description = $3, category = $4, value_type = $5, default_value = $6, sort_order = $7`,
        [fd.key, fd.name, fd.description, fd.category, fd.value_type, fd.default_value, fd.sort_order]
      );
    }
    // Seed plan features — merge defaults with per-plan overrides
    const plans = ['free', 'starter', 'pro', 'business', 'internal'];
    for (const plan of plans) {
      const planSeeds = PLAN_FEATURE_SEEDS[plan] || {};
      for (const fd of FEATURE_DEFINITIONS) {
        const value = planSeeds[fd.key] !== undefined ? planSeeds[fd.key] : fd.default_value;
        const dbValue = value === null ? null : String(value);
        await p.query(
          `INSERT INTO plan_features (plan, feature_key, value) VALUES ($1, $2, $3)
           ON CONFLICT (plan, feature_key) DO NOTHING`,
          [plan, fd.key, dbValue]
        );
      }
    }
    console.log(`✅ Seeded ${FEATURE_DEFINITIONS.length} feature definitions across ${plans.length} plans`);
  } catch (err) { console.error('[DB] Feature seed error:', err.message); }

  // Backfill: if an existing Iris/Maxwell writer was seeded before role was added (or a prior
  // role-save failure left role=NULL), repair the role. Idempotent.
  try {
    await p.query(`UPDATE writers SET role = 'designer' WHERE LOWER(name) = 'iris' AND (role IS NULL OR role != 'designer')`).catch(() => {});
    await p.query(`UPDATE writers SET role = 'editor' WHERE LOWER(name) = 'maxwell' AND (role IS NULL OR role != 'editor')`).catch(() => {});
  } catch (_) { /* writers table may not exist yet in fresh envs — ignore */ }

  // Seed admin user (only if ADMIN_PASSWORD env var is set — otherwise setup wizard handles it)
  if (process.env.ADMIN_PASSWORD) {
    const existingAdmin = await prepare('SELECT id FROM users WHERE username = $1').get('admin');
    if (!existingAdmin) {
      const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
      await prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES ($1, $2, $3, $4)').run('admin', hash, 'owner', 'Admin');
      console.log('✅ Seeded admin user');
    }
  }

  // Migrate ADMIN_EMAILS to users table (one-time)
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  for (const email of adminEmails) {
    const existing = await prepare('SELECT id FROM users WHERE LOWER(email) = $1 AND tenant_id = 1').get(email);
    if (!existing) {
      const username = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 50);
      const displayName = username.charAt(0).toUpperCase() + username.slice(1);
      const randomHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
      try {
        await prepare(
          'INSERT INTO users (username, password_hash, email, display_name, role, tenant_id) VALUES ($1, $2, $3, $4, $5, 1)'
        ).run(username, randomHash, email, displayName, 'owner');
        console.log(`  ✅ Migrated ADMIN_EMAIL to users: ${email}`);
      } catch { /* duplicate username, skip */ }
    }
  }

  // ── Writing styles: table + system seeds ──────────────────────
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS writing_styles (
        id          SERIAL PRIMARY KEY,
        tenant_id   INTEGER NOT NULL DEFAULT 0,
        name        VARCHAR(100) NOT NULL,
        slug        VARCHAR(120) NOT NULL,
        description TEXT,
        prompt      TEXT NOT NULL,
        category    VARCHAR(50) DEFAULT 'general',
        is_system   BOOLEAN DEFAULT false,
        sort_order  INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tenant_id, slug)
      )
    `);
    await p.query(`ALTER TABLE writers  ADD COLUMN IF NOT EXISTS style_id INTEGER REFERENCES writing_styles(id) ON DELETE SET NULL`);
    await p.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS restyled_content   TEXT`);
    await p.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS restyle_style_id   INTEGER REFERENCES writing_styles(id) ON DELETE SET NULL`);
    await p.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS final_thoughts      TEXT`);
    await p.query(`ALTER TABLE writing_styles ADD COLUMN IF NOT EXISTS sample_output TEXT`);

    const SYSTEM_STYLES = [
      {
        slug: 'the-wire', name: 'The Wire', sort_order: 1,
        description: 'Reuters/AP style — inverted pyramid, just the facts, tight sentences.',
        prompt: `Write in wire-service style (Reuters, AP). Lead sentence contains the single most important fact. Inverted pyramid: most newsworthy first, supporting detail second, background last. Sentences are short and declarative. No opinion, no colour, no adjectives beyond what the facts support. Every claim is attributable. Use past tense for events, present tense for ongoing situations. Spell out jargon immediately on first use. Numbers are precise. Paragraphs are one to two sentences.`,
        sample_output: `MIT researchers developed a technique that reduces large language model energy consumption by 40 percent without degrading output quality, according to a paper published in Nature.\n\nThe method, called selective activation pruning, identifies and disables redundant neural pathways during inference. The researchers tested it on five leading open-source models.\n\nIndustry observers said the technique could significantly lower the cost of running artificial intelligence at scale.`,
      },
      {
        slug: 'the-explainer', name: 'The Explainer', sort_order: 2,
        description: 'Vox-style — "here\'s why this matters", analogies, reader-first.',
        prompt: `Write in modern explainer style (Vox, The Atlantic). Open by answering "why does this matter to the reader?" before explaining what happened. Define every technical term immediately after first use. Use concrete analogies to make abstract ideas tangible. Subheadings guide readers through sections. End each section with a clear takeaway. Assume the reader is intelligent but not an expert — never condescending, never lost.`,
        sample_output: `Running AI is expensive — and not just in dollars. The massive neural networks powering today's AI systems consume enormous amounts of electricity every time they answer a question. That may be about to change.\n\nResearchers at MIT say they've cut that energy cost by 40 percent using a technique called selective activation pruning. Think of it like turning off the lights in rooms nobody is using: the method identifies neural pathways inside a model that aren't contributing meaningfully to its answers, then deactivates them during each response.\n\nCritically, the quality of the AI's output doesn't suffer. The team verified this across five major open-source models and published their findings in Nature.\n\nThe takeaway: cheaper, greener AI is closer than it looked.`,
      },
      {
        slug: 'the-columnist', name: 'The Columnist', sort_order: 3,
        description: 'Strong POV, thesis-first, confident opinion journalism.',
        prompt: `Write with a strong, clear point of view. Open with your thesis — don't bury it. Hook the reader in the first three sentences and declare your argument. Support it with evidence but own your opinion; don't hide behind the data. Use vivid, specific language. Short paragraphs. End with a memorable close that reinforces your thesis. The voice should feel like a confident, informed friend who has a clear take and isn't afraid to say so.`,
        sample_output: `The AI industry has spent years telling us that power-hungry models are simply the price of progress. MIT just called that bluff.\n\nResearchers there have slashed large language model energy consumption by 40 percent — without touching output quality. Their method, selective activation pruning, doesn't require new hardware or a ground-up redesign. It just stops AI systems from doing redundant work they were already doing for no good reason.\n\nFive models tested. Published in Nature. The results held.\n\nThis isn't a marginal tweak. It's proof that the industry's energy crisis is, at least in part, a complacency problem. If MIT can find 40 percent headroom, the question isn't whether more efficiency is possible — it's why it took this long to look.`,
      },
      {
        slug: 'the-longread', name: 'The Longread', sort_order: 4,
        description: 'Magazine depth — narrative arc, scene-setting, immersive prose.',
        prompt: `Write in longform magazine style (The New Yorker, WIRED). Open with a scene, anecdote, or vivid detail that draws the reader in before introducing the news hook. Build a narrative arc with a clear beginning, middle, and end. Characters and direct quotes bring the story to life. Weave data and context into the narrative rather than bolting them on as bullet points. Every paragraph earns its place. The prose should reward careful, unhurried reading.`,
        sample_output: `The model was doing too much. That was the intuition — not yet a proof, not yet a paper, just a nagging suspicion shared among a small team at MIT who had spent months staring at the internals of large language models and noticing something strange: vast stretches of the network seemed to fire on every query, regardless of whether those pathways contributed anything useful to the answer.\n\nWhat followed was a methodical hunt for waste. The result, now published in Nature, is a technique called selective activation pruning — a way of identifying and silencing redundant neural pathways during inference, the moment when a model is actually generating a response. The energy savings: 40 percent. The quality loss: none detectable across five leading open-source models.\n\nFor an industry that has grown accustomed to trading kilowatts for capability, it's an uncomfortable finding. The implication isn't just that AI can be made cheaper to run. It's that a meaningful portion of what these systems currently do, at enormous energetic cost, is work they didn't need to do in the first place.`,
      },
      {
        slug: 'the-brief', name: 'The Brief', sort_order: 5,
        description: 'Ultra-compact — 3–5 bullets plus one closing line, under 120 words.',
        prompt: `Write in ultra-compact briefing format. Structure: three to five bullet points, each a single complete idea with no filler, followed by one closing sentence that gives the "so what." The lead bullet is the most important fact. Total word count must not exceed 120 words. No preamble, no padding, no attribution sentences — every word earns its place. Optimised for reading in under 30 seconds on a mobile device.`,
        sample_output: `• MIT cut large language model energy use by 40% with no quality loss.\n• Method: selective activation pruning — disables redundant neural pathways during inference.\n• Validated across five open-source models; published in Nature.\n• Industry observers say it could sharply reduce the cost of running AI at scale.\n\nIf it scales, this reframes the AI energy debate entirely.`,
      },
      {
        slug: 'the-enthusiast', name: 'The Enthusiast', sort_order: 6,
        description: 'High energy, accessible, knowledgeable — like a passionate expert.',
        prompt: `Write with high energy and genuine enthusiasm for the subject. Tone is knowledgeable but accessible — a passionate expert explaining something they love to a smart friend. Use vivid, concrete language. Short sentences mixed with slightly longer ones for rhythm. Avoid dry academic phrasing. Don't talk down to the reader, but don't assume expertise either. Express genuine excitement about breakthroughs and discoveries where warranted. Close with a forward-looking line about what comes next.`,
        sample_output: `Here's something that should genuinely excite you: MIT researchers just found a way to make large language models 40 percent more energy-efficient — without sacrificing a single percentage point of quality.\n\nThe technique is called selective activation pruning. Here's the core idea: modern AI models are enormous, and during inference — when the model is actually generating output — huge portions of the neural network fire even when they're not contributing anything useful. Pruning identifies those redundant pathways and switches them off. It's elegant, and it works.\n\nThey tested it on five leading open-source models. Published in Nature. The results held across the board.\n\nThis is the kind of paper that makes you optimistic about where AI efficiency research is heading — and it suggests there's a lot more headroom left to find.`,
      },
    ];

    for (const s of SYSTEM_STYLES) {
      await p.query(
        `INSERT INTO writing_styles (tenant_id, name, slug, description, prompt, sample_output, is_system, sort_order)
         VALUES (0, $1, $2, $3, $4, $5, true, $6)
         ON CONFLICT (tenant_id, slug) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description,
           prompt = EXCLUDED.prompt, sample_output = EXCLUDED.sample_output,
           sort_order = EXCLUDED.sort_order`,
        [s.name, s.slug, s.description, s.prompt, s.sample_output, s.sort_order]
      );
    }
  } catch (err) {
    if (!/already exists/i.test(err.message)) console.error('[DB] writing_styles setup:', err.message);
  }

  // Scheduled publishing — publish_at holds article until drop window; status = 'scheduled' bridges approved → published.
  await p.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ DEFAULT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_articles_scheduled ON articles(tenant_id, status, publish_at) WHERE status = 'scheduled'`);
  // Thread target_publish_at from budget slot → story pitch so synthesis can seed articles.publish_at.
  await p.query(`ALTER TABLE story_pitches ADD COLUMN IF NOT EXISTS target_publish_at TIMESTAMPTZ DEFAULT NULL`);

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

  _dbReady = true;
  console.log('✅ Postgres database initialized');
  return p;
}

module.exports = { init: initDb, prepare, getPool, isDbReady, connectAndInit };
