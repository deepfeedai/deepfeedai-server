/**
 * Mobile Bottom Nav
 *
 * On narrow viewports (< 768px), replaces the hamburger-only nav with a
 * persistent bottom tab bar for the four most common flows plus a More
 * tab that opens the existing sidebar drawer.
 *
 * Tabs:
 *   💬 Chat      → /newsroom-chat.html
 *   📰 Articles  → /articles.html
 *   📡 Activity  → /newsroom-activity.html
 *   🔔 Bell      (toggles the existing notifications dropdown in-place)
 *   ⋮ More       (opens the sidebar via its hamburger trigger)
 *
 * Adds padding-bottom to .main-content so page content doesn't hide
 * behind the bar. Active tab highlighted from current pathname.
 */
(function () {
  'use strict';

  function ready(cb) {
    if (document.body && window.NavKit) return cb();
    setTimeout(function () { ready(cb); }, 50);
  }

  ready(function init() {
    if (!document.querySelector('.admin-layout')) return;

    var NK = window.NavKit;
    var esc = NK.esc;
    var el  = NK.el;

    var TABS = [
      { href: '/newsroom-chat.html',     label: 'Chat',     icon: '💬' },
      { href: '/articles.html',          label: 'Articles', icon: '📰' },
      { href: '/newsroom-activity.html', label: 'Activity', icon: '📡' },
      { action: 'bell',                  label: 'Alerts',   icon: '🔔' },
      { action: 'more',                  label: 'More',     icon: '⋮' },
    ];

    var pathname = window.location.pathname;

    function render() {
      if (document.getElementById('mobileBottomNav')) return;
      var nav = el('nav', { id: 'mobileBottomNav', class: 'mbnav', 'aria-label': 'Primary' });
      TABS.forEach(function (t) {
        var isActive = t.href && pathname === t.href;
        var cls = 'mbnav-tab' + (isActive ? ' active' : '');

        var tab;
        if (t.href) {
          tab = el('a', { class: cls, href: t.href });
        } else {
          tab = el('button', { class: cls, type: 'button' });
        }
        tab.innerHTML = '<span class="mbnav-icon">' + t.icon + '</span><span class="mbnav-label">' + esc(t.label) + '</span>';
        if (t.action === 'bell') {
          tab.addEventListener('click', function (ev) {
            ev.preventDefault();
            var bellBtn = document.getElementById('dfaBellBtn') || document.querySelector('.notifications-bell-btn');
            if (bellBtn) bellBtn.click();
          });
          // Mirror the bell's unread badge onto this tab when present
          tab.setAttribute('data-bell-tab', '1');
        }
        if (t.action === 'more') {
          tab.addEventListener('click', function (ev) {
            ev.preventDefault();
            var hamburger = document.getElementById('hamburger');
            if (hamburger) hamburger.click();
          });
        }
        nav.appendChild(tab);
      });
      document.body.appendChild(nav);
    }

    // Mirror the unread-badge count from the notifications bell onto the
    // Alerts tab. Cheap poll — the bell itself updates on an interval.
    function syncBellBadge() {
      var tab = document.querySelector('[data-bell-tab]');
      if (!tab) return;
      var badge = document.querySelector('#dfaBellBadge, .dfa-bell-badge');
      var count = badge ? parseInt(badge.textContent, 10) : 0;
      var existing = tab.querySelector('.mbnav-badge');
      if (count > 0) {
        if (!existing) {
          existing = el('span', { class: 'mbnav-badge' });
          tab.appendChild(existing);
        }
        existing.textContent = count > 99 ? '99+' : String(count);
      } else if (existing) {
        existing.remove();
      }
    }

    // ── Styles ────────────────────────────────────────────
    (function styles() {
      if (document.getElementById('mbnavStyles')) return;
      var s = document.createElement('style');
      s.id = 'mbnavStyles';
      s.textContent = [
        '.mbnav { display:none; position:fixed; left:0; right:0; bottom:0; height:58px; background:var(--bg-card, #1a1a1a); border-top:1px solid var(--border, #333); z-index:9000; padding-bottom:env(safe-area-inset-bottom, 0); }',
        '.mbnav-tab { flex:1; background:none; border:0; color:var(--muted, #888); text-decoration:none; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; font-size:10px; padding:6px 4px; cursor:pointer; position:relative; }',
        '.mbnav-tab.active { color:var(--primary, #7c3aed); }',
        '.mbnav-icon { font-size:18px; line-height:1; }',
        '.mbnav-label { font-size:10px; font-weight:500; letter-spacing:0.2px; }',
        '.mbnav-badge { position:absolute; top:4px; right:calc(50% - 20px); background:#ef4444; color:#fff; font-size:10px; font-weight:700; padding:1px 5px; border-radius:999px; min-width:16px; text-align:center; line-height:14px; }',
        '@media (max-width: 768px) {',
        '  .mbnav { display:flex; }',
        '  .main-content { padding-bottom:72px !important; }',
        '  .mx-bubble { bottom:74px !important; }', // lift Maxwell bubble above the bottom nav
        '}',
      ].join('\n');
      document.head.appendChild(s);
    })();

    render();
    syncBellBadge();
    setInterval(syncBellBadge, 3000);
  });
})();
