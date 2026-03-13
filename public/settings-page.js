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
    { id: 'siteOgImage',          key: 'site_og_image' },
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


  // Color picker sync
  function syncColorPicker(pickerId, textId) {
    const picker = document.getElementById(pickerId);
    const text   = document.getElementById(textId);
    if (!picker || !text) return;
    picker.addEventListener('input', () => { text.value = picker.value; });
    text.addEventListener('input', () => {
      if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value;
    });
  }
  syncColorPicker('siteAccentColor', 'siteAccentColorText');
  syncColorPicker('siteBgColor',     'siteBgColorText');

  // Category list editor
  let _siteCategories = [];

  function renderCategories() {
    const container = document.getElementById('siteCategoriesList');
    if (!container) return;
    container.innerHTML = _siteCategories.map((cat, i) => `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;" data-cat-idx="${i}">
        <input type="text" class="form-control" value="${escHtml(cat.name)}" data-cat-name="${i}"
               style="flex:1;max-width:200px;" placeholder="Category name" />
        <input type="color" value="${cat.color || '#7c3aed'}" data-cat-color="${i}"
               style="width:36px;height:30px;border:none;background:none;cursor:pointer;" />
        <input type="text" class="form-control" value="${cat.color || '#7c3aed'}" data-cat-color-text="${i}"
               style="width:90px;font-family:monospace;font-size:12px;" />
        <button class="btn btn-ghost btn-sm" data-cat-remove="${i}" type="button" title="Remove" style="color:var(--danger);">✕</button>
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
    container.querySelectorAll('[data-cat-remove]').forEach(el => {
      el.addEventListener('click', () => {
        _siteCategories.splice(Number(el.dataset.catRemove), 1);
        renderCategories();
      });
    });
  }

  document.getElementById('addCategoryBtn')?.addEventListener('click', () => {
    _siteCategories.push({ name: '', color: '#7c3aed' });
    renderCategories();
  });

  function loadSiteSettings(settings) {
    for (const f of SITE_FIELDS) {
      const el = document.getElementById(f.id);
      if (el) el.value = settings[f.key] || '';
    }
    // Colors
    const accent = settings.site_accent_color || '#4F8EF7';
    const bg     = settings.site_bg_color || '#0d1117';
    const accentPicker = document.getElementById('siteAccentColor');
    const accentText   = document.getElementById('siteAccentColorText');
    const bgPicker     = document.getElementById('siteBgColor');
    const bgText       = document.getElementById('siteBgColorText');
    if (accentPicker) accentPicker.value = accent;
    if (accentText)   accentText.value   = accent;
    if (bgPicker)     bgPicker.value     = bg;
    if (bgText)       bgText.value       = bg;

    // Categories
    try {
      _siteCategories = JSON.parse(settings.site_categories || '[]');
    } catch { _siteCategories = []; }
    renderCategories();

    // Logo preview
    if (logoPreview && settings.site_logo_html) {
      logoPreview.innerHTML = settings.site_logo_html;
    }
  }

  document.getElementById('saveSiteSettingsBtn')?.addEventListener('click', async function () {
    const payload = {};
    for (const f of SITE_FIELDS) {
      const el = document.getElementById(f.id);
      if (el) payload[f.key] = el.value;
    }
    payload.site_accent_color = document.getElementById('siteAccentColorText')?.value || '#4F8EF7';
    payload.site_bg_color     = document.getElementById('siteBgColorText')?.value || '#0d1117';

    // Clean up categories — remove empty names
    const cleanCats = _siteCategories.filter(c => c.name && c.name.trim());
    payload.site_categories = JSON.stringify(cleanCats);

    const statusEl = document.getElementById('siteSettingsStatus');
    try {
      this.disabled = true; this.textContent = 'Saving…';
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
      statusEl.textContent = '✅ Site settings saved';
      showAlert('Site settings saved ✓');
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    } catch (err) {
      statusEl.textContent = '❌ ' + err.message;
      showAlert('Save failed: ' + err.message, 'error');
    } finally {
      this.disabled = false; this.textContent = 'Save Site Settings';
    }
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
      loadSiteSettings(settings);
    } catch (err) {
      showAlert('Failed to load settings: ' + err.message, 'error');
    }
  };

  initModals();
  loadSettings();