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
    el.innerHTML =
      gaugeRow('Articles', q.articles.used, q.articles.limit, '', q.articles.pct) +
      gaugeRow('AI Spend', '$' + q.ai_spend.used, '$' + q.ai_spend.limit, '', q.ai_spend.pct) +
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
          <a href="/article/${escHtml(a.slug)}" target="_blank" rel="noopener"
             style="color:var(--accent);text-decoration:none;"
             title="${escHtml(a.title)}">${escHtml(a.title)}</a>
        </td>
        <td><span class="badge badge-muted">${escHtml(a.category)}</span></td>
        <td><strong>${fmt(a.views)}</strong></td>
        <td><canvas id="miniTrend${i}" width="60" height="24" style="vertical-align:middle;"></canvas></td>
        <td class="text-muted text-sm">${fmt(a.audio_plays)}</td>
        <td class="text-muted text-sm">${fmt(a.shares)}</td>
      </tr>`).join('');

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
  });
})();
