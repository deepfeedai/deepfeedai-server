/* global apiFetch, requireAuth, showAlert */
(function () {
  'use strict';

  var state = { date: todayString(), candidates: [], selectedId: null };

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function todayString() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function toast(msg, type) {
    if (typeof showAlert === 'function') showAlert(msg, type || 'success');
    else console.log('[editorial-intelligence]', type || 'info', msg);
  }

  function statusPill(status) {
    var cls = status === 'approved' || status === 'added_to_runsheet' ? ' ei-pill-approved'
      : status === 'rejected' ? ' ei-pill-rejected' : '';
    return '<span class="ei-pill' + cls + '">' + esc(status || 'proposed') + '</span>';
  }

  function renderCards() {
    var el = document.getElementById('eiCards');
    var count = document.getElementById('eiCount');
    if (count) count.textContent = String(state.candidates.length);
    if (!el) return;
    if (!state.candidates.length) {
      el.innerHTML = '<div class="ei-empty">No candidates yet. Run a planning pass.</div>';
      renderDetail(null);
      return;
    }
    if (!state.selectedId) state.selectedId = state.candidates[0].id;
    el.innerHTML = state.candidates.map(function (c) {
      var b = c.brief || {};
      var active = c.id === state.selectedId ? ' active' : '';
      var score = Math.round(c.score || 0);
      var srcCount = (c.source_article_ids || []).length;
      return [
        '<button class="ei-card' + active + '" data-id="' + esc(c.id) + '">',
          '<div class="ei-card-title">' + esc((b.headline || c.title || '').slice(0, 180)) + '</div>',
          '<div class="ei-card-row">',
            '<span class="ei-pill ei-pill-score">' + score + '</span>',
            '<span class="ei-pill">' + esc(b.priority || 'standard') + '</span>',
            '<span class="ei-pill">' + esc(b.pitch_type || c.signal?.editorial_value || 'analysis') + '</span>',
            '<span class="ei-pill">' + srcCount + ' sources</span>',
            statusPill(b.status || c.status),
          '</div>',
        '</button>',
      ].join('');
    }).join('');
    renderDetail(state.candidates.find(function (c) { return c.id === state.selectedId; }));
  }

  function renderScoreGrid(c) {
    var comps = c.score_components || {};
    var labels = {
      source_density: 'Density',
      source_diversity: 'Diversity',
      freshness: 'Freshness',
      velocity: 'Velocity',
      novelty: 'Novelty',
      thread_connection: 'Thread',
      writer_fit: 'Writer fit',
    };
    return '<div class="ei-score-grid">' + Object.keys(labels).map(function (key) {
      return '<div class="ei-score-row"><strong>' + esc(String(comps[key] || 0)) + '</strong>' + esc(labels[key]) + '</div>';
    }).join('') + '</div>';
  }

  function renderDetail(c) {
    var el = document.getElementById('eiDetail');
    var statusEl = document.getElementById('eiBriefStatus');
    if (!el) return;
    if (!c) {
      if (statusEl) statusEl.textContent = '';
      el.innerHTML = '<div class="ei-empty">Select a candidate.</div>';
      return;
    }
    var b = c.brief || {};
    if (statusEl) statusEl.innerHTML = statusPill(b.status || c.status);
    var evidence = b.evidence || c.source_articles || [];
    var canApprove = b.id && b.status !== 'approved' && b.status !== 'added_to_runsheet';
    var canReject = b.id && b.status !== 'rejected' && b.status !== 'added_to_runsheet';
    var canAdd = b.id && b.status === 'approved';
    el.innerHTML = [
      '<div>',
        '<div class="ei-section-label">Headline</div>',
        '<div class="ei-section-text"><strong>' + esc(b.headline || c.title) + '</strong></div>',
      '</div>',
      '<div>',
        '<div class="ei-section-label">Angle</div>',
        '<div class="ei-section-text">' + esc(b.angle || c.summary || '') + '</div>',
      '</div>',
      '<div>',
        '<div class="ei-section-label">Why Now</div>',
        '<div class="ei-section-text">' + esc(b.why_now || '') + '</div>',
      '</div>',
      '<div>',
        '<div class="ei-section-label">Audience Value</div>',
        '<div class="ei-section-text">' + esc(b.audience_value || '') + '</div>',
      '</div>',
      '<div>',
        '<div class="ei-section-label">Plan</div>',
        '<div class="ei-card-row">',
          '<span class="ei-pill">' + esc(b.priority || 'standard') + '</span>',
          '<span class="ei-pill">' + esc(b.pitch_type || 'analysis') + '</span>',
          b.recommended_writer_name ? '<span class="ei-pill">' + esc(b.recommended_writer_name) + '</span>' : '',
          b.target_publish_window ? '<span class="ei-pill">' + esc(b.target_publish_window) + '</span>' : '',
        '</div>',
      '</div>',
      '<div>',
        '<div class="ei-section-label">Score</div>',
        renderScoreGrid(c),
      '</div>',
      '<div>',
        '<div class="ei-section-label">Evidence</div>',
        evidence.length ? evidence.map(function (src) {
          return '<div class="ei-source"><div class="ei-source-title">' + esc(src.title || ('Source #' + src.id)) + '</div><div class="ei-meta">' + esc(src.source || '') + '</div></div>';
        }).join('') : '<div class="ei-meta">No source evidence attached.</div>',
      '</div>',
      '<div class="ei-actions">',
        canApprove ? '<button class="btn btn-primary btn-sm" data-action="approve" data-id="' + esc(b.id) + '">Approve Brief</button>' : '',
        canAdd ? '<button class="btn btn-secondary btn-sm" data-action="add" data-id="' + esc(b.id) + '">Add to Runsheet</button>' : '',
        canReject ? '<button class="btn btn-ghost btn-sm" data-action="reject" data-id="' + esc(b.id) + '">Reject</button>' : '',
        b.added_budget_slot_id ? '<a class="btn btn-ghost btn-sm" href="/budget.html?date=' + encodeURIComponent(state.date) + '">View Runsheet</a>' : '',
      '</div>',
    ].join('');
  }

  async function load() {
    var summary = document.getElementById('eiSummary');
    try {
      var data = await apiFetch('/admin/editorial-intelligence/candidates?date=' + encodeURIComponent(state.date));
      state.candidates = data.candidates || [];
      if (summary) summary.textContent = state.candidates.length + ' candidates for ' + state.date;
      renderCards();
    } catch (err) {
      toast('Failed to load planning board: ' + err.message, 'error');
    }
  }

  async function runPlanning() {
    var btn = document.getElementById('eiRunBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Running...'; }
    try {
      var result = await apiFetch('/admin/editorial-intelligence/run', {
        method: 'POST',
        body: JSON.stringify({ date: state.date, limit: 12 }),
      });
      toast('Planning pass created ' + ((result.briefs || []).length) + ' briefs', 'success');
      state.selectedId = null;
      await load();
    } catch (err) {
      toast('Planning pass failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Run Planning Pass'; }
    }
  }

  async function mutateBrief(action, id) {
    var path = '/admin/editorial-intelligence/briefs/' + id + '/' + action;
    var body = action === 'add-to-runsheet' ? { date: state.date } : {};
    try {
      await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
      toast(action === 'add-to-runsheet' ? 'Added to runsheet' : 'Brief updated', 'success');
      await load();
    } catch (err) {
      toast('Action failed: ' + err.message, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (typeof requireAuth === 'function' && !requireAuth()) return;
    var dateEl = document.getElementById('eiDate');
    if (dateEl) {
      dateEl.value = state.date;
      dateEl.addEventListener('change', function () {
        state.date = dateEl.value || todayString();
        state.selectedId = null;
        load();
      });
    }
    document.getElementById('eiRunBtn')?.addEventListener('click', runPlanning);
    document.getElementById('eiRefreshBtn')?.addEventListener('click', load);
    document.getElementById('eiCards')?.addEventListener('click', function (e) {
      var btn = e.target.closest('.ei-card');
      if (!btn) return;
      state.selectedId = parseInt(btn.dataset.id, 10);
      renderCards();
    });
    document.getElementById('eiDetail')?.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      if (action === 'add') return mutateBrief('add-to-runsheet', btn.dataset.id);
      return mutateBrief(action, btn.dataset.id);
    });
    load();
  });
})();
