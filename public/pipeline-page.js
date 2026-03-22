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
});
