// ── Settings Tab Switching ────────────────────────────────
(function initSettingsTabs() {
  const tabBar = document.getElementById('settingsTabs');
  if (!tabBar) return;
  const btns   = tabBar.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel[data-tab]');

  function switchTab(name) {
    btns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    panels.forEach(p => p.classList.toggle('active', p.dataset.tab === name));
    sessionStorage.setItem('dfa_settings_tab', name);
  }

  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (btn) switchTab(btn.dataset.tab);
  });

  const saved = sessionStorage.getItem('dfa_settings_tab');
  if (saved && document.querySelector('.tab-panel[data-tab="' + saved + '"]')) {
    switchTab(saved);
  }
})();

// ── Theme Presets ────────────────────────────────────────
const THEME_PRESETS = [
  { name: 'Dark Blue',    accent: '#4F8EF7', bg: '#0d1117', bgCard: '#161b22', border: '#21262d', text: '#e6edf3', muted: '#8b949e', accentDim: '#2d5fbe' },
  { name: 'Dark Cyan',    accent: '#00d9ff', bg: '#0d0d0d', bgCard: '#161616', border: '#222222', text: '#f0f0f0', muted: '#888888', accentDim: '#0099b3' },
  { name: 'Dark Purple',  accent: '#a78bfa', bg: '#0f0b1a', bgCard: '#1a1525', border: '#2d2640', text: '#e8e0f0', muted: '#9990a8', accentDim: '#7c5fc4' },
  { name: 'Midnight Green',accent: '#34d399', bg: '#0a1214', bgCard: '#121e22', border: '#1e3030', text: '#e0f0ec', muted: '#7da89e', accentDim: '#1f9e6f' },
];

const COLOR_FIELDS = [
  { picker: 'siteAccentColor',    text: 'siteAccentColorText',    key: 'site_accent_color' },
  { picker: 'siteBgColor',        text: 'siteBgColorText',        key: 'site_bg_color' },
  { picker: 'siteBgCardColor',    text: 'siteBgCardColorText',    key: 'site_bg_card_color' },
  { picker: 'siteBorderColor',    text: 'siteBorderColorText',    key: 'site_border_color' },
  { picker: 'siteTextColor',      text: 'siteTextColorText',      key: 'site_text_color' },
  { picker: 'siteMutedColor',     text: 'siteMutedColorText',     key: 'site_muted_color' },
  { picker: 'siteAccentDimColor', text: 'siteAccentDimColorText', key: 'site_accent_dim_color' },
];

// Sync color picker ↔ text input for all 7 fields
COLOR_FIELDS.forEach(f => {
  const picker = document.getElementById(f.picker);
  const text   = document.getElementById(f.text);
  if (picker && text) {
    picker.addEventListener('input', () => { text.value = picker.value; });
    text.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value;
    });
  }
});

// Render preset buttons
(function renderPresets() {
  const container = document.getElementById('themePresets');
  if (!container) return;
  THEME_PRESETS.forEach((preset, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-outline btn-sm';
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
    btn.innerHTML = '<span style="width:12px;height:12px;border-radius:50%;background:' + preset.accent + ';display:inline-block;"></span> ' + preset.name;
    btn.addEventListener('click', () => {
      const vals = [preset.accent, preset.bg, preset.bgCard, preset.border, preset.text, preset.muted, preset.accentDim];
      COLOR_FIELDS.forEach((f, j) => {
        const picker = document.getElementById(f.picker);
        const text   = document.getElementById(f.text);
        if (picker) picker.value = vals[j];
        if (text)   text.value = vals[j];
      });
    });
    container.appendChild(btn);
  });
})();

// ── Logo Upload ──────────────────────────────────────────
function initLogoUpload(kind) {
  const fileInput  = document.getElementById(kind + 'FileInput');
  const selectBtn  = document.getElementById(kind + 'SelectBtn');
  const uploadBtn  = document.getElementById(kind + 'UploadBtn');
  const previewImg = document.getElementById(kind + 'PreviewImg');
  const statusEl   = document.getElementById(kind + 'UploadStatus');
  if (!fileInput || !selectBtn) return;

  selectBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      statusEl.textContent = '⚠️ File too large (max 2MB)';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      previewImg.src = reader.result;
      previewImg.style.display = 'block';
      const emptyEl = document.getElementById(kind + 'PreviewEmpty');
      if (emptyEl) emptyEl.style.display = 'none';
      uploadBtn.style.display = 'inline-flex';
      uploadBtn._dataUrl = reader.result;
    };
    reader.readAsDataURL(file);
  });

  uploadBtn.addEventListener('click', async () => {
    if (!uploadBtn._dataUrl) return;
    uploadBtn.disabled = true;
    statusEl.textContent = 'Uploading…';
    try {
      const type = kind === 'favicon' ? 'favicon' : 'logo';
      const res = await apiFetch('/settings/logo', {
        method: 'POST',
        body: JSON.stringify({ dataUrl: uploadBtn._dataUrl, type }),
      });
      statusEl.textContent = '✅ Uploaded successfully';
      uploadBtn.style.display = 'none';
      previewImg.src = res.url;
    } catch (err) {
      statusEl.textContent = '❌ Upload failed: ' + err.message;
    } finally {
      uploadBtn.disabled = false;
    }
  });
}
initLogoUpload('logo');
initLogoUpload('favicon');
initLogoUpload('ogimage');

let apiKeyVisible = false;

  document.getElementById('toggleApiKeyBtn').addEventListener('click', function() {
    const input = document.getElementById('elApiKey');
    apiKeyVisible = !apiKeyVisible;
    input.type = apiKeyVisible ? 'text' : 'password';
    this.textContent = apiKeyVisible ? '🙈' : '👁️';
  });

  document.getElementById('saveElBtn').addEventListener('click', async function() {
    const value = document.getElementById('elApiKey').value.trim();
    // If empty, we allow saving empty to clear the override
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elevenlabs_api_key: value })
      });
      showAlert(value ? 'API key saved ✓' : 'API key cleared — using environment variable');
      document.getElementById('elApiKey').value = '';
      await loadSettings();
    } catch (err) {
      showAlert('Save failed: ' + err.message, 'error');
    }
  });

  // ── Image Generation settings ──────────────────────────────────
  const IMAGEN_MODELS = [
    'imagen-4.0-generate-001',
    'imagen-4.0-ultra-generate-001',
    'imagen-4.0-fast-generate-001',
  ];
  let imagenKeyVisible = false;

  function loadImagenSettings(settings) {
    const modelEl  = document.getElementById('imagenModel');
    const statusEl = document.getElementById('imagenKeyStatus');

    // Set model dropdown
    const savedModel = settings.imagen_model || 'imagen-4.0-generate-001';
    modelEl.value = IMAGEN_MODELS.includes(savedModel) ? savedModel : 'imagen-4.0-generate-001';

    // API key status
    if (settings.imagen_api_key) {
      statusEl.textContent = '✅ API key is set (leave blank to keep current value)';
      document.getElementById('imagenApiKey').placeholder = '••••••••••••••••••••••••••••••••';
    } else {
      statusEl.textContent = '⚠️ No API key set — using GEMINI_API_KEY environment variable';
    }
  }

  document.getElementById('toggleImagenKeyBtn').addEventListener('click', function() {
    imagenKeyVisible = !imagenKeyVisible;
    document.getElementById('imagenApiKey').type = imagenKeyVisible ? 'text' : 'password';
    this.textContent = imagenKeyVisible ? '🙈' : '👁️';
  });

  document.getElementById('saveImagenBtn').addEventListener('click', async function() {
    const model  = document.getElementById('imagenModel').value;
    const apiKey = document.getElementById('imagenApiKey').value.trim();
    try {
      this.disabled = true;
      this.textContent = 'Saving…';
      await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagen_model: model, ...(apiKey !== '' && { imagen_api_key: apiKey }) })
      });
      showAlert('Image settings saved ✓');
      document.getElementById('imagenApiKey').value = '';
      const fresh = await apiFetch('/settings');
      loadImagenSettings(fresh);
    } catch (err) {
      showAlert('Save failed: ' + err.message, 'error');
    } finally {
      this.disabled = false;
      this.textContent = 'Save Image Settings';
    }
  });

  async function loadSettings() {
    try {
      const settings = await apiFetch('/settings');

      // ElevenLabs
      const keyEl    = document.getElementById('elApiKey');
      const statusEl = document.getElementById('apiKeyStatus');
      if (settings.elevenlabs_api_key) {
        keyEl.placeholder = '••••••••••••••••••••••••••••••••';
        statusEl.textContent = '✅ API key is set (leave blank to keep current value)';
        keyEl.value = '';
      } else {
        statusEl.textContent = '⚠️ No API key set — using ELEVENLABS_API_KEY environment variable';
      }

      // Image generation
      loadImagenSettings(settings);
    } catch (err) {
      showAlert('Failed to load settings: ' + err.message, 'error');
    }
  }

  // ── Content Lifecycle / Purge ─────────────────────────────────────
  function loadPurgeSettings(settings) {
    document.getElementById('purgeEnabled').checked              = settings.purge_enabled === '1';
    document.getElementById('purgeDays').value                   = settings.purge_days || '30';
    document.getElementById('purgeProtectFeatured').checked      = settings.purge_protect_featured !== '0';
    document.getElementById('purgeProtectAudio').checked         = settings.purge_protect_audio === '1';
    document.getElementById('purgeProtectEngaged').checked       = settings.purge_protect_engaged === 'true';
    document.getElementById('purgeProtectEngagedDays').value     = settings.purge_protect_engaged_days || '7';
    document.getElementById('purgeGraceHours').value             = settings.purge_grace_hours || '24';
    toggleEngagedDaysRow();
  }

  function toggleEngagedDaysRow() {
    const checked = document.getElementById('purgeProtectEngaged').checked;
    document.getElementById('purgeEngagedDaysRow').style.display = checked ? '' : 'none';
  }
  document.getElementById('purgeProtectEngaged').addEventListener('change', toggleEngagedDaysRow);

  document.getElementById('savePurgeSettingsBtn').addEventListener('click', async function () {
    const payload = {
      purge_enabled:               document.getElementById('purgeEnabled').checked ? '1' : '0',
      purge_days:                  String(Math.max(parseInt(document.getElementById('purgeDays').value) || 30, 7)),
      purge_protect_featured:      document.getElementById('purgeProtectFeatured').checked ? '1' : '0',
      purge_protect_audio:         document.getElementById('purgeProtectAudio').checked    ? '1' : '0',
      purge_protect_engaged:       document.getElementById('purgeProtectEngaged').checked  ? 'true' : 'false',
      purge_protect_engaged_days:  String(Math.max(parseInt(document.getElementById('purgeProtectEngagedDays').value) || 7, 1)),
      purge_grace_hours:           String(Math.max(parseInt(document.getElementById('purgeGraceHours').value) || 24, 1)),
    };
    try {
      this.disabled = true; this.textContent = 'Saving…';
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
      document.getElementById('purgeSettingsStatus').textContent = '✅ Purge settings saved';
      showAlert('Purge settings saved ✓');
    } catch (err) {
      showAlert('Save failed: ' + err.message, 'error');
    } finally {
      this.disabled = false; this.textContent = 'Save Settings';
    }
  });

  let _lastDryRunResult = null;

  document.getElementById('dryRunPurgeBtn').addEventListener('click', async function () {
    const days            = Math.max(parseInt(document.getElementById('purgeDays').value) || 30, 7);
    const protectFeatured = document.getElementById('purgeProtectFeatured').checked;
    const protectAudio    = document.getElementById('purgeProtectAudio').checked;
    try {
      this.disabled = true; this.textContent = '⏳ Scanning…';
      const data = await apiFetch('/articles/purge-old', {
        method: 'POST',
        body: JSON.stringify({ days, dryRun: true, protectFeatured, protectAudio })
      });
      _lastDryRunResult = { days, protectFeatured, protectAudio };

      const preview = document.getElementById('purgePreviewContent');
      if (data.eligibleCount === 0) {
        preview.innerHTML = `
          <div style="text-align:center;padding:24px 0;">
            <div style="font-size:32px;margin-bottom:8px;">✅</div>
            <p class="text-muted">No articles older than <strong>${days} days</strong> to archive.</p>
            ${data.protectedCount > 0 ? `<p class="form-help">${data.protectedCount} article(s) are protected and would be skipped.</p>` : ''}
          </div>`;
        document.getElementById('confirmPurgeNowBtn').style.display = 'none';
      } else {
        const sampleRows = data.eligible.slice(0, 8).map(a =>
          `<li style="font-size:13px;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--border);">${escHtml(a.title)} <span style="font-size:11px;">(${fmtDate(a.created_at)})</span></li>`
        ).join('');
        const moreCount = data.eligibleCount - Math.min(data.eligibleCount, 8);
        preview.innerHTML = `
          <p style="margin-bottom:14px;">
            <strong style="color:var(--danger);font-size:16px;">${data.eligibleCount}</strong>
            article${data.eligibleCount !== 1 ? 's' : ''} older than <strong>${days} days</strong> will be archived.
            ${data.protectedCount > 0 ? `<span class="text-muted text-sm"> (${data.protectedCount} protected)</span>` : ''}
          </p>
          <ul style="list-style:none;padding:0;margin:0 0 10px;">${sampleRows}</ul>
          ${moreCount > 0 ? `<p style="font-size:12px;color:var(--muted);">…and ${moreCount} more</p>` : ''}
          <p style="font-size:12px;color:var(--muted);margin-top:12px;">Archived articles are soft-deleted and permanently purged after the configured grace period.</p>`;
        document.getElementById('confirmPurgeNowBtn').style.display = 'inline-flex';
      }
      openModal('purgePreviewModal');
    } catch (err) {
      showAlert('Preview failed: ' + err.message, 'error');
    } finally {
      this.disabled = false; this.textContent = '🔍 Preview Purge';
    }
  });

  document.getElementById('confirmPurgeNowBtn').addEventListener('click', async function () {
    if (!_lastDryRunResult) return;
    const { days, protectFeatured, protectAudio } = _lastDryRunResult;
    try {
      this.disabled = true; this.textContent = '⏳ Archiving…';
      const data = await apiFetch('/articles/purge-old', {
        method: 'POST',
        body: JSON.stringify({ days, dryRun: false, protectFeatured, protectAudio })
      });
      closeModal('purgePreviewModal');
      showAlert(`✅ ${data.message}`);
      _lastDryRunResult = null;
    } catch (err) {
      showAlert('Purge failed: ' + err.message, 'error');
    } finally {
      this.disabled = false; this.textContent = '🗑️ Archive Now';
    }
  });

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Spam detection settings ───────────────────────────────────────
  let perspKeyVisible = false;
  document.getElementById('togglePerspKeyBtn')?.addEventListener('click', function () {
    const inp = document.getElementById('perspectiveKey');
    perspKeyVisible = !perspKeyVisible;
    inp.type = perspKeyVisible ? 'text' : 'password';
    this.textContent = perspKeyVisible ? '🙈' : '👁️';
  });

  function loadSpamSettings(settings) {
    const blocklist  = document.getElementById('spamBlocklist');
    const enabled    = document.getElementById('perspectiveEnabled');
    const blockThr   = document.getElementById('spamBlockThreshold');
    const queueThr   = document.getElementById('spamQueueThreshold');
    if (blocklist) blocklist.value  = settings.spam_blocklist          || '';
    if (enabled)   enabled.checked  = settings.spam_perspective_enabled === '1';
    if (blockThr)  blockThr.value   = settings.spam_block_threshold    || '0.85';
    if (queueThr)  queueThr.value   = settings.spam_queue_threshold    || '0.50';
    // Don't pre-fill API key
  }

  document.getElementById('saveSpamSettingsBtn')?.addEventListener('click', async function () {
    const statusEl = document.getElementById('spamSettingsStatus');
    const payload  = {
      spam_blocklist:            document.getElementById('spamBlocklist').value.trim(),
      spam_perspective_enabled:  document.getElementById('perspectiveEnabled').checked ? '1' : '0',
      spam_block_threshold:      document.getElementById('spamBlockThreshold').value,
      spam_queue_threshold:      document.getElementById('spamQueueThreshold').value,
    };
    const key = document.getElementById('perspectiveKey').value.trim();
    if (key) payload.spam_perspective_key = key;

    try {
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
      statusEl.textContent = '✅ Saved';
      document.getElementById('perspectiveKey').value = '';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    } catch (err) {
      statusEl.textContent = '❌ ' + err.message;
    }
  });

  // ── Moderation queue settings ──────────────────────────────────────
  function loadModQueueSettings(settings) {
    const enabled   = document.getElementById('modQueueEnabled');
    const threshold = document.getElementById('modQueueThreshold');
    if (enabled)   enabled.checked    = settings.mod_queue_enabled === '1';
    if (threshold) threshold.value    = settings.mod_queue_threshold || '1';
  }

  document.getElementById('saveModQueueBtn')?.addEventListener('click', async function () {
    const enabled   = document.getElementById('modQueueEnabled').checked ? '1' : '0';
    const threshold = document.getElementById('modQueueThreshold').value || '1';
    const statusEl  = document.getElementById('modQueueStatus');
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({ mod_queue_enabled: enabled, mod_queue_threshold: threshold }),
      });
      statusEl.textContent = '✅ Saved';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    } catch (err) {
      statusEl.textContent = '❌ ' + err.message;
    }
  });

  // ── Site Customization ────────────────────────────────────────────
  const SITE_FIELDS = [
    { id: 'siteName',              key: 'site_name' },
    { id: 'siteShortName',        key: 'site_short_name' },
    { id: 'siteTagline',          key: 'site_tagline' },
    { id: 'siteDescription',      key: 'site_description' },
    { id: 'siteLogoEmoji',        key: 'site_logo_emoji' },
    { id: 'siteLogoHtml',         key: 'site_logo_html' },
    { id: 'siteDomain',           key: 'site_domain' },
    { id: 'siteUrl',              key: 'site_url' },
    { id: 'siteTwitterHandle',    key: 'site_twitter_handle' },
    { id: 'siteCopyright',        key: 'site_copyright' },
    { id: 'siteFooterTagline',    key: 'site_footer_tagline' },
    { id: 'siteGaId',             key: 'site_ga_id' },
    { id: 'siteAdsenseId',        key: 'site_adsense_id' },
    { id: 'siteAiPersona',        key: 'site_ai_persona' },
    { id: 'siteNewsletterSubject', key: 'site_newsletter_subject' },
    { id: 'siteEmailFromName',    key: 'site_email_from_name' },
  ];

  // Logo HTML live preview
  const logoHtmlInput  = document.getElementById('siteLogoHtml');
  const logoPreview    = document.getElementById('siteLogoPreview');
  const logoEmojiInput = document.getElementById('siteLogoEmoji');

  if (logoHtmlInput && logoPreview) {
    logoHtmlInput.addEventListener('input', () => { logoPreview.innerHTML = logoHtmlInput.value; });
  }

  // Auto-sync: when Logo Emoji changes, replace the leading emoji in Logo HTML
  if (logoEmojiInput && logoHtmlInput) {
    logoEmojiInput.addEventListener('input', () => {
      const newEmoji = logoEmojiInput.value.trim();
      if (!newEmoji) return;
      const current = logoHtmlInput.value;
      const updated = current.replace(/^[\p{Emoji}\u200d\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}]+/u, newEmoji);
      logoHtmlInput.value = updated !== current ? updated : newEmoji + current.replace(/^[^\s&]+/, '');
      if (logoPreview) logoPreview.innerHTML = logoHtmlInput.value;
    });
  }


  // Category list editor
  let _siteCategories = [];

  function renderCategories() {
    const container = document.getElementById('siteCategoriesList');
    if (!container) return;
    container.innerHTML = _siteCategories.map((cat, i) => `
      <div style="margin-bottom:12px;padding:10px;border:1px solid var(--border);border-radius:8px;" data-cat-idx="${i}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <input type="text" class="form-control" value="${escHtml(cat.name)}" data-cat-name="${i}"
                 style="flex:1;max-width:200px;" placeholder="Category name" />
          <input type="color" value="${cat.color || '#7c3aed'}" data-cat-color="${i}"
                 style="width:36px;height:30px;border:none;background:none;cursor:pointer;" />
          <input type="text" class="form-control" value="${cat.color || '#7c3aed'}" data-cat-color-text="${i}"
                 style="width:90px;font-family:monospace;font-size:12px;" />
          <button class="btn btn-ghost btn-sm" data-cat-remove="${i}" type="button" title="Remove" style="color:var(--danger);">✕</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" class="form-control" value="${escHtml((cat.keywords || []).join(', '))}" data-cat-keywords="${i}"
                 style="flex:1;font-size:12px;color:var(--muted);" placeholder="Keywords (comma-separated) for auto-categorization" />
          <button class="btn btn-outline btn-sm" data-cat-generate="${i}" type="button" title="Auto-generate keywords with AI" style="white-space:nowrap;">AI</button>
        </div>
      </div>
    `).join('');

    // Bind events
    container.querySelectorAll('[data-cat-name]').forEach(el => {
      el.addEventListener('input', () => {
        _siteCategories[Number(el.dataset.catName)].name = el.value;
      });
    });
    container.querySelectorAll('[data-cat-color]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = Number(el.dataset.catColor);
        _siteCategories[idx].color = el.value;
        const textEl = container.querySelector(`[data-cat-color-text="${idx}"]`);
        if (textEl) textEl.value = el.value;
      });
    });
    container.querySelectorAll('[data-cat-color-text]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = Number(el.dataset.catColorText);
        if (/^#[0-9a-f]{6}$/i.test(el.value)) {
          _siteCategories[idx].color = el.value;
          const picker = container.querySelector(`[data-cat-color="${idx}"]`);
          if (picker) picker.value = el.value;
        }
      });
    });
    container.querySelectorAll('[data-cat-keywords]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = Number(el.dataset.catKeywords);
        _siteCategories[idx].keywords = el.value.split(',').map(k => k.trim()).filter(Boolean);
      });
    });
    container.querySelectorAll('[data-cat-remove]').forEach(el => {
      el.addEventListener('click', () => {
        _siteCategories.splice(Number(el.dataset.catRemove), 1);
        renderCategories();
      });
    });
    container.querySelectorAll('[data-cat-generate]').forEach(el => {
      el.addEventListener('click', async () => {
        const idx = Number(el.dataset.catGenerate);
        const cat = _siteCategories[idx];
        if (!cat || !cat.name.trim()) { showAlert('Enter a category name first', 'error'); return; }
        el.disabled = true; el.textContent = '…';
        try {
          const result = await apiFetch('/categories/generate-keywords', {
            method: 'POST',
            body: JSON.stringify({ name: cat.name, existingKeywords: cat.keywords || [] }),
          });
          if (result.keywords && result.keywords.length) {
            // Merge with existing, deduplicate
            const merged = [...new Set([...(cat.keywords || []), ...result.keywords])];
            _siteCategories[idx].keywords = merged;
            renderCategories();
            showAlert(`Generated ${result.keywords.length} keywords for ${cat.name}`);
          }
        } catch (err) {
          showAlert('Keyword generation failed: ' + err.message, 'error');
        } finally {
          el.disabled = false; el.textContent = 'AI';
        }
      });
    });
  }

  document.getElementById('addCategoryBtn')?.addEventListener('click', () => {
    _siteCategories.push({ name: '', color: '#7c3aed', keywords: [] });
    renderCategories();
  });

  document.getElementById('generateAllKeywordsBtn')?.addEventListener('click', async function () {
    const catsWithNames = _siteCategories.filter(c => c.name && c.name.trim());
    if (!catsWithNames.length) { showAlert('Add at least one category first', 'error'); return; }
    this.disabled = true; this.textContent = 'Generating…';
    let generated = 0;
    try {
      for (let i = 0; i < _siteCategories.length; i++) {
        const cat = _siteCategories[i];
        if (!cat.name || !cat.name.trim()) continue;
        try {
          const result = await apiFetch('/categories/generate-keywords', {
            method: 'POST',
            body: JSON.stringify({ name: cat.name, existingKeywords: cat.keywords || [] }),
          });
          if (result.keywords && result.keywords.length) {
            _siteCategories[i].keywords = [...new Set([...(cat.keywords || []), ...result.keywords])];
            generated++;
          }
        } catch { /* continue to next */ }
      }
      renderCategories();
      showAlert(`Generated keywords for ${generated} of ${catsWithNames.length} categories. Review and press Save Categories when ready.`);
    } catch (err) {
      showAlert('Generation failed: ' + err.message, 'error');
    } finally {
      this.disabled = false; this.textContent = 'AI Generate All';
    }
  });

  // ── Per-panel save helper ─────────────────────────────────────────
  function panelSave(btnId, statusId, label, saveFn) {
    document.getElementById(btnId)?.addEventListener('click', async function () {
      const statusEl = document.getElementById(statusId);
      try {
        this.disabled = true; this.textContent = 'Saving…';
        await saveFn();
        statusEl.textContent = '✅ ' + label + ' saved';
        showAlert(label + ' saved ✓');
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
      } catch (err) {
        statusEl.textContent = '❌ ' + err.message;
        showAlert('Save failed: ' + err.message, 'error');
      } finally {
        this.disabled = false; this.textContent = 'Save ' + label;
      }
    });
  }

  function saveFields(fields) {
    const payload = {};
    for (const f of fields) {
      const el = document.getElementById(f.id);
      if (el) payload[f.key] = el.value;
    }
    return apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
  }

  // ── Categories save ─────────────────────────────────────────────
  panelSave('saveCategoriesBtn', 'categoriesStatus', 'Categories', async () => {
    const cleanCats = _siteCategories.filter(c => c.name && c.name.trim());
    const result = await apiFetch('/categories', { method: 'PUT', body: JSON.stringify(cleanCats) });
    if (Array.isArray(result)) {
      _siteCategories = result;
      renderCategories();
    }
  });

  // ── AI & Newsletter save ────────────────────────────────────────
  panelSave('saveNewsletterBtn', 'newsletterStatus', 'AI & Newsletter', () => saveFields([
    { id: 'siteAiPersona',        key: 'site_ai_persona' },
    { id: 'siteNewsletterSubject', key: 'site_newsletter_subject' },
    { id: 'siteEmailFromName',    key: 'site_email_from_name' },
  ]));

  // ── Analytics & Ads save ────────────────────────────────────────
  panelSave('saveAnalyticsBtn', 'analyticsAdsStatus', 'Analytics & Ads', () => saveFields([
    { id: 'siteGaId',       key: 'site_ga_id' },
    { id: 'siteAdsenseId',  key: 'site_adsense_id' },
  ]));

  // ── Perspective API save ────────────────────────────────────────
  panelSave('savePerspectiveBtn', 'perspectiveStatus', 'Perspective Settings', async () => {
    const payload = {
      spam_perspective_enabled: document.getElementById('perspectiveEnabled').checked ? '1' : '0',
    };
    const key = document.getElementById('perspectiveKey').value.trim();
    if (key) payload.spam_perspective_key = key;
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
    if (key) document.getElementById('perspectiveKey').value = '';
  });

  async function loadSiteSettings(settings) {
    for (const f of SITE_FIELDS) {
      const el = document.getElementById(f.id);
      if (el) el.value = settings[f.key] || '';
    }
    // Colors — load all 7 tokens
    const colorDefaults = {
      site_accent_color: '#4F8EF7', site_bg_color: '#0d1117', site_bg_card_color: '#161b22',
      site_border_color: '#21262d', site_text_color: '#e6edf3', site_muted_color: '#8b949e',
      site_accent_dim_color: '#2d5fbe',
    };
    COLOR_FIELDS.forEach(f => {
      const val = settings[f.key] || colorDefaults[f.key] || '#000000';
      const picker = document.getElementById(f.picker);
      const text   = document.getElementById(f.text);
      if (picker) picker.value = val;
      if (text)   text.value   = val;
    });

    // Logo image previews
    if (settings.site_logo_url) {
      const img = document.getElementById('logoPreviewImg');
      const empty = document.getElementById('logoPreviewEmpty');
      if (img) { img.src = settings.site_logo_url; img.style.display = 'block'; }
      if (empty) empty.style.display = 'none';
    }
    if (settings.site_favicon_url) {
      const img = document.getElementById('faviconPreviewImg');
      const empty = document.getElementById('faviconPreviewEmpty');
      if (img) { img.src = settings.site_favicon_url; img.style.display = 'block'; }
      if (empty) empty.style.display = 'none';
    }
    if (settings.site_og_image) {
      const img = document.getElementById('ogimagePreviewImg');
      const empty = document.getElementById('ogimagePreviewEmpty');
      if (img) { img.src = settings.site_og_image; img.style.display = 'block'; }
      if (empty) empty.style.display = 'none';
    }

    // Categories — loaded from /api/categories (falls back to legacy setting)
    try {
      const cats = await apiFetch('/categories');
      _siteCategories = Array.isArray(cats) && cats.length ? cats : [];
    } catch { _siteCategories = []; }
    if (!_siteCategories.length && settings.site_categories) {
      try { _siteCategories = JSON.parse(settings.site_categories); } catch { /* ignore */ }
    }
    renderCategories();

    // Logo preview
    if (logoPreview && settings.site_logo_html) {
      logoPreview.innerHTML = settings.site_logo_html;
    }
  }

  // ── Branding save ─────────────────────────────────────────────────
  panelSave('saveBrandingBtn', 'brandingStatus', 'Branding', () => saveFields([
    { id: 'siteName',          key: 'site_name' },
    { id: 'siteShortName',    key: 'site_short_name' },
    { id: 'siteTagline',      key: 'site_tagline' },
    { id: 'siteDescription',  key: 'site_description' },
    { id: 'siteLogoEmoji',    key: 'site_logo_emoji' },
    { id: 'siteLogoHtml',     key: 'site_logo_html' },
    { id: 'siteCopyright',    key: 'site_copyright' },
    { id: 'siteFooterTagline',key: 'site_footer_tagline' },
  ]));

  // ── Domain & URLs save ──────────────────────────────────────────
  panelSave('saveDomainBtn', 'domainStatus', 'Domain & URLs', () => saveFields([
    { id: 'siteDomain',        key: 'site_domain' },
    { id: 'siteUrl',           key: 'site_url' },
    { id: 'siteTwitterHandle', key: 'site_twitter_handle' },
  ]));

  // ── Theme save ──────────────────────────────────────────────────
  panelSave('saveThemeBtn', 'themeStatus', 'Theme', async () => {
    const payload = {};
    COLOR_FIELDS.forEach(f => {
      const text = document.getElementById(f.text);
      if (text) payload[f.key] = text.value;
    });
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
  });

  // ── Extend loadSettings to include all setting sections ───────────
  const _origLoadSettings = loadSettings;
  loadSettings = async function() {
    try {
      const settings = await apiFetch('/settings');
      const keyEl    = document.getElementById('elApiKey');
      const statusEl = document.getElementById('apiKeyStatus');
      if (settings.elevenlabs_api_key) {
        keyEl.placeholder = '••••••••••••••••••••••••••••••••';
        statusEl.textContent = '✅ API key is set (leave blank to keep current value)';
        keyEl.value = '';
      } else {
        statusEl.textContent = '⚠️ No API key set — using ELEVENLABS_API_KEY environment variable';
      }
      loadImagenSettings(settings);
      loadPurgeSettings(settings);
      loadSpamSettings(settings);
      loadModQueueSettings(settings);
      await loadSiteSettings(settings);
    } catch (err) {
      showAlert('Failed to load settings: ' + err.message, 'error');
    }
  };

  renderSidebar();
  initModals();
  loadSettings();