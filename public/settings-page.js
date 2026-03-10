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

  loadSettings();