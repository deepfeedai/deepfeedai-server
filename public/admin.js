/* ===== DeepFeedAI Admin — Core JS ===== */

const API = '/api';

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
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

function requireGuest() {
  if (isLoggedIn()) {
    window.location.href = '/index.html';
  }
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
    window.location.href = '/login.html';
    throw new Error('Unauthorized');
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
function initSidebar() {
  const hamburger = document.getElementById('hamburger');
  const sidebar   = document.getElementById('sidebar');
  const overlay   = document.getElementById('sidebarOverlay');

  if (!hamburger || !sidebar) return;

  function toggleSidebar() {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  }

  hamburger.addEventListener('click', toggleSidebar);
  overlay.addEventListener('click', closeSidebar);

  // Close sidebar on nav link click (mobile)
  sidebar.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth < 768) closeSidebar();
    });
  });
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

// ── Toast / Alert ─────────────────────────────────────────
function showAlert(msg, type = 'success', container = '#alertArea') {
  const area = document.querySelector(container);
  if (!area) return;
  area.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
  setTimeout(() => { area.innerHTML = ''; }, 3500);
}

// ── Format helpers ────────────────────────────────────────
function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(str);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

// ── Categories ────────────────────────────────────────────
const CATEGORIES = ['Industry', 'LLMs', 'Research', 'Tools', 'Policy', 'Hardware', 'Agents', 'Other'];

function categoryOptions(selected = '') {
  return CATEGORIES.map(c =>
    `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`
  ).join('');
}

// ── DOM ready helper ──────────────────────────────────────
function onReady(fn) {
  if (document.readyState !== 'loading') fn();
  else document.addEventListener('DOMContentLoaded', fn);
}
