/* ===== Pipeline Page ===== */
onReady(async () => {
  if (!requireAuth()) return;
  renderSidebar();

  const loadingMsg    = document.getElementById('loadingMsg');
  const writersSection = document.getElementById('writersSection');
  const writersTbody  = document.getElementById('writersTbody');
  const generatedAt   = document.getElementById('generatedAt');
  const queueSection  = document.getElementById('queueSection');
  const queueTbody    = document.getElementById('queueTbody');
  const historySection = document.getElementById('historySection');
  const historyTbody  = document.getElementById('historyTbody');
  const forecastSection = document.getElementById('forecastSection');
  const forecastTbody  = document.getElementById('forecastTbody');
  const watchlistSection = document.getElementById('watchlistSection');
  const wantedChips   = document.getElementById('wantedChips');
  const blockedChips  = document.getElementById('blockedChips');
  const watchlistInput = document.getElementById('watchlistInput');
  const watchlistType  = document.getElementById('watchlistType');
  const addWatchlistBtn = document.getElementById('addWatchlistBtn');
  const refreshBtn    = document.getElementById('refreshBtn');
  const runSelectedBtn = document.getElementById('runSelectedBtn');
  const selectedCount  = document.getElementById('selectedCount');
  const selectAll      = document.getElementById('selectAll');

  // Track queue items for selective run
  let queueItems = []; // { writerId, clusterIndex, topic }

  async function loadPipeline() {
    loadingMsg.style.display = '';
    writersSection.style.display = 'none';
    queueSection.style.display = 'none';
    forecastSection.style.display = 'none';
    historySection.style.display = 'none';

    try {
      const [overview, history, forecasts, watchlist] = await Promise.all([
        apiFetch('/synthesis/pipeline-overview'),
        apiFetch('/synthesis/history'),
        apiFetch('/synthesis/forecasts'),
        apiFetch('/synthesis/watchlist'),
      ]);

      loadingMsg.style.display = 'none';
      renderWriters(overview);
      renderQueue(overview);
      renderWatchlist(watchlist);
      renderForecasts(forecasts);
      renderHistory(history);
    } catch (err) {
      loadingMsg.textContent = 'Error loading pipeline: ' + err.message;
    }
  }

  function computeNextRun(schedule) {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcDow = now.getUTCDay();

    if (schedule === 'daily') {
      const next = new Date(now);
      next.setUTCHours(6, 0, 0, 0);
      if (utcH >= 6) next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
    if (schedule === 'twice-daily') {
      const next = new Date(now);
      if (utcH < 6) { next.setUTCHours(6, 0, 0, 0); }
      else if (utcH < 18) { next.setUTCHours(18, 0, 0, 0); }
      else { next.setUTCDate(next.getUTCDate() + 1); next.setUTCHours(6, 0, 0, 0); }
      return next;
    }
    if (schedule === 'weekly') {
      const next = new Date(now);
      const daysUntilMon = (1 - utcDow + 7) % 7 || (utcH >= 6 ? 7 : 0);
      next.setUTCDate(next.getUTCDate() + daysUntilMon);
      next.setUTCHours(6, 0, 0, 0);
      return next;
    }
    return null;
  }

  function formatRelative(date) {
    if (!date) return '—';
    const diff = date.getTime() - Date.now();
    if (diff < 0) return 'now';
    const hours = Math.floor(diff / 3_600_000);
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  function renderWriters(overview) {
    generatedAt.textContent = overview.generatedAt ? `Updated ${new Date(overview.generatedAt).toLocaleTimeString()}` : '';
    const writers = overview.writers || [];

    writersTbody.innerHTML = writers.map(w => {
      const schedule = w.writer.schedule || 'daily';
      const nextRun = computeNextRun(schedule);
      const cooldown = w.cooldown || {};
      const cooldownHtml = cooldown.active
        ? `<span class="cooldown-badge cooldown-active">${Math.round(cooldown.hoursSinceLastRun)}h ago</span>`
        : `<span class="cooldown-badge cooldown-ready">Ready</span>`;
      const clusters = w.clusters || [];
      const wouldGenerate = clusters.filter(c => !c.wouldSkipDedup).length;
      const clusterClass = clusters.length > 0 ? '' : 'cluster-count-zero';

      return `<tr>
        <td><strong>${esc(w.writer.name)}</strong></td>
        <td><span class="schedule-badge">${esc(schedule)}</span></td>
        <td>${nextRun ? `${formatRelative(nextRun)} <span class="text-muted text-sm">(${nextRun.toUTCString().slice(0, 22)})</span>` : '—'}</td>
        <td>${cooldownHtml}</td>
        <td>${w.articlePool?.total || 0}</td>
        <td><span class="cluster-count ${clusterClass}">${clusters.length}</span></td>
        <td><span class="cluster-count ${clusterClass}">${wouldGenerate}</span></td>
      </tr>`;
    }).join('');

    writersSection.style.display = '';
  }

  function renderQueue(overview) {
    queueItems = [];
    const writers = overview.writers || [];

    for (const w of writers) {
      (w.clusters || []).forEach((c, ci) => {
        queueItems.push({
          writerId: w.writer.id,
          writerName: w.writer.name,
          clusterIndex: ci,
          topic: c.topic,
          articleCount: c.articleCount,
          strength: c.strength || 0,
          wouldSkipDedup: c.wouldSkipDedup,
          overlapPct: c.overlapPct,
          proposedHeadline: c.proposedHeadline,
          watchlist: c.watchlist || {},
        });
      });
    }

    if (!queueItems.length) {
      queueTbody.innerHTML = `<tr><td colspan="7" class="text-muted" style="padding:20px;text-align:center;">No pending clusters across any writer</td></tr>`;
    } else {
      queueTbody.innerHTML = queueItems.map((item, i) => {
        const strengthClass = item.strength >= 0.3 ? 'strength-high' : item.strength >= 0.15 ? 'strength-med' : 'strength-low';
        const strengthLabel = item.strength >= 0.3 ? 'High' : item.strength >= 0.15 ? 'Med' : 'Low';
        const dedupHtml = item.wouldSkipDedup
          ? `<span class="dedup-warn">Skip (${item.overlapPct}%)</span>`
          : `<span class="dedup-ok">OK</span>`;
        const wl = item.watchlist || {};
        const wlBadges = [
          ...(wl.wanted ? [`<span class="watchlist-wanted">wanted: ${esc(wl.wantedKeywords.join(', '))}</span>`] : []),
          ...(wl.blocked ? [`<span class="watchlist-blocked">blocked: ${esc(wl.blockedKeywords.join(', '))}</span>`] : []),
        ].join(' ');
        const disabled = item.wouldSkipDedup || wl.blocked ? 'disabled' : '';
        return `<tr${wl.blocked ? ' style="opacity:0.5;"' : ''}>
          <td><input type="checkbox" class="queue-check" data-idx="${i}" ${disabled}></td>
          <td>${esc(item.writerName)}</td>
          <td>${esc(item.topic)} ${wlBadges}</td>
          <td>${item.articleCount}</td>
          <td><span class="${strengthClass}">${strengthLabel} (${item.strength})</span></td>
          <td>${dedupHtml}</td>
          <td><span class="proposed-headline">${esc(item.proposedHeadline || '')}</span></td>
        </tr>`;
      }).join('');
    }

    queueSection.style.display = '';
    updateSelectedCount();
  }

  function renderWatchlist(entries) {
    const wanted = (entries || []).filter(e => e.type === 'wanted');
    const blocked = (entries || []).filter(e => e.type === 'blocked');

    wantedChips.innerHTML = wanted.length
      ? wanted.map(e => `<span class="chip chip-wanted">${esc(e.keyword)} <span class="chip-delete" data-id="${e.id}">&times;</span></span>`).join('')
      : '<span class="text-muted text-sm">None</span>';

    blockedChips.innerHTML = blocked.length
      ? blocked.map(e => `<span class="chip chip-blocked">${esc(e.keyword)} <span class="chip-delete" data-id="${e.id}">&times;</span></span>`).join('')
      : '<span class="text-muted text-sm">None</span>';

    watchlistSection.style.display = '';
  }

  // Watchlist: add entry
  addWatchlistBtn.addEventListener('click', async () => {
    const keyword = watchlistInput.value.trim();
    const type = watchlistType.value;
    if (!keyword) return showToast('Enter a keyword', 'error');
    addWatchlistBtn.disabled = true;
    try {
      await apiFetch('/synthesis/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, type }),
      });
      watchlistInput.value = '';
      showToast(`Added "${keyword}" as ${type}`, 'success');
      loadPipeline();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      addWatchlistBtn.disabled = false;
    }
  });

  // Watchlist: delete entry (delegated)
  document.addEventListener('click', async (e) => {
    if (!e.target.classList.contains('chip-delete')) return;
    const id = e.target.dataset.id;
    if (!id) return;
    try {
      await apiFetch(`/synthesis/watchlist/${id}`, { method: 'DELETE' });
      showToast('Removed', 'success');
      loadPipeline();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  function renderForecasts(forecasts) {
    if (!forecasts || !forecasts.length) {
      forecastTbody.innerHTML = `<tr><td colspan="5" class="text-muted" style="padding:20px;text-align:center;">No forecasts yet. Forecasts are generated 1 hour before scheduled synthesis runs.</td></tr>`;
    } else {
      forecastTbody.innerHTML = forecasts.map(f => {
        const summary = typeof f.summary === 'string' ? JSON.parse(f.summary) : (f.summary || {});
        const statusClass = f.status === 'pending' ? 'status-success' : f.status === 'stale' ? 'text-muted' : '';
        return `<tr>
          <td>${esc(f.writer_name)}</td>
          <td>${new Date(f.forecast_at).toLocaleString()}</td>
          <td>${summary.totalClusters || 0}</td>
          <td>${summary.wouldGenerate || 0}</td>
          <td><span class="${statusClass}">${esc(f.status)}</span></td>
        </tr>`;
      }).join('');
    }
    forecastSection.style.display = '';
  }

  function renderHistory(data) {
    const runs = data.runs || [];
    if (!runs.length) {
      historyTbody.innerHTML = `<tr><td colspan="4" class="text-muted" style="padding:20px;text-align:center;">No synthesis runs yet</td></tr>`;
    } else {
      historyTbody.innerHTML = runs.map(r => {
        const statusClass = r.status === 'success' ? 'status-success' : r.status === 'failed' ? 'status-failed' : '';
        let summaryText = '—';
        if (r.summary) {
          const s = typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary;
          if (s.writers !== undefined) summaryText = `${s.writers} writer(s)`;
          if (s.results) {
            const total = s.results.reduce((acc, r) => acc + (r.generated || 0), 0);
            summaryText += `, ${total} generated`;
          }
          if (s.generated !== undefined) summaryText = `${s.generated} generated, ${s.skipped || 0} skipped`;
        }
        return `<tr>
          <td>${new Date(r.started_at).toLocaleString()}</td>
          <td>${esc(r.job_name)}</td>
          <td><span class="${statusClass}">${esc(r.status)}</span></td>
          <td class="text-sm">${esc(summaryText)}</td>
        </tr>`;
      }).join('');
    }
    historySection.style.display = '';
  }

  function updateSelectedCount() {
    const checks = document.querySelectorAll('.queue-check:checked');
    const count = checks.length;
    selectedCount.textContent = `${count} selected`;
    runSelectedBtn.disabled = count === 0;
  }

  // Event: select all
  selectAll.addEventListener('change', () => {
    document.querySelectorAll('.queue-check:not(:disabled)').forEach(cb => { cb.checked = selectAll.checked; });
    updateSelectedCount();
  });

  // Event: individual checkbox
  queueTbody.addEventListener('change', (e) => {
    if (e.target.classList.contains('queue-check')) updateSelectedCount();
  });

  // Event: run selected clusters
  runSelectedBtn.addEventListener('click', async () => {
    const checks = document.querySelectorAll('.queue-check:checked');
    if (!checks.length) return;

    // Group selected items by writer
    const byWriter = {};
    checks.forEach(cb => {
      const idx = parseInt(cb.dataset.idx);
      const item = queueItems[idx];
      if (!item) return;
      if (!byWriter[item.writerId]) byWriter[item.writerId] = [];
      byWriter[item.writerId].push(item.clusterIndex);
    });

    runSelectedBtn.disabled = true;
    runSelectedBtn.textContent = 'Running...';

    const results = [];
    for (const [writerId, indices] of Object.entries(byWriter)) {
      try {
        const result = await apiFetch(`/synthesis/run/${writerId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clusterIndices: indices }),
        });
        results.push({ writerId, ...result });
      } catch (err) {
        results.push({ writerId, error: err.message });
      }
    }

    const totalGenerated = results.reduce((acc, r) => acc + (r.generated || 0), 0);
    showToast(`Generated ${totalGenerated} article(s) from ${checks.length} cluster(s)`, totalGenerated > 0 ? 'success' : 'error');

    runSelectedBtn.disabled = false;
    runSelectedBtn.textContent = 'Run Selected';
    loadPipeline(); // refresh
  });

  // Event: refresh
  refreshBtn.addEventListener('click', loadPipeline);

  // Initial load
  loadPipeline();

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // ══════════════════════════════════════════════════════════════════
  // Orchestration Pipeline UI
  // ══════════════════════════════════════════════════════════════════

  const orchRunList      = document.getElementById('orchRunList');
  const orchStats        = document.getElementById('orchStats');
  const orchStatusFilter = document.getElementById('orchStatusFilter');
  const orchScoutBtn     = document.getElementById('orchScoutBtn');
  const orchCycleBtn     = document.getElementById('orchCycleBtn');

  if (!orchRunList) return; // Section not present

  let orchOffset = 0;
  const ORCH_PAGE = 20;

  function relTime(iso) {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    return `${Math.round(diff / 86400000)}d ago`;
  }

  function stageDot(status) {
    return `<span class="orch-stage-dot orch-dot-${status}"></span>`;
  }

  function stageBadge(status) {
    const labels = { scout:'Scout', skeptic:'Verifying', research:'Researching',
      writing:'Writing', review:'Reviewing', paused:'Needs Review',
      published:'Published', rejected:'Rejected', error:'Error', approved:'Approved' };
    return `<span class="orch-badge orch-bg-${status}">${labels[status] || status}</span>`;
  }

  function renderOrchStats(stats) {
    if (!orchStats || !stats) return;
    orchStats.innerHTML = [
      { n: stats.in_progress, l: 'In Progress' },
      { n: stats.paused,      l: 'Needs Review', highlight: stats.paused > 0 },
      { n: stats.published,   l: 'Published' },
      { n: stats.today,       l: 'Today' },
      { n: stats.total,       l: 'All Time' },
    ].map(s => `
      <div class="orch-stat-pill" ${s.highlight ? 'style="border-color:rgba(239,68,68,.4)"' : ''}>
        <div class="num" ${s.highlight ? 'style="color:#f87171"' : ''}>${s.n}</div>
        <div class="lbl">${s.l}</div>
      </div>
    `).join('');
  }

  function renderOrchRun(run) {
    const stageData = run.stage_data || {};
    const skeptic = stageData.skeptic || {};

    const gateHtml = run.human_gate_required ? `
      <div class="orch-gate-banner">
        <p class="orch-gate-reason"><strong>Needs review:</strong> ${esc(run.human_gate_reason || 'Human approval required')}</p>
        ${skeptic.conflicts && skeptic.conflicts.length ? `
          <ul class="orch-conflicts">
            ${skeptic.conflicts.map(c => `<li>${esc(c)}</li>`).join('')}
          </ul>` : ''}
        <div class="orch-action-row">
          <button class="btn-orch-approve" data-id="${run.id}" data-action="approve">Approve &amp; continue</button>
          <button class="btn-orch-reject"  data-id="${run.id}" data-action="reject">Kill story</button>
        </div>
      </div>` : '';

    const articleHtml = run.article_id ? `
      <div class="orch-detail">Article: <span>
        ${run.article_slug
          ? `<a href="/article-editor.html?id=${run.article_id}" class="text-primary" style="font-size:12px;">${esc(run.article_title || `#${run.article_id}`)}</a>`
          : esc(run.article_title || `#${run.article_id}`)
        }
        ${run.article_published ? '<span style="color:#4ade80;font-size:10px;margin-left:4px;">LIVE</span>' : '<span style="color:#fb923c;font-size:10px;margin-left:4px;">Draft</span>'}
      </span></div>` : '';

    const writerHtml = run.writer_name
      ? `<div class="orch-detail">Writer: <span>${esc(run.writer_name)}</span></div>` : '';

    const confidenceHtml = skeptic.confidence !== undefined
      ? `<div class="orch-detail">Confidence: <span>${Math.round(skeptic.confidence * 100)}%</span></div>` : '';

    const sourcesHtml = skeptic.independent_sources !== undefined
      ? `<div class="orch-detail">Independent sources: <span>${skeptic.independent_sources}</span></div>` : '';

    const gapsHtml = skeptic.gaps && skeptic.gaps.length ? `
      <div class="orch-detail">Gaps identified:</div>
      <ul class="orch-gaps">${skeptic.gaps.slice(0,3).map(g => `<li>${esc(g)}</li>`).join('')}</ul>
    ` : '';

    const advanceHtml = !run.human_gate_required &&
      !['paused','published','rejected','error','approved'].includes(run.status) ? `
      <div class="orch-action-row">
        <button class="btn-orch-advance" data-id="${run.id}" data-action="advance">Advance now</button>
      </div>` : '';

    const errorHtml = run.error_message
      ? `<div class="orch-detail" style="color:#ef4444;">Error: <span>${esc(run.error_message)}</span></div>` : '';

    return `
      <div class="orch-run" data-run-id="${run.id}">
        <div class="orch-run-header">
          ${stageDot(run.status)}
          <div class="orch-topic" title="${esc(run.topic)}">${esc(run.topic || 'Untitled story')}</div>
          ${stageBadge(run.status)}
          <span class="orch-meta">${relTime(run.updated_at || run.created_at)}</span>
        </div>
        <div class="orch-run-body" id="orchBody_${run.id}">
          ${gateHtml}
          ${articleHtml}
          ${writerHtml}
          ${confidenceHtml}
          ${sourcesHtml}
          ${gapsHtml}
          ${errorHtml}
          ${advanceHtml}
        </div>
      </div>`;
  }

  async function loadOrchRuns(append = false) {
    const status = orchStatusFilter ? orchStatusFilter.value : '';
    try {
      const params = new URLSearchParams({ limit: ORCH_PAGE, offset: orchOffset });
      if (status) params.set('status', status);

      const [runsData, statsData] = await Promise.all([
        apiFetch(`/orchestrator/runs?${params}`),
        apiFetch('/orchestrator/stats'),
      ]);

      if (!append) {
        orchRunList.innerHTML = '';
        renderOrchStats(statsData);
      }

      if (!runsData.runs || !runsData.runs.length) {
        if (!append) orchRunList.innerHTML = '<div class="orch-empty">No pipeline runs yet. Click "Scout now" to discover stories.</div>';
        return;
      }

      runsData.runs.forEach(run => {
        const el = document.createElement('div');
        el.innerHTML = renderOrchRun(run);
        orchRunList.appendChild(el.firstElementChild);
      });
    } catch (err) {
      if (!append) orchRunList.innerHTML = `<div class="orch-empty" style="color:#ef4444;">Error loading pipeline: ${esc(err.message)}</div>`;
    }
  }

  // Expand/collapse run body on click
  orchRunList.addEventListener('click', async (e) => {
    const header = e.target.closest('.orch-run-header');
    if (header) {
      const card = header.closest('.orch-run');
      const body = card.querySelector('.orch-run-body');
      if (body) body.classList.toggle('open');
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const runId = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === 'approve') {
      btn.disabled = true;
      btn.textContent = 'Approving…';
      try {
        await apiFetch(`/orchestrator/runs/${runId}/approve`, { method: 'POST', body: {} });
        showToast('Story approved — advancing pipeline', 'success');
        orchOffset = 0;
        loadOrchRuns();
      } catch (err) {
        showToast('Approve failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Approve & continue';
      }
    }

    if (action === 'reject') {
      if (!confirm('Kill this story and archive any draft? This cannot be undone.')) return;
      btn.disabled = true;
      try {
        await apiFetch(`/orchestrator/runs/${runId}/reject`, { method: 'POST', body: {} });
        showToast('Story rejected', 'success');
        orchOffset = 0;
        loadOrchRuns();
      } catch (err) {
        showToast('Reject failed: ' + err.message, 'error');
        btn.disabled = false;
      }
    }

    if (action === 'advance') {
      btn.disabled = true;
      btn.textContent = 'Advancing…';
      try {
        const result = await apiFetch(`/orchestrator/runs/${runId}/advance`, { method: 'POST', body: {} });
        showToast(`Advanced to ${result.nextStage}`, 'success');
        orchOffset = 0;
        loadOrchRuns();
      } catch (err) {
        showToast('Advance failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Advance now';
      }
    }
  });

  // Filter change
  if (orchStatusFilter) {
    orchStatusFilter.addEventListener('change', () => { orchOffset = 0; loadOrchRuns(); });
  }

  // Scout now
  if (orchScoutBtn) {
    orchScoutBtn.addEventListener('click', async () => {
      orchScoutBtn.disabled = true;
      orchScoutBtn.textContent = 'Scouting…';
      try {
        const result = await apiFetch('/orchestrator/scout', { method: 'POST', body: {} });
        showToast(`Scout found ${result.scout_created} new story opportunity${result.scout_created !== 1 ? 's' : ''}`, result.scout_created > 0 ? 'success' : 'info');
        orchOffset = 0;
        loadOrchRuns();
      } catch (err) {
        showToast('Scout failed: ' + err.message, 'error');
      } finally {
        orchScoutBtn.disabled = false;
        orchScoutBtn.textContent = 'Scout now';
      }
    });
  }

  // Run full cycle
  if (orchCycleBtn) {
    orchCycleBtn.addEventListener('click', async () => {
      orchCycleBtn.disabled = true;
      orchCycleBtn.textContent = 'Running…';
      try {
        const result = await apiFetch('/orchestrator/trigger', { method: 'POST', body: {} });
        const r = result.result || {};
        showToast(
          `Cycle done — ${r.scout_created || 0} scouted, ${r.advanced || 0} advanced, ${r.published || 0} published`,
          'success'
        );
        orchOffset = 0;
        loadOrchRuns();
      } catch (err) {
        showToast('Cycle failed: ' + err.message, 'error');
      } finally {
        orchCycleBtn.disabled = false;
        orchCycleBtn.textContent = 'Run cycle';
      }
    });
  }

  // Initial load
  loadOrchRuns();
  window.pageRefresh = loadOrchRuns;
});
