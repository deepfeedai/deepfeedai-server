/**
 * NRChat — Maxwell chat slide-out panel for the Newsroom SPA
 *
 * Standalone module: zero dependency on window.NavKit or .admin-layout.
 * Requires only apiFetch and showAlert from admin.js.
 *
 * DOM elements expected in newsroom.html (do NOT create them here):
 *   #nr-maxwell-pill   — topbar toggle button
 *   #nr-chat-panel     — aside, gets class "open" to slide in
 *   #nr-chat-backdrop  — fullscreen div behind panel (mobile click-to-close)
 *   #nr-chat-thread    — messages container
 *   #nr-chat-input     — textarea
 *   #nr-chat-form      — form wrapping textarea + send button
 *   #nr-chat-send      — submit button
 *   #nr-chat-close     — close X button inside panel
 *   #nr-chat-clear     — clear ↻ button inside panel
 *
 * Exposed as window.NRChat = { init, open, close }
 */
(function () {
  'use strict';

  // ── Module-level state ──────────────────────────────────
  var maxwellId  = null;
  var sending    = false;

  // ── Cached DOM refs (populated in init) ────────────────
  var pill     = null;
  var panel    = null;
  var backdrop = null;
  var thread   = null;
  var input    = null;
  var form     = null;
  var sendBtn  = null;
  var closeBtn = null;
  var clearBtn = null;

  // ── HTML escape ────────────────────────────────────────
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Maxwell discovery ───────────────────────────────────
  async function resolveMaxwell() {
    try {
      var data = await apiFetch('/newsroom-chat/writers');
      if (!data || !Array.isArray(data.writers)) { hidePill(); return; }
      var maxwell = data.writers.find(function (w) {
        return w.is_system && w.role === 'editor';
      });
      if (!maxwell) { hidePill(); return; }
      maxwellId = maxwell.id;
    } catch (_) {
      hidePill();
    }
  }

  function hidePill() {
    if (pill) pill.style.display = 'none';
  }

  // ── Panel open / close ──────────────────────────────────
  function openPanel() {
    if (!panel) return;
    panel.classList.add('open');
    if (backdrop) backdrop.style.display = 'block';
    if (input) {
      setTimeout(function () { input.focus(); }, 150);
    }
  }

  function closePanel() {
    if (!panel) return;
    panel.classList.remove('open');
    if (backdrop) backdrop.style.display = 'none';
  }

  function togglePanel() {
    if (!panel) return;
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  }

  // ── Thread rendering ────────────────────────────────────
  function appendMsg(role, html, isHtml) {
    var div = document.createElement('div');
    div.className = 'nr-chat-msg ' + role;
    if (isHtml) {
      div.innerHTML = html;
    } else {
      div.textContent = html;
    }
    thread.appendChild(div);
    scrollDown();
    return div;
  }

  function appendThinking() {
    var div = document.createElement('div');
    div.className = 'nr-chat-msg thinking';
    div.textContent = 'Maxwell is thinking…';
    thread.appendChild(div);
    scrollDown();
    return div;
  }

  function appendActions(actions) {
    actions.forEach(function (action) {
      var btn = document.createElement('button');
      btn.className = 'nr-chat-action-btn';
      btn.dataset.actionId = action.id || action.action_id || '';
      btn.textContent = action.label || action.action_id || 'Action';
      btn.addEventListener('click', function () { applyAction(action, btn); });
      thread.appendChild(btn);
    });
    scrollDown();
  }

  function appendParseHint(hint) {
    var div = document.createElement('div');
    div.className = 'nr-chat-msg nr-chat-hint';
    div.textContent = hint;
    thread.appendChild(div);
    scrollDown();
  }

  function renderResponse(resp) {
    if (resp.proposal) {
      // proposal: { description, actions }
      var p = resp.proposal;
      if (p.description) {
        appendMsg('maxwell', esc(p.description), true);
      }
      if (Array.isArray(p.actions) && p.actions.length) {
        appendActions(p.actions);
      }
    } else if (resp.text) {
      appendMsg('maxwell', esc(resp.text), true);
      if (Array.isArray(resp.actions) && resp.actions.length) {
        appendActions(resp.actions);
      }
      if (resp.parse_hint) {
        appendParseHint(resp.parse_hint);
      }
    } else if (Array.isArray(resp.actions) && resp.actions.length) {
      appendActions(resp.actions);
      if (resp.parse_hint) {
        appendParseHint(resp.parse_hint);
      }
    } else if (resp.parse_hint) {
      appendParseHint(resp.parse_hint);
    }
  }

  function scrollDown() {
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  // ── Action approval ─────────────────────────────────────
  async function applyAction(action, btn) {
    if (!maxwellId) return;
    btn.disabled = true;
    try {
      var result = await apiFetch('/newsroom-chat/actions/approve', {
        method: 'POST',
        body: JSON.stringify({
          action_id:  action.id || action.action_id,
          writer_id:  maxwellId,
        }),
      });
      appendMsg('maxwell', esc(result.text || 'Done!'), true);
    } catch (err) {
      appendMsg('error', 'Could not apply action: ' + (err.message || 'unknown error'));
      btn.disabled = false;
    }
  }

  // ── Send ─────────────────────────────────────────────────
  async function sendMessage() {
    if (sending || !maxwellId) return;
    var text = input.value.trim();
    if (!text) return;

    sending = true;
    if (sendBtn) sendBtn.disabled = true;

    appendMsg('user', text);
    input.value = '';
    input.style.height = 'auto';

    var thinking = appendThinking();

    try {
      var resp = await apiFetch('/newsroom-chat', {
        method: 'POST',
        body: JSON.stringify({
          message:     text,
          writer_id:   maxwellId,
          context_key: 'nr-newsroom',
        }),
      });
      thinking.remove();
      renderResponse(resp);
    } catch (err) {
      thinking.remove();
      appendMsg('error', 'Maxwell isn\'t available right now.');
    } finally {
      sending = false;
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.focus();
    }
  }

  // ── Clear ────────────────────────────────────────────────
  async function clearThread() {
    thread.innerHTML = '';
    if (!maxwellId) return;
    try {
      await apiFetch('/newsroom-chat/clear', {
        method: 'POST',
        body: JSON.stringify({ writer_id: maxwellId }),
      });
    } catch (_) {
      // silent — local clear already happened
    }
  }

  // ── Keyboard shortcut ────────────────────────────────────
  function onKeyDown(ev) {
    // Only fire when no input/textarea/select/contenteditable is focused
    if (ev.key !== 'm' && ev.key !== 'M') return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var ce = document.activeElement && document.activeElement.isContentEditable;
    if (ce) return;
    togglePanel();
  }

  // ── Init ─────────────────────────────────────────────────
  function init() {
    pill = document.getElementById('nr-maxwell-pill');
    if (!pill) return; // not on newsroom page

    panel    = document.getElementById('nr-chat-panel');
    backdrop = document.getElementById('nr-chat-backdrop');
    thread   = document.getElementById('nr-chat-thread');
    input    = document.getElementById('nr-chat-input');
    form     = document.getElementById('nr-chat-form');
    sendBtn  = document.getElementById('nr-chat-send');
    closeBtn = document.getElementById('nr-chat-close');
    clearBtn = document.getElementById('nr-chat-clear');

    // Pill toggle
    pill.addEventListener('click', togglePanel);

    // Close button
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    // Backdrop click (mobile close)
    if (backdrop) {
      backdrop.addEventListener('click', closePanel);
    }

    // Clear button
    if (clearBtn) clearBtn.addEventListener('click', clearThread);

    // Form submit
    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        sendMessage();
      });
    }

    // Enter sends, Shift+Enter = newline
    if (input) {
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          sendMessage();
        }
      });

      // Auto-resize textarea
      input.addEventListener('input', function () {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      });
    }

    // Global keyboard shortcut: m to toggle
    document.addEventListener('keydown', onKeyDown);

    // Discover Maxwell's writer ID
    resolveMaxwell();
  }

  // ── Boot ─────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Public API ───────────────────────────────────────────
  window.NRChat = {
    init:  init,
    open:  openPanel,
    close: closePanel,
  };

})();
