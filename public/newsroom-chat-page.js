/* global apiFetch, renderSidebar */
(function () {
  'use strict';
  renderSidebar();

  var writers = [];
  var activeWriter = null;
  var currentUser = null;
  var sending = false;
  var activeArticleId = null;

  // Stable 12-hue palette matching lib/writer-colors.js (used as a fallback
  // when the signed-in editor hasn't set an avatar yet).
  var USER_PALETTE = ['#8b5cf6','#3b82f6','#06b6d4','#10b981','#22c55e','#eab308','#f97316','#ef4444','#ec4899','#a855f7','#14b8a6','#6366f1'];
  function userAccent(u) {
    var n = Number(u && u.id);
    if (!Number.isFinite(n)) return USER_PALETTE[0];
    return USER_PALETTE[((n % USER_PALETTE.length) + USER_PALETTE.length) % USER_PALETTE.length];
  }

  init();

  async function init() {
    await Promise.all([loadWriters(), loadCurrentUser()]);
    wireInput();
    document.getElementById('clearBtn').addEventListener('click', clearChat);
    document.getElementById('chatContextDismiss').addEventListener('click', function () {
      activeArticleId = null;
      document.getElementById('chatContextBar').style.display = 'none';
    });
    // Support URL params: ?writer_id=N (auto-select), ?article_id=N (load context), ?intent=pitch
    var params = new URLSearchParams(window.location.search);
    var preselect = parseInt(params.get('writer_id'), 10);
    var articleParam = parseInt(params.get('article_id'), 10);
    var intentParam = params.get('intent');
    if (articleParam) await setArticleContext(articleParam);
    if (preselect) await pickWriter(preselect);
    if (preselect && intentParam === 'pitch') autoSendPitchOpener();
    // Wire proposal approve/reject (event delegation on chat thread)
    document.getElementById('chatThread').addEventListener('click', handleProposalClick);
  }

  async function setArticleContext(articleId) {
    try {
      var data = await apiFetch('/articles/' + articleId);
      activeArticleId = articleId;
      var title = data.title || ('Article #' + articleId);
      document.getElementById('chatContextLabel').textContent = title;
      document.getElementById('chatContextBar').style.display = 'flex';
    } catch (err) {
      // best-effort — don't block the rest of init
    }
  }

  async function loadCurrentUser() {
    try {
      currentUser = await apiFetch('/auth/me');
    } catch (err) {
      currentUser = null;
    }
  }

  async function loadWriters() {
    var roster = document.getElementById('chatRoster');
    try {
      var data = await apiFetch('/newsroom-chat/writers');
      writers = data.writers || [];
      if (!writers.length) {
        roster.innerHTML = '<div class="chat-empty">No writers in the newsroom yet. Add some on /writers.</div>';
        return;
      }
      roster.innerHTML = writers.map(function (w) {
        var avatarInner = w.avatar_url
          ? '<img class="roster-avatar" src="' + esc(w.avatar_url) + '" alt="" />'
          : '<div class="roster-avatar" style="display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--muted);">' + esc((w.name || '?').charAt(0).toUpperCase()) + '</div>';
        var state = w.presence_state || 'idle';
        var dot = '<span class="presence-dot presence-' + esc(state) + '" title="' + esc(state) + '"></span>';
        return '<div class="roster-item" data-id="' + w.id + '">'
          + '<div class="roster-avatar-wrap">' + avatarInner + dot + '</div>'
          + '<div class="roster-meta">'
          + '<div class="roster-name">' + esc(w.name) + '</div>'
          + '<div class="roster-beat">' + esc(w.beat || 'newsroom') + ' · ' + esc(state) + ' · ' + (w.published_count || 0) + ' published</div>'
          + '</div></div>';
      }).join('');
      roster.querySelectorAll('.roster-item').forEach(function (el) {
        el.addEventListener('click', function () {
          var id = parseInt(el.dataset.id, 10);
          pickWriter(id);
        });
      });
    } catch (err) {
      roster.innerHTML = '<div class="chat-empty">Failed to load writers: ' + esc(err.message || err) + '</div>';
    }
  }

  async function pickWriter(id) {
    activeWriter = writers.find(function (w) { return w.id === id; });
    if (!activeWriter) return;
    document.querySelectorAll('.roster-item').forEach(function (el) {
      el.classList.toggle('active', parseInt(el.dataset.id, 10) === id);
    });
    document.getElementById('chatHeaderTitle').textContent = activeWriter.name;
    document.getElementById('chatHeaderMeta').textContent = activeWriter.beat || '';
    document.getElementById('chatFooter').style.display = '';
    var thread = document.getElementById('chatThread');
    thread.innerHTML = '<div class="chat-empty">Loading history…</div>';
    try {
      var data = await apiFetch('/newsroom-chat/history?writer_id=' + id);
      renderThread(data.messages || []);
    } catch (err) {
      thread.innerHTML = '<div class="chat-empty">Failed to load history: ' + esc(err.message || err) + '</div>';
    }
  }

  function writerInitial(name) {
    return (name || '?').trim().charAt(0).toUpperCase() || '?';
  }

  function avatarHtml(w) {
    var accent = (w && w.accent) || '#8b5cf6';
    if (w && w.avatar_url) {
      return '<img class="chat-avatar" src="' + esc(w.avatar_url) + '" alt="" />';
    }
    // Fallback monogram circle tinted with the writer's accent.
    return '<div class="chat-avatar chat-avatar-fallback" ' +
      'style="background:' + esc(accent) + ';color:#fff;">' +
      esc(writerInitial(w && w.name)) + '</div>';
  }

  function userAvatarHtml() {
    var accent = userAccent(currentUser);
    if (currentUser && currentUser.avatar_url) {
      return '<img class="chat-avatar" src="' + esc(currentUser.avatar_url) + '" alt="" />';
    }
    var initial = ((currentUser && (currentUser.display_name || currentUser.username)) || '').trim().charAt(0).toUpperCase() || 'Y';
    return '<div class="chat-avatar chat-avatar-fallback" ' +
      'style="background:' + esc(accent) + ';color:#fff;">' + esc(initial) + '</div>';
  }

  function bubbleHtml(role, text, w) {
    if (role === 'user') {
      // Editor (you) — right-aligned with your avatar mirroring writers on the left.
      return '<div class="chat-row chat-row-user">' +
        '<div class="chat-bubble user">' + linkify(esc(text)) + '</div>' +
        userAvatarHtml() +
        '</div>';
    }
    var accent = (w && w.accent) || '#8b5cf6';
    var name = esc((w && w.name) || 'Writer');
    // color-mix gives us a soft accent tint on the bubble background while
    // honoring whatever --bg-card the admin theme is using.
    var bg = 'color-mix(in oklab, var(--bg-card) 85%, ' + accent + ' 15%)';
    return '<div class="chat-row chat-row-assistant">' +
      avatarHtml(w) +
      '<div class="chat-bubble-wrap">' +
        '<div class="chat-bubble-name" style="color:' + esc(accent) + ';">' + name + '</div>' +
        '<div class="chat-bubble assistant" style="background:' + bg + ';">' +
          linkify(esc(text)) +
        '</div>' +
      '</div></div>';
  }

  function scrollToBottom() {
    var thread = document.getElementById('chatThread');
    // scrollIntoView on the last child is the most reliable approach —
    // the browser resolves the nearest scrollable ancestor itself, avoiding
    // flex-container height races that trip up direct scrollTop assignment.
    function doScroll() {
      var last = thread.lastElementChild;
      if (last) {
        last.scrollIntoView({ block: 'end', behavior: 'instant' });
      } else {
        thread.scrollTop = thread.scrollHeight;
      }
    }
    doScroll();
    // Second pass after flex reflow / input row visibility change settles
    setTimeout(doScroll, 80);
  }

  // Clean stored history content before display.
  // User turns may have server-injected context preambles; AI turns may have raw <<<PITCH:>>> blocks.
  function cleanHistoryContent(role, text) {
    if (!text) return text;
    if (role === 'user') {
      // Extract the editor's actual message from enriched preamble.
      // Pattern: "[context blocks]\n\nEditor: <message>\n\n[more injected blocks]"
      var editorMatch = text.match(/\bEditor:\s+([\s\S]*?)(?:\n\n\[|$)/);
      if (editorMatch) return editorMatch[1].trim();
      // Fallback: strip leading [block] sections if no Editor: marker
      var stripped = text.replace(/^\[[^\]]*\]\n*/g, '').trim();
      return stripped || text;
    }
    // Strip raw pitch/action machine markers from AI responses
    return text.replace(/\n*<<<PITCH:[\s\S]*?>>>\s*$/g, '').trim();
  }

  function renderThread(messages) {
    var thread = document.getElementById('chatThread');
    if (!messages.length) {
      thread.innerHTML = '<div class="chat-empty">No history yet. Say hi.</div>';
      return;
    }
    thread.innerHTML = messages.map(function (m) {
      var role = m.role === 'user' ? 'user' : 'assistant';
      return bubbleHtml(role, cleanHistoryContent(role, m.content), activeWriter);
    }).join('');
    scrollToBottom();
  }

  function appendBubble(role, text) {
    var thread = document.getElementById('chatThread');
    if (thread.querySelector('.chat-empty')) thread.innerHTML = '';
    var temp = document.createElement('div');
    temp.innerHTML = bubbleHtml(role, text, activeWriter);
    thread.appendChild(temp.firstChild);
    scrollToBottom();
  }

  function wireInput() {
    var input = document.getElementById('chatInput');
    var sendBtn = document.getElementById('sendBtn');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    sendBtn.addEventListener('click', sendMessage);
    wireAttachPanel();
  }

  var _attachSearchTimer;

  function wireAttachPanel() {
    var attachBtn = document.getElementById('chatAttachBtn');
    var panel = document.getElementById('chatAttachPanel');
    var searchInput = document.getElementById('chatAttachSearch');
    var results = document.getElementById('chatAttachResults');

    attachBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      attachBtn.classList.toggle('active', !open);
      if (!open) { searchInput.value = ''; searchInput.focus(); renderAttachResults([]); }
    });

    searchInput.addEventListener('input', function () {
      clearTimeout(_attachSearchTimer);
      var q = searchInput.value.trim();
      if (!q) { renderAttachResults([]); return; }
      _attachSearchTimer = setTimeout(function () { doAttachSearch(q); }, 250);
    });

    // Close on outside click
    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== attachBtn) {
        panel.style.display = 'none';
        attachBtn.classList.remove('active');
      }
    });

    results.addEventListener('click', function (e) {
      var item = e.target.closest('[data-attach-id]');
      if (!item) return;
      activeArticleId = parseInt(item.dataset.attachId, 10);
      var title = item.dataset.attachTitle || ('Article #' + activeArticleId);
      document.getElementById('chatContextLabel').textContent = title;
      document.getElementById('chatContextBar').style.display = 'flex';
      panel.style.display = 'none';
      attachBtn.classList.remove('active');
      document.getElementById('chatInput').focus();
    });
  }

  async function doAttachSearch(q) {
    var results = document.getElementById('chatAttachResults');
    results.innerHTML = '<div class="chat-attach-empty">Searching…</div>';
    try {
      var data = await apiFetch('/articles?search=' + encodeURIComponent(q) + '&limit=8');
      var articles = Array.isArray(data) ? data : (data.articles || []);
      renderAttachResults(articles);
    } catch (err) {
      results.innerHTML = '<div class="chat-attach-empty">Search failed</div>';
    }
  }

  function renderAttachResults(articles) {
    var results = document.getElementById('chatAttachResults');
    if (!articles.length) {
      results.innerHTML = '<div class="chat-attach-empty">No articles found</div>';
      return;
    }
    results.innerHTML = articles.map(function (a) {
      var meta = [a.category, a.content_type, a.source].filter(Boolean).join(' · ');
      return '<div class="chat-attach-result" data-attach-id="' + a.id + '" data-attach-title="' + esc(a.title || '') + '">'
        + '<div class="chat-attach-result-title">' + esc(a.title || '(untitled)') + '</div>'
        + (meta ? '<div class="chat-attach-result-meta">' + esc(meta) + '</div>' : '')
        + '</div>';
    }).join('');
  }

  // Auto-send the opening pitch message when navigating from Feed Inbox via 📋
  function autoSendPitchOpener() {
    var input = document.getElementById('chatInput');
    if (input) input.value = 'I found this story and think it could make a strong original piece. What angle would you take, and which writer should pitch it?';
    sendMessage('pitch');
  }

  async function sendMessage(intent) {
    if (sending || !activeWriter) return;
    var input = document.getElementById('chatInput');
    var text = input.value.trim();
    if (!text) return;
    sending = true;
    appendBubble('user', text);
    input.value = '';
    input.style.height = 'auto';
    var thread = document.getElementById('chatThread');
    var typing = document.createElement('div');
    typing.className = 'chat-typing';
    typing.textContent = activeWriter.name + ' is typing…';
    thread.appendChild(typing);
    scrollToBottom();
    try {
      var payload = { writer_id: activeWriter.id, message: text };
      if (activeArticleId) payload.context_article_id = activeArticleId;
      if (intent) payload.intent = intent;
      var resp = await apiFetch('/newsroom-chat', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      typing.remove();
      // If the server rehydrated an article from prior context (anaphora), sync
      // the context bar so the editor can see which article was used.
      if (resp.resolved_article_id && !activeArticleId) {
        activeArticleId = resp.resolved_article_id;
        var bar = document.getElementById('chatContextBar');
        var label = document.getElementById('chatContextLabel');
        if (bar && label) {
          label.textContent = 'Article #' + resp.resolved_article_id + ' (from context)';
          bar.style.display = 'flex';
        }
      }
      if (resp.proposal) {
        appendBubble('assistant', resp.text || '');
        appendProposalCard(resp.proposal);
      } else {
        appendBubble('assistant', resp.text || '(no response)');
        if (resp.actions && resp.actions.length) appendActionButtons(resp.actions);
        if (resp.parse_hint) appendParseHint(resp.parse_hint, text, intent);
      }
    } catch (err) {
      typing.remove();
      appendBubble('assistant', '⚠️ ' + (err.message || 'send failed'));
    } finally {
      sending = false;
      input.focus();
    }
  }

  function appendProposalCard(proposal) {
    var thread = document.getElementById('chatThread');
    var card = document.createElement('div');
    card.className = 'chat-proposal-card';
    card.dataset.proposal = JSON.stringify(proposal);

    var inner = '';
    if (proposal.proposal_type === 'thumbnail') {
      inner = '<div class="chat-proposal-preview">'
        + '<img src="' + esc(proposal.preview_url) + '" alt="Proposed thumbnail" class="chat-proposal-image" />'
        + '</div>';
    } else if (proposal.proposal_type === 'headline') {
      inner = '<div class="chat-proposal-headline">&ldquo;' + esc(proposal.new_headline) + '&rdquo;</div>'
        + (proposal.rationale ? '<div class="chat-proposal-rationale">' + esc(proposal.rationale) + '</div>' : '');
    }

    var approveLabel = proposal.proposal_type === 'headline'
      ? '✓ Apply headline'
      : (proposal.article_id ? '✓ Apply to article' : '✓ Looks good');
    inner += '<div class="chat-proposal-actions">'
      + '<button class="btn btn-primary btn-sm chat-proposal-approve">'+approveLabel+'</button>'
      + '<button class="btn btn-outline btn-sm chat-proposal-reject">✕ Skip</button>'
      + '</div>';

    card.innerHTML = inner;
    thread.appendChild(card);
    scrollToBottom();
  }

  // Renders action buttons returned by Maxwell (e.g. create_pitch).
  // Each action: { type, label, payload }
  function appendActionButtons(actions) {
    var thread = document.getElementById('chatThread');
    var card = document.createElement('div');
    card.className = 'chat-proposal-card';
    var inner = '<div class="chat-proposal-actions">';
    actions.forEach(function (action) {
      inner += '<button class="btn btn-primary btn-sm chat-action-btn" data-action="' + esc(JSON.stringify(action)) + '">' + esc(action.label) + '</button>';
    });
    inner += '<button class="btn btn-outline btn-sm chat-proposal-reject">✕ Skip</button>';
    inner += '</div>';
    card.innerHTML = inner;
    thread.appendChild(card);
    scrollToBottom();
  }

  // Inline banner shown when the backend detected a pitch recommendation but
  // couldn't parse the structured payload. Offers a Retry that re-sends the
  // original message so the model can regenerate the block.
  function appendParseHint(hint, originalText, originalIntent) {
    var thread = document.getElementById('chatThread');
    var banner = document.createElement('div');
    banner.className = 'chat-parse-hint';
    banner.innerHTML = '<span class="chat-parse-hint-text">' + esc(hint) + '</span>'
      + '<button class="btn btn-outline btn-sm chat-parse-hint-retry">↻ Retry</button>';
    thread.appendChild(banner);
    scrollToBottom();
    banner.querySelector('.chat-parse-hint-retry').addEventListener('click', function () {
      banner.remove();
      var input = document.getElementById('chatInput');
      if (input) input.value = originalText;
      sendMessage(originalIntent || 'pitch');
    });
  }

  async function handleProposalClick(e) {
    var approveBtn = e.target.closest('.chat-proposal-approve');
    var actionBtn  = e.target.closest('.chat-action-btn');
    var rejectBtn  = e.target.closest('.chat-proposal-reject');
    if (!approveBtn && !actionBtn && !rejectBtn) return;

    var card = e.target.closest('.chat-proposal-card');
    if (!card) return;

    // Disable buttons immediately to prevent double-click
    card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });

    if (rejectBtn) {
      card.classList.add('chat-proposal-dismissed');
      appendBubble('assistant', 'No problem — just let me know if you\'d like to try a different direction.');
      scrollToBottom();
      return;
    }

    // Action button (e.g. create_pitch from Maxwell)
    if (actionBtn) {
      try {
        var action = JSON.parse(actionBtn.dataset.action);
        var result = await apiFetch('/newsroom-chat/actions/approve', {
          method: 'POST',
          body: JSON.stringify(action),
        });
        card.classList.add('chat-proposal-applied');
        appendBubble('assistant', result.text || 'Done!');
      } catch (err) {
        card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        appendBubble('assistant', '⚠️ ' + (err.message || 'Failed to apply'));
      }
      scrollToBottom();
      return;
    }

    // Approve (existing tool proposal: thumbnail, headline)
    try {
      var proposal = JSON.parse(card.dataset.proposal);
      var result = await apiFetch('/newsroom-chat/actions/approve', {
        method: 'POST',
        body: JSON.stringify(proposal),
      });
      card.classList.add('chat-proposal-applied');
      appendBubble('assistant', result.text || 'Done!');
    } catch (err) {
      card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      appendBubble('assistant', '⚠️ ' + (err.message || 'Failed to apply'));
    }
    scrollToBottom();
  }

  async function clearChat() {
    if (!activeWriter) return;
    if (!confirm('Clear conversation history with ' + activeWriter.name + '?')) return;
    try {
      await apiFetch('/newsroom-chat/clear', {
        method: 'POST',
        body: JSON.stringify({ writer_id: activeWriter.id }),
      });
      document.getElementById('chatThread').innerHTML = '<div class="chat-empty">Cleared. Say hi.</div>';
    } catch (err) {
      alert('Clear failed: ' + (err.message || err));
    }
  }

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function linkify(html) {
    // URLs ending in an image extension render as inline <img>; other URLs as
    // clickable links. Lets Iris drop a generated image_url straight into a
    // reply and have it appear in the bubble. Strip a trailing markdown ")"
    // so "![...](url)" syntax works too.
    return html.replace(/(https?:\/\/[^\s<]+)/g, function (full) {
      var url = full.replace(/[)\].,;!?]+$/, '');
      var trailing = full.slice(url.length);
      var isImage = /\.(png|jpe?g|webp|gif)(\?[^\s]*)?$/i.test(url);
      if (isImage) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' +
          '<img src="' + url + '" alt="" class="chat-inline-image" ' +
          'style="display:block;max-width:100%;max-height:360px;border-radius:8px;margin:6px 0;" />' +
          '</a>' + trailing;
      }
      return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>' + trailing;
    });
  }
})();
