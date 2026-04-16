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
    {
      selector: 'node.original',
      style: {
        'width': 64,
        'height': 64,
        'background-color': function (node) { return node.data('accentColor') || '#6366f1'; },
        'border-color': function (node) { return node.data('accentColor') || '#6366f1'; },
        'border-width': 2,
        'color': '#e5e7eb',
        'font-size': 11,
        'font-weight': 'bold',
        'text-max-width': 120,
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': '#fff',
        'border-width': 3,
      },
    },
    {
      selector: 'edge',
      style: {
        'width': 1.5,
        'line-color': '#444',
        'target-arrow-color': '#444',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': 0.8,
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
      },
    },
  ];

  // ── Layout ──────────────────────────────────────────────────────────────────
  var COSE_LAYOUT = {
    name: 'cose',
    animate: false,
    numIter: 600,
    nodeRepulsion: function (node) {
      return node.data('type') === 'original' ? 8000 : 4000;
    },
    idealEdgeLength: function () { return 120; },
    nodeOverlap: 20,
    gravity: 0.25,
    padding: 40,
  };

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

    var days      = document.getElementById('sbDays')?.value || '14';
    var category  = document.getElementById('sbCategory')?.value || '';
    var writerId  = document.getElementById('sbWriter')?.value || '';
    var linkedOnly = document.getElementById('sbLinkedOnly')?.checked;

    try {
      var params = new URLSearchParams({ days: days });
      if (category) params.set('category', category);
      if (writerId) params.set('writer_id', writerId);

      var data = await apiFetch('/story-board?' + params.toString());
      boardData = data;

      var nodes = data.nodes;
      var edges = data.edges;

      // Client-side linked-only filter: keep only source nodes connected by at least one edge
      if (linkedOnly) {
        var connectedSources = new Set();
        edges.forEach(function (e) { connectedSources.add(e.data.target); });
        nodes = nodes.filter(function (n) {
          return n.data.type === 'original' || connectedSources.has(n.id);
        });
      }

      renderBoard(nodes, edges);
      updateStats(data.stats);
    } catch (err) {
      showAlert('Failed to load story board: ' + (err.message || err), 'error');
    } finally {
      showLoading(false);
    }
  }

  // ── Render board (init or refresh Cytoscape) ─────────────────────────────────
  function renderBoard(nodes, edges) {
    var container = document.getElementById('cy');
    if (!container) return;

    // Remove empty placeholder
    var placeholder = container.querySelector('.sb-empty');
    if (placeholder) placeholder.remove();

    if (!nodes.length) {
      if (cy) { cy.destroy(); cy = null; }
      container.innerHTML = '<div class="sb-empty"><div style="font-size:36px;margin-bottom:12px;">📋</div><div>No originals found for this period.</div><div style="font-size:12px;margin-top:6px;">Try a longer time window or different filters.</div></div>';
      return;
    }

    var elements = nodes.map(function (n) {
      return {
        group: 'nodes',
        data: Object.assign({ id: n.id, label: truncate(n.data.title, 28) }, n.data),
        classes: n.data.type === 'original' ? 'original' : 'source',
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
        minZoom: 0.15,
        maxZoom: 4,
      });

      cy.on('tap', 'node', function (evt) {
        var node = evt.target;
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
    title.textContent = truncate(data.title, 40);

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
    var html = '';

    if (data.imageUrl) {
      html += '<img class="sb-panel-image" src="' + escHtml(data.imageUrl) + '" alt="" />';
    }

    html += '<div class="sb-panel-badges">';
    if (data.type) html += '<span class="badge sb-type-original">' + escHtml(data.contentType || 'original') + '</span>';
    if (data.category) html += '<span class="badge badge-muted">' + escHtml(data.category) + '</span>';
    if (data.writerName) html += '<span class="badge badge-muted">✍ ' + escHtml(data.writerName) + '</span>';
    html += '</div>';

    if (data.summary) {
      html += '<p class="sb-panel-summary">' + escHtml(data.summary).slice(0, 220) + (data.summary.length > 220 ? '…' : '') + '</p>';
    }

    html += '<a class="sb-panel-view-link" href="/articles.html?id=' + data.articleId + '" target="_blank">View in Articles →</a>';

    // Source list
    var linkedEdges = boardData.edges.filter(function (e) {
      return e.data.source === 'a_' + data.articleId;
    });

    html += '<div class="sb-section-title">Sources (' + linkedEdges.length + ')</div>';
    html += '<div class="sb-source-list" id="sbSourceList">';

    if (linkedEdges.length === 0) {
      html += '<div style="font-size:12px;color:var(--muted);">No linked sources.</div>';
    } else {
      linkedEdges.forEach(function (e) {
        var srcNodeId = e.data.target;
        var srcNode = boardData.nodes.find(function (n) { return n.id === srcNodeId; });
        if (!srcNode) return;
        var linkType = e.data.linkType;
        var badgeClass = linkType === 'manual' ? 'sb-edge-manual' : 'sb-edge-auto';
        var removeBtn = linkType === 'manual' && e.data.linkId
          ? '<button class="sb-source-item-remove" onclick="sbRemoveLink(' + e.data.linkId + ',' + data.articleId + ')" title="Remove link">✕</button>'
          : '';
        html += '<div class="sb-source-item">'
          + '<span class="badge ' + badgeClass + '" style="flex-shrink:0;">' + escHtml(linkType) + '</span>'
          + '<span class="sb-source-item-title">' + escHtml(srcNode.data.title) + '</span>'
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
    var html = '';

    html += '<div class="sb-panel-badges">';
    html += '<span class="badge sb-type-source">source</span>';
    if (data.category) html += '<span class="badge badge-muted">' + escHtml(data.category) + '</span>';
    if (data.source) html += '<span class="badge badge-muted">' + escHtml(data.source) + '</span>';
    html += '</div>';

    if (data.publishedAt) {
      html += '<div style="font-size:11px;color:var(--muted);margin-bottom:10px;">' + fmtDate(data.publishedAt) + '</div>';
    }
    if (data.summary) {
      html += '<p class="sb-panel-summary">' + escHtml(data.summary).slice(0, 220) + (data.summary.length > 220 ? '…' : '') + '</p>';
    }
    if (data.sourceUrl) {
      html += '<a class="sb-panel-view-link" href="' + escHtml(data.sourceUrl) + '" target="_blank" rel="noopener">View source →</a>';
    }

    // Used by
    var usedByEdges = boardData.edges.filter(function (e) {
      return e.data.target === 'a_' + data.articleId;
    });

    html += '<div class="sb-section-title">Used by (' + usedByEdges.length + ')</div>';
    html += '<div class="sb-used-by-list">';

    if (usedByEdges.length === 0) {
      html += '<div style="font-size:12px;color:var(--muted);">Not linked to any originals.</div>';
    } else {
      usedByEdges.forEach(function (e) {
        var origNodeId = e.data.source;
        var origNode = boardData.nodes.find(function (n) { return n.id === origNodeId; });
        if (!origNode) return;
        html += '<div class="sb-used-by-item" onclick="sbFocusNode(\'' + origNode.id + '\')">'
          + escHtml(origNode.data.title)
          + '</div>';
      });
    }

    html += '</div>';
    body.innerHTML = html;
  }

  // ── Link picker ──────────────────────────────────────────────────────────────
  var _pickerDebounce = null;
  var _currentOriginalId = null;

  window.sbOpenLinkPicker = function (originalId) {
    _currentOriginalId = originalId;
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
    } catch (err) {
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
      // Re-open panel for the original node
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

  function updateStats(stats) {
    var el = document.getElementById('sbStats');
    if (!el || !stats) return;
    el.textContent = stats.originals + ' originals · ' + stats.sources + ' sources · ' + stats.edges + ' connections';
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function fmtDate(d) {
    if (!d) return '';
    try { return new Date(d).toLocaleDateString(); } catch { return ''; }
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
  document.getElementById('sbLinkedOnly')?.addEventListener('change', function () {
    // Re-render from cached data rather than re-fetching
    var linkedOnly = this.checked;
    var nodes = boardData.nodes;
    var edges = boardData.edges;
    if (linkedOnly) {
      var connectedSources = new Set();
      edges.forEach(function (e) { connectedSources.add(e.data.target); });
      nodes = nodes.filter(function (n) {
        return n.data.type === 'original' || connectedSources.has(n.id);
      });
    }
    renderBoard(nodes, edges);
  });

  // ── Init ─────────────────────────────────────────────────────────────────────
  onReady(async function () {
    if (!requireAuth()) return;
    renderSidebar();

    // Load categories from shared util if available
    if (typeof loadCategories === 'function') {
      try { await loadCategories(); } catch { /* best-effort */ }
    }
    categories = window._siteCategories || [];

    // Load writers for filter
    try {
      var writerData = await apiFetch('/writers?limit=100');
      writers = Array.isArray(writerData) ? writerData : (writerData.writers || []);
    } catch { /* best-effort */ }

    populateFilters();
    loadBoard();
  });
})();
