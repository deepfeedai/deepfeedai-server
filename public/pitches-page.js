/**
 * Pitches Page — agent pitches (story_pitches) + editor commissions (article_pitches) + newsroom feed.
 */
(function () {
  var writers = [];
  var activeTab = 'pitches';
  var viewMode = localStorage.getItem('dfai_pitches_view') || 'list';
  var groupBy = localStorage.getItem('dfai_pitches_group') || 'none';
  var selectedPitchIds = new Set();
  var _allPitchesCache = [];
  var commissionsViewMode = localStorage.getItem('dfai_commissions_view') || 'list';
  var commissionsGroupBy = localStorage.getItem('dfai_commissions_group') || 'none';
  var selectedCommissionIds = new Set();
  var _allCommissionsCache = [];

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toast(msg, type) {
    if (typeof window.showAlert === 'function') window.showAlert(msg, type || 'success');
    else if (type === 'error') alert(msg);
  }

  // ── Tabs ──────────────────────────────────────────────────

  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      document.getElementById('pitchesSection').style.display = activeTab === 'pitches' ? '' : 'none';
      document.getElementById('commissionsSection').style.display = activeTab === 'commissions' ? '' : 'none';
      document.getElementById('newsroomSection').style.display = activeTab === 'newsroom' ? '' : 'none';
      if (activeTab === 'newsroom') loadNewsroom();
      if (activeTab === 'commissions') loadCommissions();
      updatePolling();
    });
  });

  // ── Agent Pitches (story_pitches) ─────────────────────────

  async function loadPitches() {
    var status = document.getElementById('pitchStatusFilter').value;
    var writerId = document.getElementById('pitchWriterFilter').value;
    var isReady = status === 'ready';
    var apiStatus = isReady ? 'pending' : status;

    var url = '/admin/pitches?status=' + apiStatus + '&_t=' + Date.now();
    if (writerId !== 'all') url += '&writer_id=' + writerId;

    try {
      var data = await apiFetch(url);
      var pitches = data.pitches || [];
      if (isReady) {
        pitches = pitches.filter(function (p) {
          return (p.source_article_ids || []).length >= 3 && (p.priority || 5) >= 7;
        });
      }
      renderPitches(pitches);

      var countData = await apiFetch('/admin/pitches/count');
      var badge = document.getElementById('pendingBadge');
      if (badge) {
        badge.textContent = countData.count || '';
        badge.style.display = countData.count ? 'inline-flex' : 'none';
      }
    } catch (err) {
      showAlert('Failed to load pitches: ' + err.message, 'error');
    }
    if (window.loadNavBadges) window.loadNavBadges();
  }

  function renderPitches(pitches) {
    pitches = pitches.slice().sort(function (a, b) { return (b.priority || 5) - (a.priority || 5); });
    _allPitchesCache = pitches;
    selectedPitchIds.clear();
    updateBulkBar();
    if (groupBy === 'writer') { renderPitchesGrouped(pitches); return; }
    if (viewMode === 'list')  { renderPitchesList(pitches); return; }
    renderPitchesGrid(pitches);
  }

  function makePitchCardHtml(p, withCb) {
    var typeLabels = { new_story: 'New Story', follow_up: 'Follow-Up', roundup: 'Roundup', prediction_check: 'Prediction Check' };
    var sc = (p.source_article_ids || []).length || 1;
    var memRefs = p.memory_refs || [];
    var chipColor, chipLabel;
    if (sc <= 1) { chipColor = 'background:rgba(239,68,68,0.18);color:#ef4444;'; chipLabel = '1 source &#9888;'; }
    else if (sc === 2) { chipColor = 'background:rgba(251,191,36,0.18);color:#fbbf24;'; chipLabel = '2 sources'; }
    else { chipColor = 'background:rgba(34,197,94,0.18);color:#22c55e;'; chipLabel = sc + ' sources &#10003;'; }
    var sourceChip = '<span class="badge badge-muted" title="Attached source count" style="' + chipColor + 'font-size:11px;">' + chipLabel + '</span>';
    var priorityStars = '';
    for (var i = 0; i < Math.round((p.priority || 5) / 2); i++) priorityStars += '*';
    var avatar = p.writer_avatar_url
      ? '<img src="' + esc(p.writer_avatar_url) + '" class="pitch-avatar" />'
      : '<div class="pitch-avatar-placeholder">&#9997;&#65039;</div>';
    var sourceArticles = p.source_articles || [];
    var sourcesHtml = sourceArticles.length
      ? '<div class="pitch-sources">' + sourceArticles.map(function (a) {
          return '<div class="pitch-source-row"><span class="pitch-source-dot">&#9679;</span>'
            + esc(a.title || ('Article #' + a.id))
            + (a.source ? ' <span style="color:var(--muted);">— ' + esc(a.source) + '</span>' : '')
            + '</div>';
        }).join('') + '</div>'
      : '';
    var existingIdsJson = JSON.stringify((p.source_article_ids || []).map(Number));
    var headlineArg = JSON.stringify(p.headline || '').replace(/"/g, '&quot;');
    var actions = '';
    if (p.status === 'pending') {
      actions = '<button class="btn btn-primary btn-sm" onclick="tryApprovePitch(' + p.id + ',' + sc + ')">Approve & Write</button>'
        + '<button class="btn btn-outline btn-sm" onclick="openEnrichSources(' + p.id + ',&quot;story&quot;,' + existingIdsJson + ',' + headlineArg + ')">Enrich sources</button>'
        + '<button class="btn btn-ghost btn-sm" onclick="dismissPitch(' + p.id + ')">Dismiss</button>';
    } else {
      actions = p.status === 'synthesized' ? '<span class="badge badge-success">Synthesized</span>'
        : p.status === 'approved' ? '<span class="badge badge-accent">Approved</span>'
        : p.status === 'dismissed' ? '<span class="badge badge-muted">Dismissed</span>' : '';
    }
    var isPending = p.status === 'pending';
    var cbHtml = (withCb && isPending)
      ? '<input type="checkbox" class="pitch-card-cb" data-pitch-id="' + p.id + '" style="position:absolute;top:10px;left:10px;z-index:2;" />'
      : '';
    var writerAttr = withCb ? ' data-writer="' + esc(String(p.writer_id || 0)) + '"' : '';
    return '<div class="pitch-card" data-pitch="' + p.id + '"' + writerAttr + '>'
      + cbHtml
      + '<div class="pitch-priority" title="Priority ' + p.priority + '">' + priorityStars + '</div>'
      + '<div class="pitch-card-header">' + avatar
      + '<div><div style="font-weight:600;font-size:13px;">' + esc(p.writer_name || 'Writer') + '</div>'
      + '<span class="pitch-type pitch-type-' + p.pitch_type + '">' + (typeLabels[p.pitch_type] || p.pitch_type) + '</span>'
      + '</div></div>'
      + '<div class="pitch-headline">' + sourceChip + ' ' + esc(p.headline) + '</div>'
      + '<div class="pitch-reasoning">' + esc(p.reasoning) + '</div>'
      + sourcesHtml
      + '<div class="pitch-meta">'
      + (memRefs.length ? 'Connects to: ' + memRefs.map(function (r) { return esc(r); }).join(', ') + ' &middot; ' : '')
      + relativeTime(p.created_at)
      + '</div>'
      + '<div class="pitch-actions">' + actions + '</div>'
      + '</div>';
  }

  function renderPitchesGrid(pitches) {
    var grid = document.getElementById('pitchGrid');
    grid.className = 'pitch-grid';
    if (!pitches.length) {
      grid.innerHTML = '<div style="text-align:center;padding:40px;grid-column:1/-1;color:var(--muted);">No pitches found. Writer agents will generate pitches when they spot stories worth covering.</div>';
      return;
    }
    grid.innerHTML = pitches.map(function (p) { return makePitchCardHtml(p, false); }).join('');
  }

  function renderPitchesList(pitches) {
    var grid = document.getElementById('pitchGrid');
    grid.className = 'pitch-list';
    if (!pitches.length) {
      grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">No pitches found.</div>';
      return;
    }
    var typeLabels = { new_story: 'New Story', follow_up: 'Follow-Up', roundup: 'Roundup', prediction_check: 'Pred. Check' };

    var hdr = '<div class="pitch-list-hdr">'
      + '<div><input type="checkbox" id="selectAllPitches" title="Select all" /></div>'
      + '<div>Headline</div><div>Writer</div><div>Type</div>'
      + '<div>Sources</div><div>Priority</div><div>Age</div><div>Actions</div>'
      + '</div>';

    var rows = pitches.map(function (p) {
      var sc = (p.source_article_ids || []).length || 1;
      var chipColor, chipLabel;
      if (sc <= 1) { chipColor = 'background:rgba(239,68,68,0.18);color:#ef4444;'; chipLabel = '1 &#9888;'; }
      else if (sc === 2) { chipColor = 'background:rgba(251,191,36,0.18);color:#fbbf24;'; chipLabel = '2'; }
      else { chipColor = 'background:rgba(34,197,94,0.18);color:#22c55e;'; chipLabel = sc + ' &#10003;'; }
      var sourceChip = '<span class="badge badge-muted" style="' + chipColor + 'font-size:11px;">' + chipLabel + '</span>';

      var pri = p.priority || 5;
      var priClass = pri >= 8 ? 'pri-high' : pri >= 5 ? 'pri-mid' : 'pri-low';
      var priBadge = '<span class="pri-badge ' + priClass + '">' + pri + '</span>';

      var typeBadge = '<span class="pitch-type pitch-type-' + p.pitch_type + '">' + (typeLabels[p.pitch_type] || p.pitch_type) + '</span>';

      var actions = '';
      if (p.status === 'pending') {
        var existingIdsJson = JSON.stringify((p.source_article_ids || []).map(Number));
        var headlineArg = JSON.stringify(p.headline || '').replace(/"/g, '&quot;');
        actions = '<button class="btn btn-primary btn-sm" onclick="tryApprovePitch(' + p.id + ',' + sc + ')">Approve</button>'
          + '<button class="btn btn-ghost btn-sm" onclick="dismissPitch(' + p.id + ')">Dismiss</button>'
          + '<button class="btn btn-outline btn-sm" style="padding:3px 7px;" title="Enrich sources" onclick="openEnrichSources(' + p.id + ',&quot;story&quot;,' + existingIdsJson + ',' + headlineArg + ')">+src</button>';
      } else {
        actions = p.status === 'synthesized' ? '<span class="badge badge-success">Synthesized</span>'
          : p.status === 'approved' ? '<span class="badge badge-accent">Approved</span>'
          : p.status === 'dismissed' ? '<span class="badge badge-muted">Dismissed</span>' : '';
      }

      var isPending = p.status === 'pending';
      return '<div class="pitch-list-row" data-pitch="' + p.id + '">'
        + '<div>' + (isPending ? '<input type="checkbox" class="pitch-cb" data-pitch-id="' + p.id + '" />' : '') + '</div>'
        + '<div class="pitch-list-headline" title="' + esc(p.headline) + '">' + esc(p.headline) + '</div>'
        + '<div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(p.writer_name || '') + '">' + esc(p.writer_name || '') + '</div>'
        + '<div>' + typeBadge + '</div>'
        + '<div>' + sourceChip + '</div>'
        + '<div>' + priBadge + '</div>'
        + '<div style="font-size:12px;color:var(--muted);white-space:nowrap;">' + relativeTime(p.created_at) + '</div>'
        + '<div class="pitch-list-actions">' + actions + '</div>'
        + '</div>';
    }).join('');

    grid.innerHTML = hdr + rows;

    var selectAll = document.getElementById('selectAllPitches');
    function syncSelectAll() {
      if (!selectAll) return;
      var cbs = grid.querySelectorAll('.pitch-cb');
      var checked = grid.querySelectorAll('.pitch-cb:checked').length;
      selectAll.indeterminate = checked > 0 && checked < cbs.length;
      selectAll.checked = cbs.length > 0 && checked === cbs.length;
    }
    if (selectAll) {
      selectAll.addEventListener('change', function () {
        grid.querySelectorAll('.pitch-cb').forEach(function (cb) {
          cb.checked = selectAll.checked;
          var id = parseInt(cb.dataset.pitchId, 10);
          if (selectAll.checked) selectedPitchIds.add(id); else selectedPitchIds.delete(id);
          cb.closest('.pitch-list-row').classList.toggle('selected', selectAll.checked);
        });
        updateBulkBar();
      });
    }
    grid.querySelectorAll('.pitch-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = parseInt(cb.dataset.pitchId, 10);
        if (cb.checked) selectedPitchIds.add(id); else selectedPitchIds.delete(id);
        cb.closest('.pitch-list-row').classList.toggle('selected', cb.checked);
        syncSelectAll();
        updateBulkBar();
      });
    });
  }

  function renderPitchesGrouped(pitches) {
    var grid = document.getElementById('pitchGrid');
    grid.className = 'pitch-swimlane';
    if (!pitches.length) {
      grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">No pitches found.</div>';
      return;
    }
    var typeLabels = { new_story: 'New Story', follow_up: 'Follow-Up', roundup: 'Roundup', prediction_check: 'Pred. Check' };

    var writerMap = {};
    var writerOrder = [];
    pitches.forEach(function (p) {
      var wid = String(p.writer_id || 0);
      if (!writerMap[wid]) {
        writerMap[wid] = { name: p.writer_name || 'Unknown', avatar: p.writer_avatar_url || null, pitches: [] };
        writerOrder.push(wid);
      }
      writerMap[wid].pitches.push(p);
    });

    function makeListRow(p) {
      var sc = (p.source_article_ids || []).length || 1;
      var chipColor, chipLabel;
      if (sc <= 1) { chipColor = 'background:rgba(239,68,68,0.18);color:#ef4444;'; chipLabel = '1 &#9888;'; }
      else if (sc === 2) { chipColor = 'background:rgba(251,191,36,0.18);color:#fbbf24;'; chipLabel = '2'; }
      else { chipColor = 'background:rgba(34,197,94,0.18);color:#22c55e;'; chipLabel = sc + ' &#10003;'; }
      var sourceChip = '<span class="badge badge-muted" style="' + chipColor + 'font-size:11px;">' + chipLabel + '</span>';
      var pri = p.priority || 5;
      var priClass = pri >= 8 ? 'pri-high' : pri >= 5 ? 'pri-mid' : 'pri-low';
      var priBadge = '<span class="pri-badge ' + priClass + '">' + pri + '</span>';
      var typeBadge = '<span class="pitch-type pitch-type-' + p.pitch_type + '">' + (typeLabels[p.pitch_type] || p.pitch_type) + '</span>';
      var actions = '';
      if (p.status === 'pending') {
        var existingIdsJson = JSON.stringify((p.source_article_ids || []).map(Number));
        var headlineArg = JSON.stringify(p.headline || '').replace(/"/g, '&quot;');
        actions = '<button class="btn btn-primary btn-sm" onclick="tryApprovePitch(' + p.id + ',' + sc + ')">Approve</button>'
          + '<button class="btn btn-ghost btn-sm" onclick="dismissPitch(' + p.id + ')">Dismiss</button>'
          + '<button class="btn btn-outline btn-sm" style="padding:3px 7px;" title="Enrich sources" onclick="openEnrichSources(' + p.id + ',&quot;story&quot;,' + existingIdsJson + ',' + headlineArg + ')">+src</button>';
      } else {
        actions = p.status === 'synthesized' ? '<span class="badge badge-success">Synthesized</span>'
          : p.status === 'approved' ? '<span class="badge badge-accent">Approved</span>'
          : p.status === 'dismissed' ? '<span class="badge badge-muted">Dismissed</span>' : '';
      }
      var isPending = p.status === 'pending';
      return '<div class="swimlane-list-row" data-pitch="' + p.id + '" data-writer="' + esc(String(p.writer_id || 0)) + '">'
        + '<div>' + (isPending ? '<input type="checkbox" class="pitch-cb" data-pitch-id="' + p.id + '" />' : '') + '</div>'
        + '<div class="pitch-list-headline" title="' + esc(p.headline) + '">' + esc(p.headline) + '</div>'
        + '<div>' + typeBadge + '</div>'
        + '<div>' + sourceChip + '</div>'
        + '<div>' + priBadge + '</div>'
        + '<div style="font-size:12px;color:var(--muted);white-space:nowrap;">' + relativeTime(p.created_at) + '</div>'
        + '<div class="pitch-list-actions">' + actions + '</div>'
        + '</div>';
    }

    grid.innerHTML = writerOrder.map(function (wid) {
      var group = writerMap[wid];
      var pendingCount = group.pitches.filter(function (p) { return p.status === 'pending'; }).length;
      var countLabel = group.pitches.length + ' pitch' + (group.pitches.length !== 1 ? 'es' : '')
        + (pendingCount !== group.pitches.length ? ' · ' + pendingCount + ' pending' : '');
      var avatar = group.avatar
        ? '<img src="' + esc(group.avatar) + '" class="swimlane-avatar" />'
        : '<div class="swimlane-avatar-ph">&#9997;&#65039;</div>';
      var header = '<div class="swimlane-header">'
        + (pendingCount > 0 ? '<input type="checkbox" class="swimlane-cb-all" data-wid="' + wid + '" title="Select all pending" />' : '<span style="width:14px;display:inline-block;"></span>')
        + '<span data-writer-id="' + wid + '" style="display:flex;align-items:center;gap:8px;cursor:pointer;" title="View writer profile">'
        + avatar
        + '<div><div class="swimlane-writer-name">' + esc(group.name) + '</div><div class="swimlane-pitch-count">' + countLabel + '</div></div>'
        + '</span>'
        + '</div>';
      var body = '';
      if (viewMode === 'grid') {
        body = '<div style="padding:12px;background:var(--bg-card);">'
          + '<div class="pitch-grid">' + group.pitches.map(function (p) { return makePitchCardHtml(p, true); }).join('') + '</div>'
          + '</div>';
      } else {
        var listHdr = '<div class="swimlane-list-hdr"><div></div>'
          + '<div>Headline</div><div>Type</div><div>Sources</div><div>Priority</div><div>Age</div><div>Actions</div>'
          + '</div>';
        body = listHdr + group.pitches.map(makeListRow).join('');
      }
      return '<div class="swimlane-group">' + header + body + '</div>';
    }).join('');

    // Wire swimlane select-all (works for both list rows and grid card checkboxes)
    grid.querySelectorAll('.swimlane-cb-all').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var wid = cb.dataset.wid;
        var allCbs = grid.querySelectorAll(
          '.swimlane-list-row[data-writer="' + wid + '"] .pitch-cb, .pitch-card[data-writer="' + wid + '"] .pitch-card-cb'
        );
        allCbs.forEach(function (rowCb) {
          rowCb.checked = cb.checked;
          var id = parseInt(rowCb.dataset.pitchId, 10);
          if (cb.checked) selectedPitchIds.add(id); else selectedPitchIds.delete(id);
          var row = rowCb.closest('.swimlane-list-row') || rowCb.closest('.pitch-card');
          if (row) row.classList.toggle('selected', cb.checked);
        });
        updateBulkBar();
      });
    });

    // Wire individual checkboxes (list rows and grid cards)
    grid.querySelectorAll('.pitch-cb, .pitch-card-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = parseInt(cb.dataset.pitchId, 10);
        if (cb.checked) selectedPitchIds.add(id); else selectedPitchIds.delete(id);
        var row = cb.closest('.swimlane-list-row') || cb.closest('.pitch-card');
        if (row) row.classList.toggle('selected', cb.checked);
        var wid = row ? (row.dataset.writer || null) : null;
        if (wid) {
          var groupCbs = grid.querySelectorAll(
            '.swimlane-list-row[data-writer="' + wid + '"] .pitch-cb, .pitch-card[data-writer="' + wid + '"] .pitch-card-cb'
          );
          var groupChecked = Array.from(groupCbs).filter(function (c) { return c.checked; }).length;
          var groupAll = grid.querySelector('.swimlane-cb-all[data-wid="' + wid + '"]');
          if (groupAll) {
            groupAll.indeterminate = groupChecked > 0 && groupChecked < groupCbs.length;
            groupAll.checked = groupCbs.length > 0 && groupChecked === groupCbs.length;
          }
        }
        updateBulkBar();
      });
    });
  }

  function updateBulkBar() {
    var bar = document.getElementById('pitchBulkBar');
    var countEl = document.getElementById('pitchBulkCount');
    if (!bar) return;
    var n = selectedPitchIds.size;
    bar.style.display = n > 0 ? 'flex' : 'none';
    if (countEl) countEl.textContent = n + ' selected';
  }

  window.clearPitchSelection = function () {
    selectedPitchIds.clear();
    document.querySelectorAll('.pitch-cb, .pitch-card-cb').forEach(function (cb) { cb.checked = false; });
    document.querySelectorAll('.pitch-list-row.selected, .swimlane-list-row.selected, .pitch-card.selected').forEach(function (r) { r.classList.remove('selected'); });
    document.querySelectorAll('.swimlane-cb-all').forEach(function (cb) { cb.checked = false; cb.indeterminate = false; });
    var sa = document.getElementById('selectAllPitches');
    if (sa) { sa.checked = false; sa.indeterminate = false; }
    updateBulkBar();
  };

  window.bulkApprovePitches = async function () {
    var ids = Array.from(selectedPitchIds);
    if (!ids.length) return;
    var weak = ids.filter(function (id) {
      var p = _allPitchesCache.find(function (p) { return p.id === id; });
      return p && (p.source_article_ids || []).length < 2;
    });
    var msg = 'Approve ' + ids.length + ' pitch' + (ids.length !== 1 ? 'es' : '') + '?';
    if (weak.length) msg += '\n\n' + weak.length + ' pitch' + (weak.length !== 1 ? 'es have' : ' has') + ' only 1 source and may fail editorial review.';
    if (!confirm(msg)) return;
    var bar = document.getElementById('pitchBulkBar');
    if (bar) bar.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    var ok = 0, fail = 0;
    for (var i = 0; i < ids.length; i++) {
      try { await apiFetch('/admin/pitches/' + ids[i] + '/approve', { method: 'POST' }); ok++; }
      catch { fail++; }
    }
    showAlert('Approved ' + ok + (fail ? ', ' + fail + ' failed' : '') + '.', fail ? 'warning' : 'success');
    await loadPitches();
  };

  window.bulkDismissPitches = async function () {
    var ids = Array.from(selectedPitchIds);
    if (!ids.length) return;
    if (!confirm('Dismiss ' + ids.length + ' pitch' + (ids.length !== 1 ? 'es' : '') + '?')) return;
    var bar = document.getElementById('pitchBulkBar');
    if (bar) bar.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    var ok = 0, fail = 0;
    for (var i = 0; i < ids.length; i++) {
      try { await apiFetch('/admin/pitches/' + ids[i] + '/dismiss', { method: 'POST' }); ok++; }
      catch { fail++; }
    }
    showAlert('Dismissed ' + ok + (fail ? ', ' + fail + ' failed' : '') + '.', fail ? 'warning' : 'success');
    await loadPitches();
  };

  function optimisticRemovePitchCard(pitchId) {
    var card = document.querySelector('.pitch-card[data-pitch="' + pitchId + '"], .pitch-list-row[data-pitch="' + pitchId + '"], .swimlane-list-row[data-pitch="' + pitchId + '"]');
    if (!card) return function () {};
    selectedPitchIds.delete(pitchId);
    updateBulkBar();
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

  window.tryApprovePitch = function (id, sourceCount) {
    if (sourceCount && sourceCount >= 2) return window.approvePitch(id);
    var ok = confirm(
      'Weak pitch — only 1 source.\n\n'
      + 'Approving will synthesize an article from a single source, '
      + 'which typically fails editorial review.\n\n'
      + 'OK = Approve anyway, Cancel = abort.'
    );
    if (ok) return window.approvePitch(id);
  };

  window.approvePitch = async function (id) {
    var restore = optimisticRemovePitchCard(id);
    try {
      var data = await apiFetch('/admin/pitches/' + id + '/approve', { method: 'POST' });
      if (data.article) {
        showAlert('Pitch approved! Article "' + data.article.title + '" created.');
      } else {
        var reason = data.synthesis_skip_reason ? ' (' + data.synthesis_skip_reason + ')' : '';
        showAlert('Pitch approved — synthesis skipped' + reason + '.', 'warning');
      }
      loadPitches();
    } catch (err) {
      restore();
      showAlert('Approve failed: ' + err.message, 'error');
      loadPitches();
    }
  };

  window.dismissPitch = async function (id) {
    var restore = optimisticRemovePitchCard(id);
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

  // ── Enrich sources modal (shared: story pitches + commissions) ────────────

  var _enrichCtx = { pitchId: null, pitchType: 'story', existingIds: new Set() };
  var _enrichWebCache = [];
  var _enrichLibSelected = new Set();
  var _enrichLibDebounce = null;
  var _enrichActiveTab = 'web';

  window.openEnrichSources = async function (pitchId, pitchType, existingIds, headline) {
    _enrichCtx = {
      pitchId: pitchId,
      pitchType: pitchType || 'story',
      existingIds: new Set((existingIds || []).map(Number).filter(Boolean)),
    };
    _enrichWebCache = [];
    _enrichLibSelected = new Set(_enrichCtx.existingIds); // pre-select existing

    // Reset web pane
    document.getElementById('enrichCommissionQuery').value = headline || '';
    document.getElementById('enrichCommissionResults').innerHTML =
      '<div class="text-muted" style="padding:24px 8px;text-align:center;">Press Search to find external coverage.</div>';
    document.getElementById('enrichCommissionQuotaInfo').textContent = '';
    document.getElementById('enrichCommissionIngestBtn').disabled = true;

    // Library tab only available for story pitches
    var libTab = document.getElementById('enrichLibraryTabBtn');
    if (libTab) libTab.style.display = _enrichCtx.pitchType === 'story' ? '' : 'none';

    // Always start on web tab
    _switchEnrichTab('web');
    openModal('enrichCommissionModal');
  };

  function _switchEnrichTab(tab) {
    _enrichActiveTab = tab;
    document.querySelectorAll('#enrichTabBar .tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.enrichTab === tab);
    });
    document.getElementById('enrichWebPane').style.display     = tab === 'web'     ? '' : 'none';
    document.getElementById('enrichLibraryPane').style.display = tab === 'library' ? '' : 'none';
    document.getElementById('enrichCommissionIngestBtn').style.display = tab === 'web'     ? '' : 'none';
    document.getElementById('enrichLibraryAddBtn').style.display       = tab === 'library' ? '' : 'none';
    if (tab === 'library') _loadLibraryResults('');
  }

  document.querySelectorAll('#enrichTabBar .tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { _switchEnrichTab(btn.dataset.enrichTab); });
  });

  // Library pane — debounced search
  document.getElementById('enrichLibraryQuery').addEventListener('input', function () {
    clearTimeout(_enrichLibDebounce);
    var q = this.value;
    _enrichLibDebounce = setTimeout(function () { _loadLibraryResults(q); }, 300);
  });

  async function _loadLibraryResults(q) {
    var el = document.getElementById('enrichLibraryResults');
    el.innerHTML = '<div class="text-muted" style="padding:16px 8px;text-align:center;">Loading…</div>';
    try {
      var data = await apiFetch('/admin/pitches/articles-search?q=' + encodeURIComponent(q || '') + '&limit=40');
      var arts = data.articles || [];
      if (!arts.length) {
        el.innerHTML = '<div class="text-muted" style="padding:16px 8px;text-align:center;">No articles found.</div>';
        document.getElementById('enrichLibraryAddBtn').disabled = true;
        return;
      }
      el.innerHTML = arts.map(function (a) {
        var isAttached = _enrichCtx.existingIds.has(a.id);
        var isChecked  = _enrichLibSelected.has(a.id);
        var dt = a.published_at ? new Date(a.published_at).toLocaleDateString() : '';
        var attachedBadge = isAttached
          ? ' <span style="font-size:10px;color:var(--muted);background:var(--surface2);padding:1px 5px;border-radius:4px;">attached</span>'
          : '';
        return '<label style="display:flex;align-items:flex-start;gap:10px;padding:8px 4px;cursor:pointer;border-bottom:1px solid var(--border);">'
          + '<input type="checkbox" data-art-id="' + a.id + '" ' + (isChecked ? 'checked' : '') + ' class="enrich-lib-cb" style="margin-top:2px;flex-shrink:0;" />'
          + '<div style="flex:1;min-width:0;">'
          + '<div style="font-size:13px;font-weight:500;line-height:1.3;">' + esc(a.title) + attachedBadge + '</div>'
          + '<div style="font-size:11px;color:var(--muted);">' + esc(a.source || '') + (dt ? ' · ' + dt : '') + (a.category ? ' · ' + esc(a.category) : '') + '</div>'
          + '</div></label>';
      }).join('');
      el.querySelectorAll('.enrich-lib-cb').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var id = parseInt(cb.dataset.artId);
          if (cb.checked) _enrichLibSelected.add(id);
          else _enrichLibSelected.delete(id);
          // Enable "Add selected" only when new (non-existing) articles are selected
          var hasNew = Array.from(_enrichLibSelected).some(function (id) { return !_enrichCtx.existingIds.has(id); });
          document.getElementById('enrichLibraryAddBtn').disabled = !hasNew;
        });
      });
      // Restore button state
      var hasNew = Array.from(_enrichLibSelected).some(function (id) { return !_enrichCtx.existingIds.has(id); });
      document.getElementById('enrichLibraryAddBtn').disabled = !hasNew;
    } catch (err) {
      el.innerHTML = '<div style="color:var(--danger);padding:16px 8px;">Failed: ' + esc(err.message) + '</div>';
    }
  }

  document.getElementById('enrichLibraryAddBtn').addEventListener('click', async function () {
    var btn = this;
    var newIds = Array.from(_enrichLibSelected).filter(function (id) { return !_enrichCtx.existingIds.has(id); });
    if (!newIds.length) { toast('No new articles selected.', 'warning'); return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await apiFetch('/admin/pitches/' + _enrichCtx.pitchId + '/sources', {
        method: 'PATCH',
        body: JSON.stringify({ source_article_ids: newIds }),
      });
      closeModal('enrichCommissionModal');
      toast(newIds.length + ' source(s) added to pitch.', 'success');
      if (_enrichCtx.pitchType === 'story') await loadPitches();
      else await loadCommissions();
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Add selected';
    }
  });

  // ── Commissions (article_pitches — editor/Maxwell) ────────

  // Filter states — 'proposed' (default), 'approved', 'orphaned' (non-terminal
  // + unassigned — the commissioned pitches that previously vanished from
  // the flow), 'all' (everything non-terminal).
  var commissionFilter = 'proposed';

  function commissionFilterToQuery(filter) {
    if (filter === 'orphaned') return 'orphaned=1';
    if (filter === 'approved') return 'status=approved';
    if (filter === 'all')      return 'status=proposed,approved';
    return 'status=proposed';
  }

  async function loadCommissions() {
    try {
      var data = await apiFetch('/pitches?' + commissionFilterToQuery(commissionFilter) + '&_t=' + Date.now());
      var commissions = data.pitches || [];
      renderCommissionsGrid(commissions);
      var badge = document.getElementById('commissionsBadge');
      if (badge) {
        badge.textContent = commissions.length || '';
        badge.style.display = commissions.length ? 'inline-flex' : 'none';
      }
      // Bulk auto-assign button — only relevant on the orphan view
      var bulk = document.getElementById('autoAssignAllBtn');
      if (bulk) bulk.style.display = (commissionFilter === 'orphaned' && commissions.length) ? 'inline-flex' : 'none';
    } catch (err) {
      document.getElementById('commissionsGrid').innerHTML =
        '<div class="review-empty">Failed to load commissions: ' + esc(err.message || err) + '</div>';
    }
    // Independently fetch the orphan count so the "Needs writer" tab badge
    // stays accurate regardless of which filter is active. Cheap — one query.
    try {
      var o = await apiFetch('/pitches?orphaned=1&limit=1');
      var orphanBadge = document.getElementById('orphanedBadge');
      if (orphanBadge) {
        // `count` is just for this page slice; the orphan count for the
        // badge is the length field returned — bump limit if you need exact
        // numbers above 1. Showing ! if any exist is enough to draw the eye.
        var n = (o.pitches && o.pitches.length) ? '!' : '';
        orphanBadge.textContent = n;
        orphanBadge.style.display = n ? 'inline-flex' : 'none';
      }
    } catch (_) { /* non-fatal */ }

    if (window.loadNavBadges) window.loadNavBadges();

  }

  // Wire the filter tab bar above the grid
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-commission-filter]');
    if (!btn) return;
    var val = btn.getAttribute('data-commission-filter');
    if (val === commissionFilter) return;
    commissionFilter = val;
    var bar = btn.closest('.tab-bar');
    if (bar) bar.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
    loadCommissions();
  });

  function renderCommissionsGrid(list) {
    list = list.slice().sort(function (a, b) {
      var sc = (b.source_count || 1) - (a.source_count || 1);
      if (sc !== 0) return sc;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
    _allCommissionsCache = list;
    selectedCommissionIds.clear();
    updateCommissionsBulkBar();
    if (commissionsGroupBy === 'writer')   { renderCommissionsGrouped(list, 'writer');   return; }
    if (commissionsGroupBy === 'category') { renderCommissionsGrouped(list, 'category'); return; }
    if (commissionsViewMode === 'list') { renderCommissionsList(list); return; }
    renderCommissionsCards(list);
  }

  function makeCommissionCardHtml(p) {
    var ago = p.created_at ? relativeTime(p.created_at) : '';
    var initiator = p.pitched_by_writer_name
      ? 'Pitched by <strong>' + esc(p.pitched_by_writer_name) + '</strong>'
      : 'Editor tip from <strong>' + esc(p.requested_by_editor_name || 'editor') + '</strong>';
    var sourceUrl = p.source_url ? '<a href="' + esc(p.source_url) + '" target="_blank" rel="noopener" class="text-muted" style="font-size:12px;">↗ ' + esc(p.source_publisher || 'source') + '</a>' : '';
    var sc = (typeof p.source_count === 'number' && p.source_count > 0) ? p.source_count : 1;
    var chipColor, chipLabel;
    if (sc <= 1) { chipColor = 'background:rgba(239,68,68,0.18);color:#ef4444;'; chipLabel = '1 source &#9888;'; }
    else if (sc === 2) { chipColor = 'background:rgba(251,191,36,0.18);color:#fbbf24;'; chipLabel = '2 sources'; }
    else { chipColor = 'background:rgba(34,197,94,0.18);color:#22c55e;'; chipLabel = sc + ' sources &#10003;'; }
    var sourceChip = '<span class="badge badge-muted" title="Attached source count" style="' + chipColor + 'margin-right:6px;">' + chipLabel + '</span>';
    var titleArg = JSON.stringify(p.source_title || '').replace(/"/g, '&quot;');
    var typeBadge = (window.renderPitchTypeBadge && p.pitch_type) ? window.renderPitchTypeBadge(p.pitch_type) : '';
    var html = '<div class="review-card" data-pitch="' + p.id + '">'
      + '<div class="review-card-header">'
      + '<div class="review-title">' + esc(p.source_title || 'Untitled source') + '</div>'
      + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' + typeBadge + sourceChip + '<span class="badge badge-muted" style="background:rgba(124,58,237,0.15);color:#a78bfa;">COMMISSION</span></div>'
      + '</div>'
      + '<div class="review-meta">'
      + '<span>' + initiator + '</span><span>' + ago + '</span>'
      + (p.source_category ? '<span>' + esc(p.source_category) + '</span>' : '')
      + (sourceUrl ? '<span>' + sourceUrl + '</span>' : '')
      + '</div>'
      + '<div class="review-suggestion"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Angle</div>' + esc(p.angle_summary || '') + '</div>'
      + '<div class="review-actions">';
    if (p.status === 'proposed') {
      html += '<button class="btn btn-primary btn-sm" onclick="tryApproveCommission(' + p.id + ',' + sc + ',' + titleArg + ')">Approve</button>'
        + '<button class="btn btn-outline btn-sm" onclick="rejectCommission(' + p.id + ')">Reject</button>'
        + '<button class="btn btn-ghost btn-sm" onclick="openEnrichSources(' + p.id + ',&quot;commission&quot;,[],' + titleArg + ')">Enrich sources</button>';
      if (sc === 2) html += '<span class="text-muted" style="font-size:12px;align-self:center;color:#fbbf24;">Consider enriching &mdash; 2 sources is thin</span>';
    } else if (p.status === 'approved') {
      html += '<span class="badge badge-accent" style="align-self:center;">Approved</span>';
      if (p.spawned_article_id) html += '<a class="btn btn-ghost btn-sm" href="/article-editor.html?id=' + p.spawned_article_id + '">→ Open article</a>';
    } else if (p.status === 'published') {
      html += '<span class="badge badge-success" style="align-self:center;">Published</span>';
      if (p.spawned_article_id) html += '<a class="btn btn-ghost btn-sm" href="/article-editor.html?id=' + p.spawned_article_id + '">→ Open article</a>';
    }
    if (!p.pitched_by_writer_id) {
      html += '<button class="btn btn-primary btn-sm" onclick="autoAssignCommission(' + p.id + ')" title="Pick the best writer automatically via beat match">&#127919; Auto-assign</button>'
        + '<button class="btn btn-ghost btn-sm" onclick="openReassignCommission(' + p.id + ')">Assign writer…</button>';
    }
    html += '</div></div>';
    return html;
  }

  function renderCommissionsCards(list) {
    var grid = document.getElementById('commissionsGrid');
    grid.className = 'review-grid';
    if (!list.length) {
      grid.innerHTML = '<div class="review-empty">No commissions awaiting review.</div>';
      return;
    }
    grid.innerHTML = list.map(makeCommissionCardHtml).join('');
  }

  function renderCommissionsList(list) {
    var grid = document.getElementById('commissionsGrid');
    grid.className = 'commission-list';
    if (!list.length) {
      grid.innerHTML = '<div class="review-empty">No commissions awaiting review.</div>';
      return;
    }

    var hdr = '<div class="commission-list-hdr">'
      + '<div><input type="checkbox" id="selectAllCommissions" title="Select all" /></div>'
      + '<div>Title / Angle</div><div>From</div><div>Category</div>'
      + '<div>Sources</div><div>Age</div><div>Actions</div>'
      + '</div>';

    var rows = list.map(function (p) {
      var sc = (typeof p.source_count === 'number' && p.source_count > 0) ? p.source_count : 1;
      var chipColor, chipLabel;
      if (sc <= 1) { chipColor = 'background:rgba(239,68,68,0.18);color:#ef4444;'; chipLabel = '1 &#9888;'; }
      else if (sc === 2) { chipColor = 'background:rgba(251,191,36,0.18);color:#fbbf24;'; chipLabel = '2'; }
      else { chipColor = 'background:rgba(34,197,94,0.18);color:#22c55e;'; chipLabel = sc + ' &#10003;'; }
      var sourceChip = '<span class="badge badge-muted" style="' + chipColor + 'font-size:11px;">' + chipLabel + '</span>';

      var initiator = p.pitched_by_writer_name
        ? esc(p.pitched_by_writer_name)
        : 'Ed: ' + esc(p.requested_by_editor_name || 'editor');
      var angle = p.angle_summary ? (p.angle_summary.length > 80 ? p.angle_summary.slice(0, 80) + '…' : p.angle_summary) : '';
      var titleArg = JSON.stringify(p.source_title || '').replace(/"/g, '&quot;');

      var actions = '';
      var isProposed = p.status === 'proposed';
      if (isProposed) {
        actions = '<button class="btn btn-primary btn-sm" onclick="tryApproveCommission(' + p.id + ',' + sc + ',' + titleArg + ')">Approve</button>'
          + '<button class="btn btn-ghost btn-sm" onclick="rejectCommission(' + p.id + ')">Reject</button>'
          + '<button class="btn btn-outline btn-sm" style="padding:3px 7px;" title="Enrich sources" onclick="openEnrichSources(' + p.id + ',&quot;commission&quot;,[],' + titleArg + ')">+src</button>';
        if (!p.pitched_by_writer_id) {
          actions += '<button class="btn btn-ghost btn-sm" style="padding:3px 7px;" title="Auto-assign writer" onclick="autoAssignCommission(' + p.id + ')">&#127919;</button>';
        }
      } else if (p.status === 'approved') {
        actions = '<span class="badge badge-accent">Approved</span>';
        if (p.spawned_article_id) actions += ' <a class="btn btn-ghost btn-sm" href="/article-editor.html?id=' + p.spawned_article_id + '">&#8594; Article</a>';
        if (!p.pitched_by_writer_id) actions += ' <button class="btn btn-ghost btn-sm" onclick="openReassignCommission(' + p.id + ')">Assign…</button>';
      } else if (p.status === 'published') {
        actions = '<span class="badge badge-success">Published</span>';
        if (p.spawned_article_id) actions += ' <a class="btn btn-ghost btn-sm" href="/article-editor.html?id=' + p.spawned_article_id + '">&#8594; Article</a>';
      } else if (!p.pitched_by_writer_id) {
        actions = '<button class="btn btn-primary btn-sm" onclick="autoAssignCommission(' + p.id + ')">&#127919; Auto-assign</button>'
          + '<button class="btn btn-ghost btn-sm" onclick="openReassignCommission(' + p.id + ')">Assign…</button>';
      }

      return '<div class="commission-list-row" data-pitch="' + p.id + '">'
        + '<div>' + (isProposed ? '<input type="checkbox" class="commission-cb" data-pitch-id="' + p.id + '" />' : '') + '</div>'
        + '<div style="overflow:hidden;">'
        + '<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(p.source_title || '') + '">' + esc(p.source_title || 'Untitled') + '</div>'
        + (angle ? '<div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(p.angle_summary || '') + '">' + esc(angle) + '</div>' : '')
        + '</div>'
        + '<div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + initiator + '">' + initiator + '</div>'
        + '<div style="font-size:12px;">' + esc(p.source_category || '') + '</div>'
        + '<div>' + sourceChip + '</div>'
        + '<div style="font-size:12px;color:var(--muted);white-space:nowrap;">' + relativeTime(p.created_at) + '</div>'
        + '<div style="display:flex;gap:4px;flex-wrap:nowrap;">' + actions + '</div>'
        + '</div>';
    }).join('');

    grid.innerHTML = hdr + rows;

    var selectAll = document.getElementById('selectAllCommissions');
    function syncSelectAll() {
      if (!selectAll) return;
      var cbs = grid.querySelectorAll('.commission-cb');
      var checked = grid.querySelectorAll('.commission-cb:checked').length;
      selectAll.indeterminate = checked > 0 && checked < cbs.length;
      selectAll.checked = cbs.length > 0 && checked === cbs.length;
    }
    if (selectAll) {
      selectAll.addEventListener('change', function () {
        grid.querySelectorAll('.commission-cb').forEach(function (cb) {
          cb.checked = selectAll.checked;
          var id = parseInt(cb.dataset.pitchId, 10);
          if (selectAll.checked) selectedCommissionIds.add(id); else selectedCommissionIds.delete(id);
          cb.closest('.commission-list-row').classList.toggle('selected', selectAll.checked);
        });
        updateCommissionsBulkBar();
      });
    }
    grid.querySelectorAll('.commission-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = parseInt(cb.dataset.pitchId, 10);
        if (cb.checked) selectedCommissionIds.add(id); else selectedCommissionIds.delete(id);
        cb.closest('.commission-list-row').classList.toggle('selected', cb.checked);
        syncSelectAll();
        updateCommissionsBulkBar();
      });
    });
  }

  function makeCommissionSwimlaneRow(p, groupKey, groupKeyValue) {
    var sc = (typeof p.source_count === 'number' && p.source_count > 0) ? p.source_count : 1;
    var chipColor, chipLabel;
    if (sc <= 1) { chipColor = 'background:rgba(239,68,68,0.18);color:#ef4444;'; chipLabel = '1 &#9888;'; }
    else if (sc === 2) { chipColor = 'background:rgba(251,191,36,0.18);color:#fbbf24;'; chipLabel = '2'; }
    else { chipColor = 'background:rgba(34,197,94,0.18);color:#22c55e;'; chipLabel = sc + ' &#10003;'; }
    var sourceChip = '<span class="badge badge-muted" style="' + chipColor + 'font-size:11px;">' + chipLabel + '</span>';
    // Mid column: category when grouped by writer, from when grouped by category
    var midCol = groupKey === 'writer'
      ? esc(p.source_category || '—')
      : (p.pitched_by_writer_name ? esc(p.pitched_by_writer_name) : 'Ed: ' + esc(p.requested_by_editor_name || 'editor'));
    var angle = p.angle_summary ? (p.angle_summary.length > 80 ? p.angle_summary.slice(0, 80) + '…' : p.angle_summary) : '';
    var titleArg = JSON.stringify(p.source_title || '').replace(/"/g, '&quot;');
    var isProposed = p.status === 'proposed';
    var actions = '';
    if (isProposed) {
      actions = '<button class="btn btn-primary btn-sm" onclick="tryApproveCommission(' + p.id + ',' + sc + ',' + titleArg + ')">Approve</button>'
        + '<button class="btn btn-ghost btn-sm" onclick="rejectCommission(' + p.id + ')">Reject</button>'
        + '<button class="btn btn-outline btn-sm" style="padding:3px 7px;" title="Enrich sources" onclick="openEnrichSources(' + p.id + ',&quot;commission&quot;,[],' + titleArg + ')">+src</button>';
      if (!p.pitched_by_writer_id) actions += '<button class="btn btn-ghost btn-sm" style="padding:3px 7px;" title="Auto-assign" onclick="autoAssignCommission(' + p.id + ')">&#127919;</button>';
    } else if (p.status === 'approved') {
      actions = '<span class="badge badge-accent">Approved</span>';
      if (p.spawned_article_id) actions += ' <a class="btn btn-ghost btn-sm" href="/article-editor.html?id=' + p.spawned_article_id + '">&#8594; Article</a>';
    } else if (p.status === 'published') {
      actions = '<span class="badge badge-success">Published</span>';
      if (p.spawned_article_id) actions += ' <a class="btn btn-ghost btn-sm" href="/article-editor.html?id=' + p.spawned_article_id + '">&#8594; Article</a>';
    } else if (!p.pitched_by_writer_id) {
      actions = '<button class="btn btn-primary btn-sm" onclick="autoAssignCommission(' + p.id + ')">&#127919; Auto-assign</button>'
        + '<button class="btn btn-ghost btn-sm" onclick="openReassignCommission(' + p.id + ')">Assign…</button>';
    }
    return '<div class="commission-swimlane-row" data-pitch="' + p.id + '" data-group-key="' + esc(String(groupKeyValue)) + '">'
      + '<div>' + (isProposed ? '<input type="checkbox" class="commission-cb" data-pitch-id="' + p.id + '" />' : '') + '</div>'
      + '<div style="overflow:hidden;">'
      + '<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(p.source_title || '') + '">' + esc(p.source_title || 'Untitled') + '</div>'
      + (angle ? '<div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(angle) + '</div>' : '')
      + '</div>'
      + '<div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + midCol + '</div>'
      + '<div>' + sourceChip + '</div>'
      + '<div style="font-size:12px;color:var(--muted);white-space:nowrap;">' + relativeTime(p.created_at) + '</div>'
      + '<div style="display:flex;gap:4px;flex-wrap:nowrap;">' + actions + '</div>'
      + '</div>';
  }

  function renderCommissionsGrouped(list, groupKey) {
    var grid = document.getElementById('commissionsGrid');
    grid.className = 'pitch-swimlane';
    if (!list.length) {
      grid.innerHTML = '<div class="review-empty">No commissions found.</div>';
      return;
    }

    var groupMap = {};
    var groupOrder = [];
    list.forEach(function (p) {
      var key, label;
      if (groupKey === 'writer') {
        key = String(p.pitched_by_writer_id || 'editor');
        label = p.pitched_by_writer_name || (p.requested_by_editor_name ? 'Ed: ' + p.requested_by_editor_name : 'Editor');
      } else {
        key = p.source_category || 'Uncategorized';
        label = key;
      }
      if (!groupMap[key]) {
        groupMap[key] = { label: label, writerId: groupKey === 'writer' ? p.pitched_by_writer_id : null, items: [] };
        groupOrder.push(key);
      }
      groupMap[key].items.push(p);
    });

    grid.innerHTML = groupOrder.map(function (key) {
      var group = groupMap[key];
      var proposedCount = group.items.filter(function (p) { return p.status === 'proposed'; }).length;
      var countLabel = group.items.length + ' commission' + (group.items.length !== 1 ? 's' : '')
        + (proposedCount !== group.items.length ? ' · ' + proposedCount + ' proposed' : '');
      var avatarHtml = groupKey === 'writer'
        ? '<div class="swimlane-avatar-ph">&#9997;&#65039;</div>'
        : '<div class="swimlane-avatar-ph" style="font-size:10px;font-weight:700;color:var(--accent);">' + esc(group.label.slice(0, 2).toUpperCase()) + '</div>';
      var writerAttr = (groupKey === 'writer' && group.writerId) ? ' data-writer-id="' + group.writerId + '"' : '';
      var header = '<div class="swimlane-header">'
        + (proposedCount > 0 ? '<input type="checkbox" class="commission-swimlane-cb-all" data-group-key="' + esc(String(key)) + '" title="Select all proposed" />' : '<span style="width:14px;display:inline-block;"></span>')
        + '<span' + writerAttr + (group.writerId ? ' style="display:flex;align-items:center;gap:8px;cursor:pointer;" title="View writer profile"' : ' style="display:flex;align-items:center;gap:8px;"') + '>'
        + avatarHtml
        + '<div><div class="swimlane-writer-name">' + esc(group.label) + '</div><div class="swimlane-pitch-count">' + countLabel + '</div></div>'
        + '</span>'
        + '</div>';
      var midColLabel = groupKey === 'writer' ? 'Category' : 'From';
      var body = '';
      if (commissionsViewMode === 'grid') {
        body = '<div style="padding:12px;background:var(--bg-card);"><div class="review-grid">'
          + group.items.map(makeCommissionCardHtml).join('')
          + '</div></div>';
      } else {
        var listHdr = '<div class="commission-swimlane-hdr"><div></div><div>Title / Angle</div><div>' + midColLabel + '</div><div>Sources</div><div>Age</div><div>Actions</div></div>';
        body = listHdr + group.items.map(function (p) { return makeCommissionSwimlaneRow(p, groupKey, key); }).join('');
      }
      return '<div class="swimlane-group" data-group-key="' + esc(String(key)) + '">' + header + body + '</div>';
    }).join('');

    // Wire swimlane select-all
    grid.querySelectorAll('.commission-swimlane-cb-all').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var gkey = cb.dataset.groupKey;
        grid.querySelectorAll('.commission-swimlane-row[data-group-key="' + gkey + '"] .commission-cb').forEach(function (rowCb) {
          rowCb.checked = cb.checked;
          var id = parseInt(rowCb.dataset.pitchId, 10);
          if (cb.checked) selectedCommissionIds.add(id); else selectedCommissionIds.delete(id);
          rowCb.closest('.commission-swimlane-row').classList.toggle('selected', cb.checked);
        });
        updateCommissionsBulkBar();
      });
    });

    // Wire individual checkboxes
    grid.querySelectorAll('.commission-swimlane-row .commission-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = parseInt(cb.dataset.pitchId, 10);
        if (cb.checked) selectedCommissionIds.add(id); else selectedCommissionIds.delete(id);
        var row = cb.closest('.commission-swimlane-row');
        if (row) row.classList.toggle('selected', cb.checked);
        var gkey = row ? row.dataset.groupKey : null;
        if (gkey) {
          var groupCbs = grid.querySelectorAll('.commission-swimlane-row[data-group-key="' + gkey + '"] .commission-cb');
          var groupChecked = Array.from(groupCbs).filter(function (c) { return c.checked; }).length;
          var groupAll = grid.querySelector('.commission-swimlane-cb-all[data-group-key="' + gkey + '"]');
          if (groupAll) {
            groupAll.indeterminate = groupChecked > 0 && groupChecked < groupCbs.length;
            groupAll.checked = groupCbs.length > 0 && groupChecked === groupCbs.length;
          }
        }
        updateCommissionsBulkBar();
      });
    });
  }

  function updateCommissionsBulkBar() {
    var bar = document.getElementById('commissionBulkBar');
    var countEl = document.getElementById('commissionBulkCount');
    if (!bar) return;
    var n = selectedCommissionIds.size;
    bar.style.display = (n > 0 && commissionFilter === 'proposed') ? 'flex' : 'none';
    if (countEl) countEl.textContent = n + ' selected';
  }

  window.clearCommissionSelection = function () {
    selectedCommissionIds.clear();
    document.querySelectorAll('.commission-cb').forEach(function (cb) { cb.checked = false; });
    document.querySelectorAll('.commission-list-row.selected, .commission-swimlane-row.selected').forEach(function (r) { r.classList.remove('selected'); });
    document.querySelectorAll('.commission-swimlane-cb-all').forEach(function (cb) { cb.checked = false; cb.indeterminate = false; });
    var sa = document.getElementById('selectAllCommissions');
    if (sa) { sa.checked = false; sa.indeterminate = false; }
    updateCommissionsBulkBar();
  };

  window.bulkApproveCommissions = async function () {
    var ids = Array.from(selectedCommissionIds);
    if (!ids.length) return;
    var weak = ids.filter(function (id) {
      var p = _allCommissionsCache.find(function (p) { return p.id === id; });
      return p && (p.source_count || 1) < 2;
    });
    var msg = 'Approve ' + ids.length + ' commission' + (ids.length !== 1 ? 's' : '') + '?';
    if (weak.length) msg += '\n\n' + weak.length + ' commission' + (weak.length !== 1 ? 's have' : ' has') + ' only 1 source and may fail editorial review.';
    if (!confirm(msg)) return;
    var bar = document.getElementById('commissionBulkBar');
    if (bar) bar.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    var ok = 0, fail = 0;
    for (var i = 0; i < ids.length; i++) {
      try { await apiFetch('/pitches/' + ids[i] + '/approve', { method: 'POST', body: JSON.stringify({}) }); ok++; }
      catch { fail++; }
    }
    showAlert('Approved ' + ok + (fail ? ', ' + fail + ' failed' : '') + '.', fail ? 'warning' : 'success');
    await loadCommissions();
  };

  window.bulkRejectCommissions = async function () {
    var ids = Array.from(selectedCommissionIds);
    if (!ids.length) return;
    if (!confirm('Reject ' + ids.length + ' commission' + (ids.length !== 1 ? 's' : '') + '?')) return;
    var bar = document.getElementById('commissionBulkBar');
    if (bar) bar.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    var ok = 0, fail = 0;
    for (var i = 0; i < ids.length; i++) {
      try { await apiFetch('/pitches/' + ids[i] + '/reject', { method: 'POST', body: JSON.stringify({}) }); ok++; }
      catch { fail++; }
    }
    showAlert('Rejected ' + ok + (fail ? ', ' + fail + ' failed' : '') + '.', fail ? 'warning' : 'success');
    await loadCommissions();
  };

  function optimisticRemoveCommissionCard(pitchId) {
    var card = document.querySelector('.review-card[data-pitch="' + pitchId + '"], .commission-list-row[data-pitch="' + pitchId + '"], .commission-swimlane-row[data-pitch="' + pitchId + '"]');
    if (!card) return function () {};
    selectedCommissionIds.delete(pitchId);
    updateCommissionsBulkBar();
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

  var pendingWeakCommission = null;
  window.tryApproveCommission = function (id, sourceCount, sourceTitle) {
    if (sourceCount && sourceCount >= 2) return window.approveCommission(id);
    pendingWeakCommission = { pitchId: id, sourceTitle: sourceTitle || '' };
    openModal('weakCommissionModal');
  };

  window.approveCommission = async function (id) {
    var restore = optimisticRemoveCommissionCard(id);
    try {
      var resp = await apiFetch('/pitches/' + id + '/approve', { method: 'POST', body: JSON.stringify({}) });
      if (resp && resp.synthesis_queued === false) {
        toast('Approved. No synthesis queued (editor tip awaiting writer assignment).', 'success');
      } else {
        toast('Commission approved.', 'success');
      }
      await loadCommissions();
    } catch (err) {
      if (err && err.message === 'cap_reached') {
        restore();
        await loadCommissions();
        pendingOverrideCommission = { pitchId: id };
        document.getElementById('overrideCommissionMessage').textContent =
          'This source already has the maximum number of originals (per the max_originals_per_source setting). Approve anyway?';
        document.getElementById('overrideCommissionNote').value = '';
        openModal('overrideCommissionModal');
        return;
      }
      restore();
      toast('Approve failed: ' + (err.message || err), 'error');
      await loadCommissions();
    }
  };

  window.rejectCommission = async function (id) {
    var note = prompt('Optional note for this rejection (blank to skip):');
    if (note === null) return;
    var restore = optimisticRemoveCommissionCard(id);
    try {
      await apiFetch('/pitches/' + id + '/reject', { method: 'POST', body: JSON.stringify({ note: note || undefined }) });
      toast('Commission rejected.', 'success');
      await loadCommissions();
    } catch (err) {
      restore();
      toast('Reject failed: ' + (err.message || err), 'error');
      await loadCommissions();
    }
  };

  // ── Enrich — web pane wiring ──────────────────────────────

  function wireEnrichCommissionModal() {
    document.getElementById('enrichCommissionSearchBtn').addEventListener('click', async function () {
      var query = document.getElementById('enrichCommissionQuery').value.trim();
      if (query.length < 4) { toast('Enter a topic (4+ chars).', 'warning'); return; }
      var resultsEl = document.getElementById('enrichCommissionResults');
      resultsEl.innerHTML = '<div class="text-muted" style="padding:24px;text-align:center;">Searching…</div>';
      document.getElementById('enrichCommissionIngestBtn').disabled = true;
      try {
        var data = await apiFetch('/research/search', { method: 'POST', body: JSON.stringify({ query: query, count: 10 }) });
        _enrichWebCache = data.results || [];
        document.getElementById('enrichCommissionQuotaInfo').textContent =
          'Quota: ' + (data.quota_used || 0) + ' / ' + (data.quota_cap || 0) + ' searches today';
        if (!_enrichWebCache.length) {
          resultsEl.innerHTML = '<div class="text-muted" style="padding:24px;text-align:center;">No external results.</div>';
          return;
        }
        // Check which URLs are already in the DB to prevent duplicate ingestion
        var urls = _enrichWebCache.map(function (r) { return r.url; }).filter(Boolean);
        var existingUrls = new Set();
        try {
          var ck = await apiFetch('/research/check-urls', { method: 'POST', body: JSON.stringify({ urls: urls }) });
          (ck.existing || []).forEach(function (u) { existingUrls.add(u); });
        } catch { /* dedup check is best-effort */ }

        resultsEl.innerHTML = _enrichWebCache.map(function (r, i) {
          var alreadyIn = existingUrls.has(r.url);
          var meta = [r.publisher || r.source, r.score ? (r.score + ' pts') : '', r.published || ''].filter(Boolean).join(' · ');
          return '<label style="display:flex;gap:10px;padding:10px;border-bottom:1px solid var(--border);cursor:pointer;' + (alreadyIn ? 'opacity:0.5;' : '') + '">'
            + '<input type="checkbox" data-idx="' + i + '" class="enrich-commission-cb"' + (alreadyIn ? ' disabled' : '') + ' />'
            + '<div style="flex:1;min-width:0;">'
            + '<div style="font-weight:600;">' + esc(r.title || '(untitled)')
              + (alreadyIn ? ' <span style="font-size:10px;color:var(--muted);background:var(--surface2);padding:1px 5px;border-radius:4px;">already ingested</span>' : '')
              + '</div>'
            + '<div class="text-muted" style="font-size:12px;margin:2px 0;">' + esc(meta) + '</div>'
            + '<div style="font-size:12px;color:var(--text);">' + esc((r.snippet || '').slice(0, 200)) + '</div>'
            + '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" style="font-size:11px;">' + esc(r.url) + '</a>'
            + '</div></label>';
        }).join('');
        resultsEl.querySelectorAll('.enrich-commission-cb').forEach(function (cb) {
          cb.addEventListener('change', function () {
            var any = !!resultsEl.querySelector('.enrich-commission-cb:checked');
            document.getElementById('enrichCommissionIngestBtn').disabled = !any;
          });
        });
      } catch (err) {
        resultsEl.innerHTML = '<div style="color:var(--danger);padding:24px;text-align:center;">Search failed: ' + esc(err.message || err) + '</div>';
      }
    });

    document.getElementById('enrichCommissionIngestBtn').addEventListener('click', async function () {
      var picked = [];
      document.querySelectorAll('.enrich-commission-cb:checked').forEach(function (cb) {
        picked.push(_enrichWebCache[parseInt(cb.dataset.idx, 10)]);
      });
      if (!picked.length) return;
      var btn = this;
      btn.disabled = true; btn.textContent = 'Ingesting…';
      try {
        var data = await apiFetch('/research/ingest', {
          method: 'POST',
          body: JSON.stringify({ results: picked, pitch_id: _enrichCtx.pitchId }),
        });
        var ingested = data.ingested?.length || 0;
        var skipped  = data.skipped?.length  || 0;
        closeModal('enrichCommissionModal');
        toast('Ingested ' + ingested + (skipped ? ' · ' + skipped + ' skipped (already in library)' : '') + '.', 'success');
        if (_enrichCtx.pitchType === 'story') await loadPitches();
        else await loadCommissions();
      } catch (err) {
        toast('Ingest failed: ' + (err.message || err), 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Ingest selected';
      }
    });
  }

  var writersListCache = [];
  var reassignCommissionId = null;

  async function loadWritersListCache() {
    if (writersListCache.length) return writersListCache;
    try {
      var data = await apiFetch('/writers');
      writersListCache = Array.isArray(data) ? data : (data.writers || []);
    } catch { writersListCache = []; }
    return writersListCache;
  }

  function fillWriterSelect(sel) {
    sel.innerHTML = '<option value="">— Editor tip (assign later) —</option>'
      + writersListCache.map(function (w) {
        return '<option value="' + w.id + '">' + esc(w.name) + (w.beat ? ' (' + esc(w.beat) + ')' : '') + '</option>';
      }).join('');
  }

  window.openReassignCommission = async function (pitchId) {
    reassignCommissionId = pitchId;
    await loadWritersListCache();
    fillWriterSelect(document.getElementById('reassignCommissionWriter'));
    openModal('reassignCommissionModal');
  };

  // One-click auto-assign: server picks the best writer via findBestWriter.
  // If the pitch is already approved, synthesis kicks off right after the
  // assignment so the orphan unsticks without a manual approve step.
  window.autoAssignCommission = async function (pitchId) {
    var card = document.querySelector('.review-card[data-pitch="' + pitchId + '"]');
    if (card) card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      var result = await apiFetch('/pitches/' + pitchId + '/auto-assign', { method: 'POST' });
      var name = result && result.writer ? result.writer.name : 'writer';
      var suffix = result && result.synthesis_queued ? ' — synthesis queued.' : '.';
      toast('Auto-assigned to ' + name + suffix, 'success');
      await loadCommissions();
    } catch (err) {
      if (card) card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      var msg = err && err.message ? err.message : String(err);
      if (/no_eligible_writer/.test(msg)) {
        toast('No eligible writers — add one or assign manually.', 'error');
      } else {
        toast('Auto-assign failed: ' + msg, 'error');
      }
    }
  };

  // Bulk auto-assign all orphans in the current tenant. Server caps at 50.
  window.autoAssignAllOrphans = async function () {
    if (!confirm('Run auto-assign on every orphaned commissioned pitch (up to 50)?')) return;
    var btn = document.getElementById('autoAssignAllBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Assigning…'; }
    try {
      var result = await apiFetch('/pitches/auto-assign-orphans', { method: 'POST' });
      toast('Assigned ' + result.assigned + ', skipped ' + result.skipped + '.', result.assigned ? 'success' : 'info');
      await loadCommissions();
    } catch (err) {
      toast('Bulk auto-assign failed: ' + (err.message || err), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🎯 Auto-assign all'; }
    }
  };

  function wireReassignCommission() {
    document.getElementById('confirmReassignCommissionBtn').addEventListener('click', async function () {
      var writerId = parseInt(document.getElementById('reassignCommissionWriter').value, 10);
      if (!writerId || !reassignCommissionId) return;
      var btn = this; btn.disabled = true; btn.textContent = 'Assigning…';
      closeModal('reassignCommissionModal');
      var restore = optimisticRemoveCommissionCard(reassignCommissionId);
      var pitchId = reassignCommissionId;
      try {
        await apiFetch('/pitches/' + pitchId + '/assign', { method: 'PATCH', body: JSON.stringify({ writer_id: writerId }) });
        toast('Writer assigned.', 'success');
        await loadCommissions();
      } catch (err) {
        restore();
        toast('Assign failed: ' + (err.message || err), 'error');
        await loadCommissions();
      } finally {
        btn.disabled = false; btn.textContent = 'Assign';
      }
    });
  }

  function wireWeakCommissionModal() {
    document.getElementById('weakCommissionEnrichFirstBtn').addEventListener('click', function () {
      if (!pendingWeakCommission) return;
      var p = pendingWeakCommission;
      pendingWeakCommission = null;
      closeModal('weakCommissionModal');
      window.openEnrichCommission(p.pitchId, p.sourceTitle);
    });
    document.getElementById('weakCommissionApproveAnywayBtn').addEventListener('click', function () {
      if (!pendingWeakCommission) return;
      var pid = pendingWeakCommission.pitchId;
      pendingWeakCommission = null;
      closeModal('weakCommissionModal');
      window.approveCommission(pid);
    });
  }

  var pendingOverrideCommission = null;
  function wireOverrideCommissionModal() {
    document.getElementById('confirmOverrideCommissionBtn').addEventListener('click', async function () {
      if (!pendingOverrideCommission) return;
      var note = document.getElementById('overrideCommissionNote').value.trim();
      if (!note) { alert('Justification is required for override.'); return; }
      var btn = this;
      btn.disabled = true; btn.textContent = 'Approving…';
      var pitchId = pendingOverrideCommission.pitchId;
      closeModal('overrideCommissionModal');
      var restore = optimisticRemoveCommissionCard(pitchId);
      try {
        await apiFetch('/pitches/' + pitchId + '/approve', { method: 'POST', body: JSON.stringify({ note: note, override: true }) });
        pendingOverrideCommission = null;
        document.getElementById('overrideCommissionNote').value = '';
        toast('Commission approved with override.', 'success');
        await loadCommissions();
      } catch (err) {
        restore();
        toast('Override approve failed: ' + (err.message || err), 'error');
        await loadCommissions();
      } finally {
        btn.disabled = false; btn.textContent = 'Approve with override';
      }
    });
  }

  var COMMISSION_TEMPLATES = {
    compliance: 'The compliance angle: explore how this affects regulatory obligations, audit posture, and the gap between current practice and what auditors will start asking about.',
    technical: 'Technical deep-dive: walk through the actual mechanics — how the attack/system works at a protocol/code level, the specific primitives involved, and what defenders should look for in logs.',
    market: 'Market impact: who benefits, who loses, what shifts in vendor positioning or capital flows this signals, and what competitors are likely to do in the next 30-90 days.',
    contrarian: 'Contrarian take: the prevailing narrative is X, but here\'s why the consensus is missing the point. Make a specific, defensible claim that runs against the wire.',
    explainer: 'Explainer for non-experts: assume the reader has heard the headline but doesn\'t know why it matters. Build the why in three layers — what happened, what it means for them, what to watch next.',
    forecast: 'Predictive forecast: based on this story plus the pattern of related events over the past N months, here\'s what I expect to happen in the next 1-4 weeks.',
    sentiment: 'Community sentiment angle: what practitioners on HN/Reddit/Twitter are actually saying versus the corporate framing. Pull representative quotes and note where the gap is widest.',
    historical: 'Historical context: this isn\'t the first time something like this has happened — here\'s the pattern, three prior incidents that rhyme, and what the field learned from them.',
  };

  function wireNewCommission() {
    document.getElementById('newCommissionTemplate').addEventListener('change', function (e) {
      var key = e.target.value;
      var textarea = document.getElementById('newCommissionAngle');
      if (key && COMMISSION_TEMPLATES[key] && (!textarea.value.trim() || confirm('Replace current angle text with template?'))) {
        textarea.value = COMMISSION_TEMPLATES[key];
        textarea.focus();
      }
    });

    document.getElementById('newCommissionBtn').addEventListener('click', async function () {
      await loadWritersListCache();
      fillWriterSelect(document.getElementById('newCommissionWriter'));
      document.getElementById('newCommissionSource').value = '';
      document.getElementById('newCommissionAngle').value = '';
      document.getElementById('newCommissionTemplate').value = '';
      openModal('newCommissionModal');
    });

    document.getElementById('submitNewCommissionBtn').addEventListener('click', async function () {
      var sourceRef = document.getElementById('newCommissionSource').value.trim();
      var writerId = parseInt(document.getElementById('newCommissionWriter').value, 10);
      var angle = document.getElementById('newCommissionAngle').value.trim();
      if (!sourceRef) { alert('Source required.'); return; }
      if (!writerId) { alert('Writer required (use /tip chat command for unassigned editor tips).'); return; }
      if (angle.length < 10) { alert('Angle must be 10+ chars.'); return; }

      var sourceId = parseInt(sourceRef, 10);
      if (!sourceId) {
        var slugMatch = sourceRef.match(/\/article\/([a-z0-9-]+)/i);
        var slug = slugMatch ? slugMatch[1] : sourceRef.replace(/^https?:\/\/[^/]+\//, '');
        try {
          var prev = await apiFetch('/articles/preview-by-slug?slug=' + encodeURIComponent(slug));
          sourceId = prev.article && prev.article.id;
        } catch (err) {
          if (/^https?:\/\//i.test(sourceRef)) {
            try {
              var meta = await apiFetch('/fetch-url?url=' + encodeURIComponent(sourceRef));
              var result = { source: 'manual', url: sourceRef, title: meta.title || sourceRef, snippet: meta.summary || '', publisher: meta.source || '', published: meta.published_at || null };
              var ingested = await apiFetch('/research/ingest', { method: 'POST', body: JSON.stringify({ results: [result] }) });
              if (ingested.ingested && ingested.ingested.length) sourceId = ingested.ingested[0].id;
              else if (ingested.skipped && ingested.skipped[0] && ingested.skipped[0].existing_id) sourceId = ingested.skipped[0].existing_id;
            } catch (err2) {
              alert('Could not ingest external URL: ' + (err2.message || err2));
              return;
            }
          } else {
            alert('Could not find article for "' + sourceRef + '"'); return;
          }
        }
      }
      if (!sourceId) { alert('Could not resolve source.'); return; }

      var btn = this; btn.disabled = true; btn.textContent = 'Submitting…';
      closeModal('newCommissionModal');
      try {
        await apiFetch('/pitches', { method: 'POST', body: JSON.stringify({ source_article_id: sourceId, pitched_by_writer_id: writerId, angle_summary: angle }) });
        toast('Commission submitted.', 'success');
        await loadCommissions();
      } catch (err) {
        toast('Submit failed: ' + (err.message || err), 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Submit';
      }
    });
  }

  // ── Polling ───────────────────────────────────────────────

  var pollTimer = null;
  function updatePolling() {
    var active = (activeTab === 'pitches' || activeTab === 'commissions') && document.visibilityState !== 'hidden';
    if (active && !pollTimer) {
      pollTimer = setInterval(function () {
        if (document.visibilityState === 'hidden') return;
        if (activeTab === 'pitches') loadPitches();
        else if (activeTab === 'commissions') loadCommissions();
      }, 15000);
    } else if (!active && pollTimer) {
      clearInterval(pollTimer); pollTimer = null;
    }
  }
  document.addEventListener('visibilitychange', updatePolling);

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

    wireEnrichCommissionModal();
    wireReassignCommission();
    wireWeakCommissionModal();
    wireOverrideCommissionModal();
    wireNewCommission();

    // Pitch view toggle
    var toggleBtns = document.querySelectorAll('#pitchViewToggle .view-toggle-btn');
    function applyViewMode() {
      toggleBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.view === viewMode); });
    }
    toggleBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        viewMode = btn.dataset.view;
        localStorage.setItem('dfai_pitches_view', viewMode);
        applyViewMode();
        loadPitches();
      });
    });
    applyViewMode();

    // Pitch group toggle
    var groupBtns = document.querySelectorAll('#pitchGroupToggle .view-toggle-btn');
    function applyGroupBy() {
      groupBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.group === groupBy); });
    }
    groupBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        groupBy = btn.dataset.group;
        localStorage.setItem('dfai_pitches_group', groupBy);
        applyGroupBy();
        loadPitches();
      });
    });
    applyGroupBy();

    // Commission view toggle
    var commToggleBtns = document.querySelectorAll('#commissionViewToggle .view-toggle-btn');
    function applyCommissionViewMode() {
      commToggleBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.cview === commissionsViewMode); });
    }
    commToggleBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        commissionsViewMode = btn.dataset.cview;
        localStorage.setItem('dfai_commissions_view', commissionsViewMode);
        applyCommissionViewMode();
        if (activeTab === 'commissions') loadCommissions();
      });
    });
    applyCommissionViewMode();

    // Commission group toggle
    var commGroupBtns = document.querySelectorAll('#commissionGroupToggle .view-toggle-btn');
    function applyCommissionsGroupBy() {
      commGroupBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.cgroup === commissionsGroupBy); });
    }
    commGroupBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        commissionsGroupBy = btn.dataset.cgroup;
        localStorage.setItem('dfai_commissions_group', commissionsGroupBy);
        applyCommissionsGroupBy();
        if (activeTab === 'commissions') loadCommissions();
      });
    });
    applyCommissionsGroupBy();

    loadPitches();
    loadCommissions(); // populate Commissions tab badge on load (grid is hidden until tab is clicked)
    updatePolling();
  }

  function relativeTime(ts) {
    if (!ts) return '';
    var seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  onReady(function () {
    if (!requireAuth()) return;
    init();
    window.pageRefresh = function () {
      if (activeTab === 'commissions') return loadCommissions();
      if (activeTab === 'newsroom') return loadNewsroom();
      return loadPitches();
    };
  });
})();
