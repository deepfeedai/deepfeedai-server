/* global apiFetch, renderSidebar */
(function () {
  'use strict';
  renderSidebar();

  var items = [];

  async function load() {
    var kind  = document.getElementById('kindFilter').value;
    var days  = document.getElementById('rangeFilter').value;
    var types = kind ? kind : 'daily_brief,weekly_digest';
    var list  = document.getElementById('briefsList');
    list.innerHTML = '<div class="briefs-empty">Loading…</div>';
    try {
      var data = await apiFetch('/newsroom-feed?type=' + encodeURIComponent(types) + '&days=' + days + '&limit=300');
      items = (data.events || []).filter(function (e) {
        return e.event_type === 'daily_brief' || e.event_type === 'weekly_digest';
      });
      render();
      // If the URL has ?id=N, scroll that brief into view + highlight.
      var openId = new URLSearchParams(location.search).get('id');
      if (openId) focusBrief(Number(openId));
    } catch (err) {
      list.innerHTML = '<div class="briefs-empty">Failed to load briefs: ' + esc(err.message || err) + '</div>';
    }
  }

  function render() {
    var q = (document.getElementById('searchInput').value || '').trim().toLowerCase();
    var filtered = items.filter(function (e) {
      if (!q) return true;
      var hay = [
        (e.payload && e.payload.headline) || '',
        (e.payload && e.payload.prose) || (e.payload && e.payload.text) || '',
        (e.payload && e.payload.period_range) || '',
      ].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    var list = document.getElementById('briefsList');
    if (!filtered.length) {
      list.innerHTML = '<div class="briefs-empty">No briefs match.</div>';
      return;
    }
    list.innerHTML = filtered.map(renderCard).join('');
  }

  function renderCard(e) {
    var payload = e.payload || {};
    var isWeekly = e.event_type === 'weekly_digest';
    var kindLabel = isWeekly ? 'Week in review' : 'Day brief';
    var kindCls   = isWeekly ? 'weekly' : 'daily';
    var date      = payload.period_range || new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    var body      = payload.version === 2
      ? renderStructured(payload)
      : '<div class="brief-prose">' + esc(payload.text || payload.prose || '(no content)') + '</div>';

    return '<div class="brief-card-wrap" id="brief-' + e.id + '">'
      + '<div class="brief-card-head">'
      +   '<span class="brief-card-kind ' + kindCls + '">' + kindLabel + '</span>'
      +   '<span class="brief-card-date">' + esc(date) + '</span>'
      +   '<button class="brief-card-perma" onclick="copyPermalink(' + e.id + ')" title="Copy permalink">🔗 Copy link</button>'
      + '</div>'
      + body
      + '</div>';
  }

  function renderStructured(payload) {
    var parts = [];
    if (payload.headline) parts.push('<div class="brief-headline">' + esc(payload.headline) + '</div>');

    var metrics = payload.metrics || {};
    var metricKeys = Object.keys(metrics);
    if (metricKeys.length) {
      parts.push('<div class="brief-metrics">' + metricKeys.map(function (k) { return renderMetric(k, metrics[k]); }).join('') + '</div>');
    }

    if (payload.top_priority && payload.top_priority.label) {
      var tp = payload.top_priority;
      var inner = '<span class="brief-priority-icon">⚡</span>'
        + '<span class="brief-priority-label">' + esc(tp.label) + '</span>'
        + (tp.cta ? '<span class="brief-priority-cta">' + esc(tp.cta) + ' →</span>' : '');
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
          var label = (g.beat || '') + (g.days ? ' · ' + g.days + 'd' : '') + (g.note ? ' · ' + g.note : '');
          return '<span class="brief-gap-chip">' + esc(label) + '</span>';
        }).join('') + '</div></div>');
    }

    var actionItems = Array.isArray(payload.action_items) ? payload.action_items : [];
    if (actionItems.length) {
      parts.push('<div class="brief-section"><div class="brief-section-title">Action items</div>'
        + '<div class="brief-actions">' + actionItems.map(function (a) {
          return '<a class="brief-action-btn" href="' + esc(a.link || '#') + '">' + esc(a.label || '') + ' →</a>';
        }).join('') + '</div></div>');
    }

    if (payload.prose) {
      parts.push('<div class="brief-section"><div class="brief-section-title">Editor\'s note</div>'
        + '<div class="brief-prose">' + esc(payload.prose) + '</div></div>');
    }
    return parts.join('');
  }

  var METRIC_LABELS = {
    articles_published: 'Published', pitches_created: 'New pitches',
    pitches_pending: 'Pending pitches', review_queue: 'In review',
    ai_spend_usd: 'AI spend', research_ingested: 'Sources ingested',
    orphaned_pitches: 'Orphaned', coverage_gaps: 'Coverage gaps',
    top_article_views: 'Top views',
  };

  function renderMetric(key, m) {
    if (!m || typeof m.value === 'undefined') return '';
    var label = METRIC_LABELS[key] || key.replace(/_/g, ' ');
    var display = key === 'ai_spend_usd' ? '$' + Number(m.value || 0).toFixed(2) : String(m.value);
    var trend = '';
    if (m.trend && m.trend !== 'flat' && m.delta_pct != null) {
      var arrow = m.trend === 'up' ? '↑' : '↓';
      var upIsBad = ['ai_spend_usd','review_queue','orphaned_pitches','coverage_gaps'].indexOf(key) >= 0;
      var good = upIsBad ? m.trend === 'down' : m.trend === 'up';
      trend = '<span class="brief-metric-trend brief-trend-' + (good ? 'good' : 'bad') + '">'
        + arrow + ' ' + (m.delta_pct > 0 ? '+' : '') + m.delta_pct + '%</span>';
    }
    return '<div class="brief-metric">'
      + '<div class="brief-metric-value">' + esc(display) + '</div>'
      + '<div class="brief-metric-label">' + esc(label) + '</div>'
      + trend
      + '</div>';
  }

  function highlightIcon(type) {
    switch (type) {
      case 'published': return '✓';
      case 'stalled_pitch': case 'stalled': return '⏱';
      case 'review_backlog': return '📚';
      case 'orphan': return '⚠';
      case 'engagement': return '📈';
      case 'top_engagement': return '🔥';
      case 'gap': return '○';
      case 'best_coverage': return '★';
      case 'pipeline': return '⚙';
      default: return '·';
    }
  }

  function focusBrief(id) {
    var el = document.getElementById('brief-' + id);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.style.outline = '2px solid var(--primary)';
    setTimeout(function () { el.style.outline = ''; }, 2500);
  }

  window.copyPermalink = function (id) {
    var url = location.origin + location.pathname + '?id=' + id;
    navigator.clipboard.writeText(url).then(
      function () { toast('Link copied'); },
      function () { prompt('Copy this link:', url); }
    );
  };

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg-card);color:var(--text);border:1px solid var(--border);padding:8px 14px;border-radius:8px;font-size:13px;z-index:10001;box-shadow:0 8px 24px rgba(0,0,0,0.3);';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1500);
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  document.getElementById('kindFilter').addEventListener('change', load);
  document.getElementById('rangeFilter').addEventListener('change', load);
  document.getElementById('searchInput').addEventListener('input', render);

  load();
})();
