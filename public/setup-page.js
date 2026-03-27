/* ============================================================
   DeepFeed AI — First-Boot Setup Wizard
   ============================================================ */
(function () {
  'use strict';

  var TOTAL_STEPS = 7;
  var currentStep = 1;
  var authToken   = null; // set after admin creation (step 3)
  var statusData  = null; // cached /api/setup/status response
  var selectedMode = 'single'; // default

  var stepEls  = document.querySelectorAll('.wizard-step[data-step]');
  var panels   = document.querySelectorAll('.wizard-panel');
  var nextBtn  = document.getElementById('wizardNext');
  var backBtn  = document.getElementById('wizardBack');

  // ── API helper ──────────────────────────────────────────────────
  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    return fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Request failed');
        return data;
      });
    });
  }

  // ── Step navigation ─────────────────────────────────────────────
  function goToStep(n) {
    currentStep = Math.max(1, Math.min(n, TOTAL_STEPS));
    stepEls.forEach(function (el) {
      var s = parseInt(el.dataset.step);
      el.classList.toggle('active', s === currentStep);
      el.classList.toggle('done', s < currentStep);
    });
    panels.forEach(function (p, i) {
      p.classList.toggle('step-active', i + 1 === currentStep);
      p.classList.toggle('step-hidden', i + 1 !== currentStep);
    });
    backBtn.style.visibility = currentStep === 1 ? 'hidden' : 'visible';
    nextBtn.textContent = currentStep === TOTAL_STEPS ? 'Go to Dashboard' : 'Next';

    // Disable Next when required actions aren't complete
    if (currentStep === 1 && !dbConnected) {
      nextBtn.disabled = true;
    } else if (currentStep === 3 && !authToken) {
      nextBtn.disabled = true;
    } else {
      nextBtn.disabled = false;
    }

    // Load step data
    if (currentStep === 1) loadWelcome();
    if (currentStep === 2) loadModeStep();
    if (currentStep === 4) loadEncryption();
    if (currentStep === 5) loadStorage();
    if (currentStep === 7) loadReview();
  }

  nextBtn.addEventListener('click', function () {
    if (currentStep === TOTAL_STEPS) {
      completeSetup();
    } else if (currentStep === 2) {
      // Save mode before advancing (in case they didn't click a card)
      api('/setup/mode', { method: 'POST', body: { mode: selectedMode } }).then(function () {
        goToStep(currentStep + 1);
      }).catch(function () {
        goToStep(currentStep + 1); // advance anyway
      });
    } else {
      goToStep(currentStep + 1);
    }
  });
  backBtn.addEventListener('click', function () { goToStep(currentStep - 1); });

  // ── Step 1: Welcome ─────────────────────────────────────────────
  var dbConnected = false;

  function loadWelcome() {
    api('/setup/status').then(function (data) {
      statusData = data;
      dbConnected = data.database === 'connected';
      document.getElementById('setupVersion').textContent = 'v' + data.version + ' — ' + data.mode + '-tenant mode';
      document.getElementById('welcomeModeDetail').textContent = data.mode === 'multi' ? 'Multi-tenant (SaaS)' : 'Single-tenant (self-hosted)';
      document.getElementById('welcomeEncIcon').textContent = data.encryption.configured ? '\u2705' : '\u26A0\uFE0F';
      document.getElementById('welcomeEncDetail').textContent = data.encryption.auto_generated
        ? 'Auto-generated (save to .env for persistence)'
        : 'Configured via environment variable';

      // Database status
      var dbIcon = document.querySelector('#welcomeStatus .check-row:first-child .check-icon');
      var dbDetail = document.querySelector('#welcomeStatus .check-row:first-child .check-detail');
      if (dbConnected) {
        dbIcon.textContent = '\u2705';
        dbDetail.textContent = 'PostgreSQL connected';
        document.getElementById('dbConfigSection').style.display = 'none';
        nextBtn.disabled = false;
      } else {
        dbIcon.textContent = '\u274C';
        dbDetail.textContent = 'Not configured';
        document.getElementById('dbConfigSection').style.display = 'block';
        nextBtn.disabled = true;
      }
    }).catch(function () {
      document.getElementById('welcomeModeDetail').textContent = 'Could not reach server';
    });
  }

  // Database connect button
  document.getElementById('dbConnectBtn').addEventListener('click', function () {
    var url = document.getElementById('dbUrl').value.trim();
    var status = document.getElementById('dbStatus');
    var btn = document.getElementById('dbConnectBtn');
    if (!url) { status.textContent = 'Enter a database URL.'; status.style.color = 'var(--danger, #ef4444)'; return; }

    btn.disabled = true;
    status.textContent = 'Connecting...';
    status.style.color = 'var(--muted)';

    api('/setup/database', { method: 'POST', body: { url: url } }).then(function () {
      status.textContent = 'Connected!';
      status.style.color = 'var(--success, #34d399)';
      dbConnected = true;
      nextBtn.disabled = false;
      // Refresh the welcome status
      loadWelcome();
    }).catch(function (e) {
      status.textContent = e.message;
      status.style.color = 'var(--danger, #ef4444)';
      btn.disabled = false;
    });
  });

  // ── Step 2: Deployment Mode ─────────────────────────────────────
  var modeCards = document.querySelectorAll('.mode-card');
  var modeStatus = document.getElementById('modeStatus');
  var modeMultiHint = document.getElementById('modeMultiHint');

  function loadModeStep() {
    // Pre-select based on server-detected mode
    if (statusData && statusData.mode === 'multi') {
      selectedMode = 'multi';
    }
    updateModeUI();
  }

  function updateModeUI() {
    modeCards.forEach(function (card) {
      card.classList.toggle('selected', card.dataset.mode === selectedMode);
    });
    modeMultiHint.style.display = selectedMode === 'multi' ? 'block' : 'none';
  }

  modeCards.forEach(function (card) {
    card.addEventListener('click', function () {
      selectedMode = card.dataset.mode;
      updateModeUI();
      // Save the choice to the server
      modeStatus.textContent = 'Saving...';
      modeStatus.style.color = 'var(--muted)';
      api('/setup/mode', { method: 'POST', body: { mode: selectedMode } }).then(function () {
        modeStatus.textContent = (selectedMode === 'multi' ? 'Multi-tenant' : 'Single-tenant') + ' mode saved.';
        modeStatus.style.color = 'var(--success, #34d399)';
      }).catch(function (e) {
        modeStatus.textContent = e.message;
        modeStatus.style.color = 'var(--danger, #ef4444)';
      });
    });
  });

  // ── Step 3: Admin Account ───────────────────────────────────────
  var usernameInput  = document.getElementById('adminUsername');
  var passwordInput  = document.getElementById('adminPassword');
  var emailInput     = document.getElementById('adminEmail');
  var adminStatus    = document.getElementById('adminStatus');
  var pwStrength     = document.getElementById('pwStrength');

  // Create admin on Enter key in password field
  passwordInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') createAdmin();
  });

  // Password strength indicator
  passwordInput.addEventListener('input', function () {
    var pw = passwordInput.value;
    if (pw.length === 0) { pwStrength.textContent = ''; return; }
    if (pw.length < 8) { pwStrength.textContent = 'Too short'; pwStrength.style.color = 'var(--danger, #ef4444)'; return; }
    var score = 0;
    if (/[a-z]/.test(pw)) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^a-zA-Z0-9]/.test(pw)) score++;
    var labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
    var colors = ['', 'var(--danger, #ef4444)', '#f59e0b', 'var(--success, #34d399)', 'var(--success, #34d399)'];
    pwStrength.textContent = labels[score] || '';
    pwStrength.style.color = colors[score] || '';
  });

  // We need a separate Create button since Next is disabled
  // Actually, let's add a create button dynamically or use a form submit
  // Simpler: add click handler that creates admin, then enables Next
  var createBtn = document.createElement('button');
  createBtn.className = 'btn btn-primary';
  createBtn.textContent = 'Create Admin Account';
  createBtn.type = 'button';
  createBtn.addEventListener('click', createAdmin);
  adminStatus.parentNode.insertBefore(createBtn, adminStatus);

  function createAdmin() {
    var username = usernameInput.value.trim();
    var password = passwordInput.value;
    var email    = emailInput.value.trim();

    if (!username || !password) {
      adminStatus.textContent = 'Username and password are required.';
      adminStatus.style.color = 'var(--danger, #ef4444)';
      return;
    }
    if (password.length < 8) {
      adminStatus.textContent = 'Password must be at least 8 characters.';
      adminStatus.style.color = 'var(--danger, #ef4444)';
      return;
    }

    createBtn.disabled = true;
    adminStatus.textContent = 'Creating account...';
    adminStatus.style.color = 'var(--muted)';

    api('/setup/admin', {
      method: 'POST',
      body: { username: username, password: password, email: email || undefined },
    }).then(function (data) {
      authToken = data.token;
      // Store token so post-setup the admin is logged in
      try { localStorage.setItem('deepfeedai_token', data.token); } catch (e) { /* ignore */ }
      adminStatus.textContent = 'Admin account created!';
      adminStatus.style.color = 'var(--success, #34d399)';
      createBtn.style.display = 'none';
      nextBtn.disabled = false;
      // Auto-advance after short delay
      setTimeout(function () { goToStep(4); }, 600);
    }).catch(function (err) {
      adminStatus.textContent = err.message;
      adminStatus.style.color = 'var(--danger, #ef4444)';
      createBtn.disabled = false;
    });
  }

  // ── Step 3: Encryption ──────────────────────────────────────────
  function loadEncryption() {
    api('/setup/encryption').then(function (data) {
      if (data.auto_generated && data.key) {
        document.getElementById('encIcon').textContent = '\u26A0\uFE0F';
        document.getElementById('encLabel').textContent = 'Auto-Generated Key';
        document.getElementById('encDetail').textContent = 'Save this key to your .env file before restarting.';
        document.getElementById('encKeySection').style.display = 'block';
        document.getElementById('encConfigured').style.display = 'none';
        document.getElementById('encKeyValue').textContent = data.key;
        document.getElementById('encEnvLine').textContent = 'SETTINGS_ENCRYPTION_KEY=' + data.key;
      } else {
        document.getElementById('encIcon').textContent = '\u2705';
        document.getElementById('encLabel').textContent = 'Encryption Active';
        document.getElementById('encDetail').textContent = 'AES-256-GCM configured via environment variable.';
        document.getElementById('encKeySection').style.display = 'none';
        document.getElementById('encConfigured').style.display = 'block';
      }
    }).catch(function () {
      document.getElementById('encIcon').textContent = '\u274C';
      document.getElementById('encLabel').textContent = 'Error';
      document.getElementById('encDetail').textContent = 'Could not check encryption status.';
    });
  }

  document.getElementById('encCopyBtn').addEventListener('click', function () {
    var key = document.getElementById('encKeyValue').textContent;
    navigator.clipboard.writeText(key).then(function () {
      document.getElementById('encCopyBtn').textContent = 'Copied!';
      setTimeout(function () { document.getElementById('encCopyBtn').textContent = 'Copy'; }, 2000);
    });
  });

  // ── Step 4: Storage ─────────────────────────────────────────────
  function loadStorage() {
    api('/setup/health').then(function (data) {
      var check = data.checks.find(function (c) { return c.key === 'storage'; });
      if (check) {
        document.getElementById('storageIcon').textContent = check.status === 'ok' ? '\u2705' : '\u274C';
        document.getElementById('storageLabel').textContent = check.status === 'ok' ? 'Storage Active' : 'Storage Issue';
        document.getElementById('storageDetail').textContent = check.detail;
      }
    });
  }

  function getS3Fields() {
    return {
      endpoint:  document.getElementById('s3Endpoint').value.trim(),
      accessKey: document.getElementById('s3AccessKey').value.trim(),
      secretKey: document.getElementById('s3SecretKey').value.trim(),
      bucket:    document.getElementById('s3Bucket').value.trim(),
      publicUrl: document.getElementById('s3PublicUrl').value.trim(),
    };
  }

  function validateS3Fields(fields, status) {
    if (!fields.endpoint || !fields.accessKey || !fields.secretKey || !fields.bucket) {
      status.textContent = 'Endpoint, Access Key, Secret Key, and Bucket are required.';
      status.style.color = 'var(--danger, #ef4444)';
      return false;
    }
    // Strip trailing slashes and paths from endpoint
    try {
      var u = new URL(fields.endpoint);
      if (u.pathname && u.pathname !== '/') {
        status.textContent = 'Endpoint should be the base URL only (no path). The bucket name goes in the Bucket field.';
        status.style.color = 'var(--danger, #ef4444)';
        return false;
      }
    } catch (e) {
      status.textContent = 'Endpoint must be a valid URL (e.g. https://account-id.r2.cloudflarestorage.com)';
      status.style.color = 'var(--danger, #ef4444)';
      return false;
    }
    return true;
  }

  function s3SettingsPayload(fields) {
    var settings = {
      r2_account_id: fields.endpoint,
      r2_access_key_id: fields.accessKey,
      r2_secret_access_key: fields.secretKey,
      r2_bucket_name: fields.bucket,
    };
    if (fields.publicUrl) settings.r2_public_url = fields.publicUrl;
    return settings;
  }

  function testStorageConnection(status) {
    return api('/setup/health').then(function (data) {
      var check = data.checks.find(function (c) { return c.key === 'storage'; });
      if (check && check.status === 'ok') {
        status.textContent = check.detail;
        status.style.color = 'var(--success, #34d399)';
      } else {
        status.textContent = check ? check.detail : 'Storage check failed';
        status.style.color = 'var(--danger, #ef4444)';
      }
      loadStorage();
    });
  }

  document.getElementById('s3SaveBtn').addEventListener('click', function () {
    var status = document.getElementById('s3Status');
    var fields = getS3Fields();
    if (!validateS3Fields(fields, status)) return;

    status.textContent = 'Saving...';
    status.style.color = 'var(--muted)';
    api('/settings/platform-storage', { method: 'PUT', body: s3SettingsPayload(fields) }).then(function () {
      status.textContent = 'Saved! Testing connection...';
      status.style.color = 'var(--muted)';
      return testStorageConnection(status);
    }).catch(function (e) {
      status.textContent = e.message;
      status.style.color = 'var(--danger, #ef4444)';
    });
  });

  document.getElementById('s3TestBtn').addEventListener('click', function () {
    var status = document.getElementById('s3Status');
    var fields = getS3Fields();
    if (!validateS3Fields(fields, status)) return;

    status.textContent = 'Saving and testing...';
    status.style.color = 'var(--muted)';
    api('/settings/platform-storage', { method: 'PUT', body: s3SettingsPayload(fields) }).then(function () {
      return testStorageConnection(status);
    }).catch(function (e) {
      status.textContent = 'Test failed: ' + e.message;
      status.style.color = 'var(--danger, #ef4444)';
    });
  });

  // ── Step 5: AI & Services ───────────────────────────────────────
  // Toggle visibility
  document.getElementById('geminiToggle').addEventListener('click', function () {
    var inp = document.getElementById('geminiKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    this.textContent = inp.type === 'password' ? 'Show' : 'Hide';
  });
  document.getElementById('elevenLabsToggle').addEventListener('click', function () {
    var inp = document.getElementById('elevenLabsKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    this.textContent = inp.type === 'password' ? 'Show' : 'Hide';
  });

  document.getElementById('servicesSaveBtn').addEventListener('click', function () {
    var status   = document.getElementById('servicesStatus');
    var settings = {};
    var gemini     = document.getElementById('geminiKey').value.trim();
    var elevenLabs = document.getElementById('elevenLabsKey').value.trim();
    var resend     = document.getElementById('resendKey').value.trim();
    var adminEmail = document.getElementById('adminEmailAddr').value.trim();

    if (gemini)     settings.gemini_api_key = gemini;
    if (elevenLabs) settings.elevenlabs_api_key = elevenLabs;
    if (resend)     settings.resend_api_key = resend;
    if (adminEmail) settings.admin_email = adminEmail;

    if (!Object.keys(settings).length) {
      status.textContent = 'Enter at least one value to save.';
      status.style.color = 'var(--danger, #ef4444)';
      return;
    }

    status.textContent = 'Saving...';
    status.style.color = 'var(--muted)';
    api('/settings', { method: 'PUT', body: settings }).then(function () {
      status.textContent = 'Saved!';
      status.style.color = 'var(--success, #34d399)';
    }).catch(function (e) {
      status.textContent = e.message;
      status.style.color = 'var(--danger, #ef4444)';
    });
  });

  // ── Step 6: Review ──────────────────────────────────────────────
  function statusIcon(s) {
    if (s === 'ok')    return '\u2705';
    if (s === 'warn')  return '\u26A0\uFE0F';
    if (s === 'error') return '\u274C';
    return '\u2B1C';
  }

  function loadReview() {
    api('/setup/health').then(function (data) {
      var container = document.getElementById('reviewChecks');
      container.textContent = '';
      data.checks.forEach(function (c) {
        var row = document.createElement('div');
        row.className = 'check-row';
        var icon = document.createElement('span');
        icon.className = 'check-icon';
        icon.textContent = statusIcon(c.status);
        var info = document.createElement('div');
        var label = document.createElement('div');
        label.className = 'check-label';
        label.textContent = c.label;
        var detail = document.createElement('div');
        detail.className = 'check-detail';
        detail.textContent = c.detail;
        info.appendChild(label);
        info.appendChild(detail);
        row.appendChild(icon);
        row.appendChild(info);
        container.appendChild(row);
      });

      document.getElementById('reviewDone').style.display = data.setup_complete ? 'block' : 'none';
    }).catch(function () {
      var container = document.getElementById('reviewChecks');
      container.textContent = '';
      var p = document.createElement('p');
      p.style.color = 'var(--muted)';
      p.textContent = 'Could not load health data.';
      container.appendChild(p);
    });
  }

  // ── Complete ────────────────────────────────────────────────────
  function completeSetup() {
    api('/setup/complete', { method: 'POST' }).catch(function () { /* best effort */ });
    window.location.href = '/index.html';
  }

  // ── Init ────────────────────────────────────────────────────────
  goToStep(1);
})();
