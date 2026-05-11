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
  var currentActuals   = null;          // data from /admin/budget/actuals
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

  // ── Missed window badge ────────────────────────────────────────────────────
  function missedWindowHtml(slot) {
    if (!slot.target_publish_at) return '';
    var t = new Date(slot.target_publish_at).getTime();
    if (isNaN(t) || t > Date.now()) return '';
    if (slot.status === 'pending') {
      return '<div class="card-missed-badge">&#9888; Window passed — approve or reassign</div>';
    }
    return '';
  }

  // ── Drop window ISO times (based on currently-viewed date) ────────────────
  // Default windows: 07:00, 12:00, 18:00 in local time.
  var DROP_WINDOWS = [
    { label: '7 AM',   hhmm: '07:00' },
    { label: '12 PM',  hhmm: '12:00' },
    { label: '6 PM',   hhmm: '18:00' },
  ];

  function dropWindowAt(hhmm) {
    // Construct a local-time datetime for currentDate at HH:MM
    return new Date(currentDate + 'T' + hhmm + ':00').toISOString();
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
    var sid         = esc(String(slot.id));

    // Action buttons — only show contextually appropriate ones
    var approveBtn = status !== 'approved'
      ? '<button class="card-btn cb-approve" data-action="approve" data-id="' + sid + '" title="Approve slot">&#10003; <span class="cb-label">Approve</span></button>'
      : '';
    var rejectBtn  = status !== 'rejected'
      ? '<button class="card-btn cb-reject" data-action="reject" data-id="' + sid + '" title="Reject slot">&#10005; <span class="cb-label">Reject</span></button>'
      : '';
    var reassignBtn = '<button class="card-btn cb-reassign" data-action="reassign" data-id="' + sid + '" title="Reassign writer">&#8635; <span class="cb-label">Reassign</span></button>';

    // Reschedule / Publish Now buttons
    var publishNowBtn = '';
    var rescheduleBtn2 = '';
    if (status !== 'rejected') {
      if ((status === 'approved' || status === 'auto_promoted') && slot.spawned_article_id) {
        publishNowBtn = '<button class="card-btn cb-publish-now" data-action="publish-now" data-id="' + sid + '" data-article-id="' + esc(String(slot.spawned_article_id)) + '" title="Publish this article immediately">&#8593; <span class="cb-label">Now</span></button>';
      }
      rescheduleBtn2 = '<button class="card-btn cb-reschedule" data-action="open-reschedule" data-id="' + sid + '" title="Change drop window">&#128336; <span class="cb-label">Reschedule</span></button>';
    }

    // Countdown (if slot is pending and has auto_promote_at)
    var cdown = (status === 'pending' && slot.auto_promote_at) ? countdownHtml(slot.id, slot.auto_promote_at) : '';

    // Missed window warning
    var missed = missedWindowHtml(slot);

    return [
      '<div class="budget-card bc-' + esc(status) + '" id="bcard-' + esc(String(slot.id)) + '" data-slot-id="' + sid + '">',
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
        missed,
        cdown,
        '<div class="card-actions">',
          approveBtn,
          rejectBtn,
          reassignBtn,
          publishNowBtn,
          rescheduleBtn2,
        '</div>',
      '</div>',
    ].join('');
  }

  // ── Render an actual published/scheduled article card ─────────────────────
  function renderActualCard(article) {
    var name    = article.writer_name || '';
    var initial = (name || '?').charAt(0).toUpperCase();
    var avatarHtml = article.writer_avatar
      ? '<img class="card-writer-avatar" src="' + esc(article.writer_avatar) + '" alt="" />'
      : '<div class="card-writer-placeholder">' + esc(initial) + '</div>';
    var time      = article.published_at || article.publish_at;
    var isPublished = !!article.is_published;
    var statusCls   = isPublished ? 'bc-approved' : 'bc-pending';
    var badgeCls    = isPublished ? 'badge-success' : 'badge-muted';
    var badgeLabel  = isPublished ? 'Published' : 'Scheduled';
    var typeLabel   = article.content_type === 'deep-dive' ? 'Deep Dive'
                    : article.content_type === 'original'  ? 'Original'
                    : esc(article.content_type || '');

    return [
      '<div class="budget-card actual-card ' + esc(statusCls) + '">',
        '<div class="card-top">',
          '<div class="card-headline">',
            '<button class="actual-link" data-preview-slug="' + esc(article.slug || '') + '" title="' + esc(article.title || '') + '">',
              esc(article.title || 'Untitled'),
            '</button>',
          '</div>',
          '<span class="badge ' + esc(badgeCls) + '">' + badgeLabel + '</span>',
        '</div>',
        '<div class="card-meta-row">',
          typeLabel ? '<span class="actual-tag">' + typeLabel + '</span>' : '',
        '</div>',
        '<div class="card-meta-row">',
          '<div class="card-writer">',
            avatarHtml,
            '<span>' + esc(name || 'Unassigned') + '</span>',
          '</div>',
          time ? '<span class="card-publish-time">' + esc(formatTime(time)) + '</span>' : '',
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

  function renderSwimlanes(slots, actuals) {
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

    // Unplanned lane — originals with no slot linkage
    if (actuals) {
      var allArticles = (actuals.published || []).concat(actuals.scheduled || []);
      var unplanned   = allArticles.filter(function (a) { return !a.slot_id; });
      if (unplanned.length) {
        html += [
          '<div class="swimlane" data-priority="unplanned">',
            '<div class="swimlane-header">',
              '<span class="swimlane-label sl-unplanned">Unplanned</span>',
              '<span class="swimlane-count">' + unplanned.length + '</span>',
            '</div>',
            '<div class="swimlane-track">',
              unplanned.map(renderActualCard).join(''),
            '</div>',
          '</div>',
        ].join('');
      }

      // Deep Dives — rolling 7-day window, independent of the daily plan
      var deepDives = actuals.deep_dives || [];
      if (deepDives.length) {
        html += [
          '<div class="swimlane" data-priority="deep-dives">',
            '<div class="swimlane-header">',
              '<span class="swimlane-label sl-deepdive">Deep Dives</span>',
              '<span class="swimlane-count">' + deepDives.length + '</span>',
              '<span class="swimlane-sublabel">Last 7 days</span>',
            '</div>',
            '<div class="swimlane-track">',
              deepDives.map(renderActualCard).join(''),
            '</div>',
          '</div>',
        ].join('');
      }
    }

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

  function renderTimeline(slots, actuals) {
    var board = document.getElementById('boardTimeline');
    if (!board) return;

    // Group actual articles by window key
    var actualsByWindow = {};
    WINDOWS.forEach(function (w) { actualsByWindow[w.key] = []; });
    if (actuals) {
      var allArticles = (actuals.published || []).concat(actuals.scheduled || []);
      allArticles.forEach(function (a) {
        var t = a.published_at || a.publish_at;
        WINDOWS.forEach(function (w) {
          if (w.test(t)) actualsByWindow[w.key].push(a);
        });
      });
    }

    // Build a fired-window lookup keyed by broad time bucket
    var firedKeys = {};
    if (actuals && actuals.drop_windows) {
      actuals.drop_windows.forEach(function (dw) {
        if (!dw.fired) return;
        var h = new Date(dw.iso).getHours();
        if (h < 6)       firedKeys['Early Morning'] = true;
        else if (h < 12) firedKeys['Morning']       = true;
        else if (h < 18) firedKeys['Afternoon']     = true;
        else             firedKeys['Evening']        = true;
      });
    }

    var html = '';
    WINDOWS.forEach(function (win) {
      var inWindow       = (slots || []).filter(function (s) { return win.test(s.target_publish_at); });
      var actualArticles = actualsByWindow[win.key] || [];
      if (!inWindow.length && !actualArticles.length) return;

      var firedBadge = firedKeys[win.key]
        ? '<span class="timeline-fired-badge">&#10003; Fired</span>'
        : '';

      var slotsHtml   = inWindow.length
        ? '<div class="timeline-card-grid">' + inWindow.map(renderCard).join('') + '</div>'
        : '';
      var actualsHtml = actualArticles.length
        ? [
            '<div class="timeline-actuals-section">',
              '<div class="timeline-actuals-label">Actuals (' + actualArticles.length + ')</div>',
              '<div class="timeline-actuals-grid">',
                actualArticles.map(renderActualCard).join(''),
              '</div>',
            '</div>',
          ].join('')
        : '';

      html += [
        '<div class="timeline-section">',
          '<div class="timeline-section-header">',
            '<span class="timeline-section-label">' + esc(win.label) + '</span>',
            '<span class="timeline-section-time">' + esc(win.time) + '</span>',
            inWindow.length ? '<span class="swimlane-count" style="margin-left:4px;">' + inWindow.length + '</span>' : '',
            firedBadge,
          '</div>',
          slotsHtml,
          actualsHtml,
        '</div>',
      ].join('');
    });

    // Deep Dives section — rolling 7-day window, appended below the daily timeline
    var deepDivesTimeline = actuals && actuals.deep_dives || [];
    if (deepDivesTimeline.length) {
      html += [
        '<div class="timeline-section">',
          '<div class="timeline-section-header">',
            '<span class="timeline-section-label">Deep Dives</span>',
            '<span class="timeline-section-time">Last 7 days</span>',
            '<span class="swimlane-count" style="margin-left:4px;">' + deepDivesTimeline.length + '</span>',
          '</div>',
          '<div class="timeline-actuals-section">',
            '<div class="timeline-actuals-grid">',
              deepDivesTimeline.map(renderActualCard).join(''),
            '</div>',
          '</div>',
        '</div>',
      ].join('');
    }

    if (!html) {
      html = '<div class="budget-empty"><div class="budget-empty-icon">&#128197;</div><h2>No slots with times</h2><p>Assign target publish times to see them in the timeline view.</p></div>';
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

  // ── Render actuals strip ──────────────────────────────────────────────────
  function renderActualsStrip(actuals) {
    var strip = document.getElementById('actualsStrip');
    if (!strip) return;

    if (!actuals) {
      strip.innerHTML = '';
      strip.className = '';
      return;
    }

    var cap   = actuals.cap;
    var pub   = cap.today;
    var sched = actuals.scheduled.length;

    var capHtml = '';
    if (cap.effective > 0) {
      var pct       = Math.min(100, Math.round((pub / cap.effective) * 100));
      var isFull    = pub >= cap.effective;
      var fillClr   = isFull ? 'var(--success)' : 'var(--accent)';
      var valCls    = isFull ? ' actuals-cap-full' : '';
      capHtml = [
        '<div class="actuals-cap">',
          '<span class="actuals-cap-label">Published</span>',
          '<span class="actuals-cap-val' + valCls + '">' + pub + ' / ' + cap.effective + '</span>',
          '<div class="actuals-cap-bar">',
            '<div class="actuals-cap-fill" style="width:' + pct + '%;background:' + fillClr + '"></div>',
          '</div>',
        '</div>',
      ].join('');
    } else {
      capHtml = '<div class="actuals-cap"><span class="actuals-cap-label">Published</span><span class="actuals-cap-val">' + pub + ' (no cap)</span></div>';
    }

    var windowsHtml = (actuals.drop_windows || []).map(function (w) {
      var icon = w.fired ? '&#10003;' : '&#9675;';
      var cls  = w.fired ? 'actuals-win-fired' : 'actuals-win-upcoming';
      return '<span class="actuals-window ' + cls + '">' + icon + ' ' + esc(w.label) + '</span>';
    }).join('');

    var schedHtml = sched > 0
      ? '<span class="actuals-queued">&#9654; ' + sched + ' queued</span>'
      : '';

    strip.className = 'actuals-strip';
    strip.innerHTML = [
      '<div class="actuals-strip-inner">',
        capHtml,
        windowsHtml ? '<div class="actuals-windows">' + windowsHtml + '</div>' : '',
        schedHtml   ? '<div class="actuals-queue">'   + schedHtml   + '</div>' : '',
      '</div>',
    ].join('');
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
    // Reset actuals strip for the new date
    currentActuals = null;
    renderActualsStrip(null);

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

    // Load actuals concurrently — will re-render strip + boards when ready
    loadActuals(date);

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

      // Render board (include actuals if they arrived before the budget fetch completed)
      renderSwimlanes(budget.slots || [], currentActuals);
      renderTimeline(budget.slots || [], currentActuals);
      showView(currentView);

    } catch (err) {
      document.getElementById('boardLoading').style.display = 'none';
      document.getElementById('boardEmpty').style.display = '';
      toast('Failed to load runsheet: ' + err.message, 'error');
    }
  }

  // ── Load actuals (concurrent with loadBudget) ──────────────────────────────
  async function loadActuals(date) {
    try {
      var data = await apiFetch('/admin/budget/actuals?date=' + date);
      if (date !== currentDate) return; // stale — date changed while fetching
      currentActuals = data;
      renderActualsStrip(data);
      // If budget is already rendered, re-render boards with actuals
      if (currentBudget) {
        renderSwimlanes(currentBudget.slots || [], currentActuals);
        renderTimeline(currentBudget.slots || [], currentActuals);
        showView(currentView);
      }
    } catch (_) {
      // Actuals are additive — fail silently
    }
  }

  // ── Update the generate button ─────────────────────────────────────────────
  function updateGenerateBtn(budgetExists) {
    var btn = document.getElementById('generateBudgetBtn');
    if (!btn) return;
    btn.disabled = false;
    btn.dataset.force = budgetExists ? 'true' : '';
    var label = btn.querySelector('.gen-label') || btn;
    if (budgetExists) {
      btn.title = 'Delete and regenerate today\'s runsheet from scratch';
      if (label !== btn) label.textContent = 'Regenerate';
      else btn.innerHTML = btn.innerHTML.replace(/Generate Runsheet|Regenerate/, 'Regenerate');
    } else {
      btn.title = 'Generate runsheet for selected date';
      if (label !== btn) label.textContent = 'Generate Runsheet';
      else btn.innerHTML = btn.innerHTML.replace(/Generate Runsheet|Regenerate/, 'Generate Runsheet');
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
    var force = btn && btn.dataset.force === 'true';
    if (btn) btn.disabled = true;
    try {
      var url = '/admin/budget/generate' + (force ? '?force=true' : '');
      var data = await apiFetch(url, { method: 'POST', body: JSON.stringify({ date: currentDate }) });
      if (data.budget) {
        currentBudget = data.budget;
        toast(force ? 'Runsheet regenerated!' : 'Runsheet generated!', 'success');
        await loadBudget(currentDate);
      }
    } catch (err) {
      toast('Failed to generate runsheet: ' + err.message, 'error');
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

  // ── Reschedule inline ──────────────────────────────────────────────────────
  function openRescheduleInline(slotId) {
    var card = document.getElementById('bcard-' + slotId);
    if (!card) return;
    var btn = card.querySelector('[data-action="open-reschedule"]');
    if (!btn) return;

    var sid = esc(String(slotId));
    var windowBtns = DROP_WINDOWS.map(function (w) {
      return '<button class="card-btn cb-reschedule-opt" data-action="reschedule-window" data-id="' + sid + '" data-time="' + esc(dropWindowAt(w.hhmm)) + '">' + esc(w.label) + '</button>';
    }).join('');

    var wrap = document.createElement('div');
    wrap.className = 'card-reschedule-picker';
    wrap.id = 'reschedule-picker-' + slotId;
    wrap.innerHTML = [
      '<span class="card-reschedule-label">Move to:</span>',
      windowBtns,
      '<button class="card-btn cb-reschedule-opt" data-action="reschedule-custom" data-id="' + sid + '">Custom&#8230;</button>',
      '<button class="card-btn cb-cancel" data-action="reschedule-cancel" data-id="' + sid + '">&#10005;</button>',
    ].join('');

    btn.parentNode.replaceChild(wrap, btn);
  }

  function closeRescheduleInline(slotId) {
    var card = document.getElementById('bcard-' + slotId);
    if (!card) return;
    var picker = document.getElementById('reschedule-picker-' + slotId);
    if (!picker) return;
    var btn = document.createElement('button');
    btn.className = 'card-btn cb-reschedule';
    btn.dataset.action = 'open-reschedule';
    btn.dataset.id = String(slotId);
    btn.title = 'Change drop window';
    btn.innerHTML = '&#128336; <span class="cb-label">Reschedule</span>';
    picker.parentNode.replaceChild(btn, picker);
  }

  async function rescheduleSlot(slotId, isoTime) {
    var card = document.getElementById('bcard-' + slotId);
    if (card) card.style.opacity = '0.5';
    closeRescheduleInline(slotId);

    var slot = currentBudget && currentBudget.slots
      ? currentBudget.slots.find(function (s) { return s.id === slotId; })
      : null;

    try {
      // Update budget slot target_publish_at
      var data = await apiFetch('/admin/budget/slots/' + slotId, {
        method: 'PATCH',
        body: JSON.stringify({ target_publish_at: isoTime }),
      });
      if (data.slot) {
        updateCardStatus(slotId, data.slot);
        // Also reschedule the spawned article if it exists
        if (slot && slot.spawned_article_id) {
          await apiFetch('/articles/' + slot.spawned_article_id + '/reschedule', {
            method: 'PUT',
            body: JSON.stringify({ action: 'window', publish_at: isoTime }),
          }).catch(function () { /* article may already be published, ignore */ });
        }
        toast('Rescheduled to ' + formatTime(isoTime), 'success');
      }
    } catch (err) {
      toast('Reschedule failed: ' + err.message, 'error');
      if (card) card.style.opacity = '';
    }
  }

  function openCustomReschedule(slotId) {
    var card = document.getElementById('bcard-' + slotId);
    if (!card) return;
    var picker = document.getElementById('reschedule-picker-' + slotId);
    if (!picker) return;

    var sid = esc(String(slotId));
    // Replace picker row with a time input + confirm
    picker.innerHTML = [
      '<input type="time" class="card-time-input" id="custom-time-' + sid + '" value="07:00" />',
      '<button class="card-btn cb-save" data-action="reschedule-custom-confirm" data-id="' + sid + '">Set</button>',
      '<button class="card-btn cb-cancel" data-action="reschedule-cancel" data-id="' + sid + '">&#10005;</button>',
    ].join('');
    var input = document.getElementById('custom-time-' + slotId);
    if (input) {
      input.focus();
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirmCustomReschedule(slotId);
        }
        if (e.key === 'Escape') closeRescheduleInline(slotId);
      });
    }
  }

  function confirmCustomReschedule(slotId) {
    var input = document.getElementById('custom-time-' + slotId);
    if (!input || !input.value) return;
    var isoTime = new Date(currentDate + 'T' + input.value + ':00').toISOString();
    rescheduleSlot(slotId, isoTime);
  }

  // ── Publish Now ────────────────────────────────────────────────────────────
  async function publishNowSlot(articleId, slotId) {
    var card = document.getElementById('bcard-' + slotId);
    if (card) card.style.opacity = '0.5';
    try {
      await apiFetch('/articles/' + articleId + '/reschedule', {
        method: 'PUT',
        body: JSON.stringify({ action: 'now' }),
      });
      toast('Article published immediately', 'success');
      // Reload the budget to get fresh slot state
      await loadBudget(currentDate);
    } catch (err) {
      toast('Publish failed: ' + err.message, 'error');
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
      writers = (Array.isArray(data) ? data : (data.writers || [])).map(function (w) {
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
          renderSwimlanes(currentBudget.slots, currentActuals);
          renderTimeline(currentBudget.slots, currentActuals);
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
    var previewBtn = e.target.closest('[data-preview-slug]');
    if (previewBtn) {
      var slug = previewBtn.dataset.previewSlug;
      if (slug && typeof showArticlePreviewBySlug === 'function') {
        showArticlePreviewBySlug(slug);
      }
      return;
    }

    var btn = e.target.closest('[data-action]');
    if (!btn) return;

    var action  = btn.dataset.action;
    var slotId  = parseInt(btn.dataset.id, 10);
    if (!slotId) return;

    if (action === 'approve')          { approveSlot(slotId); }
    if (action === 'reject')           { rejectSlot(slotId); }
    if (action === 'reassign')               { openReassignModal(slotId); }
    if (action === 'open-reschedule')        { openRescheduleInline(slotId); }
    if (action === 'reschedule-cancel')      { closeRescheduleInline(slotId); }
    if (action === 'reschedule-window')      { rescheduleSlot(slotId, btn.dataset.time); }
    if (action === 'reschedule-custom')      { openCustomReschedule(slotId); }
    if (action === 'reschedule-custom-confirm') { confirmCustomReschedule(slotId); }
    if (action === 'publish-now')            { publishNowSlot(parseInt(btn.dataset.articleId, 10), slotId); }
  });

  // ── View toggle ────────────────────────────────────────────────────────────
  document.getElementById('viewSwimlanes').addEventListener('click', function () { showView('swimlanes'); });
  document.getElementById('viewTimeline').addEventListener('click',  function () { showView('timeline'); });

  // ── Generate budget button ─────────────────────────────────────────────────
  document.getElementById('generateBudgetBtn').addEventListener('click', generateBudget);
  document.getElementById('generateBudgetEmptyBtn').addEventListener('click', generateBudget);

  // ── Audio Briefing panel (multi-edition) ──────────────────────────────────
  (function () {
    var EDITIONS = [
      { key: 'morning',   label: 'Morning Edition',  time: '8:00 AM',  color: '#f59e0b' },
      { key: 'afternoon', label: 'Afternoon Update', time: '1:00 PM',  color: '#3b82f6' },
      { key: 'evening',   label: 'Evening Report',   time: '6:00 PM',  color: '#8b5cf6' },
    ];

    var container = document.getElementById('briefingPanelContainer');
    if (!container) return;

    function buildEditionRow(ed) {
      var row = document.createElement('div');
      row.className = 'briefing-edition-row';
      row.id = 'brief-row-' + ed.key;
      row.innerHTML = '<div class="brief-ed-info">'
        + '<span class="brief-ed-dot" style="background:' + ed.color + ';"></span>'
        + '<span class="brief-ed-label">' + ed.label + '</span>'
        + '<span class="brief-ed-time">' + ed.time + '</span>'
        + '</div>'
        + '<div class="brief-ed-controls" id="brief-ctrl-' + ed.key + '">'
        + '<button class="btn btn-outline btn-sm brief-gen-btn" id="brief-btn-' + ed.key + '" data-edition="' + ed.key + '">'
        + '<svg style="width:12px;height:12px;flex-shrink:0;" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53L6.75 15.75H4.5a.75.75 0 01-.75-.75v-6a.75.75 0 01.75-.75H6.75z" /></svg>'
        + ' <span class="brief-btn-label-' + ed.key + '">Generate</span>'
        + '</button>'
        + '</div>';
      return row;
    }

    EDITIONS.forEach(function (ed) { container.appendChild(buildEditionRow(ed)); });

    function applyBriefingState(edKey, briefing) {
      var btn   = document.getElementById('brief-btn-' + edKey);
      var ctrl  = document.getElementById('brief-ctrl-' + edKey);
      var label = btn && btn.querySelector('.brief-btn-label-' + edKey);
      if (!btn || !label) return;

      if (!briefing) return; // not yet generated — default "Generate" state is fine

      var STUCK_MS = 5 * 60 * 1000; // 5 minutes

      if (briefing.status === 'ready') {
        label.textContent = '✓ Ready';
        btn.classList.add('btn-success-muted');
        if (briefing.audio_url) {
          // Insert inline audio player
          var existing = ctrl.querySelector('.brief-audio-wrap');
          if (!existing) {
            var wrap = document.createElement('div');
            wrap.className = 'brief-audio-wrap';
            wrap.style.cssText = 'display:flex;align-items:center;gap:6px;margin-left:8px;';
            wrap.innerHTML = '<audio src="' + briefing.audio_url + '" preload="none" controls style="height:26px;max-width:180px;"></audio>'
              + '<a href="' + briefing.audio_url + '" target="_blank" style="color:var(--muted);font-size:11px;">↗</a>';
            ctrl.appendChild(wrap);
          }
        }
      } else if (briefing.status === 'pending') {
        var age = Date.now() - new Date(briefing.updated_at || briefing.created_at).getTime();
        if (age > STUCK_MS) {
          label.textContent = 'Stuck — Retry';
          btn.title = 'Generation appears stuck (>5 min) — click to force retry';
        } else {
          label.textContent = 'Generating…';
          btn.disabled = true;
        }
      } else if (briefing.status === 'error') {
        label.textContent = 'Failed — Retry';
      }
    }

    // Load today's briefings
    apiFetch('/admin/budget/briefing').then(function (data) {
      var briefings = data.briefings || [];
      var byEdition = {};
      briefings.forEach(function (b) { byEdition[b.edition] = b; });
      EDITIONS.forEach(function (ed) { applyBriefingState(ed.key, byEdition[ed.key]); });
    }).catch(function () {});

    // Wire generate buttons
    container.addEventListener('click', async function (e) {
      var btn = e.target.closest('.brief-gen-btn');
      if (!btn) return;
      var edition = btn.dataset.edition;
      var label   = btn.querySelector('.brief-btn-label-' + edition);
      if (!label) return;
      btn.disabled = true;
      label.textContent = 'Generating…';
      try {
        var data = await apiFetch('/admin/budget/briefing/generate', {
          method: 'POST',
          body: JSON.stringify({ force: true, edition }),
        });
        if (data.ok) {
          applyBriefingState(edition, { status: 'ready', audio_url: data.audio_url });
          btn.disabled = false;
        } else {
          label.textContent = 'Failed — Retry';
          btn.disabled = false;
        }
      } catch (err) {
        label.textContent = 'Failed — Retry';
        btn.disabled = false;
      }
    });
  })();

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
