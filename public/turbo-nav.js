/**
 * Turbo Nav — partial-page navigation for same-origin admin links.
 *
 * Instead of a full browser navigation, intercept the click, fetch() the
 * target HTML, swap .main-content, run new scripts, push history.
 * Sidebar, bell, palette, and other outer chrome stay mounted — no flicker,
 * sidebar scroll preserved.
 *
 * Opt-in model (two gates — BOTH must be true for turbo to engage):
 *
 *   1. User enabled it — localStorage.navKit.turbo === "on".
 *      Toggle via NavKit.openCheatsheet footer (Phase 2b) or the console:
 *        localStorage.setItem('navKit.turbo', 'on')
 *
 *   2. Both source + target pages declare they're turbo-safe:
 *        <meta name="turbo-ok" content="1">
 *      Pages without this meta stay on full-page navigation. This is a
 *      per-page migration switch — page-specific JS has to be idempotent
 *      and listen for the `turbonav:loaded` event to re-init.
 *
 * Safety:
 *   - `?turbo=0` query param on any URL force-disables for that session.
 *   - Modifier-clicks, external links, downloads, forms bypass turbo.
 *   - Any error during swap falls back to a full navigation.
 *
 * Per-page migration checklist:
 *   1. Add <meta name="turbo-ok" content="1"> to <head>.
 *   2. Wrap your page init in a function (e.g. renderPage).
 *   3. Call it both on DOMContentLoaded AND turbonav:loaded.
 *   4. Clean up intervals/listeners in a `turbonav:unload` listener.
 */
(function () {
  'use strict';

  function ready(cb) {
    if (window.NavKit) return cb();
    setTimeout(function () { ready(cb); }, 50);
  }

  ready(function init() {
    var NK = window.NavKit;

    // ── Guard: respect kill switches ──────────────────────
    var urlParams = new URLSearchParams(location.search);
    if (urlParams.get('turbo') === '0') {
      sessionStorage.setItem('navKit.turboDisabled', '1');
    }
    function turboEnabled() {
      if (sessionStorage.getItem('navKit.turboDisabled') === '1') return false;
      return localStorage.getItem('navKit.turbo') === 'on';
    }

    function turboOkMeta(doc) {
      var m = (doc || document).querySelector('meta[name="turbo-ok"]');
      return m && m.getAttribute('content') === '1';
    }

    // ── Progress bar + skeleton ──────────────────────────
    var bar = null;
    var skeletonTimer = null;
    function progressStart() {
      progressEnd();
      bar = document.createElement('div');
      bar.className = 'turbo-progress';
      document.body.appendChild(bar);
      requestAnimationFrame(function () { bar.style.width = '70%'; });
      // Only show a skeleton over the content if the fetch takes >150ms —
      // fast swaps flash too quickly for the skeleton to be anything but
      // distracting.
      skeletonTimer = setTimeout(showSkeleton, 150);
    }
    function progressEnd() {
      clearTimeout(skeletonTimer);
      skeletonTimer = null;
      hideSkeleton();
      if (!bar) return;
      bar.style.width = '100%';
      var b = bar;
      setTimeout(function () { if (b && b.parentNode) b.parentNode.removeChild(b); }, 200);
      bar = null;
    }
    function showSkeleton() {
      var main = document.querySelector('.main-content');
      if (!main || document.getElementById('turboSkeleton')) return;
      var sk = document.createElement('div');
      sk.id = 'turboSkeleton';
      sk.className = 'turbo-skeleton';
      sk.innerHTML = '<div class="turbo-skel-row" style="width:40%"></div>'
                   + '<div class="turbo-skel-row" style="width:90%"></div>'
                   + '<div class="turbo-skel-row" style="width:75%"></div>'
                   + '<div class="turbo-skel-row" style="width:85%"></div>'
                   + '<div class="turbo-skel-row" style="width:60%"></div>';
      main.appendChild(sk);
    }
    function hideSkeleton() {
      var sk = document.getElementById('turboSkeleton');
      if (sk) sk.remove();
    }

    // ── Scripts re-execution ──────────────────────────────
    // Cloning a <script> element and appending it to the DOM causes the
    // browser to execute it. This is how we re-run page-specific inline
    // scripts inside the swapped .main-content.
    function reExecuteScripts(root) {
      var scripts = root.querySelectorAll('script');
      scripts.forEach(function (old) {
        var fresh = document.createElement('script');
        for (var i = 0; i < old.attributes.length; i++) {
          var a = old.attributes[i];
          fresh.setAttribute(a.name, a.value);
        }
        if (!old.src) fresh.textContent = old.textContent;
        old.parentNode.replaceChild(fresh, old);
      });
    }

    // Page-specific <script src> tags typically live at the bottom of <body>,
    // outside .main-content. Compute the diff between current and target and
    // swap: remove scripts present only in the old page, append scripts
    // present only in the new page. Scripts present in both are left alone
    // (and won't re-execute — pages should listen for turbonav:loaded).
    function diffBodyScripts(newBody) {
      var KEEP = /\/(admin|admin-mobile-nav|notifications-bell|nav-kit|command-palette|nav-extras|breadcrumbs|turbo-nav)\.js/;
      function srcSet(body) {
        var set = {};
        body.querySelectorAll('script[src]').forEach(function (s) {
          var src = s.getAttribute('src');
          if (!src || KEEP.test(src)) return;
          set[src] = s;
        });
        return set;
      }
      var oldScripts = srcSet(document.body);
      var newScripts = srcSet(newBody);

      // Remove old scripts not in new page
      for (var src in oldScripts) {
        if (!(src in newScripts)) oldScripts[src].remove();
      }
      // Append new scripts not in old page
      for (var src2 in newScripts) {
        if (src2 in oldScripts) continue;
        var fresh = document.createElement('script');
        var old = newScripts[src2];
        for (var i = 0; i < old.attributes.length; i++) {
          fresh.setAttribute(old.attributes[i].name, old.attributes[i].value);
        }
        document.body.appendChild(fresh);
      }
    }

    // ── Core swap ─────────────────────────────────────────
    async function visit(href, opts) {
      opts = opts || {};
      progressStart();
      document.dispatchEvent(new CustomEvent('turbonav:unload', { detail: { from: location.pathname, to: href } }));

      var resp;
      try {
        resp = await fetch(href, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
      } catch (_) {
        progressEnd();
        window.location.href = href;
        return;
      }
      if (!resp.ok) {
        progressEnd();
        window.location.href = href;
        return;
      }
      var html = await resp.text();
      var doc  = new DOMParser().parseFromString(html, 'text/html');

      // Second gate: target must also be turbo-ok. If not, fall back to full
      // navigation (still benefits from the fetch already-cached response).
      if (!turboOkMeta(doc)) {
        progressEnd();
        window.location.href = href;
        return;
      }

      var newMain = doc.querySelector('.main-content');
      var curMain = document.querySelector('.main-content');
      if (!newMain || !curMain) {
        progressEnd();
        window.location.href = href;
        return;
      }

      // Swap
      curMain.innerHTML = newMain.innerHTML;
      reExecuteScripts(curMain);
      diffBodyScripts(doc.body);

      // Title + history
      if (doc.title) document.title = doc.title;
      if (!opts.replace) history.pushState({ turbo: true }, '', href);

      // Reset scroll on new page (match browser default for normal nav)
      window.scrollTo(0, 0);

      progressEnd();
      document.dispatchEvent(new CustomEvent('turbonav:loaded', { detail: { path: location.pathname } }));
    }

    // ── Click interception ────────────────────────────────
    document.addEventListener('click', function (ev) {
      if (!turboEnabled()) return;
      if (!turboOkMeta(document)) return; // source page not turbo-safe
      if (ev.defaultPrevented) return;
      if (ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

      var a = ev.target.closest('a');
      if (!a || !a.href) return;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      if (a.getAttribute('data-turbo') === 'false') return;

      var url;
      try { url = new URL(a.href); } catch (_) { return; }
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;

      ev.preventDefault();
      visit(url.pathname + url.search);
    });

    // Back/forward
    window.addEventListener('popstate', function (ev) {
      if (!turboEnabled()) return;
      if (!turboOkMeta(document)) return;
      visit(location.pathname + location.search, { replace: true });
    });

    // ── Styles ────────────────────────────────────────────
    (function styles() {
      if (document.getElementById('turboNavStyles')) return;
      var s = document.createElement('style');
      s.id = 'turboNavStyles';
      s.textContent = [
        '.turbo-progress { position:fixed; top:0; left:0; height:2px; width:0%; background:var(--primary, #7c3aed); z-index:10002; transition:width 0.4s ease-out; }',
        '.turbo-skeleton { padding:24px; display:flex; flex-direction:column; gap:12px; opacity:0; animation:turboSkFadeIn 0.15s ease-out forwards; }',
        '.turbo-skel-row { height:14px; border-radius:6px; background:linear-gradient(90deg, var(--surface2, #1f1f1f) 0%, var(--border, #333) 50%, var(--surface2, #1f1f1f) 100%); background-size:200% 100%; animation:turboSkShimmer 1.2s ease-in-out infinite; }',
        '@keyframes turboSkFadeIn { to { opacity:1; } }',
        '@keyframes turboSkShimmer { 0% { background-position:200% 0; } 100% { background-position:-200% 0; } }',
      ].join('\n');
      document.head.appendChild(s);
    })();

    // ── Cheatsheet toggle for turbo (Power Users) ─────────
    NK.register('mod+shift+t', function () {
      var now = turboEnabled();
      if (now) localStorage.removeItem('navKit.turbo');
      else localStorage.setItem('navKit.turbo', 'on');
      var toast = document.createElement('div');
      toast.className = 'nav-extras-toast in';
      toast.textContent = 'Turbo nav ' + (now ? 'off' : 'on') + ' — reload if pages misbehave';
      document.body.appendChild(toast);
      setTimeout(function () { toast.remove(); }, 1800);
    }, 'Toggle turbo nav (experimental)');

    // Expose manual trigger for scripts that want to opt in programmatically
    window.TurboNav = { visit: visit, enabled: turboEnabled };
  });
})();
