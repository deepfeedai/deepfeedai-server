/* Deep Feed AI Admin — Story Board page v3 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────────
  var cy             = null;
  var boardData      = { nodes: [], edges: [], stats: {} };
  var selectedNodeId = null;
  var writers        = [];
  var categories     = [];
  var _activeGroup   = null;
  var _activeGroupBy = null;
  var _hiddenNodeIds = new Set();   // nodes manually hidden by the user
  var _panelOpen     = false;
  var _searchMatches = [];
  var _searchIdx     = -1;
  var _ctxNodeData   = null;
  var _focusedNodeId = null;   // node currently in neighbourhood-focus mode

  // ── Pitch status colours ──────────────────────────────────────────────────────
  var PITCH_STATUS_COLORS = {
    proposed: '#f59e0b',
    approved: '#22c55e',
    rejected: '#6b7280',
  };

  // ── Group colour palette ──────────────────────────────────────────────────────
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
    _activeGroup     = null;
    _activeGroupBy   = null;
  }

  function isPitchesMode() {
    return document.getElementById('sbView')?.value === 'pitches';
  }

  // ── Public site base URL (for "View on site" links) ───────────────────────────
  function publicSiteBase() {
    var host = window.location.hostname;
    if (host === 'portal-staging.deepfeedai.com') return 'https://staging.deepfeedai.com';
    if (host === 'portal.deepfeedai.com')         return 'https://deepfeedai.com';
    return null; // local dev — no public site link
  }

  // ── Proxy URL for article images (bypasses R2 CORS on canvas) ─────────────────
  function proxyImg(url) {
    if (!url) return null;
    const token = typeof getToken === 'function' ? getToken() : '';
    return '/api/proxy-image?url=' + encodeURIComponent(url) + (token ? '&token=' + encodeURIComponent(token) : '');
  }

  // ── Build Cytoscape stylesheet ────────────────────────────────────────────────
  function buildCyStyle() {
    var curveStyle = ({
      curved:   'bezier',
      straight: 'straight',
      taxi:     'taxi',
    })[document.getElementById('sbEdgeStyle')?.value] || 'bezier';
    var colorEdges = !!document.getElementById('sbColorEdges')?.checked;

    return [
      // ── Base (source) nodes ───────────────────────────────────────────────────
      {
        selector: 'node',
        style: {
          'width':  32,
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
      // ── Original article nodes ────────────────────────────────────────────────
      {
        selector: 'node.original',
        style: {
          'width':  'data(nodeSize)',
          'height': 'data(nodeSize)',
          'shape':  'roundrectangle',
          'background-color': function (n) {
            return n.data('imageUrl') ? '#111827' : (n.data('nodeColor') || n.data('accentColor') || '#6366f1');
          },
          'background-image': function (n) {
            var p = proxyImg(n.data('imageUrl'));
            return p ? 'url(' + p + ')' : 'none';
          },
          'background-fit': 'cover',
          'background-image-opacity': function (n) { return n.data('imageUrl') ? 1 : 0; },
          'border-color': function (n) { return n.data('nodeColor') || n.data('accentColor') || '#6366f1'; },
          'border-width': 3,
          'color': '#ffffff',
          'font-size': 11,
          'font-weight': 'bold',
          'text-max-width': 140,
          'text-background-color': '#111827',
          'text-background-opacity': 0.85,
          'text-background-padding': '3px',
          'text-background-shape': 'roundrectangle',
          'text-wrap': 'wrap',
        },
      },
      // ── Deep-dive hexagon ─────────────────────────────────────────────────────
      {
        selector: 'node.deep-dive',
        style: { 'shape': 'hexagon' },
      },
      // ── Pitch nodes ───────────────────────────────────────────────────────────
      {
        selector: 'node.pitch',
        style: {
          'width':  64,
          'height': 64,
          'shape':  'ellipse',
          'background-color': function (n) { return n.data('nodeColor') || PITCH_STATUS_COLORS[n.data('status')] || '#f59e0b'; },
          'border-color':     function (n) { return n.data('nodeColor') || PITCH_STATUS_COLORS[n.data('status')] || '#f59e0b'; },
          'border-width': 3,
          'color': '#e5e7eb',
          'font-size': 10,
          'font-weight': 'bold',
          'text-max-width': 130,
          'text-background-color': '#111827',
          'text-background-opacity': 0.8,
          'text-background-padding': '3px',
          'text-background-shape': 'roundrectangle',
          'text-wrap': 'wrap',
        },
      },
      // ── Orphan original ───────────────────────────────────────────────────────
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
          'border-color': '#ffffff',
          'border-width': 4,
          'border-style': 'solid',
          'opacity': 1,
        },
      },
      // ── Dimmed ────────────────────────────────────────────────────────────────
      {
        selector: '.dimmed',
        style: { 'opacity': 0.1 },
      },
      // ── Search match highlight ────────────────────────────────────────────────
      {
        selector: 'node.search-match',
        style: {
          'border-width': 4,
          'border-color': '#facc15',
          'border-opacity': 1,
          'border-style': 'solid',
          'opacity': 1,
        },
      },
      // ── Auto / source edges ───────────────────────────────────────────────────
      {
        selector: 'edge',
        style: {
          'width': 1.5,
          'line-color': colorEdges
            ? function (e) { return e.data('edgeColor') || '#4b5563'; }
            : '#4b5563',
          'target-arrow-color': colorEdges
            ? function (e) { return e.data('edgeColor') || '#4b5563'; }
            : '#4b5563',
          'target-arrow-shape': 'triangle',
          'curve-style': curveStyle,
          'arrow-scale': 0.8,
          'opacity': 0.75,
        },
      },
      // ── Manual link (cyan dashed) ─────────────────────────────────────────────
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
      // ── Pitch → attached (muted dashed) ──────────────────────────────────────
      {
        selector: 'edge.attached',
        style: {
          'width': 1,
          'line-color': '#6b7280',
          'target-arrow-color': '#6b7280',
          'line-style': 'dashed',
          'line-dash-pattern': [4, 4],
          'opacity': 0.55,
          'curve-style': curveStyle,
        },
      },
      // ── Pitch → spawned original (bold green) ─────────────────────────────────
      {
        selector: 'edge.spawned',
        style: {
          'width': 3,
          'line-color': '#22c55e',
          'target-arrow-color': '#22c55e',
          'line-style': 'solid',
          'opacity': 1,
          'curve-style': curveStyle,
        },
      },
    ];
  }

  // ── Layout options ────────────────────────────────────────────────────────────
  function getLayout() {
    var layout = document.getElementById('sbLayout')?.value || 'cose';
    if (layout === 'concentric') {
      return {
        name: 'concentric', animate: false, padding: 40,
        concentric: function (n) { return (n.hasClass('pitch') || n.hasClass('original')) ? 2 : 1; },
        levelWidth: function () { return 1; },
        minNodeSpacing: 40, startAngle: Math.PI * 3 / 2,
      };
    }
    if (layout === 'breadthfirst') {
      return { name: 'breadthfirst', animate: false, padding: 40, directed: true, spacingFactor: 1.5 };
    }
    if (layout === 'grid') {
      return {
        name: 'grid', animate: false, padding: 40, spacingFactor: 1.2,
        sort: function (a, b) {
          var aC = a.hasClass('pitch') || a.hasClass('original');
          var bC = b.hasClass('pitch') || b.hasClass('original');
          return aC === bC ? 0 : (aC ? -1 : 1);
        },
      };
    }
    return {
      name: 'cose', animate: false, numIter: 600,
      nodeRepulsion: function (n) { return (n.hasClass('pitch') || n.hasClass('original')) ? 9000 : 4500; },
      idealEdgeLength: function () { return 130; },
      nodeOverlap: 24, gravity: 0.25, padding: 40, randomize: true,
    };
  }

  // ── Toolbar adapts per view mode ──────────────────────────────────────────────
  function adaptToolbarForMode() {
    var pitches = isPitchesMode();
    var statusSel = document.getElementById('sbStatus');
    if (statusSel) {
      statusSel.innerHTML = pitches
        ? '<option value="">All</option>'
          + '<option value="proposed" selected>Proposed</option>'
          + '<option value="approved">Approved</option>'
          + '<option value="rejected">Rejected</option>'
        : '<option value="published" selected>Published</option>'
          + '<option value="draft">Draft</option>'
          + '<option value="all">All</option>';
    }
    var catWrap = document.getElementById('sbCategory')?.closest('div');
    if (catWrap) catWrap.style.display = pitches ? 'none' : '';
    document.querySelectorAll('.pitches-only').forEach(function (el) {
      el.style.display = pitches ? '' : 'none';
    });
    var groupSel = document.getElementById('sbGroupBy');
    if (groupSel) groupSel.value = '';
  }

  // ── Populate filter selects ───────────────────────────────────────────────────
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

  // ── Load board ────────────────────────────────────────────────────────────────
  async function loadBoard() {
    showLoading(true);
    closeSidePanel();
    resetGroupColors();
    try {
      if (isPitchesMode()) { await loadPitches(); } else { await loadArticles(); }
    } finally {
      showLoading(false);
    }
  }

  async function loadArticles() {
    var days        = document.getElementById('sbDays')?.value || '14';
    var category    = document.getElementById('sbCategory')?.value || '';
    var writerId    = document.getElementById('sbWriter')?.value || '';
    var status      = document.getElementById('sbStatus')?.value || 'published';
    var linkedOnly  = document.getElementById('sbLinkedOnly')?.checked;
    var orphansOnly = document.getElementById('sbOrphansOnly')?.checked;
    try {
      var params = new URLSearchParams({ days: days, status: status });
      if (category) params.set('category', category);
      if (writerId)  params.set('writer_id', writerId);
      var data = await apiFetch('/story-board?' + params.toString());
      boardData = data;
      applyFiltersAndRender(linkedOnly, orphansOnly);
      updateStats(data.stats, data.edges);
    } catch (err) {
      showAlert('Failed to load story board: ' + (err.message || err), 'error');
    }
  }

  async function loadPitches() {
    var days        = document.getElementById('sbDays')?.value || '14';
    var writerId    = document.getElementById('sbWriter')?.value || '';
    var status      = document.getElementById('sbStatus')?.value || '';
    var orphansOnly = document.getElementById('sbOrphansOnly')?.checked;
    try {
      var params = new URLSearchParams({ days: days });
      if (status)   params.set('status', status);
      if (writerId) params.set('writer_id', writerId);
      var data = await apiFetch('/story-board/pitches?' + params.toString());
      boardData = data;
      applyFiltersAndRender(false, orphansOnly);
      updateStats(data.stats, data.edges);
    } catch (err) {
      showAlert('Failed to load pitches: ' + (err.message || err), 'error');
    }
  }

  // ── Client-side filters → render ─────────────────────────────────────────────
  function applyFiltersAndRender(linkedOnly, orphansOnly) {
    var nodes = boardData.nodes;
    var edges = boardData.edges;

    // Apply user-hidden nodes first
    if (_hiddenNodeIds.size) {
      nodes = nodes.filter(function (n) { return !_hiddenNodeIds.has(n.id); });
      edges = edges.filter(function (e) {
        return !_hiddenNodeIds.has(e.data.source) && !_hiddenNodeIds.has(e.data.target);
      });
    }

    if (isPitchesMode()) {
      if (orphansOnly) {
        var spawnedSrcs = new Set(
          edges.filter(function (e) { return e.data.linkType === 'spawned'; })
               .map(function (e) { return e.data.source; })
        );
        var kept = new Set(
          nodes.filter(function (n) { return n.data.type !== 'pitch' || !spawnedSrcs.has(n.id); })
               .map(function (n) { return n.id; })
        );
        nodes = nodes.filter(function (n) { return kept.has(n.id); });
        edges = edges.filter(function (e) { return kept.has(e.data.source) && kept.has(e.data.target); });
      }
    } else {
      if (orphansOnly) {
        var connectedOriginals = new Set(edges.map(function (e) { return e.data.source; }));
        nodes = nodes.filter(function (n) {
          return n.data.type === 'original' && !connectedOriginals.has(n.id);
        });
        edges = [];
      } else if (linkedOnly) {
        var connectedSrcs = new Set(edges.map(function (e) { return e.data.target; }));
        nodes = nodes.filter(function (n) {
          return n.data.type === 'original' || connectedSrcs.has(n.id);
        });
      }
    }

    renderBoard(nodes, edges);
    updateHiddenBtn();
  }

  // ── Hidden-node toolbar button ────────────────────────────────────────────────
  function updateHiddenBtn() {
    var btn = document.getElementById('sbShowHiddenBtn');
    if (!btn) return;
    var count = _hiddenNodeIds.size;
    if (count === 0) {
      btn.style.display = 'none';
    } else {
      btn.style.display = '';
      btn.textContent = '👁 Show ' + count + ' hidden';
    }
  }

  // ── Render board ──────────────────────────────────────────────────────────────
  function renderBoard(nodes, edges) {
    var container = document.getElementById('cy');
    if (!container) return;

    _activeGroup   = null;
    _activeGroupBy = null;

    if (!nodes.length) {
      if (cy) { cy.destroy(); cy = null; }
      container.innerHTML = '<div class="sb-empty">'
        + '<div style="font-size:36px;margin-bottom:12px;">📋</div>'
        + '<div>' + (isPitchesMode() ? 'No pitches found.' : 'No originals found.') + '</div>'
        + '<div style="font-size:12px;margin-top:6px;">Try a longer time window or different filters.</div>'
        + '</div>';
      hideLegend();
      return;
    }
    var ph = container.querySelector('.sb-empty');
    if (ph) ph.remove();

    var groupBy  = document.getElementById('sbGroupBy')?.value || '';
    var centralWithEdges = new Set(edges.map(function (e) { return e.data.source; }));

    // Source counts per central node (excluding spawned edges)
    var sourceCounts = {};
    edges.forEach(function (e) {
      if (e.data.linkType !== 'spawned') {
        sourceCounts[e.data.source] = (sourceCounts[e.data.source] || 0) + 1;
      }
    });

    // Group colour map
    var groupColorMap = {};
    if (groupBy) {
      nodes.forEach(function (n) {
        if (n.data.type !== 'original' && n.data.type !== 'pitch') return;
        var key = groupKeyFor(n.data, groupBy);
        if (key && !groupColorMap[key]) groupColorMap[key] = groupColor(key);
      });
    }

    // Category colours for edge colouring
    var origColors = {};
    nodes.forEach(function (n) {
      if (n.data.type === 'original') origColors[n.id] = groupColor(n.data.category || 'Uncategorized');
      else if (n.data.type === 'pitch') origColors[n.id] = PITCH_STATUS_COLORS[n.data.status] || '#f59e0b';
    });

    var elements = nodes.map(function (n) {
      var type      = n.data.type;
      var isCentral = type === 'original' || type === 'pitch';
      var classes   = type;
      if (type === 'original' && !centralWithEdges.has(n.id)) classes += ' orphan';
      if (n.data.contentType === 'deep-dive') classes += ' deep-dive';

      var nodeColor = null;
      if (isCentral && groupBy) {
        var gkey = groupKeyFor(n.data, groupBy);
        if (gkey) nodeColor = groupColorMap[gkey];
      }

      // Score-based size (originals only): 52–88px
      var nodeSize = 72;
      if (type === 'pitch') {
        nodeSize = 64;
      } else if (type === 'original' && n.data.editorialScore != null) {
        nodeSize = Math.max(52, Math.min(88, Math.round(52 + (n.data.editorialScore / 10) * 36)));
      }

      // Label: title + source count + score
      var cnt   = isCentral ? (sourceCounts[n.id] || 0) : 0;
      var label = truncate(n.data.title, 26);
      if (type === 'pitch') {
        var statusMark = { proposed: '●', approved: '✓', rejected: '✗' }[n.data.status] || '';
        label = statusMark + ' ' + truncate(n.data.title, 24);
        if (cnt > 0) label += '\n(' + cnt + ')';
      } else if (type === 'original') {
        var sc = n.data.editorialScore;
        if (cnt > 0 || sc != null) {
          label += '\n';
          if (cnt > 0)    label += '(' + cnt + ')';
          if (sc != null) label += (cnt > 0 ? ' ' : '') + '★' + sc;
        }
      }

      return {
        group: 'nodes',
        data: Object.assign(
          { id: n.id, label: label, nodeColor: nodeColor, nodeSize: nodeSize },
          n.data
        ),
        classes: classes,
      };
    }).concat(edges.map(function (e) {
      return {
        group: 'edges',
        data: Object.assign({ id: e.id, edgeColor: origColors[e.data.source] || '#4b5563' }, e.data),
        classes: e.data.linkType || 'auto',
      };
    }));

    var cyStyle  = buildCyStyle();
    var cyLayout = getLayout();

    if (cy) {
      cy.style(cyStyle);
      cy.elements().remove();
      cy.add(elements);
      cy.layout(cyLayout).run();
    } else {
      cy = cytoscape({
        container: container, elements: elements,
        style: cyStyle, layout: cyLayout, minZoom: 0.1, maxZoom: 4,
      });

      cy.on('tap', 'node', function (evt) {
        selectedNodeId = evt.target.id();
        openSidePanel(evt.target.data());
      });
      cy.on('tap', function (evt) {
        if (evt.target === cy) closeSidePanel();
      });

      // Tooltip on hover
      cy.on('mouseover', 'node', function (evt) {
        var n        = evt.target;
        var data     = n.data();
        var tooltip  = document.getElementById('sbTooltip');
        var wrap     = document.getElementById('sbBoardWrap');
        if (!tooltip || !wrap) return;

        var pos      = n.renderedPosition();
        var cyRect   = document.getElementById('cy').getBoundingClientRect();
        var wrapRect = wrap.getBoundingClientRect();
        var srcCnt   = cy.edges('[source = "' + n.id() + '"]').filter(function (e) {
          return e.data('linkType') !== 'spawned';
        }).length;
        var usedByCnt = cy.edges('[target = "' + n.id() + '"]').length;

        var html = '<div style="font-weight:700;margin-bottom:4px;">'
          + escHtml(truncate(data.title, 52)) + '</div>';

        if (data.type === 'pitch') {
          var sColor = PITCH_STATUS_COLORS[data.status] || '#9ca3af';
          html += '<div style="color:' + sColor + ';font-size:11px;font-weight:600;">'
            + escHtml(data.status || '') + '</div>';
          if (data.writerName) html += '<div style="color:var(--muted);font-size:11px;">✍ ' + escHtml(data.writerName) + '</div>';
          html += '<div style="color:var(--muted);font-size:11px;margin-top:4px;">🔗 ' + srcCnt + ' source' + (srcCnt === 1 ? '' : 's') + '</div>';
          if (cy.edges('[source = "' + n.id() + '"][linkType = "spawned"]').length) {
            html += '<div style="color:#22c55e;font-size:11px;">✓ Spawned article</div>';
          }
        } else {
          if (data.category)   html += '<div style="color:var(--muted);font-size:11px;">' + escHtml(data.category) + '</div>';
          if (data.writerName) html += '<div style="color:var(--muted);font-size:11px;">✍ ' + escHtml(data.writerName) + '</div>';
          if (data.editorialScore != null) {
            var sc  = data.editorialScore;
            var cls = sc >= 7 ? 'sb-score-high' : sc >= 5 ? 'sb-score-mid' : 'sb-score-low';
            html += '<span class="sb-score-badge ' + cls + '" style="margin-top:4px;display:inline-block;">Score ' + sc + '</span>';
          }
          if (data.type === 'original') {
            html += '<div style="color:var(--muted);font-size:11px;margin-top:4px;">🔗 ' + srcCnt + ' source' + (srcCnt === 1 ? '' : 's') + '</div>';
          } else {
            html += '<div style="color:var(--muted);font-size:11px;margin-top:4px;">📰 used by ' + usedByCnt + (isPitchesMode() ? ' pitch' : ' original') + (usedByCnt === 1 ? '' : 's') + '</div>';
          }
        }

        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min((cyRect.left - wrapRect.left) + pos.x + 14, wrapRect.width - 250) + 'px';
        tooltip.style.top  = Math.max((cyRect.top  - wrapRect.top)  + pos.y - 22, 4) + 'px';
      });

      cy.on('mouseout', 'node', function () {
        var t = document.getElementById('sbTooltip');
        if (t) t.style.display = 'none';
      });

      // Double-click to zoom in on node
      cy.on('dbltap', 'node', function (evt) {
        cy.animate({
          center: { eles: evt.target },
          zoom: Math.min(cy.zoom() * 1.8, 3),
        }, { duration: 300 });
      });

      // Right-click context menu
      cy.on('cxttap', 'node', function (evt) {
        _ctxNodeData = evt.target.data();
        var pos     = evt.renderedPosition;
        var wrapEl  = document.getElementById('sbBoardWrap');
        var cyEl    = document.getElementById('cy');
        if (!wrapEl || !cyEl) return;
        var wrapRect = wrapEl.getBoundingClientRect();
        var cyRect   = cyEl.getBoundingClientRect();
        showContextMenu(
          cyRect.left - wrapRect.left + pos.x,
          cyRect.top  - wrapRect.top  + pos.y,
          _ctxNodeData
        );
      });

      cy.on('tap', function () { hideContextMenu(); });
    }

    renderLegend(groupBy, groupColorMap);
  }

  // ── Group key helper ──────────────────────────────────────────────────────────
  function groupKeyFor(data, groupBy) {
    if (groupBy === 'writer')   return data.writerName || 'Unassigned';
    if (groupBy === 'status')   return data.status     || 'unknown';
    if (groupBy === 'category') return data.category   || 'Uncategorized';
    return null;
  }

  // ── Legend ─────────────────────────────────────────────────────────────────────
  function renderLegend(groupBy, colorMap) {
    var legend = document.getElementById('sbLegend');
    var title  = document.getElementById('sbLegendTitle');
    var items  = document.getElementById('sbLegendItems');
    if (!legend || !title || !items) return;

    if (!groupBy || !Object.keys(colorMap).length) { legend.style.display = 'none'; return; }

    title.textContent = { writer: 'Writers', status: 'Status', category: 'Categories' }[groupBy] || groupBy;
    items.innerHTML = Object.entries(colorMap).map(function (entry) {
      var key   = entry[0];
      var color = entry[1];
      var safeKey = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return '<div class="sb-legend-item sb-legend-clickable" data-group-key="' + escHtml(key) + '" '
        + 'onclick="sbToggleGroup(\'' + safeKey + '\',\'' + groupBy + '\')">'
        + '<div class="sb-legend-swatch" style="background:' + color + ';"></div>'
        + '<span>' + escHtml(key) + '</span></div>';
    }).join('');
    legend.style.display = 'block';
  }

  function hideLegend() {
    var legend = document.getElementById('sbLegend');
    if (legend) legend.style.display = 'none';
  }

  // ── Legend group toggle ───────────────────────────────────────────────────────
  window.sbToggleGroup = function (key, groupByType) {
    if (!cy) return;
    document.querySelectorAll('.sb-legend-clickable').forEach(function (el) {
      el.classList.remove('sb-legend-active');
    });
    if (_activeGroup === key) {
      _activeGroup = null; _activeGroupBy = null;
      cy.elements().removeClass('dimmed');
      return;
    }
    _activeGroup = key; _activeGroupBy = groupByType;
    var matchIds = new Set();
    cy.nodes().forEach(function (n) {
      if (!n.hasClass('original') && !n.hasClass('pitch')) return;
      if (groupKeyFor(n.data(), groupByType) === key) matchIds.add(n.id());
    });
    cy.edges().forEach(function (e) {
      if (matchIds.has(e.data('source'))) matchIds.add(e.data('target'));
    });
    cy.elements().addClass('dimmed');
    matchIds.forEach(function (id) { cy.getElementById(id).removeClass('dimmed'); });
    cy.edges().forEach(function (e) {
      if (matchIds.has(e.data('source'))) e.removeClass('dimmed');
    });
    document.querySelectorAll('.sb-legend-clickable').forEach(function (el) {
      if (el.getAttribute('data-group-key') === key) el.classList.add('sb-legend-active');
    });
  };

  // ── Hide / show nodes ─────────────────────────────────────────────────────────
  window.sbHideNode = function (nodeId) {
    _hiddenNodeIds.add(nodeId);
    closeSidePanel();
    applyFiltersAndRender(
      document.getElementById('sbLinkedOnly')?.checked,
      document.getElementById('sbOrphansOnly')?.checked
    );
  };

  // ── Side panel ─────────────────────────────────────────────────────────────────
  function openSidePanel(data) {
    var panel = document.getElementById('sbPanel');
    var title = document.getElementById('sbPanelTitle');
    var body  = document.getElementById('sbPanelBody');
    if (!panel || !title || !body) return;
    panel.classList.remove('sb-panel-hidden');
    panel.style.transform = 'translateX(0)';
    title.textContent = truncate(data.title, 42);
    _panelOpen = true;
    if (data.type === 'pitch')         renderPitchPanel(data, body);
    else if (data.type === 'original') renderOriginalPanel(data, body);
    else                               renderSourcePanel(data, body);
  }

  function closeSidePanel() {
    var panel = document.getElementById('sbPanel');
    if (panel) { panel.classList.add('sb-panel-hidden'); panel.style.transform = ''; }
    selectedNodeId = null;
    _panelOpen = false;
  }

  // Shared nav links for article nodes
  function articleNavLinks(data) {
    var html = '';
    var adminUrl = '/articles.html?id=' + data.articleId;
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">';
    html += '<a class="btn btn-sm btn-outline" href="' + adminUrl + '" target="_blank">📋 View in Articles</a>';
    var pubBase = publicSiteBase();
    var slug    = data.slug || '';
    if (pubBase && slug) {
      html += '<a class="btn btn-sm btn-outline" href="' + escHtml(pubBase + '/article/' + slug)
        + '" target="_blank" rel="noopener">🌐 View on Site</a>';
    }
    html += '<button class="btn btn-sm btn-ghost" style="color:var(--muted);" onclick="sbHideNode(\''
      + escHtml(data.id || ('a_' + data.articleId)) + '\')">🙈 Hide</button>';
    html += '</div>';
    return html;
  }

  // ── Original side panel ───────────────────────────────────────────────────────
  function renderOriginalPanel(data, body) {
    var nodeId      = 'a_' + data.articleId;
    var linkedEdges = boardData.edges.filter(function (e) { return e.data.source === nodeId; });
    var sourceCount = linkedEdges.length;
    var html = '';

    if (data.imageUrl) html += '<img class="sb-panel-image" src="' + escHtml(data.imageUrl) + '" alt="" />';

    if (data.writerName) {
      html += '<div class="sb-panel-writer">';
      if (data.writerAvatar) {
        html += '<img class="sb-panel-writer-avatar" src="' + escHtml(data.writerAvatar) + '" alt="" />';
      } else {
        html += '<div class="sb-panel-writer-avatar" style="display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:var(--muted);">'
          + escHtml((data.writerName || '?')[0].toUpperCase()) + '</div>';
      }
      html += '<span class="sb-panel-writer-name">' + escHtml(data.writerName) + '</span></div>';
    }

    html += '<div class="sb-panel-meta-row">';
    html += '<span class="badge sb-type-original">' + escHtml(data.contentType || 'original') + '</span>';
    if (data.category) html += '<span class="badge badge-muted">' + escHtml(data.category) + '</span>';
    if (data.editorialScore != null) {
      var sc = data.editorialScore;
      html += '<span class="sb-score-badge ' + (sc >= 7 ? 'sb-score-high' : sc >= 5 ? 'sb-score-mid' : 'sb-score-low') + '">★ ' + sc + '</span>';
    }
    html += '</div>';

    html += '<div class="sb-panel-meta-row">';
    if (data.publishedAt) html += '<span>📅 ' + escHtml(fmtDate(data.publishedAt)) + '</span>';
    html += '<span>🔗 ' + sourceCount + ' source' + (sourceCount === 1 ? '' : 's') + '</span>';
    if (sourceCount === 0) html += '<span class="sb-orphan-warn">No sources</span>';
    html += '</div>';

    if (data.summary) html += '<p class="sb-panel-summary">' + escHtml(data.summary).slice(0, 280) + (data.summary.length > 280 ? '…' : '') + '</p>';

    html += articleNavLinks(Object.assign({ id: nodeId }, data));

    if (!isPitchesMode()) {
      html += '<div class="sb-section-title">Sources</div><div class="sb-source-list" id="sbSourceList">';
      if (sourceCount === 0) {
        html += '<div style="font-size:12px;color:var(--muted);">No linked sources.</div>';
      } else {
        linkedEdges.forEach(function (e) {
          var srcNode = boardData.nodes.find(function (n) { return n.id === e.data.target; });
          if (!srcNode) return;
          var lt = e.data.linkType;
          var removeBtn = lt === 'manual' && e.data.linkId
            ? '<button class="sb-source-item-remove" onclick="sbRemoveLink(' + e.data.linkId + ',' + data.articleId + ')" title="Remove">✕</button>'
            : '';
          html += '<div class="sb-source-item">'
            + '<span class="badge ' + (lt === 'manual' ? 'sb-edge-manual' : 'sb-edge-auto') + '" style="flex-shrink:0;">' + escHtml(lt) + '</span>'
            + '<span class="sb-source-item-title" title="' + escHtml(srcNode.data.title) + '">' + escHtml(truncate(srcNode.data.title, 38)) + '</span>'
            + removeBtn + '</div>';
        });
      }
      html += '</div>';
      html += '<button class="sb-link-add-btn" onclick="sbOpenLinkPicker(' + data.articleId + ')">+ Link source</button>';
      html += '<div id="sbLinkPicker" style="display:none;"></div>';
    } else {
      var spawnEdges = boardData.edges.filter(function (e) {
        return e.data.linkType === 'spawned' && e.data.target === nodeId;
      });
      if (spawnEdges.length) {
        html += '<div class="sb-section-title">Spawned from pitch</div>';
        spawnEdges.forEach(function (e) {
          var pn = boardData.nodes.find(function (n) { return n.id === e.data.source; });
          if (!pn) return;
          html += '<div class="sb-used-by-item" onclick="sbFocusNode(\'' + pn.id + '\')">'
            + escHtml(truncate(pn.data.title, 48)) + '</div>';
        });
      }
    }
    body.innerHTML = html;
  }

  // ── Pitch side panel ──────────────────────────────────────────────────────────
  function renderPitchPanel(data, body) {
    var pitchEdges  = boardData.edges.filter(function (e) { return e.data.source === 'p_' + data.pitchId; });
    var spawnedEdge = pitchEdges.find(function (e) { return e.data.linkType === 'spawned'; });
    var srcEdges    = pitchEdges.filter(function (e) { return e.data.linkType !== 'spawned'; });
    var statusColor = { proposed: '#f59e0b', approved: '#22c55e', rejected: '#9ca3af' }[data.status] || '#9ca3af';
    var statusLabel = { proposed: 'Proposed', approved: 'Approved', rejected: 'Rejected' }[data.status] || data.status;
    var html = '';

    if (data.writerName) {
      html += '<div class="sb-panel-writer">';
      if (data.writerAvatar) {
        html += '<img class="sb-panel-writer-avatar" src="' + escHtml(data.writerAvatar) + '" alt="" />';
      } else {
        html += '<div class="sb-panel-writer-avatar" style="display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:var(--muted);">'
          + escHtml((data.writerName || '?')[0].toUpperCase()) + '</div>';
      }
      html += '<span class="sb-panel-writer-name">' + escHtml(data.writerName) + '</span></div>';
    }

    html += '<div class="sb-panel-meta-row">';
    html += '<span class="badge" style="background:' + statusColor + '22;color:' + statusColor + ';font-weight:700;">' + escHtml(statusLabel) + '</span>';
    if (data.createdAt) html += '<span>📅 ' + escHtml(fmtDate(data.createdAt)) + '</span>';
    html += '</div>';

    if (data.summary) html += '<p class="sb-panel-summary">' + escHtml(data.summary).slice(0, 400) + (data.summary.length > 400 ? '…' : '') + '</p>';
    if (data.decisionNote) {
      html += '<div class="sb-section-title">Decision note</div>';
      html += '<p class="sb-panel-summary" style="margin-bottom:10px;">' + escHtml(data.decisionNote) + '</p>';
    }

    // Spawned original
    if (spawnedEdge) {
      var spawnedNode = boardData.nodes.find(function (n) { return n.id === spawnedEdge.data.target; });
      if (spawnedNode) {
        html += '<div class="sb-section-title">Spawned Article</div>';
        html += '<div class="sb-source-item" style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);">'
          + '<span class="badge" style="background:rgba(34,197,94,0.2);color:#22c55e;flex-shrink:0;">original</span>'
          + '<span class="sb-source-item-title" onclick="sbFocusNode(\'' + escHtml(spawnedNode.id) + '\')" '
          + 'style="cursor:pointer;color:var(--primary);">' + escHtml(truncate(spawnedNode.data.title, 36)) + '</span>'
          + '<a href="/articles.html?id=' + spawnedNode.data.articleId + '" target="_blank" style="color:var(--muted);font-size:11px;flex-shrink:0;">↗</a>'
          + '</div>';
      }
    }

    if (srcEdges.length) {
      html += '<div class="sb-section-title" style="margin-top:10px;">Sources (' + srcEdges.length + ')</div><div class="sb-source-list">';
      srcEdges.forEach(function (e) {
        var srcNode = boardData.nodes.find(function (n) { return n.id === e.data.target; });
        if (!srcNode) return;
        var lbl = e.data.linkType === 'attached' ? 'attached' : 'source';
        var cls = e.data.linkType === 'attached' ? 'sb-edge-auto' : 'sb-edge-manual';
        html += '<div class="sb-source-item"><span class="badge ' + cls + '" style="flex-shrink:0;">' + escHtml(lbl) + '</span>'
          + '<span class="sb-source-item-title" title="' + escHtml(srcNode.data.title) + '">' + escHtml(truncate(srcNode.data.title, 36)) + '</span></div>';
      });
      html += '</div>';
    }

    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">';
    html += '<a class="btn btn-sm btn-outline" href="/pitches.html" target="_blank">📋 View Pitches</a>';
    html += '<button class="btn btn-sm btn-ghost" style="color:var(--muted);" onclick="sbHideNode(\'p_' + data.pitchId + '\')">🙈 Hide</button>';
    html += '</div>';

    body.innerHTML = html;
  }

  // ── Source side panel ─────────────────────────────────────────────────────────
  function renderSourcePanel(data, body) {
    var nodeId      = 'a_' + data.articleId;
    var usedByEdges = boardData.edges.filter(function (e) { return e.data.target === nodeId; });
    var html = '';

    if (data.imageUrl) html += '<img class="sb-panel-image" src="' + escHtml(data.imageUrl) + '" alt="" />';

    html += '<div class="sb-panel-badges">';
    html += '<span class="badge sb-type-source">source</span>';
    if (data.category) html += '<span class="badge badge-muted">' + escHtml(data.category) + '</span>';
    if (data.source)   html += '<span class="badge badge-muted">' + escHtml(data.source) + '</span>';
    html += '</div>';

    html += '<div class="sb-panel-meta-row">';
    if (data.publishedAt) html += '<span>📅 ' + escHtml(fmtDate(data.publishedAt)) + '</span>';
    html += '<span>📰 used by ' + usedByEdges.length + ' ' + (isPitchesMode() ? 'pitch' : 'original') + (usedByEdges.length === 1 ? '' : 's') + '</span>';
    html += '</div>';

    if (data.summary) html += '<p class="sb-panel-summary">' + escHtml(data.summary).slice(0, 280) + (data.summary.length > 280 ? '…' : '') + '</p>';
    if (data.sourceUrl) html += '<a class="sb-panel-view-link" href="' + escHtml(data.sourceUrl) + '" target="_blank" rel="noopener">View source →</a>';

    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">';
    html += '<button class="btn btn-sm btn-ghost" style="color:var(--muted);" onclick="sbHideNode(\'' + nodeId + '\')">🙈 Hide</button>';
    html += '</div>';

    html += '<div class="sb-section-title">' + (isPitchesMode() ? 'Pitched by' : 'Used by originals') + '</div>';
    html += '<div class="sb-used-by-list">';
    if (!usedByEdges.length) {
      html += '<div style="font-size:12px;color:var(--muted);">Not linked to anything.</div>';
    } else {
      usedByEdges.forEach(function (e) {
        var pn = boardData.nodes.find(function (n) { return n.id === e.data.source; });
        if (!pn) return;
        html += '<div class="sb-used-by-item" onclick="sbFocusNode(\'' + pn.id + '\')">'
          + escHtml(truncate(pn.data.title, 48)) + '</div>';
      });
    }
    html += '</div>';
    body.innerHTML = html;
  }

  // ── Link picker (articles mode) ───────────────────────────────────────────────
  var _pickerDebounce = null;

  window.sbOpenLinkPicker = function (originalId) {
    var picker = document.getElementById('sbLinkPicker');
    if (!picker) return;
    picker.style.display = '';
    picker.innerHTML = '<div class="sb-link-picker">'
      + '<input class="sb-link-picker-input" id="sbPickerInput" type="text" placeholder="Search articles…" autocomplete="off" />'
      + '<div id="sbPickerResults"><div class="sb-link-picker-empty">Type to search…</div></div></div>';
    var input = document.getElementById('sbPickerInput');
    if (input) {
      input.focus();
      input.addEventListener('input', function () {
        clearTimeout(_pickerDebounce);
        _pickerDebounce = setTimeout(function () { sbPickerSearch(input.value.trim(), originalId); }, 300);
      });
    }
  };

  async function sbPickerSearch(q, originalId) {
    var results = document.getElementById('sbPickerResults');
    if (!results) return;
    if (q.length < 2) { results.innerHTML = '<div class="sb-link-picker-empty">Type to search…</div>'; return; }
    results.innerHTML = '<div class="sb-link-picker-empty">Searching…</div>';
    try {
      var data = await apiFetch('/story-board/search?q=' + encodeURIComponent(q));
      if (!data.length) { results.innerHTML = '<div class="sb-link-picker-empty">No results.</div>'; return; }
      results.innerHTML = data.map(function (a) {
        return '<div class="sb-link-result-item" onclick="sbAddLink(' + originalId + ',' + a.id + ')">'
          + '<div class="sb-link-result-title">' + escHtml(a.title) + '</div>'
          + '<div class="sb-link-result-meta">' + escHtml(a.category || '') + (a.source ? ' · ' + escHtml(a.source) : '') + '</div></div>';
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
      var n = boardData.nodes.find(function (n) { return n.data.articleId === originalId; });
      if (n) openSidePanel(n.data);
    } catch (err) { showAlert('Failed to add link: ' + (err.message || err), 'error'); }
  };

  window.sbRemoveLink = async function (linkId, originalId) {
    if (!confirm('Remove this source link?')) return;
    try {
      await apiFetch('/story-board/links/' + linkId, { method: 'DELETE' });
      await loadBoard();
      var n = boardData.nodes.find(function (n) { return n.data.articleId === originalId; });
      if (n) openSidePanel(n.data);
    } catch (err) { showAlert('Failed to remove link: ' + (err.message || err), 'error'); }
  };

  window.sbFocusNode = function (nodeId) {
    if (!cy) return;
    var node = cy.getElementById(nodeId);
    if (!node || !node.length) return;
    cy.animate({ fit: { eles: node, padding: 80 }, duration: 400 });
    node.select();
    openSidePanel(node.data());
  };

  // ── Board search ──────────────────────────────────────────────────────────────
  function applySearch(q) {
    if (!cy) return;
    q = q.trim().toLowerCase();
    if (!q) { clearSearch(); return; }

    _searchMatches = [];
    cy.nodes().forEach(function (n) {
      var d     = n.data();
      var match = (d.title  || '').toLowerCase().includes(q)
               || (d.source || '').toLowerCase().includes(q);
      if (match) {
        n.addClass('search-match');
        n.removeClass('dimmed');
        _searchMatches.push(n.id());
      } else {
        n.removeClass('search-match');
        n.addClass('dimmed');
      }
    });

    _searchIdx = 0;
    var countEl = document.getElementById('sbSearchCount');
    if (!_searchMatches.length) {
      if (countEl) countEl.textContent = 'No matches';
      return;
    }
    if (countEl) countEl.textContent = _searchMatches.length + ' match' + (_searchMatches.length === 1 ? '' : 'es');

    if (_searchMatches.length === 1) {
      sbFocusNode(_searchMatches[0]);
    } else {
      cy.animate({ center: { eles: cy.getElementById(_searchMatches[0]) }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 300 });
    }
  }

  function clearSearch() {
    if (cy) cy.nodes().removeClass('search-match dimmed');
    _searchMatches = []; _searchIdx = -1;
    var countEl = document.getElementById('sbSearchCount');
    if (countEl) countEl.textContent = '';
    var inp = document.getElementById('sbSearch');
    if (inp) inp.value = '';
  }

  function stepSearch(dir) {
    if (!cy || !_searchMatches.length) return;
    _searchIdx = (_searchIdx + dir + _searchMatches.length) % _searchMatches.length;
    cy.animate({ center: { eles: cy.getElementById(_searchMatches[_searchIdx]) }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 250 });
    var countEl = document.getElementById('sbSearchCount');
    if (countEl) countEl.textContent = (_searchIdx + 1) + ' / ' + _searchMatches.length;
  }

  // ── Neighbourhood focus ───────────────────────────────────────────────────────
  function focusNeighbourhood(nodeId) {
    if (!cy) return;
    _focusedNodeId = nodeId;
    var node      = cy.getElementById(nodeId);
    var connected = node.closedNeighborhood(); // node + its direct neighbours + connecting edges
    cy.elements().addClass('dimmed');
    connected.removeClass('dimmed');
  }

  function unfocusNeighbourhood() {
    if (!cy) return;
    _focusedNodeId = null;
    cy.elements().removeClass('dimmed');
  }

  // ── Context menu ──────────────────────────────────────────────────────────────
  function showContextMenu(x, y, data) {
    var menu = document.getElementById('sbContextMenu');
    if (!menu) return;
    var isArticle = data.type === 'original' || data.type === 'deep-dive' || data.type === 'source';
    var isOrig    = data.type === 'original' || data.type === 'deep-dive';
    document.getElementById('sbCtxOpenAdmin').style.display = isArticle ? '' : 'none';
    document.getElementById('sbCtxLinkSource').style.display = isOrig ? '' : 'none';
    // Toggle focus label based on whether this node is already focused
    var focusItem = document.getElementById('sbCtxNeighbourFocus');
    if (focusItem) {
      focusItem.textContent = (_focusedNodeId === data.id) ? '👁 Unfocus' : '👁 Focus node';
    }
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.classList.remove('sb-context-hidden');
  }

  function hideContextMenu() {
    var menu = document.getElementById('sbContextMenu');
    if (menu) menu.classList.add('sb-context-hidden');
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  function handleKeyDown(e) {
    var tag = document.activeElement ? document.activeElement.tagName : '';
    var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === '/' && !inInput) {
      e.preventDefault();
      var inp = document.getElementById('sbSearch');
      if (inp) inp.focus();
      return;
    }
    if (e.key === 'Escape') {
      var inp = document.getElementById('sbSearch');
      if (inp && document.activeElement === inp) {
        clearSearch();
        inp.blur();
      } else if (_focusedNodeId) {
        unfocusNeighbourhood();
      } else if (_panelOpen) {
        closeSidePanel();
      }
      hideContextMenu();
      return;
    }
    if ((e.key === 'n') && _searchMatches.length > 1 && !inInput) {
      e.preventDefault(); stepSearch(+1);
    }
    if ((e.key === 'N') && _searchMatches.length > 1 && !inInput) {
      e.preventDefault(); stepSearch(-1);
    }
    if (e.key === 'f' && !inInput && cy) {
      cy.fit(undefined, 40);
    }
    if ((e.key === 'h' || e.key === 'Delete') && selectedNodeId && !inInput) {
      sbHideNode(selectedNodeId);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────
  function showLoading(show) {
    var el = document.getElementById('sbLoading');
    if (el) el.style.display = show ? '' : 'none';
  }

  function updateStats(stats, edges) {
    var el = document.getElementById('sbStats');
    if (!el || !stats) return;
    if (isPitchesMode()) {
      var parts = [stats.pitches + ' pitches'];
      if (stats.proposed) parts.push(stats.proposed + ' proposed');
      if (stats.approved) parts.push(stats.approved + ' approved');
      if (stats.rejected) parts.push(stats.rejected + ' rejected');
      if (stats.articles) parts.push(stats.articles + ' articles');
      el.textContent = parts.join(' · ');
    } else {
      var withEdges = new Set((edges || []).map(function (e) { return e.data.source; }));
      var orphans   = stats.originals - withEdges.size;
      el.textContent = stats.originals + ' originals · ' + stats.sources + ' sources · ' + stats.edges + ' connections'
        + (orphans > 0 ? ' · ⚠ ' + orphans + ' unsourced' : '');
    }
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
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Export PNG ────────────────────────────────────────────────────────────────
  document.getElementById('sbExportBtn')?.addEventListener('click', function () {
    if (!cy) return;
    var blob = cy.png({ output: 'blob', bg: '#111827', full: true, scale: 2 });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url;
    a.download = (isPitchesMode() ? 'pitches-board-' : 'story-board-') + new Date().toISOString().slice(0, 10) + '.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  // ── Event listeners ───────────────────────────────────────────────────────────
  document.getElementById('sbView')?.addEventListener('change', function () {
    resetGroupColors(); adaptToolbarForMode();
    _hiddenNodeIds.clear();
    clearSearch();
    _focusedNodeId = null;
    if (cy) { cy.destroy(); cy = null; }
    loadBoard();
  });

  document.getElementById('sbRefreshBtn')?.addEventListener('click', loadBoard);
  document.getElementById('sbDays')?.addEventListener('change', loadBoard);
  document.getElementById('sbStatus')?.addEventListener('change', loadBoard);
  document.getElementById('sbCategory')?.addEventListener('change', loadBoard);
  document.getElementById('sbWriter')?.addEventListener('change', loadBoard);
  document.getElementById('sbPanelClose')?.addEventListener('click', closeSidePanel);

  document.getElementById('sbShowHiddenBtn')?.addEventListener('click', function () {
    _hiddenNodeIds.clear();
    applyFiltersAndRender(
      document.getElementById('sbLinkedOnly')?.checked,
      document.getElementById('sbOrphansOnly')?.checked
    );
  });

  document.getElementById('sbGroupBy')?.addEventListener('change', function () {
    resetGroupColors();
    applyFiltersAndRender(document.getElementById('sbLinkedOnly')?.checked, document.getElementById('sbOrphansOnly')?.checked);
  });
  document.getElementById('sbLinkedOnly')?.addEventListener('change', function () {
    applyFiltersAndRender(this.checked, document.getElementById('sbOrphansOnly')?.checked);
  });
  document.getElementById('sbOrphansOnly')?.addEventListener('change', function () {
    applyFiltersAndRender(document.getElementById('sbLinkedOnly')?.checked, this.checked);
  });
  document.getElementById('sbLayout')?.addEventListener('change', function () {
    applyFiltersAndRender(document.getElementById('sbLinkedOnly')?.checked, document.getElementById('sbOrphansOnly')?.checked);
  });
  document.getElementById('sbEdgeStyle')?.addEventListener('change', function () {
    if (cy) { cy.style(buildCyStyle()); cy.forceRender(); }
  });
  document.getElementById('sbColorEdges')?.addEventListener('change', function () {
    if (cy) { cy.style(buildCyStyle()); cy.forceRender(); }
  });

  document.getElementById('sbFitBtn')?.addEventListener('click', function () { if (cy) cy.fit(cy.elements(), 40); });
  document.getElementById('sbZoomInBtn')?.addEventListener('click', function () {
    if (!cy) return;
    var c = { x: cy.width() / 2, y: cy.height() / 2 };
    cy.zoom({ level: Math.min(cy.zoom() * 1.3, cy.maxZoom()), renderedPosition: c });
  });
  document.getElementById('sbZoomOutBtn')?.addEventListener('click', function () {
    if (!cy) return;
    var c = { x: cy.width() / 2, y: cy.height() / 2 };
    cy.zoom({ level: Math.max(cy.zoom() * 0.77, cy.minZoom()), renderedPosition: c });
  });

  // ── Search input ──────────────────────────────────────────────────────────────
  (function () {
    var searchTimer;
    var inp = document.getElementById('sbSearch');
    if (!inp) return;
    inp.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var val = inp.value;
      searchTimer = setTimeout(function () { applySearch(val); }, 200);
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); stepSearch(+1); }
      if (e.key === 'Escape') { clearSearch(); inp.blur(); }
    });
  }());

  // ── Context menu buttons ──────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    if (!document.getElementById('sbContextMenu')?.contains(e.target)) hideContextMenu();
  });
  document.getElementById('sbCtxFocus')?.addEventListener('click', function () {
    if (_ctxNodeData) sbFocusNode(_ctxNodeData.id);
    hideContextMenu();
  });
  document.getElementById('sbCtxNeighbourFocus')?.addEventListener('click', function () {
    if (!_ctxNodeData) return;
    if (_focusedNodeId === _ctxNodeData.id) unfocusNeighbourhood();
    else focusNeighbourhood(_ctxNodeData.id);
    hideContextMenu();
  });
  document.getElementById('sbCtxOpenAdmin')?.addEventListener('click', function () {
    if (_ctxNodeData && _ctxNodeData.articleId) {
      window.open('/articles.html?id=' + _ctxNodeData.articleId, '_blank');
    }
    hideContextMenu();
  });
  document.getElementById('sbCtxLinkSource')?.addEventListener('click', function () {
    if (_ctxNodeData && _ctxNodeData.articleId) sbOpenLinkPicker(_ctxNodeData.articleId);
    hideContextMenu();
  });
  document.getElementById('sbCtxHide')?.addEventListener('click', function () {
    if (_ctxNodeData) sbHideNode(_ctxNodeData.id);
    hideContextMenu();
  });

  // ── Keyboard handler ──────────────────────────────────────────────────────────
  document.addEventListener('keydown', handleKeyDown);

  // ── Mobile filter toggle ──────────────────────────────────────────────────────
  (function() {
    var toggleBtn = document.getElementById('sbFilterToggleBtn');
    var drawer    = document.getElementById('sbToolbarFilters');
    if (!toggleBtn || !drawer) return;
    toggleBtn.addEventListener('click', function() {
      var open = drawer.classList.toggle('open');
      toggleBtn.classList.toggle('active', open);
    });
  }());

  // ── Init ──────────────────────────────────────────────────────────────────────
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
    adaptToolbarForMode();
    await loadBoard();
    window.pageRefresh = loadBoard;

    // Handle ?articleId=X deep-link from articles page
    var params    = new URLSearchParams(window.location.search);
    var articleId = params.get('articleId');
    if (articleId) {
      setTimeout(function () {
        sbFocusNode('a_' + articleId);
      }, 300);
    }
  });
})();
