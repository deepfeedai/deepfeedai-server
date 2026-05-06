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
  let viewMode = 'table'; // 'table' | 'folders'
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
          <button class="btn btn-ghost btn-sm folder-pitch-panel-btn" data-id="${g.id}" title="Pitch folder">📋</button>
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

    list.querySelectorAll('.folder-pitch-panel-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        const g = groups.find(x => x.id === id);
        const folderArts = allArticles.filter(a => a.group_id === id);
        pitchFolder(id, g?.name || 'Folder', folderArts);
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
  const FOLDER_TOTAL_SOFT = 25;
  let _autoSortPayload = null; // holds dry-run result + candidate ids for apply step

  function getAutoSortCandidates() {
    return articles.filter(a => !a.group_id && a.category && a.category !== 'Uncategorized');
  }

  function parseSeedInput() {
    const raw = document.getElementById('seedFoldersInput')?.value || '';
    return raw.split(',').map(s => s.trim().slice(0, 30)).filter(Boolean);
  }

  document.getElementById('autoSortBtn')?.addEventListener('click', () => {
    const candidates = getAutoSortCandidates();
    if (!candidates.length) {
      showAlert('No ungrouped categorized articles in current view.', 'success');
      return;
    }
    // Reset modal state
    const seedInput = document.getElementById('seedFoldersInput');
    if (seedInput) seedInput.value = '';
    const body = document.getElementById('autoSortPreviewBody');
    if (body) body.innerHTML = '';
    const confirmBtn = document.getElementById('confirmAutoSortBtn');
    if (confirmBtn) confirmBtn.style.display = 'none';
    _autoSortPayload = null;

    // Show folder limit warning if close
    if (groups.length >= FOLDER_TOTAL_SOFT) {
      if (body) body.innerHTML = `<p class="text-danger">Folder limit reached (${FOLDER_TOTAL_SOFT}). Delete some folders before creating more.</p>`;
      openModal('autoSortModal');
      return;
    }

    openModal('autoSortModal');
  });

  async function runAutoSortDryRun() {
    const candidates = getAutoSortCandidates();
    if (!candidates.length) {
      showAlert('No ungrouped categorized articles in current view.', 'success');
      return;
    }
    const seeds = parseSeedInput();
    const body = document.getElementById('autoSortPreviewBody');
    const confirmBtn = document.getElementById('confirmAutoSortBtn');
    if (body) body.innerHTML = `<p class="text-muted">Analysing ${candidates.length} article${candidates.length === 1 ? '' : 's'}…</p>`;
    if (confirmBtn) confirmBtn.style.display = 'none';
    _autoSortPayload = null;

    try {
      const ids = candidates.map(a => a.id);
      const data = await apiFetch('/feed-groups/auto-sort', {
        method: 'POST',
        body: JSON.stringify({ dry_run: true, article_ids: ids, seeds }),
      });
      data._article_ids = ids;
      data._seeds = seeds;
      _autoSortPayload = data;
      renderAutoSortPreview(data);
    } catch (err) {
      if (body) body.innerHTML = `<p class="text-danger">Analysis failed: ${escHtml(err.message)}</p>`;
    }
  }

  document.getElementById('analyseBtn')?.addEventListener('click', runAutoSortDryRun);
  document.getElementById('seedFoldersInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') runAutoSortDryRun();
  });

  function renderAutoSortPreview(data) {
    const body = document.getElementById('autoSortPreviewBody');
    const confirmBtn = document.getElementById('confirmAutoSortBtn');
    if (!body) return;

    const proposals  = data.proposals  || [];
    const newFolders = data.new_folders || [];
    const skipped    = data.skipped    || 0;
    const missed     = data.missed     || 0;

    if (!proposals.length) {
      body.innerHTML = '<p class="text-muted">No assignments to make — inbox may already be sorted.</p>';
      if (confirmBtn) confirmBtn.style.display = 'none';
      return;
    }

    // Group by folder for display
    const byFolder = {};
    proposals.forEach(p => {
      if (!byFolder[p.folder]) byFolder[p.folder] = [];
      const art = allArticles.find(a => a.id === p.id);
      byFolder[p.folder].push(art ? art.title : `Article #${p.id}`);
    });

    let html = '';

    // Warnings
    if (skipped > 0) {
      html += `<p class="text-muted" style="font-size:12px;margin-bottom:8px;">⚠ ${skipped} article${skipped === 1 ? '' : 's'} skipped (200-article limit per run).</p>`;
    }
    if (missed > 0) {
      html += `<p class="text-muted" style="font-size:12px;margin-bottom:8px;">⚠ ${missed} article${missed === 1 ? '' : 's'} not assigned by AI — will remain ungrouped.</p>`;
    }
    if (newFolders.length) {
      html += `<p style="font-size:12px;margin-bottom:10px;">New folders: ${newFolders.map(n => `<strong>${escHtml(n)}</strong>`).join(', ')}</p>`;
    }

    html += '<div style="display:flex;flex-direction:column;gap:8px;">';
    Object.entries(byFolder).sort((a, b) => a[0].localeCompare(b[0])).forEach(([folder, titles]) => {
      const isNew = newFolders.some(n => n.toLowerCase() === folder.toLowerCase());
      html += `<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:5px;">
          ${escHtml(folder)}
          ${isNew ? ' <span class="badge badge-muted" style="font-size:10px;">new</span>' : ''}
          <span class="text-muted" style="font-weight:400;"> · ${titles.length} article${titles.length === 1 ? '' : 's'}</span>
        </div>
        <ul style="margin:0;padding-left:16px;font-size:12px;color:var(--muted);">
          ${titles.slice(0, 4).map(t => `<li style="margin-bottom:2px;">${escHtml(t)}</li>`).join('')}
          ${titles.length > 4 ? `<li style="color:var(--muted);">…and ${titles.length - 4} more</li>` : ''}
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
        body: JSON.stringify({
          dry_run: false,
          article_ids: _autoSortPayload._article_ids || [],
          seeds: _autoSortPayload._seeds || [],
        }),
      });
      closeModal('autoSortModal');
      const nf = (data.new_folders || []).length;
      const folderMsg = nf ? `, ${nf} new folder${nf > 1 ? 's' : ''} created` : '';
      const skippedMsg = data.skipped ? ` (${data.skipped} skipped — over 200 limit)` : '';
      showAlert(`Sorted ${data.applied} article${data.applied === 1 ? '' : 's'}${folderMsg}${skippedMsg}.`, 'success');
      _autoSortPayload = null;
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

    // Search — every word must appear somewhere in title+summary (AND logic)
    if (searchQuery) {
      const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
      filtered = filtered.filter(a => {
        const haystack = ((a.title || '') + ' ' + (a.summary || '')).toLowerCase();
        return words.every(w => haystack.includes(w));
      });
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

    renderView();
  }

  // ── View switching ────────────────────────────────────────

  function renderView() {
    const tableWrap = document.getElementById('tableViewWrap');
    const folderWrap = document.getElementById('folderViewContainer');
    const paginationEl = document.getElementById('inboxPagination');
    if (viewMode === 'folders') {
      if (tableWrap) tableWrap.style.display = 'none';
      if (folderWrap) folderWrap.style.display = '';
      if (paginationEl) paginationEl.innerHTML = '';
      renderFolderView();
    } else {
      if (tableWrap) tableWrap.style.display = '';
      if (folderWrap) folderWrap.style.display = 'none';
      renderTable();
    }
  }

  function renderFolderView() {
    const container = document.getElementById('folderViewContainer');
    if (!container) return;

    // Group filtered articles by folder
    const grouped = new Map(); // group_id → { name, color, articles[] }
    const ungrouped = [];

    articles.forEach(a => {
      if (a.group_id) {
        if (!grouped.has(a.group_id)) {
          grouped.set(a.group_id, { name: a.group_name || 'Unknown', color: a.group_color || '#6366f1', articles: [] });
        }
        grouped.get(a.group_id).articles.push(a);
      } else {
        ungrouped.push(a);
      }
    });

    const sections = [...grouped.entries()].map(([id, g]) => ({ ...g, id })).sort((a, b) => a.name.localeCompare(b.name));

    // Build sectionMap for event wiring: groupId (int or 'none') → articles[]
    const sectionMap = new Map();
    sections.forEach(g => sectionMap.set(g.id, g.articles));
    if (ungrouped.length) sectionMap.set('none', ungrouped);

    let html = '';
    sections.forEach(g => { html += renderFolderSection(g.name, g.color, g.articles, g.id); });
    if (ungrouped.length) html += renderFolderSection('Ungrouped', null, ungrouped, 'none');
    if (!html) html = '<p class="text-muted" style="text-align:center;padding:40px 0;">No articles match the current filters.</p>';

    container.innerHTML = html;

    // Wire section select-all checkboxes and set indeterminate state
    container.querySelectorAll('.folder-select-all-check').forEach(cb => {
      const rawGid = cb.dataset.groupId;
      const gidKey = rawGid === 'none' ? 'none' : parseInt(rawGid);
      const sectionArts = sectionMap.get(gidKey) || [];
      const sectionIds = sectionArts.map(a => a.id);
      const allSel = sectionIds.length > 0 && sectionIds.every(id => selectedIds.has(id));
      const someSel = sectionIds.some(id => selectedIds.has(id));
      cb.checked = allSel;
      cb.indeterminate = someSel && !allSel;
      cb.addEventListener('change', () => {
        toggleFolderSelection(gidKey, cb.checked, sectionArts);
      });
    });

    // Wire folder pitch buttons in section headers
    container.querySelectorAll('.folder-pitch-btn').forEach(btn => {
      const rawGid = btn.dataset.groupId;
      const gidKey = rawGid === 'none' ? 'none' : parseInt(rawGid);
      const name = btn.dataset.groupName || 'Folder';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        pitchFolder(gidKey, name, sectionMap.get(gidKey) || []);
      });
    });

    // Wire article checkboxes
    container.querySelectorAll('.row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.id);
        if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        const card = document.getElementById('fcard-' + id);
        if (card) card.classList.toggle('row-selected', cb.checked);

        // Update parent section's select-all checkbox state
        const section = cb.closest('.folder-section');
        if (section) {
          const sectionCb = section.querySelector('.folder-select-all-check');
          const allCbs = [...section.querySelectorAll('.row-check')];
          const allSel = allCbs.every(c => c.checked);
          const someSel = allCbs.some(c => c.checked);
          if (sectionCb) { sectionCb.checked = allSel; sectionCb.indeterminate = someSel && !allSel; }
        }

        updateBulkToolbar();
      });
    });
  }

  function toggleFolderSelection(groupId, select, sectionArts) {
    sectionArts.forEach(a => {
      if (select) selectedIds.add(a.id); else selectedIds.delete(a.id);
      const card = document.getElementById('fcard-' + a.id);
      if (card) {
        card.classList.toggle('row-selected', select);
        const cb = card.querySelector('.row-check');
        if (cb) cb.checked = select;
      }
    });
    updateBulkToolbar();
  }

  function pitchFolder(groupId, groupName, folderArticles) {
    if (!folderArticles.length) { showAlert('No articles in this folder.', 'error'); return; }
    if (!window.ArticleContext || !window.Maxwell) {
      alert('Maxwell bubble unavailable. Ensure editor_workspace is enabled.');
      return;
    }
    if (folderArticles.length > 15) {
      if (!confirm(`This folder has ${folderArticles.length} articles — only the first 15 will be sent. Continue?`)) return;
    }
    const limited = folderArticles.slice(0, 15);
    const primary = limited[0];
    const rest = limited.slice(1);
    (window.Maxwell.reset ? window.Maxwell.reset({ silent: true }) : Promise.resolve()).then(function () {
      window.ArticleContext.set({
        id: primary.id,
        title: primary.title || null,
        slug: primary.slug || null,
        writer_id: primary.writer_id || null,
        writer_name: primary.writer_name || null,
        additional_ids: rest.map(a => a.id),
        additional_titles: rest.map(a => a.title || null),
      });
      const prompt = `Pitch a story from the "${groupName}" folder — ${limited.length} source${limited.length === 1 ? '' : 's'} attached. What's the strongest angle and who should cover it?`;
      window.Maxwell.ask(prompt, { autoSend: false });
    });
  }

  function renderFolderSection(name, color, sectionArticles, groupId) {
    const gidAttr = groupId !== null && groupId !== undefined ? groupId : 'none';
    const dot = `<span class="folder-dot" style="background:${color ? escHtml(color) : 'var(--muted)'};width:10px;height:10px;flex-shrink:0;"></span>`;
    const cards = sectionArticles.map(renderFolderCard).join('');
    return `<div class="folder-section" data-group-id="${gidAttr}">
      <div class="folder-section-header">
        <label class="folder-section-check-label" title="Select all in ${escHtml(name)}">
          <input type="checkbox" class="folder-select-all-check" data-group-id="${gidAttr}" />
        </label>
        ${dot}
        <span class="folder-section-name">${escHtml(name)}</span>
        <span class="folder-section-count">${sectionArticles.length} article${sectionArticles.length === 1 ? '' : 's'}</span>
        <button class="btn btn-ghost btn-sm folder-pitch-btn" data-group-id="${gidAttr}" data-group-name="${escHtml(name)}" title="Pitch this folder to Maxwell">📋 Pitch</button>
      </div>
      <div class="folder-section-body">${cards}</div>
    </div>`;
  }

  function renderFolderCard(a) {
    const checked = selectedIds.has(a.id) ? 'checked' : '';
    const scoreClass = a.editorial_score >= 7 ? 'badge-success' : a.editorial_score >= 5 ? 'badge-warning' : 'badge-danger';
    return `<div class="folder-card ${selectedIds.has(a.id) ? 'row-selected' : ''}" id="fcard-${a.id}">
      <label class="folder-card-check"><input type="checkbox" class="row-check" data-id="${a.id}" ${checked} /></label>
      <div class="folder-card-body">
        <div class="folder-card-title">${escHtml(a.title)}${pitchBadge(a.pitch_status)}</div>
        <div class="folder-card-meta">
          ${a.source ? `<span class="text-muted text-sm">${escHtml(a.source)}</span>` : ''}
          ${a.category ? `<span class="badge badge-muted">${escHtml(a.category)}</span>` : ''}
          ${a.editorial_score != null ? `<span class="badge ${scoreClass}">${a.editorial_score}</span>` : ''}
          <span class="text-muted text-sm">${relativeTime(a.created_at)}</span>
        </div>
      </div>
      <div class="folder-card-actions">
        ${safeUrl(a.source_url) ? `<a class="btn btn-ghost btn-sm" href="${escHtml(safeUrl(a.source_url))}" target="_blank" rel="noopener" title="View source">🔗</a>` : ''}
        <button class="btn btn-ghost btn-sm" title="Discuss with an agent" onclick="discussArticle(${a.id},${escHtml(JSON.stringify(a.title||''))},${escHtml(JSON.stringify(a.category||''))})">💬</button>
        <button class="btn btn-ghost btn-sm" title="Pitch via Maxwell" onclick="pitchWithMaxwell(${a.id},${escHtml(JSON.stringify(a.title||''))})">📋</button>
        <button class="btn btn-ghost btn-sm" title="Preview" onclick="previewArticle(${a.id})">👁</button>
        <button class="btn btn-ghost btn-sm" title="Delete" onclick="deleteArticle(${a.id})">🗑️</button>
      </div>
    </div>`;
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
      applyFilters({ preservePage: true }); // also re-renders view
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
      const PAGE_SIZE = 200;

      // Fetch first page and render immediately so the table isn't blocked
      const firstData = await apiFetch(`/articles?type=curated&limit=${PAGE_SIZE}&offset=0`);
      const firstBatch = Array.isArray(firstData) ? firstData : (firstData.articles || []);
      allArticles = firstBatch;

      renderFolderPanel();
      populateSourceFilter();
      populateCategoryFilter();
      updateUncatBanner();
      applyFilters();

      // Fetch remaining pages in the background
      if (firstData.hasMore === true) {
        (async () => {
          let offset = firstBatch.length;
          let hasMore = true;
          while (hasMore) {
            const data = await apiFetch(`/articles?type=curated&limit=${PAGE_SIZE}&offset=${offset}`);
            const batch = Array.isArray(data) ? data : (data.articles || []);
            if (!batch.length) break;
            allArticles = allArticles.concat(batch);
            hasMore = data.hasMore === true;
            offset += batch.length;
          }
          // Refresh UI with the complete dataset
          renderFolderPanel();
          populateSourceFilter();
          populateCategoryFilter();
          updateUncatBanner();
          applyFilters();
        })().catch(err => console.warn('[feed-inbox] background load failed:', err.message));
      }
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

  // View toggle
  document.getElementById('viewTable')?.addEventListener('click', () => {
    viewMode = 'table';
    document.getElementById('viewTable')?.classList.add('active');
    document.getElementById('viewFolders')?.classList.remove('active');
    renderView();
  });
  document.getElementById('viewFolders')?.addEventListener('click', () => {
    viewMode = 'folders';
    document.getElementById('viewFolders')?.classList.add('active');
    document.getElementById('viewTable')?.classList.remove('active');
    renderView();
  });

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
