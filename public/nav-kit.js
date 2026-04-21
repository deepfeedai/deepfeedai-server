/**
 * Deep Feed AI Admin — Navigation Kit
 *
 * Loaded once from admin.js on every admin page. Ships the shared foundations
 * for the navigation roadmap:
 *
 *   1. Keybindings — central registry for app-wide keyboard shortcuts with
 *      input-focus guard, chord support (e.g. "g a"), and a "?" cheatsheet
 *      overlay that lists everything currently registered.
 *   2. Telemetry — lightweight localStorage-backed tracker for page visits,
 *      used to rank recents in the sidebar and the command palette. No
 *      server round-trip.
 *   3. DOM helpers — a shared esc() / el() used by the palette and other
 *      nav components so each new module isn't a copy/paste.
 *
 * Downstream modules (command-palette, recent-pinned, breadcrumbs) consume
 * window.NavKit rather than re-implementing any of this.
 */
(function () {
  'use strict';

  // ── DOM helpers ────────────────────────────────────────────
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class' || k === 'className') node.className = attrs[k];
        else if (k === 'dataset') for (var d in attrs[k]) node.dataset[d] = attrs[k][d];
        else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(node.style, attrs[k]);
        else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // ── Keybindings ────────────────────────────────────────────
  // Registry entries: { keys: 'g a' | '?' | 'mod+k', fn, description, scope }
  // - "mod" means Cmd on Mac, Ctrl elsewhere.
  // - Multi-key entries ("g a") are chords: press keys in sequence within 1.2s.
  // - Shortcuts don't fire while focus is in an <input>/<textarea>/contentEditable.
  var bindings = [];
  var chordBuffer = '';
  var chordTimer = null;

  var isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  function modKey(ev) { return isMac ? ev.metaKey : ev.ctrlKey; }

  function inEditable(target) {
    if (!target) return false;
    var tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function normaliseEvent(ev) {
    // Build a token like "mod+k", "shift+?", "g", "?".
    // Chord-mode uses plain character tokens; single-press uses modifiers.
    var parts = [];
    if (modKey(ev)) parts.push('mod');
    if (ev.shiftKey && ev.key.length > 1) parts.push('shift');
    // ev.key is the character; for printable keys this is already lowercase-able.
    var key = ev.key;
    if (key === ' ') key = 'space';
    else if (key.length === 1) key = key.toLowerCase();
    parts.push(key);
    return parts.join('+');
  }

  function register(keys, fn, description, scope) {
    bindings.push({ keys: keys, fn: fn, description: description || '', scope: scope || 'global' });
  }

  function unregister(keys) {
    bindings = bindings.filter(function (b) { return b.keys !== keys; });
  }

  function list() { return bindings.slice(); }

  function onKeyDown(ev) {
    if (inEditable(ev.target)) return;

    var token = normaliseEvent(ev);

    // First: try direct matches (includes "mod+k", "?", etc.)
    for (var i = 0; i < bindings.length; i++) {
      if (bindings[i].keys === token) {
        ev.preventDefault();
        bindings[i].fn(ev);
        resetChord();
        return;
      }
    }

    // Chord logic: single printable key with no modifiers extends the buffer.
    // If the buffer + key matches a registered chord like "g a", fire it.
    if (!modKey(ev) && !ev.altKey && ev.key.length === 1) {
      var next = chordBuffer ? (chordBuffer + ' ' + ev.key.toLowerCase()) : ev.key.toLowerCase();
      for (var j = 0; j < bindings.length; j++) {
        if (bindings[j].keys === next) {
          ev.preventDefault();
          bindings[j].fn(ev);
          resetChord();
          return;
        }
      }
      // Does any binding start with the buffer-extended prefix? If so, keep the buffer alive.
      var isPrefix = bindings.some(function (b) {
        return b.keys.split(' ')[0] === next || b.keys.indexOf(next + ' ') === 0;
      });
      if (isPrefix) {
        chordBuffer = next;
        clearTimeout(chordTimer);
        chordTimer = setTimeout(resetChord, 1200);
      } else {
        resetChord();
      }
    }
  }

  function resetChord() {
    chordBuffer = '';
    clearTimeout(chordTimer);
    chordTimer = null;
  }

  // ── Cheatsheet overlay (bound to "?") ─────────────────────
  function openCheatsheet() {
    var existing = document.getElementById('navKitCheatsheet');
    if (existing) { existing.remove(); return; }

    var rows = bindings
      .filter(function (b) { return b.description; })
      .sort(function (a, b) { return a.keys.localeCompare(b.keys); })
      .map(function (b) {
        var keys = b.keys
          .replace(/mod\+/g, isMac ? '⌘' : 'Ctrl+')
          .replace(/shift\+/g, '⇧')
          .split(' ')
          .map(function (p) { return '<kbd>' + esc(p) + '</kbd>'; })
          .join(' <span class="nav-kit-sep">then</span> ');
        return '<tr><td class="nav-kit-keys">' + keys + '</td><td>' + esc(b.description) + '</td></tr>';
      }).join('');

    var overlay = el('div', { id: 'navKitCheatsheet', class: 'nav-kit-overlay', onclick: function (e) { if (e.target === overlay) overlay.remove(); } });
    overlay.innerHTML = ''
      + '<div class="nav-kit-sheet" role="dialog" aria-label="Keyboard shortcuts">'
      +   '<div class="nav-kit-sheet-header">'
      +     '<h3>Keyboard shortcuts</h3>'
      +     '<button class="nav-kit-close" aria-label="Close">✕</button>'
      +   '</div>'
      +   '<table class="nav-kit-table">'
      +     '<thead><tr><th>Keys</th><th>Action</th></tr></thead>'
      +     '<tbody>' + (rows || '<tr><td colspan="2" style="opacity:.6">No shortcuts registered yet.</td></tr>') + '</tbody>'
      +   '</table>'
      + '</div>';
    overlay.querySelector('.nav-kit-close').addEventListener('click', function () { overlay.remove(); });
    document.body.appendChild(overlay);

    // Close on Escape
    var escListener = function (ev) {
      if (ev.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escListener); }
    };
    document.addEventListener('keydown', escListener);
  }

  // ── Telemetry ──────────────────────────────────────────────
  // Tracks page visits in localStorage so the command palette and sidebar
  // recent section can rank. Keep the payload tiny; cap the history so
  // storage doesn't bloat.
  var TELEMETRY_KEY = 'navKit.telemetry.v1';
  var MAX_RECENT = 15;
  var MAX_HITS_PER_PATH = 1000;

  function readTelemetry() {
    try {
      var raw = localStorage.getItem(TELEMETRY_KEY);
      if (!raw) return { hits: {}, recent: [] };
      var parsed = JSON.parse(raw);
      return {
        hits: parsed.hits && typeof parsed.hits === 'object' ? parsed.hits : {},
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      };
    } catch (_) {
      return { hits: {}, recent: [] };
    }
  }

  function writeTelemetry(data) {
    try { localStorage.setItem(TELEMETRY_KEY, JSON.stringify(data)); } catch (_) {}
  }

  function trackVisit(path, label) {
    if (!path) return;
    var data = readTelemetry();
    data.hits[path] = Math.min((data.hits[path] || 0) + 1, MAX_HITS_PER_PATH);
    data.recent = [{ path: path, label: label || path, at: Date.now() }]
      .concat(data.recent.filter(function (r) { return r.path !== path; }))
      .slice(0, MAX_RECENT);
    writeTelemetry(data);
  }

  function getHits() { return readTelemetry().hits; }
  function getRecent() { return readTelemetry().recent; }
  function clearTelemetry() { writeTelemetry({ hits: {}, recent: [] }); }

  // ── Boot ───────────────────────────────────────────────────
  function init() {
    document.addEventListener('keydown', onKeyDown, true);
    register('shift+?', openCheatsheet, 'Show keyboard shortcuts');
    injectStyles();
  }

  function injectStyles() {
    if (document.getElementById('navKitStyles')) return;
    var style = document.createElement('style');
    style.id = 'navKitStyles';
    style.textContent = [
      '.nav-kit-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.55); display:flex; align-items:center; justify-content:center; z-index:10000; }',
      '.nav-kit-sheet { background:var(--bg-card, #1a1a1a); color:var(--text, #fff); border:1px solid var(--border, #333); border-radius:12px; width:min(560px, 92vw); max-height:80vh; overflow:auto; box-shadow:0 16px 48px rgba(0,0,0,0.5); }',
      '.nav-kit-sheet-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--border, #333); }',
      '.nav-kit-sheet-header h3 { margin:0; font-size:15px; font-weight:600; }',
      '.nav-kit-close { background:none; border:0; color:var(--muted, #888); font-size:16px; cursor:pointer; padding:4px 8px; border-radius:6px; }',
      '.nav-kit-close:hover { color:var(--text, #fff); background:var(--surface2, #222); }',
      '.nav-kit-table { width:100%; border-collapse:collapse; font-size:13px; }',
      '.nav-kit-table th { text-align:left; padding:10px 20px; font-weight:500; color:var(--muted, #888); border-bottom:1px solid var(--border, #333); }',
      '.nav-kit-table td { padding:8px 20px; border-bottom:1px solid var(--surface2, #1f1f1f); }',
      '.nav-kit-keys { white-space:nowrap; }',
      '.nav-kit-keys kbd { display:inline-block; padding:2px 7px; font-family:ui-monospace,monospace; font-size:11px; background:var(--surface2, #222); border:1px solid var(--border, #333); border-radius:4px; color:var(--text, #fff); margin-right:2px; }',
      '.nav-kit-sep { font-size:11px; color:var(--muted, #888); margin:0 4px; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  // Expose the public API
  window.NavKit = {
    register: register,
    unregister: unregister,
    list: list,
    trackVisit: trackVisit,
    getHits: getHits,
    getRecent: getRecent,
    clearTelemetry: clearTelemetry,
    esc: esc,
    el: el,
    openCheatsheet: openCheatsheet,
    isMac: isMac,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
