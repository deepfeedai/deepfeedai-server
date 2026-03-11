/* ===== DeepFeedAI Admin — Comments Page ===== */

let allComments  = [];
let queueItems   = [];
let activeFilter = 'all';
let slugFilter   = '';

onReady(async () => {
  if (!requireAuth()) return;
  initSidebar();
  initLogout();

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

  let filtered = allComments.filter(c => !c.isDeleted);

  if (activeFilter === 'reported') {
    filtered = filtered.filter(c => c.reportCount > 0);
  }

  if (slugFilter) {
    filtered = filtered.filter(c =>
      (c.articleSlug || '').toLowerCase().includes(slugFilter)
    );
  }

  filtered.sort((a, b) => {
    if (b.reportCount !== a.reportCount) return b.reportCount - a.reportCount;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="empty-state"><div class="empty-icon">💬</div>
      <p>${activeFilter === 'reported' ? 'No reported comments' : 'No comments yet'}</p></div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const slug      = escHtml(c.articleSlug || '—');
    const body      = escHtml((c.body || '').slice(0, 120)) + (c.body && c.body.length > 120 ? '…' : '');
    const userName  = escHtml(c.user?.displayName || 'Unknown');
    const provider  = escHtml(c.user?.provider || '');
    const date      = fmtDate(c.createdAt);
    const reports   = c.reportCount || 0;
    const reportBadge = reports > 0
      ? `<span class="badge badge-danger" style="font-size:11px;">🚩 ${reports}</span>`
      : `<span style="color:var(--muted);font-size:12px;">—</span>`;
    const articleLink = `<a href="https://deepfeedai.com/article/${slug}" target="_blank" rel="noopener"
      style="color:var(--accent);font-size:12px;word-break:break-all;"
      title="${slug}">${slug.length > 28 ? slug.slice(0, 28) + '…' : slug}</a>`;
    const providerIcon = provider === 'google' ? '🔵' : provider === 'github' ? '⚫' : '👤';

    return `
      <tr data-id="${c.id}">
        <td style="font-size:12px;">${articleLink}</td>
        <td style="font-size:13px;color:var(--text-secondary);">${body}</td>
        <td style="font-size:12px;">
          ${c.user?.avatarUrl
            ? `<img src="${escHtml(c.user.avatarUrl)}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:5px;" onerror="this.style.display='none'" />`
            : ''}
          ${providerIcon} ${userName}
        </td>
        <td style="text-align:center;">${reportBadge}</td>
        <td style="color:var(--muted);font-size:12px;">${date}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" onclick="confirmHide(${c.id})" title="Hide comment">🙈</button>
            <button class="btn btn-danger btn-sm" onclick="confirmDelete(${c.id})" title="Delete permanently">🗑️</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function renderQueueTable(tbody) {
  if (queueItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="empty-state"><div class="empty-icon">✅</div>
      <p>Queue is empty — no comments pending review</p></div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = queueItems.map(c => {
    const slug     = escHtml(c.articleSlug || '—');
    const body     = escHtml((c.body || '').slice(0, 160)) + (c.body && c.body.length > 160 ? '…' : '');
    const userName = escHtml(c.user?.displayName || 'Unknown');
    const provider = escHtml(c.user?.provider || '');
    const date     = fmtDate(c.createdAt);
    const prior    = c.priorApproved ?? 0;
    const providerIcon = provider === 'google' ? '🔵' : provider === 'github' ? '⚫' : '👤';
    const articleLink  = `<a href="https://deepfeedai.com/article/${slug}" target="_blank" rel="noopener"
      style="color:var(--accent);font-size:12px;" title="${slug}">${slug.length > 28 ? slug.slice(0, 28) + '…' : slug}</a>`;

    return `
      <tr data-id="${c.id}">
        <td style="font-size:12px;">${articleLink}</td>
        <td style="font-size:13px;color:var(--text-secondary);">${body}</td>
        <td style="font-size:12px;">
          ${c.user?.avatarUrl
            ? `<img src="${escHtml(c.user.avatarUrl)}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:5px;" onerror="this.style.display='none'" />`
            : ''}
          ${providerIcon} ${userName}
          <div style="color:var(--muted);font-size:11px;margin-top:2px;">${prior} prior approved</div>
        </td>
        <td style="text-align:center;">
          <span class="badge badge-muted" style="font-size:11px;">⏳ Pending</span>
        </td>
        <td style="color:var(--muted);font-size:12px;">${date}</td>
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
      renderTable();
    });
  });

  const slugInput = document.getElementById('slugFilter');
  slugInput.addEventListener('input', () => {
    slugFilter = slugInput.value.trim().toLowerCase();
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

/* ── Helpers ──────────────────────────────────────────────────────── */
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
