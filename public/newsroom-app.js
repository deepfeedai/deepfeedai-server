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
    floor: { el: null, initialized: false, init: function() { if (window.NRFloor) NRFloor.init(); } },
    wire:  { el: null, initialized: false, init: function() { if (window.NRWire)  NRWire.init();  } },
    desk:  { el: null, initialized: false, init: function() { if (window.NRDesk)  NRDesk.init();  } },
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
    workspaces.floor.el = document.getElementById('ws-floor');
    workspaces.wire.el  = document.getElementById('ws-wire');
    workspaces.desk.el  = document.getElementById('ws-desk');

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
  });

  // Expose for inter-module communication
  window.NRApp = { switchWorkspace: switchWorkspace };
})();
