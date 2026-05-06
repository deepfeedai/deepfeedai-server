/**
 * Newsroom Reports workspace
 * Tabs: Overview · Content · AI Spend · Writers · Audit
 * Depends on: admin.js (apiFetch, showAlert)
 */
(function () {
  'use strict';

  var activeTab  = 'overview';
  var activeRange = '30d';
  var loaded     = {};

  // ── Helpers ────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function fmtNum(n) {
    var v = parseInt(n, 10) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000)    return (v / 1000).toFixed(1) + 'K';
    return String(v);
  }

  function relTime(iso) {
    if (!iso) return '—';
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60)   return Math.round(diff) + 's ago';
    if (diff < 3600) return Math.round(diff / 60) + 'm ago';
    if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
    return Math.round(diff / 86400) + 'd ago';
  }

  function truncate(s, max) {
    var str = String(s || '');
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function statCard(label, value, extra) {
    return '<div class="nr-stat-card">'
      + '<div class="nr-stat-label">' + esc(label) + '</div>'
      + '<div class="nr-stat-value">' + esc(value) + '</div>'
      + (extra || '')
      + '</div>';
  }

  // CSS bar chart — maxW is the container width in percent (default 100)
  function barChart(rows, maxVal) {
    if (!rows.length) return '<div class="nr-empty" style="padding:12px 0;">No data.</div>';
    var html = '<div class="nr-bar-chart">';
    rows.forEach(function (r) {
      var pct = maxVal > 0 ? Math.max(1, Math.round((r.value / maxVal) * 100)) : 0;
      html += '<div class="nr-bar-row">'
        + '<div class="nr-bar-label">' + esc(truncate(r.label, 40)) + '</div>'
        + '<div class="nr-bar-track">'
        + '<div class="nr-bar-fill" style="width:' + pct + '%;"></div>'
        + '</div>'
        + '<div class="nr-bar-val">' + esc(r.display || fmtNum(r.value)) + '</div>'
        + '</div>';
    });
    html += '</div>';
    return html;
  }

  function trendBadge(last, prior) {
    if (!prior || prior === 0) return last > 0 ? '<span class="nr-stat-delta up">↑ trend</span>' : '';
    var delta = last - prior;
    var pct   = Math.round(Math.abs(delta / prior) * 100);
    var up    = delta >= 0;
    return '<span class="nr-stat-delta ' + (up ? 'up' : 'down') + '">'
      + (up ? '↑' : '↓') + ' ' + pct + '% vs prior</span>';
  }

  // ── Overview tab ───────────────────────────────────────────────────────────

  async function loadOverview() {
    var panel = document.getElementById('reports-overview');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading overview…</div>';

    try {
      var results = await Promise.all([
        apiFetch('/analytics/summary?range=' + activeRange),
        apiFetch('/ai-usage/summary?range=' + activeRange).catch(function () { return null; }),
      ]);
      renderOverview(results[0], results[1]);
    } catch (err) {
      panel.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
    }
  }

  function renderOverview(data, aiData) {
    var panel = document.getElementById('reports-overview');
    if (!panel) return;

    var totals  = data.totals  || {};
    var byDay   = Array.isArray(data.by_day) ? data.by_day : [];

    // Trend: last half vs first half of the range
    var half     = Math.floor(byDay.length / 2);
    var sumFirst = byDay.slice(0, half).reduce(function (s, d) { return s + (d.views || 0); }, 0);
    var sumLast  = byDay.slice(half).reduce(function (s, d)  { return s + (d.views || 0); }, 0);
    var trend    = trendBadge(sumLast, sumFirst);

    var html = '<div class="nr-analytics-grid">';
    html += statCard('Total Views',  fmtNum(totals.views),       trend);
    html += statCard('Audio Plays',  fmtNum(totals.audio_plays), '');
    html += statCard('Shares',       fmtNum(totals.shares),      '');
    if (totals.views_prev != null) {
      var viewsPct = totals.views_prev > 0
        ? Math.round(((totals.views - totals.views_prev) / totals.views_prev) * 100) : 0;
      var vsHtml = '<span class="nr-stat-delta ' + (viewsPct >= 0 ? 'up' : 'down') + '">'
        + (viewsPct >= 0 ? '↑' : '↓') + ' ' + Math.abs(viewsPct) + '% vs prev period</span>';
      html = '<div class="nr-analytics-grid">';
      html += statCard('Total Views',  fmtNum(totals.views),       vsHtml);
      html += statCard('Audio Plays',  fmtNum(totals.audio_plays), '');
      html += statCard('Shares',       fmtNum(totals.shares),      '');
    }
    html += '</div>';

    // Views sparkline via CSS bars
    if (byDay.length > 1) {
      var maxV = Math.max.apply(null, byDay.map(function (d) { return d.views || 0; }));
      var rows = byDay.slice(-14).map(function (d) {
        return { label: (d.day || '').slice(5), value: d.views || 0 };
      });
      html += '<div style="margin-top:24px;">';
      html += '<div class="nr-section-heading">Daily Views</div>';
      html += barChart(rows, maxV);
      html += '</div>';
    }

    // AI spend summary strip
    if (aiData) {
      var tot    = aiData.totals || {};
      var budget = aiData.budget || {};
      var cost   = parseFloat(tot.estimated_cost) || 0;
      var limit  = parseFloat(budget.monthly_limit) || 0;
      var spend  = parseFloat(budget.current_spend) || 0;
      html += '<div style="margin-top:24px;padding:14px 0;border-top:1px solid var(--border);display:flex;gap:24px;flex-wrap:wrap;align-items:center;">';
      html += '<span style="font-size:12px;color:var(--muted);">AI Spend (' + esc(activeRange) + ')</span>';
      html += '<span style="font-size:14px;font-weight:600;">$' + esc(cost.toFixed(4)) + '</span>';
      if (limit > 0) {
        var pct = Math.min(100, Math.round((spend / limit) * 100));
        var barClr = pct >= 90 ? 'var(--danger,#ef4444)' : pct >= 70 ? '#f59e0b' : 'var(--accent,#6366f1)';
        html += '<div style="flex:1;min-width:140px;">'
          + '<div style="font-size:11px;color:var(--muted);margin-bottom:3px;">Budget: $' + esc(spend.toFixed(2)) + ' / $' + esc(limit.toFixed(2)) + '</div>'
          + '<div style="height:4px;border-radius:2px;background:var(--border);">'
          + '<div style="height:100%;border-radius:2px;background:' + barClr + ';width:' + pct + '%;"></div>'
          + '</div></div>';
      }
      html += '<a href="#" data-ws="reports" data-reports-tab="ai-spend" style="font-size:12px;color:var(--accent);">Details →</a>';
      html += '</div>';
    }

    panel.innerHTML = html;
  }

  // ── Production tab ────────────────────────────────────────────────────────

  async function loadProduction() {
    var panel = document.getElementById('reports-production');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading production stats…</div>';

    try {
      var stats = await apiFetch('/dashboard/stats');
      renderProduction(stats);
    } catch (err) {
      panel.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
    }
  }

  function renderProduction(stats) {
    var panel = document.getElementById('reports-production');
    if (!panel) return;

    var a = stats.articles || {};
    var f = stats.feed     || {};
    var s = stats.sources  || {};

    // Delta badge helper
    function delta(curr, prev, label) {
      if (prev == null) return '';
      var diff = (curr || 0) - (prev || 0);
      if (diff === 0) return '<span class="nr-stat-delta" style="color:var(--muted);">= same</span>';
      var up = diff > 0;
      return '<span class="nr-stat-delta ' + (up ? 'up' : 'down') + '">'
        + (up ? '↑' : '↓') + ' ' + Math.abs(diff) + (label || '') + '</span>';
    }

    // Stat cards — articles
    var html = '<div class="nr-section-heading">Articles</div>';
    html += '<div class="nr-analytics-grid">';
    html += statCard('Published',   String(a.published  || 0), '');
    html += statCard('Drafts',      String(a.drafts     || 0), '');
    html += statCard('In Review',   String(a.in_review  || 0), '');
    html += statCard('Today',       String(a.today      || 0), delta(a.today,     a.yesterday,  ' vs yesterday'));
    html += statCard('This Week',   String(a.this_week  || 0), delta(a.this_week, a.last_week,  ' vs last week'));
    html += '</div>';

    // Stat cards — feed & sources
    html += '<div class="nr-section-heading" style="margin-top:24px;">Ingestion</div>';
    html += '<div class="nr-analytics-grid">';
    html += statCard('Feed Articles', String(f.total || 0), '');
    html += statCard('Ingested Today', String(f.today || 0), '');
    html += statCard('This Week',      String(f.this_week || 0), '');
    html += statCard('Active Sources', String(s.active || 0), '');
    html += '</div>';

    // Published sparkline (7-day SVG bars)
    var sparkDays = stats.sparkline || [];
    if (sparkDays.length) {
      var W = 320, H = 72, pad = 4;
      var maxV  = Math.max.apply(null, sparkDays.map(function (d) { return d.value || 0; }), 1);
      var barW  = Math.floor((W - pad * 2) / sparkDays.length) - 2;
      var today = new Date().toISOString().slice(0, 10);
      var DOW   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var bars  = sparkDays.map(function (d, i) {
        var barH   = Math.max(2, Math.round(((d.value || 0) / Math.max(maxV, 1)) * (H - 24)));
        var x      = pad + i * (barW + 2);
        var y      = H - 16 - barH;
        var isToday = d.day === today;
        var fill   = isToday ? 'var(--accent,#6366f1)' : 'var(--border)';
        var dow    = DOW[new Date(d.day + 'T12:00:00Z').getUTCDay()];
        return '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + barH + '" rx="2" fill="' + fill + '">'
          + '<title>' + esc(d.day) + ': ' + (d.value || 0) + ' published</title></rect>'
          + '<text x="' + (x + barW / 2) + '" y="' + (H - 2) + '" text-anchor="middle" font-size="9" fill="var(--muted)">' + dow + '</text>'
          + (d.value > 0 ? '<text x="' + (x + barW / 2) + '" y="' + (y - 3) + '" text-anchor="middle" font-size="9" fill="var(--muted)">' + d.value + '</text>' : '');
      }).join('');

      html += '<div style="margin-top:24px;">';
      html += '<div class="nr-section-heading">Published This Week</div>';
      html += '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px;display:block;">' + bars + '</svg>';
      html += '</div>';
    }

    // By-category breakdown
    var cats = stats.categories || [];
    if (cats.length) {
      var total  = cats.reduce(function (s, c) { return s + (c.count || 0); }, 0);
      var maxCnt = cats[0] ? (cats[0].count || 1) : 1;
      html += '<div style="margin-top:24px;">';
      html += '<div class="nr-section-heading">By Category</div>';
      html += '<div class="nr-bar-chart">';
      cats.forEach(function (c) {
        var pct   = Math.max(1, Math.round((c.count / maxCnt) * 100));
        var share = total > 0 ? Math.round((c.count / total) * 100) : 0;
        html += '<div class="nr-bar-row">'
          + '<div class="nr-bar-label">' + esc(c.category || 'Other') + '</div>'
          + '<div class="nr-bar-track"><div class="nr-bar-fill" style="width:' + pct + '%;"></div></div>'
          + '<div class="nr-bar-val">' + esc(String(c.count)) + ' <span style="color:var(--muted);font-size:10px;">' + share + '%</span></div>'
          + '</div>';
      });
      html += '</div></div>';
    }

    // Recent articles
    var recent = stats.recent || [];
    if (recent.length) {
      html += '<div style="margin-top:24px;">';
      html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">';
      html += '<div class="nr-section-heading" style="margin-bottom:0;">Recent Articles</div>';
      html += '<a href="/articles.html" style="font-size:12px;color:var(--accent);">All articles →</a>';
      html += '</div>';
      html += '<table class="nr-writers-table">';
      html += '<thead><tr><th>Title</th><th style="text-align:right;">Status</th><th style="text-align:right;">Published</th></tr></thead><tbody>';
      recent.slice(0, 8).forEach(function (a) {
        var title  = esc(a.generated_title || a.title || 'Untitled');
        var slug   = a.slug ? '/article/' + esc(a.slug) : '#';
        var status = a.is_published ? '<span style="color:var(--success);font-size:11px;">✓ live</span>'
          : a.status === 'review' ? '<span style="color:#f59e0b;font-size:11px;">review</span>'
          : '<span style="color:var(--muted);font-size:11px;">draft</span>';
        var when = a.published_at ? esc(relTime(a.published_at)) : '—';
        html += '<tr>'
          + '<td style="font-size:13px;"><a href="' + slug + '" target="_blank" style="color:inherit;text-decoration:none;" title="' + title + '">' + title + '</a></td>'
          + '<td style="text-align:right;">' + status + '</td>'
          + '<td style="text-align:right;font-size:12px;color:var(--muted);">' + when + '</td>'
          + '</tr>';
      });
      html += '</tbody></table></div>';
    }

    panel.innerHTML = html;
  }

  // ── Content tab ────────────────────────────────────────────────────────────

  async function loadContent() {
    var panel = document.getElementById('reports-content');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading content report…</div>';

    try {
      var data = await apiFetch('/analytics/summary?range=' + activeRange);
      renderContent(data);
    } catch (err) {
      panel.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
    }
  }

  function renderContent(data) {
    var panel = document.getElementById('reports-content');
    if (!panel) return;

    var topArticles = Array.isArray(data.top_articles) ? data.top_articles : [];
    var engagement  = data.engagement || {};

    var html = '<div class="nr-section-heading">Top Articles — Last ' + esc(activeRange) + '</div>';

    if (topArticles.length) {
      html += '<table class="nr-writers-table" style="margin-bottom:24px;">';
      html += '<thead><tr>'
        + '<th style="width:50%;">Article</th>'
        + '<th style="text-align:right;">Views</th>'
        + '<th style="text-align:right;">Audio</th>'
        + '<th style="text-align:right;">Shares</th>'
        + '</tr></thead><tbody>';
      topArticles.forEach(function (a, i) {
        html += '<tr>';
        html += '<td style="display:flex;align-items:center;gap:8px;">';
        html += '<span style="color:var(--muted);font-size:11px;min-width:18px;">' + esc(String(i + 1)) + '</span>';
        if (a.slug) {
          html += '<a href="/article/' + esc(a.slug) + '" target="_blank" style="color:inherit;text-decoration:none;font-size:13px;" title="' + esc(a.title) + '">'
            + esc(truncate(a.title, 70)) + '</a>';
        } else {
          html += '<span style="font-size:13px;" title="' + esc(a.title) + '">' + esc(truncate(a.title, 70)) + '</span>';
        }
        html += '</td>';
        html += '<td style="text-align:right;font-variant-numeric:tabular-nums;font-size:13px;">' + esc(fmtNum(a.views)) + '</td>';
        html += '<td style="text-align:right;font-variant-numeric:tabular-nums;font-size:13px;">' + esc(fmtNum(a.audio_plays)) + '</td>';
        html += '<td style="text-align:right;font-variant-numeric:tabular-nums;font-size:13px;">' + esc(fmtNum(a.shares)) + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<div class="nr-empty" style="margin-bottom:24px;">No article data yet.</div>';
    }

    // Engagement by category if present
    var byCat = Array.isArray(engagement.by_category) ? engagement.by_category : [];
    if (byCat.length) {
      var maxCat = Math.max.apply(null, byCat.map(function (c) { return c.views || 0; }));
      html += '<div class="nr-section-heading" style="margin-top:8px;">Views by Category</div>';
      html += barChart(byCat.map(function (c) { return { label: c.category, value: c.views || 0 }; }), maxCat);
    }

    panel.innerHTML = html;
  }

  // ── AI Spend tab ───────────────────────────────────────────────────────────

  async function loadAiSpend() {
    var panel = document.getElementById('reports-ai-spend');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading AI spend…</div>';

    try {
      var results = await Promise.all([
        apiFetch('/ai-usage/summary?range=' + activeRange),
        apiFetch('/ai-usage/by-writer?range=' + activeRange).catch(function () { return null; }),
      ]);
      renderAiSpend(results[0], results[1]);
    } catch (err) {
      panel.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
    }
  }

  function renderAiSpend(data, byWriter) {
    var panel = document.getElementById('reports-ai-spend');
    if (!panel) return;

    var tot    = data.totals  || {};
    var budget = data.budget  || {};
    var models = Array.isArray(data.by_model) ? data.by_model : [];

    var cost        = parseFloat(tot.estimated_cost) || 0;
    var calls       = parseInt(tot.api_calls, 10)    || 0;
    var tokens      = parseInt(tot.total_tokens, 10)  || 0;
    var successRate = parseFloat(tot.success_rate)    || 0;

    var html = '<div class="nr-analytics-grid">';
    html += statCard('AI Cost',     '$' + cost.toFixed(4), '');
    html += statCard('API Calls',   fmtNum(calls),         '');
    html += statCard('Tokens',      fmtNum(tokens),        '');
    html += statCard('Success Rate', successRate.toFixed(1) + '%', '');
    html += '</div>';

    // Budget bar
    var limit = parseFloat(budget.monthly_limit) || 0;
    var spend = parseFloat(budget.current_spend)  || 0;
    if (limit > 0) {
      var pct = Math.min(100, Math.round((spend / limit) * 100));
      var barClr = pct >= 90 ? 'var(--danger,#ef4444)' : pct >= 70 ? '#f59e0b' : 'var(--accent,#6366f1)';
      html += '<div style="margin:20px 0 4px;">';
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Monthly budget: $' + esc(spend.toFixed(2)) + ' of $' + esc(limit.toFixed(2)) + ' (' + pct + '%)</div>';
      html += '<div style="height:6px;border-radius:3px;background:var(--border);">'
        + '<div style="height:100%;border-radius:3px;background:' + barClr + ';width:' + pct + '%;transition:width .3s;"></div>'
        + '</div></div>';
    }

    // By-model table
    if (models.length) {
      var maxCost = Math.max.apply(null, models.map(function (m) { return parseFloat(m.cost || 0); }));
      html += '<div style="margin-top:24px;">';
      html += '<div class="nr-section-heading">Cost by Model</div>';
      html += barChart(models.map(function (m) {
        return { label: (m.provider || '') + ' / ' + (m.model || ''), value: parseFloat(m.cost || 0), display: '$' + parseFloat(m.cost || 0).toFixed(4) };
      }), maxCost);

      html += '<div style="overflow-x:auto;margin-top:12px;">';
      html += '<table class="nr-writers-table">';
      html += '<thead><tr><th>Provider</th><th>Model</th>'
        + '<th style="text-align:right;">Calls</th>'
        + '<th style="text-align:right;">Input tok</th>'
        + '<th style="text-align:right;">Output tok</th>'
        + '<th style="text-align:right;">Cost</th></tr></thead><tbody>';
      models.forEach(function (m) {
        html += '<tr>'
          + '<td style="font-size:12px;">' + esc(m.provider || '—') + '</td>'
          + '<td style="font-size:12px;">' + esc(m.model || '—') + '</td>'
          + '<td style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">' + esc(fmtNum(m.calls || m.api_calls)) + '</td>'
          + '<td style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">' + esc(fmtNum(m.input_tokens)) + '</td>'
          + '<td style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">' + esc(fmtNum(m.output_tokens)) + '</td>'
          + '<td style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">$' + esc(parseFloat(m.cost || 0).toFixed(4)) + '</td>'
          + '</tr>';
      });
      html += '</tbody></table></div></div>';
    } else {
      html += '<div class="nr-empty" style="margin-top:16px;">No model-level data yet.</div>';
    }

    // By-writer section
    var writers = byWriter && Array.isArray(byWriter.writers) ? byWriter.writers : [];
    if (writers.length) {
      var maxWCost = Math.max.apply(null, writers.map(function (w) { return parseFloat(w.cost || 0); }));
      html += '<div style="margin-top:28px;">';
      html += '<div class="nr-section-heading">Cost by Writer</div>';
      html += barChart(writers.map(function (w) {
        return { label: w.writer_name || 'Writer ' + w.writer_id, value: parseFloat(w.cost || 0), display: '$' + parseFloat(w.cost || 0).toFixed(4) };
      }), maxWCost);
      html += '</div>';
    }

    panel.innerHTML = html;
  }

  // ── Writers tab ────────────────────────────────────────────────────────────

  async function loadWriters() {
    var panel = document.getElementById('reports-writers');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading writer performance…</div>';

    try {
      var results = await Promise.all([
        apiFetch('/ai-usage/by-writer?range=' + activeRange).catch(function () { return null; }),
        apiFetch('/analytics/summary?range=' + activeRange).catch(function () { return null; }),
      ]);
      renderWriters(results[0], results[1]);
    } catch (err) {
      panel.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
    }
  }

  function renderWriters(aiByWriter, analyticsData) {
    var panel = document.getElementById('reports-writers');
    if (!panel) return;

    var writers = aiByWriter && Array.isArray(aiByWriter.writers) ? aiByWriter.writers : [];

    // Build a map of top articles per writer from analytics if available
    var topArticles = analyticsData && Array.isArray(analyticsData.top_articles) ? analyticsData.top_articles : [];

    var html = '<div class="nr-section-heading">Writer Performance — Last ' + esc(activeRange) + '</div>';

    if (!writers.length) {
      html += '<div class="nr-empty">No writer-level AI usage data for this period.</div>';
      panel.innerHTML = html;
      return;
    }

    // Sort by cost desc
    writers = writers.slice().sort(function (a, b) { return parseFloat(b.cost || 0) - parseFloat(a.cost || 0); });

    html += '<table class="nr-writers-table">';
    html += '<thead><tr>'
      + '<th>Writer</th>'
      + '<th style="text-align:right;">AI Calls</th>'
      + '<th style="text-align:right;">Tokens</th>'
      + '<th style="text-align:right;">AI Cost</th>'
      + '</tr></thead><tbody>';

    writers.forEach(function (w) {
      var name     = w.writer_name || 'Writer #' + w.writer_id;
      var calls    = parseInt(w.calls || w.api_calls, 10) || 0;
      var inTok    = parseInt(w.input_tokens, 10)  || 0;
      var outTok   = parseInt(w.output_tokens, 10) || 0;
      var cost     = parseFloat(w.cost || 0);

      html += '<tr>'
        + '<td style="font-size:13px;font-weight:500;">' + esc(name) + '</td>'
        + '<td style="text-align:right;font-size:13px;font-variant-numeric:tabular-nums;">' + esc(fmtNum(calls)) + '</td>'
        + '<td style="text-align:right;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;">' + esc(fmtNum(inTok + outTok)) + '</td>'
        + '<td style="text-align:right;font-size:13px;font-variant-numeric:tabular-nums;">$' + esc(cost.toFixed(4)) + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';

    // Total cost bar
    var totalCost = writers.reduce(function (s, w) { return s + parseFloat(w.cost || 0); }, 0);
    html += '<div style="font-size:12px;color:var(--muted);margin-top:10px;text-align:right;">Total: $' + totalCost.toFixed(4) + '</div>';

    // Breakdown bar chart
    var maxW = Math.max.apply(null, writers.map(function (w) { return parseFloat(w.cost || 0); }));
    if (maxW > 0) {
      html += '<div style="margin-top:24px;">';
      html += '<div class="nr-section-heading">Cost Distribution</div>';
      html += barChart(writers.map(function (w) {
        return { label: w.writer_name || 'Writer #' + w.writer_id, value: parseFloat(w.cost || 0), display: '$' + parseFloat(w.cost || 0).toFixed(4) };
      }), maxW);
      html += '</div>';
    }

    panel.innerHTML = html;
  }

  // ── Audit tab ──────────────────────────────────────────────────────────────

  async function loadAudit() {
    var panel = document.getElementById('reports-audit');
    if (!panel) return;
    panel.innerHTML = '<div class="nr-loading">Loading audit log…</div>';

    try {
      var data = await apiFetch('/admin/audit-log?limit=100');
      renderAudit(data);
    } catch (err) {
      panel.innerHTML = '<div class="nr-empty" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
    }
  }

  function renderAudit(data) {
    var panel = document.getElementById('reports-audit');
    if (!panel) return;
    var items = (data && data.items) || [];

    var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">';
    html += '<div class="nr-section-heading" style="margin-bottom:0;">Audit Log</div>';
    html += '<a href="/audit.html" style="font-size:12px;color:var(--accent);">Full log &amp; export →</a>';
    html += '</div>';

    if (!items.length) {
      html += '<div class="nr-empty">No audit events found.</div>';
    } else {
      html += '<div style="display:flex;flex-direction:column;gap:0;">';
      items.forEach(function (ev) {
        var actor    = ev.actor_email || ev.user_email || ev.actor || 'system';
        var action   = ev.action || '—';
        var resource = ev.resource ? ' · ' + esc(ev.resource) : '';
        var detail   = ev.details ? (typeof ev.details === 'string' ? ev.details : JSON.stringify(ev.details)) : '';
        var when     = ev.created_at ? relTime(ev.created_at) : '—';

        html += '<div style="display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--border);">';
        html += '<span style="font-size:11px;color:var(--muted);white-space:nowrap;flex-shrink:0;min-width:70px;">' + esc(when) + '</span>';
        html += '<div style="flex:1;min-width:0;">';
        html += '<span style="font-size:12px;font-weight:600;color:var(--text);">' + esc(action) + '</span>';
        html += '<span style="font-size:12px;color:var(--muted);">' + resource + '</span>';
        if (detail) {
          html += '<div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">'
            + esc(String(detail).slice(0, 120)) + '</div>';
        }
        html += '</div>';
        html += '<span style="font-size:11px;color:var(--muted);white-space:nowrap;flex-shrink:0;">' + esc(String(actor).split('@')[0]) + '</span>';
        html += '</div>';
      });
      html += '</div>';

      if (data.total > items.length) {
        html += '<div style="font-size:12px;color:var(--muted);text-align:center;margin-top:10px;">'
          + esc(String(data.total - items.length)) + ' more events — '
          + '<a href="/audit.html" style="color:var(--accent);">view all</a></div>';
      }
    }

    panel.innerHTML = html;
  }

  // ── Bar chart CSS (injected once) ──────────────────────────────────────────

  (function injectBarChartStyles() {
    if (document.getElementById('nr-reports-css')) return;
    var style = document.createElement('style');
    style.id  = 'nr-reports-css';
    style.textContent = [
      '.nr-bar-chart { display:flex;flex-direction:column;gap:6px;margin-top:6px; }',
      '.nr-bar-row { display:flex;align-items:center;gap:8px; }',
      '.nr-bar-label { font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:110px;max-width:160px; }',
      '.nr-bar-track { flex:1;height:8px;border-radius:4px;background:var(--border);overflow:hidden; }',
      '.nr-bar-fill { height:100%;border-radius:4px;background:var(--accent,#6366f1);transition:width .3s; }',
      '.nr-bar-val { font-size:12px;font-variant-numeric:tabular-nums;color:var(--text);min-width:52px;text-align:right; }',
    ].join('\n');
    document.head.appendChild(style);
  })();

  // ── Tab switching ──────────────────────────────────────────────────────────

  var TAB_LOADERS = {
    'overview':   loadOverview,
    'production': loadProduction,
    'content':    loadContent,
    'ai-spend':   loadAiSpend,
    'writers':    loadWriters,
    'audit':      loadAudit,
  };

  var PANEL_IDS = ['overview', 'production', 'content', 'ai-spend', 'writers', 'audit'];

  function switchTab(tab) {
    if (!TAB_LOADERS[tab]) return;

    document.querySelectorAll('#nr-reports-tabs .reports-inner-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.reportsTab === tab);
    });

    PANEL_IDS.forEach(function (id) {
      var el = document.getElementById('reports-' + id);
      if (el) el.classList.toggle('active', id === tab);
    });

    activeTab = tab;
    try { localStorage.setItem('nr_reports_tab', tab); } catch (_) {}

    if (!loaded[tab]) {
      loaded[tab] = true;
      TAB_LOADERS[tab]();
    }
  }

  function reloadActiveTab() {
    // Clear loaded flag so switchTab re-fetches
    delete loaded[activeTab];
    switchTab(activeTab);
  }

  // ── Range selector ─────────────────────────────────────────────────────────

  function onRangeChange(range) {
    activeRange = range;
    // Invalidate all loaded tabs
    loaded = {};
    switchTab(activeTab);
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    var tabBar = document.getElementById('nr-reports-tabs');
    if (tabBar) {
      tabBar.addEventListener('click', function (e) {
        var btn = e.target.closest('.reports-inner-tab');
        if (!btn || !btn.dataset.reportsTab) return;
        switchTab(btn.dataset.reportsTab);
      });
    }

    var rangeEl = document.getElementById('nr-reports-range');
    if (rangeEl) {
      rangeEl.addEventListener('change', function () {
        onRangeChange(rangeEl.value);
      });
    }

    // Restore persisted tab
    var savedTab = null;
    try { savedTab = localStorage.getItem('nr_reports_tab'); } catch (_) {}
    if (savedTab && TAB_LOADERS[savedTab]) activeTab = savedTab;

    switchTab(activeTab);
  }

  // ── Public surface ─────────────────────────────────────────────────────────
  window.NRReports = { init: init, reload: reloadActiveTab };

})();
