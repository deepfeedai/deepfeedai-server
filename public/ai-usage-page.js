/* Deep Feed AI Admin — AI Usage & Costs page */
(function () {
  'use strict';

  const PROVIDER_COLORS = {
    gemini:     '#4285F4',
    elevenlabs: '#8B5CF6',
    imagen:     '#F59E0B',
    resend:     '#10B981',
    newsapi:    '#6366F1',
    brave:      '#EF4444',
  };

  function fmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function shortDate(isoStr) {
    const d = new Date(isoStr);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function relTime(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  let currentRange = '30d';

  async function loadData() {
    if (!requireAuth()) return;

    try {
      const data = await apiFetch(`/ai-usage/summary?range=${currentRange}`);
      render(data);
    } catch (err) {
      console.error('[ai-usage] load error:', err);
    }
  }

  function render(data) {
    const t = data.totals || {};
    const b = data.budget || {};

    // Stat cards
    document.getElementById('statCost').textContent = '$' + parseFloat(t.estimated_cost || 0).toFixed(2);
    document.getElementById('statCalls').textContent = fmt(parseInt(t.api_calls) || 0);
    document.getElementById('statTokens').textContent = fmt(parseInt(t.total_tokens) || 0);
    document.getElementById('statSuccess').textContent = (parseFloat(t.success_rate) || 0) + '%';

    // Budget
    const pct = Math.min(b.percent_used || 0, 100);
    document.getElementById('budgetSpent').textContent = '$' + parseFloat(b.current_spend || 0).toFixed(2) + ' spent';
    document.getElementById('budgetLimit').textContent = '$' + parseFloat(b.monthly_limit || 50).toFixed(2) + ' limit';
    document.getElementById('budgetToday').textContent = 'Today: $' + parseFloat(b.today_spend || 0).toFixed(2);
    document.getElementById('budgetProjected').textContent = 'Projected: $' + parseFloat(b.projected_monthly || 0).toFixed(2) + '/mo';
    document.getElementById('budgetLabel').textContent = pct + '% used this month';

    const fill = document.getElementById('budgetFill');
    fill.style.width = pct + '%';
    fill.style.background = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#22c55e';

    // Daily spend sparkline
    renderSparkline(data.by_day || []);

    // Provider bars
    renderBars('providerBars', data.by_provider || [], 'provider');

    // Operation bars
    renderBars('operationBars', data.by_operation || [], 'operation');

    // Errors
    renderErrors(data.recent_errors || []);
  }

  function renderSparkline(byDay) {
    const chart = document.getElementById('sparkChart');
    const labels = document.getElementById('sparkLabels');
    if (!byDay.length) {
      chart.innerHTML = '<div style="color:var(--text-muted);font-size:13px;align-self:center;">No data yet</div>';
      labels.innerHTML = '';
      return;
    }

    const days = parseInt(currentRange) || 30;
    const filled = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const match = byDay.find(r => r.day && r.day.slice(0, 10) === key);
      filled.push({ day: key, cost: match ? parseFloat(match.cost) : 0 });
    }

    const max = Math.max(...filled.map(r => r.cost), 0.01);
    chart.innerHTML = filled.map(r => {
      const pct = Math.max(Math.round((r.cost / max) * 100), 2);
      return `<div class="spark-bar" style="height:${pct}%" title="${shortDate(r.day)}: $${r.cost.toFixed(4)}"></div>`;
    }).join('');

    const mid = Math.floor(filled.length / 2);
    labels.innerHTML = `<span>${shortDate(filled[0].day)}</span><span>${shortDate(filled[mid].day)}</span><span>${shortDate(filled[filled.length - 1].day)}</span>`;
  }

  function renderBars(containerId, items, nameKey) {
    const container = document.getElementById(containerId);
    if (!items.length) {
      container.innerHTML = '<div class="text-muted text-sm">No data yet</div>';
      return;
    }

    const maxCost = Math.max(...items.map(i => parseFloat(i.cost)), 0.01);
    container.innerHTML = items.map(item => {
      const cost = parseFloat(item.cost);
      const pct = Math.round((cost / maxCost) * 100);
      const name = item[nameKey] || 'unknown';
      const color = PROVIDER_COLORS[name] || '#4F8EF7';
      return `
        <div class="bar-row">
          <div class="bar-label">${escHtml(name)}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${color};"></div>
          </div>
          <div class="bar-value">$${cost.toFixed(4)}</div>
        </div>`;
    }).join('');
  }

  function renderErrors(errors) {
    const tbody = document.getElementById('errorsTbody');
    document.getElementById('errorCount').textContent = errors.length + ' recent';

    if (!errors.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center" style="padding:24px;">No errors</td></tr>';
      return;
    }

    tbody.innerHTML = errors.map(e => `
      <tr>
        <td style="white-space:nowrap;font-size:12px;">${relTime(e.created_at)}</td>
        <td><span class="badge">${escHtml(e.operation)}</span></td>
        <td style="font-size:12px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(e.error)}</td>
      </tr>
    `).join('');
  }

  // Range tab switching
  document.getElementById('rangeTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.range-tab');
    if (!tab) return;
    document.querySelectorAll('.range-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentRange = tab.dataset.range;
    loadData();
  });

  document.getElementById('refreshBtn').addEventListener('click', loadData);

  // Init
  loadData();
})();
