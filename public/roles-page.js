/* ===== DeepFeedAI Admin — Roles & Permissions ===== */

var roles = [];

var PERMISSION_GROUPS = [
  { resource: 'articles', label: 'Articles', actions: ['read', 'create', 'update', 'delete', 'publish'] },
  { resource: 'sources', label: 'Sources', actions: ['read', 'create', 'update', 'delete'] },
  { resource: 'writers', label: 'Writers', actions: ['read', 'create', 'update', 'delete'] },
  { resource: 'categories', label: 'Categories', actions: ['read', 'create', 'update', 'delete'] },
  { resource: 'media', label: 'Media', actions: ['read', 'create', 'delete'] },
  { resource: 'voices', label: 'Voices', actions: ['read', 'create', 'update', 'delete'] },
  { resource: 'settings', label: 'Settings', actions: ['read', 'update'] },
  { resource: 'analytics', label: 'Analytics', actions: ['read'] },
  { resource: 'comments', label: 'Comments', actions: ['read', 'moderate', 'delete'] },
  { resource: 'newsletter', label: 'Newsletter', actions: ['read', 'send'] },
  { resource: 'users', label: 'Users', actions: ['read', 'create', 'update', 'delete'] },
  { resource: 'roles', label: 'Roles', actions: ['read', 'create', 'update', 'delete'] },
  { resource: 'fetch', label: 'Fetch', actions: ['execute'] },
  { resource: 'synthesis', label: 'Synthesis', actions: ['execute'] },
  { resource: 'audit', label: 'Audit Log', actions: ['read'] },
];

// ── Helpers ──────────────────────────────────────────────────

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parsePermissions(role) {
  var perms = role.permissions;
  if (typeof perms === 'string') {
    try { perms = JSON.parse(perms); } catch { perms = []; }
  }
  return Array.isArray(perms) ? perms : [];
}

// ── Data Loading ─────────────────────────────────────────────

async function loadRoles() {
  try {
    roles = await apiFetch('/admin/roles');
    renderRoles();
  } catch (err) {
    showAlert('Failed to load roles: ' + err.message, 'error');
  }
}

// ── Table Rendering ──────────────────────────────────────────

function renderRoles() {
  var tbody = document.getElementById('rolesBody');
  if (!roles.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No roles found</div></td></tr>';
    return;
  }
  tbody.innerHTML = roles.map(function(r) {
    var perms = parsePermissions(r);
    var permLabel = perms.includes('*') ? 'Full access' : perms.length + ' permissions';
    return '<tr>'
      + '<td class="td-title">' + esc(r.name) + '</td>'
      + '<td class="text-muted">' + esc(r.description || '\u2014') + '</td>'
      + '<td class="text-center"><span class="badge badge-muted">' + permLabel + '</span></td>'
      + '<td class="text-center">' + (r.is_system ? '<span class="badge badge-accent">System</span>' : '<span class="badge badge-muted">Custom</span>') + '</td>'
      + '<td class="td-actions">'
      + '<button class="btn btn-ghost btn-sm" onclick="viewRole(' + r.id + ')" title="View">\uD83D\uDC41</button>'
      + (!r.is_system
        ? ' <button class="btn btn-ghost btn-sm" onclick="editRole(' + r.id + ')" title="Edit">&#9998;</button>'
        + ' <button class="btn btn-ghost btn-sm text-danger" onclick="deleteRole(' + r.id + ', \'' + esc(r.name).replace(/'/g, "\\'") + '\')" title="Delete">&#10005;</button>'
        : '')
      + '</td>'
      + '</tr>';
  }).join('');
}

// ── Permissions Grid ─────────────────────────────────────────

function renderPermissionsGrid(selectedPerms) {
  var sel = new Set(selectedPerms || []);
  var container = document.getElementById('permissionsGrid');

  container.innerHTML = PERMISSION_GROUPS.map(function(group) {
    var allChecked = group.actions.every(function(a) { return sel.has(group.resource + '.' + a); });

    var actionsHtml = group.actions.map(function(action) {
      var perm = group.resource + '.' + action;
      var checked = sel.has(perm) ? ' checked' : '';
      return '<label class="perm-action">'
        + '<input type="checkbox" data-perm="' + perm + '"' + checked + ' />'
        + action
        + '</label>';
    }).join('');

    return '<div class="perm-group">'
      + '<div class="perm-group-header">'
      + '<span class="perm-group-title">' + esc(group.label) + '</span>'
      + '<span class="perm-group-all" data-resource="' + group.resource + '">' + (allChecked ? 'Deselect All' : 'Select All') + '</span>'
      + '</div>'
      + '<div class="perm-actions">' + actionsHtml + '</div>'
      + '</div>';
  }).join('');

  // Wire up Select All toggles
  container.querySelectorAll('.perm-group-all').forEach(function(toggle) {
    toggle.addEventListener('click', function() {
      var resource = this.dataset.resource;
      var group = this.closest('.perm-group');
      var checkboxes = group.querySelectorAll('input[type="checkbox"]');
      var allChecked = Array.from(checkboxes).every(function(cb) { return cb.checked; });
      checkboxes.forEach(function(cb) { cb.checked = !allChecked; });
      this.textContent = allChecked ? 'Select All' : 'Deselect All';
    });
  });
}

function getSelectedPermissions() {
  var checked = document.querySelectorAll('#permissionsGrid input[type="checkbox"]:checked');
  var perms = [];
  checked.forEach(function(cb) { perms.push(cb.dataset.perm); });
  return perms;
}

// ── Modal Actions ────────────────────────────────────────────

function openAddRole() {
  document.getElementById('roleModalTitle').textContent = 'Add Role';
  document.getElementById('roleId').value = '';
  document.getElementById('roleName').value = '';
  document.getElementById('roleName').disabled = false;
  document.getElementById('roleDescription').value = '';
  renderPermissionsGrid([]);
  openModal('roleModal');
  document.getElementById('roleName').focus();
}

function editRole(id) {
  var r = roles.find(function(x) { return x.id === id; });
  if (!r) return;
  if (r.is_system) return;

  document.getElementById('roleModalTitle').textContent = 'Edit Role';
  document.getElementById('roleId').value = r.id;
  document.getElementById('roleName').value = r.name;
  document.getElementById('roleName').disabled = true;
  document.getElementById('roleDescription').value = r.description || '';

  var perms = parsePermissions(r);
  renderPermissionsGrid(perms);
  openModal('roleModal');
}

function viewRole(id) {
  var r = roles.find(function(x) { return x.id === id; });
  if (!r) return;

  var perms = parsePermissions(r);
  var permLabel = perms.includes('*') ? 'Full access' : perms.length + ' permissions';

  var permListHtml = '';
  if (perms.includes('*')) {
    permListHtml = '<p class="text-accent" style="font-weight:600;">Full access (wildcard)</p>';
  } else if (perms.length) {
    // Group by resource
    var grouped = {};
    perms.forEach(function(p) {
      var parts = p.split('.');
      var res = parts[0];
      var act = parts.slice(1).join('.');
      if (!grouped[res]) grouped[res] = [];
      grouped[res].push(act);
    });
    permListHtml = '<div class="permissions-grid">';
    Object.keys(grouped).forEach(function(res) {
      permListHtml += '<div class="perm-group">'
        + '<div class="perm-group-header"><span class="perm-group-title">' + esc(res) + '</span></div>'
        + '<div class="perm-actions">' + grouped[res].map(function(a) {
          return '<span class="badge badge-muted" style="margin:2px;">' + esc(a) + '</span>';
        }).join('') + '</div>'
        + '</div>';
    });
    permListHtml += '</div>';
  } else {
    permListHtml = '<p class="text-muted">No permissions assigned</p>';
  }

  document.getElementById('viewRoleTitle').textContent = r.name + (r.is_system ? ' (System)' : '');
  document.getElementById('viewRoleBody').innerHTML =
    '<div class="form-group"><label class="form-label">Description</label><p>' + esc(r.description || '\u2014') + '</p></div>'
    + '<div class="form-group"><label class="form-label">Permissions (' + permLabel + ')</label>' + permListHtml + '</div>';
  openModal('viewRoleModal');
}

async function saveRole() {
  var editId = document.getElementById('roleId').value;
  var name = document.getElementById('roleName').value.trim();
  var description = document.getElementById('roleDescription').value.trim();
  var permissions = getSelectedPermissions();

  if (!editId && !name) { showAlert('Role name is required', 'error'); return; }
  if (!permissions.length) { showAlert('Select at least one permission', 'error'); return; }

  var payload = { permissions: permissions };
  if (!editId) payload.name = name;
  if (description) payload.description = description;

  try {
    if (editId) {
      await apiFetch('/admin/roles/' + editId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      await apiFetch('/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    closeModal('roleModal');
    showAlert(editId ? 'Role updated' : 'Role created');
    await loadRoles();
  } catch (err) {
    showAlert('Save failed: ' + err.message, 'error');
  }
}

async function deleteRole(id, name) {
  if (!confirm('Delete role "' + name + '"? This cannot be undone.')) return;
  try {
    await apiFetch('/admin/roles/' + id, { method: 'DELETE' });
    showAlert('Role deleted');
    await loadRoles();
  } catch (err) {
    showAlert('Delete failed: ' + err.message, 'error');
  }
}

// ── Event Listeners ──────────────────────────────────────────

document.getElementById('addRoleBtn').addEventListener('click', openAddRole);
document.getElementById('saveRoleBtn').addEventListener('click', saveRole);

// ── Initialize ───────────────────────────────────────────────

async function init() {
  renderSidebar();
  initModals();
  await loadRoles();
}

onReady(function() {
  if (!requireAuth()) return;
  init();
});
