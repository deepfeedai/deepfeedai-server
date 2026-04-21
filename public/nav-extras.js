/**
 * Nav Extras — sidebar Recent/Pinned section + Gmail-style shortcuts.
 *
 * Runs after admin.js renderSidebar() has mounted the sidebar. Inserts a
 * dedicated section at the top of .sidebar-nav showing:
 *
 *   ★ Pinned    — user-curated, right-click any nav link to pin/unpin
 *   ⏱ Recent    — auto from NavKit visit telemetry, capped at 5
 *
 * Also registers Gmail-style g-chord shortcuts that jump to common pages:
 *   g d → Dashboard         g a → Articles        g e → Editorial
 *   g c → Newsroom Chat     g p → Pitches         g f → Feed Inbox
 *   g v → Activity          g , → Settings
 *
 * All keybindings show up in the ? cheatsheet automatically.
 */
(function () {
  'use strict';

  function ready(cb) {
    if (window.NavKit && window.NAV_GROUPS && document.querySelector('.sidebar-nav')) return cb();
    setTimeout(function () { ready(cb); }, 50);
  }

  ready(function init() {
    var NK = window.NavKit;
    var esc = NK.esc;
    var el  = NK.el;

    var PINNED_KEY = 'navKit.pinned.v1';
    var MAX_RECENT = 5;

    // ── Storage ────────────────────────────────────────────
    function readPinned() {
      try { return JSON.parse(localStorage.getItem(PINNED_KEY)) || []; }
      catch (_) { return []; }
    }
    function writePinned(arr) {
      try { localStorage.setItem(PINNED_KEY, JSON.stringify(arr.slice(0, 10))); } catch (_) {}
    }
    function isPinned(href) { return readPinned().indexOf(href) >= 0; }
    function togglePin(href) {
      var arr = readPinned();
      var idx = arr.indexOf(href);
      if (idx >= 0) arr.splice(idx, 1); else arr.unshift(href);
      writePinned(arr);
    }

    // ── Resolve href → { label, icon } from NAV_GROUPS ────
    function lookup(href) {
      var groups = window.NAV_GROUPS || [];
      for (var i = 0; i < groups.length; i++) {
        var items = groups[i].items;
        for (var j = 0; j < items.length; j++) {
          if (items[j].href === href) return items[j];
        }
      }
      // Fallback: synthesise a label from the path
      return { href: href, label: href.replace(/^\/|\.html$/g, '').replace(/-/g, ' '), icon: '⏱' };
    }


    var CHEVRON = '<svg class="nav-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';


    // ── Render ─────────────────────────────────────────────
    function render() {
      var nav = document.querySelector('.sidebar-nav');
      if (!nav) return;
      var existing = document.getElementById('navExtras');
      if (existing) existing.remove();

      var pinned = readPinned().map(lookup);
      var recent = NK.getRecent()
        .filter(function (r) { return !isPinned(r.path); })
        .slice(0, MAX_RECENT)
        .map(function (r) {
          var known = lookup(r.path);
          return { href: r.path, label: known.label || r.label, icon: known.icon };
        });

      if (!pinned.length && !recent.length) return;

      var pathname = window.location.pathname;
      var wrap = el('div', { id: 'navExtras' });

      function section(label, items) {
        if (!items.length) return null;

        var storageKey = 'navExtras.collapsed.' + label.replace(/[^\w]/g, '');
        var isCollapsed = localStorage.getItem(storageKey) === 'true';

        var header = el('div', { class: 'nav-section' + (isCollapsed ? ' collapsed' : ''), html: label + CHEVRON });
        var group  = el('div', { class: 'nav-group'   + (isCollapsed ? ' collapsed' : '') });

        header.addEventListener('click', function () {
          var nowCollapsed = !header.classList.contains('collapsed');
          header.classList.toggle('collapsed', nowCollapsed);
          group.classList.toggle('collapsed',  nowCollapsed);
          try { localStorage.setItem(storageKey, nowCollapsed ? 'true' : 'false'); } catch (_) {}
        });

        items.forEach(function (it) {
          var active = pathname === it.href ? ' active' : '';
          group.appendChild(el('a', {

            class: 'nav-link' + active,
            href: it.href,
            dataset: { navExtrasHref: it.href },
            html: (it.icon || '') + ' <span>' + esc(it.label) + '</span>',

          }));
        });

        var frag = document.createDocumentFragment();
        frag.appendChild(header);
        frag.appendChild(group);

        return frag;
      }

      var pinSection    = section('★ Pinned',  pinned);
      var recentSection = section('⏱ Recent', recent);
      if (pinSection)    wrap.appendChild(pinSection);
      if (recentSection) wrap.appendChild(recentSection);

      nav.insertBefore(wrap, nav.firstChild);
    }

    // ── Context menu: right-click sidebar link to pin/unpin ─
    function attachContextMenus() {
      var nav = document.querySelector('.sidebar-nav');
      if (!nav) return;
      nav.addEventListener('contextmenu', function (ev) {
        var link = ev.target.closest('a.nav-link');
        if (!link || !link.href) return;
        ev.preventDefault();
        var href = new URL(link.href, location.href).pathname;
        togglePin(href);
        render();
        toast(isPinned(href) ? 'Pinned' : 'Unpinned');
      });
    }

    function toast(msg) {
      var t = document.getElementById('navExtrasToast');
      if (t) t.remove();
      t = el('div', { id: 'navExtrasToast', class: 'nav-extras-toast' }, [msg]);
      document.body.appendChild(t);
      setTimeout(function () { t.classList.add('in'); }, 10);
      setTimeout(function () { t.classList.remove('in'); setTimeout(function () { t.remove(); }, 200); }, 1200);
    }

    // ── Gmail-style g-chord shortcuts ─────────────────────
    var GMAIL_SHORTCUTS = [
      { keys: 'g d', href: '/index.html',            label: 'Dashboard' },
      { keys: 'g a', href: '/articles.html',         label: 'Articles' },
      { keys: 'g e', href: '/editorial.html',        label: 'Editorial' },
      { keys: 'g c', href: '/newsroom-chat.html',    label: 'Newsroom Chat' },
      { keys: 'g p', href: '/pitches.html',          label: 'Pitches' },
      { keys: 'g f', href: '/feed-inbox.html',       label: 'Feed Inbox' },
      { keys: 'g v', href: '/newsroom-activity.html', label: 'Activity' },
      { keys: 'g w', href: '/writers.html',          label: 'Writers (AI Team)' },
      { keys: 'g s', href: '/story-board.html',      label: 'Story Board' },
      { keys: 'g ,', href: '/settings.html',         label: 'Settings' },
    ];
    GMAIL_SHORTCUTS.forEach(function (s) {
      NK.register(s.keys, function () { window.location.href = s.href; }, 'Jump to ' + s.label);
    });

    // Pin/unpin current page
    NK.register('mod+d', function () {
      var p = window.location.pathname;
      togglePin(p);
      render();
      toast(isPinned(p) ? 'Pinned' : 'Unpinned');
    }, 'Pin/unpin current page');

    // ── Styles ────────────────────────────────────────────
    (function styles() {
      if (document.getElementById('navExtrasStyles')) return;
      var s = document.createElement('style');
      s.id = 'navExtrasStyles';
      s.textContent = [
        '#navExtras .nav-section:first-child { margin-top:0; }',
        '#navExtras { padding-bottom:4px; margin-bottom:4px; border-bottom:1px solid var(--border, #333); }',
        '#navExtras .nav-link { opacity:0.95; }',
        '#navExtras .nav-link span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:inline-block; max-width:160px; vertical-align:bottom; }',
        '.nav-extras-toast { position:fixed; bottom:20px; left:50%; transform:translate(-50%, 20px); background:var(--bg-card, #1a1a1a); color:var(--text, #fff); border:1px solid var(--border, #333); padding:8px 14px; border-radius:8px; font-size:13px; z-index:10001; opacity:0; transition:opacity 0.2s, transform 0.2s; box-shadow:0 8px 24px rgba(0,0,0,0.3); }',
        '.nav-extras-toast.in { opacity:1; transform:translate(-50%, 0); }',
      ].join('\n');
      document.head.appendChild(s);
    })();

    render();
    attachContextMenus();
  });
})();
