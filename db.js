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
      min_cluster_size         INTEGER DEFAULT 3,
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
    `INSERT INTO settings (key, value) VALUES ('site_categories', '${JSON.stringify([
      {"name":"LLMs","color":"#7c3aed","keywords":["gpt-3","gpt-4","gpt4o","gpt-5","o1-preview","o1-mini","o3","o3-mini","o4-mini","claude","sonnet","opus","haiku","gemini","gemini pro","gemini ultra","llama","mistral","mixtral","falcon","phi","qwen","deepseek","grok","command r","llm","llms","large language model","language model","foundation model","base model","multimodal model","vision language","text generation","context window","system prompt","prompt engineering","few-shot","zero-shot","chain of thought","retrieval augmented","rag","tokenizer","transformer","attention mechanism","token limit","inference","openai","anthropic","cohere","ai21","mistral ai","together ai","perplexity","xai","inflection","groq"]},
      {"name":"Image AI","color":"#0ea5e9","keywords":["midjourney","dall-e","stable diffusion","stability ai","ideogram","firefly","leonardo","flux","sora","runway","kling","pika","gen-2","gen-3","veo","lumiere","cogvideo","imagen","text to image","text to video","image generation","video generation","image synthesis","diffusion model","latent diffusion","generative image","ai art","ai generated image","text to speech","speech synthesis","voice cloning","tts","audio generation","music generation","suno","udio","synthetic media","ai video","ai image","visual generation","inpainting","outpainting","img2img"]},
      {"name":"Research","color":"#22d3ee","keywords":["arxiv","neurips","icml","iclr","acl","emnlp","cvpr","iccv","naacl","preprint","research paper","new paper","paper proposes","paper introduces","dataset","benchmark","evaluation framework","evals","ablation","hyperparameter","alignment","interpretability","mechanistic interpretability","scaling law","emergent ability","adversarial robustness","pretraining","fine-tuning","rlhf","dpo","reward model","constitutional ai","ai safety research","ai alignment","hallucination","hallucinations","researchers found","researchers developed","researchers propose","university researchers","deepmind research","google brain","openai research","meta research","peer review","state of the art","novel approach","breakthrough"]},
      {"name":"Tools","color":"#34d399","keywords":["github copilot","cursor ai","codeium","tabnine","codex","devin","replit","aider","mcp","model context protocol","function calling","tool use","ai agent","agentic","multi-agent","autonomous agent","chatbot","ai assistant","virtual assistant","copilot","workflow automation","ai coding","code generation","ai developer tool","no-code","low-code","zapier","n8n","automation platform","langchain","llamaindex","vector database","pinecone","weaviate","chroma","ai search","semantic search","ai api","developer platform"]},
      {"name":"Business","color":"#f59e0b","keywords":["series a","series b","series c","seed round","venture round","funding round","raised $","secures $","acquisition","merger","ipo","valuation","unicorn","spac","ai funding","ai investment","ai investor","venture capital","andreessen","sequoia","a16z","softbank","revenue","earnings","quarterly earnings","fiscal quarter","market share","share price","ai startup","ai company","layoff","laid off","job cuts","restructuring","downsizing","ai partnership","ai deal","enterprise ai","billion dollar","market cap"]},
      {"name":"Policy","color":"#f97316","keywords":["eu ai act","ai act","executive order","ai regulation","ai bill","ai law","ai legislation","ai lawsuit","sued over ai","ai litigation","court ruling","ai settlement","ftc","doj","congress","senate","parliament","ai regulation","ai legislation","ai policy","ai compliance","gdpr","ccpa","biometric","ai copyright","intellectual property","fair use","training data lawsuit","ai ethics","algorithmic bias","ai fairness","ai transparency","misinformation","disinformation","deepfake legislation","ai governance","ai oversight","ai moratorium","ai accountability","data privacy"]},
      {"name":"CyberSecurity","color":"#ef4444","keywords":["cyberattack","cyber attack","ransomware","malware","phishing","zero day","zero-day","exploit","vulnerability","cve","ai security","llm security","prompt injection","jailbreak","adversarial attack","model theft","model extraction","hacker","hacking","data breach","intrusion","threat actor","apt","nation state","cybersecurity","infosec","soc","siem","threat intelligence","penetration testing","red team security","ai powered attack","ai generated phishing","deepfake fraud","voice clone fraud","security vulnerability","security flaw","cybercrime","botnet","supply chain attack","credential stuffing"]},
      {"name":"Industry","color":"#94a3b8","keywords":["ai in healthcare","ai in education","ai in finance","ai in entertainment","ai in gaming","ai in manufacturing","ai in retail","ai in agriculture","ai in legal","ai in automotive","self-driving","autonomous vehicle","robotics","robot","humanoid","ai adoption","digital transformation","ai strategy","ai workforce","ai jobs","ai replace","ai impact","ai powered","artificial intelligence","generative ai","machine learning","deep learning","neural network","computer vision","natural language processing","nlp","ai chip","ai hardware","gpu","tpu","nvidia","amd","intel ai","qualcomm ai","edge ai","on-device ai","ai infrastructure","cloud ai","ai market","ai industry","ai trend","ai forecast","ai report"]}
    ])}') ON CONFLICT (key) DO NOTHING`,
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
    // Phase 2: Multi-beat writers junction table
    `CREATE TABLE IF NOT EXISTS writer_beats (
      id          SERIAL PRIMARY KEY,
      writer_id   INTEGER NOT NULL REFERENCES writers(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      UNIQUE(writer_id, category_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_writer_beats_writer   ON writer_beats(writer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_writer_beats_category ON writer_beats(category_id)`,
    // Phase 3: Writer style profile columns
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS tone TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS expertise_level TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS style_guide TEXT`,
    `ALTER TABLE writers ADD COLUMN IF NOT EXISTS few_shot_examples JSONB DEFAULT '[]'`,
  ];
  for (const sql of migrations) {
    try { await p.query(sql); } catch { /* already exists */ }
  }

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
        await prepare("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING").run('_migrated_cat_keywords_v2', '1');
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
      if (parseInt(vCount.cnt) > 0) {
        // Seed writers from voices if not already done
        if (parseInt(wCount.cnt) === 0) {
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

        // Drop ALL FK constraints on writer_id columns, then add new ones pointing to writers
        // Find actual constraint names dynamically (names may vary across environments)
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
        console.log('  FK constraints re-pointed to writers table');
      }
      await p.query("INSERT INTO settings (key, value) VALUES ('writers_migration_done', '1') ON CONFLICT (key) DO NOTHING");
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
      await p.query("INSERT INTO settings (key, value) VALUES ('writer_beats_migration_done', '1') ON CONFLICT (key) DO NOTHING");
      if (seeded > 0) console.log(`✅ Seeded ${seeded} writer_beats from legacy beat column`);
    }
  } catch (err) { console.error('[DB] writer_beats seed error:', err.message); }

  // Backfill slugs for writers missing one
  try {
    const noSlug = await prepare("SELECT id, name FROM writers WHERE slug IS NULL OR slug = ''").all();
    for (const w of noSlug) {
      const slug = w.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      try { await prepare('UPDATE writers SET slug = $1 WHERE id = $2').run(slug, w.id); } catch { /* slug conflict, skip */ }
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
