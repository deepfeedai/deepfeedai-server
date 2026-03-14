let sources = [];
  let deleteSourceId = null;

  // ── Suggested feeds ────────────────────────────────────────────────
  const SUGGESTED_FEEDS = [
    { name: 'The Verge AI',           url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',    category: 'Tech Media' },
    { name: 'Wired AI',               url: 'https://www.wired.com/feed/category/artificial-intelligence/latest/rss', category: 'Tech Media' },
    { name: 'TechCrunch AI',          url: 'https://techcrunch.com/category/artificial-intelligence/feed/',          category: 'Tech Media' },
    { name: 'VentureBeat AI',         url: 'https://venturebeat.com/category/ai/feed/',                              category: 'Tech Media' },
    { name: 'Ars Technica',           url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',               category: 'Tech Media' },
    { name: 'MIT Technology Review',  url: 'https://www.technologyreview.com/feed/',                                  category: 'Research / Academic' },
    { name: 'Google AI Blog',         url: 'https://blog.google/technology/ai/rss/',                                  category: 'Company Blogs' },
    { name: 'OpenAI Blog',            url: 'https://openai.com/blog/rss.xml',                                         category: 'Company Blogs' },
    { name: 'Anthropic News',         url: 'https://www.anthropic.com/news/rss.xml',                                  category: 'Company Blogs' },
    { name: 'Meta AI Blog',           url: 'https://ai.meta.com/blog/rss/',                                           category: 'Company Blogs' },
    { name: 'DeepMind Blog',          url: 'https://deepmind.google/blog/rss.xml',                                    category: 'Company Blogs' },
    { name: 'Hugging Face Blog',      url: 'https://huggingface.co/blog/feed.xml',                                    category: 'Developer / Research' },
    { name: 'Towards Data Science',   url: 'https://towardsdatascience.com/feed',                                     category: 'Developer / Research' },
    { name: 'Import AI (Jack Clark)', url: 'https://jack-clark.net/feed/',                                            category: 'Newsletters' },
    { name: 'AI Weirdness',           url: 'https://aiweirdness.com/rss',                                             category: 'Newsletters' },
    { name: 'NVIDIA AI Blog',         url: 'https://blogs.nvidia.com/blog/category/deep-learning/feed/',              category: 'Company Blogs' },
    { name: 'AI News',                url: 'https://www.artificialintelligence-news.com/feed/',                       category: 'Tech Media' },
    { name: 'The Batch (DeepLearning.AI)', url: 'https://www.deeplearning.ai/the-batch/rss/',                        category: 'Newsletters' },
  ];

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtLastFetched(val) {
    if (!val) return '<span class="text-muted text-sm">Never</span>';
    return `<span class="text-muted text-sm" title="${fmtDate(val)}">${relativeTime(val)}</span>`;
  }

  function renderTable() {
    const tbody = document.getElementById('sourcesBody');
    if (sources.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7">
        <div class="empty-state"><div class="empty-icon">📡</div><p>No sources configured — add one to get started</p></div>
      </td></tr>`;
      return;
    }

    tbody.innerHTML = sources.map(s => `
      <tr id="srow-${s.id}">
        <td style="font-weight:500;">${escHtml(s.name)}</td>
        <td class="td-url" title="${escHtml(s.url)}">
          <a href="${escHtml(s.url)}" target="_blank" rel="noopener" class="text-muted text-sm">
            ${escHtml(s.url.length > 45 ? s.url.slice(0, 45) + '…' : s.url)}
          </a>
        </td>
        <td class="text-muted">${s.priority}</td>
        <td>
          <button
            class="badge ${s.is_active ? 'badge-success' : 'badge-danger'}"
            style="cursor:pointer;border:none;background:inherit;"
            onclick="toggleActive(${s.id})">
            ${s.is_active ? 'Active' : 'Off'}
          </button>
        </td>
        <td>
          ${s.auto_publish
            ? `<span class="badge badge-success" title="Auto-publishes up to ${s.auto_publish_max || 5} articles per fetch">✓ Max ${s.auto_publish_max || 5}</span>`
            : `<span class="text-muted text-sm">Draft only</span>`
          }
        </td>
        <td>${fmtLastFetched(s.last_fetched)}</td>
        <td class="td-actions">
          <button class="btn btn-ghost btn-sm btn-icon" title="Edit" onclick="openEditSource(${s.id})">✏️</button>
          <button class="btn btn-ghost btn-sm btn-icon" title="Delete" onclick="openDeleteSource(${s.id})">🗑️</button>
        </td>
      </tr>
    `).join('');
  }

  async function loadSources() {
    try {
      sources = await apiFetch('/sources');
      renderTable();
    } catch (err) {
      showAlert('Failed to load sources: ' + err.message, 'error');
    }
  }

  function openAddSource(prefill) {
    document.getElementById('sourceModalTitle').textContent = 'Add Source';
    document.getElementById('editSourceId').value = '';
    document.getElementById('fSName').value     = prefill ? prefill.name : '';
    document.getElementById('fSUrl').value      = prefill ? prefill.url  : '';
    document.getElementById('fSPriority').value = '1';
    document.getElementById('fSActive').checked        = true;
    document.getElementById('fSAutoPublish').checked   = false;
    document.getElementById('fSAutoPublishMax').value  = '5';
    document.getElementById('maxPublishGroup').style.display = 'none';
    openModal('sourceModal');
    document.getElementById('fSName').focus();
  }

  function openEditSource(id) {
    const s = sources.find(x => x.id === id);
    if (!s) return;
    document.getElementById('sourceModalTitle').textContent = 'Edit Source';
    document.getElementById('editSourceId').value           = s.id;
    document.getElementById('fSName').value                 = s.name || '';
    document.getElementById('fSUrl').value                  = s.url  || '';
    document.getElementById('fSPriority').value             = s.priority || 1;
    document.getElementById('fSActive').checked             = !!s.is_active;
    document.getElementById('fSAutoPublish').checked        = !!s.auto_publish;
    document.getElementById('fSAutoPublishMax').value       = s.auto_publish_max || 5;
    document.getElementById('maxPublishGroup').style.display = s.auto_publish ? '' : 'none';
    openModal('sourceModal');
    document.getElementById('fSName').focus();
  }

  function openDeleteSource(id) {
    deleteSourceId = id;
    openModal('deleteSourceModal');
  }

  async function saveSource() {
    const id   = document.getElementById('editSourceId').value;
    const name = document.getElementById('fSName').value.trim();
    const url  = document.getElementById('fSUrl').value.trim();
    if (!name) { showAlert('Source name is required', 'error'); return; }
    if (!url)  { showAlert('RSS URL is required', 'error');  return; }

    const payload = {
      name,
      url,
      priority         : parseInt(document.getElementById('fSPriority').value) || 1,
      is_active        : document.getElementById('fSActive').checked,
      auto_publish     : document.getElementById('fSAutoPublish').checked,
      auto_publish_max : parseInt(document.getElementById('fSAutoPublishMax').value) || 5,
    };

    const saveBtn = document.getElementById('saveSourceBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      if (id) {
        const updated = await apiFetch(`/sources/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        const idx = sources.findIndex(s => s.id === parseInt(id));
        if (idx >= 0) sources[idx] = updated;
        showAlert('Source updated ✓');
      } else {
        const created = await apiFetch('/sources', { method: 'POST', body: JSON.stringify(payload) });
        sources.unshift(created);
        showAlert('Source added ✓');
      }
      closeModal('sourceModal');
      renderTable();
    } catch (err) {
      showAlert('Error: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Source';
    }
  }

  async function confirmDeleteSource() {
    if (!deleteSourceId) return;
    try {
      await apiFetch(`/sources/${deleteSourceId}`, { method: 'DELETE' });
      sources = sources.filter(s => s.id !== deleteSourceId);
      renderTable();
      closeModal('deleteSourceModal');
      showAlert('Source deleted');
      deleteSourceId = null;
    } catch (err) {
      showAlert('Delete failed: ' + err.message, 'error');
    }
  }

  async function toggleActive(id) {
    try {
      const res = await apiFetch(`/sources/${id}/toggle`, { method: 'PUT' });
      const s = sources.find(x => x.id === id);
      if (s) s.is_active = res.is_active;
      renderTable();
    } catch (err) {
      showAlert('Error: ' + err.message, 'error');
    }
  }

  function renderSuggestedFeeds() {
    const existing = new Set(sources.map(s => s.url));
    const byCategory = {};
    for (const f of SUGGESTED_FEEDS) {
      if (!byCategory[f.category]) byCategory[f.category] = [];
      byCategory[f.category].push(f);
    }

    let html = '';
    for (const [cat, feeds] of Object.entries(byCategory)) {
      html += `<div style="padding:12px 20px 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);">${escHtml(cat)}</div>`;
      for (const f of feeds) {
        const added = existing.has(f.url);
        html += `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid var(--border);">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:500;font-size:14px;">${escHtml(f.name)}</div>
              <div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(f.url)}</div>
            </div>
            ${added
              ? `<span class="badge badge-success" style="flex-shrink:0;">Added</span>`
              : `<button class="btn btn-primary btn-sm" style="flex-shrink:0;" onclick="prefillFromSuggested('${escHtml(f.name)}','${escHtml(f.url)}')">＋ Add</button>`
            }
          </div>`;
      }
    }
    document.getElementById('suggestedList').innerHTML = html;
  }

  function prefillFromSuggested(name, url) {
    closeModal('suggestedModal');
    openAddSource({ name, url });
  }

  onReady(async () => {
    if (!requireAuth()) return;
    renderSidebar();
    initModals();

    document.getElementById('addSourceBtn').addEventListener('click', () => openAddSource());
    document.getElementById('saveSourceBtn').addEventListener('click', saveSource);
    document.getElementById('confirmDeleteSourceBtn').addEventListener('click', confirmDeleteSource);

    // Show/hide max input when auto-publish toggled
    document.getElementById('fSAutoPublish').addEventListener('change', function() {
      document.getElementById('maxPublishGroup').style.display = this.checked ? '' : 'none';
    });

    // Suggested feeds modal
    document.getElementById('suggested-btn').addEventListener('click', () => {
      renderSuggestedFeeds();
      openModal('suggestedModal');
    });

    await loadSources();
  });

  // Fetch all sources
  const fetchBtn = document.getElementById('fetch-btn');
  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = 'Fetching…';
      try {
        const data = await apiFetch('/fetch', { method: 'POST', body: JSON.stringify({}) });
        showAlert(`✅ Done! ${data.inserted} new articles added. ${data.skipped} already existed.`);
        await loadSources();
      } catch (e) {
        showAlert('❌ Fetch failed: ' + e.message, 'error');
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = '🔄 Fetch All Sources';
      }
    });
  }