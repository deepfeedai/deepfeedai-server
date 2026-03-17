let writers = [];
let voicesList = [];
let categoriesList = [];
let perfData = [];
let pendingDeleteId = null;
let pendingAvatarDataUrl = null;
let perfSortCol = 'articles_total';
let perfSortDir = 'desc';

// ── Data Loading ─────────────────────────────────────────────────

async function loadWriters() {
  try {
    writers = await apiFetch('/admin/writers');
    renderWriters();
  } catch (err) {
    showAlert('Failed to load writers: ' + err.message, 'error');
  }
}

async function loadVoicesList() {
  try { voicesList = await apiFetch('/voices'); } catch { voicesList = []; }
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
      + '<td class="text-muted text-sm">' + esc(w.voice_name || 'None') + '</td>'
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

// ── Voice Dropdown ───────────────────────────────────────────────

function populateVoiceDropdown(selectedId) {
  var sel = document.getElementById('fWriterVoice');
  sel.innerHTML = '<option value="">None (no audio)</option>' + voicesList.map(function(v) {
    return '<option value="' + v.id + '"' + (v.id === selectedId ? ' selected' : '') + '>' + esc(v.name) + (v.is_default ? ' (default)' : '') + '</option>';
  }).join('');
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
  document.getElementById('fWriterIsAuto').checked = false;
  document.getElementById('fWriterSchedule').value = 'daily';
  document.getElementById('fWriterLookback').value = '168';
  document.getElementById('fWriterMinCluster').value = '3';
  document.getElementById('writerAvatarPreviewWrap').style.display = 'none';
  document.getElementById('avatarPromptPreview').style.display = 'none';
  document.getElementById('fWriterAvatar').value = '';
  pendingAvatarDataUrl = null;
  populateBeatsCheckboxes([]);
  populateVoiceDropdown(null);
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
  populateBeatsCheckboxes(beatIds);
  populateVoiceDropdown(w.voice_id);

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
  var voiceVal = document.getElementById('fWriterVoice').value;
  var voice_id = voiceVal ? parseInt(voiceVal) : null;
  var beats = getSelectedBeats();
  var gender = document.getElementById('fWriterGender').value || null;

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
    voice_id: voice_id,
    gender: gender,
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

async function loadPerformance(range) {
  try {
    perfData = await apiFetch('/admin/writers/performance?range=' + (range || '30d'));
    renderPerformance();
  } catch (err) {
    document.getElementById('perfBody').innerHTML = '<tr><td colspan="10" class="text-muted" style="text-align:center;">Failed to load: ' + esc(err.message) + '</td></tr>';
  }
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

// ── Initialize ───────────────────────────────────────────────────

async function init() {
  renderSidebar();
  initModals();
  await loadCategoriesList();
  await loadVoicesList();
  await loadWriters();
}

onReady(function() {
  if (!requireAuth()) return;
  if (!hasPermission('writers.create')) {
    var btn = document.getElementById('addWriterBtn');
    if (btn) btn.style.display = 'none';
  }
  init();
});
