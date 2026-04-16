/* global apiFetch, renderSidebar */
(function () {
  'use strict';
  renderSidebar();

  init();

  var broadcasting = false;

  async function init() {
    document.getElementById('typeFilter').addEventListener('change', load);
    document.getElementById('daysFilter').addEventListener('change', load);
    document.getElementById('refreshBtn').addEventListener('click', load);
    document.getElementById('broadcastBtn').addEventListener('click', sendBroadcast);
    document.getElementById('broadcastInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendBroadcast();
    });
    document.getElementById('briefBtn').addEventListener('click', triggerBrief);
    document.getElementById('digestBtn').addEventListener('click', triggerDigest);
    await load();
  }

  async function sendBroadcast() {
    if (broadcasting) return;
    var input = document.getElementById('broadcastInput');
    var msg = input.value.trim();
    if (!msg) return;
    broadcasting = true;
    document.getElementById('broadcastBtn').disabled = true;
    document.getElementById('broadcastRouting').textContent = 'Routing to writers…';
    try {
      var data = await apiFetch('/newsroom-feed/broadcast', {
        method: 'POST',
        body: JSON.stringify({ message: msg }),
      });
      input.value = '';
      var routed = data.routed_to && data.routed_to.length ? data.routed_to.join(', ') : 'no writers matched';
      document.getElementById('broadcastRouting').textContent = 'Sent · routing to: ' + routed + ' (replies loading…)';
      await load();
      // Auto-open the replies thread for the new broadcast event after a brief delay
      if (data.event_id) {
        setTimeout(function () {
          var thread = document.querySelector('[data-thread="' + data.event_id + '"]');
          if (thread && !thread.classList.contains('open')) {
            thread.classList.add('open');
            loadReplies(data.event_id);
          }
        }, 2500);
      }
    } catch (err) {
      document.getElementById('broadcastRouting').textContent = 'Failed: ' + esc(err.message || err);
    } finally {
      broadcasting = false;
      document.getElementById('broadcastBtn').disabled = false;
    }
  }

  async function triggerBrief() {
    var btn = document.getElementById('briefBtn');
    btn.disabled = true;
    btn.textContent = '📋 Generating…';
    try {
      await apiFetch('/newsroom-feed/trigger-brief', { method: 'POST' });
      btn.textContent = '📋 Generating (check feed in ~30s)';
      setTimeout(function () { btn.textContent = '📋 Generate Day Brief'; btn.disabled = false; load(); }, 30000);
    } catch (err) {
      btn.textContent = '📋 Generate Day Brief';
      btn.disabled = false;
      alert('Failed: ' + (err.message || err));
    }
  }

  async function triggerDigest() {
    var btn = document.getElementById('digestBtn');
    btn.disabled = true;
    btn.textContent = '📰 Generating…';
    try {
      await apiFetch('/newsroom-feed/trigger-digest', { method: 'POST' });
      btn.textContent = '📰 Generating (check feed in ~45s)';
      setTimeout(function () { btn.textContent = '📰 Generate Week in Review'; btn.disabled = false; load(); }, 45000);
    } catch (err) {
      btn.textContent = '📰 Generate Week in Review';
      btn.disabled = false;
      alert('Failed: ' + (err.message || err));
    }
  }

  async function load() {
    var stream = document.getElementById('feedStream');
    stream.innerHTML = '<div class="feed-empty">Loading…</div>';
    var type = document.getElementById('typeFilter').value;
    var days = document.getElementById('daysFilter').value;
    var qs = '?days=' + encodeURIComponent(days);
    if (type) qs += '&type=' + encodeURIComponent(type);
    try {
      var data = await apiFetch('/newsroom-feed' + qs);
      render(data.events || []);
    } catch (err) {
      stream.innerHTML = '<div class="feed-empty">Failed to load: ' + esc(err.message || err) + '</div>';
    }
  }

  function render(events) {
    var stream = document.getElementById('feedStream');
    if (!events.length) {
      stream.innerHTML = '<div class="feed-empty">No activity in this window.</div>';
      return;
    }
    stream.innerHTML = events.map(renderCard).join('');
  }

  var EMOJIS = ['🔥', '💡', '🚩', '👀'];

  function renderCard(e) {
    var actor = e.actor_writer_name || (e.actor_user_id ? 'Editor' : 'System');
    var avatar = e.actor_writer_avatar
      ? '<img class="feed-avatar" src="' + esc(e.actor_writer_avatar) + '" alt="" />'
      : '<div class="feed-avatar">' + esc((actor || '?').charAt(0).toUpperCase()) + '</div>';
    var when = relativeTime(new Date(e.created_at));
    var payload = e.payload || {};
    var tagClass = 'tag-' + e.event_type.replace(/\W/g, '_');
    var reactions = e.reactions || {};
    var replyCount = e.reply_count || 0;

    var inner = '';
    if (e.event_type === 'published') {
      var link = payload.slug ? '<a class="feed-link" href="/articles.html?id=' + e.target_article_id + '" target="_blank">View →</a>' : '';
      inner = '<div class="feed-title">' + esc(payload.title || '(untitled)') + '</div>'
        + (payload.summary ? '<div class="feed-snippet">' + esc(payload.summary) + '</div>' : '')
        + '<div class="feed-meta">'
        + (payload.category ? '<span>' + esc(payload.category) + '</span>' : '')
        + (payload.content_type ? '<span>' + esc(payload.content_type) + '</span>' : '')
        + '<span>' + link + '</span>'
        + '</div>';
    } else if (e.event_type === 'pitched') {
      inner = '<div class="feed-title">Pitch on "' + esc(payload.source_title || '(source)') + '"</div>'
        + (payload.angle_summary ? '<div class="feed-snippet">' + esc(payload.angle_summary) + '</div>' : '')
        + '<div class="feed-meta"><a class="feed-link" href="/editorial.html">Review →</a></div>';
    } else if (e.event_type === 'pitch_approved') {
      inner = '<div class="feed-snippet">Pitch #' + e.target_pitch_id + ' approved'
        + (payload.override ? ' <strong>(over cap)</strong>' : '') + '.</div>'
        + (payload.note ? '<div class="feed-meta">Note: ' + esc(payload.note) + '</div>' : '');
    } else if (e.event_type === 'pitch_rejected') {
      inner = '<div class="feed-snippet">Pitch #' + e.target_pitch_id + ' rejected.</div>'
        + (payload.note ? '<div class="feed-meta">Note: ' + esc(payload.note) + '</div>' : '');
    } else if (e.event_type === 'enriched') {
      inner = '<div class="feed-title">External research ingested</div>'
        + '<div class="feed-snippet">' + (payload.ingested_count || 0) + ' article(s) added from web search.'
        + (payload.sample_titles && payload.sample_titles.length ? ' Sample: ' + esc(payload.sample_titles.join(' · ')) : '')
        + '</div>';
    } else if (e.event_type === 'standup') {
      inner = longTextCard(payload.text, 'Morning standup');
    } else if (e.event_type === 'editor_broadcast') {
      inner = '<div class="feed-title">📣 ' + esc(payload.text || '') + '</div>'
        + (replyCount > 0 ? '' : '<div class="feed-meta" style="color:var(--muted);font-size:12px;">Routing to writers — replies will appear below.</div>');
    } else if (e.event_type === 'daily_brief') {
      inner = '<div class="feed-title">' + (payload.manual ? '📋 Day Brief (manual)' : '📋 End-of-Day Brief') + '</div>'
        + longTextCard(payload.text, null);
    } else if (e.event_type === 'weekly_digest') {
      inner = '<div class="feed-title">' + (payload.manual ? '📰 Week in Review (manual)' : '📰 Week in Review') + '</div>'
        + longTextCard(payload.text, null);
    } else {
      inner = '<div class="feed-snippet">' + esc(JSON.stringify(payload).slice(0, 200)) + '</div>';
    }

    var reactBtns = EMOJIS.map(function (em) {
      var cnt = reactions[em] || 0;
      var cls = 'react-btn' + (cnt > 0 ? ' has-count' : '');
      return '<button class="' + cls + '" data-event="' + e.id + '" data-emoji="' + em + '">'
        + em + (cnt > 0 ? ' ' + cnt : '') + '</button>';
    }).join('');

    var replyBtn = '<button class="reply-toggle" data-toggle-replies="' + e.id + '">'
      + '💬 ' + (replyCount > 0 ? replyCount + ' ' : '') + 'Replies'
      + '</button>';

    var threadDiv = '<div class="reply-thread" data-thread="' + e.id + '">'
      + '<div class="reply-list" data-replies="' + e.id + '">Loading…</div>'
      + '<div class="reply-input-row">'
      + '<input type="text" data-reply-input="' + e.id + '" placeholder="Reply…" />'
      + '<button class="btn btn-primary btn-sm" data-reply-send="' + e.id + '">Send</button>'
      + '</div></div>';

    return '<div class="feed-card">'
      + '<div class="feed-card-header">'
      + avatar
      + '<div class="feed-actor">' + esc(actor) + '</div>'
      + '<span class="feed-event-tag ' + tagClass + '">' + esc(e.event_type) + '</span>'
      + '<span class="feed-time">' + when + '</span>'
      + '</div>'
      + inner
      + '<div class="feed-actions">' + reactBtns + replyBtn + '</div>'
      + threadDiv
      + '</div>';
  }

  // Render a collapsible long-text block (for standups, briefs, digests)
  function longTextCard(text, label) {
    if (!text) return label ? '<div class="feed-snippet">' + esc(label) + '</div>' : '';
    var id = 'lt-' + Math.random().toString(36).slice(2);
    var short = text.length > 400;
    return (label ? '<div class="feed-snippet" style="color:var(--muted);font-size:11px;margin-bottom:4px;">' + esc(label) + '</div>' : '')
      + '<div class="feed-long-text' + (short ? ' collapsed' : '') + '" id="' + id + '">' + esc(text) + '</div>'
      + (short ? '<button class="feed-expand-btn" data-expand="' + id + '">Show more</button>' : '');
  }

  // Wire reaction + reply handlers (event-delegated on stream container)
  document.addEventListener('click', async function (ev) {
    var t = ev.target;
    if (t.dataset && t.dataset.expand) {
      var el = document.getElementById(t.dataset.expand);
      if (el) {
        el.classList.remove('collapsed');
        t.style.display = 'none';
      }
      return;
    }
    if (t.classList && t.classList.contains('react-btn')) {
      var eventId = t.dataset.event;
      var emoji = t.dataset.emoji;
      try {
        await apiFetch('/newsroom-feed/' + eventId + '/react', {
          method: 'POST', body: JSON.stringify({ emoji: emoji }),
        });
        load(); // refetch to update tallies
      } catch (err) {
        if (err && err.message && err.message.includes('not enabled')) {
          alert('Reactions need the Newsroom Social feature flag.');
        } else {
          alert('Reaction failed: ' + (err.message || err));
        }
      }
    } else if (t.dataset && t.dataset.toggleReplies) {
      var id = t.dataset.toggleReplies;
      var thread = document.querySelector('[data-thread="' + id + '"]');
      thread.classList.toggle('open');
      if (thread.classList.contains('open')) loadReplies(id);
    } else if (t.dataset && t.dataset.replySend) {
      var id2 = t.dataset.replySend;
      var input = document.querySelector('[data-reply-input="' + id2 + '"]');
      var content = input.value.trim();
      if (!content) return;
      try {
        await apiFetch('/newsroom-feed/' + id2 + '/replies', {
          method: 'POST', body: JSON.stringify({ content: content }),
        });
        input.value = '';
        await loadReplies(id2);
      } catch (err) {
        alert('Reply failed: ' + (err.message || err));
      }
    }
  });

  async function loadReplies(eventId) {
    var listEl = document.querySelector('[data-replies="' + eventId + '"]');
    if (!listEl) return;
    try {
      var data = await apiFetch('/newsroom-feed/' + eventId + '/replies');
      var replies = data.replies || [];
      if (!replies.length) {
        listEl.innerHTML = '<div class="text-muted" style="font-size:12px;">No replies yet.</div>';
        return;
      }
      listEl.innerHTML = replies.map(function (r) {
        var who = r.author_writer_name || r.author_user_name || 'User';
        return '<div class="reply-item">'
          + '<span class="reply-author">' + esc(who) + '</span>'
          + '<span class="reply-time">' + relativeTime(new Date(r.created_at)) + '</span>'
          + '<div>' + esc(r.content) + '</div>'
          + '</div>';
      }).join('');
    } catch (err) {
      listEl.innerHTML = '<div class="text-muted" style="font-size:12px;color:var(--danger);">Failed: ' + esc(err.message || err) + '</div>';
    }
  }

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = String(str || '');
    return d.innerHTML;
  }

  function relativeTime(date) {
    var s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    return d + 'd ago';
  }
})();
