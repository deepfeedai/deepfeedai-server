/**
 * Newsroom — The Desk workspace
 * Five inner tabs: Writers, Articles, Analytics, Engagement, Settings.
 *
 * APIs consumed:
 *   GET  /api/admin/writers
 *   GET  /api/admin/writers/performance?range=30d
 *   GET  /api/articles?limit=40&offset=0
 *   GET  /api/analytics/summary?range=30d
 *   GET  /api/ai-usage/summary?range=30d
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
    analytics:  false,
    engagement: false,
    settings:   false,
  };

  var activeTab = 'writers';

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
    var url = '/articles?limit=40&offset=' + (offset || 0) + '&type=original,deep-dive';
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

    // Restore persisted filter
    try { artStatus = localStorage.getItem('nr_desk_art_filter') || ''; } catch (_) {}

    var html = '<div class="nr-articles-toolbar">';
    html += '<input class="nr-articles-search" id="nr-articles-search" placeholder="Search articles…" value="' + esc(artSearch) + '">';
    html += '<div class="nr-filter-chips" id="nr-articles-filter">';
    html += chipHtml('', 'All', artStatus);
    html += chipHtml('published', 'Published', artStatus);
    html += chipHtml('draft', 'Draft', artStatus);
    html += chipHtml('review', 'Review', artStatus);
    html += '</div>';
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
    return articles.map(function (a) {
      var displayTitle = a.generated_title || a.title || '(Untitled)';
      var statusKey    = artStatusFromRow(a);
      var dateSrc      = a.published_at || a.created_at;
      var meta         = (a.category ? esc(a.category) + ' · ' : '') + esc(relTime(dateSrc));
      return '<div class="nr-article-row">'
        + '<a class="nr-article-title" href="/article-editor.html?id=' + esc(String(a.id)) + '" title="' + esc(displayTitle) + '">'
        + esc(truncate(displayTitle, 90))
        + '</a>'
        + '<span class="nr-article-meta">' + meta + '</span>'
        + '<span class="nr-article-status as-' + esc(statusKey) + '">' + esc(statusKey) + '</span>'
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
  }

  function onArtLoadMore() {
    artOffset += 40;
    loadArticles({ reset: false });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ANALYTICS TAB
  // ══════════════════════════════════════════════════════════════════════════

  async function loadAnalytics() {
    var panel = document.getElementById('desk-analytics');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading analytics…</div>';

    try {
      var results = await Promise.all([
        apiFetch('/analytics/summary?range=30d'),
        apiFetch('/ai-usage/summary?range=30d').catch(function () { return null; }),
      ]);
      renderAnalytics(results[0], results[1]);
    } catch (err) {
      var panel2 = document.getElementById('desk-analytics');
      if (panel2) {
        panel2.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load analytics: ' + esc(err.message) + '</div>';
      }
      showAlert('Analytics load failed: ' + err.message, 'error');
    }
  }

  function renderAnalytics(data, aiData) {
    var panel = document.getElementById('desk-analytics');
    if (!panel) return;

    var totals      = data.totals      || {};
    var byDay       = Array.isArray(data.by_day)       ? data.by_day       : [];
    var topArticles = Array.isArray(data.top_articles) ? data.top_articles : [];

    // Compute trend: last 7d vs prior 7d
    var trendHtml = '';
    if (byDay.length >= 7) {
      var last7  = byDay.slice(-7).reduce(function (s, d) { return s + (d.views || 0); }, 0);
      var prior7 = byDay.length >= 14
        ? byDay.slice(-14, -7).reduce(function (s, d) { return s + (d.views || 0); }, 0)
        : 0;
      if (prior7 > 0) {
        var delta   = last7 - prior7;
        var pct     = Math.round(Math.abs(delta / prior7) * 100);
        var trendUp = delta >= 0;
        trendHtml = '<span class="nr-stat-delta ' + (trendUp ? 'up' : 'down') + '">'
          + (trendUp ? '↑' : '↓') + ' ' + pct + '% vs prior 7d'
          + '</span>';
      } else if (last7 > 0) {
        trendHtml = '<span class="nr-stat-delta up">↑ trend</span>';
      }
    } else if (byDay.length > 0) {
      // Not enough data for comparison — show direction within available window
      var firstHalf = Math.floor(byDay.length / 2);
      var sumFirst  = byDay.slice(0, firstHalf).reduce(function (s, d) { return s + (d.views || 0); }, 0);
      var sumSecond = byDay.slice(firstHalf).reduce(function (s, d) { return s + (d.views || 0); }, 0);
      if (sumFirst + sumSecond > 0) {
        var goingUp = sumSecond >= sumFirst;
        trendHtml = '<span class="nr-stat-delta ' + (goingUp ? 'up' : 'down') + '">'
          + (goingUp ? '↑ trend' : '↓ trend')
          + '</span>';
      }
    }

    // Stat cards
    var html = '<div class="nr-analytics-grid">';

    html += statCardHtml('Total Views', fmtNum(totals.views), trendHtml);
    html += statCardHtml('Audio Plays', fmtNum(totals.audio_plays), '');
    html += statCardHtml('Shares', fmtNum(totals.shares), '');

    html += '</div>';

    // Top articles section
    html += '<div style="margin-top:24px;">';
    html += '<div class="nr-section-heading">Top Articles — Last 30 Days</div>';

    if (topArticles.length) {
      html += '<table class="nr-writers-table" style="margin-top:8px;">';
      html += '<thead><tr><th style="width:60%;">Article</th><th style="text-align:right;">Views</th></tr></thead>';
      html += '<tbody>';
      topArticles.slice(0, 5).forEach(function (a, i) {
        html += '<tr>';
        html += '<td style="display:flex;align-items:center;gap:8px;">';
        html += '<span style="color:var(--muted,#9ca3af);font-size:11px;min-width:16px;">' + esc(String(i + 1)) + '</span>';
        if (a.slug) {
          html += '<a href="/article/' + esc(a.slug) + '" target="_blank" style="color:inherit;text-decoration:none;font-size:13px;" title="' + esc(a.title) + '">';
          html += esc(truncate(a.title, 72));
          html += '</a>';
        } else {
          html += '<span style="font-size:13px;" title="' + esc(a.title) + '">' + esc(truncate(a.title, 72)) + '</span>';
        }
        html += '</td>';
        html += '<td style="text-align:right;font-size:13px;font-variant-numeric:tabular-nums;">' + esc(fmtNum(a.views)) + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<div class="nr-empty" style="padding:20px 0;">No article data available yet.</div>';
    }

    html += '</div>';

    // AI Usage section
    html += renderAiUsageSection(aiData);

    // Footer link
    html += '<div style="margin-top:20px;text-align:right;">';
    html += '<a href="/analytics.html" style="font-size:12px;color:var(--accent,#6366f1);">Open full Analytics →</a>';
    html += '</div>';

    panel.innerHTML = html;
  }

  function renderAiUsageSection(aiData) {
    var html = '<div style="margin-top:28px;">';
    html += '<div class="nr-section-heading" style="margin-bottom:12px;">AI Usage (30d)</div>';

    if (!aiData) {
      html += '<div class="nr-empty" style="padding:12px 0;">AI usage data unavailable.</div>';
      html += '</div>';
      return html;
    }

    var tot    = aiData.totals  || {};
    var budget = aiData.budget  || {};
    var models = Array.isArray(aiData.by_model) ? aiData.by_model : [];

    // Summary row
    var cost        = parseFloat(tot.estimated_cost) || 0;
    var calls       = parseInt(tot.api_calls, 10)    || 0;
    var successRate = parseFloat(tot.success_rate)   || 0;

    html += '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;">';
    html += '<span style="font-size:13px;">Cost: <strong>$' + esc(cost.toFixed(4)) + '</strong></span>';
    html += '<span style="font-size:13px;">Calls: <strong>' + esc(fmtNum(calls)) + '</strong></span>';
    html += '<span style="font-size:13px;">Success: <strong>' + esc(successRate.toFixed(1)) + '%</strong></span>';
    html += '</div>';

    // Budget progress bar
    var monthlyLimit = parseFloat(budget.monthly_limit) || 0;
    var monthlySpend = parseFloat(budget.current_spend)  || 0;
    if (monthlyLimit > 0) {
      var pct = Math.min(100, Math.round((monthlySpend / monthlyLimit) * 100));
      var barColor = pct >= 90 ? 'var(--danger,#ef4444)' : pct >= 70 ? '#f59e0b' : 'var(--accent,#6366f1)';
      html += '<div style="margin-bottom:12px;">';
      html += '<div style="font-size:12px;color:var(--muted,#9ca3af);margin-bottom:4px;">Budget: $'
        + esc(monthlySpend.toFixed(2)) + ' / $' + esc(monthlyLimit.toFixed(2)) + ' monthly</div>';
      html += '<div style="height:4px;border-radius:2px;background:var(--border,#e5e7eb);">'
        + '<div style="height:100%;border-radius:2px;background:' + barColor + ';width:' + pct + '%;"></div>'
        + '</div>';
      html += '</div>';
    }

    // By-model table
    if (models.length) {
      html += '<div style="overflow-x:auto;">';
      html += '<table class="nr-writers-table" style="margin-top:4px;">';
      html += '<thead><tr>';
      html += '<th>Model</th><th>Provider</th>';
      html += '<th style="text-align:right;">Input tokens</th>';
      html += '<th style="text-align:right;">Output tokens</th>';
      html += '<th style="text-align:right;">Cost</th>';
      html += '</tr></thead><tbody>';
      models.forEach(function (m) {
        html += '<tr>';
        html += '<td style="font-size:12px;">' + esc(m.model || '—') + '</td>';
        html += '<td style="font-size:12px;">' + esc(m.provider || '—') + '</td>';
        html += '<td style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">' + esc(fmtNum(m.input_tokens)) + '</td>';
        html += '<td style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">' + esc(fmtNum(m.output_tokens)) + '</td>';
        html += '<td style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">$' + esc(parseFloat(m.cost || 0).toFixed(4)) + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="nr-empty" style="padding:8px 0;">No model-level data yet.</div>';
    }

    html += '</div>';
    return html;
  }

  function statCardHtml(label, value, extra) {
    return '<div class="nr-stat-card">'
      + '<div class="nr-stat-label">' + esc(label) + '</div>'
      + '<div class="nr-stat-value">' + esc(value) + '</div>'
      + (extra || '')
      + '</div>';
  }

  function truncate(s, max) {
    var str = String(s || '');
    return str.length > max ? str.slice(0, max) + '…' : str;
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
      ]);
      var queue   = Array.isArray(results[0].queue) ? results[0].queue : [];
      var banners = Array.isArray(results[1]) ? results[1] : [];
      renderEngagement(queue, banners);
    } catch (err) {
      var panel2 = document.getElementById('desk-engagement');
      if (panel2) {
        panel2.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load engagement: ' + esc(err.message) + '</div>';
      }
      showAlert('Engagement load failed: ' + err.message, 'error');
    }
  }

  function renderEngagement(queue, banners) {
    var panel = document.getElementById('desk-engagement');
    if (!panel) return;

    // ── Comments section ──
    var html = '<div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;">';
    html += '<div class="nr-section-heading">Pending Moderation</div>';
    html += '<span style="font-size:12px;color:var(--muted,#9ca3af);">'
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
    html += '<div class="nr-section-heading" style="margin-bottom:10px;">Newsletter</div>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">';
    html += '<button id="nr-nl-preview-btn" class="nr-row-btn">Preview</button>';
    html += '<button id="nr-nl-send-btn" class="nr-row-btn" style="color:var(--accent,#6366f1);">Send to subscribers</button>';
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
    var n = (parseInt(countEl.textContent, 10) || 0) + delta;
    countEl.textContent = String(Math.max(0, n));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SETTINGS TAB
  // ══════════════════════════════════════════════════════════════════════════

  // Keys we surface in the read view (in display order)
  var SETTINGS_DISPLAY = [
    { key: 'site_name',         label: 'Site Name' },
    { key: 'site_tagline',      label: 'Tagline' },
    { key: 'site_url',          label: 'Site URL' },
    { key: 'mod_queue_enabled', label: 'Comment Moderation Queue' },
    { key: 'ai_daily_budget',   label: 'AI Daily Budget (USD)' },
    { key: 'ai_monthly_budget', label: 'AI Monthly Budget (USD)' },
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

    var html = '<div class="nr-section-heading" style="margin-bottom:12px;">Publication Settings</div>';
    html += '<table class="nr-writers-table">';
    html += '<tbody>';

    SETTINGS_DISPLAY.forEach(function (def) {
      var raw = data[def.key];
      // Skip keys not present in response
      if (raw === undefined || raw === null) return;
      // Skip anything that looks like an encrypted blob (long base64/hex strings)
      var strVal = String(raw);
      if (strVal.length > 200 || /^[A-Za-z0-9+/]{40,}={0,2}$/.test(strVal)) return;

      var displayVal = formatSettingValue(def.key, raw);

      html += '<tr>';
      html += '<td style="color:var(--muted,#6b7280);font-size:12px;white-space:nowrap;width:200px;">' + esc(def.label) + '</td>';
      html += '<td style="font-size:13px;">' + displayVal + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';

    // Footer link
    html += '<div style="margin-top:24px;display:flex;align-items:center;justify-content:space-between;">';
    html += '<span style="font-size:12px;color:var(--muted,#9ca3af);">Read-only snapshot — edit in full Settings.</span>';
    html += '<a href="/settings.html" style="font-size:13px;font-weight:500;color:var(--accent,#6366f1);">Open full Settings →</a>';
    html += '</div>';

    // ── RSS Sources section ──
    html += '<hr style="margin:20px 0;border:none;border-top:1px solid var(--border,#e5e7eb);">';
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

    // Wire source toggle buttons
    var sourcesList = document.getElementById('nr-sources-list');
    if (sourcesList) {
      sourcesList.addEventListener('click', function (e) {
        var toggleBtn = e.target.closest('[data-toggle-source]');
        if (toggleBtn) toggleSource(parseInt(toggleBtn.dataset.toggleSource, 10), toggleBtn);
      });
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

  function formatSettingValue(key, raw) {
    // Boolean toggle keys
    if (key === 'mod_queue_enabled') {
      var on = raw === true || raw === 'true' || raw === '1' || raw === 1;
      return on
        ? '<span style="color:var(--success,#10b981);font-size:12px;font-weight:600;">Enabled</span>'
        : '<span style="color:var(--muted,#9ca3af);font-size:12px;">Disabled</span>';
    }

    // URL keys — make them clickable
    if (key === 'site_url') {
      var url = String(raw || '');
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        return '<a href="' + esc(url) + '" target="_blank" rel="noopener" style="color:var(--accent,#6366f1);font-size:13px;">' + esc(url) + '</a>';
      }
    }

    // Budget keys — format as currency
    if (key === 'ai_daily_budget' || key === 'ai_monthly_budget') {
      var num = parseFloat(raw);
      if (!isNaN(num)) {
        return '<span style="font-variant-numeric:tabular-nums;">$' + esc(num.toFixed(2)) + '</span>';
      }
    }

    return esc(String(raw || ''));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB SWITCHING
  // ══════════════════════════════════════════════════════════════════════════

  var TAB_LOADERS = {
    writers:    loadWriters,
    articles:   loadArticles,
    analytics:  loadAnalytics,
    engagement: loadEngagement,
    settings:   loadSettings,
  };

  function switchTab(tab) {
    if (!TAB_LOADERS[tab]) return;

    // Update button states
    document.querySelectorAll('#nr-desk-tabs .desk-inner-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Update panel visibility
    var panels = ['writers', 'articles', 'analytics', 'engagement', 'settings'];
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
