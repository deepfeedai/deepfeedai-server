/* ===== DeepFeedAI Admin — /notifications page (PR-D) ===== */
(function () {
  'use strict';

  if (typeof requireAuth === 'function' && !requireAuth()) return;

  var PAGE_SIZE = 25;

  var state = {
    tab: 'unread', // 'unread' | 'all'
    offset: 0,
    items: [],
    hasMore: false,
    loading: false,
  };

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
    return new Date(t).toLocaleString();
  }

  function dayKey(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'Older';
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var yest = new Date(today); yest.setDate(yest.getDate() - 1);
    var start = new Date(d); start.setHours(0, 0, 0, 0);
    if (start.getTime() === today.getTime()) return 'Today';
    if (start.getTime() === yest.getTime()) return 'Yesterday';
    return start.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'dfa-bell-toast dfa-bell-toast-' + (kind || 'ok');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('show'); }, 10);
    setTimeout(function () { el.classList.remove('show'); setTimeout(function () { el.remove(); }, 300); }, 2600);
  }

  async function fetchPage(reset) {
    if (state.loading) return;
    state.loading = true;
    if (reset) { state.items = []; state.offset = 0; }
    var params = ['limit=' + PAGE_SIZE, 'offset=' + state.offset];
    if (state.tab === 'unread') params.push('unread=1');
    try {
      var r = await apiFetch('/admin-notifications?' + params.join('&'));
      state.items = state.items.concat(r.items || []);
      state.hasMore = !!r.has_more;
      state.offset += (r.items || []).length;
      var badge = document.getElementById('notifUnreadCount');
      if (badge) badge.textContent = r.unread_count != null ? r.unread_count : '';
    } catch (err) {
      var m = String(err && err.message || '');
      if (/disabled/.test(m) || /permission/i.test(m)) {
        showFlagBanner();
      } else {
        document.getElementById('notifContent').innerHTML =
          '<div class="notif-empty">Failed to load: ' + esc(m) + '</div>';
      }
    } finally {
      state.loading = false;
      render();
    }
  }

  function showFlagBanner() {
    var b = document.getElementById('notifFlagBanner');
    if (!b) return;
    b.style.display = 'block';
    b.innerHTML =
      '<div class="feature-gate-banner" style="padding:16px;border-radius:10px;background:rgba(234,179,8,0.1);border:1px solid rgba(234,179,8,0.3);color:var(--text);margin-bottom:16px;">' +
      '<strong>Notifications Center is disabled</strong><br>' +
      '<span style="color:var(--muted);font-size:13px;">Enable the <code>notifications_center</code> feature flag to use this page.</span></div>';
    document.getElementById('notifContent').innerHTML = '';
  }

  function render() {
    var container = document.getElementById('notifContent');
    if (!container) return;
    if (!state.items.length) {
      container.innerHTML = '<div class="notif-empty">' +
        (state.tab === 'unread' ? 'You\'re all caught up 🎉' : 'No notifications yet') + '</div>';
    } else {
      // Group by day
      var groups = [];
      var byKey = {};
      state.items.forEach(function (n) {
        var k = dayKey(n.created_at);
        if (!byKey[k]) { byKey[k] = []; groups.push(k); }
        byKey[k].push(n);
      });
      var html = groups.map(function (k) {
        return '<div class="notif-day-header">' + esc(k) + '</div>' +
          byKey[k].map(renderCard).join('');
      }).join('');
      container.innerHTML = html;

      container.querySelectorAll('[data-notif-id]').forEach(function (el) {
        var id = Number(el.getAttribute('data-notif-id'));
        el.querySelectorAll('.dfa-bell-action-btn[data-token]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            runAction(btn, id);
          });
        });
        var readBtn = el.querySelector('[data-mark-read]');
        if (readBtn) readBtn.addEventListener('click', function () { markRead(id); });
      });
    }

    var loadMore = document.getElementById('notifLoadMore');
    if (loadMore) {
      loadMore.style.display = state.hasMore ? 'block' : 'none';
      loadMore.disabled = state.loading;
      loadMore.textContent = state.loading ? 'Loading…' : 'Load more';
    }
  }

  function renderCard(n) {
    var actions = '';
    var list = (n.payload && Array.isArray(n.payload.actionable)) ? n.payload.actionable : [];
    if (list.length) {
      actions = '<div class="notif-card-actions">' + list.map(function (a) {
        var cls = a.style === 'primary' ? ' primary' : '';
        return '<button class="dfa-bell-action-btn' + cls + '" data-token="' +
          esc(a.token || '') + '">' + esc(a.label || 'Do') + '</button>';
      }).join('') +
      (!n.read_at ? '<button class="dfa-bell-action-btn" data-mark-read>Mark read</button>' : '') +
      '</div>';
    } else if (!n.read_at) {
      actions = '<div class="notif-card-actions"><button class="dfa-bell-action-btn" data-mark-read>Mark read</button></div>';
    }
    return '<div class="notif-card' + (n.read_at ? '' : ' unread') + '" data-notif-id="' + n.id + '">' +
      '<div class="notif-card-head">' +
        '<div class="notif-card-title">' +
          '<span class="notif-card-kind">' + esc(n.kind || 'notif') + '</span>' +
          esc(n.title || '(untitled)') +
        '</div>' +
        '<div class="notif-card-time">' + esc(relTime(n.created_at)) + '</div>' +
      '</div>' +
      (n.body ? '<div class="notif-card-body">' + esc(n.body) + '</div>' : '') +
      actions +
      '</div>';
  }

  async function markRead(id) {
    try { await apiFetch('/admin-notifications/' + id + '/read', { method: 'POST' }); } catch (_) {}
    var item = state.items.find(function (x) { return x.id === id; });
    if (item) item.read_at = new Date().toISOString();
    if (state.tab === 'unread') state.items = state.items.filter(function (x) { return !!x.read_at === false; });
    render();
    refreshUnreadBadge();
  }

  async function refreshUnreadBadge() {
    try {
      var r = await apiFetch('/admin-notifications/unread-count');
      var b = document.getElementById('notifUnreadCount');
      if (b) b.textContent = (r && r.count) != null ? r.count : '';
    } catch (_) {}
  }

  async function markAllRead() {
    try {
      await apiFetch('/admin-notifications/mark-all-read', { method: 'POST' });
      state.items.forEach(function (i) { if (!i.read_at) i.read_at = new Date().toISOString(); });
      if (state.tab === 'unread') state.items = [];
      render();
      refreshUnreadBadge();
      toast('All marked as read');
    } catch (err) { toast('Failed: ' + (err && err.message), 'err'); }
  }

  async function runAction(btn, notifId) {
    var token = btn.getAttribute('data-token');
    if (!token || btn.disabled) return;
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> …';
    try {
      await apiFetch('/actions/' + encodeURIComponent(token), {
        method: 'POST', body: JSON.stringify({ source: 'web' }),
      });
      try { await apiFetch('/admin-notifications/' + notifId + '/read', { method: 'POST' }); } catch (_) {}
      toast('Done');
      state.items = state.items.filter(function (x) { return x.id !== notifId; });
      render();
      refreshUnreadBadge();
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = original;
      toast((err && err.message) || 'Action failed', 'err');
    }
  }

  function init() {
    if (typeof renderSidebar === 'function') renderSidebar();
    if (typeof initModals === 'function') initModals();

    document.querySelectorAll('.notif-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.notif-tab').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.tab = btn.getAttribute('data-tab');
        fetchPage(true);
      });
    });

    document.getElementById('notifLoadMore').addEventListener('click', function () { fetchPage(false); });
    document.getElementById('notifMarkAllBtn').addEventListener('click', markAllRead);

    fetchPage(true);
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
