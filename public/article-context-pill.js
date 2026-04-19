/**
 * Persistent Article-Context Pill
 *
 * Shows an always-visible pill in the topbar — "📄 <title> ▾" — that
 * persists across page navigation via localStorage. Click to jump between
 * surfaces (Edit / Preview / Chat / Pitches / Analytics) with the same
 * article pre-loaded. Click ✕ to clear.
 *
 * Auto-detection: when the user lands on /article-editor.html?id=N or
 * /preview.html?slug=X, the pill sets itself from the API response.
 * Pages can also call window.ArticleContext.set({...}) programmatically.
 *
 * Storage key: navKit.article.v1
 * Schema: { id, title, slug, writer_id, writer_name, set_at }
 */
(function () {
  'use strict';

  var KEY = 'navKit.article.v1';
  var MAX_AGE_MS = 24 * 60 * 60 * 1000; // drop after 24h of inactivity

  function ready(cb) {
    if (window.NavKit && document.querySelector('.topbar')) return cb();
    setTimeout(function () { ready(cb); }, 50);
  }

  ready(function init() {
    var NK = window.NavKit;
    var esc = NK.esc;
    var el  = NK.el;

    // ── Storage ────────────────────────────────────────────
    function read() {
      try {
        var raw = JSON.parse(localStorage.getItem(KEY));
        if (!raw || !raw.id) return null;
        if (raw.set_at && Date.now() - raw.set_at > MAX_AGE_MS) {
          localStorage.removeItem(KEY);
          return null;
        }
        return raw;
      } catch (_) { return null; }
    }
    function write(obj) {
      try {
        localStorage.setItem(KEY, JSON.stringify(Object.assign({}, obj, { set_at: Date.now() })));
      } catch (_) {}
      render();
    }
    function clear() {
      localStorage.removeItem(KEY);
      render();
    }

    // ── Auto-detect on article pages ──────────────────────
    async function autoDetect() {
      try {
        if (location.pathname === '/article-editor.html') {
          var id = new URLSearchParams(location.search).get('id');
          if (!id) return;
          var a = await apiFetch('/articles/' + id);
          if (a && a.id) {
            write({ id: a.id, title: a.title, slug: a.slug, writer_id: a.writer_id || null, writer_name: a.writer_name || null });
          }
        } else if (location.pathname === '/preview.html') {
          var slug = new URLSearchParams(location.search).get('slug');
          if (!slug) return;
          var b = await apiFetch('/articles/preview-by-slug?slug=' + encodeURIComponent(slug));
          if (b && b.id) {
            write({ id: b.id, title: b.title, slug: b.slug, writer_id: b.writer_id || null, writer_name: b.writer_name || null });
          }
        }
      } catch (_) { /* silent — pill stays at last-known article */ }
    }

    // ── Render ─────────────────────────────────────────────
    function render() {
      var topbar = document.querySelector('.topbar');
      if (!topbar) return;
      var existing = document.getElementById('articleContextPill');
      if (existing) existing.remove();

      var ctx = read();
      if (!ctx) return;

      var pill = el('div', { id: 'articleContextPill', class: 'article-context-pill' });
      // When multiple sources are queued (multi-source pitch composing), show
      // "Title +N more" so the editor knows the full stack is attached.
      var additionalCount = Array.isArray(ctx.additional_ids) ? ctx.additional_ids.length : 0;
      var titleHtml = esc(ctx.title || ('Article #' + ctx.id))
        + (additionalCount > 0 ? ' <span class="acp-more">+' + additionalCount + '</span>' : '');
      pill.innerHTML = ''
        + '<button class="acp-btn" aria-haspopup="menu">'
        +   '<span class="acp-icon">📄</span>'
        +   '<span class="acp-title">' + titleHtml + '</span>'
        +   '<span class="acp-caret">▾</span>'
        + '</button>'
        + '<button class="acp-clear" title="Clear article context" aria-label="Clear">✕</button>';

      var menu = el('div', { class: 'acp-menu', role: 'menu' });
      [
        { label: '✏️ Edit',     href: '/article-editor.html?id=' + ctx.id },
        { label: '👁 Preview',   href: ctx.slug ? '/preview.html?slug=' + encodeURIComponent(ctx.slug) : null },
        { label: '💬 Chat with writer', href: ctx.writer_id ? '/newsroom-chat.html?writer_id=' + ctx.writer_id + '&context_article_id=' + ctx.id : null },
        { label: '📋 Pitches',   href: '/pitches.html?source_article_id=' + ctx.id },
        { label: '📊 Analytics', href: '/analytics.html?article_id=' + ctx.id },
      ].forEach(function (row) {
        if (!row.href) return;
        var link = el('a', { class: 'acp-menu-item', href: row.href, role: 'menuitem' }, [row.label]);
        menu.appendChild(link);
      });
      pill.appendChild(menu);

      pill.querySelector('.acp-btn').addEventListener('click', function (ev) {
        ev.stopPropagation();
        pill.classList.toggle('open');
      });
      pill.querySelector('.acp-clear').addEventListener('click', function (ev) {
        ev.stopPropagation();
        clear();
      });
      document.addEventListener('click', function (ev) {
        if (!pill.contains(ev.target)) pill.classList.remove('open');
      });

      topbar.appendChild(pill);
    }

    // ── Styles ────────────────────────────────────────────
    (function styles() {
      if (document.getElementById('acpStyles')) return;
      var s = document.createElement('style');
      s.id = 'acpStyles';
      s.textContent = [
        '.topbar { display:flex; align-items:center; gap:12px; }',
        '.topbar .topbar-title { flex:1; min-width:0; }',
        '.article-context-pill { position:relative; display:flex; align-items:center; gap:4px; flex-shrink:0; }',
        '.acp-btn { display:inline-flex; align-items:center; gap:6px; background:var(--surface2, #1f1f1f); border:1px solid var(--border, #333); color:var(--text, #fff); padding:6px 10px; border-radius:999px; font-size:12px; cursor:pointer; max-width:260px; }',
        '.acp-btn:hover { background:var(--bg-card, #1a1a1a); }',
        '.acp-icon { font-size:13px; }',
        '.acp-title { max-width:180px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.acp-more { display:inline-block; margin-left:4px; padding:1px 6px; border-radius:999px; background:var(--primary, #7c3aed); color:#fff; font-size:10px; font-weight:700; vertical-align:middle; }',
        '.acp-caret { color:var(--muted, #888); font-size:10px; }',
        '.acp-clear { background:none; border:0; color:var(--muted, #888); font-size:13px; cursor:pointer; padding:4px 6px; border-radius:6px; }',
        '.acp-clear:hover { color:var(--text, #fff); background:var(--surface2, #222); }',
        '.acp-menu { display:none; position:absolute; top:calc(100% + 6px); right:0; background:var(--bg-card, #1a1a1a); border:1px solid var(--border, #333); border-radius:8px; padding:4px; min-width:200px; box-shadow:0 8px 24px rgba(0,0,0,0.3); z-index:100; }',
        '.article-context-pill.open .acp-menu { display:block; }',
        '.acp-menu-item { display:block; padding:8px 10px; font-size:13px; color:var(--text, #fff); text-decoration:none; border-radius:6px; }',
        '.acp-menu-item:hover { background:var(--surface2, #222); }',
        '@media (max-width: 640px) { .acp-title { max-width:90px; } .acp-btn { max-width:140px; } }',
      ].join('\n');
      document.head.appendChild(s);
    })();

    // Expose API for pages to set/clear programmatically
    window.ArticleContext = {
      set: function (obj) {
        if (!obj || !obj.id) return;
        write(obj);
      },
      clear: clear,
      get:   read,
      render: render,
    };

    // Re-render on turbo navigations so the pill reflects new context
    document.addEventListener('turbonav:loaded', function () {
      autoDetect().then(render);
    });

    autoDetect().then(render);
  });
})();
