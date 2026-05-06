/* ===== DeepFeedAI — Signup Page (Redesigned) ===== */

onReady(async () => {
  // ── Signups gate check ──────────────────────────────────────────
  try {
    const statusRes = await fetch('/api/setup/status');
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (!statusData.signups_enabled) {
        document.getElementById('signupContent').style.display = 'none';
        document.getElementById('waitlistPanel').style.display = '';
        _initWaitlistForm();
        return;
      }
    }
  } catch { /* network error — fall through to signup form */ }

  function _initWaitlistForm() {
    const submitBtn = document.getElementById('waitlistSubmitBtn');
    const emailInput = document.getElementById('waitlistEmail');
    const errEl = document.getElementById('waitlistError');

    function showWaitlistError(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
    function clearWaitlistError() { errEl.style.display = 'none'; }

    async function submitWaitlist() {
      clearWaitlistError();
      const email = emailInput.value.trim();
      const name = document.getElementById('waitlistName').value.trim();
      if (!email) return showWaitlistError('Email is required');

      submitBtn.disabled = true;
      submitBtn.textContent = 'Joining…';

      try {
        const res = await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name, source: 'signup' }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong');
        document.getElementById('waitlistFormWrap').style.display = 'none';
        document.getElementById('waitlistSuccess').style.display = 'block';
      } catch (err) {
        showWaitlistError(err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Join the waitlist';
      }
    }

    submitBtn.addEventListener('click', submitWaitlist);
    emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitWaitlist(); });
  }

  const errEl = document.getElementById('signupError');

  let currentStep = 1;
  let userToken = sessionStorage.getItem('signup_token') || null;
  let registeredEmail = sessionStorage.getItem('signup_email') || null;
  let selectedPlan = sessionStorage.getItem('signup_plan') || 'free';
  let slugOk = false;
  let slugTimer = null;
  let planLimits = [];

  function persistState() {
    if (userToken) sessionStorage.setItem('signup_token', userToken);
    else sessionStorage.removeItem('signup_token');
    if (registeredEmail) sessionStorage.setItem('signup_email', registeredEmail);
    else sessionStorage.removeItem('signup_email');
    sessionStorage.setItem('signup_plan', selectedPlan);
    sessionStorage.setItem('signup_step', String(currentStep));
  }
  function clearSignupState() {
    sessionStorage.removeItem('signup_token');
    sessionStorage.removeItem('signup_email');
    sessionStorage.removeItem('signup_plan');
    sessionStorage.removeItem('signup_step');
  }

  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');

  if (error) showError(error === 'unauthorized' ? 'OAuth error. Please try again.' : 'Sign-in failed.');
  if (params.get('cancelled') === 'true') showError('Payment was cancelled. You can choose a different plan or try again.');
  if (code) await exchangeOAuthCode(code);

  // Restore signup progress after page refresh or redirect from login
  if (!code && userToken) {
    // Validate the token is still good before trusting it
    try {
      const meRes = await fetch('/api/user-auth/me', {
        headers: { Authorization: 'Bearer ' + userToken },
      });
      if (!meRes.ok) throw new Error('Invalid token');
    } catch {
      // Token is stale or user was deleted — clear and start fresh
      userToken = null;
      registeredEmail = null;
      clearSignupState();
    }
  }

  if (!code && userToken) {
    const savedStep = parseInt(sessionStorage.getItem('signup_step'));
    if (savedStep > 1) {
      if (savedStep === 2 && registeredEmail) {
        document.getElementById('verifyEmailAddr').textContent = registeredEmail;
      }
      goToStep(savedStep);
    } else {
      await checkExistingTenant();
    }
  }

  // ── Plan data (public endpoint, no auth required) ──
  try {
    const res = await fetch('/api/tenants/plans');
    if (res.ok) {
      const data = await res.json();
      planLimits = data.plans || [];
    }
  } catch { /* use defaults */ }
  renderPlans();

  // ── OAuth buttons ──
  document.getElementById('googleBtn').addEventListener('click', () => {
    window.location.href = '/api/user-auth/google?return_to=signup';
  });
  document.getElementById('githubBtn').addEventListener('click', () => {
    window.location.href = '/api/user-auth/github?return_to=signup';
  });

  // ── Email registration ──
  document.getElementById('registerBtn').addEventListener('click', async () => {
    clearError();
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;

    if (!name) return showError('Name is required');
    if (!email) return showError('Email is required');
    if (password.length < 8) return showError('Password must be at least 8 characters');

    const btn = document.getElementById('registerBtn');
    btn.disabled = true;
    btn.textContent = 'Creating account...';

    try {
      const res = await fetch('/api/user-auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      userToken = data.token;
      registeredEmail = data.user.email || email;
      persistState();

      if (data.email_verified === false) {
        // Show verification step
        document.getElementById('verifyEmailAddr').textContent = registeredEmail;
        goToStep(2);
      } else {
        await checkExistingTenant();
      }
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  });

  // ── Toggle between register and login forms ──
  document.getElementById('showLoginLink').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('loginForm').style.display = '';
    clearError();
  });
  document.getElementById('showRegisterLink').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = '';
    clearError();
  });

  // ── Email login (returning users) ──
  document.getElementById('loginBtn').addEventListener('click', async () => {
    clearError();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!email) return showError('Email is required');
    if (!password) return showError('Password is required');

    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
      const res = await fetch('/api/user-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      userToken = data.token;
      registeredEmail = data.user.email || email;
      persistState();

      if (data.email_verified === false) {
        document.getElementById('verifyEmailAddr').textContent = registeredEmail;
        goToStep(2);
      } else {
        await checkExistingTenant();
      }
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  document.getElementById('loginPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginBtn').click();
  });
  document.getElementById('loginEmail')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginPassword').focus();
  });

  // ── Registration form keyboard shortcuts ──
  document.getElementById('regEmail')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('registerBtn').click();
  });
  document.getElementById('regPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('registerBtn').click();
  });

  // ── Verification handlers ──
  document.getElementById('verifyBtn').addEventListener('click', verifyEmail);
  document.getElementById('verifyCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyEmail();
  });
  document.getElementById('resendBtn').addEventListener('click', resendVerification);

  // ── Navigation ──
  document.getElementById('backToStep1').addEventListener('click', () => goToStep(1));
  document.getElementById('backToStep1FromVerify').addEventListener('click', () => {
    userToken = null;
    registeredEmail = null;
    clearSignupState();
    document.getElementById('verifyCode').value = '';
    goToStep(1);
  });
  document.getElementById('backToStep3').addEventListener('click', () => goToStep(3));
  document.getElementById('toStep4').addEventListener('click', () => goToStep(4));
  document.getElementById('createBtn').addEventListener('click', createTenant);

  // ── Slug auto-generation ──
  document.getElementById('siteName').addEventListener('input', () => {
    const slug = document.getElementById('siteName').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    document.getElementById('siteSlug').value = slug;
    checkSlug(slug);
  });
  document.getElementById('siteSlug').addEventListener('input', () => {
    const slug = document.getElementById('siteSlug').value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
    document.getElementById('siteSlug').value = slug;
    checkSlug(slug);
  });

  // ── Plan selection ──
  document.getElementById('planGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.plan-option');
    if (!card) return;
    selectedPlan = card.dataset.plan;
    persistState();
    document.querySelectorAll('.plan-option').forEach(c => c.classList.toggle('selected', c.dataset.plan === selectedPlan));
  });

  // ── Functions ──

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }
  function clearError() {
    errEl.style.display = 'none';
  }

  function goToStep(step) {
    currentStep = step;
    document.querySelectorAll('.step-panel').forEach((p, i) => {
      p.classList.toggle('active', i + 1 === step);
    });
    // Update step indicators
    document.querySelectorAll('.signup-step').forEach(s => {
      const n = parseInt(s.dataset.step);
      s.classList.toggle('active', n === step);
      s.classList.toggle('done', n < step);
    });
    document.querySelectorAll('.signup-step-line').forEach((l, i) => {
      l.classList.toggle('done', i + 1 < step);
    });
    clearError();
    persistState();

    if (step === 2) document.getElementById('verifyCode').focus();
    if (step === 4) document.getElementById('siteName').focus();
  }

  async function verifyEmail() {
    clearError();
    const code = document.getElementById('verifyCode').value.replace(/\s/g, '');
    if (!code || !/^\d{6}$/.test(code)) return showError('Enter the 6-digit code');

    const btn = document.getElementById('verifyBtn');
    btn.disabled = true;
    btn.textContent = 'Verifying...';

    try {
      const res = await fetch('/api/user-auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userToken },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');

      // Update token with emailVerified claim
      if (data.token) userToken = data.token;
      persistState();
      await checkExistingTenant();
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = 'Verify';
    }
  }

  async function resendVerification() {
    const btn = document.getElementById('resendBtn');
    const status = document.getElementById('resendStatus');
    btn.disabled = true;

    try {
      const res = await fetch('/api/user-auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userToken },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resend');
      if (data.sent === false) throw new Error(data.error || 'Email delivery failed');

      status.innerHTML = '<span style="color:var(--success);">Code sent!</span>';
      document.getElementById('verifyCode').value = '';
      document.getElementById('verifyCode').focus();

      // 60-second cooldown
      let cooldown = 60;
      btn.textContent = `Resend (${cooldown}s)`;
      const timer = setInterval(() => {
        cooldown--;
        if (cooldown <= 0) {
          clearInterval(timer);
          btn.disabled = false;
          btn.textContent = 'Resend code';
          status.innerHTML = '';
        } else {
          btn.textContent = `Resend (${cooldown}s)`;
        }
      }, 1000);
    } catch (err) {
      status.innerHTML = `<span style="color:var(--danger);">${err.message}</span>`;
      btn.disabled = false;
    }
  }

  async function exchangeOAuthCode(oauthCode) {
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
      persistState();
      // OAuth users are already verified — skip verification step
      await checkExistingTenant();
    } catch (err) {
      showError(err.message);
    }
  }

  async function checkExistingTenant() {
    // Check if email verification is needed (local provider, not yet verified)
    try {
      const payload = JSON.parse(atob(userToken.split('.')[1]));
      if (payload.provider === 'local' && !payload.emailVerified) {
        registeredEmail = payload.email;
        persistState();
        document.getElementById('verifyEmailAddr').textContent = registeredEmail;
        goToStep(2);
        return;
      }
    } catch { /* token parse failed — continue */ }

    try {
      const loginRes = await fetch('/api/tenants/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userToken },
      });
      if (loginRes.ok) {
        const loginData = await loginRes.json();
        clearSignupState();
        setToken(loginData.token);
        localStorage.setItem('deepfeedai_user', loginData.tenant.display_name);
        localStorage.setItem('deepfeedai_tenant', loginData.tenant.slug);
        window.location.replace('/index.html');
        return;
      }
    } catch { /* no existing tenant */ }
    // Skip to plan selection (step 3) — verification already done or not needed
    goToStep(3);
  }

  function formatPrice(cents) {
    if (!cents || cents === 0) return '$0/mo';
    const dollars = cents / 100;
    return dollars % 1 === 0 ? `$${dollars}/mo` : `$${dollars.toFixed(2)}/mo`;
  }

  function buildFeaturesFromLimits(limit) {
    const features = [];
    if (limit.max_sources) features.push(`${limit.max_sources} sources`);
    else features.push('Unlimited sources');
    if (limit.max_writers) features.push(`${limit.max_writers} writers`);
    else features.push('Unlimited writers');
    if (limit.max_credits_month) features.push(`${limit.max_credits_month.toLocaleString()} AI credits/mo`);
    else features.push('Unlimited AI credits');
    if (limit.custom_domain_enabled) features.push('Custom domain');
    if (limit.audio_enabled) features.push('Audio generation');
    return features;
  }

  function renderPlans() {
    const grid = document.getElementById('planGrid');
    const plans = [
      { id: 'free', name: 'Free', price: '$0/mo', badge: null, features: ['3 sources', '1 writer', '25 articles/mo'] },
      { id: 'starter', name: 'Starter', price: '$0/mo', badge: 'Popular', features: ['10 sources', '4 writers', '250 articles/mo'] },
      { id: 'pro', name: 'Pro', price: 'Coming soon', badge: null, features: ['50 sources', '20 writers', '2,000 articles/mo', 'Custom domain', 'Audio'] },
      { id: 'business', name: 'Business', price: 'Contact us', badge: null, features: ['Unlimited sources', 'Unlimited writers', 'Unlimited articles', 'Priority support'] },
    ];

    // Override with real plan limits if available
    for (const p of plans) {
      const limit = planLimits.find(l => l.plan === p.id);
      if (limit) {
        // Prefer Stripe product data when available
        if (limit.stripe) {
          if (limit.stripe.name) p.name = limit.stripe.name;
          if (limit.stripe.price_cents != null) p.price = formatPrice(limit.stripe.price_cents);
          else if (limit.price_cents !== undefined) p.price = formatPrice(limit.price_cents);
          if (limit.stripe.features && limit.stripe.features.length) {
            p.features = limit.stripe.features;
          } else {
            p.features = buildFeaturesFromLimits(limit);
          }
        } else {
          if (limit.price_cents !== undefined) p.price = formatPrice(limit.price_cents);
          p.features = buildFeaturesFromLimits(limit);
        }
      }
    }

    grid.innerHTML = plans.map(p => `
      <div class="plan-option${p.id === selectedPlan ? ' selected' : ''}" data-plan="${p.id}">
        ${p.badge ? `<div class="plan-badge">${p.badge}</div>` : ''}
        <div class="plan-name">${p.name}</div>
        <div class="plan-price">${p.price}</div>
        <ul class="plan-features">
          ${p.features.map(f => `<li>${f}</li>`).join('')}
        </ul>
      </div>
    `).join('');
  }

  function checkSlug(slug) {
    slugOk = false;
    document.getElementById('createBtn').disabled = true;
    clearTimeout(slugTimer);
    const status = document.getElementById('slugStatus');

    if (!slug || slug.length < 3) {
      status.innerHTML = slug ? '<span style="color:var(--danger);">At least 3 characters</span>' : '';
      return;
    }

    status.innerHTML = '<span style="color:var(--muted);">Checking...</span>';
    slugTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/tenants/check-slug?slug=' + encodeURIComponent(slug));
        const data = await res.json();
        if (data.available) {
          status.innerHTML = '<span style="color:var(--success);">&#10003; Available</span>';
          slugOk = true;
          document.getElementById('createBtn').disabled = false;
        } else {
          const span = document.createElement('span');
          span.style.color = 'var(--danger)';
          span.textContent = data.reason || 'Taken';
          status.innerHTML = '';
          status.appendChild(span);
        }
      } catch {
        status.innerHTML = '<span style="color:var(--danger);">Could not check</span>';
      }
    }, 400);
  }

  async function createTenant() {
    if (!slugOk || !userToken) return;
    const name = document.getElementById('siteName').value.trim();
    const slug = document.getElementById('siteSlug').value.trim();
    if (!name) { showError('Enter a site name'); return; }

    const btn = document.getElementById('createBtn');
    btn.disabled = true;
    btn.innerHTML = 'Creating...';
    clearError();

    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userToken },
        body: JSON.stringify({ slug, display_name: name, plan: selectedPlan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create site');

      clearSignupState();
      setToken(data.token);
      localStorage.setItem('deepfeedai_user', name);
      localStorage.setItem('deepfeedai_tenant', data.tenant.slug);

      // Paid plans require Stripe checkout before activation
      if (data.requires_payment) {
        btn.innerHTML = 'Redirecting to payment...';
        // Save user token so checkout-success page can poll status
        sessionStorage.setItem('deepfeedai_user_token', userToken);
        const checkoutRes = await fetch('/api/tenants/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userToken },
          body: JSON.stringify({ tenantId: data.tenant.id }),
        });
        const checkoutData = await checkoutRes.json();
        if (!checkoutRes.ok) throw new Error(checkoutData.error || 'Failed to start checkout');
        window.location.href = checkoutData.checkout_url;
        return;
      }

      window.location.replace('/wizard.html');
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.innerHTML = 'Create Site &rarr;';
    }
  }
});
