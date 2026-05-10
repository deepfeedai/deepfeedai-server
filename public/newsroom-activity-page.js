/* global apiFetch, renderSidebar */
(function () {
  'use strict';
  renderSidebar();

  init();
  window.pageRefresh = load;

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
          document.getElementById('broadcastRouting').textContent = '';
        }, 2500);
      } else {
        document.getElementById('broadcastRouting').textContent = '';
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
      btn.textContent = '📋 Brief posted';
      await load();
      setTimeout(function () { btn.textContent = '📋 Generate Day Brief'; btn.disabled = false; }, 3000);
    } catch (err) {
      btn.textContent = '📋 Generate Day Brief';
      btn.disabled = false;
      alert('Brief failed: ' + (err.message || err));
    }
  }

  async function triggerDigest() {
    var btn = document.getElementById('digestBtn');
    btn.disabled = true;
    btn.textContent = '📰 Generating…';
    try {
      await apiFetch('/newsroom-feed/trigger-digest', { method: 'POST' });
      btn.textContent = '📰 Digest posted';
      await load();
      setTimeout(function () { btn.textContent = '📰 Generate Week in Review'; btn.disabled = false; }, 3000);
    } catch (err) {
      btn.textContent = '📰 Generate Week in Review';
      btn.disabled = false;
      alert('Digest failed: ' + (err.message || err));
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
    hydrateBriefFeedback();
  }

  // After the feed renders, fetch each visible brief's existing feedback so
  // the current user's prior vote shows as active. One request per brief —
  // cheap and simple; could batch later if the feed grows.
  function hydrateBriefFeedback() {
    document.querySelectorAll('[data-brief-feedback]').forEach(async function (wrap) {
      var eventId = wrap.getAttribute('data-brief-feedback');
      try {
        var data = await apiFetch('/newsroom-feed/' + eventId + '/feedback');
        if (data.my_vote) {
          var btn = wrap.querySelector('[data-brief-vote="' + data.my_vote + '"]');
          if (btn) btn.classList.add('active');
        }
      } catch (_) { /* silent — feedback UI isn't critical */ }
    });
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
    } else if (e.event_type === 'daily_brief' || e.event_type === 'weekly_digest') {
      var isWeekly = e.event_type === 'weekly_digest';
      var titleIcon = isWeekly ? '📰' : '📋';
      var titleText = isWeekly
        ? (payload.manual ? 'Week in Review (manual)' : 'Week in Review')
        : (payload.manual ? 'Day Brief (manual)' : 'End-of-Day Brief');
      var title = '<div class="feed-title">' + titleIcon + ' ' + esc(titleText) + '</div>';
      var feedbackRow = '<div class="brief-feedback" data-brief-feedback="' + e.id + '">'
        + '<button class="brief-thumb" data-brief-vote="up" title="Good brief">👍</button>'
        + '<button class="brief-thumb" data-brief-vote="down" title="Needs adjustment">👎</button>'
        + '<span class="brief-feedback-status"></span>'
        + '</div>';
      if (payload.version === 2) {
        inner = title + renderBriefCard(payload) + feedbackRow;
      } else {
        inner = title + longTextCard(payload.text, null) + feedbackRow;
      }
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

    // Broadcast threads redirect to per-writer chat rather than posting static replies
    var isBroadcast = e.event_type === 'editor_broadcast';
    var replyInputRow = isBroadcast
      ? '<div class="feed-meta" style="color:var(--muted);font-size:12px;margin-top:8px;">To continue a conversation, click "Chat →" next to a writer\'s reply.</div>'
      : '<div class="reply-input-row">'
        + '<input type="text" data-reply-input="' + e.id + '" placeholder="Reply…" />'
        + '<button class="btn btn-primary btn-sm" data-reply-send="' + e.id + '">Send</button>'
        + '</div>';
    var threadDiv = '<div class="reply-thread" data-thread="' + e.id + '">'
      + '<div class="reply-list" data-replies="' + e.id + '">Loading…</div>'
      + replyInputRow
      + '</div>';

    var dismissBtn = '<button class="feed-dismiss-btn" data-dismiss-event="' + e.id + '" title="Dismiss">✕</button>';
    return '<div class="feed-card">'
      + '<div class="feed-card-header">'
      + avatar
      + '<div class="feed-actor">' + esc(actor) + '</div>'
      + '<span class="feed-event-tag ' + tagClass + '">' + esc(e.event_type) + '</span>'
      + '<span class="feed-time">' + when + '</span>'
      + dismissBtn
      + '</div>'
      + inner
      + '<div class="feed-actions">' + reactBtns + replyBtn + '</div>'
      + threadDiv
      + '</div>';
  }

  // Render a collapsible long-text block (for standups, briefs, digests)
  // ── Structured brief rendering (version 2) ────────────────
  //
  // Renders a version-2 brief payload as a rich card:
  //   • headline
  //   • hero metric chips with trend arrows (vs baseline)
  //   • top-priority callout (if present)
  //   • highlights list (linked where possible)
  //   • coverage gaps
  //   • action items
  //   • expandable prose section
  //
  // All links route to the admin via onclick-less <a href> so right-click →
  // open-in-new-tab works too. Server computes every number; the LLM only
  // labels/explains.
  function renderBriefCard(payload) {
    var parts = [];

    if (payload.headline) {
      parts.push('<div class="brief-headline">' + esc(payload.headline) + '</div>');
    }

    var metrics = payload.metrics || {};
    var metricKeys = Object.keys(metrics);
    if (metricKeys.length) {
      parts.push('<div class="brief-metrics">' + metricKeys.map(function (key) {
        var m = metrics[key];
        return renderMetricChip(key, m);
      }).join('') + '</div>');
    }

    if (payload.top_priority && payload.top_priority.label) {
      var tp = payload.top_priority;
      var cta = tp.cta ? '<span class="brief-priority-cta">' + esc(tp.cta) + ' →</span>' : '';
      var inner = '<span class="brief-priority-icon">⚡</span>'
        + '<span class="brief-priority-label">' + esc(tp.label) + '</span>'
        + cta;
      parts.push(tp.link
        ? '<a class="brief-priority" href="' + esc(tp.link) + '">' + inner + '</a>'
        : '<div class="brief-priority">' + inner + '</div>');
    }

    var highlights = Array.isArray(payload.highlights) ? payload.highlights : [];
    if (highlights.length) {
      parts.push('<div class="brief-section"><div class="brief-section-title">Highlights</div>'
        + '<ul class="brief-list">'
        + highlights.map(function (h) {
          var icon = highlightIcon(h.type);
          var body = '<span class="brief-list-icon">' + icon + '</span>'
            + '<span class="brief-list-title">' + esc(h.title || '') + '</span>'
            + (h.writer ? '<span class="brief-list-meta">· ' + esc(h.writer) + '</span>' : '')
            + (h.note ? '<span class="brief-list-meta">· ' + esc(h.note) + '</span>' : '');
          return '<li>' + (h.link ? '<a href="' + esc(h.link) + '">' + body + '</a>' : body) + '</li>';
        }).join('')
        + '</ul></div>');
    }

    var gaps = Array.isArray(payload.gaps) ? payload.gaps : [];
    if (gaps.length) {
      parts.push('<div class="brief-section"><div class="brief-section-title">Coverage gaps</div>'
        + '<div class="brief-gaps">' + gaps.map(function (g) {
          var label = g.beat + (g.days ? ' · ' + g.days + 'd' : '') + (g.note ? ' · ' + g.note : '');
          return '<span class="brief-gap-chip">' + esc(label) + '</span>';
        }).join('') + '</div></div>');
    }

    var actionItems = Array.isArray(payload.action_items) ? payload.action_items : [];
    if (actionItems.length) {
      parts.push('<div class="brief-section"><div class="brief-section-title">Action items</div>'
        + '<div class="brief-actions">' + actionItems.map(function (a) {
          if (a.action && a.action.endpoint) {
            // Inline-executable — encode action payload via encodeURIComponent
            // so quotes inside JSON can't escape the attribute. Click handler
            // decodes + parses.
            var encoded = encodeURIComponent(JSON.stringify(a.action));
            return '<button class="brief-action-btn brief-action-exec" data-brief-action="' + encoded + '">'
              + esc(a.label || '') + '</button>';
          }
          return '<a class="brief-action-btn" href="' + esc(a.link || '#') + '">' + esc(a.label || '') + ' →</a>';
        }).join('') + '</div></div>');
    }

    if (payload.prose) {
      parts.push('<div class="brief-section"><div class="brief-section-title">Editor\'s note</div>'
        + longTextCard(payload.prose, null) + '</div>');
    }

    return parts.join('');
  }

  function renderMetricChip(key, m) {
    if (!m || typeof m.value === 'undefined') return '';
    var label = METRIC_LABELS[key] || key.replace(/_/g, ' ');
    var display = formatMetricValue(key, m.value);
    var trendHtml = '';
    if (m.trend && m.trend !== 'flat' && m.delta_pct != null) {
      var arrow = m.trend === 'up' ? '↑' : '↓';
      var sign = m.delta_pct > 0 ? '+' : '';
      var cls = 'brief-metric-trend brief-trend-' + (isGoodTrend(key, m.trend) ? 'good' : 'bad');
      trendHtml = '<span class="' + cls + '">' + arrow + ' ' + sign + m.delta_pct + '%</span>';
    }
    // Clickable → opens Maxwell with a prefilled question about this metric.
    // Encode key + raw value so the handler can build a rich prompt even
    // after the card is re-rendered.
    var metricData = encodeURIComponent(JSON.stringify({ key: key, value: m.value, baseline: m.baseline, delta_pct: m.delta_pct, trend: m.trend }));
    return '<button class="brief-metric brief-metric-clickable" data-brief-metric="' + metricData + '" title="Ask Maxwell about this">'
      + '<div class="brief-metric-value">' + esc(display) + '</div>'
      + '<div class="brief-metric-label">' + esc(label) + '</div>'
      + trendHtml
      + '</button>';
  }

  // Build a contextual question for Maxwell based on the metric the editor
  // tapped. Keep questions concise; Maxwell already has the day's data in
  // the conversation context key and can elaborate.
  function metricQuestion(m) {
    var key = m.key;
    var v = m.value;
    var dp = m.delta_pct;
    var trendWord = dp == null ? '' : (dp > 0 ? ' (up ' + dp + '%)' : ' (down ' + Math.abs(dp) + '%)');
    switch (key) {
      case 'articles_published': return 'Walk me through today\'s published articles' + trendWord + '.';
      case 'pitches_created':    return 'Break down today\'s pitch activity' + trendWord + '.';
      case 'pitches_pending':    return 'What\'s in the pitch pipeline right now (' + v + ' pending)?';
      case 'review_queue':       return 'What\'s stuck in the review queue (' + v + ' articles)?';
      case 'ai_spend_usd':       return 'Break down today\'s AI spend ($' + Number(v).toFixed(2) + ')' + trendWord + '. Which operations drove it?';
      case 'research_ingested':  return 'Summarise today\'s research intake (' + v + ' sources). Anything worth a pitch?';
      case 'orphaned_pitches':   return 'Walk me through the ' + v + ' orphaned commissioned pitches. Which writer fits each?';
      case 'coverage_gaps':      return 'Which beats did we miss this week, and what should we cover next week?';
      case 'top_article_views':  return 'What made the top article this week work? What can we learn?';
      default:                   return 'Tell me about ' + (METRIC_LABELS[key] || key).toLowerCase() + '.';
    }
  }

  var METRIC_LABELS = {
    articles_published: 'Published',
    pitches_created:    'New pitches',
    pitches_pending:    'Pending pitches',
    review_queue:       'In review',
    ai_spend_usd:       'AI spend',
    research_ingested:  'Sources ingested',
    orphaned_pitches:   'Orphaned',
    coverage_gaps:      'Coverage gaps',
    top_article_views:  'Top views',
  };

  function formatMetricValue(key, value) {
    if (key === 'ai_spend_usd') return '$' + Number(value || 0).toFixed(2);
    return String(value);
  }

  // Up isn't always good (AI spend rising is bad, orphans rising is bad).
  function isGoodTrend(key, trend) {
    var upIsBad = ['ai_spend_usd', 'review_queue', 'orphaned_pitches', 'coverage_gaps'];
    if (upIsBad.indexOf(key) >= 0) return trend === 'down';
    return trend === 'up';
  }

  function highlightIcon(type) {
    switch (type) {
      case 'published':      return '✓';
      case 'stalled_pitch':  return '⏱';
      case 'review_backlog': return '📚';
      case 'orphan':         return '⚠';
      case 'engagement':     return '📈';
      case 'top_engagement': return '🔥';
      case 'gap':            return '○';
      case 'best_coverage':  return '★';
      case 'pipeline':       return '⚙';
      case 'stalled':        return '⏱';
      default:               return '·';
    }
  }

  function longTextCard(text, label) {
    if (!text) return label ? '<div class="feed-snippet">' + esc(label) + '</div>' : '';
    var id = 'lt-' + Math.random().toString(36).slice(2);
    var labelHtml = label ? '<div class="feed-snippet" style="color:var(--muted);font-size:11px;margin-bottom:4px;">' + esc(label) + '</div>' : '';
    if (text.length <= 400) {
      return labelHtml + '<div class="feed-long-text" id="' + id + '">' + esc(text) + '</div>';
    }
    // Long text: render a sentence-bounded preview so the visible portion
    // ends on a complete sentence rather than mid-word (line-clamp used to
    // do this in CSS). Full text is stashed on the element for "Show more".
    var preview = previewToSentence(text, 280);
    var fullEncoded = encodeURIComponent(text);
    return labelHtml
      + '<div class="feed-long-text" id="' + id + '" data-full="' + fullEncoded + '">'
      + esc(preview) + (preview.length < text.length ? '…' : '')
      + '</div>'
      + '<button class="feed-expand-btn" data-expand="' + id + '">Show more</button>';
  }

  // Trim text to maxLen, preferring the last sentence-ending punctuation.
  // Falls back to the last word boundary if no sentence break is available
  // in the second half of the slice.
  function previewToSentence(text, maxLen) {
    if (text.length <= maxLen) return text.trim();
    var slice = text.slice(0, maxLen);
    var lastEnd = -1;
    [/\.\s/g, /!\s/g, /\?\s/g, /\.\n/g, /!\n/g, /\?\n/g].forEach(function (re) {
      var m, last = -1;
      while ((m = re.exec(slice)) !== null) last = m.index;
      if (last > lastEnd) lastEnd = last;
    });
    if (lastEnd > maxLen * 0.4) return slice.slice(0, lastEnd + 1).trim();
    var lastSpace = slice.lastIndexOf(' ');
    return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
  }

  // Wire reaction + reply handlers (event-delegated on stream container)
  document.addEventListener('click', async function (ev) {
    var t = ev.target;
    // Metric chip → Maxwell bubble with a contextual question
    var metricBtn = t.closest && t.closest('.brief-metric-clickable');
    if (metricBtn && metricBtn.dataset.briefMetric) {
      ev.preventDefault();
      if (!window.Maxwell || !window.Maxwell.ask) return;
      try {
        var m = JSON.parse(decodeURIComponent(metricBtn.dataset.briefMetric));
        window.Maxwell.ask(metricQuestion(m), { autoSend: true });
      } catch (_) {}
      return;
    }
    // Brief feedback thumbs — upsert / clear current user's vote
    var thumb = t.closest && t.closest('.brief-thumb');
    if (thumb) {
      ev.preventDefault();
      var wrap = thumb.closest('.brief-feedback');
      if (!wrap) return;
      var eventId = wrap.getAttribute('data-brief-feedback');
      var currentVote = thumb.dataset.briefVote;
      var alreadyActive = thumb.classList.contains('active');
      var toSend = alreadyActive ? null : currentVote; // toggle off if re-clicked
      try {
        await apiFetch('/newsroom-feed/' + eventId + '/feedback', {
          method: 'POST',
          body: JSON.stringify({ vote: toSend }),
        });
        wrap.querySelectorAll('.brief-thumb').forEach(function (b) { b.classList.remove('active'); });
        if (toSend) thumb.classList.add('active');
        var status = wrap.querySelector('.brief-feedback-status');
        if (status) status.textContent = toSend === 'up' ? 'Thanks for the signal.' : toSend === 'down' ? 'Noted — Maxwell will adjust.' : '';
      } catch (err) {
        alert('Feedback failed: ' + (err.message || err));
      }
      return;
    }
    // Inline brief action button — server-computed, payload.action carries the
    // endpoint + method. Encoded via encodeURIComponent in the renderer so
    // quotes in JSON don't break the attribute.
    var briefActionBtn = t.closest && t.closest('.brief-action-exec');
    if (briefActionBtn && briefActionBtn.dataset.briefAction) {
      ev.preventDefault();
      var action;
      try { action = JSON.parse(decodeURIComponent(briefActionBtn.dataset.briefAction)); }
      catch (_) { return; }
      if (action.confirm && !window.confirm(action.confirm)) return;
      briefActionBtn.disabled = true;
      var origText = briefActionBtn.textContent;
      briefActionBtn.textContent = 'Working…';
      try {
        var endpoint = action.endpoint.replace(/^\/api/, '');
        var result = await apiFetch(endpoint, { method: action.method || 'POST' });
        var msg = action.success_message || 'Done';
        if (result && typeof result.assigned === 'number') {
          msg = 'Assigned ' + result.assigned + (result.skipped ? ', skipped ' + result.skipped : '') + '.';
        } else if (result && result.writer && result.writer.name) {
          msg = 'Assigned to ' + result.writer.name + '.';
        }
        briefActionBtn.textContent = '✓ ' + msg;
        briefActionBtn.classList.add('brief-action-done');
      } catch (err) {
        briefActionBtn.textContent = origText;
        briefActionBtn.disabled = false;
        alert('Action failed: ' + (err.message || err));
      }
      return;
    }
    if (t.dataset && t.dataset.expand) {
      var el = document.getElementById(t.dataset.expand);
      if (el) {
        if (el.dataset.full) {
          el.textContent = decodeURIComponent(el.dataset.full);
          delete el.dataset.full;
        } else {
          el.classList.remove('collapsed');
        }
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
    } else if (t.dataset && t.dataset.dismissEvent) {
      var eventId = parseInt(t.dataset.dismissEvent, 10);
      t.disabled = true;
      try {
        await apiFetch('/newsroom-feed/' + eventId, { method: 'DELETE' });
        var card = t.closest('.feed-card');
        if (card) { card.style.transition = 'opacity 0.2s'; card.style.opacity = '0'; setTimeout(function() { card.remove(); }, 200); }
      } catch (err) {
        t.disabled = false;
        alert('Dismiss failed: ' + (err.message || err));
      }
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
        var chatLink = r.author_writer_id
          ? ' <a class="feed-link" href="/newsroom-chat.html?writer_id=' + r.author_writer_id + '" style="font-size:11px;">Chat →</a>'
          : '';
        return '<div class="reply-item">'
          + '<span class="reply-author">' + esc(who) + '</span>'
          + '<span class="reply-time">' + relativeTime(new Date(r.created_at)) + '</span>'
          + chatLink
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
