(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let stories        = [];
  let activeStatus   = 'active';
  let searchQuery    = '';
  let sortBy         = 'activity';
  let openStoryId    = null;
  let openStory      = null;
  let _regenTimer    = null;
  let _regenAttempts = 0;
  let _pendingArchiveId = null;

  // Phase 3: new-story modal
  let _newStorySelectedIds = []; // [{ id, title }]
  let _newStorySearchTimer = null;

  // Phase 3: drawer add-article
  let _addArtSearchTimer = null;

  // ── Boot ───────────────────────────────────────────────────────────────────
  onReady(function () {
    if (!requireAuth()) return;
    renderSidebar();

    document.getElementById('sSearch').addEventListener('input', e => {
      searchQuery = e.target.value.trim().toLowerCase();
      renderList();
    });
    document.getElementById('sSort').addEventListener('change', e => {
      sortBy = e.target.value;
      renderList();
    });
    loadStories();
  });

  // ── Data ───────────────────────────────────────────────────────────────────
  async function loadStories() {
    try {
      const data = await apiFetch('/story-timelines?status=active,dormant,archived&limit=100');
      stories = data.stories || [];
      renderAll();
    } catch (err) {
      document.getElementById('sList').innerHTML =
        `<div class="s-empty"><div class="ei">⚠️</div><p>${esc(err.message)}</p></div>`;
    }
  }

  // ── Render: full page ──────────────────────────────────────────────────────
  function renderAll() {
    renderStats();
    renderTabs();
    renderList();
  }

  function renderStats() {
    const total    = stories.length;
    const active   = stories.filter(s => s.status === 'active').length;
    const dormant  = stories.filter(s => s.status === 'dormant').length;
    const archived = stories.filter(s => s.status === 'archived').length;
    const totalArt = stories.reduce((n, s) => n + (s.articleCount || s.article_count || 0), 0);
    document.getElementById('sStats').innerHTML = `
      <div class="s-stat"><div class="s-stat-num">${total}</div><div class="s-stat-label">Total Stories</div></div>
      <div class="s-stat"><div class="s-stat-num">${active}</div><div class="s-stat-label">Active</div></div>
      <div class="s-stat"><div class="s-stat-num">${dormant}</div><div class="s-stat-label">Dormant</div></div>
      <div class="s-stat"><div class="s-stat-num">${archived}</div><div class="s-stat-label">Archived</div></div>
      <div class="s-stat"><div class="s-stat-num">${totalArt}</div><div class="s-stat-label">Articles</div></div>
    `;
  }

  function renderTabs() {
    const counts = { active: 0, dormant: 0, archived: 0 };
    stories.forEach(s => { if (counts[s.status] !== undefined) counts[s.status]++; });
    const tabs = [
      { key: 'active',   label: 'Active' },
      { key: 'dormant',  label: 'Dormant' },
      { key: 'archived', label: 'Archived' },
      { key: 'all',      label: 'All' },
    ];
    document.getElementById('sTabs').innerHTML = tabs.map(t => {
      const cnt = t.key === 'all' ? stories.length : (counts[t.key] || 0);
      return `<button class="s-tab${activeStatus === t.key ? ' active' : ''}"
        onclick="setStatus('${t.key}')">
        ${t.label}<span class="tc">${cnt}</span>
      </button>`;
    }).join('');
  }

  // ── Public callbacks (called from inline HTML) ─────────────────────────────
  window.setStatus = function (status) {
    activeStatus = status;
    renderTabs();
    renderList();
  };

  // ── Render: list ───────────────────────────────────────────────────────────
  function filteredStories() {
    return stories.filter(s => {
      if (activeStatus !== 'all' && s.status !== activeStatus) return false;
      if (searchQuery) {
        const hay = (s.name || '').toLowerCase() + ' ' + (s.summary || '').toLowerCase();
        if (!hay.includes(searchQuery)) return false;
      }
      return true;
    });
  }

  function sortedStories(list) {
    const copy = list.slice();
    if (sortBy === 'activity') {
      copy.sort((a, b) => {
        const ta = a.lastActivityAt || a.last_activity_at || a.createdAt || a.created_at || '';
        const tb = b.lastActivityAt || b.last_activity_at || b.createdAt || b.created_at || '';
        return tb.localeCompare(ta);
      });
    } else if (sortBy === 'count') {
      copy.sort((a, b) => (b.articleCount || b.article_count || 0) - (a.articleCount || a.article_count || 0));
    } else if (sortBy === 'created') {
      copy.sort((a, b) => {
        const ta = a.createdAt || a.created_at || '';
        const tb = b.createdAt || b.created_at || '';
        return tb.localeCompare(ta);
      });
    }
    return copy;
  }

  function renderList() {
    const visible = sortedStories(filteredStories());
    const el = document.getElementById('sList');
    if (!visible.length) {
      el.innerHTML = `<div class="s-empty"><div class="ei">📖</div><p>No stories found</p></div>`;
      return;
    }
    el.innerHTML = visible.map(s => {
      const count   = s.articleCount || s.article_count || 0;
      const ago     = relativeTime(s.lastActivityAt || s.last_activity_at || s.createdAt || s.created_at);
      const preview = s.summary ? s.summary.slice(0, 90) : '';
      const badge   = badgeHtml(s.status);
      const isOpen  = s.id === openStoryId;
      const spark   = s._intensityCache ? renderMiniSparkline(s._intensityCache) : '<span class="sparkline"></span>';
      const initials = (s.name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
      const cover = s.cover && s.cover.imageUrl
        ? `<img src="${esc(s.cover.imageUrl)}" alt="" />`
        : initials;
      return `<div class="s-row${isOpen ? ' s-row-active' : ''}" onclick="openDrawer(${s.id})">
        <div class="s-cover">${cover}</div>
        <div class="s-main">
          <div class="s-name">${esc(s.name || 'Untitled')}</div>
          ${preview ? `<div class="s-preview">${esc(preview)}</div>` : ''}
        </div>
        <div class="s-meta">
          ${badge}
          <span class="s-count">${count} article${count !== 1 ? 's' : ''}</span>
          <span class="s-ago">${ago}</span>
          ${spark}
        </div>
      </div>`;
    }).join('');
  }

  function badgeHtml(status) {
    if (status === 'active')   return '<span class="s-badge sb-active">● Active</span>';
    if (status === 'dormant')  return '<span class="s-badge sb-dormant">◑ Dormant</span>';
    if (status === 'archived') return '<span class="s-badge sb-archived">○ Archived</span>';
    return '';
  }

  function renderMiniSparkline(intensity) {
    if (!intensity || !intensity.length) return '<span class="sparkline"></span>';
    const recent = intensity.slice(-14);
    const max = Math.max(...recent.map(d => d.count), 1);
    const bars = recent.map(d => {
      const pct = Math.round((d.count / max) * 100);
      return `<div class="sp-bar" style="height:${Math.max(2, Math.round(pct * 0.16))}px;"></div>`;
    }).join('');
    return `<span class="sparkline">${bars}</span>`;
  }

  // ── Drawer ─────────────────────────────────────────────────────────────────
  window.openDrawer = async function (id) {
    if (openStoryId === id) return;
    clearRegenPoll();
    openStoryId = id;
    openStory   = null;

    document.getElementById('storiesLayout').classList.add('drawer-open');
    document.getElementById('dBody').innerHTML =
      '<div style="text-align:center;padding:40px;"><span class="spinner"></span></div>';

    // Highlight row immediately
    renderList();

    try {
      const data = await apiFetch('/story-timelines/' + id);
      openStory = data.story;
      // Cache intensity on the list item for sparklines
      const listItem = stories.find(s => s.id === id);
      if (listItem && openStory.intensity) listItem._intensityCache = openStory.intensity;
      renderList();
      renderDrawer(openStory);
    } catch (err) {
      document.getElementById('dBody').innerHTML =
        `<div class="s-empty"><div class="ei">⚠️</div><p>${esc(err.message)}</p></div>`;
    }
  };

  window.closeDrawer = function () {
    clearRegenPoll();
    openStoryId = null;
    openStory   = null;
    document.getElementById('storiesLayout').classList.remove('drawer-open');
    renderList();
  };

  function renderDrawer(s) {
    const slug    = s.slug || '';
    const summary = s.summary || '';
    const count   = s.article_count || s.articleCount || 0;
    const status  = s.status || 'active';

    // Update archive button label
    const archiveBtn = document.getElementById('archiveBtn');
    if (status === 'archived') {
      archiveBtn.textContent = 'Restore';
      archiveBtn.onclick = () => restoreStory();
    } else {
      archiveBtn.textContent = 'Archive';
      archiveBtn.onclick = () => archiveStory();
    }

    document.getElementById('dBody').innerHTML = `
      <div id="dName" class="d-name" contenteditable="true" spellcheck="false">${esc(s.name || '')}</div>
      <div class="d-slug">
        <span style="color:var(--text-muted)">slug:</span>
        <code style="font-size:11px;">${esc(slug)}</code>
        <button class="btn-key" title="Copy slug" onclick="copySlug()"
          style="font-size:12px;padding:1px 4px;">⎘</button>
        ${badgeHtml(status)}
      </div>

      <div class="d-section">
        <div class="d-section-label">Summary
          <button class="btn btn-ghost btn-sm" onclick="saveSummary()" style="font-size:11px;">Save</button>
        </div>
        <textarea id="dSummary" class="d-textarea" rows="4" placeholder="Add a summary…">${esc(summary)}</textarea>
      </div>

      <div class="d-section">
        <div class="d-section-label">Activity (last 60 days)</div>
        <div class="intensity-wrap" id="dIntensity">${renderIntensityChart(s.intensity)}</div>
      </div>

      <div class="d-section">
        <div class="d-section-label">
          Articles <span style="font-weight:400;color:var(--text-muted)">${count}</span>
          <button class="btn btn-ghost btn-sm" onclick="toggleAddArticle()" id="addArtBtn"
            style="font-size:11px;">+ Add</button>
        </div>
        <div class="a-list" id="dArticles">${renderArticleList(s.articles || [])}</div>
        <div id="addArtWrap" style="display:none;">
          <div class="add-art-wrap">
            <input class="add-art-input" id="addArtInput" placeholder="Search by title or source…" autocomplete="off" />
            <div class="add-art-results" id="addArtResults"></div>
          </div>
        </div>
      </div>
    `;

    setupNameEdit(s);
    setupAddArticle(s.id);
  }

  function renderIntensityChart(intensity) {
    if (!intensity || !intensity.length) {
      return '<div style="flex:1;text-align:center;font-size:11px;color:var(--text-muted);align-self:center;">No data</div>';
    }
    const max = Math.max(...intensity.map(d => d.count), 1);
    return intensity.map(d => {
      const h = Math.max(3, Math.round((d.count / max) * 28));
      return `<div class="i-bar" style="height:${h}px;" title="${d.date}: ${d.count}"></div>`;
    }).join('');
  }

  function renderArticleList(articles) {
    if (!articles.length) {
      return '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">No articles yet</div>';
    }
    return articles.map(a => {
      const date = a.published_at
        ? new Date(a.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      const isKey = !!a.is_key_moment;
      return `<div class="a-item${isKey ? ' a-key' : ''}" id="a-item-${a.id}">
        <div class="a-date">${date}</div>
        <div class="a-info">
          <div class="a-title">${esc(a.title || 'Untitled')}</div>
          ${a.writer_name ? `<div class="a-writer">by ${esc(a.writer_name)}</div>` : ''}
        </div>
        <div class="a-btns">
          <button class="btn-key" title="${isKey ? 'Remove key moment' : 'Mark as key moment'}"
            onclick="toggleKeyMoment(${a.id}, ${isKey})">${isKey ? '★' : '☆'}</button>
          <div id="rm-wrap-${a.id}">
            <button class="btn-rm" onclick="showRemoveConfirm(${a.id})">✕</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // ── Drawer: name inline edit ───────────────────────────────────────────────
  function setupNameEdit(s) {
    const el = document.getElementById('dName');
    if (!el) return;
    let original = s.name || '';

    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { el.textContent = original; el.blur(); }
    });

    el.addEventListener('blur', async () => {
      const newName = el.textContent.trim();
      if (newName === original) return;
      if (!newName) { el.textContent = original; return; }
      try {
        await apiFetch('/story-timelines/' + openStoryId, {
          method: 'PATCH', body: JSON.stringify({ name: newName }),
        });
        original = newName;
        const listItem = stories.find(s2 => s2.id === openStoryId);
        if (listItem) { listItem.name = newName; renderList(); }
      } catch (err) {
        el.textContent = original;
        showAlert('Failed to save name: ' + err.message, 'error');
      }
    });
  }

  // ── Drawer: summary save ───────────────────────────────────────────────────
  window.saveSummary = async function () {
    if (!openStoryId) return;
    const el = document.getElementById('dSummary');
    if (!el) return;
    try {
      await apiFetch('/story-timelines/' + openStoryId, {
        method: 'PATCH', body: JSON.stringify({ summary: el.value }),
      });
      const listItem = stories.find(s => s.id === openStoryId);
      if (listItem) { listItem.summary = el.value; }
      showAlert('Summary saved', 'success');
    } catch (err) {
      showAlert('Failed to save summary: ' + err.message, 'error');
    }
  };

  // ── Drawer: copy slug ──────────────────────────────────────────────────────
  window.copySlug = function () {
    if (!openStory) return;
    navigator.clipboard.writeText(openStory.slug || '').catch(() => {});
  };

  // ── Drawer: archive / restore ──────────────────────────────────────────────
  window.archiveStory = function () {
    if (!openStoryId) return;
    _pendingArchiveId = openStoryId;
    const s = stories.find(s2 => s2.id === openStoryId);
    document.getElementById('archiveStoryName').textContent = s ? s.name : '';
    openModal('archiveModal');
  };

  window.confirmArchive = async function () {
    if (!_pendingArchiveId) return;
    closeModal('archiveModal');
    try {
      await apiFetch('/story-timelines/' + _pendingArchiveId, { method: 'DELETE' });
      const s = stories.find(s2 => s2.id === _pendingArchiveId);
      if (s) s.status = 'archived';
      if (openStoryId === _pendingArchiveId && openStory) {
        openStory.status = 'archived';
        renderDrawer(openStory);
      }
      renderAll();
      showAlert('Story archived', 'success');
    } catch (err) {
      showAlert('Archive failed: ' + err.message, 'error');
    }
    _pendingArchiveId = null;
  };

  window.restoreStory = async function () {
    if (!openStoryId) return;
    try {
      await apiFetch('/story-timelines/' + openStoryId, {
        method: 'PATCH', body: JSON.stringify({ status: 'active' }),
      });
      const s = stories.find(s2 => s2.id === openStoryId);
      if (s) s.status = 'active';
      if (openStory) { openStory.status = 'active'; renderDrawer(openStory); }
      renderAll();
      showAlert('Story restored', 'success');
    } catch (err) {
      showAlert('Restore failed: ' + err.message, 'error');
    }
  };

  // ── Drawer: regenerate ─────────────────────────────────────────────────────
  window.regenerateStory = async function () {
    if (!openStoryId) return;
    clearRegenPoll();
    const btn = document.getElementById('regenBtn');
    if (btn) btn.innerHTML = '<span class="regen-spin"></span> Regenerating…';
    try {
      await apiFetch('/story-timelines/' + openStoryId + '/regenerate', { method: 'POST' });
    } catch (err) {
      showAlert('Regenerate failed: ' + err.message, 'error');
      if (btn) btn.textContent = '↺ Regenerate';
      return;
    }
    _regenAttempts = 0;
    const storyIdAtStart = openStoryId;
    const nameAtStart    = openStory ? openStory.name : null;
    const summAtStart    = openStory ? openStory.summary : null;

    _regenTimer = setInterval(async () => {
      if (openStoryId !== storyIdAtStart) { clearRegenPoll(); return; }
      _regenAttempts++;
      try {
        const data = await apiFetch('/story-timelines/' + storyIdAtStart);
        const fresh = data.story;
        const changed = fresh.name !== nameAtStart || fresh.summary !== summAtStart;
        if (changed || _regenAttempts >= 10) {
          clearRegenPoll();
          openStory = fresh;
          const listItem = stories.find(s => s.id === storyIdAtStart);
          if (listItem) {
            listItem.name    = fresh.name;
            listItem.summary = fresh.summary;
          }
          renderList();
          renderDrawer(fresh);
          if (changed) showAlert('Story regenerated', 'success');
        }
      } catch { /* ignore transient errors */ }
    }, 3000);
  };

  function clearRegenPoll() {
    if (_regenTimer) { clearInterval(_regenTimer); _regenTimer = null; }
    _regenAttempts = 0;
    const btn = document.getElementById('regenBtn');
    if (btn) btn.innerHTML = '↺ Regenerate';
  }

  // ── Drawer: key moment toggle ──────────────────────────────────────────────
  window.toggleKeyMoment = async function (articleId, currentlyKey) {
    if (!openStoryId) return;
    try {
      await apiFetch('/story-timelines/' + openStoryId + '/articles/' + articleId, {
        method: 'PATCH', body: JSON.stringify({ isKeyMoment: !currentlyKey }),
      });
      // Refresh drawer
      const data = await apiFetch('/story-timelines/' + openStoryId);
      openStory = data.story;
      const listItem = stories.find(s => s.id === openStoryId);
      if (listItem && openStory.intensity) listItem._intensityCache = openStory.intensity;
      renderDrawer(openStory);
    } catch (err) {
      showAlert('Failed to update key moment: ' + err.message, 'error');
    }
  };

  // ── Drawer: remove article ─────────────────────────────────────────────────
  window.showRemoveConfirm = function (articleId) {
    const wrap = document.getElementById('rm-wrap-' + articleId);
    if (!wrap) return;
    wrap.innerHTML = `<div class="rm-confirm">
      <span>Remove?</span>
      <button class="rm-yes" onclick="confirmRemoveArticle(${articleId})">Yes</button>
      <button class="rm-no"  onclick="cancelRemove(${articleId})">No</button>
    </div>`;
  };

  window.cancelRemove = function (articleId) {
    const wrap = document.getElementById('rm-wrap-' + articleId);
    if (!wrap) return;
    wrap.innerHTML = `<button class="btn-rm" onclick="showRemoveConfirm(${articleId})">✕</button>`;
  };

  window.confirmRemoveArticle = async function (articleId) {
    if (!openStoryId) return;
    try {
      await apiFetch('/story-timelines/' + openStoryId + '/articles/' + articleId, {
        method: 'DELETE',
      });
      const data = await apiFetch('/story-timelines/' + openStoryId);
      openStory = data.story;
      const listItem = stories.find(s => s.id === openStoryId);
      if (listItem) {
        const cnt = openStory.article_count || openStory.articleCount || 0;
        listItem.article_count = cnt;
        listItem.articleCount  = cnt;
        if (openStory.intensity) listItem._intensityCache = openStory.intensity;
      }
      renderList();
      renderDrawer(openStory);
    } catch (err) {
      showAlert('Failed to remove article: ' + err.message, 'error');
    }
  };

  // ── Phase 3: New Story modal ───────────────────────────────────────────────
  window.openNewStoryModal = function () {
    _newStorySelectedIds = [];
    document.getElementById('newStoryName').value    = '';
    document.getElementById('newStorySearch').value  = '';
    document.getElementById('newStoryResults').innerHTML = '';
    document.getElementById('newStorySelected').innerHTML = '';
    openModal('newStoryModal');
    setTimeout(() => document.getElementById('newStoryName').focus(), 80);

    const searchEl = document.getElementById('newStorySearch');
    searchEl.oninput = () => {
      clearTimeout(_newStorySearchTimer);
      _newStorySearchTimer = setTimeout(() => _searchNewStoryArticles(searchEl.value.trim()), 280);
    };
  };

  async function _searchNewStoryArticles(q) {
    const el = document.getElementById('newStoryResults');
    if (!el) return;
    if (!q) { el.innerHTML = ''; return; }
    try {
      const data = await apiFetch('/story-timelines/articles-search?limit=12&q=' + encodeURIComponent(q));
      const articles = (data.articles || []).filter(a => !_newStorySelectedIds.find(s => s.id === a.id));
      if (!articles.length) { el.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--text-muted)">No results</div>'; return; }
      el.innerHTML = articles.map(a => {
        const date = a.published_at ? new Date(a.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        return `<div class="art-result" onclick="_addToNewStory(${a.id}, ${JSON.stringify(esc(a.title))})">
          <div style="flex:1;min-width:0;">
            <div class="art-result-title">${esc(a.title)}</div>
            <div class="art-result-meta">${esc(a.source || '')}${date ? ' · ' + date : ''}</div>
          </div>
          <div class="art-result-add">+</div>
        </div>`;
      }).join('');
    } catch { /* ignore transient errors */ }
  }

  window._addToNewStory = function (id, title) {
    if (_newStorySelectedIds.find(s => s.id === id)) return;
    _newStorySelectedIds.push({ id, title });
    _renderNewStoryPills();
    document.getElementById('newStoryResults').innerHTML = '';
    document.getElementById('newStorySearch').value = '';
  };

  function _renderNewStoryPills() {
    const el = document.getElementById('newStorySelected');
    if (!el) return;
    el.innerHTML = _newStorySelectedIds.map(s =>
      `<span class="art-pill">
        <span>${esc(s.title)}</span>
        <span class="art-pill-rm" onclick="_removeFromNewStory(${s.id})">×</span>
      </span>`
    ).join('');
  }

  window._removeFromNewStory = function (id) {
    _newStorySelectedIds = _newStorySelectedIds.filter(s => s.id !== id);
    _renderNewStoryPills();
  };

  window.submitNewStory = async function () {
    const name = (document.getElementById('newStoryName').value || '').trim();
    if (!name) { document.getElementById('newStoryName').focus(); return; }
    const btn = document.getElementById('newStorySubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const data = await apiFetch('/story-timelines', {
        method: 'POST',
        body: JSON.stringify({ name, articleIds: _newStorySelectedIds.map(s => s.id) }),
      });
      closeModal('newStoryModal');
      await loadStories();
      if (data.story?.id) openDrawer(data.story.id);
    } catch (err) {
      showAlert('Failed to create story: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create Story';
    }
  };

  // ── Phase 3: Drawer add-article ────────────────────────────────────────────
  function setupAddArticle(storyId) {
    const input = document.getElementById('addArtInput');
    if (!input) return;
    input.oninput = () => {
      clearTimeout(_addArtSearchTimer);
      _addArtSearchTimer = setTimeout(() => _searchDrawerArticles(storyId, input.value.trim()), 280);
    };
  }

  window.toggleAddArticle = function () {
    const wrap = document.getElementById('addArtWrap');
    if (!wrap) return;
    const open = wrap.style.display !== 'none';
    wrap.style.display = open ? 'none' : '';
    const btn = document.getElementById('addArtBtn');
    if (btn) btn.textContent = open ? '+ Add' : '✕ Cancel';
    if (!open) setTimeout(() => document.getElementById('addArtInput')?.focus(), 60);
  };

  async function _searchDrawerArticles(storyId, q) {
    const el = document.getElementById('addArtResults');
    if (!el) return;
    if (!q) { el.innerHTML = ''; return; }
    try {
      const url = '/story-timelines/articles-search?limit=12&exclude_story=' + storyId + '&q=' + encodeURIComponent(q);
      const data = await apiFetch(url);
      const articles = data.articles || [];
      if (!articles.length) { el.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--text-muted)">No results</div>'; return; }
      el.innerHTML = articles.map(a => {
        const date = a.published_at ? new Date(a.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        return `<div class="art-result" onclick="_attachArticleToStory(${a.id})">
          <div style="flex:1;min-width:0;">
            <div class="art-result-title">${esc(a.title)}</div>
            <div class="art-result-meta">${esc(a.source || '')}${date ? ' · ' + date : ''}</div>
          </div>
          <div class="art-result-add">+</div>
        </div>`;
      }).join('');
    } catch { /* ignore */ }
  }

  window._attachArticleToStory = async function (articleId) {
    if (!openStoryId) return;
    const resultsEl = document.getElementById('addArtResults');
    const inputEl   = document.getElementById('addArtInput');
    if (resultsEl) resultsEl.innerHTML = '';
    if (inputEl)   inputEl.value = '';
    try {
      await apiFetch('/story-timelines/' + openStoryId + '/articles', {
        method: 'POST',
        body: JSON.stringify({ articleId, isKeyMoment: false }),
      });
      const data = await apiFetch('/story-timelines/' + openStoryId);
      openStory = data.story;
      const listItem = stories.find(s => s.id === openStoryId);
      if (listItem) {
        const cnt = openStory.article_count || openStory.articleCount || 0;
        listItem.article_count = cnt;
        listItem.articleCount  = cnt;
        if (openStory.intensity) listItem._intensityCache = openStory.intensity;
      }
      renderList();
      renderDrawer(openStory);
    } catch (err) {
      showAlert('Failed to add article: ' + err.message, 'error');
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000)        return 'just now';
    if (ms < 3600000)      return Math.floor(ms / 60000) + 'm ago';
    if (ms < 86400000)     return Math.floor(ms / 3600000) + 'h ago';
    if (ms < 7 * 86400000) return Math.floor(ms / 86400000) + 'd ago';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
})();
