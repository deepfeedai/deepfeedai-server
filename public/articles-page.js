let articles = [];
  let allArticles = []; // full list including archived
  let writersList = []; // cached writers for dropdown
  let deleteTargetId = null;
  let sortCol = 'published_at';
  let sortDir = 'desc';
  let selectedIds = new Set();
  let showArchived = false;
  let searchQuery = '';
  let audioFilter = 'all';
  let dateFilter  = 'all';
  let writerFilter = 'all';
  let statusFilter = 'all';
  let categoryFilter = 'all';
  let contentTypeFilter = 'all';
  let writerNameFilter = 'all';
  let activeTab   = 'all';
  let viewMode    = localStorage.getItem('dfa_articles_view') || 'table';
  let artPage     = 1;
  let artPageSize = 25;

  function applyViewMode() {
    const desktop = document.querySelector('.articles-desktop');
    const mobile = document.querySelector('.articles-mobile');
    if (!desktop || !mobile) return;
    desktop.style.display = viewMode === 'table' ? '' : 'none';
    mobile.style.display = viewMode === 'cards' ? 'block' : 'none';
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewMode);
    });
  }

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function sortArticles(col) {
    if (sortCol === col) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortCol = col;
      sortDir = ['published_at','created_at'].includes(col) ? 'desc' : 'asc';
    }
    // Update sort icons
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

  function applyFilters({ preservePage = false } = {}) {
    // Update draft + review count badges regardless of active tab
    const publishedCountEl = document.getElementById('publishedCount');
    if (publishedCountEl) {
      const publishedCount = allArticles.filter(a => a.is_published && !a.is_archived).length;
      publishedCountEl.textContent = publishedCount || '';
      publishedCountEl.style.display = publishedCount ? 'inline-flex' : 'none';
    }
    const draftCountEl = document.getElementById('draftCount');
    if (draftCountEl) {
      const draftCount = allArticles.filter(a => a.status === 'draft' || (!a.status && !a.is_archived && !a.is_published)).length;
      draftCountEl.textContent = draftCount || '';
      draftCountEl.style.display = draftCount ? 'inline-flex' : 'none';
    }
    const reviewCountEl = document.getElementById('reviewCount');
    if (reviewCountEl) {
      const reviewCount = allArticles.filter(a => a.status === 'review').length;
      reviewCountEl.textContent = reviewCount || '';
      reviewCountEl.style.display = reviewCount ? 'inline-flex' : 'none';
    }

    // Published tab — show published, non-archived articles
    if (activeTab === 'published') {
      let filtered = allArticles.filter(a => a.is_published && !a.is_archived);
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(a =>
          (a.title   && a.title.toLowerCase().includes(q)) ||
          (a.summary && a.summary.toLowerCase().includes(q))
        );
      }
      filtered.sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
      articles = filtered;
      if (!preservePage) artPage = 1;
      else artPage = Math.min(artPage, Math.ceil(articles.length / artPageSize) || 1);
      const countEl = document.getElementById('filterCount');
      if (countEl) {
        countEl.textContent = `${filtered.length} published`;
        countEl.classList.remove('filter-count-active');
      }
      renderTable();
      return;
    }

    // Review tab — show articles pending review
    if (activeTab === 'review') {
      let filtered = allArticles.filter(a => a.status === 'review');
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(a =>
          (a.title   && a.title.toLowerCase().includes(q)) ||
          (a.summary && a.summary.toLowerCase().includes(q))
        );
      }
      filtered.sort((a, b) => new Date(a.submitted_for_review_at || a.created_at) - new Date(b.submitted_for_review_at || b.created_at));
      articles = filtered;
      if (!preservePage) artPage = 1;
      else artPage = Math.min(artPage, Math.ceil(articles.length / artPageSize) || 1);
      const countEl = document.getElementById('filterCount');
      if (countEl) {
        countEl.textContent = `${filtered.length} in review`;
        countEl.classList.remove('filter-count-active');
      }
      renderTable();
      return;
    }

    // Drafts tab — override all other filters
    if (activeTab === 'drafts') {
      let filtered = allArticles.filter(a => a.status === 'draft' || (!a.status && !a.is_archived && !a.is_published));
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(a =>
          (a.title   && a.title.toLowerCase().includes(q)) ||
          (a.summary && a.summary.toLowerCase().includes(q))
        );
      }
      // Default sort: oldest first (surface stale drafts)
      filtered.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      articles = filtered;
      if (!preservePage) artPage = 1;
      else artPage = Math.min(artPage, Math.ceil(articles.length / artPageSize) || 1);
      const countEl = document.getElementById('filterCount');
      if (countEl) {
        countEl.textContent = `${filtered.length} draft${filtered.length !== 1 ? 's' : ''}`;
        countEl.classList.remove('filter-count-active');
      }
      renderTable();
      return;
    }

    // 1. Start from full list, apply status or archived toggle
    let filtered;
    if (statusFilter === 'published') {
      filtered = allArticles.filter(a => a.is_published && !a.is_archived);
    } else if (statusFilter === 'draft') {
      filtered = allArticles.filter(a => !a.is_published && !a.is_archived);
    } else if (statusFilter === 'archived') {
      filtered = allArticles.filter(a => a.is_archived);
    } else {
      filtered = showArchived ? allArticles : allArticles.filter(a => !a.is_archived);
    }

    // 2. Full-text search on title + summary
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(a =>
        (a.title   && a.title.toLowerCase().includes(q)) ||
        (a.summary && a.summary.toLowerCase().includes(q))
      );
    }

    // 3. Audio filter
    if (audioFilter === 'has-audio') {
      filtered = filtered.filter(a => a.audio_status === 'ready' && a.audio_url);
    } else if (audioFilter === 'no-audio') {
      filtered = filtered.filter(a => !a.audio_status || a.audio_status === 'error');
    } else if (audioFilter === 'hidden') {
      filtered = filtered.filter(a => a.audio_status === 'ready' && a.audio_url && !a.media_enabled);
    }

    // 4. Date filter
    if (dateFilter !== 'all') {
      const now = Date.now();
      const msMap = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
      const ms = msMap[dateFilter] || 0;
      if (ms) filtered = filtered.filter(a => {
        const d = new Date(a.published_at || a.created_at);
        return now - d.getTime() <= ms;
      });
    }

    // 5. Writer filter
    if (writerFilter === 'unassigned') {
      filtered = filtered.filter(a => !a.writer_id);
    } else if (writerFilter === 'assigned') {
      filtered = filtered.filter(a => !!a.writer_id);
    }

    // 6. Writer name filter
    if (writerNameFilter !== 'all') {
      const wid = parseInt(writerNameFilter);
      filtered = filtered.filter(a => a.writer_id === wid);
    }

    // 7. Category filter
    if (categoryFilter === 'uncategorized') {
      filtered = filtered.filter(a => !a.category || a.category === 'Uncategorized');
    } else if (categoryFilter !== 'all') {
      filtered = filtered.filter(a => a.category === categoryFilter);
    }

    // 8. Content type filter (editorial formats only — curated articles are in Feed Inbox)
    if (contentTypeFilter === 'original') {
      filtered = filtered.filter(a => a.content_type === 'original');
    } else if (contentTypeFilter === 'deep-dive') {
      filtered = filtered.filter(a => a.content_type === 'deep-dive');
    }

    // 9. Sort
    filtered.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (va == null) va = ''; if (vb == null) vb = '';
      if (['is_published','is_featured','editorial_score'].includes(sortCol)) { va = Number(va || 0); vb = Number(vb || 0); }
      else if (['published_at','created_at'].includes(sortCol)) { va = new Date(va); vb = new Date(vb); }
      else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    articles = filtered;
    if (!preservePage) artPage = 1;
    else artPage = Math.min(artPage, Math.ceil(articles.length / artPageSize) || 1);

    // 6. Update count badge
    const countEl = document.getElementById('filterCount');
    if (countEl) {
      const total = (showArchived ? allArticles : allArticles.filter(a => !a.is_archived)).length;
      const isFiltered = searchQuery || audioFilter !== 'all' || dateFilter !== 'all' || statusFilter !== 'all' || categoryFilter !== 'all' || writerNameFilter !== 'all' || contentTypeFilter !== 'all';
      countEl.textContent = isFiltered
        ? `${articles.length} of ${total}`
        : `${total} articles`;
      countEl.classList.toggle('filter-count-active', isFiltered && articles.length < total);
    }

    renderTable();
  }

  function updateBulkToolbar() {
    const toolbar = document.getElementById('bulkToolbar');
    const count   = document.getElementById('bulkCount');
    if (selectedIds.size > 0) {
      toolbar.style.display = 'flex';
      count.textContent = `${selectedIds.size} selected`;
    } else {
      toolbar.style.display = 'none';
    }
    // Sync select-all checkbox
    const all = document.getElementById('selectAll');
    if (all) all.checked = articles.length > 0 && selectedIds.size === articles.length;
  }

  // ── Per-row HTML generators (extracted for reuse by rerenderRow) ──

  const ROW_TOTAL_COLS = 12;

  function renderRowHtml(a) {
    const isArchived = !!a.is_archived;
    const rowClass = [
      selectedIds.has(a.id) ? 'row-selected' : '',
      isArchived ? 'row-archived' : ''
    ].filter(Boolean).join(' ');

    const row1 = `
    <tr id="row-${a.id}" class="row-main ${rowClass}">
      <td class="td-check" rowspan="2">
        <input type="checkbox" class="row-check" data-id="${a.id}" ${selectedIds.has(a.id) ? 'checked' : ''} />
      </td>
      <td class="td-title" title="${escHtml(a.title)}">
        <span class="td-editable-text">${escHtml(a.title)}</span>
        ${isArchived ? ' <span class="badge badge-archived" style="font-size:10px;margin-left:4px;">Archived</span>' : `<button class="td-edit-btn" onclick="startInlineEdit(${a.id},'title')" title="Edit title">✏️</button>`}
      </td>
      <td class="text-center">${a.editorial_score != null
        ? `<span class="badge ${a.editorial_score >= 7 ? 'badge-success' : a.editorial_score >= 5 ? 'badge-warning' : 'badge-danger'}" style="min-width:24px;">${a.editorial_score}</span>`
        : '<span class="text-muted">—</span>'}</td>
      <td class="text-muted text-sm">${escHtml(a.source || '—')}</td>
      <td class="td-category">
        ${isArchived
          ? `<span class="badge badge-muted">${escHtml(a.category || '—')}</span>`
          : `<span class="badge badge-muted td-editable-cat" onclick="startInlineEdit(${a.id},'category')" title="Click to change category">${escHtml(a.category || '—')}</span>`}
      </td>
      <td>${isArchived ? '<span class="badge badge-muted">Archived</span>'
        : a.status === 'review' ? '<span class="badge badge-warning">In Review</span>'
        : `<span class="badge ${a.is_published ? 'badge-success' : 'badge-muted'}">${a.is_published ? 'Published' : 'Draft'}</span>`}
      </td>
      <td class="td-importance">${renderImportanceCell(a)}</td>
      <td>${isArchived ? '—' : `
        <div class="featured-picker" style="display:flex;align-items:center;gap:4px;">
          <span class="badge ${a.is_featured ? 'badge-accent' : 'badge-muted'}" style="min-width:44px;text-align:center;">
            ${a.is_featured ? (a.featured_priority ? '⭐' + a.featured_priority : '⭐') : '—'}
          </span>
          <select class="featured-priority-select" style="font-size:12px;padding:4px 6px;min-width:60px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;"
            onchange="setFeaturedPriority(${a.id}, this.value)" title="Set featured priority (1=top)">
            <option value="0"  ${!a.is_featured              ? 'selected' : ''}>Off</option>
            <option value="1"  ${a.featured_priority === 1   ? 'selected' : ''}>#1</option>
            <option value="2"  ${a.featured_priority === 2   ? 'selected' : ''}>#2</option>
            <option value="3"  ${a.featured_priority === 3   ? 'selected' : ''}>#3</option>
            <option value="4"  ${a.featured_priority === 4   ? 'selected' : ''}>#4</option>
            <option value="5"  ${a.featured_priority === 5   ? 'selected' : ''}>#5</option>
          </select>
        </div>`}
      </td>
      <td class="text-muted text-sm">${(() => { const w = writersList.find(x => x.id === a.writer_id); return w ? escHtml(w.name) : '<span style="color:var(--muted);">—</span>'; })()}</td>
      <td class="text-muted text-sm"><span title="${fmtDate(a.published_at || a.created_at)}">${relativeTime(a.published_at || a.created_at)}</span></td>
      <td class="td-image" id="img-cell-${a.id}" style="text-align:center;">
        ${isArchived ? '—' : renderImageCell(a)}
      </td>
      <td class="td-audio" id="audio-cell-${a.id}" style="text-align:center;">
        ${isArchived ? '—' : renderAudioCell(a)}
      </td>
    </tr>`;

    const row2 = `
    <tr class="row-sub ${rowClass}">
      <td colspan="${ROW_TOTAL_COLS - 1}">
        <div class="row-sub-actions">
          ${a.source_url ? `<a class="btn btn-ghost btn-sm" href="${escHtml(a.source_url)}" target="_blank" rel="noopener" title="View original">🔗</a>` : ''}
          ${isArchived ? `
            <button class="btn btn-ghost btn-sm" title="Restore" onclick="restoreArticle(${a.id})">♻️ Restore</button>
            <button class="btn btn-ghost btn-sm" title="Permanently delete" onclick="openPurge(${a.id})">💀 Delete</button>
          ` : `
            ${a.status === 'review' ? `
              <button class="btn btn-sm" style="background:var(--success);color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;" title="Approve" onclick="approveArticle(${a.id})">✓ Approve</button>
              <button class="btn btn-ghost btn-sm" title="Reject" onclick="rejectArticle(${a.id})">✗ Reject</button>
            ` : a.status === 'draft' || (!a.status && !a.is_published && !a.is_archived) ? `
              <button class="btn btn-sm" style="background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;" title="Submit for Review" onclick="submitForReview(${a.id})">📝 Review</button>
            ` : ''}
            <button class="btn btn-ghost btn-sm" title="${!isFeatureOn('image_generation') ? 'Image generation not available on your plan' : a.image_url ? 'Regenerate image' : 'Generate image'}" onclick="generateImage(${a.id})" ${!isFeatureOn('image_generation') ? 'disabled' : ''}>🎨 Image</button>
            <button class="btn btn-ghost btn-sm" title="${!isFeatureOn('audio') ? 'Audio not available on your plan' : a.audio_url ? 'Regenerate audio' : 'Generate audio'}" onclick="generateAudio(${a.id})" ${!isFeatureOn('audio') ? 'disabled' : ''}>🎙️ Audio</button>
            <button class="btn btn-ghost btn-sm" title="Preview" onclick="previewArticle(${a.id})">👁 Preview</button>
            ${hasPermission('articles.update') ? `<button class="btn btn-ghost btn-sm" title="Open Editor" onclick="window.location.href='/article-editor.html?id=${a.id}'">✍️ Editor</button>` : ''}
            <button class="btn btn-ghost btn-sm" title="Edit" onclick="openEdit(${a.id})">✏️ Edit</button>
            ${(a.content_type === 'original' || a.content_type === 'deep-dive') ? `<button class="btn btn-ghost btn-sm" title="Regenerate from sources" onclick="regenerateArticle(${a.id})">🔄 Regen</button>` : ''}
            ${(a.full_content || a.summary) ? `<button class="btn btn-ghost btn-sm" title="${a.followups ? 'Regenerate follow-ups' : 'Generate follow-ups'}" onclick="generateFollowups(${a.id})">💬 ${a.followups ? 'Redo' : ''} Q&A</button>` : ''}
            <button class="btn btn-ghost btn-sm" title="Archive" onclick="openDelete(${a.id})">🗑️ Archive</button>
          `}
        </div>
      </td>
    </tr>`;

    return row1 + row2;
  }

  function renderCardHtml(a) {
    const isArchived = !!a.is_archived;
    const writer = writersList.find(x => x.id === a.writer_id);
    const cardClass = [
      'article-card',
      selectedIds.has(a.id) ? 'card-selected' : '',
      isArchived ? 'card-archived' : ''
    ].filter(Boolean).join(' ');
    return `
    <div class="${cardClass}" id="mcard-${a.id}">
      <div class="article-card-header">
        <input type="checkbox" class="card-check" data-id="${a.id}" ${selectedIds.has(a.id) ? 'checked' : ''} />
        <div class="article-card-title">${escHtml(a.title)}</div>
      </div>
      <div class="article-card-meta">
        ${isArchived
          ? '<span class="badge badge-archived">Archived</span>'
          : a.status === 'review'
            ? '<span class="badge badge-warning">In Review</span>'
            : `<span class="badge ${a.is_published ? 'badge-success' : 'badge-muted'}">${a.is_published ? 'Published' : 'Draft'}</span>`}
        <span class="badge badge-muted">${escHtml(a.category || 'Uncategorized')}</span>
        ${writer ? `<span class="text-muted text-sm">${escHtml(writer.name)}</span>` : ''}
        <span class="text-muted text-sm">${relativeTime(a.published_at || a.created_at)}</span>
      </div>
      ${a.source ? `<div class="article-card-source text-muted text-sm">${escHtml(a.source)}</div>` : ''}
      <div class="article-card-actions">
        ${a.source_url ? `<a class="btn btn-ghost btn-sm btn-icon" href="${escHtml(a.source_url)}" target="_blank" rel="noopener" title="View original">🔗</a>` : ''}
        ${isArchived ? `
          <button class="btn btn-ghost btn-sm" title="Restore" onclick="restoreArticle(${a.id})">♻️ Restore</button>
          <button class="btn btn-ghost btn-sm" title="Permanently delete" onclick="openPurge(${a.id})">💀 Delete</button>
        ` : `
          ${a.status === 'review' ? `
            <button class="btn btn-sm" style="background:var(--success);color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;" title="Approve" onclick="approveArticle(${a.id})">✓ Approve</button>
            <button class="btn btn-ghost btn-sm" title="Reject" onclick="rejectArticle(${a.id})">✗ Reject</button>
          ` : a.status === 'draft' || (!a.status && !a.is_published && !a.is_archived) ? `
            <button class="btn btn-sm" style="background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;" title="Submit for Review" onclick="submitForReview(${a.id})">📝 Review</button>
          ` : ''}
          <button class="btn btn-ghost btn-sm" title="${!isFeatureOn('image_generation') ? 'Image generation not available on your plan' : a.image_url ? 'Regenerate image' : 'Generate image'}" onclick="generateImage(${a.id})" ${!isFeatureOn('image_generation') ? 'disabled' : ''}>🎨 Image</button>
          <button class="btn btn-ghost btn-sm" title="${!isFeatureOn('audio') ? 'Audio not available on your plan' : a.audio_url ? 'Regenerate audio' : 'Generate audio'}" onclick="generateAudio(${a.id})" ${!isFeatureOn('audio') ? 'disabled' : ''}>🎙️ Audio</button>
          <button class="btn btn-ghost btn-sm" title="Preview" onclick="previewArticle(${a.id})">👁 Preview</button>
          <button class="btn btn-ghost btn-sm" title="Edit Content" onclick="window.location.href='/article-editor.html?id=${a.id}'">📝 Content</button>
          <button class="btn btn-ghost btn-sm" title="Edit" onclick="openEdit(${a.id})">✏️ Edit</button>
          <button class="btn btn-ghost btn-sm" title="Archive" onclick="openDelete(${a.id})">🗑️ Archive</button>
        `}
      </div>
    </div>`;
  }

  // ── Optimistic update helpers ──

  function wireRowCheckbox(row) {
    const cb = row.querySelector('.row-check');
    if (cb) cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
      row.classList.toggle('row-selected', cb.checked);
      updateBulkToolbar();
    });
  }

  function wireCardCheckbox(card) {
    const cb = card.querySelector('.card-check');
    if (cb) cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
      card.classList.toggle('card-selected', cb.checked);
      updateBulkToolbar();
    });
  }

  function updateTabBadges() {
    const draftCountEl = document.getElementById('draftCount');
    if (draftCountEl) {
      const c = allArticles.filter(a => a.status === 'draft' || (!a.status && !a.is_archived && !a.is_published)).length;
      draftCountEl.textContent = c || '';
      draftCountEl.style.display = c ? 'inline-flex' : 'none';
    }
    const reviewCountEl = document.getElementById('reviewCount');
    if (reviewCountEl) {
      const c = allArticles.filter(a => a.status === 'review').length;
      reviewCountEl.textContent = c || '';
      reviewCountEl.style.display = c ? 'inline-flex' : 'none';
    }
  }

  function rerenderRow(id) {
    const a = allArticles.find(x => x.id === id);
    if (!a) return;

    // Desktop
    const mainRow = document.getElementById(`row-${id}`);
    if (mainRow) {
      const subRow = mainRow.nextElementSibling;
      const temp = document.createElement('tbody');
      temp.innerHTML = renderRowHtml(a);
      const newMain = temp.children[0];
      const newSub = temp.children[1];
      mainRow.replaceWith(newMain);
      if (subRow) subRow.replaceWith(newSub);
      wireRowCheckbox(newMain);
    }

    // Mobile
    const card = document.getElementById(`mcard-${id}`);
    if (card) {
      const temp = document.createElement('div');
      temp.innerHTML = renderCardHtml(a);
      const newCard = temp.firstElementChild;
      card.replaceWith(newCard);
      wireCardCheckbox(newCard);
    }

    updateTabBadges();
  }

  function removeArticleRow(id) {
    const mainRow = document.getElementById(`row-${id}`);
    if (mainRow) {
      const subRow = mainRow.nextElementSibling;
      mainRow.remove();
      if (subRow) subRow.remove();
    }
    const card = document.getElementById(`mcard-${id}`);
    if (card) card.remove();

    const filtIdx = articles.findIndex(x => x.id === id);
    if (filtIdx !== -1) articles.splice(filtIdx, 1);

    renderPagination('articlesPagination', articles.length, artPage, artPageSize,
      (p) => { artPage = p; renderTable(); document.getElementById('articlesBody')?.closest('.table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
      (s) => { artPageSize = s; artPage = 1; renderTable(); document.getElementById('articlesBody')?.closest('.table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    );
    updateTabBadges();
  }

  /**
   * Optimistically patch an article in allArticles and re-render its row.
   * Returns a rollback function that restores the original state.
   */
  function updateArticleRow(id, patch) {
    const idx = allArticles.findIndex(x => x.id === id);
    if (idx === -1) return () => {};
    const snapshot = { ...allArticles[idx] };
    Object.assign(allArticles[idx], patch);
    rerenderRow(id);
    return () => { Object.assign(allArticles[idx], snapshot); rerenderRow(id); };
  }

  function renderTable() {
    const tbody = document.getElementById('articlesBody');
    const mobileList = document.getElementById('articlesMobileList');
    if (articles.length === 0) {
      tbody.innerHTML = `<tr><td colspan="12">
        <div class="empty-state"><div class="empty-icon">📭</div><p>No articles found — try adjusting filters</p></div>
      </td></tr>`;
      if (mobileList) mobileList.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>No articles found — try adjusting filters</p></div>';
      document.getElementById('articlesPagination').innerHTML = '';
      updateBulkToolbar();
      return;
    }

    const pageArticles = articles.slice((artPage - 1) * artPageSize, artPage * artPageSize);

    tbody.innerHTML = pageArticles.map(a => renderRowHtml(a)).join('');

    if (mobileList) {
      mobileList.innerHTML = pageArticles.map(a => renderCardHtml(a)).join('');
      mobileList.querySelectorAll('.card-check').forEach(cb => {
        wireCardCheckbox(cb.closest('.article-card'));
      });
    }

    tbody.querySelectorAll('.row-check').forEach(cb => {
      wireRowCheckbox(cb.closest('tr'));
    });

    updateBulkToolbar();

    renderPagination('articlesPagination', articles.length, artPage, artPageSize,
      (p) => { artPage = p; renderTable(); document.getElementById('articlesBody')?.closest('.table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
      (s) => { artPageSize = s; artPage = 1; renderTable(); document.getElementById('articlesBody')?.closest('.table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    );

    applyViewMode();
  }

  /* ---------- Story levels (importance) ---------- */
  const IMPORTANCE_COLORS = {
    breaking: { bg: '#dc2626', fg: '#fff' },      // red
    major:    { bg: '#f97316', fg: '#fff' },      // orange
    trending: { bg: '#eab308', fg: '#111' },      // yellow
    standard: { bg: 'var(--border)', fg: 'var(--text-muted, #94a3b8)' },
  };

  function renderImportanceCell(a) {
    const eff = a.effective_importance || a.importance || 'standard';
    const locked = !!a.importance_locked;
    const c = IMPORTANCE_COLORS[eff] || IMPORTANCE_COLORS.standard;
    const label = eff.charAt(0).toUpperCase() + eff.slice(1);
    const lockIcon = locked ? ' 🔒' : '';
    return `
      <div class="importance-cell" style="display:inline-flex;align-items:center;gap:4px;">
        <span class="importance-badge" onclick="toggleImportanceMenu(${a.id})"
          style="cursor:pointer;background:${c.bg};color:${c.fg};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;user-select:none;"
          title="${locked ? 'Manual override (locked). Click to change.' : 'Auto-computed. Click to override.'}">
          ${label}${lockIcon}
        </span>
        <div id="imp-menu-${a.id}" class="importance-menu" style="display:none;position:absolute;z-index:100;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,0.15);margin-top:24px;">
          ${['breaking','major','trending','standard'].map(l => `
            <div onclick="setImportance(${a.id}, '${l}')" style="padding:4px 10px;cursor:pointer;font-size:12px;border-radius:4px;" onmouseover="this.style.background='var(--hover,#222)'" onmouseout="this.style.background=''">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${IMPORTANCE_COLORS[l].bg};margin-right:6px;"></span>${l}
            </div>`).join('')}
          ${locked ? `<div onclick="unlockImportance(${a.id})" style="padding:4px 10px;cursor:pointer;font-size:12px;border-top:1px solid var(--border);color:var(--accent);">🔓 Unlock (auto)</div>` : ''}
        </div>
      </div>`;
  }

  window.toggleImportanceMenu = function(id) {
    document.querySelectorAll('.importance-menu').forEach(m => {
      if (m.id !== `imp-menu-${id}`) m.style.display = 'none';
    });
    const menu = document.getElementById(`imp-menu-${id}`);
    if (menu) menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  };

  window.setImportance = async function(id, level) {
    const menu = document.getElementById(`imp-menu-${id}`);
    if (menu) menu.style.display = 'none';
    try {
      await apiFetch(`/articles/${id}/importance`, {
        method: 'PATCH',
        body: JSON.stringify({ importance: level }),
      });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx >= 0) {
        allArticles[idx].importance = level;
        allArticles[idx].importance_locked = true;
        allArticles[idx].effective_importance = level;
        rerenderRow(id);
      }
      if (typeof toast === 'function') toast(`Importance set to ${level}`, 'success');
    } catch (e) {
      console.error('[importance] set failed', e);
      if (typeof toast === 'function') toast('Failed to set importance', 'error');
    }
  };

  window.unlockImportance = async function(id) {
    const menu = document.getElementById(`imp-menu-${id}`);
    if (menu) menu.style.display = 'none';
    try {
      await apiFetch(`/articles/${id}/importance`, {
        method: 'PATCH',
        body: JSON.stringify({ unlock: true }),
      });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx >= 0) {
        allArticles[idx].importance_locked = false;
        rerenderRow(id);
      }
      if (typeof toast === 'function') toast('Importance unlocked', 'success');
    } catch (e) {
      console.error('[importance] unlock failed', e);
      if (typeof toast === 'function') toast('Failed to unlock', 'error');
    }
  };

  // Close importance menus on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.importance-cell')) {
      document.querySelectorAll('.importance-menu').forEach(m => { m.style.display = 'none'; });
    }
  });

  /* ---------- Image helpers ---------- */
  function renderImageCell(a) {
    if (a.image_url) {
      const isAI = a.image_url.includes('img-') && (a.image_url.includes('/images/') || a.image_url.includes('r2') || a.image_url.includes('media'));
      return `
        <div style="position:relative;display:inline-block;">
          <img src="${escHtml(a.image_url)}" alt=""
            style="width:52px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--border);cursor:pointer;display:block;"
            onclick="previewImage('${escHtml(a.image_url)}')"
            onerror="this.outerHTML='<span style=\\'color:var(--danger);font-size:11px;\\'>✕</span>'" />
          ${isAI ? '<span style="position:absolute;top:-4px;right:-4px;background:var(--accent);color:#000;font-size:8px;font-weight:700;border-radius:3px;padding:1px 3px;line-height:1.2;">AI</span>' : ''}
        </div>`;
    }
    return `<span style="color:var(--muted);font-size:11px;">—</span>`;
  }

  let _imagePreviewUrl = null;
  function previewImage(url) {
    _imagePreviewUrl = url;
    document.getElementById('imgPreviewEl').src = url;
    document.getElementById('imgPreviewLink').href = url;
    openModal('imagePreviewModal');
  }

  function toSlug(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()
      .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  }

  function previewArticle(id) {
    const a = allArticles.find(x => x.id === id);
    if (!a) return;

    const writer = writersList.find(w => w.id === a.writer_id);
    const slug = a.slug || toSlug(a.title);
    const date = a.published_at || a.created_at;
    const fmtPubDate = date ? new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

    // Relative time
    const relTime = (function(d) {
      if (!d) return '';
      const diff = Date.now() - new Date(d).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 2) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      if (days < 7) return days + 'd ago';
      return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    })(date);

    // Read time
    const textForWordCount = (a.content_type === 'original' && a.full_content) ? a.full_content : (a.summary || '');
    const wordCount = (textForWordCount + ' ' + (a.title || '')).trim().split(/\s+/).filter(Boolean).length;
    const readMins = Math.max(1, Math.round(wordCount / 200));

    // Markdown → HTML (applied after escHtml so tags are safe)
    function mdInline(s) {
      return s
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code style="background:var(--bg-card);border:1px solid var(--border);border-radius:4px;padding:0.1em 0.4em;font-size:0.875em;color:var(--accent);">$1</code>');
    }
    function mdCitations(s, refs) {
      return s.replace(/\[(\d+)\]/g, (m, num) => {
        const idx = parseInt(num) - 1;
        if (idx < 0 || idx >= refs.length) return m;
        const ref = refs[idx];
        const href = ref.source_url ? escHtml(ref.source_url) : '#';
        const tip = escHtml((ref.source || '') + ': ' + (ref.title || ''));
        return `<sup style="color:var(--accent);"><a href="${href}" target="_blank" rel="noopener" title="${tip}" style="color:var(--accent);text-decoration:none;">[${num}]</a></sup>`;
      });
    }
    function mdBlock(text, refs) {
      const lines = text.split('\n');
      let out = '';
      let inList = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/^### (.+)$/.test(line)) {
          if (inList) { out += '</ul>'; inList = false; }
          out += `<h3>${mdInline(escHtml(line.replace(/^### /, '').trim()))}</h3>`;
          continue;
        }

        if (/^> (.+)$/.test(line)) {
          if (inList) { out += '</ul>'; inList = false; }
          out += `<blockquote>${mdInline(mdCitations(escHtml(line.replace(/^> /, '').trim()), refs))}</blockquote>`;
          continue;
        }

        if (/^\s*[-*] (.+)$/.test(line)) {
          if (!inList) { out += '<ul>'; inList = true; }
          const item = line.replace(/^\s*[-*] /, '').trim();
          out += `<li>${mdInline(mdCitations(escHtml(item), refs))}</li>`;
          continue;
        }

        if (inList) { out += '</ul>'; inList = false; }
        if (!line.trim()) continue;

        let para = line;
        while (i + 1 < lines.length && lines[i + 1].trim() && !/^(###|>|\s*[-*] )/.test(lines[i + 1])) {
          i++;
          para += ' ' + lines[i];
        }
        out += `<p>${mdInline(mdCitations(escHtml(para.trim()), refs))}</p>`;
      }
      if (inList) out += '</ul>';
      return out;
    }

    // Scoped styles that mirror the frontend article page
    const scopedCSS = `<style>
      .ap { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text); }
      .ap-hero-img { width: 100%; max-height: 400px; object-fit: cover; display: block; border-radius: 0; }
      .ap-body { max-width: 720px; margin: 0 auto; padding: 0 28px 28px; }
      .ap-tag { display: inline-block; color: var(--accent); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; margin-bottom: 8px; margin-top: 24px; }
      .ap-title { font-size: clamp(1.5rem, 3.5vw, 2.2rem); font-weight: 800; line-height: 1.2; margin: 0 0 12px; color: var(--text); }
      .ap-writer-byline { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .ap-writer-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid var(--accent); }
      .ap-writer-name { font-size: 0.9rem; font-weight: 600; color: var(--text); }
      .ap-meta { display: flex; align-items: center; gap: 0.6rem; font-size: 0.9rem; color: var(--muted); flex-wrap: wrap; margin-bottom: 16px; }
      .ap-meta .source { color: var(--text); font-weight: 600; }
      .ap-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; margin-top: 16px; }
      .ap-audio { margin: 20px 0; background: rgba(0,217,255,0.05); border: 1px solid rgba(0,217,255,0.18); border-radius: 14px; padding: 14px 18px; }
      .ap-audio-label { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); background: rgba(0,217,255,0.12); padding: 3px 10px; border-radius: 999px; display: inline-block; margin-bottom: 10px; }
      .ap-audio-voice { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .ap-audio-voice img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
      .ap-audio-voice span { font-size: 0.82rem; font-weight: 600; color: var(--text); }
      .ap-tldr { background: linear-gradient(135deg, rgba(79,142,247,0.08) 0%, rgba(139,92,246,0.08) 100%); border: 1px solid rgba(79,142,247,0.2); border-radius: 14px; padding: 18px 20px; margin: 20px 0; }
      .ap-tldr-badge { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); background: rgba(79,142,247,0.12); padding: 3px 10px; border-radius: 999px; display: inline-block; margin-bottom: 10px; }
      .ap-tldr-text { font-size: 0.95rem; line-height: 1.75; color: var(--text); margin: 0; }
      .ap-content { font-size: 1rem; line-height: 1.85; color: var(--text); margin: 20px 0; }
      .ap-content p { margin-bottom: 1.25rem; }
      .ap-content h2 { font-size: 1.4rem; font-weight: 700; margin: 2rem 0 0.75rem; }
      .ap-content h3 { font-size: 1.15rem; font-weight: 700; margin: 1.5rem 0 0.6rem; }
      .ap-content ul { padding-left: 1.25rem; margin-bottom: 1.25rem; }
      .ap-content li { margin-bottom: 0.4rem; }
      .ap-content blockquote { border-left: 3px solid var(--accent); padding: 0.5rem 1.25rem; margin: 1.5rem 0; color: var(--muted); font-style: italic; }
      .ap-content a { color: var(--accent); text-decoration: none; }
      .ap-content a:hover { text-decoration: underline; }
      .ap-summary { font-size: 1rem; line-height: 1.85; color: var(--text); margin: 20px 0; }
      .ap-summary p { margin-bottom: 1.25rem; }
      .ap-summary-note { color: var(--muted); font-size: 0.85rem; font-style: italic; }
      .ap-cta { display: inline-block; background: var(--accent); color: #fff; font-weight: 700; font-size: 0.95rem; padding: 12px 28px; border-radius: 99px; text-decoration: none; margin: 8px 0 20px; box-shadow: 0 4px 20px rgba(0,217,255,0.25); }
      .ap-cta:hover { opacity: 0.9; }
      .ap-context { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; margin: 20px 0; font-size: 0.85rem; color: var(--muted); }
      .ap-context strong { color: var(--text); }
      .ap-sources { margin: 20px 0 8px; }
      .ap-sources h3 { font-size: 0.82rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 8px; }
      .ap-sources ul { list-style: none; padding: 0; margin: 0; }
      .ap-sources li { font-size: 0.85rem; color: var(--text); padding: 4px 0; line-height: 1.5; }
      .ap-sources li a { color: var(--accent); text-decoration: none; }
      .ap-sources li a:hover { text-decoration: underline; }
      .ap-sources .ref-num { color: var(--muted); font-size: 0.78rem; margin-right: 4px; }
      .ap-sources .ref-origin { color: var(--muted); font-size: 0.8rem; }
      .ap-video { margin: 20px 0; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
      .ap-video-badge { font-size: 12px; font-weight: 600; color: #e53e3e; margin-bottom: 10px; }
      .ap-video-wrap { position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 8px; }
      .ap-video-wrap iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; }
    </style>`;

    let html = scopedCSS + '<div class="ap">';

    // Hero image
    if (a.image_url) {
      html += `<img class="ap-hero-img" src="${escHtml(a.image_url)}" alt="" onerror="this.style.display='none'" />`;
    }

    html += '<div class="ap-body">';

    // Admin status badges
    html += `<div class="ap-badges">`;
    if (a.is_published) html += `<span class="badge badge-success">Published</span>`;
    else html += `<span class="badge badge-muted">Draft</span>`;
    if (a.is_featured) html += `<span class="badge badge-accent">Featured #${a.featured_priority || '?'}</span>`;
    if (a.content_type === 'original') html += `<span class="badge" style="background:var(--accent);color:#000;">Original</span>`;
    if (a.content_type === 'deep-dive') html += `<span class="badge" style="background:var(--accent);color:#000;">Deep Dive</span>`;
    if (a.editorial_score) html += `<span class="badge badge-muted">Score: ${a.editorial_score}/10</span>`;
    html += `</div>`;

    // Category tag
    html += `<div class="ap-tag">${escHtml(a.category || 'Industry')}</div>`;

    // Title
    html += `<h1 class="ap-title">${escHtml(a.title)}</h1>`;

    // Writer byline
    if (writer) {
      html += `<div class="ap-writer-byline">`;
      if (writer.avatar_url) {
        html += `<img class="ap-writer-avatar" src="${escHtml(writer.avatar_url)}" alt="${escHtml(writer.name)}" onerror="this.style.display='none'" />`;
      }
      html += `<div class="ap-writer-name">by ${escHtml(writer.name)}</div>`;
      html += `</div>`;
    }

    // Meta line
    html += `<div class="ap-meta">`;
    if (!writer && a.source) html += `<span class="source">${escHtml(a.source)}</span><span>·</span>`;
    if (relTime || fmtPubDate) html += `<time title="${escHtml(fmtPubDate)}">${escHtml(relTime || fmtPubDate)}</time><span>·</span>`;
    html += `<span>${readMins} min read</span>`;
    html += `</div>`;

    // Audio player
    if (a.audio_url) {
      html += `<div class="ap-audio">`;
      html += `<span class="ap-audio-label">🎙️ AI Audio Summary</span>`;
      if (a.audio_voice_name) {
        html += `<div class="ap-audio-voice">`;
        if (a.audio_voice_avatar_url) html += `<img src="${escHtml(a.audio_voice_avatar_url)}" alt="" onerror="this.style.display='none'" />`;
        html += `<span>${escHtml(a.audio_voice_name)}</span>`;
        html += `</div>`;
      }
      html += `<audio controls style="width:100%;height:36px;" src="${escHtml(a.audio_url)}"></audio>`;
      html += `</div>`;
    }

    // Video embed
    if (a.embed_url) {
      try {
        const u = new URL(a.embed_url);
        if (u.protocol === 'https:' && (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && u.pathname.startsWith('/embed/')) {
          html += `<div class="ap-video">`;
          html += `<div class="ap-video-badge">&#9654; Video</div>`;
          html += `<div class="ap-video-wrap"><iframe src="${escHtml(a.embed_url)}" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" allowfullscreen loading="lazy"></iframe></div>`;
          html += `</div>`;
        }
      } catch(e) {}
    }

    // TLDR overview
    if (a.tldr_overview) {
      html += `<div class="ap-tldr">`;
      html += `<span class="ap-tldr-badge">✨ AI Summary</span>`;
      html += `<div class="ap-tldr-text">${escHtml(a.tldr_overview)}</div>`;
      html += `</div>`;
    }

    // Content rendering based on content_type
    if (a.content_type === 'deep-dive' && a.full_content) {
      let refs = [];
      try { let raw = a.source_article_ids; if (typeof raw === 'string') raw = JSON.parse(raw); if (Array.isArray(raw)) refs = raw; } catch(e) {}

      let meta = a.synthesis_meta;
      if (meta && typeof meta === 'string') try { meta = JSON.parse(meta); } catch(e) { meta = null; }

      const sourceCount = (meta && meta.source_count) ? meta.source_count : refs.length;
      const clusterCount = (meta && meta.cluster_count) ? meta.cluster_count : 0;
      if (sourceCount) {
        html += `<div class="ap-context"><strong>Weekly Deep Dive</strong> — ${sourceCount} sources across ${clusterCount} story threads</div>`;
      }

      const sections = a.full_content.split(/^## /m);
      html += `<div class="ap-content">`;
      if (sections[0] && sections[0].trim()) {
        html += mdBlock(sections[0].trim(), refs);
      }
      for (let si = 1; si < sections.length; si++) {
        const secText = sections[si];
        const nlIdx = secText.indexOf('\n');
        const secTitle = nlIdx !== -1 ? secText.substring(0, nlIdx).trim() : secText.trim();
        const secBody = nlIdx !== -1 ? secText.substring(nlIdx + 1).trim() : '';
        html += `<h2>${mdInline(escHtml(secTitle))}</h2>`;
        if (secBody) html += mdBlock(secBody, refs);
      }
      html += `</div>`;

      if (refs.length) {
        html += `<div class="ap-sources"><h3>Sources</h3><ul>`;
        refs.forEach((r, i) => {
          const title = escHtml(r.title || 'Article');
          const source = r.source ? ` <span class="ref-origin">— ${escHtml(r.source)}</span>` : '';
          const link = r.source_url ? `<a href="${escHtml(r.source_url)}" target="_blank" rel="noopener">${title}</a>` : title;
          html += `<li><span class="ref-num">[${i + 1}]</span> ${link}${source}</li>`;
        });
        html += `</ul></div>`;
      }

    } else if (a.content_type === 'original' && a.full_content) {
      let refs = [];
      try { let raw = a.source_article_ids; if (typeof raw === 'string') raw = JSON.parse(raw); if (Array.isArray(raw)) refs = raw; } catch(e) {}

      let meta = a.synthesis_meta;
      if (meta && typeof meta === 'string') try { meta = JSON.parse(meta); } catch(e) { meta = null; }
      if (meta && meta.source_count) {
        const names = meta.source_names || [];
        let nameStr = '';
        if (names.length <= 3) nameStr = names.map(escHtml).join(', ');
        else nameStr = names.slice(0, 2).map(escHtml).join(', ') + ' and ' + (names.length - 2) + ' others';
        const span = meta.timespan_hours;
        const spanStr = span <= 4 ? span + ' hours'
          : span <= 48 ? Math.round(span / 24) + ' day' + (Math.round(span / 24) !== 1 ? 's' : '')
          : Math.round(span / 168) + ' week' + (Math.round(span / 168) !== 1 ? 's' : '');
        html += `<div class="ap-context">Based on <strong>${meta.source_count} sources</strong>`;
        if (nameStr) html += ` from <strong>${nameStr}</strong>`;
        html += ` over the last <strong>${spanStr}</strong></div>`;
      }

      html += `<div class="ap-content"><h2 style="font-size:1.3rem;">Full Analysis</h2>`;
      html += mdBlock(a.full_content.trim(), refs);
      html += `</div>`;

      if (refs.length) {
        html += `<div class="ap-sources"><h3>Sources</h3><ul>`;
        refs.forEach((r, i) => {
          const title = escHtml(r.title || 'Article');
          const source = r.source ? ` <span class="ref-origin">— ${escHtml(r.source)}</span>` : '';
          const link = r.source_url ? `<a href="${escHtml(r.source_url)}" target="_blank" rel="noopener">${title}</a>` : title;
          html += `<li><span class="ref-num">[${i + 1}]</span> ${link}${source}</li>`;
        });
        html += `</ul></div>`;
      }

    } else {
      // Curated article — summary + CTA
      if (a.summary) {
        html += `<div class="ap-summary">`;
        html += `<p>${escHtml(a.summary)}</p>`;
        html += `<p class="ap-summary-note">${a.embed_url ? 'Watch the full video on YouTube.' : 'Source: ' + escHtml(a.source || 'Source') + '. Click below to read the full article.'}</p>`;
        html += `</div>`;
      }

      if (a.source_url || a.embed_url) {
        html += `<div style="text-align:center;">`;
        html += `<a class="ap-cta" href="${escHtml(a.source_url || a.embed_url || '#')}" target="_blank" rel="noopener noreferrer">`;
        html += a.embed_url ? 'Watch on YouTube →' : `Read Full Article on ${escHtml(a.source || 'Source')} →`;
        html += `</a></div>`;
      }
    }

    html += '</div></div>';

    document.getElementById('articlePreviewBody').innerHTML = html;

    // Footer links
    const liveLink = document.getElementById('previewLiveLink');
    const sourceLink = document.getElementById('previewSourceLink');

    const siteBase = getSiteBase();
    if (a.is_published && slug) {
      liveLink.href = `${siteBase}/article/${slug}`;
      liveLink.style.display = '';
    } else {
      liveLink.style.display = 'none';
    }

    if (a.source_url) {
      sourceLink.href = a.source_url;
      sourceLink.style.display = '';
    } else {
      sourceLink.style.display = 'none';
    }

    openModal('articlePreviewModal');
  }

  async function bulkGenerateImages() {
    const ids = [...selectedIds].filter(id => {
      const a = articles.find(x => x.id === id);
      return a && !a.is_archived;
    });
    if (!ids.length) return;
    showAlert(`Generating images for ${ids.length} article(s)… this may take a while.`);
    let done = 0, failed = 0;
    for (const id of ids) {
      const cell = document.getElementById(`img-cell-${id}`);
      if (cell) cell.innerHTML = '<span class="badge badge-muted" style="font-size:10px;">⏳</span>';
      try {
        await apiFetch('/media/generate-image', { method: 'POST', body: JSON.stringify({ articleId: id }) });
        done++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 500)); // small delay between calls
    }
    selectedIds.clear();
    showAlert(`Images generated: ${done} ✓${failed ? `, ${failed} failed` : ''}`);
    await loadArticles({ preservePage: true });
  }

  /* ---------- Recategorize helpers ---------- */
  let _recategorizePendingParams = null;

  function renderRecategorizePreview(data) {
    const el = document.getElementById('recategorizePreview');
    if (!data || data.updated === 0) {
      el.innerHTML = '<p style="color:var(--muted);">All articles are already correctly categorized. No changes needed.</p>';
      document.getElementById('confirmRecategorizeBtn').style.display = 'none';
      return;
    }
    document.getElementById('confirmRecategorizeBtn').style.display = '';
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

  async function showRecategorizePreview(params) {
    _recategorizePendingParams = params;
    const el = document.getElementById('recategorizePreview');
    el.innerHTML = '<p style="color:var(--muted);">Analyzing articles…</p>';
    document.getElementById('confirmRecategorizeBtn').style.display = 'none';
    openModal('recategorizeModal');
    // Clear pending params when modal is dismissed via Cancel/X
    document.querySelectorAll('#recategorizeModal [data-close-modal]').forEach(el => {
      el.addEventListener('click', () => { _recategorizePendingParams = null; }, { once: true });
    });
    try {
      const data = await apiFetch('/fetch/recategorize', {
        method: 'POST',
        body: JSON.stringify({ ...params, dryRun: true }),
      });
      renderRecategorizePreview(data);
    } catch (err) {
      el.innerHTML = `<p style="color:var(--danger);">Preview failed: ${err.message}</p>`;
    }
  }

  async function confirmRecategorize() {
    if (!_recategorizePendingParams) return;
    const btn = document.getElementById('confirmRecategorizeBtn');
    btn.disabled = true; btn.textContent = 'Applying…';
    try {
      const data = await apiFetch('/fetch/recategorize', {
        method: 'POST',
        body: JSON.stringify({ ..._recategorizePendingParams, dryRun: false }),
      });
      closeModal('recategorizeModal');
      const writerMsg = data.writerReassignments ? `, ${data.writerReassignments} writer(s) reassigned` : '';
      showAlert(`Re-categorized ${data.updated} of ${data.total} articles${writerMsg}`);
      selectedIds.clear();
      await loadArticles({ preservePage: true });
    } catch (err) {
      showAlert('Re-categorize failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Apply Changes';
      _recategorizePendingParams = null;
    }
  }

  async function bulkRecategorize() {
    const ids = [...selectedIds].filter(id => {
      const a = articles.find(x => x.id === id);
      return a && !a.is_archived;
    });
    if (!ids.length) { showAlert('No non-archived articles selected', 'error'); return; }
    await showRecategorizePreview({ articleIds: ids });
  }

  async function recategorizeAll() {
    const params = {};
    // Scope by active date filter
    if (dateFilter === '24h') params.days = 1;
    else if (dateFilter === '7d') params.days = 7;
    else if (dateFilter === '30d') params.days = 30;
    await showRecategorizePreview(params);
  }

  /* ---------- Audio helpers ---------- */
  function renderAudioCell(a) {
    const status = a.audio_status;
    if (!status) return '—';
    if (status === 'error') {
      return '<span class="badge badge-danger" style="font-size:10px;">Error</span>';
    }
    if (status === 'pending') {
      return `<span class="badge badge-muted" style="font-size:11px;">⏳ Generating…</span>`;
    }
    if (status === 'ready' && a.audio_url) {
      const enabled = !!a.media_enabled;
      return `
        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
          <audio id="ap-${a.id}" src="${a.audio_url}" preload="none" style="display:none;"></audio>
          <button class="btn btn-ghost btn-sm btn-icon" title="Preview audio"
            onclick="previewAudio(${a.id})">▶️</button>
          <button class="btn btn-ghost btn-sm btn-icon" title="Remove audio"
            onclick="deleteAudio(${a.id})">🗑️</button>
          <button class="badge ${enabled ? 'badge-accent' : 'badge-muted'}"
            style="cursor:pointer;border:none;background:inherit;font-size:11px;"
            title="${enabled ? 'Published on site — click to hide' : 'Hidden — click to publish on site'}"
            onclick="toggleMedia(${a.id})">
            ${enabled ? '✅ On' : '⬜ Off'}
          </button>
        </div>`;
    }
    return '—';
  }

  async function generateAudio(id) {
    const cell = document.getElementById(`audio-cell-${id}`);
    if (cell) cell.innerHTML = '<span class="badge badge-muted" style="font-size:11px;">⏳ Generating…</span>';
    try {
      const data = await apiFetch('/media/generate-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId: id })
      });
      showAlert(`Audio ready (${data.charCount} chars)${data.voiceName ? ' — ' + data.voiceName : ''}`);
      await loadArticles({ preservePage: true });
    } catch (err) {
      showAlert('Audio generation failed: ' + err.message, 'error');
      await loadArticles({ preservePage: true });
    }
  }

  async function generateImage(id) {
    const btn = document.querySelector(`#row-${id} [title="Generate AI image"]`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      await apiFetch('/media/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId: id })
      });
      showAlert('Image generated ✓');
      await loadArticles({ preservePage: true });
    } catch (err) {
      showAlert('Image generation failed: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🎨'; }
    }
  }

  async function generateFollowups(id) {
    try {
      showAlert('Generating follow-up Q&As…');
      const data = await apiFetch(`/articles/${id}/generate-followups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      showAlert('Generated ' + (data.followups?.length || 0) + ' follow-ups ✓', 'success');
      await loadArticles({ preservePage: true });
    } catch (err) {
      showAlert('Follow-up generation failed: ' + (err.message || 'Unknown error'), 'error');
    }
  }

  async function regenerateArticle(id) {
    if (!confirm('Regenerate this article from its sources? The current content will be replaced.')) return;
    try {
      showAlert('Regenerating article…');
      const data = await apiFetch(`/articles/${id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      showAlert('Article regenerated: ' + (data.title || '✓'), 'success');
      await loadArticles({ preservePage: true });
    } catch (err) {
      showAlert('Regeneration failed: ' + (err.message || 'Unknown error'), 'error');
    }
  }

  // Image upload/clear helpers
  function setImageField(url) {
    document.getElementById('fImageUrl').value = url || '';
    var status = document.getElementById('fImageStatus');
    var clearBtn = document.getElementById('fImageClearBtn');
    if (url) {
      var name = url.split('/').pop();
      status.textContent = name;
      status.title = url;
      clearBtn.style.display = '';
    } else {
      status.textContent = 'No image';
      status.title = '';
      clearBtn.style.display = 'none';
    }
  }

  document.getElementById('fImageUploadBtn').addEventListener('click', function() {
    document.getElementById('fImageUpload').click();
  });
  document.getElementById('fImageClearBtn').addEventListener('click', function() {
    setImageField('');
  });
  document.getElementById('fImageUpload').addEventListener('change', async function() {
    var file = this.files[0];
    if (!file) return;
    var btn = document.getElementById('fImageUploadBtn');
    var origText = btn.textContent;
    btn.textContent = 'Uploading\u2026';
    btn.style.pointerEvents = 'none';
    try {
      var form = new FormData();
      form.append('image', file);
      var token = getToken();
      var res = await fetch('/api/media/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: form,
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setImageField(data.imageUrl);
      showToast('Image uploaded');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.textContent = origText;
      btn.style.pointerEvents = '';
      this.value = '';
    }
  });

  function previewAudio(id) {
    const el = document.getElementById(`ap-${id}`);
    if (!el) return;
    if (el.paused) { el.play(); }
    else { el.pause(); el.currentTime = 0; }
  }

  async function deleteAudio(id) {
    try {
      await apiFetch(`/media/audio/${id}`, { method: 'DELETE' });
      showAlert('Audio removed');
      await loadArticles({ preservePage: true });
    } catch (err) {
      showAlert('Failed to remove audio: ' + err.message, 'error');
    }
  }

  async function toggleMedia(id) {
    try {
      const data = await apiFetch(`/media/toggle/${id}`, { method: 'PUT' });
      showAlert(data.media_enabled ? 'Audio published on site ✓' : 'Audio hidden from site');
      await loadArticles({ preservePage: true });
    } catch (err) {
      showAlert('Toggle failed: ' + err.message, 'error');
    }
  }

  // ── Inline edit ────────────────────────────────────────────────────────────
  async function startInlineEdit(id, field) {
    const a = articles.find(x => x.id === id);
    if (!a) return;

    if (field === 'title') {
      const td = document.querySelector(`#row-${id} .td-title`);
      if (!td || td.querySelector('input')) return;
      const original = a.title || '';
      td.innerHTML = `<input class="inline-edit-input" type="text" value="${escHtml(original)}" />`;
      const input = td.querySelector('input');
      input.focus(); input.select();
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); input._done = true; commitInlineEdit(id, 'title', input.value.trim(), original); }
        if (e.key === 'Escape') { input._done = true; cancelInlineEdit(id); }
      });
      input.addEventListener('blur', () => {
        if (input._done) return;
        const val = input.value.trim();
        if (val && val !== original) commitInlineEdit(id, 'title', val, original);
        else cancelInlineEdit(id);
      });
    }

    if (field === 'category') {
      const td = document.querySelector(`#row-${id} .td-category`);
      if (!td || td.querySelector('select')) return;
      const original = a.category || 'Industry';
      const cats = window._siteCategories.length ? window._siteCategories : ['Industry'];
      const opts = cats.map(c =>
        `<option value="${c}"${c === original ? ' selected' : ''}>${c}</option>`
      ).join('');
      td.innerHTML = `<select class="inline-edit-select">${opts}</select>`;
      const select = td.querySelector('select');
      select.focus();
      select.addEventListener('change', () => { select._done = true; commitInlineEdit(id, 'category', select.value, original); });
      select.addEventListener('blur',   () => { if (!select._done) cancelInlineEdit(id); });
      select.addEventListener('keydown', e => { if (e.key === 'Escape') { select._done = true; cancelInlineEdit(id); } });
    }
  }

  async function commitInlineEdit(id, field, value, original) {
    if (!value || value === original) return cancelInlineEdit(id);
    const rollback = updateArticleRow(id, { [field]: value });
    try {
      const updated = await apiFetch(`/articles/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ [field]: value })
      });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx !== -1) Object.assign(allArticles[idx], updated);
      rerenderRow(id);
      showAlert(`${field === 'title' ? 'Title' : 'Category'} updated ✓`);
    } catch (err) {
      rollback();
      showAlert('Update failed: ' + err.message, 'error');
    }
  }

  function cancelInlineEdit(id) {
    rerenderRow(id);
  }

  async function loadWriters() {
    try {
      writersList = await apiFetch('/writers');
    } catch { writersList = []; }
  }

  function populateWriterSelect(selectedId) {
    const sel = document.getElementById('fWriter');
    sel.innerHTML = '<option value="">Unassigned</option>' +
      writersList.map(w => `<option value="${w.id}"${w.id === selectedId ? ' selected' : ''}>${escHtml(w.name)}</option>`).join('');
  }

  async function loadArticles({ preservePage = false } = {}) {
    const tbody = document.getElementById('articlesBody');
    if (!preservePage && tbody) tbody.innerHTML = skeletonRows(['sk-w-sm','sk-w-full','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm'], 5);
    try {
      await loadWriters();
      // Fetch all articles by paginating through the API (max 500 per request)
      const PAGE_SIZE = 500;
      let all = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const data = await apiFetch(`/articles?type=editorial&limit=${PAGE_SIZE}&offset=${offset}`);
        const batch = Array.isArray(data) ? data : (data.articles || []);
        all = all.concat(batch);
        hasMore = data.hasMore === true;
        offset += batch.length;
        if (!batch.length) break;
      }
      allArticles = all;
      applyFilters({ preservePage });
    } catch (err) {
      showAlert('Failed to load articles: ' + err.message, 'error');
    }
  }

  function openAdd() {
    document.getElementById('modalTitle').textContent = 'Add Article';
    document.getElementById('editId').value = '';
    document.getElementById('fAutoUrl').value = '';
    document.getElementById('autoFillStatus').textContent = '';
    document.getElementById('fTitle').value = '';
    document.getElementById('fSummary').value = '';
    document.getElementById('fCategory').innerHTML = categoryOptions('Industry');
    document.getElementById('fAuthor').value = '';
    document.getElementById('fSource').value = '';
    document.getElementById('fSourceUrl').value = '';
    setImageField('');
    document.getElementById('fPublished').checked = true;
    document.getElementById('fFeatured').value = '0';
    populateWriterSelect(null);
    openModal('articleModal');
    document.getElementById('fAutoUrl').focus();
  }

  // Auto-fill form from URL
  document.getElementById('autoFillBtn').addEventListener('click', async () => {
    const url    = document.getElementById('fAutoUrl').value.trim();
    const status = document.getElementById('autoFillStatus');
    const btn    = document.getElementById('autoFillBtn');
    if (!url) return;

    btn.disabled = true;
    btn.textContent = 'Fetching…';
    status.textContent = '';
    status.className = 'autofill-status';

    try {
      const data = await apiFetch('/fetch-url?url=' + encodeURIComponent(url));

      // Populate fields — only overwrite if currently empty
      const set = (id, val) => { if (val) document.getElementById(id).value = val; };
      set('fTitle',     data.title);
      set('fSummary',   data.summary);
      set('fSource',    data.source);
      set('fSourceUrl', data.source_url);
      setImageField(data.image || '');
      set('fAuthor',    data.author);
      if (data.category) document.getElementById('fCategory').innerHTML = categoryOptions(data.category);

      status.textContent = '✅ Fields populated — review and edit as needed.';
      status.className   = 'autofill-status success';
    } catch (err) {
      status.textContent = '❌ ' + err.message;
      status.className   = 'autofill-status error';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fetch';
    }
  });

  // Also trigger on Enter in the URL field
  document.getElementById('fAutoUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('autoFillBtn').click(); }
  });

  function openEdit(id) {
    const a = articles.find(x => x.id === id);
    if (!a) return;
    document.getElementById('modalTitle').textContent = 'Edit Article';
    document.getElementById('editId').value = a.id;
    document.getElementById('fTitle').value = a.title || '';
    document.getElementById('fSummary').value = a.summary || '';
    document.getElementById('fCategory').innerHTML = categoryOptions(a.category);
    document.getElementById('fAuthor').value = a.author || '';
    document.getElementById('fSource').value = a.source || '';
    document.getElementById('fSourceUrl').value = a.source_url || '';
    setImageField(a.image_url || '');
    document.getElementById('fPublished').checked = !!a.is_published;
    document.getElementById('fFeatured').value = a.is_featured ? (a.featured_priority || 1) : 0;
    populateWriterSelect(a.writer_id || null);
    openModal('articleModal');
    document.getElementById('fTitle').focus();
  }

  function openDelete(id) {
    deleteTargetId = id;
    openModal('deleteModal');
  }

  async function saveArticle() {
    const id    = document.getElementById('editId').value;
    const title = document.getElementById('fTitle').value.trim();
    if (!title) { showAlert('Title is required', 'error'); return; }

    const payload = {
      title,
      summary   : document.getElementById('fSummary').value.trim() || null,
      category  : document.getElementById('fCategory').value,
      author    : document.getElementById('fAuthor').value.trim() || null,
      source    : document.getElementById('fSource').value.trim() || null,
      source_url: document.getElementById('fSourceUrl').value.trim() || null,
      image_url : document.getElementById('fImageUrl').value.trim() || null,
      is_published: document.getElementById('fPublished').checked,
      is_featured       : parseInt(document.getElementById('fFeatured').value) > 0,
      featured_priority : parseInt(document.getElementById('fFeatured').value) || null,
    };

    const writerVal = document.getElementById('fWriter').value;
    const writerId = writerVal ? parseInt(writerVal) : null;

    const saveBtn = document.getElementById('saveArticleBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      if (id) {
        // Edit: optimistic update + close modal immediately
        const rollback = updateArticleRow(parseInt(id), { ...payload, writer_id: writerId });
        closeModal('articleModal');
        try {
          const saved = await apiFetch(`/articles/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
          await apiFetch(`/articles/${id}/assign-writer`, { method: 'PUT', body: JSON.stringify({ writerId }) });
          const idx = allArticles.findIndex(x => x.id === parseInt(id));
          if (idx !== -1) Object.assign(allArticles[idx], saved, { writer_id: writerId });
          rerenderRow(parseInt(id));
          showAlert('Article updated ✓');
        } catch (err) {
          rollback();
          showAlert('Error: ' + err.message, 'error');
        }
      } else {
        // Create: wait for API, then reload with page preserved
        const saved = await apiFetch('/articles', { method: 'POST', body: JSON.stringify(payload) });
        if (saved && saved.id) {
          await apiFetch(`/articles/${saved.id}/assign-writer`, { method: 'PUT', body: JSON.stringify({ writerId }) });
        }
        closeModal('articleModal');
        showAlert('Article created ✓');
        await loadArticles({ preservePage: true });
      }
    } catch (err) {
      showAlert('Error: ' + err.message, 'error');
    }
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Article';
  }

  async function confirmDelete() {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    selectedIds.delete(id);
    closeModal('deleteModal');
    deleteTargetId = null;

    // Optimistic: patch as archived and remove from view
    const idx = allArticles.findIndex(x => x.id === id);
    const snapshot = idx !== -1 ? { ...allArticles[idx] } : null;
    if (idx !== -1) Object.assign(allArticles[idx], { is_archived: 1, is_published: 0, is_featured: 0, featured_priority: null, status: 'archived' });
    if (!showArchived && statusFilter !== 'archived') {
      removeArticleRow(id);
    } else {
      rerenderRow(id);
    }

    try {
      await apiFetch(`/articles/${id}`, { method: 'DELETE' });
      showAlert('Article archived — will be purged automatically after 24h');
    } catch (err) {
      // Rollback
      if (snapshot && idx !== -1) Object.assign(allArticles[idx], snapshot);
      applyFilters({ preservePage: true });
      showAlert('Archive failed: ' + err.message, 'error');
    }
  }

  let purgeTargetId = null;
  function openPurge(id) {
    purgeTargetId = id;
    openModal('purgeModal');
  }

  async function confirmPurge() {
    if (!purgeTargetId) return;
    const id = purgeTargetId;
    selectedIds.delete(id);
    closeModal('purgeModal');
    purgeTargetId = null;

    // Optimistic: remove from allArticles and DOM
    const idx = allArticles.findIndex(x => x.id === id);
    const snapshot = idx !== -1 ? allArticles.splice(idx, 1)[0] : null;
    removeArticleRow(id);

    try {
      await apiFetch(`/articles/${id}/purge`, { method: 'DELETE' });
      showAlert('Article permanently deleted');
    } catch (err) {
      // Rollback: re-insert into allArticles and re-render
      if (snapshot) allArticles.push(snapshot);
      applyFilters({ preservePage: true });
      showAlert('Purge failed: ' + err.message, 'error');
    }
  }

  async function restoreArticle(id) {
    const rollback = updateArticleRow(id, { is_archived: 0, status: 'draft', archived_at: null });
    try {
      const result = await apiFetch(`/articles/${id}/restore`, { method: 'PUT' });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx !== -1) Object.assign(allArticles[idx], result);
      rerenderRow(id);
      showAlert('Article restored ✓');
    } catch (err) {
      rollback();
      showAlert('Restore failed: ' + err.message, 'error');
    }
  }

  async function togglePublish(id) {
    const a = allArticles.find(x => x.id === id);
    if (!a) return;
    const newVal = a.is_published ? 0 : 1;
    const newStatus = newVal ? 'published' : 'draft';
    const rollback = updateArticleRow(id, { is_published: newVal, status: newStatus });
    try {
      const result = await apiFetch(`/articles/${id}/publish`, { method: 'PUT' });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx !== -1) Object.assign(allArticles[idx], result);
      rerenderRow(id);
    } catch (err) {
      rollback();
      showAlert('Error: ' + err.message, 'error');
    }
  }

  async function approveArticle(id) {
    const rollback = updateArticleRow(id, { status: 'published', is_published: 1, is_archived: 0 });
    // If on review tab, article will leave the filtered view
    if (activeTab === 'review') {
      removeArticleRow(id);
    }
    try {
      const result = await apiFetch(`/articles/${id}/approve`, { method: 'PUT' });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx !== -1) Object.assign(allArticles[idx], result);
      showAlert('Article approved and published', 'success');
    } catch (err) {
      rollback();
      if (activeTab === 'review') applyFilters({ preservePage: true });
      showAlert('Error: ' + err.message, 'error');
    }
  }

  async function rejectArticle(id) {
    const rollback = updateArticleRow(id, { status: 'draft', is_published: 0, is_archived: 0 });
    if (activeTab === 'review') {
      removeArticleRow(id);
    }
    try {
      const result = await apiFetch(`/articles/${id}/reject`, { method: 'PUT' });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx !== -1) Object.assign(allArticles[idx], result);
      showAlert('Article rejected — moved back to drafts', 'info');
    } catch (err) {
      rollback();
      if (activeTab === 'review') applyFilters({ preservePage: true });
      showAlert('Error: ' + err.message, 'error');
    }
  }

  async function submitForReview(id) {
    const rollback = updateArticleRow(id, { status: 'review' });
    if (activeTab === 'drafts') {
      removeArticleRow(id);
    }
    try {
      const result = await apiFetch(`/articles/${id}/submit-review`, { method: 'PUT' });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx !== -1) Object.assign(allArticles[idx], result);
      showAlert('Article submitted for review', 'success');
    } catch (err) {
      rollback();
      if (activeTab === 'drafts') applyFilters({ preservePage: true });
      showAlert('Error: ' + err.message, 'error');
    }
  }

  async function setFeaturedPriority(id, priority) {
    const p = parseInt(priority);
    const rollback = updateArticleRow(id, {
      is_featured: p > 0 ? 1 : 0,
      featured_priority: p || null
    });
    try {
      const result = await apiFetch(`/articles/${id}/feature`, {
        method: 'PUT',
        body: JSON.stringify({ priority: p || null }),
      });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx !== -1) Object.assign(allArticles[idx], result);
      rerenderRow(id);
    } catch (err) {
      rollback();
      showAlert('Error: ' + err.message, 'error');
    }
  }

  // ── Bulk actions ────────────────────────────────────────────────────────────
  async function bulkSetPublish(val) {
    const ids = [...selectedIds];
    if (!ids.length) return;
    let done = 0;
    for (const id of ids) {
      const a = articles.find(x => x.id === id);
      if (a && a.is_published !== val) {
        await apiFetch(`/articles/${id}/publish`, { method: 'PUT' });
        done++;
      }
    }
    selectedIds.clear();
    showAlert(`${done} article(s) ${val ? 'published' : 'unpublished'} ✓`);
    await loadArticles({ preservePage: true });
  }

  async function bulkDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} article(s)? This cannot be undone.`)) return;
    let done = 0;
    for (const id of ids) {
      try { await apiFetch(`/articles/${id}`, { method: 'DELETE' }); done++; } catch {}
    }
    selectedIds.clear();
    showAlert(`${done} article(s) deleted`);
    await loadArticles({ preservePage: true });
  }

  async function bulkAutoAssignWriters() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const unassigned = ids.filter(id => {
      const a = allArticles.find(x => x.id === id);
      return a && !a.writer_id;
    });
    if (!unassigned.length) {
      showAlert('All selected articles already have writers assigned', 'error');
      return;
    }
    try {
      const result = await apiFetch('/articles/bulk-assign-writer', {
        method: 'POST',
        body: JSON.stringify({ articleIds: unassigned })
      });
      selectedIds.clear();
      showAlert(`${result.assigned} article(s) assigned to writers` + (result.skipped ? `, ${result.skipped} skipped` : ''));
      await loadArticles({ preservePage: true });
    } catch (err) {
      showAlert('Auto-assign failed: ' + err.message, 'error');
    }
  }

  onReady(async () => {
    if (!requireAuth()) return;
    renderSidebar();
    initModals();

    // Load feature flags so media buttons can be gated
    await loadAdminFeatures();

    if (hasPermission('articles.create')) {
      const writeBtn = document.getElementById('writeArticleBtn');
      if (writeBtn) writeBtn.style.display = '';
    }
    if (!hasPermission('articles.create')) {
      const addBtn = document.getElementById('addArticleBtn');
      if (addBtn) addBtn.style.display = 'none';
    }
    if (!hasPermission('articles.delete')) {
      const delBtn = document.getElementById('bulkDeleteBtn');
      if (delBtn) delBtn.style.display = 'none';
    }

    document.getElementById('fCategory').innerHTML = categoryOptions('Industry');
    document.getElementById('addArticleBtn').addEventListener('click', openAdd);

    // ── Export dropdown ──────────────────────────────────────────────────────
    const exportBtn  = document.getElementById('exportBtn');
    const exportMenu = document.getElementById('exportMenu');

    exportBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.style.display = exportMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { if (exportMenu) exportMenu.style.display = 'none'; });

    document.querySelectorAll('.export-option').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        exportMenu.style.display = 'none';
        const format = link.dataset.format;
        const token  = localStorage.getItem('deepfeedai_token');
        const params = new URLSearchParams({ format });
        // Trigger download via hidden anchor with Authorization header workaround:
        // fetch → blob → object URL
        const url = `/api/articles/export?${params.toString()}`;
        fetch(url, { headers: { Authorization: `Bearer ${token}` } })
          .then(r => {
            if (!r.ok) return r.json().then(d => { throw new Error(d.error || 'Export failed'); });
            return r.blob();
          })
          .then(blob => {
            const ts = new Date().toISOString().slice(0, 10);
            const filename = `articles-${ts}.${format}`;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
          })
          .catch(err => showAlert('Export failed: ' + err.message, 'error'));
      });
    });
    // Purge dropdown
    const purgeArticlesBtn = document.getElementById('purgeArticlesBtn');
    const purgeMenu        = document.getElementById('purgeMenu');
    purgeArticlesBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      purgeMenu.style.display = purgeMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { if (purgeMenu) purgeMenu.style.display = 'none'; });
    document.querySelectorAll('.purge-option').forEach(link => {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        purgeMenu.style.display = 'none';
        const type = link.dataset.type;
        const label = type === 'all' ? 'ALL articles' : `all ${type} articles`;
        if (!confirm(`⚠️ Permanently delete ${label}? This cannot be undone.`)) return;
        try {
          const data = await apiFetch(`/articles/purge-all?type=${type}`, { method: 'DELETE' });
          showAlert(`Deleted ${data.deleted} ${type} article${data.deleted !== 1 ? 's' : ''}`, 'success');
          await loadArticles({ preservePage: true });
        } catch (err) {
          showAlert('Purge failed: ' + err.message, 'error');
        }
      });
    });

    document.getElementById('saveArticleBtn').addEventListener('click', saveArticle);
    document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
    document.getElementById('confirmPurgeBtn').addEventListener('click', confirmPurge);

    document.getElementById('showArchived').addEventListener('change', e => {
      showArchived = e.target.checked;
      selectedIds.clear();
      applyFilters();
    });

    // View toggle
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        viewMode = btn.dataset.view;
        localStorage.setItem('dfa_articles_view', viewMode);
        applyViewMode();
      });
    });

    // Sortable column headers
    document.querySelectorAll('.sortable').forEach(th => {
      th.addEventListener('click', () => sortArticles(th.dataset.col));
    });

    // Select all checkbox
    document.getElementById('selectAll').addEventListener('change', e => {
      if (e.target.checked) {
        articles.forEach(a => selectedIds.add(a.id));
      } else {
        selectedIds.clear();
      }
      renderTable();
    });

    // Bulk toolbar buttons
    document.getElementById('bulkPublishBtn').addEventListener('click', () => bulkSetPublish(1));
    document.getElementById('bulkUnpublishBtn').addEventListener('click', () => bulkSetPublish(0));
    document.getElementById('bulkImagesBtn').addEventListener('click', bulkGenerateImages);
    if (!isFeatureOn('image_generation')) {
      var bulkImgBtn = document.getElementById('bulkImagesBtn');
      if (bulkImgBtn) { bulkImgBtn.disabled = true; bulkImgBtn.title = 'Image generation not available on your plan'; }
    }
    document.getElementById('bulkRecategorizeBtn').addEventListener('click', bulkRecategorize);
    document.getElementById('bulkDeleteBtn').addEventListener('click', bulkDelete);
    document.getElementById('bulkAssignWriterBtn').addEventListener('click', bulkAutoAssignWriters);
    document.getElementById('recategorizeAllBtn').addEventListener('click', recategorizeAll);
    document.getElementById('confirmRecategorizeBtn').addEventListener('click', confirmRecategorize);
    document.getElementById('bulkClearBtn').addEventListener('click', () => {
      selectedIds.clear();
      renderTable();
    });

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.tab;
        selectedIds.clear();
        // Show/hide "Show archived" — only relevant in All tab
        const archivedWrap = document.getElementById('showArchivedWrap');
        if (archivedWrap) archivedWrap.style.display = (activeTab === 'published' || activeTab === 'drafts' || activeTab === 'review') ? 'none' : 'flex';
        // Reset search when switching tabs
        searchQuery = '';
        document.getElementById('articleSearch').value = '';
        document.getElementById('clearSearch').style.display = 'none';
        applyFilters();
      });
    });

    // Search input
    let _searchDebounce;
    document.getElementById('articleSearch').addEventListener('input', e => {
      searchQuery = e.target.value.trim();
      const clearBtn = document.getElementById('clearSearch');
      if (clearBtn) clearBtn.style.display = searchQuery ? 'inline-flex' : 'none';
      clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(applyFilters, 250);
    });
    document.getElementById('clearSearch').addEventListener('click', () => {
      searchQuery = '';
      document.getElementById('articleSearch').value = '';
      document.getElementById('clearSearch').style.display = 'none';
      applyFilters();
    });

    // Filter dropdowns
    document.getElementById('statusFilter').addEventListener('change', e => {
      statusFilter = e.target.value;
      applyFilters();
    });
    document.getElementById('audioFilter').addEventListener('change', e => {
      audioFilter = e.target.value;
      applyFilters();
    });
    document.getElementById('dateFilter').addEventListener('change', e => {
      dateFilter = e.target.value;
      applyFilters();
    });
    document.getElementById('writerFilter').addEventListener('change', e => {
      writerFilter = e.target.value;
      applyFilters();
    });
    document.getElementById('contentTypeFilter').addEventListener('change', e => {
      contentTypeFilter = e.target.value;
      applyFilters();
    });

    await loadCategories();

    // Build category filter options dynamically
    const catSelect = document.getElementById('categoryFilter');
    const catGroup = document.getElementById('categoryFilterGroup');
    if (catSelect && window._siteCategories.length) {
      const uncatOpt = document.createElement('option');
      uncatOpt.value = 'uncategorized';
      uncatOpt.textContent = 'Uncategorized';
      catSelect.appendChild(uncatOpt);
      window._siteCategories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        catSelect.appendChild(opt);
      });
      catGroup.style.display = '';
      catSelect.addEventListener('change', e => {
        categoryFilter = e.target.value;
        applyFilters();
      });
    }

    await loadArticles();

    // Activate tab from URL hash (e.g. #review, #drafts)
    const hashTab = location.hash.replace('#', '');
    if (hashTab && ['all', 'published', 'drafts', 'review'].includes(hashTab)) {
      activeTab = hashTab;
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === hashTab);
      });
      const archivedWrap = document.getElementById('showArchivedWrap');
      if (archivedWrap) archivedWrap.style.display = (hashTab === 'published' || hashTab === 'drafts' || hashTab === 'review') ? 'none' : 'flex';
      applyFilters();
    }

    // Build writer filter options dynamically (after loadArticles populates writersList)
    const writerSelect = document.getElementById('writerNameFilter');
    const writerGroup = document.getElementById('writerNameFilterGroup');
    if (writerSelect && writersList.length) {
      writersList.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.id;
        opt.textContent = w.name;
        writerSelect.appendChild(opt);
      });
      writerGroup.style.display = '';
      writerSelect.addEventListener('change', e => {
        writerNameFilter = e.target.value;
        applyFilters();
      });
    }

    // ── Keyboard navigation ──────────────────────────────
    let focusedRowId = null;

    function getFocusableRows() {
      return [...document.querySelectorAll('#articlesBody tr[id^="row-"]')];
    }

    function setFocusedRow(id) {
      document.querySelectorAll('#articlesBody tr.kb-focus').forEach(r => r.classList.remove('kb-focus'));
      focusedRowId = id;
      if (id != null) {
        const row = document.getElementById(`row-${id}`);
        if (row) { row.classList.add('kb-focus'); row.scrollIntoView({ block: 'nearest' }); }
      }
    }

    document.addEventListener('keydown', e => {
      if (isInputFocused()) return;
      const rows = getFocusableRows();
      if (!rows.length) return;

      if (e.key === '?') {
        showKbdHelp([
          { key: 'j / ↓', desc: 'Next row' },
          { key: 'k / ↑', desc: 'Previous row' },
          { key: 'e',      desc: 'Edit focused article' },
          { key: 'd',      desc: 'Archive focused article' },
          { key: '?',      desc: 'Toggle this help' },
        ]);
        return;
      }

      const ids = rows.map(r => parseInt(r.id.replace('row-', '')));
      const idx = focusedRowId != null ? ids.indexOf(focusedRowId) : -1;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedRow(ids[Math.min(idx + 1, ids.length - 1)]);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedRow(ids[Math.max(idx - 1, 0)]);
      } else if (e.key === 'e' && focusedRowId != null) {
        openEdit(focusedRowId);
      } else if (e.key === 'd' && focusedRowId != null) {
        openDelete(focusedRowId);
      }
    });
  });