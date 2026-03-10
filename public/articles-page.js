let articles = [];
  let allArticles = []; // full list including archived
  let deleteTargetId = null;
  let sortCol = 'published_at';
  let sortDir = 'desc';
  let selectedIds = new Set();
  let showArchived = false;

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
    articles.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (['is_published','is_featured'].includes(sortCol)) {
        va = Number(va); vb = Number(vb);
      } else if (['published_at','created_at'].includes(sortCol)) {
        va = new Date(va); vb = new Date(vb);
      } else {
        va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
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
      tbody.innerHTML = `<tr><td colspan="9">
        <div class="empty-state"><div class="empty-icon">📭</div><p>No articles yet. Add one!</p></div>
      </td></tr>`;
      updateBulkToolbar();
      return;
    }

    tbody.innerHTML = articles.map(a => {
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
        <td class="td-title" title="${escHtml(a.title)}">${escHtml(a.title)}${isArchived ? ' <span class="badge badge-archived" style="font-size:10px;margin-left:4px;">Archived</span>' : ''}</td>
        <td style="color:var(--muted);font-size:12px;">${escHtml(a.source || '—')}</td>
        <td><span class="badge badge-muted">${escHtml(a.category || '—')}</span></td>
        <td>${isArchived ? '<span class="badge badge-muted">—</span>' : `
          <button class="badge ${a.is_published ? 'badge-success' : 'badge-muted'}"
            style="cursor:pointer;border:none;background:inherit;"
            onclick="togglePublish(${a.id})">
            ${a.is_published ? 'Published' : 'Draft'}
          </button>`}
        </td>
        <td>${isArchived ? '—' : `
          <button class="badge ${a.is_featured ? 'badge-accent' : 'badge-muted'}"
            style="cursor:pointer;border:none;background:inherit;"
            onclick="toggleFeature(${a.id})">
            ${a.is_featured ? '⭐ Yes' : '—'}
          </button>`}
        </td>
        <td style="color:var(--muted);font-size:12px;">${fmtDate(a.published_at || a.created_at)}</td>
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
            <button class="btn btn-ghost btn-sm btn-icon" title="Generate AI image" onclick="generateImage(${a.id})">🎨</button>
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
    return `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 6px;" title="Generate AI image" onclick="generateImage(${a.id})">🎨</button>`;
  }

  let _imagePreviewUrl = null;
  function previewImage(url) {
    _imagePreviewUrl = url;
    document.getElementById('imgPreviewEl').src = url;
    document.getElementById('imgPreviewLink').href = url;
    openModal('imagePreviewModal');
  }

  async function generateImage(id) {
    const cell = document.getElementById(`img-cell-${id}`);
    if (cell) cell.innerHTML = '<span class="badge badge-muted" style="font-size:10px;">⏳</span>';
    try {
      const data = await apiFetch('/media/generate-image', {
        method: 'POST',
        body: JSON.stringify({ articleId: id })
      });
      console.log('[ImageGen] Concept:', data.visualConcept);
      console.log('[ImageGen] Full prompt:', data.fullPrompt);
      showAlert('Image generated ✓');
      await loadArticles();
    } catch (err) {
      showAlert('Image generation failed: ' + err.message, 'error');
      await loadArticles();
    }
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

  let _pendingAudioArticleId = null;
  let _selectedVoiceId = null;

  async function generateAudio(id) {
    _pendingAudioArticleId = id;
    _selectedVoiceId = null;

    // Load voices and render picker
    let voices = [];
    try {
      voices = await apiFetch('/voices');
    } catch (e) { voices = []; }

    const list = document.getElementById('voicePickerList');
    list.innerHTML = '';

    if (voices.length === 0) {
      list.innerHTML = '<p style="color:var(--muted);text-align:center;">No voices configured. <a href="/voices.html">Add one →</a></p>';
    } else {
      voices.forEach(v => {
        const card = document.createElement('div');
        card.className = 'voice-picker-card';
        card.dataset.voiceId = v.id;
        card.style.cssText = 'display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:border-color 0.15s;';

        const avatarHtml = v.avatar_url
          ? `<img src="${v.avatar_url}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;" onerror="this.outerHTML='<div style=\\'width:40px;height:40px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;\\'>🎙️</div>'" />`
          : '<div style="width:40px;height:40px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">🎙️</div>';

        card.innerHTML = `
          ${avatarHtml}
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:14px;">${v.name}${v.is_default ? ' <span style="font-size:11px;color:var(--accent);">Default</span>' : ''}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px;">${v.description || v.voice_id}</div>
          </div>`;

        card.addEventListener('click', () => {
          document.querySelectorAll('.voice-picker-card').forEach(c => c.style.borderColor = 'var(--border)');
          card.style.borderColor = 'var(--accent)';
          _selectedVoiceId = v.id;
        });

        list.appendChild(card);

        // Pre-select default voice
        if (v.is_default) {
          card.style.borderColor = 'var(--accent)';
          _selectedVoiceId = v.id;
        }
      });
    }

    openModal('voicePickerModal');
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('confirmGenerateBtn').addEventListener('click', async () => {
      if (!_pendingAudioArticleId) return;
      const id = _pendingAudioArticleId;
      closeModal('voicePickerModal');
      _pendingAudioArticleId = null;

      const cell = document.getElementById(`audio-cell-${id}`);
      if (cell) cell.innerHTML = '<span class="badge badge-muted" style="font-size:11px;">⏳ Generating…</span>';
      try {
        const payload = { articleId: id };
        if (_selectedVoiceId) payload.voiceId = _selectedVoiceId;
        const data = await apiFetch(`/media/generate-audio`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        showAlert(`Audio ready ✓ (${data.charCount} chars)${data.voiceName ? ' — ' + data.voiceName : ''}`);
        await loadArticles();
      } catch (err) {
        showAlert('Audio generation failed: ' + err.message, 'error');
        await loadArticles();
      }
    });
  });

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

  async function loadArticles() {
    try {
      allArticles = await apiFetch('/articles');
      articles = showArchived ? allArticles : allArticles.filter(a => !a.is_archived);
      // Re-apply current sort after reload
      articles.sort((a, b) => {
        let va = a[sortCol], vb = b[sortCol];
        if (va == null) va = ''; if (vb == null) vb = '';
        if (['is_published','is_featured'].includes(sortCol)) { va = Number(va); vb = Number(vb); }
        else if (['published_at','created_at'].includes(sortCol)) { va = new Date(va); vb = new Date(vb); }
        else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
      renderTable();
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
    document.getElementById('fFeatured').checked = false;
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
    document.getElementById('fFeatured').checked = !!a.is_featured;
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
      is_featured : document.getElementById('fFeatured').checked,
    };

    try {
      const saveBtn = document.getElementById('saveArticleBtn');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      if (id) {
        await apiFetch(`/articles/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showAlert('Article updated ✓');
      } else {
        await apiFetch('/articles', { method: 'POST', body: JSON.stringify(payload) });
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

  async function toggleFeature(id) {
    try {
      await apiFetch(`/articles/${id}/feature`, { method: 'PUT' });
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

  onReady(async () => {
    if (!requireAuth()) return;
    initSidebar();
    initLogout();
    initModals();

    document.getElementById('fCategory').innerHTML = categoryOptions('Industry');
    document.getElementById('addArticleBtn').addEventListener('click', openAdd);
    document.getElementById('saveArticleBtn').addEventListener('click', saveArticle);
    document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
    document.getElementById('confirmPurgeBtn').addEventListener('click', confirmPurge);

    document.getElementById('showArchived').addEventListener('change', e => {
      showArchived = e.target.checked;
      articles = showArchived ? allArticles : allArticles.filter(a => !a.is_archived);
      selectedIds.clear();
      renderTable();
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
    document.getElementById('bulkDeleteBtn').addEventListener('click', bulkDelete);
    document.getElementById('bulkClearBtn').addEventListener('click', () => {
      selectedIds.clear();
      renderTable();
    });

    await loadArticles();
  });