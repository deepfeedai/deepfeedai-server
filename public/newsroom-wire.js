/**
 * Newsroom — The Wire workspace
 * Unified ingest feed: source article clusters grouped by topic_tag,
 * with actions to synthesize or spike each cluster.
 * Inner tabs: Feed | Stories | Discover | Pipeline
 *
 * APIs consumed:
 *   GET  /api/articles?type=curated&limit=100&offset=0
 *   GET  /api/story-threads?status=active,dormant&limit=40
 *   GET  /api/synthesis/pipeline-overview
 *   POST /api/synthesis/run-all
 *   GET  /api/admin/discover?q=&sources=&period=24h
 *   POST /api/admin/discover/import
 *   POST /api/synthesis/run/:writerId?force=true
 *
 * Globals from admin.js: apiFetch, showAlert, escHtml
 * Exposed as: window.NRWire = { init }
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  var state = {
    clusters: [],          // [{tag, articles: [], threadName, isCluster}]
    threadsMap: {},        // topic_tag → thread name
    pipelineData: null,
    activeFilter: 'all',   // 'all' | 'clusters' | 'singles'
    searchQuery: '',
    synthesizing: false,
    searchTimer: null,
    // Inner-tab lazy-load flags
    loaded: {
      feed: false,
      stories: false,
      discover: false,
      pipeline: false,
    },
  };

  // ── HTML escape helper ────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Relative time ─────────────────────────────────────────────────────────
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

  // ── Extract domain from URL or source string ──────────────────────────────
  function sourceDomain(source) {
    if (!source) return 'unknown';
    try {
      if (/^https?:\/\//i.test(source)) {
        return new URL(source).hostname.replace(/^www\./, '');
      }
    } catch (_) {}
    return source.length > 20 ? source.slice(0, 18) + '…' : source;
  }

  // ── Group articles by topic_tag ───────────────────────────────────────────
  function groupArticles(articles) {
    var map = {};   // key → [article, ...]
    articles.forEach(function (a) {
      var key = (a.topic_tag && a.topic_tag.trim()) ? a.topic_tag.trim() : sourceDomain(a.source);
      if (!map[key]) map[key] = [];
      map[key].push(a);
    });

    var clusters = [];
    Object.keys(map).forEach(function (tag) {
      var arts = map[tag];
      clusters.push({
        tag: tag,
        articles: arts,
        isCluster: arts.length >= 2,
        threadName: state.threadsMap[tag] || null,
      });
    });

    // Sort: clusters (≥2) first by count desc, then singles by recency
    clusters.sort(function (a, b) {
      if (a.isCluster !== b.isCluster) return a.isCluster ? -1 : 1;
      if (a.isCluster) return b.articles.length - a.articles.length;
      var ta = a.articles[0] && a.articles[0].created_at ? new Date(a.articles[0].created_at).getTime() : 0;
      var tb = b.articles[0] && b.articles[0].created_at ? new Date(b.articles[0].created_at).getTime() : 0;
      return tb - ta;
    });

    return clusters;
  }

  // ── Build a single cluster card HTML string ───────────────────────────────
  function clusterCardHtml(cluster) {
    var tag      = cluster.tag;
    var arts     = cluster.articles;
    var count    = arts.length;
    var typeCls  = cluster.isCluster ? 'ct-cluster' : 'ct-single';
    var typeLabel = cluster.isCluster ? 'Cluster' : 'Single';

    // Newest article timestamp
    var newest = arts.reduce(function (best, a) {
      var t = a.created_at ? new Date(a.created_at).getTime() : 0;
      return t > best ? t : best;
    }, 0);
    var ageStr = newest ? relTime(new Date(newest).toISOString()) : '';

    // Thread name pill (if known)
    var threadPill = cluster.threadName
      ? '<span style="font-size:10px;color:var(--muted);font-weight:400;margin-left:4px;">· ' + esc(cluster.threadName) + '</span>'
      : '';

    // Stats
    var statsHtml = ''
      + '<span class="nr-cluster-stat"><strong>' + esc(count) + '</strong> source' + (count !== 1 ? 's' : '') + '</span>'
      + (ageStr ? '<span class="nr-cluster-stat">' + esc(ageStr) + '</span>' : '');

    // Source rows: show first 3, rest behind toggle
    var PREVIEW_LIMIT = 3;
    var visibleArts   = arts.slice(0, PREVIEW_LIMIT);
    var hiddenArts    = arts.slice(PREVIEW_LIMIT);
    var hasHidden     = hiddenArts.length > 0;

    var sourcesHtml = '';
    visibleArts.forEach(function (a) {
      var pub   = sourceDomain(a.source);
      var title = a.title || '(untitled)';
      var pitchBadge = '';
      if (a.pitch_status === 'in_pitch') {
        pitchBadge = ' <span style="font-size:9px;color:var(--accent);font-weight:600;vertical-align:middle;">IN PITCH</span>';
      } else if (a.pitch_status === 'used') {
        pitchBadge = ' <span style="font-size:9px;color:var(--muted);font-weight:600;vertical-align:middle;">USED</span>';
      }
      sourcesHtml += '<div class="nr-source-row">'
        + '<span class="nr-source-pub" title="' + esc(a.source) + '">' + esc(pub) + '</span>'
        + '<span class="nr-source-title">' + esc(title) + pitchBadge + '</span>'
        + '</div>';
    });

    if (hasHidden) {
      // Hidden rows (initially collapsed)
      sourcesHtml += '<div class="nr-wire-hidden-rows" style="display:none;">';
      hiddenArts.forEach(function (a) {
        var pub   = sourceDomain(a.source);
        var title = a.title || '(untitled)';
        sourcesHtml += '<div class="nr-source-row">'
          + '<span class="nr-source-pub" title="' + esc(a.source) + '">' + esc(pub) + '</span>'
          + '<span class="nr-source-title">' + esc(title) + '</span>'
          + '</div>';
      });
      sourcesHtml += '</div>';
      sourcesHtml += '<div class="nr-source-more" data-wire-toggle>'
        + 'Show ' + hiddenArts.length + ' more'
        + '</div>';
    }

    // Action row — singles get "Queue →" instead of Synthesize
    var actionsHtml = '';
    if (cluster.isCluster) {
      actionsHtml = '<button class="nr-action-primary" data-wire-synthesize="' + esc(tag) + '">Synthesize ↗</button>'
        + '<button class="nr-action-secondary" data-wire-pitch="' + esc(tag) + '">Assign pitch</button>'
        + '<button class="nr-action-danger" data-wire-spike="' + esc(tag) + '">Spike</button>';
    } else {
      actionsHtml = '<button class="nr-action-secondary" data-wire-queue="' + esc(tag) + '">Queue →</button>'
        + '<button class="nr-action-danger" data-wire-spike="' + esc(tag) + '">Spike</button>';
    }

    return '<div class="nr-cluster-card" data-wire-tag="' + esc(tag) + '" data-wire-type="' + (cluster.isCluster ? 'cluster' : 'single') + '">'
      + '<div class="nr-cluster-header">'
      +   '<span class="nr-cluster-type ' + typeCls + '">' + typeLabel + '</span>'
      +   '<span class="nr-cluster-tag">' + esc(tag) + '</span>'
      +   threadPill
      +   '<div class="nr-cluster-stats">' + statsHtml + '</div>'
      + '</div>'
      + '<div class="nr-cluster-sources">' + sourcesHtml + '</div>'
      + '<div class="nr-cluster-actions">' + actionsHtml + '</div>'
      + '</div>';
  }

  // ── Render all cluster cards into #nr-wire-feed ───────────────────────────
  function renderFeed() {
    var feed = document.getElementById('nr-wire-feed');
    if (!feed) return;

    var clusters = state.clusters;
    if (!clusters.length) {
      feed.innerHTML = '<div class="nr-empty">'
        + '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25M16.5 7.5V18a2.25 2.25 0 002.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 002.25 2.25h13.5M6 7.5h3v3H6V7.5z"/></svg>'
        + '<span>No source articles in the wire.</span>'
        + '<button class="nr-add-btn" id="nr-wire-fetch-btn" style="margin-top:8px;">Fetch latest articles</button>'
        + '</div>';
      var fetchBtn = feed.querySelector('#nr-wire-fetch-btn');
      if (fetchBtn) {
        fetchBtn.addEventListener('click', function() {
          fetchBtn.disabled = true;
          fetchBtn.textContent = 'Fetching…';
          apiFetch('/fetch', { method: 'POST' })
            .then(function() {
              showAlert('Fetch triggered — articles will appear shortly.', 'success');
              setTimeout(function() {
                state.loaded.feed = false;
                loadArticles().then(function() {
                  state.clusters.forEach(function(cluster) {
                    if (!cluster.threadName && state.threadsMap[cluster.tag]) {
                      cluster.threadName = state.threadsMap[cluster.tag];
                    }
                  });
                  renderFeed();
                  state.loaded.feed = true;
                }).catch(function() {});
              }, 3000);
            })
            .catch(function(err) {
              showAlert('Fetch failed: ' + err.message, 'error');
              fetchBtn.disabled = false;
              fetchBtn.textContent = 'Fetch latest articles';
            });
        });
      }
      return;
    }

    var html = '';
    clusters.forEach(function (cluster) {
      html += clusterCardHtml(cluster);
    });
    feed.innerHTML = html;

    // Wire up event handlers
    bindFeedEvents(feed);

    // Apply active filter + search after render
    applyFilterAndSearch();
  }

  // ── Bind card-level event handlers (delegation from feed container) ────────
  function bindFeedEvents(feed) {
    feed.addEventListener('click', function (e) {
      var target = e.target;

      // "Show N more" toggle
      if (target.hasAttribute('data-wire-toggle') || target.closest('[data-wire-toggle]')) {
        var toggleEl = target.hasAttribute('data-wire-toggle') ? target : target.closest('[data-wire-toggle]');
        var card     = toggleEl.closest('.nr-cluster-card');
        if (!card) return;
        var hiddenRows = card.querySelector('.nr-wire-hidden-rows');
        if (!hiddenRows) return;
        var isHidden = hiddenRows.style.display === 'none';
        hiddenRows.style.display = isHidden ? '' : 'none';
        var hiddenCount = card.querySelectorAll('.nr-wire-hidden-rows .nr-source-row').length;
        toggleEl.textContent = isHidden ? 'Show less' : 'Show ' + hiddenCount + ' more';
        return;
      }

      // Synthesize button
      var synthBtn = target.closest('[data-wire-synthesize]');
      if (synthBtn) {
        handleSynthesize(synthBtn);
        return;
      }

      // Queue button (singles)
      var queueBtn = target.closest('[data-wire-queue]');
      if (queueBtn) {
        handleQueue(queueBtn);
        return;
      }

      // Assign pitch button
      var pitchBtn = target.closest('[data-wire-pitch]');
      if (pitchBtn) {
        handleAssignPitch(pitchBtn);
        return;
      }

      // Spike button
      var spikeBtn = target.closest('[data-wire-spike]');
      if (spikeBtn) {
        handleSpike(spikeBtn);
        return;
      }
    });
  }

  // ── Action handlers ───────────────────────────────────────────────────────

  function handleSynthesize(btn) {
    var tag = btn.dataset.wireSynthesize || '';
    // Open Maxwell with cluster context — he'll propose the right pitch and writer assignment
    if (window.NRChat && window.NRChat.openMaxwellWithContext) {
      NRChat.openMaxwellWithContext(
        'Synthesize the "' + tag + '" cluster for the newsroom. ' +
        'Review the available sources and recommend the best writer and angle.'
      );
    } else {
      showAlert('Maxwell unavailable — check feature flags.', 'error');
    }
  }

  // Used by both "Assign pitch →" (clusters) and "Queue →" (singles)
  async function createPitchFromCluster(tag, btn, origText) {
    var cluster = state.clusters.find(function (c) { return c.tag === tag; });
    if (!cluster || !cluster.articles.length) {
      showAlert('No articles found for this cluster.', 'error');
      btn.disabled = false;
      btn.textContent = origText;
      return;
    }

    // Resolve editor ID from JWT
    var editorId = null;
    try {
      var token = localStorage.getItem('deepfeedai_token');
      var payload = token ? JSON.parse(atob(token.split('.')[1])) : null;
      editorId = payload ? (payload.sub || payload.id || null) : null;
    } catch (_) {}
    if (!editorId) {
      showAlert('Could not identify editor — please re-login.', 'error');
      btn.disabled = false;
      btn.textContent = origText;
      return;
    }

    try {
      await apiFetch('/pitches', {
        method: 'POST',
        body: JSON.stringify({
          source_article_id:    cluster.articles[0].id,
          angle_summary:        'Cover the "' + tag + '" story — synthesize the available sources into an original article.',
          requested_by_editor_id: editorId,
        }),
      });
      showAlert('Pitch created and added to the queue.', 'success');
      // Refresh the Floor pitch queue if it's active
      if (window.NRFloor && NRFloor.refreshPitches) NRFloor.refreshPitches();
    } catch (err) {
      showAlert('Failed to create pitch: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  function handleQueue(btn) {
    var tag = btn.dataset.wireQueue || '';
    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Creating…';
    createPitchFromCluster(tag, btn, origText);
  }

  function handleAssignPitch(btn) {
    var tag = btn.dataset.wirePitch || '';
    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Creating…';
    createPitchFromCluster(tag, btn, origText);
  }

  async function handleSpike(btn) {
    var tag  = btn.dataset.wireSpike || '';
    var card = btn.closest('.nr-cluster-card');
    if (!card) return;

    var cluster = state.clusters.find(function (c) { return c.tag === tag; });
    var articleIds = cluster ? cluster.articles.map(function (a) { return a.id; }) : [];

    // Immediately hide the card
    card.classList.add('spiked');
    btn.disabled = true;

    if (!articleIds.length) {
      state.clusters = state.clusters.filter(function (c) { return c.tag !== tag; });
      showAlert('Cluster spiked.', 'info');
      return;
    }

    try {
      await Promise.all(articleIds.map(function (id) {
        return apiFetch('/articles/' + id, { method: 'DELETE' });
      }));
      state.clusters = state.clusters.filter(function (c) { return c.tag !== tag; });
      showAlert(
        'Spiked — ' + articleIds.length + ' article' + (articleIds.length !== 1 ? 's' : '') + ' archived.',
        'success'
      );
    } catch (err) {
      card.classList.remove('spiked');
      btn.disabled = false;
      showAlert('Spike failed: ' + err.message, 'error');
    }
  }

  // ── Filter chips ──────────────────────────────────────────────────────────
  function setFilter(filter) {
    state.activeFilter = filter;

    // Update chip active states
    var chips = document.querySelectorAll('#nr-wire-filters .nr-filter-chip');
    chips.forEach(function (chip) {
      chip.classList.toggle('active', chip.dataset.filter === filter);
    });

    applyFilterAndSearch();
  }

  // ── Search ────────────────────────────────────────────────────────────────
  function onSearchInput(e) {
    clearTimeout(state.searchTimer);
    var val = e.target.value;
    state.searchTimer = setTimeout(function () {
      state.searchQuery = val.trim().toLowerCase();
      applyFilterAndSearch();
    }, 250);
  }

  // ── Apply filter + search (client-side, no re-render) ────────────────────
  function applyFilterAndSearch() {
    var cards = document.querySelectorAll('#nr-wire-feed .nr-cluster-card');
    var q     = state.searchQuery;
    var f     = state.activeFilter;

    cards.forEach(function (card) {
      var type    = card.dataset.wireType;   // 'cluster' | 'single'
      var tag     = (card.dataset.wireTag || '').toLowerCase();

      // Filter chip
      var filterPass = true;
      if (f === 'clusters') filterPass = type === 'cluster';
      if (f === 'singles')  filterPass = type === 'single';

      // Search: match tag or any visible title text
      var searchPass = true;
      if (q) {
        var titleText = (card.querySelector('.nr-cluster-sources') || { textContent: '' }).textContent.toLowerCase();
        searchPass = tag.indexOf(q) !== -1 || titleText.indexOf(q) !== -1;
      }

      card.classList.toggle('hidden-card', !(filterPass && searchPass));
    });

    // Show empty state if all cards hidden
    var anyVisible = false;
    cards.forEach(function (c) { if (!c.classList.contains('hidden-card') && !c.classList.contains('spiked')) anyVisible = true; });

    var feed = document.getElementById('nr-wire-feed');
    var emptyEl = feed && feed.querySelector('.nr-wire-no-results');
    if (!anyVisible && cards.length > 0) {
      if (!emptyEl && feed) {
        var div = document.createElement('div');
        div.className = 'nr-empty nr-wire-no-results';
        div.innerHTML = '<span>No clusters match your filters.</span>';
        feed.appendChild(div);
      }
    } else {
      if (emptyEl) emptyEl.remove();
    }
  }

  // ── Pipeline status badge ─────────────────────────────────────────────────
  function renderPipelineStatus(data) {
    var statusEl = document.getElementById('nr-pipeline-status');
    var dotEl    = document.getElementById('nr-pipeline-dot');
    var textEl   = document.getElementById('nr-pipeline-text');
    if (!statusEl || !dotEl || !textEl) return;

    var writers  = (data && data.writers) || [];
    var healthy  = false;
    var readyCount = 0;
    var totalCount = writers.length;

    writers.forEach(function (w) {
      var cooldownActive = w.cooldown && w.cooldown.active;
      var lastOk         = w.lastRun && w.lastRun.status === 'success';
      if (!cooldownActive && lastOk) {
        healthy = true;
        readyCount++;
      }
    });

    if (totalCount === 0) {
      dotEl.className = 'nr-pipeline-dot warn';
      textEl.textContent = 'No writers configured';
    } else if (healthy) {
      dotEl.className = 'nr-pipeline-dot';
      textEl.textContent = readyCount + '/' + totalCount + ' writers ready';
    } else {
      dotEl.className = 'nr-pipeline-dot warn';
      var allCooldown = writers.every(function (w) { return w.cooldown && w.cooldown.active; });
      textEl.textContent = allCooldown ? 'All writers in cooldown' : 'Pipeline needs attention';
    }

    statusEl.style.display = 'flex';
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  async function loadStoryThreads() {
    try {
      var data = await apiFetch('/story-threads?status=active,dormant&limit=30');
      var threads = data.threads || [];
      var map = {};
      threads.forEach(function (t) {
        if (t.topic_tag) map[t.topic_tag] = t.name || t.topic_tag;
      });
      state.threadsMap = map;
    } catch (_) {
      // Non-critical — wire still works without thread names
      state.threadsMap = {};
    }
  }

  async function loadArticles() {
    try {
      var data = await apiFetch('/articles?type=curated&limit=100&offset=0');
      var articles = data.articles || [];
      state.clusters = groupArticles(articles);
    } catch (err) {
      state.clusters = [];
      var feed = document.getElementById('nr-wire-feed');
      if (feed) {
        feed.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load wire: ' + esc(err.message) + '</div>';
      }
      throw err; // re-throw so caller can gate renderFeed
    }
  }

  async function loadPipelineStatus() {
    try {
      var data = await apiFetch('/synthesis/pipeline-overview');
      state.pipelineData = data;
      renderPipelineStatus(data);
    } catch (_) {
      // Pipeline badge is best-effort; don't surface errors
      var statusEl = document.getElementById('nr-pipeline-status');
      if (statusEl) {
        var dotEl  = document.getElementById('nr-pipeline-dot');
        var textEl = document.getElementById('nr-pipeline-text');
        if (dotEl)  dotEl.className = 'nr-pipeline-dot warn';
        if (textEl) textEl.textContent = 'Pipeline unavailable';
        statusEl.style.display = 'flex';
      }
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    var feed = document.getElementById('nr-wire-feed');
    if (feed) feed.innerHTML = '<div class="nr-loading">Loading wire…</div>';

    // ── Filter chip handlers ─────────────────────────────────────────
    var filterContainer = document.getElementById('nr-wire-filters');
    if (filterContainer) {
      filterContainer.addEventListener('click', function (e) {
        var chip = e.target.closest('.nr-filter-chip');
        if (!chip) return;
        var filter = chip.dataset.filter;
        if (filter) setFilter(filter);
      });
    }

    // ── Search handler ───────────────────────────────────────────────
    var searchInput = document.getElementById('nr-wire-search');
    if (searchInput) {
      searchInput.addEventListener('input', onSearchInput);
      // Clear on escape
      searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          searchInput.value = '';
          state.searchQuery = '';
          applyFilterAndSearch();
          searchInput.blur();
        }
      });
    }

    // ── Load articles + story threads in parallel ────────────────────
    try {
      await Promise.all([
        loadArticles(),
        loadStoryThreads(),
      ]);

      // Enrich clusters with thread names (threads loaded in parallel)
      state.clusters.forEach(function (cluster) {
        if (!cluster.threadName && state.threadsMap[cluster.tag]) {
          cluster.threadName = state.threadsMap[cluster.tag];
        }
      });

      renderFeed();
      state.loaded.feed = true;
    } catch (_) {
      // loadArticles already set error state in the feed element
    }

    // ── Pipeline status badge (async, non-blocking) ──────────────────
    loadPipelineStatus();

    // ── Counter badge in tab (optional, best-effort) ─────────────────
    updateWireTabBadge();

    // ── Wire inner-tab switching ─────────────────────────────────────
    var tabBar = document.getElementById('nr-wire-tab-bar');
    if (tabBar) {
      tabBar.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-wire-tab]');
        if (!btn) return;
        var name = btn.dataset.wireTab;
        activateWireTab(name);
      });
    }
  }

  // ── Activate an inner Wire tab ─────────────────────────────────────────────
  function activateWireTab(name) {
    // Swap active class on tab buttons
    var buttons = document.querySelectorAll('#nr-wire-tab-bar [data-wire-tab]');
    buttons.forEach(function (b) {
      b.classList.toggle('active', b.dataset.wireTab === name);
    });

    // Swap active class on panels
    var panels = document.querySelectorAll('.wire-tab-panel');
    panels.forEach(function (p) {
      p.classList.toggle('active', p.id === 'wire-tab-' + name);
    });

    // Lazy-load each tab on first activation
    if (name === 'stories' && !state.loaded.stories) {
      loadAndRenderStories();
    } else if (name === 'discover' && !state.loaded.discover) {
      state.loaded.discover = true; // mark now; search is on-demand
      initDiscoverHandlers();
    } else if (name === 'pipeline' && !state.loaded.pipeline) {
      loadAndRenderPipeline();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature 2 — Stories tab
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadAndRenderStories() {
    var container = document.getElementById('nr-stories-list');
    if (!container) return;
    container.innerHTML = '<div class="nr-loading">Loading stories…</div>';

    try {
      var data = await apiFetch('/story-threads?status=active,dormant&limit=40');
      var threads = (data && data.threads) || [];
      state.loaded.stories = true;

      if (!threads.length) {
        container.innerHTML = '<div class="nr-empty"><span>No active or dormant stories found.</span></div>';
        return;
      }

      var html = '';
      threads.forEach(function (t) {
        var displayName = esc(t.name || t.topic_tag || '—');
        var statusCls   = 'ss-' + esc(t.status || 'unknown');
        var statusLabel = esc(t.status || '');
        var count       = t.article_count != null ? esc(t.article_count) : '0';
        var age         = t.last_activity_at ? esc(relTime(t.last_activity_at)) : '';
        var cat         = t.category ? esc(t.category) : '';
        var tag         = esc(t.topic_tag || '');

        html += '<div class="nr-story-card">'
          + '<div class="nr-story-left">'
          +   '<div class="nr-story-name">' + displayName + '</div>'
          +   '<div class="nr-story-meta">'
          +     '<span>' + count + ' articles</span>'
          +     (age ? '<span>' + age + '</span>' : '')
          +     (cat ? '<span>' + cat + '</span>' : '')
          +   '</div>'
          + '</div>'
          + '<span class="nr-story-status ' + statusCls + '">' + statusLabel + '</span>'
          + '<a href="/story-board.html?tag=' + tag + '" class="nr-row-btn">Board &rarr;</a>'
          + '</div>';
      });

      container.innerHTML = html;
    } catch (err) {
      state.loaded.stories = false;
      container.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load stories: ' + esc(err.message) + '</div>';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature 3 — Discover tab
  // ═══════════════════════════════════════════════════════════════════════════

  function initDiscoverHandlers() {
    var btn   = document.getElementById('nr-discover-btn');
    var input = document.getElementById('nr-discover-query');

    if (btn) {
      btn.addEventListener('click', runDiscover);
    }
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') runDiscover();
      });
    }

    // Source chip toggles (event delegation on the source bar)
    var sourcesBar = document.getElementById('nr-discover-sources');
    if (sourcesBar) {
      sourcesBar.addEventListener('click', function (e) {
        var chip = e.target.closest('[data-src]');
        if (!chip) return;
        chip.classList.toggle('active');
      });
    }

    // Import button delegation on results container
    var results = document.getElementById('nr-discover-results');
    if (results) {
      results.addEventListener('click', function (e) {
        var importBtn = e.target.closest('[data-import-url]');
        if (importBtn) {
          handleDiscoverImport(importBtn);
        }
      });
    }
  }

  async function runDiscover() {
    var input   = document.getElementById('nr-discover-query');
    var results = document.getElementById('nr-discover-results');
    if (!results) return;

    var query = (input && input.value.trim()) || '';

    // Collect active sources
    var activeChips = document.querySelectorAll('#nr-discover-sources [data-src].active');
    var sources = [];
    activeChips.forEach(function (c) { sources.push(c.dataset.src); });

    results.innerHTML = '<div class="nr-loading">Searching…</div>';

    try {
      var qs = '?q=' + encodeURIComponent(query)
        + '&sources=' + encodeURIComponent(sources.join(','))
        + '&period=24h';
      var data = await apiFetch('/admin/discover' + qs);
      var items = (data && data.results) || [];

      if (!items.length) {
        results.innerHTML = '<div class="nr-empty"><span>No results found.</span></div>';
        return;
      }

      var html = '';
      items.forEach(function (item) {
        var imported    = !!item.alreadyImported;
        var importedCls = imported ? ' already-imported' : '';
        var src         = esc(item.sourceName || '');
        var age         = item.publishedAt ? esc(relTime(item.publishedAt)) : '';
        var title       = esc(item.title || '');
        var desc        = esc(item.description || '');
        var url         = esc(item.url || '#');

        html += '<div class="nr-discover-card' + importedCls + '">'
          + '<div class="nr-discover-meta">'
          +   '<span class="nr-discover-source">' + src + '</span>'
          +   (age ? '<span class="nr-discover-age">' + age + '</span>' : '')
          +   (imported ? '<span class="nr-imported-label">already imported</span>' : '')
          + '</div>'
          + '<div class="nr-discover-title">' + title + '</div>'
          + '<div class="nr-discover-desc">' + desc + '</div>'
          + '<div class="nr-discover-actions">'
          +   (!imported
                ? '<button class="nr-action-primary"'
                  + ' data-import-url="' + url + '"'
                  + ' data-import-title="' + esc(item.title || '') + '"'
                  + ' data-import-desc="' + esc(item.description || '') + '"'
                  + ' data-import-source="' + esc(item.sourceName || '') + '"'
                  + '>Import &rarr;</button>'
                : '')
          +   '<a href="' + url + '" target="_blank" class="nr-action-secondary">Source &#x2197;</a>'
          + '</div>'
          + '</div>';
      });

      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Search failed: ' + esc(err.message) + '</div>';
    }
  }

  async function handleDiscoverImport(btn) {
    var url    = btn.dataset.importUrl    || '';
    var title  = btn.dataset.importTitle  || '';
    var desc   = btn.dataset.importDesc   || '';
    var source = btn.dataset.importSource || '';

    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Importing…';

    try {
      await apiFetch('/admin/discover/import', {
        method: 'POST',
        body: JSON.stringify({ articles: [{ url: url, title: title, description: desc, sourceName: source }] }),
      });
      showAlert('Article imported successfully.', 'success');
      // Mark card as already imported
      var card = btn.closest('.nr-discover-card');
      if (card) {
        card.classList.add('already-imported');
        btn.remove();
        // Append label if not already there
        var meta = card.querySelector('.nr-discover-meta');
        if (meta && !meta.querySelector('.nr-imported-label')) {
          var lbl = document.createElement('span');
          lbl.className = 'nr-imported-label';
          lbl.textContent = 'already imported';
          meta.appendChild(lbl);
        }
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = origText;
      showAlert('Import failed: ' + err.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature 4 — Pipeline tab
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadAndRenderPipeline() {
    var container = document.getElementById('nr-pipeline-detail');
    if (!container) return;
    container.innerHTML = '<div class="nr-loading">Loading pipeline…</div>';

    try {
      var data    = await apiFetch('/synthesis/pipeline-overview');
      var writers = (data && data.writers) || [];
      state.loaded.pipeline = true;

      if (!writers.length) {
        container.innerHTML = '<div class="nr-empty"><span>No writers configured.</span></div>';
        return;
      }

      var html = '';
      writers.forEach(function (w) {
        var writer   = w.writer   || {};
        var cooldown = w.cooldown || {};
        var pool     = w.articlePool || {};
        var clusters = w.clusters || [];
        var lastRun  = w.lastRun  || {};

        // Badge logic
        var badgeState, badgeLabel;
        if (lastRun.status === 'failed') {
          badgeState = 'error';
          badgeLabel = 'error';
        } else if (cooldown.active) {
          var hoursLeft = cooldown.threshold != null && cooldown.hoursSinceLastRun != null
            ? Math.max(0, Math.ceil(cooldown.threshold - cooldown.hoursSinceLastRun))
            : '?';
          badgeState = 'cooldown';
          badgeLabel = 'cooldown (' + hoursLeft + 'h)';
        } else {
          badgeState = 'ready';
          badgeLabel = 'ready';
        }

        var writerId   = esc(writer.id   || '');
        var writerName = esc(writer.name || 'Unknown');
        var poolTotal  = pool.total != null ? esc(pool.total) : '0';
        var clusterLen = esc(clusters.length);
        var lastRunAge = lastRun.started_at ? esc(relTime(lastRun.started_at)) : 'never';

        // Top 5 clusters
        var clustersHtml = '';
        clusters.slice(0, 5).forEach(function (c) {
          clustersHtml += '<div class="nr-pipeline-cluster-row">'
            + '<span class="nr-pipeline-cluster-tag">' + esc(c.topic) + '</span>'
            + '<span class="nr-pipeline-cluster-count">' + esc(c.sourceCount) + ' sources</span>'
            + '</div>';
        });

        html += '<div class="nr-pipeline-card">'
          + '<div class="nr-pipeline-card-header">'
          +   '<span class="nr-pipeline-writer-name">' + writerName + '</span>'
          +   '<div class="nr-pipeline-badges">'
          +     '<span class="nr-pipeline-badge pb-' + esc(badgeState) + '">' + esc(badgeLabel) + '</span>'
          +   '</div>'
          +   '<button class="nr-action-primary" data-run-writer="' + writerId + '">Run now &rarr;</button>'
          + '</div>'
          + '<div class="nr-pipeline-stats">'
          +   '<span><strong>' + poolTotal + '</strong> sources</span>'
          +   '<span><strong>' + clusterLen + '</strong> clusters</span>'
          +   '<span>Last run: ' + lastRunAge + '</span>'
          + '</div>'
          + (clustersHtml ? '<div class="nr-pipeline-clusters">' + clustersHtml + '</div>' : '')
          + '</div>';
      });

      container.innerHTML = html;

      // Bind "Run now" buttons via event delegation
      container.addEventListener('click', function (e) {
        var runBtn = e.target.closest('[data-run-writer]');
        if (runBtn) handleRunWriter(runBtn);
      });
    } catch (err) {
      state.loaded.pipeline = false;
      container.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed to load pipeline: ' + esc(err.message) + '</div>';
    }
  }

  async function handleRunWriter(btn) {
    var writerId = btn.dataset.runWriter || '';
    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Running…';

    try {
      await apiFetch('/synthesis/run/' + encodeURIComponent(writerId) + '?force=true', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      showAlert('Synthesis run queued for writer.', 'success');
    } catch (err) {
      showAlert('Run failed: ' + err.message, 'error');
    } finally {
      setTimeout(function () {
        if (btn && btn.parentNode) {
          btn.disabled = false;
          btn.textContent = origText;
        }
      }, 4000);
    }
  }

  // ── Update the Wire tab with cluster count (best-effort) ─────────────────
  function updateWireTabBadge() {
    var clusterCount = state.clusters.filter(function (c) { return c.isCluster; }).length;
    if (!clusterCount) return;
    var tab = document.querySelector('[data-ws="wire"]');
    if (!tab) return;
    // Only add badge if not already there
    if (!tab.querySelector('.nr-wire-badge')) {
      var badge = document.createElement('span');
      badge.className = 'nr-wire-badge';
      badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;'
        + 'min-width:16px;height:16px;border-radius:8px;font-size:9px;font-weight:700;'
        + 'background:var(--accent-dim);color:var(--accent);padding:0 4px;margin-left:5px;vertical-align:middle;';
      badge.textContent = clusterCount;
      tab.appendChild(badge);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.NRWire = { init: init };

})();
