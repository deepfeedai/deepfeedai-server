// ── Sanitize HTML for logo preview (strip scripts and event handlers) ──
function sanitizeLogoHtml(html) {
  var div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script,iframe,object,embed,link,style').forEach(function(el) { el.remove(); });
  div.querySelectorAll('*').forEach(function(el) {
    for (var i = el.attributes.length - 1; i >= 0; i--) {
      var name = el.attributes[i].name.toLowerCase();
      if (name.startsWith('on') || name === 'href' && el.getAttribute('href').trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(el.attributes[i].name);
      }
    }
  });
  return div.innerHTML;
}

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

// ── Toggle Secret Visibility (used by Auth tab) ─────────
function toggleSecretVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
}

// ── Theme Presets ────────────────────────────────────────
const THEME_PRESETS = [
  // Dark themes
  { name: 'Dark Blue',       accent: '#4F8EF7', bg: '#0d1117', bgCard: '#161b22', border: '#21262d', text: '#e6edf3', muted: '#8b949e', accentDim: '#2d5fbe' },
  { name: 'Dark Cyan',       accent: '#00d9ff', bg: '#0d0d0d', bgCard: '#161616', border: '#222222', text: '#f0f0f0', muted: '#888888', accentDim: '#0099b3' },
  { name: 'Dark Purple',     accent: '#a78bfa', bg: '#0f0b1a', bgCard: '#1a1525', border: '#2d2640', text: '#e8e0f0', muted: '#9990a8', accentDim: '#7c5fc4' },
  { name: 'Midnight Green',  accent: '#34d399', bg: '#0a1214', bgCard: '#121e22', border: '#1e3030', text: '#e0f0ec', muted: '#7da89e', accentDim: '#1f9e6f' },
  { name: 'Dark Rose',       accent: '#f472b6', bg: '#110a10', bgCard: '#1c1520', border: '#2e2030', text: '#f0e4ec', muted: '#a090a0', accentDim: '#b8508a' },
  { name: 'Dark Amber',      accent: '#fbbf24', bg: '#111009', bgCard: '#1c1a12', border: '#302a1a', text: '#f0ece0', muted: '#a09880', accentDim: '#b8880e' },
  { name: 'Charcoal',        accent: '#60a5fa', bg: '#121212', bgCard: '#1e1e1e', border: '#2a2a2a', text: '#e0e0e0', muted: '#909090', accentDim: '#3b7ad8' },
  { name: 'Dark Red',        accent: '#ef4444', bg: '#110d0d', bgCard: '#1c1616', border: '#2e2020', text: '#f0e6e6', muted: '#a09090', accentDim: '#b83030' },
  { name: 'Dark Orange',     accent: '#f97316', bg: '#111009', bgCard: '#1c1810', border: '#302818', text: '#f0ece0', muted: '#a09878', accentDim: '#c45a0e' },
  { name: 'Dark Teal',       accent: '#14b8a6', bg: '#0a1212', bgCard: '#121c1c', border: '#1e2e2e', text: '#e0f0ee', muted: '#7da8a0', accentDim: '#0e8a7e' },
  { name: 'Obsidian',        accent: '#94a3b8', bg: '#09090b', bgCard: '#131316', border: '#1e1e24', text: '#d4d4d8', muted: '#71717a', accentDim: '#64748b' },
  { name: 'Monokai',         accent: '#a6e22e', bg: '#272822', bgCard: '#2e2f28', border: '#3e3d32', text: '#f8f8f2', muted: '#75715e', accentDim: '#7ea01e' },
  { name: 'Dracula',         accent: '#bd93f9', bg: '#282a36', bgCard: '#2e303e', border: '#44475a', text: '#f8f8f2', muted: '#6272a4', accentDim: '#9466d8' },
  { name: 'Nord',            accent: '#88c0d0', bg: '#2e3440', bgCard: '#3b4252', border: '#434c5e', text: '#eceff4', muted: '#7b88a1', accentDim: '#5e96a8' },
  { name: 'Solarized Dark',  accent: '#b58900', bg: '#002b36', bgCard: '#073642', border: '#0a4555', text: '#93a1a1', muted: '#657b83', accentDim: '#8a6800' },
  { name: 'Dark Slate',      accent: '#6ee7b7', bg: '#0f172a', bgCard: '#1e293b', border: '#334155', text: '#e2e8f0', muted: '#94a3b8', accentDim: '#3cb88a' },
  { name: 'Dark Coral',      accent: '#fb7185', bg: '#110b0d', bgCard: '#1c1518', border: '#2e2025', text: '#f0e6e8', muted: '#a09098', accentDim: '#c44860' },
  { name: 'Dark Gold',       accent: '#eab308', bg: '#12110a', bgCard: '#1c1b12', border: '#302e1c', text: '#f0eed8', muted: '#a09e78', accentDim: '#b08a06' },
  { name: 'Dark Indigo',     accent: '#818cf8', bg: '#0c0c1a', bgCard: '#161628', border: '#252540', text: '#e4e4f0', muted: '#9090a8', accentDim: '#5c64c4' },
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

  // ── Unified Image Provider config ───────────────────────────────
  const IMAGE_PROVIDER_MODELS = {
    imagen: [
      { id: 'imagen-4.0-generate-001',        label: 'imagen-4.0 (Standard) — $0.04' },
      { id: 'imagen-4.0-ultra-generate-001',  label: 'imagen-4.0 Ultra — $0.04' },
      { id: 'imagen-4.0-fast-generate-001',   label: 'imagen-4.0 Fast — $0.04' },
    ],
    dalle: [
      { id: 'dall-e-3',     label: 'DALL-E 3 Standard — $0.08 (1792x1024)' },
      { id: 'dall-e-3-hd',  label: 'DALL-E 3 HD — $0.12 (1792x1024)' },
    ],
  };

  function populateImgModelDropdown(selectEl, provider, currentValue, allowEmpty) {
    const models = IMAGE_PROVIDER_MODELS[provider] || [];
    selectEl.innerHTML = '';
    if (allowEmpty) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = provider ? 'Default for provider' : '— select provider first —';
      selectEl.appendChild(opt);
    }
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      selectEl.appendChild(opt);
    }
    // Pick the selected value:
    //   - currentValue if it matches a known model
    //   - otherwise: empty string when allowEmpty, else first model
    let nextValue;
    if (currentValue && models.some(m => m.id === currentValue)) {
      nextValue = currentValue;
    } else if (allowEmpty) {
      nextValue = '';
    } else {
      nextValue = models[0] ? models[0].id : '';
    }
    selectEl.value = nextValue;
    selectEl.disabled = !provider;
  }

  function loadImageProviderSettings(settings) {
    let cfg = {};
    try {
      const raw = settings.image_provider_config;
      cfg = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    } catch { cfg = {}; }

    // Fall back to legacy imagen_model setting when no new config exists yet
    const legacyImagenModel = cfg.default?.model ? null : (settings.imagen_model || null);

    const defaultProvider = cfg.default?.provider || 'imagen';
    const defaultModel    = cfg.default?.model || legacyImagenModel || '';
    const defaultEl = document.getElementById('imgDefaultProvider');
    const defaultModelEl = document.getElementById('imgDefaultModel');
    defaultEl.value = defaultProvider;
    populateImgModelDropdown(defaultModelEl, defaultProvider, defaultModel, false);

    for (const op of ['thumbnail-render', 'inline-image']) {
      const opCfg = cfg.operations?.[op] || {};
      const provEl  = document.getElementById('imgOpProvider-' + op);
      const modelEl = document.getElementById('imgOpModel-' + op);
      provEl.value = opCfg.provider || '';
      populateImgModelDropdown(modelEl, opCfg.provider || '', opCfg.model || '', true);
    }
  }

  document.getElementById('imgDefaultProvider').addEventListener('change', function() {
    populateImgModelDropdown(document.getElementById('imgDefaultModel'), this.value, '', false);
  });
  for (const op of ['thumbnail-render', 'inline-image']) {
    document.getElementById('imgOpProvider-' + op).addEventListener('change', function() {
      populateImgModelDropdown(document.getElementById('imgOpModel-' + op), this.value, '', true);
    });
  }

  document.getElementById('saveImageProviderBtn').addEventListener('click', async function() {
    const cfg = {
      default: {
        provider: document.getElementById('imgDefaultProvider').value,
        model:    document.getElementById('imgDefaultModel').value,
      },
      operations: {},
    };
    for (const op of ['thumbnail-render', 'inline-image']) {
      const provider = document.getElementById('imgOpProvider-' + op).value;
      if (!provider) continue;
      const model = document.getElementById('imgOpModel-' + op).value;
      cfg.operations[op] = { provider, ...(model ? { model } : {}) };
    }
    if (!Object.keys(cfg.operations).length) delete cfg.operations;

    try {
      this.disabled = true;
      this.textContent = 'Saving…';
      await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_provider_config: JSON.stringify(cfg) }),
      });
      showAlert('Image provider settings saved ✓');
    } catch (err) {
      showAlert('Save failed: ' + err.message, 'error');
    } finally {
      this.disabled = false;
      this.textContent = 'Save Image Provider Settings';
    }
  });

  // ── AI Providers (BYAI) ──────────────────────────────────────────
  var aiProvidersInfo = null;

  var OP_LABELS = {
    categorize: 'Categorize', 'writer-tldr': 'Writer TLDR', summary: 'Summary',
    'thumbnail-concept': 'Thumbnail', trends: 'Trends', 'category-suggest': 'Category Suggest',
    'generate-keywords': 'Keywords', 'generate-writer-personas': 'Writers',
    'audio-script': 'Audio Script', synthesis: 'Synthesis', chat: 'Chat',
    'article-assist': 'Article Assist', 'deep-dive': 'Deep Dive',
  };

  async function populateModelDropdown(selectEl, provider, currentValue) {
    selectEl.innerHTML = '<option value="">Default for tier</option>';
    if (!provider) return;
    try {
      var data = await apiFetch('/settings/available-models?provider=' + encodeURIComponent(provider));
      for (var m of (data.models || [])) {
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (currentValue && m.id === currentValue) opt.selected = true;
        selectEl.appendChild(opt);
      }
    } catch (_) {}
  }

  async function loadAiProviders(settings) {
    try {
      aiProvidersInfo = await apiFetch('/settings/ai-providers');
    } catch (err) {
      console.warn('[AI Providers] Could not load:', err.message);
      return;
    }

    var status = aiProvidersInfo.status || {};
    var config = aiProvidersInfo.config;
    var providers = aiProvidersInfo.providers || [];

    // Key status indicators
    if (settings.openai_api_key) {
      document.getElementById('openaiApiKeyPortal').placeholder = '••••••••••••••••••••••••••••••••';
      document.getElementById('openaiKeyStatus').textContent = '✅ API key is set (leave blank to keep current value)';
    }
    if (settings.anthropic_api_key) {
      document.getElementById('anthropicApiKeyPortal').placeholder = '••••••••••••••••••••••••••••••••';
      document.getElementById('anthropicKeyStatus').textContent = '✅ API key is set (leave blank to keep current value)';
    }
    if (settings.openrouter_api_key) {
      document.getElementById('openrouterApiKeyPortal').placeholder = '••••••••••••••••••••••••••••••••';
      document.getElementById('openrouterKeyStatus').textContent = '✅ API key is set (leave blank to keep current value)';
    }
    if (settings.ollama_base_url) {
      document.getElementById('ollamaBaseUrlPortal').value = settings.ollama_base_url;
      document.getElementById('ollamaUrlStatus').textContent = '✅ Ollama URL is configured';
    }

    // Populate default provider dropdown
    var defProvEl = document.getElementById('defaultProviderPortal');
    for (var p of providers) {
      if (p === 'gemini') continue;
      var opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p.charAt(0).toUpperCase() + p.slice(1);
      if (config && config.default && config.default.provider === p) opt.selected = true;
      defProvEl.appendChild(opt);
    }

    // Populate default model if config exists
    if (config && config.default && config.default.provider) {
      await populateModelDropdown(document.getElementById('defaultModelPortal'), config.default.provider, config.default.model);
    }

    // Dynamic model update on provider change
    defProvEl.addEventListener('change', async function() {
      await populateModelDropdown(document.getElementById('defaultModelPortal'), this.value, null);
    });

    // Per-operation overrides table
    var opContainer = document.getElementById('operationOverridesPortal');
    var opTiers = aiProvidersInfo.operationTiers || {};
    var opKeys = Object.keys(opTiers);

    var html = '<table style="width:100%;font-size:13px;"><thead><tr>'
      + '<th style="text-align:left;padding:4px 6px;">Operation</th>'
      + '<th style="text-align:left;padding:4px 6px;">Tier</th>'
      + '<th style="text-align:left;padding:4px 6px;">Provider</th>'
      + '<th style="text-align:left;padding:4px 6px;">Model</th>'
      + '</tr></thead><tbody>';

    for (var op of opKeys) {
      var tier = opTiers[op];
      var opCfg = (config && config.operations && config.operations[op]) || {};
      html += '<tr>'
        + '<td style="padding:4px 6px;">' + (OP_LABELS[op] || op) + '</td>'
        + '<td style="padding:4px 6px;"><span class="badge badge-' + (tier === 'fast' ? 'success' : tier === 'powerful' ? 'warning' : 'muted') + '" style="font-size:10px;">' + tier + '</span></td>'
        + '<td style="padding:4px 6px;"><select class="form-control portal-op-provider" data-op="' + op + '" style="font-size:12px;padding:2px 6px;">'
        + '<option value="">Default</option>';
      for (var pp of providers) {
        html += '<option value="' + pp + '"' + (opCfg.provider === pp ? ' selected' : '') + '>' + pp.charAt(0).toUpperCase() + pp.slice(1) + '</option>';
      }
      html += '</select></td>'
        + '<td style="padding:4px 6px;"><select class="form-control portal-op-model" data-op="' + op + '" style="font-size:12px;padding:2px 6px;">'
        + '<option value="">Default</option></select></td></tr>';
    }
    html += '</tbody></table>';
    opContainer.innerHTML = html;

    // Pre-populate model dropdowns for saved overrides
    for (var op of opKeys) {
      var oCfg = (config && config.operations && config.operations[op]) || {};
      if (oCfg.provider) {
        var mSel = opContainer.querySelector('.portal-op-model[data-op="' + op + '"]');
        await populateModelDropdown(mSel, oCfg.provider, oCfg.model);
      }
    }

    // Wire per-operation provider → model dynamic loading
    opContainer.addEventListener('change', async function(e) {
      if (!e.target.classList.contains('portal-op-provider')) return;
      var opKey = e.target.getAttribute('data-op');
      var mSel = opContainer.querySelector('.portal-op-model[data-op="' + opKey + '"]');
      await populateModelDropdown(mSel, e.target.value, null);
    });
  }

  // Test connection buttons
  function wirePortalTest(btnId, provider) {
    document.getElementById(btnId).addEventListener('click', async function() {
      var btn = this;
      var orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Testing…';
      try {
        var result = await apiFetch('/settings/test-provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: provider }),
        });
        if (result.ok) {
          showAlert(provider.charAt(0).toUpperCase() + provider.slice(1) + ' connection successful ✓');
        } else {
          showAlert('Connection failed: ' + (result.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        showAlert('Test failed: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
  }
  wirePortalTest('testOpenaiPortal', 'openai');
  wirePortalTest('testAnthropicPortal', 'anthropic');
  wirePortalTest('testOpenrouterPortal', 'openrouter');
  wirePortalTest('testOllamaPortal', 'ollama');

  // Save handler
  document.getElementById('saveAiProvidersPortalBtn').addEventListener('click', async function() {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      var payload = {};

      var openaiKey = document.getElementById('openaiApiKeyPortal').value.trim();
      if (openaiKey) payload.openai_api_key = openaiKey;
      var anthropicKey = document.getElementById('anthropicApiKeyPortal').value.trim();
      if (anthropicKey) payload.anthropic_api_key = anthropicKey;
      var openrouterKey = document.getElementById('openrouterApiKeyPortal').value.trim();
      if (openrouterKey) payload.openrouter_api_key = openrouterKey;
      var ollamaUrl = document.getElementById('ollamaBaseUrlPortal').value.trim();
      if (ollamaUrl) payload.ollama_base_url = ollamaUrl;

      // Build ai_provider_config
      var cfg = {};
      var defProv = document.getElementById('defaultProviderPortal').value;
      if (defProv) {
        cfg.default = { provider: defProv };
        var defModel = document.getElementById('defaultModelPortal').value;
        if (defModel) cfg.default.model = defModel;
      }
      var ops = {};
      var opSels = document.querySelectorAll('.portal-op-provider');
      for (var sel of opSels) {
        var opKey = sel.getAttribute('data-op');
        if (!sel.value) continue;
        var entry = { provider: sel.value };
        var mSel = document.querySelector('.portal-op-model[data-op="' + opKey + '"]');
        if (mSel && mSel.value) entry.model = mSel.value;
        ops[opKey] = entry;
      }
      if (Object.keys(ops).length) cfg.operations = ops;
      payload.ai_provider_config = Object.keys(cfg).length ? JSON.stringify(cfg) : '';

      await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (openaiKey) {
        document.getElementById('openaiApiKeyPortal').value = '';
        document.getElementById('openaiApiKeyPortal').placeholder = '••••••••••••••••••••••••••••••••';
        document.getElementById('openaiKeyStatus').textContent = '✅ API key is set (leave blank to keep current value)';
      }
      if (anthropicKey) {
        document.getElementById('anthropicApiKeyPortal').value = '';
        document.getElementById('anthropicApiKeyPortal').placeholder = '••••••••••••••••••••••••••••••••';
        document.getElementById('anthropicKeyStatus').textContent = '✅ API key is set (leave blank to keep current value)';
      }
      if (openrouterKey) {
        document.getElementById('openrouterApiKeyPortal').value = '';
        document.getElementById('openrouterApiKeyPortal').placeholder = '••••••••••••••••••••••••••••••••';
        document.getElementById('openrouterKeyStatus').textContent = '✅ API key is set (leave blank to keep current value)';
      }
      if (ollamaUrl) {
        document.getElementById('ollamaUrlStatus').textContent = '✅ Ollama URL is configured';
      }

      showAlert('AI provider settings saved ✓');
    } catch (err) {
      showAlert('Save failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save AI Provider Settings';
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
      loadImageProviderSettings(settings);
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
    document.getElementById('auditRetentionDays').value          = settings.audit_retention_days || '90';
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

  document.getElementById('saveAuditRetentionBtn').addEventListener('click', async function () {
    const days = Math.max(parseInt(document.getElementById('auditRetentionDays').value) || 90, 30);
    try {
      this.disabled = true; this.textContent = 'Saving…';
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify({ audit_retention_days: String(days) }) });
      document.getElementById('auditRetentionStatus').textContent = '✅ Audit retention saved';
      showAlert('Audit retention saved ✓');
    } catch (err) {
      showAlert('Save failed: ' + err.message, 'error');
    } finally {
      this.disabled = false; this.textContent = 'Save';
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
    { id: 'siteTwitterHandle',    key: 'site_twitter_handle' },
    { id: 'siteCopyright',        key: 'site_copyright' },
    { id: 'siteFooterTagline',    key: 'site_footer_tagline' },
    { id: 'siteGaId',             key: 'site_ga_id' },
    { id: 'siteAdsenseId',        key: 'site_adsense_id' },
    { id: 'siteAiPersona',        key: 'site_ai_persona' },
    { id: 'siteNewsletterSubject', key: 'site_newsletter_subject' },
    { id: 'siteEmailFromName',    key: 'site_email_from_name' },
    { id: 'siteDomain',           key: 'site_domain' },
    { id: 'siteUrl',              key: 'site_url' },
    { id: 'mainSiteUrl',          key: 'main_site_url' },
  ];

  // Logo HTML live preview
  const logoHtmlInput  = document.getElementById('siteLogoHtml');
  const logoPreview    = document.getElementById('siteLogoPreview');
  const logoEmojiInput = document.getElementById('siteLogoEmoji');

  if (logoHtmlInput && logoPreview) {
    logoHtmlInput.addEventListener('input', () => { logoPreview.innerHTML = sanitizeLogoHtml(logoHtmlInput.value); });
  }

  // Auto-sync: when Logo Emoji changes, replace the leading emoji in Logo HTML
  if (logoEmojiInput && logoHtmlInput) {
    logoEmojiInput.addEventListener('input', () => {
      const newEmoji = logoEmojiInput.value.trim();
      if (!newEmoji) return;
      const current = logoHtmlInput.value;
      const updated = current.replace(/^[\p{Emoji}\u200d\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}]+/u, newEmoji);
      logoHtmlInput.value = updated !== current ? updated : newEmoji + current.replace(/^[^\s&]+/, '');
      if (logoPreview) logoPreview.innerHTML = sanitizeLogoHtml(logoHtmlInput.value);
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
  let _categoriesSaveSucceeded = false;
  panelSave('saveCategoriesBtn', 'categoriesStatus', 'Categories', async () => {
    const cleanCats = _siteCategories.filter(c => c.name && c.name.trim());
    const result = await apiFetch('/categories', { method: 'PUT', body: JSON.stringify(cleanCats) });
    if (Array.isArray(result)) {
      _siteCategories = result;
      renderCategories();
    }
    _categoriesSaveSucceeded = true;
  });
  // After save completes, offer to re-categorize (outside panelSave so button isn't frozen)
  document.getElementById('saveCategoriesBtn')?.addEventListener('click', () => {
    // Wait for panelSave to finish, then check
    const check = setInterval(async () => {
      if (!_categoriesSaveSucceeded) return;
      clearInterval(check);
      _categoriesSaveSucceeded = false;
      try {
        const preview = await apiFetch('/fetch/recategorize', {
          method: 'POST',
          body: JSON.stringify({ dryRun: true }),
        });
        if (preview.updated > 0) {
          const previewEl = document.getElementById('settingsRecategorizePreview');
          const rows = Object.entries(preview.moves).map(([move, count]) =>
            `<tr><td style="padding:4px 8px;">${escHtml(move)}</td><td style="padding:4px 8px;text-align:right;font-weight:600;">${count}</td></tr>`
          ).join('');
          previewEl.innerHTML = `
            <p><strong>${preview.updated}</strong> of ${preview.total} articles would be re-categorized:</p>
            <table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:8px;">
              <thead><tr style="border-bottom:1px solid var(--border);"><th style="padding:4px 8px;text-align:left;">Move</th><th style="padding:4px 8px;text-align:right;">Count</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`;
          openModal('recategorizePromptModal');
        }
      } catch { /* silent — recategorize prompt is best-effort */ }
    }, 200);
    // Safety: stop polling after 30s
    setTimeout(() => clearInterval(check), 30000);
  });

  // ── Settings recategorize confirm ─────────────────────────────
  document.getElementById('settingsRecategorizeBtn')?.addEventListener('click', async function () {
    this.disabled = true; this.textContent = 'Re-categorizing…';
    try {
      const data = await apiFetch('/fetch/recategorize', {
        method: 'POST',
        body: JSON.stringify({ dryRun: false }),
      });
      closeModal('recategorizePromptModal');
      const writerMsg = data.writerReassignments ? `, ${data.writerReassignments} writer(s) reassigned` : '';
      showAlert(`Re-categorized ${data.updated} of ${data.total} articles${writerMsg}`);
    } catch (err) {
      showAlert('Re-categorize failed: ' + err.message, 'error');
    } finally {
      this.disabled = false; this.textContent = 'Re-categorize';
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

  // ── Email (Resend) save ──────────────────────────────────────────
  panelSave('saveResendBtn', 'resendSaveStatus', 'Email Settings', async () => {
    const payload = {};
    const apiKey = document.getElementById('resendApiKey').value.trim();
    const audienceId = document.getElementById('resendAudienceId').value.trim();
    if (apiKey) payload.resend_api_key = apiKey;
    if (audienceId) payload.resend_audience_id = audienceId;
    if (Object.keys(payload).length === 0) {
      showToast('Please fill in at least one field', 'error');
      return;
    }
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
    if (apiKey) {
      document.getElementById('resendApiKey').value = '';
      document.getElementById('resendApiKey').placeholder = '••••••••  (saved)';
    }
    var status = document.getElementById('resendStatus');
    if (status) { status.textContent = 'Configured'; status.className = 'badge badge-success'; }
  });

  // ── News Source Keys save ──────────────────────────────────────
  panelSave('saveNewsKeysBtn', 'newsKeysSaveStatus', 'News Source Keys', async () => {
    const payload = {};
    const newsKey = document.getElementById('newsApiKey').value.trim();
    const braveKey = document.getElementById('braveApiKey').value.trim();
    const ytKey = document.getElementById('youtubeApiKey').value.trim();
    if (newsKey) payload.news_api_key = newsKey;
    if (braveKey) payload.brave_api_key = braveKey;
    if (ytKey) payload.youtube_api_key = ytKey;
    if (Object.keys(payload).length === 0) {
      showToast('Please fill in at least one field', 'error');
      return;
    }
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
    if (newsKey) {
      document.getElementById('newsApiKey').value = '';
      document.getElementById('newsApiKey').placeholder = '••••••••  (saved)';
    }
    if (braveKey) {
      document.getElementById('braveApiKey').value = '';
      document.getElementById('braveApiKey').placeholder = '••••••••  (saved)';
    }
    if (ytKey) {
      document.getElementById('youtubeApiKey').value = '';
      document.getElementById('youtubeApiKey').placeholder = '••••••••  (saved)';
    }
  });

  // ── Live News Settings save ──────────────────────────────────────
  panelSave('saveLiveNewsBtn', 'liveNewsSaveStatus', 'Live News Settings', async () => {
    var payload = {};
    var query = document.getElementById('liveNewsQuery').value.trim();
    payload.live_news_query = query || '';
    payload.auto_publish_live = document.getElementById('autoPublishLive').checked ? '1' : '0';
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
  });

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
      logoPreview.innerHTML = sanitizeLogoHtml(settings.site_logo_html);
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

  // ── Site URLs save ──────────────────────────────────────────────
  panelSave('saveSiteUrlsBtn', 'siteUrlsStatus', 'Site URLs', () => saveFields([
    { id: 'siteDomain',  key: 'site_domain' },
    { id: 'siteUrl',     key: 'site_url' },
    { id: 'mainSiteUrl', key: 'main_site_url' },
  ]));

  // ── Social & Metadata save ──────────────────────────────────────
  panelSave('saveDomainBtn', 'domainStatus', 'Social & Metadata', () => saveFields([
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

  // ── Storage status (read-only — config moved to Platform Dashboard) ──
  function loadStorageSection() {
    apiFetch('/settings/storage-status').then(function(data) {
      var backendEl = document.getElementById('storageBackendDisplay');
      var usageEl = document.getElementById('storageUsageDisplay');
      var statusBadge = document.getElementById('r2Status');
      if (backendEl) {
        backendEl.textContent = data.r2Configured ? 'Cloudflare R2' : (data.backend === 'local' ? 'Local (ephemeral)' : data.backend);
      }
      if (usageEl) {
        var mb = (data.bytesUsed / (1024 * 1024)).toFixed(1);
        usageEl.textContent = mb + ' MB / ' + data.fileCount + ' files';
      }
      if (statusBadge) {
        statusBadge.textContent = data.r2Configured ? 'Active' : 'Local';
        statusBadge.className = data.r2Configured ? 'badge badge-success' : 'badge badge-muted';
      }
    }).catch(function() {});
  }

  function loadAuthTab(settings) {
    // Google status
    const googleId = settings.oauth_google_client_id;
    const googleSecret = settings.oauth_google_client_secret;
    const googleStatus = document.getElementById('googleOAuthStatus');
    if (googleStatus) {
      if (googleId) {
        googleStatus.textContent = 'Configured';
        googleStatus.className = 'badge badge-success';
        document.getElementById('oauthGoogleClientId').value = googleId;
        if (googleSecret) {
          document.getElementById('oauthGoogleClientSecret').placeholder = '••••••••  (saved)';
        }
      } else {
        googleStatus.textContent = 'Not configured';
        googleStatus.className = 'badge badge-muted';
      }
    }

    // GitHub status
    const githubId = settings.oauth_github_client_id;
    const githubSecret = settings.oauth_github_client_secret;
    const githubStatus = document.getElementById('githubOAuthStatus');
    if (githubStatus) {
      if (githubId) {
        githubStatus.textContent = 'Configured';
        githubStatus.className = 'badge badge-success';
        document.getElementById('oauthGithubClientId').value = githubId;
        if (githubSecret) {
          document.getElementById('oauthGithubClientSecret').placeholder = '••••••••  (saved)';
        }
      } else {
        githubStatus.textContent = 'Not configured';
        githubStatus.className = 'badge badge-muted';
      }
    }
  }

  function loadResendTab(settings) {
    var apiKey = settings.resend_api_key;
    var audienceId = settings.resend_audience_id;
    var status = document.getElementById('resendStatus');
    if (apiKey || audienceId) {
      if (status) { status.textContent = 'Configured'; status.className = 'badge badge-success'; }
      if (apiKey) document.getElementById('resendApiKey').placeholder = '••••••••  (saved)';
      if (audienceId) document.getElementById('resendAudienceId').value = audienceId;
    }
  }

  function loadNewsKeysTab(settings) {
    var newsKey = settings.news_api_key;
    var braveKey = settings.brave_api_key;
    if (newsKey) document.getElementById('newsApiKey').placeholder = '••••••••  (saved)';
    if (braveKey) document.getElementById('braveApiKey').placeholder = '••••••••  (saved)';
    if (settings.youtube_api_key) document.getElementById('youtubeApiKey').placeholder = '••••••••  (saved)';

    // Live News settings
    if (settings.live_news_query) document.getElementById('liveNewsQuery').value = settings.live_news_query;
    if (settings.auto_publish_live === '1') document.getElementById('autoPublishLive').checked = true;
  }

  // Save Google OAuth
  document.getElementById('saveGoogleOAuth')?.addEventListener('click', async () => {
    const clientId = document.getElementById('oauthGoogleClientId').value.trim();
    const clientSecret = document.getElementById('oauthGoogleClientSecret').value.trim();
    const body = {};
    if (clientId) body.oauth_google_client_id = clientId;
    if (clientSecret) body.oauth_google_client_secret = clientSecret;
    if (Object.keys(body).length === 0) {
      showToast('Please enter at least one field', 'error');
      return;
    }
    try {
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) });
      showToast('Google OAuth saved');
      await loadSettings();
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    }
  });

  // Save GitHub OAuth
  document.getElementById('saveGithubOAuth')?.addEventListener('click', async () => {
    const clientId = document.getElementById('oauthGithubClientId').value.trim();
    const clientSecret = document.getElementById('oauthGithubClientSecret').value.trim();
    const body = {};
    if (clientId) body.oauth_github_client_id = clientId;
    if (clientSecret) body.oauth_github_client_secret = clientSecret;
    if (Object.keys(body).length === 0) {
      showToast('Please enter at least one field', 'error');
      return;
    }
    try {
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) });
      showToast('GitHub OAuth saved');
      await loadSettings();
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
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
      loadAiProviders(settings);
      loadPurgeSettings(settings);
      loadSpamSettings(settings);
      loadModQueueSettings(settings);
      loadAuthTab(settings);
      loadStorageSection();
      loadResendTab(settings);
      loadNewsKeysTab(settings);
      await loadSiteSettings(settings);
    } catch (err) {
      showAlert('Failed to load settings: ' + err.message, 'error');
    }
  };

  // ── Automation Tab: Scheduled Tasks Management ──────────

  // Load automation tab on click
  (function() {
    var tabBar = document.getElementById('settingsTabs');
    if (!tabBar) return;
    tabBar.addEventListener('click', function(e) {
      var btn = e.target.closest('.tab-btn');
      if (btn && btn.dataset.tab === 'automation') loadAutomationTab();
    });
    // Also load if restored from session
    if (sessionStorage.getItem('dfa_settings_tab') === 'automation') {
      setTimeout(loadAutomationTab, 0);
    }
  })();

  async function loadAutomationTab() {
    var container = document.getElementById('cronJobsList');
    if (!container) return;
    container.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading...</div>';

    try {
      var _data = await apiFetch('/admin/cron');
      var jobs = _data.jobs || [];

      // Autopilot toggle
      var autopilotToggle = document.getElementById('autopilotToggle');
      var autopilotBanner = document.getElementById('autopilotBanner');
      var autopilotStateText = document.getElementById('autopilotStateText');
      if (autopilotToggle) {
        var isOn = _data.autopilotEnabled !== false;
        autopilotToggle.checked = isOn;
        autopilotStateText.textContent = isOn ? 'ON' : 'OFF';
        autopilotBanner.style.display = isOn ? 'none' : '';
        autopilotToggle.onchange = async function() {
          var newState = autopilotToggle.checked;
          try {
            await apiFetch('/admin/cron/autopilot', { method: 'PUT', body: JSON.stringify({ enabled: newState }) });
            autopilotStateText.textContent = newState ? 'ON' : 'OFF';
            autopilotBanner.style.display = newState ? 'none' : '';
            showToast('Autopilot ' + (newState ? 'enabled' : 'disabled'));
          } catch (err) {
            autopilotToggle.checked = !newState;
            showToast(err.message, 'error');
          }
        };
      }

      if (!jobs.length) {
        container.innerHTML = '<div class="empty-state">No scheduled tasks found</div>';
        return;
      }

      // Group by category
      var groups = {};
      jobs.forEach(function(j) {
        var cat = j.category || 'Other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(j);
      });

      var categoryOrder = ['Content', 'Media', 'Notifications', 'Monitoring', 'Maintenance'];
      var html = '';

      categoryOrder.forEach(function(cat) {
        if (!groups[cat]) return;
        html += '<div style="margin-top:20px;">';
        html += '<h4 class="text-muted text-sm" style="margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em;">' + escHtml(cat) + '</h4>';

        groups[cat].forEach(function(job) {
          var enabled = job.enabled !== false;
          var schedule = job.currentSchedule || job.defaultSchedule;
          var lastRun = job.lastRun;
          var statusBadge = '';
          if (lastRun) {
            var statusClass = lastRun.status === 'success' ? 'badge-success' : lastRun.status === 'error' ? 'badge-danger' : 'badge-muted';
            statusBadge = '<span class="badge ' + statusClass + '">' + escHtml(lastRun.status) + '</span>';
          }
          var lastRunTime = lastRun ? formatAge(lastRun.started_at) : 'Never';
          var lastSummary = '';
          if (lastRun && lastRun.summary) {
            var s = lastRun.summary;
            if (s.error) lastSummary = '<span class="text-danger text-xs">' + escHtml(s.error) + '</span>';
            else {
              var parts = [];
              Object.keys(s).forEach(function(k) { parts.push(k + ': ' + s[k]); });
              if (parts.length) lastSummary = '<span class="text-muted text-xs">' + escHtml(parts.join(', ')) + '</span>';
            }
          }

          html += '<div class="dash-panel" style="margin-bottom:12px;padding:16px;" data-job="' + escHtml(job.name) + '">';
          html += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">';

          // Left: name + description
          html += '<div style="flex:1;min-width:200px;">';
          html += '<div style="font-weight:600;">' + escHtml(job.description) + '</div>';
          html += '<div class="text-muted text-xs" style="margin-top:2px;">Job: <code>' + escHtml(job.name) + '</code></div>';
          html += '</div>';

          // Middle: last run info
          html += '<div style="display:flex;gap:16px;align-items:center;">';
          html += '<div>';
          html += '<div class="text-muted text-xs">Last run</div>';
          html += '<div class="text-sm">' + escHtml(lastRunTime) + ' ' + statusBadge + '</div>';
          if (lastSummary) html += '<div style="margin-top:2px;">' + lastSummary + '</div>';
          html += '</div>';
          html += '</div>';

          // Right: controls
          html += '<div style="display:flex;gap:8px;align-items:center;">';
          html += '<button class="btn btn-outline btn-sm" onclick="viewCronHistory(\'' + escHtml(job.name) + '\')" title="View history">History</button>';
          html += '<button class="btn btn-outline btn-sm" onclick="runCronJob(\'' + escHtml(job.name) + '\', this)" title="Run now">Run Now</button>';
          html += '<label class="form-check" style="margin:0;" title="' + (enabled ? 'Enabled' : 'Disabled') + '">';
          html += '<input type="checkbox" data-job-toggle="' + escHtml(job.name) + '"' + (enabled ? ' checked' : '') + ' /> On';
          html += '</label>';
          html += '</div>';

          html += '</div>';

          // Cron builder
          html += '<div class="cron-builder" data-cron-builder="' + escHtml(job.name) + '" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">';

          // Row 1: Frequency
          html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
          html += '<span class="text-sm">Run every</span>';
          html += '<select class="form-control form-control-sm" data-cron-interval="' + escHtml(job.name) + '">';
          [1,2,5,10,15,20,30].forEach(function(v) {
            html += '<option value="' + v + '">' + v + '</option>';
          });
          html += '</select>';
          html += '<select class="form-control form-control-sm" data-cron-unit="' + escHtml(job.name) + '">';
          html += '<option value="minutes">minutes</option>';
          html += '<option value="hours">hours</option>';
          html += '</select>';
          html += '</div>';

          // Row 2: Hour range
          html += '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">';
          html += '<label class="form-check" style="margin:0;">';
          html += '<input type="checkbox" data-cron-hourlimit="' + escHtml(job.name) + '" /> Only during';
          html += '</label>';
          html += '<select class="form-control form-control-sm" data-cron-hourstart="' + escHtml(job.name) + '" disabled>' + hourOptions() + '</select>';
          html += '<span class="text-sm">to</span>';
          html += '<select class="form-control form-control-sm" data-cron-hourend="' + escHtml(job.name) + '" disabled>' + hourOptions() + '</select>';
          html += '</div>';

          // Row 3: Day of week
          html += '<div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap;">';
          html += '<span class="text-sm">Days:</span>';
          var dayLabels = [
            { value: '1', label: 'Mon' }, { value: '2', label: 'Tue' },
            { value: '3', label: 'Wed' }, { value: '4', label: 'Thu' },
            { value: '5', label: 'Fri' }, { value: '6', label: 'Sat' },
            { value: '0', label: 'Sun' }
          ];
          dayLabels.forEach(function(d) {
            html += '<label class="form-check form-check-sm"><input type="checkbox" data-cron-day="' + escHtml(job.name) + '" value="' + d.value + '" checked /> ' + d.label + '</label>';
          });
          html += '</div>';

          // Row 4: Preview
          html += '<div style="margin-top:8px;" data-cron-preview="' + escHtml(job.name) + '">';
          html += '<div class="text-muted text-xs" data-cron-description="' + escHtml(job.name) + '"></div>';
          html += '<div class="text-muted text-xs" data-cron-nextruns="' + escHtml(job.name) + '" style="margin-top:4px;"></div>';
          html += '<div class="text-xs" data-cron-saved="' + escHtml(job.name) + '" style="margin-top:4px;color:var(--success);opacity:0;transition:opacity 0.3s;"></div>';
          html += '</div>';

          html += '</div>'; // end cron-builder

          html += '</div>'; // end job card
        });

        html += '</div>';
      });

      container.innerHTML = html;

      // Wire up toggle handlers
      container.querySelectorAll('[data-job-toggle]').forEach(function(cb) {
        cb.addEventListener('change', function() {
          updateCronJob(cb.dataset.jobToggle, { enabled: cb.checked });
        });
      });

      // Wire up hour-limit checkbox to enable/disable hour selects
      container.querySelectorAll('[data-cron-hourlimit]').forEach(function(cb) {
        cb.addEventListener('change', function() {
          var jobName = cb.dataset.cronHourlimit;
          var startSel = document.querySelector('[data-cron-hourstart="' + jobName + '"]');
          var endSel = document.querySelector('[data-cron-hourend="' + jobName + '"]');
          startSel.disabled = !cb.checked;
          endSel.disabled = !cb.checked;
          debouncedPreviewAndSave(jobName);
        });
      });

      // Wire up all builder controls for preview + auto-save
      container.querySelectorAll('[data-cron-interval],[data-cron-unit],[data-cron-hourstart],[data-cron-hourend],[data-cron-day]').forEach(function(el) {
        el.addEventListener('change', function() {
          var jobName = el.dataset.cronInterval || el.dataset.cronUnit || el.dataset.cronHourstart || el.dataset.cronHourend || el.dataset.cronDay;
          debouncedPreviewAndSave(jobName);
        });
      });

      // Parse existing schedules into builder controls
      jobs.forEach(function(job) {
        var schedule = job.currentSchedule || job.defaultSchedule;
        parseCronToBuilder(schedule, job.name);
        updateCronPreview(job.name);
      });

    } catch (err) {
      container.innerHTML = '<div class="empty-state">Failed to load: ' + escHtml(err.message) + '</div>';
    }
  }

  function getScheduleOptions(jobName, defaultSchedule) {
    var presets = {
      'rss-fetch':       [{ value: '*/10 * * * *', label: 'Every 10 min' }, { value: '*/15 * * * *', label: 'Every 15 min' }, { value: '*/30 * * * *', label: 'Every 30 min' }, { value: '0 * * * *', label: 'Every hour' }],
      'live-news':       [{ value: '*/30 * * * *', label: 'Every 30 min' }, { value: '0 * * * *', label: 'Every hour' }, { value: '0 */2 * * *', label: 'Every 2 hours' }, { value: '0 */4 * * *', label: 'Every 4 hours' }],
      'synthesis':       [{ value: '0 * * * *', label: 'Hourly check' }],
      'auto-audio':      [{ value: '0 6 * * *', label: '6 AM UTC' }, { value: '0 8 * * *', label: '8 AM UTC' }, { value: '0 10 * * *', label: '10 AM UTC' }, { value: '0 12 * * *', label: '12 PM UTC' }],
      'newsletter':      [{ value: '0 14 * * 1', label: 'Monday 2 PM UTC' }, { value: '0 10 * * 1', label: 'Monday 10 AM UTC' }, { value: '0 14 * * 5', label: 'Friday 2 PM UTC' }, { value: '0 10 * * 5', label: 'Friday 10 AM UTC' }],
      'auto-archive':    [{ value: '0 1 * * *', label: '1 AM UTC' }, { value: '0 2 * * *', label: '2 AM UTC' }, { value: '0 3 * * *', label: '3 AM UTC' }, { value: '0 4 * * *', label: '4 AM UTC' }],
      'purge-archived':  [{ value: '0 * * * *', label: 'Every hour' }, { value: '0 */2 * * *', label: 'Every 2 hours' }, { value: '0 */6 * * *', label: 'Every 6 hours' }],
      'auth-cleanup':    [{ value: '*/5 * * * *', label: 'Every 5 min' }, { value: '*/10 * * * *', label: 'Every 10 min' }, { value: '*/30 * * * *', label: 'Every 30 min' }],
      'budget-alert':    [{ value: '0 8 * * *', label: '8 AM UTC' }, { value: '0 9 * * *', label: '9 AM UTC' }, { value: '0 10 * * *', label: '10 AM UTC' }, { value: '0 12 * * *', label: '12 PM UTC' }],
    };

    var options = presets[jobName] || [];
    var hasDefault = options.some(function(o) { return o.value === defaultSchedule; });
    if (!hasDefault && defaultSchedule) {
      options.unshift({ value: defaultSchedule, label: defaultSchedule + ' (default)' });
    }
    return options;
  }

  // ── Cron Builder Helpers ────────────────────────────────

  function hourOptions() {
    var html = '';
    for (var h = 0; h < 24; h++) {
      var label = h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM';
      html += '<option value="' + h + '">' + label + '</option>';
    }
    return html;
  }

  function buildCronExpression(jobName) {
    var interval = document.querySelector('[data-cron-interval="' + jobName + '"]').value;
    var unit = document.querySelector('[data-cron-unit="' + jobName + '"]').value;
    var hourLimited = document.querySelector('[data-cron-hourlimit="' + jobName + '"]').checked;
    var hourStart = document.querySelector('[data-cron-hourstart="' + jobName + '"]').value;
    var hourEnd = document.querySelector('[data-cron-hourend="' + jobName + '"]').value;

    var dayCheckboxes = document.querySelectorAll('[data-cron-day="' + jobName + '"]');
    var days = [];
    dayCheckboxes.forEach(function(cb) { if (cb.checked) days.push(cb.value); });

    var minuteField, hourField;

    if (unit === 'minutes') {
      minuteField = interval === '1' ? '*' : '*/' + interval;
      if (hourLimited) {
        hourField = (hourStart === hourEnd) ? String(hourStart) : hourStart + '-' + hourEnd;
      } else {
        hourField = '*';
      }
    } else {
      // hours
      minuteField = '0';
      if (hourLimited) {
        if (hourStart === hourEnd) {
          hourField = String(hourStart);
        } else if (interval === '1') {
          hourField = hourStart + '-' + hourEnd;
        } else {
          hourField = hourStart + '-' + hourEnd + '/' + interval;
        }
      } else {
        hourField = interval === '1' ? '*' : '*/' + interval;
      }
    }

    var dayField = days.length === 0 || days.length === 7 ? '*' : days.join(',');

    return minuteField + ' ' + hourField + ' * * ' + dayField;
  }

  function parseCronToBuilder(expr, jobName) {
    var parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return;

    var minField = parts[0];
    var hourField = parts[1];
    var dayField = parts[4];

    var intervalSel = document.querySelector('[data-cron-interval="' + jobName + '"]');
    var unitSel = document.querySelector('[data-cron-unit="' + jobName + '"]');
    var hourLimitCb = document.querySelector('[data-cron-hourlimit="' + jobName + '"]');
    var hourStartSel = document.querySelector('[data-cron-hourstart="' + jobName + '"]');
    var hourEndSel = document.querySelector('[data-cron-hourend="' + jobName + '"]');

    if (!intervalSel || !unitSel || !hourLimitCb || !hourStartSel || !hourEndSel) return;

    // Parse minute field
    var minStep = minField.match(/^\*\/(\d+)$/);
    if (minField === '*') {
      // every minute
      unitSel.value = 'minutes';
      intervalSel.value = '1';
    } else if (minStep) {
      unitSel.value = 'minutes';
      intervalSel.value = minStep[1];
    } else if (minField === '0') {
      // hourly pattern
      unitSel.value = 'hours';
      var hourStep = hourField.match(/^\*\/(\d+)$/);
      var hourRange = hourField.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
      if (hourField === '*') {
        intervalSel.value = '1';
      } else if (hourStep) {
        intervalSel.value = hourStep[1];
      } else if (hourRange) {
        hourLimitCb.checked = true;
        hourStartSel.disabled = false;
        hourEndSel.disabled = false;
        hourStartSel.value = hourRange[1];
        hourEndSel.value = hourRange[2];
        intervalSel.value = hourRange[3] || '1';
      } else {
        // Specific hour like "14" — treat as every 1 hour limited to that hour
        var specificHour = parseInt(hourField, 10);
        if (!isNaN(specificHour)) {
          intervalSel.value = '1';
          hourLimitCb.checked = true;
          hourStartSel.disabled = false;
          hourEndSel.disabled = false;
          hourStartSel.value = specificHour;
          hourEndSel.value = specificHour;
        }
      }
    } else {
      // Specific minute — best effort: treat as minutes
      unitSel.value = 'minutes';
      intervalSel.value = '1';
    }

    // Parse hour field for minute-based patterns
    if (unitSel.value === 'minutes') {
      var hRange = hourField.match(/^(\d+)-(\d+)$/);
      if (hRange) {
        hourLimitCb.checked = true;
        hourStartSel.disabled = false;
        hourEndSel.disabled = false;
        hourStartSel.value = hRange[1];
        hourEndSel.value = hRange[2];
      } else if (hourField !== '*') {
        var hVal = parseInt(hourField, 10);
        if (!isNaN(hVal)) {
          hourLimitCb.checked = true;
          hourStartSel.disabled = false;
          hourEndSel.disabled = false;
          hourStartSel.value = hVal;
          hourEndSel.value = hVal;
        }
      }
    }

    // Parse day field
    var dayCheckboxes = document.querySelectorAll('[data-cron-day="' + jobName + '"]');
    if (dayField !== '*') {
      var activeDays = dayField.split(',');
      dayCheckboxes.forEach(function(cb) {
        cb.checked = activeDays.indexOf(cb.value) !== -1;
      });
    } else {
      dayCheckboxes.forEach(function(cb) { cb.checked = true; });
    }

    // Snap interval to nearest valid option
    var validIntervals = ['1','2','5','10','15','20','30'];
    if (validIntervals.indexOf(intervalSel.value) === -1) {
      // Find closest
      var target = parseInt(intervalSel.value, 10);
      var closest = '1';
      var minDiff = Infinity;
      validIntervals.forEach(function(v) {
        var diff = Math.abs(parseInt(v, 10) - target);
        if (diff < minDiff) { minDiff = diff; closest = v; }
      });
      intervalSel.value = closest;
    }
  }

  var _previewTimers = {};
  var _saveTimers = {};

  function updateCronPreview(jobName) {
    var expr = buildCronExpression(jobName);
    var descEl = document.querySelector('[data-cron-description="' + jobName + '"]');
    var runsEl = document.querySelector('[data-cron-nextruns="' + jobName + '"]');
    if (!descEl) return;

    descEl.textContent = 'Expression: ' + expr;
    runsEl.textContent = 'Loading preview...';

    apiFetch('/admin/cron/preview?schedule=' + encodeURIComponent(expr))
      .then(function(data) {
        descEl.textContent = data.description || expr;
        if (data.nextRuns && data.nextRuns.length) {
          var runStrs = data.nextRuns.map(function(r) {
            return new Date(r).toLocaleString();
          });
          runsEl.textContent = 'Next runs: ' + runStrs.join('  |  ');
        } else {
          runsEl.textContent = '';
        }
      })
      .catch(function(err) {
        descEl.textContent = 'Expression: ' + expr;
        runsEl.textContent = 'Preview unavailable';
      });
  }

  function debouncedPreviewAndSave(jobName) {
    // Debounce preview (300ms)
    clearTimeout(_previewTimers[jobName]);
    _previewTimers[jobName] = setTimeout(function() {
      updateCronPreview(jobName);
    }, 300);

    // Debounce auto-save (1000ms)
    clearTimeout(_saveTimers[jobName]);
    _saveTimers[jobName] = setTimeout(function() {
      var expr = buildCronExpression(jobName);
      var savedEl = document.querySelector('[data-cron-saved="' + jobName + '"]');
      updateCronJob(jobName, { schedule: expr }).then(function() {
        if (savedEl) {
          savedEl.textContent = 'Saved';
          savedEl.style.opacity = '1';
          setTimeout(function() { savedEl.style.opacity = '0'; }, 1500);
        }
      });
    }, 1000);
  }

  function formatAge(dateStr) {
    try {
      var d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      var now = new Date();
      var diff = Math.floor((now - d) / 1000);
      if (diff < 60) return 'Just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return Math.floor(diff / 86400) + 'd ago';
    } catch (e) { return dateStr; }
  }

  async function updateCronJob(name, updates) {
    try {
      await apiFetch('/admin/cron/' + name, {
        method: 'PUT',
        body: JSON.stringify(updates),
      });
      showToast((updates.schedule ? 'Schedule' : (updates.enabled === false ? 'Disabled' : 'Enabled')) + ' — ' + name);
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
      loadAutomationTab();
    }
  }

  async function runCronJob(name, btn) {
    if (!confirm('Run "' + name + '" now?')) return;
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Running...';
    try {
      var result = await apiFetch('/admin/cron/' + name + '/run', { method: 'POST' });
      showToast('Job completed');
      loadAutomationTab();
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  async function viewCronHistory(name) {
    try {
      var _hdata = await apiFetch('/admin/cron/' + name + '/history');
      var runs = _hdata.runs || [];
      if (!runs.length) { showToast('No run history yet'); return; }

      var html = '<div style="max-height:400px;overflow-y:auto;">';
      html += '<table><thead><tr><th>Started</th><th>Duration</th><th>Status</th><th>Summary</th></tr></thead><tbody>';
      runs.forEach(function(r) {
        var duration = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) + 's' : '—';
        var statusBadge = r.status === 'success' ? '<span class="badge badge-success">success</span>' : r.status === 'error' ? '<span class="badge badge-danger">error</span>' : '<span class="badge badge-muted">' + escHtml(r.status) + '</span>';
        var summary = '';
        if (r.summary) {
          if (r.summary.error) summary = escHtml(r.summary.error);
          else {
            var parts = [];
            Object.keys(r.summary).forEach(function(k) { parts.push(k + ': ' + r.summary[k]); });
            summary = escHtml(parts.join(', '));
          }
        }
        html += '<tr><td class="text-sm">' + escHtml(new Date(r.started_at).toLocaleString()) + '</td><td class="text-sm">' + duration + '</td><td>' + statusBadge + '</td><td class="text-muted text-xs">' + summary + '</td></tr>';
      });
      html += '</tbody></table></div>';

      var modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.style.display = 'flex';
      modal.innerHTML = '<div class="modal modal-xl" style="max-width:700px;">'
        + '<div class="modal-header"><h3>Run History — ' + escHtml(name) + '</h3><button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">✕</button></div>'
        + '<div class="modal-body">' + html + '</div>'
        + '</div>';
      document.body.appendChild(modal);
    } catch (err) {
      showToast('Failed to load history: ' + err.message, 'error');
    }
  }

  // Make functions available globally for onclick handlers
  window.runCronJob = runCronJob;
  window.viewCronHistory = viewCronHistory;

  // ── Featured Rotation Settings ─────────────────────────────────────

  function loadFeaturedRotationSettings(settings) {
    var enabledEl   = document.getElementById('featRotationEnabled');
    var intervalEl  = document.getElementById('featRotationInterval');
    var strategyEl  = document.getElementById('featRotationStrategy');
    var poolEl      = document.getElementById('featRotationPoolDays');
    var cooldownEl  = document.getElementById('featRotationCooldown');
    if (!enabledEl) return;
    enabledEl.checked  = settings.featured_rotation_enabled === '1';
    intervalEl.value   = settings.featured_rotation_interval_hours || '12';
    strategyEl.value   = settings.featured_rotation_strategy || 'score';
    poolEl.value       = settings.featured_rotation_pool_days || '7';
    cooldownEl.value   = settings.featured_rotation_cooldown_days || '3';
    toggleFeatRotationFields();
  }

  function toggleFeatRotationFields() {
    var enabled = document.getElementById('featRotationEnabled');
    var fields  = document.getElementById('featRotationFields');
    if (enabled && fields) fields.style.opacity = enabled.checked ? '1' : '0.5';
  }

  var featEnabledEl = document.getElementById('featRotationEnabled');
  if (featEnabledEl) featEnabledEl.addEventListener('change', toggleFeatRotationFields);

  var saveFeatBtn = document.getElementById('saveFeatRotationBtn');
  if (saveFeatBtn) {
    saveFeatBtn.addEventListener('click', async function() {
      var payload = {
        featured_rotation_enabled:        document.getElementById('featRotationEnabled').checked ? '1' : '0',
        featured_rotation_interval_hours: String(Math.max(parseInt(document.getElementById('featRotationInterval').value) || 12, 1)),
        featured_rotation_strategy:       document.getElementById('featRotationStrategy').value,
        featured_rotation_pool_days:      String(Math.max(parseInt(document.getElementById('featRotationPoolDays').value) || 7, 1)),
        featured_rotation_cooldown_days:  String(Math.max(parseInt(document.getElementById('featRotationCooldown').value) || 3, 0)),
      };
      try {
        this.disabled = true; this.textContent = 'Saving...';
        await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });
        document.getElementById('featRotationStatus').textContent = 'Saved';
        showToast('Featured rotation settings saved');
        setTimeout(function() { document.getElementById('featRotationStatus').textContent = ''; }, 3000);
      } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
      } finally {
        this.disabled = false; this.textContent = 'Save Settings';
      }
    });
  }

  var rotateNowBtn = document.getElementById('rotateNowBtn');
  if (rotateNowBtn) {
    rotateNowBtn.addEventListener('click', async function() {
      try {
        this.disabled = true; this.textContent = 'Rotating...';
        var result = await apiFetch('/articles/rotate-featured', { method: 'POST' });
        if (result.rotated) {
          showToast('Rotation complete: ' + (result.slotsFilled || 0) + ' slot(s) filled');
        } else {
          showToast(result.reason || 'No rotation needed', 'info');
        }
        loadFeaturedRotationStatus();
      } catch (err) {
        showToast('Rotation failed: ' + err.message, 'error');
      } finally {
        this.disabled = false; this.textContent = 'Rotate Now';
      }
    });
  }

  async function loadFeaturedRotationStatus() {
    var infoEl = document.getElementById('featRotationInfo');
    var textEl = document.getElementById('featRotationStatusText');
    if (!infoEl || !textEl) return;
    try {
      var status = await apiFetch('/articles/rotation-status');
      infoEl.style.display = '';
      var lines = [];
      if (status.featured && status.featured.length) {
        lines.push('<strong>Currently featured (' + status.featured.length + '/5):</strong>');
        status.featured.forEach(function(a) {
          var badges = [];
          if (a.is_pinned) badges.push('<span class="badge badge-info">Pinned</span>');
          if (a.featured_source === 'auto') badges.push('<span class="badge badge-muted">Auto</span>');
          if (a.featured_source === 'manual') badges.push('<span class="badge badge-success">Manual</span>');
          if (a.featured_until) badges.push('<span class="text-muted">expires ' + new Date(a.featured_until).toLocaleString() + '</span>');
          lines.push('&nbsp;&nbsp;#' + (a.featured_priority || '?') + ' — ' + escHtml(a.title || 'Untitled') + ' ' + badges.join(' '));
        });
      } else {
        lines.push('No articles currently featured.');
      }
      if (status.nextRotationAt) {
        lines.push('<br>Next rotation: <strong>' + new Date(status.nextRotationAt).toLocaleString() + '</strong>');
      }
      if (status.lastRotation) {
        lines.push('Last rotation: ' + new Date(status.lastRotation.rotated_at).toLocaleString()
          + ' — ' + (status.lastRotation.slots_filled || 0) + ' slot(s) filled (' + (status.lastRotation.strategy_used || 'n/a') + ')');
      }
      textEl.innerHTML = lines.join('<br>');
    } catch (err) {
      infoEl.style.display = '';
      textEl.textContent = 'Could not load rotation status.';
    }
  }

  // Load rotation settings + status when automation tab is activated
  (function() {
    var tabBar = document.getElementById('settingsTabs');
    if (!tabBar) return;
    tabBar.addEventListener('click', function(e) {
      var btn = e.target.closest('.tab-btn');
      if (btn && btn.dataset.tab === 'automation') {
        loadFeaturedRotationStatus();
      }
    });
    if (sessionStorage.getItem('dfa_settings_tab') === 'automation') {
      setTimeout(loadFeaturedRotationStatus, 100);
    }
  })();

  // Hook featured rotation loading into the main loadSettings flow
  var _origLoadSettingsForRotation = loadSettings;
  loadSettings = async function() {
    await _origLoadSettingsForRotation();
    try {
      var settings = await apiFetch('/settings');
      loadFeaturedRotationSettings(settings);
    } catch (e) { /* ignore — main loadSettings already shows error */ }
  };

  renderSidebar();
  initModals();

  if (!hasPermission('settings.update')) {
    document.querySelectorAll('.btn-primary').forEach(function(btn) {
      if (btn.textContent.trim().toLowerCase().startsWith('save')) {
        btn.disabled = true;
        btn.title = 'You do not have permission to update settings';
      }
    });
  }

  // ── Feature-gate settings sections ────────────────────────────
  loadAdminFeatures().then(function() {
    // Featured Rotation
    if (!isFeatureOn('featured_rotation')) {
      var featRotationCard = document.getElementById('featRotationEnabled');
      if (featRotationCard) {
        var card = featRotationCard.closest('.settings-card');
        if (card) {
          card.classList.add('feature-locked');
          card.insertAdjacentHTML('afterbegin',
            '<div style="pointer-events:auto;padding:12px 20px 0;">' + featureGateBanner('Featured Rotation') + '</div>');
        }
      }
    }

    // Spam Detection
    if (!isFeatureOn('spam_detection')) {
      var spamPanel = document.getElementById('spamBlocklist');
      if (spamPanel) {
        var panel = spamPanel.closest('.dash-panel');
        if (panel) {
          panel.classList.add('feature-locked');
          panel.insertAdjacentHTML('afterbegin',
            '<div style="pointer-events:auto;">' + featureGateBanner('Spam Detection') + '</div>');
        }
      }
    }

    // SEO Titles — show upgrade badge next to the Description (SEO) label
    if (!isFeatureOn('seo_titles')) {
      var seoLabel = document.querySelector('label[for="siteDescription"]');
      if (seoLabel) {
        seoLabel.insertAdjacentHTML('beforeend',
          ' <span class="badge badge-muted" style="background:rgba(234,179,8,0.15);color:#eab308;font-size:10px;vertical-align:middle;">Upgrade</span>');
      }
    }

    // BYOK — gate API key cards (ElevenLabs, Gemini, Perspective, etc.)
    if (!isFeatureOn('byok')) {
      var integrationCards = document.querySelectorAll('.tab-panel[data-tab="integrations"] .settings-card');
      integrationCards.forEach(function(card) {
        // Only lock cards that have API key inputs (but skip the AI Providers card — gated by byai)
        if (card.id === 'aiProvidersCard') return;
        if (card.querySelector('input[type="password"], input[id*="ApiKey"], input[id*="apiKey"]')) {
          card.classList.add('feature-locked');
          card.insertAdjacentHTML('afterbegin',
            '<div style="pointer-events:auto;padding:12px 20px 0;">' + featureGateBanner('Bring Your Own Key') + '</div>');
        }
      });
    }

    // BYAI — gate the AI Providers card separately
    if (!isFeatureOn('byai')) {
      var aiCard = document.getElementById('aiProvidersCard');
      if (aiCard) {
        aiCard.classList.add('feature-locked');
        aiCard.insertAdjacentHTML('afterbegin',
          '<div style="pointer-events:auto;padding:12px 20px 0;">' + featureGateBanner('Bring Your Own AI') + '</div>');
      }
    }
  });

  // ── Messaging Tab ──────────────────────────────────────────────
  var _msgWriters = [];

  function writerOptions() {
    return '<option value="">— Select Agent —</option>' + _msgWriters.map(function (w) {
      var role = w.role && w.role !== 'writer' ? ' (' + w.role + ')' : '';
      return '<option value="' + w.id + '">' + w.name + role + '</option>';
    }).join('');
  }

  function setupTokenSave(btnId, inputId, settingsKey, badgeId) {
    document.getElementById(btnId)?.addEventListener('click', async function () {
      var token = document.getElementById(inputId).value.trim();
      if (!token) { showAlert('Enter a token', 'error'); return; }
      this.disabled = true; this.textContent = 'Saving...';
      try {
        await apiFetch('/settings', { method: 'PUT', body: JSON.stringify({ [settingsKey]: token }) });
        document.getElementById(inputId).value = '';
        document.getElementById(inputId).placeholder = '••••••••  (saved)';
        var badge = document.getElementById(badgeId);
        if (badge) { badge.textContent = 'Configured'; badge.className = 'badge badge-success'; }
        showAlert('Token saved');
      } catch (err) { showAlert('Save failed: ' + err.message, 'error'); }
      finally { this.disabled = false; this.textContent = 'Save'; }
    });
  }

  (function initMessaging() {
    // Token saves
    setupTokenSave('saveTelegramBtn', 'telegramBotToken', 'telegram_bot_token', 'telegramStatus');
    setupTokenSave('saveSlackBtn', 'slackBotToken', 'slack_bot_token', 'slackStatus');
    setupTokenSave('saveDiscordBtn', 'discordBotToken', 'discord_bot_token', 'discordStatus');
    setupTokenSave('saveDiscordAppIdBtn', 'discordAppId', 'discord_app_id', null);
    setupTokenSave('saveDiscordPublicKeyBtn', 'discordPublicKey', 'discord_public_key', null);

    // Register Discord slash commands
    document.getElementById('registerDiscordCommandsBtn')?.addEventListener('click', async function () {
      this.disabled = true; this.textContent = 'Registering...';
      var statusEl = document.getElementById('discordRegisterStatus');
      try {
        var data = await apiFetch('/admin/pitches/discord-register-commands', { method: 'POST' });
        var names = (data.commands || []).map(function (c) { return '/' + c.name; }).join(', ');
        if (statusEl) statusEl.textContent = 'Registered: ' + names;
        showAlert('Discord commands registered');
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Failed: ' + err.message;
        showAlert('Registration failed: ' + err.message, 'error');
      } finally {
        this.disabled = false; this.textContent = 'Register Commands';
      }
    });

    // Telegram webhook
    document.getElementById('setTelegramWebhookBtn')?.addEventListener('click', async function () {
      var url = document.getElementById('telegramWebhookUrl').value.trim();
      if (!url) { showAlert('Enter the webhook URL', 'error'); return; }
      this.disabled = true; this.textContent = 'Setting...';
      try {
        var data = await apiFetch('/admin/pitches/telegram-webhook', { method: 'POST', body: JSON.stringify({ webhook_url: url }) });
        var st = document.getElementById('telegramSaveStatus');
        if (st) st.textContent = 'Webhook set: ' + data.webhook_url;
        showAlert('Webhook configured');
      } catch (err) { showAlert('Webhook failed: ' + err.message, 'error'); }
      finally { this.disabled = false; this.textContent = 'Set Webhook'; }
    });

    // Detect buttons
    function setupDetect(btnId, platform, apiPath, requireMsg) {
      document.getElementById(btnId)?.addEventListener('click', async function () {
        this.disabled = true; this.textContent = 'Detecting...';
        var container = document.getElementById('detectedChannels');
        try {
          var data = await apiFetch(apiPath);
          var chats = data.chats || [];
          if (!chats.length) {
            container.innerHTML = '<div class="text-muted text-sm">' + (requireMsg || 'No channels found.') + '</div>';
          } else {
            renderDetectedChannels(platform, chats);
          }
        } catch (err) {
          container.innerHTML = '<div class="text-muted text-sm">Detection failed: ' + err.message + '</div>';
        } finally {
          this.disabled = false;
          this.textContent = 'Detect ' + platform.charAt(0).toUpperCase() + platform.slice(1);
        }
      });
    }

    setupDetect('detectTelegramBtn', 'telegram', '/admin/pitches/telegram-chats', 'No chats found. Send your bot a message on Telegram first.');
    setupDetect('detectSlackBtn', 'slack', '/admin/pitches/slack-channels', 'No channels found. Add the bot to channels in Slack first.');
    setupDetect('detectDiscordBtn', 'discord', '/admin/pitches/discord-channels', 'No channels found. Add the bot to a Discord server first.');
  })();

  function renderDetectedChannels(platform, chats) {
    var container = document.getElementById('detectedChannels');
    var platformIcons = { telegram: '&#128172;', slack: '&#128488;', discord: '&#127918;' };
    var icon = platformIcons[platform] || '';

    var html = '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">'
      + icon + ' ' + chats.length + ' ' + platform + ' channel(s) found. Select a writer and click Enroll:</div>';

    html += chats.map(function (c, i) {
      var threadLabel = c.thread_id ? ' <span class="badge badge-accent" style="font-size:9px;">Topic ' + c.thread_id + '</span>' : '';
      var typeIcon = (c.type === 'group' || c.type === 'supergroup') ? '&#128101;' : c.type === 'private_channel' ? '&#128274;' : '&#128100;';
      return '<div style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;font-size:13px;" data-enroll="' + i + '">'
        + '<span>' + typeIcon + '</span>'
        + '<div style="flex:1;min-width:0;">'
        + '<strong>' + (c.title || c.chat_id) + '</strong>' + threadLabel
        + '<div class="text-muted" style="font-size:11px;">' + c.chat_id + (c.last_message ? ' — "' + c.last_message + '"' : '') + '</div>'
        + '</div>'
        + '<select class="form-control enroll-writer" data-chat="' + c.chat_id + '" data-thread="' + (c.thread_id || '') + '" style="width:140px;font-size:12px;">' + writerOptions() + '</select>'
        + '<button class="btn btn-primary btn-sm enroll-btn" style="white-space:nowrap;">Enroll</button>'
        + '</div>';
    }).join('');

    container.innerHTML = html;

    // Enroll button handlers
    container.querySelectorAll('.enroll-btn').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var row = btn.closest('[data-enroll]');
        var sel = row.querySelector('.enroll-writer');
        var writerId = sel.value;
        if (!writerId) { showAlert('Select a writer first', 'error'); return; }
        var chatId = sel.dataset.chat;
        var threadId = sel.dataset.thread || null;
        btn.disabled = true; btn.textContent = 'Enrolling...';
        try {
          await apiFetch('/admin/pitches/channels', {
            method: 'POST',
            body: JSON.stringify({ platform: platform, channel_id: chatId, thread_id: threadId, writer_id: writerId })
          });
          btn.textContent = 'Enrolled';
          btn.className = 'btn btn-sm';
          btn.style.background = 'var(--success)';
          btn.style.color = '#fff';
          btn.style.border = 'none';
          row.style.borderColor = 'var(--success)';
          showAlert('Writer enrolled in channel');
          loadChannels();
        } catch (err) {
          showAlert('Enroll failed: ' + err.message, 'error');
          btn.disabled = false; btn.textContent = 'Enroll';
        }
      });
    });
  }

  async function loadMessagingTab(settings) {
    // Status badges
    var platforms = [
      { key: 'telegram_bot_token', badge: 'telegramStatus', input: 'telegramBotToken' },
      { key: 'slack_bot_token', badge: 'slackStatus', input: 'slackBotToken' },
      { key: 'discord_bot_token', badge: 'discordStatus', input: 'discordBotToken' },
    ];
    platforms.forEach(function (p) {
      if (settings[p.key]) {
        var badge = document.getElementById(p.badge);
        if (badge) { badge.textContent = 'Configured'; badge.className = 'badge badge-success'; }
        document.getElementById(p.input).placeholder = '••••••••  (saved)';
      }
    });

    // Discord app settings (non-sensitive, show actual values)
    if (settings.discord_app_id) {
      document.getElementById('discordAppId').value = settings.discord_app_id;
    }
    if (settings.discord_public_key) {
      document.getElementById('discordPublicKey').value = settings.discord_public_key;
    }

    // Load writers for dropdowns
    try {
      _msgWriters = await apiFetch('/admin/writers');
    } catch { _msgWriters = []; }

    loadChannels();
  }

  async function loadChannels() {
    var container = document.getElementById('channelsList');
    if (!container) return;
    try {
      var data = await apiFetch('/admin/pitches/channels');
      var channels = data.channels || [];
      if (!channels.length) {
        container.innerHTML = '<div class="text-muted text-sm" style="padding:12px;">No channels enrolled yet. Use Detect above to find and enroll channels.</div>';
        return;
      }
      var platformIcons = { telegram: '&#128172;', slack: '&#128488;', discord: '&#127918;', webhook: '&#128279;' };
      container.innerHTML = '<table style="width:100%;font-size:13px;"><thead><tr><th>Platform</th><th>Channel</th><th>Topic</th><th>Writer</th><th>Active</th><th></th></tr></thead><tbody>'
        + channels.map(function (ch) {
          return '<tr>'
            + '<td>' + (platformIcons[ch.platform] || '') + ' ' + ch.platform + '</td>'
            + '<td class="text-muted input-mono" style="font-size:12px;">' + (ch.channel_id || '') + '</td>'
            + '<td class="text-muted input-mono" style="font-size:12px;">' + (ch.thread_id || '—') + '</td>'
            + '<td>' + (ch.writer_name || '<span class="text-muted">—</span>') + '</td>'
            + '<td><button class="btn btn-ghost btn-sm" onclick="toggleChannel(' + ch.id + ')">' + (ch.is_active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-muted">Off</span>') + '</button></td>'
            + '<td><button class="btn btn-ghost btn-sm" onclick="deleteChannel(' + ch.id + ')">&#10005;</button></td>'
            + '</tr>';
        }).join('')
        + '</tbody></table>';
    } catch {
      container.innerHTML = '<div class="text-muted text-sm">Failed to load channels.</div>';
    }
  }

  window.toggleChannel = async function (id) {
    try {
      await apiFetch('/admin/pitches/channels/' + id + '/toggle', { method: 'POST' });
      loadChannels();
    } catch (err) { showAlert('Toggle failed: ' + err.message, 'error'); }
  };

  window.deleteChannel = async function (id) {
    if (!confirm('Remove this channel?')) return;
    try {
      await apiFetch('/admin/pitches/channels/' + id, { method: 'DELETE' });
      showAlert('Channel removed');
      loadChannels();
    } catch (err) { showAlert('Delete failed: ' + err.message, 'error'); }
  };

  // Hook messaging load into settings
  var _origLoadSettingsForMessaging = loadSettings;
  loadSettings = async function () {
    await _origLoadSettingsForMessaging();
    try {
      var settings = await apiFetch('/settings');
      loadMessagingTab(settings);
    } catch {}
  };

  loadSettings();