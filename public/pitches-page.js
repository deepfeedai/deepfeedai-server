/**
 * Pitches Page — agent pitches (story_pitches) + editor commissions (article_pitches) + newsroom feed.
 */
(function () {
  var writers = [];
  var activeTab = 'pitches';

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

    var url = '/admin/pitches?status=' + status;
    if (writerId !== 'all') url += '&writer_id=' + writerId;

    try {
      var data = await apiFetch(url);
      var pitches = data.pitches || [];
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

  function optimisticRemovePitchCard(pitchId) {
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
      var data = await apiFetch('/pitches?' + commissionFilterToQuery(commissionFilter));
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
    var grid = document.getElementById('commissionsGrid');
    if (!list.length) {
      grid.innerHTML = '<div class="review-empty">No commissions awaiting review.</div>';
      return;
    }
    grid.innerHTML = list.map(function (p) {
      var ago = p.created_at ? relativeTime(p.created_at) : '';
      var initiator = p.pitched_by_writer_name
        ? 'Pitched by <strong>' + esc(p.pitched_by_writer_name) + '</strong>'
        : 'Editor tip from <strong>' + esc(p.requested_by_editor_name || 'editor') + '</strong>';
      var sourceUrl = p.source_url ? '<a href="' + esc(p.source_url) + '" target="_blank" rel="noopener" class="text-muted" style="font-size:12px;">↗ ' + esc(p.source_publisher || 'source') + '</a>' : '';

      var sc = (typeof p.source_count === 'number' && p.source_count > 0) ? p.source_count : 1;
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
      var sourceChip = '<span class="badge badge-muted" title="Attached source count" style="' + chipColor + 'margin-right:6px;">' + chipLabel + '</span>';

      var titleArg = JSON.stringify(p.source_title || '').replace(/"/g, '&quot;');
      var html = '<div class="review-card" data-pitch="' + p.id + '">';
      html += '<div class="review-card-header">';
      html += '<div class="review-title">' + esc(p.source_title || 'Untitled source') + '</div>';
      var typeBadge = (window.renderPitchTypeBadge && p.pitch_type) ? window.renderPitchTypeBadge(p.pitch_type) : '';
      html += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' + typeBadge + sourceChip + '<span class="badge badge-muted" style="background:rgba(124,58,237,0.15);color:#a78bfa;">COMMISSION</span></div>';
      html += '</div>';
      html += '<div class="review-meta">';
      html += '<span>' + initiator + '</span>';
      html += '<span>' + ago + '</span>';
      if (p.source_category) html += '<span>' + esc(p.source_category) + '</span>';
      if (sourceUrl) html += '<span>' + sourceUrl + '</span>';
      html += '</div>';
      html += '<div class="review-suggestion">';
      html += '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Angle</div>';
      html += esc(p.angle_summary || '');
      html += '</div>';
      // Status-dependent action buttons. Orphaned / approved views need
      // different affordances than the default proposed queue.
      html += '<div class="review-actions">';
      if (p.status === 'proposed') {
        html += '<button class="btn btn-primary btn-sm" onclick="tryApproveCommission(' + p.id + ',' + sc + ',' + titleArg + ')">Approve</button>';
        html += '<button class="btn btn-outline btn-sm" onclick="rejectCommission(' + p.id + ')">Reject</button>';
        html += '<button class="btn btn-ghost btn-sm" onclick="openEnrichCommission(' + p.id + ', ' + titleArg + ')">Enrich sources</button>';
        if (sc === 2) {
          html += '<span class="text-muted" style="font-size:12px;align-self:center;color:#fbbf24;">Consider enriching &mdash; 2 sources is thin</span>';
        }
      } else if (p.status === 'approved') {
        html += '<span class="badge badge-accent" style="align-self:center;">Approved</span>';
        if (p.spawned_article_id) {
          html += '<a class="btn btn-ghost btn-sm" href="/article-editor.html?id=' + p.spawned_article_id + '">→ Open article</a>';
        }
      } else if (p.status === 'published') {
        html += '<span class="badge badge-success" style="align-self:center;">Published</span>';
        if (p.spawned_article_id) {
          html += '<a class="btn btn-ghost btn-sm" href="/article-editor.html?id=' + p.spawned_article_id + '">→ Open article</a>';
        }
      }
      if (!p.pitched_by_writer_id) {
        html += '<button class="btn btn-primary btn-sm" onclick="autoAssignCommission(' + p.id + ')" title="Pick the best writer automatically via beat match">🎯 Auto-assign</button>';
        html += '<button class="btn btn-ghost btn-sm" onclick="openReassignCommission(' + p.id + ')">Assign writer…</button>';
      }
      html += '</div>';
      html += '</div>';
      return html;
    }).join('');
  }

  function optimisticRemoveCommissionCard(pitchId) {
    var card = document.querySelector('.review-card[data-pitch="' + pitchId + '"]');
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

  // ── Commission modals ─────────────────────────────────────

  var enrichCommissionId = null;
  var enrichCommissionResultsCache = [];

  window.openEnrichCommission = function (pitchId, sourceTitle) {
    enrichCommissionId = pitchId;
    enrichCommissionResultsCache = [];
    document.getElementById('enrichCommissionQuery').value = sourceTitle || '';
    document.getElementById('enrichCommissionResults').innerHTML = '<div class="text-muted" style="padding:24px 8px;text-align:center;">Press Search to find external coverage.</div>';
    document.getElementById('enrichCommissionQuotaInfo').textContent = '';
    document.getElementById('enrichCommissionIngestBtn').disabled = true;
    openModal('enrichCommissionModal');
  };

  function wireEnrichCommissionModal() {
    document.getElementById('enrichCommissionSearchBtn').addEventListener('click', async function () {
      var query = document.getElementById('enrichCommissionQuery').value.trim();
      if (query.length < 4) { alert('Enter a topic (4+ chars).'); return; }
      var resultsEl = document.getElementById('enrichCommissionResults');
      resultsEl.innerHTML = '<div class="text-muted" style="padding:24px;text-align:center;">Searching…</div>';
      try {
        var data = await apiFetch('/research/search', { method: 'POST', body: JSON.stringify({ query: query, count: 10 }) });
        enrichCommissionResultsCache = data.results || [];
        document.getElementById('enrichCommissionQuotaInfo').textContent =
          'Quota: ' + (data.quota_used || 0) + ' / ' + (data.quota_cap || 0) + ' searches today';
        if (!enrichCommissionResultsCache.length) {
          resultsEl.innerHTML = '<div class="text-muted" style="padding:24px;text-align:center;">No external results. Errors: ' + JSON.stringify(data.errors || []) + '</div>';
          document.getElementById('enrichCommissionIngestBtn').disabled = true;
          return;
        }
        resultsEl.innerHTML = enrichCommissionResultsCache.map(function (r, i) {
          var meta = [r.publisher || r.source, r.score ? (r.score + ' pts') : '', r.published || ''].filter(Boolean).join(' · ');
          return '<label style="display:flex;gap:10px;padding:10px;border-bottom:1px solid var(--border);cursor:pointer;">'
            + '<input type="checkbox" data-idx="' + i + '" class="enrich-commission-cb" />'
            + '<div style="flex:1;min-width:0;">'
            + '<div style="font-weight:600;">' + esc(r.title || '(untitled)') + '</div>'
            + '<div class="text-muted" style="font-size:12px;margin:2px 0;">' + esc(meta) + '</div>'
            + '<div style="font-size:12px;color:var(--text);">' + esc((r.snippet || '').slice(0, 200)) + '</div>'
            + '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" style="font-size:11px;">' + esc(r.url) + '</a>'
            + '</div></label>';
        }).join('');
        document.querySelectorAll('.enrich-commission-cb').forEach(function (cb) {
          cb.addEventListener('change', function () {
            var any = !!document.querySelector('.enrich-commission-cb:checked');
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
        picked.push(enrichCommissionResultsCache[parseInt(cb.dataset.idx, 10)]);
      });
      if (!picked.length) return;
      var btn = this;
      btn.disabled = true; btn.textContent = 'Ingesting…';
      try {
        var data = await apiFetch('/research/ingest', { method: 'POST', body: JSON.stringify({ results: picked, pitch_id: enrichCommissionId }) });
        alert('Ingested: ' + (data.ingested?.length || 0) + ' · Skipped: ' + (data.skipped?.length || 0));
        closeModal('enrichCommissionModal');
        await loadCommissions();
      } catch (err) {
        alert('Ingest failed: ' + (err.message || err));
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

    loadPitches();
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
  });
})();
