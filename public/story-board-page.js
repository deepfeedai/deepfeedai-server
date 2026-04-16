/* Deep Feed AI Admin — Story Board page */
(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────
  var cy             = null;
  var boardData      = { nodes: [], edges: [], stats: {} };
  var selectedNodeId = null;
  var writers        = [];
  var categories     = [];

  // ── Cytoscape style ─────────────────────────────────────────────────────────
  var CY_STYLE = [
    // ── Default node (source) ─────────────────────────────────────────────────
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
    // ── Original node — thumbnail + accent colour fallback ────────────────────
    {
      selector: 'node.original',
      style: {
        'width': 72,
        'height': 72,
        'shape': 'roundrectangle',
        'background-color': function (n) { return n.data('accentColor') || '#6366f1'; },
        'background-image': function (n) { return n.data('imageUrl') || 'none'; },
        'background-fit': 'cover',
        'background-clip': 'node',
        'background-image-opacity': function (n) { return n.data('imageUrl') ? 1 : 0; },
        'border-color': function (n) { return n.data('accentColor') || '#6366f1'; },
        'border-width': 2,
        'color': '#e5e7eb',
        'font-size': 11,
        'font-weight': 'bold',
        'text-max-width': 140,
        'text-background-color': '#111827',
        'text-background-opacity': 0.75,
        'text-background-padding': '3px',
        'text-background-shape': 'roundrectangle',
      },
    },
    // ── Orphaned original (0 sources) ─────────────────────────────────────────
    {
      selector: 'node.original.orphan',
      style: {
        'border-color': '#ef4444',
        'border-width': 3,
        'border-style': 'dashed',
      },
    },
    // ── Selected ──────────────────────────────────────────────────────────────
    {
      selector: 'node:selected',
      style: {
        'border-color': '#fff',
        'border-width': 3,
      },
    },
    // ── Compound group node ───────────────────────────────────────────────────
    {
      selector: 'node.group-node',
      style: {
        'shape': 'roundrectangle',
        'background-color': 'rgba(255,255,255,0.03)',
        'border-color': 'rgba(255,255,255,0.12)',
        'border-width': 1,
        'border-style': 'dashed',
        'label': 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'font-size': 13,
        'font-weight': 'bold',
        'color': 'rgba(255,255,255,0.45)',
        'padding': '28px',
        'text-margin-y': 6,
        'min-zoomed-font-size': 0,
      },
    },
    // ── Edges ─────────────────────────────────────────────────────────────────
    {
      selector: 'edge',
      style: {
        'width': 1.5,
        'line-color': '#4b5563',
        'target-arrow-color': '#4b5563',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': 0.8,
        'opacity': 0.8,
      },
    },
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

  var COSE_GROUPED_LAYOUT = Object.assign({}, COSE_LAYOUT, {
    nodeRepulsion: function (node) {
      return node.hasClass('group-node') ? 12000 : (node.data('type') === 'original' ? 9000 : 4500);
    },
    idealEdgeLength: function () { return 150; },
    gravity: 0.4,
  });

  // ── Populate filter selects ─────────────────────────────────────────────────
  function populateFilters() {
    var catSel = document.getElementById('sbCategory');
    if (catSel && categories.length) {
      catSel.innerHTML = '<option value="">All</option>'
        + categories.map(function (c) { return '<option value="' + escHtml(c) + '">' + escHtml(c) + '</option>'; }).join('');
    }
    var writerSel = document.getElementById('sbWriter');
    if (writerSel && writers.length) {
      writerSel.innerHTML = '<option value="">All</option>'
        + writers.map(function (w) {
            return '<option value="' + w.id + '">' + escHtml(w.name || 'Writer ' + w.id) + '</option>';
          }).join('');
    }
  }

  // ── Load board data from API ─────────────────────────────────────────────────
  async function loadBoard() {
    showLoading(true);
    closeSidePanel();

    var days       = document.getElementById('sbDays')?.value || '14';
    var category   = document.getElementById('sbCategory')?.value || '';
    var writerId   = document.getElementById('sbWriter')?.value || '';
    var linkedOnly = document.getElementById('sbLinkedOnly')?.checked;

    try {
      var params = new URLSearchParams({ days: days });
      if (category) params.set('category', category);
      if (writerId) params.set('writer_id', writerId);

      var data = await apiFetch('/story-board?' + params.toString());
      boardData = data;

      var nodes = data.nodes;
      var edges = data.edges;

      if (linkedOnly) {
        var connectedSources = new Set();
        edges.forEach(function (e) { connectedSources.add(e.data.target); });
        nodes = nodes.filter(function (n) {
          return n.data.type === 'original' || connectedSources.has(n.id);
        });
      }

      renderBoard(nodes, edges);
      updateStats(data.stats, edges);
    } catch (err) {
      showAlert('Failed to load story board: ' + (err.message || err), 'error');
    } finally {
      showLoading(false);
    }
  }

  // ── Render board ─────────────────────────────────────────────────────────────
  function renderBoard(nodes, edges) {
    var container = document.getElementById('cy');
    if (!container) return;

    var placeholder = container.querySelector('.sb-empty');
    if (placeholder) placeholder.remove();

    if (!nodes.length) {
      if (cy) { cy.destroy(); cy = null; }
      container.innerHTML = '<div class="sb-empty"><div style="font-size:36px;margin-bottom:12px;">📋</div><div>No originals found for this period.</div><div style="font-size:12px;margin-top:6px;">Try a longer time window or different filters.</div></div>';
      return;
    }

    var groupBy = document.getElementById('sbGroupBy')?.value || '';

    // Which originals have at least one edge?
    var originalsWithEdges = new Set();
    edges.forEach(function (e) { originalsWithEdges.add(e.data.source); });

    // ── Build elements ────────────────────────────────────────────────────────
    var elements = [];
    var groupIds = new Set();

    nodes.forEach(function (n) {
      var isOriginal = n.data.type === 'original';
      var parentId   = null;

      if (isOriginal && groupBy) {
        var groupKey = groupBy === 'writer'
          ? (n.data.writerName || 'Unassigned')
          : (n.data.category || 'Uncategorized');
        parentId = 'grp_' + groupKey;

        if (!groupIds.has(parentId)) {
          groupIds.add(parentId);
          elements.push({
            group: 'nodes',
            data: { id: parentId, label: groupKey, type: 'group' },
            classes: 'group-node',
          });
        }
      }

      var classes = isOriginal ? 'original' : 'source';
      var hasEdge  = originalsWithEdges.has(n.id);
      if (isOriginal && !hasEdge) classes += ' orphan';

      var elData = Object.assign({ id: n.id, label: truncate(n.data.title, 28) }, n.data);
      if (parentId) elData.parent = parentId;

      elements.push({ group: 'nodes', data: elData, classes: classes });
    });

    edges.forEach(function (e) {
      elements.push({
        group: 'edges',
        data: Object.assign({ id: e.id }, e.data),
        classes: e.data.linkType === 'manual' ? 'manual' : 'auto',
      });
    });

    var layout = groupBy ? COSE_GROUPED_LAYOUT : COSE_LAYOUT;

    if (cy) {
      cy.elements().remove();
      cy.add(elements);
      cy.layout(layout).run();
    } else {
      cy = cytoscape({
        container: container,
        elements: elements,
        style: CY_STYLE,
        layout: layout,
        minZoom: 0.1,
        maxZoom: 4,
      });

      cy.on('tap', 'node', function (evt) {
        var node = evt.target;
        if (node.hasClass('group-node')) return; // ignore taps on group containers
        selectedNodeId = node.id();
        openSidePanel(node.data());
      });

      cy.on('tap', function (evt) {
        if (evt.target === cy) closeSidePanel();
      });
    }
  }

  // ── Side panel ───────────────────────────────────────────────────────────────
  function openSidePanel(data) {
    var panel = document.getElementById('sbPanel');
    var title = document.getElementById('sbPanelTitle');
    var body  = document.getElementById('sbPanelBody');
    if (!panel || !title || !body) return;

    panel.classList.remove('sb-panel-hidden');
    title.textContent = truncate(data.title, 42);

    if (data.type === 'original') {
      renderOriginalPanel(data, body);
    } else {
      renderSourcePanel(data, body);
    }
  }

  function closeSidePanel() {
    var panel = document.getElementById('sbPanel');
    if (panel) panel.classList.add('sb-panel-hidden');
    selectedNodeId = null;
  }

  function renderOriginalPanel(data, body) {
    var linkedEdges = boardData.edges.filter(function (e) {
      return e.data.source === 'a_' + data.articleId;
    });
    var sourceCount = linkedEdges.length;

    var html = '';

    // Thumbnail
    if (data.imageUrl) {
      html += '<img class="sb-panel-image" src="' + escHtml(data.imageUrl) + '" alt="" />';
    }

    // Writer avatar + name
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

    // Meta row: content type, category, score, date
    html += '<div class="sb-panel-meta-row">';
    html += '<span class="badge sb-type-original">' + escHtml(data.contentType || 'original') + '</span>';
    if (data.category) html += '<span class="badge badge-muted">' + escHtml(data.category) + '</span>';
    if (data.editorialScore != null) {
      var scoreClass = data.editorialScore >= 7 ? 'sb-score-high' : data.editorialScore >= 5 ? 'sb-score-mid' : 'sb-score-low';
      html += '<span class="sb-score-badge ' + scoreClass + '">Score ' + data.editorialScore + '</span>';
    }
    html += '</div>';

    // Published date + source count
    html += '<div class="sb-panel-meta-row">';
    if (data.publishedAt) html += '<span>📅 ' + escHtml(fmtDatetime(data.publishedAt)) + '</span>';
    html += '<span>🔗 ' + sourceCount + ' source' + (sourceCount === 1 ? '' : 's') + '</span>';
    if (sourceCount === 0) html += '<span class="sb-orphan-warn">No sources</span>';
    html += '</div>';

    // Summary
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
    if (data.source) html += '<span class="badge badge-muted">' + escHtml(data.source) + '</span>';
    html += '</div>';

    html += '<div class="sb-panel-meta-row">';
    if (data.publishedAt) html += '<span>📅 ' + escHtml(fmtDatetime(data.publishedAt)) + '</span>';
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

  // ── Link picker ──────────────────────────────────────────────────────────────
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
    var originalsWithEdges = new Set(edges.map(function (e) { return e.data.source; }));
    var orphans = stats.originals - originalsWithEdges.size;
    var orphanStr = orphans > 0 ? ' · ⚠ ' + orphans + ' unsourced' : '';
    el.textContent = stats.originals + ' originals · ' + stats.sources + ' sources · ' + stats.edges + ' connections' + orphanStr;
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function fmtDatetime(d) {
    if (!d) return '';
    try {
      var dt = new Date(d);
      return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return ''; }
  }

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Event listeners ──────────────────────────────────────────────────────────
  document.getElementById('sbRefreshBtn')?.addEventListener('click', loadBoard);
  document.getElementById('sbPanelClose')?.addEventListener('click', closeSidePanel);
  document.getElementById('sbDays')?.addEventListener('change', loadBoard);
  document.getElementById('sbCategory')?.addEventListener('change', loadBoard);
  document.getElementById('sbWriter')?.addEventListener('change', loadBoard);
  document.getElementById('sbGroupBy')?.addEventListener('change', function () {
    // Re-render from cached data — no new fetch needed
    var linked = document.getElementById('sbLinkedOnly')?.checked;
    var nodes  = boardData.nodes;
    var edges  = boardData.edges;
    if (linked) {
      var connected = new Set(edges.map(function (e) { return e.data.target; }));
      nodes = nodes.filter(function (n) {
        return n.data.type === 'original' || connected.has(n.id);
      });
    }
    renderBoard(nodes, edges);
  });
  document.getElementById('sbLinkedOnly')?.addEventListener('change', function () {
    var linked = this.checked;
    var nodes  = boardData.nodes;
    var edges  = boardData.edges;
    if (linked) {
      var connected = new Set(edges.map(function (e) { return e.data.target; }));
      nodes = nodes.filter(function (n) {
        return n.data.type === 'original' || connected.has(n.id);
      });
    }
    renderBoard(nodes, edges);
  });

  // Zoom controls
  document.getElementById('sbFitBtn')?.addEventListener('click', function () {
    if (cy) cy.fit(undefined, 40);
  });
  document.getElementById('sbZoomInBtn')?.addEventListener('click', function () {
    if (cy) cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  });
  document.getElementById('sbZoomOutBtn')?.addEventListener('click', function () {
    if (cy) cy.zoom({ level: cy.zoom() * 0.77, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  });

  // ── Init ─────────────────────────────────────────────────────────────────────
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
