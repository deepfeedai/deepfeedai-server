/**
 * Feed Inbox — curated/source articles management.
 * Stripped-down view for triaging RSS-ingested source material.
 */
(function () {
  let allArticles = [];
  let articles = [];
  let sortCol = 'created_at';
  let sortDir = 'desc';
  let selectedIds = new Set();
  let searchQuery = '';
  let sourceFilter = 'all';
  let categoryFilter = 'all';
  let dateFilter = 'all';
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
    const anyFilter = searchQuery || sourceFilter !== 'all' || categoryFilter !== 'all' || dateFilter !== 'all';
    if (countEl) {
      countEl.textContent = anyFilter ? `${filtered.length} of ${allArticles.length}` : `${filtered.length} articles`;
      countEl.classList.toggle('filter-count-active', anyFilter);
    }

    renderTable();
  }

  // ── Render ───────────────────────────────────────────────

  function renderRowHtml(a) {
    const rowClass = selectedIds.has(a.id) ? 'row-selected' : '';
    return `
    <tr id="row-${a.id}" class="${rowClass}">
      <td class="td-check">
        <input type="checkbox" class="row-check" data-id="${a.id}" ${selectedIds.has(a.id) ? 'checked' : ''} />
      </td>
      <td class="td-title" title="${escHtml(a.title)}">
        <span>${escHtml(a.title)}</span>
      </td>
      <td class="text-muted text-sm">${escHtml(a.source || '—')}</td>
      <td class="td-category">
        <span class="badge badge-muted">${escHtml(a.category || '—')}</span>
      </td>
      <td class="text-center">${a.editorial_score != null
        ? `<span class="badge ${a.editorial_score >= 7 ? 'badge-success' : a.editorial_score >= 5 ? 'badge-warning' : 'badge-danger'}" style="min-width:24px;">${a.editorial_score}</span>`
        : '<span class="text-muted">—</span>'}</td>
      <td class="text-muted text-sm"><span title="${fmtDate(a.created_at)}">${relativeTime(a.created_at)}</span></td>
      <td style="text-align:center;">
        <div style="display:flex;gap:2px;justify-content:center;">
          ${safeUrl(a.source_url) ? `<a class="btn btn-ghost btn-sm" href="${escHtml(safeUrl(a.source_url))}" target="_blank" rel="noopener" title="View source">🔗</a>` : ''}
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
      applyFilters({ preservePage: true });
      showAlert('Article deleted.', 'success');
    } catch (err) {
      showAlert('Delete failed: ' + err.message, 'error');
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

      // Populate source filter
      populateSourceFilter();
      populateCategoryFilter();

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
    sel.innerHTML = '<option value="all">All</option><option value="uncategorized">Uncategorized</option>'
      + cats.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    if (group) group.style.display = '';
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
  document.getElementById('sourceFilter')?.addEventListener('change', e => {
    sourceFilter = e.target.value;
    applyFilters();
  });
  document.getElementById('categoryFilter')?.addEventListener('change', e => {
    categoryFilter = e.target.value;
    applyFilters();
  });
  document.getElementById('dateFilter')?.addEventListener('change', e => {
    dateFilter = e.target.value;
    applyFilters();
  });

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
    showAlert(`Deleted ${deleted} article(s).`, 'success');
    applyFilters({ preservePage: true });
  });

  document.getElementById('bulkClearBtn')?.addEventListener('click', () => {
    selectedIds.clear();
    applyFilters({ preservePage: true });
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
  loadArticles();
})();
