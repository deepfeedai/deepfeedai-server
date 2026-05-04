'use strict';

var styles = [];

// ── Load ─────────────────────────────────────────────────────────
async function loadStyles() {
  try {
    styles = await apiFetch('/admin/writing-styles');
    renderStyles();
  } catch (err) {
    showAlert('Failed to load writing styles: ' + err.message, 'error');
  }
}

function renderStyles() {
  var system = styles.filter(function(s) { return s.is_system; });
  var tenant = styles.filter(function(s) { return !s.is_system; });

  document.getElementById('systemGrid').innerHTML = system.length
    ? system.map(styleCard).join('')
    : '<div class="text-muted text-sm">No system styles found.</div>';

  document.getElementById('tenantGrid').innerHTML = tenant.length
    ? tenant.map(styleCard).join('')
    : '<div class="text-muted text-sm">No custom styles yet — create one or fork a system style.</div>';
}

function styleCard(s) {
  var isSystem = s.is_system;
  var actions = isSystem
    ? '<button class="btn btn-sm" onclick="forkStyle(' + s.id + ')">Fork &amp; Customise</button>'
    : '<button class="btn btn-sm" onclick="openEdit(' + s.id + ')">Edit</button>'
      + '<button class="btn btn-sm btn-danger" onclick="deleteStyle(' + s.id + ', \'' + esc(s.name) + '\')">Delete</button>';

  return '<div class="style-card' + (isSystem ? ' system' : '') + '">'
    + '<div class="style-card-header">'
    +   '<div>'
    +     '<div class="style-card-name">' + esc(s.name) + (isSystem ? ' <span class="badge-system">System</span>' : '') + '</div>'
    +     (s.description ? '<div class="style-card-desc" style="margin-top:4px;">' + esc(s.description) + '</div>' : '')
    +   '</div>'
    + '</div>'
    + '<div class="style-card-prompt">' + esc(s.prompt) + '</div>'
    + '<div class="style-card-actions">'
    +   actions
    +   '<button class="btn btn-sm" onclick="previewStyle(' + s.id + ')">Preview</button>'
    + '</div>'
    + '</div>';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Modal ─────────────────────────────────────────────────────────
function openCreate() {
  document.getElementById('modalTitle').textContent = 'New Writing Style';
  document.getElementById('fStyleId').value = '';
  document.getElementById('fStyleName').value = '';
  document.getElementById('fStyleDesc').value = '';
  document.getElementById('fStylePrompt').value = '';
  document.getElementById('previewBox').style.display = 'none';
  document.getElementById('previewLoading').style.display = 'none';
  document.getElementById('runPreviewBtn').textContent = 'Generate preview';
  openModal('styleModal');
}

function openEdit(id) {
  var s = styles.find(function(x) { return x.id === id; });
  if (!s) return;
  document.getElementById('modalTitle').textContent = s.is_system ? 'View Writing Style' : 'Edit Writing Style';
  document.getElementById('fStyleId').value = s.id;
  document.getElementById('fStyleName').value = s.name || '';
  document.getElementById('fStyleDesc').value = s.description || '';
  document.getElementById('fStylePrompt').value = s.prompt || '';
  document.getElementById('previewLoading').style.display = 'none';
  document.getElementById('runPreviewBtn').textContent = s.sample_output ? 'Regenerate preview' : 'Generate preview';
  var box = document.getElementById('previewBox');
  if (s.sample_output) {
    box.className = 'preview-box';
    box.textContent = s.sample_output;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
  openModal('styleModal');
}

// ── Save ──────────────────────────────────────────────────────────
async function saveStyle() {
  var id     = document.getElementById('fStyleId').value;
  var name   = document.getElementById('fStyleName').value.trim();
  var desc   = document.getElementById('fStyleDesc').value.trim();
  var prompt = document.getElementById('fStylePrompt').value.trim();

  if (!name || !prompt) { showAlert('Name and prompt are required', 'error'); return; }

  var body = { name, description: desc, prompt };

  try {
    if (id) {
      await apiFetch('/admin/writing-styles/' + id, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await apiFetch('/admin/writing-styles', { method: 'POST', body: JSON.stringify(body) });
    }
    closeModal('styleModal');
    await loadStyles();
    showAlert('Style saved', 'success');
  } catch (err) {
    showAlert('Save failed: ' + err.message, 'error');
  }
}

// ── Fork ──────────────────────────────────────────────────────────
async function forkStyle(id) {
  try {
    await apiFetch('/admin/writing-styles/' + id + '/fork', { method: 'POST' });
    await loadStyles();
    showAlert('Style forked — edit it in Your Styles', 'success');
  } catch (err) {
    showAlert('Fork failed: ' + err.message, 'error');
  }
}

// ── Delete ────────────────────────────────────────────────────────
async function deleteStyle(id, name) {
  if (!confirm('Delete "' + name + '"? Writers using this style will lose it.')) return;
  try {
    await apiFetch('/admin/writing-styles/' + id, { method: 'DELETE' });
    await loadStyles();
    showAlert('Style deleted', 'success');
  } catch (err) {
    showAlert('Delete failed: ' + err.message, 'error');
  }
}

// ── Preview ───────────────────────────────────────────────────────
function cacheSampleOutput(id, text) {
  var s = styles.find(function(x) { return x.id === id; });
  if (!s || s.is_system) return;
  s.sample_output = text;
  document.getElementById('runPreviewBtn').textContent = 'Regenerate preview';
  apiFetch('/admin/writing-styles/' + id, { method: 'PUT', body: JSON.stringify({ sample_output: text }) })
    .catch(function() {});
}

async function previewStyle(id) {
  var s       = styles.find(function(x) { return x.id === id; });
  var box     = document.getElementById('previewBox');
  var loading = document.getElementById('previewLoading');

  openEdit(id);

  if (s && s.sample_output) {
    loading.style.display = 'none';
    box.className = 'preview-box';
    box.textContent = s.sample_output;
    box.style.display = '';
    return;
  }

  box.style.display = 'none';
  loading.style.display = '';

  try {
    var data = await apiFetch('/admin/writing-styles/preview', { method: 'POST', body: JSON.stringify({ styleId: id }) });
    loading.style.display = 'none';
    box.className = 'preview-box';
    box.textContent = data.preview || '(no preview returned)';
    box.style.display = '';
    if (data.preview) cacheSampleOutput(id, data.preview);
  } catch (err) {
    loading.style.display = 'none';
    box.className = 'preview-box';
    box.textContent = 'Preview failed: ' + err.message;
    box.style.display = '';
  }
}

async function runPreview() {
  var prompt  = document.getElementById('fStylePrompt').value.trim();
  var id      = document.getElementById('fStyleId').value;
  var box     = document.getElementById('previewBox');
  var loading = document.getElementById('previewLoading');

  if (!prompt && !id) { showAlert('Enter a prompt first', 'error'); return; }

  box.style.display = 'none';
  loading.style.display = '';

  try {
    var body = id ? { styleId: parseInt(id), prompt } : { prompt };
    var data = await apiFetch('/admin/writing-styles/preview', { method: 'POST', body: JSON.stringify(body) });
    loading.style.display = 'none';
    box.className = 'preview-box';
    box.textContent = data.preview || '(no preview returned)';
    box.style.display = '';
    if (data.preview && id) cacheSampleOutput(parseInt(id), data.preview);
  } catch (err) {
    loading.style.display = 'none';
    box.className = 'preview-box';
    box.textContent = 'Preview failed: ' + err.message;
    box.style.display = '';
  }
}

// ── Boot ──────────────────────────────────────────────────────────
renderSidebar();
initModals();
loadStyles();
