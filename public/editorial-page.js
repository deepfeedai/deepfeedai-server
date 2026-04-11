/* eslint-disable no-unused-vars */
/* global apiFetch */
(function () {
  'use strict';

  var articles = [];

  init();

  async function init() {
    await loadReviewQueue();
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

      var score = verdict?.score || 0;
      var scoreClass = score >= 7 ? 'review-score-high' : score >= 4 ? 'review-score-mid' : 'review-score-low';
      var issues = verdict?.issues || [];
      var suggestion = verdict?.suggestion || '';

      var ago = a.submitted_for_review_at ? timeSince(new Date(a.submitted_for_review_at)) : 'unknown';
      var wordCount = (a.full_content || '').split(/\s+/).filter(Boolean).length;

      var html = '<div class="review-card" data-id="' + a.id + '">';
      html += '<div class="review-card-header">';
      html += '<div class="review-title">' + esc(a.title || 'Untitled') + '</div>';
      html += '<div class="review-score ' + scoreClass + '">' + score + '/10</div>';
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

      // Preview toggle
      html += '<details><summary style="cursor:pointer;font-size:12px;color:var(--muted);margin-bottom:8px;">Preview article</summary>';
      html += '<div class="review-preview">' + esc((a.full_content || a.summary || 'No content').slice(0, 1000)) + '</div>';
      html += '</details>';

      html += '<div class="review-actions">';
      html += '<button class="btn btn-primary btn-sm" onclick="approveArticle(' + a.id + ')">Approve & Publish</button>';
      html += '<button class="btn btn-outline btn-sm" onclick="rejectArticle(' + a.id + ')">Reject to Draft</button>';
      html += '</div>';
      html += '</div>';
      return html;
    }).join('');
  }

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
