/**
 * Writer Detail Page — full profile view for a single writer.
 */
(function () {
  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function loadWriterDetail() {
    var params = new URLSearchParams(window.location.search);
    var writerId = parseInt(params.get('id'));
    if (!writerId) {
      document.getElementById('writerDetailContent').innerHTML = '<div class="empty-state"><div class="empty-icon">&#9888;&#65039;</div><p>No writer ID provided</p></div>';
      return;
    }

    // Wire edit button
    document.getElementById('editWriterBtn').onclick = function () {
      window.location.href = '/writers.html?edit=' + writerId;
    };

    try {
      // Fetch all data in parallel
      var [allWriters, memories, articles, perfRes] = await Promise.all([
        apiFetch('/admin/writers'),
        apiFetch('/admin/writers/' + writerId + '/memories?limit=100').catch(function () { return { memories: [] }; }),
        apiFetch('/articles?type=editorial&limit=100&offset=0').catch(function () { return { articles: [] }; }),
        apiFetch('/admin/writers/performance?range=30d').catch(function () { return []; }),
      ]);

      var w = allWriters.find(function (x) { return x.id === writerId; });
      if (!w) {
        document.getElementById('writerDetailContent').innerHTML = '<div class="empty-state"><div class="empty-icon">&#9888;&#65039;</div><p>Writer not found</p></div>';
        return;
      }

      var memList = memories.memories || [];
      var writerArticles = (articles.articles || []).filter(function (a) { return a.writer_id === writerId; });
      var perf = (Array.isArray(perfRes) ? perfRes : []).find(function (p) { return p.writer_id === writerId || p.id === writerId; });
      var beats = (w.beats || []).map(function (b) { return typeof b === 'string' ? b : b.name; });
      var contLevel = w.contrarian_level != null ? parseFloat(w.contrarian_level) : 0.5;
      var contLabel = contLevel <= 0.2 ? 'Straight reporter' : contLevel <= 0.4 ? 'Mostly balanced' : contLevel <= 0.6 ? 'Balanced' : contLevel <= 0.8 ? 'Pushes back' : 'Contrarian';

      // Update page title
      document.querySelector('.topbar-title').textContent = w.name;

      var html = '';

      // ── Header ──────────────────────────────────────────────
      html += '<div class="wd-header">';
      if (w.avatar_url) {
        html += '<img src="' + esc(w.avatar_url) + '" class="wd-avatar" />';
      } else {
        html += '<div class="wd-avatar-placeholder">&#9997;&#65039;</div>';
      }
      html += '<div style="flex:1;min-width:0;">';
      html += '<h1 class="wd-name">' + esc(w.name) + '</h1>';
      if (beats.length) {
        html += '<div>' + beats.map(function (b) { return '<span class="badge badge-muted" style="font-size:12px;margin:2px 3px;">' + esc(b) + '</span>'; }).join('') + '</div>';
      }
      if (w.bio) html += '<p class="wd-bio">' + esc(w.bio) + '</p>';
      html += '</div></div>';

      // ── Stats ───────────────────────────────────────────────
      html += '<div class="wd-stats">';
      var statItems = [
        { label: 'Articles', value: w.article_count || 0 },
        { label: 'Originals', value: perf ? (perf.articles_original || 0) : '—' },
        { label: 'Avg Score', value: perf ? (parseFloat(perf.avg_editorial_score) || 0).toFixed(1) : '—' },
        { label: 'Followers', value: w.follower_count || 0 },
        { label: 'Views', value: perf ? (perf.total_views || 0) : '—' },
        { label: 'Reactions', value: perf ? (perf.total_reactions || 0) : '—' },
        { label: 'Comments', value: perf ? (perf.total_comments || 0) : '—' },
        { label: 'Memories', value: memList.length },
      ];
      statItems.forEach(function (s) {
        html += '<div class="wd-stat"><div class="wd-stat-value">' + s.value + '</div><div class="wd-stat-label">' + s.label + '</div></div>';
      });
      html += '</div>';

      // ── Personality + Style ─────────────────────────────────
      html += '<div class="wd-two-col">';

      // Personality card
      html += '<div class="wd-card">';
      html += '<div class="wd-section-title">Personality</div>';
      if (w.beat_angle) html += '<div style="margin-bottom:8px;"><strong>Angle:</strong> ' + esc(w.beat_angle) + '</div>';
      if (w.signature_phrases && w.signature_phrases.length) {
        html += '<div style="margin-bottom:8px;"><strong>Phrases:</strong> ' + w.signature_phrases.map(function (p) { return '&ldquo;' + esc(p) + '&rdquo;'; }).join(', ') + '</div>';
      }
      html += '<div style="margin-bottom:8px;"><strong>Contrarian:</strong> ' + contLabel + ' (' + contLevel.toFixed(1) + ')</div>';
      html += '<div style="background:var(--bg-surface, #0a0a0a);border-radius:6px;overflow:hidden;height:8px;margin-top:4px;">';
      html += '<div style="height:100%;width:' + (contLevel * 100) + '%;background:linear-gradient(90deg, var(--accent), #a855f7);border-radius:6px;"></div>';
      html += '</div>';
      html += '</div>';

      // Style card
      html += '<div class="wd-card">';
      html += '<div class="wd-section-title">Style & Voice</div>';
      html += '<div style="margin-bottom:6px;"><strong>Tone:</strong> ' + esc(w.tone || 'Default') + '</div>';
      html += '<div style="margin-bottom:6px;"><strong>Expertise:</strong> ' + esc(w.expertise_level || 'Default') + '</div>';
      html += '<div style="margin-bottom:6px;"><strong>Mode:</strong> ' + (w.is_auto ? 'Auto' : 'Manual') + ' &middot; ' + esc(w.synthesis_schedule || 'daily') + '</div>';
      html += '<div><strong>Voice:</strong> ' + (w.elevenlabs_voice_id ? 'Configured' : 'None') + '</div>';
      if (w.style_guide) html += '<div style="margin-top:8px;padding:8px;background:var(--bg-surface, #0a0a0a);border-radius:6px;font-size:12px;color:var(--muted);">' + esc(w.style_guide) + '</div>';
      html += '</div>';

      html += '</div>'; // end two-col

      // ── Articles ────────────────────────────────────────────
      html += '<div class="wd-section">';
      html += '<div class="wd-section-title">Articles (' + writerArticles.length + ')</div>';
      html += '<div class="wd-card">';
      if (writerArticles.length === 0) {
        html += '<div class="text-muted text-sm">No articles yet</div>';
      } else {
        // Group by month
        var byMonth = {};
        writerArticles.forEach(function (a) {
          var d = new Date(a.published_at || a.created_at);
          var key = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
          if (!byMonth[key]) byMonth[key] = [];
          byMonth[key].push(a);
        });
        Object.entries(byMonth).forEach(function (entry) {
          html += '<div style="font-weight:600;font-size:12px;color:var(--muted);margin:12px 0 6px;text-transform:uppercase;">' + esc(entry[0]) + '</div>';
          entry[1].forEach(function (a) {
            var typeBadge = a.content_type === 'deep-dive' ? '<span class="badge badge-accent" style="font-size:9px;">Deep Dive</span> ' : '';
            var scoreBadge = a.editorial_score != null
              ? '<span class="badge ' + (a.editorial_score >= 7 ? 'badge-success' : a.editorial_score >= 5 ? 'badge-warning' : 'badge-danger') + '" style="font-size:10px;min-width:20px;">' + a.editorial_score + '</span> '
              : '';
            html += '<div class="wd-article-row">'
              + scoreBadge
              + '<span class="badge badge-muted" style="font-size:10px;">' + esc(a.category || '—') + '</span> '
              + typeBadge
              + '<span class="wd-article-title" title="' + esc(a.title) + '">' + esc(a.title) + '</span>'
              + '<span class="text-muted text-sm" style="white-space:nowrap;">' + relativeTime(a.published_at || a.created_at) + '</span>'
              + '</div>';
          });
        });
      }
      html += '</div></div>';

      // ── Memories ────────────────────────────────────────────
      html += '<div class="wd-section">';
      html += '<div class="wd-section-title">Editorial Memory (' + memList.length + ')</div>';
      html += '<div class="wd-card">';
      if (memList.length === 0) {
        html += '<div class="text-muted text-sm">No memories yet — auto-extracted after synthesis.</div>';
      } else {
        // Group by type
        var byType = {};
        memList.forEach(function (m) {
          var t = m.memory_type || 'other';
          if (!byType[t]) byType[t] = [];
          byType[t].push(m);
        });
        var typeOrder = ['position', 'thread', 'source_note', 'prediction'];
        typeOrder.forEach(function (type) {
          var items = byType[type];
          if (!items || !items.length) return;
          items.forEach(function (m) {
            html += '<div class="memory-item">'
              + '<span class="memory-type memory-type-' + m.memory_type + '">' + m.memory_type.replace('_', ' ') + '</span>'
              + '<div style="flex:1;min-width:0;">'
              + '<div style="font-weight:600;font-size:13px;">' + esc(m.subject) + '</div>'
              + '<div class="text-muted text-sm">' + esc(m.content) + '</div>'
              + '<div class="text-muted" style="font-size:11px;margin-top:2px;">'
              + relativeTime(m.created_at)
              + (m.confidence ? ' &middot; confidence: ' + parseFloat(m.confidence).toFixed(2) : '')
              + (m.expires_at ? ' &middot; expires ' + relativeTime(m.expires_at) : '')
              + '</div>'
              + '</div></div>';
          });
        });
      }
      html += '</div></div>';

      // ── System Prompt ───────────────────────────────────────
      if (w.system_prompt) {
        html += '<div class="wd-section">';
        html += '<div class="wd-section-title">System Prompt</div>';
        html += '<div class="wd-card" style="font-size:13px;white-space:pre-wrap;color:var(--muted);font-family:monospace;max-height:200px;overflow-y:auto;">' + esc(w.system_prompt) + '</div>';
        html += '</div>';
      }

      document.getElementById('writerDetailContent').innerHTML = html;

    } catch (err) {
      showAlert('Failed to load writer: ' + err.message, 'error');
      document.getElementById('writerDetailContent').innerHTML = '<div class="empty-state"><div class="empty-icon">&#9888;&#65039;</div><p>Failed to load writer details</p></div>';
    }
  }

  onReady(function () {
    if (!requireAuth()) return;
    renderSidebar();
    initModals();
    loadWriterDetail();
  });
})();
