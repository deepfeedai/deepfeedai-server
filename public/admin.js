/* ===== DeepFeedAI Admin — Core JS ===== */

// ── Client-side error logger (auto-inject) ──────────────
(function() {
  if (window._dfaLoggerLoaded) return;
  window._dfaLoggerLoaded = true;
  window.DFAClientLogger = { source: 'portal' };
  var s = document.createElement('script');
  s.src = '/client-logger.js';
  s.async = true;
  document.head.appendChild(s);
})();

const API = '/api';

// ── Site URL helper (tenant-aware) ───────────────────────
function getSiteBase() {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    try { const o = localStorage.getItem('dfa_site_url'); if (o) return o; } catch {}
    return 'http://localhost:3000';
  }

  // Tenant subdomain — admin portal shares hostname with the public site
  if (host !== 'portal-staging.deepfeedai.com' && host !== 'portal.deepfeedai.com') {
    return window.location.origin;
  }

  // Platform admin host — resolve tenant slug from JWT
  const base = host === 'portal-staging.deepfeedai.com' ? 'staging.deepfeedai.com' : 'deepfeedai.com';
  try {
    const token = localStorage.getItem('deepfeedai_token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      // Platform admin uses the root domain; tenant admins get subdomain URLs
      if (payload.tenantSlug && payload.type !== 'platform-admin') {
        return 'https://' + payload.tenantSlug + '.' + base;
      }
    }
  } catch (_) {}

  // Fallback — platform root
  return 'https://' + base;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Auth helpers ──────────────────────────────────────────
function getToken() {
  return localStorage.getItem('deepfeedai_token');
}

function setToken(token) {
  localStorage.setItem('deepfeedai_token', token);
}

function clearToken() {
  localStorage.removeItem('deepfeedai_token');
  localStorage.removeItem('deepfeedai_user');
}

function isLoggedIn() {
  const token = getToken();
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 <= Date.now()) return false;
    if (payload.type !== 'tenant-admin' && payload.type !== 'platform-admin') return false;
    return true;
  } catch {
    return false;
  }
}

function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
    return false;
  }
  return true;
}

function requireGuest() {
  if (isLoggedIn()) {
    window.location.href = '/overview.html';
  }
}

// ── Permission helpers ───────────────────────────────────
function getUserPermissions() {
  const token = localStorage.getItem('deepfeedai_token');
  if (!token) return [];
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.permissions || (payload.role === 'owner' ? ['*'] : []);
  } catch { return []; }
}

function getUserRole() {
  const token = localStorage.getItem('deepfeedai_token');
  if (!token) return null;
  try {
    return JSON.parse(atob(token.split('.')[1])).role || null;
  } catch { return null; }
}

function hasPermission(perm) {
  const perms = getUserPermissions();
  if (perms.includes('*')) return true;
  const [resource] = perm.split('.');
  return perms.includes(perm) || perms.includes(resource + '.*');
}

function isPlatformAdmin() {
  var token = localStorage.getItem('deepfeedai_token');
  if (!token) return false;
  try {
    return JSON.parse(atob(token.split('.')[1])).type === 'platform-admin';
  } catch { return false; }
}

// ── Fetch wrapper ─────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(API + path, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
    throw new Error('Unauthorized');
  }

  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'You don\'t have permission to perform this action');
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

// ── Modal ─────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

function initModals() {
  document.querySelectorAll('.modal-close, [data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.modal-overlay').classList.remove('open');
    });
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });
}

// ── Sidebar ───────────────────────────────────────────────
const LEGACY_NAV_GROUPS = [
  { label: '', items: [
    { href: '/newsroom.html', label: '← Newsroom', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19 12H5M12 19l-7-7 7-7"/></svg>' },
  ]},
  { label: 'The Floor', items: [
    { href: '/editorial-intelligence.html', label: 'Intelligence', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.456-2.456L14.25 6l1.035-.259a3.375 3.375 0 002.456-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" /></svg>' },
    { href: '/budget.html', label: 'Runsheet', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5m-9-6h.008v.008H12v-.008zM12 15h.008v.008H12V15zm0 2.25h.008v.008H12v-.008zM9.75 15h.008v.008H9.75V15zm0 2.25h.008v.008H9.75v-.008zM7.5 15h.008v.008H7.5V15zm0 2.25h.008v.008H7.5v-.008zm6.75-4.5h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V15zm0 2.25h.008v.008h-.008v-.008zm2.25-4.5h.008v.008H16.5v-.008zm0 2.25h.008v.008H16.5V15z" /></svg>' },
    { href: '/pitches.html', label: 'Pitches', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" /></svg>', badgeId: 'pitches' },
    { href: '/editorial.html', label: 'Editorial', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>', badgeId: 'editorial' },
    { href: '/newsroom-activity.html', label: 'Activity', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" /></svg>' },
    { href: '/briefs.html', label: 'Briefs', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>' },
  ]},
  { label: 'The Wire', items: [
    { href: '/feed-inbox.html', label: 'Reader', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-17.399 0V5.507c0-.621.504-1.125 1.125-1.125h14.25c.621 0 1.125.504 1.125 1.125v7.993m-17.399 0c0 .621.504 1.125 1.125 1.125h14.25c.621 0 1.125-.504 1.125-1.125" /></svg>' },
    { href: '/stories.html', label: 'Stories', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>' },
    { href: '/story-board.html', label: 'Story Board', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>' },
    { href: '/discover.html', label: 'Discover', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>' },
    { href: '/pipeline.html', label: 'Pipeline', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" /></svg>' },
    { href: '/sources.html', label: 'RSS Sources', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12.75 19.5v-.75a7.5 7.5 0 00-7.5-7.5H4.5m0-6.75h.75c7.87 0 14.25 6.38 14.25 14.25v.75M6 18.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" /></svg>' },
  ]},
  { label: 'The Desk', items: [
    { href: '/articles.html', label: 'Articles', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>' },
    { href: '/writers.html', label: 'AI Team', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" /></svg>' },
    { href: '/writing-styles.html', label: 'Writing Styles', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>' },
    { href: '/newsletter.html', label: 'Newsletter', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" /></svg>' },
    { href: '/comments.html', label: 'Comments', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>', badgeId: 'comments' },
    { href: '/banners.html', label: 'Banners', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46" /></svg>' },
  ]},
  { label: 'Reports', items: [
    { href: '/classic.html', label: 'Dashboard', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>' },
    { href: '/analytics.html', label: 'Analytics', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>' },
    { href: '/ai-usage.html', label: 'AI Usage', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>' },
    { href: '/audit.html', label: 'Logs', icon: '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" /></svg>' },
  ]},
];


// Shared synchronous navigation catalog: presentation only; APIs remain authoritative.
window.WorkflowNav = (function () {
  const icon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 5h16v14H4zM4 9h16M9 9v10"/></svg>';
  const old = LEGACY_NAV_GROUPS.flatMap(g => g.items);
  const pages = [];
  function add(group, href, label, permission, purpose, secondary, caution) {
    const original = old.find(p => p.href === href.split('?')[0]);
    pages.push({group,href,label,permissions:permission ? permission.split(',') : [],purpose,secondary:!!secondary,caution:caution || '',icon:original?.icon || icon,badgeId:original?.badgeId});
  }
  add('Overview','/overview.html','Overview','','See what needs attention and choose your next step.');
  add('Overview','/newsroom-activity.html','Activity','articles.read','Review recent newsroom changes.');
  add('Overview','/classic.html','Metrics dashboard','articles.read','Inspect existing newsroom totals and performance.',true);
  add('Overview','/analytics.html','Analytics','analytics.read','Understand readership and content performance.',true);
  add('Overview','/notifications.html','Notifications','','Read updates addressed to you.',true);
  add('Discover','/feed-inbox.html','Reader','articles.read','Gather evidence, save useful sources, and hand them to an assignment.',false,'Reading, saving and organizing do not call AI. Enrichment and Maxwell chat are optional paid actions. Exact repeats are different from coverage groups.');
  add('Discover','/sources.html','RSS Sources','sources.read','Organize subscriptions and import or export feed lists.',false,'Removal preserves imported articles. Clear all is publication-scoped and recoverable. Exports can contain private feed tokens; share them carefully. Fetching feeds does not enrich with AI.');
  add('Discover','/discover.html','Web discovery','fetch.execute','Search external sources and import evidence.',true,'Importing evidence is separate from paid AI enrichment.');
  add('Discover','/pipeline.html','Synthesis pipeline','articles.read','Inspect source clusters before explicitly drafting coverage.',true,'Generate is a paid action. A cluster is evidence, not a published article.');
  add('Discover','/synthesis.html','Synthesis tools','articles.read','Review specialist synthesis controls.',true,'Generation can incur provider charges; inspect sources before running it.');
  add('Discover','/story-board.html','Story Board','articles.read','Explore relationships between source coverage.',true);
  add('Discover','/newsroom-feed.html','Newsroom feed','articles.read','Open the existing newsroom feed workspace.',true);
  add('Editorial','/newsroom-workflow.html','Newsroom workflow','articles.read','Follow each item from evidence to publication: see its stage, blockers, recorded progress and next action.',false,'Approval and source organization never generate a draft. Paid generation requires explicit confirmation. Publication, newsletter sending and edition sharing remain separate deliberate actions. A failed or interrupted request must be checked before retrying.');
  add('Editorial','/pitches.html','Pitches & assignments','articles.read','Evaluate ideas and prepare sourced assignments.',false,'Saving or approving an assignment does not generate a draft. Needs sources means attach evidence; Generate draft is a separate paid action. Drafting means check status, not submit again.');
  add('Editorial','/articles.html?tab=drafts&content_type=editorial','Editorial drafts','articles.read','Develop drafts before review and publication.');
  add('Editorial','/articles.html?tab=review','Awaiting review','articles.read','Check evidence, copy and images before deliberate publication.',true);
  add('Editorial','/editorial.html','Editorial review','articles.read','Use the specialist editorial review workspace.',true);
  add('Editorial','/budget.html','Runsheet','articles.read','Plan and review the publishing schedule.',true,'Approving and generating are distinct. Scheduled content is not yet published.');
  add('Editorial','/briefs.html','Briefs','articles.read','Review editorial briefs and their next steps.',true);
  add('Editorial','/newsroom-chat.html','Maxwell chat','articles.read','Discuss editorial work with Maxwell.',true,'Sending a chat message can use paid AI and propose actions. Review proposed actions before confirming.');
  add('Editorial','/newsroom.html','Newsroom hub','articles.read','Open the existing specialist newsroom workspace.',true,'Chat and generation can incur provider charges.');
  add('Editorial','/editorial-intelligence.html','Editorial intelligence','articles.read','Inspect candidates and editorial recommendations.',true,'Running intelligence can call paid AI. Viewing this navigation does not run it.');
  add('Publish','/articles.html?tab=published','Published articles','articles.read','Review live coverage, corrections and unpublishing.');
  add('Publish','/editions.html','Newspaper editions','articles.read','Arrange authored coverage into a saved newspaper edition for preview and printing.',false,'Editions start private. Proofs can contain drafts and are marked DRAFT. Finalizing locks the snapshot; it does not publish articles. Sharing a published-content issue is separate. Printed or downloaded copies cannot be recalled.');
  add('Publish','/stories.html','Stories','articles.read','Curate ongoing timelines of published coverage.',false,'Stories are timelines, not assignments. AI summary generation is explicit and may incur charges. Draft articles do not belong in public coverage.');
  add('Publish','/articles.html?tab=scheduled','Scheduled articles','articles.read','Inspect queued publications and their scheduled times.',true);
  add('Publish','/articles.html','Article library','articles.read','Find editorial article records and their persisted status.',true,'Save is not Publish. Uploading an image requires Save Article to attach it. Publication and unpublishing affect readers.');
  add('Publish','/newsletter.html','Newsletter','newsletter.send','Prepare and review newsletter editions.',true,'Sending contacts subscribers. AI suggestions may incur charges; neither happens by opening this page.');
  add('Publish','/comments.html','Comments','comments.read','Review reader comments and moderation decisions.',true);
  add('Publish','/banners.html','Banners','settings.read','Manage reader-facing notices.',true,'Saving active banners can change the public site.');
  add('Manage','/writers.html','AI Team','writers.read','Configure writers and editorial responsibilities.',false,'Creating a profile is separate from optional paid portrait and writing generation.');
  add('Manage','/writing-styles.html','Writing styles','','Maintain reusable editorial style guidance.');
  add('Manage','/settings.html','Settings','settings.read','Configure this publication and its integrations.',false,'Provider tests may incur charges. Automation, credentials and destructive controls require deliberate review; help never changes them.');
  add('Manage','/ai-usage.html','AI usage','analytics.read','Review recorded provider usage and costs.');
  add('Manage','/audit.html','Logs','audit.read,analytics.read','Inspect recorded administrative events.',true);
  add('Manage','/users.html','Users','users.read','Manage people with access to this publication.',true,'Changing roles or access affects what users can do.');
  add('Manage','/roles.html','Roles','roles.read','Inspect role permissions and access boundaries.',true);
  add('Manage','/wizard.html','Setup wizard','settings.update','Open the existing publication setup workflow.',true,'Review changes before applying setup.');
  add('Manage','/deploy-wizard.html','Deployment wizard','settings.update','Open the existing deployment setup workflow.',true,'Deployment actions can change running infrastructure.');
  add('Manage','/setup.html','Initial setup','settings.update','Open the existing initial setup entry point.',true);
  const aliases = {'/article-editor.html':'/articles.html','/preview.html':'/articles.html','/writer-detail.html':'/writers.html','/':'/overview.html','/index.html':'/overview.html'};
  function url(value) { try { if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\u0000-\u0020]/.test(value))return null; const u=new URL(value,'https://navigation.invalid');return u.origin==='https://navigation.invalid'?u:null; }catch{return null;} }
  function resolve(value) {
    const u=url(value);if(!u)return null;
    const pathname=aliases[u.pathname]||u.pathname;
    const candidates=pages.filter(p=>p.href.split('?')[0]===pathname);
    return candidates.find(p=>{const q=url(p.href).searchParams;return q.size>0&&Array.from(q).every(([k,v])=>u.searchParams.get(k)===v);})||candidates.find(p=>!p.href.includes('?'))||candidates[0]||null;
  }
  function allowed(value) { const p=typeof value==='string'?resolve(value):value; return !!p && p.permissions.every(hasPermission); }
  function groups() { return ['Overview','Discover','Editorial','Publish','Manage'].map(label=>({label,items:pages.filter(p=>p.group===label&&allowed(p))})).filter(g=>g.items.length); }
  function active(p,value) { return resolve(value)?.href===p.href; }
  function scopedKey(name) { let claims={};try {claims=JSON.parse(atob(localStorage.getItem('deepfeedai_token').split('.')[1]));}catch{}return 'workflow.v1:'+encodeURIComponent(String(claims.tenantId??'none'))+':'+encodeURIComponent(String(claims.type??'guest'))+':'+encodeURIComponent(String(claims.sub??'none'))+':'+name; }
  return {pages,resolve,allowed,groups,active,scopedKey};
})();
const NAV_GROUPS = window.WorkflowNav.groups();

const LOGOUT_ICON = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" /></svg>';

// Expose nav groups on window so downstream modules (command palette,
// recent/pinned, etc.) can enumerate pages without duplicating the list.
window.NAV_GROUPS = NAV_GROUPS;

function renderSidebar() {
  const layout = document.querySelector('.admin-layout');
  if (!layout || document.getElementById('sidebar')) return;

  // Load navigation modules (keybindings, ?-cheatsheet, visit telemetry,
  // command palette, recent/pinned) exactly once per page. All admin pages
  // call renderSidebar on boot, so this is the natural funnel.
  [
    { id: 'navKitScript',             src: '/nav-kit.js' },
    { id: 'commandPaletteScript',     src: '/command-palette.js' },
    { id: 'navExtrasScript',          src: '/nav-extras.js' },
    { id: 'breadcrumbsScript',        src: '/breadcrumbs.js' },
    { id: 'turboNavScript',           src: '/turbo-nav.js' },
    { id: 'articleContextPillScript', src: '/article-context-pill.js' },
    { id: 'maxwellBubbleScript',      src: '/maxwell-bubble.js' },
    { id: 'mobileBottomNavScript',    src: '/mobile-bottom-nav.js' },
    { id: 'onboardingHintsScript',    src: '/onboarding-hints.js' },
    { id: 'pitchTypesScript',         src: '/pitch-types.js' },
  ].forEach(function (m) {
    if (document.getElementById(m.id)) return;
    var s = document.createElement('script');
    s.id  = m.id;
    s.src = m.src;
    s.defer = true;
    document.head.appendChild(s);
  });

  const pathname = window.location.pathname + window.location.search;

  // Collapsed state persisted per-group; active group always stays open
  let collapsedGroups;
  try { collapsedGroups = new Set(JSON.parse(localStorage.getItem(window.WorkflowNav.scopedKey('collapsed')) || '[]')); }
  catch (e) { collapsedGroups = new Set(); }

  let activeGroupKey = null;
  NAV_GROUPS.forEach(function(group) {
    group.items.forEach(function(item) {
      if (window.WorkflowNav.active(item, pathname)) {
        activeGroupKey = group.label.toLowerCase().replace(/\s+/g, '-');
      }
    });
  });

  const CHEVRON = '<svg class="nav-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  let navHtml = '';
  NAV_GROUPS.forEach(group => {
    const groupKey = group.label.toLowerCase().replace(/\s+/g, '-');
    const isCollapsed = collapsedGroups.has(groupKey) && groupKey !== activeGroupKey;
    navHtml += '<button type="button" class="nav-section workflow-group' + (isCollapsed ? ' collapsed' : '') + '" aria-expanded="' + !isCollapsed + '" data-nav-toggle="' + groupKey + '">' + group.label + CHEVRON + '</button>';
    navHtml += '<div class="nav-group' + (isCollapsed ? ' collapsed' : '') + '" data-nav-group="' + groupKey + '">';
    let secondaryOpen=false;
    group.items.slice().sort((a,b)=>Number(a.secondary)-Number(b.secondary)).forEach(item => {
      if(item.secondary&&!secondaryOpen){secondaryOpen=true;const show=group.items.some(p=>p.secondary&&window.WorkflowNav.active(p,pathname));navHtml+='<details class="workflow-tools"'+(show?' open':'')+'><summary>More '+group.label.toLowerCase()+' tools</summary>';}
      const active = window.WorkflowNav.active(item, pathname) ? ' active' : '';
      const badge = item.badgeId ? '<span class="nav-count" id="navBadge-' + item.badgeId + '" style="display:none"></span>' : '';
      navHtml += '<a '+(active?'aria-current="page" ':'')+'class="nav-link' + active + '" href="' + item.href + '">' + item.icon + ' ' + item.label + badge + '</a>';
    });
    if (secondaryOpen) navHtml += '</details>';
    navHtml += '</div>';
  });

  // Default logo — will be updated from site config
  const defaultLogo = '\u{1F916} Deep Feed<span>AI</span>';

  const sidebarHtml = '<aside class="sidebar" id="sidebar">'
    + '<div class="sidebar-header"><div class="sidebar-logo" id="sidebarLogo">' + defaultLogo + '</div></div>'
    + '<nav class="sidebar-nav">' + navHtml + '</nav>'
    + '<div class="sidebar-footer"><div id="tenantSwitcher"></div>' + '' + '<button class="nav-link" data-logout>' + LOGOUT_ICON + ' Logout</button></div>'
    + '</aside>'
    + '<div class="sidebar-overlay" id="sidebarOverlay"></div>';

  layout.insertAdjacentHTML('afterbegin', sidebarHtml);
  initSidebar();
  initNavCollapse();
  loadNavBadges();
  initLogout();
  loadTenantSwitcher();

  // Track page visit for recents/palette ranking. Resolve a human label by
  // finding the matching nav entry; fall back to document.title. Wait for
  // NavKit to be ready (it loads async via the script injection above).
  const activeItem = (function findActive() {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (window.WorkflowNav.active(item, pathname)) return item;
      }
    }
    return null;
  })();
  const trackLabel = activeItem ? activeItem.label : (document.title || pathname);
  (function track(tries) {
    if (window.NavKit && typeof window.NavKit.trackVisit === 'function') {
      if (window.WorkflowNav.allowed(pathname)) window.NavKit.trackVisit(window.WorkflowNav.resolve(pathname).href, trackLabel);
    } else if (tries < 40) {
      setTimeout(function () { track(tries + 1); }, 50);
    }
  })(0);

  // Fetch site config to update logo
  apiFetch('/site-config').then(function(config) {
    var logoEl = document.getElementById('sidebarLogo');
    if (!logoEl) return;
    var emoji = config.logo_emoji || '';
    var shortName = config.short_name || config.name || '';
    if (shortName) {
      logoEl.textContent = '';
      if (emoji) {
        logoEl.textContent = emoji + ' ';
      }
      logoEl.appendChild(document.createTextNode(shortName));
    }
  }).catch(function() { /* keep default */ });

  // Show current user in topbar
  var topbarUser = document.getElementById('topbarUser');
  if (topbarUser) {
    try {
      var token = localStorage.getItem('deepfeedai_token');
      if (token) {
        var payload = JSON.parse(atob(token.split('.')[1]));
        var name = payload.displayName || payload.username || payload.email || '';
        var role = payload.role || '';
        if (name) {
          var perms = getUserPermissions();
          var permSummary = perms.includes('*') ? 'Full access' : perms.length + ' permissions';
          topbarUser.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px;">'
            + '<span class="text-muted text-sm">' + escHtml(name) + '</span>'
            + (role ? '<span class="badge badge-muted" style="font-size:10px;">' + escHtml(role) + '</span>' : '')
            + '<span class="text-muted text-xs" title="' + escHtml(perms.includes('*') ? 'Full access (owner)' : perms.join(', ')) + '">(' + escHtml(permSummary) + ')</span>'
            + '</span>';
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Inject settings gear + refresh button into topbar
  var topbarEl = document.querySelector('.topbar');
  if (topbarEl && !topbarEl.querySelector('#topbarRefreshBtn')) {
    var settingsGearLink = document.createElement('a');
    settingsGearLink.href = '/settings.html';
    settingsGearLink.className = 'topbar-settings-link';
    settingsGearLink.title = 'Settings';
    settingsGearLink.setAttribute('aria-label', 'Settings');
    settingsGearLink.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

    var refreshBtn = document.createElement('button');
    refreshBtn.id = 'topbarRefreshBtn';
    refreshBtn.className = 'topbar-refresh-btn';
    refreshBtn.title = 'Refresh page data';
    refreshBtn.setAttribute('aria-label', 'Refresh');
    refreshBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
    refreshBtn.addEventListener('click', function () {
      var svg = refreshBtn.querySelector('svg');
      if (svg) svg.classList.add('topbar-refresh-spinning');
      var done = function () { if (svg) svg.classList.remove('topbar-refresh-spinning'); };
      if (typeof window.pageRefresh === 'function') {
        try {
          var result = window.pageRefresh();
          if (result && typeof result.then === 'function') result.then(done, done);
          else setTimeout(done, 400);
        } catch (e) { done(); }
      } else {
        location.reload();
      }
    });

    var userSpan = document.getElementById('topbarUser');
    if (userSpan) {
      topbarEl.insertBefore(refreshBtn, userSpan);
      if (window.WorkflowNav.allowed('/settings.html')) topbarEl.insertBefore(settingsGearLink, userSpan);
    } else {
      topbarEl.appendChild(refreshBtn);
      if (window.WorkflowNav.allowed('/settings.html')) topbarEl.appendChild(settingsGearLink);
    }
  }

  // Inject credit widget into topbar
  renderCreditWidget();
  window.WorkflowHelp?.boot();
}

// ── Credit widget (topbar donut ring) ────────────────────
function getCreditCacheKey() {
  try {
    var token = localStorage.getItem('deepfeedai_token');
    if (token) {
      var tid = JSON.parse(atob(token.split('.')[1])).tenantId;
      if (tid) return 'dfa_credit_cache_' + tid;
    }
  } catch (_) {}
  return 'dfa_credit_cache';
}
const CREDIT_CACHE_TTL = 60000;
const CW_CIRCUMFERENCE = 2 * Math.PI * 8; // r=8 → ~50.27

function cwRingSvg() {
  return '<svg class="cw-ring" width="22" height="22" viewBox="0 0 22 22">'
    + '<circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="3" opacity="0.2" />'
    + '<circle class="cw-arc" cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="3"'
    + ' stroke-dasharray="' + CW_CIRCUMFERENCE.toFixed(2) + '"'
    + ' stroke-dashoffset="' + CW_CIRCUMFERENCE.toFixed(2) + '"'
    + ' stroke-linecap="round" transform="rotate(-90 11 11)" />'
    + '</svg>';
}

function renderCreditWidget() {
  if (document.getElementById('creditWidget')) return;
  var topbar = document.querySelector('.topbar');
  if (!topbar) return;
  var userEl = document.getElementById('topbarUser');

  var widget = document.createElement('a');
  widget.id = 'creditWidget';
  widget.href = '/ai-usage.html';
  widget.className = 'credit-widget';
  widget.title = 'AI Credits';
  widget.innerHTML = cwRingSvg()
    + '<span class="credit-widget-pct">--%</span>'
    + '<span class="credit-widget-dot">&middot;</span>'
    + '<span class="credit-widget-credits">--</span>';

  if (userEl) topbar.insertBefore(widget, userEl);
  else topbar.appendChild(widget);

  loadCreditData();
}

function formatCredits(n) {
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
  return n.toLocaleString();
}

function updateCreditWidget(data) {
  var widget = document.getElementById('creditWidget');
  if (!widget) return;

  // Hide if plan has no credit allocation at all
  if (data.monthlyAllocation <= 0 && data.totalAvailable <= 0) {
    widget.style.display = 'none';
    return;
  }

  widget.style.display = '';

  // Update donut arc
  var pct = Math.min(data.percentUsed, 100);
  var offset = CW_CIRCUMFERENCE * (1 - pct / 100);
  var arc = widget.querySelector('.cw-arc');
  if (arc) arc.setAttribute('stroke-dashoffset', offset.toFixed(2));

  // Update text
  widget.querySelector('.credit-widget-pct').textContent = Math.round(pct) + '%';
  widget.querySelector('.credit-widget-credits').textContent = formatCredits(data.totalAvailable) + ' cr';

  // Color coding
  widget.classList.remove('credit-ok', 'credit-warn', 'credit-crit');
  if (pct >= 90) widget.classList.add('credit-crit');
  else if (pct >= 70) widget.classList.add('credit-warn');
  else widget.classList.add('credit-ok');

  widget.title = data.totalAvailable.toLocaleString() + ' of '
    + data.monthlyAllocation.toLocaleString() + ' credits remaining ('
    + Math.round(pct) + '% used)\nClick for details';
}

async function loadCreditData() {
  // Check sessionStorage cache
  try {
    var cached = JSON.parse(sessionStorage.getItem(getCreditCacheKey()));
    if (cached && Date.now() - cached.ts < CREDIT_CACHE_TTL) {
      updateCreditWidget(cached.data);
      return;
    }
  } catch (_) {}

  try {
    var balance = await apiFetch('/credits/balance');
    var percentUsed = balance.monthlyAllocation > 0
      ? Math.round((balance.usedThisMonth / balance.monthlyAllocation) * 100)
      : 0;

    var data = {
      totalAvailable: balance.totalAvailable || 0,
      monthlyAllocation: balance.monthlyAllocation || 0,
      usedThisMonth: balance.usedThisMonth || 0,
      percentUsed: percentUsed,
    };

    sessionStorage.setItem(getCreditCacheKey(), JSON.stringify({ ts: Date.now(), data: data }));
    updateCreditWidget(data);
  } catch (err) {
    // Widget shows neutral placeholder — non-fatal
    console.warn('[credit-widget]', err.message);
  }
}

function initNavCollapse() {
  document.querySelectorAll('[data-nav-toggle]').forEach(function(toggle) {
    toggle.addEventListener('click', function() {
      const key = toggle.dataset.navToggle;
      const group = document.querySelector('[data-nav-group="' + key + '"]');
      if (!group) return;
      const isNowCollapsed = group.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed', isNowCollapsed);
      let collapsed;
      try { collapsed = new Set(JSON.parse(localStorage.getItem(window.WorkflowNav.scopedKey('collapsed')) || '[]')); }
      catch (e) { collapsed = new Set(); }
      if (isNowCollapsed) collapsed.add(key); else collapsed.delete(key);
      try { localStorage.setItem(window.WorkflowNav.scopedKey('collapsed'), JSON.stringify([...collapsed])); } catch (_) {}
      toggle.setAttribute('aria-expanded', String(!isNowCollapsed));
    });
  });
}

function updateNavBadge(id, count) {
  const el = document.getElementById('navBadge-' + id);
  if (!el) return;
  count = Number(count) || 0;
  if (count > 0) { el.textContent = count > 99 ? '99+' : String(count); el.style.display = ''; }
  else { el.style.display = 'none'; }
}

let _navBadgeTimer = null;
function loadNavBadges() {
  clearTimeout(_navBadgeTimer);
  _navBadgeTimer = setTimeout(function() {
    apiFetch('/dashboard/stats').then(function(stats) {
      if (!stats) return;
      const pitchCount = (stats.pitches ? (stats.pitches.pending || 0) + (stats.pitches.proposed || 0) : 0);
      updateNavBadge('pitches',   pitchCount);
      updateNavBadge('comments',  stats.comments && stats.comments.queue);
      updateNavBadge('editorial', stats.articles && stats.articles.in_review);
    }).catch(function() {});
  }, 100);
}
window.loadNavBadges = loadNavBadges;
document.addEventListener('visibilitychange', function() {
  if (!document.hidden) loadNavBadges();
});

function initSidebar() {
  const hamburger=document.getElementById('hamburger'),sidebar=document.getElementById('sidebar'),overlay=document.getElementById('sidebarOverlay');
  if(!hamburger||!sidebar||!overlay||hamburger.dataset.mobileNavWired)return;
  hamburger.dataset.mobileNavWired='1';overlay.dataset.mobileNavWired='1';hamburger.setAttribute('aria-controls','sidebar');hamburger.setAttribute('aria-expanded','false');hamburger.setAttribute('aria-label','Open navigation');
  function close(returnFocus) {sidebar.classList.remove('open');overlay.classList.remove('open');hamburger.setAttribute('aria-expanded','false');if(returnFocus)hamburger.focus();}
  function toggle(){if(sidebar.classList.contains('open'))return close(true);sidebar.classList.add('open');overlay.classList.add('open');hamburger.setAttribute('aria-expanded','true');sidebar.querySelector('a,button,summary')?.focus();}
  hamburger.addEventListener('click',toggle);overlay.addEventListener('click',()=>close(true));
  sidebar.addEventListener('click',e=>{if(e.target.closest('a')&&window.innerWidth<768)close(false);});
  document.addEventListener('keydown',e=>{if(window.innerWidth>=768||!sidebar.classList.contains('open'))return;if(e.key==='Escape'){e.preventDefault();close(true);}if(e.key==='Tab'){const nodes=Array.from(sidebar.querySelectorAll('a,button,summary,[tabindex="0"]')).filter(n=>n.getClientRects().length&&!n.disabled);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&(document.activeElement===first||!sidebar.contains(document.activeElement))){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||!sidebar.contains(document.activeElement))){e.preventDefault();first?.focus();}}});
  window.addEventListener('resize',()=>{if(window.innerWidth>=768)close(false);});
}

// ── Tenant switcher ──────────────────────────────────────
function loadTenantSwitcher() {
  const container = document.getElementById('tenantSwitcher');
  if (!container) return;

  // Get current tenantId from JWT
  var currentTenantId = null;
  try {
    var token = localStorage.getItem('deepfeedai_token');
    if (token) currentTenantId = JSON.parse(atob(token.split('.')[1])).tenantId;
  } catch (_) {}

  apiFetch('/tenants/mine').then(function(data) {
    var tenants = data.tenants || [];
    if (tenants.length < 2) return; // No need to show switcher for single tenant

    var current = tenants.find(function(t) { return t.tenant_id === currentTenantId; });
    var currentName = current ? escHtml(current.display_name || current.slug) : 'Select site';

    container.innerHTML =
      '<div class="tenant-switcher">'
      + '<button class="tenant-switcher-btn nav-link" id="tenantSwitcherBtn">'
      + '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>'
      + ' <span class="tenant-switcher-name">' + currentName + '</span>'
      + '</button>'
      + '<div class="tenant-switcher-menu" id="tenantSwitcherMenu">'
      + tenants.map(function(t) {
          var active = t.tenant_id === currentTenantId ? ' tenant-active' : '';
          return '<button class="tenant-option' + active + '" data-tenant-id="' + t.tenant_id + '">'
            + escHtml(t.display_name || t.slug)
            + '<span class="text-muted text-xs">' + escHtml(t.role) + '</span>'
            + '</button>';
        }).join('')
      + '</div>'
      + '</div>';

    var btn = document.getElementById('tenantSwitcherBtn');
    var menu = document.getElementById('tenantSwitcherMenu');

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      menu.classList.toggle('open');
    });

    document.addEventListener('click', function() {
      menu.classList.remove('open');
    });

    menu.querySelectorAll('.tenant-option').forEach(function(opt) {
      opt.addEventListener('click', function() {
        var tid = Number(opt.getAttribute('data-tenant-id'));
        if (tid === currentTenantId) { menu.classList.remove('open'); return; }
        opt.textContent = 'Switching\u2026';
        apiFetch('/tenants/switch', {
          method: 'POST',
          body: JSON.stringify({ tenantId: tid }),
        }).then(function(res) {
          setToken(res.token);
          window.location.reload();
        }).catch(function(err) {
          showToast(err.message, 'error');
          menu.classList.remove('open');
        });
      });
    });
  }).catch(function() { /* ignore — user may not have multi-tenant access */ });
}

// ── Logout ────────────────────────────────────────────────
function initLogout() {
  document.querySelectorAll('[data-logout]').forEach(el => {
    el.addEventListener('click', async () => {
      try { await apiFetch('/auth/logout', { method: 'POST' }); } catch {}
      clearToken();
      window.location.href = '/login.html';
    });
  });
}

// ── Toast ─────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-msg">${escHtml(msg)}</span><button class="toast-close" aria-label="Close">✕</button>`;

  const dismiss = () => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };

  toast.querySelector('.toast-close').addEventListener('click', dismiss);

  container.appendChild(toast);
  setTimeout(dismiss, 4000);
}

// Alias kept for backward compatibility
function showAlert(msg, type = 'success') {
  showToast(msg, type === 'error' ? 'error' : type);
}

// ── Format helpers ────────────────────────────────────────
function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(str);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function relativeTime(str) {
  if (!str) return '—';
  const date = new Date(str);
  const diff = date - Date.now();
  const abs  = Math.abs(diff);
  const rtf  = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  const WEEK = 604_800_000, MONTH = 2_592_000_000, YEAR = 31_536_000_000;
  if (abs < MINUTE) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < HOUR)   return rtf.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY)    return rtf.format(Math.round(diff / HOUR), 'hour');
  if (abs < WEEK)   return rtf.format(Math.round(diff / DAY), 'day');
  if (abs < MONTH)  return rtf.format(Math.round(diff / WEEK), 'week');
  if (abs < YEAR)   return rtf.format(Math.round(diff / MONTH), 'month');
  return rtf.format(Math.round(diff / YEAR), 'year');
}

function badgePublished(v) {
  return v
    ? '<span class="badge badge-success">Published</span>'
    : '<span class="badge badge-muted">Draft</span>';
}

function badgeFeatured(v) {
  return v
    ? '<span class="badge badge-accent">⭐ Featured</span>'
    : '<span class="badge badge-muted">—</span>';
}

function badgeActive(v) {
  return v
    ? '<span class="badge badge-success">Active</span>'
    : '<span class="badge badge-danger">Off</span>';
}

// ── Categories (loaded dynamically from categories table) ─────────
window._siteCategories = [];

async function loadCategories() {
  if (window._siteCategories.length) return window._siteCategories;
  try {
    const cats = await apiFetch('/categories');
    window._siteCategories = Array.isArray(cats) ? cats.map(c => c.name) : [];
  } catch { /* ignore */ }
  if (!window._siteCategories.length) window._siteCategories = ['Industry'];
  return window._siteCategories;
}

function categoryOptions(selected = '') {
  const cats = window._siteCategories.length ? window._siteCategories : ['Industry'];
  return cats.map(c =>
    `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`
  ).join('');
}

// ── Pagination ────────────────────────────────────────────
function renderPagination(containerId, total, page, pageSize, onPageChange, onSizeChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const start = (page - 1) * pageSize + 1;
  const end   = Math.min(page * pageSize, total);

  // Build page number list with ellipsis
  const rawPages = new Set([1, 2, page - 1, page, page + 1, totalPages - 1, totalPages]);
  const pages = [...rawPages].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let btns = '';
  let prev = 0;
  for (const p of pages) {
    if (prev && p - prev > 1) btns += `<span class="page-ellipsis">…</span>`;
    btns += `<button class="page-btn${p === page ? ' active' : ''}" data-page="${p}">${p}</button>`;
    prev = p;
  }

  container.innerHTML = `
    <div class="pagination">
      <span class="pagination-info">Page ${page} of ${totalPages} &middot; ${start}–${end} of ${total}</span>
      <div class="pagination-controls">
        <button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
        ${btns}
        <button class="page-btn" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Next ›</button>
        <select class="page-size-select" aria-label="Items per page">
          ${[25, 50, 100].map(s => `<option value="${s}"${s === pageSize ? ' selected' : ''}>${s} / page</option>`).join('')}
        </select>
      </div>
    </div>`;

  container.querySelectorAll('.page-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => onPageChange(Number(btn.dataset.page)));
  });
  container.querySelector('.page-size-select').addEventListener('change', e => onSizeChange(Number(e.target.value)));
}

// ── Keyboard shortcut guard ────────────────────────────────
function isInputFocused() {
  const tag = document.activeElement?.tagName?.toLowerCase();
  return ['input','textarea','select'].includes(tag) || document.activeElement?.isContentEditable;
}

// ── Keyboard help overlay ──────────────────────────────────
function showKbdHelp(shortcuts) {
  const existing = document.getElementById('kbdOverlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.className = 'kbd-overlay';
  overlay.id = 'kbdOverlay';
  overlay.innerHTML = `
    <div class="kbd-panel">
      <h3>Keyboard Shortcuts <button id="kbdClose" class="btn btn-ghost btn-sm">✕</button></h3>
      <div class="kbd-list">
        ${shortcuts.map(s => `
          <div class="kbd-row">
            <span class="kbd-desc">${s.desc}</span>
            <kbd>${s.key}</kbd>
          </div>`).join('')}
      </div>
    </div>`;

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#kbdClose').addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// ── Skeleton helpers ──────────────────────────────────────
function skeletonRows(cols, count = 4) {
  const cells = cols.map(w => `<td><span class="skeleton sk-text ${w}"></span></td>`).join('');
  return Array(count).fill(`<tr class="skeleton-row">${cells}</tr>`).join('');
}

function skeletonStats(count = 4) {
  return Array(count).fill(`
    <div class="skeleton-stat">
      <span class="skeleton sk-stat-label"></span>
      <span class="skeleton sk-stat-value"></span>
    </div>`).join('');
}

// ── Feature Flags ─────────────────────────────────────────
window.AdminFeatures = null;
var _adminFeaturesPromise = null;

function loadAdminFeatures() {
  if (_adminFeaturesPromise) return _adminFeaturesPromise;
  _adminFeaturesPromise = (async function () {
    try {
      var features = await apiFetch('/features');
      window.AdminFeatures = features;
      return features;
    } catch (err) {
      console.warn('[feature-flags]', err.message);
      // Default to empty object — treat all features as enabled when flags unavailable
      window.AdminFeatures = {};
      return {};
    }
  })();
  return _adminFeaturesPromise;
}

function isFeatureOn(key) {
  if (!window.AdminFeatures) return true; // not loaded yet — default to enabled
  var val = window.AdminFeatures[key];
  if (val === undefined) return true; // unknown feature — default to enabled
  return val === true || val === 'true';
}

function featureGateBanner(featureName) {
  return '<div class="feature-gate-banner">'
    + '<span class="badge badge-muted" style="background:rgba(234,179,8,0.15);color:#eab308;">Upgrade</span>'
    + '<span>' + escHtml(featureName) + ' is not available on your current plan.</span>'
    + '</div>';
}

// ── DOM ready helper ──────────────────────────────────────
function onReady(fn) {
  if (document.readyState !== 'loading') fn();
  else document.addEventListener('DOMContentLoaded', fn);
}

// Separate module keeps the already deployed assignment button overlay intact.
if (location.pathname === '/pitches.html') {
  const briefScript = document.createElement('script');
  briefScript.src = '/assignment-brief.js';
  document.head.appendChild(briefScript);
}
if (location.pathname === '/article-editor.html') {
  const statusScript = document.createElement('script');
  statusScript.src = '/publication-status.js';
  document.head.appendChild(statusScript);
}

// Shared allowlisted list navigation state (source: navigation-state.js).
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkflowState=api;})(typeof window==='undefined'?globalThis:window,function(root){
'use strict';
function safeReturn(value,fallback='/articles.html'){try{if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\u0000-\u0020]/.test(value))return fallback;const u=new URL(value,'https://admin.invalid');return u.origin==='https://admin.invalid'&&/^\/[a-z0-9-]+\.html$/.test(u.pathname)?u.pathname+u.search+u.hash:fallback;}catch{return fallback;}}
function parse(schema,search){const params=new URLSearchParams(search);const out={};for(const[key,rule]of Object.entries(schema)){const value=params.get(key);if(value===null)continue;if(Array.isArray(rule)){if(rule.includes(value))out[key]=value;}else if(rule==='id'){if(/^[1-9]\d{0,9}$/.test(value))out[key]=value;}else if(rule==='number'){if(/^\d{1,7}$/.test(value))out[key]=value;}else if(value.length<=300)out[key]=value;}return out;}
function notify(){if(root.dispatchEvent&&root.Event)root.dispatchEvent(new root.Event('workflow:navigate'));}
function create(schema,restore){let restoring=false,lastUrl=root.location.pathname+root.location.search+root.location.hash;const read=()=>parse(schema,root.location.search);function saveScroll(){if(restoring)return;try{const panes={};for(const id of ['readerList','readerDetail']){const e=root.document?.getElementById(id);if(e)panes[id]=e.scrollTop;}root.history.replaceState({...root.history.state,workflowPanes:panes,workflowScroll:root.scrollY||0},'');}catch{}}
function restoreScroll(){root.requestAnimationFrame(()=>{root.scrollTo(0,Number(root.history.state?.workflowScroll)||0);for(const[id,top]of Object.entries(root.history.state?.workflowPanes||{})){if(!['readerList','readerDetail'].includes(id))continue;const e=root.document?.getElementById(id);if(e)e.scrollTop=Number(top)||0;}});}
function write(values,replace=false){if(restoring)return;const url=new URL(root.location.href);for(const key of Object.keys(schema)){const value=values[key];if(value===undefined||value===null||value==='')url.searchParams.delete(key);else url.searchParams.set(key,String(value));}if(url.href===root.location.href)return;saveScroll();root.history[replace?'replaceState':'pushState']({...root.history.state,workflowScroll:0},'',url.pathname+url.search+url.hash);lastUrl=url.pathname+url.search+url.hash;notify();}
root.addEventListener('pagehide',saveScroll);root.addEventListener('scroll',saveScroll,{passive:true,capture:true});root.addEventListener('popstate',async()=>{restoring=true;try{const result=await restore(read());if(result===false){root.history.replaceState(root.history.state,'',lastUrl);return;}lastUrl=root.location.pathname+root.location.search+root.location.hash;restoreScroll();notify();}finally{restoring=false;}});return {read,write,restoreScroll,safeReturn};}
return {safeReturn,parse,create};
});

// Update query-sensitive navigation after list history changes without replacing the shell.
window.addEventListener('workflow:navigate', function () {
  const current=location.pathname+location.search;
  document.querySelectorAll('.sidebar-nav a.nav-link').forEach(link=>{const item=window.WorkflowNav.resolve(link.getAttribute('href'));const active=item&&window.WorkflowNav.active(item,current);link.classList.toggle('active',!!active);if(active){link.setAttribute('aria-current','page');const tools=link.closest('details');if(tools)tools.open=true;const group=link.closest('[data-nav-group]');if(group){group.classList.remove('collapsed');const toggle=document.querySelector('[data-nav-toggle="'+group.dataset.navGroup+'"]');if(toggle){toggle.classList.remove('collapsed');toggle.setAttribute('aria-expanded','true');}}}else link.removeAttribute('aria-current');});
});

// BEGIN synchronous workflow guidance
(function () {
  'use strict';
  if(window.WorkflowHelp)return;
  function node(tag, text, cls) { const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n; }
  function boot() {
    const nav=window.WorkflowNav;if(!nav)return;
    const item=nav.resolve(location.pathname+location.search);if(!item||!nav.allowed(item))return;
    const custom=document.querySelector('.nr-topbar-right');
    const host=document.querySelector('.page-body, .page-content, .main-content, .settings-main')||custom;if(!host||document.getElementById('workflowPurpose'))return;
    const wrap=node('section',null,'workflow-purpose');wrap.id='workflowPurpose';wrap.setAttribute('aria-label','Page guidance');
    const copy=node('div',null,'workflow-purpose-copy');copy.append(node('span',item.group,'workflow-eyebrow'),node('p',item.purpose));wrap.append(copy);
    const actions=node('div',null,'workflow-guidance-actions');const help=node('button','Help with this page','btn btn-outline');help.type='button';help.id='workflowHelpButton';help.setAttribute('aria-expanded','false');help.setAttribute('aria-controls','workflowHelpPanel');actions.append(help);
    const candidates=nav.groups().find(g=>g.label===item.group)?.items||[];
    const next=candidates.find(p=>p.href!==item.href&&!p.secondary);
    if(next) {const a=node('a',next.label,'workflow-context-link');a.href=next.href;actions.append(a);}
    wrap.append(actions);
    if(custom&&host===custom){wrap.classList.add('workflow-custom-purpose');copy.hidden=true;const overview=node('a','Overview','workflow-context-link');overview.href='/overview.html';actions.prepend(overview);}
    // Keep page's existing topbar and all actual create/publish controls intact.
    const bar=host.querySelector(':scope > .topbar');if(bar)bar.after(wrap);else host.prepend(wrap);
    const panel=node('section',null,'workflow-help');panel.id='workflowHelpPanel';panel.hidden=true;panel.setAttribute('aria-labelledby','workflowHelpTitle');
    const title=node('h2','Help: '+item.label);title.id='workflowHelpTitle';panel.append(title,node('p',item.purpose));
    const caution=item.caution||nav.resolve(location.pathname)?.caution;
    if(caution)panel.append(node('p',caution,'workflow-caution'));
    panel.append(node('p','These links only navigate. They do not generate, approve, publish, delete, send messages, or retry jobs. Your available actions still depend on permissions and enabled features.'));
    const list=node('ul');candidates.filter(p=>p.href!==item.href).forEach(p=>{const li=node('li');const a=node('a',p.label);a.href=p.href;li.append(a,node('span',' — '+p.purpose));list.append(li);});panel.append(list);
    const intro=node('a','Getting started checklist');intro.href='/overview.html?onboarding=show';panel.append(intro);
    const close=node('button','Close help','btn btn-outline');close.type='button';panel.append(close);if(custom&&host===custom){panel.classList.add('workflow-custom-help');document.body.append(panel);}else wrap.after(panel);
    function set(open){panel.hidden=!open;help.setAttribute('aria-expanded',String(open));if(open){title.tabIndex=-1;title.focus();}else help.focus();}
    help.addEventListener('click',()=>set(panel.hidden));close.addEventListener('click',()=>set(false));panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();set(false);}});
  }
  window.addEventListener('workflow:navigate',function(){
    const panel=document.getElementById('workflowHelpPanel'),wrap=document.getElementById('workflowPurpose');
    const open=panel&&!panel.hidden;const focusOwned=!!(panel?.contains(document.activeElement)||wrap?.contains(document.activeElement));
    panel?.remove();wrap?.remove();boot();
    const replacement=document.getElementById('workflowHelpPanel'),button=document.getElementById('workflowHelpButton');
    if(open&&replacement){replacement.hidden=false;button?.setAttribute('aria-expanded','true');}
    if(focusOwned)button?.focus();
  });
  window.WorkflowHelp={boot};
  // admin.js is parser-loaded after page markup; mount now, without a second request.
  boot();
  // Fallback for custom shells that load the shared script earlier.
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);
})();

// END synchronous workflow guidance
