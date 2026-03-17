/* Deep Feed AI Admin — Audit Log page */

var auditData = [];
var currentPage = 1;
var totalPages = 1;
var totalItems = 0;
var liveTailInterval = null;
var PAGE_SIZE = 50;

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Load ──────────────────────────────────────────────────────────

async function loadAuditLog() {
  var params = new URLSearchParams();
  params.set('page', currentPage);
  params.set('limit', PAGE_SIZE);

  var action = document.getElementById('filterAction').value;
  var from = document.getElementById('filterFrom').value;
  var to = document.getElementById('filterTo').value;
  var search = document.getElementById('filterSearch').value.trim();

  if (action) params.set('action', action);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (search) params.set('search', search);

  try {
    var result = await apiFetch('/admin/audit-log?' + params.toString());
    auditData = result.items;
    totalItems = result.total;
    totalPages = result.pages;
    currentPage = result.page;
    renderAuditLog();
    renderPaginationControls();
    updateStats();
  } catch (err) {
    showToast('Failed to load audit log: ' + err.message, 'error');
  }
}

// ── Render ────────────────────────────────────────────────────────

function renderAuditLog() {
  var tbody = document.getElementById('auditBody');
  if (!auditData.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">No audit events found</div></td></tr>';
    return;
  }
  tbody.innerHTML = auditData.map(function(e) {
    var actionBadgeClass = getActionBadgeClass(e.action);
    var time = new Date(e.created_at).toLocaleString();
    var details = e.details ? formatDetails(e.details) : '—';
    var resourceLabel = e.resource ? (e.resource + (e.resource_id ? ' #' + e.resource_id : '')) : '—';
    return '<tr>'
      + '<td class="text-muted text-sm">' + esc(time) + '</td>'
      + '<td>' + esc(e.user_email || '—') + '</td>'
      + '<td><span class="badge ' + actionBadgeClass + '">' + esc(e.action) + '</span></td>'
      + '<td class="text-muted">' + esc(resourceLabel) + '</td>'
      + '<td class="text-sm" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(JSON.stringify(e.details || {})) + '">' + details + '</td>'
      + '<td class="text-muted text-sm">' + esc(e.ip_address || '—') + '</td>'
      + '</tr>';
  }).join('');
}

function getActionBadgeClass(action) {
  if (action.includes('create') || action.includes('login')) return 'badge-success';
  if (action.includes('delete') || action.includes('archive') || action.includes('deactivate')) return 'badge-danger';
  if (action.includes('update') || action.includes('reset')) return 'badge-accent';
  if (action.includes('denied') || action.includes('failed')) return 'badge-danger';
  return 'badge-muted';
}

function formatDetails(details) {
  if (!details || typeof details !== 'object') return esc(String(details));
  var parts = [];
  for (var key in details) {
    if (details.hasOwnProperty(key)) {
      parts.push(esc(key) + ': ' + esc(String(details[key])));
    }
  }
  return parts.join(', ') || '—';
}

// ── Pagination ────────────────────────────────────────────────────

function renderPaginationControls() {
  var container = document.getElementById('paginationContainer');
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  var html = '<div style="display:flex;gap:4px;align-items:center;">';
  html += '<button class="btn btn-ghost btn-sm" ' + (currentPage <= 1 ? 'disabled' : '') + ' onclick="goToPage(' + (currentPage - 1) + ')">&#8592;</button>';
  html += '<span class="text-muted text-sm">Page ' + currentPage + ' of ' + totalPages + ' (' + totalItems + ' events)</span>';
  html += '<button class="btn btn-ghost btn-sm" ' + (currentPage >= totalPages ? 'disabled' : '') + ' onclick="goToPage(' + (currentPage + 1) + ')">&#8594;</button>';
  html += '</div>';
  container.innerHTML = html;
}

function goToPage(page) {
  currentPage = page;
  loadAuditLog();
}

// ── Live Tail ─────────────────────────────────────────────────────

function toggleLiveTail() {
  var btn = document.getElementById('liveTailBtn');
  if (liveTailInterval) {
    clearInterval(liveTailInterval);
    liveTailInterval = null;
    btn.textContent = 'Live Tail: Off';
    btn.classList.remove('btn-success');
    btn.classList.add('btn-outline');
  } else {
    currentPage = 1;
    loadAuditLog();
    liveTailInterval = setInterval(function() { loadAuditLog(); }, 10000);
    btn.textContent = 'Live Tail: On';
    btn.classList.remove('btn-outline');
    btn.classList.add('btn-success');
  }
}

// ── Archive ───────────────────────────────────────────────────────

async function archiveOldEntries() {
  var days = prompt('Delete audit entries older than how many days? (minimum 30)', '90');
  if (!days) return;
  days = parseInt(days);
  if (isNaN(days) || days < 30) {
    showToast('Minimum 30 days', 'error');
    return;
  }
  if (!confirm('Permanently delete audit entries older than ' + days + ' days?')) return;
  try {
    var result = await apiFetch('/admin/audit-log/archive', {
      method: 'DELETE',
      body: JSON.stringify({ olderThanDays: days })
    });
    showToast('Archived ' + result.deleted + ' entries');
    loadAuditLog();
  } catch (err) {
    showToast('Archive failed: ' + err.message, 'error');
  }
}

// ── Stats ─────────────────────────────────────────────────────────

function updateStats() {
  var statsEl = document.getElementById('auditStats');
  if (statsEl) statsEl.textContent = totalItems + ' events';
}

// ── Debounce ──────────────────────────────────────────────────────

function debounce(fn, ms) {
  var timer;
  return function() {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// ── Event Listeners ───────────────────────────────────────────────

document.getElementById('filterAction').addEventListener('change', function() { currentPage = 1; loadAuditLog(); });
document.getElementById('filterFrom').addEventListener('change', function() { currentPage = 1; loadAuditLog(); });
document.getElementById('filterTo').addEventListener('change', function() { currentPage = 1; loadAuditLog(); });
document.getElementById('filterSearch').addEventListener('input', debounce(function() { currentPage = 1; loadAuditLog(); }, 500));
document.getElementById('clearFiltersBtn').addEventListener('click', function() {
  document.getElementById('filterAction').value = '';
  document.getElementById('filterFrom').value = '';
  document.getElementById('filterTo').value = '';
  document.getElementById('filterSearch').value = '';
  currentPage = 1;
  loadAuditLog();
});
document.getElementById('liveTailBtn').addEventListener('click', toggleLiveTail);
document.getElementById('archiveBtn').addEventListener('click', archiveOldEntries);

// ── Init ──────────────────────────────────────────────────────────

onReady(function() {
  if (!requireAuth()) return;
  renderSidebar();
  if (getUserRole && getUserRole() === 'owner') {
    document.getElementById('archiveBtn').style.display = '';
  }
  loadAuditLog();
});
