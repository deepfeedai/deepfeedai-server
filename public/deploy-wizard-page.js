/* ============================================================
   DeepFeedAI Admin — Deployment Wizard
   ============================================================ */

(function () {
  'use strict';

  const TOTAL_STEPS = 5;
  let currentStep = 1;
  let healthData = null;

  // ── Step navigation ────────────────────────────────────────
  const stepEls   = document.querySelectorAll('.wizard-step[data-step]');
  const panelEls  = document.querySelectorAll('.wizard-panel');
  const nextBtn   = document.getElementById('wizardNext');
  const backBtn   = document.getElementById('wizardBack');

  function goToStep(n) {
    currentStep = Math.max(1, Math.min(n, TOTAL_STEPS));
    stepEls.forEach(el => {
      const s = parseInt(el.dataset.step);
      el.classList.toggle('active', s === currentStep);
      el.classList.toggle('done', s < currentStep);
    });
    panelEls.forEach((p, i) => p.classList.toggle('active', i + 1 === currentStep));
    backBtn.style.visibility = currentStep === 1 ? 'hidden' : 'visible';
    nextBtn.textContent = currentStep === TOTAL_STEPS ? 'Complete Setup' : 'Next';
    // Load step-specific data
    if (currentStep === 1) loadEncryptionStatus();
    if (currentStep === 2) loadStorageStatus();
    if (currentStep === 3) loadAiStatus();
    if (currentStep === 4) loadEmailStatus();
    if (currentStep === 5) loadReview();
  }

  nextBtn.addEventListener('click', () => {
    if (currentStep === TOTAL_STEPS) {
      completeSetup();
    } else {
      goToStep(currentStep + 1);
    }
  });
  backBtn.addEventListener('click', () => goToStep(currentStep - 1));

  // Jump to step from URL hash (e.g. deploy-wizard.html#step3)
  const hashStep = parseInt((location.hash || '').replace('#step', ''));
  goToStep(hashStep >= 1 && hashStep <= TOTAL_STEPS ? hashStep : 1);

  // ── Status helpers ─────────────────────────────────────────
  function statusIcon(status) {
    if (status === 'ok')    return '\u2705';
    if (status === 'warn')  return '\u26A0\uFE0F';
    if (status === 'error') return '\u274C';
    return '\u2B1C';
  }

  function findCheck(key) {
    if (!healthData) return null;
    return healthData.checks.find(c => c.key === key) || null;
  }

  async function fetchHealth() {
    try {
      healthData = await apiFetch('/settings/deployment-health');
    } catch { /* ignore */ }
  }

  // ── Step 1: Encryption ─────────────────────────────────────
  async function loadEncryptionStatus() {
    await fetchHealth();
    const check = findCheck('encryption');
    const ok = check && check.status === 'ok';
    document.getElementById('encIcon').textContent = ok ? '\u2705' : '\u274C';
    document.getElementById('encLabel').textContent = ok ? 'Encryption Active' : 'Encryption Disabled';
    document.getElementById('encDetail').textContent = check ? check.detail : '';
    document.getElementById('encInstructions').style.display = ok ? 'none' : 'block';
  }

  // ── Step 2: Storage ────────────────────────────────────────
  async function loadStorageStatus() {
    if (!healthData) await fetchHealth();
    const check = findCheck('storage');
    const ok = check && check.status === 'ok';
    document.getElementById('storageIcon').textContent = statusIcon(check ? check.status : 'none');
    document.getElementById('storageLabel').textContent = ok ? 'Storage Active' : 'Storage Issue';
    document.getElementById('storageDetail').textContent = check ? check.detail : '';
  }

  document.getElementById('dwS3SaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('dwS3Status');
    const settings = {};
    const endpoint = document.getElementById('dwS3Endpoint').value.trim();
    const accessKey = document.getElementById('dwS3AccessKey').value.trim();
    const secretKey = document.getElementById('dwS3SecretKey').value.trim();
    const bucket = document.getElementById('dwS3Bucket').value.trim();
    const publicUrl = document.getElementById('dwS3PublicUrl').value.trim();

    if (!endpoint || !accessKey || !secretKey || !bucket) {
      status.textContent = 'Endpoint, Access Key, Secret Key, and Bucket are required.';
      status.style.color = 'var(--danger)';
      return;
    }

    // Map to R2 settings keys (platform-level storage config)
    settings.r2_account_id = endpoint;
    settings.r2_access_key_id = accessKey;
    settings.r2_secret_access_key = secretKey;
    settings.r2_bucket_name = bucket;
    if (publicUrl) settings.r2_public_url = publicUrl;

    status.textContent = 'Saving...';
    status.style.color = 'var(--muted)';
    try {
      await apiFetch('/settings/platform-storage', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      status.textContent = 'Saved!';
      status.style.color = 'var(--success, #34d399)';
      healthData = null;
      await loadStorageStatus();
    } catch (e) {
      status.textContent = e.message;
      status.style.color = 'var(--danger)';
    }
  });

  document.getElementById('dwS3TestBtn').addEventListener('click', async () => {
    const status = document.getElementById('dwS3Status');
    status.textContent = 'Testing...';
    status.style.color = 'var(--muted)';
    try {
      const data = await apiFetch('/settings/storage-status');
      status.textContent = data.r2Configured ? 'Connection OK' : 'Using local storage';
      status.style.color = 'var(--success, #34d399)';
    } catch (e) {
      status.textContent = e.message;
      status.style.color = 'var(--danger)';
    }
  });

  // ── Step 3: AI ─────────────────────────────────────────────
  async function loadAiStatus() {
    if (!healthData) await fetchHealth();
    const check = findCheck('ai');
    const ok = check && check.status === 'ok';
    document.getElementById('aiIcon').textContent = statusIcon(check ? check.status : 'none');
    document.getElementById('aiLabel').textContent = ok ? 'AI Configured' : 'AI Not Configured';
    document.getElementById('aiDetail').textContent = check ? check.detail : '';
  }

  document.getElementById('dwGeminiToggle').addEventListener('click', function () {
    const inp = document.getElementById('dwGeminiKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    this.textContent = inp.type === 'password' ? 'Show' : 'Hide';
  });
  document.getElementById('dwElevenLabsToggle').addEventListener('click', function () {
    const inp = document.getElementById('dwElevenLabsKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    this.textContent = inp.type === 'password' ? 'Show' : 'Hide';
  });

  document.getElementById('dwAiSaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('dwAiStatus');
    const settings = {};
    const gemini = document.getElementById('dwGeminiKey').value.trim();
    const eleven = document.getElementById('dwElevenLabsKey').value.trim();
    if (gemini) settings.gemini_api_key = gemini;
    if (eleven) settings.elevenlabs_api_key = eleven;
    if (!Object.keys(settings).length) { status.textContent = 'Enter at least one key.'; status.style.color = 'var(--danger)'; return; }

    status.textContent = 'Saving...';
    status.style.color = 'var(--muted)';
    try {
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(settings) });
      status.textContent = 'Saved!';
      status.style.color = 'var(--success, #34d399)';
      healthData = null;
      await loadAiStatus();
    } catch (e) {
      status.textContent = e.message;
      status.style.color = 'var(--danger)';
    }
  });

  // ── Step 4: Email ──────────────────────────────────────────
  async function loadEmailStatus() {
    if (!healthData) await fetchHealth();
    const check = findCheck('email');
    const ok = check && check.status === 'ok';
    document.getElementById('emailIcon').textContent = statusIcon(check ? check.status : 'none');
    document.getElementById('emailLabel').textContent = ok ? 'Email Configured' : 'Email Not Configured';
    document.getElementById('emailDetail').textContent = check ? check.detail : '';
  }

  document.getElementById('dwEmailSaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('dwEmailStatus');
    const settings = {};
    const resendKey = document.getElementById('dwResendKey').value.trim();
    const audience = document.getElementById('dwResendAudience').value.trim();
    const from = document.getElementById('dwNotifyFrom').value.trim();
    const adminEmail = document.getElementById('dwAdminEmail').value.trim();
    if (resendKey) settings.resend_api_key = resendKey;
    if (audience)  settings.resend_audience_id = audience;
    if (from)      settings.notify_from = from;
    if (adminEmail) settings.admin_email = adminEmail;
    if (!Object.keys(settings).length) { status.textContent = 'Enter at least one field.'; status.style.color = 'var(--danger)'; return; }

    status.textContent = 'Saving...';
    status.style.color = 'var(--muted)';
    try {
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(settings) });
      status.textContent = 'Saved!';
      status.style.color = 'var(--success, #34d399)';
      healthData = null;
      await loadEmailStatus();
    } catch (e) {
      status.textContent = e.message;
      status.style.color = 'var(--danger)';
    }
  });

  document.getElementById('dwEmailTestBtn').addEventListener('click', async () => {
    const status = document.getElementById('dwEmailStatus');
    status.textContent = 'Sending test...';
    status.style.color = 'var(--muted)';
    try {
      await apiFetch('/settings/test-email', { method: 'POST' });
      status.textContent = 'Test email sent!';
      status.style.color = 'var(--success, #34d399)';
    } catch (e) {
      status.textContent = e.message;
      status.style.color = 'var(--danger)';
    }
  });

  // ── Step 5: Review ─────────────────────────────────────────
  async function loadReview() {
    healthData = null; // force fresh
    await fetchHealth();
    const container = document.getElementById('reviewChecks');
    if (!healthData) { container.innerHTML = '<p style="color:var(--muted);">Could not load health data.</p>'; return; }

    container.innerHTML = healthData.checks.map(c => `
      <div class="deploy-health-card deploy-health-${c.status}">
        <span class="deploy-health-icon">${statusIcon(c.status)}</span>
        <div>
          <div class="deploy-health-label">${c.label}</div>
          <div class="deploy-health-detail">${c.detail}</div>
        </div>
      </div>
    `).join('');

    document.getElementById('reviewDone').style.display = healthData.setup_complete ? 'block' : 'none';
    nextBtn.textContent = 'Complete Setup';
  }

  // ── Complete ───────────────────────────────────────────────
  async function completeSetup() {
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({ deployment_wizard_completed: 'true' }),
      });
    } catch { /* best effort */ }
    window.location.href = '/index.html';
  }
})();
