/* global apiFetch, renderSidebar */
(function () {
  'use strict';
  renderSidebar();

  init();

  async function init() {
    document.getElementById('typeFilter').addEventListener('change', load);
    document.getElementById('daysFilter').addEventListener('change', load);
    document.getElementById('refreshBtn').addEventListener('click', load);
    await load();
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

  function renderCard(e) {
    var actor = e.actor_writer_name || (e.actor_user_id ? 'Editor' : 'System');
    var avatar = e.actor_writer_avatar
      ? '<img class="feed-avatar" src="' + esc(e.actor_writer_avatar) + '" alt="" />'
      : '<div class="feed-avatar">' + esc((actor || '?').charAt(0).toUpperCase()) + '</div>';
    var when = relativeTime(new Date(e.created_at));
    var payload = e.payload || {};
    var tagClass = 'tag-' + e.event_type.replace(/\W/g, '_');

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
    } else {
      inner = '<div class="feed-snippet">' + esc(JSON.stringify(payload).slice(0, 200)) + '</div>';
    }

    return '<div class="feed-card">'
      + '<div class="feed-card-header">'
      + avatar
      + '<div class="feed-actor">' + esc(actor) + '</div>'
      + '<span class="feed-event-tag ' + tagClass + '">' + esc(e.event_type) + '</span>'
      + '<span class="feed-time">' + when + '</span>'
      + '</div>'
      + inner
      + '</div>';
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
