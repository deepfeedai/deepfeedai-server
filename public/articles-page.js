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
  let writerNameFilter = 'all';
  let activeTab   = 'all';
  let artPage     = 1;
  let artPageSize = 25;

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

  function applyFilters() {
    // Update draft count badge regardless of active tab
    const draftCountEl = document.getElementById('draftCount');
    if (draftCountEl) {
      const draftCount = allArticles.filter(a => !a.is_archived && !a.is_published).length;
      draftCountEl.textContent = draftCount || '';
      draftCountEl.style.display = draftCount ? 'inline-flex' : 'none';
    }

    // Drafts tab — override all other filters
    if (activeTab === 'drafts') {
      let filtered = allArticles.filter(a => !a.is_archived && !a.is_published);
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
      artPage = 1;
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

    // 7. Sort
    filtered.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (va == null) va = ''; if (vb == null) vb = '';
      if (['is_published','is_featured'].includes(sortCol)) { va = Number(va); vb = Number(vb); }
      else if (['published_at','created_at'].includes(sortCol)) { va = new Date(va); vb = new Date(vb); }
      else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    articles = filtered;
    artPage = 1;

    // 6. Update count badge
    const countEl = document.getElementById('filterCount');
    if (countEl) {
      const total = (showArchived ? allArticles : allArticles.filter(a => !a.is_archived)).length;
      const isFiltered = searchQuery || audioFilter !== 'all' || dateFilter !== 'all' || statusFilter !== 'all' || categoryFilter !== 'all' || writerNameFilter !== 'all';
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

  function renderTable() {
    const tbody = document.getElementById('articlesBody');
    if (articles.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11">
        <div class="empty-state"><div class="empty-icon">📭</div><p>No articles found — try adjusting filters</p></div>
      </td></tr>`;
      document.getElementById('articlesPagination').innerHTML = '';
      updateBulkToolbar();
      return;
    }

    const pageArticles = articles.slice((artPage - 1) * artPageSize, artPage * artPageSize);

    tbody.innerHTML = pageArticles.map(a => {
      const isArchived = !!a.is_archived;
      const rowClass = [
        selectedIds.has(a.id) ? 'row-selected' : '',
        isArchived ? 'row-archived' : ''
      ].filter(Boolean).join(' ');
      return `
      <tr id="row-${a.id}" class="${rowClass}">
        <td class="td-check">
          <input type="checkbox" class="row-check" data-id="${a.id}" ${selectedIds.has(a.id) ? 'checked' : ''} />
        </td>
        <td class="td-title" title="${escHtml(a.title)}">
          <span class="td-editable-text">${escHtml(a.title)}</span>
          ${isArchived ? ' <span class="badge badge-archived" style="font-size:10px;margin-left:4px;">Archived</span>' : `<button class="td-edit-btn" onclick="startInlineEdit(${a.id},'title')" title="Edit title">✏️</button>`}
        </td>
        <td class="text-muted text-sm">${escHtml(a.source || '—')}</td>
        <td class="td-category">
          ${isArchived
            ? `<span class="badge badge-muted">${escHtml(a.category || '—')}</span>`
            : `<span class="badge badge-muted td-editable-cat" onclick="startInlineEdit(${a.id},'category')" title="Click to change category">${escHtml(a.category || '—')}</span>`}
        </td>
        <td>${isArchived ? '<span class="badge badge-muted">—</span>' : `
          <button class="badge ${a.is_published ? 'badge-success' : 'badge-muted'}"
            style="cursor:pointer;border:none;background:inherit;"
            onclick="togglePublish(${a.id})">
            ${a.is_published ? 'Published' : 'Draft'}
          </button>`}
        </td>
        <td>${isArchived ? '—' : `
          <div class="featured-picker" style="display:flex;align-items:center;gap:4px;">
            <span class="badge ${a.is_featured ? 'badge-accent' : 'badge-muted'}" style="min-width:44px;text-align:center;">
              ${a.is_featured ? (a.featured_priority ? '⭐' + a.featured_priority : '⭐') : '—'}
            </span>
            <select class="featured-priority-select" style="font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;"
              onchange="setFeaturedPriority(${a.id}, this.value)" title="Set featured priority (1=top)">
              <option value="0"  ${!a.is_featured              ? 'selected' : ''}>Off</option>
              <option value="1"  ${a.featured_priority === 1   ? 'selected' : ''}>#1</option>
              <option value="2"  ${a.featured_priority === 2   ? 'selected' : ''}>#2</option>
              <option value="3"  ${a.featured_priority === 3   ? 'selected' : ''}>#3</option>
            </select>
          </div>`}
        </td>
        <td class="text-muted text-sm">${(() => { const w = writersList.find(x => x.id === a.writer_id); return w ? escHtml(w.name) : '<span style="color:var(--muted);">—</span>'; })()}</td>
        <td class="text-muted text-sm"><span title="${fmtDate(a.published_at || a.created_at)}">${relativeTime(a.published_at || a.created_at)}</span></td>
        <td class="td-image" id="img-cell-${a.id}" style="text-align:center;">
          ${isArchived ? '—' : renderImageCell(a)}
        </td>
        <td class="td-audio" id="audio-cell-${a.id}">
          ${isArchived ? '—' : renderAudioCell(a)}
        </td>
        <td class="td-actions">
          ${a.source_url ? `<a class="btn btn-ghost btn-sm btn-icon" href="${escHtml(a.source_url)}" target="_blank" rel="noopener" title="View original article">🔗</a>` : ''}
          ${isArchived ? `
            <button class="btn btn-ghost btn-sm btn-icon" title="Restore" onclick="restoreArticle(${a.id})">♻️</button>
            <button class="btn btn-ghost btn-sm btn-icon" title="Permanently delete" onclick="openPurge(${a.id})">💀</button>
          ` : `
            <button class="btn btn-ghost btn-sm btn-icon" title="Preview" onclick="previewArticle(${a.id})">👁</button>
            ${!a.image_url ? `<button class="btn btn-ghost btn-sm btn-icon" title="Generate AI image" onclick="generateImage(${a.id})">🎨</button>` : ''}
            <button class="btn btn-ghost btn-sm btn-icon" title="Edit" onclick="openEdit(${a.id})">✏️</button>
            <button class="btn btn-ghost btn-sm btn-icon" title="Archive" onclick="openDelete(${a.id})">🗑️</button>
          `}
        </td>
      </tr>`;
    }).join('');

    // Wire up row checkboxes
    tbody.querySelectorAll('.row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.id);
        if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        const row = document.getElementById(`row-${id}`);
        if (row) row.classList.toggle('row-selected', cb.checked);
        updateBulkToolbar();
      });
    });

    updateBulkToolbar();

    renderPagination('articlesPagination', articles.length, artPage, artPageSize,
      (p) => { artPage = p; renderTable(); },
      (s) => { artPageSize = s; artPage = 1; renderTable(); }
    );
  }

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

    let html = '';

    // Hero image
    if (a.image_url) {
      html += `<img src="${escHtml(a.image_url)}" alt="" style="width:100%;max-height:340px;object-fit:cover;display:block;" />`;
    }

    html += `<div style="padding:24px 28px;">`;

    // Status badges
    html += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">`;
    html += `<span class="badge">${escHtml(a.category || 'Industry')}</span>`;
    if (a.is_published) html += `<span class="badge badge-success">Published</span>`;
    else html += `<span class="badge badge-muted">Draft</span>`;
    if (a.is_featured) html += `<span class="badge badge-accent">Featured #${a.featured_priority || '?'}</span>`;
    if (a.content_type === 'original') html += `<span class="badge" style="background:var(--accent);color:#000;">Original</span>`;
    if (a.editorial_score) html += `<span class="badge badge-muted">Score: ${a.editorial_score}/10</span>`;
    html += `</div>`;

    // Title
    html += `<h2 style="margin:0 0 8px;font-size:22px;line-height:1.3;color:var(--text);">${escHtml(a.title)}</h2>`;

    // Meta line
    const metaParts = [];
    if (a.source) metaParts.push(escHtml(a.source));
    if (a.author) metaParts.push(`by ${escHtml(a.author)}`);
    if (writer) metaParts.push(`Writer: ${escHtml(writer.name)}`);
    if (fmtPubDate) metaParts.push(fmtPubDate);
    if (metaParts.length) {
      html += `<p style="margin:0 0 16px;font-size:13px;color:var(--muted);">${metaParts.join(' · ')}</p>`;
    }

    // Summary
    if (a.summary) {
      html += `<div style="margin-bottom:16px;font-size:14px;line-height:1.6;color:var(--text-secondary, var(--text));opacity:0.85;">${escHtml(a.summary)}</div>`;
    }

    // TLDR overview
    if (a.tldr_overview) {
      html += `<div style="margin-bottom:16px;padding:12px 16px;background:var(--surface);border-radius:8px;border:1px solid var(--border);">`;
      html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px;">TLDR</div>`;
      html += `<div style="font-size:13px;line-height:1.6;color:var(--text);">${escHtml(a.tldr_overview)}</div>`;
      html += `</div>`;
    }

    // Full content (for originals)
    if (a.full_content) {
      html += `<div style="margin-bottom:16px;padding:12px 16px;background:var(--surface);border-radius:8px;border:1px solid var(--border);">`;
      html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px;">Full Content</div>`;
      html += `<div style="font-size:13px;line-height:1.7;color:var(--text);white-space:pre-wrap;">${escHtml(a.full_content).slice(0, 2000)}${(a.full_content.length > 2000) ? '…' : ''}</div>`;
      html += `</div>`;
    }

    // Audio player
    if (a.audio_url) {
      html += `<div style="margin-bottom:16px;">`;
      html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px;">Audio${a.audio_voice_name ? ' · ' + escHtml(a.audio_voice_name) : ''}</div>`;
      html += `<audio controls style="width:100%;" src="${escHtml(a.audio_url)}"></audio>`;
      html += `</div>`;
    }

    html += `</div>`;

    document.getElementById('articlePreviewBody').innerHTML = html;

    // Footer links
    const liveLink = document.getElementById('previewLiveLink');
    const sourceLink = document.getElementById('previewSourceLink');

    const host = window.location.hostname;
    const siteBase = host === 'asgard.deepfeedai.com' ? 'https://staging.deepfeedai.com'
      : host === 'olympus.deepfeedai.com' ? 'https://deepfeedai.com'
      : 'http://localhost:3000';
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
    await loadArticles();
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
      await loadArticles();
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
    if (!status || status === 'error') {
      return `
        <button class="btn btn-ghost btn-sm" title="Generate audio summary" onclick="generateAudio(${a.id})">
          🎙️ Generate
        </button>
        ${status === 'error' ? '<span class="badge badge-danger" style="font-size:10px;">Error</span>' : ''}`;
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
      await loadArticles();
    } catch (err) {
      showAlert('Audio generation failed: ' + err.message, 'error');
      await loadArticles();
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
      await loadArticles();
    } catch (err) {
      showAlert('Image generation failed: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🎨'; }
    }
  }

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
      await loadArticles();
    } catch (err) {
      showAlert('Failed to remove audio: ' + err.message, 'error');
    }
  }

  async function toggleMedia(id) {
    try {
      const data = await apiFetch(`/media/toggle/${id}`, { method: 'PUT' });
      showAlert(data.media_enabled ? 'Audio published on site ✓' : 'Audio hidden from site');
      await loadArticles();
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
    try {
      const updated = await apiFetch(`/articles/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ [field]: value })
      });
      const idx = allArticles.findIndex(x => x.id === id);
      if (idx !== -1) Object.assign(allArticles[idx], updated);
      showAlert(`${field === 'title' ? 'Title' : 'Category'} updated ✓`);
      applyFilters();
    } catch (err) {
      showAlert('Update failed: ' + err.message, 'error');
      applyFilters();
    }
  }

  function cancelInlineEdit(id) {
    applyFilters();
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

  async function loadArticles() {
    const tbody = document.getElementById('articlesBody');
    if (tbody) tbody.innerHTML = skeletonRows(['sk-w-sm','sk-w-full','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-sm'], 5);
    try {
      await loadWriters();
      allArticles = await apiFetch('/articles');
      applyFilters();
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
    document.getElementById('fImageUrl').value = '';
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
      set('fImageUrl',  data.image);
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
    document.getElementById('fImageUrl').value = a.image_url || '';
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

    try {
      const saveBtn = document.getElementById('saveArticleBtn');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      let saved;
      if (id) {
        saved = await apiFetch(`/articles/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        await apiFetch(`/articles/${id}/assign-writer`, { method: 'PUT', body: JSON.stringify({ writerId }) });
        showAlert('Article updated ✓');
      } else {
        saved = await apiFetch('/articles', { method: 'POST', body: JSON.stringify(payload) });
        if (saved && saved.id) {
          await apiFetch(`/articles/${saved.id}/assign-writer`, { method: 'PUT', body: JSON.stringify({ writerId }) });
        }
        showAlert('Article created ✓');
      }
      closeModal('articleModal');
      await loadArticles();
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Article';
    } catch (err) {
      showAlert('Error: ' + err.message, 'error');
      document.getElementById('saveArticleBtn').disabled = false;
      document.getElementById('saveArticleBtn').textContent = 'Save Article';
    }
  }

  async function confirmDelete() {
    if (!deleteTargetId) return;
    try {
      await apiFetch(`/articles/${deleteTargetId}`, { method: 'DELETE' });
      selectedIds.delete(deleteTargetId);
      closeModal('deleteModal');
      showAlert('Article archived — will be purged automatically after 24h');
      deleteTargetId = null;
      await loadArticles();
    } catch (err) {
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
    try {
      await apiFetch(`/articles/${purgeTargetId}/purge`, { method: 'DELETE' });
      selectedIds.delete(purgeTargetId);
      closeModal('purgeModal');
      showAlert('Article permanently deleted');
      purgeTargetId = null;
      await loadArticles();
    } catch (err) {
      showAlert('Purge failed: ' + err.message, 'error');
    }
  }

  async function restoreArticle(id) {
    try {
      await apiFetch(`/articles/${id}/restore`, { method: 'PUT' });
      showAlert('Article restored ✓');
      await loadArticles();
    } catch (err) {
      showAlert('Restore failed: ' + err.message, 'error');
    }
  }

  async function togglePublish(id) {
    try {
      await apiFetch(`/articles/${id}/publish`, { method: 'PUT' });
      await loadArticles();
    } catch (err) { showAlert('Error: ' + err.message, 'error'); }
  }

  async function setFeaturedPriority(id, priority) {
    try {
      const p = parseInt(priority);
      await apiFetch(`/articles/${id}/feature`, {
        method: 'PUT',
        body: JSON.stringify({ priority: p || null }),
      });
      await loadArticles();
    } catch (err) { showAlert('Error: ' + err.message, 'error'); }
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
    await loadArticles();
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
    await loadArticles();
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
      await loadArticles();
    } catch (err) {
      showAlert('Auto-assign failed: ' + err.message, 'error');
    }
  }

  onReady(async () => {
    if (!requireAuth()) return;
    renderSidebar();
    initModals();

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
          await loadArticles();
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
        if (archivedWrap) archivedWrap.style.display = activeTab === 'drafts' ? 'none' : 'flex';
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