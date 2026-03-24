/* ===== DeepFeedAI Admin — Comments Page ===== */

let allComments  = [];
let queueItems   = [];
let activeFilter = 'all';
let slugFilter   = '';
let cmtPage      = 1;
let cmtPageSize  = 25;
let selectedCmtIds = new Set();
let expandedCmtId  = null;

onReady(async () => {
  if (!requireAuth()) return;
  renderSidebar();

  if (!hasPermission('comments.moderate')) {
    var bulkToolbar = document.getElementById('cmtBulkToolbar');
    if (bulkToolbar) bulkToolbar.style.display = 'none';
  }

  const user = localStorage.getItem('deepfeedai_user');
  if (user) document.getElementById('topbarUser').textContent = `👤 ${user}`;

  // Auto-activate filter from URL param
  const urlFilter = new URLSearchParams(window.location.search).get('filter');
  const urlTab    = new URLSearchParams(window.location.search).get('tab');
  if (urlFilter === 'reported') activeFilter = 'reported';
  if (urlTab    === 'queue')    activeFilter = 'queue';

  await Promise.all([loadComments(), loadQueue()]);
  initFilters();

  // Sync filter tab UI after load
  if (activeFilter !== 'all') {
    document.querySelectorAll('.filter-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === activeFilter);
    });
  }
});

/* ── Load all comments ────────────────────────────────────────────── */
async function loadComments() {
  const tbody = document.getElementById('commentsBody');
  if (tbody && activeFilter !== 'queue') {
    tbody.innerHTML = skeletonRows(['sk-w-md','sk-w-full','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm'], 5);
  }
  try {
    const data = await apiFetch('/comments/admin');
    allComments = data.comments || [];
    renderStats();
    if (activeFilter !== 'queue') renderTable();
  } catch (err) {
    showAlert('Failed to load comments: ' + err.message, 'error');
  }
}

/* ── Load moderation queue ────────────────────────────────────────── */
async function loadQueue() {
  try {
    const data = await apiFetch('/comments/admin/queue');
    queueItems = data.queue || [];
    updateQueueBadge();
    if (activeFilter === 'queue') renderTable();
  } catch (err) {
    console.warn('Queue load failed:', err.message);
  }
}

function updateQueueBadge() {
  const badge = document.getElementById('queueBadge');
  if (!badge) return;
  if (queueItems.length > 0) {
    badge.textContent = queueItems.length;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}

/* ── Stats ────────────────────────────────────────────────────────── */
function renderStats() {
  const active   = allComments.filter(c => !c.isDeleted);
  const deleted  = allComments.filter(c => c.isDeleted);
  const flagged  = active.filter(c => c.reportCount > 0);
  const userIds  = new Set(active.filter(c => c.user).map(c => c.user.id));

  document.getElementById('statTotal').textContent   = active.length;
  document.getElementById('statFlagged').textContent = flagged.length;
  document.getElementById('statUsers').textContent   = userIds.size;
  document.getElementById('statDeleted').textContent = deleted.length;

  if (flagged.length > 0) {
    document.getElementById('statFlaggedCard').classList.add('stat-card-warn');
  }
}

/* ── Table rendering ──────────────────────────────────────────────── */
function renderTable() {
  const tbody = document.getElementById('commentsBody');

  // Queue tab: show pending comments with approve/reject actions
  if (activeFilter === 'queue') {
    renderQueueTable(tbody);
    return;
  }

  // Include hidden comments in the list (all = visible + hidden, reported = reported only)
  let filtered = activeFilter === 'reported'
    ? allComments.filter(c => !c.isDeleted && c.reportCount > 0)
    : allComments; // show everything including hidden

  if (slugFilter) {
    filtered = filtered.filter(c =>
      (c.articleSlug || '').toLowerCase().includes(slugFilter)
    );
  }

  filtered.sort((a, b) => {
    // Hidden to bottom, then by report count desc, then newest first
    if (a.isDeleted !== b.isDeleted) return a.isDeleted ? 1 : -1;
    if (b.reportCount !== a.reportCount) return b.reportCount - a.reportCount;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7">
      <div class="empty-state"><div class="empty-icon">💬</div>
      <p>${activeFilter === 'reported' ? 'No reported comments — all clear' : 'No comments yet — looking clean ✨'}</p></div>
    </td></tr>`;
    document.getElementById('commentsPagination').innerHTML = '';
    updateCmtBulkToolbar();
    return;
  }

  const pageComments = filtered.slice((cmtPage - 1) * cmtPageSize, cmtPage * cmtPageSize);

  const rows = pageComments.flatMap(c => {
    const slug        = escHtml(c.articleSlug || '—');
    const bodyText    = c.isDeleted ? '<em class="text-muted">[hidden]</em>' : escHtml((c.body || '').slice(0, 120)) + (c.body && c.body.length > 120 ? '…' : '');
    const userName    = escHtml(c.user?.displayName || 'Unknown');
    const provider    = escHtml(c.user?.provider || '');
    const date        = `<span title="${fmtDate(c.createdAt)}">${relativeTime(c.createdAt)}</span>`;
    const reports     = c.reportCount || 0;
    const reportBadge = reports > 0
      ? `<span class="badge badge-danger" style="font-size:11px;">🚩 ${reports}</span>`
      : `<span class="text-muted text-sm">—</span>`;
    const hiddenBadge = c.isDeleted
      ? `<span class="badge badge-muted" style="font-size:11px;margin-left:4px;">🙈 Hidden</span>`
      : '';
    const articleLink = `<a href="${getSiteBase()}/article/${slug}" target="_blank" rel="noopener"
      style="color:var(--accent);font-size:12px;word-break:break-all;"
      title="${slug}">${slug.length > 28 ? slug.slice(0, 28) + '…' : slug}</a>`;
    const providerIcon = provider === 'google' ? '🔵' : provider === 'github' ? '⚫' : '👤';
    const rowClass    = [
      c.isDeleted ? 'row-archived' : '',
      selectedCmtIds.has(c.id) ? 'row-selected' : '',
      expandedCmtId === c.id ? 'kb-focus' : ''
    ].filter(Boolean).join(' ');
    const isExpanded  = expandedCmtId === c.id;

    const actions = c.isDeleted
      ? `<div style="display:flex;gap:6px;">
           <button class="btn btn-ghost btn-sm" onclick="restoreComment(${c.id})" title="Restore comment">↩️</button>
           <button class="btn btn-danger btn-sm" onclick="confirmDelete(${c.id})" title="Delete permanently">🗑️</button>
         </div>`
      : `<div style="display:flex;gap:6px;">
           <button class="btn btn-ghost btn-sm" onclick="confirmHide(${c.id})" title="Hide comment">🙈</button>
           <button class="btn btn-danger btn-sm" onclick="confirmDelete(${c.id})" title="Delete permanently">🗑️</button>
         </div>`;

    const mainRow = `
      <tr data-id="${c.id}" class="cmt-row ${rowClass}" style="cursor:pointer;">
        <td class="td-check" onclick="event.stopPropagation()">
          <input type="checkbox" class="cmt-check" data-id="${c.id}" ${selectedCmtIds.has(c.id) ? 'checked' : ''} />
        </td>
        <td style="font-size:12px;">${articleLink}</td>
        <td style="font-size:13px;">${bodyText}${hiddenBadge}</td>
        <td style="font-size:12px;">
          ${c.user?.avatarUrl ? `<img src="${escHtml(c.user.avatarUrl)}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:5px;" onerror="this.style.display='none'" />` : ''}
          ${providerIcon} ${userName}
        </td>
        <td style="text-align:center;">${reportBadge}</td>
        <td class="text-muted text-sm">${date}</td>
        <td onclick="event.stopPropagation()">${actions}</td>
      </tr>`;

    const expandRow = isExpanded ? `
      <tr class="cmt-expand-row" data-parent="${c.id}">
        <td colspan="7" style="padding:0;">
          <div class="cmt-expand-body">
            <div style="font-size:13px;line-height:1.6;color:var(--text);margin-bottom:var(--space-3);">${escHtml(c.body || '')}</div>
            ${c.spamScore != null ? `<div style="font-size:12px;color:#fb923c;">🤖 Spam score: ${Math.round(c.spamScore * 100)}%${c.spamReason ? ` — ${escHtml(c.spamReason)}` : ''}</div>` : ''}
            ${c.parentId ? `<div style="font-size:12px;color:var(--muted);margin-top:var(--space-1);">↩ Reply to comment #${c.parentId}</div>` : ''}
          </div>
        </td>
      </tr>` : '';

    return mainRow + expandRow;
  });

  tbody.innerHTML = rows.join('');

  // Wire checkboxes
  tbody.querySelectorAll('.cmt-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) selectedCmtIds.add(id); else selectedCmtIds.delete(id);
      const row = tbody.querySelector(`tr[data-id="${id}"]`);
      if (row) row.classList.toggle('row-selected', cb.checked);
      updateCmtBulkToolbar();
    });
  });

  // Wire row click → expand
  tbody.querySelectorAll('.cmt-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.dataset.id);
      expandedCmtId = expandedCmtId === id ? null : id;
      renderTable();
    });
  });

  // Sync select-all
  const selectAll = document.getElementById('cmtSelectAll');
  if (selectAll) selectAll.checked = pageComments.length > 0 && pageComments.every(c => selectedCmtIds.has(c.id));

  updateCmtBulkToolbar();

  renderPagination('commentsPagination', filtered.length, cmtPage, cmtPageSize,
    (p) => { cmtPage = p; renderTable(); },
    (s) => { cmtPageSize = s; cmtPage = 1; renderTable(); }
  );
}

function updateCmtBulkToolbar() {
  const toolbar = document.getElementById('cmtBulkToolbar');
  const count   = document.getElementById('cmtBulkCount');
  if (!toolbar) return;
  if (selectedCmtIds.size > 0) {
    toolbar.style.display = 'flex';
    count.textContent = `${selectedCmtIds.size} selected`;
  } else {
    toolbar.style.display = 'none';
  }
}

function renderQueueTable(tbody) {
  if (queueItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="empty-state"><div class="empty-icon">✅</div>
      <p>Queue is empty — nothing to review</p></div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = queueItems.map(c => {
    const slug     = escHtml(c.articleSlug || '—');
    const body     = escHtml((c.body || '').slice(0, 160)) + (c.body && c.body.length > 160 ? '…' : '');
    const userName = escHtml(c.user?.displayName || 'Unknown');
    const provider = escHtml(c.user?.provider || '');
    const date     = `<span title="${fmtDate(c.createdAt)}">${relativeTime(c.createdAt)}</span>`;
    const prior    = c.priorApproved ?? 0;
    const providerIcon = provider === 'google' ? '🔵' : provider === 'github' ? '⚫' : '👤';
    const articleLink  = `<a href="${getSiteBase()}/article/${slug}" target="_blank" rel="noopener"
      style="color:var(--accent);font-size:12px;" title="${slug}">${slug.length > 28 ? slug.slice(0, 28) + '…' : slug}</a>`;

    // Spam indicator
    const spamScore  = c.spamScore != null ? Math.round(c.spamScore * 100) : null;
    const spamReason = c.spamReason || null;
    const spamBadge  = spamScore != null
      ? `<span class="badge" style="font-size:10px;background:rgba(251,146,60,0.15);color:#fb923c;border:1px solid rgba(251,146,60,0.3);"
              title="${escHtml(spamReason || '')}">🤖 ${spamScore}%</span>`
      : '';
    const reasonLabel = spamReason
      ? `<div style="color:#fb923c;font-size:10px;margin-top:2px;">${escHtml(spamReason)}</div>`
      : '';

    return `
      <tr data-id="${c.id}">
        <td style="font-size:12px;">${articleLink}</td>
        <td style="font-size:13px;color:var(--text-secondary);">${body}${reasonLabel}</td>
        <td style="font-size:12px;">
          ${c.user?.avatarUrl
            ? `<img src="${escHtml(c.user.avatarUrl)}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:5px;" onerror="this.style.display='none'" />`
            : ''}
          ${providerIcon} ${userName}
          <div class="text-muted text-xs mt-1">${prior} prior approved</div>
        </td>
        <td style="text-align:center;">
          <div style="display:flex;flex-direction:column;gap:3px;align-items:center;">
            <span class="badge badge-muted" style="font-size:11px;">⏳ Pending</span>
            ${spamBadge}
          </div>
        </td>
        <td class="text-muted text-sm">${date}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm" style="background:rgba(52,211,153,0.15);color:#34d399;border:1px solid rgba(52,211,153,0.3);"
                    onclick="approveComment(${c.id})" title="Approve">✅</button>
            <button class="btn btn-danger btn-sm" onclick="rejectComment(${c.id})" title="Reject & delete">🗑️</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

/* ── Filters ──────────────────────────────────────────────────────── */
function initFilters() {
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      cmtPage = 1;
      renderTable();
    });
  });

  const slugInput = document.getElementById('slugFilter');
  slugInput.addEventListener('input', () => {
    slugFilter = slugInput.value.trim().toLowerCase();
    cmtPage = 1;
    renderTable();
  });

  // Select-all
  document.getElementById('cmtSelectAll')?.addEventListener('change', e => {
    const tbody = document.getElementById('commentsBody');
    tbody.querySelectorAll('.cmt-check').forEach(cb => {
      cb.checked = e.target.checked;
      const id = parseInt(cb.dataset.id);
      if (e.target.checked) selectedCmtIds.add(id); else selectedCmtIds.delete(id);
    });
    updateCmtBulkToolbar();
  });

  // Bulk toolbar buttons
  document.getElementById('cmtBulkApprove')?.addEventListener('click', () => bulkAction('approve'));
  document.getElementById('cmtBulkHide')?.addEventListener('click',    () => bulkAction('hide'));
  document.getElementById('cmtBulkDelete')?.addEventListener('click',  () => {
    if (!confirm(`Permanently delete ${selectedCmtIds.size} comment(s)? This cannot be undone.`)) return;
    bulkAction('delete');
  });
  document.getElementById('cmtBulkClear')?.addEventListener('click', () => {
    selectedCmtIds.clear();
    renderTable();
  });
}

/* ── Queue Actions ────────────────────────────────────────────────── */
async function approveComment(id) {
  try {
    await apiFetch(`/comments/admin/${id}/approve`, { method: 'POST' });
    queueItems = queueItems.filter(c => c.id !== id);
    updateQueueBadge();
    renderTable();
    showAlert('Comment approved — now visible publicly.', 'success');
    // Reload allComments so stats update
    await loadComments();
  } catch (err) {
    showAlert('Failed to approve: ' + err.message, 'error');
  }
}

async function rejectComment(id) {
  if (!confirm('Reject and permanently delete this comment?')) return;
  try {
    await apiFetch(`/comments/admin/${id}/reject`, { method: 'POST' });
    queueItems = queueItems.filter(c => c.id !== id);
    updateQueueBadge();
    renderTable();
    showAlert('Comment rejected and deleted.', 'success');
  } catch (err) {
    showAlert('Failed to reject: ' + err.message, 'error');
  }
}

/* ── Bulk Actions ────────────────────────────────────────────────── */
async function bulkAction(action) {
  const ids = [...selectedCmtIds];
  if (!ids.length) return;
  try {
    await apiFetch('/comments/admin/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    });
    const label = action === 'approve' ? 'approved' : action === 'hide' ? 'hidden' : 'deleted';
    showToast(`${ids.length} comment(s) ${label}`, 'success');
    selectedCmtIds.clear();
    expandedCmtId = null;
    await loadComments();
  } catch (err) {
    showAlert('Bulk action failed: ' + err.message, 'error');
  }
}

/* ── Restore Action ───────────────────────────────────────────────── */
async function restoreComment(id) {
  try {
    await apiFetch(`/comments/admin/${id}/restore`, { method: 'POST' });
    const c = allComments.find(c => c.id === id);
    if (c) c.isDeleted = false;
    renderStats();
    renderTable();
    showAlert('Comment restored and visible publicly.', 'success');
  } catch (err) {
    showAlert('Failed to restore: ' + err.message, 'error');
  }
}

/* ── Hide/Delete Actions ──────────────────────────────────────────── */
function confirmHide(id) {
  document.getElementById('confirmTitle').textContent = 'Hide Comment';
  document.getElementById('confirmMsg').textContent   = 'This will soft-delete the comment and clear any reports. The user will see [deleted].';
  document.getElementById('confirmOkBtn').onclick = () => hideComment(id);
  openModal('confirmModal');
}

function confirmDelete(id) {
  document.getElementById('confirmTitle').textContent = 'Delete Comment';
  document.getElementById('confirmMsg').textContent   = 'This will permanently delete the comment from the database. This cannot be undone.';
  document.getElementById('confirmOkBtn').onclick = () => hardDelete(id);
  openModal('confirmModal');
}

async function hideComment(id) {
  closeModal('confirmModal');
  try {
    await apiFetch(`/comments/admin/${id}/hide`, { method: 'POST' });
    allComments = allComments.filter(c => c.id !== id);
    renderStats();
    renderTable();
    showAlert('Comment hidden.', 'success');
  } catch (err) {
    showAlert('Failed to hide: ' + err.message, 'error');
  }
}

async function hardDelete(id) {
  closeModal('confirmModal');
  try {
    await apiFetch(`/comments/admin/${id}`, { method: 'DELETE' });
    allComments = allComments.filter(c => c.id !== id);
    renderStats();
    renderTable();
    showAlert('Comment deleted.', 'success');
  } catch (err) {
    showAlert('Failed to delete: ' + err.message, 'error');
  }
}

/* ── Keyboard navigation ──────────────────────────────────────────── */
(function initKeyNav() {
  let focusedId = null;

  function getFocusableRows() {
    return [...document.querySelectorAll('#commentsBody tr[data-id]')];
  }

  function setFocusedRow(id) {
    document.querySelectorAll('#commentsBody tr.kb-focus').forEach(r => r.classList.remove('kb-focus'));
    focusedId = id;
    if (id != null) {
      const row = document.querySelector(`#commentsBody tr[data-id="${id}"]`);
      if (row) { row.classList.add('kb-focus'); row.scrollIntoView({ block: 'nearest' }); }
    }
  }

  document.addEventListener('keydown', e => {
    if (isInputFocused()) return;
    const rows = getFocusableRows();

    if (e.key === '?') {
      showKbdHelp([
        { key: 'j / ↓', desc: 'Next row' },
        { key: 'k / ↑', desc: 'Previous row' },
        { key: 'a',      desc: 'Approve focused comment (queue)' },
        { key: 'd',      desc: 'Delete focused comment' },
        { key: 'h',      desc: 'Hide focused comment' },
        { key: '?',      desc: 'Toggle this help' },
      ]);
      return;
    }

    if (!rows.length) return;
    const ids = rows.map(r => parseInt(r.dataset.id));
    const idx = focusedId != null ? ids.indexOf(focusedId) : -1;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedRow(ids[Math.min(idx + 1, ids.length - 1)]);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedRow(ids[Math.max(idx - 1, 0)]);
    } else if (e.key === 'a' && focusedId != null && activeFilter === 'queue') {
      approveComment(focusedId);
    } else if (e.key === 'd' && focusedId != null) {
      confirmDelete(focusedId);
    } else if (e.key === 'h' && focusedId != null) {
      confirmHide(focusedId);
    }
  });
})();

/* ── Helpers ──────────────────────────────────────────────────────── */
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
