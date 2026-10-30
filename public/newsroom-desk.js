/**
 * Newsroom — The Desk workspace
 * Inner tabs: Writers, Articles, Engagement, Settings, Styles.
 *
 * APIs consumed:
 *   GET  /api/admin/writers
 *   GET  /api/admin/writers/performance?range=30d
 *   GET  /api/articles?limit=40&offset=0
 *   GET  /api/comments/admin/queue
 *   POST /api/comments/admin/:id/approve
 *   POST /api/comments/admin/:id/reject
 *   POST /api/newsletter/send?preview=true
 *   POST /api/newsletter/send
 *   GET  /api/banners/active
 *   POST /api/banners
 *   DELETE /api/banners/:id
 *   GET  /api/sources
 *   GET  /api/settings
 *
 * Globals from admin.js: apiFetch, showAlert, escHtml, fmtDate
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  var loaded = {
    writers:    false,
    articles:   false,
    engagement: false,
    settings:   false,
    styles:     false,
  };

  var activeTab = 'articles';

  // Articles tab state
  var artOffset      = 0;
  var artStatus      = '';
  var artSearch      = '';
  var artSearchTimer = null;

  // ── XSS-safe HTML escape ──────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Avatar colour pool (matches Floor's palette) ──────────────────────────
  var AV_COLOURS = [
    '#7c3aed', '#0369a1', '#be185d', '#047857',
    '#b45309', '#1d4ed8', '#be123c', '#065f46',
  ];
  var avColourCache = {};
  function writerColour(id) {
    if (!avColourCache[id]) {
      avColourCache[id] = AV_COLOURS[(parseInt(id, 10) || 0) % AV_COLOURS.length];
    }
    return avColourCache[id];
  }

  // Build initials from a display name
  function initials(name) {
    return String(name || '?')
      .split(' ')
      .map(function (w) { return w[0] || ''; })
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  // Avatar HTML — 28×28 lg size
  function avatarHtml(name, id, avatarUrl, accentColor) {
    var style;
    if (avatarUrl) {
      style = 'background-image:url(' + esc(avatarUrl) + ');background-size:cover;background-position:center;color:transparent;';
    } else {
      var bg = accentColor || writerColour(id);
      style = 'background:' + esc(bg) + ';';
    }
    return '<span class="nr-av-lg" style="' + style + '">' + (avatarUrl ? '' : esc(initials(name))) + '</span>';
  }

  // Relative time label
  function relTime(iso) {
    if (!iso) return '';
    var diff = Date.now() - new Date(iso).getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  // Format a number with comma thousands separators
  function fmtNum(n) {
    var num = parseInt(n, 10);
    if (isNaN(num)) return '—';
    return num.toLocaleString();
  }

  // Round a float to one decimal
  function fmtScore(v) {
    var f = parseFloat(v);
    if (isNaN(f)) return '—';
    return f.toFixed(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WRITERS TAB
  // ══════════════════════════════════════════════════════════════════════════

  async function loadWriters() {
    var panel = document.getElementById('desk-writers');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading writers…</div>';

    try {
      var results = await Promise.all([
        apiFetch('/admin/writers'),
        apiFetch('/admin/writers/performance?range=30d').catch(function () { return { writers: [] }; }),
      ]);
      var writers     = Array.isArray(results[0]) ? results[0] : (results[0].writers || []);
      var perfData    = results[1] || {};
      var perfWriters = Array.isArray(perfData.writers) ? perfData.writers : [];

      // Index perf data by writer_id for O(1) lookup
      var perfMap = {};
      perfWriters.forEach(function (p) { perfMap[p.writer_id] = p; });

      renderWriters(writers, perfMap);
    } catch (err) {
      var panel2 = document.getElementById('desk-writers');
      if (panel2) {
        panel2.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load writers: ' + esc(err.message) + '</div>';
      }
      showAlert('Writers load failed: ' + err.message, 'error');
    }
  }

  function renderWriters(writers, perfMap) {
    var panel = document.getElementById('desk-writers');
    if (!panel) return;

    if (!writers.length) {
      panel.innerHTML = '<div class="nr-empty">No writers found.</div>';
      return;
    }

    // Separate system writers (Maxwell) from regular writers
    var regular = writers.filter(function (w) { return !w.is_system; });
    var system   = writers.filter(function (w) { return w.is_system; });

    var html = '<div style="overflow-x:auto;">';
    html += '<table class="nr-writers-table">';
    html += '<thead><tr>';
    html += '<th>Writer</th>';
    html += '<th>Beat</th>';
    html += '<th>Articles (30d)</th>';
    html += '<th>Score</th>';
    html += '<th>Status</th>';
    html += '<th>Actions</th>';
    html += '</tr></thead>';
    html += '<tbody>';

    // Regular writers first
    regular.forEach(function (w) {
      html += writerRowHtml(w, perfMap[w.id] || null);
    });

    // System writers (Maxwell, etc.) at the bottom with a divider
    if (system.length) {
      html += '<tr><td colspan="6" style="padding:4px 10px;background:var(--surface-2,#f3f4f6);"><span class="nr-section-heading">System Agents</span></td></tr>';
      system.forEach(function (w) {
        html += writerRowHtml(w, perfMap[w.id] || null, true);
      });
    }

    html += '</tbody></table></div>';

    html += '<button class="nr-add-btn" onclick="window.location.href=\'/writer-create.html\'">+ Add Writer</button>';

    panel.innerHTML = html;

    // Delegated handler for Chat → buttons
    panel.addEventListener('click', function (e) {
      var chatBtn = e.target.closest('[data-chat-writer-id]');
      if (chatBtn && window.NRChat && window.NRChat.openForWriter) {
        NRChat.openForWriter(
          parseInt(chatBtn.dataset.chatWriterId, 10),
          chatBtn.dataset.chatWriterName || 'Writer'
        );
      }
    });
  }

  function writerRowHtml(w, perf, isSystem) {
    var articles = perf ? (perf.articles_total || 0) : 0;
    var score    = perf ? perf.avg_editorial_score : null;

    // Primary beat: use beats array if available, fall back to beat string
    var beatLabel = '';
    if (Array.isArray(w.beats) && w.beats.length) {
      beatLabel = w.beats[0].name;
    } else if (w.beat) {
      beatLabel = w.beat;
    }

    // Status determination
    var statusHtml;
    if (isSystem) {
      statusHtml = '<span class="nr-writer-handle">' + esc(w.role || 'System Agent') + '</span>';
    } else if (articles === 0) {
      statusHtml = '<span class="nr-status-silent">○ Silent</span>';
    } else {
      statusHtml = '<span class="nr-status-active">● Active</span>';
    }

    var html = '<tr>';

    // Writer cell
    html += '<td>';
    html += '<div class="nr-writer-cell">';
    html += avatarHtml(w.name, w.id, w.avatar_url, w.accent_color);
    html += '<div style="min-width:0;">';
    html += '<div class="nr-writer-name">' + esc(w.name || '—') + '</div>';
    if (w.slug) {
      html += '<div class="nr-writer-handle">@' + esc(w.slug) + '</div>';
    }
    html += '</div>';
    html += '</div>';
    html += '</td>';

    // Beat cell
    html += '<td>';
    if (beatLabel) {
      html += '<span class="nr-beat-badge">' + esc(beatLabel) + '</span>';
    } else {
      html += '<span style="color:var(--muted,#9ca3af);font-size:12px;">—</span>';
    }
    html += '</td>';

    // Articles (30d)
    html += '<td style="text-align:right;padding-right:16px;">' + esc(String(articles)) + '</td>';

    // Score
    html += '<td style="text-align:right;padding-right:16px;">' + esc(fmtScore(score)) + '</td>';

    // Status
    html += '<td>' + statusHtml + '</td>';

    // Actions
    html += '<td>';
    html += '<a class="nr-row-btn" href="/writer-detail.html?id=' + esc(String(w.id)) + '">View →</a>';
    html += ' <button class="nr-row-btn" data-chat-writer-id="' + esc(String(w.id)) + '" data-chat-writer-name="' + esc(w.name || '') + '">Chat →</button>';
    html += '</td>';

    html += '</tr>';
    return html;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARTICLES TAB
  // ══════════════════════════════════════════════════════════════════════════

  function artStatusFromRow(a) {
    if (a.is_published === 1 || a.is_published === true) return 'published';
    if (a.status === 'review') return 'review';
    return 'draft';
  }

  function buildArtUrl(status, search, offset) {
    var url = '/articles?limit=40&offset=' + (offset || 0) + '&type=editorial';
    if (status) url += '&status=' + encodeURIComponent(status);
    if (search)  url += '&search=' + encodeURIComponent(search);
    return url;
  }

  async function loadArticles(opts) {
    opts = opts || {};
    var reset  = opts.reset !== false;   // default: reset list
    var panel  = document.getElementById('desk-articles');
    if (!panel) return;

    if (reset) {
      artOffset = 0;
      panel.innerHTML = '<div class="nr-loading">Loading articles…</div>';
    } else {
      // Append mode — disable the Load more button while fetching
      var lmBtn = document.getElementById('nr-articles-load-more');
      if (lmBtn) { lmBtn.disabled = true; lmBtn.textContent = 'Loading…'; }
    }

    try {
      var data     = await apiFetch(buildArtUrl(artStatus, artSearch, artOffset));
      var articles = Array.isArray(data.articles) ? data.articles : [];
      var hasMore  = !!data.hasMore;

      if (reset) {
        renderArticlesPanel(articles, hasMore);
      } else {
        appendArticleRows(articles, hasMore);
      }
    } catch (err) {
      if (reset) {
        var p2 = document.getElementById('desk-articles');
        if (p2) p2.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load articles: ' + esc(err.message) + '</div>';
      }
      showAlert('Articles load failed: ' + err.message, 'error');
    }
  }

  function renderArticlesPanel(articles, hasMore) {
    var panel = document.getElementById('desk-articles');
    if (!panel) return;

    // Reset bulk bar on re-render
    var bulkBar = document.getElementById('nr-article-bulk-bar');
    if (bulkBar) bulkBar.style.display = 'none';

    // Restore persisted filter
    try { artStatus = localStorage.getItem('nr_desk_art_filter') || ''; } catch (_) {}

    var html = '<div class="nr-articles-toolbar">';
    html += '<input type="checkbox" class="nr-bulk-check" id="nr-art-select-all" title="Select all" style="margin-right:2px;">';
    html += '<input class="nr-articles-search" id="nr-articles-search" placeholder="Search articles…" value="' + esc(artSearch) + '">';
    html += '<div class="nr-filter-chips" id="nr-articles-filter">';
    html += chipHtml('', 'All', artStatus);
    html += chipHtml('published', 'Published', artStatus);
    html += chipHtml('draft', 'Draft', artStatus);
    html += chipHtml('review', 'Review', artStatus);
    html += '</div>';
    html += '<a href="/article-editor.html?return=/newsroom.html%23desk/articles" class="nr-row-btn">+ New Article</a>';
    html += '<a href="/articles.html" class="nr-row-btn" style="margin-left:auto;">Full list →</a>';
    html += '</div>';

    html += '<div id="nr-articles-list">';
    html += articleRowsHtml(articles);
    html += '</div>';

    if (hasMore) {
      html += '<button id="nr-articles-load-more" class="nr-add-btn">Load more…</button>';
    }

    panel.innerHTML = html;
    wireArticleEvents(panel);
  }

  function chipHtml(value, label, activeValue) {
    var isActive = (value === activeValue) ? ' active' : '';
    return '<button class="nr-filter-chip' + isActive + '" data-art-status="' + esc(value) + '">' + esc(label) + '</button>';
  }

  function articleRowsHtml(articles) {
    if (!articles.length) {
      return '<div class="nr-empty" style="padding:16px 0;">No articles found.</div>';
    }
    var siteBase = typeof getSiteBase === 'function' ? getSiteBase() : '';
    return articles.map(function (a) {
      var displayTitle = a.generated_title || a.title || '(Untitled)';
      var statusKey    = artStatusFromRow(a);
      var dateSrc      = a.published_at || a.created_at;
      var meta         = (a.category ? esc(a.category) + ' · ' : '') + esc(relTime(dateSrc));
      var previewHref  = (a.slug && siteBase) ? siteBase + '/article/' + esc(a.slug) : '';
      return '<div class="nr-article-row" data-art-row-id="' + esc(String(a.id)) + '">'
        + '<input type="checkbox" class="nr-bulk-check nr-art-row-check" data-art-id="' + esc(String(a.id)) + '" aria-label="Select">'
        + '<a class="nr-article-title" href="/article-editor.html?id=' + esc(String(a.id)) + '&return=/newsroom.html%23desk/articles" title="' + esc(displayTitle) + '">'
        + esc(truncate(displayTitle, 90))
        + '</a>'
        + '<span class="nr-article-meta">' + meta + '</span>'
        + '<span class="nr-article-status as-' + esc(statusKey) + '">' + esc(statusKey) + '</span>'
        + '<div class="nr-article-actions">'
        + '<button class="nr-art-act-btn" data-art-image="' + a.id + '" title="Generate image"' + (a.image_url ? ' style="color:var(--accent)"' : '') + '>🎨</button>'
        + ((a.content_type === 'original' || a.content_type === 'deep-dive')
            ? '<button class="nr-art-act-btn" data-art-inline="' + a.id + '" title="Generate inline images"' + (Array.isArray(a.inline_images) && a.inline_images.some(function(i){return i.status==='ready';}) ? ' style="color:var(--accent)"' : '') + '>🖼</button>'
            : '')
        + '<button class="nr-art-act-btn" data-art-audio="' + a.id + '" title="Generate audio"' + (a.audio_url ? ' style="color:var(--accent)"' : '') + '>🎙️</button>'
        + '<button class="nr-art-act-btn nr-art-act-archive" data-art-archive="' + a.id + '" title="Archive">🗄</button>'
        + (previewHref ? '<a href="' + previewHref + '" target="_blank" class="nr-art-preview-link" title="Preview on site">↗ Preview</a>' : '')
        + (statusKey === 'published' ? '<button class="nr-art-unpublish-btn" data-art-unpublish="' + esc(String(a.id)) + '">Unpublish</button>' : '')
        + '</div>'
        + '</div>';
    }).join('');
  }

  function appendArticleRows(articles, hasMore) {
    var list = document.getElementById('nr-articles-list');
    if (list) {
      if (articles.length) {
        list.insertAdjacentHTML('beforeend', articleRowsHtml(articles));
      }
    }

    // Remove old Load more button
    var old = document.getElementById('nr-articles-load-more');
    if (old) old.parentNode.removeChild(old);

    if (hasMore) {
      var panel = document.getElementById('desk-articles');
      if (panel) {
        var btn = document.createElement('button');
        btn.id        = 'nr-articles-load-more';
        btn.className = 'nr-add-btn';
        btn.textContent = 'Load more…';
        panel.appendChild(btn);
        btn.addEventListener('click', onArtLoadMore);
      }
    }
  }

  function wireArticleEvents(panel) {
    // Search input — debounced
    var searchEl = panel.querySelector('#nr-articles-search');
    if (searchEl) {
      searchEl.addEventListener('input', function (e) {
        clearTimeout(artSearchTimer);
        artSearchTimer = setTimeout(function () {
          artSearch = e.target.value.trim();
          artOffset = 0;
          loadArticles({ reset: true });
        }, 300);
      });
    }

    // Filter chips
    var chipBar = panel.querySelector('#nr-articles-filter');
    if (chipBar) {
      chipBar.addEventListener('click', function (e) {
        var chip = e.target.closest('[data-art-status]');
        if (!chip) return;
        artStatus = chip.dataset.artStatus;
        artOffset = 0;
        try { localStorage.setItem('nr_desk_art_filter', artStatus); } catch (_) {}
        // Update chip active states
        chipBar.querySelectorAll('.nr-filter-chip').forEach(function (c) {
          c.classList.toggle('active', c.dataset.artStatus === artStatus);
        });
        loadArticles({ reset: true });
      });
    }

    // Load more button
    var lmBtn = panel.querySelector('#nr-articles-load-more');
    if (lmBtn) {
      lmBtn.addEventListener('click', onArtLoadMore);
    }

    // Wire bulk bar
    initArticleBulkBar(panel);

    // Article inline action buttons (image, audio, archive, unpublish)
    panel.addEventListener('click', function(e) {
      var imgBtn = e.target.closest('[data-art-image]');
      if (imgBtn) { artGenImage(parseInt(imgBtn.dataset.artImage, 10), imgBtn); return; }
      var inlineBtn = e.target.closest('[data-art-inline]');
      if (inlineBtn) { artGenInline(parseInt(inlineBtn.dataset.artInline, 10), inlineBtn); return; }
      var audBtn = e.target.closest('[data-art-audio]');
      if (audBtn) { artGenAudio(parseInt(audBtn.dataset.artAudio, 10), audBtn); return; }
      var archBtn = e.target.closest('[data-art-archive]');
      if (archBtn) { artArchive(parseInt(archBtn.dataset.artArchive, 10), archBtn); return; }
      var unpubBtn = e.target.closest('[data-art-unpublish]');
      if (unpubBtn) { artUnpublish(parseInt(unpubBtn.dataset.artUnpublish, 10), unpubBtn); return; }
    });
  }

  function onArtLoadMore() {
    artOffset += 40;
    loadArticles({ reset: false });
  }

  async function artGenImage(articleId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      await apiFetch('/media/generate-image', {
        method: 'POST',
        body: JSON.stringify({ articleId: articleId }),
      });
      showAlert('Image generated.', 'success');
      if (btn) { btn.style.color = 'var(--accent)'; btn.textContent = '🎨'; btn.disabled = false; }
    } catch(err) {
      showAlert('Image failed: ' + err.message, 'error');
      if (btn) { btn.textContent = '🎨'; btn.disabled = false; }
    }
  }

  async function artGenInline(articleId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      const result=await apiFetch('/articles/' + articleId + '/generate-inline-images', { method: 'POST' });
      const summary=ImageOutcomes.summarize(result.outcomes || []);
      showAlert(summary.text,summary.hasIssues?'error':'success');
      if (btn) { btn.style.color = 'var(--accent)'; btn.textContent = '🖼'; btn.disabled = false; }
    } catch (err) {
      showAlert('Inline images failed: ' + err.message, 'error');
      if (btn) { btn.textContent = '🖼'; btn.disabled = false; }
    }
  }

  async function artGenAudio(articleId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      await apiFetch('/media/generate-audio', {
        method: 'POST',
        body: JSON.stringify({ articleId: articleId }),
      });
      showAlert('Audio generated.', 'success');
      if (btn) { btn.style.color = 'var(--accent)'; btn.textContent = '🎙️'; btn.disabled = false; }
    } catch(err) {
      showAlert('Audio failed: ' + err.message, 'error');
      if (btn) { btn.textContent = '🎙️'; btn.disabled = false; }
    }
  }

  function artArchive(articleId, btn) {
    var row = btn && btn.closest('.nr-article-row');
    if (!row) return;
    row.style.transition = 'opacity .15s';
    row.style.opacity = '0.25';
    if (btn) btn.disabled = true;

    if (typeof showUndoToast !== 'function') {
      apiFetch('/articles/' + articleId, { method: 'DELETE' }).then(function() {
        row.remove();
      }).catch(function(err) {
        row.style.opacity = '';
        if (btn) btn.disabled = false;
        showAlert('Archive failed: ' + err.message, 'error');
      });
      return;
    }

    showUndoToast('Article archived.', function onCommit() {
      apiFetch('/articles/' + articleId, { method: 'DELETE' }).then(function() {
        row.remove();
      }).catch(function(err) {
        row.style.opacity = '';
        if (btn) btn.disabled = false;
        showAlert('Archive failed: ' + err.message, 'error');
      });
    }, function onUndo() {
      row.style.opacity = '';
      if (btn) btn.disabled = false;
    });
  }

  async function artUnpublish(articleId, btn) {
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await apiFetch('/articles/' + articleId + '/publish', { method: 'PUT', body:JSON.stringify({published:false}) });
      showAlert('Article unpublished — reverted to draft.', 'info');
      var row = btn.closest('.nr-article-row');
      if (row) {
        var statusBadge = row.querySelector('.nr-article-status');
        if (statusBadge) {
          statusBadge.className = 'nr-article-status as-draft';
          statusBadge.textContent = 'draft';
        }
        btn.remove();
      }
    } catch(err) {
      showAlert('Unpublish failed: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  function truncate(s, max) {
    var str = String(s || '');
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  // ── Bulk article actions ──────────────────────────────────────────────────

  function updateArtBulkBar() {
    var checked = document.querySelectorAll('#nr-articles-list .nr-art-row-check:checked');
    var bar     = document.getElementById('nr-article-bulk-bar');
    var countEl = document.getElementById('nr-article-bulk-count');
    if (!bar) return;
    var n = checked.length;
    if (countEl) countEl.textContent = n + ' selected';
    bar.style.display = n > 0 ? '' : 'none';
  }

  function bulkArchive() {
    var checked = document.querySelectorAll('#nr-articles-list .nr-art-row-check:checked');
    if (!checked.length) return;
    var ids = Array.prototype.map.call(checked, function(c) { return parseInt(c.dataset.artId, 10); });

    // Visually dim rows immediately
    ids.forEach(function(id) {
      var row = document.querySelector('[data-art-row-id="' + id + '"]');
      if (row) { row.style.transition = 'opacity .15s'; row.style.opacity = '0.25'; }
    });

    var bar = document.getElementById('nr-article-bulk-bar');
    if (bar) bar.style.display = 'none';

    if (typeof showUndoToast !== 'function') {
      ids.forEach(function(id) {
        apiFetch('/articles/' + id, { method: 'DELETE' }).then(function() {
          var row = document.querySelector('[data-art-row-id="' + id + '"]');
          if (row) row.remove();
        });
      });
      return;
    }

    var label = ids.length + ' article' + (ids.length !== 1 ? 's' : '');
    showUndoToast('Archived ' + label + '.', function onCommit() {
      ids.forEach(function(id) {
        apiFetch('/articles/' + id, { method: 'DELETE' }).then(function() {
          var row = document.querySelector('[data-art-row-id="' + id + '"]');
          if (row) row.remove();
        }).catch(function(err) {
          var row = document.querySelector('[data-art-row-id="' + id + '"]');
          if (row) row.style.opacity = '';
          showAlert('Archive failed: ' + err.message, 'error');
        });
      });
    }, function onUndo() {
      ids.forEach(function(id) {
        var row = document.querySelector('[data-art-row-id="' + id + '"]');
        if (row) {
          row.style.opacity = '';
          var check = row.querySelector('.nr-art-row-check');
          if (check) check.checked = false;
        }
      });
    });
  }

  async function bulkUnpublish() {
    var checked = document.querySelectorAll('#nr-articles-list .nr-art-row-check:checked');
    if (!checked.length) return;
    var ids = Array.prototype.map.call(checked, function(c) { return parseInt(c.dataset.artId, 10); });

    var btn = document.getElementById('nr-article-bulk-unpublish');
    if (btn) { btn.disabled = true; btn.textContent = 'Unpublishing…'; }

    var succeeded = 0;
    await Promise.all(ids.map(function(id) {
      return apiFetch('/articles/' + id + '/publish', { method: 'PUT', body:JSON.stringify({published:false}) }).then(function() {
        succeeded++;
        var row = document.querySelector('[data-art-row-id="' + id + '"]');
        if (row) {
          var statusBadge = row.querySelector('.nr-article-status');
          if (statusBadge) { statusBadge.className = 'nr-article-status as-draft'; statusBadge.textContent = 'draft'; }
          var unpubBtn = row.querySelector('[data-art-unpublish]');
          if (unpubBtn) unpubBtn.remove();
          var check = row.querySelector('.nr-art-row-check');
          if (check) check.checked = false;
        }
      }).catch(function(err) {
        showAlert('Unpublish failed for article ' + id + ': ' + err.message, 'error');
      });
    }));

    if (succeeded > 0) showAlert('Unpublished ' + succeeded + ' article' + (succeeded !== 1 ? 's' : '') + '.', 'info');
    if (btn) { btn.disabled = false; btn.textContent = 'Unpublish'; }
    updateArtBulkBar();
  }

  function initArticleBulkBar(panel) {
    // Wire select-all checkbox
    var selectAll = panel.querySelector('#nr-art-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', function() {
        var allChecks = document.querySelectorAll('#nr-articles-list .nr-art-row-check');
        Array.prototype.forEach.call(allChecks, function(c) { c.checked = selectAll.checked; });
        updateArtBulkBar();
      });
    }

    // Wire row checkbox changes
    var listEl = document.getElementById('nr-articles-list');
    if (listEl) {
      listEl.addEventListener('change', function(e) {
        if (e.target.closest('.nr-art-row-check')) {
          // Update select-all indeterminate state
          var allChecks = document.querySelectorAll('#nr-articles-list .nr-art-row-check');
          var checkedCount = document.querySelectorAll('#nr-articles-list .nr-art-row-check:checked').length;
          if (selectAll) {
            selectAll.indeterminate = checkedCount > 0 && checkedCount < allChecks.length;
            selectAll.checked = checkedCount === allChecks.length && allChecks.length > 0;
          }
          updateArtBulkBar();
        }
      });
    }

    // Wire bulk bar buttons (outside panel — in main layout)
    var archiveBtn = document.getElementById('nr-article-bulk-archive');
    if (archiveBtn) { archiveBtn.onclick = bulkArchive; }

    var unpublishBtn = document.getElementById('nr-article-bulk-unpublish');
    if (unpublishBtn) { unpublishBtn.onclick = bulkUnpublish; }

    var clearBtn = document.getElementById('nr-article-bulk-clear');
    if (clearBtn) {
      clearBtn.onclick = function() {
        Array.prototype.forEach.call(
          document.querySelectorAll('#nr-articles-list .nr-art-row-check'),
          function(c) { c.checked = false; }
        );
        if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
        updateArtBulkBar();
      };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ENGAGEMENT TAB
  // ══════════════════════════════════════════════════════════════════════════

  async function loadEngagement() {
    var panel = document.getElementById('desk-engagement');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading engagement…</div>';

    try {
      var results = await Promise.all([
        apiFetch('/comments/admin/queue').catch(function () { return { queue: [] }; }),
        apiFetch('/banners/active').catch(function () { return []; }),
        apiFetch('/newsletter/history').catch(function () { return []; }),
      ]);
      var queue      = Array.isArray(results[0].queue) ? results[0].queue : [];
      var banners    = Array.isArray(results[1]) ? results[1] : [];
      var nlHistory  = Array.isArray(results[2]) ? results[2] : [];
      renderEngagement(queue, banners, nlHistory);
    } catch (err) {
      var panel2 = document.getElementById('desk-engagement');
      if (panel2) {
        panel2.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load engagement: ' + esc(err.message) + '</div>';
      }
      showAlert('Engagement load failed: ' + err.message, 'error');
    }
  }

  function renderEngagement(queue, banners, nlHistory) {
    var panel = document.getElementById('desk-engagement');
    if (!panel) return;

    // ── Comments section ──
    var html = '<div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;">';
    html += '<div class="nr-section-heading">Pending Moderation</div>';
    html += '<span style="font-size:12px;color:var(--muted,#9ca3af);" data-queue-count="' + queue.length + '">'
      + esc(String(queue.length)) + ' item' + (queue.length !== 1 ? 's' : '')
      + '</span>';
    html += '</div>';

    if (!queue.length) {
      html += '<div class="nr-empty">No comments pending moderation. ✓</div>';
    } else {
      html += '<div id="desk-engagement-list">';
      queue.forEach(function (c) { html += commentRowHtml(c); });
      html += '</div>';
    }

    html += '<div style="margin-top:12px;text-align:right;">';
    html += '<a href="/comments.html?tab=queue" style="font-size:12px;color:var(--accent,#6366f1);">Open full Comments →</a>';
    html += '</div>';

    // ── Newsletter section ──
    html += '<hr style="margin:20px 0;border:none;border-top:1px solid var(--border,#e5e7eb);">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">';
    html += '<div class="nr-section-heading">Newsletter</div>';
    html += '<a href="/newsletter.html" style="font-size:12px;color:var(--accent,#6366f1);">Manage →</a>';
    html += '</div>';

    // Send history (last 3)
    nlHistory = nlHistory || [];
    if (nlHistory.length) {
      html += '<div style="display:flex;flex-direction:column;gap:0;margin-bottom:10px;">';
      nlHistory.slice(0, 3).forEach(function (send) {
        var when = send.sent_at ? relTime(send.sent_at) : '—';
        var subject = send.subject || '(no subject)';
        var arts    = send.article_count != null ? send.article_count + ' articles' : '';
        html += '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border,#e5e7eb);">';
        html += '<span style="font-size:11px;color:var(--muted,#9ca3af);white-space:nowrap;min-width:60px;">' + esc(when) + '</span>';
        html += '<span style="font-size:12px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(truncate(subject, 60)) + '</span>';
        if (arts) html += '<span style="font-size:11px;color:var(--muted,#9ca3af);white-space:nowrap;">' + esc(arts) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div style="font-size:12px;color:var(--muted,#9ca3af);margin-bottom:10px;">No sends yet.</div>';
    }

    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">';
    html += '<button id="nr-nl-preview-btn" class="nr-row-btn">Preview</button>';
    html += '<button id="nr-nl-send-btn" class="nr-row-btn" style="color:var(--accent,#6366f1);">Send digest</button>';
    html += '</div>';
    html += '<div id="nr-nl-preview-box" style="display:none;margin-top:10px;font-size:12px;overflow:auto;max-height:300px;border:1px solid var(--border,#e5e7eb);border-radius:6px;padding:12px;"></div>';

    // ── Banners section ──
    html += '<hr style="margin:20px 0;border:none;border-top:1px solid var(--border,#e5e7eb);">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">';
    html += '<div class="nr-section-heading">Banners</div>';
    html += '</div>';

    html += '<div id="nr-banners-list">';
    html += renderBannersList(banners);
    html += '</div>';

    // New banner form
    html += '<div style="margin-top:12px;border:1px solid var(--border,#e5e7eb);border-radius:6px;padding:12px;">';
    html += '<div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--muted,#6b7280);">New Banner</div>';
    html += '<textarea id="nr-banner-message" rows="2" style="width:100%;box-sizing:border-box;font-size:13px;padding:6px 8px;border:1px solid var(--border,#e5e7eb);border-radius:4px;resize:vertical;" placeholder="Banner message…"></textarea>';
    html += '<div style="display:flex;gap:8px;margin-top:6px;align-items:center;">';
    html += '<select id="nr-banner-type" style="font-size:12px;padding:4px 6px;border:1px solid var(--border,#e5e7eb);border-radius:4px;">';
    html += '<option value="info">Info</option>';
    html += '<option value="warning">Warning</option>';
    html += '<option value="error">Error</option>';
    html += '</select>';
    html += '<button id="nr-banner-submit" class="nr-add-btn" style="margin-top:0;padding:4px 12px;">Add Banner</button>';
    html += '</div>';
    html += '</div>';

    panel.innerHTML = html;

    // Wire comments
    var list = document.getElementById('desk-engagement-list');
    if (list) {
      list.addEventListener('click', function (e) {
        var approveBtn = e.target.closest('[data-approve-comment]');
        var rejectBtn  = e.target.closest('[data-reject-comment]');
        if (approveBtn) moderateComment(parseInt(approveBtn.dataset.approveComment, 10), 'approve', approveBtn);
        if (rejectBtn)  moderateComment(parseInt(rejectBtn.dataset.rejectComment, 10),  'reject',  rejectBtn);
      });
    }

    // Wire newsletter buttons
    var previewBtn = document.getElementById('nr-nl-preview-btn');
    if (previewBtn) previewBtn.addEventListener('click', doNewsletterPreview);

    var sendBtn = document.getElementById('nr-nl-send-btn');
    if (sendBtn) sendBtn.addEventListener('click', doNewsletterSend);

    // Wire banners list (delete)
    var bannersList = document.getElementById('nr-banners-list');
    if (bannersList) {
      bannersList.addEventListener('click', function (e) {
        var delBtn = e.target.closest('[data-delete-banner]');
        if (delBtn) deleteBanner(parseInt(delBtn.dataset.deleteBanner, 10), delBtn);
      });
    }

    // Wire new banner form
    var bannerSubmit = document.getElementById('nr-banner-submit');
    if (bannerSubmit) bannerSubmit.addEventListener('click', createBanner);
  }

  function renderBannersList(banners) {
    if (!banners.length) {
      return '<div class="nr-empty" style="padding:8px 0;">No active banners.</div>';
    }
    return banners.map(function (b) {
      var typeColor = b.type === 'error' ? 'var(--danger,#ef4444)'
        : b.type === 'warning' ? '#f59e0b'
        : 'var(--accent,#6366f1)';
      return '<div class="nr-comment-row" style="display:flex;align-items:center;gap:8px;" data-banner-id="' + esc(String(b.id)) + '">'
        + '<span style="flex:1;font-size:13px;">' + esc(truncate(b.message, 80)) + '</span>'
        + '<span style="font-size:11px;font-weight:600;color:' + typeColor + ';white-space:nowrap;">' + esc(b.type || 'info') + '</span>'
        + (b.scope === 'global' ? '<span style="font-size:11px;color:var(--muted,#9ca3af);">global</span>' : '')
        + (b.scope !== 'global' ? '<button class="nr-row-btn" style="color:var(--danger,#ef4444);" data-delete-banner="' + esc(String(b.id)) + '">Delete</button>' : '')
        + '</div>';
    }).join('');
  }

  async function doNewsletterPreview() {
    var btn = document.getElementById('nr-nl-preview-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      var html = await apiFetch('/newsletter/send?preview=true', { method: 'POST' });
      // apiFetch parses JSON, but preview returns raw HTML — handle both
      var box = document.getElementById('nr-nl-preview-box');
      if (box) {
        box.style.display = '';
        // If we got a string (raw HTML), display as text; if object, stringify
        if (typeof html === 'string') {
          box.textContent = html;
        } else {
          box.textContent = JSON.stringify(html, null, 2);
        }
      }
    } catch (err) {
      showAlert('Newsletter preview failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Preview'; }
    }
  }

  async function doNewsletterSend() {
    if (!confirm('Send newsletter to all subscribers?')) return;
    var btn = document.getElementById('nr-nl-send-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      await apiFetch('/newsletter/send', { method: 'POST' });
      showAlert('Newsletter sent successfully.', 'success');
    } catch (err) {
      showAlert('Newsletter send failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send to subscribers'; }
    }
  }

  async function deleteBanner(bannerId, btn) {
    if (!bannerId) return;
    var row = btn && btn.closest('[data-banner-id]');
    if (row) row.style.opacity = '0.5';
    if (btn) btn.disabled = true;
    try {
      await apiFetch('/banners/' + bannerId, { method: 'DELETE' });
      showAlert('Banner deleted.', 'info');
      if (row && row.parentNode) row.parentNode.removeChild(row);
    } catch (err) {
      showAlert('Failed to delete banner: ' + err.message, 'error');
      if (row) row.style.opacity = '';
      if (btn) btn.disabled = false;
    }
  }

  async function createBanner() {
    var messageEl = document.getElementById('nr-banner-message');
    var typeEl    = document.getElementById('nr-banner-type');
    var submitBtn = document.getElementById('nr-banner-submit');

    var message = messageEl ? messageEl.value.trim() : '';
    var type    = typeEl    ? typeEl.value           : 'info';

    if (!message) { showAlert('Banner message is required.', 'error'); return; }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding…'; }
    try {
      var banner = await apiFetch('/banners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message, type: type, dismissible: true }),
      });
      showAlert('Banner created.', 'success');
      if (messageEl) messageEl.value = '';

      // Refresh banners list
      var bannersList = document.getElementById('nr-banners-list');
      if (bannersList && banner && banner.id) {
        var typeColor = type === 'error' ? 'var(--danger,#ef4444)'
          : type === 'warning' ? '#f59e0b'
          : 'var(--accent,#6366f1)';
        var newRow = '<div class="nr-comment-row" style="display:flex;align-items:center;gap:8px;" data-banner-id="' + esc(String(banner.id)) + '">'
          + '<span style="flex:1;font-size:13px;">' + esc(truncate(message, 80)) + '</span>'
          + '<span style="font-size:11px;font-weight:600;color:' + typeColor + ';white-space:nowrap;">' + esc(type) + '</span>'
          + '<button class="nr-row-btn" style="color:var(--danger,#ef4444);" data-delete-banner="' + esc(String(banner.id)) + '">Delete</button>'
          + '</div>';
        // Remove empty state message if present
        var empty = bannersList.querySelector('.nr-empty');
        if (empty) empty.parentNode.removeChild(empty);
        bannersList.insertAdjacentHTML('beforeend', newRow);
      }
    } catch (err) {
      showAlert('Failed to create banner: ' + err.message, 'error');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add Banner'; }
    }
  }

  function commentRowHtml(c) {
    var user    = (c.user && c.user.displayName) ? c.user.displayName : 'Anonymous';
    var article = (c.article && c.article.title)  ? c.article.title   : 'Unknown article';
    var slug    = c.article && c.article.slug;

    var articleLink = slug
      ? '<a href="/article/' + esc(slug) + '" target="_blank" style="color:inherit;">' + esc(truncate(article, 55)) + '</a>'
      : esc(truncate(article, 55));

    var priorBadge = c.priorApproved
      ? ' <span style="font-size:10px;background:var(--surface-2,#f3f4f6);padding:1px 5px;border-radius:4px;color:var(--muted,#9ca3af);">prior approved</span>'
      : '';

    return '<div class="nr-comment-row" data-comment-id="' + esc(String(c.id)) + '">'
      + '<div class="nr-comment-meta">'
      + '<strong>' + esc(user) + '</strong>'
      + priorBadge
      + ' · ' + articleLink
      + ' · <span style="color:var(--muted,#9ca3af);">' + esc(relTime(c.created_at)) + '</span>'
      + '</div>'
      + '<div class="nr-comment-body">' + esc(truncate(c.body, 200)) + '</div>'
      + '<div class="nr-comment-actions">'
      + '<button class="nr-row-btn" style="color:var(--success,#10b981);" data-approve-comment="' + esc(String(c.id)) + '">Approve</button>'
      + '<button class="nr-row-btn" style="color:var(--danger,#ef4444);"  data-reject-comment="'  + esc(String(c.id)) + '">Reject</button>'
      + '</div>'
      + '</div>';
  }

  async function moderateComment(commentId, action, btn) {
    var row = btn && btn.closest('[data-comment-id]');
    if (row) row.style.opacity = '0.5';
    if (btn) { btn.disabled = true; }

    try {
      await apiFetch('/comments/admin/' + commentId + '/' + action, { method: 'POST' });

      var verb = action === 'approve' ? 'Approved' : 'Rejected';
      showAlert(verb + ' — comment removed from queue.', action === 'approve' ? 'success' : 'info');

      if (row) {
        row.style.transition = 'opacity 0.2s';
        row.style.opacity = '0';
        setTimeout(function () {
          if (row.parentNode) row.parentNode.removeChild(row);
          updateEngagementCount(-1);
        }, 200);
      }
    } catch (err) {
      showAlert('Failed to ' + action + ' comment: ' + err.message, 'error');
      if (row) row.style.opacity = '';
      if (btn) btn.disabled = false;
    }
  }

  function updateEngagementCount(delta) {
    var panel = document.getElementById('desk-engagement');
    if (!panel) return;
    var countEl = panel.querySelector('[data-queue-count]');
    if (!countEl) return;
    var n = Math.max(0, (parseInt(countEl.dataset.queueCount, 10) || 0) + delta);
    countEl.dataset.queueCount = String(n);
    countEl.textContent = n + ' item' + (n !== 1 ? 's' : '');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SETTINGS TAB
  // ══════════════════════════════════════════════════════════════════════════

  // Keys we surface in the read view (in display order)
  var SETTINGS_DISPLAY = [
    { key: 'site_name',              label: 'Site Name' },
    { key: 'site_tagline',           label: 'Tagline' },
    { key: 'site_url',               label: 'Site URL' },
    { key: 'mod_queue_enabled',      label: 'Comment Moderation Queue' },
    { key: 'ai_daily_budget',        label: 'AI Daily Budget (USD)' },
    { key: 'ai_monthly_budget',      label: 'AI Monthly Budget (USD)' },
    { key: 'newsroom_timezone',      label: 'Newsroom Timezone', type: 'timezone' },
    { key: 'budget_autopilot_hours', label: 'Auto-promote delay (hours)', type: 'number' },
  ];

  var TIMEZONE_OPTIONS = [
    { value: 'UTC',                   label: 'UTC' },
    { value: 'America/New_York',      label: 'Eastern (ET)' },
    { value: 'America/Chicago',       label: 'Central (CT)' },
    { value: 'America/Denver',        label: 'Mountain (MT)' },
    { value: 'America/Los_Angeles',   label: 'Pacific (PT)' },
    { value: 'America/Anchorage',     label: 'Alaska (AKT)' },
    { value: 'Pacific/Honolulu',      label: 'Hawaii (HT)' },
    { value: 'America/Toronto',       label: 'Toronto (ET)' },
    { value: 'America/Vancouver',     label: 'Vancouver (PT)' },
    { value: 'America/Sao_Paulo',     label: 'São Paulo (BRT)' },
    { value: 'Europe/London',         label: 'London (GMT/BST)' },
    { value: 'Europe/Paris',          label: 'Paris (CET/CEST)' },
    { value: 'Europe/Berlin',         label: 'Berlin (CET/CEST)' },
    { value: 'Europe/Amsterdam',      label: 'Amsterdam (CET/CEST)' },
    { value: 'Europe/Stockholm',      label: 'Stockholm (CET/CEST)' },
    { value: 'Europe/Warsaw',         label: 'Warsaw (CET/CEST)' },
    { value: 'Europe/Kiev',           label: 'Kyiv (EET/EEST)' },
    { value: 'Asia/Dubai',            label: 'Dubai (GST)' },
    { value: 'Asia/Kolkata',          label: 'India (IST)' },
    { value: 'Asia/Singapore',        label: 'Singapore (SGT)' },
    { value: 'Asia/Tokyo',            label: 'Tokyo (JST)' },
    { value: 'Asia/Seoul',            label: 'Seoul (KST)' },
    { value: 'Asia/Shanghai',         label: 'Shanghai (CST)' },
    { value: 'Australia/Sydney',      label: 'Sydney (AEST/AEDT)' },
    { value: 'Australia/Melbourne',   label: 'Melbourne (AEST/AEDT)' },
    { value: 'Pacific/Auckland',      label: 'Auckland (NZST/NZDT)' },
  ];

  async function loadSettings() {
    var panel = document.getElementById('desk-settings');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading settings…</div>';

    try {
      var results = await Promise.all([
        apiFetch('/settings'),
        apiFetch('/sources').catch(function () { return null; }),
      ]);
      renderSettings(results[0], results[1]);
    } catch (err) {
      var panel2 = document.getElementById('desk-settings');
      if (panel2) {
        panel2.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load settings: ' + esc(err.message) + '</div>';
      }
      showAlert('Settings load failed: ' + err.message, 'error');
    }
  }

  function renderSettings(data, sources) {
    var panel = document.getElementById('desk-settings');
    if (!panel) return;

    var html = '<div class="nr-section-heading" style="margin-bottom:16px;">Publication Settings</div>';
    html += '<div class="nr-settings-form" id="nr-settings-form">';

    SETTINGS_DISPLAY.forEach(function (def) {
      var raw = data[def.key];
      // For timezone/number settings show even when not yet set (use empty default)
      var isSpecialType = def.type === 'timezone' || def.type === 'number';
      if (!isSpecialType && (raw === undefined || raw === null)) return;
      var strVal = raw !== undefined && raw !== null ? String(raw) : '';
      if (!isSpecialType && (strVal.length > 200 || /^[A-Za-z0-9+/]{40,}={0,2}$/.test(strVal))) return;

      html += '<div class="nr-settings-row">';
      html += '<label class="nr-settings-label" for="nr-setting-' + esc(def.key) + '">' + esc(def.label) + '</label>';
      html += '<div class="nr-settings-control">';

      if (def.key === 'mod_queue_enabled') {
        var on = raw === true || raw === 'true' || raw === '1' || raw === 1;
        html += '<button type="button" class="nr-toggle-btn' + (on ? ' on' : '') + '" '
          + 'data-setting-key="mod_queue_enabled" id="nr-setting-mod_queue_enabled">'
          + '<span class="nr-toggle-track"><span class="nr-toggle-thumb"></span></span>'
          + '<span class="nr-toggle-label">' + (on ? 'Enabled' : 'Disabled') + '</span>'
          + '</button>';
      } else if (def.type === 'timezone') {
        html += '<select id="nr-setting-' + esc(def.key) + '" class="nr-setting-select" data-setting-key="' + esc(def.key) + '">';
        TIMEZONE_OPTIONS.forEach(function (opt) {
          var sel = (strVal === opt.value || (!strVal && opt.value === 'UTC')) ? ' selected' : '';
          html += '<option value="' + esc(opt.value) + '"' + sel + '>' + esc(opt.label) + '</option>';
        });
        html += '</select>';
      } else {
        var inputType = 'text';
        if (def.key === 'site_url') inputType = 'url';
        if (def.type === 'number' || def.key === 'ai_daily_budget' || def.key === 'ai_monthly_budget') inputType = 'number';
        var extra = inputType === 'number' ? ' step="1" min="0"' : '';
        if (def.key === 'ai_daily_budget' || def.key === 'ai_monthly_budget') extra = ' step="0.01" min="0"';
        html += '<input type="' + inputType + '" '
          + 'id="nr-setting-' + esc(def.key) + '" '
          + 'class="nr-setting-input" '
          + 'data-setting-key="' + esc(def.key) + '" '
          + 'value="' + esc(strVal) + '"'
          + extra + ' />';
      }

      html += '<span class="nr-setting-status" id="nr-setting-status-' + esc(def.key) + '"></span>';
      html += '</div>';
      html += '</div>';
    });

    html += '</div>';

    // ── RSS Sources section ──
    html += '<hr style="margin:24px 0;border:none;border-top:1px solid var(--border,#e5e7eb);">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">';
    html += '<div class="nr-section-heading">RSS Sources</div>';
    html += '<a href="/sources.html" style="font-size:12px;color:var(--accent,#6366f1);">Manage sources →</a>';
    html += '</div>';

    if (!sources || !Array.isArray(sources) || !sources.length) {
      html += '<div class="nr-empty" style="padding:8px 0;">No sources configured.</div>';
    } else {
      html += '<div id="nr-sources-list">';
      sources.forEach(function (s) {
        var isActive  = s.is_active === 1 || s.is_active === true;
        var lastFetch = s.last_fetched_at ? relTime(s.last_fetched_at) : 'never';
        var artCount  = s.article_count != null ? fmtNum(s.article_count) : '—';

        html += '<div class="nr-comment-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;" data-source-id="' + esc(String(s.id)) + '">';
        html += '<div style="flex:1;min-width:0;">';
        html += '<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(s.name || '—') + '</div>';
        html += '<div style="font-size:11px;color:var(--muted,#9ca3af);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(s.url || '') + '">' + esc(truncate(s.url || '', 60)) + '</div>';
        html += '</div>';
        html += '<span style="font-size:11px;color:var(--muted,#9ca3af);white-space:nowrap;">' + esc(artCount) + ' articles</span>';
        html += '<span style="font-size:11px;color:var(--muted,#9ca3af);white-space:nowrap;">fetched ' + esc(lastFetch) + '</span>';
        html += '<button class="nr-row-btn" style="white-space:nowrap;color:' + (isActive ? 'var(--danger,#ef4444)' : 'var(--success,#10b981)') + ';" data-toggle-source="' + esc(String(s.id)) + '" data-source-active="' + (isActive ? '1' : '0') + '">'
          + (isActive ? 'Disable' : 'Enable') + '</button>';
        html += '</div>';
      });
      html += '</div>';
    }

    panel.innerHTML = html;

    // Wire save-on-blur / Enter for text & number inputs; save-on-change for selects
    var form = document.getElementById('nr-settings-form');
    if (form) {
      form.addEventListener('blur', function (e) {
        if (e.target.matches('.nr-setting-input')) {
          saveSetting(e.target.dataset.settingKey, e.target.value);
        }
      }, true);
      form.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target.matches('.nr-setting-input')) {
          e.target.blur();
        }
      });
      form.addEventListener('change', function (e) {
        if (e.target.matches('.nr-setting-select')) {
          saveSetting(e.target.dataset.settingKey, e.target.value);
        }
      });
      form.addEventListener('click', function (e) {
        var btn = e.target.closest('.nr-toggle-btn');
        if (!btn) return;
        var nowOn = btn.classList.contains('on');
        btn.classList.toggle('on', !nowOn);
        btn.querySelector('.nr-toggle-label').textContent = !nowOn ? 'Enabled' : 'Disabled';
        saveSetting('mod_queue_enabled', !nowOn ? '1' : '0');
      });
    }

    // Wire source toggle buttons
    var sourcesList = document.getElementById('nr-sources-list');
    if (sourcesList) {
      sourcesList.addEventListener('click', function (e) {
        var toggleBtn = e.target.closest('[data-toggle-source]');
        if (toggleBtn) toggleSource(parseInt(toggleBtn.dataset.toggleSource, 10), toggleBtn);
      });
    }
  }

  async function saveSetting(key, value) {
    var statusEl = document.getElementById('nr-setting-status-' + key);
    if (statusEl) { statusEl.textContent = '…'; statusEl.style.color = 'var(--muted,#6b7280)'; }
    try {
      var body = {};
      body[key] = value;
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) });
      if (statusEl) {
        statusEl.textContent = '✓ Saved';
        statusEl.style.color = 'var(--success,#10b981)';
        setTimeout(function () { if (statusEl) statusEl.textContent = ''; }, 2000);
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = '✗ Failed';
        statusEl.style.color = 'var(--danger,#ef4444)';
      }
      showAlert('Failed to save setting: ' + err.message, 'error');
    }
  }

  async function toggleSource(sourceId, btn) {
    if (!sourceId) return;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      var result = await apiFetch('/sources/' + sourceId + '/toggle', { method: 'PUT' });
      var nowActive = result && (result.is_active === 1 || result.is_active === true);
      if (btn) {
        btn.disabled = false;
        btn.textContent = nowActive ? 'Disable' : 'Enable';
        btn.style.color = nowActive ? 'var(--danger,#ef4444)' : 'var(--success,#10b981)';
        btn.dataset.sourceActive = nowActive ? '1' : '0';
      }
      showAlert('Source ' + (nowActive ? 'enabled' : 'disabled') + '.', 'info');
    } catch (err) {
      showAlert('Failed to toggle source: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.sourceActive === '1' ? 'Disable' : 'Enable'; }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STYLES TAB
  // ══════════════════════════════════════════════════════════════════════════

  async function loadStyles() {
    var panel = document.getElementById('desk-styles');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading styles…</div>';

    try {
      var styles = await apiFetch('/admin/writing-styles');
      renderStyles(Array.isArray(styles) ? styles : []);
    } catch (err) {
      var panel2 = document.getElementById('desk-styles');
      if (panel2) {
        panel2.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load styles: ' + esc(err.message) + '</div>';
      }
      showAlert('Styles load failed: ' + err.message, 'error');
    }
  }

  function renderStyles(styles) {
    var panel = document.getElementById('desk-styles');
    if (!panel) return;

    var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">';
    html += '<div class="nr-section-heading">Writing Styles</div>';
    html += '<a href="/writing-styles.html" style="font-size:12px;color:var(--accent,#6366f1);">Manage all styles →</a>';
    html += '</div>';

    if (!styles.length) {
      html += '<div class="nr-empty">No writing styles found.</div>';
    } else {
      html += '<div style="display:flex;flex-direction:column;gap:8px;">';
      styles.forEach(function (s) {
        var isSystem = s.is_system === true || s.is_system === 1;
        var desc = s.description ? truncate(String(s.description), 100) : '';
        html += '<div class="nr-style-card">';
        html += '<div class="nr-style-head">';
        html += '<span class="nr-style-name">' + esc(s.name || '—') + '</span>';
        if (s.category) {
          html += '<span class="nr-style-cat">' + esc(s.category) + '</span>';
        }
        if (isSystem) {
          html += '<span class="nr-style-system">system</span>';
        }
        html += '</div>';
        if (desc) {
          html += '<div class="nr-style-desc">' + esc(desc) + '</div>';
        }
        html += '<div class="nr-style-foot">';
        html += '<a href="/writing-styles.html" class="nr-row-btn">Edit →</a>';
        html += '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    html += '<button class="nr-add-btn" style="margin-top:14px;" onclick="window.location.href=\'/writing-styles.html\'">+ New Style</button>';

    panel.innerHTML = html;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB SWITCHING
  // ══════════════════════════════════════════════════════════════════════════

  var TAB_LOADERS = {
    writers:    loadWriters,
    articles:   loadArticles,
    engagement: loadEngagement,
    settings:   loadSettings,
    styles:     loadStyles,
  };

  function switchTab(tab) {
    if (!TAB_LOADERS[tab]) return;

    // Update button states
    document.querySelectorAll('#nr-desk-tabs .desk-inner-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Update panel visibility
    var panels = ['writers', 'articles', 'engagement', 'settings', 'styles'];
    panels.forEach(function (name) {
      var el = document.getElementById('desk-' + name);
      if (el) el.classList.toggle('active', name === tab);
    });

    activeTab = tab;

    // Lazy load: only fetch when first visiting this tab
    if (!loaded[tab]) {
      loaded[tab] = true;
      TAB_LOADERS[tab]();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════════════════════

  function init() {
    // Wire up inner tab buttons
    var tabBar = document.getElementById('nr-desk-tabs');
    if (tabBar) {
      tabBar.addEventListener('click', function (e) {
        var btn = e.target.closest('.desk-inner-tab');
        if (!btn || !btn.dataset.tab) return;
        switchTab(btn.dataset.tab);
      });
    }

    // Restore persisted article filter on init
    try { artStatus = localStorage.getItem('nr_desk_art_filter') || ''; } catch (_) {}

    // Restore last desk tab from localStorage
    var savedTab = null;
    try { savedTab = localStorage.getItem('nr_desk_tab'); } catch (_) {}
    if (savedTab && TAB_LOADERS[savedTab]) {
      activeTab = savedTab;
    }

    // Persist tab choice on switch
    var origSwitch = switchTab;
    switchTab = function (tab) {
      origSwitch(tab);
      try { localStorage.setItem('nr_desk_tab', tab); } catch (_) {}
    };

    // Activate the starting tab (writers by default, or restored)
    switchTab(activeTab);
  }

  // ── Public surface ────────────────────────────────────────────────────────
  window.NRDesk = { init: init };

})();
