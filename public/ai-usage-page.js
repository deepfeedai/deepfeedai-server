/* Deep Feed AI Admin — AI Usage page */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────
  const PROVIDER_COLORS = {
    gemini:     '#4285F4',
    openai:     '#10B981',
    anthropic:  '#D97706',
    elevenlabs: '#8B5CF6',
    imagen:     '#F59E0B',
    dalle:      '#EC4899',
    openrouter: '#6366F1',
    resend:     '#14B8A6',
    newsapi:    '#6366F1',
    brave:      '#EF4444',
    ollama:     '#94A3B8',
  };

  const TYPE_COLORS = {
    text:   '#4285F4',
    image:  '#F59E0B',
    voice:  '#8B5CF6',
    search: '#EF4444',
    email:  '#10B981',
  };

  const TYPE_LABELS = { text:'LLM Text', image:'Images', voice:'Voice/TTS', search:'Search', email:'Email' };

  // ── Helpers ────────────────────────────────────────────────────────────
  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function fmtCost(n) {
    n = Number(n) || 0;
    if (n < 0.0001) return '$0.0000';
    if (n < 0.01)   return '$' + n.toFixed(6);
    if (n < 1)      return '$' + n.toFixed(4);
    return '$' + n.toFixed(2);
  }

  function shortDate(iso) {
    const d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function relTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function el(id) { return document.getElementById(id); }
  function setText(id, v) { const e = el(id); if (e) e.textContent = v; }
  function setHtml(id, v) { const e = el(id); if (e) e.innerHTML = v; }

  let currentRange = '30d';
  let _summaryData  = null;
  let _sessionWriterId  = null;
  let _breakdownPeriod  = 'today';

  // ── Load ──────────────────────────────────────────────────────────────
  async function loadData() {
    if (!requireAuth()) return;
    try {
      const [data] = await Promise.all([
        apiFetch(`/ai-usage/summary?range=${currentRange}`),
        loadElevenLabs(),
        loadSessions(),
        loadWriters(),
        loadCallLog(),
      ]);
      _summaryData = data;
      render(data);
    } catch (err) {
      console.error('[ai-usage]', err);
      showAlert('Failed to load AI usage data', 'error');
    }
  }

  // ── Render: main summary ───────────────────────────────────────────────
  function render(data) {
    renderAnomaly(data.anomaly);
    renderByok(data.byok);
    renderStatCards(data);
    renderSparkline(data.by_day || []);
    renderModelBars(data.by_model || []);
    renderTypeBars(data.by_type || []);
    // operation breakdown is loaded independently via loadOperationBreakdown()
    renderErrors(data.recent_errors || []);
    renderBudget(data.budget || {});
    renderEfficiency(data);
    populateLogFilters(data);
  }

  // ── Anomaly banner ────────────────────────────────────────────────────
  function renderAnomaly(anomaly) {
    const banner = el('anomalyBanner');
    if (!banner) return;
    if (anomaly && anomaly.is_anomaly) {
      el('anomalyText').innerHTML =
        '<strong>Spend spike detected:</strong> today\'s cost is '
        + anomaly.factor.toFixed(1) + '× the ' + currentRange + ' daily average ('
        + fmtCost(anomaly.today_spend) + ' today vs '
        + fmtCost(anomaly.avg_daily) + ' avg). Check the Call Log for unexpected usage.';
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  // ── BYOK vs platform strip ────────────────────────────────────────────
  function renderByok(byok) {
    if (!byok) return;
    setText('byokCost', fmtCost(byok.byok_cost));
    setText('byokCalls', byok.byok_calls + ' calls on your keys');
    setText('platformCredits', fmt(byok.platform_credits));
    setText('platformCalls', byok.platform_calls + ' calls on platform credits');
  }

  // ── Stat cards ────────────────────────────────────────────────────────
  function renderStatCards(data) {
    const t = data.totals || {};
    const cache = data.cache || {};

    setText('statCost',    fmtCost(parseFloat(t.estimated_cost) || 0));
    setText('statCredits', fmt(parseInt(t.total_credits) || 0));
    setText('statCreditsDelta', 'this period');
    setText('statCalls',   fmt(parseInt(t.api_calls) || 0));
    setText('statTokens',  fmt(parseInt(t.total_tokens) || 0));
    setText('statSuccess', (parseFloat(t.success_rate) || 0) + '%');

    // Cache hit rate
    const rate = cache.cache_rate || 0;
    setText('statCacheRate', rate + '%');
    if (cache.cost_saved > 0) {
      setText('statCacheSaved', '~' + fmtCost(cache.cost_saved) + ' saved');
    } else {
      setText('statCacheSaved', fmt(cache.cached_tokens || 0) + ' tokens cached');
    }
  }

  // ── Efficiency ────────────────────────────────────────────────────────
  function renderEfficiency(data) {
    const eff = data.efficiency || {};
    setText('statCostPerArticle', fmtCost(eff.cost_per_article || 0));
    setText('statArticleCount', (eff.published_articles || 0) + ' articles published');
    setText('statCreditsPerArticle', fmt(eff.credits_per_article || 0));

    const top = (eff.top_expensive_articles || [])[0];
    if (top) {
      setText('statTopArticleCost', fmtCost(parseFloat(top.cost) || 0));
      const title = (top.slug || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const el2 = el('statTopArticleSlug');
      if (el2) { el2.textContent = title; el2.title = title; }
    }
  }

  // ── Budget ────────────────────────────────────────────────────────────
  function renderBudget(b) {
    const creditsUsed   = parseInt(b.credits_used_month)  || 0;
    const creditsLimit  = parseInt(b.credits_limit_month) || 0;
    const creditsPct    = Math.min(b.credits_percent_used || 0, 100);
    const creditsRemain = Math.max(0, creditsLimit - creditsUsed);

    setText('creditsUsed', fmt(creditsUsed) + ' used');
    setText('creditsLimit', fmt(creditsLimit) + ' limit');
    setText('creditsToday', 'Today: ' + fmt(parseInt(b.credits_used_today) || 0));
    setText('creditsRemaining', 'Remaining: ' + fmt(creditsRemain));
    setText('creditsLabel', Math.round(creditsPct) + '% used this month');

    const fill = el('creditsFill');
    if (fill) {
      fill.style.width = creditsPct + '%';
      fill.style.background = creditsPct >= 90 ? '#ef4444' : creditsPct >= 70 ? '#f59e0b' : '#22c55e';
    }
  }

  // ── Sparkline ─────────────────────────────────────────────────────────
  function renderSparkline(byDay) {
    const chart  = el('sparkChart');
    const labels = el('sparkLabels');
    if (!byDay.length) {
      if (chart)  chart.innerHTML  = '<div style="color:var(--muted);font-size:13px;align-self:center;">No data yet</div>';
      if (labels) labels.innerHTML = '';
      return;
    }

    const days   = parseInt(currentRange) || 30;
    const filled = [];
    const now    = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key   = d.toISOString().slice(0, 10);
      const match = byDay.find(r => r.day && r.day.slice(0, 10) === key);
      filled.push({ day: key, cost: match ? parseFloat(match.cost) || 0 : 0 });
    }

    const max = Math.max(...filled.map(r => r.cost), 0.0001);
    if (chart) chart.innerHTML = filled.map(r => {
      const pct = Math.max(Math.round((r.cost / max) * 100), 2);
      return `<div class="spark-bar" style="height:${pct}%" title="${shortDate(r.day)}: ${fmtCost(r.cost)}"></div>`;
    }).join('');

    const mid = Math.floor(filled.length / 2);
    if (labels) labels.innerHTML =
      `<span>${shortDate(filled[0].day)}</span><span>${shortDate(filled[mid].day)}</span><span>${shortDate(filled[filled.length - 1].day)}</span>`;
  }

  // ── Provider + Model grouped bars ─────────────────────────────────────
  function renderModelBars(byModel) {
    const container = el('modelBars');
    if (!container) return;
    if (!byModel.length) { container.innerHTML = '<div class="text-muted text-sm">No data yet</div>'; return; }

    // Group by provider
    const groups = {};
    byModel.forEach(row => {
      const p = row.provider || 'unknown';
      if (!groups[p]) groups[p] = { cost: 0, calls: 0, models: [] };
      groups[p].cost  += parseFloat(row.cost) || 0;
      groups[p].calls += parseInt(row.calls)  || 0;
      groups[p].models.push(row);
    });

    const maxCost = Math.max(...Object.values(groups).map(g => g.cost), 0.0001);

    container.innerHTML = Object.entries(groups).map(([provider, group]) => {
      const pct   = Math.round((group.cost / maxCost) * 100);
      const color = PROVIDER_COLORS[provider] || '#4F8EF7';

      const modelRows = group.models.map(m => {
        const mPct    = group.cost > 0 ? Math.round((parseFloat(m.cost) / group.cost) * 100) : 0;
        const cached  = parseInt(m.cached_tokens) || 0;
        const input   = parseInt(m.input_tokens)  || 0;
        const out     = parseInt(m.output_tokens) || 0;
        const cacheRate = input > 0 ? Math.round((cached / input) * 100) : 0;
        return `
          <div class="model-row">
            <div class="model-label" title="${escHtml(m.model)}">${escHtml(m.model)}</div>
            <div class="bar-track" style="flex:1;">
              <div class="bar-fill" style="width:${mPct}%;background:${color};opacity:0.7;"></div>
            </div>
            <div class="bar-value" style="width:90px;">${fmtCost(parseFloat(m.cost) || 0)}</div>
            <div class="model-tokens">${fmt(input)}in · ${fmt(out)}out${cacheRate > 0 ? ' · ' + cacheRate + '%⚡' : ''}</div>
          </div>`;
      }).join('');

      return `
        <div class="model-group">
          <div class="model-group-header">
            <div class="bar-label" style="width:auto;flex:1;">${escHtml(provider)}</div>
            <div class="bar-track" style="flex:2;height:8px;">
              <div class="bar-fill" style="width:${pct}%;background:${color};"></div>
            </div>
            <div class="bar-value">${fmtCost(group.cost)}</div>
          </div>
          ${modelRows}
        </div>`;
    }).join('');
  }

  // ── By media type bars ────────────────────────────────────────────────
  function renderTypeBars(byType) {
    const container = el('typeBars');
    if (!container) return;
    if (!byType.length) { container.innerHTML = '<div class="text-muted text-sm">No data yet</div>'; return; }

    const maxCost = Math.max(...byType.map(r => parseFloat(r.cost) || 0), 0.0001);
    container.innerHTML = byType.map(row => {
      const cost  = parseFloat(row.cost) || 0;
      const pct   = Math.round((cost / maxCost) * 100);
      const type  = row.media_type || 'text';
      const color = TYPE_COLORS[type] || '#4F8EF7';
      const label = TYPE_LABELS[type] || type;
      return `
        <div class="bar-row">
          <div class="bar-label">${escHtml(label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color};"></div></div>
          <div class="bar-value">${fmtCost(cost)} <span style="font-size:10px;">(${fmt(row.calls)})</span></div>
        </div>`;
    }).join('');
  }

  // ── Cost breakdown by operation ───────────────────────────────────────
  async function loadOperationBreakdown(period) {
    period = period || _breakdownPeriod;
    _breakdownPeriod = period;
    const tbody = el('breakdownTbody');
    const foot  = el('breakdownFoot');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center" style="padding:16px;">Loading…</td></tr>';
    if (foot) foot.hidden = true;
    try {
      const data = await apiFetch(`/ai-usage/cost-breakdown?period=${encodeURIComponent(period)}`);
      renderOperationBreakdown(data);
    } catch (err) {
      const t = el('breakdownTbody');
      if (t) t.innerHTML = '<tr><td colspan="6" class="text-muted text-center" style="padding:16px;">Failed to load</td></tr>';
    }
  }

  function renderOperationBreakdown(data) {
    const tbody = el('breakdownTbody');
    const foot  = el('breakdownFoot');
    const totalEl = el('breakdownTotal');
    if (!tbody) return;

    const ops = data.operations || [];
    if (!ops.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center" style="padding:24px;">No data for this period</td></tr>';
      if (foot) foot.hidden = true;
      return;
    }

    tbody.innerHTML = ops.map((op, i) => {
      const pct = Math.min(op.pct_of_total || 0, 100);
      const imgBadge = op.images > 0
        ? ` <span style="font-size:10px;color:var(--muted);">🖼 ${op.images}</span>`
        : '';
      return `
        <tr>
          <td style="text-align:center;color:var(--muted);font-size:12px;">${i + 1}</td>
          <td style="font-size:12px;">${escHtml(op.operation || 'unknown')}${imgBadge}</td>
          <td style="text-align:right;font-size:12px;">${fmt(op.calls)}</td>
          <td style="text-align:right;font-size:12px;font-weight:600;">${fmtCost(op.cost)}</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px;">
              <div class="breakdown-pct-track"><div class="breakdown-pct-fill" style="width:${pct}%;"></div></div>
              <span style="font-size:11px;color:var(--muted);width:38px;">${pct.toFixed(1)}%</span>
            </div>
          </td>
          <td style="text-align:right;font-size:11px;color:var(--muted);">${fmtCost(op.cost_per_call)}</td>
        </tr>`;
    }).join('');

    if (totalEl) totalEl.textContent = fmtCost(data.total || 0);
    if (foot) foot.hidden = false;
  }

  // ── Generic bar chart ─────────────────────────────────────────────────
  function renderBars(containerId, items, nameKey) {
    const container = el(containerId);
    if (!container) return;
    if (!items.length) { container.innerHTML = '<div class="text-muted text-sm">No data yet</div>'; return; }

    const maxCost = Math.max(...items.map(r => parseFloat(r.cost) || 0), 0.0001);
    container.innerHTML = items.map(item => {
      const cost  = parseFloat(item.cost) || 0;
      const pct   = Math.round((cost / maxCost) * 100);
      const name  = item[nameKey] || 'unknown';
      const color = PROVIDER_COLORS[name] || '#4F8EF7';
      return `
        <div class="bar-row">
          <div class="bar-label">${escHtml(name)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color};"></div></div>
          <div class="bar-value">${fmtCost(cost)}</div>
        </div>`;
    }).join('');
  }

  // ── By writer table ───────────────────────────────────────────────────
  async function loadWriters() {
    try {
      const data = await apiFetch(`/ai-usage/by-writer?range=${currentRange}`);
      renderWriters(data.writers || []);
      populateSessionWriterFilter(data.writers || []);
    } catch (err) {
      const tbody = el('writerTbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-muted text-center" style="padding:24px;">Failed to load</td></tr>';
    }
  }

  function renderWriters(writers) {
    const tbody    = el('writerTbody');
    const countEl  = el('writerCount');
    if (countEl) countEl.textContent = writers.length + ' writers';

    if (!writers.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-muted text-center" style="padding:24px;">No writer usage yet</td></tr>';
      return;
    }

    if (tbody) tbody.innerHTML = writers.map(w => {
      const avatar = w.avatar_url
        ? `<img src="${escHtml(w.avatar_url)}" class="writer-avatar-sm" />`
        : `<span class="writer-initials-sm">${escHtml((w.writer_name || '?')[0].toUpperCase())}</span>`;
      const cached   = parseInt(w.cached_tokens)  || 0;
      const input    = parseInt(w.input_tokens)   || 0;
      const cacheRate = input > 0 ? Math.round((cached / input) * 100) : 0;
      const byokBit  = parseInt(w.byok_calls) > 0
        ? `<span class="byai-badge">${fmt(w.byok_calls)} BYOK</span>`
        : '<span class="platform-badge">platform</span>';

      return `<tr class="writer-usage-row">
        <td>${avatar}${escHtml(w.writer_name || '#' + w.writer_id)}</td>
        <td>${fmt(w.calls)}</td>
        <td>${fmt(input)}</td>
        <td>${fmt(cached)}${cacheRate > 0 ? ` <span style="color:var(--success);font-size:10px;">(${cacheRate}%⚡)</span>` : ''}</td>
        <td>${fmt(w.output_tokens)}</td>
        <td><strong>${fmtCost(parseFloat(w.cost) || 0)}</strong></td>
        <td>${fmt(w.credits)}</td>
        <td>${byokBit}</td>
      </tr>`;
    }).join('');
  }

  // ── Agent sessions ────────────────────────────────────────────────────
  async function loadSessions() {
    try {
      let url = `/ai-usage/sessions?range=${currentRange}&limit=50`;
      if (_sessionWriterId) url += `&writerId=${_sessionWriterId}`;
      const res = await apiFetch(url);
      renderSessions(res.sessions || []);
    } catch (err) {
      const tbody = el('sessionsTbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-muted text-center" style="padding:24px;">Failed to load</td></tr>';
    }
  }

  function populateSessionWriterFilter(writers) {
    const sel = el('sessionWriterFilter');
    if (!sel || !writers.length) return;
    // Keep existing selected value if any
    const current = sel.value;
    sel.innerHTML = '<option value="">All writers</option>'
      + writers.map(w => `<option value="${w.id}"${String(w.id) === current ? ' selected' : ''}>${escHtml(w.name)}</option>`).join('');
  }

  function fmtDuration(ms) {
    const n = parseInt(ms) || 0;
    if (n < 1000) return n + 'ms';
    if (n < 60000) return (n / 1000).toFixed(1) + 's';
    return Math.floor(n / 60000) + 'm ' + Math.round((n % 60000) / 1000) + 's';
  }

  function renderSessions(sessions) {
    const tbody   = el('sessionsTbody');
    const countEl = el('sessionCount');
    if (countEl) countEl.textContent = sessions.length + (sessions.length === 50 ? '+' : '') + ' sessions';

    if (!sessions.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-muted text-center" style="padding:24px;">No agent sessions in this range</td></tr>';
      return;
    }

    if (tbody) tbody.innerHTML = sessions.map(s => {
      const cost    = parseFloat(s.estimated_cost) || 0;
      const cached  = parseInt(s.total_cached_tokens) || 0;
      const input   = parseInt(s.total_input_tokens)  || 0;
      const fresh   = Math.max(input - cached, 0);
      const out     = parseInt(s.total_output_tokens) || 0;
      const cacheRate = input > 0 ? Math.round((cached / input) * 100) : 0;

      const writerCell = s.writer_name
        ? escHtml(s.writer_name)
        : (s.writer_id != null ? `<span class="text-muted">#${s.writer_id}</span>` : '<span class="text-muted">—</span>');

      const cachedHtml = cached > 0
        ? `${fmt(cached)} <span style="color:var(--success);font-size:10px;">(${cacheRate}%⚡)</span>`
        : fmt(cached);

      const ok = s.all_success
        ? '<span class="badge" style="background:#22c55e22;color:#22c55e;">ok</span>'
        : '<span class="badge" style="background:#ef444422;color:#ef4444;">error</span>';

      const ops = Array.isArray(s.operations)
        ? [...new Set(s.operations)].slice(0, 3).join(', ')
        : '';

      return `
        <tr class="session-row" data-id="${escHtml(s.agent_session_id)}" style="cursor:pointer;" title="Click to expand iterations">
          <td style="white-space:nowrap;font-size:12px;">${relTime(s.started_at)}</td>
          <td style="font-size:12px;">${writerCell}</td>
          <td style="font-size:12px;">${escHtml(s.first_provider || '?')} / <span style="color:var(--muted);font-size:11px;">${escHtml(s.first_model || '?')}</span></td>
          <td title="${escHtml(ops)}">${s.iterations}</td>
          <td style="font-size:12px;">${cachedHtml} / ${fmt(fresh)} / ${fmt(out)}</td>
          <td style="font-size:12px;"><strong>${fmtCost(cost)}</strong></td>
          <td style="font-size:12px;color:var(--muted);">${fmtDuration(s.duration_ms)}</td>
          <td>${ok}</td>
        </tr>
        <tr class="session-detail" data-detail="${escHtml(s.agent_session_id)}" hidden>
          <td colspan="8" style="background:var(--bg);padding:12px 16px;"></td>
        </tr>`;
    }).join('');

    if (tbody) tbody.querySelectorAll('.session-row').forEach(row => {
      row.addEventListener('click', () => toggleSessionDetail(row.dataset.id));
    });
  }

  async function toggleSessionDetail(sessionId) {
    const detailRow = document.querySelector(`tr.session-detail[data-detail="${sessionId}"]`);
    if (!detailRow) return;
    if (!detailRow.hidden) { detailRow.hidden = true; return; }
    const cell = detailRow.querySelector('td');
    cell.innerHTML = '<div class="text-muted text-sm">Loading…</div>';
    detailRow.hidden = false;
    try {
      const res   = await apiFetch(`/ai-usage/sessions/${encodeURIComponent(sessionId)}`);
      const iters = res.iterations || [];
      if (!iters.length) { cell.innerHTML = '<div class="text-muted text-sm">No iterations</div>'; return; }
      cell.innerHTML = `
        <table class="data-table" style="margin:0;font-size:12px;">
          <thead><tr>
            <th>#</th><th>Operation</th><th>Provider/Model</th>
            <th>In (cached/fresh)</th><th>Out</th><th>Cost</th><th>Duration</th><th>Key</th><th>Status</th>
          </tr></thead>
          <tbody>
            ${iters.map((it, i) => {
              const cached = parseInt(it.input_tokens_cached) || 0;
              const fresh  = parseInt(it.input_tokens_fresh) || Math.max((parseInt(it.input_tokens) || 0) - cached, 0);
              const cost   = parseFloat(it.estimated_cost) || 0;
              const keyBit = it.is_byai
                ? '<span class="byai-badge">BYOK</span>'
                : '<span class="platform-badge">platform</span>';
              const ok = it.success
                ? '<span class="badge" style="background:#22c55e22;color:#22c55e;">ok</span>'
                : `<span class="badge" style="background:#ef444422;color:#ef4444;" title="${escHtml(it.error_message || '')}">error</span>`;
              return `<tr>
                <td>${i + 1}</td>
                <td>${escHtml(it.operation || '')}</td>
                <td>${escHtml(it.provider || '')}/${escHtml(it.model || '')}</td>
                <td>${fmt(cached)} / ${fmt(fresh)}</td>
                <td>${fmt(parseInt(it.output_tokens) || 0)}</td>
                <td>${fmtCost(cost)}</td>
                <td>${it.duration_ms != null ? it.duration_ms + 'ms' : '—'}</td>
                <td>${keyBit}</td>
                <td>${ok}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    } catch (err) {
      cell.innerHTML = `<div class="text-muted text-sm">Failed: ${escHtml(err.message)}</div>`;
    }
  }

  // ── Call log ──────────────────────────────────────────────────────────
  let _callLogData = [];

  async function loadCallLog(filters) {
    const params = new URLSearchParams({ limit: 200 });
    if (filters?.provider)  params.set('provider',  filters.provider);
    if (filters?.model)     params.set('model',      filters.model);
    if (filters?.operation) params.set('operation',  filters.operation);
    if (filters?.is_byai)   params.set('is_byai',    filters.is_byai);

    try {
      const rows = await apiFetch(`/ai-usage/recent?${params}`);
      _callLogData = rows;
      renderCallLog(rows);
    } catch (err) {
      const tbody = el('callLogTbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="text-muted text-center" style="padding:24px;">Failed to load</td></tr>';
    }
  }

  function renderCallLog(rows) {
    const tbody   = el('callLogTbody');
    const countEl = el('callLogCount');
    if (countEl) countEl.textContent = rows.length + ' calls shown';

    if (!rows.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="text-muted text-center" style="padding:24px;">No calls found</td></tr>';
      return;
    }

    if (tbody) tbody.innerHTML = rows.map(r => {
      const cached = parseInt(r.input_tokens_cached) || 0;
      const input  = parseInt(r.input_tokens)        || 0;
      const fresh  = Math.max(input - cached, 0);
      const out    = parseInt(r.output_tokens)        || 0;
      const cost   = parseFloat(r.estimated_cost)    || 0;
      const dur    = r.duration_ms != null ? r.duration_ms + 'ms' : '—';
      const keyBit = r.is_byai
        ? '<span class="byai-badge">BYOK</span>'
        : '<span class="platform-badge">platform</span>';
      const ok = r.success
        ? '<span class="badge" style="background:#22c55e22;color:#22c55e;font-size:10px;">ok</span>'
        : `<span class="badge" style="background:#ef444422;color:#ef4444;font-size:10px;" title="${escHtml(r.error_message || '')}">err</span>`;
      return `<tr>
        <td style="white-space:nowrap;">${relTime(r.created_at)}</td>
        <td>${escHtml(r.provider || '—')}</td>
        <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${escHtml(r.model || '')}">${escHtml(r.model || '—')}</td>
        <td>${escHtml(r.operation || '—')}</td>
        <td>${fmt(cached)} / ${fmt(fresh)}</td>
        <td>${fmt(out)}</td>
        <td>${fmtCost(cost)}</td>
        <td>${dur}</td>
        <td>${keyBit}</td>
        <td>${ok}</td>
      </tr>`;
    }).join('');
  }

  // Populate filter dropdowns from summary data
  function populateLogFilters(data) {
    const models    = (data.by_model    || []);
    const ops       = (data.by_operation || []);
    const providers = [...new Set(models.map(m => m.provider).filter(Boolean))];
    const modelNames = [...new Set(models.map(m => m.model).filter(Boolean))];
    const opNames   = ops.map(o => o.operation).filter(Boolean);

    const provEl = el('logFilterProvider');
    const modEl  = el('logFilterModel');
    const opEl   = el('logFilterOperation');

    if (provEl && provEl.options.length === 1) {
      providers.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; provEl.appendChild(o); });
    }
    if (modEl && modEl.options.length === 1) {
      modelNames.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; modEl.appendChild(o); });
    }
    if (opEl && opEl.options.length === 1) {
      opNames.forEach(op => { const o = document.createElement('option'); o.value = op; o.textContent = op; opEl.appendChild(o); });
    }
  }

  // ── Errors ────────────────────────────────────────────────────────────
  function renderErrors(errors) {
    const tbody = el('errorsTbody');
    setText('errorCount', errors.length + ' recent');
    if (!errors.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center" style="padding:24px;">No errors 🎉</td></tr>';
      return;
    }
    if (tbody) tbody.innerHTML = errors.map(e => `
      <tr>
        <td style="white-space:nowrap;font-size:12px;">${relTime(e.created_at)}</td>
        <td><span class="badge">${escHtml(e.operation)}</span></td>
        <td style="font-size:12px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(e.error)}</td>
      </tr>`).join('');
  }

  // ── ElevenLabs ────────────────────────────────────────────────────────
  async function loadElevenLabs() {
    try {
      const data = await apiFetch('/ai-usage/elevenlabs');
      if (!data || !data.configured) return;
      el('elCard').hidden = false;
      const pct = data.character_limit > 0 ? Math.round((data.character_count / data.character_limit) * 1000) / 10 : 0;
      setText('elTier', (data.tier || 'free') + (data.status && data.status !== 'active' ? ' (' + data.status + ')' : ''));
      setText('elUsed', fmt(data.character_count) + ' / ' + fmt(data.character_limit) + ' characters');
      setText('elPct', pct + '% used');
      setText('elVoices', 'Voices: ' + (data.voice_slots_used || 0) + ' / ' + (data.voice_limit || 0));
      if (data.next_reset_unix) {
        const d = new Date(data.next_reset_unix * 1000);
        const days = Math.ceil((d - Date.now()) / 86400000);
        setText('elReset', 'Resets in ' + days + 'd (' + (d.getMonth() + 1) + '/' + d.getDate() + ')');
      }
      const fill = el('elFill');
      if (fill) { fill.style.width = Math.min(pct, 100) + '%'; fill.style.background = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#8B5CF6'; }
    } catch (e) { /* optional */ }
  }

  // ── Credits / promo section ───────────────────────────────────────────
  async function loadCreditsSection() {
    try {
      const promos = await apiFetch('/promo/active');
      const promoEl = el('activePromos');
      if (promoEl && promos.redemptions?.length > 0) {
        promoEl.innerHTML = promos.redemptions.map(r =>
          `<div style="margin-bottom:4px;">✓ <strong>${escHtml(r.code)}</strong> — ${fmt(r.bonus_credits)} bonus credits${r.expires_at ? ' (expires ' + new Date(r.expires_at).toLocaleDateString() + ')' : ''}</div>`
        ).join('');
      }

      const packsData = await apiFetch('/credits/packs');
      const packsEl = el('creditPacks');
      if (packsEl && packsData.packs?.length > 0) {
        packsEl.innerHTML = `
          <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:#aaa;">Buy More Credits</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${packsData.packs.map(p => `
              <button class="btn btn-sm buy-pack-btn" data-id="${p.id}" style="display:flex;flex-direction:column;align-items:center;padding:8px 16px;line-height:1.4;">
                <span style="font-weight:600">${p.credits.toLocaleString()} credits</span>
                <span style="font-size:11px;color:#888;">$${Math.round(p.price_cents / 100)}</span>
              </button>`).join('')}
          </div>`;
        packsEl.querySelectorAll('.buy-pack-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = 'Redirecting…';
            try {
              const res = await apiFetch('/credits/checkout', { method:'POST', body: JSON.stringify({ packId: parseInt(btn.dataset.id) }) });
              if (res.checkout_url) window.location.href = res.checkout_url;
            } catch (err) { showAlert(err.message, 'error'); btn.disabled = false; }
          });
        });
      }

      const params = new URLSearchParams(location.search);
      if (params.get('credits') === 'purchased') {
        showAlert('Credits purchased successfully!', 'success');
        history.replaceState({}, '', location.pathname);
      } else if (params.get('credits') === 'cancelled') {
        showAlert('Credit purchase cancelled', 'error');
        history.replaceState({}, '', location.pathname);
      }
    } catch { /* optional */ }
  }

  el('redeemPromoBtn')?.addEventListener('click', async () => {
    const input = el('promoCodeInput');
    const code  = input?.value?.trim();
    if (!code) return;
    try {
      const res = await apiFetch('/promo/redeem', { method:'POST', body: JSON.stringify({ code }) });
      showAlert(`Redeemed! +${fmt(res.bonus_credits)} bonus credits`, 'success');
      input.value = '';
      await loadCreditsSection();
      await loadData();
    } catch (err) { showAlert(err.message, 'error'); }
  });

  // ── Range tabs ────────────────────────────────────────────────────────
  el('rangeTabs')?.addEventListener('click', e => {
    const tab = e.target.closest('.range-tab');
    if (!tab) return;
    document.querySelectorAll('.range-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentRange = tab.dataset.range;
    loadData();
  });

  el('refreshBtn')?.addEventListener('click', loadData);

  // ── Call log filter controls ──────────────────────────────────────────
  el('logFilterApply')?.addEventListener('click', () => {
    loadCallLog({
      provider:  el('logFilterProvider')?.value  || '',
      model:     el('logFilterModel')?.value     || '',
      operation: el('logFilterOperation')?.value || '',
      is_byai:   el('logFilterByok')?.value      || '',
    });
  });

  el('logFilterReset')?.addEventListener('click', () => {
    ['logFilterProvider','logFilterModel','logFilterOperation','logFilterByok'].forEach(id => {
      const e = el(id); if (e) e.value = '';
    });
    loadCallLog();
  });

  el('sessionWriterFilter')?.addEventListener('change', e => {
    _sessionWriterId = e.target.value ? parseInt(e.target.value) : null;
    loadSessions();
  });

  el('sessionFilterReset')?.addEventListener('click', () => {
    _sessionWriterId = null;
    const sel = el('sessionWriterFilter');
    if (sel) sel.value = '';
    loadSessions();
  });

  el('breakdownPeriodTabs')?.addEventListener('click', e => {
    const tab = e.target.closest('.breakdown-period-tab');
    if (!tab) return;
    document.querySelectorAll('.breakdown-period-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loadOperationBreakdown(tab.dataset.period);
  });

  // ── Init ──────────────────────────────────────────────────────────────
  renderSidebar();
  loadData();
  loadCreditsSection();
  loadOperationBreakdown('today');
  window.pageRefresh = function () { loadData(); loadCreditsSection(); loadOperationBreakdown(_breakdownPeriod); };
})();
