/* ===== DeepFeedAI Admin — Comments Page ===== */

let allComments  = [];
let activeFilter = 'all';
let slugFilter   = '';

onReady(async () => {
  if (!requireAuth()) return;
  initSidebar();
  initLogout();

  const user = localStorage.getItem('deepfeedai_user');
  if (user) document.getElementById('topbarUser').textContent = `👤 ${user}`;

  // Auto-activate filter from URL param (e.g. ?filter=reported from dashboard)
  const urlFilter = new URLSearchParams(window.location.search).get('filter');
  if (urlFilter === 'reported') activeFilter = 'reported';

  await loadComments();
  initFilters();

  // Sync filter tab UI after load
  if (activeFilter !== 'all') {
    document.querySelectorAll('.filter-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === activeFilter);
    });
  }
});

/* ── Load comments from admin API ─────────────────────────────────── */
async function loadComments() {
  try {
    const data = await apiFetch('/comments/admin');
    allComments = data.comments || [];
    renderStats();
    renderTable();
  } catch (err) {
    showAlert('Failed to load comments: ' + err.message, 'error');
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

  let filtered = allComments.filter(c => !c.isDeleted);

  if (activeFilter === 'reported') {
    filtered = filtered.filter(c => c.reportCount > 0);
  }

  if (slugFilter) {
    filtered = filtered.filter(c =>
      (c.articleSlug || '').toLowerCase().includes(slugFilter)
    );
  }

  // Sort: most reports first, then newest
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

/* ── Actions ──────────────────────────────────────────────────────── */
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
