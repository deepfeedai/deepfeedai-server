/* ===== DeepFeedAI — Signup Page ===== */

onReady(async () => {
  const errEl      = document.getElementById('signupError');
  const stepAuth   = document.getElementById('stepAuth');
  const stepTenant = document.getElementById('stepTenant');
  const googleBtn  = document.getElementById('googleBtn');
  const githubBtn  = document.getElementById('githubBtn');
  const nameInput  = document.getElementById('siteName');
  const slugInput  = document.getElementById('siteSlug');
  const slugStatus = document.getElementById('slugStatus');
  const createBtn  = document.getElementById('createBtn');
  const greeting   = document.getElementById('userGreeting');

  let userToken = null; // public user JWT for tenant creation
  let slugOk    = false;
  let slugTimer = null;

  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const error  = params.get('error');

  if (error) {
    showError(error === 'unauthorized' ? 'OAuth error. Please try again.' : 'Sign-in failed.');
  }

  // If returning from OAuth with a code, exchange it for a user JWT
  if (code) {
    await exchangeCode(code);
  }

  // OAuth buttons
  googleBtn.addEventListener('click', () => {
    window.location.href = '/api/user-auth/google?return_to=signup';
  });
  githubBtn.addEventListener('click', () => {
    window.location.href = '/api/user-auth/github?return_to=signup';
  });

  // Auto-generate slug from site name
  nameInput.addEventListener('input', () => {
    const slug = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    slugInput.value = slug;
    checkSlug(slug);
  });

  // Manual slug editing
  slugInput.addEventListener('input', () => {
    const slug = slugInput.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
    slugInput.value = slug;
    checkSlug(slug);
  });

  // Create tenant
  createBtn.addEventListener('click', createTenant);

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  function clearError() {
    errEl.style.display = 'none';
  }

  async function exchangeCode(oauthCode) {
    // Clear code from URL
    window.history.replaceState({}, '', '/signup.html');

    try {
      const res = await fetch('/api/user-auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: oauthCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Code exchange failed');

      userToken = data.token;

      // Check if this user already owns a tenant — if so, log them in directly
      try {
        const loginRes = await fetch('/api/tenants/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + userToken,
          },
        });
        if (loginRes.ok) {
          const loginData = await loginRes.json();
          setToken(loginData.token);
          localStorage.setItem('deepfeedai_user', loginData.tenant.display_name);
          localStorage.setItem('deepfeedai_tenant', loginData.tenant.slug);
          window.location.replace('/index.html');
          return;
        }
      } catch { /* no existing tenant — continue to signup */ }

      showTenantStep(data.user);
    } catch (err) {
      showError(err.message);
    }
  }

  function showTenantStep(user) {
    stepAuth.style.display = 'none';
    stepTenant.style.display = 'block';
    if (user && user.display_name) {
      greeting.textContent = 'Welcome, ' + user.display_name + '!';
    }
    nameInput.focus();
  }

  function checkSlug(slug) {
    slugOk = false;
    createBtn.disabled = true;
    clearTimeout(slugTimer);

    if (!slug || slug.length < 3) {
      slugStatus.innerHTML = slug ? '<span style="color:var(--danger);">At least 3 characters</span>' : '';
      return;
    }

    slugStatus.innerHTML = '<span style="color:var(--muted);">Checking...</span>';
    slugTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/tenants/check-slug?slug=' + encodeURIComponent(slug));
        const data = await res.json();
        if (data.available) {
          slugStatus.innerHTML = '<span style="color:var(--success);">&#10003; Available</span>';
          slugOk = true;
          createBtn.disabled = false;
        } else {
          slugStatus.innerHTML = '<span style="color:var(--danger);">' + (data.reason || 'Taken') + '</span>';
        }
      } catch {
        slugStatus.innerHTML = '<span style="color:var(--danger);">Could not check</span>';
      }
    }, 400);
  }

  async function createTenant() {
    if (!slugOk || !userToken) return;
    const name = nameInput.value.trim();
    const slug = slugInput.value.trim();
    if (!name) { showError('Enter a site name'); return; }

    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
    clearError();

    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + userToken,
        },
        body: JSON.stringify({ slug, display_name: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create site');

      // Store tenant admin JWT and redirect to wizard
      setToken(data.token);
      localStorage.setItem('deepfeedai_user', name);
      localStorage.setItem('deepfeedai_tenant', data.tenant.slug);
      window.location.replace('/wizard.html');
    } catch (err) {
      showError(err.message);
      createBtn.disabled = false;
      createBtn.textContent = 'Create Site';
    }
  }
});
