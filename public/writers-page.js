let writers = [];
let categoriesList = [];
let perfData = [];
let pendingDeleteId = null;
let pendingAvatarDataUrl = null;
let perfSortCol = 'articles_total';
let perfSortDir = 'desc';
let avatarPollTimer = null;

// ── Data Loading ─────────────────────────────────────────────────

async function loadWriters() {
  try {
    writers = await apiFetch('/admin/writers');
    renderWriters();
  } catch (err) {
    showAlert('Failed to load writers: ' + err.message, 'error');
  }
}


async function loadCategoriesList() {
  try { categoriesList = await apiFetch('/categories'); } catch { categoriesList = []; }
}

// ── Writers Table ────────────────────────────────────────────────

function renderWriters() {
  var tbody = document.getElementById('writersBody');
  if (!writers.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">&#9997;&#65039;</div><p>No writers configured &mdash; add one to get started</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = writers.map(function(w) {
    var avatarHtml = w.avatar_url
      ? '<img src="' + esc(w.avatar_url) + '" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" onerror="this.outerHTML=\'<div style=\\\'width:36px;height:36px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;\\\'>&#9997;&#65039;</div>\'" />'
      : '<div style="width:36px;height:36px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;">&#9997;&#65039;</div>';

    var beats = (w.beats || []).map(function(b) { return typeof b === 'string' ? b : b.name; });
    var beatsHtml = beats.length ? beats.map(function(n) { return '<span class="badge badge-muted" style="font-size:10px;margin:1px 2px;">' + esc(n) + '</span>'; }).join('') : '<span class="text-muted">&mdash;</span>';

    var autoBadge = w.is_auto
      ? '<span class="badge badge-accent" style="font-size:10px;">Auto</span>'
      : '<span class="text-muted text-sm">Manual</span>';

    return '<tr>'
      + '<td>' + avatarHtml + '</td>'
      + '<td><strong>' + esc(w.name) + '</strong></td>'
      + '<td>' + beatsHtml + '</td>'
      + '<td style="text-align:center;">' + autoBadge + '</td>'
      + '<td class="text-muted text-sm">' + (w.elevenlabs_voice_id ? '<span title="' + esc(w.elevenlabs_voice_id) + '">Configured</span>' : 'None') + '</td>'
      + '<td style="text-align:center;">' + (w.article_count || 0) + '</td>'
      + '<td>'
      + '<div style="display:flex;gap:6px;">'
      + '<button class="btn btn-ghost btn-sm btn-icon" title="Edit" onclick="openEdit(' + w.id + ')">&#9998;&#65039;</button>'
      + '<button class="btn btn-ghost btn-sm btn-icon" title="Delete" onclick="openDelete(' + w.id + ')">&#128465;&#65039;</button>'
      + '</div>'
      + '</td>'
      + '</tr>';
  }).join('');
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Beats Checkboxes ─────────────────────────────────────────────

function populateBeatsCheckboxes(selectedIds) {
  var container = document.getElementById('fWriterBeats');
  if (!container) return;
  var sel = new Set((selectedIds || []).map(Number));
  container.innerHTML = categoriesList.map(function(cat) {
    var checked = sel.has(cat.id) ? ' checked' : '';
    return '<label><input type="checkbox" value="' + cat.id + '"' + checked + ' /> ' + esc(cat.name) + '</label>';
  }).join('');
}

function getSelectedBeats() {
  var checks = document.querySelectorAll('#fWriterBeats input[type="checkbox"]:checked');
  var ids = [];
  checks.forEach(function(el) { ids.push(parseInt(el.value)); });
  return ids;
}

// ── Few-Shot Examples ────────────────────────────────────────────

function addFewShotRow(title, excerpt) {
  var container = document.getElementById('fewShotContainer');
  var row = document.createElement('div');
  row.className = 'few-shot-row';
  row.innerHTML = '<input type="text" class="form-control fs-title" placeholder="Example title" value="' + esc(title || '') + '" />'
    + '<textarea class="form-control fs-excerpt" placeholder="Example excerpt" rows="2">' + esc(excerpt || '') + '</textarea>'
    + '<button class="btn btn-ghost btn-sm" type="button" onclick="this.parentElement.remove()" title="Remove">&#10005;</button>';
  container.appendChild(row);
}

function collectFewShotExamples() {
  var rows = document.querySelectorAll('#fewShotContainer .few-shot-row');
  var examples = [];
  rows.forEach(function(row) {
    var title = row.querySelector('.fs-title').value.trim();
    var excerpt = row.querySelector('.fs-excerpt').value.trim();
    if (title || excerpt) examples.push({ title: title, excerpt: excerpt });
  });
  return examples;
}

// ── Modal Open/Close ─────────────────────────────────────────────

document.getElementById('fWriterName').addEventListener('input', function() {
  if (document.getElementById('editWriterId').value) return;
  var slug = this.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  document.getElementById('fWriterSlug').value = slug;
});

function openAdd() {
  document.getElementById('writerModalTitle').textContent = 'Add Writer';
  document.getElementById('editWriterId').value = '';
  document.getElementById('fWriterName').value = '';
  document.getElementById('fWriterSlug').value = '';
  document.getElementById('fWriterBio').value = '';
  document.getElementById('fWriterKeywords').value = '';
  document.getElementById('fWriterSystemPrompt').value = '';
  document.getElementById('fWriterTone').value = '';
  document.getElementById('fWriterExpertise').value = '';
  document.getElementById('fWriterStyleGuide').value = '';
  document.getElementById('fewShotContainer').innerHTML = '';
  document.getElementById('fWriterGender').value = '';
  document.getElementById('fWriterEthnicity').value = '';
  document.getElementById('fWriterIsAuto').checked = false;
  document.getElementById('fWriterSchedule').value = 'daily';
  document.getElementById('fWriterLookback').value = '168';
  document.getElementById('fWriterMinCluster').value = '3';
  document.getElementById('writerAvatarPreviewWrap').style.display = 'none';
  document.getElementById('avatarPromptPreview').style.display = 'none';
  document.getElementById('fWriterAvatar').value = '';
  pendingAvatarDataUrl = null;
  document.getElementById('fWriterElevenLabsVoice').value = '';
  populateBeatsCheckboxes([]);
  openModal('writerModal');
  document.getElementById('fWriterName').focus();
}

function openEdit(id) {
  var w = writers.find(function(x) { return x.id === id; });
  if (!w) return;
  document.getElementById('writerModalTitle').textContent = 'Edit Writer';
  document.getElementById('editWriterId').value = w.id;
  document.getElementById('fWriterName').value = w.name;
  document.getElementById('fWriterSlug').value = w.slug || '';
  document.getElementById('fWriterBio').value = w.bio || '';
  document.getElementById('fWriterKeywords').value = (w.keywords || []).join(', ');
  document.getElementById('fWriterSystemPrompt').value = w.system_prompt || '';
  document.getElementById('fWriterTone').value = w.tone || '';
  document.getElementById('fWriterExpertise').value = w.expertise_level || '';
  document.getElementById('fWriterStyleGuide').value = w.style_guide || '';
  document.getElementById('fWriterGender').value = w.gender || '';
  document.getElementById('fWriterEthnicity').value = w.ethnicity || '';
  document.getElementById('fWriterIsAuto').checked = !!w.is_auto;
  document.getElementById('fWriterSchedule').value = w.synthesis_schedule || 'daily';
  document.getElementById('fWriterLookback').value = w.synthesis_lookback_hours != null ? w.synthesis_lookback_hours : 168;
  document.getElementById('fWriterMinCluster').value = w.min_cluster_size != null ? w.min_cluster_size : 3;
  pendingAvatarDataUrl = null;
  document.getElementById('fWriterAvatar').value = '';
  if (w.avatar_url) {
    document.getElementById('writerAvatarPreview').src = w.avatar_url;
    document.getElementById('writerAvatarPreviewWrap').style.display = 'block';
  } else {
    document.getElementById('writerAvatarPreviewWrap').style.display = 'none';
  }

  // Populate beats checkboxes with selected IDs
  var beatIds = (w.beats || []).map(function(b) { return typeof b === 'object' ? b.id : b; });
  document.getElementById('fWriterElevenLabsVoice').value = w.elevenlabs_voice_id || '';
  populateBeatsCheckboxes(beatIds);

  // Few-shot examples
  document.getElementById('fewShotContainer').innerHTML = '';
  var fse = typeof w.few_shot_examples === 'string' ? JSON.parse(w.few_shot_examples || '[]') : (w.few_shot_examples || []);
  fse.forEach(function(ex) { addFewShotRow(ex.title, ex.excerpt); });

  openModal('writerModal');
  document.getElementById('fWriterName').focus();
}

function openDelete(id) {
  var w = writers.find(function(x) { return x.id === id; });
  if (!w) return;
  pendingDeleteId = id;
  document.getElementById('deleteWriterName').textContent = w.name;
  openModal('deleteWriterModal');
}

// ── Avatar Preview ───────────────────────────────────────────────

document.getElementById('fWriterAvatar').addEventListener('change', function() {
  var file = this.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    pendingAvatarDataUrl = e.target.result;
    document.getElementById('writerAvatarPreview').src = pendingAvatarDataUrl;
    document.getElementById('writerAvatarPreviewWrap').style.display = 'block';
  };
  reader.readAsDataURL(file);
});

// ── Save Writer ──────────────────────────────────────────────────

document.getElementById('saveWriterBtn').addEventListener('click', async function() {
  var editId  = document.getElementById('editWriterId').value;
  var name    = document.getElementById('fWriterName').value.trim();
  var slug    = document.getElementById('fWriterSlug').value.trim();
  var bio     = document.getElementById('fWriterBio').value.trim();
  var keywordsRaw = document.getElementById('fWriterKeywords').value.trim();
  var keywords = keywordsRaw ? keywordsRaw.split(',').map(function(k) { return k.trim(); }).filter(Boolean) : [];
  var system_prompt = document.getElementById('fWriterSystemPrompt').value.trim();
  var tone = document.getElementById('fWriterTone').value;
  var expertise_level = document.getElementById('fWriterExpertise').value;
  var style_guide = document.getElementById('fWriterStyleGuide').value.trim();
  var few_shot_examples = collectFewShotExamples();
  var is_auto = document.getElementById('fWriterIsAuto').checked;
  var synthesis_schedule = document.getElementById('fWriterSchedule').value;
  var synthesis_lookback_hours = parseInt(document.getElementById('fWriterLookback').value) || 168;
  var min_cluster_size = parseInt(document.getElementById('fWriterMinCluster').value) || 3;
  var elevenlabs_voice_id = document.getElementById('fWriterElevenLabsVoice').value.trim() || null;
  var beats = getSelectedBeats();
  var gender = document.getElementById('fWriterGender').value || null;
  var ethnicity = document.getElementById('fWriterEthnicity').value || null;

  if (!name) { showAlert('Name is required', 'error'); return; }

  var payload = {
    name: name,
    slug: slug || null,
    bio: bio || null,
    beats: beats,
    keywords: keywords,
    system_prompt: system_prompt || null,
    tone: tone || null,
    expertise_level: expertise_level || null,
    style_guide: style_guide || null,
    few_shot_examples: few_shot_examples,
    is_auto: is_auto,
    synthesis_schedule: synthesis_schedule,
    synthesis_lookback_hours: synthesis_lookback_hours,
    min_cluster_size: min_cluster_size,
    elevenlabs_voice_id: elevenlabs_voice_id,
    gender: gender,
    ethnicity: ethnicity,
  };

  try {
    var savedWriter;
    if (editId) {
      savedWriter = await apiFetch('/admin/writers/' + editId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      savedWriter = await apiFetch('/admin/writers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    closeModal('writerModal');
    showAlert(editId ? 'Writer updated' : 'Writer created');

    if (pendingAvatarDataUrl && savedWriter && savedWriter.id) {
      try {
        await apiFetch('/admin/writers/' + savedWriter.id + '/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: pendingAvatarDataUrl })
        });
      } catch (avatarErr) {
        showAlert('Writer saved, but avatar upload failed: ' + avatarErr.message, 'error');
      }
      pendingAvatarDataUrl = null;
    }

    await loadWriters();
  } catch (err) {
    showAlert('Save failed: ' + err.message, 'error');
  }
});

// ── Delete Writer ────────────────────────────────────────────────

document.getElementById('confirmDeleteWriterBtn').addEventListener('click', async function() {
  if (!pendingDeleteId) return;
  try {
    await apiFetch('/admin/writers/' + pendingDeleteId, { method: 'DELETE' });
    closeModal('deleteWriterModal');
    pendingDeleteId = null;
    showAlert('Writer deleted');
    await loadWriters();
  } catch (err) {
    showAlert('Delete failed: ' + err.message, 'error');
  }
});

document.getElementById('addWriterBtn').addEventListener('click', openAdd);
document.getElementById('addFewShotBtn').addEventListener('click', function() { addFewShotRow('', ''); });

// ── Generate Avatar with AI ──────────────────────────────────────
document.getElementById('generateAvatarBtn').addEventListener('click', async function() {
  var writerId = document.getElementById('editWriterId').value;
  if (!writerId) {
    showAlert('Save the writer first, then generate an avatar', 'error');
    return;
  }
  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    var result = await apiFetch('/admin/writers/' + writerId + '/generate-avatar', { method: 'POST' });
    if (result.avatar_url) {
      document.getElementById('writerAvatarPreview').src = result.avatar_url;
      document.getElementById('writerAvatarPreviewWrap').style.display = '';
      showAlert('Avatar generated');
      await loadWriters();
    }
    // Show the prompt that was used
    if (result._avatarPrompt) {
      var promptEl = document.getElementById('avatarPromptPreview');
      promptEl.textContent = 'Prompt: ' + result._avatarPrompt;
      promptEl.style.display = '';
    }
  } catch (err) {
    showAlert('Avatar generation failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI Generate';
  }
});

// ── Performance Dashboard ────────────────────────────────────────

var writerCompareChart = null;
var CHART_COLORS = ['#00d9ff', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#f59e0b'];

function createChart(canvasId, config) {
  var canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return null;
  var defaults = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#888', font: { family: "'Inter', sans-serif", size: 11 } } },
      tooltip: { backgroundColor: '#222', titleColor: '#f0f0f0', bodyColor: '#ccc', borderColor: '#333', borderWidth: 1 },
    },
  };
  if (!config.type || config.type === 'line' || config.type === 'bar') {
    var scaleDefaults = { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#888', font: { family: "'Inter', sans-serif", size: 11 } } };
    config.options = config.options || {};
    config.options.scales = config.options.scales || {};
    ['x', 'y'].forEach(function(axis) {
      config.options.scales[axis] = Object.assign({}, scaleDefaults, config.options.scales[axis] || {});
    });
  }
  config.options = Object.assign({}, defaults, config.options, { plugins: Object.assign({}, defaults.plugins, (config.options || {}).plugins || {}) });
  return new Chart(canvas, config);
}

async function loadPerformance(range) {
  try {
    perfData = await apiFetch('/admin/writers/performance?range=' + (range || '30d'));
    renderLeaderboard();
    renderWriterChart();
    renderPerformance();
  } catch (err) {
    document.getElementById('perfBody').innerHTML = '<tr><td colspan="10" class="text-muted" style="text-align:center;">Failed to load: ' + esc(err.message) + '</td></tr>';
  }
}

function renderLeaderboard() {
  var el = document.getElementById('leaderboard');
  if (!el || !perfData.length) { if (el) el.innerHTML = ''; return; }

  // Sort by engagement score: views + reactions*5 + comments*3
  var ranked = perfData.slice().sort(function(a, b) {
    var scoreA = (a.total_views || 0) + (a.total_reactions || 0) * 5 + (a.total_comments || 0) * 3;
    var scoreB = (b.total_views || 0) + (b.total_reactions || 0) * 5 + (b.total_comments || 0) * 3;
    return scoreB - scoreA;
  });

  var top = ranked.slice(0, 3);
  var medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49']; // gold, silver, bronze
  var maxViews = Math.max.apply(null, top.map(function(w) { return w.total_views || 1; }));
  var maxArticles = Math.max.apply(null, top.map(function(w) { return w.articles_total || 1; }));

  el.innerHTML = top.map(function(w, i) {
    var avatarHtml = w.avatar_url
      ? '<img class="leader-avatar" src="' + esc(w.avatar_url) + '" alt="" />'
      : '<div class="leader-avatar-placeholder">' + esc(w.name.charAt(0)) + '</div>';
    var viewsPct = Math.round(((w.total_views || 0) / maxViews) * 100);
    var articlesPct = Math.round(((w.articles_total || 0) / maxArticles) * 100);
    return '<div class="leader-card">'
      + '<div class="leader-rank">' + medals[i] + '</div>'
      + avatarHtml
      + '<div class="leader-name">' + esc(w.name) + '</div>'
      + '<div class="leader-stat"><strong>' + (w.articles_total || 0) + '</strong> articles</div>'
      + '<div class="leader-stat"><strong>' + (w.total_views || 0) + '</strong> views</div>'
      + '<div class="leader-stat"><strong>$' + (w.cost_per_article || 0).toFixed(4) + '</strong> /article</div>'
      + '<div class="leader-bars">'
      + '<div class="leader-bar-row"><div class="leader-bar-label">Views</div><div class="leader-bar-track"><div class="leader-bar-fill" style="width:' + viewsPct + '%;background:#00d9ff;"></div></div></div>'
      + '<div class="leader-bar-row"><div class="leader-bar-label">Articles</div><div class="leader-bar-track"><div class="leader-bar-fill" style="width:' + articlesPct + '%;background:#4ade80;"></div></div></div>'
      + '</div></div>';
  }).join('');
}

function renderWriterChart() {
  if (writerCompareChart) writerCompareChart.destroy();
  if (!perfData.length) return;

  var writers = perfData.filter(function(w) { return w.articles_total > 0; }).slice(0, 8);
  if (!writers.length) return;

  writerCompareChart = createChart('writerCompareChart', {
    type: 'bar',
    data: {
      labels: writers.map(function(w) { return w.name; }),
      datasets: [
        { label: 'Articles', data: writers.map(function(w) { return w.articles_total; }), backgroundColor: '#00d9ff', borderRadius: 4 },
        { label: 'Views', data: writers.map(function(w) { return w.total_views; }), backgroundColor: '#4ade80', borderRadius: 4 },
        { label: 'Reactions', data: writers.map(function(w) { return w.total_reactions; }), backgroundColor: '#fbbf24', borderRadius: 4 },
      ],
    },
    options: {
      plugins: { legend: { display: true, position: 'top' } },
      scales: { x: { stacked: false }, y: { beginAtZero: true } },
    },
  });
}

function renderPerformance() {
  var data = perfData.slice();

  // Sort
  data.sort(function(a, b) {
    var va = a[perfSortCol] || 0, vb = b[perfSortCol] || 0;
    return perfSortDir === 'asc' ? va - vb : vb - va;
  });

  // Update sort indicators
  document.querySelectorAll('#perfTable .sortable').forEach(function(th) {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === perfSortCol) th.classList.add(perfSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });

  var tbody = document.getElementById('perfBody');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-muted" style="text-align:center;">No writer data for this period</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(function(r) {
    var avatarHtml = r.avatar_url
      ? '<img src="' + esc(r.avatar_url) + '" style="width:24px;height:24px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px;" />'
      : '';
    return '<tr>'
      + '<td>' + avatarHtml + '<strong>' + esc(r.name) + '</strong></td>'
      + '<td class="perf-val">' + r.articles_total + '</td>'
      + '<td class="perf-val">' + r.articles_original + '</td>'
      + '<td class="perf-val">' + (r.avg_editorial_score != null ? r.avg_editorial_score : '&mdash;') + '</td>'
      + '<td class="perf-val">' + r.total_views + '</td>'
      + '<td class="perf-val">' + r.total_reactions + '</td>'
      + '<td class="perf-val">' + r.total_comments + '</td>'
      + '<td class="perf-val">' + r.follower_count + '</td>'
      + '<td class="perf-val">$' + (r.total_cost || 0).toFixed(2) + '</td>'
      + '<td class="perf-val">$' + (r.cost_per_article || 0).toFixed(4) + '</td>'
      + '</tr>';
  }).join('');
}

// Sortable column headers
document.querySelectorAll('#perfTable .sortable').forEach(function(th) {
  th.addEventListener('click', function() {
    var col = this.dataset.sort;
    if (perfSortCol === col) {
      perfSortDir = perfSortDir === 'desc' ? 'asc' : 'desc';
    } else {
      perfSortCol = col;
      perfSortDir = 'desc';
    }
    renderPerformance();
  });
});

// Range selector
document.getElementById('perfRange').addEventListener('change', function() {
  loadPerformance(this.value);
});

// ── Tab Switching ────────────────────────────────────────────────

document.querySelectorAll('#writerTabs .tab-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('#writerTabs .tab-btn').forEach(function(b) { b.classList.remove('active'); });
    this.classList.add('active');
    var tab = this.dataset.tab;
    document.getElementById('writersSection').style.display = tab === 'writers' ? '' : 'none';
    document.getElementById('performanceSection').style.display = tab === 'performance' ? '' : 'none';
    if (tab === 'performance' && !perfData.length) {
      loadPerformance(document.getElementById('perfRange').value);
    }
  });
});

// ── AI Generate Writers ──────────────────────────────────────────

var aiGenPersonas = [];

function getCategoryCoverage() {
  var map = {};
  writers.forEach(function(w) {
    (w.beats || []).forEach(function(b) {
      var id = typeof b === 'object' ? b.id : b;
      if (!map[id]) map[id] = [];
      map[id].push(w.name);
    });
  });
  return map;
}

function openAiGenerate() {
  var content = document.getElementById('aiGenContent');
  var coverage = getCategoryCoverage();

  if (!categoriesList.length) {
    content.innerHTML = '<div class="empty-state"><p>No categories found. Add categories first.</p></div>';
    openModal('aiGenerateModal');
    return;
  }

  var html = '<div style="margin-bottom:12px;">'
    + '<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">'
    + '<input type="checkbox" id="aiGenUncoveredOnly" checked style="width:14px;height:14px;" />'
    + ' Show only categories without writers'
    + '</label></div>'
    + '<div id="aiGenCatList" style="margin-bottom:16px;"></div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
    + '<button class="btn btn-outline" data-close-modal>Cancel</button>'
    + '<button class="btn btn-primary" id="aiGenGenerateBtn">Generate Personas</button>'
    + '</div>';
  content.innerHTML = html;

  function renderCatList() {
    var uncoveredOnly = document.getElementById('aiGenUncoveredOnly').checked;
    var container = document.getElementById('aiGenCatList');
    var cats = categoriesList.filter(function(c) {
      return !uncoveredOnly || !coverage[c.id];
    });
    if (!cats.length) {
      container.innerHTML = '<p class="text-muted" style="font-size:13px;">All categories already have writers assigned.</p>';
      return;
    }
    container.innerHTML = cats.map(function(c) {
      var writerNames = coverage[c.id];
      var badge = writerNames
        ? '<span class="text-muted" style="font-size:11px;margin-left:8px;">Has writer: ' + esc(writerNames.join(', ')) + '</span>'
        : '<span style="font-size:11px;margin-left:8px;color:var(--accent);">No writer</span>';
      return '<label style="display:flex;align-items:center;gap:6px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--border);">'
        + '<input type="checkbox" class="aiGenCatCb" value="' + c.id + '" checked style="width:14px;height:14px;" />'
        + ' <strong>' + esc(c.name) + '</strong>' + badge
        + '</label>';
    }).join('');
  }

  renderCatList();
  document.getElementById('aiGenUncoveredOnly').addEventListener('change', renderCatList);
  document.getElementById('aiGenGenerateBtn').addEventListener('click', doAiGenerate);
  openModal('aiGenerateModal');
}

async function doAiGenerate() {
  var checks = document.querySelectorAll('.aiGenCatCb:checked');
  var categoryIds = [];
  checks.forEach(function(el) { categoryIds.push(parseInt(el.value)); });
  if (!categoryIds.length) { showAlert('Select at least one category', 'error'); return; }

  var content = document.getElementById('aiGenContent');
  content.innerHTML = '<div style="text-align:center;padding:40px 0;">'
    + '<span class="spinner"></span>'
    + '<p class="text-muted" style="margin-top:12px;">Generating writer personas with AI...</p>'
    + '</div>';

  try {
    var result = await apiFetch('/admin/writers/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // uncoveredOnly: false — frontend already filters categories via checkbox UI
      body: JSON.stringify({ categoryIds: categoryIds, uncoveredOnly: false })
    });

    aiGenPersonas = result.generated || [];
    if (!aiGenPersonas.length) {
      content.innerHTML = '<div class="empty-state"><p>' + esc(result.message || 'No personas generated') + '</p></div>'
        + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">'
        + '<button class="btn btn-outline" data-close-modal>Close</button></div>';
      initModals();
      return;
    }
    renderAiGenResults();
  } catch (err) {
    content.innerHTML = '<div class="empty-state" style="color:var(--danger);"><p>Error: ' + esc(err.message) + '</p></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">'
      + '<button class="btn btn-outline" onclick="openAiGenerate()">Retry</button>'
      + '<button class="btn btn-outline" data-close-modal>Close</button></div>';
    initModals();
  }
}

function renderAiGenResults() {
  var content = document.getElementById('aiGenContent');
  var toneOpts = ['', 'analytical', 'conversational', 'provocative', 'authoritative', 'casual', 'technical'];
  var expertiseOpts = ['', 'beginner-friendly', 'intermediate', 'technical', 'expert'];
  var genderOpts = ['', 'male', 'female', 'non-binary'];
  var ethnicityOpts = ['', 'African American', 'African', 'Asian', 'East Asian', 'South Asian', 'Hispanic/Latino', 'Middle Eastern', 'Native American', 'Pacific Islander', 'Caucasian', 'Mixed/Multiracial'];

  function selectHtml(id, opts, selected) {
    return '<select class="form-control" data-field="' + id + '" style="font-size:12px;">'
      + opts.map(function(o) {
        var label = o || '— Default —';
        return '<option value="' + esc(o) + '"' + (o === selected ? ' selected' : '') + '>' + esc(label) + '</option>';
      }).join('') + '</select>';
  }

  var cardsHtml = aiGenPersonas.map(function(p, i) {
    return '<div class="aiGenCard" data-idx="' + i + '" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">'
      + '<input type="checkbox" class="aiGenSelect" data-idx="' + i + '" checked style="width:16px;height:16px;" />'
      + '<span class="badge badge-muted" style="font-size:10px;">' + esc(p.categoryName) + '</span>'
      + '</div>'
      + '<div class="form-grid-2" style="gap:8px;margin-bottom:8px;">'
      + '<div><label class="form-label" style="font-size:11px;">Name</label>'
      + '<input type="text" class="form-control" data-field="name" data-idx="' + i + '" value="' + esc(p.name) + '" style="font-size:12px;" /></div>'
      + '<div><label class="form-label" style="font-size:11px;">Bio</label>'
      + '<textarea class="form-control" data-field="bio" data-idx="' + i + '" rows="2" style="font-size:12px;">' + esc(p.bio) + '</textarea></div>'
      + '</div>'
      + '<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">'
      + '<div style="flex:1;min-width:120px;"><label class="form-label" style="font-size:11px;">Tone</label>' + selectHtml('tone', toneOpts, p.tone) + '</div>'
      + '<div style="flex:1;min-width:120px;"><label class="form-label" style="font-size:11px;">Expertise</label>' + selectHtml('expertise_level', expertiseOpts, p.expertise_level) + '</div>'
      + '<div style="flex:1;min-width:120px;"><label class="form-label" style="font-size:11px;">Gender</label>' + selectHtml('gender', genderOpts, p.gender || '') + '</div>'
      + '<div style="flex:1;min-width:120px;"><label class="form-label" style="font-size:11px;">Ethnicity</label>' + selectHtml('ethnicity', ethnicityOpts, p.ethnicity || '') + '</div>'
      + '</div>'
      + '<div style="margin-bottom:8px;"><label class="form-label" style="font-size:11px;">Keywords</label>'
      + '<input type="text" class="form-control" data-field="keywords" data-idx="' + i + '" value="' + esc((p.keywords || []).join(', ')) + '" style="font-size:12px;" /></div>'
      + '<details style="margin-bottom:4px;"><summary style="font-size:11px;color:var(--text-muted);cursor:pointer;">System Prompt & Style Guide</summary>'
      + '<div style="margin-top:6px;">'
      + '<textarea class="form-control" data-field="system_prompt" data-idx="' + i + '" rows="3" style="font-size:12px;margin-bottom:6px;">' + esc(p.system_prompt) + '</textarea>'
      + '<textarea class="form-control" data-field="style_guide" data-idx="' + i + '" rows="2" style="font-size:12px;">' + esc(p.style_guide) + '</textarea>'
      + '</div></details>'
      + '</div>';
  }).join('');

  var selectCount = aiGenPersonas.length;
  content.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">'
    + '<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">'
    + '<input type="checkbox" id="aiGenSelectAll" checked style="width:14px;height:14px;" /> Select All'
    + '</label>'
    + '<span class="text-muted" style="font-size:12px;" id="aiGenCount">' + selectCount + ' selected</span>'
    + '</div>'
    + '<div style="max-height:500px;overflow-y:auto;">' + cardsHtml + '</div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">'
    + '<button class="btn btn-outline" data-close-modal>Cancel</button>'
    + '<button class="btn btn-primary" id="aiGenCreateBtn">Create ' + selectCount + ' Writers</button>'
    + '</div>';

  // Select all toggle
  document.getElementById('aiGenSelectAll').addEventListener('change', function() {
    var checked = this.checked;
    document.querySelectorAll('.aiGenSelect').forEach(function(cb) { cb.checked = checked; });
    updateAiGenCount();
  });

  // Individual checkbox updates
  content.addEventListener('change', function(e) {
    if (e.target.classList.contains('aiGenSelect')) updateAiGenCount();
  });

  document.getElementById('aiGenCreateBtn').addEventListener('click', createAiGenWriters);
  initModals();
}

function updateAiGenCount() {
  var checked = document.querySelectorAll('.aiGenSelect:checked').length;
  var countEl = document.getElementById('aiGenCount');
  if (countEl) countEl.textContent = checked + ' selected';
  var btn = document.getElementById('aiGenCreateBtn');
  if (btn) btn.textContent = 'Create ' + checked + ' Writer' + (checked !== 1 ? 's' : '');
}

function readAiGenCard(idx) {
  var p = aiGenPersonas[idx];
  var card = document.querySelector('.aiGenCard[data-idx="' + idx + '"]');
  if (!card) return p;

  var nameEl = card.querySelector('[data-field="name"]');
  var bioEl = card.querySelector('[data-field="bio"]');
  var toneEl = card.querySelector('[data-field="tone"]');
  var expertiseEl = card.querySelector('[data-field="expertise_level"]');
  var genderEl = card.querySelector('[data-field="gender"]');
  var ethnicityEl = card.querySelector('[data-field="ethnicity"]');
  var keywordsEl = card.querySelector('[data-field="keywords"]');
  var promptEl = card.querySelector('[data-field="system_prompt"]');
  var styleEl = card.querySelector('[data-field="style_guide"]');

  return {
    name: nameEl ? nameEl.value.trim() : p.name,
    bio: bioEl ? bioEl.value.trim() : p.bio,
    beat: p.beat,
    beats: p.beats,
    keywords: keywordsEl ? keywordsEl.value.split(',').map(function(k) { return k.trim(); }).filter(Boolean) : p.keywords,
    system_prompt: promptEl ? promptEl.value.trim() : p.system_prompt,
    tone: toneEl ? toneEl.value : p.tone,
    expertise_level: expertiseEl ? expertiseEl.value : p.expertise_level,
    style_guide: styleEl ? styleEl.value.trim() : p.style_guide,
    gender: genderEl ? (genderEl.value || null) : p.gender,
    ethnicity: ethnicityEl ? (ethnicityEl.value || null) : p.ethnicity,
    is_auto: true,
    synthesis_schedule: 'daily',
    synthesis_lookback_hours: 168,
    min_cluster_size: 3,
  };
}

async function createAiGenWriters() {
  var selected = [];
  document.querySelectorAll('.aiGenSelect:checked').forEach(function(cb) {
    selected.push(parseInt(cb.dataset.idx));
  });
  if (!selected.length) { showAlert('Select at least one writer', 'error'); return; }

  // Read edited values from DOM BEFORE replacing innerHTML
  var personaData = {};
  selected.forEach(function(idx) { personaData[idx] = readAiGenCard(idx); });

  var content = document.getElementById('aiGenContent');
  var statusHtml = selected.map(function(idx) {
    var p = personaData[idx];
    return '<div id="aiGenStatus' + idx + '" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">'
      + '<span class="spinner" style="width:16px;height:16px;"></span>'
      + '<span>Creating <strong>' + esc(p.name) + '</strong> (' + esc(p.categoryName) + ')...</span>'
      + '</div>';
  }).join('');

  content.innerHTML = '<div id="aiGenProgress">' + statusHtml + '</div>'
    + '<div style="margin-top:16px;display:flex;justify-content:flex-end;">'
    + '<button class="btn btn-outline" id="aiGenDoneBtn" style="display:none;" data-close-modal>Done</button></div>';
  initModals();

  var created = 0;
  var failed = 0;
  var createdIds = [];

  for (var i = 0; i < selected.length; i++) {
    var idx = selected[i];
    var persona = personaData[idx];
    var statusEl = document.getElementById('aiGenStatus' + idx);

    try {
      var savedWriter = await apiFetch('/admin/writers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(persona)
      });
      created++;
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--success);">&#10003;</span> <span><strong>' + esc(persona.name) + '</strong> created — generating avatar...</span>';

      // Fire-and-forget avatar generation
      if (savedWriter && savedWriter.id) {
        createdIds.push(savedWriter.id);
        apiFetch('/admin/writers/' + savedWriter.id + '/generate-avatar', { method: 'POST' }).catch(function() {});
      }
    } catch (err) {
      failed++;
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">&#10007;</span> <span><strong>' + esc(persona.name) + '</strong> failed: ' + esc(err.message) + '</span>';
    }
  }

  // Show done button and summary
  var summary = '<p style="margin-top:12px;font-size:13px;">' + created + ' writer' + (created !== 1 ? 's' : '') + ' created.'
    + (failed ? ' ' + failed + ' failed.' : '')
    + ' Avatars will appear as they generate.</p>';
  var progress = document.getElementById('aiGenProgress');
  if (progress) progress.insertAdjacentHTML('afterend', summary);
  var doneBtn = document.getElementById('aiGenDoneBtn');
  if (doneBtn) doneBtn.style.display = '';

  // Refresh writers table and poll for avatars
  await loadWriters();
  if (createdIds.length) startAvatarPolling(createdIds);
}

document.getElementById('aiGenerateWritersBtn').addEventListener('click', openAiGenerate);

// ── Avatar Polling ──────────────────────────────────────────────

function startAvatarPolling(writerIds) {
  stopAvatarPolling();
  var remaining = new Set(writerIds);
  var attempts = 0;
  var maxAttempts = 30; // ~2.5 min at 5s intervals

  avatarPollTimer = setInterval(async function() {
    attempts++;
    if (!remaining.size || attempts > maxAttempts) { stopAvatarPolling(); return; }
    try {
      var fresh = await apiFetch('/admin/writers');
      writers = fresh;
      for (var i = 0; i < fresh.length; i++) {
        if (remaining.has(fresh[i].id) && fresh[i].avatar_url) {
          remaining.delete(fresh[i].id);
        }
      }
      renderWriters();
      if (!remaining.size) stopAvatarPolling();
    } catch (e) { /* ignore */ }
  }, 5000);
}

function stopAvatarPolling() {
  if (avatarPollTimer) { clearInterval(avatarPollTimer); avatarPollTimer = null; }
}

// ── Initialize ───────────────────────────────────────────────────

async function init() {
  renderSidebar();
  initModals();
  await loadCategoriesList();
  await loadWriters();

  // Voice preview handler
  document.getElementById('previewVoiceBtn').addEventListener('click', async function() {
    var voiceId = document.getElementById('fWriterElevenLabsVoice').value.trim();
    if (!voiceId) { showAlert('Enter an ElevenLabs Voice ID first', 'error'); return; }
    var statusEl = document.getElementById('voicePreviewStatus');
    statusEl.style.display = '';
    statusEl.textContent = 'Generating preview...';
    this.disabled = true;
    try {
      var data = await apiFetch('/media/preview-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_id: voiceId })
      });
      var raw = atob(data.audio);
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'audio/mpeg' });
      var blobUrl = URL.createObjectURL(blob);
      var audio = new Audio(blobUrl);
      audio.play();
      statusEl.textContent = 'Playing preview...';
      audio.onended = function() { statusEl.style.display = 'none'; URL.revokeObjectURL(blobUrl); };
    } catch (err) {
      statusEl.textContent = 'Preview failed: ' + err.message;
    } finally {
      document.getElementById('previewVoiceBtn').disabled = false;
    }
  });
}

onReady(function() {
  if (!requireAuth()) return;
  if (!hasPermission('writers.create')) {
    var btn = document.getElementById('addWriterBtn');
    if (btn) btn.style.display = 'none';
    var aiBtn = document.getElementById('aiGenerateWritersBtn');
    if (aiBtn) aiBtn.style.display = 'none';
  }
  init();
});
