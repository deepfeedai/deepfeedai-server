# Changelog

All notable changes to Deep Feed AI Admin are documented here.

---

## [Unreleased]
> Features planned or in progress

- **Phase 2 — HeyGen avatar video** — async video generation endpoint, MP4 download + DB storage, admin polling UI, video modal on article page
- Up to 3 featured articles with priority ordering
- Newsletter send interface
- Analytics dashboard (page views, subscriber growth)

---

## [3.1.0] — 2026-03-10

### Added
- **AI-generated article thumbnails** — new `POST /api/media/generate-image` endpoint in `routes/media.js`
  - Accepts `{ articleId }`, fetches the article from DB, and runs a two-step AI pipeline
  - **Step 1 — Gemini visual concept:** uses `gemini-2.5-flash-lite` to write a short (≤40 words) abstract, cinematic visual concept for the article based on title, summary, and category
  - **Step 2 — Imagen 3 generation:** calls `imagen-3.0-generate-002` with the visual concept combined with a category-specific style preset (LLMs, Research, Tools, Policy, Business, CyberSecurity, Image AI, Industry, Agents, Hardware) at 16:9 aspect ratio
  - **Storage:** uploads PNG to Cloudflare R2 (`images/article-{id}.png`) when R2 is configured; falls back to local `public/media/images/` in dev
  - **DB update:** saves CDN/local URL to `articles.image_url`; main site picks up the new image automatically on next load
  - Includes 30-second timeout on Imagen API call; falls back to title-based prompt if Gemini concept step fails
- **🎨 Generate AI image button** in admin articles table — appears on all non-archived articles in the actions column; shows ⏳ spinner while generating, restores on error

---

## [3.0.0] — 2026-03-10

### Added
- **Voice Characters system** — full multi-voice management for ElevenLabs TTS audio generation
  - `voices` table: stores name, ElevenLabs voice ID, description, avatar image URL, and default flag
  - `settings` table: key/value store for admin-managed config (e.g. API key overrides)
  - `GET/POST/PUT/DELETE /api/voices` — full CRUD; delete auto-reassigns default if needed
  - `PUT /api/voices/:id/default` — set any voice as the global default
  - `POST /api/voices/:id/avatar` — upload avatar as base64 dataURL; stored to Cloudflare R2 (production) or local filesystem (dev)
  - `GET/PUT /api/settings` — upsert key/value settings; supports `elevenlabs_api_key` override
  - `POST /api/voices/preview` — generates a TTS preview clip (up to 500 chars) using selected voice; returns base64 MP3
- **Voice picker on audio generation** — "🎙️ Generate" button now opens a voice selection modal showing all available voices with avatars; pre-selects the default; selected voice is sent with the request
- **Voice snapshot on articles** — `audio_voice_name` and `audio_voice_avatar_url` stored on each article at audio generation time; survives voice edits/deletions
- **Voices page** (`/voices.html`) — full voice management UI: table with avatar, name, voice ID, description, default badge; add/edit modal with avatar upload + preview; set-default button
- **Voice Test Studio** — panel at the top of `/voices.html` with editable sample text (500 char limit with live counter), voice dropdown, ▶ Test Voice button, live playback with avatar + name display, ⏹ Stop button
- **Settings page** (`/settings.html`) — ElevenLabs API key override input (password field, show/hide toggle); saved to DB, overrides env var at runtime; falls back to env var if blank
- **Sidebar nav updated** — Voices and Settings links added to all admin pages (`index.html`, `articles.html`, `sources.html`)
- Express body size limit raised to **10 MB** to support base64 avatar image uploads in JSON

### Changed
- `POST /api/media/generate-audio` — now accepts optional `voiceId`; resolves voice from `voices` table (explicit → default → env var fallback); resolves API key from `settings` table (DB → env var fallback); stores `audio_voice_name` and `audio_voice_avatar_url` snapshot on the article

---

## [2.1.0] — 2026-03-09

### Added
- **48-hour article age filter** — RSS fetch now skips any article whose `pubDate` is older than 48 hours; prevents stale historical articles from polluting the feed; articles without a `pubDate` are still accepted; old articles counted in the `skipped` total returned by `POST /api/fetch`
- **Original article link in admin** — articles table actions column now includes a 🔗 button that opens `source_url` in a new tab (`rel="noopener"`); only rendered when `source_url` is present

### Fixed
- **Cloudflare R2 audio storage live in production** — `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and `R2_PUBLIC_URL` env vars confirmed set in Railway; audio generation now uploads MP3s directly to R2 and stores the full CDN URL in the DB; confirmed working end-to-end

---

## [2.0.0] — 2026-03-09

### Added
- **Production deployment on Railway** — admin backend fully deployed and live at `https://deepfeedai-admin-production.up.railway.app`
- **PostgreSQL support** — `db.js` rewritten for `pg` Pool; `normalizeSql()` converts `?` → `$N` params and `datetime('now')` → `NOW()` / `INTERVAL` syntax transparently; `serializeRow()` normalises pg `Date` objects to ISO strings
  - Schema updated: `SERIAL PRIMARY KEY`, `TIMESTAMPTZ DEFAULT NOW()`, `BOOLEAN` types
  - `prepare().run/get/all` all return Promises — all callers updated to `async/await`
  - `INSERT … RETURNING *` pattern replaces "insert then SELECT" pattern
  - `sql.js` removed from dependencies; `pg` added
- **Cloudflare R2 audio storage** — `routes/media.js` uploads MP3s to R2 via `@aws-sdk/client-s3` when `R2_*` env vars are set; falls back to local `public/media/audio/` in dev; CDN URL stored in DB for production, relative path for dev
- **`railway.json`** — healthcheck on `GET /api/news/updated-at`, `restartPolicyType: ON_FAILURE`
- **`.env.example`** — documents all required env vars: `PORT`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `DATABASE_URL`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `R2_*`

### Changed
- **CORS** — replaced strict origin allowlist with `cors()` (open); security handled entirely by JWT on all authenticated endpoints; strict CORS was causing 500s when the admin panel's own browser called its own API
- **OG image enrichment** — wrapped in `setImmediate()` (fire-and-forget); `POST /api/fetch` now responds immediately with inserted/skipped counts; enrichment continues in the background
- **`fetchHtml()` timeout** — added `req.destroy()` call in the `timeout` event handler; previously the socket stayed open after the timeout event fired, causing concurrent scrapes to hang indefinitely
- **Purge cron** — updated to use `NOW() - INTERVAL '24 hours'` syntax for Postgres
- **Server startup** — `db.init()` awaited before `app.listen()`; admin user seeded on first run

### Fixed
- **All routes** — converted to `async/await`; every `db.prepare().run/get/all` call properly awaited (pg returns Promises; previously only sql.js-style sync was used)
- **Fetch endpoint hanging** — two-part fix: socket abort on timeout + fire-and-forget OG enrichment (see Changed above)

---

## [1.3.0] — 2026-03-09

### Added
- **Soft-delete / archive system** — articles can be archived instead of permanently deleted; archived articles are hidden from `/api/news` and trigger a cache bust on the main site; a 24-hour cron purges records older than 24 hours automatically
  - `is_archived INTEGER DEFAULT 0` and `archived_at TEXT` columns added to DB
  - `PUT /api/articles/:id/archive` — move to archive
  - `PUT /api/articles/:id/restore` — restore from archive
  - `DELETE /api/articles/:id/purge` — hard delete (admin only, for immediate removal)
  - Archive tab on articles page with restore/purge actions per row
- **ElevenLabs audio generation (Phase 1)** — generate MP3 narrations for any published article directly from the admin panel
  - `POST /api/media/generate-audio` — Gemini 2.5 Flash Lite writes a natural 2–3 sentence spoken-word news anchor script, then ElevenLabs TTS converts it to MP3 and saves to `public/media/audio/{slug}-{id}.mp3`
  - `DELETE /api/media/audio/:id` — remove audio file and clear DB record
  - `PUT /api/media/toggle/:id` — toggle `media_enabled` (controls whether the audio player appears on the main site)
  - Audio script (TTS text) stored as `audio_transcript` for karaoke caption display on the main site
  - Falls back to cleaned RSS summary if Gemini is unavailable; text capped at 900 chars (ElevenLabs limit)
- **Audio columns in DB** — `audio_url TEXT`, `audio_status TEXT` (`null | pending | ready | error`), `audio_transcript TEXT`, `media_enabled INTEGER DEFAULT 0` added to `articles` table via migration
- **Audio column in admin articles table** — per-row controls: Generate button, ▶ preview player, 🗑 delete, ✅ On/Off toggle; status badge reflects `audio_status`
- **`audio_transcript` exposed in `/api/article?slug=`** — single article lookup now returns the stored TTS script so the main site can render karaoke captions client-side
- **`/media/*` served statically** — `public/media/` mounted as a static directory; audio files accessible at `/media/audio/{filename}.mp3`

### Changed
- **`buildTtsText()`** in `routes/media.js` prefers the Gemini-written spoken summary over raw RSS content; strips markdown, limits to 900 chars
- **`/api/news` `SELECT *`** — automatically includes all new audio columns without query changes

### Fixed
- **`db.prepare().all()` used consistently** — `db.all()` does not exist in sql.js; corrected in `routes/article.js` (was causing silent 500s on slug lookups)

---

## [1.2.0] — 2026-03-09
### Added
- **AI summaries** (`GET /api/summary`) — Gemini 2.5 Flash Lite generates structured TLDRs (overview, key points, why it matters); in-memory cache per process; same interface as the Vercel serverless function
- **Single article lookup** (`GET /api/article?slug=`) — public endpoint for `article.html` to fetch a single article by URL slug for direct/shared links
- **URL auto-fill** (`GET /api/fetch-url?url=`) — scrapes Open Graph tags and JSON-LD structured data from any public URL to auto-populate the Add Article form (title, image, summary, source, author, date)
- **Cache invalidation endpoint** (`GET /api/news/updated-at`) — lightweight endpoint returning the latest `updated_at` timestamp; used by the main site to detect DB changes and bust localStorage cache immediately
- **`serve.js` proxy** — main site dev server now proxies `/api/*` to the admin, enabling AI summaries and article lookups locally

### Changed
- **Single featured article enforced** — featuring an article automatically unfeatures all others; enforced on toggle, create, and edit
- **Featured articles sorted first** — `/api/news` now orders by `is_featured DESC, published_at DESC`
- **Toggle functions reload from server** — publish/feature toggles re-fetch the full article list after each action, eliminating stale local state that caused table clearing
- **`dotenv` uses `override: true`** — `.env` file takes precedence over any system environment variables (fixes expired system-level `GEMINI_API_KEY` override)
- **Author extraction improved** — `fetch-url` now parses JSON-LD structured data for author in addition to meta tags (fixes missing author on sites like The Verge)

### Fixed
- **`updated_at` column added** to `articles` table — tracked on all mutations (update, toggle publish, toggle feature, delete)
- **`is_featured` enforced on article save** — creating or editing an article with `is_featured: true` unfeatured all others first

---

## [1.1.0] — 2026-03-09
### Added
- **RSS auto-fetch** (`POST /api/fetch`) — fetches all active sources, deduplicates by URL, inserts new articles as drafts; triggered manually or via cron
- **30-minute cron job** — auto-fetches RSS sources every 30 min; new articles saved as drafts for review
- **"Fetch All Sources" button** on sources page — manual trigger with result summary alert
- **`last_fetched` column** on sources — shows when each source was last fetched
- **`rss-parser` + `node-cron`** dependencies added

### Changed
- **Category removed from sources** — category is detected per-article via keyword matching, not per-source
- **Sources table simplified** — removed category column from UI and API

---

## [1.0.0] — 2026-03-07
### Added
- Initial release — Express + SQLite admin panel
- JWT authentication with bcrypt password hashing
- Full CRUD for articles and RSS sources
- Mobile-friendly dark-theme UI (dashboard, articles, sources)
- Public `/api/news` endpoint for main site consumption
- Default seed: admin user + The Verge AI RSS source
