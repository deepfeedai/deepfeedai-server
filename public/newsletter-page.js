/* Deep Feed AI Admin — Newsletter page (v1.1.0) */
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
    return Math.floor(hrs / 24) + 'd ago';
  }

  // ── State ──────────────────────────────────────────────────────
  let currentFormat    = 'daily';
  let candidates       = [];      // full pool from /candidates
  let orderedIds       = [];      // current ordered+checked selection
  let checkedIds       = new Set();
  let currentDraft     = null;
  let savePending      = false;
  let countdownTimer   = null;
  let dragSrcIdx       = null;

  // ── DOM refs ───────────────────────────────────────────────────
  const el = id => document.getElementById(id);

  // ── Format toggle ──────────────────────────────────────────────
  function initFormatToggle() {
    document.querySelectorAll('.nl-format-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nl-format-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFormat = btn.dataset.format;
        el('storyArcSection').style.display = currentFormat === 'weekly' ? 'block' : 'none';
        loadDraft();
        loadCandidates();
      });
    });
  }

  // ── Draft: load ────────────────────────────────────────────────
  async function loadDraft() {
    try {
      const draft = await apiFetch(`/newsletter/draft?format=${currentFormat}`);
      currentDraft = draft;

      if (draft) {
        el('subjectInput').value = draft.subject || '';
        el('introInput').value   = draft.intro || '';
        if (el('storyArcInput')) el('storyArcInput').value = draft.story_arc || '';
        if (el('audienceSelect')) el('audienceSelect').value = draft.audience || 'all';
        if (draft.article_ids && Array.isArray(draft.article_ids)) {
          orderedIds = draft.article_ids.map(Number);
          checkedIds = new Set(orderedIds);
        }
        // Restore briefing_content if it exists on the draft
        if (draft.briefing_content && el('briefingStatus')) {
          const bc = draft.briefing_content;
          el('briefingStatus').textContent = `✓ Briefing ready — ${(bc.storyAnalyses || []).length} stories analysed. Preview to see the full report.`;
          if (el('generateBriefingBtn')) el('generateBriefingBtn').textContent = '✨ Regenerate Briefing';
        }
        renderBanner(draft);
      } else {
        renderBanner(null);
      }
    } catch (_) {
      renderBanner(null);
    }
  }

  // ── Draft: save ────────────────────────────────────────────────
  async function saveDraft(silent = false) {
    const ids     = getSelectedIds();
    const saveBtn = el('saveDraftBtn');
    if (!silent && saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '💾 Saving…'; }
    try {
      const draftBody = {
        article_ids: ids,
        subject:     el('subjectInput').value.trim() || null,
        intro:       el('introInput').value.trim() || null,
        format:      currentFormat,
        audience:    el('audienceSelect')?.value || 'all',
      };
      if (currentFormat === 'weekly') {
        draftBody.story_arc = el('storyArcInput')?.value.trim() || null;
      }
      const draft = await apiFetch('/newsletter/draft', {
        method: 'POST',
        body: JSON.stringify(draftBody),
      });
      currentDraft = draft;
      if (!silent) {
        el('nlSaveIndicator').textContent = '';
        if (saveBtn) {
          saveBtn.textContent = '✓ Saved';
          setTimeout(() => { saveBtn.textContent = '💾 Save Draft'; }, 2000);
        }
      }
      renderBanner(draft);
    } catch (err) {
      if (!silent) {
        el('nlSaveIndicator').textContent = 'Save failed';
        alert('Save failed: ' + escHtml(err.message));
      }
    } finally {
      if (!silent && saveBtn) saveBtn.disabled = false;
    }
  }

  // ── Draft: skip ────────────────────────────────────────────────
  async function skipToday() {
    if (!confirm(`Skip today's ${currentFormat} newsletter? It will not auto-send.`)) return;
    try {
      await apiFetch('/newsletter/draft', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'skipped', format: currentFormat }),
      });
      currentDraft = null;
      renderBanner(null);
      el('nlDraftBanner').style.display = 'none';
    } catch (err) {
      alert('Could not skip: ' + escHtml(err.message));
    }
  }

  // ── Countdown banner ───────────────────────────────────────────
  function renderBanner(draft) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

    const banner   = el('nlDraftBanner');
    const badge    = el('nlDraftBadge');
    const countdown = el('nlCountdown');

    if (!draft || draft.status !== 'pending') {
      banner.style.display = 'none';
      return;
    }

    banner.style.display = 'flex';

    // Auto-send at 7:30 AM in the user's local time (server enforces newsroom tz)
    const now       = new Date();
    const autoSend  = new Date(now);
    autoSend.setHours(7, 30, 0, 0);
    if (autoSend <= now) autoSend.setDate(autoSend.getDate() + 1); // tomorrow if past

    function tick() {
      const msLeft = autoSend - Date.now();
      if (msLeft <= 0) {
        clearInterval(countdownTimer);
        countdown.textContent = 'Auto-sending now…';
        badge.textContent = 'Sending';
        return;
      }
      const mins = Math.floor(msLeft / 60000);
      const secs = Math.floor((msLeft % 60000) / 1000);
      const isSoon = mins < 15;
      badge.textContent = isSoon ? 'Sending soon' : 'Draft Ready';
      badge.className   = 'nl-draft-badge' + (isSoon ? ' auto-send-soon' : '');
      countdown.innerHTML = `Auto-sends in <strong>${mins}m ${secs}s</strong> unless you send or skip`;
    }

    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  // ── Candidates: load ───────────────────────────────────────────
  async function loadCandidates() {
    el('articlePickerList').innerHTML = '<div class="nl-picker-empty">Loading…</div>';
    el('candidateCount').textContent = 'Loading…';
    try {
      candidates = await apiFetch('/newsletter/candidates');
      el('candidateCount').textContent = `${candidates.length} article${candidates.length !== 1 ? 's' : ''}`;
      renderPicker();
    } catch (err) {
      el('articlePickerList').innerHTML = `<div class="nl-picker-empty">Failed to load: ${escHtml(err.message)}</div>`;
    }
  }

  // ── Picker: render ─────────────────────────────────────────────
  function renderPicker() {
    const list = el('articlePickerList');
    if (!candidates.length) {
      list.innerHTML = '<div class="nl-picker-empty">No articles in the last 48 hours. Newsletter will auto-fetch recent articles.</div>';
      updateSelectedCount();
      return;
    }

    // Build ordered display: checked+ordered first (in drag order), then unchecked candidates
    const checkedOrdered = orderedIds.filter(id => candidates.find(c => c.id === id));
    const unchecked      = candidates.filter(c => !checkedIds.has(c.id));
    const displayOrder   = [
      ...checkedOrdered.map(id => candidates.find(c => c.id === id)).filter(Boolean),
      ...unchecked,
    ];

    list.innerHTML = '';
    displayOrder.forEach((article, idx) => {
      const isChecked = checkedIds.has(article.id);
      const row = document.createElement('div');
      row.className = 'nl-article-row';
      row.dataset.id  = article.id;
      row.dataset.idx = idx;
      row.draggable   = true;

      const tierLabel = article.tier && article.tier !== 'standard'
        ? `<span class="nl-tier-badge nl-tier-${escHtml(article.tier)}">${escHtml(article.tier)}</span>`
        : '';
      const date = article.publishedAt
        ? new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';

      row.innerHTML = `
        <span class="nl-drag-handle" title="Drag to reorder">⠿</span>
        <input type="checkbox" class="nl-article-check" ${isChecked ? 'checked' : ''}
          aria-label="Include ${escHtml(article.title)}" />
        <div class="nl-article-meta">
          <div class="nl-article-title">${escHtml(article.title)}</div>
          <div class="nl-article-sub">
            ${tierLabel}
            <span>${escHtml(article.category || '')}</span>
            <span>${escHtml(date)}</span>
            ${article.contentType === 'deep-dive' ? '<span>Deep Dive</span>' : ''}
          </div>
        </div>`;

      // Checkbox toggle
      row.querySelector('.nl-article-check').addEventListener('change', e => {
        if (e.target.checked) {
          checkedIds.add(article.id);
          if (!orderedIds.includes(article.id)) orderedIds.push(article.id);
        } else {
          checkedIds.delete(article.id);
          orderedIds = orderedIds.filter(id => id !== article.id);
        }
        updateSelectedCount();
        autoSaveDraft();
      });

      // Drag events (only for checked articles — unchecked don't reorder)
      row.addEventListener('dragstart', e => {
        dragSrcIdx = idx;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        list.querySelectorAll('.nl-article-row').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.nl-article-row').forEach(r => r.classList.remove('drag-over'));
        row.classList.add('drag-over');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drag-over');
        if (dragSrcIdx === null || dragSrcIdx === idx) return;

        const allRows  = [...list.querySelectorAll('.nl-article-row')];
        const srcId    = parseInt(allRows[dragSrcIdx]?.dataset.id);
        const destId   = parseInt(allRows[idx]?.dataset.id);
        if (!srcId || !destId || srcId === destId) return;

        // Reorder in orderedIds
        const srcPos  = orderedIds.indexOf(srcId);
        const destPos = orderedIds.indexOf(destId);
        if (srcPos !== -1 && destPos !== -1) {
          orderedIds.splice(srcPos, 1);
          orderedIds.splice(destPos, 0, srcId);
        } else if (srcPos !== -1) {
          orderedIds.splice(srcPos, 1);
          orderedIds.push(srcId);
        }

        dragSrcIdx = null;
        renderPicker();
        autoSaveDraft();
      });

      list.appendChild(row);
    });

    updateSelectedCount();
  }

  function updateSelectedCount() {
    const n = checkedIds.size;
    el('selectedCount').textContent = `(${n} selected)`;
  }

  function getSelectedIds() {
    return orderedIds.filter(id => checkedIds.has(id));
  }

  // Debounced auto-save after user changes selection
  let _autoSaveTimer = null;
  function autoSaveDraft() {
    clearTimeout(_autoSaveTimer);
    el('nlSaveIndicator').textContent = 'Saving…';
    _autoSaveTimer = setTimeout(() => saveDraft(true), 1200);
  }

  // ── AI suggestions ─────────────────────────────────────────────
  async function suggestIntro() {
    const ids = getSelectedIds();
    if (!ids.length) { alert('Select at least one article first.'); return; }
    const btn = el('suggestIntroBtn');
    btn.disabled = true; btn.textContent = '…';
    try {
      const { intro } = await apiFetch('/newsletter/draft/suggest-intro', {
        method: 'POST',
        body: JSON.stringify({ article_ids: ids }),
      });
      el('introInput').value = intro;
      autoSaveDraft();
    } catch (err) {
      alert('Intro suggestion failed: ' + escHtml(err.message));
    } finally {
      btn.disabled = false; btn.textContent = '✨';
    }
  }

  async function suggestSubject() {
    const ids = getSelectedIds();
    if (!ids.length) { alert('Select at least one article first.'); return; }
    const btn = el('suggestSubjectBtn');
    btn.disabled = true; btn.textContent = '…';
    try {
      const { subject } = await apiFetch('/newsletter/draft/suggest-subject', {
        method: 'POST',
        body: JSON.stringify({ article_ids: ids }),
      });
      el('subjectInput').value = subject;
      autoSaveDraft();
    } catch (err) {
      alert('Subject suggestion failed: ' + escHtml(err.message));
    } finally {
      btn.disabled = false; btn.textContent = '✨';
    }
  }

  async function suggestArc() {
    const ids = getSelectedIds();
    if (!ids.length) { alert('Select the articles that belong to this story arc first.'); return; }
    const btn = el('suggestArcBtn');
    btn.disabled = true; btn.textContent = '…';
    try {
      const { storyArc } = await apiFetch('/newsletter/draft/suggest-story-arc', {
        method: 'POST',
        body: JSON.stringify({ article_ids: ids }),
      });
      el('storyArcInput').value = storyArc;
    } catch (err) {
      alert('Story Arc suggestion failed: ' + escHtml(err.message));
    } finally {
      btn.disabled = false; btn.textContent = '✨';
    }
  }

  // ── Preview ────────────────────────────────────────────────────
  async function loadPreview() {
    const placeholder = el('previewPlaceholder');
    const frame       = el('previewFrame');
    const refreshBtn  = el('refreshPreviewBtn');

    placeholder.innerHTML = '<div class="big-icon">⏳</div><div>Rendering preview…</div>';
    placeholder.style.display = 'flex';
    frame.style.display = 'none';

    try {
      const token = localStorage.getItem('deepfeedai_token');
      const body  = {
        article_ids: getSelectedIds(),
        subject:     el('subjectInput').value.trim() || undefined,
        intro:       el('introInput').value.trim() || undefined,
        format:      currentFormat,
      };
      if (currentFormat === 'weekly') {
        body.story_arc = el('storyArcInput')?.value.trim() || undefined;
      }

      const res = await fetch('/api/newsletter/send?preview=true', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      let html = await res.text();
      html = html.replace('<head>', '<head><base target="_blank">');
      frame.srcdoc = html;
      frame.style.display = 'block';
      placeholder.style.display = 'none';
      refreshBtn.style.display = 'inline-block';
    } catch (err) {
      placeholder.innerHTML = `<div class="big-icon">❌</div><div>Preview failed: ${escHtml(err.message)}</div>`;
    }
  }

  // ── WIR briefing generation ────────────────────────────────────
  async function generateBriefing() {
    const ids = getSelectedIds();
    if (!ids.length) { alert('Select at least one article first.'); return; }
    const btn    = el('generateBriefingBtn');
    const status = el('briefingStatus');
    btn.disabled = true;
    btn.textContent = '⏳ Generating…';
    status.textContent = 'Running analysis (this may take 30–60 seconds)…';
    try {
      const data = await apiFetch('/newsletter/draft/suggest-weekly-briefing', {
        method: 'POST',
        body: JSON.stringify({ article_ids: ids, draft_id: currentDraft?.id }),
      });
      const bc = data.briefing;
      status.textContent = `✓ Briefing generated — ${(bc.storyAnalyses || []).length} stories analysed, ${(bc.signals || []).length} signals. Preview to see the full report layout.`;
      btn.textContent = '✨ Regenerate Briefing';
      // Store on draft object so preview/send picks it up
      if (currentDraft) currentDraft.briefing_content = bc;
    } catch (err) {
      status.textContent = 'Error: ' + escHtml(err.message);
      btn.textContent = '✨ Generate Briefing';
    } finally {
      btn.disabled = false;
    }
  }

  // ── Send ───────────────────────────────────────────────────────
  async function sendNewsletter() {
    const ids      = getSelectedIds();
    const audience = el('audienceSelect')?.value || 'all';
    const audienceLabel = audience === 'paid' ? 'paid subscribers only' : 'all subscribers';
    const msg = ids.length
      ? `Send to ${audienceLabel} with ${ids.length} selected article${ids.length !== 1 ? 's' : ''}?`
      : `No articles selected — send will auto-fetch the latest 8 articles to ${audienceLabel}. Continue?`;
    if (!confirm(msg)) return;

    const sendBtn  = el('sendBtn');
    const statusEl = el('sendStatus');
    sendBtn.disabled    = true;
    sendBtn.textContent = '⏳ Sending…';
    statusEl.innerHTML  = '';

    try {
      const body = {
        article_ids: ids.length ? ids : undefined,
        subject:     el('subjectInput').value.trim() || undefined,
        intro:       el('introInput').value.trim() || undefined,
        format:      currentFormat,
        audience,
      };
      if (currentFormat === 'weekly') {
        body.story_arc = el('storyArcInput')?.value.trim() || undefined;
      }

      if (currentFormat === 'weekly' && currentDraft?.briefing_content) {
        body.briefing_content = currentDraft.briefing_content;
      }

      const data = await apiFetch('/newsletter/send', { method: 'POST', body: JSON.stringify(body) });
      const audDesc = data.audience === 'paid' ? ' (paid subscribers)' : '';
      statusEl.innerHTML = `<div class="alert alert-success">✅ Sent${audDesc}! Broadcast ID: <code>${escHtml(data.broadcastId)}</code> — ${data.articleCount} articles</div>`;
      currentDraft = null;
      renderBanner(null);
      el('nlDraftBanner').style.display = 'none';
      loadHistory();
    } catch (err) {
      statusEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
    } finally {
      sendBtn.disabled    = false;
      sendBtn.textContent = '🚀 Send Now';
    }
  }

  // ── History ────────────────────────────────────────────────────
  async function loadHistory() {
    const tbody = el('historyTbody');
    try {
      const rows = await apiFetch('/newsletter/history');
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center" style="padding:24px;">No sends yet</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => {
        const dotClass = r.status === 'skipped' ? 'history-dot skipped'
                       : r.trigger === 'cron'   ? 'history-dot auto'
                       : 'history-dot';
        const audBadge = r.audience === 'paid'
          ? '<span style="font-size:10px;font-weight:700;color:#a855f7;background:rgba(168,85,247,0.15);padding:1px 6px;border-radius:4px;">Paid</span>'
          : '<span style="font-size:10px;color:var(--text-muted);">All</span>';
        return `<tr>
          <td title="${escHtml(new Date(r.sent_at).toLocaleString())}">
            ${relTime(r.sent_at)}<br><span class="text-muted text-sm">${new Date(r.sent_at).toLocaleDateString()}</span>
          </td>
          <td>${escHtml(r.subject || '—')}</td>
          <td>${r.article_count ?? '—'}</td>
          <td>${audBadge}</td>
          <td><code class="text-sm">${escHtml(r.broadcast_id || '—')}</code></td>
          <td><span class="${dotClass}"></span>${escHtml(r.status)}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-muted text-center">Failed to load: ${escHtml(err.message)}</td></tr>`;
    }
  }

  // ── Feature gate ───────────────────────────────────────────────
  async function applyFeatureGate() {
    await loadAdminFeatures();
    if (!isFeatureOn('newsletter')) {
      const mainContent = document.querySelector('.main-content');
      if (mainContent) mainContent.insertAdjacentHTML('afterbegin', featureGateBanner('Newsletter'));
      el('sendBtn').disabled = true;
      el('sendBtn').classList.add('feature-locked');
      el('sendBtn').title = 'Newsletter is not available on your current plan';
      el('saveDraftBtn').disabled = true;
    }
  }

  // ── Paid tier setup wizard ─────────────────────────────────────
  let _paidConfig = null;

  function _wizardStep(n) {
    document.querySelectorAll('.wizard-step').forEach((s, i) => {
      s.classList.toggle('active', i + 1 === n);
      s.classList.toggle('done', i + 1 < n);
    });
    document.querySelectorAll('.wizard-panel').forEach((p, i) => {
      p.style.display = (i + 1 === n) ? '' : 'none';
    });
  }

  async function initPaidSetupWizard() {
    try {
      _paidConfig = await apiFetch('/newsletter/paid-config');
    } catch { return; }

    if (_paidConfig.isConfigured) {
      el('paidConfigSummary').style.display = '';
      _renderPaidEnabledToggle(_paidConfig.enabled !== false);
      el('paidConfigDetails').textContent =
        `Price ID: ${_paidConfig.priceId || '—'} · Audience: ${_paidConfig.resendAudienceId || '—'}`;
      el('editPriceId').value          = _paidConfig.priceId || '';
      el('editResendAudienceId').value = _paidConfig.resendAudienceId || '';
      return;
    }

    el('paidSetupWizard').style.display = '';
    _wizardStep(1);

    // Step 1 — stripe check
    if (_paidConfig.stripeConnected) {
      el('stripeStatus').style.display = 'none';
      el('stripeConnectedState').style.display = '';
    } else {
      el('stripeStatus').style.display = 'none';
      el('stripeNotConfiguredState').style.display = '';
    }

    el('wizardStep1Next')?.addEventListener('click', () => _wizardStep(2));

    // Step 2 — price setup mode toggle
    el('priceAutoBtn')?.addEventListener('click', () => {
      el('priceAutoForm').style.display = '';
      el('pricePasteForm').style.display = 'none';
      el('priceAutoBtn').classList.add('active');
      el('pricePasteBtn').classList.remove('active');
    });
    el('pricePasteBtn')?.addEventListener('click', () => {
      el('pricePasteForm').style.display = '';
      el('priceAutoForm').style.display = 'none';
      el('pricePasteBtn').classList.add('active');
      el('priceAutoBtn').classList.remove('active');
    });

    el('createPriceBtn')?.addEventListener('click', async () => {
      const amount = el('priceAmount').value;
      if (!amount) { el('wizardStep2Status').textContent = 'Enter an amount in cents.'; return; }
      el('createPriceBtn').disabled = true;
      el('createPriceBtn').textContent = 'Creating…';
      el('wizardStep2Status').textContent = '';
      try {
        await apiFetch('/newsletter/paid-setup/create-price', {
          method: 'POST',
          body: JSON.stringify({
            displayName: el('priceDisplayName').value || 'Weekly Intelligence Report',
            amount:      Number(amount),
            currency:    el('priceCurrency').value,
            interval:    el('priceInterval').value,
          }),
        });
        _wizardStep(3);
      } catch (err) {
        el('wizardStep2Status').textContent = 'Error: ' + escHtml(err.message);
        el('createPriceBtn').disabled = false;
        el('createPriceBtn').textContent = 'Create product & price →';
      }
    });

    el('savePriceIdBtn')?.addEventListener('click', async () => {
      const priceId = el('pastedPriceId').value.trim();
      if (!priceId) { el('wizardStep2Status').textContent = 'Enter a Price ID.'; return; }
      el('savePriceIdBtn').disabled = true;
      el('wizardStep2Status').textContent = '';
      try {
        await apiFetch('/newsletter/paid-setup/save', {
          method: 'POST',
          body: JSON.stringify({ priceId }),
        });
        _wizardStep(3);
      } catch (err) {
        el('wizardStep2Status').textContent = 'Error: ' + escHtml(err.message);
        el('savePriceIdBtn').disabled = false;
      }
    });

    // Step 3 — Resend audience
    el('saveAudienceBtn')?.addEventListener('click', async () => {
      const audienceId = el('resendAudienceInput').value.trim();
      if (!audienceId) { el('wizardStep3Status').textContent = 'Enter a Resend Audience ID.'; return; }
      el('saveAudienceBtn').disabled = true;
      el('wizardStep3Status').textContent = '';
      try {
        await apiFetch('/newsletter/paid-setup/save', {
          method: 'POST',
          body: JSON.stringify({ resendAudienceId: audienceId }),
        });
        _wizardStep(4);
      } catch (err) {
        el('wizardStep3Status').textContent = 'Error: ' + escHtml(err.message);
        el('saveAudienceBtn').disabled = false;
      }
    });

    el('wizardDismissBtn')?.addEventListener('click', () => {
      el('paidSetupWizard').style.display = 'none';
    });
  }

  function _renderPaidEnabledToggle(enabled) {
    const toggle = el('paidEnabledToggle');
    const label  = el('paidEnabledLabel');
    if (!toggle) return;
    toggle.checked = enabled;
    if (label) label.textContent = enabled ? 'Visible to readers' : 'Hidden from readers';
  }

  function initPaidConfigEdit() {
    el('paidEnabledToggle')?.addEventListener('change', async function() {
      const enabled = this.checked;
      _renderPaidEnabledToggle(enabled);
      try {
        await apiFetch('/newsletter/paid-setup/save', {
          method: 'POST',
          body: JSON.stringify({ enabled }),
        });
      } catch (err) {
        // Revert on failure
        this.checked = !enabled;
        _renderPaidEnabledToggle(!enabled);
        alert('Failed to update: ' + escHtml(err.message));
      }
    });

    el('editPaidConfigBtn')?.addEventListener('click', () => {
      const form = el('paidConfigEditForm');
      form.style.display = form.style.display === 'none' ? '' : 'none';
    });
    el('savePaidConfigBtn')?.addEventListener('click', async () => {
      el('savePaidConfigBtn').disabled = true;
      el('paidConfigSaveStatus').textContent = 'Saving…';
      try {
        await apiFetch('/newsletter/paid-setup/save', {
          method: 'POST',
          body: JSON.stringify({
            priceId:         el('editPriceId').value.trim() || null,
            resendAudienceId: el('editResendAudienceId').value.trim() || null,
          }),
        });
        el('paidConfigSaveStatus').textContent = '✓ Saved';
        el('paidConfigDetails').textContent =
          `Price ID: ${el('editPriceId').value || '—'} · Audience: ${el('editResendAudienceId').value || '—'}`;
        setTimeout(() => { el('paidConfigSaveStatus').textContent = ''; }, 2500);
      } catch (err) {
        el('paidConfigSaveStatus').textContent = 'Error: ' + escHtml(err.message);
      } finally {
        el('savePaidConfigBtn').disabled = false;
      }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    if (!requireAuth()) return;
    renderSidebar();
    await applyFeatureGate();
    initFormatToggle();

    // Load draft and candidates in parallel
    await Promise.all([loadDraft(), loadCandidates()]);

    // Merge draft article_ids with candidates to seed ordered selection
    if (currentDraft?.article_ids?.length && candidates.length) {
      orderedIds = currentDraft.article_ids.map(Number);
      checkedIds = new Set(orderedIds);
      renderPicker();
    }

    // Wire up buttons
    el('previewBtn')?.addEventListener('click', loadPreview);
    el('refreshPreviewBtn')?.addEventListener('click', loadPreview);
    el('sendBtn')?.addEventListener('click', sendNewsletter);
    el('saveDraftBtn')?.addEventListener('click', () => saveDraft(false));
    el('skipTodayBtn')?.addEventListener('click', skipToday);
    el('suggestIntroBtn')?.addEventListener('click', suggestIntro);
    el('suggestSubjectBtn')?.addEventListener('click', suggestSubject);
    el('suggestArcBtn')?.addEventListener('click', suggestArc);
    el('generateBriefingBtn')?.addEventListener('click', generateBriefing);

    // Auto-save on subject/intro blur
    el('subjectInput')?.addEventListener('blur', () => saveDraft(true));
    el('introInput')?.addEventListener('blur', () => saveDraft(true));

    initPaidSetupWizard();
    initPaidConfigEdit();

    loadHistory();
    window.pageRefresh = function () { loadDraft(); loadCandidates(); loadHistory(); };
  });
})();
