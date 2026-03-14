let writers = [];
let voicesList = [];
let pendingDeleteId = null;
let pendingAvatarDataUrl = null;

async function loadWriters() {
  try {
    writers = await apiFetch('/admin/writers');
    renderWriters();
  } catch (err) {
    showAlert('Failed to load writers: ' + err.message, 'error');
  }
}

async function loadVoicesList() {
  try {
    voicesList = await apiFetch('/voices');
  } catch { voicesList = []; }
}

function renderWriters() {
  const tbody = document.getElementById('writersBody');
  if (!writers.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">&#9997;&#65039;</div><p>No writers configured &mdash; add one to get started</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = writers.map(w => {
    const avatarHtml = w.avatar_url
      ? '<img src="' + esc(w.avatar_url) + '" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" onerror="this.outerHTML=\'<div style=\\\'width:36px;height:36px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;\\\'>&#9997;&#65039;</div>\'" />'
      : '<div style="width:36px;height:36px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;">&#9997;&#65039;</div>';

    const autoBadge = w.is_auto
      ? '<span class="badge badge-accent" style="font-size:10px;">Auto</span>'
      : '<span class="text-muted text-sm">Manual</span>';

    return '<tr>'
      + '<td>' + avatarHtml + '</td>'
      + '<td><strong>' + esc(w.name) + '</strong></td>'
      + '<td class="text-muted">' + esc(w.beat || '&mdash;') + '</td>'
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

function populateVoiceDropdown(selectedId) {
  const sel = document.getElementById('fWriterVoice');
  sel.innerHTML = '<option value="">None (no audio)</option>' + voicesList.map(v =>
    '<option value="' + v.id + '"' + (v.id === selectedId ? ' selected' : '') + '>' + esc(v.name) + (v.is_default ? ' (default)' : '') + '</option>'
  ).join('');
}

async function populateBeatDropdown() {
  await loadCategories();
  const sel = document.getElementById('fWriterBeat');
  if (!sel) return;
  const cats = window._siteCategories && window._siteCategories.length ? window._siteCategories : [];
  sel.innerHTML = '<option value="">None</option>' + cats.map(function(c) {
    return '<option value="' + c + '">' + c + '</option>';
  }).join('');
}

// Auto-generate slug from name on create
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
  document.getElementById('fWriterBeat').value = '';
  document.getElementById('fWriterKeywords').value = '';
  document.getElementById('fWriterSystemPrompt').value = '';
  document.getElementById('fWriterIsAuto').checked = false;
  document.getElementById('fWriterSchedule').value = 'daily';
  document.getElementById('fWriterLookback').value = '168';
  document.getElementById('fWriterMinCluster').value = '3';
  document.getElementById('writerAvatarPreviewWrap').style.display = 'none';
  document.getElementById('fWriterAvatar').value = '';
  pendingAvatarDataUrl = null;
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
  document.getElementById('fWriterBeat').value = w.beat || '';
  document.getElementById('fWriterKeywords').value = (w.keywords || []).join(', ');
  document.getElementById('fWriterSystemPrompt').value = w.system_prompt || '';
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
  populateVoiceDropdown(w.voice_id);
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

document.getElementById('saveWriterBtn').addEventListener('click', async function() {
  var editId  = document.getElementById('editWriterId').value;
  var name    = document.getElementById('fWriterName').value.trim();
  var slug    = document.getElementById('fWriterSlug').value.trim();
  var bio     = document.getElementById('fWriterBio').value.trim();
  var beat    = document.getElementById('fWriterBeat').value.trim();
  var keywordsRaw = document.getElementById('fWriterKeywords').value.trim();
  var keywords = keywordsRaw ? keywordsRaw.split(',').map(function(k) { return k.trim(); }).filter(Boolean) : [];
  var system_prompt = document.getElementById('fWriterSystemPrompt').value.trim();
  var is_auto = document.getElementById('fWriterIsAuto').checked;
  var synthesis_schedule = document.getElementById('fWriterSchedule').value;
  var synthesis_lookback_hours = parseInt(document.getElementById('fWriterLookback').value) || 168;
  var min_cluster_size = parseInt(document.getElementById('fWriterMinCluster').value) || 3;
  var voiceVal = document.getElementById('fWriterVoice').value;
  var voice_id = voiceVal ? parseInt(voiceVal) : null;

  if (!name) { showAlert('Name is required', 'error'); return; }

  var payload = {
    name: name,
    slug: slug || null,
    bio: bio || null,
    beat: beat || null,
    keywords: keywords,
    system_prompt: system_prompt || null,
    is_auto: is_auto,
    synthesis_schedule: synthesis_schedule,
    synthesis_lookback_hours: synthesis_lookback_hours,
    min_cluster_size: min_cluster_size,
    voice_id: voice_id,
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

    // Upload avatar separately
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

// Initialize
async function init() {
  renderSidebar();
  initModals();
  await populateBeatDropdown();
  await loadVoicesList();
  await loadWriters();
}

onReady(function() {
  if (!requireAuth()) return;
  init();
});
