onReady(() => {
    // Redirect if already logged in
    requireGuest();

    const form     = document.getElementById('loginForm');
    const errEl    = document.getElementById('loginError');
    const signInBtn = document.getElementById('signInBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.style.display = 'none';
      signInBtn.disabled = true;
      signInBtn.innerHTML = '<span class="spinner"></span> Signing in…';

      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;

      try {
        const data = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });

        const json = await data.json();

        if (!data.ok) {
          throw new Error(json.error || 'Login failed');
        }

        setToken(json.token);
        localStorage.setItem('deepfeedai_user', json.username);
        window.location.href = '/index.html';
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        signInBtn.disabled = false;
        signInBtn.textContent = 'Sign In';
      }
    });
  });