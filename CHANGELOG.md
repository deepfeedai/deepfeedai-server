# Changelog

All notable changes to Deep Feed AI Admin are documented here.

---

## [Unreleased]
> Features planned or in progress

- **HeyGen avatar video** — async video generation endpoint, MP4 download + DB storage, admin polling UI, video modal on article page

---

## [1.12.0] — 2026-03-14

### Added — Site Branding & Theme Customization
- **Shared R2 upload helper** — extracted `lib/r2.js` from voices.js; reused by logo upload and avatar upload
- **Logo/favicon upload** — `POST /api/settings/logo` endpoint accepts base64 dataUrl, stores to R2 under `branding/`, saves URL in settings table
- **Upload widgets** — Settings > General > Branding now has file picker + preview for site logo and favicon (max 2MB)
- **Extended color tokens** — 7 configurable theme colors: accent, background, surface, border, text, muted, accent hover
- **Theme presets** — 4 one-click presets: Dark Blue, Dark Cyan, Dark Purple, Midnight Green
- **Frontend consumption** — `brand.js` applies all 7 CSS custom properties + renders uploaded logo/favicon from site config

---

## [1.11.0] — 2026-03-14

### Changed — Admin UI Overhaul
- **DRY sidebar** — extracted duplicated sidebar HTML from 10 pages into shared `renderSidebar()` function in `admin.js`
- **Grouped navigation** — organized flat 10-item nav into 5 groups: Overview, Content, Engagement, Monitoring, System
- **Auto-active detection** — replaced hardcoded `active` class with automatic pathname matching
- **Settings tabs** — reorganized single long-scroll page into 4 tabs: General, Integrations, Content, Moderation
- **Consolidated API keys** — moved ElevenLabs, Imagen, Perspective, GA, and AdSense configs under Integrations tab
- Selected settings tab persists via `sessionStorage`

---

## [1.10.1] — 2026-03-14

### Fixed
- **Synthesis slugs** — stop appending timestamp to every synthesized article slug; timestamp now only used as fallback when title produces an empty slug

---

## [1.10.0] — 2026-03-14

### Added — Phase 4: Writer Follows & Following Feed
- **`writer_follows` table** — `(id, user_id FK→public_users, writer_id FK→voices, created_at, UNIQUE(user_id, writer_id))`; auto-created via migration in `db.js`
- **`POST /api/writers/:slug/follow`** — follow a writer (JWT auth); creates `writer_follows` row; returns updated `follower_count`
- **`DELETE /api/writers/:slug/follow`** — unfollow a writer (JWT auth); removes row; returns updated `follower_count`
- **`GET /api/writers/following`** — list writers the authenticated user follows
- **`is_following` annotation** — `GET /api/writers` and `GET /api/writers/:slug` now include `is_following: true/false` when a Bearer token is present
- **`follower_count`** — writer list and detail endpoints include follower count via `LEFT JOIN` on `writer_follows`
- **Following feed** — `GET /api/news?feed=following` filters articles to writers the authenticated user follows
- **Follow notifications** — `createNewArticleNotification(writerId, articleSlug, articleTitle)` added to `routes/notifications.js`; synthesis pipeline notifies followers when a writer publishes an original article
- **ElevenLabs subscription usage card** — AI Usage dashboard now shows ElevenLabs monthly character usage alongside Gemini/Imagen costs

---

## [1.9.0] — 2026-03-14

### Added — Phase 1: AI Usage Tracking & Cost Dashboard
- **`ai_usage` table** — logs every AI API call with provider, model, operation, token counts, estimated cost, and metadata; auto-created via migration in `db.js`
- **`lib/ai-usage.js`** — `logUsage()` helper with `estimateCost()` pricing for Gemini, Imagen, and ElevenLabs models; `extractGeminiTokens()` for automatic token extraction from API responses
- **14 API call sites instrumented** — `logUsage().catch(() => {})` added after every AI API response across `routes/summary.js` (2), `routes/media.js` (3), `routes/thumbnail.js` (1), `routes/trends.js` (1), `lib/synthesis.js` (1), `lib/writer-assign.js` (1), `lib/notify.js` (1), `routes/newsletter.js` (1), `routes/contact.js` (1), `routes/fetch.js` (2)
- **`GET /api/ai-usage/summary`** — dashboard API with `?range=7d|30d|90d`; returns totals by provider, operation, and day with budget status
- **AI Usage admin page** (`public/ai-usage.html` + `public/ai-usage-page.js`) — cost breakdown charts, daily spend, per-operation breakdown, budget warnings
- **AI Usage nav link** — added to sidebar on all admin pages
- **Settings seeded** — `ai_daily_budget`, `ai_budget_warn_pct` defaults added to `db.js`

### Added — Phase 2: Synthesis & Writer Pipeline Improvements
- **Beat-scoped synthesis** — `runSynthesisForWriter()` now filters articles by `writer_id`; falls back to unassigned articles in the writer's beat category if below `min_cluster_size`
- **Quality gate + editorial scoring** — new `lib/quality-gate.js` with `getEditorialScore(article)` returning `{ publish, newsworthiness, feature_worthy, reason }`; synthesized articles start as drafts and auto-publish only if they pass the quality gate
- **`editorial_score` column** — `ALTER TABLE articles ADD COLUMN IF NOT EXISTS editorial_score INTEGER`
- **Auto-thumbnail after synthesis** — `lib/media-helpers.js` extracted from `routes/media.js`; synthesis pipeline auto-generates thumbnails for originals that pass the quality gate
- **Improved writer assignment** — abbreviation map, +2 title match weight, normalized comparisons
- **Settings seeded** — `daily_publish_target` (default `20`), `auto_editorial_scoring` (default `1`)

### Added — Phase 3: Full Autonomy
- **Budget-aware execution** — new `lib/budget.js` with `canSpend(operation)` checking today's spend vs `ai_daily_budget`; wired into synthesis, quality gate, media helpers, and summary routes
- **Auto-publish live news** — hourly cron reads `auto_publish_live` setting; articles run through heuristic checks → editorial scoring → daily target soft cap before publishing
- **Post-publish hooks** — new `lib/post-publish.js` with `onArticlePublished(articleId)`: pre-warm TLDR, generate thumbnail if missing, auto-assign writer; all budget-checked and fire-and-forget
- **Auto-audio cron** — daily `0 8 * * *` cron generates audio for top articles (editorial_score >= 8, featured, or original); capped at `auto_audio_daily_max`; respects `elevenlabs_monthly_chars` limit
- **Budget alerts** — daily cron checks monthly spend vs budget; sends admin email via Resend if over warning threshold
- **Settings seeded** — `auto_publish_live` (default `0`), `auto_publish_quality_gate` (default `1`), `auto_audio_enabled` (default `0`), `auto_audio_daily_max` (default `3`), `elevenlabs_monthly_chars` (default `100000`)

---

## [1.8.10] — 2026-03-11

### Added
- **Purge-all endpoint** — `DELETE /api/articles/purge-all` with dropdown (feed/original/all)
- **Purge originals button** — `DELETE /api/synthesis/purge` for testing
- **Synthesis dedup** — 50% source overlap check, 23h cooldown per writer, force override
- **Writer personas** — AI writer characters with configurable name, beat, bio, avatar, tone, synthesis schedule
- **Writer assignment** — auto-assigns articles to writers by beat/keyword matching
- **Original article synthesis** — clusters related articles and generates original long-form content
- **Public user auth** — JWT-based sign-up/sign-in for public users (separate from admin auth)
- **Comments system** — threaded comments on articles with reply notifications
- **Bookmarks** — save/unsave articles per user
- **Notifications** — in-app notification system for replies and follows

---

## [1.8.9] — 2026-03-10

### Added
- **AI-generated article thumbnails** via Google Imagen 4
  - Two-step pipeline: Gemini writes visual concept → Imagen 4 renders 16:9 image
  - 10 per-category style presets
  - Images stored to Cloudflare R2; local fallback for dev
- **Image column in articles table** — clickable thumbnail with AI badge
- **Bulk image generation** — select multiple articles → Generate Images
- **Image generation settings** — model selector (Standard/Ultra/Fast), API key override

---

## [1.8.8] — 2026-03-10

### Added
- **Voice Characters system** — full multi-voice management for ElevenLabs TTS
  - `voices` table with CRUD endpoints
  - Voice picker modal on audio generation
  - Voice snapshot on articles (`audio_voice_name`, `audio_voice_avatar_url`)
- **Voices page** (`/voices.html`) — voice management UI with Voice Test Studio
- **Settings page** (`/settings.html`) — ElevenLabs API key override

---

## [1.8.7] — 2026-03-09

### Added
- **48-hour article age filter** — RSS fetch skips articles older than 48 hours
- **Original article link** — 🔗 button in admin articles table

### Fixed
- **Cloudflare R2 audio storage** — confirmed working end-to-end in production

---

## [1.8.6] — 2026-03-09

### Added
- **Production deployment on Railway**
- **PostgreSQL support** — `db.js` rewritten for `pg` Pool with transparent SQL normalization
- **Cloudflare R2 audio storage** — MP3 uploads via `@aws-sdk/client-s3`
- **`railway.json`** + **`.env.example`**

### Fixed
- **All routes** — converted to `async/await` for pg Promises
- **Fetch endpoint hanging** — socket abort on timeout + fire-and-forget OG enrichment

---

## [1.8.5] — 2026-03-09

### Added
- **Soft-delete / archive system** — archive, restore, purge endpoints; 24-hour auto-purge cron
- **ElevenLabs audio generation** — Gemini writes spoken-word script → ElevenLabs TTS → MP3
  - Generate, delete, toggle endpoints
  - Audio columns in DB (`audio_url`, `audio_status`, `audio_transcript`, `media_enabled`)
  - Audio controls in admin articles table

---

## [1.8.4] — 2026-03-09

### Added
- **AI summaries** (`GET /api/summary`) — Gemini structured TLDRs
- **Single article lookup** (`GET /api/article?slug=`)
- **URL auto-fill** (`GET /api/fetch-url?url=`) — OG tags + JSON-LD scraping
- **Cache invalidation** (`GET /api/news/updated-at`)

---

## [1.3.0] — 2026-03-09

### Added
- **RSS auto-fetch** (`POST /api/fetch`) — fetch all sources, deduplicate, insert as drafts
- **30-minute cron job** — auto-fetch RSS sources
- **Category detection** — per-article keyword matching (removed from sources)

---

## [1.2.0] — 2026-03-09

### Added
- **AI summaries** (`GET /api/summary`)
- **Single article lookup** (`GET /api/article?slug=`)
- **Cache invalidation endpoint**
- **Featured article enforcement** — single featured at a time

---

## [1.1.0] — 2026-03-09

### Added
- **RSS auto-fetch** with 30-minute cron
- **Fetch All Sources button** on sources page
- **`last_fetched` column** on sources

---

## [1.0.0] — 2026-03-07

### Added
- Initial release — Express + SQLite admin panel
- JWT authentication with bcrypt password hashing
- Full CRUD for articles and RSS sources
- Mobile-friendly dark-theme UI (dashboard, articles, sources)
- Public `/api/news` endpoint for main site consumption
- Default seed: admin user + The Verge AI RSS source
