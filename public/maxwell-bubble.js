/**
 * Maxwell Floating Bubble
 *
 * Ask-Maxwell-from-anywhere. Adds a floating bubble in the bottom-right
 * corner of every admin page; click opens a right-side slide-out chat
 * panel that reuses /api/newsroom-chat. Current article context (from the
 * persistent article-context pill, Phase 2b) auto-attaches so Maxwell
 * answers with that article already in view.
 *
 * Gated by the editor_workspace feature flag — if disabled, the bubble
 * stays hidden. Writer id is discovered by asking for the roster and
 * selecting the system editor agent.
 *
 * Handles all three response shapes from /api/newsroom-chat:
 *   - Plain text ({ text })
 *   - Legacy action buttons ({ actions: [...] })
 *   - Tool proposals when maxwell_tool_calling flag is on ({ proposal })
 *   - Parse-hint retry banner ({ parse_hint })
 *
 * History is persisted server-side via the context key — we don't cache
 * anything locally beyond the in-session thread.
 */
(function () {
  'use strict';

  function ready(cb) {
    if (document.body && window.NavKit) return cb();
    setTimeout(function () { ready(cb); }, 50);
  }

  ready(function init() {
    // Skip on login/signup/setup/static pages
    if (!document.querySelector('.admin-layout')) return;
    // Skip on the newsroom-chat page itself — the bubble would be redundant
    if (location.pathname === '/newsroom-chat.html') return;

    var NK = window.NavKit;
    var esc = NK.esc;
    var el  = NK.el;

    var maxwellId = null;
    var enabled   = null;   // null = unresolved, true/false once checked
    var panel = null;
    var bubble = null;
    var thread = null;
    var input  = null;
    var sending = false;
    var lastUserMessage = '';

    // ── Feature gate + Maxwell discovery ──────────────────
    async function resolveMaxwell() {
      try {
        var writers = await apiFetch('/newsroom-chat/writers');
        if (!writers || !Array.isArray(writers.writers)) { enabled = false; return; }
        var maxwell = writers.writers.find(function (w) { return w.is_system && w.role === 'editor'; });
        if (!maxwell) { enabled = false; return; }
        maxwellId = maxwell.id;
        enabled = true;
        renderBubble();
      } catch (_) {
        enabled = false; // editor_workspace flag likely off — stay hidden
      }
    }

    // ── Bubble + panel UI ─────────────────────────────────
    function renderBubble() {
      if (bubble) return;
      bubble = el('button', {
        id: 'maxwellBubble',
        class: 'mx-bubble',
        'aria-label': 'Ask Maxwell',
        title: 'Ask Maxwell (M)',
        onclick: togglePanel,
      }, ['📋']);
      document.body.appendChild(bubble);
      NK.register('m', function () { togglePanel(); }, 'Ask Maxwell');
    }

    function ensurePanel() {
      if (panel) return;
      panel = el('aside', { id: 'maxwellPanel', class: 'mx-panel', role: 'dialog', 'aria-label': 'Chat with Maxwell' });

      var header = el('header', { class: 'mx-head' });
      header.innerHTML = ''
        + '<div class="mx-head-title"><span class="mx-head-icon">📋</span> Maxwell <span class="mx-head-sub">Editorial Director</span></div>'
        + '<div class="mx-head-ctx" id="mxHeadCtx"></div>'


        + '<button class="mx-head-reset" title="Clear conversation and sources" aria-label="Clear chat">↻ Clear</button>'


        + '<button class="mx-head-close" aria-label="Close">✕</button>';
      header.querySelector('.mx-head-close').addEventListener('click', closePanel);
      header.querySelector('.mx-head-reset').addEventListener('click', function () { resetThread({ keepOpen: true }); });

      thread = el('div', { id: 'mxThread', class: 'mx-thread' });

      var form = el('form', { class: 'mx-form', onsubmit: function (ev) { ev.preventDefault(); sendMessage(); } });
      input = el('textarea', {
        id: 'mxInput',
        class: 'mx-input',
        rows: '1',
        placeholder: 'Ask Maxwell…',
        autocomplete: 'off',
      });
      input.addEventListener('input', autosize);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendMessage(); }
      });
      // When the soft keyboard opens on mobile, the visual viewport shrinks
      // and the input can end up under the keyboard. Nudge it back into view
      // after the keyboard animation settles.
      input.addEventListener('focus', function () {
        setTimeout(function () {
          if (input.scrollIntoView) input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }, 300);
      });
      var send = el('button', { class: 'mx-send', type: 'submit', 'aria-label': 'Send' }, ['↑']);
      form.appendChild(input);
      form.appendChild(send);

      panel.appendChild(header);
      panel.appendChild(thread);
      panel.appendChild(form);
      document.body.appendChild(panel);

      // Close on outside click / Esc. The _justOpened() guard prevents the
      // click event that opened the panel (e.g. the Feed Inbox bulk pitch
      // button) from immediately closing it again when it bubbles up here.
      document.addEventListener('click', function (ev) {
        if (!panel.classList.contains('open')) return;
        if (_justOpened()) return;
        if (panel.contains(ev.target) || (bubble && bubble.contains(ev.target))) return;
        closePanel();
      });
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && panel.classList.contains('open')) closePanel();
      });
    }

    // Guards the outside-click handler against the click that just opened
    // the panel — e.g. the Feed Inbox bulk "Create pitch from selection"
    // button lives outside the panel AND the bubble, so without this flag
    // the same click that triggers openPanel also bubbles up to document
    // and the handler immediately closes the panel.
    var _openedAt = 0;
    function _justOpened() { return Date.now() - _openedAt < 300; }

    function togglePanel() {
      ensurePanel();
      if (panel.classList.contains('open')) closePanel();
      else openPanel();
    }

    function openPanel() {
      ensurePanel();
      panel.classList.add('open');
      _openedAt = Date.now();
      refreshContextBadge();
      if (!thread.children.length) {
        appendBubble('assistant', 'Hi — Maxwell here. Ask me about any story, writer, or coverage gap. I can propose pitches, approvals, and assignments.');
      }
      // iOS Safari blocks programmatic .focus() called outside the original
      // tap event from showing the soft keyboard. On touch devices, skip the
      // auto-focus so the user's first tap on the textarea reliably opens
      // the keyboard. Desktop still gets the convenience auto-focus.
      var isTouch = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
      if (!isTouch) {
        setTimeout(function () { input.focus(); }, 150);
      }
    }

    function closePanel() { if (panel) panel.classList.remove('open'); }

    function refreshContextBadge() {
      var badge = document.getElementById('mxHeadCtx');
      if (!badge) return;
      var ctx = window.ArticleContext && window.ArticleContext.get();
      if (ctx && ctx.title) {
        badge.innerHTML = '<span class="mx-head-ctx-pill">📄 ' + esc(ctx.title) + '</span>';
      } else {
        badge.innerHTML = '';
      }
    }

    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    }




    // ── Minimal markdown → HTML (assistant messages only) ────
    function mdInline(s) {
      return s
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>')
        .replace(/\*([^\*\n]+?)\*/g, '<em>$1</em>')
        .replace(/_([^_\n]+?)_/g, '<em>$1</em>')
        .replace(/`([^`]+?)`/g, '<code>$1</code>');
    }
    function mdToHtml(raw) {
      // Escape HTML to prevent XSS, then apply markdown on top.
      var s = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      var lines = s.split('\n');
      var html = '';
      var listDepth = 0; // 0=none, 1=outer, 2=inner
      lines.forEach(function (line) {
        var hm = line.match(/^(#{1,3})\s+(.+)$/);
        if (hm) {
          if (listDepth) { html += listDepth > 1 ? '</ul></li></ul>' : '</ul>'; listDepth = 0; }
          html += '<p class="mx-md-h' + hm[1].length + '">' + mdInline(hm[2]) + '</p>';
          return;
        }
        var im = line.match(/^(\s*)[\-\*]\s+(.*)$/);
        if (im) {
          var depth = im[1].length > 0 ? 2 : 1;
          if (listDepth === 0) { html += '<ul class="mx-md-ul">'; listDepth = 1; }
          if (depth === 2 && listDepth === 1) { html += '<ul class="mx-md-ul mx-md-ul-sub">'; listDepth = 2; }
          if (depth === 1 && listDepth === 2) { html += '</ul>'; listDepth = 1; }
          html += '<li>' + mdInline(im[2]) + '</li>';
          return;
        }
        if (listDepth) { html += listDepth > 1 ? '</ul></ul>' : '</ul>'; listDepth = 0; }
        if (line.trim() === '') { html += '<br>'; return; }
        html += '<p class="mx-md-p">' + mdInline(line) + '</p>';
      });
      if (listDepth) html += listDepth > 1 ? '</ul></ul>' : '</ul>';
      return html;
    }

    // ── Thread rendering ──────────────────────────────────
    function appendBubble(role, text) {
      var b = el('div', { class: 'mx-bubble-msg mx-' + role });
      if (role === 'assistant') {
        b.innerHTML = mdToHtml(text);
      } else {
        b.textContent = text;
      }



      thread.appendChild(b);
      scrollDown();
      return b;
    }

    function appendTyping() {
      var t = el('div', { class: 'mx-typing' }, ['Maxwell is typing…']);
      thread.appendChild(t);
      scrollDown();
      return t;
    }

    function appendProposal(proposal) {
      var card = el('div', { class: 'mx-card' });
      var title = proposalTitle(proposal);
      // Pitch proposals get a type dropdown so the editor can override
      // Maxwell's inferred type before approving. Also shows a source-count
      // chip when the pitch bundles multiple sources.
      var extra = '';
      if (proposal.proposal_type === 'pitch') {
        var srcCount = Array.isArray(proposal.source_article_ids) ? proposal.source_article_ids.length : 1;
        if (srcCount > 1) {
          extra += '<div class="mx-card-meta">' + srcCount + ' sources:</div>';
          var titles = Array.isArray(proposal.source_titles) ? proposal.source_titles : [];
          if (titles.length) {
            extra += '<ul class="mx-card-sources">'
              + titles.slice(0, 5).map(function (s) {
                return '<li>' + esc((s.title || 'Article #' + s.id).slice(0, 80)) + '</li>';
              }).join('')
              + (titles.length > 5 ? '<li class="mx-card-sources-more">+ ' + (titles.length - 5) + ' more</li>' : '')
              + '</ul>';
          }
        }
        if (window.renderPitchTypeSelect) {
          extra += '<div class="mx-card-type-row"><span>Type:</span> ' + window.renderPitchTypeSelect(proposal.pitch_type) + '</div>';
        }
      }
      card.innerHTML = '<div class="mx-card-body">' + esc(title) + '</div>'
        + extra
        + '<div class="mx-card-actions">'
        +   '<button class="mx-card-approve">✓ ' + (proposal.destructive ? 'Confirm' : 'Approve') + '</button>'
        +   '<button class="mx-card-skip">Skip</button>'
        + '</div>';
      card.querySelector('.mx-card-approve').addEventListener('click', function () { applyProposal(proposal, card); });
      card.querySelector('.mx-card-skip').addEventListener('click', function () { card.remove(); });
      thread.appendChild(card);
      scrollDown();
    }

    function proposalTitle(p) {
      switch (p.proposal_type) {
        case 'pitch':          return '📋 Pitch — ' + (p.angle_summary || '') + (p.writer_name ? ' → ' + p.writer_name : '');
        case 'approve_article':return '✓ Approve article #' + p.article_id;
        case 'kill_article':   return '⚠️ Kill article #' + p.article_id + (p.reason ? ' — ' + p.reason : '');
        case 'assign_writer':  return '👤 Assign article #' + p.article_id + (p.writer_name ? ' → ' + p.writer_name : '');
        case 'feature_article':return '⭐ ' + (p.featured ? 'Feature' : 'Unfeature') + ' article #' + p.article_id;
        case 'headline':       return '✏️ Headline: ' + (p.new_headline || '');
        case 'thumbnail':      return '🎨 New thumbnail';
        default:               return 'Proposal: ' + p.proposal_type;
      }
    }

    async function applyProposal(proposal, card) {
      card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      // Merge the editor's type override into the payload before POSTing —
      // the dropdown lives in the card so we read it just before send.
      var typeSel = card.querySelector('.pitch-type-select');
      if (typeSel && proposal.proposal_type === 'pitch') {
        proposal = Object.assign({}, proposal, { pitch_type: typeSel.value });
      }
      try {
        var result = await apiFetch('/newsroom-chat/actions/approve', {
          method: 'POST',
          body: JSON.stringify(proposal),
        });
        card.classList.add('done');
        appendBubble('assistant', result.text || 'Done!');
        // After a successful pitch creation, reset the session so the next
        // pitch composition starts from a clean slate — no stale sources
        // carried over from the pill, no prior turns in the thread history.
        // The editor sees a confirmation bubble above the reset.
        if (proposal.proposal_type === 'pitch' && result && !result.error) {
          setTimeout(function () {
            resetThread({ keepOpen: false, silent: true });
          }, 400);
        }
      } catch (err) {
        card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        appendBubble('assistant', '⚠️ ' + (err.message || 'apply failed'));
      }
    }

    function appendAction(action) {
      // Legacy action button shape (create_pitch via <<<PITCH:>>> parse path)
      var card = el('div', { class: 'mx-card' });
      card.innerHTML = '<div class="mx-card-body">' + esc(action.label || 'Create') + '</div>'
        + '<div class="mx-card-actions">'
        +   '<button class="mx-card-approve">✓ Create</button>'
        +   '<button class="mx-card-skip">Skip</button>'
        + '</div>';
      card.querySelector('.mx-card-approve').addEventListener('click', async function () {
        card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        try {
          var result = await apiFetch('/newsroom-chat/actions/approve', {
            method: 'POST',
            body: JSON.stringify(action),
          });
          card.classList.add('done');
          appendBubble('assistant', result.text || 'Done!');
        } catch (err) {
          card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
          appendBubble('assistant', '⚠️ ' + (err.message || 'apply failed'));
        }
      });
      card.querySelector('.mx-card-skip').addEventListener('click', function () { card.remove(); });
      thread.appendChild(card);
      scrollDown();
    }

    function appendParseHint(hint, originalText) {
      var banner = el('div', { class: 'mx-hint' });
      banner.innerHTML = '<span>' + esc(hint) + '</span><button class="mx-hint-retry">↻ Retry</button>';
      banner.querySelector('.mx-hint-retry').addEventListener('click', function () {
        banner.remove();
        input.value = originalText;
        sendMessage();
      });
      thread.appendChild(banner);
      scrollDown();
    }

    function scrollDown() { thread.scrollTop = thread.scrollHeight; }

    // ── Send ──────────────────────────────────────────────
    async function sendMessage() {
      if (sending || !enabled || !maxwellId) return;
      var text = input.value.trim();
      if (!text) return;
      sending = true;
      lastUserMessage = text;
      appendBubble('user', text);
      input.value = '';
      autosize();

      var typing = appendTyping();
      var ctx = window.ArticleContext && window.ArticleContext.get();

      try {
        var resp = await apiFetch('/newsroom-chat', {
          method: 'POST',
          body: JSON.stringify({
            writer_id: maxwellId,
            message:   text,
            context_article_id: ctx && ctx.id ? ctx.id : undefined,
            // Multi-source pitch composing — editor queued N sources in the
            // pill. Server enriches the message with all of them so Maxwell
            // can propose a pitch that bundles them.
            context_attached_article_ids: (ctx && Array.isArray(ctx.additional_ids) && ctx.additional_ids.length) ? ctx.additional_ids : undefined,
          }),
        });
        typing.remove();

        if (resp.resolved_article_id && (!ctx || !ctx.id)) {
          // Server resolved an article via anaphora — sync pill
          if (window.ArticleContext) {
            window.ArticleContext.set({ id: resp.resolved_article_id, title: null });
          }
          refreshContextBadge();
        }

        if (resp.proposal) {
          if (resp.text) appendBubble('assistant', resp.text);
          appendProposal(resp.proposal);
        } else {
          if (resp.text) appendBubble('assistant', resp.text);
          if (resp.actions && resp.actions.length) resp.actions.forEach(appendAction);
          if (resp.parse_hint) appendParseHint(resp.parse_hint, text);
        }
      } catch (err) {
        typing.remove();
        appendBubble('assistant', '⚠️ ' + (err.message || 'Send failed'));
      } finally {
        sending = false;
        input.focus();
      }
    }

    // ── Styles ────────────────────────────────────────────
    (function styles() {
      if (document.getElementById('maxwellBubbleStyles')) return;
      var s = document.createElement('style');
      s.id = 'maxwellBubbleStyles';
      s.textContent = [
        '.mx-bubble { position:fixed; bottom:20px; right:20px; width:52px; height:52px; border-radius:50%; background:var(--primary, #7c3aed); color:#fff; border:0; font-size:22px; cursor:pointer; z-index:9999; box-shadow:0 6px 20px rgba(0,0,0,0.35); transition:transform 0.15s; }',
        '.mx-bubble:hover { transform:scale(1.06); }',
        // height uses dvh on mobile so the iOS Safari URL bar doesn't push
        // the form below the visible viewport. 100vh fallback for older
        // browsers that don't recognise dvh.
        '.mx-panel { position:fixed; top:0; right:0; width:min(420px, 95vw); height:100vh; height:100dvh; background:var(--bg-card, #1a1a1a); color:var(--text, #fff); border-left:1px solid var(--border, #333); transform:translateX(100%); transition:transform 0.25s ease-out; z-index:10000; display:flex; flex-direction:column; box-shadow:-8px 0 32px rgba(0,0,0,0.4); }',
        '.mx-panel.open { transform:translateX(0); }',
        '.mx-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--border, #333); flex-shrink:0; }',
        '.mx-head-title { font-size:14px; font-weight:600; flex-shrink:0; }',
        '.mx-head-icon { margin-right:4px; }',
        '.mx-head-sub { font-size:11px; color:var(--muted, #888); font-weight:400; margin-left:4px; }',
        '.mx-head-ctx { flex:1; min-width:0; font-size:11px; }',
        '.mx-head-ctx-pill { display:inline-block; background:var(--surface2, #1f1f1f); padding:3px 8px; border-radius:999px; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.mx-head-close, .mx-head-reset { background:none; border:0; color:var(--muted, #888); font-size:14px; cursor:pointer; padding:4px 8px; border-radius:6px; }',
        '.mx-head-close:hover, .mx-head-reset:hover { color:var(--text, #fff); background:var(--surface2, #222); }',
        '.mx-head-reset { font-size:15px; }',
        '.mx-thread { flex:1; overflow-y:auto; padding:12px 16px; display:flex; flex-direction:column; gap:8px; }',



        '.mx-bubble-msg { max-width:88%; padding:8px 12px; border-radius:12px; font-size:13px; line-height:1.45; word-wrap:break-word; }',
        '.mx-user      { align-self:flex-end;   background:var(--primary, #7c3aed); color:#fff; white-space:pre-wrap; }',
        '.mx-assistant { align-self:flex-start; background:var(--surface2, #1f1f1f); }',
        '.mx-assistant .mx-md-p { margin:0 0 4px; } .mx-assistant .mx-md-h1,.mx-assistant .mx-md-h2,.mx-assistant .mx-md-h3 { margin:6px 0 2px; font-weight:600; }',
        '.mx-assistant .mx-md-h1 { font-size:14px; } .mx-assistant .mx-md-h2 { font-size:13px; } .mx-assistant .mx-md-h3 { font-size:13px; color:var(--muted,#888); }',
        '.mx-assistant .mx-md-ul { margin:4px 0 4px 14px; padding:0; list-style:disc; } .mx-assistant .mx-md-ul-sub { margin:2px 0 2px 12px; list-style:circle; }',
        '.mx-assistant .mx-md-ul li { margin-bottom:2px; } .mx-assistant code { background:rgba(255,255,255,0.08); border-radius:3px; padding:1px 4px; font-size:12px; }',



        '.mx-typing { align-self:flex-start; font-size:12px; color:var(--muted, #888); padding:4px 8px; }',
        '.mx-card { align-self:flex-start; max-width:95%; background:var(--surface2, #1f1f1f); border:1px solid var(--border, #333); border-radius:10px; padding:10px 12px; font-size:13px; }',
        '.mx-card.done { opacity:0.6; }',
        '.mx-card-body { margin-bottom:8px; }',
        '.mx-card-meta { font-size:11px; color:var(--muted, #888); margin-bottom:6px; }',
        '.mx-card-sources { list-style:none; padding:0; margin:0 0 8px; font-size:12px; }',
        '.mx-card-sources li { padding:3px 0; color:var(--text, #fff); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '.mx-card-sources li::before { content:"· "; color:var(--muted, #888); }',
        '.mx-card-sources .mx-card-sources-more { color:var(--muted, #888); font-style:italic; }',
        '.mx-card-type-row { display:flex; align-items:center; gap:6px; margin-bottom:8px; font-size:12px; color:var(--muted, #888); }',
        '.mx-card-type-row .pitch-type-select { padding:3px 6px; background:var(--bg-card, #1a1a1a); border:1px solid var(--border, #333); color:var(--text, #fff); border-radius:5px; font-size:12px; font-family:inherit; }',
        '.mx-card-actions { display:flex; gap:6px; }',
        '.mx-card-approve { background:var(--primary, #7c3aed); color:#fff; border:0; padding:6px 12px; border-radius:6px; font-size:12px; cursor:pointer; }',
        '.mx-card-skip    { background:transparent; color:var(--muted, #888); border:1px solid var(--border, #333); padding:6px 12px; border-radius:6px; font-size:12px; cursor:pointer; }',
        '.mx-hint { align-self:stretch; font-size:12px; color:var(--muted, #888); background:var(--surface2, #1f1f1f); padding:8px 10px; border-radius:8px; display:flex; align-items:center; gap:10px; }',
        '.mx-hint-retry { margin-left:auto; background:transparent; border:1px solid var(--border, #333); color:var(--text, #fff); padding:4px 10px; border-radius:6px; font-size:11px; cursor:pointer; }',
        '.mx-form { display:flex; align-items:flex-end; gap:8px; padding:10px 12px; border-top:1px solid var(--border, #333); flex-shrink:0; }',
        '.mx-input { flex:1; background:var(--surface2, #1f1f1f); color:var(--text, #fff); border:1px solid var(--border, #333); border-radius:10px; padding:8px 12px; font-size:13px; resize:none; min-height:36px; max-height:120px; font-family:inherit; }',
        '.mx-input:focus { outline:none; border-color:var(--primary, #7c3aed); }',
        '.mx-send { background:var(--primary, #7c3aed); color:#fff; border:0; width:36px; height:36px; border-radius:50%; cursor:pointer; font-size:16px; flex-shrink:0; }',
        '.mx-send:disabled { opacity:0.5; cursor:not-allowed; }',
      ].join('\n');
      document.head.appendChild(s);
    })();

    // Refresh context badge when pill changes (poll — cheap)
    setInterval(function () {
      if (panel && panel.classList.contains('open')) refreshContextBadge();
    }, 2000);

    // Reset the whole session: clear the attached article context, wipe
    // the client-side thread DOM, and ask the server to forget our
    // conversation_history for this context key. Used by the header ↻
    // button, the Feed Inbox multi-source flow before starting a new
    // composition, and the auto-reset after a pitch is approved.
    async function resetThread(opts) {
      opts = opts || {};
      if (window.ArticleContext) window.ArticleContext.clear();
      if (thread) thread.innerHTML = '';
      if (maxwellId) {
        try { await apiFetch('/newsroom-chat/clear', { method: 'POST', body: JSON.stringify({ writer_id: maxwellId }) }); }
        catch (_) { /* silent — client is already reset, server drift is non-fatal */ }
      }
      if (!opts.silent && panel && panel.classList.contains('open')) {
        appendBubble('assistant', 'Fresh start — sources cleared, prior conversation dropped.');
      }
      refreshContextBadge();
      if (opts.keepOpen && panel && !panel.classList.contains('open')) openPanel();
    }

    window.Maxwell = {
      open:  function () { ensurePanel(); openPanel(); },
      close: function () { closePanel(); },
      reset: function (opts) { return resetThread(opts || {}); },
      ask: function (question, opts) {
        opts = opts || {};
        ensurePanel();
        openPanel();
        // Wait for openPanel's animation so focus/send land on ready DOM
        setTimeout(function () {
          if (!input) return;
          input.value = String(question || '');
          autosize();
          if (opts.autoSend) sendMessage();
          else input.focus();
        }, opts.autoSend ? 100 : 200);
      },
    };

    // Kick off discovery
    resolveMaxwell();
  });
})();
