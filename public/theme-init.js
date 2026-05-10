/**
 * Global theme initializer — applies the user's chosen skin/font across the
 * entire admin and injects an Appearance picker into the topbar. Mirrors
 * the Newsroom appearance system (preferences live in newsroom_prefs and
 * are exposed via /api/newsroom-prefs).
 *
 * Loaded synchronously in <head> on every admin page so the data-skin /
 * data-font attributes are set before first paint (no FOUC).
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'deepfeedai_token';
  var SKIN_KEY  = 'nr_skin';
  var FONT_KEY  = 'nr_font';

  // ── PHASE 1: Synchronous apply from localStorage (FOUC prevention) ──
  try {
    var s = localStorage.getItem(SKIN_KEY);
    var f = localStorage.getItem(FONT_KEY);
    if (s) document.documentElement.setAttribute('data-skin', s);
    if (f) document.documentElement.setAttribute('data-font', f);
  } catch (_) { /* localStorage unavailable — skip */ }

  // ── PHASE 2: After DOM ready, sync from server + inject picker ──
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  ready(function () {
    syncFromServer();
    injectPicker();
  });

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
  }

  function applySkin(skin) {
    if (!skin) return;
    document.documentElement.setAttribute('data-skin', skin);
    try { localStorage.setItem(SKIN_KEY, skin); } catch (_) {}
    markActive('skin', skin);
  }
  function applyFont(font) {
    if (!font) return;
    document.documentElement.setAttribute('data-font', font);
    try { localStorage.setItem(FONT_KEY, font); } catch (_) {}
    markActive('font', font);
  }

  function syncFromServer() {
    var token = getToken();
    if (!token) return; // unauth pages (login, signup) — skip silently
    fetch('/api/newsroom-prefs', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        if (data.skin) applySkin(data.skin);
        if (data.font) applyFont(data.font);
      })
      .catch(function () { /* offline / network — keep localStorage value */ });
  }

  function savePrefs(prefs) {
    var token = getToken();
    if (!token) return;
    fetch('/api/newsroom-prefs', {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(prefs),
    }).catch(function () { /* keep localStorage as source of truth */ });
  }

  // ── Picker injection ──────────────────────────────────────────────────
  var SKINS = [
    { id: 'ink',        label: 'Ink' },
    { id: 'daylight',   label: 'Daylight' },
    { id: 'wire',       label: 'Wire' },
    { id: 'broadsheet', label: 'Broadsheet' },
    { id: 'tabloid',    label: 'Tabloid' },
  ];
  var FONTS = [
    { id: 'system',    label: 'System' },
    { id: 'newsprint', label: 'Newsprint' },
    { id: 'modern',    label: 'Modern' },
    { id: 'terminal',  label: 'Terminal' },
    { id: 'classic',   label: 'Classic' },
  ];

  function injectPicker() {
    // Skip on the Newsroom page — it has its own appearance panel (nr-appear-*).
    if (document.querySelector('.nr-appear-panel, #nr-appear-btn')) return;

    var topbar = document.querySelector('.topbar, .settings-topbar');
    if (!topbar) return;
    if (topbar.querySelector('.theme-picker-btn')) return;

    var btn = document.createElement('button');
    btn.className = 'theme-picker-btn';
    btn.title = 'Appearance';
    btn.setAttribute('aria-label', 'Appearance');
    btn.textContent = '🎨';

    var panel = document.createElement('div');
    panel.className = 'theme-picker-panel';
    panel.style.display = 'none';
    panel.innerHTML =
        '<div class="theme-picker-section-label">Skin</div>'
      + '<div class="theme-picker-row">'
      + SKINS.map(function (s) {
          return '<button class="theme-picker-skin" data-skin="' + s.id + '" title="' + s.label + '" aria-label="' + s.label + ' skin"></button>';
        }).join('')
      + '</div>'
      + '<div class="theme-picker-section-label">Font</div>'
      + '<div class="theme-picker-row theme-picker-fonts">'
      + FONTS.map(function (f) {
          return '<button class="theme-picker-font" data-font="' + f.id + '">' + f.label + '</button>';
        }).join('')
      + '</div>';

    var anchor = topbar.querySelector('.topbar-user, #topbarUser, .settings-topbar-user');
    if (anchor) topbar.insertBefore(btn, anchor);
    else topbar.appendChild(btn);
    document.body.appendChild(panel);

    markActive('skin', document.documentElement.getAttribute('data-skin'));
    markActive('font', document.documentElement.getAttribute('data-font'));

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel.style.display === 'none') {
        var rect = btn.getBoundingClientRect();
        panel.style.top = (rect.bottom + 6) + 'px';
        panel.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
        panel.style.display = 'block';
      } else {
        panel.style.display = 'none';
      }
    });

    document.addEventListener('click', function (e) {
      if (panel.style.display === 'none') return;
      if (!panel.contains(e.target) && e.target !== btn) panel.style.display = 'none';
    });

    panel.addEventListener('click', function (e) {
      var skinEl = e.target.closest && e.target.closest('[data-skin]');
      if (skinEl) {
        var skin = skinEl.getAttribute('data-skin');
        applySkin(skin);
        savePrefs({ skin: skin });
        return;
      }
      var fontEl = e.target.closest && e.target.closest('[data-font]');
      if (fontEl) {
        var font = fontEl.getAttribute('data-font');
        applyFont(font);
        savePrefs({ font: font });
      }
    });
  }

  function markActive(kind, value) {
    var sel = '.theme-picker-' + kind;
    var nodes = document.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.getAttribute('data-' + kind) === value) n.classList.add('is-active');
      else n.classList.remove('is-active');
    }
  }
})();
