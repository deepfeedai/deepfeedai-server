/* Deep Feed AI Admin — Analytics page */
(function () {
  'use strict';

  function fmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function shortDate(isoStr) {
    const d = new Date(isoStr);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /* ── Sparkline ──────────────────────────────────────────────── */
  function renderSparkline(byDay) {
    const chart  = document.getElementById('sparkChart');
    const labels = document.getElementById('sparkLabels');
    if (!chart || !byDay.length) {
      if (chart) chart.innerHTML = '<div style="color:var(--text-muted);font-size:13px;align-self:center;">No data yet</div>';
      return;
    }

    // Fill missing days in last 30
    const filled = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const match = byDay.find(r => r.day && r.day.slice(0, 10) === key);
      filled.push({ day: key, views: match ? match.views : 0 });
    }

    const max = Math.max(...filled.map(r => r.views), 1);
    chart.innerHTML = filled.map(r => {
      const pct = Math.max(Math.round((r.views / max) * 100), 2);
      return `<div class="spark-bar" style="height:${pct}%" title="${shortDate(r.day)}: ${r.views} views"></div>`;
    }).join('');

    // Show first, middle, last date labels
    labels.innerHTML = `<span>${shortDate(filled[0].day)}</span><span>${shortDate(filled[14].day)}</span><span>${shortDate(filled[29].day)}</span>`;
  }

  /* ── Category bars ──────────────────────────────────────────── */
  function renderCategoryBars(byCategory) {
    const el = document.getElementById('categoryBars');
    if (!el) return;
    if (!byCategory.length) {
      el.innerHTML = '<div class="text-muted text-sm">No data yet</div>';
      return;
    }
    const max = Math.max(...byCategory.map(r => r.views), 1);
    el.innerHTML = byCategory.map(r => {
      const pct = Math.round((r.views / max) * 100);
      return `
        <div class="cat-bar-row">
          <div class="cat-bar-label" title="${escHtml(r.category)}">${escHtml(r.category)}</div>
          <div class="cat-bar-track">
            <div class="cat-bar-fill" style="width:${pct}%"></div>
          </div>
          <div class="cat-bar-count">${fmt(r.views)}</div>
        </div>`;
    }).join('');
  }

  /* ── Top articles table ─────────────────────────────────────── */
  function renderTopArticles(articles) {
    const tbody = document.getElementById('topArticlesTbody');
    if (!tbody) return;
    if (!articles.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center" style="padding:24px;">No data yet</td></tr>';
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
        <td class="text-muted text-sm">${fmt(a.audio_plays)}</td>
        <td class="text-muted text-sm">${fmt(a.shares)}</td>
      </tr>`).join('');
  }

  /* ── Load data ──────────────────────────────────────────────── */
  async function loadAnalytics() {
    document.getElementById('refreshBtn').disabled = true;
    document.getElementById('refreshBtn').textContent = 'Loading…';

    try {
      const data = await apiFetch('/analytics/summary');

      // Stat cards
      document.getElementById('statTotalViews').textContent  = fmt(data.totals.views);
      document.getElementById('statViews7d').textContent     = `${fmt(data.totals.views_7d)} last 7 days`;
      document.getElementById('statViews30d').textContent    = fmt(data.totals.views_30d);
      document.getElementById('statAudioPlays').textContent  = fmt(data.totals.audio_plays);
      document.getElementById('statShares').textContent      = fmt(data.totals.shares);

      renderSparkline(data.by_day);
      renderTopArticles(data.top_articles);
      renderCategoryBars(data.by_category);

      document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
    } catch (err) {
      showAlert('Failed to load analytics: ' + err.message, 'error');
    } finally {
      document.getElementById('refreshBtn').disabled = false;
      document.getElementById('refreshBtn').textContent = '↻ Refresh';
    }
  }

  /* ── Init ───────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refreshBtn')?.addEventListener('click', loadAnalytics);
    loadAnalytics();
  });
})();
