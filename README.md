# Deep Feed AI — Admin Panel

Backend CMS and API for [deepfeedai.com](https://deepfeedai.com). Manages articles, RSS sources, media generation, and serves the public news API consumed by the main site.

## Features

- 🔐 **JWT Authentication** — bcrypt-hashed passwords, token-based sessions
- 📰 **Article Management** — full CRUD with publish/draft, featured toggle, manual entry, and URL auto-fill
- 🗃️ **Soft-delete / Archive** — archive articles instead of deleting; archived articles are hidden from the public API; a 24-hour cron auto-purges old archived records
- 📡 **RSS Source Management** — add sources, auto-fetch on demand or every 30 min via cron; new articles saved as drafts for manual review
- 🔗 **URL Auto-fill** — paste any article URL to auto-populate title, image, summary, source, and author from Open Graph + JSON-LD structured data
- ✨ **AI Summaries** — Gemini 2.5 Flash Lite generates structured TLDRs (overview, key points, why it matters) served to `article.html`
- 🎙️ **Audio Generation (ElevenLabs)** — generate MP3 narrations for any article from the admin panel:
  - Gemini writes a natural 2–3 sentence spoken-word news anchor script
  - ElevenLabs TTS converts the script to MP3 (`eleven_turbo_v2` model)
  - MP3 saved to `public/media/audio/` and served statically
  - Per-row admin controls: Generate · ▶ Preview · 🗑 Delete · ✅ On/Off toggle
  - `media_enabled` flag gates whether the player appears on the main site
  - TTS script stored as `audio_transcript` for karaoke caption rendering
- 🌐 **Public News API** — `/api/news` powers the main site; featured articles sort to top; archived articles excluded
- ⚡ **Cache invalidation** — `/api/news/updated-at` lets the main site bust its localStorage cache the moment content changes
- 📱 **Mobile-friendly** — collapsible sidebar, responsive tables

## Quick Start

```bash
cd deepfeedai-admin
npm install
cp .env.example .env   # fill in your values
node server.js
```

Admin runs on **http://localhost:4000**

## Default Credentials

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `deepfeedai2026` |

> ⚠️ Change the password and JWT secret before deploying to production.

## Environment Variables

Create a `.env` file (never commit it):

```env
PORT=4000
JWT_SECRET=your_strong_random_secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password
GEMINI_API_KEY=your_gemini_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_ID=your_elevenlabs_voice_id
```

> **Gemini model:** `gemini-2.5-flash-lite` (required — `gemini-2.0-flash-lite` is unavailable on new accounts)
> **ElevenLabs model:** `eleven_turbo_v2`, max 900 chars per request

## Project Structure

```
deepfeedai-admin/
├── server.js              # Express app + cron jobs (30-min RSS fetch, 24-h archive purge)
├── db.js                  # SQLite (sql.js) wrapper + schema migrations + seed
├── package.json
├── .env                   # ← never committed
├── routes/
│   ├── auth.js            # POST /api/auth/login
│   ├── articles.js        # CRUD /api/articles + publish/feature/archive/restore/purge
│   ├── sources.js         # CRUD /api/sources + active toggle
│   ├── fetch.js           # POST /api/fetch — RSS import (dedup by URL)
│   ├── fetch-url.js       # GET  /api/fetch-url — OG + JSON-LD scraper
│   ├── article.js         # GET  /api/article — single article by slug (public)
│   ├── summary.js         # GET  /api/summary — AI TLDR via Gemini (public)
│   └── media.js           # POST /api/media/generate-audio
│                          # DELETE /api/media/audio/:id
│                          # PUT  /api/media/toggle/:id
└── public/
    ├── login.html
    ├── index.html         # Dashboard
    ├── articles.html      # Article manager (with audio controls column)
    ├── sources.html       # RSS source manager
    ├── admin.css
    ├── admin.js
    └── media/
        └── audio/         # Generated MP3 files (gitignored)
```

## API Reference

### Public (no auth)
| Method | Path | Description |
|---|---|---|
| GET | `/api/news` | Published articles — `?category=LLMs&limit=10&featured=1` |
| GET | `/api/news/updated-at` | Latest DB change timestamp (cache busting) |
| GET | `/api/article?slug=` | Single article by URL slug; includes `audio_url`, `audio_transcript`, `media_enabled` |
| GET | `/api/summary?title=&description=` | AI TLDR via Gemini |
| GET | `/media/audio/:filename` | Serve pre-generated MP3 audio file |

### Authenticated (Bearer token)
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Login → returns JWT |
| GET | `/api/articles` | List all articles (incl. draft + archived) |
| POST | `/api/articles` | Create article |
| PUT | `/api/articles/:id` | Update article |
| DELETE | `/api/articles/:id` | Delete article (hard delete) |
| PUT | `/api/articles/:id/publish` | Toggle published |
| PUT | `/api/articles/:id/feature` | Toggle featured (enforces 1 max) |
| PUT | `/api/articles/:id/archive` | Move to archive (soft-delete) |
| PUT | `/api/articles/:id/restore` | Restore from archive |
| DELETE | `/api/articles/:id/purge` | Hard-delete archived article immediately |
| GET | `/api/sources` | List sources |
| POST | `/api/sources` | Add source |
| PUT | `/api/sources/:id` | Update source |
| DELETE | `/api/sources/:id` | Delete source |
| PUT | `/api/sources/:id/toggle` | Toggle active |
| POST | `/api/fetch` | Fetch all active RSS sources |
| GET | `/api/fetch-url?url=` | Scrape URL for OG + JSON-LD metadata |
| POST | `/api/media/generate-audio` | Generate ElevenLabs MP3 for an article |
| DELETE | `/api/media/audio/:id` | Delete audio file + clear DB record |
| PUT | `/api/media/toggle/:id` | Toggle `media_enabled` (show/hide player on main site) |

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express
- **Database:** SQLite via sql.js (pure JS — no native compilation required)
- **Auth:** JWT + bcryptjs
- **AI (summaries + TTS scripts):** Google Gemini 2.5 Flash Lite
- **Audio TTS:** ElevenLabs `eleven_turbo_v2`
- **RSS:** rss-parser
- **Scheduler:** node-cron (RSS fetch every 30 min, archive purge every 24 h)
- **Frontend:** Vanilla HTML/CSS/JS

## Notes

- Only one article can be featured at a time (will increase to 3 with priority in a future release)
- New articles fetched via RSS are saved as **drafts** — review and publish manually
- Audio files in `public/media/audio/` are excluded from git; sync to Cloudflare R2 or S3 for production
- The `.env` file and database file are excluded from git
- Use `db.prepare(sql).all()` — `db.all()` does not exist in sql.js
- See [CHANGELOG.md](./CHANGELOG.md) for full version history
