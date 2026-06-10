/**
 * Newsroom SPA — main controller
 * Handles workspace routing, auth, lazy init, and shared state.
 * Depends on: admin.js (apiFetch, requireAuth, showAlert)
 * Workspace modules: newsroom-floor.js, newsroom-wire.js, newsroom-desk.js
 */
(function () {
  'use strict';

  if (!requireAuth()) return;

  // ── Workspace registry ─────────────────────────────────────
  var workspaces = {
    floor:   { el: null, initialized: false, init: function() { if (window.NRFloor)   NRFloor.init();   } },
    wire:    { el: null, initialized: false, init: function() { if (window.NRWire)    NRWire.init();    } },
    desk:    { el: null, initialized: false, init: function() { if (window.NRDesk)    NRDesk.init();    } },
    reports: { el: null, initialized: false, init: function() { if (window.NRReports) NRReports.init(); } },
    custom:  { el: null, initialized: false, init: function() { if (window.NRCustom)  NRCustom.init();  } },
  };

  var activeWs = 'floor';

  // ── Switch workspace ────────────────────────────────────────
  function switchWorkspace(ws) {
    if (!workspaces[ws]) return;
    if (ws === activeWs) return;

    workspaces[activeWs].el.classList.remove('active');
    document.querySelectorAll('[data-ws]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.ws === ws);
    });

    activeWs = ws;
    workspaces[ws].el.classList.add('active');

    if (!workspaces[ws].initialized) {
      workspaces[ws].initialized = true;
      workspaces[ws].init();
    }

    // Persist last active workspace
    try { localStorage.setItem('nr_ws', ws); } catch (_) {}
  }

  // ── Init on DOM ready ───────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    // Resolve workspace elements
    workspaces.floor.el   = document.getElementById('ws-floor');
    workspaces.wire.el    = document.getElementById('ws-wire');
    workspaces.desk.el    = document.getElementById('ws-desk');
    workspaces.reports.el = document.getElementById('ws-reports');
    workspaces.custom.el  = document.getElementById('ws-custom');

    // Workspace tab click handlers
    document.querySelectorAll('[data-ws]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchWorkspace(btn.dataset.ws);
      });
    });

    // Restore last workspace (skip if 'floor' — that's the default)
    var savedWs = null;
    try { savedWs = localStorage.getItem('nr_ws'); } catch (_) {}
    if (savedWs && savedWs !== 'floor' && workspaces[savedWs]) {
      // Small delay so Floor init fires first (it's the visible pane)
      setTimeout(function() { switchWorkspace(savedWs); }, 0);
    }

    // Always init the Floor immediately (default landing)
    workspaces.floor.initialized = true;
    if (window.NRFloor) NRFloor.init();

    // Pre-load Wire data in the background so it's ready when the user switches
    workspaces.wire.initialized = true;
    if (window.NRWire) NRWire.init();

    // Init Maxwell chat panel
    if (window.NRChat) NRChat.init();

    // Sync user prefs from backend (cross-device: overrides localStorage if different)
    setTimeout(function () { if (window.NRPrefs) NRPrefs.init(); }, 800);

    // ── User menu ─────────────────────────────────────────
    (function initUserMenu() {
      var btn      = document.getElementById('nr-user-btn');
      var dropdown = document.getElementById('nr-user-dropdown');
      var avEl     = document.getElementById('nr-user-av');
      var identEl  = document.getElementById('nr-user-identity');
      if (!btn || !dropdown) return;

      // Populate from JWT payload
      try {
        var token   = localStorage.getItem('deepfeedai_token');
        var payload = token ? JSON.parse(atob(token.split('.')[1])) : null;
        if (payload) {
          var name = payload.displayName || payload.username || payload.email || '';
          var role = payload.role || '';
          var initials = name ? name.trim().split(/\s+/).map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase() : '?';
          if (avEl) avEl.textContent = initials;
          if (identEl && name) {
            identEl.innerHTML = '<strong>' + name.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</strong>'
              + (role ? '<span>' + role + '</span>' : '');
          }
          btn.title = name || 'Account';
        }
      } catch (_) {}

      // Toggle dropdown
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var open = dropdown.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });

      // Close on outside click
      document.addEventListener('click', function() {
        dropdown.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      });

      // Wire logout (admin.js initLogout() looks for [data-logout])
      if (typeof initLogout === 'function') initLogout();
    })();

    // Load publication name from site config
    apiFetch('/site-config').then(function (cfg) {
      var el = document.getElementById('nr-pub-name');
      if (!el) return;
      var name = cfg.short_name || cfg.name || '';
      if (name) {
        var emoji = cfg.logo_emoji ? cfg.logo_emoji + ' ' : '';
        el.textContent = emoji + name;
      }
    }).catch(function () { /* keep default */ });
  });

  // ── Keyboard shortcut: 1/2/3 to switch workspaces ──────────
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '1') switchWorkspace('floor');
    if (e.key === '2') switchWorkspace('wire');
    if (e.key === '3') switchWorkspace('desk');
    if (e.key === '4') switchWorkspace('reports');
    if (e.key === '5') switchWorkspace('custom');
    if (e.key === 'Escape') {
      document.querySelectorAll('section.nr-expanded').forEach(function(s) {
        s.classList.remove('nr-expanded');
        var btn = s.querySelector('.nr-expand-btn');
        if (btn) { btn.innerHTML = '⊞'; btn.title = 'Expand'; }
      });
    }
  });

  // Handle dynamic [data-ws][data-reports-tab] deep links (e.g. "AI Spend →" in Reports Overview)
  document.addEventListener('click', function (e) {
    var link = e.target.closest('[data-reports-tab][data-ws]');
    if (!link) return;
    var ws  = link.dataset.ws;
    var tab = link.dataset.reportsTab;
    if (link.tagName === 'A') e.preventDefault();
    if (ws) switchWorkspace(ws);
    if (tab) setTimeout(function () {
      if (window.NRReports && NRReports.switchTab) NRReports.switchTab(tab);
    }, ws === activeWs ? 0 : 160);
  });

  // Expose for inter-module communication
  window.NRApp = { switchWorkspace: switchWorkspace };
})();

// ── Shared undo toast ─────────────────────────────────────────────────────────
(function () {
  'use strict';

  var _timer    = null;
  var _commitFn = null;
  var _undoFn   = null;
  var DURATION  = 5000;

  function showUndoToast(message, onCommit, onUndo) {
    // If a previous toast is pending, commit it immediately before showing new one
    if (_timer) {
      clearTimeout(_timer);
      _timer = null;
      if (_commitFn) { _commitFn(); }
    }
    _commitFn = onCommit || null;
    _undoFn   = onUndo   || null;

    var toast = document.getElementById('nr-undo-toast');
    if (!toast) { if (onCommit) onCommit(); return; }

    var msgEl = toast.querySelector('.nr-undo-msg');
    if (msgEl) msgEl.textContent = message;

    // Reset + restart progress bar animation
    var bar = toast.querySelector('.nr-undo-bar');
    if (bar) { bar.style.transition = 'none'; bar.style.width = '100%'; }

    toast.classList.add('visible');

    if (bar) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          bar.style.transition = 'width ' + DURATION + 'ms linear';
          bar.style.width = '0%';
        });
      });
    }

    _timer = setTimeout(function () {
      _timer = null;
      _dismiss();
      if (_commitFn) { _commitFn(); _commitFn = null; }
    }, DURATION);
  }

  function _dismiss() {
    var toast = document.getElementById('nr-undo-toast');
    if (toast) toast.classList.remove('visible');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var undoBtn = document.getElementById('nr-undo-btn');
    if (undoBtn) {
      undoBtn.addEventListener('click', function () {
        if (_timer) { clearTimeout(_timer); _timer = null; }
        _dismiss();
        _commitFn = null;
        if (_undoFn) { _undoFn(); _undoFn = null; }
      });
    }
  });

  window.showUndoToast = showUndoToast;
})();

// ── Appearance management (skin + font) ────────────────────────────────────────
(function () {
  'use strict';
  var btn   = document.getElementById('nr-appear-btn');
  var panel = document.getElementById('nr-appear-panel');
  if (!btn || !panel) return;

  function getSaved(key, def) {
    try { return localStorage.getItem(key) || def; } catch(_) { return def; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, val); } catch(_) {}
  }

  function applySkin(skin) {
    document.documentElement.setAttribute('data-skin', skin);
    panel.querySelectorAll('.nr-skin-swatch').forEach(function(s) {
      s.classList.toggle('active', s.dataset.skin === skin);
    });
    save('nr_skin', skin);
    if (window.NRPrefs) NRPrefs.save('skin', skin);
  }
  function applyFont(font) {
    document.documentElement.setAttribute('data-font', font);
    panel.querySelectorAll('.nr-font-opt').forEach(function(f) {
      f.classList.toggle('active', f.dataset.font === font);
    });
    save('nr_font', font);
    if (window.NRPrefs) NRPrefs.save('font', font);
  }

  function openPanel() {
    panel.style.display = 'block';
    btn.setAttribute('aria-expanded', 'true');
  }
  function closePanel() {
    panel.style.display = 'none';
    btn.setAttribute('aria-expanded', 'false');
  }

  // Apply saved prefs
  applySkin(getSaved('nr_skin', 'ink'));
  applyFont(getSaved('nr_font', 'system'));

  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    panel.style.display === 'none' ? openPanel() : closePanel();
  });

  panel.addEventListener('click', function(e) { e.stopPropagation(); });

  panel.querySelectorAll('.nr-skin-swatch').forEach(function(s) {
    s.addEventListener('click', function() { applySkin(s.dataset.skin); });
  });
  panel.querySelectorAll('.nr-font-opt').forEach(function(f) {
    f.addEventListener('click', function() { applyFont(f.dataset.font); });
  });

  document.addEventListener('click', closePanel);

  window.NRAppearance = { applySkin: applySkin, applyFont: applyFont };
})();

// ── Expand / fullscreen for sections ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.nr-col-header').forEach(function (header) {
    var btn = document.createElement('button');
    btn.className = 'nr-expand-btn';
    btn.title = 'Expand';
    btn.innerHTML = '⊞';
    btn.type = 'button';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var section = header.closest('section');
      if (!section) return;
      var expanded = section.classList.toggle('nr-expanded');
      btn.innerHTML = expanded ? '⊡' : '⊞';
      btn.title = expanded ? 'Collapse (Esc)' : 'Expand';
    });
    var actions = header.querySelector('.nr-col-actions');
    if (actions) {
      actions.insertBefore(btn, actions.firstChild);
    } else {
      header.appendChild(btn);
    }
  });
});

// ── Custom workspace ───────────────────────────────────────────────────────────
window.NRCustom = (function () {
  'use strict';

  var PAGES = [
    { id: 'floor',         name: 'The Floor',      icon: '📋', desc: 'Budget, pitches & activity',  ws: 'floor' },
    { id: 'wire',          name: 'The Wire',        icon: '📡', desc: 'Feed, stories & discovery',   ws: 'wire' },
    { id: 'desk',          name: 'The Desk',        icon: '🗂',  desc: 'Writers, analytics & settings', ws: 'desk' },
    { id: 'intelligence',  name: 'Intelligence',    icon: '✦', desc: 'Story planning layer',         href: '/editorial-intelligence.html' },
    { id: 'budget',        name: 'Budget',          icon: '📅', desc: 'Daily news budget',            href: '/budget.html' },
    { id: 'pitches',       name: 'Pitches',         icon: '💡', desc: 'Story pitches queue',          href: '/pitches.html' },
    { id: 'articles',      name: 'Articles',        icon: '📰', desc: 'Article archive',              href: '/articles.html' },
    { id: 'editorial',     name: 'Editorial',       icon: '✏️',  desc: 'Editorial review queue',       href: '/editorial.html' },
    { id: 'feed-inbox',    name: 'Feed Inbox',      icon: '📥', desc: 'Incoming feed articles',       href: '/feed-inbox.html' },
    { id: 'writers',       name: 'Writers',         icon: '✍️',  desc: 'AI writer team',               href: '/writers.html' },
    { id: 'analytics',     name: 'Analytics',       icon: '📊', desc: 'Site & content analytics',     href: '/analytics.html' },
    { id: 'comments',      name: 'Comments',        icon: '💬', desc: 'Reader comments',              href: '/comments.html' },
    { id: 'newsletter',    name: 'Newsletter',      icon: '📧', desc: 'Email campaigns',              href: '/newsletter.html' },
    { id: 'sources',       name: 'Sources',         icon: '🛰️',  desc: 'RSS & feed sources',           href: '/sources.html' },
    { id: 'notifications', name: 'Notifications',   icon: '🔔', desc: 'Alert channels',              href: '/notifications.html' },
    { id: 'ai-usage',      name: 'AI Usage',        icon: '🤖', desc: 'Token & cost usage',           href: '/ai-usage.html' },
    { id: 'audit',         name: 'Audit Log',       icon: '🔍', desc: 'Activity & audit trail',       href: '/audit.html' },
    { id: 'settings',      name: 'Settings',        icon: '⚙️',  desc: 'Tenant configuration',         href: '/settings.html' },
    { id: 'banners',       name: 'Banners',         icon: '📢', desc: 'Site banners',                 href: '/banners.html' },
    { id: 'stories',       name: 'Story Board',     icon: '🗺️',  desc: 'Story threads',                href: '/story-board.html' },
  ];

  var pinned = [];

  function load() {
    try { pinned = JSON.parse(localStorage.getItem('nr_pinned') || '[]'); } catch(_) { pinned = []; }
    if (!Array.isArray(pinned)) pinned = [];
  }
  function persist() {
    try { localStorage.setItem('nr_pinned', JSON.stringify(pinned)); } catch(_) {}
    if (window.NRPrefs) NRPrefs.save('pinned', pinned);
  }
  function isPinned(id) { return pinned.indexOf(id) !== -1; }

  function togglePin(id) {
    var idx = pinned.indexOf(id);
    if (idx === -1) { pinned.push(id); } else { pinned.splice(idx, 1); }
    persist();
    render();
  }

  function makeTile(page) {
    var pinned_now = isPinned(page.id);
    var tile = document.createElement(page.href ? 'a' : 'button');
    tile.className = 'custom-tile' + (pinned_now ? ' pinned' : '');
    tile.type = page.href ? undefined : 'button';
    if (page.href) {
      tile.href = page.href;
    } else {
      tile.addEventListener('click', function () {
        if (window.NRApp) NRApp.switchWorkspace(page.ws);
      });
    }

    var pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'custom-pin-btn';
    pinBtn.title = pinned_now ? 'Unpin' : 'Pin';
    pinBtn.textContent = pinned_now ? '★' : '☆';
    pinBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      togglePin(page.id);
    });

    tile.innerHTML =
      '<span class="custom-tile-icon">' + page.icon + '</span>' +
      '<span class="custom-tile-name">' + page.name + '</span>' +
      '<span class="custom-tile-desc">' + page.desc + '</span>';
    tile.appendChild(pinBtn);
    return tile;
  }

  function render() {
    var pinnedEl = document.getElementById('nr-pinned-tiles');
    var allEl    = document.getElementById('nr-all-tiles');
    if (!pinnedEl || !allEl) return;

    pinnedEl.innerHTML = '';
    if (pinned.length === 0) {
      pinnedEl.innerHTML = '<div class="custom-empty-state">Pin pages below to create quick-launch shortcuts here.</div>';
    } else {
      pinned.forEach(function (id) {
        var page = PAGES.filter(function(p) { return p.id === id; })[0];
        if (page) pinnedEl.appendChild(makeTile(page));
      });
    }

    allEl.innerHTML = '';
    PAGES.forEach(function (page) {
      allEl.appendChild(makeTile(page));
    });
  }

  function init() {
    load();
    render();
  }

  return { init: init };
})();

// ── Keyboard shortcut cheatsheet ──────────────────────────────────────────────
(function () {
  'use strict';

  var backdrop = document.getElementById('nr-shortcuts-backdrop');
  var closeBtn = document.getElementById('nr-shortcuts-close');
  var openBtn  = document.getElementById('nr-shortcuts-btn');
  if (!backdrop) return;

  function open() {
    backdrop.style.display = 'flex';
    if (closeBtn) closeBtn.focus();
  }
  function close() {
    backdrop.style.display = 'none';
  }

  if (openBtn) openBtn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);

  // Dismiss on backdrop click
  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) close();
  });

  // ? key toggles, Escape closes
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') {
      backdrop.style.display === 'none' ? open() : close();
    }
    if (e.key === 'Escape' && backdrop.style.display !== 'none') {
      close();
      e.stopImmediatePropagation(); // prevent Escape from also collapsing sections
    }
  }, true); // capture phase so this fires before the section-collapse handler
})();

// ── User preferences sync (skin, font, pinned → backend) ──────────────────────
window.NRPrefs = (function () {
  'use strict';

  var _timer   = null;
  var _pending = {};

  function _flush() {
    var body = _pending;
    _pending = {};
    if (!Object.keys(body).length) return;
    if (typeof apiFetch !== 'function') return;
    apiFetch('/newsroom-prefs', { method: 'PUT', body: JSON.stringify(body) }).catch(function () {});
  }

  // Queue a single-key save; debounced so rapid changes coalesce into one request
  function save(key, value) {
    _pending[key] = value;
    clearTimeout(_timer);
    _timer = setTimeout(_flush, 600);
  }

  // Load from API and apply (cross-device sync on login)
  function init() {
    if (typeof apiFetch !== 'function') return;
    apiFetch('/newsroom-prefs').then(function (prefs) {
      if (!prefs) return;
      if (prefs.skin && window.NRAppearance) NRAppearance.applySkin(prefs.skin);
      if (prefs.font && window.NRAppearance) NRAppearance.applyFont(prefs.font);
      if (Array.isArray(prefs.pinned)) {
        try { localStorage.setItem('nr_pinned', JSON.stringify(prefs.pinned)); } catch (_) {}
        if (window.NRCustom) NRCustom.init();
      }
    }).catch(function () {});
  }

  return { init: init, save: save };
})();

// ── Hash-based URL routing ─────────────────────────────────────────────────────
(function () {
  'use strict';

  function pushHash(ws, tab) {
    try { history.replaceState(null, '', '#' + ws + (tab ? '/' + tab : '')); } catch (_) {}
  }

  function getActiveInnerTab(ws) {
    if (ws === 'desk') {
      var b = document.querySelector('#nr-desk-tabs .desk-inner-tab.active');
      return b ? b.dataset.tab : null;
    }
    if (ws === 'wire') {
      var b = document.querySelector('#nr-wire-tab-bar [data-wire-tab].active');
      return b ? b.dataset.wireTab : null;
    }
    return null;
  }

  function applyHash(hash) {
    var clean = (hash || '').replace(/^#/, '');
    if (!clean) return;
    var parts = clean.split('/');
    var ws = parts[0]; var tab = parts[1] || null;
    if (!ws || !window.NRApp) return;
    NRApp.switchWorkspace(ws);
    if (tab) {
      setTimeout(function () {
        var btn = document.querySelector('[data-tab="' + tab + '"]') ||
                  document.querySelector('[data-wire-tab="' + tab + '"]');
        if (btn) btn.click();
      }, 150);
    }
  }

  // Intercept clicks to keep hash in sync
  document.addEventListener('click', function (e) {
    var wsBtn = e.target.closest('[data-ws]');
    if (wsBtn) { setTimeout(function () { pushHash(wsBtn.dataset.ws, getActiveInnerTab(wsBtn.dataset.ws)); }, 20); return; }

    var deskBtn = e.target.closest('#nr-desk-tabs [data-tab]');
    if (deskBtn) { setTimeout(function () { pushHash('desk', deskBtn.dataset.tab); }, 20); return; }

    var wireBtn = e.target.closest('#nr-wire-tab-bar [data-wire-tab]');
    if (wireBtn) { setTimeout(function () { pushHash('wire', wireBtn.dataset.wireTab); }, 20); return; }
  }, true);

  // Back / forward
  window.addEventListener('hashchange', function () { applyHash(location.hash); });

  // Initial load — wait for workspaces to init, then route
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      if (location.hash && location.hash !== '#' && location.hash !== '#floor') {
        applyHash(location.hash);
      }
    }, 300);
  });
})();
