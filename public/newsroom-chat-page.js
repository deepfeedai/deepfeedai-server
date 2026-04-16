/* global apiFetch, renderSidebar */
(function () {
  'use strict';
  renderSidebar();

  var writers = [];
  var activeWriter = null;
  var currentUser = null;
  var sending = false;

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
    // Support ?writer_id=N to auto-select a writer (e.g. deep-link from broadcast feed)
    var params = new URLSearchParams(window.location.search);
    var preselect = parseInt(params.get('writer_id'), 10);
    if (preselect) pickWriter(preselect);
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
    document.getElementById('clearBtn').style.display = '';
    document.getElementById('chatInputRow').style.display = '';
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

  function renderThread(messages) {
    var thread = document.getElementById('chatThread');
    if (!messages.length) {
      thread.innerHTML = '<div class="chat-empty">No history yet. Say hi.</div>';
      return;
    }
    thread.innerHTML = messages.map(function (m) {
      return bubbleHtml(m.role === 'user' ? 'user' : 'assistant', m.content, activeWriter);
    }).join('');
    thread.scrollTop = thread.scrollHeight;
  }

  function appendBubble(role, text) {
    var thread = document.getElementById('chatThread');
    if (thread.querySelector('.chat-empty')) thread.innerHTML = '';
    var temp = document.createElement('div');
    temp.innerHTML = bubbleHtml(role, text, activeWriter);
    thread.appendChild(temp.firstChild);
    thread.scrollTop = thread.scrollHeight;
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
  }

  async function sendMessage() {
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
    thread.scrollTop = thread.scrollHeight;
    try {
      var resp = await apiFetch('/newsroom-chat', {
        method: 'POST',
        body: JSON.stringify({ writer_id: activeWriter.id, message: text }),
      });
      typing.remove();
      appendBubble('assistant', resp.text || '(no response)');
    } catch (err) {
      typing.remove();
      appendBubble('assistant', '⚠️ ' + (err.message || 'send failed'));
    } finally {
      sending = false;
      input.focus();
    }
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
