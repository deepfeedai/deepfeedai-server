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

    html += '<button class="nr-btn-gen" id="nr-floor-regen">+ Regenerate Runsheet</button>';
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
    if (regenBtn) regenBtn.addEventListener('click', function() { generateBudget(true); });
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
      + (s.spawned_article_id
        ? '<span class="nr-slot-draft-tag">→ In Draft</span>'
        : '')
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
      return '<strong>' + esc(actor) + '</strong> published today\'s runsheet';
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

    // Reset bulk bar when list re-renders
    var bulkBar = document.getElementById('nr-pitch-bulk-bar');
    if (bulkBar) bulkBar.style.display = 'none';

    var html = '';
    pitches.forEach(function(p) {
      var initials = (p.writer_name || '?').split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
      var avStyle = p.writer_avatar_url
        ? 'background-image:url(' + esc(p.writer_avatar_url) + ');background-size:cover;color:transparent;'
        : 'background:' + writerColour(p.writer_id) + ';';

      var actionBtn = isApprovedTab
        ? '<button class="nr-assign-btn" data-synthesize-pitch="' + p.id + '">Synthesize →</button>'
        : '<button class="nr-assign-btn" data-approve-pitch="' + p.id + '">Approve →</button>';

      var dismissBtn = (isProposedTab || isApprovedTab)
        ? '<button class="nr-dismiss-btn" data-dismiss-pitch="' + p.id + '" title="Dismiss">✕</button>'
        : '';

      var checkHtml = (isProposedTab || isApprovedTab)
        ? '<input type="checkbox" class="nr-bulk-check nr-pitch-bulk-check" data-pitch-id="' + p.id + '" aria-label="Select pitch">'
        : '';

      html += '<div class="nr-pitch-row" data-pitch-row-id="' + p.id + '">'
        + checkHtml
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
        + '<button class="nr-assign-btn" data-review-id="' + esc(String(a.id)) + '" data-review-title="' + esc(title) + '">Review →</button>'
        + '</div>';
    });
    listEl.innerHTML = html;

    listEl.querySelectorAll('[data-review-id]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        openReviewModal(parseInt(btn.dataset.reviewId, 10), btn.dataset.reviewTitle || '');
      });
    });
  }

  // ── Inline article review modal ───────────────────────────────────────────
  function openReviewModal(articleId, titleHint) {
    var overlay = document.getElementById('nr-review-modal');
    if (!overlay) return;

    var titleEl   = document.getElementById('nr-review-modal-title');
    var metaEl    = document.getElementById('nr-review-meta');
    var excerptEl = document.getElementById('nr-review-excerpt');
    var fullLink  = document.getElementById('nr-review-fulllink');
    var approveBtn = document.getElementById('nr-review-approve');
    var rejectBtn  = document.getElementById('nr-review-reject');

    if (titleEl)   titleEl.textContent = titleHint || 'Review Article';
    if (fullLink)  fullLink.href = '/article-editor.html?id=' + articleId;
    if (metaEl)    metaEl.innerHTML = '';
    if (excerptEl) excerptEl.innerHTML = '<div class="nr-loading">Loading…</div>';
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Approve & Publish'; }
    if (rejectBtn)  { rejectBtn.disabled = false;  rejectBtn.textContent = 'Send Back to Draft'; }

    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Load full article
    apiFetch('/articles/' + articleId).then(function(a) {
      if (titleEl) titleEl.textContent = a.title || a.generated_title || titleHint || 'Review Article';
      if (fullLink) fullLink.href = '/article-editor.html?id=' + a.id;

      // Meta row: writer chip + score badge
      var meta = '';
      if (a.writer_id) meta += writerChipFromId(a.writer_id);
      if (a.editorial_score != null) {
        var score = parseFloat(a.editorial_score);
        var scoreCls = score >= 7 ? 'nr-score-high' : score >= 5 ? 'nr-score-mid' : 'nr-score-low';
        meta += '<span class="nr-score-badge ' + scoreCls + '">Score ' + score.toFixed(1) + '</span>';
      }
      if (a.category) meta += '<span style="font-size:11px;color:var(--muted);margin-left:4px;">' + esc(a.category) + '</span>';
      if (metaEl) metaEl.innerHTML = meta;

      // Excerpt: use body_markdown or content, truncate to ~1200 chars
      var body = a.body_markdown || a.content || a.summary || '';
      if (body.length > 1200) body = body.slice(0, 1200) + '\n\n…';
      if (excerptEl) excerptEl.textContent = body || '(No content preview available)';

      // Wire up buttons with article id
      if (approveBtn) {
        approveBtn.onclick = function() { approveArticle(a.id, approveBtn, rejectBtn); };
      }
      if (rejectBtn) {
        rejectBtn.onclick = function() { rejectArticle(a.id, approveBtn, rejectBtn); };
      }
    }).catch(function(err) {
      if (excerptEl) excerptEl.innerHTML = '<div style="color:var(--danger);">Failed to load article: ' + esc(err.message) + '</div>';
    });

    // Close on overlay click
    overlay.onclick = function(e) { if (e.target === overlay) closeReviewModal(); };
  }

  function closeReviewModal() {
    var overlay = document.getElementById('nr-review-modal');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
  }

  async function approveArticle(articleId, approveBtn, rejectBtn) {
    if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Approving…'; }
    if (rejectBtn)  rejectBtn.disabled = true;
    try {
      await apiFetch('/articles/' + articleId + '/approve', { method: 'PUT' });
      showAlert('Article approved and published.', 'success');
      closeReviewModal();
      loadEditorialQueue();
      loadActivity();
    } catch(err) {
      showAlert('Failed to approve: ' + err.message, 'error');
      if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Approve & Publish'; }
      if (rejectBtn)  rejectBtn.disabled = false;
    }
  }

  async function rejectArticle(articleId, approveBtn, rejectBtn) {
    if (rejectBtn)  { rejectBtn.disabled = true; rejectBtn.textContent = 'Sending back…'; }
    if (approveBtn) approveBtn.disabled = true;
    try {
      await apiFetch('/articles/' + articleId + '/reject', { method: 'PUT' });
      showAlert('Article sent back to draft.', 'info');
      closeReviewModal();
      loadEditorialQueue();
      loadActivity();
    } catch(err) {
      showAlert('Failed to reject: ' + err.message, 'error');
      if (rejectBtn)  { rejectBtn.disabled = false; rejectBtn.textContent = 'Send Back to Draft'; }
      if (approveBtn) approveBtn.disabled = false;
    }
  }

  // ── API actions ───────────────────────────────────────────────────────────
  async function loadBudget() {
    try {
      var data = await apiFetch('/admin/budget/today');
      var budget = data.budget || null;
      renderBudget(budget);
    } catch (err) {
      var bodyEl = document.getElementById('nr-budget-body');
      if (bodyEl) bodyEl.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load runsheet: ' + esc(err.message) + '</div>';
    }
  }

  async function generateBudget(force) {
    if (state.generating) return;
    state.generating = true;
    var genBtn = document.getElementById('nr-budget-generate-btn');
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating…'; }
    var bodyEl = document.getElementById('nr-budget-body');
    if (bodyEl) bodyEl.innerHTML = '<div class="nr-loading">Maxwell is writing today\'s runsheet…</div>';
    try {
      var url = '/admin/budget/generate' + (force ? '?force=true' : '');
      var data = await apiFetch(url, { method: 'POST' });
      if (data.budget && data.skipped) {
        showAlert('Runsheet already exists for today — reloading.', 'info');
        await loadBudget();
      } else if (data.budget) {
        var slotCount = (data.budget.slots || []).length;
        showAlert('Runsheet generated — ' + slotCount + ' slots.', 'success');
        await loadBudget();
      } else {
        throw new Error(data.error || 'Generation failed');
      }
    } catch (err) {
      showAlert('Failed to generate runsheet: ' + err.message, 'error');
      await loadBudget();
    } finally {
      state.generating = false;
      if (genBtn) { genBtn.disabled = false; genBtn.textContent = 'Generate'; }
    }
  }

  async function publishBudget() {
    if (!state.budget) {
      showAlert('No runsheet loaded — try refreshing.', 'error');
      return;
    }
    var pubBtn = document.getElementById('nr-budget-publish-btn');
    if (pubBtn) { pubBtn.disabled = true; pubBtn.textContent = 'Publishing…'; }
    try {
      await apiFetch('/admin/budget/' + state.budget.id, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'published' }),
      });
      showAlert('Runsheet published.', 'success');
      await loadBudget();
    } catch (err) {
      showAlert('Failed to publish runsheet: ' + err.message, 'error');
      if (pubBtn) { pubBtn.disabled = false; pubBtn.textContent = 'Publish →'; }
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
      updatePitchCount(-1);
    } catch (err) {
      showAlert('Failed to approve pitch: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = pitchStatusFilter === 'approved' ? 'Synthesize →' : 'Approve →'; }
    }
  }

  function updatePitchCount(delta) {
    var countEl = document.getElementById('nr-pitch-count');
    if (!countEl) return;
    var n = (parseInt(countEl.textContent, 10) || 0) + delta;
    if (n <= 0) countEl.style.display = 'none';
    else { countEl.textContent = String(n); countEl.style.display = ''; }
  }

  function dismissPitch(pitchId, btn) {
    var row = btn && btn.closest('.nr-pitch-row');

    if (!row) {
      // No row context (swipe or sheet) — direct dismiss
      apiFetch('/admin/pitches/' + pitchId + '/dismiss', { method: 'POST' }).then(function() {
        updatePitchCount(-1);
      }).catch(function(err) {
        showAlert('Failed to dismiss pitch: ' + err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = '✕'; }
      });
      return;
    }

    // Undo toast path
    row.style.transition = 'opacity .15s';
    row.style.opacity = '0.25';
    if (btn) btn.disabled = true;

    if (typeof showUndoToast !== 'function') {
      apiFetch('/admin/pitches/' + pitchId + '/dismiss', { method: 'POST' }).then(function() {
        row.remove();
        updatePitchCount(-1);
      }).catch(function(err) {
        row.style.opacity = '';
        if (btn) { btn.disabled = false; btn.textContent = '✕'; }
        showAlert('Failed to dismiss pitch: ' + err.message, 'error');
      });
      return;
    }

    showUndoToast('Pitch dismissed.', function onCommit() {
      apiFetch('/admin/pitches/' + pitchId + '/dismiss', { method: 'POST' }).then(function() {
        row.remove();
        updatePitchCount(-1);
      }).catch(function(err) {
        row.style.opacity = '';
        if (btn) { btn.disabled = false; btn.textContent = '✕'; }
        showAlert('Failed to dismiss pitch: ' + err.message, 'error');
      });
    }, function onUndo() {
      row.style.opacity = '';
      if (btn) btn.disabled = false;
    });
  }

  // ── Bottom sheet ──────────────────────────────────────────────────────────
  var sheet = (function () {
    var overlayEl, sheetEl, titleEl, subtitleEl, bodyEl, footEl, handleEl;
    var dragStartY, isDragging;

    function init() {
      overlayEl   = document.getElementById('nr-sheet-overlay');
      sheetEl     = document.getElementById('nr-bottom-sheet');
      titleEl     = document.getElementById('nr-sheet-title');
      subtitleEl  = document.getElementById('nr-sheet-subtitle');
      bodyEl      = document.getElementById('nr-sheet-body');
      footEl      = document.getElementById('nr-sheet-foot');
      handleEl    = document.getElementById('nr-sheet-drag-handle');
      if (overlayEl) overlayEl.addEventListener('click', close);
      // Swipe-down handle to dismiss
      if (handleEl) {
        handleEl.addEventListener('touchstart', function(e) {
          dragStartY = e.touches[0].clientY; isDragging = false;
        }, { passive: true });
        handleEl.addEventListener('touchmove', function(e) {
          var dy = e.touches[0].clientY - dragStartY;
          if (dy > 5) { isDragging = true; sheetEl.style.transition = 'none'; sheetEl.style.transform = 'translateY(' + Math.max(0, dy) + 'px)'; }
        }, { passive: true });
        handleEl.addEventListener('touchend', function(e) {
          var dy = e.changedTouches[0].clientY - dragStartY;
          sheetEl.style.transition = ''; sheetEl.style.transform = '';
          if (dy > 72) close();
          isDragging = false;
        });
      }
    }

    function open(cfg) {
      if (!sheetEl) return;
      titleEl.innerHTML    = cfg.title    || '';
      subtitleEl.innerHTML = cfg.subtitle || '';
      bodyEl.innerHTML     = cfg.body     || '';
      footEl.innerHTML     = cfg.foot     || '';
      overlayEl.classList.add('open');
      sheetEl.classList.add('open');
      document.body.style.overflow = 'hidden';
      if (cfg.wire) cfg.wire();
    }

    function close() {
      if (!sheetEl) return;
      overlayEl.classList.remove('open');
      sheetEl.classList.remove('open');
      document.body.style.overflow = '';
    }

    return { init: init, open: open, close: close };
  })();

  // ── Open slot detail sheet ─────────────────────────────────────────────────
  function openSlotSheet(s) {
    var isEditable = s.status === 'pending';
    var writerHtml = writerChipHtml(s);
    var srcCount   = Array.isArray(s.source_article_ids) ? s.source_article_ids.length : 0;

    var body = '';
    if (s.rationale) {
      body += '<div class="nr-sheet-detail-row"><span class="nr-sheet-detail-label">Rationale</span><span class="nr-sheet-detail-value" style="color:var(--muted);">' + esc(s.rationale) + '</span></div>';
    }
    if (writerHtml) {
      body += '<div class="nr-sheet-detail-row"><span class="nr-sheet-detail-label">Writer</span><span class="nr-sheet-detail-value">' + writerHtml + '</span></div>';
    }
    if (s.target_publish_at) {
      body += '<div class="nr-sheet-detail-row"><span class="nr-sheet-detail-label">Target</span><span class="nr-sheet-detail-value">' + esc(fmtWindow(s.target_publish_at)) + '</span></div>';
    }
    if (srcCount) {
      body += '<div class="nr-sheet-detail-row"><span class="nr-sheet-detail-label">Sources</span><span class="nr-sheet-detail-value">' + srcCount + ' article' + (srcCount > 1 ? 's' : '') + '</span></div>';
    }

    var foot = isEditable
      ? '<button class="nr-sheet-btn-primary"  id="nr-sheet-a">✓ Approve</button>'
        + '<button class="nr-sheet-btn-secondary" id="nr-sheet-r">✕ Reject</button>'
      : '<div style="text-align:center;width:100%;font-size:13px;color:var(--muted);">Status: <strong>' + esc(s.status) + '</strong></div>';

    sheet.open({
      title:    esc(s.headline_suggestion || s.topic_tag || '—'),
      subtitle: esc((s.priority || 'standard').toUpperCase()) + ' · ' + esc(s.pitch_type || 'original'),
      body:     body,
      foot:     foot,
      wire: function() {
        var aBtn = document.getElementById('nr-sheet-a');
        var rBtn = document.getElementById('nr-sheet-r');
        if (aBtn) aBtn.addEventListener('click', function() {
          aBtn.disabled = true; aBtn.textContent = '…';
          if (rBtn) rBtn.disabled = true;
          approveSlot(s.id); sheet.close();
        });
        if (rBtn) rBtn.addEventListener('click', function() {
          rBtn.disabled = true; rBtn.textContent = '…';
          if (aBtn) aBtn.disabled = true;
          rejectSlot(s.id); sheet.close();
        });
      },
    });
  }

  // ── Open pitch detail sheet ────────────────────────────────────────────────
  function openPitchSheet(pitchId, row) {
    var approveBtn = row.querySelector('[data-approve-pitch]');
    var synthBtn   = row.querySelector('[data-synthesize-pitch]');
    var dismissBtn = row.querySelector('[data-dismiss-pitch]');
    var headlineEl = row.querySelector('.nr-pitch-headline');
    var writerEl   = row.querySelector('.nr-writer-chip');
    var badgeEl    = row.querySelector('.nr-pt-badge');

    var headline  = headlineEl ? (headlineEl.title || headlineEl.textContent).trim() : '—';
    var writerHtml = writerEl ? writerEl.outerHTML : '';
    var badgeHtml  = badgeEl  ? badgeEl.outerHTML  : '';
    var isApproved = !!synthBtn;

    var body = '';
    if (badgeHtml || writerHtml) {
      body += '<div class="nr-sheet-detail-row" style="gap:8px;">' + badgeHtml
        + (writerHtml ? '<span style="margin-left:auto;">' + writerHtml + '</span>' : '')
        + '</div>';
    }

    var approveLabel = isApproved ? '⚡ Synthesize' : '✓ Approve';
    var foot = '<button class="nr-sheet-btn-primary" id="nr-sheet-a">' + approveLabel + '</button>';
    if (dismissBtn) foot += '<button class="nr-sheet-btn-secondary" id="nr-sheet-r">✕ Dismiss</button>';

    sheet.open({
      title:    esc(headline),
      subtitle: 'Story Pitch',
      body:     body,
      foot:     foot,
      wire: function() {
        var aBtn = document.getElementById('nr-sheet-a');
        var rBtn = document.getElementById('nr-sheet-r');
        if (aBtn) aBtn.addEventListener('click', function() {
          aBtn.disabled = true; aBtn.textContent = '…';
          if (rBtn) rBtn.disabled = true;
          approvePitch(pitchId, aBtn);
          sheet.close();
        });
        if (rBtn) rBtn.addEventListener('click', function() {
          rBtn.disabled = true; rBtn.textContent = '…';
          if (aBtn) aBtn.disabled = true;
          dismissPitch(pitchId, rBtn);
          sheet.close();
        });
      },
    });
  }

  // ── Pitch row: tap for detail sheet (all devices) ─────────────────────────
  function wirePitchTap(containerEl) {
    containerEl.addEventListener('click', function(e) {
      if (e.target.closest('button')) return;
      var row = e.target.closest('.nr-pitch-row');
      if (!row) return;
      var approveBtn = row.querySelector('[data-approve-pitch],[data-synthesize-pitch]');
      if (!approveBtn) return;
      var pitchId = parseInt(approveBtn.dataset.approvePitch || approveBtn.dataset.synthesizePitch, 10);
      if (pitchId) openPitchSheet(pitchId, row);
    });
  }

  // ── Swipe left/right on pitch rows ────────────────────────────────────────
  function wireSwipePitches(containerEl) {
    var startX, startY, activeRow, dirLocked;

    containerEl.addEventListener('touchstart', function(e) {
      var row = e.target.closest('.nr-pitch-row');
      if (!row) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      activeRow  = row;
      dirLocked  = null;
    }, { passive: true });

    containerEl.addEventListener('touchmove', function(e) {
      if (!activeRow) return;
      var dx = e.touches[0].clientX - startX;
      var dy = e.touches[0].clientY - startY;
      if (!dirLocked) {
        if (Math.abs(dy) > Math.abs(dx) + 8) { activeRow = null; return; }
        if (Math.abs(dx) > 8) dirLocked = 'h';
      }
      if (dirLocked !== 'h') return;
      e.preventDefault();
      activeRow.style.transition = 'none';
      activeRow.style.transform  = 'translateX(' + dx + 'px)';
      activeRow.classList.toggle('swiping-approve', dx > 28);
      activeRow.classList.toggle('swiping-dismiss', dx < -28);
    }, { passive: false });

    containerEl.addEventListener('touchend', function(e) {
      if (!activeRow || dirLocked !== 'h') { activeRow = null; return; }
      var dx = e.changedTouches[0].clientX - startX;
      activeRow.classList.remove('swiping-approve', 'swiping-dismiss');
      activeRow.style.transition = 'transform .2s ease, opacity .2s';

      var approveBtn = activeRow.querySelector('[data-approve-pitch]');
      var synthBtn   = activeRow.querySelector('[data-synthesize-pitch]');
      var dismissBtn = activeRow.querySelector('[data-dismiss-pitch]');

      if (dx > 88 && (approveBtn || synthBtn)) {
        var pid = parseInt((approveBtn || synthBtn).dataset.approvePitch || (synthBtn || {}).dataset.synthesizePitch, 10);
        activeRow.style.transform = 'translateX(110%)';
        activeRow.style.opacity   = '0';
        var rowRef = activeRow;
        setTimeout(function() { approvePitch(pid, null); rowRef.remove(); }, 210);
      } else if (dx < -88 && dismissBtn) {
        var did = parseInt(dismissBtn.dataset.dismissPitch, 10);
        activeRow.style.transform = 'translateX(-110%)';
        activeRow.style.opacity   = '0';
        var rowRef2 = activeRow;
        setTimeout(function() { dismissPitch(did, null); rowRef2.remove(); }, 210);
      } else {
        activeRow.style.transform = '';
      }
      activeRow = null;
    });
  }

  // ── Swipe left/right on budget slot cards ─────────────────────────────────
  function wireSwipeSlots(containerEl) {
    var startX, startY, activeCard, dirLocked;

    containerEl.addEventListener('touchstart', function(e) {
      var card = e.target.closest('.nr-slot-card');
      if (!card) return;
      startX     = e.touches[0].clientX;
      startY     = e.touches[0].clientY;
      activeCard = card;
      dirLocked  = null;
    }, { passive: true });

    containerEl.addEventListener('touchmove', function(e) {
      if (!activeCard) return;
      var dx = e.touches[0].clientX - startX;
      var dy = e.touches[0].clientY - startY;
      if (!dirLocked) {
        if (Math.abs(dy) > Math.abs(dx) + 8) { activeCard = null; return; }
        if (Math.abs(dx) > 8) dirLocked = 'h';
      }
      if (dirLocked !== 'h') return;
      e.preventDefault();
      activeCard.style.transition = 'none';
      activeCard.style.transform  = 'translateX(' + dx + 'px)';
      activeCard.classList.toggle('swiping-approve', dx > 28);
      activeCard.classList.toggle('swiping-reject',  dx < -28);
    }, { passive: false });

    containerEl.addEventListener('touchend', function(e) {
      if (!activeCard || dirLocked !== 'h') { activeCard = null; return; }
      var dx = e.changedTouches[0].clientX - startX;
      activeCard.classList.remove('swiping-approve', 'swiping-reject');
      activeCard.style.transition = 'transform .2s ease, opacity .2s';

      var aBtn = activeCard.querySelector('[data-approve-slot]');
      var rBtn = activeCard.querySelector('[data-reject-slot]');

      if (dx > 88 && aBtn) {
        var sid = parseInt(aBtn.dataset.approveSlot, 10);
        activeCard.style.transform = 'translateX(110%)';
        activeCard.style.opacity   = '0';
        var cardRef = activeCard;
        setTimeout(function() { approveSlot(sid); cardRef.remove(); }, 210);
      } else if (dx < -88 && rBtn) {
        var rid = parseInt(rBtn.dataset.rejectSlot, 10);
        activeCard.style.transform = 'translateX(-110%)';
        activeCard.style.opacity   = '0';
        var cardRef2 = activeCard;
        setTimeout(function() { rejectSlot(rid); cardRef2.remove(); }, 210);
      } else {
        activeCard.style.transform = '';
      }
      activeCard = null;
    });
  }

  // ── Slot card tap → detail sheet ──────────────────────────────────────────
  function wireSlotTap(containerEl) {
    containerEl.addEventListener('click', function(e) {
      if (e.target.closest('button') || e.target.closest('input')) return;
      if (e.target.closest('.nr-slot-headline')) return; // let inline edit handle it
      var card = e.target.closest('.nr-slot-card');
      if (!card) return;
      var slotId = parseInt(card.dataset.slotId, 10);
      if (!slotId) return;
      var s = state.slots.filter(function(x) { return x.id === slotId; })[0];
      if (s) openSlotSheet(s);
    });
  }

  // ── FAB: create pitch / add to runsheet ───────────────────────────────────
  function openCreateSheet() {
    var writerOpts = state.writers.map(function(w) {
      return '<option value="' + w.id + '">' + esc(w.name || w.persona_name || 'Writer ' + w.id) + '</option>';
    }).join('');

    var hasBudget = !!(state.budget && state.budget.id);

    var body = '<div class="nr-create-form">'
      + '<div class="nr-form-field"><label>Headline</label>'
      + '<input id="nr-new-hl" type="text" placeholder="What\'s the story?" maxlength="300" autocomplete="off"></div>'
      + '<div class="nr-form-field"><label>Writer</label>'
      + '<select id="nr-new-wr"><option value="">— Pick a writer —</option>' + writerOpts + '</select></div>'
      + '<div class="nr-form-field"><label>Priority</label>'
      + '<select id="nr-new-pr"><option value="standard" selected>Standard</option>'
      + '<option value="lead">Lead</option><option value="brief">Brief</option><option value="hold">Hold</option></select></div>'
      + '<div class="nr-form-field"><label>Type</label>'
      + '<select id="nr-new-tp"><option value="original" selected>Original</option>'
      + '<option value="breaking">Breaking</option><option value="analysis">Analysis</option>'
      + '<option value="deep_dive">Deep Dive</option><option value="follow_up">Follow Up</option></select></div>'
      + '</div>';

    var foot = hasBudget
      ? '<button class="nr-sheet-btn-primary"  id="nr-create-submit">Add to Runsheet</button>'
        + '<button class="nr-sheet-btn-secondary" id="nr-create-cancel" style="flex:0 0 auto;padding:14px 18px;">Cancel</button>'
      : '<div style="text-align:center;width:100%;font-size:13px;color:var(--muted);">Generate today\'s runsheet first, then add pitches here.</div>';

    sheet.open({
      title:    '+ New Pitch',
      subtitle: hasBudget ? 'Adding to today\'s runsheet' : 'No runsheet for today',
      body:     body,
      foot:     foot,
      wire: function() {
        var cancelBtn = document.getElementById('nr-create-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', sheet.close);

        var submitBtn = document.getElementById('nr-create-submit');
        if (!submitBtn) return;

        var hlInput = document.getElementById('nr-new-hl');
        if (hlInput) setTimeout(function() { hlInput.focus(); }, 60);

        submitBtn.addEventListener('click', function() {
          var hl  = (document.getElementById('nr-new-hl') || {}).value || '';
          var wid = (document.getElementById('nr-new-wr') || {}).value || '';
          var pr  = (document.getElementById('nr-new-pr') || {}).value || 'standard';

          hl = hl.trim();
          if (!hl)  { showAlert('Headline is required.', 'error');  return; }
          if (!wid) { showAlert('Please pick a writer.', 'error');  return; }

          submitBtn.disabled    = true;
          submitBtn.textContent = 'Adding…';

          apiFetch('/admin/budget/' + state.budget.id + '/slots', {
            method: 'POST',
            body: JSON.stringify({ headline_suggestion: hl, assigned_writer_id: parseInt(wid, 10), priority: pr }),
          }).then(function() {
            showAlert('Added to runsheet.', 'success');
            sheet.close();
            loadBudget();
          }).catch(function(err) {
            showAlert('Failed to add: ' + err.message, 'error');
            submitBtn.disabled    = false;
            submitBtn.textContent = 'Add to Runsheet';
          });
        });
      },
    });
  }

  // ── Bulk pitch actions ────────────────────────────────────────────────────

  function updatePitchBulkBar() {
    var checked = document.querySelectorAll('#nr-pitch-list .nr-pitch-bulk-check:checked');
    var bar     = document.getElementById('nr-pitch-bulk-bar');
    var countEl = document.getElementById('nr-pitch-bulk-count');
    if (!bar) return;
    var n = checked.length;
    if (countEl) countEl.textContent = n + ' selected';
    bar.style.display = n > 0 ? '' : 'none';
  }

  async function bulkApprovePitches() {
    var checked = document.querySelectorAll('#nr-pitch-list .nr-pitch-bulk-check:checked');
    if (!checked.length) return;
    var items = Array.prototype.map.call(checked, function(c) {
      return { id: parseInt(c.dataset.pitchId, 10), row: c.closest('.nr-pitch-row') };
    });

    var btn = document.getElementById('nr-pitch-bulk-approve');
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }

    var succeeded = 0;
    await Promise.all(items.map(function(item) {
      return apiFetch('/admin/pitches/' + item.id + '/approve', { method: 'POST' }).then(function() {
        succeeded++;
        if (item.row) item.row.remove();
      }).catch(function(err) {
        showAlert('Approve failed for pitch ' + item.id + ': ' + err.message, 'error');
      });
    }));

    if (succeeded > 0) {
      showAlert('Approved ' + succeeded + ' pitch' + (succeeded !== 1 ? 'es' : '') + '.', 'success');
      updatePitchCount(-succeeded);
    }

    if (btn) { btn.disabled = false; btn.textContent = 'Approve'; }
    updatePitchBulkBar();
  }

  function bulkDismissPitches() {
    var checked = document.querySelectorAll('#nr-pitch-list .nr-pitch-bulk-check:checked');
    if (!checked.length) return;
    var items = Array.prototype.map.call(checked, function(c) {
      var row = c.closest('.nr-pitch-row');
      return { id: parseInt(c.dataset.pitchId, 10), row: row };
    });

    // Dim rows immediately
    items.forEach(function(item) {
      if (item.row) { item.row.style.transition = 'opacity .15s'; item.row.style.opacity = '0.25'; }
    });

    var bar = document.getElementById('nr-pitch-bulk-bar');
    if (bar) bar.style.display = 'none';

    var n = items.length;
    var label = n + ' pitch' + (n !== 1 ? 'es' : '');

    if (typeof showUndoToast !== 'function') {
      items.forEach(function(item) {
        apiFetch('/admin/pitches/' + item.id + '/dismiss', { method: 'POST' }).then(function() {
          if (item.row) item.row.remove();
          updatePitchCount(-1);
        });
      });
      return;
    }

    showUndoToast('Dismissed ' + label + '.', function onCommit() {
      items.forEach(function(item) {
        apiFetch('/admin/pitches/' + item.id + '/dismiss', { method: 'POST' }).then(function() {
          if (item.row) item.row.remove();
          updatePitchCount(-1);
        }).catch(function(err) {
          if (item.row) item.row.style.opacity = '';
          showAlert('Dismiss failed: ' + err.message, 'error');
        });
      });
    }, function onUndo() {
      items.forEach(function(item) {
        if (item.row) {
          item.row.style.opacity = '';
          var check = item.row.querySelector('.nr-pitch-bulk-check');
          if (check) check.checked = false;
        }
      });
      updatePitchBulkBar();
    });
  }

  function initPitchBulkBar() {
    var approveBtn = document.getElementById('nr-pitch-bulk-approve');
    if (approveBtn) approveBtn.addEventListener('click', bulkApprovePitches);

    var dismissBtn = document.getElementById('nr-pitch-bulk-dismiss');
    if (dismissBtn) dismissBtn.addEventListener('click', bulkDismissPitches);

    var clearBtn = document.getElementById('nr-pitch-bulk-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        Array.prototype.forEach.call(
          document.querySelectorAll('#nr-pitch-list .nr-pitch-bulk-check'),
          function(c) { c.checked = false; }
        );
        updatePitchBulkBar();
      });
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

    // Review modal close
    var reviewClose = document.getElementById('nr-review-close');
    if (reviewClose) reviewClose.addEventListener('click', closeReviewModal);
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeReviewModal();
    });

    // Bottom sheet init
    sheet.init();

    // Swipe + tap + bulk-check handlers (attached to containers — survive re-renders)
    var pitchListEl  = document.getElementById('nr-pitch-list');
    var budgetBodyEl = document.getElementById('nr-budget-body');
    if (pitchListEl) {
      wireSwipePitches(pitchListEl);
      wirePitchTap(pitchListEl);
      pitchListEl.addEventListener('change', function(e) {
        if (e.target.closest('.nr-pitch-bulk-check')) updatePitchBulkBar();
      });
    }
    if (budgetBodyEl) { wireSwipeSlots(budgetBodyEl); wireSlotTap(budgetBodyEl); }

    // Init bulk action bar
    initPitchBulkBar();

    // FAB
    var fabEl = document.getElementById('nr-fab');
    if (fabEl) {
      fabEl.classList.remove('hidden');
      fabEl.addEventListener('click', openCreateSheet);

      // Hide FAB when user switches away from Floor
      document.querySelectorAll('[data-ws]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (btn.dataset.ws === 'floor') {
            fabEl.classList.remove('hidden');
          } else {
            fabEl.classList.add('hidden');
          }
        });
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

    // Poll while Floor is active: activity 60s, pitches + editorial 120s
    var pollTick = 0;
    var pollTimer = setInterval(function() {
      var floor = document.getElementById('ws-floor');
      if (!floor || !floor.classList.contains('active')) return;
      pollTick++;
      loadActivity();
      if (pollTick % 2 === 0) {   // every 2nd tick = 120s
        loadPitches();
        loadEditorialQueue();
      }
    }, 60000);

    // Clean up on page hide
    window.addEventListener('pagehide', function() { clearInterval(pollTimer); }, { once: true });
  }

  window.NRFloor = { init: init, refreshPitches: loadPitches };
})();
