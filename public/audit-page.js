/* Deep Feed AI Admin — Logs page (replaces old audit-only page) */

var currentTab = 'overview';
var overviewRange = '24h';
var aiOpsRange = '7d';

// Page states
var appLogPage = 1, reqPage = 1, errPage = 1, auditPage = 1;
var PAGE_SIZE = 50;

// Charts
var reqVolumeChart = null, errRateChart = null, reqDistChart = null, cronDurationChart = null, aiLatencyChart = null;

// SSE
var appLiveTailSource = null, auditSseSource = null;
var healthTimer = null;

// Audit data (for detail modal)
var auditData = [];

var CHART_COLORS = ['#00d9ff', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#f59e0b'];

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function debounce(fn, ms) { var t; return function() { clearTimeout(t); t = setTimeout(fn, ms); }; }

// ── Tabs ─────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.log-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.log-tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      switchTab(btn.getAttribute('data-tab'));
    });
  });
}

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.log-section').forEach(function(el) { el.classList.remove('active'); });
  var section = document.getElementById(name + 'Section');
  if (section) section.classList.add('active');

  // Clear health timer
  if (name !== 'health' && healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
  // Close app live tail
  if (name !== 'app-logs' && appLiveTailSource) { appLiveTailSource.close(); appLiveTailSource = null; }
  // Close audit SSE
  if (name !== 'audit' && auditSseSource) { auditSseSource.close(); auditSseSource = null; }

  if (name === 'overview') loadOverview();
  else if (name === 'app-logs') loadAppLogs();
  else if (name === 'requests') loadRequests();
  else if (name === 'errors') loadErrors();
  else if (name === 'audit') loadAuditLog();
  else if (name === 'cron') loadCron();
  else if (name === 'ai-ops') loadAiOps();
  else if (name === 'health') loadHealth();
}

// ── Range buttons ────────────────────────────────────────
function renderRange(containerId, options, active, onChange) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = options.map(function(o) {
    return '<button class="range-btn' + (o === active ? ' active' : '') + '" data-r="' + o + '">' + o + '</button>';
  }).join('');
  container.querySelectorAll('.range-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      container.querySelectorAll('.range-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      onChange(btn.getAttribute('data-r'));
    });
  });
}

// ── Chart helper ─────────────────────────────────────────
function makeChart(canvasId, config) {
  var canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return null;
  var defaults = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#888', font: { size: 11 } } }, tooltip: { backgroundColor: '#222', titleColor: '#f0f0f0', bodyColor: '#ccc' } },
  };
  if (!config.type || config.type === 'line' || config.type === 'bar') {
    var sd = { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#888', font: { size: 11 } } };
    config.options = config.options || {};
    config.options.scales = config.options.scales || {};
    config.options.scales.x = Object.assign({}, sd, config.options.scales.x || {});
    config.options.scales.y = Object.assign({}, sd, config.options.scales.y || {});
  }
  config.options = Object.assign({}, defaults, config.options || {}, { plugins: Object.assign({}, defaults.plugins, (config.options || {}).plugins || {}) });
  return new Chart(canvas, config);
}

function fmtChartTime(t, range) {
  var d = new Date(t);
  if (range === '1h' || range === '6h' || range === '24h') return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// ── Pagination helper ────────────────────────────────────
function renderPag(containerId, page, pages, total, onChange) {
  var el = document.getElementById(containerId);
  if (!el) return;
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = '<div style="display:flex;gap:4px;align-items:center;">'
    + '<button class="btn btn-ghost btn-sm" ' + (page <= 1 ? 'disabled' : '') + ' data-p="' + (page - 1) + '">&#8592;</button>'
    + '<span class="text-muted text-sm">Page ' + page + ' of ' + pages + ' (' + total + ')</span>'
    + '<button class="btn btn-ghost btn-sm" ' + (page >= pages ? 'disabled' : '') + ' data-p="' + (page + 1) + '">&#8594;</button>'
    + '</div>';
  el.querySelectorAll('[data-p]').forEach(function(btn) {
    btn.addEventListener('click', function() { onChange(parseInt(btn.getAttribute('data-p'))); });
  });
}

// ── Export helper ─────────────────────────────────────────
function exportCSV(endpoint) {
  var token = getToken();
  fetch('/api/admin/logs/' + endpoint, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
    .then(function(r) { if (!r.ok) throw new Error('Export failed'); return r.blob(); })
    .then(function(blob) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'logs-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(function(err) { showToast('Export failed: ' + err.message, 'error'); });
}

// ── Overview ─────────────────────────────────────────────
async function loadOverview() {
  try {
    var data = await apiFetch('/admin/logs/overview?range=' + overviewRange);

    document.getElementById('overviewStats').innerHTML =
      statBox('Errors', data.error_count, data.error_count > 0 ? 'color:#f87171' : '') +
      statBox('Requests', data.request_volume) +
      statBox('Avg Response', data.avg_response_ms + 'ms') +
      statBox('Cron Active', data.cron_active) +
      statBox('AI Success', data.ai_success_rate + '%');

    if (reqVolumeChart) reqVolumeChart.destroy();
    reqVolumeChart = makeChart('reqVolumeChart', {
      type: 'line',
      data: { labels: data.request_chart.map(function(r) { return fmtChartTime(r.time, overviewRange); }),
        datasets: [{ label: 'Requests', data: data.request_chart.map(function(r) { return r.count; }), borderColor: CHART_COLORS[0], backgroundColor: 'rgba(0,217,255,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
      options: { plugins: { legend: { display: false } } }
    });

    if (errRateChart) errRateChart.destroy();
    errRateChart = makeChart('errRateChart', {
      type: 'line',
      data: { labels: data.error_chart.map(function(r) { return fmtChartTime(r.time, overviewRange); }),
        datasets: [{ label: 'Errors', data: data.error_chart.map(function(r) { return r.count; }), borderColor: CHART_COLORS[3], backgroundColor: 'rgba(248,113,113,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
      options: { plugins: { legend: { display: false } } }
    });

    // Alerts
    var alertData = await apiFetch('/admin/logs/alerts');
    var alertEl = document.getElementById('overviewAlerts');
    if (alertData.alerts && alertData.alerts.length > 0) {
      alertEl.innerHTML = alertData.alerts.map(function(a) {
        var cls = a.severity === 'critical' ? 'alert-critical' : a.severity === 'warning' ? 'alert-warning' : 'alert-info';
        return '<div class="alert-banner ' + cls + '">' + esc(a.message) + '</div>';
      }).join('');
    } else { alertEl.innerHTML = ''; }
  } catch (err) { showToast(err.message, 'error'); }
}

function statBox(label, value, style) {
  return '<div class="stat-box"><div class="stat-label">' + esc(label) + '</div><div class="stat-value"' + (style ? ' style="' + style + '"' : '') + '>' + esc(String(value)) + '</div></div>';
}

// ── App Logs ─────────────────────────────────────────────
async function loadAppLogs() {
  try {
    var params = new URLSearchParams({ page: appLogPage, limit: PAGE_SIZE });
    var level = document.getElementById('logLevel').value;
    var mod = document.getElementById('logModule').value;
    var search = document.getElementById('logSearch').value;
    if (level) params.set('level', level);
    if (mod) params.set('module', mod);
    if (search) params.set('search', search);

    var data = await apiFetch('/admin/logs/app?' + params);
    var tbody = document.getElementById('appLogBody');

    tbody.innerHTML = data.items.length > 0
      ? data.items.map(function(row) {
        var hasDetail = row.context || row.error_stack;
        return '<tr class="log-row" data-id="' + row.id + '">'
          + '<td class="text-muted text-sm">' + (relativeTime ? relativeTime(row.created_at) : esc(new Date(row.created_at).toLocaleString())) + '</td>'
          + '<td><span class="lvl-badge lvl-' + row.level + '">' + row.level + '</span></td>'
          + '<td class="text-sm">' + esc(row.module || '') + '</td>'
          + '<td class="text-sm" style="font-family:monospace;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc((row.message || '').slice(0, 200)) + '</td>'
          + '<td class="text-muted text-xs" style="font-family:monospace;">' + esc((row.correlation_id || '').slice(0, 8)) + '</td>'
          + '</tr>'
          + (hasDetail ? '<tr class="log-detail" style="display:none;"><td colspan="5"><pre class="log-pre">' + esc(row.error_stack || '') + (row.context ? '\n' + JSON.stringify(row.context, null, 2) : '') + '</pre></td></tr>' : '');
      }).join('')
      : '<tr><td colspan="5"><div class="empty-state">No logs found</div></td></tr>';

    tbody.querySelectorAll('.log-row').forEach(function(tr) {
      tr.addEventListener('click', function() {
        var next = tr.nextElementSibling;
        if (next && next.classList.contains('log-detail')) next.style.display = next.style.display === 'none' ? '' : 'none';
      });
    });

    renderPag('appLogPagination', data.page, data.pages, data.total, function(p) { appLogPage = p; loadAppLogs(); });
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadAppModules() {
  try {
    var data = await apiFetch('/admin/logs/app/modules');
    var sel = document.getElementById('logModule');
    if (sel && data.modules) {
      sel.innerHTML = '<option value="">All Modules</option>' + data.modules.map(function(m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('');
    }
  } catch (e) { /* non-fatal */ }
}

function toggleAppLiveTail() {
  var btn = document.getElementById('appLiveTailBtn');
  var feed = document.getElementById('appLiveFeed');
  if (appLiveTailSource) {
    appLiveTailSource.close(); appLiveTailSource = null;
    btn.textContent = 'Live Tail'; btn.classList.remove('btn-live-active'); btn.classList.add('btn-outline');
    feed.style.display = 'none'; return;
  }
  apiFetch('/admin/logs/app/stream-ticket', { method: 'POST' }).then(function(data) {
    appLiveTailSource = new EventSource('/api/admin/logs/app/stream?ticket=' + data.ticket);
    btn.textContent = 'Stop Tail'; btn.classList.add('btn-live-active'); btn.classList.remove('btn-outline');
    feed.style.display = ''; feed.innerHTML = '<div class="live-entry text-muted">Connected...</div>';
    appLiveTailSource.onmessage = function(e) {
      try {
        var entry = JSON.parse(e.data);
        var html = '<div class="live-entry"><span class="text-xs" style="font-family:monospace;">' + new Date(entry.timestamp).toLocaleTimeString() + '</span>'
          + '<span class="lvl-badge lvl-' + entry.level + '">' + entry.level + '</span>'
          + '<span class="text-sm">' + esc(entry.module || '') + '</span>'
          + '<span class="text-sm">' + esc(entry.message) + '</span></div>';
        feed.insertAdjacentHTML('afterbegin', html);
        while (feed.children.length > 100) feed.lastElementChild.remove();
      } catch (ex) { /* ignore */ }
    };
    appLiveTailSource.onerror = function() {
      appLiveTailSource.close(); appLiveTailSource = null;
      btn.textContent = 'Live Tail'; btn.classList.remove('btn-live-active'); btn.classList.add('btn-outline');
    };
  }).catch(function(err) { showToast(err.message, 'error'); });
}

// ── Requests ─────────────────────────────────────────────
async function loadRequests() {
  try {
    var params = new URLSearchParams({ page: reqPage, limit: PAGE_SIZE });
    var method = document.getElementById('reqMethod').value;
    var statusF = document.getElementById('reqStatus').value;
    var pathF = document.getElementById('reqPath').value;
    if (method) params.set('method', method);
    if (pathF) params.set('path', pathF);
    if (statusF) { params.set('status_min', statusF + '00'); params.set('status_max', statusF + '99'); }

    var data = await apiFetch('/admin/logs/requests?' + params);
    var dist = await apiFetch('/admin/logs/requests/distribution?range=24h');

    document.getElementById('reqStats').innerHTML =
      statBox('Total', data.total) + statBox('Avg Duration', data.stats.avg_duration + 'ms') +
      statBox('4xx', data.stats.count_4xx, data.stats.count_4xx > 0 ? 'color:#fbbf24' : '') +
      statBox('5xx', data.stats.count_5xx, data.stats.count_5xx > 0 ? 'color:#f87171' : '');

    if (reqDistChart) reqDistChart.destroy();
    if (dist.buckets && dist.buckets.length) {
      reqDistChart = makeChart('reqDistChart', {
        type: 'bar',
        data: { labels: dist.buckets.map(function(b) { return b.label; }), datasets: [{ label: 'Requests', data: dist.buckets.map(function(b) { return b.count; }), backgroundColor: CHART_COLORS.slice(0, dist.buckets.length) }] },
        options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
      });
    }

    var tbody = document.getElementById('reqBody');
    tbody.innerHTML = data.items.length > 0
      ? data.items.map(function(r) {
        var sc = parseInt(r.status_code); var scCls = sc >= 500 ? 's-5xx' : sc >= 400 ? 's-4xx' : sc >= 300 ? 's-3xx' : 's-2xx';
        return '<tr><td class="text-muted text-sm">' + (relativeTime ? relativeTime(r.created_at) : esc(new Date(r.created_at).toLocaleString())) + '</td>'
          + '<td><span class="method-badge m-' + r.method + '">' + r.method + '</span></td>'
          + '<td class="text-sm" style="font-family:monospace;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(r.path) + '">' + esc(r.path) + '</td>'
          + '<td><span class="status-badge ' + scCls + '">' + r.status_code + '</span></td>'
          + '<td class="text-sm">' + (r.duration_ms != null ? r.duration_ms + 'ms' : '—') + '</td>'
          + '<td class="text-muted text-sm" style="font-family:monospace;">' + esc(r.ip_address || '') + '</td></tr>';
      }).join('')
      : '<tr><td colspan="6"><div class="empty-state">No requests found</div></td></tr>';

    renderPag('reqPagination', data.page, data.pages, data.total, function(p) { reqPage = p; loadRequests(); });
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Errors ───────────────────────────────────────────────
async function loadErrors() {
  try {
    var params = new URLSearchParams({ page: errPage, limit: PAGE_SIZE });
    var st = document.getElementById('errStatus').value;
    var search = document.getElementById('errSearch').value;
    if (st) params.set('status', st);
    if (search) params.set('search', search);

    var data = await apiFetch('/admin/logs/errors?' + params);
    var tbody = document.getElementById('errBody');

    tbody.innerHTML = data.items.length > 0
      ? data.items.map(function(row) {
        var sCls = 'err-' + (row.status || 'open');
        return '<tr class="log-row" data-eid="' + row.id + '">'
          + '<td class="text-sm" style="font-family:monospace;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(row.message) + '">' + esc((row.message || '').slice(0, 120)) + '</td>'
          + '<td class="text-sm">' + esc(row.module || '') + '</td>'
          + '<td><strong>' + (row.count || 0) + '</strong></td>'
          + '<td class="text-muted text-sm">' + (relativeTime ? relativeTime(row.last_seen) : '') + '</td>'
          + '<td><span class="err-status ' + sCls + '">' + esc(row.status) + '</span></td>'
          + '<td>'
          + (row.status === 'open' ? '<button class="btn btn-ghost btn-sm" onclick="updateErrStatus(' + row.id + ',\'resolved\')">Resolve</button> ' : '')
          + (row.status !== 'open' ? '<button class="btn btn-ghost btn-sm" onclick="updateErrStatus(' + row.id + ',\'open\')">Reopen</button>' : '')
          + '</td></tr>'
          + (row.stack_sample ? '<tr class="log-detail" style="display:none"><td colspan="6"><pre class="log-pre">' + esc(row.stack_sample) + '</pre></td></tr>' : '');
      }).join('')
      : '<tr><td colspan="6"><div class="empty-state">No errors found</div></td></tr>';

    tbody.querySelectorAll('.log-row').forEach(function(tr) {
      tr.addEventListener('click', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        var next = tr.nextElementSibling;
        if (next && next.classList.contains('log-detail')) next.style.display = next.style.display === 'none' ? '' : 'none';
      });
    });

    renderPag('errPagination', data.page, data.pages, data.total, function(p) { errPage = p; loadErrors(); });
  } catch (err) { showToast(err.message, 'error'); }
}

window.updateErrStatus = async function(id, status) {
  try {
    await apiFetch('/admin/logs/errors/' + id + '/status', { method: 'PUT', body: JSON.stringify({ status: status }) });
    showToast('Error marked as ' + status);
    loadErrors();
  } catch (err) { showToast(err.message, 'error'); }
};

// ── Audit Trail (preserved logic) ────────────────────────
async function loadAuditLog() {
  try {
    var params = new URLSearchParams({ page: auditPage, limit: PAGE_SIZE });
    var action = document.getElementById('filterAction').value;
    var from = document.getElementById('auditFrom').value;
    var to = document.getElementById('auditTo').value;
    var search = document.getElementById('auditSearch').value.trim();
    if (action) params.set('action', action);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (search) params.set('search', search);

    var result = await apiFetch('/admin/audit-log?' + params);
    auditData = result.items;

    var tbody = document.getElementById('auditBody');
    tbody.innerHTML = auditData.length > 0
      ? auditData.map(function(e, i) {
        var bc = getActionBadgeClass(e.action);
        var resLabel = e.resource ? (e.resource + (e.resource_id ? ' #' + e.resource_id : '')) : '—';
        return '<tr><td class="text-muted text-sm">' + esc(new Date(e.created_at).toLocaleString()) + '</td>'
          + '<td>' + esc(e.user_email || '—') + '</td>'
          + '<td><span class="badge ' + bc + '">' + esc(e.action) + '</span></td>'
          + '<td class="text-muted">' + esc(resLabel) + '</td>'
          + '<td class="text-sm audit-details-cell" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;" data-idx="' + i + '">' + formatDetails(e.details) + '</td>'
          + '<td class="text-muted text-sm">' + esc(e.ip_address || '—') + '</td></tr>';
      }).join('')
      : '<tr><td colspan="6"><div class="empty-state">No audit events</div></td></tr>';

    renderPag('auditPagination', result.page, result.pages, result.total, function(p) { auditPage = p; loadAuditLog(); });

    // Stats
    var stats = await apiFetch('/admin/audit-log/stats?period=7d');
    document.getElementById('auditStatsCards').innerHTML =
      statBox('Total', stats.total || 0) + statBox('Today', stats.today || 0) +
      statBox('Top User', stats.topUsers && stats.topUsers.length ? stats.topUsers[0].email.split('@')[0] : '—');

    // Alerts
    var alerts = await apiFetch('/admin/audit-log/alerts');
    var banner = document.getElementById('auditAlertBanner');
    if (alerts.alerts && alerts.alerts.length > 0) {
      banner.style.display = 'block';
      banner.innerHTML = alerts.alerts.map(function(a) {
        var cls = a.severity === 'critical' ? 'alert-critical' : a.severity === 'warning' ? 'alert-warning' : 'alert-info';
        return '<div class="alert-banner ' + cls + '"><strong>' + esc(a.type) + '</strong>: ' + esc(a.message) + '</div>';
      }).join('');
    } else { banner.style.display = 'none'; }
  } catch (err) { showToast(err.message, 'error'); }
}

function getActionBadgeClass(action) {
  if (action.includes('create') || action.includes('login')) return 'badge-success';
  if (action.includes('delete') || action.includes('archive') || action.includes('deactivate')) return 'badge-danger';
  if (action.includes('update') || action.includes('reset')) return 'badge-accent';
  if (action.includes('denied') || action.includes('failed')) return 'badge-danger';
  return 'badge-muted';
}

function formatDetails(details) {
  if (!details || typeof details !== 'object') return esc(String(details || '—'));
  var parts = [];
  for (var key in details) {
    if (!details.hasOwnProperty(key)) continue;
    if (key === 'changes' && typeof details[key] === 'object') {
      for (var f in details[key]) { var c = details[key][f]; parts.push(esc(f) + ': ' + esc(String(c.from ?? '')) + ' → ' + esc(String(c.to ?? ''))); }
    } else { parts.push(esc(key) + ': ' + esc(String(details[key]))); }
  }
  return parts.join(', ') || '—';
}

// Audit detail modal (click delegation)
document.getElementById('auditBody').addEventListener('click', function(e) {
  var cell = e.target.closest('.audit-details-cell');
  if (!cell) return;
  var idx = parseInt(cell.getAttribute('data-idx'), 10);
  if (auditData[idx] && auditData[idx].details) showDetailModal(auditData[idx].details);
});

function showDetailModal(obj) {
  var modal = document.getElementById('detailModal');
  document.getElementById('detailModalContent').textContent = JSON.stringify(obj, null, 2);
  modal.style.display = 'flex';
}
function closeDetailModal() { document.getElementById('detailModal').style.display = 'none'; }
document.addEventListener('click', function(e) { if (e.target === document.getElementById('detailModal')) closeDetailModal(); });

// Audit live tail
function toggleAuditLiveTail() {
  var btn = document.getElementById('auditLiveTailBtn');
  if (auditSseSource) {
    auditSseSource.close(); auditSseSource = null;
    btn.textContent = 'Live Tail: Off'; btn.classList.remove('btn-live-active'); btn.classList.add('btn-outline'); return;
  }
  apiFetch('/admin/audit-log/stream-ticket', { method: 'POST' }).then(function(data) {
    auditSseSource = new EventSource('/api/admin/audit-log/stream?ticket=' + data.ticket);
    btn.textContent = 'Live Tail: On'; btn.classList.add('btn-live-active'); btn.classList.remove('btn-outline');
    auditSseSource.onmessage = function(ev) {
      try { var entry = JSON.parse(ev.data); auditData.unshift(entry); if (auditData.length > PAGE_SIZE) auditData.pop(); loadAuditLog(); } catch (ex) {}
    };
    auditSseSource.onerror = function() { auditSseSource.close(); auditSseSource = null; btn.textContent = 'Live Tail: Off'; btn.classList.remove('btn-live-active'); btn.classList.add('btn-outline'); };
  }).catch(function() {});
}

// Audit archive
async function archiveAudit() {
  var days = prompt('Delete audit entries older than how many days? (min 30)', '90');
  if (!days) return; days = parseInt(days);
  if (isNaN(days) || days < 30) { showToast('Minimum 30 days', 'error'); return; }
  if (!confirm('Permanently delete entries older than ' + days + ' days?')) return;
  try {
    var r = await apiFetch('/admin/audit-log/archive', { method: 'DELETE', body: JSON.stringify({ olderThanDays: days }) });
    showToast('Archived ' + r.deleted + ' entries'); loadAuditLog();
  } catch (err) { showToast(err.message, 'error'); }
}

// Audit CSV export
function exportAuditCSV() {
  var params = new URLSearchParams();
  var action = document.getElementById('filterAction').value;
  var from = document.getElementById('auditFrom').value;
  var to = document.getElementById('auditTo').value;
  var search = document.getElementById('auditSearch').value.trim();
  if (action) params.set('action', action); if (from) params.set('from', from);
  if (to) params.set('to', to); if (search) params.set('search', search);
  var token = getToken();
  fetch('/api/admin/audit-log/export?' + params, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
    .then(function(r) { if (!r.ok) throw new Error('Failed'); return r.blob(); })
    .then(function(blob) { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'audit-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click(); })
    .catch(function(err) { showToast(err.message, 'error'); });
}

// ── Cron ─────────────────────────────────────────────────
async function loadCron() {
  try {
    var timeline = await apiFetch('/admin/logs/cron/timeline?range=24h');
    var duration = await apiFetch('/admin/logs/cron/duration-trends?range=7d');

    var totalRuns = 0, failed = 0, totalMs = 0, durCount = 0;
    timeline.jobs.forEach(function(j) { j.runs.forEach(function(r) {
      totalRuns++; if (r.status === 'error') failed++;
      if (r.start && r.end) { totalMs += new Date(r.end) - new Date(r.start); durCount++; }
    }); });
    var successRate = totalRuns > 0 ? Math.round((totalRuns - failed) / totalRuns * 100) : 100;

    document.getElementById('cronStats').innerHTML =
      statBox('Success Rate', successRate + '%', successRate < 90 ? 'color:#f87171' : '') +
      statBox('Avg Duration', (durCount > 0 ? Math.round(totalMs / durCount) : 0) + 'ms') +
      statBox('Failed (24h)', failed, failed > 0 ? 'color:#f87171' : '');

    // Timeline
    var sc = { success: '#4ade80', error: '#f87171', running: '#fbbf24', crashed: '#a78bfa' };
    var now = Date.now(), r24 = 86400000, s24 = now - r24;
    document.getElementById('cronTimeline').innerHTML = timeline.jobs.length > 0
      ? timeline.jobs.map(function(j) {
        var bars = j.runs.map(function(r) {
          var s = Math.max(0, (new Date(r.start) - s24) / r24 * 100);
          var e = r.end ? Math.min(100, (new Date(r.end) - s24) / r24 * 100) : s + 0.5;
          return '<div class="tl-bar" style="left:' + s + '%;width:' + Math.max(0.3, e - s) + '%;background:' + (sc[r.status] || '#555') + '" title="' + r.status + '"></div>';
        }).join('');
        return '<div class="tl-row"><span class="tl-label">' + esc(j.name) + '</span><div class="tl-track">' + bars + '</div></div>';
      }).join('')
      : '<div class="text-muted">No runs in last 24h</div>';

    // Duration chart
    if (cronDurationChart) cronDurationChart.destroy();
    if (duration.jobs && duration.jobs.length) {
      var allDays = []; duration.jobs.forEach(function(j) { j.data.forEach(function(d) { if (allDays.indexOf(d.day) === -1) allDays.push(d.day); }); }); allDays.sort();
      cronDurationChart = makeChart('cronDurationChart', {
        type: 'line',
        data: { labels: allDays.map(function(d) { return new Date(d).toLocaleDateString('en', { month: 'short', day: 'numeric' }); }),
          datasets: duration.jobs.map(function(j, i) { return { label: j.name, data: j.data.map(function(d) { return d.avg_ms; }), borderColor: CHART_COLORS[i % CHART_COLORS.length], tension: 0.3, pointRadius: 2 }; }) },
        options: { scales: { y: { beginAtZero: true } } }
      });
    }
  } catch (err) { showToast(err.message, 'error'); }
}

// ── AI Ops ───────────────────────────────────────────────
async function loadAiOps() {
  try {
    var latency = await apiFetch('/admin/logs/ai/latency?range=' + aiOpsRange);
    var errors = await apiFetch('/admin/logs/ai/error-patterns');

    if (aiLatencyChart) aiLatencyChart.destroy();
    if (latency.data && latency.data.length) {
      aiLatencyChart = makeChart('aiLatencyChart', {
        type: 'line',
        data: { labels: latency.data.map(function(d) { return new Date(d.day).toLocaleDateString('en', { month: 'short', day: 'numeric' }); }),
          datasets: [
            { label: 'p50', data: latency.data.map(function(d) { return d.p50; }), borderColor: CHART_COLORS[1], tension: 0.3, pointRadius: 2 },
            { label: 'p90', data: latency.data.map(function(d) { return d.p90; }), borderColor: CHART_COLORS[2], tension: 0.3, pointRadius: 2 },
            { label: 'p99', data: latency.data.map(function(d) { return d.p99; }), borderColor: CHART_COLORS[3], tension: 0.3, pointRadius: 2 },
          ] },
        options: { scales: { y: { beginAtZero: true } } }
      });
    }

    document.getElementById('aiErrorBody').innerHTML = errors.patterns && errors.patterns.length > 0
      ? errors.patterns.map(function(r) {
        return '<tr><td class="text-sm" style="font-family:monospace;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(r.message) + '">' + esc((r.message || '').slice(0, 120)) + '</td>'
          + '<td><strong>' + r.count + '</strong></td>'
          + '<td class="text-sm">' + (r.operations || []).map(function(o) { return '<span class="badge badge-muted">' + esc(o) + '</span>'; }).join(' ') + '</td>'
          + '<td class="text-muted text-sm">' + (relativeTime ? relativeTime(r.last_seen) : '') + '</td></tr>';
      }).join('')
      : '<tr><td colspan="4"><div class="empty-state">No AI errors</div></td></tr>';
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Health ───────────────────────────────────────────────
async function loadHealth() {
  try {
    var health = await apiFetch('/admin/logs/health');
    var alerts = await apiFetch('/admin/logs/alerts');

    var upSec = health.uptime_seconds || 0;
    var upStr = upSec < 3600 ? Math.floor(upSec / 60) + 'm' : Math.floor(upSec / 3600) + 'h ' + Math.floor((upSec % 3600) / 60) + 'm';
    document.getElementById('healthUptime').innerHTML = statBox('Uptime', upStr) + statBox('Version', health.server_version || '—');

    var checks = health.checks?.checks || health.checks || [];
    if (Array.isArray(checks)) {
      document.getElementById('healthGrid').innerHTML = checks.map(function(c) {
        var dotCls = c.status === 'ok' ? 'dot-ok' : c.status === 'warn' ? 'dot-warn' : c.status === 'error' ? 'dot-error' : 'dot-none';
        return '<div class="health-card"><div><span class="health-dot ' + dotCls + '"></span><strong>' + esc(c.label) + '</strong></div>'
          + '<div class="text-muted text-sm" style="margin-top:6px;">' + esc(c.detail || '') + '</div></div>';
      }).join('');
    }

    var alertEl = document.getElementById('healthAlerts');
    if (alerts.alerts && alerts.alerts.length > 0) {
      alertEl.innerHTML = alerts.alerts.map(function(a) {
        var cls = a.severity === 'critical' ? 'alert-critical' : a.severity === 'warning' ? 'alert-warning' : 'alert-info';
        return '<div class="alert-banner ' + cls + '">' + esc(a.message) + '</div>';
      }).join('');
    } else { alertEl.innerHTML = '<div class="alert-banner alert-info">No active alerts</div>'; }

    if (healthTimer) clearTimeout(healthTimer);
    if (currentTab === 'health') healthTimer = setTimeout(loadHealth, 30000);
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Init ─────────────────────────────────────────────────
onReady(function() {
  if (!requireAuth()) return;
  renderSidebar();
  initTabs();

  // Range buttons
  renderRange('overviewRange', ['1h', '6h', '24h', '7d'], overviewRange, function(r) { overviewRange = r; loadOverview(); });
  renderRange('aiOpsRange', ['7d', '30d', '90d'], aiOpsRange, function(r) { aiOpsRange = r; loadAiOps(); });

  // Show archive button for owners
  if (typeof getUserRole === 'function' && getUserRole() === 'owner') {
    var archBtn = document.getElementById('archiveBtn');
    if (archBtn) archBtn.style.display = '';
  }

  // Load initial tab
  loadOverview();
  loadAppModules();
  window.pageRefresh = function () {
    var tabFns = { overview: loadOverview, logs: loadAppLogs, requests: loadRequests, errors: loadErrors, audit: loadAuditLog, cron: loadCron, aiops: loadAiOps, health: loadHealth };
    return (tabFns[currentTab] || loadOverview)();
  };

  // Filter listeners
  var dAppLogs = debounce(function() { appLogPage = 1; loadAppLogs(); }, 400);
  var dReqs = debounce(function() { reqPage = 1; loadRequests(); }, 400);
  var dErrs = debounce(function() { errPage = 1; loadErrors(); }, 400);
  var dAudit = debounce(function() { auditPage = 1; loadAuditLog(); }, 400);

  document.getElementById('logLevel').addEventListener('change', dAppLogs);
  document.getElementById('logModule').addEventListener('change', dAppLogs);
  document.getElementById('logSearch').addEventListener('input', dAppLogs);

  document.getElementById('reqMethod').addEventListener('change', dReqs);
  document.getElementById('reqStatus').addEventListener('change', dReqs);
  document.getElementById('reqPath').addEventListener('input', dReqs);

  document.getElementById('errStatus').addEventListener('change', dErrs);
  document.getElementById('errSearch').addEventListener('input', dErrs);

  document.getElementById('filterAction').addEventListener('change', dAudit);
  document.getElementById('auditFrom').addEventListener('change', dAudit);
  document.getElementById('auditTo').addEventListener('change', dAudit);
  document.getElementById('auditSearch').addEventListener('input', dAudit);

  // Buttons
  document.getElementById('appLiveTailBtn').addEventListener('click', toggleAppLiveTail);
  document.getElementById('appExportBtn').addEventListener('click', function() { exportCSV('app/export'); });
  document.getElementById('reqExportBtn').addEventListener('click', function() { exportCSV('requests/export'); });
  document.getElementById('errExportBtn').addEventListener('click', function() { exportCSV('errors/export'); });
  document.getElementById('auditExportBtn').addEventListener('click', exportAuditCSV);
  document.getElementById('auditLiveTailBtn').addEventListener('click', toggleAuditLiveTail);
  document.getElementById('archiveBtn').addEventListener('click', archiveAudit);
});
