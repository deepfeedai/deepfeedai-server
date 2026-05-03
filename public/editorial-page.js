/* eslint-disable no-unused-vars */
/* global apiFetch */
(function () {
  'use strict';

  renderSidebar();

  var articles   = [];
  var selectedIds = new Set();

  init();
  window.pageRefresh = loadReviewQueue;

  async function init() {
    initModals();
    await loadReviewQueue();
  }

  function toast(msg, type) {
    if (typeof window.showAlert === 'function') {
      window.showAlert(msg, type || 'success');
    } else if (type === 'error') {
      alert(msg);
    }
  }

  async function loadReviewQueue() {
    try {
      var data = await apiFetch('/articles/review-queue');
      articles = data.articles || [];
      selectedIds.clear();
      renderStats(articles);
      renderSelectBar();
      renderGrid(articles);
    } catch (err) {
      document.getElementById('reviewGrid').innerHTML = '<div class="review-empty">Failed to load review queue: ' + (err.message || err) + '</div>';
    }
  }

  function renderStats(list) {
    var el = document.getElementById('reviewStats');
    var total = list.length;
    var avgScore = total ? Math.round(list.reduce(function (s, a) {
      var v = a.editor_verdict;
      if (typeof v === 'string') try { v = JSON.parse(v); } catch { v = null; }
      return s + (v?.score || 0);
    }, 0) / total * 10) / 10 : 0;

    el.innerHTML =
      '<div class="review-stat"><div class="review-stat-num">' + total + '</div><div class="review-stat-label">Pending Review</div></div>' +
      '<div class="review-stat"><div class="review-stat-num">' + avgScore + '</div><div class="review-stat-label">Avg Editor Score</div></div>';
  }

  // ── Selection bar ────────────────────────────────────────────────────────────

  function renderSelectBar() {
    var bar = document.getElementById('reviewSelectBar');
    if (!bar) return;
    if (!articles.length) { bar.innerHTML = ''; return; }

    var n        = selectedIds.size;
    var allCount = articles.length;
    var allChecked = n === allCount;
    var indeterminate = n > 0 && n < allCount;

    bar.innerHTML = '<div class="review-select-bar">'
      + '<label>'
        + '<input type="checkbox" id="selectAllCb"' + (allChecked ? ' checked' : '') + ' onchange="toggleSelectAll(this.checked)" />'
        + (n === 0 ? 'Select all ' + allCount : n + ' of ' + allCount + ' selected')
      + '</label>'
      + (n > 0
          ? '<span class="review-bulk-actions">'
              + '<button class="btn btn-primary btn-sm" onclick="bulkAction(\'approve\')" id="ba-approve">Approve & Publish</button>'
              + '<button class="btn btn-warning btn-sm" onclick="bulkAction(\'reject-draft\')" id="ba-reject-draft">Reject to Draft</button>'
              + '<button class="btn btn-danger btn-sm" onclick="bulkAction(\'discard\')" id="ba-discard">Reject</button>'
              + '<button class="btn btn-ghost btn-sm" onclick="clearSelection()">Clear</button>'
            + '</span>'
          : '')
      + '</div>';

    // indeterminate can only be set via JS after the element exists
    if (indeterminate) {
      var cb = document.getElementById('selectAllCb');
      if (cb) cb.indeterminate = true;
    }
  }

  window.toggleSelectAll = function (checked) {
    if (checked) articles.forEach(function (a) { selectedIds.add(a.id); });
    else selectedIds.clear();
    renderSelectBar();
    document.querySelectorAll('.review-card').forEach(function (card) {
      var id = parseInt(card.dataset.id, 10);
      var cb = card.querySelector('.review-cb');
      if (cb) cb.checked = checked;
      card.classList.toggle('selected', checked);
    });
  };

  window.toggleCard = function (id, checked) {
    if (checked) selectedIds.add(id);
    else selectedIds.delete(id);
    renderSelectBar();
    var card = document.querySelector('.review-card[data-id="' + id + '"]');
    if (card) card.classList.toggle('selected', checked);
  };

  window.clearSelection = function () {
    selectedIds.clear();
    renderSelectBar();
    document.querySelectorAll('.review-card').forEach(function (card) {
      card.classList.remove('selected');
      var cb = card.querySelector('.review-cb');
      if (cb) cb.checked = false;
    });
  };

  // ── Bulk actions ─────────────────────────────────────────────────────────────

  window.bulkAction = async function (action) {
    if (!selectedIds.size) return;
    var n = selectedIds.size;
    var labels = { approve: 'Approve & Publish', 'reject-draft': 'Reject to Draft', discard: 'Reject' };
    var confirms = {
      approve:        'Publish ' + n + ' article' + (n > 1 ? 's' : '') + '?',
      'reject-draft': 'Send ' + n + ' article' + (n > 1 ? 's' : '') + ' back to draft?',
      discard:        'Permanently reject ' + n + ' article' + (n > 1 ? 's' : '') + '? They will be archived and removed from the queue.',
    };
    if (!confirm(confirms[action])) return;

    var ids    = [...selectedIds];
    var btnId  = 'ba-' + action;
    var btn    = document.getElementById(btnId);
    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }

    try {
      var result = await apiFetch('/articles/bulk-action', {
        method: 'PUT',
        body: JSON.stringify({ ids, action }),
      });
      var processed = result.processed || ids.length;
      var skipped   = result.skipped   || 0;
      var msg = processed + ' article' + (processed > 1 ? 's' : '') + ' updated.';
      if (skipped) msg += ' (' + skipped + ' skipped — no longer in review)';
      toast(msg, 'success');
      await loadReviewQueue();
    } catch (err) {
      toast('Bulk action failed: ' + (err.message || err), 'error');
      if (btn) { btn.disabled = false; btn.textContent = labels[action]; }
    }
  };

  // ── Grid ─────────────────────────────────────────────────────────────────────

  function renderGrid(list) {
    var grid = document.getElementById('reviewGrid');
    if (!list.length) {
      grid.innerHTML = '<div class="review-empty">No articles pending review. All clear!</div>';
      return;
    }

    grid.innerHTML = list.map(function (a) {
      var verdict = a.editor_verdict;
      if (typeof verdict === 'string') try { verdict = JSON.parse(verdict); } catch { verdict = null; }

      var hasVerdict = verdict && (verdict.score != null);
      var score = verdict?.score || 0;
      var scoreClass = score >= 7 ? 'review-score-high' : score >= 4 ? 'review-score-mid' : 'review-score-low';
      var issues = verdict?.issues || [];
      var suggestion = verdict?.suggestion || '';

      var ago = a.submitted_for_review_at ? timeSince(new Date(a.submitted_for_review_at)) : 'unknown';
      var wordCount = (a.full_content || '').split(/\s+/).filter(Boolean).length;

      var sm = a.synthesis_meta;
      if (typeof sm === 'string') { try { sm = JSON.parse(sm); } catch { sm = null; } }
      var fromPitch = sm && sm.from_pitch ? sm.from_pitch : null;

      var isSelected = selectedIds.has(a.id);

      var html = '<div class="review-card' + (isSelected ? ' selected' : '') + '" data-id="' + a.id + '">';
      html += '<div class="review-card-header">';
      // Checkbox
      html += '<div class="review-cb-wrap"><input type="checkbox" class="review-cb"'
        + (isSelected ? ' checked' : '')
        + ' onchange="toggleCard(' + a.id + ', this.checked)" onclick="event.stopPropagation()" /></div>';
      // Title + score
      html += '<div class="review-title-wrap">';
      html += '<div class="review-title">' + esc(a.title || 'Untitled')
        + (fromPitch
            ? ' <span class="badge badge-muted" title="Synthesized from a pitch" style="background:rgba(124,58,237,0.15);color:#a78bfa;font-size:11px;margin-left:6px;vertical-align:middle;">From pitch #' + fromPitch + '</span>'
            : '')
        + '</div>';
      html += '</div>';
      html += hasVerdict
        ? '<div class="review-score ' + scoreClass + '">' + score + '/10</div>'
        : '<button class="btn btn-outline btn-sm" onclick="runEditorialReview(' + a.id + ', this)" style="font-size:11px;">Run review</button>';
      html += '</div>';

      html += '<div class="review-meta">';
      html += '<span>Writer: ' + esc(a.source || 'Unknown') + '</span>';
      html += '<span>' + wordCount + ' words</span>';
      html += '<span>Submitted ' + ago + '</span>';
      if (a.editorial_revision_count > 0) html += '<span>Revisions: ' + a.editorial_revision_count + '</span>';
      html += '</div>';

      if (issues.length) {
        html += '<div class="review-issues">';
        issues.forEach(function (issue) {
          html += '<div class="review-issue">' + esc(issue) + '</div>';
        });
        html += '</div>';
      }

      if (suggestion) {
        html += '<div class="review-suggestion">' + esc(suggestion) + '</div>';
      }

      var ce = a.copy_edit_result;
      if (typeof ce === 'string') { try { ce = JSON.parse(ce); } catch { ce = null; } }
      if (ce) {
        var ceVerdict = ce.verdict || 'clean';
        var ceColor = ceVerdict === 'clean' ? '#22c55e' : ceVerdict === 'minor_edits' ? '#fbbf24' : '#ef4444';
        html += '<details class="vera-section">';
        html += '<summary style="cursor:pointer;font-size:12px;font-weight:600;color:' + esc(ceColor) + ';margin-bottom:4px;">';
        html += 'Vera — copy desk · ' + esc(ceVerdict.replace('_', ' '));
        if (ce.corrections && ce.corrections.length) html += ' · ' + ce.corrections.length + ' correction(s)';
        html += '</summary>';
        html += '<div class="vera-body">';
        if (ce.headline_verdict !== 'strong' || ce.headline_suggestion) {
          html += '<div class="vera-row"><span class="vera-label">Headline:</span> '
            + '<span style="color:' + (ce.headline_verdict === 'strong' ? '#22c55e' : '#fbbf24') + ';">' + esc(ce.headline_verdict) + '</span>'
            + (ce.headline_suggestion ? ' → <em>' + esc(ce.headline_suggestion) + '</em>' : '')
            + '</div>';
        }
        if (ce.lede_verdict !== 'strong' || ce.lede_note) {
          html += '<div class="vera-row"><span class="vera-label">Lede:</span> '
            + '<span style="color:' + (ce.lede_verdict === 'strong' ? '#22c55e' : '#fbbf24') + ';">' + esc(ce.lede_verdict) + '</span>'
            + (ce.lede_note ? ' — ' + esc(ce.lede_note) : '')
            + '</div>';
        }
        if (ce.reading_level) {
          html += '<div class="vera-row"><span class="vera-label">Reading level:</span> ' + esc(ce.reading_level) + '</div>';
        }
        if (ce.corrections && ce.corrections.length) {
          html += '<div class="vera-corrections">';
          ce.corrections.forEach(function (c) {
            html += '<div class="vera-correction">'
              + '<span class="vera-original">' + esc(c.original) + '</span>'
              + ' → <span class="vera-suggested">' + esc(c.suggested) + '</span>'
              + ' <span class="vera-reason">(' + esc(c.reason) + ')</span>'
              + '</div>';
          });
          html += '</div>';
        }
        if (ce.style_notes && ce.style_notes.length) {
          html += '<div class="vera-style-notes">' + ce.style_notes.map(function (n) {
            return '<div class="vera-row">📌 ' + esc(n) + '</div>';
          }).join('') + '</div>';
        }
        html += '</div></details>';
      }

      html += '<details><summary style="cursor:pointer;font-size:12px;color:var(--muted);margin-bottom:8px;">Preview article</summary>';
      html += '<div class="review-preview">' + esc((a.full_content || a.summary || 'No content').slice(0, 1000)) + '</div>';
      html += '</details>';

      html += '<div class="review-actions">';
      html += '<button class="btn btn-primary btn-sm" onclick="approveArticle(' + a.id + ')">Approve & Publish</button>';
      html += '<button class="btn btn-warning btn-sm" onclick="openRevisionModal(' + a.id + ', ' + JSON.stringify(a.title || '').replace(/"/g, '&quot;') + ')">Request Revision</button>';
      html += '<button class="btn btn-ghost btn-sm" onclick="rejectArticle(' + a.id + ')">Reject to Draft</button>';
      html += '<button class="btn btn-danger btn-sm" onclick="discardArticle(' + a.id + ')">Reject</button>';
      if (hasVerdict) html += '<button class="btn btn-ghost btn-sm" onclick="runEditorialReview(' + a.id + ', this)" title="Re-run AI review">↻ Re-review</button>';
      html += '</div>';
      html += '</div>';
      return html;
    }).join('');
  }

  // ── Individual article actions ────────────────────────────────────────────────

  var _revisionArticleId = null;

  window.openRevisionModal = function (id, title) {
    _revisionArticleId = id;
    var titleEl = document.getElementById('revisionArticleTitle');
    var noteEl  = document.getElementById('revisionEditorNote');
    if (titleEl) titleEl.textContent = title;
    if (noteEl)  noteEl.value = '';
    openModal('revisionModal');
  };

  window.submitRevision = async function () {
    if (!_revisionArticleId) return;
    var noteEl = document.getElementById('revisionEditorNote');
    var note = noteEl ? noteEl.value.trim() : '';
    var btn = document.getElementById('revisionSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      await apiFetch('/articles/' + _revisionArticleId + '/request-revision', {
        method: 'POST',
        body: JSON.stringify({ note }),
      });
      closeModal('revisionModal');
      toast('Revision requested — writer notified and rewrite triggered.', 'success');
      await loadReviewQueue();
    } catch (err) {
      toast('Request failed: ' + (err.message || err), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Request Revision'; }
    }
  };

  window.runEditorialReview = async function (id, btn) {
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Reviewing…';
    try {
      await apiFetch('/articles/' + id + '/editorial-review', { method: 'POST' });
      toast('Editorial review complete.', 'success');
      await loadReviewQueue();
    } catch (err) {
      toast('Review failed: ' + (err.message || err), 'error');
      btn.disabled = false;
      btn.textContent = orig;
    }
  };

  window.approveArticle = async function (id) {
    if (!confirm('Publish this article?')) return;
    try {
      await apiFetch('/articles/' + id + '/approve', { method: 'PUT' });
      await loadReviewQueue();
    } catch (err) {
      alert('Approve failed: ' + (err.message || err));
    }
  };

  window.rejectArticle = async function (id) {
    if (!confirm('Reject this article back to draft?')) return;
    try {
      await apiFetch('/articles/' + id + '/reject', { method: 'PUT' });
      await loadReviewQueue();
    } catch (err) {
      alert('Reject to draft failed: ' + (err.message || err));
    }
  };

  window.discardArticle = async function (id) {
    if (!confirm('Permanently reject this article? It will be archived and removed from the queue.')) return;
    try {
      await apiFetch('/articles/' + id + '/discard', { method: 'PUT' });
      await loadReviewQueue();
    } catch (err) {
      alert('Reject failed: ' + (err.message || err));
    }
  };

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function timeSince(date) {
    var seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }
})();
