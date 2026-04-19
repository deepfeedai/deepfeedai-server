/**
 * Command Palette — ⌘K / Ctrl+K fuzzy launcher.
 *
 * Sources (merged and ranked):
 *   - Pages          — static from window.NAV_GROUPS
 *   - Recent pages   — NavKit visit telemetry
 *   - Articles       — live /api/articles?search=
 *   - Writers        — live /api/writers (filtered client-side)
 *
 * Ranking: exact match > prefix > subsequence; each base score boosted by
 *   log(1 + visits) from NavKit telemetry for pages. Live results are shown
 *   after a 180ms debounce while typing.
 *
 * Keyboard: ↑/↓ navigate, Enter opens, Esc closes, ⌘↵ opens in new tab.
 *
 * This module self-registers with NavKit once available. Downstream pages
 * don't need to know about it.
 */
(function () {
  'use strict';

  function ready(cb) {
    if (window.NavKit && window.NAV_GROUPS) return cb();
    setTimeout(function () { ready(cb); }, 50);
  }

  ready(function init() {
    var NK = window.NavKit;
    var esc = NK.esc;
    var el  = NK.el;

    var DEBOUNCE_MS = 180;
    var MAX_RESULTS = 40;

    var overlay = null;
    var input   = null;
    var list    = null;
    var results = [];
    var selected = 0;
    var searchToken = 0;
    var debounceTimer = null;

    // ── Page catalog (from NAV_GROUPS) ─────────────────────
    function pageItems() {
      var out = [];
      (window.NAV_GROUPS || []).forEach(function (g) {
        g.items.forEach(function (item) {
          out.push({
            kind: 'page',
            label: item.label,
            group: g.label,
            href: item.href,
            icon: item.icon,
          });
        });
      });
      // Settings (footer) — also a page
      out.push({ kind: 'page', label: 'Settings', group: 'Admin', href: '/settings.html', icon: '' });
      return out;
    }

    // ── Fuzzy ranker ──────────────────────────────────────
    // Returns null if no match, otherwise a score (higher = better).
    function rank(label, query) {
      if (!query) return 0;
      var L = label.toLowerCase();
      var Q = query.toLowerCase();
      if (L === Q) return 1000;
      if (L.startsWith(Q)) return 500 - (L.length - Q.length);
      var idx = L.indexOf(Q);
      if (idx >= 0) return 300 - idx;
      // Subsequence match
      var li = 0;
      for (var qi = 0; qi < Q.length; qi++) {
        var c = Q.charAt(qi);
        var found = -1;
        for (; li < L.length; li++) {
          if (L.charAt(li) === c) { found = li; li++; break; }
        }
        if (found < 0) return null;
      }
      return 100 - Q.length;
    }

    function hitBoost(path) {
      var hits = NK.getHits();
      var n = hits[path] || 0;
      return Math.log(1 + n) * 10;
    }

    // ── Rendering ─────────────────────────────────────────
    function renderResults() {
      if (!list) return;
      list.innerHTML = '';
      if (!results.length) {
        var empty = el('div', { class: 'cp-empty' }, ['No matches. Keep typing…']);
        list.appendChild(empty);
        return;
      }
      results.forEach(function (r, i) {
        var icon = r.icon || (r.kind === 'article' ? '📄' : r.kind === 'writer' ? '👤' : r.kind === 'recent' ? '⏱' : '→');
        var row = el('div', {
          class: 'cp-row' + (i === selected ? ' selected' : ''),
          dataset: { index: String(i) },
          onclick: function () { selected = i; activate(); },
          onmousemove: function () { if (selected !== i) { selected = i; highlightSelected(); } },
        });
        row.innerHTML = ''
          + '<span class="cp-row-icon">' + (r.icon ? r.icon : esc(icon)) + '</span>'
          + '<span class="cp-row-label">' + esc(r.label) + '</span>'
          + '<span class="cp-row-meta">' + esc(r.group || r.kind) + '</span>';
        list.appendChild(row);
      });
      scrollSelectedIntoView();
    }

    function highlightSelected() {
      if (!list) return;
      var rows = list.querySelectorAll('.cp-row');
      for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('selected', i === selected);
      scrollSelectedIntoView();
    }

    function scrollSelectedIntoView() {
      if (!list) return;
      var row = list.querySelector('.cp-row.selected');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }

    // ── Search ────────────────────────────────────────────
    function computeResults(query) {
      var q = (query || '').trim();
      var items = pageItems();

      // Recent: always include at top when query is empty or matches
      var recents = NK.getRecent().map(function (r) {
        return { kind: 'recent', label: r.label, group: 'Recent', href: r.path, icon: '⏱' };
      });

      var all = recents.concat(items);

      // Dedupe by href (recent takes precedence so pages don't re-appear)
      var seen = {};
      var merged = [];
      all.forEach(function (it) {
        if (it.href && seen[it.href]) return;
        if (it.href) seen[it.href] = true;
        merged.push(it);
      });

      if (!q) return merged.slice(0, MAX_RESULTS);

      var scored = [];
      merged.forEach(function (it) {
        var s = rank(it.label, q);
        if (s == null) return;
        if (it.href) s += hitBoost(it.href);
        scored.push({ it: it, s: s });
      });
      scored.sort(function (a, b) { return b.s - a.s; });
      return scored.map(function (x) { return x.it; }).slice(0, MAX_RESULTS);
    }

    async function fetchLive(query, token) {
      if (!query || query.length < 2) return [];
      var results = [];
      try {
        var data = await apiFetch('/articles?search=' + encodeURIComponent(query) + '&limit=6');
        if (token !== searchToken) return [];
        var articles = Array.isArray(data) ? data : (data.articles || []);
        articles.forEach(function (a) {
          results.push({
            kind: 'article',
            label: a.title || '(untitled)',
            group: [a.category, a.content_type].filter(Boolean).join(' · ') || 'Article',
            href: '/article-editor.html?id=' + a.id,
            icon: '📄',
          });
        });
      } catch (_) { /* swallow — offline or 403 */ }
      try {
        var writers = await apiFetch('/writers');
        if (token !== searchToken) return results;
        var ql = query.toLowerCase();
        (Array.isArray(writers) ? writers : []).forEach(function (w) {
          if (!w.name || w.name.toLowerCase().indexOf(ql) < 0) return;
          results.push({
            kind: 'writer',
            label: w.name,
            group: (w.beats || []).join(', ') || 'Writer',
            href: '/writers.html?slug=' + (w.slug || ''),
            icon: '👤',
          });
        });
      } catch (_) {}
      return results;
    }

    function refresh() {
      var q = input.value;
      selected = 0;
      results = computeResults(q);
      renderResults();

      clearTimeout(debounceTimer);
      if (!q || q.length < 2) return;
      var myToken = ++searchToken;
      debounceTimer = setTimeout(async function () {
        var live = await fetchLive(q, myToken);
        if (myToken !== searchToken) return;
        // Merge: put live results after static ones, dedupe by href
        var seen = {};
        results.forEach(function (r) { if (r.href) seen[r.href] = true; });
        live.forEach(function (r) { if (!r.href || !seen[r.href]) { seen[r.href] = true; results.push(r); } });
        results = results.slice(0, MAX_RESULTS);
        renderResults();
      }, DEBOUNCE_MS);
    }

    function activate(newTab) {
      var r = results[selected];
      if (!r || !r.href) return;
      close();
      if (newTab) window.open(r.href, '_blank');
      else window.location.href = r.href;
    }

    // ── Overlay lifecycle ─────────────────────────────────
    function ensureOverlay() {
      if (overlay) return;
      overlay = el('div', { id: 'cpOverlay', class: 'cp-overlay', onclick: function (e) { if (e.target === overlay) close(); } });
      var panel = el('div', { class: 'cp-panel', role: 'dialog', 'aria-label': 'Command palette' });
      var hint  = el('div', { class: 'cp-hint' }, ['↑↓ navigate · ↵ open · ' + (NK.isMac ? '⌘↵' : 'Ctrl+↵') + ' new tab · Esc close']);
      input = el('input', {
        class: 'cp-input',
        type: 'text',
        placeholder: 'Jump to page, article, writer…',
        autocomplete: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      });
      list = el('div', { class: 'cp-list' });

      input.addEventListener('input', refresh);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); selected = Math.min(results.length - 1, selected + 1); highlightSelected(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); selected = Math.max(0, selected - 1); highlightSelected(); }
        else if (ev.key === 'Enter') { ev.preventDefault(); activate(ev.metaKey || ev.ctrlKey); }
        else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      });

      panel.appendChild(input);
      panel.appendChild(list);
      panel.appendChild(hint);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    }

    function open() {
      ensureOverlay();
      overlay.style.display = 'flex';
      input.value = '';
      refresh();
      setTimeout(function () { input.focus(); }, 10);
    }

    function close() {
      if (overlay) overlay.style.display = 'none';
    }

    // ── Styles ────────────────────────────────────────────
    (function styles() {
      if (document.getElementById('cpStyles')) return;
      var s = document.createElement('style');
      s.id = 'cpStyles';
      s.textContent = [
        '.cp-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.55); display:none; align-items:flex-start; justify-content:center; padding-top:12vh; z-index:10000; }',
        '.cp-panel { background:var(--bg-card, #1a1a1a); color:var(--text, #fff); border:1px solid var(--border, #333); border-radius:12px; width:min(640px, 92vw); max-height:70vh; overflow:hidden; box-shadow:0 16px 48px rgba(0,0,0,0.5); display:flex; flex-direction:column; }',
        '.cp-input { border:0; outline:0; background:transparent; color:inherit; font-size:16px; padding:16px 20px; border-bottom:1px solid var(--border, #333); }',
        '.cp-list { overflow-y:auto; max-height:50vh; }',
        '.cp-row { display:grid; grid-template-columns:32px 1fr auto; align-items:center; gap:10px; padding:10px 16px; cursor:pointer; font-size:13px; border-left:2px solid transparent; }',
        '.cp-row.selected { background:var(--surface2, #222); border-left-color:var(--primary, #7c3aed); }',
        '.cp-row-icon { width:24px; text-align:center; opacity:0.9; }',
        '.cp-row-icon svg { width:18px; height:18px; }',
        '.cp-row-label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.cp-row-meta { font-size:11px; color:var(--muted, #888); white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis; }',
        '.cp-empty { padding:20px; text-align:center; color:var(--muted, #888); font-size:13px; }',
        '.cp-hint { padding:8px 16px; border-top:1px solid var(--border, #333); font-size:11px; color:var(--muted, #888); text-align:center; }',
      ].join('\n');
      document.head.appendChild(s);
    })();

    // ── Register hotkey ────────────────────────────────────
    NK.register('mod+k', open, 'Open command palette');
    NK.register('/', function (ev) { open(); }, 'Open command palette (alt hotkey)');

    // Public API (in case a page wants to open it explicitly)
    window.CommandPalette = { open: open, close: close };
  });
})();
