# Deep Feed AI Admin Panel

A full-featured admin panel for managing news articles and RSS sources for the Deep Feed AI news site.

## Features

✅ **Authentication** - JWT-based login with bcrypt password hashing  
✅ **Article Management** - Create, read, update, delete articles with rich metadata  
✅ **RSS Source Management** - Add, edit, and manage RSS feed sources  
✅ **Dark Theme UI** - Mobile-responsive dashboard matching Deep Feed AI branding  
✅ **Public API** - Unauthenticated API endpoint for the main site to fetch published news  
✅ **Database** - SQLite with sql.js (no native compilation required)  

## Running the Server

```bash
cd /home/claw_user/.openclaw/workspace/deepfeedai-admin
npm install
node server.js
```

Server runs on **http://localhost:4000**

## Default Credentials

- **Username:** `admin`
- **Password:** `deepfeedai2026`

## Project Structure

```
deepfeedai-admin/
├── server.js                 # Express app entry point
├── db.js                     # SQLite database wrapper (sql.js)
├── package.json              # Dependencies
├── .env                      # Environment configuration
├── routes/
│   ├── auth.js              # Login/logout endpoints
│   ├── articles.js          # Article CRUD operations
│   └── sources.js           # RSS source CRUD operations
└── public/
    ├── login.html           # Login page
    ├── index.html           # Dashboard home
    ├── articles.html        # Article manager
    ├── sources.html         # RSS source manager
    ├── admin.css            # Dark theme styling
    └── admin.js             # Frontend JS utilities
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with username/password
- `POST /api/auth/logout` - Logout (client-side only)

### Articles (require JWT Bearer token)
- `GET /api/articles` - List all articles (supports filters: `?published=1&category=LLMs`)
- `GET /api/articles/:id` - Get single article
- `POST /api/articles` - Create article
- `PUT /api/articles/:id` - Update article
- `DELETE /api/articles/:id` - Delete article
- `PUT /api/articles/:id/feature` - Toggle featured status
- `PUT /api/articles/:id/publish` - Toggle published status

### Sources (require JWT Bearer token)
- `GET /api/sources` - List all RSS sources
- `POST /api/sources` - Add new source
- `PUT /api/sources/:id` - Update source
- `DELETE /api/sources/:id` - Delete source
- `PUT /api/sources/:id/toggle` - Toggle active status

### Public News (no authentication)
- `GET /api/news` - Get published articles (supports `?category=LLMs&limit=10&featured=1`)

## Database

SQLite database (deepfeedai.db) with three tables:

**articles** - News articles  
**sources** - RSS feed sources  
**users** - Admin user accounts  

Default seeding:
- Admin user: `admin` / `deepfeedai2026`
- RSS source: The Verge AI

## Color Palette (Dark Theme)

- Background: `#0d0d0d`
- Card: `#161616`
- Sidebar: `#111111`
- Accent: `#00d9ff` (cyan)
- Danger: `#f87171` (red)
- Success: `#4ade80` (green)
- Text: `#f0f0f0`
- Muted: `#888`

## Mobile Responsiveness

- **Desktop (>768px):** Sidebar navigation on left
- **Tablet/Mobile (<768px):** Hamburger menu with collapsible sidebar
- Fully responsive grid layouts and tables

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite (sql.js - pure JavaScript)
- **Auth:** JWT + bcryptjs
- **Frontend:** Vanilla HTML/CSS/JS (no frameworks)
- **Styling:** Pure CSS (no CSS frameworks)

## Notes

- All HTML pages are self-contained with no external CSS framework dependencies
- Frontend uses localStorage for JWT token persistence
- Auto-redirects to login if token is missing or expired
- All API responses include proper error messages
- Database is auto-saved to disk after each mutation
