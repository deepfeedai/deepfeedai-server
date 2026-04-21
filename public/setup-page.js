/* ============================================================
   DeepFeed AI — First-Boot Setup Wizard (3-step)
   ============================================================ */
(function () {
  'use strict';

  var TOTAL_STEPS = 3;
  var currentStep = 1;
  var authToken   = null;
  var statusData  = null;
  var dbConnected = false;

  var stepEls = document.querySelectorAll('.wizard-step[data-step]');
  var panels  = document.querySelectorAll('.wizard-panel');
  var nextBtn = document.getElementById('wizardNext');
  var backBtn = document.getElementById('wizardBack');

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
      var s = parseInt(el.dataset.step, 10);
      el.classList.toggle('active', s === currentStep);
      el.classList.toggle('done', s < currentStep);
    });
    panels.forEach(function (p, i) {
      p.classList.toggle('step-active', i + 1 === currentStep);
      p.classList.toggle('step-hidden', i + 1 !== currentStep);
    });
    backBtn.style.visibility = currentStep === 1 ? 'hidden' : 'visible';

    if (currentStep === TOTAL_STEPS) {
      nextBtn.textContent = 'Continue to Newsroom \u2192';
    } else {
      nextBtn.textContent = 'Next';
    }

    // Default Next state
    nextBtn.disabled = false;
    if (currentStep === 1 && !dbConnected) nextBtn.disabled = true;
    if (currentStep === 2 && !authToken)   nextBtn.disabled = true;

    // Step-specific load
    if (currentStep === 1) loadWelcome();
    if (currentStep === 3) loadEncryption();
  }

  nextBtn.addEventListener('click', function () {
    if (currentStep === TOTAL_STEPS) {
      window.location.href = '/wizard.html';
      return;
    }
    goToStep(currentStep + 1);
  });

  backBtn.addEventListener('click', function () { goToStep(currentStep - 1); });

  // ── Step 1: Welcome ─────────────────────────────────────────────
  function loadWelcome() {
    api('/setup/status').then(function (data) {
      statusData = data;
      dbConnected = data.database === 'connected';
      document.getElementById('setupVersion').textContent = 'v' + data.version + ' \u2014 ' + data.mode + '-tenant mode';
      document.getElementById('welcomeModeDetail').textContent = data.mode === 'multi' ? 'Multi-tenant (SaaS)' : 'Single-tenant (self-hosted)';
      document.getElementById('welcomeEncIcon').textContent = data.encryption.configured ? '\u2705' : '\u26a0\ufe0f';
      document.getElementById('welcomeEncDetail').textContent = data.encryption.auto_generated
        ? 'Auto-generated (save to .env for persistence)'
        : 'Configured via environment variable';

      var dbIcon   = document.getElementById('welcomeDbIcon');
      var dbDetail = document.getElementById('welcomeDbDetail');
      dbIcon.textContent   = dbConnected ? '\u2705' : '\u274c';
      dbDetail.textContent = dbConnected ? 'PostgreSQL connected' : 'Not configured';

      if (dbConnected) {
        document.getElementById('dbConfigSection').style.display = 'none';
        nextBtn.disabled = false;
      } else {
        document.getElementById('dbConfigSection').style.display = 'block';
        nextBtn.disabled = true;
      }
    }).catch(function () {
      document.getElementById('welcomeModeDetail').textContent = 'Could not reach server';
    });
  }

  document.getElementById('dbConnectBtn').addEventListener('click', function () {
    var url    = document.getElementById('dbUrl').value.trim();
    var status = document.getElementById('dbStatus');
    var btn    = this;
    if (!url) {
      status.textContent = 'Enter a database URL.';
      status.style.color = 'var(--danger,#ef4444)';
      return;
    }
    btn.disabled = true;
    status.textContent = 'Connecting...';
    status.style.color = 'var(--muted)';
    api('/setup/database', { method: 'POST', body: { url: url } })
      .then(function () {
        status.textContent = 'Connected!';
        status.style.color = 'var(--success,#34d399)';
        dbConnected = true;
        nextBtn.disabled = false;
        loadWelcome();
      })
      .catch(function (e) {
        status.textContent = e.message;
        status.style.color = 'var(--danger,#ef4444)';
        btn.disabled = false;
      });
  });

  // ── Step 2: Admin Account ───────────────────────────────────────
  var passwordInput        = document.getElementById('adminPassword');
  var passwordConfirmInput = document.getElementById('adminPasswordConfirm');
  var adminStatus          = document.getElementById('adminStatus');

  passwordInput.addEventListener('input', function () {
    var pw = passwordInput.value;
    var el = document.getElementById('pwStrength');
    if (!pw) { el.textContent = ''; return; }
    if (pw.length < 8) { el.textContent = 'Too short'; el.style.color = 'var(--danger,#ef4444)'; return; }
    var score = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(function (r) { return r.test(pw); }).length;
    var labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
    var colors = ['', 'var(--danger,#ef4444)', '#f59e0b', 'var(--success,#34d399)', 'var(--success,#34d399)'];
    el.textContent = labels[score] || '';
    el.style.color = colors[score] || '';
  });

  passwordConfirmInput.addEventListener('input', function () {
    var el = document.getElementById('pwConfirmStatus');
    if (!passwordConfirmInput.value) { el.textContent = ''; return; }
    var match = passwordInput.value === passwordConfirmInput.value;
    el.textContent = match ? 'Passwords match' : 'Passwords do not match';
    el.style.color = match ? 'var(--success,#34d399)' : 'var(--danger,#ef4444)';
  });

  var createBtn = document.createElement('button');
  createBtn.className = 'btn btn-primary';
  createBtn.textContent = 'Create Admin Account';
  createBtn.type = 'button';
  createBtn.addEventListener('click', createAdmin);
  adminStatus.parentNode.insertBefore(createBtn, adminStatus);

  function createAdmin() {
    var username = document.getElementById('adminUsername').value.trim();
    var password = passwordInput.value;
    var confirm  = passwordConfirmInput.value;
    var email    = document.getElementById('adminEmail').value.trim();

    if (!username || !password) {
      adminStatus.textContent = 'Username and password are required.';
      adminStatus.style.color = 'var(--danger,#ef4444)';
      return;
    }
    if (password.length < 8) {
      adminStatus.textContent = 'Password must be at least 8 characters.';
      adminStatus.style.color = 'var(--danger,#ef4444)';
      return;
    }
    if (password !== confirm) {
      adminStatus.textContent = 'Passwords do not match.';
      adminStatus.style.color = 'var(--danger,#ef4444)';
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
      try { localStorage.setItem('deepfeedai_token', data.token); } catch (e) { /* ignore */ }
      adminStatus.textContent = 'Admin account created!';
      adminStatus.style.color = 'var(--success,#34d399)';
      createBtn.style.display = 'none';
      nextBtn.disabled = false;
      setTimeout(function () { goToStep(3); }, 600);
    }).catch(function (err) {
      adminStatus.textContent = err.message;
      adminStatus.style.color = 'var(--danger,#ef4444)';
      createBtn.disabled = false;
    });
  }

  // ── Step 3: Encryption ──────────────────────────────────────────
  function loadEncryption() {
    api('/setup/encryption').then(function (data) {
      if (data.auto_generated && data.key) {
        document.getElementById('encIcon').textContent = '\u26a0\ufe0f';
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
      document.getElementById('encIcon').textContent = '\u274c';
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

  // ── Init ────────────────────────────────────────────────────────
  goToStep(1);
})();
