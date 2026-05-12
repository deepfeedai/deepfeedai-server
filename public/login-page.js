/* ===== DeepFeedAI Admin — Login Page =====
 *
 * Unified login flow for all admin panel users:
 *   1. Email/password → public user JWT → tenant-admin JWT (primary)
 *   2. Google/GitHub OAuth → public user JWT → tenant-admin JWT
 *   3. Username/password → admin JWT (legacy, hidden behind "Admin login" link)
 */

onReady(async () => {
  if (isLoggedIn()) {
    window.location.replace('/classic.html');
    return;
  }

  const googleBtn      = document.getElementById('googleBtn');
  const errEl          = document.getElementById('loginError');
  const emailSection   = document.getElementById('emailLoginSection');
  const localSection   = document.getElementById('localLoginSection');
  const oauthSection   = document.getElementById('oauthSection');
  const authDivider    = document.getElementById('authDivider');
  const emailLoginError = document.getElementById('emailLoginError');
  const localLoginError = document.getElementById('localLoginError');
  const adminToggle    = document.getElementById('adminLoginToggle');
  const adminLink      = document.getElementById('adminLoginLink');

  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const error  = params.get('error');

  if (error === 'unauthorized') {
    showLoginError('Your account is not authorized. Create a site first.');
  } else if (error) {
    showLoginError('Sign-in failed. Please try again.');
  }

  if (code) {
    await exchangeCode(code);
  }

  // Show divider between email form and OAuth
  authDivider.style.display = '';

  // Detect available auth methods and deployment mode
  let hasLocal = false;
  let isSingleTenant = false;
  try {
    const [authRes, infoRes] = await Promise.all([
      fetch('/api/auth/methods'),
      fetch('/api/instance-info'),
    ]);
    if (authRes.ok) {
      const methods = await authRes.json();
      hasLocal = methods.local === true;
      const hasGoogle = methods.google === true;

      if (!hasGoogle) {
        googleBtn.style.display = 'none';
        oauthSection.style.display = 'none';
        authDivider.style.display = 'none';
      }
    }
    if (infoRes.ok) {
      const info = await infoRes.json();
      isSingleTenant = info.mode === 'single';
    }
  } catch (_) { /* fall back to defaults */ }

  // Single-tenant: show direct admin login by default, hide email/tenant flow
  if (isSingleTenant && hasLocal) {
    emailSection.style.display = 'none';
    localSection.style.display = '';
    oauthSection.style.display = 'none';
    authDivider.style.display = 'none';
    adminToggle.style.display = 'none';
    var signupLink = document.getElementById('signupLink');
    if (signupLink) signupLink.style.display = 'none';
  } else {
    // Multi-tenant: show "Admin login" toggle when local auth is available
    if (hasLocal) adminToggle.style.display = '';
  }

  // Toggle between email login and legacy admin login
  adminLink.addEventListener('click', (e) => {
    e.preventDefault();
    const showingAdmin = localSection.style.display !== 'none';
    if (showingAdmin) {
      // Switch back to email login
      localSection.style.display = 'none';
      emailSection.style.display = '';
      adminLink.textContent = 'Admin login';
    } else {
      // Switch to legacy admin login
      emailSection.style.display = 'none';
      localSection.style.display = '';
      adminLink.textContent = 'Email login';
    }
  });

  // ── OAuth ──
  googleBtn.addEventListener('click', () => {
    window.location.href = '/api/user-auth/google?return_to=login';
  });

  // ── Email/password login ──
  const emailLoginBtn = document.getElementById('emailLoginBtn');
  emailLoginBtn.addEventListener('click', doEmailLogin);

  document.getElementById('loginEmailPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doEmailLogin();
  });
  document.getElementById('loginEmail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginEmailPassword').focus();
  });

  async function doEmailLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginEmailPassword').value;
    if (!email || !password) {
      showEmailError('Please enter email and password');
      return;
    }
    try {
      emailLoginBtn.disabled = true;
      emailLoginBtn.textContent = 'Signing in\u2026';
      hideEmailError();

      // Step 1: Authenticate as public user
      const res = await fetch('/api/user-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.status === 429) throw new Error('Too many login attempts. Please try again later.');
      if (!res.ok) throw new Error(data.error || 'Login failed');

      // Step 2: Exchange public user JWT for tenant-admin JWT
      const loginRes = await fetch('/api/tenants/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + data.token,
        },
      });
      const loginData = await loginRes.json();

      if (loginRes.status === 404 && loginData.signup) {
        sessionStorage.setItem('signup_token', data.token);
        window.location.href = '/signup.html';
        return;
      }
      if (!loginRes.ok) throw new Error(loginData.error || 'No site found for this account');

      localStorage.setItem('deepfeedai_token', loginData.token);
      window.location.replace('/classic.html');
    } catch (err) {
      showEmailError(err.message);
      emailLoginBtn.disabled = false;
      emailLoginBtn.textContent = 'Sign In';
    }
  }

  // ── Legacy admin login ──
  const localLoginBtn = document.getElementById('localLoginBtn');
  localLoginBtn.addEventListener('click', doLocalLogin);

  document.getElementById('loginPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLocalLogin();
  });

  async function doLocalLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!username || !password) {
      showLocalError('Please enter username and password');
      return;
    }
    try {
      localLoginBtn.disabled = true;
      localLoginBtn.textContent = 'Signing in\u2026';
      hideLocalError();

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (res.status === 429) throw new Error('Too many login attempts. Please try again later.');
      if (!res.ok) throw new Error(data.error || 'Login failed');

      localStorage.setItem('deepfeedai_token', data.token);
      window.location.href = '/classic.html';
    } catch (err) {
      showLocalError(err.message);
      localLoginBtn.disabled = false;
      localLoginBtn.textContent = 'Sign In';
    }
  }

  // ── Helpers ──
  function showEmailError(msg) {
    emailLoginError.textContent = msg;
    emailLoginError.style.display = 'block';
  }
  function hideEmailError() {
    emailLoginError.style.display = 'none';
  }
  function showLocalError(msg) {
    localLoginError.textContent = msg;
    localLoginError.style.display = 'block';
  }
  function hideLocalError() {
    localLoginError.style.display = 'none';
  }
  function showLoginError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  async function exchangeCode(oauthCode) {
    googleBtn.disabled = true;
    googleBtn.innerHTML = '<span class="spinner"></span> Signing in\u2026';
    try {
      const tokenRes = await fetch('/api/user-auth/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code: oauthCode }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokenData.error || 'Code exchange failed');

      const loginRes = await fetch('/api/tenants/login', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + tokenData.token,
        },
      });
      const loginData = await loginRes.json();

      if (loginRes.status === 404 && loginData.signup) {
        window.location.href = '/signup.html?token=' + encodeURIComponent(tokenData.token);
        return;
      }
      if (!loginRes.ok) throw new Error(loginData.error || 'Tenant login failed');

      localStorage.setItem('deepfeedai_token', loginData.token);
      window.location.replace('/classic.html');
    } catch (err) {
      showLoginError(err.message);
      googleBtn.disabled = false;
      googleBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M17.64 9.2045c0-.6382-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z" fill="#000"/><path d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8055.54-1.8354.859-3.0477.859-2.344 0-4.328-1.584-5.036-3.7104H.957v2.3318C2.4382 15.9832 5.4818 18 9 18z" fill="#000"/><path d="M3.964 10.71C3.7836 10.17 3.6818 9.5945 3.6818 9s.1018-1.17.2822-1.71V4.9582H.957A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.957 4.0418L3.964 10.71z" fill="#000"/><path d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.957 4.9582L3.964 7.29C4.672 5.1636 6.656 3.5795 9 3.5795z" fill="#000"/></svg> Sign in with Google`;
    }
  }
});
