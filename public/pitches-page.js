/**
 * Pitches Page — story pitch management + newsroom feed.
 */
(function () {
  var writers = [];
  var activeTab = 'pitches';

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Tabs ──────────────────────────────────────────────────

  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      document.getElementById('pitchesSection').style.display = activeTab === 'pitches' ? '' : 'none';
      document.getElementById('newsroomSection').style.display = activeTab === 'newsroom' ? '' : 'none';
      if (activeTab === 'newsroom') loadNewsroom();
    });
  });

  // ── Pitches ───────────────────────────────────────────────

  async function loadPitches() {
    var status = document.getElementById('pitchStatusFilter').value;
    var writerId = document.getElementById('pitchWriterFilter').value;

    var url = '/admin/pitches?status=' + status;
    if (writerId !== 'all') url += '&writer_id=' + writerId;

    try {
      var data = await apiFetch(url);
      var pitches = data.pitches || [];
      renderPitches(pitches);

      // Update badge
      var countData = await apiFetch('/admin/pitches/count');
      var badge = document.getElementById('pendingBadge');
      if (badge) {
        badge.textContent = countData.count || '';
        badge.style.display = countData.count ? 'inline-flex' : 'none';
      }
    } catch (err) {
      showAlert('Failed to load pitches: ' + err.message, 'error');
    }
  }

  function renderPitches(pitches) {
    var grid = document.getElementById('pitchGrid');
    if (!pitches.length) {
      grid.innerHTML = '<div style="text-align:center;padding:40px;grid-column:1/-1;color:var(--muted);">No pitches found. Writer agents will generate pitches when they spot stories worth covering.</div>';
      return;
    }

    grid.innerHTML = pitches.map(function (p) {
      var typeLabels = { new_story: 'New Story', follow_up: 'Follow-Up', roundup: 'Roundup', prediction_check: 'Prediction Check' };
      var sourceCount = (p.source_article_ids || []).length;
      var memRefs = (p.memory_refs || []);

      // Source-count chip (red 1 / amber 2 / green 3+)
      var sc = sourceCount || 1;
      var chipColor, chipLabel;
      if (sc <= 1) {
        chipColor = 'background:rgba(239,68,68,0.18);color:#ef4444;';
        chipLabel = '1 source &#9888;';
      } else if (sc === 2) {
        chipColor = 'background:rgba(251,191,36,0.18);color:#fbbf24;';
        chipLabel = '2 sources';
      } else {
        chipColor = 'background:rgba(34,197,94,0.18);color:#22c55e;';
        chipLabel = sc + ' sources &#10003;';
      }
      var sourceChip = '<span class="badge badge-muted" title="Attached source count" style="' + chipColor + 'font-size:11px;">' + chipLabel + '</span>';
      var priorityStars = '';
      for (var i = 0; i < Math.round((p.priority || 5) / 2); i++) priorityStars += '*';

      var avatar = p.writer_avatar_url
        ? '<img src="' + esc(p.writer_avatar_url) + '" class="pitch-avatar" />'
        : '<div class="pitch-avatar-placeholder">&#9997;&#65039;</div>';

      var actions = '';
      if (p.status === 'pending') {
        actions = '<button class="btn btn-primary btn-sm" onclick="tryApprovePitch(' + p.id + ',' + sc + ')">Approve & Write</button>'
          + '<button class="btn btn-outline btn-sm" onclick="dismissPitch(' + p.id + ')">Dismiss</button>';
        if (sc === 2) {
          actions += '<span class="text-muted" style="font-size:11px;align-self:center;color:#fbbf24;">Consider enriching &mdash; 2 sources is thin</span>';
        }
      } else {
        var statusBadge = p.status === 'synthesized' ? '<span class="badge badge-success">Synthesized</span>'
          : p.status === 'approved' ? '<span class="badge badge-accent">Approved</span>'
          : p.status === 'dismissed' ? '<span class="badge badge-muted">Dismissed</span>' : '';
        actions = statusBadge;
      }

      return '<div class="pitch-card" data-pitch="' + p.id + '">'
        + '<div class="pitch-priority" title="Priority ' + p.priority + '">' + priorityStars + '</div>'
        + '<div class="pitch-card-header">'
        + avatar
        + '<div>'
        + '<div style="font-weight:600;font-size:13px;">' + esc(p.writer_name || 'Writer') + '</div>'
        + '<span class="pitch-type pitch-type-' + p.pitch_type + '">' + (typeLabels[p.pitch_type] || p.pitch_type) + '</span>'
        + '</div>'
        + '</div>'
        + '<div class="pitch-headline">' + sourceChip + ' ' + esc(p.headline) + '</div>'
        + '<div class="pitch-reasoning">' + esc(p.reasoning) + '</div>'
        + '<div class="pitch-meta">'
        + sourceCount + ' source' + (sourceCount !== 1 ? 's' : '')
        + (memRefs.length ? ' &middot; connects to: ' + memRefs.map(function (r) { return esc(r); }).join(', ') : '')
        + ' &middot; ' + relativeTime(p.created_at)
        + '</div>'
        + '<div class="pitch-actions">' + actions + '</div>'
        + '</div>';
    }).join('');
  }

  function optimisticRemoveCard(pitchId) {
    var card = document.querySelector('.pitch-card[data-pitch="' + pitchId + '"]');
    if (!card) return function () {};
    card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    card.classList.add('optimistic-removing');
    var removed = false;
    var timer = setTimeout(function () {
      if (card.parentNode) card.parentNode.removeChild(card);
      removed = true;
    }, 200);
    return function restore() {
      clearTimeout(timer);
      if (!removed && card.parentNode) {
        card.classList.remove('optimistic-removing');
        card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      }
    };
  }

  // Pre-approval intervention: warn before approving a single-source pitch.
  // Uses native confirm() since this page doesn't host the enrichModal markup.
  window.tryApprovePitch = function (id, sourceCount) {
    if (sourceCount && sourceCount >= 2) {
      return window.approvePitch(id);
    }
    var ok = confirm(
      'Weak pitch — only 1 source.\n\n'
      + 'Approving will synthesize an article from a single source, '
      + 'which typically fails editorial review.\n\n'
      + 'OK = Approve anyway, Cancel = abort.'
    );
    if (ok) return window.approvePitch(id);
  };

  window.approvePitch = async function (id) {
    var restore = optimisticRemoveCard(id);
    try {
      var data = await apiFetch('/admin/pitches/' + id + '/approve', { method: 'POST' });
      if (data.article) {
        showAlert('Pitch approved! Article "' + data.article.title + '" created.');
      } else {
        showAlert('Pitch approved (not enough sources for synthesis).');
      }
      loadPitches();
    } catch (err) {
      restore();
      showAlert('Approve failed: ' + err.message, 'error');
      loadPitches();
    }
  };

  window.dismissPitch = async function (id) {
    var restore = optimisticRemoveCard(id);
    try {
      await apiFetch('/admin/pitches/' + id + '/dismiss', { method: 'POST' });
      showAlert('Pitch dismissed.');
      loadPitches();
    } catch (err) {
      restore();
      showAlert('Dismiss failed: ' + err.message, 'error');
      loadPitches();
    }
  };

  // ── Polling ───────────────────────────────────────────────
  var pollTimer = null;
  function updatePolling() {
    var active = activeTab === 'pitches' && document.visibilityState !== 'hidden';
    if (active && !pollTimer) {
      pollTimer = setInterval(function () {
        if (document.visibilityState === 'hidden') return;
        loadPitches();
      }, 15000);
    } else if (!active && pollTimer) {
      clearInterval(pollTimer); pollTimer = null;
    }
  }
  document.addEventListener('visibilitychange', updatePolling);
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', updatePolling);
  });

  // ── Newsroom Feed ─────────────────────────────────────────

  async function loadNewsroom() {
    var feed = document.getElementById('newsroomFeed');
    try {
      var data = await apiFetch('/admin/pitches/newsroom');
      var messages = data.messages || [];

      if (!messages.length) {
        feed.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">No newsroom activity yet. Writers will coordinate here during synthesis.</div>';
        return;
      }

      feed.innerHTML = messages.map(function (m) {
        var typeLabels = { coordination: 'Coordination', handoff: 'Story Handoff', reference: 'Cross-Reference', standup: 'Standup' };
        var avatar = m.from_writer_avatar
          ? '<img src="' + esc(m.from_writer_avatar) + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" />'
          : '<div style="width:32px;height:32px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:14px;">&#9997;&#65039;</div>';

        var toLine = m.to_writer_name ? ' &rarr; ' + esc(m.to_writer_name) : ' (broadcast)';

        return '<div class="newsroom-item">'
          + avatar
          + '<div style="flex:1;">'
          + '<div style="font-size:12px;color:var(--muted);">'
          + '<strong style="color:var(--text);">' + esc(m.from_writer_name || 'System') + '</strong>'
          + toLine
          + ' &middot; <span class="badge badge-muted" style="font-size:9px;">' + (typeLabels[m.message_type] || m.message_type) + '</span>'
          + ' &middot; ' + relativeTime(m.created_at)
          + '</div>'
          + '<div style="margin-top:4px;font-size:13px;line-height:1.5;">' + esc(m.content) + '</div>'
          + '</div>'
          + '</div>';
      }).join('');
    } catch (err) {
      feed.innerHTML = '<div class="text-muted">Failed to load newsroom feed.</div>';
    }
  }

  // ── Filters ───────────────────────────────────────────────

  document.getElementById('pitchStatusFilter').addEventListener('change', loadPitches);
  document.getElementById('pitchWriterFilter').addEventListener('change', loadPitches);

  // ── Init ──────────────────────────────────────────────────

  async function init() {
    renderSidebar();
    initModals();

    // Load writers for filter dropdown
    try {
      writers = await apiFetch('/admin/writers');
      var sel = document.getElementById('pitchWriterFilter');
      writers.forEach(function (w) {
        var opt = document.createElement('option');
        opt.value = w.id;
        opt.textContent = w.name;
        sel.appendChild(opt);
      });
    } catch {}

    loadPitches();
    updatePolling();
  }

  onReady(function () {
    if (!requireAuth()) return;
    init();
  });
})();
