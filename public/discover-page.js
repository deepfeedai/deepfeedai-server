var searchResults = [];
var selectedUrls = new Set();

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function doSearch() {
  var query = document.getElementById('searchQuery').value.trim();
  if (!query) { showToast('Enter a search query', 'error'); return; }

  var sources = [];
  if (document.getElementById('srcBrave').checked) sources.push('brave');
  if (document.getElementById('srcNewsApi').checked) sources.push('newsapi');
  if (document.getElementById('srcYouTube').checked) sources.push('youtube');
  if (sources.length === 0) { showToast('Select at least one source', 'error'); return; }

  var period = document.getElementById('searchPeriod').value;

  // Validate custom range
  if (period === 'custom') {
    var dateFrom = document.getElementById('dateFrom').value;
    var dateTo = document.getElementById('dateTo').value;
    if (!dateFrom || !dateTo) { showToast('Select both from and to dates', 'error'); return; }
    if (dateFrom > dateTo) { showToast('From date must be before to date', 'error'); return; }
  }

  // Show loading
  document.getElementById('loadingState').style.display = '';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('resultsWrap').style.display = 'none';
  document.getElementById('resultsInfo').style.display = 'none';
  document.getElementById('importBar').style.display = 'none';
  selectedUrls.clear();

  try {
    var params = new URLSearchParams({ q: query, sources: sources.join(','), period: period });
    if (period === 'custom') {
      params.set('from', document.getElementById('dateFrom').value);
      params.set('to', document.getElementById('dateTo').value);
    }
    var data = await apiFetch('/admin/discover?' + params.toString());
    searchResults = data.results || [];
    document.getElementById('loadingState').style.display = 'none';
    if (data.youtubeQuotaExceeded) showToast('YouTube API quota exceeded — YouTube results may be missing', 'error');

    if (searchResults.length === 0) {
      document.getElementById('emptyState').style.display = '';
      document.getElementById('emptyState').textContent = 'No results found for "' + query + '"';
      return;
    }

    document.getElementById('resultsInfo').style.display = '';
    document.getElementById('resultsCount').textContent = searchResults.length + ' results found';
    document.getElementById('resultsWrap').style.display = '';
    renderResults();
  } catch (err) {
    document.getElementById('loadingState').style.display = 'none';
    showToast('Search failed: ' + err.message, 'error');
  }
}

function renderResults() {
  var tbody = document.getElementById('resultsBody');
  tbody.innerHTML = searchResults.map(function(r, i) {
    var sourceBadge = r.source === 'brave'
      ? '<span class="badge badge-success">Brave</span>'
      : r.source === 'youtube' ? '<span class="badge badge-danger">YouTube</span>'
      : '<span class="badge badge-accent">NewsAPI</span>';
    var statusBadge = r.alreadyImported
      ? '<span class="badge badge-muted">Imported</span>'
      : '';
    var checked = selectedUrls.has(r.url) ? ' checked' : '';
    var disabled = r.alreadyImported ? ' disabled' : '';
    var age = r.publishedAt ? formatAge(r.publishedAt) : '—';
    var domain = r.sourceName || '—';
    var category = r.detectedCategory || '—';

    return '<tr' + (r.alreadyImported ? ' style="opacity:0.5;"' : '') + '>'
      + '<td><input type="checkbox" class="result-check" data-idx="' + i + '"' + checked + disabled + ' /></td>'
      + '<td>' + sourceBadge + '</td>'
      + '<td>'
      +   '<div class="td-title" style="margin-bottom:2px;"><a href="' + esc(r.url) + '" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;" onmouseover="this.style.color=\'var(--accent)\'" onmouseout="this.style.color=\'var(--text)\'">' + esc(r.title) + '</a></div>'
      +   '<div class="text-muted text-sm">' + esc(domain) + '</div>'
      +   (r.description ? '<div class="text-muted text-xs" style="margin-top:4px;max-width:500px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(r.description.slice(0, 150)) + '</div>' : '')
      + '</td>'
      + '<td><span class="badge badge-muted">' + esc(category) + '</span></td>'
      + '<td class="text-muted text-sm">' + age + '</td>'
      + '<td>' + statusBadge + '</td>'
      + '<td><button class="btn btn-ghost btn-sm" onclick="openDiscoverPitch(' + i + ')" title="Pitch a counter-angle on this story">📌</button></td>'
      + '</tr>';
  }).join('');
}

function formatAge(dateStr) {
  try {
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    var now = new Date();
    var diff = Math.floor((now - d) / 1000);
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  } catch (e) { return dateStr; }
}

function updateSelection() {
  var count = selectedUrls.size;
  document.getElementById('selectedCount').textContent = count;
  document.getElementById('importBar').style.display = count > 0 ? '' : 'none';
}

async function doImport() {
  if (selectedUrls.size === 0) return;

  var articles = searchResults
    .filter(function(r) { return selectedUrls.has(r.url); })
    .map(function(r) {
      return {
        url: r.url,
        title: r.title,
        description: r.description,
        imageUrl: r.imageUrl,
        category: r.detectedCategory,
        embedUrl: r.embedUrl || null,
        source: r.source,
        sourceName: r.sourceName || null,
      };
    });

  var status = document.querySelector('input[name="importStatus"]:checked').value;
  var autoAssignWriter = document.getElementById('autoWriter').checked;
  var autoCategorize = document.getElementById('autoCategorize').checked;

  var btn = document.getElementById('importBtn');
  btn.disabled = true;
  btn.textContent = 'Importing...';

  try {
    var result = await apiFetch('/admin/discover/import', {
      method: 'POST',
      body: JSON.stringify({ articles: articles, status: status, autoAssignWriter: autoAssignWriter, autoCategorize: autoCategorize }),
    });
    showToast('Imported ' + result.imported + ' articles' + (result.skipped ? ', ' + result.skipped + ' skipped (duplicates)' : ''));
    // Mark imported articles in current results without re-searching
    var importedUrls = new Set(articles.map(function(a) { return a.url; }));
    searchResults.forEach(function(r) {
      if (importedUrls.has(r.url)) r.alreadyImported = true;
    });
    selectedUrls.clear();
    renderResults();
    updateSelection();
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Selected';
  }
}

// Event listeners
document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('searchQuery').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doSearch();
});

document.getElementById('resultsBody').addEventListener('change', function(e) {
  if (e.target.classList.contains('result-check')) {
    var idx = parseInt(e.target.dataset.idx);
    var r = searchResults[idx];
    if (e.target.checked) {
      selectedUrls.add(r.url);
    } else {
      selectedUrls.delete(r.url);
    }
    updateSelection();
  }
});

document.getElementById('checkAll').addEventListener('change', function(e) {
  var checks = document.querySelectorAll('.result-check:not(:disabled)');
  checks.forEach(function(cb) {
    cb.checked = e.target.checked;
    var idx = parseInt(cb.dataset.idx);
    var r = searchResults[idx];
    if (e.target.checked) {
      selectedUrls.add(r.url);
    } else {
      selectedUrls.delete(r.url);
    }
  });
  updateSelection();
});

document.getElementById('selectAllBtn').addEventListener('click', function() {
  document.getElementById('checkAll').checked = true;
  document.getElementById('checkAll').dispatchEvent(new Event('change'));
});

document.getElementById('importBtn').addEventListener('click', doImport);

// ── Saved Searches ──────────────────────────────────────────────

var savedSearches = [];
var activeSavedSearchId = null;

async function loadSavedSearches() {
  try {
    savedSearches = await apiFetch('/admin/discover/saved');
    renderSavedSearches();
  } catch { /* non-fatal */ }
}

function renderSavedSearches() {
  var container = document.getElementById('savedSearchList');
  var wrap = document.getElementById('savedSearches');
  if (!savedSearches.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  container.innerHTML = '<span class="text-muted text-sm" style="margin-right:4px;">Saved:</span>'
    + savedSearches.map(function(s) {
      var countBadge = s.result_count ? ' <span class="text-muted text-xs">(' + s.result_count + ')</span>' : '';
      var activeClass = s.id === activeSavedSearchId ? ' btn-primary' : ' btn-outline';
      return '<span style="display:inline-flex;align-items:center;gap:2px;">'
        + '<button class="btn btn-sm' + activeClass + '" onclick="loadSavedResults(' + s.id + ')" title="' + esc(s.query) + '">' + esc(s.name) + countBadge + '</button>'
        + '<button class="btn btn-ghost btn-sm text-danger" onclick="deleteSavedSearch(' + s.id + ', \'' + esc(s.name).replace(/'/g, "\\'") + '\')" title="Remove" style="padding:2px 4px;font-size:11px;">&#10005;</button>'
        + '</span>';
    }).join('');
}

async function saveCurrentSearch() {
  var query = document.getElementById('searchQuery').value.trim();
  if (!query) { showToast('Enter a search query first', 'error'); return; }

  var name = prompt('Save search as:', query.slice(0, 30));
  if (!name) return;

  var sources = [];
  if (document.getElementById('srcBrave').checked) sources.push('brave');
  if (document.getElementById('srcNewsApi').checked) sources.push('newsapi');
  if (document.getElementById('srcYouTube').checked) sources.push('youtube');
  var period = document.getElementById('searchPeriod').value;

  try {
    var saveBody = { name: name, query: query, sources: sources.join(','), period: period, results: searchResults };
    if (period === 'custom') {
      var df = document.getElementById('dateFrom').value;
      var dt = document.getElementById('dateTo').value;
      if (!df || !dt) { showToast('Select both from and to dates', 'error'); return; }
      if (df > dt) { showToast('From date must be before to date', 'error'); return; }
      saveBody.from_date = df;
      saveBody.to_date = dt;
    }
    await apiFetch('/admin/discover/saved', {
      method: 'POST',
      body: JSON.stringify(saveBody),
    });
    showToast('Search saved with ' + searchResults.length + ' results');
    await loadSavedSearches();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

async function loadSavedResults(id) {
  activeSavedSearchId = id;
  renderSavedSearches();

  document.getElementById('loadingState').style.display = '';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('resultsWrap').style.display = 'none';
  document.getElementById('resultsInfo').style.display = 'none';
  document.getElementById('importBar').style.display = 'none';
  selectedUrls.clear();

  try {
    var data = await apiFetch('/admin/discover/saved/' + id);

    // Populate search form
    document.getElementById('searchQuery').value = data.query || '';
    document.getElementById('searchPeriod').value = data.period || '24h';
    document.getElementById('searchPeriod').dispatchEvent(new Event('change'));
    if (data.period === 'custom' && data.from_date && data.to_date) {
      document.getElementById('dateFrom').value = data.from_date;
      document.getElementById('dateTo').value = data.to_date;
    } else {
      document.getElementById('dateFrom').value = '';
      document.getElementById('dateTo').value = '';
    }
    document.getElementById('srcBrave').checked = (data.sources || '').includes('brave');
    document.getElementById('srcNewsApi').checked = (data.sources || '').includes('newsapi');
    document.getElementById('srcYouTube').checked = (data.sources || '').includes('youtube');

    searchResults = data.results || [];
    document.getElementById('loadingState').style.display = 'none';

    if (searchResults.length === 0) {
      document.getElementById('emptyState').style.display = '';
      document.getElementById('emptyState').textContent = 'No cached results. Click "Refresh" to search.';
      return;
    }

    var lastRun = data.last_run_at ? formatAge(data.last_run_at) : 'never';
    document.getElementById('resultsInfo').style.display = '';
    document.getElementById('resultsCount').innerHTML = searchResults.length + ' cached results <span class="text-muted text-xs">(last updated ' + lastRun + ')</span> <button class="btn btn-outline btn-sm" onclick="refreshSavedSearch(' + id + ')" style="margin-left:8px;">Refresh</button>';
    document.getElementById('resultsWrap').style.display = '';
    renderResults();
  } catch (err) {
    document.getElementById('loadingState').style.display = 'none';
    showToast('Failed to load saved results: ' + err.message, 'error');
  }
}

async function refreshSavedSearch(id) {
  document.getElementById('loadingState').style.display = '';
  document.getElementById('resultsWrap').style.display = 'none';
  selectedUrls.clear();

  try {
    var data = await apiFetch('/admin/discover/saved/' + id + '/refresh', { method: 'POST' });
    searchResults = data.results || [];
    document.getElementById('loadingState').style.display = 'none';

    if (searchResults.length === 0) {
      document.getElementById('emptyState').style.display = '';
      document.getElementById('emptyState').textContent = 'No results found';
      document.getElementById('resultsInfo').style.display = 'none';
      return;
    }

    document.getElementById('resultsInfo').style.display = '';
    document.getElementById('resultsCount').innerHTML = searchResults.length + ' results <span class="text-muted text-xs">(just refreshed)</span> <button class="btn btn-outline btn-sm" onclick="refreshSavedSearch(' + id + ')" style="margin-left:8px;">Refresh</button>';
    document.getElementById('resultsWrap').style.display = '';
    renderResults();
    showToast('Results refreshed');
    await loadSavedSearches(); // update count badges
  } catch (err) {
    document.getElementById('loadingState').style.display = 'none';
    showToast('Refresh failed: ' + err.message, 'error');
  }
}

async function deleteSavedSearch(id, name) {
  if (!confirm('Delete saved search "' + name + '"?')) return;
  try {
    await apiFetch('/admin/discover/saved/' + id, { method: 'DELETE' });
    if (activeSavedSearchId === id) activeSavedSearchId = null;
    showToast('Search deleted');
    await loadSavedSearches();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

document.getElementById('saveSearchBtn').addEventListener('click', saveCurrentSearch);

// Toggle custom date range visibility
document.getElementById('searchPeriod').addEventListener('change', function() {
  document.getElementById('customDateRange').style.display = this.value === 'custom' ? '' : 'none';
});

onReady(async function() {
  if (!requireAuth()) return;
  renderSidebar();

  // Load feature flags and gate saved searches
  await loadAdminFeatures();
  if (!isFeatureOn('saved_searches')) {
    var saveBtn = document.getElementById('saveSearchBtn');
    if (saveBtn) saveBtn.style.display = 'none';
    var savedSection = document.getElementById('savedSearches');
    if (savedSection) savedSection.style.display = 'none';
  }

  // Generate year options dynamically (current year down to 2020)
  var select = document.getElementById('searchPeriod');
  var customOpt = select.querySelector('option[value="custom"]');
  var currentYear = new Date().getFullYear();
  for (var y = currentYear; y >= 2020; y--) {
    var opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    select.insertBefore(opt, customOpt);
  }

  // Set default date picker constraints
  var today = new Date().toISOString().split('T')[0];
  document.getElementById('dateTo').setAttribute('max', today);
  document.getElementById('dateTo').value = today;
  document.getElementById('dateFrom').value = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  document.getElementById('emptyState').style.display = '';
  if (isFeatureOn('saved_searches')) {
    loadSavedSearches();
  }
  initDiscoverPitch();
});

// ── Pitch from Discover ────────────────────────────────────────
var DISCOVER_TEMPLATES = {
  compliance: 'The compliance angle: explore how this affects regulatory obligations, audit posture, and the gap between current practice and what auditors will start asking about.',
  technical: 'Technical deep-dive: walk through the actual mechanics — how it works at a protocol/code level, the specific primitives, and what defenders should look for in logs.',
  market: 'Market impact: who benefits, who loses, what shifts in vendor positioning or capital flows this signals, and what competitors are likely to do next.',
  contrarian: 'Contrarian take: the prevailing narrative is X, but here\'s why I think the consensus is missing the point.',
  explainer: 'Explainer for non-experts: assume the reader has heard the headline but doesn\'t know why it matters. Build the why in three layers.',
  forecast: 'Predictive forecast: based on this story plus the pattern of related events, here\'s what I expect to happen in the next 1-4 weeks.',
  sentiment: 'Community sentiment angle: what practitioners are actually saying versus the corporate framing.',
  historical: 'Historical context: this isn\'t the first time — here\'s the pattern, three prior incidents that rhyme, and what the field learned.',
};

var discoverPitchWriters = [];
var discoverPitchActive = null;

window.openDiscoverPitch = async function (idx) {
  var r = searchResults[idx];
  if (!r) return;
  discoverPitchActive = r;
  if (!discoverPitchWriters.length) {
    try {
      var data = await apiFetch('/writers');
      discoverPitchWriters = Array.isArray(data) ? data : (data.writers || []);
    } catch { discoverPitchWriters = []; }
  }
  document.getElementById('discoverPitchSourcePreview').innerHTML =
    '<div style="font-weight:600;">' + esc(r.title) + '</div>'
    + '<div class="text-muted text-xs" style="margin-top:4px;">' + esc(r.sourceName || r.source || '') + ' · <a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.url) + '</a></div>';
  var sel = document.getElementById('discoverPitchWriter');
  sel.innerHTML = discoverPitchWriters.map(function (w) {
    return '<option value="' + w.id + '">' + esc(w.name) + (w.beat ? ' (' + esc(w.beat) + ')' : '') + '</option>';
  }).join('');
  document.getElementById('discoverPitchTemplate').value = '';
  document.getElementById('discoverPitchAngle').value = '';
  openModal('discoverPitchModal');
};

function initDiscoverPitch() {
  document.getElementById('discoverPitchTemplate').addEventListener('change', function (e) {
    var key = e.target.value;
    var ta = document.getElementById('discoverPitchAngle');
    if (key && DISCOVER_TEMPLATES[key] && (!ta.value.trim() || confirm('Replace current angle with template?'))) {
      ta.value = DISCOVER_TEMPLATES[key];
      ta.focus();
    }
  });

  document.getElementById('submitDiscoverPitchBtn').addEventListener('click', async function () {
    if (!discoverPitchActive) return;
    var writerId = parseInt(document.getElementById('discoverPitchWriter').value, 10);
    var angle = document.getElementById('discoverPitchAngle').value.trim();
    if (!writerId) { alert('Pick a writer.'); return; }
    if (angle.length < 10) { alert('Angle must be 10+ chars.'); return; }
    var btn = this; btn.disabled = true; btn.textContent = 'Working…';
    try {
      // Step 1: ingest the discover result via /research/ingest as a curated article
      var result = {
        source: discoverPitchActive.source || 'discover',
        url: discoverPitchActive.url,
        title: discoverPitchActive.title,
        snippet: discoverPitchActive.description || '',
        publisher: discoverPitchActive.sourceName || '',
        published: discoverPitchActive.publishedAt || null,
      };
      var ingest = await apiFetch('/research/ingest', {
        method: 'POST', body: JSON.stringify({ results: [result] }),
      });
      var sourceId = (ingest.ingested && ingest.ingested[0] && ingest.ingested[0].id)
        || (ingest.skipped && ingest.skipped[0] && ingest.skipped[0].existing_id);
      if (!sourceId) { alert('Ingest returned no article id.'); btn.disabled = false; btn.textContent = 'Ingest + create pitch'; return; }

      // Step 2: create the pitch
      var pitch = await apiFetch('/pitches', {
        method: 'POST',
        body: JSON.stringify({ source_article_id: sourceId, pitched_by_writer_id: writerId, angle_summary: angle }),
      });
      closeModal('discoverPitchModal');
      showToast('Pitch #' + pitch.id + ' created on ingested source.');
      // Mark the discover row as imported so editor doesn't double-pitch
      discoverPitchActive.alreadyImported = true;
      renderResults();
      discoverPitchActive = null;
    } catch (err) {
      alert('Pitch failed: ' + (err.message || err));
    } finally {
      btn.disabled = false; btn.textContent = 'Ingest + create pitch';
    }
  });
}
