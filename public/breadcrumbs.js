/**
 * Topbar breadcrumbs — `Group › Page › Entity`.
 *
 * Renders a compact trail above/beside the existing .topbar-title showing
 * the nav group, the current page, and (for entity pages like the article
 * editor) the entity name fetched from the API.
 *
 * Sources:
 *   - Group + page labels resolved from window.NAV_GROUPS by pathname.
 *   - Entity level added for select entity pages: article-editor, preview.
 *
 * Pages that don't match any NAV_GROUPS entry keep the vanilla topbar-title.
 * Runs after admin.js renderSidebar() so the topbar is present.
 */
(function () {
  'use strict';

  function ready(cb) {
    if (window.NavKit && window.NAV_GROUPS && document.querySelector('.topbar')) return cb();
    setTimeout(function () { ready(cb); }, 50);
  }

  ready(function init() {
    var NK = window.NavKit;
    var esc = NK.esc;
    var el  = NK.el;
    var pathname = window.location.pathname;

    // Resolve { group, item } from NAV_GROUPS
    function resolveNav() {
      var groups = window.NAV_GROUPS || [];
      for (var i = 0; i < groups.length; i++) {
        for (var j = 0; j < groups[i].items.length; j++) {
          var it = groups[i].items[j];
          if (pathname === it.href || (it.href === '/index.html' && pathname === '/')) {
            return { group: groups[i].label, item: it.label, href: it.href };
          }
        }
      }
      return null;
    }

    // Entity pages: pull a human label from the URL + API. Keep this list
    // small and intentional — over-enriching the topbar makes it noisy.
    async function resolveEntity() {
      try {
        if (pathname === '/article-editor.html') {
          var id = new URLSearchParams(location.search).get('id');
          if (!id) return null;
          var data = await apiFetch('/articles/' + id);
          return { parent: { group: 'Content', item: 'Articles', href: '/articles.html' }, label: data?.title || ('Article #' + id) };
        }
        if (pathname === '/preview.html') {
          var slug = new URLSearchParams(location.search).get('slug');
          if (!slug) return null;
          var d = await apiFetch('/articles/preview-by-slug?slug=' + encodeURIComponent(slug));
          return { parent: { group: 'Content', item: 'Articles', href: '/articles.html' }, label: d?.title || slug };
        }
      } catch (_) { /* non-fatal — breadcrumbs degrade gracefully */ }
      return null;
    }

    function render(nav, entity) {
      var topbar = document.querySelector('.topbar');
      if (!topbar) return;
      var title = topbar.querySelector('.topbar-title');
      if (!title) return;

      // Don't clobber an existing breadcrumb (turbo-nav re-runs may refresh)
      var existing = topbar.querySelector('.breadcrumbs');
      if (existing) existing.remove();

      var crumbs = [];
      if (entity && entity.parent) {
        crumbs.push({ label: entity.parent.group });
        crumbs.push({ label: entity.parent.item, href: entity.parent.href });
        crumbs.push({ label: entity.label });
      } else if (nav) {
        crumbs.push({ label: nav.group });
        crumbs.push({ label: nav.item });
      } else {
        return; // nothing meaningful to show
      }

      var wrap = el('div', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' });
      crumbs.forEach(function (c, i) {
        if (i > 0) wrap.appendChild(el('span', { class: 'breadcrumbs-sep' }, ['›']));
        if (c.href) {
          wrap.appendChild(el('a', { class: 'breadcrumbs-link', href: c.href }, [c.label]));
        } else {
          var isLast = i === crumbs.length - 1;
          wrap.appendChild(el('span', { class: 'breadcrumbs-crumb' + (isLast ? ' current' : '') }, [c.label]));
        }
      });

      // Replace the topbar-title text with the breadcrumbs (keeps the title
      // as a fallback for pages we don't resolve).
      title.innerHTML = '';
      title.appendChild(wrap);
    }

    (function styles() {
      if (document.getElementById('breadcrumbsStyles')) return;
      var s = document.createElement('style');
      s.id = 'breadcrumbsStyles';
      s.textContent = [
        '.breadcrumbs { display:inline-flex; align-items:center; gap:6px; font-size:14px; font-weight:500; flex-wrap:wrap; }',
        '.breadcrumbs-sep { color:var(--muted, #888); font-weight:300; }',
        '.breadcrumbs-link { color:var(--muted, #888); text-decoration:none; }',
        '.breadcrumbs-link:hover { color:var(--text, #fff); text-decoration:underline; }',
        '.breadcrumbs-crumb { color:var(--muted, #888); }',
        '.breadcrumbs-crumb.current { color:var(--text, #fff); font-weight:600; }',
        '@media (max-width: 640px) { .breadcrumbs { font-size:13px; } .breadcrumbs-crumb:not(.current), .breadcrumbs-link { display:none; } .breadcrumbs-sep { display:none; } }',
      ].join('\n');
      document.head.appendChild(s);
    })();

    var nav = resolveNav();
    // Initial render with nav only; enrichment (entity name) comes async.
    if (nav) render(nav, null);
    resolveEntity().then(function (entity) {
      if (entity) render(nav, entity);
    });
  });
})();
