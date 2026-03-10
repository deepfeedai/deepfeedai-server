onReady(async () => {
    if (!requireAuth()) return;
    initSidebar();
    initLogout();

    const user = localStorage.getItem('deepfeedai_user');
    if (user) document.getElementById('topbarUser').textContent = `👤 ${user}`;

    try {
      const [articles, sources] = await Promise.all([
        apiFetch('/articles'),
        apiFetch('/sources'),
      ]);

      document.getElementById('statTotal').textContent     = articles.length;
      document.getElementById('statPublished').textContent = articles.filter(a => a.is_published).length;
      document.getElementById('statFeatured').textContent  = articles.filter(a => a.is_featured).length;
      document.getElementById('statSources').textContent   = sources.filter(s => s.is_active).length;

      const recent = articles.slice(0, 10);
      const tbody  = document.getElementById('recentBody');

      if (recent.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5">
          <div class="empty-state"><div class="empty-icon">📭</div><p>No articles yet</p></div>
        </td></tr>`;
      } else {
        tbody.innerHTML = recent.map(a => `
          <tr>
            <td class="td-title" title="${escHtml(a.title)}">${escHtml(a.title)}</td>
            <td><span class="badge badge-muted">${escHtml(a.category || '—')}</span></td>
            <td>${badgePublished(a.is_published)}</td>
            <td>${badgeFeatured(a.is_featured)}</td>
            <td style="color:var(--muted);font-size:12px;">${fmtDate(a.created_at)}</td>
          </tr>
        `).join('');
      }
    } catch (err) {
      showAlert('Failed to load dashboard data: ' + err.message, 'error');
    }
  });

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }