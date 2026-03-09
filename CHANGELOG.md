# Changelog

All notable changes to Deep Feed AI Admin are documented here.

---

## [Unreleased]
> Features planned or in progress

- Neon Postgres for production (replace SQLite)
- Up to 3 featured articles with priority ordering
- Newsletter send interface
- Analytics dashboard (page views, subscriber growth)

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
