/* eslint-disable no-unused-vars */
/* global apiFetch */
(function () {
  'use strict';

  renderSidebar();

  var allMessages = [];
  var activeFilter = 'all';

  init();

  async function init() {
    setupFilters();
    await loadFeed();
  }

  function setupFilters() {
    document.getElementById('feedFilters').addEventListener('click', function (e) {
      var btn = e.target.closest('.feed-filter');
      if (!btn) return;
      document.querySelectorAll('.feed-filter').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeFilter = btn.dataset.type;
      renderFeed();
    });
  }

  async function loadFeed() {
    try {
      var data = await apiFetch('/admin/pitches/newsroom?limit=100');
      allMessages = data.messages || [];
      renderFeed();
    } catch (err) {
      document.getElementById('feedList').innerHTML = '<div class="feed-empty">Failed to load feed: ' + (err.message || err) + '</div>';
    }
  }

  function renderFeed() {
    var list = document.getElementById('feedList');
    var filtered = activeFilter === 'all'
      ? allMessages
      : allMessages.filter(function (m) { return m.message_type === activeFilter; });

    if (!filtered.length) {
      list.innerHTML = '<div class="feed-empty">' + (allMessages.length ? 'No messages matching this filter.' : 'No newsroom activity yet. Messages will appear here as agents synthesize articles and the editor reviews them.') + '</div>';
      return;
    }

    list.innerHTML = filtered.map(function (m) {
      var typeLabel = {
        'coordination': 'Coordination',
        'editorial-review': 'Editorial',
        'pitch': 'Pitch',
        'admin': 'Admin',
      }[m.message_type] || m.message_type;

      var typeClass = 'feed-type-' + (m.message_type || '').replace(/[^a-z-]/g, '');

      var avatarHtml = m.from_writer_avatar
        ? '<img src="' + esc(m.from_writer_avatar) + '" class="feed-avatar" />'
        : '<div class="feed-avatar-placeholder">' + (m.from_writer_name ? esc(m.from_writer_name.charAt(0)) : '?') + '</div>';

      var targetHtml = '';
      if (m.to_writer_name) {
        targetHtml = '<div class="feed-target">To: ' + esc(m.to_writer_name) + '</div>';
      }

      // Parse context for extra info
      var context = m.context;
      if (typeof context === 'string') try { context = JSON.parse(context); } catch { context = {}; }
      var verdictHtml = '';
      if (context?.verdict) {
        var v = context.verdict;
        var scoreClass = v.score >= 7 ? 'color:#22c55e' : v.score >= 4 ? 'color:#fbbf24' : 'color:#ef4444';
        verdictHtml = '<div style="margin-top:6px;font-size:12px;">';
        verdictHtml += '<span style="' + scoreClass + ';font-weight:700;">Score: ' + v.score + '/10</span>';
        if (v.publish) verdictHtml += ' <span style="color:#22c55e;">Approved</span>';
        else verdictHtml += ' <span style="color:#ef4444;">Flagged</span>';
        if (v.issues && v.issues.length) {
          verdictHtml += '<div style="margin-top:4px;color:var(--muted);">' + v.issues.map(function (i) { return '- ' + esc(i); }).join('<br>') + '</div>';
        }
        verdictHtml += '</div>';
      }

      return '<div class="feed-item">'
        + avatarHtml
        + '<div class="feed-body">'
        + '<div class="feed-header">'
        + '<span class="feed-name">' + esc(m.from_writer_name || 'System') + '</span>'
        + '<span class="feed-type ' + typeClass + '">' + esc(typeLabel) + '</span>'
        + '<span class="feed-time">' + timeSince(new Date(m.created_at)) + '</span>'
        + '</div>'
        + '<div class="feed-content">' + esc(m.content) + '</div>'
        + targetHtml
        + verdictHtml
        + '</div>'
        + '</div>';
    }).join('');
  }

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function timeSince(date) {
    var seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }
})();
