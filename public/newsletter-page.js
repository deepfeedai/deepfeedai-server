/* Deep Feed AI Admin — Newsletter page */
(function () {
  'use strict';

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function relTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2)  return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days === 1 ? 'yesterday' : days + 'd ago';
  }

  /* ── Preview ─────────────────────────────────────────────── */
  async function loadPreview() {
    const placeholder = document.getElementById('previewPlaceholder');
    const frame       = document.getElementById('previewFrame');
    const refreshBtn  = document.getElementById('refreshPreviewBtn');

    placeholder.innerHTML = '<div class="big-icon">⏳</div><div>Loading preview…</div>';
    placeholder.style.display = 'flex';
    frame.style.display = 'none';

    try {
      const token = localStorage.getItem('deepfeedai_token');
      const res   = await fetch('/api/newsletter/send?preview=true', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await res.text());
      const html = await res.text();

      frame.srcdoc = html;
      frame.style.display = 'block';
      placeholder.style.display = 'none';
      refreshBtn.style.display = 'inline-block';
    } catch (err) {
      placeholder.innerHTML = `<div class="big-icon">❌</div><div>Preview failed: ${escHtml(err.message)}</div>`;
    }
  }

  /* ── Send ────────────────────────────────────────────────── */
  async function sendNewsletter() {
    const sendBtn     = document.getElementById('sendBtn');
    const statusEl    = document.getElementById('sendStatus');
    const subjectVal  = document.getElementById('subjectInput').value.trim();

    if (!confirm('Send the newsletter to your entire Resend audience now?')) return;

    sendBtn.disabled  = true;
    sendBtn.textContent = '⏳ Sending…';
    statusEl.innerHTML = '';

    try {
      const body = subjectVal ? { subject: subjectVal } : {};
      const data = await apiFetch('/newsletter/send', { method: 'POST', body: JSON.stringify(body) });
      statusEl.innerHTML = `<div class="alert alert-success">✅ Sent! Broadcast ID: <code>${escHtml(data.broadcastId)}</code> — ${data.articleCount} articles</div>`;
      loadHistory();
    } catch (err) {
      statusEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = '🚀 Send Now';
    }
  }

  /* ── History ─────────────────────────────────────────────── */
  async function loadHistory() {
    const tbody = document.getElementById('historyTbody');
    try {
      const rows = await apiFetch('/newsletter/history');
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-muted text-center" style="padding:24px;">No sends yet</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td title="${escHtml(new Date(r.sent_at).toLocaleString())}">
            ${relTime(r.sent_at)}<br><span class="text-muted text-sm">${new Date(r.sent_at).toLocaleDateString()}</span>
          </td>
          <td>${escHtml(r.subject || '—')}</td>
          <td>${r.article_count ?? '—'}</td>
          <td><code class="text-sm">${escHtml(r.broadcast_id || '—')}</code></td>
          <td><span class="history-dot"></span>${escHtml(r.status)}</td>
        </tr>`).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-muted text-center">Failed to load history: ${escHtml(err.message)}</td></tr>`;
    }
  }

  /* ── Init ────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    if (!requireAuth()) return;
    renderSidebar();
    document.getElementById('previewBtn')?.addEventListener('click', loadPreview);
    document.getElementById('refreshPreviewBtn')?.addEventListener('click', loadPreview);
    document.getElementById('sendBtn')?.addEventListener('click', sendNewsletter);
    loadHistory();
  });
})();
