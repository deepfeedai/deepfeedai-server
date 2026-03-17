var users = [];
var roles = [];

// ── Data Loading ─────────────────────────────────────────────────

async function loadUsers() {
  try {
    var results = await Promise.all([
      apiFetch('/admin/users'),
      apiFetch('/admin/roles'),
    ]);
    users = results[0];
    roles = results[1];
    populateRoleDropdown();
    renderUsers();
  } catch (err) {
    if (err.message.includes('403')) {
      document.getElementById('usersBody').innerHTML =
        '<tr><td colspan="7"><div class="empty-state">You don\'t have permission to view users</div></td></tr>';
      document.getElementById('addUserBtn').style.display = 'none';
      return;
    }
    showToast('Failed to load users: ' + err.message, 'error');
  }
}

// ── Render ───────────────────────────────────────────────────────

function renderUsers() {
  var tbody = document.getElementById('usersBody');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No users yet. Click "+ Add User" to create one.</div></td></tr>';
    return;
  }
  tbody.innerHTML = users.map(function(u) {
    return '<tr>'
      + '<td class="td-title">' + esc(u.username) + '</td>'
      + '<td>' + esc(u.display_name || '\u2014') + '</td>'
      + '<td class="text-muted">' + esc(u.email || '\u2014') + '</td>'
      + '<td><span class="badge ' + (u.role === 'owner' ? 'badge-accent' : 'badge-muted') + '">' + esc(u.role) + '</span></td>'
      + '<td><span class="badge ' + (u.is_active ? 'badge-success' : 'badge-danger') + '">' + (u.is_active ? 'Active' : 'Inactive') + '</span></td>'
      + '<td class="text-muted text-sm">' + (u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'Never') + '</td>'
      + '<td class="td-actions">'
      + '<div style="display:flex;gap:6px;">'
      + '<button class="btn btn-ghost btn-sm" onclick="editUser(' + u.id + ')" title="Edit">&#9998;</button>'
      + '<button class="btn btn-ghost btn-sm" onclick="resetPassword(' + u.id + ')" title="Reset Password">&#128273;</button>'
      + (u.is_active ? '<button class="btn btn-ghost btn-sm text-danger" onclick="deactivateUser(' + u.id + ', \'' + esc(u.username).replace(/'/g, "\\'") + '\')" title="Deactivate">&#10005;</button>' : '')
      + '<button class="btn btn-ghost btn-sm text-danger" onclick="deleteUserPermanent(' + u.id + ', \'' + esc(u.username).replace(/'/g, "\\'") + '\')" title="Delete permanently">&#128465;</button>'
      + '</div>'
      + '</td>'
      + '</tr>';
  }).join('');
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Role Dropdown ────────────────────────────────────────────────

function populateRoleDropdown(selectedRole) {
  var sel = document.getElementById('userRole');
  sel.innerHTML = roles.map(function(r) {
    var name = typeof r === 'string' ? r : r.name;
    var selected = name === selectedRole ? ' selected' : '';
    return '<option value="' + esc(name) + '"' + selected + '>' + esc(name) + '</option>';
  }).join('');
}

// ── Modal Open/Close ─────────────────────────────────────────────

function openAddUser() {
  document.getElementById('userModalTitle').textContent = 'Add User';
  document.getElementById('userId').value = '';
  document.getElementById('userUsername').value = '';
  document.getElementById('userDisplayName').value = '';
  document.getElementById('userEmail').value = '';
  document.getElementById('userPassword').value = '';
  document.getElementById('passwordGroup').style.display = '';
  document.getElementById('activeGroup').style.display = 'none';
  populateRoleDropdown();
  openModal('userModal');
  document.getElementById('userUsername').focus();
}

function editUser(id) {
  var u = users.find(function(x) { return x.id === id; });
  if (!u) return;
  document.getElementById('userModalTitle').textContent = 'Edit User';
  document.getElementById('userId').value = u.id;
  document.getElementById('userUsername').value = u.username;
  document.getElementById('userDisplayName').value = u.display_name || '';
  document.getElementById('userEmail').value = u.email || '';
  document.getElementById('userPassword').value = '';
  document.getElementById('passwordGroup').style.display = 'none';
  document.getElementById('activeGroup').style.display = '';
  document.getElementById('userActive').checked = !!u.is_active;
  populateRoleDropdown(u.role);
  openModal('userModal');
  document.getElementById('userUsername').focus();
}

// ── Save User ────────────────────────────────────────────────────

async function saveUser() {
  var editId = document.getElementById('userId').value;
  var username = document.getElementById('userUsername').value.trim();
  var display_name = document.getElementById('userDisplayName').value.trim();
  var email = document.getElementById('userEmail').value.trim();
  var password = document.getElementById('userPassword').value;
  var role = document.getElementById('userRole').value;

  if (!username || username.length < 3) {
    showToast('Username must be at least 3 characters', 'error');
    return;
  }

  if (!editId && (!password || password.length < 8)) {
    showToast('Password must be at least 8 characters', 'error');
    return;
  }

  var payload;

  if (!editId) {
    payload = {
      username: username,
      display_name: display_name || username,
      email: email || null,
      role: role,
      password: password,
    };
  } else {
    payload = {
      display_name: display_name || null,
      email: email || null,
      role: role,
      is_active: document.getElementById('userActive').checked ? 1 : 0,
    };
  }

  try {
    if (editId) {
      await apiFetch('/admin/users/' + editId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      await apiFetch('/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    closeModal('userModal');
    showToast(editId ? 'User updated' : 'User created');
    await loadUsers();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

// ── Deactivate User ──────────────────────────────────────────────

async function deactivateUser(id, username) {
  if (!confirm('Deactivate user "' + username + '"? They will no longer be able to log in.')) return;
  try {
    await apiFetch('/admin/users/' + id, { method: 'DELETE' });
    showToast('User deactivated');
    await loadUsers();
  } catch (err) {
    showToast('Failed to deactivate: ' + err.message, 'error');
  }
}

// ── Delete User Permanently ──────────────────────────────────────

async function deleteUserPermanent(id, username) {
  if (!confirm('PERMANENTLY delete user "' + username + '"? This cannot be undone.')) return;
  try {
    var res = await apiFetch('/admin/users/' + id + '/permanent', { method: 'DELETE' });
    if (res.logout) {
      localStorage.removeItem('deepfeedai_token');
      showToast('Your account has been deleted. Logging out...');
      setTimeout(function() { window.location.href = '/login.html'; }, 1500);
      return;
    }
    showToast('User permanently deleted');
    await loadUsers();
  } catch (err) {
    showToast('Failed to delete: ' + err.message, 'error');
  }
}

// ── Reset Password ───────────────────────────────────────────────

function resetPassword(id) {
  document.getElementById('resetUserId').value = id;
  document.getElementById('resetPassword').value = '';
  openModal('resetPwModal');
  document.getElementById('resetPassword').focus();
}

async function doResetPassword() {
  var id = document.getElementById('resetUserId').value;
  var password = document.getElementById('resetPassword').value;

  if (!password || password.length < 8) {
    showToast('Password must be at least 8 characters', 'error');
    return;
  }

  try {
    await apiFetch('/admin/users/' + id + '/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password })
    });
    closeModal('resetPwModal');
    showToast('Password reset successfully');
  } catch (err) {
    showToast('Reset failed: ' + err.message, 'error');
  }
}

// ── Event Listeners & Init ───────────────────────────────────────

document.getElementById('addUserBtn').addEventListener('click', openAddUser);
document.getElementById('saveUserBtn').addEventListener('click', saveUser);
document.getElementById('resetPwBtn').addEventListener('click', doResetPassword);

onReady(function() {
  if (!requireAuth()) return;
  renderSidebar();
  initModals();
  loadUsers();
});
