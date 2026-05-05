/**
 * Newsroom — The Floor workspace
 * Shows today's editorial budget, live activity feed, pending pitch queue,
 * and the editorial review queue.
 *
 * APIs consumed:
 *   GET  /api/admin/budget/today
 *   POST /api/admin/budget/generate
 *   PATCH /api/admin/budget/:id          { status: 'published' }
 *   POST /api/admin/budget/slots/:id/approve
 *   POST /api/admin/budget/slots/:id/reject
 *   PATCH /api/admin/budget/slots/:id    { headline_suggestion: string }
 *   GET  /api/newsroom-feed?days=1&limit=40
 *   GET  /api/admin/pitches?status=proposed&limit=12
 *   GET  /api/admin/pitches?limit=15      (all)
 *   POST /api/admin/pitches/:id/approve
 *   POST /api/admin/pitches/:id/dismiss
 *   GET  /api/articles/review-queue
 *   GET  /api/admin/writers
 *
 * Globals from admin.js: apiFetch, showAlert, escHtml, fmtDate
 */
(function () {
  'use strict';

  var state = {
    budget: null,
    slots: [],
    writers: [],          // [{id, name, avatar_url, accent_color}]
    writersMap: {},
    generating: false,
    publishConfirmPending: false,
  };

  // Pitch filter state
  var pitchStatusFilter = 'proposed';

  // ── Colour pool for writer avatars ────────────────────────────────────────
  var AV_COLOURS = ['#7c3aed','#0369a1','#be185d','#047857','#b45309','#1d4ed8','#be123c','#065f46'];
  var avColourCache = {};
  function writerColour(id) {
    if (!avColourCache[id]) avColourCache[id] = AV_COLOURS[(id || 0) % AV_COLOURS.length];
    return avColourCache[id];
  }

  // ── HTML helpers ──────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  function relTime(iso) {
    if (!iso) return '';
    var diff = Date.now() - new Date(iso).getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function fmtWindow(iso) {
    if (!iso) return 'Unscheduled';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unscheduled';
    var h = d.getUTCHours(), mn = d.getUTCMinutes();
    return String(h).padStart(2,'0') + ':' + String(mn).padStart(2,'0') + ' UTC';
  }

  function writerChipHtml(slot) {
    var name = slot.assigned_writer_name || slot.recommended_writer_name || '';
    var id   = slot.assigned_writer_id   || slot.recommended_writer_id   || 0;
    var av   = slot.assigned_writer_avatar || slot.recommended_writer_avatar || '';
    if (!name) return '';
    var initials = name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
    var style = av
      ? 'background-image:url(' + esc(av) + ');background-size:cover;background-position:center;color:transparent;'
      : 'background:' + writerColour(id) + ';';
    return '<span class="nr-writer-chip"><span class="nr-av" style="' + style + '">' + (av ? '' : esc(initials)) + '</span>' + esc(name) + '</span>';
  }

  function writerChipFromId(writerId) {
    if (!writerId) return '';
    var w = state.writersMap[writerId];
    if (!w) return '';
    var initials = (w.name || '?').split(' ').map(function(x) { return x[0]; }).join('').slice(0,2).toUpperCase();
    var style = w.avatar_url
      ? 'background-image:url(' + esc(w.avatar_url) + ');background-size:cover;background-position:center;color:transparent;'
      : 'background:' + writerColour(w.id) + ';';
    return '<span class="nr-writer-chip"><span class="nr-av" style="' + style + '">' + (w.avatar_url ? '' : esc(initials)) + '</span>' + esc(w.name || '') + '</span>';
  }

  function pitchTypeBadge(type) {
    var safe = (type || 'original').replace(/[^a-z_]/g, '');
    return '<span class="nr-pt-badge pt-' + safe + '">' + esc(type || 'original') + '</span>';
  }

  // ── Render budget ─────────────────────────────────────────────────────────
  function renderBudget(budget) {
    var metaEl   = document.getElementById('nr-budget-meta');
    var bodyEl   = document.getElementById('nr-budget-body');
    var pubBtn   = document.getElementById('nr-budget-publish-btn');
    var genBtn   = document.getElementById('nr-budget-generate-btn');
    if (!bodyEl) return;

    if (!budget) {
      if (metaEl) metaEl.textContent = '';
      if (pubBtn) pubBtn.style.display = 'none';
      bodyEl.innerHTML = '<div class="nr-empty">'
        + '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"/></svg>'
        + '<span>Maxwell hasn\'t generated an editorial plan yet.<br>Generate one to see today\'s story priorities.</span>'
        + '</div>';
      if (genBtn) genBtn.style.display = '';
      return;
    }

    state.budget = budget;
    state.slots  = budget.slots || [];

    var statusLabel = budget.status === 'published' ? '● Published' : '● Draft';
    var statusColor = budget.status === 'published' ? 'var(--success)' : 'var(--warn)';
    if (metaEl) {
      metaEl.innerHTML = '<span style="color:' + statusColor + ';font-size:11px;font-weight:600;">' + statusLabel + '</span>'
        + (budget.editorial_note ? '<span class="text-muted" style="font-size:11px;margin-left:8px;">' + esc(budget.editorial_note.slice(0,80)) + (budget.editorial_note.length > 80 ? '…' : '') + '</span>' : '');
    }
    if (pubBtn) pubBtn.style.display = budget.status === 'draft' ? '' : 'none';

    var groups = { lead: [], standard: [], brief: [], hold: [] };
    state.slots.forEach(function(s) { (groups[s.priority] || groups.standard).push(s); });

    var html = '';
    [
      { key: 'lead',     label: 'Lead',     cls: 'nr-prio-lead'     },
      { key: 'standard', label: 'Standard', cls: 'nr-prio-standard' },
      { key: 'brief',    label: 'Brief',    cls: 'nr-prio-brief'    },
      { key: 'hold',     label: 'Hold',     cls: 'nr-prio-hold'     },
    ].forEach(function(grp) {
      var slots = groups[grp.key];
      if (!slots.length) return;
      html += '<div class="nr-priority-group">';
      html += '<div class="nr-priority-label ' + grp.cls + '">' + grp.label + '</div>';
      html += '<div class="nr-slot-cards">';
      slots.forEach(function(s) { html += slotCardHtml(s); });
      html += '</div></div>';
    });

    html += '<button class="nr-btn-gen" id="nr-floor-regen">+ Regenerate Budget</button>';
    bodyEl.innerHTML = html;

    // Wire up slot action buttons
    bodyEl.querySelectorAll('[data-approve-slot]').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); approveSlot(parseInt(btn.dataset.approveSlot, 10)); });
    });
    bodyEl.querySelectorAll('[data-reject-slot]').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); rejectSlot(parseInt(btn.dataset.rejectSlot, 10)); });
    });

    // Wire up inline headline editing on all slot headlines
    bodyEl.querySelectorAll('.nr-slot-headline[data-slot-id]').forEach(function(el) {
      el.addEventListener('click', function(e) { e.stopPropagation(); startHeadlineEdit(el); });
    });

    var regenBtn = document.getElementById('nr-floor-regen');
    if (regenBtn) regenBtn.addEventListener('click', generateBudget);
  }

  function slotCardHtml(s) {
    var statusCls = s.status !== 'pending' ? ' ' + s.status : '';
    var time = fmtWindow(s.target_publish_at);
    var srcCount = Array.isArray(s.source_article_ids) ? s.source_article_ids.length : 0;
    var isEditable = s.status === 'pending';

    return '<div class="nr-slot-card' + esc(statusCls) + '" data-slot-id="' + s.id + '">'
      + '<div class="nr-slot-left">'
      + '<div class="nr-slot-type">' + esc(s.pitch_type || 'original') + '</div>'
      + '<div class="nr-slot-headline" data-slot-id="' + s.id + '" title="Click to edit">' + esc(s.headline_suggestion || s.topic_tag || '—') + '</div>'
      + '<div class="nr-slot-meta">'
      + writerChipHtml(s)
      + (time !== 'Unscheduled' ? '<span class="nr-slot-time">' + esc(time) + '</span>' : '')
      + (srcCount ? '<span class="nr-slot-sources">' + srcCount + ' source' + (srcCount !== 1 ? 's' : '') + '</span>' : '')
      + '</div>'
      + '</div>'
      + (isEditable
        ? '<div class="nr-slot-actions">'
          + '<button class="nr-btn-approve" data-approve-slot="' + s.id + '" title="Approve">✓</button>'
          + '<button class="nr-btn-reject"  data-reject-slot="' + s.id + '"  title="Reject">✕</button>'
          + '</div>'
        : '<div class="nr-slot-actions" style="align-items:center;padding-top:4px;">'
          + '<span style="font-size:10px;color:var(--muted);">' + esc(s.status) + '</span>'
          + '</div>')
      + '</div>';
  }

  // ── Slot headline inline edit ─────────────────────────────────────────────
  function startHeadlineEdit(headlineEl) {
    if (headlineEl.dataset.editing === 'true') return;
    headlineEl.dataset.editing = 'true';

    var slotId   = parseInt(headlineEl.dataset.slotId, 10);
    var current  = headlineEl.textContent.trim();
    if (current === '—') current = '';

    var input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'nr-slot-headline-input';
    input.style.cssText = 'width:100%;font-size:inherit;font-weight:inherit;'
      + 'background:var(--surface2,#23232a);color:var(--text,#f1f1f1);'
      + 'border:1px solid var(--accent,#7c3aed);border-radius:4px;padding:2px 6px;'
      + 'outline:none;box-sizing:border-box;';

    headlineEl.style.display = 'none';
    headlineEl.parentNode.insertBefore(input, headlineEl.nextSibling);
    input.focus();
    input.select();

    function commit() {
      var newVal = input.value.trim();
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('keydown', onKey);
      input.remove();
      headlineEl.style.display = '';
      delete headlineEl.dataset.editing;
      if (!newVal || newVal === current) return;
      saveHeadlineSuggestion(slotId, newVal, headlineEl);
    }

    function cancel() {
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('keydown', onKey);
      input.remove();
      headlineEl.style.display = '';
      delete headlineEl.dataset.editing;
    }

    function onBlur() { commit(); }

    function onKey(e) {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    }

    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', onKey);
  }

  async function saveHeadlineSuggestion(slotId, newValue, headlineEl) {
    try {
      await apiFetch('/admin/budget/slots/' + slotId, {
        method: 'PATCH',
        body: JSON.stringify({ headline_suggestion: newValue }),
      });
      headlineEl.textContent = newValue;
      // Update local state
      var s = state.slots.find(function(x) { return x.id === slotId; });
      if (s) s.headline_suggestion = newValue;
    } catch (err) {
      showAlert('Failed to update headline: ' + err.message, 'error');
    }
  }

  // ── Render activity feed ──────────────────────────────────────────────────
  function renderActivity(events) {
    var el = document.getElementById('nr-activity-list');
    if (!el) return;
    if (!events || !events.length) {
      el.innerHTML = '<div class="nr-empty"><span>No recent activity.</span></div>';
      return;
    }

    var html = '';
    events.forEach(function(ev) {
      var dotCls = activityDotClass(ev.event_type);
      var text   = activityText(ev);
      html += '<div class="nr-activity-item">'
        + '<div class="nr-ev-dot ' + dotCls + '"></div>'
        + '<div class="nr-activity-body">'
        + '<div class="nr-activity-text">' + text + '</div>'
        + '<div class="nr-activity-time">' + esc(relTime(ev.created_at)) + '</div>'
        + '</div>'
        + '</div>';
    });
    el.innerHTML = html;
  }

  function activityDotClass(type) {
    if (!type) return 'nr-ev-default';
    if (type === 'published')              return 'nr-ev-published';
    if (type.startsWith('pitch') || type === 'pitched') return 'nr-ev-pitched';
    if (type === 'daily_brief' || type === 'weekly_digest') return 'nr-ev-brief';
    if (type.includes('editorial') || type.includes('budget') || type.includes('slot')) return 'nr-ev-editorial';
    return 'nr-ev-default';
  }

  function activityText(ev) {
    var actor = ev.actor_writer_name || 'System';
    var type  = ev.event_type || '';
    var payload = ev.payload || {};

    if (type === 'published') {
      var title = (payload.title || payload.generated_title || '');
      return '<strong>' + esc(actor) + '</strong> published'
        + (title ? ' <span class="nr-activity-article">"' + esc(title.slice(0,70)) + (title.length > 70 ? '…' : '') + '"</span>' : '');
    }
    if (type === 'pitched' || type === 'pitch_proposed') {
      var headline = payload.headline || '';
      return '<strong>' + esc(actor) + '</strong> pitched'
        + (headline ? ' <span class="nr-activity-article">"' + esc(headline.slice(0,60)) + (headline.length > 60 ? '…' : '') + '"</span>' : '');
    }
    if (type === 'budget_published') {
      return '<strong>' + esc(actor) + '</strong> published today\'s news budget';
    }
    if (type === 'budget_slot_approved') {
      var h = payload.headline || '';
      return '<strong>' + esc(actor) + '</strong> approved slot'
        + (h ? ': <span class="nr-activity-article">"' + esc(h.slice(0,55)) + (h.length > 55 ? '…' : '') + '"</span>' : '');
    }
    if (type === 'daily_brief') {
      return '<strong>' + esc(actor) + '</strong> received daily brief';
    }
    if (type === 'editorial_review') {
      var art = payload.title || '';
      return '<strong>Editorial</strong> reviewed'
        + (art ? ' <span class="nr-activity-article">"' + esc(art.slice(0,55)) + (art.length > 55 ? '…' : '') + '"</span>' : ' an article');
    }
    // fallback: humanise the event type
    var label = type.replace(/_/g, ' ');
    return '<strong>' + esc(actor) + '</strong> · ' + esc(label);
  }

  // ── Render pitch queue ────────────────────────────────────────────────────
  function renderPitchQueue(pitches, total) {
    var listEl  = document.getElementById('nr-pitch-list');
    var countEl = document.getElementById('nr-pitch-count');
    if (!listEl) return;

    if (countEl) {
      if (total > 0) {
        countEl.textContent = total;
        countEl.style.display = '';
      } else {
        countEl.style.display = 'none';
      }
    }

    if (!pitches || !pitches.length) {
      listEl.innerHTML = '<div class="nr-empty"><span>No '
        + (pitchStatusFilter === 'all' ? '' : pitchStatusFilter + ' ')
        + 'pitches.</span></div>';
      return;
    }

    var isApprovedTab = pitchStatusFilter === 'approved';
    var isProposedTab = pitchStatusFilter === 'proposed';

    var html = '';
    pitches.forEach(function(p) {
      var initials = (p.writer_name || '?').split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
      var avStyle = p.writer_avatar_url
        ? 'background-image:url(' + esc(p.writer_avatar_url) + ');background-size:cover;color:transparent;'
        : 'background:' + writerColour(p.writer_id) + ';';

      var actionBtn = isApprovedTab
        ? '<button class="nr-assign-btn" data-synthesize-pitch="' + p.id + '">Synthesize →</button>'
        : '<button class="nr-assign-btn" data-approve-pitch="' + p.id + '">Approve →</button>';

      var dismissBtn = isProposedTab
        ? '<button class="nr-dismiss-btn" data-dismiss-pitch="' + p.id + '" title="Dismiss">✕</button>'
        : '';

      html += '<div class="nr-pitch-row">'
        + pitchTypeBadge(p.pitch_type)
        + '<span class="nr-pitch-headline" title="' + esc(p.headline) + '">' + esc(p.headline || '—') + '</span>'
        + '<span class="nr-writer-chip" style="flex-shrink:0;"><span class="nr-av" style="' + avStyle + '">' + (p.writer_avatar_url ? '' : esc(initials)) + '</span>' + esc(p.writer_name || '') + '</span>'
        + actionBtn
        + dismissBtn
        + '</div>';
    });
    listEl.innerHTML = html;

    listEl.querySelectorAll('[data-approve-pitch]').forEach(function(btn) {
      btn.addEventListener('click', function() { approvePitch(parseInt(btn.dataset.approvePitch, 10), btn); });
    });

    listEl.querySelectorAll('[data-synthesize-pitch]').forEach(function(btn) {
      btn.addEventListener('click', function() { approvePitch(parseInt(btn.dataset.synthesizePitch, 10), btn); });
    });

    listEl.querySelectorAll('[data-dismiss-pitch]').forEach(function(btn) {
      btn.addEventListener('click', function() { dismissPitch(parseInt(btn.dataset.dismissPitch, 10), btn); });
    });
  }

  // ── Render editorial queue ────────────────────────────────────────────────
  function renderEditorialQueue(items) {
    var listEl  = document.getElementById('nr-editorial-list');
    var countEl = document.getElementById('nr-editorial-count');
    if (!listEl) return;

    var count = items ? items.length : 0;
    if (countEl) {
      if (count > 0) {
        countEl.textContent = count;
        countEl.style.display = '';
      } else {
        countEl.style.display = 'none';
      }
    }

    if (!items || !items.length) {
      listEl.innerHTML = '<div class="nr-empty"><span>No articles pending review.</span></div>';
      return;
    }

    var html = '';
    items.forEach(function(a) {
      var title     = a.title || a.generated_title || '(Untitled)';
      var truncated = title.length > 70 ? title.slice(0, 70) + '…' : title;
      var status    = a.status || 'review';

      // Map status to CSS class and label
      var statusCls, statusLabel;
      if (status === 'revision_requested') {
        statusCls   = 'as-draft';
        statusLabel = 'needs revision';
      } else {
        statusCls   = 'as-review';
        statusLabel = 'pending review';
      }

      var writerChip = writerChipFromId(a.writer_id);

      html += '<div class="nr-pitch-row">'
        + '<span class="nr-article-status ' + statusCls + '">' + esc(statusLabel) + '</span>'
        + '<span class="nr-pitch-headline" title="' + esc(title) + '">' + esc(truncated) + '</span>'
        + (writerChip ? writerChip : '')
        + '<a class="nr-assign-btn" href="/article-editor.html?id=' + esc(String(a.id)) + '">Review →</a>'
        + '</div>';
    });
    listEl.innerHTML = html;
  }

  // ── API actions ───────────────────────────────────────────────────────────
  async function loadBudget() {
    try {
      var data = await apiFetch('/admin/budget/today');
      var budget = data.budget || null;
      renderBudget(budget);
    } catch (err) {
      var bodyEl = document.getElementById('nr-budget-body');
      if (bodyEl) bodyEl.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load budget: ' + esc(err.message) + '</div>';
    }
  }

  async function generateBudget() {
    if (state.generating) return;
    state.generating = true;
    var genBtn = document.getElementById('nr-budget-generate-btn');
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating…'; }
    var bodyEl = document.getElementById('nr-budget-body');
    if (bodyEl) bodyEl.innerHTML = '<div class="nr-loading">Maxwell is writing today\'s budget…</div>';
    try {
      var data = await apiFetch('/admin/budget/generate', { method: 'POST' });
      if (data.skipped === 'already_exists') {
        showAlert('Budget already exists for today — reloading.', 'info');
        await loadBudget();
      } else if (data.ok) {
        showAlert('Budget generated — ' + (data.slot_count || 0) + ' slots.', 'success');
        await loadBudget();
      } else {
        throw new Error(data.error || 'Generation failed');
      }
    } catch (err) {
      showAlert('Failed to generate budget: ' + err.message, 'error');
      await loadBudget();
    } finally {
      state.generating = false;
      if (genBtn) { genBtn.disabled = false; genBtn.textContent = 'Generate'; }
    }
  }

  async function publishBudget() {
    if (!state.budget) return;
    try {
      await apiFetch('/admin/budget/' + state.budget.id, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'published' }),
      });
      showAlert('Budget published.', 'success');
      await loadBudget();
    } catch (err) {
      showAlert('Failed to publish: ' + err.message, 'error');
    }
  }

  async function approveSlot(slotId) {
    var card = document.querySelector('[data-slot-id="' + slotId + '"]');
    if (card) card.style.opacity = '0.5';
    try {
      await apiFetch('/admin/budget/slots/' + slotId + '/approve', { method: 'POST' });
      showAlert('Slot approved.', 'success');
      // Update card state locally without full reload
      var s = state.slots.find(function(x) { return x.id === slotId; });
      if (s) s.status = 'approved';
      if (card) {
        card.classList.add('approved');
        card.classList.remove('pending');
        var actionsEl = card.querySelector('.nr-slot-actions');
        if (actionsEl) actionsEl.innerHTML = '<span style="font-size:10px;color:var(--success);">approved</span>';
        card.style.opacity = '';
      }
    } catch (err) {
      showAlert('Failed to approve slot: ' + err.message, 'error');
      if (card) card.style.opacity = '';
    }
  }

  async function rejectSlot(slotId) {
    var card = document.querySelector('[data-slot-id="' + slotId + '"]');
    if (card) card.style.opacity = '0.5';
    try {
      await apiFetch('/admin/budget/slots/' + slotId + '/reject', { method: 'POST' });
      showAlert('Slot rejected.', 'info');
      var s = state.slots.find(function(x) { return x.id === slotId; });
      if (s) s.status = 'rejected';
      if (card) {
        card.classList.add('rejected');
        var actionsEl = card.querySelector('.nr-slot-actions');
        if (actionsEl) actionsEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">rejected</span>';
        card.style.opacity = '';
      }
    } catch (err) {
      showAlert('Failed to reject slot: ' + err.message, 'error');
      if (card) card.style.opacity = '';
    }
  }

  async function loadActivity() {
    var el = document.getElementById('nr-activity-list');
    try {
      var data = await apiFetch('/newsroom-feed?days=1&limit=40');
      var events = data.events || data || [];
      renderActivity(Array.isArray(events) ? events : []);
    } catch (err) {
      if (el) el.innerHTML = '<div class="nr-empty" style="color:var(--muted);">Activity unavailable.</div>';
    }
  }

  async function loadPitches() {
    try {
      var url;
      if (pitchStatusFilter === 'all') {
        url = '/admin/pitches?limit=15';
      } else {
        url = '/admin/pitches?status=' + pitchStatusFilter + '&limit=12';
      }
      var data = await apiFetch(url);
      var pitches = data.pitches || [];
      var total   = data.total || pitches.length;
      renderPitchQueue(pitches, total);
    } catch (err) {
      var el = document.getElementById('nr-pitch-list');
      if (el) el.innerHTML = '<div class="nr-empty" style="color:var(--muted);">Pitches unavailable.</div>';
    }
  }

  async function loadEditorialQueue() {
    var el = document.getElementById('nr-editorial-list');
    try {
      var data = await apiFetch('/articles/review-queue');
      var items = data.articles || [];
      renderEditorialQueue(items);
    } catch (err) {
      if (el) el.innerHTML = '<div class="nr-empty" style="color:var(--muted);">Editorial queue unavailable.</div>';
    }
  }

  async function loadWriters() {
    try {
      var writers = await apiFetch('/admin/writers');
      if (Array.isArray(writers)) {
        state.writers = writers;
        state.writersMap = {};
        writers.forEach(function(w) { state.writersMap[w.id] = w; });
      }
    } catch (err) {
      // Non-critical — editorial queue will just omit writer chips
    }
  }

  async function approvePitch(pitchId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      await apiFetch('/admin/pitches/' + pitchId + '/approve', { method: 'POST' });
      showAlert('Pitch approved — synthesis queued.', 'success');
      // Remove the row
      var row = btn && btn.closest('.nr-pitch-row');
      if (row) row.remove();
      // Decrement count
      var countEl = document.getElementById('nr-pitch-count');
      if (countEl) {
        var n = parseInt(countEl.textContent, 10) - 1;
        if (n <= 0) countEl.style.display = 'none';
        else countEl.textContent = n;
      }
    } catch (err) {
      showAlert('Failed to approve pitch: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = pitchStatusFilter === 'approved' ? 'Synthesize →' : 'Approve →'; }
    }
  }

  async function dismissPitch(pitchId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      await apiFetch('/admin/pitches/' + pitchId + '/dismiss', { method: 'POST' });
      showAlert('Pitch dismissed.', 'info');
      var row = btn && btn.closest('.nr-pitch-row');
      if (row) row.remove();
      var countEl = document.getElementById('nr-pitch-count');
      if (countEl) {
        var n = parseInt(countEl.textContent, 10) - 1;
        if (n <= 0) countEl.style.display = 'none';
        else countEl.textContent = n;
      }
    } catch (err) {
      showAlert('Failed to dismiss pitch: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '✕'; }
    }
  }

  // ── Public init ───────────────────────────────────────────────────────────
  function init() {
    // Button handlers
    var genBtn = document.getElementById('nr-budget-generate-btn');
    if (genBtn) genBtn.addEventListener('click', generateBudget);

    var pubBtn = document.getElementById('nr-budget-publish-btn');
    if (pubBtn) pubBtn.addEventListener('click', publishBudget);

    var refreshBtn = document.getElementById('nr-activity-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', loadActivity);

    // Pitch filter tab handlers
    var filterBar = document.getElementById('nr-pitch-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', function(e) {
        var tab = e.target.closest('.nr-pitch-filter-tab[data-pitch-status]');
        if (!tab) return;
        var newStatus = tab.dataset.pitchStatus;
        if (newStatus === pitchStatusFilter) return;
        pitchStatusFilter = newStatus;
        filterBar.querySelectorAll('.nr-pitch-filter-tab').forEach(function(t) {
          t.classList.toggle('active', t === tab);
        });
        loadPitches();
      });
    }

    // Load writers first so writersMap is populated before editorial queue renders
    loadWriters().then(function() {
      loadEditorialQueue();
    });

    // Load all panels
    loadBudget();
    loadActivity();
    loadPitches();

    // Poll activity every 90 seconds while Floor is active
    var pollTimer = setInterval(function() {
      if (document.getElementById('ws-floor').classList.contains('active')) {
        loadActivity();
      }
    }, 90000);

    // Clean up on page hide
    window.addEventListener('pagehide', function() { clearInterval(pollTimer); }, { once: true });
  }

  window.NRFloor = { init: init };
})();
