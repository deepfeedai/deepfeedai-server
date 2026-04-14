/* eslint-disable no-unused-vars */
/* global apiFetch */
(function () {
  'use strict';

  renderSidebar();

  var articles = [];

  var pitches = [];
  var activeTab = 'articles';
  var pendingOverride = null; // { pitchId, message }

  init();

  async function init() {
    initModals();
    wireTabs();
    wireOverrideModal();
    await loadReviewQueue();
    // Best-effort load — pitches feature may be disabled (404) and that's fine
    loadPitches().catch(function () {
      document.getElementById('pitchesGrid').innerHTML =
        '<div class="review-empty">Counter-angle pitches are not enabled for this newsroom.</div>';
      document.getElementById('pitchesTabCount').textContent = '';
    });
  }

  function wireTabs() {
    var btns = document.querySelectorAll('.tab-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.dataset.tab;
        if (tab === activeTab) return;
        activeTab = tab;
        btns.forEach(function (b) {
          var active = b.dataset.tab === tab;
          b.classList.toggle('active', active);
          b.style.borderBottomColor = active ? 'var(--primary)' : 'transparent';
          b.style.color = active ? 'var(--text)' : 'var(--muted)';
        });
        document.getElementById('articlesPanel').style.display = tab === 'articles' ? '' : 'none';
        document.getElementById('pitchesPanel').style.display = tab === 'pitches' ? '' : 'none';
      });
    });
  }

  function wireOverrideModal() {
    document.getElementById('confirmOverrideBtn').addEventListener('click', async function () {
      if (!pendingOverride) return;
      var note = document.getElementById('overrideNote').value.trim();
      if (!note) { alert('Justification is required for override.'); return; }
      var btn = this;
      btn.disabled = true; btn.textContent = 'Approving…';
      try {
        await apiFetch('/pitches/' + pendingOverride.pitchId + '/approve', {
          method: 'POST',
          body: JSON.stringify({ note: note, override: true }),
        });
        closeModal('overrideModal');
        pendingOverride = null;
        document.getElementById('overrideNote').value = '';
        await loadPitches();
      } catch (err) {
        alert('Override approve failed: ' + (err.message || err));
      } finally {
        btn.disabled = false; btn.textContent = 'Approve with override';
      }
    });
  }

  async function loadReviewQueue() {
    try {
      var data = await apiFetch('/articles/review-queue');
      articles = data.articles || [];
      renderStats(articles);
      renderGrid(articles);
      var c = document.getElementById('articlesTabCount');
      c.textContent = articles.length || '';
      c.style.display = articles.length ? 'inline-flex' : 'none';
    } catch (err) {
      document.getElementById('reviewGrid').innerHTML = '<div class="review-empty">Failed to load review queue: ' + (err.message || err) + '</div>';
    }
  }

  async function loadPitches() {
    var data = await apiFetch('/pitches?status=proposed');
    pitches = data.pitches || [];
    renderPitchesGrid(pitches);
    var c = document.getElementById('pitchesTabCount');
    c.textContent = pitches.length || '';
    c.style.display = pitches.length ? 'inline-flex' : 'none';
  }

  function renderPitchesGrid(list) {
    var grid = document.getElementById('pitchesGrid');
    if (!list.length) {
      grid.innerHTML = '<div class="review-empty">No pitches awaiting review.</div>';
      return;
    }
    grid.innerHTML = list.map(function (p) {
      var ago = p.created_at ? timeSince(new Date(p.created_at)) : '';
      var initiator = p.pitched_by_writer_name
        ? 'Pitched by <strong>' + esc(p.pitched_by_writer_name) + '</strong>'
        : 'Editor tip from <strong>' + esc(p.requested_by_editor_name || 'editor') + '</strong>';
      var sourceUrl = p.source_url ? '<a href="' + esc(p.source_url) + '" target="_blank" rel="noopener" class="text-muted" style="font-size:12px;">↗ ' + esc(p.source_publisher || 'source') + '</a>' : '';

      var html = '<div class="review-card" data-pitch="' + p.id + '">';
      html += '<div class="review-card-header">';
      html += '<div class="review-title">' + esc(p.source_title || 'Untitled source') + '</div>';
      html += '<span class="badge badge-muted" style="background:rgba(124,58,237,0.15);color:#a78bfa;">PITCH</span>';
      html += '</div>';
      html += '<div class="review-meta">';
      html += '<span>' + initiator + '</span>';
      html += '<span>' + ago + '</span>';
      if (p.source_category) html += '<span>' + esc(p.source_category) + '</span>';
      if (sourceUrl) html += '<span>' + sourceUrl + '</span>';
      html += '</div>';
      html += '<div class="review-suggestion" style="font-style:normal;color:var(--text);background:var(--surface2);padding:12px;border-radius:8px;margin:10px 0;">';
      html += '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Angle</div>';
      html += esc(p.angle_summary || '');
      html += '</div>';
      html += '<div class="review-actions">';
      html += '<button class="btn btn-primary btn-sm" onclick="approvePitch(' + p.id + ')">Approve</button>';
      html += '<button class="btn btn-outline btn-sm" onclick="rejectPitch(' + p.id + ')">Reject</button>';
      html += '</div>';
      html += '</div>';
      return html;
    }).join('');
  }

  window.approvePitch = async function (id) {
    try {
      var resp = await apiFetch('/pitches/' + id + '/approve', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (resp && resp.synthesis_queued === false) {
        alert('Approved. No synthesis queued (likely an editor tip awaiting writer assignment).');
      }
      await loadPitches();
    } catch (err) {
      // Cap-reached: open override modal. apiFetch surfaces the server's
      // {error: 'cap_reached'} as err.message, so detect by message.
      if (err && err.message === 'cap_reached') {
        pendingOverride = { pitchId: id };
        document.getElementById('overrideMessage').textContent =
          'This source already has the maximum number of originals (per the max_originals_per_source setting). Approve anyway?';
        document.getElementById('overrideNote').value = '';
        openModal('overrideModal');
        return;
      }
      alert('Approve failed: ' + (err.message || err));
    }
  };

  window.rejectPitch = async function (id) {
    var note = prompt('Optional note for this rejection (blank to skip):') || '';
    try {
      await apiFetch('/pitches/' + id + '/reject', {
        method: 'POST',
        body: JSON.stringify({ note: note || undefined }),
      });
      await loadPitches();
    } catch (err) {
      alert('Reject failed: ' + (err.message || err));
    }
  };

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
