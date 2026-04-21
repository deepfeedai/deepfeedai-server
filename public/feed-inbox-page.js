/**
 * Feed Inbox — curated/source articles management.
 * Stripped-down view for triaging RSS-ingested source material.
 */
(function () {
  let allArticles = [];
  let articles = [];
  let groups = [];
  let activeGroupId = null; // null=All, 'none'=Ungrouped, number=group id
  let sortCol = 'created_at';
  let sortDir = 'desc';
  let selectedIds = new Set();
  let searchQuery = '';
  let sourceFilter = 'all';
  let categoryFilter = 'all';
  let dateFilter = 'all';
  let statusFilter = 'all';
  let scoreFilter = 'all';
  let pitchStatusFilter = 'all';
  let activeTab = 'all';
  let page = 1;
  let pageSize = 50;

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function safeUrl(url) {
    if (!url) return '';
    return /^https?:\/\//i.test(url) ? url : '';
  }

  // ── Folder panel ─────────────────────────────────────────

  async function loadGroups() {
    try {
      const data = await apiFetch('/feed-groups');
      groups = data.groups || [];
      renderFolderPanel();
      populateBulkMoveDropdown();
    } catch (err) {
      console.error('Failed to load groups:', err);
    }
  }

  function renderFolderPanel() {
    const list = document.getElementById('folderList');
    if (!list) return;

    const totalCount = allArticles.length;
    const ungrpCount = allArticles.filter(a => !a.group_id).length;

    let html = '';

    html += `<div class="folder-item ${activeGroupId === null ? 'active' : ''}" data-group="all">
      <span class="folder-dot" style="background:var(--muted)"></span>
      <span class="folder-name">All</span>
      <span class="folder-count">${totalCount}</span>
    </div>`;

    html += `<div class="folder-item ${activeGroupId === 'none' ? 'active' : ''}" data-group="none">
      <span class="folder-dot" style="background:var(--border-color,#444)"></span>
      <span class="folder-name">Ungrouped</span>
      <span class="folder-count">${ungrpCount}</span>
    </div>`;

    groups.forEach(g => {
      const isActive = activeGroupId === g.id;
      const count = allArticles.filter(a => a.group_id === g.id).length;
      html += `<div class="folder-item ${isActive ? 'active' : ''}" data-group="${g.id}">
        <span class="folder-dot" style="background:${escHtml(g.color)}"></span>
        <span class="folder-name">${escHtml(g.name)}</span>
        <span class="folder-count">${count}</span>
        <div class="folder-actions">
          <button class="btn btn-ghost btn-sm folder-edit-btn" data-id="${g.id}" title="Rename">✏</button>
          <button class="btn btn-ghost btn-sm folder-delete-btn" data-id="${g.id}" title="Delete">✕</button>
        </div>
      </div>`;
    });

    list.innerHTML = html;

    list.querySelectorAll('.folder-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.folder-actions')) return;
        const gid = el.dataset.group;
        setActiveGroup(gid === 'all' ? null : gid === 'none' ? 'none' : parseInt(gid));
      });
    });

    list.querySelectorAll('.folder-edit-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        startEditGroup(parseInt(btn.dataset.id));
      });
    });

    list.querySelectorAll('.folder-delete-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        deleteGroup(parseInt(btn.dataset.id));
      });
    });
  }

  function setActiveGroup(id) {
    activeGroupId = id;
    renderFolderPanel();
    applyFilters();
  }

  function startEditGroup(id) {
    const g = groups.find(x => x.id === id);
    if (!g) return;
    const list = document.getElementById('folderList');
    const item = list ? list.querySelector(`[data-group="${id}"]`) : null;
    if (!item) return;

    item.innerHTML = `
      <input type="text" class="folder-name-input" value="${escHtml(g.name)}" maxlength="60" style="flex:1;min-width:0;" />
      <input type="color" class="folder-color-input" value="${g.color}" />
      <button class="btn btn-primary btn-sm folder-save-edit-btn" data-id="${id}">✓</button>
      <button class="btn btn-ghost btn-sm folder-cancel-edit-btn">✕</button>
    `;
    item.style.flexWrap = 'wrap';
    item.querySelector('.folder-name-input').focus();

    item.querySelector('.folder-save-edit-btn').addEventListener('click', async () => {
      const newName = item.querySelector('.folder-name-input').value.trim();
      const newColor = item.querySelector('.folder-color-input').value;
      if (!newName) return;
      try {
        const updated = await apiFetch('/feed-groups/' + id, {
          method: 'PUT',
          body: JSON.stringify({ name: newName, color: newColor }),
        });
        const idx = groups.findIndex(x => x.id === id);
        if (idx >= 0) groups[idx] = { ...groups[idx], name: updated.name, color: updated.color };
        renderFolderPanel();
        populateBulkMoveDropdown();
      } catch (err) {
        showAlert('Rename failed: ' + err.message, 'error');
        renderFolderPanel();
      }
    });

    item.querySelector('.folder-cancel-edit-btn').addEventListener('click', () => renderFolderPanel());
  }

  async function deleteGroup(id) {
    const g = groups.find(x => x.id === id);
    if (!confirm(`Delete folder "${g?.name || id}"? Articles will become ungrouped.`)) return;
    try {
      await apiFetch('/feed-groups/' + id, { method: 'DELETE' });
      groups = groups.filter(x => x.id !== id);
      allArticles.forEach(a => { if (a.group_id === id) a.group_id = null; });
      if (activeGroupId === id) activeGroupId = null;
      renderFolderPanel();
      populateBulkMoveDropdown();
      applyFilters({ preservePage: true });
    } catch (err) {
      showAlert('Delete failed: ' + err.message, 'error');
    }
  }

  function populateBulkMoveDropdown() {
    const sel = document.getElementById('bulkMoveFolder');
    if (!sel) return;
    sel.innerHTML = `<option value="">📁 Move to…</option>`
      + groups.map(g => `<option value="${g.id}">${escHtml(g.name)}</option>`).join('')
      + `<option value="none">— Ungrouped</option>`;
  }

  // New folder form
  document.getElementById('newFolderBtn')?.addEventListener('click', () => {
    const form = document.getElementById('folderNewForm');
    if (!form) return;
    const visible = form.style.display !== 'none';
    form.style.display = visible ? 'none' : '';
    if (!visible) document.getElementById('folderNameInput')?.focus();
  });

  document.getElementById('folderSaveBtn')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('folderNameInput');
    const colorInput = document.getElementById('folderColorInput');
    const name = nameInput?.value.trim();
    const color = colorInput?.value || '#6366f1';
    if (!name) { nameInput?.focus(); return; }
    try {
      const newGroup = await apiFetch('/feed-groups', {
        method: 'POST',
        body: JSON.stringify({ name, color }),
      });
      groups.push(newGroup);
      if (nameInput) nameInput.value = '';
      document.getElementById('folderNewForm').style.display = 'none';
      renderFolderPanel();
      populateBulkMoveDropdown();
      showAlert(`Folder "${newGroup.name}" created.`, 'success');
    } catch (err) {
      showAlert('Create failed: ' + err.message, 'error');
    }
  });

  document.getElementById('folderCancelBtn')?.addEventListener('click', () => {
    const form = document.getElementById('folderNewForm');
    if (form) form.style.display = 'none';
  });

  document.getElementById('folderNameInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('folderSaveBtn')?.click();
    if (e.key === 'Escape') document.getElementById('folderCancelBtn')?.click();
  });

  // ── AI Auto-sort ─────────────────────────────────────────
  let _autoSortPayload = null; // holds last dry-run result for apply step

  document.getElementById('autoSortBtn')?.addEventListener('click', async () => {
    const ungrouped = allArticles.filter(a => !a.group_id);
    if (!ungrouped.length) {
      showAlert('All articles are already in a folder.', 'success');
      return;
    }
    const body = document.getElementById('autoSortPreviewBody');
    const confirmBtn = document.getElementById('confirmAutoSortBtn');
    if (body) body.innerHTML = `<p class="text-muted">Asking AI to sort ${ungrouped.length} ungrouped article${ungrouped.length === 1 ? '' : 's'}…</p>`;
    if (confirmBtn) confirmBtn.style.display = 'none';
    _autoSortPayload = null;
    openModal('autoSortModal');

    try {
      const data = await apiFetch('/feed-groups/auto-sort', {
        method: 'POST',
        body: JSON.stringify({ dry_run: true }),
      });
      _autoSortPayload = data;
      renderAutoSortPreview(data);
    } catch (err) {
      if (body) body.innerHTML = `<p class="text-danger">Auto-sort failed: ${escHtml(err.message)}</p>`;
    }
  });

  function renderAutoSortPreview(data) {
    const body = document.getElementById('autoSortPreviewBody');
    const confirmBtn = document.getElementById('confirmAutoSortBtn');
    if (!body) return;

    const proposals = data.proposals || [];
    const newFolders = data.new_folders || [];

    if (!proposals.length) {
      body.innerHTML = '<p class="text-muted">No assignments to make — inbox may already be sorted.</p>';
      if (confirmBtn) confirmBtn.style.display = 'none';
      return;
    }

    // Build a folder → articles map for display
    const byFolder = {};
    proposals.forEach(p => {
      if (!byFolder[p.folder]) byFolder[p.folder] = [];
      const art = allArticles.find(a => a.id === p.id);
      byFolder[p.folder].push(art ? art.title : `Article #${p.id}`);
    });

    let html = '';
    if (newFolders.length) {
      html += `<p class="text-muted" style="margin-bottom:8px;">New folders will be created: ${newFolders.map(n => `<strong>${escHtml(n)}</strong>`).join(', ')}</p>`;
    }

    html += '<div style="display:flex;flex-direction:column;gap:10px;">';
    Object.entries(byFolder).forEach(([folder, titles]) => {
      const isNew = newFolders.includes(folder);
      html += `<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px;">
          ${escHtml(folder)}${isNew ? ' <span class="badge badge-muted" style="font-size:10px;">new</span>' : ''}
          <span class="text-muted" style="font-weight:400;"> · ${titles.length} article${titles.length === 1 ? '' : 's'}</span>
        </div>
        <ul style="margin:0;padding-left:16px;font-size:12px;color:var(--muted);">
          ${titles.slice(0, 5).map(t => `<li>${escHtml(t)}</li>`).join('')}
          ${titles.length > 5 ? `<li>…and ${titles.length - 5} more</li>` : ''}
        </ul>
      </div>`;
    });
    html += '</div>';

    body.innerHTML = html;
    if (confirmBtn) confirmBtn.style.display = '';
  }

  document.getElementById('confirmAutoSortBtn')?.addEventListener('click', async () => {
    const confirmBtn = document.getElementById('confirmAutoSortBtn');
    const body = document.getElementById('autoSortPreviewBody');
    if (!_autoSortPayload) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Applying…';
    try {
      const data = await apiFetch('/feed-groups/auto-sort', {
        method: 'POST',
        body: JSON.stringify({ dry_run: false }),
      });
      closeModal('autoSortModal');
      const newFolderCount = (data.new_folders || []).length;
      const folderMsg = newFolderCount ? `, ${newFolderCount} new folder${newFolderCount > 1 ? 's' : ''} created` : '';
      showAlert(`Auto-sorted ${data.applied} article${data.applied === 1 ? '' : 's'}${folderMsg}.`, 'success');
      _autoSortPayload = null;
      // Reload both articles and groups to reflect new assignments
      await loadGroups();
      await loadArticles();
    } catch (err) {
      showAlert('Apply failed: ' + err.message, 'error');
      if (body) body.innerHTML = `<p class="text-danger">Apply failed: ${escHtml(err.message)}</p>`;
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Apply assignments';
    }
  });

  // ── Sorting ──────────────────────────────────────────────

  function sortArticles(col) {
    if (sortCol === col) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortCol = col;
      sortDir = col === 'created_at' ? 'desc' : 'asc';
    }
    document.querySelectorAll('.sortable').forEach(th => {
      const icon = th.querySelector('.sort-icon');
      if (th.dataset.col === sortCol) {
        icon.textContent = sortDir === 'asc' ? '↑' : '↓';
        th.classList.add('active-sort');
      } else {
        icon.textContent = '⇅';
        th.classList.remove('active-sort');
      }
    });
    applyFilters();
  }

  // ── Filters ──────────────────────────────────────────────

  function applyFilters({ preservePage = false } = {}) {
    // Update tab badges
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const todayCount = allArticles.filter(a => (now - new Date(a.created_at).getTime()) < day).length;
    const weekCount = allArticles.filter(a => (now - new Date(a.created_at).getTime()) < 7 * day).length;
    const todayEl = document.getElementById('todayCount');
    const weekEl = document.getElementById('weekCount');
    if (todayEl) { todayEl.textContent = todayCount || ''; todayEl.style.display = todayCount ? 'inline-flex' : 'none'; }
    if (weekEl) { weekEl.textContent = weekCount || ''; weekEl.style.display = weekCount ? 'inline-flex' : 'none'; }

    let filtered = [...allArticles];

    // Tab filter
    if (activeTab === 'today') {
      filtered = filtered.filter(a => (now - new Date(a.created_at).getTime()) < day);
    } else if (activeTab === 'week') {
      filtered = filtered.filter(a => (now - new Date(a.created_at).getTime()) < 7 * day);
    }

    // Group filter
    if (activeGroupId !== null) {
      if (activeGroupId === 'none') {
        filtered = filtered.filter(a => !a.group_id);
      } else {
        filtered = filtered.filter(a => a.group_id === activeGroupId);
      }
    }

    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(a =>
        (a.title && a.title.toLowerCase().includes(q)) ||
        (a.summary && a.summary.toLowerCase().includes(q))
      );
    }

    // Source
    if (sourceFilter !== 'all') {
      filtered = filtered.filter(a => a.source === sourceFilter);
    }

    // Category
    if (categoryFilter === 'uncategorized') {
      filtered = filtered.filter(a => !a.category || a.category === 'Uncategorized');
    } else if (categoryFilter !== 'all') {
      filtered = filtered.filter(a => a.category === categoryFilter);
    }

    // Date
    if (dateFilter !== 'all') {
      const cutoff = dateFilter === '24h' ? day : dateFilter === '7d' ? 7 * day : 30 * day;
      filtered = filtered.filter(a => (now - new Date(a.created_at).getTime()) < cutoff);
    }

    // Status
    if (statusFilter !== 'all') {
      filtered = filtered.filter(a => (a.status || 'draft') === statusFilter);
    }

    // Score bucket
    if (scoreFilter !== 'all') {
      filtered = filtered.filter(a => {
        const s = a.editorial_score;
        if (scoreFilter === 'none') return s == null;
        if (s == null) return false;
        const n = Number(s);
        if (scoreFilter === 'high') return n >= 7;
        if (scoreFilter === 'mid')  return n >= 5 && n < 7;
        if (scoreFilter === 'low')  return n < 5;
        return true;
      });
    }

    // Pitch status filter
    if (pitchStatusFilter !== 'all') {
      filtered = filtered.filter(a => a.pitch_status === pitchStatusFilter);
    }

    // Sort
    filtered.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (sortCol === 'editorial_score') { va = Number(va || 0); vb = Number(vb || 0); }
      else if (sortCol === 'created_at') { va = new Date(va); vb = new Date(vb); }
      else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    articles = filtered;
    if (!preservePage) page = 1;
    else page = Math.min(page, Math.ceil(articles.length / pageSize) || 1);

    // Filter count indicator
    const countEl = document.getElementById('filterCount');
    const anyFilter = searchQuery || sourceFilter !== 'all' || categoryFilter !== 'all' || dateFilter !== 'all' || statusFilter !== 'all' || scoreFilter !== 'all' || pitchStatusFilter !== 'all' || activeGroupId !== null;
    if (countEl) {
      countEl.textContent = anyFilter ? `${filtered.length} of ${allArticles.length}` : `${filtered.length} articles`;
      countEl.classList.toggle('filter-count-active', anyFilter);
    }

    renderTable();
  }

  // ── Render ───────────────────────────────────────────────

  function pitchBadge(status) {
    if (!status || status === 'unused') return '';
    if (status === 'in_pitch') return `<span class="badge" style="background:rgba(234,179,8,.15);color:#ca8a04;font-size:10px;margin-left:4px;">In pitch</span>`;
    if (status === 'used') return `<span class="badge" style="background:rgba(34,197,94,.12);color:#16a34a;font-size:10px;margin-left:4px;">Used</span>`;
    return '';
  }

  function groupChip(a) {
    if (!a.group_id || !a.group_name) return '';
    const color = a.group_color || '#6366f1';
    return `<span class="folder-chip" style="border-color:${escHtml(color)};color:${escHtml(color)};">${escHtml(a.group_name)}</span>`;
  }

  function renderRowHtml(a) {
    const rowClass = selectedIds.has(a.id) ? 'row-selected' : '';
    return `
    <tr id="row-${a.id}" class="${rowClass}">
      <td class="td-check">
        <input type="checkbox" class="row-check" data-id="${a.id}" ${selectedIds.has(a.id) ? 'checked' : ''} />
      </td>
      <td class="td-title" title="${escHtml(a.title)}">
        <span>${escHtml(a.title)}</span>
        ${groupChip(a)}${pitchBadge(a.pitch_status)}
      </td>
      <td class="text-muted text-sm" data-label="Source">${escHtml(a.source || '—')}</td>
      <td class="td-category" data-label="Category">
        <span class="badge badge-muted">${escHtml(a.category || '—')}</span>
      </td>
      <td class="text-center" data-label="Score">${a.editorial_score != null
        ? `<span class="badge ${a.editorial_score >= 7 ? 'badge-success' : a.editorial_score >= 5 ? 'badge-warning' : 'badge-danger'}" style="min-width:24px;">${a.editorial_score}</span>`
        : '<span class="text-muted">—</span>'}</td>
      <td class="text-muted text-sm" data-label="Fetched"><span title="${fmtDate(a.created_at)}">${relativeTime(a.created_at)}</span></td>
      <td class="td-actions" style="text-align:center;">
        <div style="display:flex;gap:2px;justify-content:center;">
          ${safeUrl(a.source_url) ? `<a class="btn btn-ghost btn-sm" href="${escHtml(safeUrl(a.source_url))}" target="_blank" rel="noopener" title="View source">🔗</a>` : ''}
          <button class="btn btn-ghost btn-sm" title="Discuss with an agent" onclick="discussArticle(${a.id}, ${escHtml(JSON.stringify(a.title || ''))}, ${escHtml(JSON.stringify(a.category || ''))})">💬</button>
          <button class="btn btn-ghost btn-sm" title="Pitch via Maxwell" onclick="pitchWithMaxwell(${a.id}, ${escHtml(JSON.stringify(a.title || ''))})">📋</button>
          <button class="btn btn-ghost btn-sm" title="Re-categorize" onclick="recategorizeArticle(${a.id})">↻</button>
          <button class="btn btn-ghost btn-sm" title="Preview" onclick="previewArticle(${a.id})">👁</button>
          <button class="btn btn-ghost btn-sm" title="Delete" onclick="deleteArticle(${a.id})">🗑️</button>
        </div>
      </td>
    </tr>`;
  }

  function renderTable() {
    const tbody = document.getElementById('inboxBody');
    if (!tbody) return;

    const start = (page - 1) * pageSize;
    const pageItems = articles.slice(start, start + pageSize);

    if (!pageItems.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="td-empty">No source articles found.</td></tr>`;
    } else {
      tbody.innerHTML = pageItems.map(renderRowHtml).join('');
    }

    // Checkbox handlers
    tbody.querySelectorAll('.row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.id);
        if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        const row = document.getElementById('row-' + id);
        if (row) row.classList.toggle('row-selected', cb.checked);
        updateBulkToolbar();
      });
    });

    renderPagination();
    updateBulkToolbar();
  }

  function renderPagination() {
    const container = document.getElementById('inboxPagination');
    if (!container) return;
    const totalPages = Math.ceil(articles.length / pageSize) || 1;
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    let html = '<div class="pagination">';
    html += `<button class="btn btn-sm btn-ghost" ${page <= 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">← Prev</button>`;
    html += `<span class="text-muted text-sm" style="padding:0 8px;">Page ${page} of ${totalPages}</span>`;
    html += `<button class="btn btn-sm btn-ghost" ${page >= totalPages ? 'disabled' : ''} onclick="goToPage(${page + 1})">Next →</button>`;
    html += '</div>';
    container.innerHTML = html;
  }

  // ── Bulk toolbar ─────────────────────────────────────────

  function updateBulkToolbar() {
    const toolbar = document.getElementById('bulkToolbar');
    const countEl = document.getElementById('bulkCount');
    if (!toolbar) return;
    if (selectedIds.size > 0) {
      toolbar.style.display = 'flex';
      countEl.textContent = selectedIds.size + ' selected';
    } else {
      toolbar.style.display = 'none';
    }
    // Sync select-all checkbox
    const selectAll = document.getElementById('selectAll');
    if (selectAll) {
      const start = (page - 1) * pageSize;
      const pageItems = articles.slice(start, start + pageSize);
      selectAll.checked = pageItems.length > 0 && pageItems.every(a => selectedIds.has(a.id));
    }
  }

  // ── Actions ──────────────────────────────────────────────

  window.previewArticle = function (id) {
    const a = allArticles.find(x => x.id === id);
    if (!a) return;

    const date = a.created_at;
    const fmtPubDate = date ? new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

    let html = `<div style="padding:24px;max-width:720px;margin:0 auto;">`;
    if (a.image_url) {
      html += `<img src="${escHtml(a.image_url)}" alt="" style="width:100%;max-height:300px;object-fit:cover;border-radius:8px;margin-bottom:16px;" />`;
    }
    html += `<span class="badge badge-muted" style="margin-bottom:8px;">${escHtml(a.category || 'Uncategorized')}</span>`;
    html += `<h2 style="margin:8px 0 12px;font-size:1.5rem;line-height:1.3;">${escHtml(a.title)}</h2>`;
    html += `<div style="display:flex;gap:8px;align-items:center;font-size:0.85rem;color:var(--muted);margin-bottom:16px;">`;
    if (a.source) html += `<span style="font-weight:600;color:var(--text);">${escHtml(a.source)}</span>`;
    if (a.author) html += `<span>by ${escHtml(a.author)}</span>`;
    html += `<span>${fmtPubDate}</span>`;
    if (a.editorial_score != null) html += `<span class="badge ${a.editorial_score >= 7 ? 'badge-success' : a.editorial_score >= 5 ? 'badge-warning' : 'badge-danger'}" style="min-width:24px;">Score: ${a.editorial_score}</span>`;
    html += `</div>`;
    if (a.summary) {
      html += `<p style="line-height:1.7;color:var(--text);">${escHtml(a.summary)}</p>`;
    }
    if (safeUrl(a.source_url)) {
      html += `<a href="${escHtml(safeUrl(a.source_url))}" target="_blank" rel="noopener" class="btn btn-primary" style="margin-top:16px;">Read Full Article on ${escHtml(a.source || 'Source')} →</a>`;
    }
    html += `</div>`;

    document.getElementById('articlePreviewBody').innerHTML = html;
    const sourceLink = document.getElementById('previewSourceLink');
    if (sourceLink && safeUrl(a.source_url)) {
      sourceLink.href = safeUrl(a.source_url);
      sourceLink.style.display = '';
    } else if (sourceLink) {
      sourceLink.style.display = 'none';
    }
    openModal('articlePreviewModal');
  };

  window.deleteArticle = async function (id) {
    if (!confirm('Delete this source article?')) return;
    try {
      await apiFetch('/articles/' + id, { method: 'DELETE' });
      allArticles = allArticles.filter(a => a.id !== id);
      selectedIds.delete(id);
      renderFolderPanel();
      applyFilters({ preservePage: true });
      showAlert('Article deleted.', 'success');
    } catch (err) {
      showAlert('Delete failed: ' + err.message, 'error');
    }
  };

  window.recategorizeArticle = async function (id) {
    try {
      const data = await apiFetch('/fetch/recategorize', {
        method: 'POST',
        body: JSON.stringify({ articleIds: [id], dryRun: false }),
      });
      if (data.updated > 0 && data.moves) {
        const moveKey = Object.keys(data.moves)[0] || '';
        const newCat = moveKey.includes(' → ') ? moveKey.split(' → ')[1] : null;
        if (newCat) {
          const art = allArticles.find(a => a.id === id);
          if (art) art.category = newCat;
          const row = document.getElementById('row-' + id);
          if (row) {
            const badge = row.querySelector('.td-category .badge');
            if (badge) badge.textContent = newCat;
          }
          showAlert(`Recategorized → ${newCat}`, 'success');
          populateCategoryFilter();
          updateUncatBanner();
          return;
        }
      }
      showAlert('Category unchanged.', 'success');
    } catch (err) {
      showAlert('Recategorize failed: ' + err.message, 'error');
    }
  };

  window.goToPage = function (p) {
    const totalPages = Math.ceil(articles.length / pageSize) || 1;
    page = Math.max(1, Math.min(p, totalPages));
    renderTable();
  };

  // ── Data loading ─────────────────────────────────────────

  async function loadArticles() {
    const tbody = document.getElementById('inboxBody');
    if (tbody) tbody.innerHTML = skeletonRows(['sk-w-full', 'sk-w-sm', 'sk-w-sm', 'sk-w-sm', 'sk-w-sm', 'sk-w-sm'], 5);
    try {
      const PAGE_SIZE = 500;
      let all = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const data = await apiFetch(`/articles?type=curated&limit=${PAGE_SIZE}&offset=${offset}`);
        const batch = Array.isArray(data) ? data : (data.articles || []);
        all = all.concat(batch);
        hasMore = data.hasMore === true;
        offset += batch.length;
        if (!batch.length) break;
      }
      allArticles = all;

      // Refresh folder counts with newly loaded articles
      renderFolderPanel();

      // Populate source filter
      populateSourceFilter();
      populateCategoryFilter();
      updateUncatBanner();

      applyFilters();
    } catch (err) {
      showAlert('Failed to load feed articles: ' + err.message, 'error');
    }
  }

  function populateSourceFilter() {
    const sources = new Set();
    allArticles.forEach(a => { if (a.source) sources.add(a.source); });
    const sel = document.getElementById('sourceFilter');
    if (!sel) return;
    const sorted = [...sources].sort((a, b) => a.localeCompare(b));
    sel.innerHTML = '<option value="all">All</option>' + sorted.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
  }

  function populateCategoryFilter() {
    const cats = window._siteCategories || [];
    const sel = document.getElementById('categoryFilter');
    const group = document.getElementById('categoryFilterGroup');
    if (!sel || !cats.length) return;
    const uncatCount = allArticles.filter(a => !a.category || a.category === 'Uncategorized').length;
    const uncatLabel = uncatCount > 0 ? `Uncategorized (${uncatCount})` : 'Uncategorized';
    sel.innerHTML = `<option value="all">All</option><option value="uncategorized">${uncatLabel}</option>`
      + cats.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    if (group) group.style.display = '';
  }

  function updateUncatBanner() {
    const banner = document.getElementById('uncatBanner');
    const msg = document.getElementById('uncatBannerMsg');
    if (!banner || !msg) return;
    const count = allArticles.filter(a => !a.category || a.category === 'Uncategorized').length;
    if (count > 0) {
      msg.textContent = `⚠ ${count} article${count === 1 ? ' is' : 's are'} uncategorized and excluded from synthesis.`;
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
  }

  // ── Event listeners ──────────────────────────────────────

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      applyFilters();
    });
  });

  // Sort
  document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => sortArticles(th.dataset.col));
  });

  // Search
  const searchInput = document.getElementById('articleSearch');
  const clearBtn = document.getElementById('clearSearch');
  let searchTimeout;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchQuery = searchInput.value.trim();
        if (clearBtn) clearBtn.style.display = searchQuery ? '' : 'none';
        applyFilters();
      }, 250);
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      clearBtn.style.display = 'none';
      applyFilters();
    });
  }

  // Filters
  const filterToggle = document.getElementById('filterBarToggle');
  const filterBarEl = document.getElementById('filterBar');
  filterToggle?.addEventListener('click', () => {
    if (!filterBarEl) return;
    const collapsed = filterBarEl.classList.toggle('collapsed');
    filterToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });

  document.getElementById('sourceFilter')?.addEventListener('change', e => { sourceFilter = e.target.value; applyFilters(); });
  document.getElementById('categoryFilter')?.addEventListener('change', e => { categoryFilter = e.target.value; applyFilters(); });
  document.getElementById('dateFilter')?.addEventListener('change', e => { dateFilter = e.target.value; applyFilters(); });
  document.getElementById('statusFilter')?.addEventListener('change', e => { statusFilter = e.target.value; applyFilters(); });
  document.getElementById('scoreFilter')?.addEventListener('change', e => { scoreFilter = e.target.value; applyFilters(); });
  document.getElementById('pitchStatusFilter')?.addEventListener('change', e => { pitchStatusFilter = e.target.value; applyFilters(); });

  // Select all
  document.getElementById('selectAll')?.addEventListener('change', e => {
    const start = (page - 1) * pageSize;
    const pageItems = articles.slice(start, start + pageSize);
    if (e.target.checked) {
      pageItems.forEach(a => selectedIds.add(a.id));
    } else {
      pageItems.forEach(a => selectedIds.delete(a.id));
    }
    applyFilters({ preservePage: true });
  });

  // Bulk delete
  document.getElementById('bulkDeleteBtn')?.addEventListener('click', async () => {
    if (!selectedIds.size) return;
    if (!confirm(`Delete ${selectedIds.size} source article(s)?`)) return;
    const ids = [...selectedIds];
    let deleted = 0;
    for (const id of ids) {
      try {
        await apiFetch('/articles/' + id, { method: 'DELETE' });
        deleted++;
      } catch { /* skip */ }
    }
    allArticles = allArticles.filter(a => !selectedIds.has(a.id));
    selectedIds.clear();
    renderFolderPanel();
    showAlert(`Deleted ${deleted} article(s).`, 'success');
    applyFilters({ preservePage: true });
  });

  document.getElementById('bulkClearBtn')?.addEventListener('click', () => {
    selectedIds.clear();
    applyFilters({ preservePage: true });
  });

  // Bulk move to folder
  document.getElementById('bulkMoveBtn')?.addEventListener('click', async () => {
    if (!selectedIds.size) return;
    const sel = document.getElementById('bulkMoveFolder');
    const val = sel?.value;
    if (!val) { showAlert('Select a folder first.', 'error'); return; }

    const ids = [...selectedIds];
    try {
      if (val === 'none') {
        // Remove from all groups — use the first matched group or just null them
        for (const g of groups) {
          const inGroup = ids.filter(id => {
            const a = allArticles.find(x => x.id === id);
            return a && a.group_id === g.id;
          });
          if (inGroup.length) {
            await apiFetch('/feed-groups/' + g.id + '/articles', {
              method: 'DELETE',
              body: JSON.stringify({ article_ids: inGroup }),
            });
          }
        }
        allArticles.forEach(a => { if (selectedIds.has(a.id)) { a.group_id = null; a.group_name = null; a.group_color = null; } });
        showAlert(`Moved ${ids.length} article(s) to Ungrouped.`, 'success');
      } else {
        const groupId = parseInt(val);
        await apiFetch('/feed-groups/' + groupId + '/articles', {
          method: 'PUT',
          body: JSON.stringify({ article_ids: ids }),
        });
        const g = groups.find(x => x.id === groupId);
        allArticles.forEach(a => {
          if (selectedIds.has(a.id)) {
            a.group_id = groupId;
            a.group_name = g?.name || null;
            a.group_color = g?.color || null;
          }
        });
        showAlert(`Moved ${ids.length} article(s) to "${g?.name || 'folder'}".`, 'success');
      }
      selectedIds.clear();
      if (sel) sel.value = '';
      renderFolderPanel();
      applyFilters({ preservePage: true });
    } catch (err) {
      showAlert('Move failed: ' + err.message, 'error');
    }
  });

  // Populate the pitch-type dropdown once PITCH_TYPES is available
  (function initBulkPitchType() {
    const sel = document.getElementById('bulkPitchType');
    if (!sel) return;
    const poll = () => {
      if (!window.PITCH_TYPES) return setTimeout(poll, 100);
      sel.innerHTML = window.PITCH_TYPES
        .map(t => `<option value="${t.key}">${t.icon} ${t.label}</option>`).join('');
    };
    poll();
  })();

  document.getElementById('bulkPitchBtn')?.addEventListener('click', () => {
    if (!selectedIds.size) return;
    if (selectedIds.size > 10) {
      if (!confirm(`You've selected ${selectedIds.size} sources — that's a lot for one pitch. Continue?`)) return;
    }
    const ids = [...selectedIds];
    const primary = allArticles.find(a => a.id === ids[0]);
    const rest    = ids.slice(1);
    const restArticles = rest.map(id => allArticles.find(a => a.id === id)).filter(Boolean);
    const typeSel = document.getElementById('bulkPitchType');
    const type = typeSel && typeSel.value ? typeSel.value : (ids.length >= 3 ? 'roundup' : ids.length >= 2 ? 'deep_dive' : 'original');
    const typeMeta = (window.PITCH_TYPE_MAP && window.PITCH_TYPE_MAP[type]) || { label: 'Original' };
    if (!window.ArticleContext || !window.Maxwell) {
      alert('Maxwell bubble unavailable. Ensure editor_workspace is enabled.');
      return;
    }
    (window.Maxwell.reset ? window.Maxwell.reset({ silent: true }) : Promise.resolve()).then(function () {
      window.ArticleContext.set({
        id: primary?.id,
        title: primary?.title || null,
        slug: primary?.slug || null,
        writer_id: primary?.writer_id || null,
        writer_name: primary?.writer_name || null,
        additional_ids: rest,
        additional_titles: restArticles.map(a => a.title || null),
      });
      const prompt = ids.length > 1
        ? `Pitch a ${typeMeta.label.toLowerCase()} on these ${ids.length} sources — what's the strongest angle and who should cover it?`
        : `Pitch a ${typeMeta.label.toLowerCase()} on this source — what's the angle and who should cover it?`;
      window.Maxwell.ask(prompt, { autoSend: false });
    });
  });

  // ── Uncategorized banner ─────────────────────────────────
  document.getElementById('uncatFixAllBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('uncatFixAllBtn');
    btn.disabled = true;
    try {
      const uncatIds = allArticles
        .filter(a => !a.category || a.category === 'Uncategorized')
        .map(a => a.id);
      if (!uncatIds.length) {
        showAlert('No uncategorized articles found.', 'success');
        return;
      }
      const CHUNK = 100;
      let totalUpdated = 0, totalReassigned = 0;
      for (let i = 0; i < uncatIds.length; i += CHUNK) {
        const chunk = uncatIds.slice(i, i + CHUNK);
        btn.textContent = `⏳ ${Math.min(i + CHUNK, uncatIds.length)}/${uncatIds.length}…`;
        const data = await apiFetch('/fetch/recategorize', {
          method: 'POST',
          body: JSON.stringify({ articleIds: chunk, dryRun: false }),
        });
        totalUpdated += data.updated || 0;
        totalReassigned += data.writerReassignments || 0;
      }
      const writerMsg = totalReassigned ? `, ${totalReassigned} writer(s) reassigned` : '';
      showAlert(`${totalUpdated} article${totalUpdated === 1 ? '' : 's'} recategorized${writerMsg}.`, 'success');
      loadArticles();
    } catch (err) {
      showAlert('Fix failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fix all';
    }
  });

  document.getElementById('uncatDismissBtn')?.addEventListener('click', () => {
    const banner = document.getElementById('uncatBanner');
    if (banner) banner.style.display = 'none';
  });

  // ── Recategorize ─────────────────────────────────────────
  let _recatPending = null;

  function renderRecatPreview(data) {
    const el = document.getElementById('recategorizePreview');
    const confirmBtn = document.getElementById('confirmRecategorizeBtn');
    if (!data || data.updated === 0) {
      el.innerHTML = '<p class="text-muted">All selected articles are already correctly categorized. No changes needed.</p>';
      confirmBtn.style.display = 'none';
      return;
    }
    confirmBtn.style.display = '';
    const rows = Object.entries(data.moves).map(([move, count]) =>
      `<tr><td style="padding:6px 12px;">${escHtml(move)}</td><td style="padding:6px 12px;text-align:right;font-weight:600;">${count}</td></tr>`
    ).join('');
    el.innerHTML = `
      <p style="margin-bottom:12px;">Scanned <strong>${data.total}</strong> articles. <strong>${data.updated}</strong> would be re-categorized:</p>
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="border-bottom:1px solid var(--border);"><th style="padding:6px 12px;text-align:left;">Move</th><th style="padding:6px 12px;text-align:right;">Count</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  document.getElementById('bulkRecategorizeBtn')?.addEventListener('click', async () => {
    const ids = [...selectedIds];
    if (!ids.length) { showAlert('Select articles first', 'error'); return; }
    _recatPending = { articleIds: ids };
    const el = document.getElementById('recategorizePreview');
    el.innerHTML = '<p class="text-muted">Analyzing articles…</p>';
    document.getElementById('confirmRecategorizeBtn').style.display = 'none';
    openModal('recategorizeModal');
    try {
      const data = await apiFetch('/fetch/recategorize', {
        method: 'POST',
        body: JSON.stringify({ ..._recatPending, dryRun: true }),
      });
      renderRecatPreview(data);
    } catch (err) {
      el.innerHTML = `<p class="text-danger">Preview failed: ${escHtml(err.message)}</p>`;
    }
  });

  document.getElementById('confirmRecategorizeBtn')?.addEventListener('click', async () => {
    if (!_recatPending) return;
    const btn = document.getElementById('confirmRecategorizeBtn');
    btn.disabled = true; btn.textContent = 'Applying…';
    try {
      const data = await apiFetch('/fetch/recategorize', {
        method: 'POST',
        body: JSON.stringify({ ..._recatPending, dryRun: false }),
      });
      closeModal('recategorizeModal');
      const writerMsg = data.writerReassignments ? `, ${data.writerReassignments} writer(s) reassigned` : '';
      showAlert(`Re-categorized ${data.updated} of ${data.total} articles${writerMsg}`, 'success');
      selectedIds.clear();
      _recatPending = null;
      loadArticles();
    } catch (err) {
      showAlert('Re-categorize failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Apply Changes';
    }
  });

  document.querySelectorAll('#recategorizeModal [data-close-modal]').forEach(el => {
    el.addEventListener('click', () => { _recatPending = null; });
  });

  // Fetch sources
  document.getElementById('fetchSourcesBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('fetchSourcesBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Fetching…';
    try {
      await apiFetch('/fetch', { method: 'POST' });
      showAlert('Fetch triggered — new articles will appear shortly.', 'success');
      setTimeout(() => loadArticles(), 3000);
    } catch (err) {
      showAlert('Fetch failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 Fetch Sources';
    }
  });

  // Purge dropdown
  const purgeBtn = document.getElementById('purgeArticlesBtn');
  const purgeMenu = document.getElementById('purgeMenu');
  if (purgeBtn && purgeMenu) {
    purgeBtn.addEventListener('click', e => {
      e.stopPropagation();
      purgeMenu.style.display = purgeMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { purgeMenu.style.display = 'none'; });
    purgeMenu.querySelectorAll('.purge-option').forEach(opt => {
      opt.addEventListener('click', e => {
        e.preventDefault();
        purgeMenu.style.display = 'none';
        openModal('purgeConfirmModal');
      });
    });
  }

  document.getElementById('confirmPurgeBtn')?.addEventListener('click', async () => {
    try {
      await apiFetch('/articles/purge-all?type=curated', { method: 'DELETE' });
      closeModal('purgeConfirmModal');
      showAlert('Feed articles purged.', 'success');
      loadArticles();
    } catch (err) {
      showAlert('Purge failed: ' + err.message, 'error');
    }
  });

  // ── Init ─────────────────────────────────────────────────
  onReady(async () => {
    if (!requireAuth()) return;
    renderSidebar();
    initModals();
    if (typeof loadCategories === 'function') {
      try { await loadCategories(); } catch { /* best-effort */ }
    }
    loadGroups();
    loadArticles();
    window.pageRefresh = loadArticles;
  });
})();
