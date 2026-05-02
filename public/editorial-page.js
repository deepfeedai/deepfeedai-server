/* eslint-disable no-unused-vars */
/* global apiFetch */
(function () {
  'use strict';

  renderSidebar();

  var articles = [];

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
      renderStats(articles);
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

      var html = '<div class="review-card" data-id="' + a.id + '">';
      html += '<div class="review-card-header">';
      html += '<div class="review-title">' + esc(a.title || 'Untitled')
        + (fromPitch
            ? ' <span class="badge badge-muted" title="Synthesized from a pitch" style="background:rgba(124,58,237,0.15);color:#a78bfa;font-size:11px;margin-left:6px;vertical-align:middle;">From pitch #' + fromPitch + '</span>'
            : '')
        + '</div>';
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
      if (hasVerdict) html += '<button class="btn btn-ghost btn-sm" onclick="runEditorialReview(' + a.id + ', this)" title="Re-run AI review">↻ Re-review</button>';
      html += '</div>';
      html += '</div>';
      return html;
    }).join('');
  }

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
