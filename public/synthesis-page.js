/* ===== Synthesis Page ===== */
onReady(async () => {
  if (!requireAuth()) return;
  initSidebar();
  initLogout();

  const writerSelect = document.getElementById('writerSelect');
  const previewBtn   = document.getElementById('previewBtn');
  const runBtn       = document.getElementById('runBtn');
  const runAllBtn    = document.getElementById('runAllBtn');
  const clusterSection = document.getElementById('clusterSection');
  const clusterTbody   = document.getElementById('clusterTbody');
  const clusterLabel   = document.getElementById('clusterWriterLabel');
  const resultSection  = document.getElementById('resultSection');
  const resultBody     = document.getElementById('resultBody');

  // Load auto-writers
  try {
    const writers = await apiFetch('/writers');
    const autoWriters = writers.filter(w => w.beat); // writers with beats are likely auto
    writerSelect.innerHTML = autoWriters.length
      ? autoWriters.map(w => `<option value="${w.id}">${w.name} (${w.beat || 'general'})</option>`).join('')
      : '<option value="">No auto-writers found</option>';
  } catch (err) {
    writerSelect.innerHTML = '<option value="">Error loading writers</option>';
  }

  // Preview
  previewBtn.addEventListener('click', async () => {
    const writerId = writerSelect.value;
    if (!writerId) return showToast('Select a writer first', 'error');
    previewBtn.disabled = true;
    previewBtn.textContent = 'Loading...';
    try {
      const data = await apiFetch(`/synthesis/preview/${writerId}`);
      clusterLabel.textContent = data.writer.name + (data.writer.beat ? ` — ${data.writer.beat}` : '');
      if (!data.clusters.length) {
        clusterTbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center" style="padding:24px;">No clusters found (need 3+ articles sharing 2+ title words)</td></tr>';
      } else {
        clusterTbody.innerHTML = data.clusters.map((c, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${esc(c.topic)}</td>
            <td>${c.articleCount}</td>
          </tr>`).join('');
      }
      clusterSection.style.display = '';
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = 'Preview Clusters';
    }
  });

  // Run single writer
  runBtn.addEventListener('click', async () => {
    const writerId = writerSelect.value;
    if (!writerId) return showToast('Select a writer first', 'error');
    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    try {
      const data = await apiFetch(`/synthesis/run/${writerId}`, { method: 'POST' });
      showResult([data]);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = 'Run Synthesis';
    }
  });

  // Run all writers
  runAllBtn.addEventListener('click', async () => {
    runAllBtn.disabled = true;
    runAllBtn.textContent = 'Running All...';
    try {
      const data = await apiFetch('/synthesis/run-all', { method: 'POST' });
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
