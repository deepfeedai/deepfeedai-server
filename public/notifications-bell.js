/* ===== DeepFeedAI Admin — Notifications bell (PR-D) ===== */
/*
 * Self-mounting bell component. Auto-injects into `.topbar` on any admin page
 * that also loads admin.js (for apiFetch). Polls /admin-notifications/unread-count
 * every 15s (paused while tab hidden). Silent no-op if the feature flag is off.
 *
 * Styles are inline + one scoped <style> block to avoid clobbering admin.css.
 * Action buttons POST to /actions/:token (PR-B) and hit parity with Telegram etc.
 */
(function () {
  'use strict';

  if (window._dfaNotifBellLoaded) return;
  window._dfaNotifBellLoaded = true;

  var POLL_MS = 15000;
  var DROPDOWN_LIMIT = 20;

  // ── Utility ─────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function relTime(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'dfa-bell-toast dfa-bell-toast-' + (kind || 'ok');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('show'); }, 10);
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 2600);
  }

  // ── Styles (scoped) ─────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('dfa-bell-styles')) return;
    var css = [
      '.dfa-bell { position:relative; display:inline-flex; align-items:center; justify-content:center;',
      '  width:36px; height:36px; border-radius:8px; background:transparent; border:1px solid var(--border,#333);',
      '  color:var(--text,#ddd); cursor:pointer; margin-right:8px; }',
      '.dfa-bell:hover { background:var(--surface2,rgba(255,255,255,0.05)); }',
      '.dfa-bell svg { width:18px; height:18px; }',
      '.dfa-bell-badge { position:absolute; top:-4px; right:-4px; min-width:16px; height:16px; padding:0 4px;',
      '  border-radius:8px; background:#ef4444; color:#fff; font-size:10px; font-weight:700;',
      '  display:none; align-items:center; justify-content:center; line-height:1; }',
      '.dfa-bell-badge.show { display:flex; }',
      '.dfa-bell-dropdown { position:absolute; top:calc(100% + 6px); right:0; width:380px; max-width:92vw;',
      '  max-height:520px; overflow:hidden; background:var(--bg-card,#1a1a1a); border:1px solid var(--border,#333);',
      '  border-radius:12px; box-shadow:0 10px 32px rgba(0,0,0,0.35); z-index:1000; display:none;',
      '  flex-direction:column; }',
      '.dfa-bell-dropdown.open { display:flex; }',
      '.dfa-bell-head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px;',
      '  border-bottom:1px solid var(--border,#333); font-weight:600; font-size:13px; }',
      '.dfa-bell-head a { color:var(--primary,#6366f1); text-decoration:none; font-size:12px; font-weight:500; cursor:pointer; }',
      '.dfa-bell-list { overflow-y:auto; flex:1; }',
      '.dfa-bell-item { padding:12px 14px; border-bottom:1px solid var(--border,#333); font-size:13px;',
      '  transition:background 0.15s; }',
      '.dfa-bell-item:last-child { border-bottom:none; }',
      '.dfa-bell-item.unread { background:rgba(99,102,241,0.05); }',
      '.dfa-bell-item:hover { background:var(--surface2,rgba(255,255,255,0.04)); }',
      '.dfa-bell-title { font-weight:600; color:var(--text,#ddd); margin-bottom:2px; }',
      '.dfa-bell-body { color:var(--muted,#999); font-size:12px; line-height:1.4; margin-bottom:4px; }',
      '.dfa-bell-time { color:var(--muted,#888); font-size:11px; }',
      '.dfa-bell-actions { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }',
      '.dfa-bell-action-btn { padding:5px 10px; border-radius:6px; border:1px solid var(--border,#333);',
      '  background:var(--surface2,rgba(255,255,255,0.04)); color:var(--text,#ddd); font-size:11px;',
      '  font-weight:500; cursor:pointer; display:inline-flex; align-items:center; gap:4px; }',
      '.dfa-bell-action-btn:hover:not(:disabled) { background:var(--primary,#6366f1); color:#fff; border-color:var(--primary,#6366f1); }',
      '.dfa-bell-action-btn:disabled { opacity:0.6; cursor:wait; }',
      '.dfa-bell-action-btn.primary { background:var(--primary,#6366f1); color:#fff; border-color:var(--primary,#6366f1); }',
      '.dfa-bell-action-btn .spin { display:inline-block; width:10px; height:10px; border:2px solid currentColor;',
      '  border-right-color:transparent; border-radius:50%; animation:dfa-bell-spin 0.6s linear infinite; }',
      '@keyframes dfa-bell-spin { to { transform:rotate(360deg); } }',
      '.dfa-bell-empty { padding:40px 20px; text-align:center; color:var(--muted,#999); font-size:13px; }',
      '.dfa-bell-foot { border-top:1px solid var(--border,#333); padding:10px 14px; display:flex;',
      '  justify-content:space-between; align-items:center; font-size:12px; }',
      '.dfa-bell-foot a { color:var(--primary,#6366f1); text-decoration:none; cursor:pointer; }',
      '.dfa-bell-toast { position:fixed; bottom:24px; right:24px; padding:10px 16px; border-radius:8px;',
      '  background:#22c55e; color:#fff; font-size:13px; font-weight:500; z-index:10000;',
      '  opacity:0; transform:translateY(10px); transition:all 0.2s; box-shadow:0 4px 12px rgba(0,0,0,0.3); }',
      '.dfa-bell-toast.show { opacity:1; transform:translateY(0); }',
      '.dfa-bell-toast-err { background:#ef4444; }',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'dfa-bell-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── State ───────────────────────────────────────────────
  var state = {
    disabled: false,      // feature flag off or first poll 403
    unread: 0,
    items: [],
    dropdownOpen: false,
    pollTimer: null,
  };

  // ── DOM ─────────────────────────────────────────────────
  function ensureBell() {
    if (document.getElementById('dfaBell')) return document.getElementById('dfaBell');
    var topbar = document.querySelector('.topbar');
    if (!topbar) return null;

    var wrap = document.createElement('div');
    wrap.id = 'dfaBellWrap';
    wrap.style.position = 'relative';
    wrap.style.display = 'inline-flex';

    var btn = document.createElement('button');
    btn.id = 'dfaBell';
    btn.className = 'dfa-bell';
    btn.title = 'Notifications';
    btn.setAttribute('aria-label', 'Notifications');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
      ' stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/>' +
      '</svg>' +
      '<span class="dfa-bell-badge" id="dfaBellBadge">0</span>';

    var dd = document.createElement('div');
    dd.id = 'dfaBellDropdown';
    dd.className = 'dfa-bell-dropdown';
    dd.innerHTML =
      '<div class="dfa-bell-head"><span>Notifications</span>' +
      '<a id="dfaBellMarkAll">Mark all read</a></div>' +
      '<div class="dfa-bell-list" id="dfaBellList">' +
        '<div class="dfa-bell-empty">Loading…</div>' +
      '</div>' +
      '<div class="dfa-bell-foot"><a href="/notifications.html">View all</a>' +
      '<span id="dfaBellFootCount" class="dfa-bell-time"></span></div>';

    wrap.appendChild(btn);
    wrap.appendChild(dd);

    // Insert before creditWidget / user if present, else append
    var userEl = document.getElementById('topbarUser');
    var creditEl = document.getElementById('creditWidget');
    var ref = creditEl || userEl;
    if (ref && ref.parentElement === topbar) topbar.insertBefore(wrap, ref);
    else topbar.appendChild(wrap);

    btn.addEventListener('click', toggleDropdown);
    dd.querySelector('#dfaBellMarkAll').addEventListener('click', markAllRead);

    document.addEventListener('click', function (e) {
      if (!state.dropdownOpen) return;
      if (wrap.contains(e.target)) return;
      closeDropdown();
    });

    return btn;
  }

  function setBadge(n) {
    var badge = document.getElementById('dfaBellBadge');
    if (!badge) return;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }
  }

  function renderList() {
    var list = document.getElementById('dfaBellList');
    if (!list) return;
    if (!state.items.length) {
      list.innerHTML = '<div class="dfa-bell-empty">You\'re all caught up 🎉</div>';
      return;
    }
    list.innerHTML = state.items.map(renderItem).join('');
    // Attach action handlers
    list.querySelectorAll('[data-notif-id]').forEach(function (itemEl) {
      var id = Number(itemEl.getAttribute('data-notif-id'));
      itemEl.querySelectorAll('.dfa-bell-action-btn[data-token]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          runAction(btn, id);
        });
      });
      itemEl.addEventListener('click', function () { markRead(id); });
    });
  }

  function renderItem(n) {
    var actions = '';
    var list = (n.payload && Array.isArray(n.payload.actionable)) ? n.payload.actionable : [];
    if (list.length) {
      actions = '<div class="dfa-bell-actions">' + list.map(function (a) {
        // Server-annotated stale states render as disabled pills with no click handler.
        if (a.used || a.expired) {
          return '<span class="dfa-bell-action-btn" style="opacity:0.6;cursor:default;" aria-disabled="true">' +
            esc(a.label || 'Done') + '</span>';
        }
        var cls = a.style === 'primary' ? ' primary' : '';
        return '<button class="dfa-bell-action-btn' + cls + '" data-token="' +
          esc(a.token || '') + '">' + esc(a.label || 'Do') + '</button>';
      }).join('') + '</div>';
    }
    return '<div class="dfa-bell-item' + (n.read_at ? '' : ' unread') + '" data-notif-id="' + n.id + '">' +
      '<div class="dfa-bell-title">' + esc(n.title || n.kind || 'Notification') + '</div>' +
      (n.body ? '<div class="dfa-bell-body">' + esc(truncate(n.body, 140)) + '</div>' : '') +
      '<div class="dfa-bell-time">' + esc(relTime(n.created_at)) + '</div>' +
      actions +
      '</div>';
  }

  // ── API ─────────────────────────────────────────────────
  function api(path, opts) {
    if (typeof apiFetch !== 'function') {
      return Promise.reject(new Error('apiFetch not loaded'));
    }
    return apiFetch(path, opts);
  }

  async function pollCount() {
    if (state.disabled) return;
    if (document.visibilityState === 'hidden') return;
    if (typeof isLoggedIn === 'function' && !isLoggedIn()) return;
    try {
      var r = await api('/admin-notifications/unread-count');
      state.unread = (r && r.count) || 0;
      setBadge(state.unread);
    } catch (err) {
      var m = String(err && err.message || '');
      if (/disabled/.test(m) || /403/.test(m) || /permission/i.test(m)) {
        // Feature flag off — silently disable
        state.disabled = true;
        var wrap = document.getElementById('dfaBellWrap');
        if (wrap) wrap.style.display = 'none';
        if (state.pollTimer) clearInterval(state.pollTimer);
      }
      // else transient — try again next tick
    }
  }

  async function loadList() {
    var list = document.getElementById('dfaBellList');
    if (list) list.innerHTML = '<div class="dfa-bell-empty">Loading…</div>';
    try {
      var r = await api('/admin-notifications?limit=' + DROPDOWN_LIMIT);
      state.items = (r && r.items) || [];
      state.unread = (r && r.unread_count) || 0;
      setBadge(state.unread);
      renderList();
    } catch (err) {
      if (list) list.innerHTML = '<div class="dfa-bell-empty">Failed to load</div>';
    }
  }

  async function markRead(id) {
    var item = state.items.find(function (x) { return x.id === id; });
    if (!item || item.read_at) return;
    item.read_at = new Date().toISOString();
    state.unread = Math.max(0, state.unread - 1);
    setBadge(state.unread);
    renderList();
    try { await api('/admin-notifications/' + id + '/read', { method: 'POST' }); }
    catch (_) { /* best-effort */ }
  }

  async function markAllRead(e) {
    if (e) e.preventDefault();
    try {
      await api('/admin-notifications/mark-all-read', { method: 'POST' });
      state.items.forEach(function (i) { if (!i.read_at) i.read_at = new Date().toISOString(); });
      state.unread = 0;
      setBadge(0);
      renderList();
      toast('All marked as read');
    } catch (err) {
      toast('Failed to mark all read', 'err');
    }
  }

  async function runAction(btn, notifId) {
    var token = btn.getAttribute('data-token');
    if (!token || btn.disabled) return;
    var originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> …';
    try {
      await api('/actions/' + encodeURIComponent(token), {
        method: 'POST',
        body: JSON.stringify({ source: 'web' }),
      });
      toast('Done');
      // Mark read + remove from dropdown list
      try { await api('/admin-notifications/' + notifId + '/read', { method: 'POST' }); } catch (_) {}
      state.items = state.items.filter(function (x) { return x.id !== notifId; });
      state.unread = Math.max(0, state.unread - 1);
      setBadge(state.unread);
      renderList();
      // Refresh count in case server cascaded things
      pollCount();
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      toast(err && err.message || 'Action failed', 'err');
    }
  }

  function toggleDropdown() {
    if (state.dropdownOpen) closeDropdown();
    else openDropdown();
  }

  function openDropdown() {
    var dd = document.getElementById('dfaBellDropdown');
    if (!dd) return;
    dd.classList.add('open');
    state.dropdownOpen = true;
    loadList();
  }

  function closeDropdown() {
    var dd = document.getElementById('dfaBellDropdown');
    if (!dd) return;
    dd.classList.remove('open');
    state.dropdownOpen = false;
  }

  // ── Boot ────────────────────────────────────────────────
  function boot() {
    // Only on pages with a topbar and admin.js apiFetch. Login/setup pages lack .topbar.
    if (!document.querySelector('.topbar')) return;
    if (typeof apiFetch !== 'function') return;
    if (typeof isLoggedIn === 'function' && !isLoggedIn()) return;

    injectStyles();

    // Mount slightly after admin.js renderSidebar() finishes inserting the topbar content.
    // renderSidebar runs in onReady; we'll poll briefly for the topbar, then mount.
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (document.querySelector('.topbar')) {
        clearInterval(t);
        ensureBell();
        pollCount();
        state.pollTimer = setInterval(pollCount, POLL_MS);
        // Re-poll immediately when tab becomes visible
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') pollCount();
        });
      } else if (tries > 20) {
        clearInterval(t);
      }
    }, 100);
  }

  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
