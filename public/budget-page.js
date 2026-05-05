/**
 * Budget Board Page — Daily Editorial Budget
 *
 * Views:
 *   swimlanes — priority swimlane rows (lead / standard / brief / hold)
 *   timeline  — rows by publish window (morning / afternoon / evening / unscheduled)
 *
 * API endpoints consumed:
 *   GET    /api/admin/budget?date=YYYY-MM-DD
 *   POST   /api/admin/budget/generate
 *   PATCH  /api/admin/budget/:id            { editorial_note } | { status }
 *   POST   /api/admin/budget/slots/:id/approve
 *   POST   /api/admin/budget/slots/:id/reject
 *   PATCH  /api/admin/budget/slots/:id      { headline_suggestion, target_publish_at, priority }
 *   POST   /api/admin/budget/slots/:id/reassign  { writer_id }
 *   GET    /api/admin/writers
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  var currentBudget   = null;          // full budget object from API
  var currentDate     = todayString(); // YYYY-MM-DD in local timezone
  var currentView     = 'swimlanes';   // 'swimlanes' | 'timeline'
  var writers         = [];            // [{id, name, avatar_url}]
  var writersLoaded   = false;
  var reassignSlotId  = null;          // slot id pending reassign
  var countdownTimers = [];            // setInterval handles for auto-promote timers

  // ── Helpers ────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function todayString() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function formatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var h = d.getHours();
    var min = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 || 12;
    return h12 + (min ? ':' + String(min).padStart(2, '0') : '') + ' ' + ampm;
  }

  function formatTimeWindow(iso) {
    if (!iso) return 'Unscheduled';
    var h = new Date(iso).getHours();
    if (isNaN(h)) return 'Unscheduled';
    if (h < 6)  return 'Early Morning';
    if (h < 12) return 'Morning';
    if (h < 18) return 'Afternoon';
    return 'Evening';
  }

  function toast(msg, type) {
    if (typeof window.showAlert === 'function') window.showAlert(msg, type || 'success');
    else console.log('[budget]', type, msg);
  }

  // ── Slot status badge ──────────────────────────────────────────────────────
  function statusBadge(status) {
    var cfg = {
      pending:        { cls: 'badge-muted',   label: 'Pending' },
      approved:       { cls: 'badge-success', label: 'Approved' },
      rejected:       { cls: 'badge-danger',  label: 'Rejected' },
      auto_promoted:  { cls: 'badge-accent',  label: 'Auto-promoted' },
    };
    var c = cfg[status] || cfg.pending;
    return '<span class="badge ' + c.cls + '">' + esc(c.label) + '</span>';
  }

  // ── Pitch type badge ───────────────────────────────────────────────────────
  function pitchTypeBadge(pitchType) {
    var map = {
      original: { cls: 'pt-original', label: 'Original' },
      brief:    { cls: 'pt-brief',    label: 'Brief' },
      analysis: { cls: 'pt-analysis', label: 'Analysis' },
    };
    var c = map[pitchType] || { cls: 'pt-original', label: esc(pitchType || '') };
    return '<span class="pitch-type-tag ' + c.cls + '">' + esc(c.label) + '</span>';
  }

  // ── Writer avatar HTML ─────────────────────────────────────────────────────
  function writerAvatarHtml(name, avatarUrl) {
    var initial = (name || '?').charAt(0).toUpperCase();
    if (avatarUrl) {
      return '<img class="card-writer-avatar" src="' + esc(avatarUrl) + '" alt="" />';
    }
    return '<div class="card-writer-placeholder">' + esc(initial) + '</div>';
  }

  // ── Countdown HTML ─────────────────────────────────────────────────────────
  function countdownHtml(slotId, autoPromoteAt) {
    if (!autoPromoteAt) return '';
    var ms = new Date(autoPromoteAt).getTime() - Date.now();
    if (ms <= 0) return '';
    return '<div class="card-countdown" id="countdown-' + esc(String(slotId)) + '" data-at="' + esc(autoPromoteAt) + '">&#9201; <span></span></div>';
  }

  // Start all countdown timers for currently-rendered cards
  function startCountdownTimers() {
    // Clear old timers
    countdownTimers.forEach(clearInterval);
    countdownTimers = [];

    document.querySelectorAll('.card-countdown').forEach(function (el) {
      var at = el.dataset.at;
      if (!at) return;
      var tick = function () {
        var ms = new Date(at).getTime() - Date.now();
        if (ms <= 0) {
          el.textContent = 'Auto-promoting…';
          return;
        }
        var totalSec = Math.floor(ms / 1000);
        var h = Math.floor(totalSec / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var s = totalSec % 60;
        var parts = [];
        if (h) parts.push(h + 'h');
        if (m || h) parts.push(m + 'm');
        parts.push(s + 's');
        var span = el.querySelector('span');
        if (span) span.textContent = parts.join(' ');
      };
      tick();
      countdownTimers.push(setInterval(tick, 1000));
    });
  }

  // ── Render a single budget card ────────────────────────────────────────────
  function renderCard(slot) {
    var displayName = slot.assigned_writer_name || slot.recommended_writer_name || '';
    var priority    = slot.priority || 'standard';
    var status      = slot.status || 'pending';

    // Action buttons — only show contextually appropriate ones
    var approveBtn = status !== 'approved'
      ? '<button class="card-btn cb-approve" data-action="approve" data-id="' + slot.id + '" title="Approve slot">&#10003; <span class="cb-label">Approve</span></button>'
      : '';
    var rejectBtn  = status !== 'rejected'
      ? '<button class="card-btn cb-reject" data-action="reject" data-id="' + slot.id + '" title="Reject slot">&#10005; <span class="cb-label">Reject</span></button>'
      : '';
    var reassignBtn = '<button class="card-btn cb-reassign" data-action="reassign" data-id="' + slot.id + '" title="Reassign writer">&#8635; <span class="cb-label">Reassign</span></button>';
    var editBtn     = '<button class="card-btn cb-edit" data-action="edit-headline" data-id="' + slot.id + '" title="Edit headline">&#9998; <span class="cb-label">Edit</span></button>';

    // Countdown (if slot is pending and has auto_promote_at)
    var cdown = (status === 'pending' && slot.auto_promote_at) ? countdownHtml(slot.id, slot.auto_promote_at) : '';

    return [
      '<div class="budget-card bc-' + esc(status) + '" id="bcard-' + esc(String(slot.id)) + '" data-slot-id="' + esc(String(slot.id)) + '">',
        '<div class="card-top">',
          '<div class="card-headline">' + esc(slot.headline_suggestion || 'Untitled') + '</div>',
          '<div class="card-status-badge">' + statusBadge(status) + '</div>',
        '</div>',
        '<div class="card-meta-row">',
          pitchTypeBadge(slot.pitch_type),
          slot.topic_tag ? '<span class="topic-tag" title="' + esc(slot.topic_tag) + '">' + esc(slot.topic_tag) + '</span>' : '',
        '</div>',
        '<div class="card-meta-row">',
          '<div class="card-writer">',
            writerAvatarHtml(displayName, null),
            '<span>' + esc(displayName || 'Unassigned') + '</span>',
          '</div>',
          slot.target_publish_at ? '<span class="card-publish-time">' + esc(formatTime(slot.target_publish_at)) + '</span>' : '',
        '</div>',
        cdown,
        '<div class="card-actions">',
          approveBtn,
          rejectBtn,
          reassignBtn,
          editBtn,
        '</div>',
      '</div>',
    ].join('');
  }

  // ── Render skeleton cards ──────────────────────────────────────────────────
  function renderSkeletonCards(count) {
    var html = '';
    for (var i = 0; i < count; i++) {
      html += [
        '<div class="sk-card">',
          '<div style="display:flex;justify-content:space-between;gap:8px;">',
            '<div class="skeleton sk-text sk-w-full" style="flex:1;height:14px;"></div>',
            '<div class="skeleton sk-badge" style="width:64px;height:20px;"></div>',
          '</div>',
          '<div style="display:flex;gap:6px;">',
            '<div class="skeleton sk-badge" style="width:56px;height:18px;border-radius:4px;"></div>',
            '<div class="skeleton sk-badge" style="width:80px;height:18px;border-radius:4px;"></div>',
          '</div>',
          '<div style="display:flex;gap:6px;align-items:center;">',
            '<div class="skeleton sk-avatar" style="width:22px;height:22px;border-radius:50%;"></div>',
            '<div class="skeleton sk-text" style="width:90px;height:11px;"></div>',
          '</div>',
          '<div style="display:flex;gap:6px;">',
            '<div class="skeleton" style="width:70px;height:26px;border-radius:6px;"></div>',
            '<div class="skeleton" style="width:62px;height:26px;border-radius:6px;"></div>',
          '</div>',
        '</div>',
      ].join('');
    }
    return html;
  }

  // ── Render swimlanes ───────────────────────────────────────────────────────
  var PRIORITY_ORDER = ['lead', 'standard', 'brief', 'hold'];
  var PRIORITY_LABELS = { lead: 'Lead', standard: 'Standard', brief: 'Brief', hold: 'Hold' };
  var PRIORITY_CSS    = { lead: 'sl-lead', standard: 'sl-standard', brief: 'sl-brief', hold: 'sl-hold' };

  function renderSwimlanes(slots) {
    var board = document.getElementById('boardSwimlanes');
    if (!board) return;

    // Group by priority
    var groups = {};
    PRIORITY_ORDER.forEach(function (p) { groups[p] = []; });
    (slots || []).forEach(function (s) {
      var p = s.priority || 'standard';
      if (!groups[p]) groups[p] = [];
      groups[p].push(s);
    });

    var html = '';
    PRIORITY_ORDER.forEach(function (priority) {
      var slotsInLane = groups[priority] || [];
      var cssClass = PRIORITY_CSS[priority] || '';
      var label = PRIORITY_LABELS[priority] || priority;

      var cardsHtml = slotsInLane.length
        ? slotsInLane.map(renderCard).join('')
        : '<div class="swimlane-empty">No ' + esc(label.toLowerCase()) + ' stories</div>';

      html += [
        '<div class="swimlane" data-priority="' + esc(priority) + '">',
          '<div class="swimlane-header">',
            '<span class="swimlane-label ' + cssClass + '">' + esc(label) + '</span>',
            '<span class="swimlane-count">' + slotsInLane.length + '</span>',
          '</div>',
          '<div class="swimlane-track">',
            cardsHtml,
          '</div>',
        '</div>',
      ].join('');
    });

    board.innerHTML = html;
    startCountdownTimers();
  }

  // ── Render timeline ────────────────────────────────────────────────────────
  var WINDOWS = [
    { key: 'Morning',       label: 'Morning',   time: '6 AM – 12 PM', test: function (iso) { if (!iso) return false; var h = new Date(iso).getHours(); return h >= 6 && h < 12; } },
    { key: 'Afternoon',     label: 'Afternoon', time: '12 PM – 6 PM', test: function (iso) { if (!iso) return false; var h = new Date(iso).getHours(); return h >= 12 && h < 18; } },
    { key: 'Evening',       label: 'Evening',   time: '6 PM+',        test: function (iso) { if (!iso) return false; var h = new Date(iso).getHours(); return h >= 18; } },
    { key: 'Early Morning', label: 'Early Morning', time: 'Before 6 AM', test: function (iso) { if (!iso) return false; var h = new Date(iso).getHours(); return h < 6; } },
    { key: 'Unscheduled',   label: 'Unscheduled', time: 'No time set',  test: function (iso) { return !iso; } },
  ];

  function renderTimeline(slots) {
    var board = document.getElementById('boardTimeline');
    if (!board) return;

    var html = '';
    WINDOWS.forEach(function (win) {
      var inWindow = (slots || []).filter(function (s) { return win.test(s.target_publish_at); });
      if (!inWindow.length) return; // skip empty windows

      var cardsHtml = inWindow.map(renderCard).join('');

      html += [
        '<div class="timeline-section">',
          '<div class="timeline-section-header">',
            '<span class="timeline-section-label">' + esc(win.label) + '</span>',
            '<span class="timeline-section-time">' + esc(win.time) + '</span>',
            '<span class="swimlane-count" style="margin-left:4px;">' + inWindow.length + '</span>',
          '</div>',
          '<div class="timeline-card-grid">',
            cardsHtml,
          '</div>',
        '</div>',
      ].join('');
    });

    if (!html) {
      html = '<div class="budget-empty"><div class="budget-empty-icon">📅</div><h2>No slots with times</h2><p>Assign target publish times to see them in the timeline view.</p></div>';
    }

    board.innerHTML = html;
    startCountdownTimers();
  }

  // ── Update stat pills ──────────────────────────────────────────────────────
  function updateStats(slots) {
    var approved = 0, pending = 0, rejected = 0;
    (slots || []).forEach(function (s) {
      if (s.status === 'approved' || s.status === 'auto_promoted') approved++;
      else if (s.status === 'rejected') rejected++;
      else pending++;
    });
    var stats = document.getElementById('budgetStats');
    if (stats) stats.style.display = 'flex';
    var a = document.getElementById('statApproved');
    var p = document.getElementById('statPending');
    var r = document.getElementById('statRejected');
    if (a) a.textContent = approved + ' approved';
    if (p) p.textContent = pending + ' pending';
    if (r) r.textContent = rejected + ' rejected';
  }

  // ── Show/hide views ────────────────────────────────────────────────────────
  function showView(view) {
    currentView = view;
    document.getElementById('viewSwimlanes').classList.toggle('active', view === 'swimlanes');
    document.getElementById('viewTimeline').classList.toggle('active', view === 'timeline');
    document.getElementById('boardSwimlanes').style.display = view === 'swimlanes' ? '' : 'none';
    document.getElementById('boardTimeline').style.display  = view === 'timeline'  ? '' : 'none';
  }

  // ── Load budget ────────────────────────────────────────────────────────────
  async function loadBudget(date) {
    // Show loading skeletons
    document.getElementById('boardLoading').style.display  = '';
    document.getElementById('boardEmpty').style.display    = 'none';
    document.getElementById('boardSwimlanes').style.display = 'none';
    document.getElementById('boardTimeline').style.display  = 'none';
    document.getElementById('editorialNoteWrap').style.display = 'none';
    document.getElementById('budgetStats').style.display = 'none';

    // Populate skeleton tracks
    ['skLeadTrack', 'skStandardTrack'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = renderSkeletonCards(3);
    });

    try {
      var data = await apiFetch('/admin/budget?date=' + date);
      var budget = data.budget || null;
      currentBudget = budget;

      // Hide loading
      document.getElementById('boardLoading').style.display = 'none';

      if (!budget) {
        document.getElementById('boardEmpty').style.display = '';
        // Disable generate button only if today already has one
        updateGenerateBtn(false);
        return;
      }

      // Budget exists — show controls
      updateGenerateBtn(true);

      // Editorial note
      var noteWrap = document.getElementById('editorialNoteWrap');
      noteWrap.style.display = '';
      var noteEl = document.getElementById('editorialNote');
      noteEl.value = budget.editorial_note || '';

      // Sidebar panels
      renderSidebarPanel(budget.coverage_gaps, 'gapsList', 'gapsCount');
      renderSidebarPanel(budget.beat_alerts, 'alertsList', 'alertsCount');
      renderAddSlotPanel(budget.id);

      // Stats
      updateStats(budget.slots || []);

      // Render board
      renderSwimlanes(budget.slots || []);
      renderTimeline(budget.slots || []);
      showView(currentView);

    } catch (err) {
      document.getElementById('boardLoading').style.display = 'none';
      document.getElementById('boardEmpty').style.display = '';
      toast('Failed to load budget: ' + err.message, 'error');
    }
  }

  // ── Update the generate button ─────────────────────────────────────────────
  function updateGenerateBtn(budgetExists) {
    var btn = document.getElementById('generateBudgetBtn');
    if (btn) {
      btn.disabled = budgetExists;
      btn.title = budgetExists ? 'Budget already generated for this date' : 'Generate budget for selected date';
    }
  }

  // ── Sidebar panel helpers ──────────────────────────────────────────────────
  function renderSidebarPanel(items, listId, countId) {
    var list  = document.getElementById(listId);
    var count = document.getElementById(countId);
    if (!list) return;

    if (!items || !items.length) {
      list.innerHTML = '<div class="sidebar-empty">None</div>';
      if (count) count.textContent = '0';
      return;
    }

    if (count) count.textContent = items.length;
    list.innerHTML = items.map(function (item) {
      if (typeof item === 'string') {
        return '<div class="sidebar-item">' + esc(item) + '</div>';
      }
      // item may be an object with { beat, gap, reason, alert } etc.
      var title  = item.beat || item.topic || item.gap || item.alert || '';
      var detail = item.reason || item.detail || '';
      return '<div class="sidebar-item">' +
        (title  ? '<strong>' + esc(title) + '</strong>' : '') +
        (detail ? esc(detail) : '') +
      '</div>';
    }).join('');
  }

  function renderAddSlotPanel(budgetId) {
    var panel = document.getElementById('addSlotPanel');
    if (!panel || !budgetId) return;
    panel.innerHTML = [
      '<div style="display:flex;flex-direction:column;gap:8px;">',
        '<input type="text" id="addSlotHeadline" placeholder="Headline suggestion" style="width:100%;padding:7px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;font-family:inherit;outline:none;" />',
        '<select id="addSlotPriority" style="width:100%;padding:7px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;font-family:inherit;outline:none;cursor:pointer;">',
          '<option value="lead">Lead</option>',
          '<option value="standard" selected>Standard</option>',
          '<option value="brief">Brief</option>',
          '<option value="hold">Hold</option>',
        '</select>',
        '<button class="btn btn-primary btn-sm" id="addSlotSubmitBtn" style="width:100%;justify-content:center;" data-budget-id="' + esc(String(budgetId)) + '">+ Add Slot</button>',
      '</div>',
    ].join('');

    document.getElementById('addSlotSubmitBtn').addEventListener('click', handleAddSlot);
  }

  // ── Generate budget ────────────────────────────────────────────────────────
  async function generateBudget() {
    var btn = document.getElementById('generateBudgetBtn');
    if (btn) btn.disabled = true;
    try {
      var data = await apiFetch('/admin/budget/generate', { method: 'POST', body: JSON.stringify({ date: currentDate }) });
      if (data.budget) {
        currentBudget = data.budget;
        toast('Budget generated!', 'success');
        await loadBudget(currentDate);
      }
    } catch (err) {
      toast('Failed to generate budget: ' + err.message, 'error');
      if (btn) btn.disabled = false;
    }
  }

  // ── Editorial note save (auto-save on blur) ────────────────────────────────
  var noteTimer = null;
  async function saveEditorialNote() {
    if (!currentBudget) return;
    var noteEl  = document.getElementById('editorialNote');
    var statusEl = document.getElementById('editorialNoteSaving');
    if (!noteEl || !statusEl) return;

    var note = noteEl.value;
    statusEl.textContent = 'Saving…';
    try {
      await apiFetch('/admin/budget/' + currentBudget.id, {
        method: 'PATCH',
        body: JSON.stringify({ editorial_note: note }),
      });
      statusEl.textContent = 'Saved.';
      clearTimeout(noteTimer);
      noteTimer = setTimeout(function () { statusEl.textContent = ''; }, 2000);
    } catch (err) {
      statusEl.textContent = 'Save failed.';
    }
  }

  // ── Slot actions ───────────────────────────────────────────────────────────
  async function approveSlot(slotId) {
    var card = document.getElementById('bcard-' + slotId);
    if (card) card.style.opacity = '0.5';
    try {
      var data = await apiFetch('/admin/budget/slots/' + slotId + '/approve', { method: 'POST' });
      if (data.slot) updateCardStatus(slotId, data.slot);
      toast('Slot approved', 'success');
    } catch (err) {
      toast('Approve failed: ' + err.message, 'error');
      if (card) card.style.opacity = '';
    }
  }

  async function rejectSlot(slotId) {
    var card = document.getElementById('bcard-' + slotId);
    if (card) card.style.opacity = '0.5';
    try {
      var data = await apiFetch('/admin/budget/slots/' + slotId + '/reject', { method: 'POST' });
      if (data.slot) updateCardStatus(slotId, data.slot);
      toast('Slot rejected', 'success');
    } catch (err) {
      toast('Reject failed: ' + err.message, 'error');
      if (card) card.style.opacity = '';
    }
  }

  // Update a single card in the DOM after a status change
  function updateCardStatus(slotId, updatedSlot) {
    // Find and update in currentBudget.slots
    if (currentBudget && currentBudget.slots) {
      currentBudget.slots = currentBudget.slots.map(function (s) {
        return s.id === updatedSlot.id ? Object.assign({}, s, updatedSlot) : s;
      });
      updateStats(currentBudget.slots);
    }

    // Re-render the specific card in-place
    var card = document.getElementById('bcard-' + slotId);
    if (!card) return;
    var newHtml = renderCard(updatedSlot);
    var tmp = document.createElement('div');
    tmp.innerHTML = newHtml;
    var newCard = tmp.firstChild;
    if (newCard) {
      card.parentNode.replaceChild(newCard, card);
      startCountdownTimers();
    }
  }

  // ── Edit headline inline ───────────────────────────────────────────────────
  function startHeadlineEdit(slotId) {
    var card = document.getElementById('bcard-' + slotId);
    if (!card) return;

    var headlineEl = card.querySelector('.card-headline');
    if (!headlineEl) return;

    var currentText = headlineEl.textContent;

    // Replace the div with an input
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'card-headline-input';
    input.value = currentText;
    headlineEl.parentNode.replaceChild(input, headlineEl);
    input.focus();
    input.select();

    // Replace edit button with save/cancel
    var actionsEl = card.querySelector('.card-actions');
    var editBtn = actionsEl ? actionsEl.querySelector('[data-action="edit-headline"]') : null;
    if (editBtn) {
      editBtn.outerHTML = [
        '<button class="card-btn cb-save" data-action="save-headline" data-id="' + esc(String(slotId)) + '" title="Save">&#10003; <span class="cb-label">Save</span></button>',
        '<button class="card-btn cb-cancel" data-action="cancel-headline" data-id="' + esc(String(slotId)) + '" title="Cancel">&#10005;</button>',
      ].join('');
    }

    // Save on Enter, cancel on Escape
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveHeadline(slotId, input.value); }
      if (e.key === 'Escape') { cancelHeadlineEdit(slotId, currentText); }
    });
    input.addEventListener('blur', function () {
      // Small delay to allow save/cancel button click to fire first
      setTimeout(function () {
        var card2 = document.getElementById('bcard-' + slotId);
        if (card2 && card2.querySelector('.card-headline-input')) {
          saveHeadline(slotId, input.value);
        }
      }, 200);
    });
  }

  function cancelHeadlineEdit(slotId, originalText) {
    var card = document.getElementById('bcard-' + slotId);
    if (!card) return;
    var input = card.querySelector('.card-headline-input');
    if (!input) return;

    var div = document.createElement('div');
    div.className = 'card-headline';
    div.textContent = originalText;
    input.parentNode.replaceChild(div, input);

    // Restore edit button
    var saveBtn = card.querySelector('[data-action="save-headline"]');
    var cancelBtn = card.querySelector('[data-action="cancel-headline"]');
    if (saveBtn) {
      saveBtn.outerHTML = '<button class="card-btn cb-edit" data-action="edit-headline" data-id="' + esc(String(slotId)) + '" title="Edit headline">&#9998; <span class="cb-label">Edit</span></button>';
    }
    if (cancelBtn) cancelBtn.remove();
  }

  async function saveHeadline(slotId, newHeadline) {
    newHeadline = (newHeadline || '').trim();
    if (!newHeadline) { return; }

    var card = document.getElementById('bcard-' + slotId);
    if (!card) return;

    // Restore the headline div immediately (optimistic)
    var input = card.querySelector('.card-headline-input');
    if (input) {
      var div = document.createElement('div');
      div.className = 'card-headline';
      div.textContent = newHeadline;
      input.parentNode.replaceChild(div, input);
    }

    // Restore edit button
    var saveBtn = card.querySelector('[data-action="save-headline"]');
    var cancelBtn = card.querySelector('[data-action="cancel-headline"]');
    if (saveBtn) {
      saveBtn.outerHTML = '<button class="card-btn cb-edit" data-action="edit-headline" data-id="' + esc(String(slotId)) + '" title="Edit headline">&#9998; <span class="cb-label">Edit</span></button>';
    }
    if (cancelBtn) cancelBtn.remove();

    try {
      await apiFetch('/admin/budget/slots/' + slotId, {
        method: 'PATCH',
        body: JSON.stringify({ headline_suggestion: newHeadline }),
      });
      // Update in-memory
      if (currentBudget && currentBudget.slots) {
        currentBudget.slots = currentBudget.slots.map(function (s) {
          return s.id === slotId ? Object.assign({}, s, { headline_suggestion: newHeadline }) : s;
        });
      }
    } catch (err) {
      toast('Failed to save headline: ' + err.message, 'error');
    }
  }

  // ── Reassign ───────────────────────────────────────────────────────────────
  function openReassignModal(slotId) {
    reassignSlotId = slotId;
    var sel = document.getElementById('reassignWriterSelect');
    if (sel) {
      if (!writersLoaded) {
        sel.innerHTML = '<option value="">Loading writers…</option>';
        loadWriters().then(function () { populateReassignSelect(); });
      } else {
        populateReassignSelect();
      }
    }
    if (typeof openModal === 'function') openModal('reassignModal');
  }

  function populateReassignSelect() {
    var sel = document.getElementById('reassignWriterSelect');
    if (!sel) return;
    var options = '<option value="">— Pick a writer —</option>';
    writers.forEach(function (w) {
      options += '<option value="' + esc(String(w.id)) + '">' + esc(w.name) + '</option>';
    });
    sel.innerHTML = options;

    // Pre-select current writer if possible
    if (reassignSlotId && currentBudget && currentBudget.slots) {
      var slot = currentBudget.slots.find(function (s) { return s.id === reassignSlotId; });
      if (slot && slot.assigned_writer_id) sel.value = String(slot.assigned_writer_id);
    }
  }

  async function confirmReassign() {
    var sel = document.getElementById('reassignWriterSelect');
    if (!sel || !reassignSlotId) return;
    var writerId = sel.value;
    if (!writerId) { toast('Select a writer first', 'error'); return; }

    try {
      var data = await apiFetch('/admin/budget/slots/' + reassignSlotId + '/reassign', {
        method: 'POST',
        body: JSON.stringify({ writer_id: parseInt(writerId, 10) }),
      });
      if (data.slot) updateCardStatus(reassignSlotId, data.slot);
      toast('Writer reassigned', 'success');
      if (typeof closeModal === 'function') closeModal('reassignModal');
    } catch (err) {
      toast('Reassign failed: ' + err.message, 'error');
    }
  }

  // ── Load writers ───────────────────────────────────────────────────────────
  async function loadWriters() {
    try {
      var data = await apiFetch('/admin/writers');
      writers = (data.writers || []).map(function (w) {
        return { id: w.id, name: w.name || w.persona_name || '', avatar_url: w.avatar_url || '' };
      });
      writersLoaded = true;
    } catch (_) {
      writersLoaded = true; // don't block UI
    }
  }

  // ── Add slot ───────────────────────────────────────────────────────────────
  async function handleAddSlot(e) {
    var budgetId = e.target.dataset.budgetId;
    if (!budgetId) return;

    var headlineEl  = document.getElementById('addSlotHeadline');
    var priorityEl  = document.getElementById('addSlotPriority');
    var headline    = headlineEl ? headlineEl.value.trim() : '';
    var priority    = priorityEl ? priorityEl.value : 'standard';

    if (!headline) { toast('Enter a headline first', 'error'); return; }

    var btn = document.getElementById('addSlotSubmitBtn');
    if (btn) btn.disabled = true;

    try {
      // Try the slots create endpoint; endpoint may not exist yet in the parallel build
      var data = await apiFetch('/admin/budget/' + budgetId + '/slots', {
        method: 'POST',
        body: JSON.stringify({ headline_suggestion: headline, priority: priority }),
      });
      if (data.slot) {
        if (currentBudget) {
          currentBudget.slots = currentBudget.slots || [];
          currentBudget.slots.push(data.slot);
          renderSwimlanes(currentBudget.slots);
          renderTimeline(currentBudget.slots);
          showView(currentView);
          updateStats(currentBudget.slots);
        }
        if (headlineEl) headlineEl.value = '';
        toast('Slot added', 'success');
      }
    } catch (err) {
      toast('Could not add slot: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Delegated click handler for card action buttons ────────────────────────
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;

    var action  = btn.dataset.action;
    var slotId  = parseInt(btn.dataset.id, 10);
    if (!slotId) return;

    if (action === 'approve')          { approveSlot(slotId); }
    if (action === 'reject')           { rejectSlot(slotId); }
    if (action === 'edit-headline')    { startHeadlineEdit(slotId); }
    if (action === 'save-headline')    {
      var card = document.getElementById('bcard-' + slotId);
      var input = card && card.querySelector('.card-headline-input');
      if (input) saveHeadline(slotId, input.value);
    }
    if (action === 'cancel-headline')  {
      var card2 = document.getElementById('bcard-' + slotId);
      var hl = card2 && card2.querySelector('.card-headline');
      cancelHeadlineEdit(slotId, hl ? hl.textContent : '');
    }
    if (action === 'reassign')         { openReassignModal(slotId); }
  });

  // ── View toggle ────────────────────────────────────────────────────────────
  document.getElementById('viewSwimlanes').addEventListener('click', function () { showView('swimlanes'); });
  document.getElementById('viewTimeline').addEventListener('click',  function () { showView('timeline'); });

  // ── Generate button ────────────────────────────────────────────────────────
  document.getElementById('generateBudgetBtn').addEventListener('click', generateBudget);
  document.getElementById('generateBudgetEmptyBtn').addEventListener('click', generateBudget);

  // ── Date picker ────────────────────────────────────────────────────────────
  var datePicker = document.getElementById('budgetDatePicker');
  datePicker.value = currentDate;
  datePicker.addEventListener('change', function () {
    currentDate = datePicker.value;
    loadBudget(currentDate);
  });

  // ── Editorial note: auto-save on blur ──────────────────────────────────────
  document.getElementById('editorialNote').addEventListener('blur', saveEditorialNote);

  // ── Reassign modal confirm ─────────────────────────────────────────────────
  document.getElementById('confirmReassignBtn').addEventListener('click', confirmReassign);

  // ── Sidebar mobile toggle ──────────────────────────────────────────────────
  document.getElementById('sidebarToggleBtn').addEventListener('click', function () {
    var sidebar = document.getElementById('budgetSidebar');
    if (sidebar) sidebar.classList.toggle('sidebar-open');
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  requireAuth();
  renderSidebar();
  initModals();
  loadWriters();
  loadBudget(currentDate);

})();
