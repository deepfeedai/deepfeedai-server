# Deep Feed AI — Admin Panel

Backend CMS and API for [deepfeedai.com](https://deepfeedai.com). Manages articles, RSS sources, and serves the public news API consumed by the main site.

## Features

- 🔐 **JWT Authentication** — bcrypt-hashed passwords, token-based sessions
- 📰 **Article Management** — full CRUD with publish/draft, featured toggle, manual entry, and URL auto-fill
- 📡 **RSS Source Management** — add sources, auto-fetch on demand or every 30 min via cron
- 🔗 **URL Auto-fill** — paste any article URL to auto-populate title, image, summary, source, and author from Open Graph + JSON-LD
- ✨ **AI Summaries** — Gemini 2.5 Flash Lite generates structured TLDRs served to `article.html`
- 🌐 **Public News API** — `/api/news` powers the main site; featured articles sort to top
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
```

## Project Structure

```
deepfeedai-admin/
├── server.js              # Express app + cron job
├── db.js                  # SQLite (sql.js) wrapper + schema + seed
├── package.json
├── .env                   # ← never committed
├── routes/
│   ├── auth.js            # POST /api/auth/login
│   ├── articles.js        # CRUD /api/articles
│   ├── sources.js         # CRUD /api/sources
│   ├── fetch.js           # POST /api/fetch — RSS import
│   ├── fetch-url.js       # GET  /api/fetch-url — URL scraper
│   ├── article.js         # GET  /api/article — single by slug (public)
│   └── summary.js         # GET  /api/summary — AI TLDR (public)
└── public/
    ├── login.html
    ├── index.html         # Dashboard
    ├── articles.html      # Article manager
    ├── sources.html       # RSS source manager
    ├── admin.css
    └── admin.js
```

## API Reference

### Public (no auth)
| Method | Path | Description |
|---|---|---|
| GET | `/api/news` | Published articles — `?category=LLMs&limit=10&featured=1` |
| GET | `/api/news/updated-at` | Latest DB change timestamp (cache busting) |
| GET | `/api/article?slug=` | Single article by URL slug |
| GET | `/api/summary?title=&description=` | AI TLDR via Gemini |

### Authenticated (Bearer token)
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Login → returns JWT |
| GET | `/api/articles` | List all articles |
| POST | `/api/articles` | Create article |
| PUT | `/api/articles/:id` | Update article |
| DELETE | `/api/articles/:id` | Delete article |
| PUT | `/api/articles/:id/publish` | Toggle published |
| PUT | `/api/articles/:id/feature` | Toggle featured (enforces 1 max) |
| GET | `/api/sources` | List sources |
| POST | `/api/sources` | Add source |
| PUT | `/api/sources/:id` | Update source |
| DELETE | `/api/sources/:id` | Delete source |
| PUT | `/api/sources/:id/toggle` | Toggle active |
| POST | `/api/fetch` | Fetch all active RSS sources |
| GET | `/api/fetch-url?url=` | Scrape URL metadata |

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express
- **Database:** SQLite via sql.js (pure JS — no native compilation)
- **Auth:** JWT + bcryptjs
- **AI:** Google Gemini 2.5 Flash Lite
- **RSS:** rss-parser
- **Scheduler:** node-cron
- **Frontend:** Vanilla HTML/CSS/JS

## Notes

- Only one article can be featured at a time (will increase to 3 with priority in a future release)
- New articles fetched via RSS are saved as **drafts** — review and publish manually
- The `.env` file is excluded from git; the database file is also excluded
- See [CHANGELOG.md](./CHANGELOG.md) for full version history
