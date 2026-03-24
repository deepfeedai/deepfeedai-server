/* Deep Feed AI Admin — Analytics page */
(function () {
  'use strict';

  /* ── Utilities ─────────────────────────────────────────── */

  function fmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ── Chart.js helpers (ported from platform.js) ────────── */

  const CHART_COLORS = ['#00d9ff', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#f59e0b'];

  function createChart(canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return null;

    const defaults = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#888', font: { family: "'Inter', sans-serif", size: 11 } } },
        tooltip: { backgroundColor: '#222', titleColor: '#f0f0f0', bodyColor: '#ccc', borderColor: '#333', borderWidth: 1 },
      },
      scales: {},
    };

    // Apply dark-theme scale defaults for cartesian charts
    if (!config.type || config.type === 'line' || config.type === 'bar') {
      const scaleDefaults = {
        grid: { color: 'rgba(255,255,255,0.06)' },
        ticks: { color: '#888', font: { family: "'Inter', sans-serif", size: 11 } },
      };
      config.options = config.options || {};
      config.options.scales = config.options.scales || {};
      for (const axis of ['x', 'y']) {
        config.options.scales[axis] = { ...scaleDefaults, ...(config.options.scales[axis] || {}) };
      }
    }

    config.options = { ...defaults, ...config.options, plugins: { ...defaults.plugins, ...(config.options?.plugins || {}) } };
    return new Chart(canvas, config);
  }

  /* ── Range tabs ────────────────────────────────────────── */

  function renderRangeTabs(containerId, options, active, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = options.map(opt =>
      `<button class="range-tab${opt === active ? ' active' : ''}" data-range="${opt}">${opt}</button>`
    ).join('');
    container.querySelectorAll('.range-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.range-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(btn.dataset.range);
      });
    });
  }

  /* ── Delta rendering ───────────────────────────────────── */

  function renderDelta(elId, current, previous, label) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!previous || previous === 0) {
      el.textContent = label || '';
      el.className = 'stat-delta';
      return;
    }
    const pct = Math.round(((current - previous) / previous) * 100);
    if (pct === 0) {
      el.textContent = `→ 0% vs prior period`;
      el.className = 'stat-delta';
    } else if (pct > 0) {
      el.textContent = `↑ ${pct}% vs prior period`;
      el.className = 'stat-delta up';
    } else {
      el.textContent = `↓ ${Math.abs(pct)}% vs prior period`;
      el.className = 'stat-delta down';
    }
  }

  /* ── Engagement ratios ──────────────────────────────────── */

  function renderEngagement(engagement) {
    document.getElementById('listenRate').textContent = engagement.listen_rate + '%';
    document.getElementById('shareRate').textContent = engagement.share_rate + '%';
  }

  /* ── Quota gauges ──────────────────────────────────────── */

  function renderQuota(quota) {
    const el = document.getElementById('quotaGauges');
    if (!el) return;

    function gaugeColor(pct) {
      if (pct >= 90) return '#ef4444';
      if (pct >= 70) return '#f59e0b';
      return '#4ade80';
    }

    function gaugeRow(label, used, limit, unit, pct) {
      const safePct = Math.min(pct, 100);
      return `
        <div class="quota-row">
          <div class="quota-label">${label}</div>
          <div class="quota-track">
            <div class="quota-fill" style="width:${safePct}%;background:${gaugeColor(pct)};"></div>
          </div>
          <div class="quota-detail">${used}${unit} / ${limit}${unit} (${pct}%)</div>
        </div>`;
    }

    const q = quota;
    // Show credits instead of dollar spend for tenant-facing view
    const credits = q.ai_credits || {};
    const creditsUsed = credits.used || 0;
    const creditsLimit = credits.limit || 0;
    const creditsPct = credits.pct || 0;
    const bonusNote = credits.bonus ? ` (incl. ${fmt(credits.bonus)} bonus)` : '';
    const purchasedNote = credits.purchased ? ` + ${fmt(credits.purchased)} banked` : '';
    const creditsLabel = `AI Credits${bonusNote}${purchasedNote}`;

    el.innerHTML =
      gaugeRow('Articles', q.articles.used, q.articles.limit, '', q.articles.pct) +
      gaugeRow(creditsLabel, fmt(creditsUsed), fmt(creditsLimit), ' credits', creditsPct) +
      gaugeRow('Storage', q.storage.used, q.storage.limit, ' MB', q.storage.pct);
  }

  /* ── Charts ────────────────────────────────────────────── */

  let viewsChart = null;
  let categoryChart = null;
  let currentRange = '30d';

  function renderViewsChart(byDay) {
    if (viewsChart) viewsChart.destroy();

    // Fill missing days
    const rangeDays = parseInt(currentRange);
    const filled = [];
    const now = new Date();
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const match = byDay.find(r => r.day && r.day.slice(0, 10) === key);
      filled.push({ day: key, views: match ? match.views : 0 });
    }

    viewsChart = createChart('viewsChart', {
      type: 'line',
      data: {
        labels: filled.map(d => new Date(d.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
        datasets: [{
          label: 'Views',
          data: filled.map(d => d.views),
          borderColor: '#00d9ff',
          backgroundColor: 'rgba(0,217,255,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: rangeDays > 30 ? 0 : 2,
        }],
      },
      options: { plugins: { legend: { display: false } } },
    });
  }

  function renderCategoryChart(byCategory) {
    if (categoryChart) categoryChart.destroy();
    if (!byCategory.length) return;

    categoryChart = createChart('categoryChart', {
      type: 'bar',
      data: {
        labels: byCategory.map(c => c.category),
        datasets: [{
          label: 'Views',
          data: byCategory.map(c => c.views),
          backgroundColor: CHART_COLORS.concat(CHART_COLORS).slice(0, byCategory.length),
          borderRadius: 4,
        }],
      },
      options: { indexAxis: 'y', plugins: { legend: { display: false } } },
    });
  }

  /* ── Top articles table + mini sparklines ─────────────────── */

  function renderTopArticles(articles) {
    const tbody = document.getElementById('topArticlesTbody');
    if (!tbody) return;
    if (!articles.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted text-center" style="padding:24px;">No data yet</td></tr>';
      return;
    }
    tbody.innerHTML = articles.map((a, i) => `
      <tr>
        <td class="text-muted text-sm">${i + 1}</td>
        <td class="title-cell">
          <a href="#" class="article-preview-link" data-slug="${escHtml(a.slug)}"
             style="color:var(--accent);text-decoration:none;cursor:pointer;"
             title="${escHtml(a.title)}">${escHtml(a.title)}</a>
        </td>
        <td><span class="badge badge-muted">${escHtml(a.category)}</span></td>
        <td><strong>${fmt(a.views)}</strong></td>
        <td><canvas id="miniTrend${i}" width="60" height="24" style="vertical-align:middle;"></canvas></td>
        <td class="text-muted text-sm">${fmt(a.audio_plays)}</td>
        <td class="text-muted text-sm">${fmt(a.shares)}</td>
      </tr>`).join('');

    // Wire preview links
    tbody.querySelectorAll('.article-preview-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        showArticlePreviewBySlug(link.dataset.slug);
      });
    });

    // Render mini sparkline charts after DOM is updated
    articles.forEach((a, i) => renderMiniSparkline(`miniTrend${i}`, a.mini_trend || []));
  }

  function renderMiniSparkline(canvasId, trendData) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;

    // Fill 7 days
    const filled = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const match = trendData.find(r => r.day && r.day.slice(0, 10) === key);
      filled.push(match ? match.views : 0);
    }

    new Chart(canvas, {
      type: 'line',
      data: {
        labels: filled.map(() => ''),
        datasets: [{
          data: filled,
          borderColor: '#00d9ff',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        }],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false },
        },
      },
    });
  }

  /* ── Engagement heatmap ─────────────────────────────────── */

  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function renderHeatmap(heatmapData) {
    const grid = document.getElementById('heatmapGrid');
    if (!grid) return;

    // Build 7×24 lookup
    const lookup = {};
    let maxViews = 1;
    for (const r of heatmapData) {
      const key = `${r.dow}-${r.hour}`;
      lookup[key] = r.views;
      if (r.views > maxViews) maxViews = r.views;
    }

    let html = '';

    // Hour labels row
    html += '<div class="heatmap-label"></div>'; // empty corner
    for (let h = 0; h < 24; h++) {
      html += `<div class="heatmap-hour-label">${h % 6 === 0 ? h + ':00' : ''}</div>`;
    }

    // Data rows (Mon-Sun, reorder so Mon=1 is first)
    const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
    for (const dow of dayOrder) {
      html += `<div class="heatmap-label">${DAY_LABELS[dow]}</div>`;
      for (let h = 0; h < 24; h++) {
        const views = lookup[`${dow}-${h}`] || 0;
        const intensity = views > 0 ? Math.max(0.15, views / maxViews) : 0.03;
        const title = `${DAY_LABELS[dow]} ${h}:00 — ${views} views`;
        html += `<div class="heatmap-cell" style="background:rgba(0,217,255,${intensity.toFixed(2)});" title="${title}"></div>`;
      }
    }

    grid.innerHTML = html;
  }

  /* ── Live activity feed ────────────────────────────────── */

  let eventSource = null;
  const MAX_FEED_ITEMS = 15;

  function relTime(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return secs + 's ago';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function eventLabel(type) {
    if (type === 'view') return 'Viewed';
    if (type === 'audio_play') return 'Listened';
    if (type === 'share') return 'Shared';
    return type;
  }

  function renderFeedItem(evt) {
    const slug = evt.article_slug || 'unknown';
    const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `<li class="feed-item">
      <span class="feed-type ${escHtml(evt.event_type)}">${eventLabel(evt.event_type)}</span>
      <span class="feed-slug" title="${escHtml(title)}">${escHtml(title)}</span>
      <span class="feed-time">${relTime(evt.created_at)}</span>
    </li>`;
  }

  async function initLiveFeed() {
    const feed = document.getElementById('liveFeed');
    if (!feed) return;

    // Load recent events
    try {
      const recent = await apiFetch('/analytics/recent');
      if (recent.length) {
        feed.innerHTML = recent.map(renderFeedItem).join('');
      } else {
        feed.innerHTML = '<li class="feed-item text-muted" style="justify-content:center;">No events yet</li>';
      }
    } catch {
      feed.innerHTML = '<li class="feed-item text-muted" style="justify-content:center;">Failed to load</li>';
    }

    // Connect SSE
    try {
      const token = typeof getToken === 'function' ? getToken() : '';
      eventSource = new EventSource(`/api/analytics/live?token=${encodeURIComponent(token)}`);

      eventSource.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          const newItem = renderFeedItem(evt);
          feed.insertAdjacentHTML('afterbegin', newItem);
          // Trim to max
          while (feed.children.length > MAX_FEED_ITEMS) {
            feed.removeChild(feed.lastChild);
          }
        } catch { /* ignore malformed */ }
      };

      eventSource.onerror = () => {
        const dot = document.getElementById('liveDot');
        if (dot) dot.style.background = 'var(--text-muted)';
      };

      eventSource.onopen = () => {
        const dot = document.getElementById('liveDot');
        if (dot) dot.style.background = 'var(--success, #4ade80)';
      };
    } catch { /* SSE not available */ }
  }

  // Update relative times every 30s
  setInterval(() => {
    const feed = document.getElementById('liveFeed');
    if (!feed) return;
    feed.querySelectorAll('.feed-time').forEach(el => {
      // Re-render would be complex, just leave as-is for simplicity
    });
  }, 30000);

  /* ── Load data ──────────────────────────────────────────── */

  async function loadAnalytics(range) {
    if (range) currentRange = range;

    document.getElementById('refreshBtn').disabled = true;
    document.getElementById('refreshBtn').textContent = 'Loading…';

    try {
      const data = await apiFetch(`/analytics/summary?range=${currentRange}`);

      // Stat cards
      document.getElementById('statViews').textContent       = fmt(data.totals.views_period);
      document.getElementById('statAudioPlays').textContent  = fmt(data.totals.audio_plays);
      document.getElementById('statShares').textContent      = fmt(data.totals.shares);
      document.getElementById('statTotalViews').textContent  = fmt(data.totals.views);

      // Deltas
      renderDelta('statViewsDelta', data.totals.views_period, data.totals.views_prev);
      renderDelta('statAudioDelta', data.totals.audio_plays, data.totals.audio_plays_prev);
      renderDelta('statSharesDelta', data.totals.shares, data.totals.shares_prev);

      // Section labels
      document.getElementById('chartTitle').textContent = `Daily Views — ${currentRange}`;
      document.getElementById('topArticlesRange').textContent = `by views, ${currentRange}`;
      document.getElementById('categoryRange').textContent = `views, ${currentRange}`;

      // Engagement ratios & quota
      renderEngagement(data.engagement || { listen_rate: 0, share_rate: 0 });
      renderQuota(data.quota || { articles: {}, ai_spend: {}, storage: {} });

      // Charts
      renderViewsChart(data.by_day);
      renderCategoryChart(data.by_category);

      // Table
      renderTopArticles(data.top_articles);

      // Heatmap
      renderHeatmap(data.heatmap || []);

      document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
    } catch (err) {
      showAlert('Failed to load analytics: ' + err.message, 'error');
    } finally {
      document.getElementById('refreshBtn').disabled = false;
      document.getElementById('refreshBtn').textContent = '↻ Refresh';
    }
  }

  /* ── Init ───────────────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', () => {
    if (!requireAuth()) return;
    renderSidebar();

    renderRangeTabs('rangeTabs', ['7d', '30d', '90d'], '30d', loadAnalytics);
    document.getElementById('refreshBtn')?.addEventListener('click', () => loadAnalytics());

    loadAnalytics();
    initLiveFeed();
  });
})();
