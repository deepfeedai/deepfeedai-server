/* global apiFetch, renderSidebar */
(function () {
  'use strict';
  renderSidebar();

  var writers = [];
  var activeWriter = null;
  var sending = false;

  init();

  async function init() {
    await loadWriters();
    wireInput();
    document.getElementById('clearBtn').addEventListener('click', clearChat);
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

  function renderThread(messages) {
    var thread = document.getElementById('chatThread');
    if (!messages.length) {
      thread.innerHTML = '<div class="chat-empty">No history yet. Say hi.</div>';
      return;
    }
    thread.innerHTML = messages.map(function (m) {
      var cls = m.role === 'user' ? 'user' : 'assistant';
      return '<div class="chat-bubble ' + cls + '">' + linkify(esc(m.content)) + '</div>';
    }).join('');
    thread.scrollTop = thread.scrollHeight;
  }

  function appendBubble(role, text) {
    var thread = document.getElementById('chatThread');
    if (thread.querySelector('.chat-empty')) thread.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'chat-bubble ' + (role === 'user' ? 'user' : 'assistant');
    div.innerHTML = linkify(esc(text));
    thread.appendChild(div);
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
    return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
})();
