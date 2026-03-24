/* Deep Feed AI Admin — AI Usage page */
(function () {
  'use strict';

  const PROVIDER_COLORS = {
    gemini:     '#4285F4',
    elevenlabs: '#8B5CF6',
    imagen:     '#F59E0B',
    resend:     '#10B981',
    newsapi:    '#6366F1',
    brave:      '#EF4444',
  };

  function fmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function shortDate(isoStr) {
    const d = new Date(isoStr);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function relTime(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  let currentRange = '30d';

  async function loadData() {
    if (!requireAuth()) return;

    try {
      const [data] = await Promise.all([
        apiFetch(`/ai-usage/summary?range=${currentRange}`),
        loadElevenLabs(),
      ]);
      render(data);
    } catch (err) {
      console.error('[ai-usage] load error:', err);
    }
  }

  async function loadElevenLabs() {
    try {
      const el = await apiFetch('/ai-usage/elevenlabs');
      if (!el || !el.configured) return;
      renderElevenLabs(el);
    } catch (err) {
      console.error('[ai-usage] elevenlabs error:', err);
    }
  }

  function renderElevenLabs(el) {
    document.getElementById('elCard').hidden = false;
    const pct = el.character_limit > 0
      ? Math.round((el.character_count / el.character_limit) * 1000) / 10
      : 0;

    document.getElementById('elTier').textContent =
      (el.tier || 'free') + (el.status && el.status !== 'active' ? ' (' + el.status + ')' : '');
    document.getElementById('elUsed').textContent =
      fmt(el.character_count) + ' / ' + fmt(el.character_limit) + ' characters';
    document.getElementById('elPct').textContent = pct + '% used';
    document.getElementById('elVoices').textContent =
      'Voices: ' + (el.voice_slots_used || 0) + ' / ' + (el.voice_limit || 0);

    if (el.next_reset_unix) {
      const resetDate = new Date(el.next_reset_unix * 1000);
      const daysLeft = Math.ceil((resetDate - Date.now()) / 86400000);
      document.getElementById('elReset').textContent =
        'Resets in ' + daysLeft + 'd (' + (resetDate.getMonth() + 1) + '/' + resetDate.getDate() + ')';
    }

    const safePct = Math.min(pct, 100);
    const fill = document.getElementById('elFill');
    fill.style.width = safePct + '%';
    fill.style.background = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#8B5CF6';
  }

  function render(data) {
    const t = data.totals || {};
    const b = data.budget || {};

    // Stat cards
    const totalCredits = parseInt(t.total_credits) || 0;
    document.getElementById('statCredits').textContent = fmt(totalCredits) + ' cr';
    document.getElementById('statCreditsDelta').textContent = 'this period';
    document.getElementById('statCalls').textContent = fmt(parseInt(t.api_calls) || 0);
    document.getElementById('statTokens').textContent = fmt(parseInt(t.total_tokens) || 0);
    document.getElementById('statSuccess').textContent = (parseFloat(t.success_rate) || 0) + '%';

    // Credit efficiency
    const eff = data.efficiency || {};
    document.getElementById('statCreditsPerArticle').textContent = fmt(eff.credits_per_article || 0) + ' cr';
    document.getElementById('statArticleCount').textContent = (eff.published_articles || 0) + ' articles published';

    const topArt = (eff.top_expensive_articles || [])[0];
    if (topArt) {
      document.getElementById('statTopArticleCredits').textContent = fmt(parseInt(topArt.credits) || 0) + ' cr';
      const title = topArt.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      document.getElementById('statTopArticleSlug').textContent = title;
      document.getElementById('statTopArticleSlug').title = title;
    } else {
      document.getElementById('statTopArticleCredits').textContent = '--';
      document.getElementById('statTopArticleSlug').textContent = 'no data';
    }

    // Monthly credits
    const creditsUsed = parseInt(b.credits_used_month) || 0;
    const creditsLimit = parseInt(b.credits_limit_month) || 0;
    const creditsPct = Math.min(b.credits_percent_used || 0, 100);
    const creditsRemaining = Math.max(0, creditsLimit - creditsUsed);

    document.getElementById('creditsUsed').textContent = fmt(creditsUsed) + ' used';
    document.getElementById('creditsLimit').textContent = fmt(creditsLimit) + ' limit';
    document.getElementById('creditsToday').textContent = 'Today: ' + fmt(parseInt(b.credits_used_today) || 0) + ' cr';
    document.getElementById('creditsRemaining').textContent = 'Remaining: ' + fmt(creditsRemaining) + ' cr';
    document.getElementById('creditsLabel').textContent = Math.round(creditsPct) + '% used this month';

    const fill = document.getElementById('creditsFill');
    fill.style.width = creditsPct + '%';
    fill.style.background = creditsPct >= 90 ? '#ef4444' : creditsPct >= 70 ? '#f59e0b' : '#22c55e';

    // Daily usage sparkline
    renderSparkline(data.by_day || []);

    // Provider bars
    renderBars('providerBars', data.by_provider || [], 'provider');

    // Operation bars
    renderBars('operationBars', data.by_operation || [], 'operation');

    // Errors
    renderErrors(data.recent_errors || []);
  }

  function renderSparkline(byDay) {
    const chart = document.getElementById('sparkChart');
    const labels = document.getElementById('sparkLabels');
    if (!byDay.length) {
      chart.innerHTML = '<div style="color:var(--text-muted);font-size:13px;align-self:center;">No data yet</div>';
      labels.innerHTML = '';
      return;
    }

    const days = parseInt(currentRange) || 30;
    const filled = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const match = byDay.find(r => r.day && r.day.slice(0, 10) === key);
      filled.push({ day: key, credits: match ? parseInt(match.credits) || 0 : 0 });
    }

    const max = Math.max(...filled.map(r => r.credits), 1);
    chart.innerHTML = filled.map(r => {
      const pct = Math.max(Math.round((r.credits / max) * 100), 2);
      return `<div class="spark-bar" style="height:${pct}%" title="${shortDate(r.day)}: ${fmt(r.credits)} cr"></div>`;
    }).join('');

    const mid = Math.floor(filled.length / 2);
    labels.innerHTML = `<span>${shortDate(filled[0].day)}</span><span>${shortDate(filled[mid].day)}</span><span>${shortDate(filled[filled.length - 1].day)}</span>`;
  }

  function renderBars(containerId, items, nameKey) {
    const container = document.getElementById(containerId);
    if (!items.length) {
      container.innerHTML = '<div class="text-muted text-sm">No data yet</div>';
      return;
    }

    const maxCredits = Math.max(...items.map(i => parseInt(i.credits) || 0), 1);
    container.innerHTML = items.map(item => {
      const credits = parseInt(item.credits) || 0;
      const pct = Math.round((credits / maxCredits) * 100);
      const name = item[nameKey] || 'unknown';
      const color = PROVIDER_COLORS[name] || '#4F8EF7';
      return `
        <div class="bar-row">
          <div class="bar-label">${escHtml(name)}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${color};"></div>
          </div>
          <div class="bar-value">${fmt(credits)} cr</div>
        </div>`;
    }).join('');
  }

  function renderErrors(errors) {
    const tbody = document.getElementById('errorsTbody');
    document.getElementById('errorCount').textContent = errors.length + ' recent';

    if (!errors.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center" style="padding:24px;">No errors</td></tr>';
      return;
    }

    tbody.innerHTML = errors.map(e => `
      <tr>
        <td style="white-space:nowrap;font-size:12px;">${relTime(e.created_at)}</td>
        <td><span class="badge">${escHtml(e.operation)}</span></td>
        <td style="font-size:12px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(e.error)}</td>
      </tr>
    `).join('');
  }

  // Range tab switching
  document.getElementById('rangeTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.range-tab');
    if (!tab) return;
    document.querySelectorAll('.range-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentRange = tab.dataset.range;
    loadData();
  });

  document.getElementById('refreshBtn').addEventListener('click', loadData);

  /* ── Promo & Credits ─────────────────────────────────────── */

  async function loadCreditsSection() {
    try {
      const promos = await apiFetch('/promo/active');
      const promoEl = document.getElementById('activePromos');
      if (promoEl && promos.redemptions?.length > 0) {
        promoEl.innerHTML = promos.redemptions.map(r =>
          `<div style="margin-bottom:4px;">✓ <strong>${escHtml(r.code)}</strong> — ${fmt(r.bonus_credits)} bonus credits${r.expires_at ? ' (expires ' + new Date(r.expires_at).toLocaleDateString() + ')' : ''}</div>`
        ).join('');
      } else if (promoEl) {
        promoEl.textContent = '';
      }

      const packsData = await apiFetch('/credits/packs');
      const packsEl = document.getElementById('creditPacks');
      if (packsEl && packsData.packs?.length > 0) {
        packsEl.innerHTML = `
          <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:#aaa;">Buy More Credits</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${packsData.packs.map(p => `
              <button class="btn btn-sm buy-pack-btn" data-id="${p.id}" style="display:flex;flex-direction:column;align-items:center;padding:8px 16px;line-height:1.4;">
                <span style="font-weight:600">${fmt(p.credits)} credits</span>
                <span style="font-size:11px;color:#888;">$${(p.price_cents / 100).toFixed(2)}</span>
              </button>
            `).join('')}
          </div>`;
        packsEl.querySelectorAll('.buy-pack-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Redirecting...';
            try {
              const res = await apiFetch('/credits/checkout', {
                method: 'POST',
                body: JSON.stringify({ packId: parseInt(btn.dataset.id) }),
              });
              if (res.checkout_url) window.location.href = res.checkout_url;
            } catch (err) {
              showAlert(err.message, 'error');
              btn.disabled = false;
            }
          });
        });
      }

      const params = new URLSearchParams(location.search);
      if (params.get('credits') === 'purchased') {
        showAlert('Credits purchased successfully!', 'success');
        history.replaceState({}, '', location.pathname);
      } else if (params.get('credits') === 'cancelled') {
        showAlert('Credit purchase cancelled', 'error');
        history.replaceState({}, '', location.pathname);
      }
    } catch {
      // Credits section is optional
    }
  }

  document.getElementById('redeemPromoBtn')?.addEventListener('click', async () => {
    const input = document.getElementById('promoCodeInput');
    const code = input?.value?.trim();
    if (!code) return;
    try {
      const res = await apiFetch('/promo/redeem', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      showAlert(`Redeemed! +${fmt(res.bonus_credits)} bonus credits`, 'success');
      input.value = '';
      await loadCreditsSection();
      await loadData(); // refresh credit gauges
    } catch (err) {
      showAlert(err.message, 'error');
    }
  });

  // Init
  renderSidebar();
  loadData();
  loadCreditsSection();
})();
