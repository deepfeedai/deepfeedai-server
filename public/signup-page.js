/* ===== DeepFeedAI — Signup Page (Redesigned) ===== */

onReady(async () => {
  const errEl = document.getElementById('signupError');

  let currentStep = 1;
  let userToken = null;
  let selectedPlan = 'free';
  let slugOk = false;
  let slugTimer = null;
  let planLimits = [];

  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');

  if (error) showError(error === 'unauthorized' ? 'OAuth error. Please try again.' : 'Sign-in failed.');
  if (params.get('cancelled') === 'true') showError('Payment was cancelled. You can choose a different plan or try again.');
  if (code) await exchangeOAuthCode(code);

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
      await checkExistingTenant();
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  });

  // ── Email login link (for users who already have an account) ──
  document.getElementById('regEmail')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('registerBtn').click();
  });
  document.getElementById('regPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('registerBtn').click();
  });

  // ── Navigation ──
  document.getElementById('backToStep1').addEventListener('click', () => goToStep(1));
  document.getElementById('backToStep2').addEventListener('click', () => goToStep(2));
  document.getElementById('toStep3').addEventListener('click', () => goToStep(3));
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

    if (step === 3) document.getElementById('siteName').focus();
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
      await checkExistingTenant();
    } catch (err) {
      showError(err.message);
    }
  }

  async function checkExistingTenant() {
    try {
      const loginRes = await fetch('/api/tenants/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userToken },
      });
      if (loginRes.ok) {
        const loginData = await loginRes.json();
        setToken(loginData.token);
        localStorage.setItem('deepfeedai_user', loginData.tenant.display_name);
        localStorage.setItem('deepfeedai_tenant', loginData.tenant.slug);
        window.location.replace('/index.html');
        return;
      }
    } catch { /* no existing tenant */ }
    goToStep(2);
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
          status.innerHTML = '<span style="color:var(--danger);">' + (data.reason || 'Taken') + '</span>';
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
