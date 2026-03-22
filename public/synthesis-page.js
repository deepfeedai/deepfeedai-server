/* ===== Synthesis Page ===== */
onReady(async () => {
  if (!requireAuth()) return;
  renderSidebar();

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

    statsRow.innerHTML = `
      ${cooldownHtml}
      <div class="stat-pill"><span class="stat-value">${pool.total || 0}</span><span class="stat-label">Article Pool</span></div>
      <div class="stat-pill"><span class="stat-value">${pool.writerScoped || 0}</span><span class="stat-label">Writer-Scoped</span></div>
      <div class="stat-pill"><span class="stat-value">${pool.beatFallback || 0}</span><span class="stat-label">Beat Fallback</span></div>
      <div class="stat-pill"><span class="stat-value">${(data.clusters || []).length}</span><span class="stat-label">Clusters</span></div>
      ${summary.wouldGenerate !== undefined ? `<div class="stat-pill"><span class="stat-value">${summary.wouldGenerate}</span><span class="stat-label">Would Generate</span></div>` : ''}
      ${summary.wouldSkipDedup ? `<div class="stat-pill"><span class="stat-value">${summary.wouldSkipDedup}</span><span class="stat-label">Would Skip (Dedup)</span></div>` : ''}
    `;
    statsSection.style.display = '';

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
