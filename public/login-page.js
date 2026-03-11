/* ===== DeepFeedAI Admin — Login Page ===== */

onReady(async () => {
  requireGuest();

  const btn   = document.getElementById('googleBtn');
  const errEl = document.getElementById('loginError');

  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const error  = params.get('error');

  // Handle errors redirected back from OAuth callback
  if (error === 'unauthorized') {
    showLoginError('Your Google account is not authorised to access the admin panel.');
  } else if (error) {
    showLoginError('Sign-in failed. Please try again.');
  }

  // Exchange one-time code for admin JWT if redirected back from OAuth
  if (code) {
    await exchangeCode(code);
  }

  btn.addEventListener('click', () => {
    window.location.href = '/api/auth/google';
  });

  function showLoginError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  async function exchangeCode(oauthCode) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';
    try {
      const res  = await fetch('/api/auth/code', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code: oauthCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Code exchange failed');

      setToken(data.token);
      localStorage.setItem('deepfeedai_user', data.displayName || data.email);
      window.location.replace('/index.html');
    } catch (err) {
      showLoginError(err.message);
      btn.disabled = false;
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M17.64 9.2045c0-.6382-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z" fill="#000"/><path d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8055.54-1.8354.859-3.0477.859-2.344 0-4.328-1.584-5.036-3.7104H.957v2.3318C2.4382 15.9832 5.4818 18 9 18z" fill="#000"/><path d="M3.964 10.71C3.7836 10.17 3.6818 9.5945 3.6818 9s.1018-1.17.2822-1.71V4.9582H.957A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.957 4.0418L3.964 10.71z" fill="#000"/><path d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.957 4.9582L3.964 7.29C4.672 5.1636 6.656 3.5795 9 3.5795z" fill="#000"/></svg> Sign in with Google`;
    }
  }
});
