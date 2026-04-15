/* admin-mobile-nav.js
 * Mobile drawer enhancer for admin pages.
 *
 * admin.js already wires the hamburger -> sidebar.open / overlay.open
 * pattern on most pages. This script makes that behavior:
 *   - idempotent (safe to load alongside admin.js)
 *   - resilient (injects the overlay if missing)
 *   - keyboard-friendly (Escape closes the drawer)
 *   - guaranteed (auto-closes drawer on any nav-link click)
 *
 * Pure additive — desktop (≥769px) is unaffected.
 */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var hamburger = document.getElementById('hamburger');
    var sidebar   = document.getElementById('sidebar');
    if (!hamburger || !sidebar) return;

    // Ensure overlay exists (admin.js usually injects it; be defensive)
    var overlay = document.getElementById('sidebarOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      overlay.id = 'sidebarOverlay';
      document.body.appendChild(overlay);
    }

    function close() {
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
    }
    function toggle() {
      var willOpen = !sidebar.classList.contains('open');
      sidebar.classList.toggle('open', willOpen);
      overlay.classList.toggle('open', willOpen);
    }

    // Mark wired so we don't double-bind if loaded twice.
    if (!hamburger.dataset.mobileNavWired) {
      hamburger.dataset.mobileNavWired = '1';
      hamburger.addEventListener('click', toggle);
    }
    if (!overlay.dataset.mobileNavWired) {
      overlay.dataset.mobileNavWired = '1';
      overlay.addEventListener('click', close);
    }

    // Close on any nav-link click (covers both <a class="nav-link"> and links inside .sidebar-nav)
    sidebar.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a');
      if (!a) return;
      if (window.innerWidth < 768) close();
    });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) close();
    });

    // Close drawer if viewport grows past breakpoint (e.g. rotation)
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 768) close();
    });
  });
})();
