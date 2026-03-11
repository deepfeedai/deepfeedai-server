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
  toast.innerHTML = `<span class="toast-msg">${msg}</span><button class="toast-close" aria-label="Close">✕</button>`;

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

// ── Categories ────────────────────────────────────────────
const CATEGORIES = ['Industry', 'LLMs', 'Research', 'Tools', 'Policy', 'Hardware', 'Agents', 'Other'];

function categoryOptions(selected = '') {
  return CATEGORIES.map(c =>
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

// ── DOM ready helper ──────────────────────────────────────
function onReady(fn) {
  if (document.readyState !== 'loading') fn();
  else document.addEventListener('DOMContentLoaded', fn);
}
