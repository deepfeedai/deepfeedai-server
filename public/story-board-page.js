/* Deep Feed AI Admin — Story Board page */
(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────
  var cy             = null;
  var boardData      = { nodes: [], edges: [], stats: {} };
  var selectedNodeId = null;
  var writers        = [];
  var categories     = [];

  // ── Group colour palette ─────────────────────────────────────────────────────
  var GROUP_PALETTE = [
    '#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6',
    '#8b5cf6','#ef4444','#14b8a6','#f97316','#84cc16',
  ];
  var _groupColorCache = {};
  var _groupColorIdx   = 0;

  function groupColor(key) {
    if (!_groupColorCache[key]) {
      _groupColorCache[key] = GROUP_PALETTE[_groupColorIdx % GROUP_PALETTE.length];
      _groupColorIdx++;
    }
    return _groupColorCache[key];
  }

  function resetGroupColors() {
    _groupColorCache = {};
    _groupColorIdx   = 0;
  }

  // ── Cytoscape base style ─────────────────────────────────────────────────────
  var CY_STYLE = [
    // Source node
    {
      selector: 'node',
      style: {
        'width': 32,
        'height': 32,
        'background-color': '#374151',
        'border-color': '#4b5563',
        'border-width': 1,
        'label': 'data(label)',
        'font-size': 10,
        'color': '#9ca3af',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-max-width': 100,
        'text-wrap': 'ellipsis',
        'text-overflow-wrap': 'anywhere',
        'min-zoomed-font-size': 8,
      },
    },
    // Original node — solid colour (canvas CORS blocks R2 images; thumbnails shown in side panel)
    {
      selector: 'node.original',
      style: {
        'width': 72,
        'height': 72,
        'shape': 'roundrectangle',
        'background-color': function (n) { return n.data('nodeColor') || n.data('accentColor') || '#6366f1'; },
        'border-color': function (n) { return n.data('nodeColor') || n.data('accentColor') || '#6366f1'; },
        'border-width': 3,
        'color': '#e5e7eb',
        'font-size': 11,
        'font-weight': 'bold',
        'text-max-width': 140,
        'text-background-color': '#111827',
        'text-background-opacity': 0.8,
        'text-background-padding': '3px',
        'text-background-shape': 'roundrectangle',
      },
    },
    // Orphan — dashed red border
    {
      selector: 'node.original.orphan',
      style: {
        'border-color': '#ef4444',
        'border-width': 3,
        'border-style': 'dashed',
      },
    },
    // Selected
    {
      selector: 'node:selected',
      style: {
        'border-color': '#ffffff',
        'border-width': 3,
        'border-style': 'solid',
      },
    },
    // Auto edge
    {
      selector: 'edge',
      style: {
        'width': 1.5,
        'line-color': '#4b5563',
        'target-arrow-color': '#4b5563',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': 0.8,
        'opacity': 0.75,
      },
    },
    // Manual edge
    {
      selector: 'edge.manual',
      style: {
        'width': 2,
        'line-color': '#00d9ff',
        'target-arrow-color': '#00d9ff',
        'line-style': 'dashed',
        'line-dash-pattern': [6, 3],
        'opacity': 1,
      },
    },
  ];

  // ── Layout ──────────────────────────────────────────────────────────────────
  var COSE_LAYOUT = {
    name: 'cose',
    animate: false,
    numIter: 600,
    nodeRepulsion: function (node) {
      return node.data('type') === 'original' ? 9000 : 4500;
    },
    idealEdgeLength: function () { return 130; },
    nodeOverlap: 24,
    gravity: 0.25,
    padding: 40,
    randomize: true,
  };

  // ── Populate filter selects ─────────────────────────────────────────────────
  function populateFilters() {
    var catSel = document.getElementById('sbCategory');
    if (catSel && categories.length) {
      catSel.innerHTML = '<option value="">All</option>'
        + categories.map(function (c) {
            return '<option value="' + escHtml(c) + '">' + escHtml(c) + '</option>';
          }).join('');
    }
    var writerSel = document.getElementById('sbWriter');
    if (writerSel && writers.length) {
      writerSel.innerHTML = '<option value="">All</option>'
        + writers.map(function (w) {
            return '<option value="' + w.id + '">' + escHtml(w.name || 'Writer ' + w.id) + '</option>';
          }).join('');
    }
  }

  // ── Load board ──────────────────────────────────────────────────────────────
  async function loadBoard() {
    showLoading(true);
    closeSidePanel();
    resetGroupColors();

    var days       = document.getElementById('sbDays')?.value || '14';
    var category   = document.getElementById('sbCategory')?.value || '';
    var writerId   = document.getElementById('sbWriter')?.value || '';
    var linkedOnly = document.getElementById('sbLinkedOnly')?.checked;

    try {
      var params = new URLSearchParams({ days: days });
      if (category) params.set('category', category);
      if (writerId)  params.set('writer_id', writerId);

      var data = await apiFetch('/story-board?' + params.toString());
      boardData = data;

      applyFiltersAndRender(linkedOnly);
      updateStats(data.stats, data.edges);
    } catch (err) {
      showAlert('Failed to load story board: ' + (err.message || err), 'error');
    } finally {
      showLoading(false);
    }
  }

  function applyFiltersAndRender(linkedOnly) {
    var nodes = boardData.nodes;
    var edges = boardData.edges;

    if (linkedOnly) {
      var connected = new Set(edges.map(function (e) { return e.data.target; }));
      nodes = nodes.filter(function (n) {
        return n.data.type === 'original' || connected.has(n.id);
      });
    }

    renderBoard(nodes, edges);
  }

  // ── Render board ────────────────────────────────────────────────────────────
  function renderBoard(nodes, edges) {
    var container = document.getElementById('cy');
    if (!container) return;

    if (!nodes.length) {
      if (cy) { cy.destroy(); cy = null; }
      container.innerHTML = '<div class="sb-empty"><div style="font-size:36px;margin-bottom:12px;">📋</div><div>No originals found for this period.</div><div style="font-size:12px;margin-top:6px;">Try a longer time window or different filters.</div></div>';
      hideLegend();
      return;
    }
    // Clear any placeholder
    var ph = container.querySelector('.sb-empty');
    if (ph) ph.remove();

    var groupBy = document.getElementById('sbGroupBy')?.value || '';

    // Which originals have edges?
    var originalsWithEdges = new Set(edges.map(function (e) { return e.data.source; }));

    // Build colour map for group-by mode
    var groupColorMap = {};
    if (groupBy) {
      nodes.forEach(function (n) {
        if (n.data.type !== 'original') return;
        var key = groupBy === 'writer'
          ? (n.data.writerName || 'Unassigned')
          : (n.data.category   || 'Uncategorized');
        if (!groupColorMap[key]) groupColorMap[key] = groupColor(key);
      });
    }

    // Build elements — no compound nodes
    var elements = nodes.map(function (n) {
      var isOriginal = n.data.type === 'original';
      var classes    = isOriginal ? 'original' : 'source';
      if (isOriginal && !originalsWithEdges.has(n.id)) classes += ' orphan';

      // In group-by mode, override border/bg colour with group colour
      var nodeColor = null;
      if (isOriginal && groupBy) {
        var key = groupBy === 'writer'
          ? (n.data.writerName || 'Unassigned')
          : (n.data.category   || 'Uncategorized');
        nodeColor = groupColorMap[key];
      }

      return {
        group: 'nodes',
        data: Object.assign(
          { id: n.id, label: truncate(n.data.title, 28), nodeColor: nodeColor },
          n.data
        ),
        classes: classes,
      };
    }).concat(edges.map(function (e) {
      return {
        group: 'edges',
        data: Object.assign({ id: e.id }, e.data),
        classes: e.data.linkType === 'manual' ? 'manual' : 'auto',
      };
    }));

    if (cy) {
      cy.elements().remove();
      cy.add(elements);
      cy.layout(COSE_LAYOUT).run();
    } else {
      cy = cytoscape({
        container: container,
        elements: elements,
        style: CY_STYLE,
        layout: COSE_LAYOUT,
        minZoom: 0.1,
        maxZoom: 4,
      });

      cy.on('tap', 'node', function (evt) {
        selectedNodeId = evt.target.id();
        openSidePanel(evt.target.data());
      });

      cy.on('tap', function (evt) {
        if (evt.target === cy) closeSidePanel();
      });
    }

    renderLegend(groupBy, groupColorMap);
  }

  // ── Legend ──────────────────────────────────────────────────────────────────
  function renderLegend(groupBy, colorMap) {
    var legend = document.getElementById('sbLegend');
    var title  = document.getElementById('sbLegendTitle');
    var items  = document.getElementById('sbLegendItems');
    if (!legend || !title || !items) return;

    if (!groupBy || !Object.keys(colorMap).length) {
      legend.style.display = 'none';
      return;
    }

    title.textContent = groupBy === 'writer' ? 'Writers' : 'Categories';
    items.innerHTML = Object.entries(colorMap).map(function (entry) {
      return '<div class="sb-legend-item">'
        + '<div class="sb-legend-swatch" style="background:' + entry[1] + ';"></div>'
        + '<span>' + escHtml(entry[0]) + '</span>'
        + '</div>';
    }).join('');
    legend.style.display = 'block';
  }

  function hideLegend() {
    var legend = document.getElementById('sbLegend');
    if (legend) legend.style.display = 'none';
  }

  // ── Side panel ──────────────────────────────────────────────────────────────
  function openSidePanel(data) {
    var panel = document.getElementById('sbPanel');
    var title = document.getElementById('sbPanelTitle');
    var body  = document.getElementById('sbPanelBody');
    if (!panel || !title || !body) return;

    // Slide in — remove hidden class and ensure transform is clear
    panel.classList.remove('sb-panel-hidden');
    panel.style.transform = 'translateX(0)';
    title.textContent = truncate(data.title, 42);

    if (data.type === 'original') {
      renderOriginalPanel(data, body);
    } else {
      renderSourcePanel(data, body);
    }
  }

  function closeSidePanel() {
    var panel = document.getElementById('sbPanel');
    if (panel) {
      panel.classList.add('sb-panel-hidden');
      panel.style.transform = '';
    }
    selectedNodeId = null;
  }

  function renderOriginalPanel(data, body) {
    var linkedEdges = boardData.edges.filter(function (e) {
      return e.data.source === 'a_' + data.articleId;
    });
    var sourceCount = linkedEdges.length;
    var html = '';

    if (data.imageUrl) {
      html += '<img class="sb-panel-image" src="' + escHtml(data.imageUrl) + '" alt="" />';
    }

    // Writer
    if (data.writerName) {
      html += '<div class="sb-panel-writer">';
      if (data.writerAvatar) {
        html += '<img class="sb-panel-writer-avatar" src="' + escHtml(data.writerAvatar) + '" alt="" />';
      } else {
        html += '<div class="sb-panel-writer-avatar" style="display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:var(--muted);">'
          + escHtml((data.writerName || '?')[0].toUpperCase()) + '</div>';
      }
      html += '<span class="sb-panel-writer-name">' + escHtml(data.writerName) + '</span>';
      html += '</div>';
    }

    // Meta row 1 — type, category, score
    html += '<div class="sb-panel-meta-row">';
    html += '<span class="badge sb-type-original">' + escHtml(data.contentType || 'original') + '</span>';
    if (data.category) html += '<span class="badge badge-muted">' + escHtml(data.category) + '</span>';
    if (data.editorialScore != null) {
      var sc = data.editorialScore;
      var scoreClass = sc >= 7 ? 'sb-score-high' : sc >= 5 ? 'sb-score-mid' : 'sb-score-low';
      html += '<span class="sb-score-badge ' + scoreClass + '">Score ' + sc + '</span>';
    }
    html += '</div>';

    // Meta row 2 — date, source count, orphan warning
    html += '<div class="sb-panel-meta-row">';
    if (data.publishedAt) html += '<span>📅 ' + escHtml(fmtDate(data.publishedAt)) + '</span>';
    html += '<span>🔗 ' + sourceCount + ' source' + (sourceCount === 1 ? '' : 's') + '</span>';
    if (sourceCount === 0) html += '<span class="sb-orphan-warn">No sources</span>';
    html += '</div>';

    if (data.summary) {
      html += '<p class="sb-panel-summary">' + escHtml(data.summary).slice(0, 280) + (data.summary.length > 280 ? '…' : '') + '</p>';
    }

    html += '<a class="sb-panel-view-link" href="/articles.html?id=' + data.articleId + '" target="_blank">View in Articles →</a>';

    // Source list
    html += '<div class="sb-section-title" style="margin-top:6px;">Sources</div>';
    html += '<div class="sb-source-list" id="sbSourceList">';
    if (sourceCount === 0) {
      html += '<div style="font-size:12px;color:var(--muted);">No linked sources.</div>';
    } else {
      linkedEdges.forEach(function (e) {
        var srcNode = boardData.nodes.find(function (n) { return n.id === e.data.target; });
        if (!srcNode) return;
        var linkType   = e.data.linkType;
        var badgeClass = linkType === 'manual' ? 'sb-edge-manual' : 'sb-edge-auto';
        var removeBtn  = linkType === 'manual' && e.data.linkId
          ? '<button class="sb-source-item-remove" onclick="sbRemoveLink(' + e.data.linkId + ',' + data.articleId + ')" title="Remove link">✕</button>'
          : '';
        html += '<div class="sb-source-item">'
          + '<span class="badge ' + badgeClass + '" style="flex-shrink:0;">' + escHtml(linkType) + '</span>'
          + '<span class="sb-source-item-title" title="' + escHtml(srcNode.data.title) + '">' + escHtml(truncate(srcNode.data.title, 38)) + '</span>'
          + removeBtn
          + '</div>';
      });
    }
    html += '</div>';
    html += '<button class="sb-link-add-btn" id="sbAddLinkBtn" onclick="sbOpenLinkPicker(' + data.articleId + ')">+ Link source</button>';
    html += '<div id="sbLinkPicker" style="display:none;"></div>';

    body.innerHTML = html;
  }

  function renderSourcePanel(data, body) {
    var usedByEdges = boardData.edges.filter(function (e) {
      return e.data.target === 'a_' + data.articleId;
    });
    var html = '';

    if (data.imageUrl) {
      html += '<img class="sb-panel-image" src="' + escHtml(data.imageUrl) + '" alt="" />';
    }

    html += '<div class="sb-panel-badges">';
    html += '<span class="badge sb-type-source">source</span>';
    if (data.category) html += '<span class="badge badge-muted">' + escHtml(data.category) + '</span>';
    if (data.source)   html += '<span class="badge badge-muted">' + escHtml(data.source) + '</span>';
    html += '</div>';

    html += '<div class="sb-panel-meta-row">';
    if (data.publishedAt) html += '<span>📅 ' + escHtml(fmtDate(data.publishedAt)) + '</span>';
    html += '<span>📰 used by ' + usedByEdges.length + ' original' + (usedByEdges.length === 1 ? '' : 's') + '</span>';
    html += '</div>';

    if (data.summary) {
      html += '<p class="sb-panel-summary">' + escHtml(data.summary).slice(0, 280) + (data.summary.length > 280 ? '…' : '') + '</p>';
    }
    if (data.sourceUrl) {
      html += '<a class="sb-panel-view-link" href="' + escHtml(data.sourceUrl) + '" target="_blank" rel="noopener">View source →</a>';
    }

    html += '<div class="sb-section-title">Used by originals</div>';
    html += '<div class="sb-used-by-list">';
    if (usedByEdges.length === 0) {
      html += '<div style="font-size:12px;color:var(--muted);">Not linked to any originals.</div>';
    } else {
      usedByEdges.forEach(function (e) {
        var origNode = boardData.nodes.find(function (n) { return n.id === e.data.source; });
        if (!origNode) return;
        html += '<div class="sb-used-by-item" onclick="sbFocusNode(\'' + origNode.id + '\')">'
          + escHtml(truncate(origNode.data.title, 48))
          + '</div>';
      });
    }
    html += '</div>';
    body.innerHTML = html;
  }

  // ── Link picker ─────────────────────────────────────────────────────────────
  var _pickerDebounce = null;

  window.sbOpenLinkPicker = function (originalId) {
    var picker = document.getElementById('sbLinkPicker');
    if (!picker) return;
    picker.style.display = '';
    picker.innerHTML = '<div class="sb-link-picker">'
      + '<input class="sb-link-picker-input" id="sbPickerInput" type="text" placeholder="Search articles…" autocomplete="off" />'
      + '<div id="sbPickerResults"><div class="sb-link-picker-empty">Type to search…</div></div>'
      + '</div>';

    var input = document.getElementById('sbPickerInput');
    if (input) {
      input.focus();
      input.addEventListener('input', function () {
        clearTimeout(_pickerDebounce);
        _pickerDebounce = setTimeout(function () {
          sbPickerSearch(input.value.trim(), originalId);
        }, 300);
      });
    }
  };

  async function sbPickerSearch(q, originalId) {
    var results = document.getElementById('sbPickerResults');
    if (!results) return;
    if (q.length < 2) {
      results.innerHTML = '<div class="sb-link-picker-empty">Type to search…</div>';
      return;
    }
    results.innerHTML = '<div class="sb-link-picker-empty">Searching…</div>';
    try {
      var data = await apiFetch('/story-board/search?q=' + encodeURIComponent(q));
      if (!data.length) {
        results.innerHTML = '<div class="sb-link-picker-empty">No results.</div>';
        return;
      }
      results.innerHTML = data.map(function (a) {
        return '<div class="sb-link-result-item" onclick="sbAddLink(' + originalId + ',' + a.id + ')">'
          + '<div class="sb-link-result-title">' + escHtml(a.title) + '</div>'
          + '<div class="sb-link-result-meta">' + escHtml(a.category || '') + (a.source ? ' · ' + escHtml(a.source) : '') + '</div>'
          + '</div>';
      }).join('');
    } catch {
      results.innerHTML = '<div class="sb-link-picker-empty" style="color:var(--danger);">Search failed.</div>';
    }
  }

  window.sbAddLink = async function (originalId, sourceId) {
    try {
      await apiFetch('/story-board/links', {
        method: 'POST',
        body: JSON.stringify({ original_article_id: originalId, source_article_id: sourceId }),
      });
      await loadBoard();
      var origNode = boardData.nodes.find(function (n) { return n.data.articleId === originalId; });
      if (origNode) openSidePanel(origNode.data);
    } catch (err) {
      showAlert('Failed to add link: ' + (err.message || err), 'error');
    }
  };

  window.sbRemoveLink = async function (linkId, originalId) {
    if (!confirm('Remove this source link?')) return;
    try {
      await apiFetch('/story-board/links/' + linkId, { method: 'DELETE' });
      await loadBoard();
      var origNode = boardData.nodes.find(function (n) { return n.data.articleId === originalId; });
      if (origNode) openSidePanel(origNode.data);
    } catch (err) {
      showAlert('Failed to remove link: ' + (err.message || err), 'error');
    }
  };

  window.sbFocusNode = function (nodeId) {
    if (!cy) return;
    var node = cy.getElementById(nodeId);
    if (!node || !node.length) return;
    cy.animate({ fit: { eles: node, padding: 80 }, duration: 400 });
    node.select();
    openSidePanel(node.data());
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function showLoading(show) {
    var el = document.getElementById('sbLoading');
    if (el) el.style.display = show ? '' : 'none';
  }

  function updateStats(stats, edges) {
    var el = document.getElementById('sbStats');
    if (!el || !stats) return;
    var withEdges = new Set((edges || []).map(function (e) { return e.data.source; }));
    var orphans   = stats.originals - withEdges.size;
    var orphanStr = orphans > 0 ? ' · ⚠ ' + orphans + ' unsourced' : '';
    el.textContent = stats.originals + ' originals · ' + stats.sources + ' sources · ' + stats.edges + ' connections' + orphanStr;
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function fmtDate(d) {
    if (!d) return '';
    try { return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return ''; }
  }

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Event listeners ─────────────────────────────────────────────────────────
  document.getElementById('sbRefreshBtn')?.addEventListener('click', loadBoard);
  document.getElementById('sbPanelClose')?.addEventListener('click', closeSidePanel);
  document.getElementById('sbDays')?.addEventListener('change', loadBoard);
  document.getElementById('sbCategory')?.addEventListener('change', loadBoard);
  document.getElementById('sbWriter')?.addEventListener('change', loadBoard);

  document.getElementById('sbGroupBy')?.addEventListener('change', function () {
    resetGroupColors();
    applyFiltersAndRender(document.getElementById('sbLinkedOnly')?.checked);
  });

  document.getElementById('sbLinkedOnly')?.addEventListener('change', function () {
    applyFiltersAndRender(this.checked);
  });

  // Zoom controls
  document.getElementById('sbFitBtn')?.addEventListener('click', function () {
    if (cy) cy.fit(cy.elements(), 40);
  });
  document.getElementById('sbZoomInBtn')?.addEventListener('click', function () {
    if (!cy) return;
    var center = { x: cy.width() / 2, y: cy.height() / 2 };
    cy.zoom({ level: Math.min(cy.zoom() * 1.3, cy.maxZoom()), renderedPosition: center });
  });
  document.getElementById('sbZoomOutBtn')?.addEventListener('click', function () {
    if (!cy) return;
    var center = { x: cy.width() / 2, y: cy.height() / 2 };
    cy.zoom({ level: Math.max(cy.zoom() * 0.77, cy.minZoom()), renderedPosition: center });
  });

  // ── Init ────────────────────────────────────────────────────────────────────
  onReady(async function () {
    if (!requireAuth()) return;
    renderSidebar();

    if (typeof loadCategories === 'function') {
      try { await loadCategories(); } catch { /* best-effort */ }
    }
    categories = window._siteCategories || [];

    try {
      var writerData = await apiFetch('/writers?limit=100');
      writers = Array.isArray(writerData) ? writerData : (writerData.writers || []);
    } catch { /* best-effort */ }

    populateFilters();
    loadBoard();
  });
})();
