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
  tbody.innerHTML = auditData.map(function(e, i) {
    var actionBadgeClass = getActionBadgeClass(e.action);
    var time = new Date(e.created_at).toLocaleString();
    var details = e.details ? formatDetails(e.details) : '—';
    var resourceLabel = e.resource ? (e.resource + (e.resource_id ? ' #' + e.resource_id : '')) : '—';
    return '<tr>'
      + '<td class="text-muted text-sm">' + esc(time) + '</td>'
      + '<td>' + esc(e.user_email || '—') + '</td>'
      + '<td><span class="badge ' + actionBadgeClass + '">' + esc(e.action) + '</span></td>'
      + '<td class="text-muted">' + esc(resourceLabel) + '</td>'
      + '<td class="text-sm audit-details-cell" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;" data-details-idx="' + i + '">' + details + '</td>'
      + '<td class="text-muted text-sm" title="' + esc(e.user_agent || '') + '">' + esc(e.ip_address || '—') + '</td>'
      + '</tr>';
  }).join('');
}

// Detail cell click delegation
document.getElementById('auditBody').addEventListener('click', function(e) {
  var cell = e.target.closest('.audit-details-cell');
  if (!cell) return;
  var idx = parseInt(cell.getAttribute('data-details-idx'), 10);
  if (auditData[idx] && auditData[idx].details) {
    showDetailModal(auditData[idx].details);
  }
});

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
    if (!details.hasOwnProperty(key)) continue;
    if (key === 'changes' && typeof details[key] === 'object') {
      var changes = details[key];
      for (var field in changes) {
        if (!changes.hasOwnProperty(field)) continue;
        var c = changes[field];
        parts.push(esc(field) + ': ' + esc(String(c.from ?? '')) + ' → ' + esc(String(c.to ?? '')));
      }
    } else {
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

// ── Live Tail (SSE with polling fallback) ─────────────────────────

var sseSource = null;

function toggleLiveTail() {
  var btn = document.getElementById('liveTailBtn');
  if (liveTailInterval || sseSource) {
    stopLiveTail();
    btn.textContent = 'Live Tail: Off';
    btn.classList.remove('btn-success');
    btn.classList.add('btn-outline');
  } else {
    currentPage = 1;
    loadAuditLog();
    startLiveTail();
    btn.textContent = 'Live Tail: On';
    btn.classList.remove('btn-outline');
    btn.classList.add('btn-success');
  }
}

function startLiveTail() {
  // Try SSE: first obtain a short-lived stream ticket (avoids JWT in URL)
  if (typeof EventSource !== 'undefined') {
    apiFetch('/admin/audit-log/stream-ticket', { method: 'POST' })
      .then(function(data) {
        if (!data.ticket) throw new Error('No ticket');
        sseSource = new EventSource('/api/admin/audit-log/stream?ticket=' + encodeURIComponent(data.ticket));
        sseSource.onmessage = function(event) {
          try {
            var entry = JSON.parse(event.data);
            auditData.unshift(entry);
            if (auditData.length > PAGE_SIZE) auditData.pop();
            totalItems++;
            renderAuditLog();
            renderPaginationControls();
          } catch (e) { /* ignore parse errors */ }
        };
        sseSource.onerror = function() {
          // Fallback to polling on SSE failure
          if (sseSource) { sseSource.close(); sseSource = null; }
          if (!liveTailInterval) {
            liveTailInterval = setInterval(function() { loadAuditLog(); }, 10000);
          }
        };
      })
      .catch(function() {
        // Fallback to polling if ticket fails
        liveTailInterval = setInterval(function() { loadAuditLog(); }, 10000);
      });
    return;
  }
  // Polling fallback
  liveTailInterval = setInterval(function() { loadAuditLog(); }, 10000);
}

function stopLiveTail() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (liveTailInterval) { clearInterval(liveTailInterval); liveTailInterval = null; }
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

// ── Stats Dashboard ───────────────────────────────────────────────

var currentStatsPeriod = '7d';

function updateStats() {
  var statsEl = document.getElementById('auditStats');
  if (statsEl) statsEl.textContent = totalItems + ' events';
  loadStats();
}

async function loadStats() {
  try {
    var result = await apiFetch('/admin/audit-log/stats?period=' + currentStatsPeriod);
    renderStatsCards(result);
    renderChart(result.timeSeries || []);
  } catch (err) {
    // Stats are non-critical
  }
}

function loadStatsWithPeriod(period) {
  currentStatsPeriod = period;
  var btns = document.querySelectorAll('[data-period]');
  btns.forEach(function(b) {
    b.classList.toggle('btn-primary', b.getAttribute('data-period') === period);
    b.classList.toggle('btn-ghost', b.getAttribute('data-period') !== period);
  });
  loadStats();
}

function renderStatsCards(stats) {
  var container = document.getElementById('auditStatsCards');
  if (!container) return;

  var cards = [
    { label: 'Total Events', value: stats.total || 0 },
    { label: 'Today', value: stats.today || 0 },
    { label: 'Top User', value: stats.topUsers && stats.topUsers.length ? stats.topUsers[0].email.split('@')[0] : '—' },
  ];

  container.innerHTML = cards.map(function(c) {
    return '<div class="dash-panel" style="padding:14px;text-align:center;">'
      + '<div class="text-muted text-sm">' + esc(c.label) + '</div>'
      + '<div style="font-size:22px;font-weight:700;color:var(--text,#e2e8f0);margin-top:4px;">' + esc(String(c.value)) + '</div>'
      + '</div>';
  }).join('');
}

function renderChart(timeSeries) {
  var container = document.getElementById('auditChart');
  if (!container || !timeSeries.length) { if (container) container.innerHTML = ''; return; }

  var max = Math.max.apply(null, timeSeries.map(function(d) { return d.count; })) || 1;

  var html = '<div style="display:flex;align-items:end;gap:2px;height:80px;padding:8px 0;">';
  timeSeries.forEach(function(d) {
    var height = Math.max(Math.round((d.count / max) * 70), 2);
    var dayLabel = d.day ? new Date(d.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;" title="' + esc(dayLabel) + ': ' + d.count + ' events">'
      + '<div style="width:100%;max-width:30px;height:' + height + 'px;background:var(--accent,#7c3aed);border-radius:3px 3px 0 0;"></div>'
      + '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

// ── Detail Modal ──────────────────────────────────────────────────

function showDetailModal(details) {
  var modal = document.getElementById('detailModal');
  var content = document.getElementById('detailModalContent');
  if (!modal || !content) return;
  content.textContent = JSON.stringify(details, null, 2);
  modal.style.display = 'flex';
}

function closeDetailModal() {
  var modal = document.getElementById('detailModal');
  if (modal) modal.style.display = 'none';
}

document.addEventListener('click', function(e) {
  var modal = document.getElementById('detailModal');
  if (e.target === modal) closeDetailModal();
});

// ── CSV Export ────────────────────────────────────────────────────

function exportCSV() {
  var params = new URLSearchParams();

  var action = document.getElementById('filterAction').value;
  var from = document.getElementById('filterFrom').value;
  var to = document.getElementById('filterTo').value;
  var search = document.getElementById('filterSearch').value.trim();

  if (action) params.set('action', action);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (search) params.set('search', search);

  var token = getToken();
  fetch('/api/admin/audit-log/export?' + params.toString(), {
    headers: token ? { 'Authorization': 'Bearer ' + token } : {}
  })
    .then(function(res) {
      if (!res.ok) throw new Error('Export failed');
      return res.blob();
    })
    .then(function(blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'audit-log-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(function(err) {
      showToast('Export failed: ' + err.message, 'error');
    });
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
document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
document.getElementById('liveTailBtn').addEventListener('click', toggleLiveTail);
document.getElementById('archiveBtn').addEventListener('click', archiveOldEntries);

// ── Init ──────────────────────────────────────────────────────────

// ── Alerts ────────────────────────────────────────────────────────

async function loadAlerts() {
  try {
    var result = await apiFetch('/admin/audit-log/alerts');
    var banner = document.getElementById('auditAlertBanner');
    if (!banner) return;
    if (!result.alerts || result.alerts.length === 0) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'block';
    banner.innerHTML = result.alerts.map(function(a) {
      var color = a.severity === 'critical' ? '#ef4444' : a.severity === 'warning' ? '#f59e0b' : '#3b82f6';
      return '<div style="background:' + color + '22;border:1px solid ' + color + ';border-radius:8px;padding:10px 16px;margin-bottom:8px;color:var(--text,#e2e8f0);font-size:13px;">'
        + '<strong style="color:' + color + ';">' + esc(a.type.replace(/-/g, ' ').toUpperCase()) + '</strong>: '
        + esc(a.message)
        + '</div>';
    }).join('');
  } catch (err) {
    // Non-critical
  }
}

// ── Init ──────────────────────────────────────────────────────────

onReady(function() {
  if (!requireAuth()) return;
  renderSidebar();
  if (getUserRole && getUserRole() === 'owner') {
    document.getElementById('archiveBtn').style.display = '';
  }
  loadAuditLog();
  loadAlerts();
});
