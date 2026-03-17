let sources = [];
  let deleteSourceId = null;
  let categoryNames = [];
  let _autoFilledName = '';

  // ── Suggested feeds by niche ──────────────────────────────────────
  const SUGGESTED_BY_NICHE = {
    'ai-tech': [
      { name: 'The Verge AI',           url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',    category: 'Tech Media' },
      { name: 'Wired AI',               url: 'https://www.wired.com/feed/category/artificial-intelligence/latest/rss', category: 'Tech Media' },
      { name: 'TechCrunch AI',          url: 'https://techcrunch.com/category/artificial-intelligence/feed/',          category: 'Tech Media' },
      { name: 'VentureBeat AI',         url: 'https://venturebeat.com/category/ai/feed/',                              category: 'Tech Media' },
      { name: 'Ars Technica',           url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',               category: 'Tech Media' },
      { name: 'MIT Technology Review',  url: 'https://www.technologyreview.com/feed/',                                  category: 'Research' },
      { name: 'Google AI Blog',         url: 'https://blog.google/technology/ai/rss/',                                  category: 'Company Blogs' },
      { name: 'OpenAI Blog',            url: 'https://openai.com/blog/rss.xml',                                         category: 'Company Blogs' },
      { name: 'Anthropic News',         url: 'https://www.anthropic.com/news/rss.xml',                                  category: 'Company Blogs' },
      { name: 'Meta AI Blog',           url: 'https://ai.meta.com/blog/rss/',                                           category: 'Company Blogs' },
      { name: 'DeepMind Blog',          url: 'https://deepmind.google/blog/rss.xml',                                    category: 'Company Blogs' },
      { name: 'Hugging Face Blog',      url: 'https://huggingface.co/blog/feed.xml',                                    category: 'Developer' },
      { name: 'NVIDIA AI Blog',         url: 'https://blogs.nvidia.com/blog/category/deep-learning/feed/',              category: 'Company Blogs' },
      { name: 'AI News',                url: 'https://www.artificialintelligence-news.com/feed/',                       category: 'Tech Media' },
      { name: 'The Batch (DeepLearning.AI)', url: 'https://www.deeplearning.ai/the-batch/rss/',                        category: 'Newsletters' },
      { name: 'Import AI (Jack Clark)', url: 'https://jack-clark.net/feed/',                                            category: 'Newsletters' },
    ],
    'crypto': [
      { name: 'CoinDesk',             url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',       category: 'News' },
      { name: 'The Block',            url: 'https://www.theblock.co/rss.xml',                       category: 'News' },
      { name: 'Decrypt',              url: 'https://decrypt.co/feed',                                category: 'News' },
      { name: 'CoinTelegraph',        url: 'https://cointelegraph.com/rss',                          category: 'News' },
      { name: 'DeFi Pulse Blog',      url: 'https://defipulse.com/blog/feed/',                       category: 'DeFi' },
      { name: 'Bankless',             url: 'https://newsletter.banklesshq.com/feed',                 category: 'Newsletters' },
      { name: 'Week in Ethereum',     url: 'https://weekinethereumnews.com/feed/',                   category: 'Ethereum' },
    ],
    'healthcare': [
      { name: 'STAT News',            url: 'https://www.statnews.com/feed/',                         category: 'News' },
      { name: 'Fierce Healthcare',    url: 'https://www.fiercehealthcare.com/rss/xml',               category: 'News' },
      { name: 'MobiHealthNews',       url: 'https://www.mobihealthnews.com/feed',                    category: 'Digital Health' },
      { name: 'Healthcare IT News',   url: 'https://www.healthcareitnews.com/feed',                  category: 'Health IT' },
      { name: 'Endpoints News',       url: 'https://endpts.com/feed/',                               category: 'Biotech' },
      { name: 'Fierce Biotech',       url: 'https://www.fiercebiotech.com/rss/xml',                  category: 'Biotech' },
    ],
    'climate': [
      { name: 'CleanTechnica',        url: 'https://cleantechnica.com/feed/',                        category: 'Clean Energy' },
      { name: 'Carbon Brief',         url: 'https://www.carbonbrief.org/feed/',                      category: 'Climate' },
      { name: 'Electrek',             url: 'https://electrek.co/feed/',                              category: 'EVs' },
      { name: 'Canary Media',         url: 'https://www.canarymedia.com/feed',                       category: 'Clean Energy' },
      { name: 'Grist',                url: 'https://grist.org/feed/',                                category: 'Climate' },
      { name: 'Inside Climate News',  url: 'https://insideclimatenews.org/feed/',                    category: 'Climate' },
    ],
    'fintech': [
      { name: 'Finextra',             url: 'https://www.finextra.com/rss/headlines.aspx',            category: 'News' },
      { name: 'TechCrunch Fintech',   url: 'https://techcrunch.com/category/fintech/feed/',          category: 'News' },
      { name: 'Finovate',             url: 'https://finovate.com/feed/',                             category: 'News' },
      { name: 'PaymentsSource',       url: 'https://www.paymentssource.com/feed',                    category: 'Payments' },
      { name: 'American Banker',      url: 'https://www.americanbanker.com/feed',                    category: 'Banking' },
    ],
    'cybersecurity': [
      { name: 'The Hacker News',      url: 'https://feeds.feedburner.com/TheHackersNews',            category: 'News' },
      { name: 'Krebs on Security',    url: 'https://krebsonsecurity.com/feed/',                      category: 'News' },
      { name: 'Dark Reading',         url: 'https://www.darkreading.com/rss.xml',                    category: 'News' },
      { name: 'BleepingComputer',     url: 'https://www.bleepingcomputer.com/feed/',                 category: 'News' },
      { name: 'Schneier on Security', url: 'https://www.schneier.com/feed/',                         category: 'Research' },
      { name: 'CISA Alerts',          url: 'https://www.cisa.gov/news.xml',                          category: 'Alerts' },
      { name: 'Threatpost',           url: 'https://threatpost.com/feed/',                           category: 'Threats' },
    ],
    'gaming': [
      { name: 'Kotaku',               url: 'https://kotaku.com/rss',                                 category: 'News' },
      { name: 'IGN',                  url: 'https://feeds.feedburner.com/ign/all',                   category: 'News' },
      { name: 'PC Gamer',             url: 'https://www.pcgamer.com/rss/',                           category: 'PC' },
      { name: 'Eurogamer',            url: 'https://www.eurogamer.net/feed',                         category: 'News' },
      { name: 'Rock Paper Shotgun',   url: 'https://www.rockpapershotgun.com/feed',                  category: 'PC' },
      { name: 'Polygon',              url: 'https://www.polygon.com/rss/index.xml',                  category: 'News' },
      { name: 'GamesIndustry.biz',    url: 'https://www.gamesindustry.biz/feed',                     category: 'Industry' },
    ],
  };
  // Fallback for custom or unknown niches
  SUGGESTED_BY_NICHE['custom'] = SUGGESTED_BY_NICHE['ai-tech'];

  let SUGGESTED_FEEDS = SUGGESTED_BY_NICHE['ai-tech']; // default, updated on load

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtLastFetched(val) {
    if (!val) return '<span class="text-muted text-sm">Never</span>';
    return `<span class="text-muted text-sm" title="${fmtDate(val)}">${relativeTime(val)}</span>`;
  }

  async function loadCategories() {
    try {
      const cats = await apiFetch('/categories');
      categoryNames = (cats || []).map(c => c.name);
      const sel = document.getElementById('fSDefaultCategory');
      sel.innerHTML = '<option value="">— Auto-detect —</option>' +
        categoryNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
    } catch { /* ignore */ }
  }

  function renderTable() {
    const tbody = document.getElementById('sourcesBody');
    if (sources.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8">
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
        <td>${s.default_category ? `<span class="badge">${escHtml(s.default_category)}</span>` : `<span class="text-muted text-sm">Auto</span>`}</td>
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
    document.getElementById('fSDefaultCategory').value = '';
    document.getElementById('feedStatus').innerHTML = '';
    _autoFilledName = '';
    openModal('sourceModal');
    if (prefill && prefill.url) document.getElementById('fSName').focus();
    else document.getElementById('fSUrl').focus();
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
    document.getElementById('fSDefaultCategory').value      = s.default_category || '';
    document.getElementById('feedStatus').innerHTML = '';
    _autoFilledName = '';
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
      default_category : document.getElementById('fSDefaultCategory').value || null,
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

    if (!hasPermission('sources.create')) {
      var btn = document.getElementById('addSourceBtn');
      if (btn) btn.style.display = 'none';
    }

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

    // Auto-fetch feed title when URL is entered
    let _feedPreviewDebounce;
    const urlInput = document.getElementById('fSUrl');
    const nameInput = document.getElementById('fSName');
    const feedStatus = document.getElementById('feedStatus');

    function previewFeed() {
      clearTimeout(_feedPreviewDebounce);
      const url = urlInput.value.trim();
      if (!url || !url.startsWith('http')) { feedStatus.innerHTML = ''; return; }
      _feedPreviewDebounce = setTimeout(async () => {
        feedStatus.innerHTML = '<span style="color:var(--muted);">Checking feed…</span>';
        try {
          const data = await apiFetch('/sources/preview-feed', {
            method: 'POST',
            body: JSON.stringify({ url }),
          });
          feedStatus.innerHTML = `<span style="color:var(--success);">✓ Valid feed · ${data.itemCount} article${data.itemCount !== 1 ? 's' : ''}</span>`;
          // Auto-populate name if empty or still has a previous auto-filled value
          if (data.title && (!nameInput.value.trim() || nameInput.value === _autoFilledName)) {
            nameInput.value = data.title;
            _autoFilledName = data.title;
          }
        } catch (err) {
          feedStatus.innerHTML = `<span style="color:var(--danger);">✗ ${escHtml(err.message || 'Not a valid RSS feed')}</span>`;
        }
      }, 600);
    }

    urlInput.addEventListener('input', previewFeed);
    urlInput.addEventListener('paste', () => setTimeout(previewFeed, 50));

    // Load niche-specific suggested feeds
    try {
      const settings = await apiFetch('/settings').catch(() => ({}));
      if (settings.wizard_niche && SUGGESTED_BY_NICHE[settings.wizard_niche]) {
        SUGGESTED_FEEDS = SUGGESTED_BY_NICHE[settings.wizard_niche];
      }
    } catch {}

    await Promise.all([loadSources(), loadCategories()]);
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