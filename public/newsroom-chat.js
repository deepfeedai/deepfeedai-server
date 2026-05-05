/**
 * NRChat — Maxwell chat slide-out panel for the Newsroom SPA
 *
 * Standalone module: zero dependency on window.NavKit or .admin-layout.
 * Requires only apiFetch and showAlert from admin.js.
 *
 * DOM elements expected in newsroom.html (do NOT create them here):
 *   #nr-maxwell-pill      — topbar toggle button
 *   #nr-chat-panel        — aside, gets class "open" to slide in
 *   #nr-chat-backdrop     — fullscreen div behind panel (mobile click-to-close)
 *   #nr-chat-thread       — messages container
 *   #nr-chat-input        — textarea
 *   #nr-chat-form         — form wrapping textarea + send button
 *   #nr-chat-send         — submit button
 *   #nr-chat-close        — close X button inside panel
 *   #nr-chat-clear        — clear ↻ button inside panel
 *   #nr-chat-head-title   — panel header title span
 *   #nr-chat-head-sub     — panel header subtitle span
 *   #nr-chat-suggest      — "Suggest actions" quick-action button (Maxwell-only)
 *
 * Exposed as window.NRChat = { init, open, close, openForWriter }
 */
(function () {
  'use strict';

  // ── Module-level state ──────────────────────────────────
  var initialized      = false;
  var maxwellId        = null;   // real Maxwell id — set once on boot, never changes
  var maxwellName      = 'Maxwell';
  var activeWriterId   = null;   // current chat target (defaults to Maxwell after boot)
  var activeWriterName = 'Maxwell';
  var sending          = false;

  // ── Cached DOM refs (populated in init) ────────────────
  var pill       = null;
  var panel      = null;
  var backdrop   = null;
  var thread     = null;
  var input      = null;
  var form       = null;
  var sendBtn    = null;
  var closeBtn   = null;
  var clearBtn   = null;
  var headTitle  = null;
  var headSub    = null;
  var suggestBtn = null;

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
      var data = await apiFetch('/newsroom-chat/maxwell');
      if (!data || !data.id) { hidePill(); return; }
      maxwellId        = data.id;
      maxwellName      = data.name || 'Maxwell';
      activeWriterId   = maxwellId;
      activeWriterName = maxwellName;
    } catch (_) {
      hidePill();
    }
  }

  function hidePill() {
    if (pill) pill.style.display = 'none';
  }

  // ── Panel header ────────────────────────────────────────
  function setHeader(title, sub) {
    if (headTitle) headTitle.textContent = '📋 ' + title;
    if (headSub)   headSub.textContent   = sub || '';
    if (panel) panel.setAttribute('aria-label', 'Chat with ' + title);
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

  // ── Reset to Maxwell ────────────────────────────────────
  function resetToMaxwell() {
    if (!maxwellId) {
      // Maxwell hasn't resolved yet — re-trigger and bail
      resolveMaxwell();
      return;
    }
    if (activeWriterId === maxwellId) return; // already in Maxwell mode, nothing to reset
    activeWriterId   = maxwellId;
    activeWriterName = maxwellName;
    setHeader(maxwellName, 'Editorial Director');
    if (input) input.placeholder = 'Ask Maxwell…';
    if (suggestBtn) suggestBtn.style.display = '';
    if (thread) thread.innerHTML = '';
  }

  // ── Open Maxwell with a pre-sent message (called from Wire cluster actions) ──
  function openMaxwellWithContext(message) {
    if (activeWriterId !== maxwellId) resetToMaxwell();
    openPanel();
    if (message && input) {
      input.value = message;
      // Brief delay so the panel slide-in animation completes before sending
      setTimeout(sendMessage, 250);
    }
  }

  // ── Per-writer chat (called from Desk Writers tab) ──────
  function openForWriter(writerId, writerName) {
    if (!writerId) return;
    activeWriterId   = writerId;
    activeWriterName = writerName || 'Writer';
    setHeader(activeWriterName, 'Writer');
    if (input) input.placeholder = 'Ask ' + activeWriterName + '…';
    if (suggestBtn) suggestBtn.style.display = 'none'; // Maxwell-only
    if (thread) thread.innerHTML = '';
    openPanel();
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
    div.textContent = (activeWriterName || 'Maxwell') + ' is thinking…';
    thread.appendChild(div);
    scrollDown();
    return div;
  }

  // parentProposal: the tool_proposal object this action belongs to (null for create_pitch actions)
  function appendActions(actions, parentProposal) {
    actions.forEach(function (action) {
      var btn = document.createElement('button');
      btn.className = 'nr-chat-action-btn';
      btn.textContent = action.label || action.action_id || 'Action';

      if (action.action_id === 'cancel') {
        btn.addEventListener('click', function () {
          // Remove all sibling action buttons without calling the API
          thread.querySelectorAll('.nr-chat-action-btn').forEach(function (b) { b.remove(); });
        });
      } else {
        btn.addEventListener('click', function () { applyAction(action, btn, parentProposal); });
      }
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
      var p = resp.proposal;
      if (p.description) {
        appendMsg('maxwell', esc(p.description), true);
      }
      if (Array.isArray(p.actions) && p.actions.length) {
        // Pass the full proposal so applyAction can forward it to the server
        appendActions(p.actions, p);
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
  // action: the button's action object ({ type/action_id, label, payload? })
  // parentProposal: the tool_proposal that owns this action, if any
  async function applyAction(action, btn, parentProposal) {
    if (!activeWriterId) return;
    btn.disabled = true;
    try {
      var payload;
      if (action.type === 'create_pitch') {
        // create_pitch actions carry their own complete payload
        payload = Object.assign({}, action, { writer_id: activeWriterId });
      } else if (parentProposal && (parentProposal.proposal_type || parentProposal.type === 'tool_proposal')) {
        // Tool proposal confirmation: forward the full parent proposal to the server
        payload = Object.assign({}, parentProposal, { writer_id: activeWriterId });
      } else {
        // Fallback for unknown action shapes
        payload = Object.assign({}, action, { writer_id: activeWriterId });
      }

      var result = await apiFetch('/newsroom-chat/actions/approve', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      appendMsg('maxwell', esc(result.text || 'Done!'), true);
    } catch (err) {
      appendMsg('error', 'Could not apply action: ' + (err.message || 'unknown error'));
      btn.disabled = false;
    }
  }

  // ── Send ─────────────────────────────────────────────────
  async function sendMessage() {
    if (sending || !activeWriterId) return;
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
          writer_id:   activeWriterId,
          context_key: 'nr-newsroom',
        }),
      });
      thinking.remove();
      renderResponse(resp);
    } catch (err) {
      thinking.remove();
      appendMsg('error', (activeWriterName || 'Maxwell') + ' isn\'t available right now.');
    } finally {
      sending = false;
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.focus();
    }
  }

  // ── Clear ────────────────────────────────────────────────
  async function clearThread() {
    thread.innerHTML = '';
    if (!activeWriterId) return;
    try {
      await apiFetch('/newsroom-chat/clear', {
        method: 'POST',
        body: JSON.stringify({ writer_id: activeWriterId }),
      });
    } catch (_) {
      // silent — local clear already happened
    }
  }

  // ── Keyboard shortcut ────────────────────────────────────
  function onKeyDown(ev) {
    if (ev.key !== 'm' && ev.key !== 'M') return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var ce = document.activeElement && document.activeElement.isContentEditable;
    if (ce) return;
    // Only reset to Maxwell when switching away from a per-writer thread
    if (activeWriterId !== maxwellId) resetToMaxwell();
    togglePanel();
  }

  // ── Init ─────────────────────────────────────────────────
  function init() {
    if (initialized) return; // guard against double-init
    initialized = true;

    pill = document.getElementById('nr-maxwell-pill');
    if (!pill) return; // not on newsroom page

    panel      = document.getElementById('nr-chat-panel');
    backdrop   = document.getElementById('nr-chat-backdrop');
    thread     = document.getElementById('nr-chat-thread');
    input      = document.getElementById('nr-chat-input');
    form       = document.getElementById('nr-chat-form');
    sendBtn    = document.getElementById('nr-chat-send');
    closeBtn   = document.getElementById('nr-chat-close');
    clearBtn   = document.getElementById('nr-chat-clear');
    headTitle  = document.getElementById('nr-chat-head-title');
    headSub    = document.getElementById('nr-chat-head-sub');
    suggestBtn = document.getElementById('nr-chat-suggest');

    // Pill opens Maxwell — only resets context when switching from a writer thread
    pill.addEventListener('click', function () {
      if (activeWriterId !== maxwellId) resetToMaxwell();
      togglePanel();
    });

    // Close button
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    // Backdrop click (mobile close)
    if (backdrop) {
      backdrop.addEventListener('click', closePanel);
    }

    // Clear button
    if (clearBtn) clearBtn.addEventListener('click', clearThread);

    // Suggest actions quick-button (Maxwell only — hidden in per-writer mode)
    if (suggestBtn) {
      suggestBtn.addEventListener('click', function () {
        if (sending || !activeWriterId) return;
        input.value = 'Suggest actions';
        sendMessage();
      });
    }

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
    init:                  init,
    open:                  openPanel,
    close:                 closePanel,
    openForWriter:         openForWriter,
    openMaxwellWithContext: openMaxwellWithContext,
  };

})();
