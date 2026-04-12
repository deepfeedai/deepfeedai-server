/* ===== Synthesis Page ===== */
onReady(async () => {
  if (!requireAuth()) return;
  renderSidebar();

  // Load feature flags and gate synthesis controls
  await loadAdminFeatures();
  if (!isFeatureOn('auto_synthesis')) {
    var synthControls = document.querySelector('.main-content') || document.querySelector('.content');
    if (synthControls) {
      synthControls.insertAdjacentHTML('afterbegin', featureGateBanner('Auto Synthesis'));
    }
    document.querySelectorAll('#runBtn, #runAllBtn, #dryRunBtn, #previewBtn').forEach(function(btn) {
      btn.disabled = true;
      btn.classList.add('feature-locked');
      btn.title = 'Auto Synthesis is not available on your current plan';
    });
  }

  const writerSelect = document.getElementById('writerSelect');
  const previewBtn   = document.getElementById('previewBtn');
  const dryRunBtn    = document.getElementById('dryRunBtn');
  const runBtn       = document.getElementById('runBtn');
  const runAllBtn    = document.getElementById('runAllBtn');
  const clusterSection = document.getElementById('clusterSection');
  const clusterTbody   = document.getElementById('clusterTbody');
  const clusterLabel   = document.getElementById('clusterWriterLabel');
  const statsSection   = document.getElementById('statsSection');
  const statsRow       = document.getElementById('statsRow');
  const resultSection  = document.getElementById('resultSection');
  const resultBody     = document.getElementById('resultBody');

  // Load auto-writers
  try {
    const writers = await apiFetch('/writers');
    const autoWriters = writers.filter(w => w.beats && w.beats.length && w.beats[0] !== null);
    writerSelect.innerHTML = autoWriters.length
      ? autoWriters.map(w => `<option value="${w.id}">${w.name} (${w.beats.join(', ') || 'general'})</option>`).join('')
      : '<option value="">No auto-writers found</option>';
  } catch (err) {
    writerSelect.innerHTML = '<option value="">Error loading writers</option>';
  }

  // --- Shared cluster rendering ---
  function renderClusterResults(data) {
    // Stats bar
    const cooldown = data.cooldown || {};
    const pool = data.articlePool || {};
    const summary = data.summary || {};
    const cooldownHtml = cooldown.active
      ? `<span class="cooldown-badge cooldown-active">Cooldown: ${Math.round(cooldown.hoursSinceLastRun)}h ago</span>`
      : `<span class="cooldown-badge cooldown-ready">Ready</span>`;

    const showDiagBtn = (pool.total || 0) === 0 || (data.clusters || []).length === 0;
    statsRow.innerHTML = `
      ${cooldownHtml}
      <div class="stat-pill"><span class="stat-value">${pool.total || 0}</span><span class="stat-label">Article Pool</span></div>
      <div class="stat-pill"><span class="stat-value">${pool.writerScoped || 0}</span><span class="stat-label">Writer-Scoped</span></div>
      <div class="stat-pill"><span class="stat-value">${pool.beatFallback || 0}</span><span class="stat-label">Beat Fallback</span></div>
      <div class="stat-pill"><span class="stat-value">${(data.clusters || []).length}</span><span class="stat-label">Clusters</span></div>
      ${summary.wouldGenerate !== undefined ? `<div class="stat-pill"><span class="stat-value">${summary.wouldGenerate}</span><span class="stat-label">Would Generate</span></div>` : ''}
      ${summary.wouldSkipDedup ? `<div class="stat-pill"><span class="stat-value">${summary.wouldSkipDedup}</span><span class="stat-label">Would Skip (Dedup)</span></div>` : ''}
      ${showDiagBtn ? `<button class="btn btn-outline btn-sm" type="button" id="diagnoseBtn" style="margin-left:8px;">Why no results?</button>` : ''}
    `;
    statsSection.style.display = '';

    const diagnoseBtn = document.getElementById('diagnoseBtn');
    if (diagnoseBtn) {
      diagnoseBtn.addEventListener('click', async function () {
        const writerId = (data.writer || {}).id;
        if (!writerId) return;
        diagnoseBtn.disabled = true;
        diagnoseBtn.textContent = 'Analyzing...';
        try {
          const diag = await apiFetch('/synthesis/diagnose/' + writerId);
          renderDiagnostic(diag);
        } catch (err) {
          showToast(err.message || 'Diagnostic failed', 'error');
        } finally {
          diagnoseBtn.disabled = false;
          diagnoseBtn.textContent = 'Why no results?';
        }
      });
    }

    // Writer label
    const writer = data.writer || {};
    clusterLabel.textContent = writer.name || '';

    // Clusters table
    const clusters = data.clusters || [];
    if (!clusters.length) {
      clusterTbody.innerHTML = `<tr><td colspan="6" class="text-muted text-center" style="padding:24px;">No clusters found — ${pool.total || 0} articles in lookback window. Try fetching more articles or lowering min_cluster_size.</td></tr>`;
    } else {
      clusterTbody.innerHTML = clusters.map((c, i) => {
        const sourceCount = (c.articles || []).length;
        const uniqueSources = [...new Set((c.articles || []).map(a => a.source).filter(Boolean))];
        const dedupHtml = c.wouldSkipDedup
          ? `<span class="dedup-warn">Skip (${c.overlapPct}% overlap)</span>`
          : `<span class="dedup-ok">OK</span>`;
        const strength = c.strength || 0;
        const strengthClass = strength >= 0.3 ? 'strength-high' : strength >= 0.15 ? 'strength-med' : 'strength-low';
        const strengthLabel = strength >= 0.3 ? 'High' : strength >= 0.15 ? 'Med' : 'Low';
        const sourceRows = (c.articles || []).map(a =>
          `<li>${esc(a.title)} ${a.source ? `<span class="text-muted">(${esc(a.source)})</span>` : ''}${a.source_url ? ` <a href="${esc(a.source_url)}" target="_blank" rel="noopener">link</a>` : ''}</li>`
        ).join('');
        return `
          <tr>
            <td>${i + 1}</td>
            <td>
              ${esc(c.topic)}
              ${c.proposedHeadline ? `<div class="proposed-headline">${esc(c.proposedHeadline)}</div>` : ''}
              <div id="sources-${i}" style="display:none;">
                <ul class="source-list">${sourceRows}</ul>
              </div>
            </td>
            <td>${c.articleCount}</td>
            <td><span class="${strengthClass}">${strengthLabel} (${strength})</span></td>
            <td>
              <span class="expand-toggle" onclick="toggleSources(${i})">${sourceCount} articles from ${uniqueSources.length} source${uniqueSources.length !== 1 ? 's' : ''}</span>
            </td>
            <td>${dedupHtml}</td>
          </tr>`;
      }).join('');
    }
    clusterSection.style.display = '';
  }

  // --- Diagnostic renderer ---
  function renderDiagnostic(diag) {
    const REASON_COLORS = { error: '#c33', warn: '#d80', info: '#06c', ok: '#2a7' };
    const levelLabel = { error: 'Blocker', warn: 'Warning', info: 'Info', ok: 'Healthy' };

    const reasonsHtml = (diag.reasons || []).map(function (r) {
      const color = REASON_COLORS[r.level] || '#555';
      return '<div style="border-left:3px solid ' + color + ';padding:8px 12px;margin-bottom:6px;background:var(--surface2);border-radius:4px;"><strong style="color:' + color + ';">' + levelLabel[r.level] + ':</strong> ' + esc(r.message) + '</div>';
    }).join('');

    const sources = diag.sources || {};
    const articles = diag.articles || {};
    const clustering = diag.clustering || {};
    const beats = (diag.beats || []).map(function (b) { return b.name; }).join(', ') || '(none)';

    const countsHtml =
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0;">' +
      statCard('Beats', beats) +
      statCard('Sources (active / total)', sources.active + ' / ' + sources.total) +
      statCard('Never fetched', sources.neverFetched) +
      statCard('Stale (>24h)', sources.stale) +
      statCard('Last fetch', sources.lastFetchAt ? new Date(sources.lastFetchAt).toLocaleString() : 'Never') +
      statCard('Curated articles (lookback)', articles.inLookbackWindow) +
      statCard('Matching this writer\'s beats', articles.matchingBeats) +
      statCard('Uncategorized', articles.uncategorized) +
      statCard('Cluster pool', clustering.pool) +
      statCard('Clusters found', clustering.clustersFound) +
      '</div>';

    const byCat = articles.byCategory || [];
    const beatSet = new Set((diag.beats || []).map(function (b) { return b.name; }));
    const minSize = (diag.writer || {}).minClusterSize || 3;
    const catRowsHtml = byCat.length
      ? byCat.map(function (c) {
        const isBeat = beatSet.has(c.category);
        const eligible = c.distinctSources >= minSize;
        const statusColor = eligible ? '#2a7' : (isBeat ? '#d80' : '#999');
        const statusText = eligible ? '✓ eligible' : (c.distinctSources + '/' + minSize + ' sources');
        return '<tr><td>' + esc(c.category) + (isBeat ? ' <span style="color:#06c;font-size:11px;">[beat]</span>' : '') + '</td><td style="text-align:right;">' + c.count + '</td><td style="text-align:right;">' + c.distinctSources + '</td><td style="color:' + statusColor + ';">' + statusText + '</td></tr>';
      }).join('')
      : '<tr><td colspan="4" class="text-muted text-center" style="padding:12px;">No categories with articles in the lookback window.</td></tr>';

    const categoryTableHtml =
      '<div style="margin-top:12px;"><div style="font-weight:600;margin-bottom:6px;">Categories in lookback window (min ' + minSize + ' sources for originals)</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
      '<thead><tr style="background:var(--surface2);"><th style="text-align:left;padding:6px;">Category</th><th style="text-align:right;padding:6px;">Articles</th><th style="text-align:right;padding:6px;">Distinct sources</th><th style="padding:6px;">Status</th></tr></thead>' +
      '<tbody>' + catRowsHtml + '</tbody>' +
      '</table></div>';

    const panel =
      '<div id="diagPanel" class="wd-card" style="margin-top:16px;padding:16px;border:1px solid var(--border);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><div style="font-weight:600;font-size:15px;">Synthesis Diagnostic — ' + esc((diag.writer || {}).name || '') + '</div>' +
      '<button class="btn btn-ghost btn-sm" type="button" onclick="document.getElementById(\'diagPanel\').remove()">Close</button></div>' +
      reasonsHtml +
      countsHtml +
      categoryTableHtml +
      '</div>';

    const existing = document.getElementById('diagPanel');
    if (existing) existing.remove();
    statsSection.insertAdjacentHTML('afterend', panel);
    document.getElementById('diagPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function statCard(label, value) {
    return '<div style="padding:8px 10px;background:var(--surface2);border-radius:4px;"><div class="text-muted text-sm">' + esc(label) + '</div><div style="font-weight:600;font-size:15px;">' + esc(String(value == null ? '—' : value)) + '</div></div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Toggle source list visibility
  window.toggleSources = function(idx) {
    const el = document.getElementById('sources-' + idx);
    if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
  };

  // Preview
  previewBtn.addEventListener('click', async () => {
    const writerId = writerSelect.value;
    if (!writerId) return showToast('Select a writer first', 'error');
    previewBtn.disabled = true;
    previewBtn.textContent = 'Loading...';
    try {
      const data = await apiFetch(`/synthesis/preview/${writerId}`);
      renderClusterResults(data);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = 'Preview Clusters';
    }
  });

  // Dry Run
  dryRunBtn.addEventListener('click', async () => {
    const writerId = writerSelect.value;
    if (!writerId) return showToast('Select a writer first', 'error');
    const force = forceCheck && forceCheck.checked;
    dryRunBtn.disabled = true;
    dryRunBtn.textContent = 'Running...';
    try {
      const data = await apiFetch(`/synthesis/dry-run/${writerId}${force ? '?force=true' : ''}`);
      renderClusterResults(data);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      dryRunBtn.disabled = false;
      dryRunBtn.textContent = 'Dry Run';
    }
  });

  const forceCheck  = document.getElementById('forceCheck');
  const purgeBtn    = document.getElementById('purgeBtn');

  // Purge all original articles
  if (purgeBtn) {
    purgeBtn.addEventListener('click', async () => {
      if (!confirm('Delete ALL original AI-generated articles? This cannot be undone.')) return;
      purgeBtn.disabled = true;
      purgeBtn.textContent = 'Purging...';
      try {
        const data = await apiFetch('/synthesis/purge', { method: 'DELETE' });
        showToast(`Purged ${data.deleted} original article${data.deleted !== 1 ? 's' : ''}`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        purgeBtn.disabled = false;
        purgeBtn.textContent = 'Purge Originals';
      }
    });
  }

  // Run single writer
  runBtn.addEventListener('click', async () => {
    const writerId = writerSelect.value;
    if (!writerId) return showToast('Select a writer first', 'error');
    const force = forceCheck && forceCheck.checked;
    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    try {
      const data = await apiFetch(`/synthesis/run/${writerId}${force ? '?force=true' : ''}`, { method: 'POST' });
      showResult([{ ...data, name: writerSelect.options[writerSelect.selectedIndex]?.text }]);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = 'Run Synthesis';
    }
  });

  // Run all writers
  runAllBtn.addEventListener('click', async () => {
    const force = forceCheck && forceCheck.checked;
    runAllBtn.disabled = true;
    runAllBtn.textContent = 'Running All...';
    try {
      const data = await apiFetch(`/synthesis/run-all${force ? '?force=true' : ''}`, { method: 'POST' });
      showResult(data);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      runAllBtn.disabled = false;
      runAllBtn.textContent = 'Run All Writers';
    }
  });

  function showResult(results) {
    resultSection.style.display = '';
    if (!results.length) {
      resultBody.innerHTML = '<div class="text-muted">No results</div>';
      return;
    }
    resultBody.innerHTML = results.map(r => `
      <div class="result-item">
        <strong>${esc(r.name || 'Writer')}</strong>:
        ${r.generated} generated from ${r.clusters} cluster(s)
        ${r.skippedDedup ? `<span class="text-muted"> · ${r.skippedDedup} skipped (duplicate)</span>` : ''}
        ${r.skipped ? `<span class="text-muted"> — ${esc(r.skipped)}</span>` : ''}
        ${r.errors && r.errors.length ? `<details style="margin-top:6px;font-size:12px;color:#f87171"><summary>Errors (${r.errors.length})</summary><ul>${r.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
      </div>`).join('');
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }
});
