/**
 * Onboarding Hints
 *
 * First-run tooltips for the new nav primitives. Each hint shows once per
 * user (localStorage flag), dismisses on any interaction, and never nags
 * again.
 *
 * Current hints:
 *   - palette: pointer to the sidebar logo / topbar with "Press ⌘K to
 *              jump anywhere" — shown after ~1.5s on first admin load.
 *   - shortcuts: "Press ? for all shortcuts" — shown alongside palette
 *                hint if the user has 0 registered keys so far.
 */
(function () {
  'use strict';

  function hintKey(id) { return window.WorkflowNav.scopedKey('hint.'+id); }

  function seen(id) { try { return localStorage.getItem(hintKey(id)) === '1'; } catch (_) { return true; } }
  function mark(id) { try { localStorage.setItem(hintKey(id), '1'); } catch (_) {} }

  function ready(cb) {
    if (document.body && window.NavKit) return cb();
    setTimeout(function () { ready(cb); }, 50);
  }

  ready(function init() {
    // Don't nag on auth / setup pages
    if (!document.querySelector('.admin-layout')) return;
    if (seen('palette')) return;

    var NK = window.NavKit;
    var modLabel = NK.isMac ? '⌘' : 'Ctrl+';

    setTimeout(function () { showPaletteHint(modLabel); }, 1500);

    function showPaletteHint(modLabel) {
      if (seen('palette')) return;
      var tip = document.createElement('div');
      tip.className = 'onb-hint';
      tip.innerHTML = ''
        + '<div class="onb-hint-title">Press <kbd>' + modLabel + 'K</kbd> to jump anywhere</div>'
        + '<div class="onb-hint-sub">Pages, articles, writers — all from one palette.</div>'
        + '<div class="onb-hint-sub">Press <kbd>?</kbd> to see every shortcut.</div>'
        + '<button class="onb-hint-dismiss" aria-label="Dismiss">Got it</button>';
      document.body.appendChild(tip);

      var dismiss = function () {
        mark('palette');
        tip.classList.remove('in');
        setTimeout(function () { if (tip.parentNode) tip.remove(); }, 220);
        removeListeners();
      };
      var removeListeners = function () {
        document.removeEventListener('keydown', onKey, true);
      };
      var onKey = function (ev) {
        if ((ev.key === 'k' || ev.key === 'K') && (ev.metaKey || ev.ctrlKey)) dismiss();
        if (ev.key === '?') dismiss();
      };
      tip.querySelector('.onb-hint-dismiss').addEventListener('click', dismiss);
      document.addEventListener('keydown', onKey, true);

      // Auto-dismiss after 15s if ignored
      setTimeout(function () { if (!seen('palette')) dismiss(); }, 15000);

      requestAnimationFrame(function () { tip.classList.add('in'); });
    }

    // ── Styles ────────────────────────────────────────────
    (function styles() {
      if (document.getElementById('onbStyles')) return;
      var s = document.createElement('style');
      s.id = 'onbStyles';
      s.textContent = [
        '.onb-hint { position:fixed; bottom:24px; left:24px; background:var(--bg-card, #1a1a1a); color:var(--text, #fff); border:1px solid var(--border, #333); border-radius:10px; padding:14px 16px; max-width:280px; z-index:9998; box-shadow:0 8px 32px rgba(0,0,0,0.4); opacity:0; transform:translateY(8px); transition:opacity 0.2s, transform 0.2s; font-size:13px; }',
        '.onb-hint.in { opacity:1; transform:translateY(0); }',
        '.onb-hint-title { font-weight:600; margin-bottom:4px; font-size:13px; }',
        '.onb-hint-sub { color:var(--muted, #888); font-size:12px; margin-bottom:3px; }',
        '.onb-hint kbd { display:inline-block; padding:1px 6px; font-family:ui-monospace,monospace; font-size:11px; background:var(--surface2, #222); border:1px solid var(--border, #333); border-radius:4px; }',
        '.onb-hint-dismiss { margin-top:8px; background:var(--primary, #7c3aed); color:#fff; border:0; padding:6px 12px; border-radius:6px; font-size:12px; cursor:pointer; }',
        '.onb-hint-dismiss:hover { opacity:0.9; }',
        '@media (max-width: 768px) { .onb-hint { bottom:80px; left:12px; right:12px; max-width:none; } }',
      ].join('\n');
      document.head.appendChild(s);
    })();
  });
})();
