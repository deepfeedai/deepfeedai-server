/**
 * Writer Drawer — right-side slide-out with a writer's profile + activity.
 *
 * Opens when a page explicitly calls window.WriterDrawer.open(writerId)
 * OR when the user clicks an element carrying data-writer-id="N" (global
 * delegate, so pages can opt in by adding that attribute to a name/avatar).
 *
 * Content:
 *   - Avatar, name, beats, bio
 *   - Recent articles (last 5, linking to the editor)
 *   - Pending pitches for this writer
 *   - Active editorial memories (if the tenant has them)
 *   - Quick actions: Open chat, Open full profile page
 *
 * Close: Esc, backdrop click, or the ✕ button. Back button also closes
 * (pushState while open, popstate closes — preserves "Esc/back closes
 * the panel before leaving the page" expectation).
 */
(function () {
  'use strict';

  function ready(cb) {
    if (document.body && window.NavKit) return cb();
    setTimeout(function () { ready(cb); }, 50);
  }

  ready(function init() {
    if (!document.querySelector('.admin-layout')) return;

    var NK = window.NavKit;
    var esc = NK.esc;
    var el  = NK.el;

    var drawer = null;
    var backdrop = null;
    var historyPushed = false;

    // ── Data loaders ──────────────────────────────────────
    async function loadWriter(id) {
      // The public /writers endpoint doesn't return per-id; so fetch all + find.
      // Cheap enough, and responses are cached by the browser.
      try {
        var all = await apiFetch('/writers');
        var arr = Array.isArray(all) ? all : (all.writers || []);
        return arr.find(function (w) { return w.id === Number(id); }) || null;
      } catch (_) { return null; }
    }

    async function loadRecentArticles(writerId) {
      try {
        var data = await apiFetch('/articles?writer_id=' + writerId + '&limit=5');
        return Array.isArray(data) ? data : (data.articles || []);
      } catch (_) { return []; }
    }

    async function loadPendingPitches(writerId) {
      try {
        var data = await apiFetch('/admin/pitches?writer_id=' + writerId + '&status=pending');
        return Array.isArray(data) ? data : (data.pitches || []);
      } catch (_) { return []; }
    }

    // ── Render ────────────────────────────────────────────
    async function open(writerId) {
      ensure();
      drawer.querySelector('.wd-body').innerHTML = '<div class="wd-loading">Loading…</div>';
      showOverlay();

      var writer = await loadWriter(writerId);
      if (!writer) {
        drawer.querySelector('.wd-body').innerHTML = '<div class="wd-empty">Writer not found.</div>';
        return;
      }

      drawer.querySelector('.wd-head-name').textContent = writer.name || 'Writer';
      var avatar = drawer.querySelector('.wd-head-avatar');
      if (writer.avatar_url) {
        avatar.innerHTML = '<img src="' + esc(writer.avatar_url) + '" alt="">';
      } else {
        avatar.textContent = (writer.name || '?').charAt(0).toUpperCase();
      }

      var beats = Array.isArray(writer.beats) ? writer.beats.filter(Boolean) : [];
      var metaBits = [];
      if (beats.length) metaBits.push(beats.join(' · '));
      if (writer.article_count != null) metaBits.push(writer.article_count + ' articles');
      if (writer.follower_count) metaBits.push(writer.follower_count + ' followers');
      drawer.querySelector('.wd-head-meta').textContent = metaBits.join(' · ');

      var body = drawer.querySelector('.wd-body');
      body.innerHTML = '';

      if (writer.bio) {
        body.appendChild(el('div', { class: 'wd-bio' }, [writer.bio]));
      }

      // Quick actions
      var actions = el('div', { class: 'wd-actions' });
      actions.appendChild(el('a', {
        class: 'wd-btn primary',
        href: '/newsroom-chat.html?writer_id=' + writer.id,
      }, ['💬 Chat']));
      actions.appendChild(el('a', {
        class: 'wd-btn',
        href: '/writers.html' + (writer.slug ? '?slug=' + encodeURIComponent(writer.slug) : ''),
      }, ['Open profile']));
      body.appendChild(actions);

      // Recent articles
      var recentSec = el('section', { class: 'wd-sec' });
      recentSec.appendChild(el('h4', { class: 'wd-sec-title' }, ['Recent articles']));
      var recentList = el('div', { class: 'wd-list' });
      recentSec.appendChild(recentList);
      body.appendChild(recentSec);

      loadRecentArticles(writer.id).then(function (rows) {
        if (!rows.length) {
          recentList.innerHTML = '<div class="wd-empty">No recent articles.</div>';
          return;
        }
        rows.slice(0, 5).forEach(function (a) {
          var link = el('a', { class: 'wd-row', href: '/article-editor.html?id=' + a.id }, [
            el('div', { class: 'wd-row-title' }, [a.title || '(untitled)']),
            el('div', { class: 'wd-row-meta' }, [[a.status, a.category].filter(Boolean).join(' · ')]),
          ]);
          recentList.appendChild(link);
        });
      });

      // Pending pitches
      var pitchSec = el('section', { class: 'wd-sec' });
      pitchSec.appendChild(el('h4', { class: 'wd-sec-title' }, ['Pending pitches']));
      var pitchList = el('div', { class: 'wd-list' });
      pitchSec.appendChild(pitchList);
      body.appendChild(pitchSec);

      loadPendingPitches(writer.id).then(function (rows) {
        if (!rows.length) {
          pitchList.innerHTML = '<div class="wd-empty">No pending pitches.</div>';
          return;
        }
        rows.slice(0, 5).forEach(function (p) {
          var link = el('a', { class: 'wd-row', href: '/pitches.html?id=' + p.id }, [
            el('div', { class: 'wd-row-title' }, [p.headline || p.angle_summary || 'Pitch #' + p.id]),
            el('div', { class: 'wd-row-meta' }, [p.priority ? 'Priority ' + p.priority : '']),
          ]);
          pitchList.appendChild(link);
        });
      });
    }

    function close() {
      if (drawer) drawer.classList.remove('open');
      if (backdrop) backdrop.classList.remove('open');
      if (historyPushed) {
        historyPushed = false;
        history.back();
      }
    }

    function ensure() {
      if (drawer) return;
      backdrop = el('div', { class: 'wd-backdrop', onclick: close });
      drawer = el('aside', { id: 'writerDrawer', class: 'wd-drawer', role: 'dialog', 'aria-label': 'Writer profile' });
      drawer.innerHTML = ''
        + '<header class="wd-head">'
        +   '<div class="wd-head-avatar"></div>'
        +   '<div class="wd-head-info"><div class="wd-head-name"></div><div class="wd-head-meta"></div></div>'
        +   '<button class="wd-close" aria-label="Close">✕</button>'
        + '</header>'
        + '<div class="wd-body"></div>';
      drawer.querySelector('.wd-close').addEventListener('click', close);
      document.body.appendChild(backdrop);
      document.body.appendChild(drawer);
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && drawer.classList.contains('open')) close();
      });
    }

    function showOverlay() {
      drawer.classList.add('open');
      backdrop.classList.add('open');
      if (!historyPushed) {
        historyPushed = true;
        history.pushState({ writerDrawer: true }, '');
      }
    }

    window.addEventListener('popstate', function () {
      if (drawer && drawer.classList.contains('open')) {
        historyPushed = false;
        drawer.classList.remove('open');
        backdrop.classList.remove('open');
      }
    });

    // ── Global click delegate ─────────────────────────────
    document.addEventListener('click', function (ev) {
      var node = ev.target.closest('[data-writer-id]');
      if (!node) return;
      var id = Number(node.getAttribute('data-writer-id'));
      if (!id) return;
      // Let explicit links through — only intercept non-anchor or data-drawer="1"
      if (node.tagName === 'A' && node.getAttribute('data-drawer') !== '1') return;
      ev.preventDefault();
      open(id);
    });

    // ── Styles ────────────────────────────────────────────
    (function styles() {
      if (document.getElementById('writerDrawerStyles')) return;
      var s = document.createElement('style');
      s.id = 'writerDrawerStyles';
      s.textContent = [
        '.wd-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.4); opacity:0; pointer-events:none; transition:opacity 0.2s; z-index:9998; }',
        '.wd-backdrop.open { opacity:1; pointer-events:auto; }',
        '.wd-drawer { position:fixed; top:0; right:0; width:min(420px, 95vw); height:100vh; background:var(--bg-card, #1a1a1a); color:var(--text, #fff); border-left:1px solid var(--border, #333); transform:translateX(100%); transition:transform 0.22s ease-out; z-index:9999; display:flex; flex-direction:column; box-shadow:-8px 0 32px rgba(0,0,0,0.4); }',
        '.wd-drawer.open { transform:translateX(0); }',
        '.wd-head { display:flex; align-items:center; gap:12px; padding:14px 16px; border-bottom:1px solid var(--border, #333); flex-shrink:0; }',
        '.wd-head-avatar { width:40px; height:40px; border-radius:50%; background:var(--surface2, #222); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; overflow:hidden; flex-shrink:0; }',
        '.wd-head-avatar img { width:100%; height:100%; object-fit:cover; }',
        '.wd-head-info { flex:1; min-width:0; }',
        '.wd-head-name { font-size:15px; font-weight:600; }',
        '.wd-head-meta { font-size:12px; color:var(--muted, #888); }',
        '.wd-close { background:none; border:0; color:var(--muted, #888); font-size:15px; cursor:pointer; padding:4px 8px; border-radius:6px; }',
        '.wd-close:hover { color:var(--text, #fff); background:var(--surface2, #222); }',
        '.wd-body { flex:1; overflow-y:auto; padding:14px 16px; }',
        '.wd-bio { font-size:13px; color:var(--muted, #888); margin-bottom:14px; }',
        '.wd-actions { display:flex; gap:8px; margin-bottom:18px; }',
        '.wd-btn { display:inline-flex; align-items:center; padding:8px 14px; border-radius:8px; background:var(--surface2, #1f1f1f); color:var(--text, #fff); text-decoration:none; font-size:13px; border:1px solid var(--border, #333); }',
        '.wd-btn.primary { background:var(--primary, #7c3aed); border-color:var(--primary, #7c3aed); }',
        '.wd-btn:hover { opacity:0.9; }',
        '.wd-sec { margin-bottom:18px; }',
        '.wd-sec-title { font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted, #888); margin:0 0 8px 0; font-weight:600; }',
        '.wd-list { display:flex; flex-direction:column; gap:4px; }',
        '.wd-row { display:block; padding:8px 10px; border-radius:6px; text-decoration:none; color:var(--text, #fff); background:var(--surface2, #1f1f1f); }',
        '.wd-row:hover { background:var(--bg-card, #1a1a1a); }',
        '.wd-row-title { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.wd-row-meta { font-size:11px; color:var(--muted, #888); }',
        '.wd-loading, .wd-empty { padding:20px; text-align:center; color:var(--muted, #888); font-size:13px; }',
      ].join('\n');
      document.head.appendChild(s);
    })();

    // Public API
    window.WriterDrawer = { open: open, close: close };
  });
})();
