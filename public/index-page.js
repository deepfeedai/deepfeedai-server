/* global apiFetch, renderSidebar, escHtml, relativeTime, fmtDate, badgePublished, showArticlePreview, requireAuth */

onReady(async () => {
  if (!requireAuth()) return;
  renderSidebar();

  // Greeting
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const greetEl = document.getElementById('dashGreeting');
  try {
    const token = localStorage.getItem('deepfeedai_token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const name = (payload.displayName || payload.username || '').split(' ')[0];
      if (name && greetEl) greetEl.textContent = greeting + ', ' + name;
    }
  } catch (e) { /* ignore */ }

  // Load settings for wizard banner check
  apiFetch('/settings').then(settings => {
    if (!settings.wizard_completed) {
      const banner = document.getElementById('wizardBanner');
      if (banner) banner.style.display = 'block';
    }
  }).catch(() => {});

  // Main data load
  let stats;
  try {
    stats = await apiFetch('/dashboard/stats');
  } catch (err) {
    showAlert('Failed to load dashboard: ' + err.message, 'error');
    return;
  }

  renderKPIs(stats);
  renderNewsroomPulse(stats);
  renderSparkline(stats);
  renderAISpend(stats);
  renderCategories(stats);
  renderAttention(stats);
  renderRecentArticles(stats);
});

// ── Delta badge ────────────────────────────────────────────
function deltaBadge(current, previous, suffix) {
  if (previous === undefined || previous === null) return '';
  const diff = current - previous;
  if (diff === 0) return '<span class="stat-delta-neutral">= same</span>';
  const sign  = diff > 0 ? '+' : '';
  const cls   = diff > 0 ? 'stat-delta-up' : 'stat-delta-down';
  const label = suffix || ' vs yesterday';
  return '<span class="' + cls + '">' + sign + diff + label + '</span>';
}

// ── KPI stat cards ─────────────────────────────────────────
function renderKPIs(stats) {
  const a = stats.articles;
  const f = stats.feed;
  const s = stats.sources;

  setText('statPublished', a.published);
  setText('statDrafts',    a.drafts);
  setText('statReview',    a.in_review);
  setText('statToday',     a.today);
  setText('statWeek',      a.this_week);
  setText('statFeedTotal', f.total);
  setText('statFeedToday', f.today);
  setText('statFeedWeek',  f.this_week);
  setText('statSources',   s.active);

  // Deltas
  setHtml('deltaPublished', deltaBadge(a.today, a.yesterday, ' vs yesterday'));
  setHtml('deltaToday',     deltaBadge(a.today, a.yesterday, ' vs yesterday'));
  setHtml('deltaWeek',      deltaBadge(a.this_week, a.last_week, ' vs last week'));

  // Warn cards
  if (a.in_review > 0) el('statReviewCard')?.classList.add('stat-card-warn');
  if (a.drafts    > 0) el('statDraftsCard')?.classList.add('stat-card-warn');
}

// ── Newsroom pulse ─────────────────────────────────────────
function renderNewsroomPulse(stats) {
  const pulseRow = el('pulseRow');
  if (!pulseRow) return;

  // Synthesis status in header
  const synthEl = el('synthStatus');
  if (synthEl && stats.synthesis) {
    const ran = stats.synthesis.last_run_at;
    const status = stats.synthesis.status;
    const cls = status === 'success' ? 'badge-accent' : status === 'failed' ? 'badge-danger' : 'badge-muted';
    synthEl.innerHTML = '<span class="badge ' + cls + '" title="Last synthesis run">'
      + 'Synthesis: ' + (ran ? relativeTime(ran) : 'never') + '</span>';
  } else if (synthEl) {
    synthEl.innerHTML = '<span class="badge badge-muted">Synthesis: never run</span>';
  }

  // Pending pitches card
  const pitchCount = stats.pitches?.pending || 0;
  const pitchCard = '<a href="/pitches.html" class="dash-pulse-card' + (pitchCount > 0 ? ' dash-pulse-card-alert' : '') + '">'
    + '<div class="dash-pulse-card-value">' + pitchCount + '</div>'
    + '<div class="dash-pulse-card-label">Pending Pitches</div>'
    + '</a>';

  // Writer cards
  const writers = stats.writers || [];
  const writerCards = writers.map(w => {
    const initial = (w.name || '?')[0].toUpperCase();
    const avatar  = w.avatar_url
      ? '<img src="' + escHtml(w.avatar_url) + '" alt="" class="dash-pulse-avatar" />'
      : '<div class="dash-pulse-avatar-initials">' + escHtml(initial) + '</div>';
    const count = w.article_count_7d || 0;
    const activity = count > 0
      ? '<span class="dash-pulse-active">' + count + ' this week</span>'
      : '<span class="dash-pulse-idle">Idle</span>';
    return '<a href="/writers.html" class="dash-pulse-card">'
      + '<div class="dash-pulse-avatar-wrap">' + avatar + '</div>'
      + '<div class="dash-pulse-card-name">' + escHtml(w.name) + '</div>'
      + activity
      + '</a>';
  }).join('');

  pulseRow.innerHTML = pitchCard + writerCards;
}

// ── 7-day sparkline (pure SVG) ─────────────────────────────
function renderSparkline(stats) {
  const wrap = el('publishedSparkline');
  if (!wrap) return;

  const days = stats.sparkline || [];
  if (!days.length) {
    wrap.innerHTML = '<div class="empty-state text-muted text-sm">No data</div>';
    return;
  }

  const W = 280, H = 72, pad = 4;
  const maxVal = Math.max(...days.map(d => d.value), 1);
  const barW   = Math.floor((W - pad * 2) / days.length) - 2;

  const today     = new Date().toISOString().slice(0, 10);
  const dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const bars = days.map((d, i) => {
    const barH  = Math.max(2, Math.round(((d.value / maxVal) * (H - 24))));
    const x     = pad + i * (barW + 2);
    const y     = H - 16 - barH;
    const isToday = d.day === today;
    const fill  = isToday ? 'var(--accent)' : 'var(--border)';
    const dow   = dayLabels[new Date(d.day + 'T12:00:00Z').getUTCDay()];
    return '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + barH + '" rx="2" fill="' + fill + '">'
      + '<title>' + d.day + ': ' + d.value + ' published</title></rect>'
      + '<text x="' + (x + barW / 2) + '" y="' + (H - 2) + '" text-anchor="middle" font-size="9" fill="var(--muted)">' + dow + '</text>'
      + (d.value > 0 ? '<text x="' + (x + barW / 2) + '" y="' + (y - 3) + '" text-anchor="middle" font-size="9" fill="var(--text-secondary)">' + d.value + '</text>' : '');
  }).join('');

  wrap.innerHTML = '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px;">' + bars + '</svg>';
}

// ── AI spend mini bar chart ────────────────────────────────
function renderAISpend(stats) {
  const totalEl = el('aiSpendTotal');
  const chartEl = el('aiSpendChart');
  if (!totalEl || !chartEl) return;

  const spend = stats.ai_spend || { week_total: 0, by_day: [] };
  totalEl.textContent = '$' + spend.week_total.toFixed(4);

  const days   = spend.by_day || [];
  const maxVal = Math.max(...days.map(d => d.value), 0.0001);
  const W = 200, H = 40;
  const barW = Math.floor((W - 8) / days.length) - 2;

  const bars = days.map((d, i) => {
    const barH = Math.max(2, Math.round((d.value / maxVal) * (H - 4)));
    const x    = 4 + i * (barW + 2);
    const y    = H - barH;
    return '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + barH + '" rx="1" fill="var(--accent)" opacity="0.6">'
      + '<title>' + d.day + ': $' + Number(d.value).toFixed(4) + '</title></rect>';
  }).join('');

  chartEl.innerHTML = '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '">' + bars + '</svg>';
}

// ── Category breakdown ─────────────────────────────────────
const CAT_COLORS = {
  'LLMs': '#a78bfa', 'Image AI': '#f472b6', 'Research': '#60a5fa',
  'Tools': '#34d399', 'Business': '#fbbf24', 'Policy': '#f87171',
  'CyberSecurity': '#ff6b35', 'Industry': '#94a3b8'
};

function renderCategories(stats) {
  const catEl = el('categoryBreakdown');
  if (!catEl) return;

  const cats = stats.categories || [];
  if (!cats.length) {
    catEl.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>No articles yet</p></div>';
    return;
  }

  const total  = cats.reduce((s, c) => s + c.count, 0);
  const maxCnt = cats[0]?.count || 1;

  catEl.innerHTML = cats.map(c => {
    const pct   = Math.round((c.count / maxCnt) * 100);
    const share = Math.round((c.count / total) * 100);
    const color = CAT_COLORS[c.category] || 'var(--accent)';
    return '<div class="cat-row">'
      + '<div class="cat-label">' + escHtml(c.category || 'Uncategorized') + '</div>'
      + '<div class="cat-bar-wrap"><div class="cat-bar" style="width:' + pct + '%;background:' + color + ';"></div></div>'
      + '<div class="cat-count">' + c.count + ' <span class="cat-pct">' + share + '%</span></div>'
      + '</div>';
  }).join('');
}

// ── What's Next (actionable attention items) ───────────────
function renderAttention(stats) {
  const attEl = el('attentionList');
  if (!attEl) return;

  const a = stats.articles;
  const f = stats.feed;
  const s = stats.sources;
  const c = stats.comments;
  const items = [];

  // In review — highest priority
  if (a.in_review > 0) {
    items.push({ icon: '👁', level: 'warn', priority: 10,
      text: a.in_review + ' article' + (a.in_review > 1 ? 's' : '') + ' waiting for editorial review',
      link: '/editorial.html', linkText: 'Review Now' });
  }

  // Pending pitches
  if (stats.pitches?.pending > 0) {
    const n = stats.pitches.pending;
    items.push({ icon: '💡', level: 'warn', priority: 9,
      text: n + ' pitch' + (n > 1 ? 'es' : '') + ' awaiting approval',
      link: '/pitches.html', linkText: 'Review Pitches' });
  }

  // Comment moderation
  if (c.queue > 0) {
    items.push({ icon: '⏳', level: 'warn', priority: 8,
      text: c.queue + ' comment' + (c.queue > 1 ? 's' : '') + ' pending moderation',
      link: '/comments.html?tab=queue', linkText: 'Review Queue' });
  }

  if (c.flagged > 0) {
    items.push({ icon: '🚩', level: 'warn', priority: 7,
      text: c.flagged + ' comment' + (c.flagged > 1 ? 's' : '') + ' reported by users',
      link: '/comments.html?filter=reported', linkText: 'Review Comments' });
  }

  // Missing images
  if (a.missing_image_published > 0) {
    items.push({ icon: '🖼️', level: 'info', priority: 5,
      text: a.missing_image_published + ' published article' + (a.missing_image_published > 1 ? 's' : '') + ' missing an image',
      link: '/articles.html', linkText: 'Fix in Articles' });
  }

  // No audio
  if (a.no_audio_published > 0) {
    items.push({ icon: '🎵', level: 'info', priority: 4,
      text: a.no_audio_published + ' published article' + (a.no_audio_published > 1 ? 's' : '') + ' without audio',
      link: '/articles.html', linkText: 'Generate Audio',
      action: { label: 'Run Audio', fn: 'triggerAudio' } });
  }

  // Synthesis hasn't run
  if (!stats.synthesis || !stats.synthesis.last_run_at) {
    items.push({ icon: '⚡', level: 'info', priority: 6,
      text: 'Synthesis has never run — trigger it to generate original articles',
      link: '/synthesis.html', linkText: 'Go to Synthesis' });
  } else {
    const lastRun = new Date(stats.synthesis.last_run_at).getTime();
    const hoursAgo = (Date.now() - lastRun) / 3600000;
    if (hoursAgo > 48) {
      items.push({ icon: '⚡', level: 'info', priority: 5,
        text: 'Synthesis last ran ' + Math.round(hoursAgo / 24) + ' days ago',
        link: '/synthesis.html', linkText: 'Run Synthesis' });
    }
  }

  // Stale drafts
  if (a.drafts > 0) {
    items.push({ icon: '📝', level: 'info', priority: 3,
      text: a.drafts + ' unpublished draft' + (a.drafts > 1 ? 's' : '') + ' waiting',
      link: '/articles.html', linkText: 'View Drafts' });
  }

  // Inactive sources
  if (s.inactive > 0) {
    items.push({ icon: '📡', level: 'muted', priority: 1,
      text: s.inactive + ' source' + (s.inactive > 1 ? 's' : '') + ' inactive',
      link: '/sources.html', linkText: 'Manage Sources' });
  }

  items.sort((a, b) => b.priority - a.priority);

  if (items.length === 0) {
    attEl.innerHTML = '<div class="attention-ok"><div style="font-size:32px;">✅</div><div>Everything looks good!</div></div>';
    return;
  }

  attEl.innerHTML = items.map(item =>
    '<div class="attention-item attention-' + item.level + '">'
    + '<span class="attention-icon">' + item.icon + '</span>'
    + '<div class="attention-text">'
    + '<span>' + item.text + '</span>'
    + (item.link ? '<a href="' + item.link + '" class="attention-link">' + item.linkText + ' →</a>' : '')
    + '</div>'
    + '</div>'
  ).join('');
}

// ── Recent articles (card grid) ────────────────────────────
function renderRecentArticles(stats) {
  const grid = el('recentGrid');
  if (!grid) return;

  const articles = stats.recent_articles || [];
  if (!articles.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">📭</div><p>No articles yet — publish your first one</p></div>';
    return;
  }

  grid.innerHTML = articles.map(a => {
    const img = a.image_url
      ? '<img src="' + escHtml(a.image_url) + '" class="dash-card-thumb" onerror="this.style.display=\'none\'" />'
      : '<div class="dash-card-thumb dash-card-thumb-empty">▭</div>';

    const audioBadge = a.audio_status === 'ready' && a.audio_url
      ? '<span class="badge badge-accent" style="font-size:10px;">🎵 ' + (a.media_enabled ? 'Live' : 'Hidden') + '</span>'
      : '';

    const writerBit = a.writer_name
      ? '<span class="text-muted text-xs">' + escHtml(a.writer_name) + '</span>'
      : '';

    return '<div class="dash-article-card" data-id="' + a.id + '">'
      + img
      + '<div class="dash-card-body">'
      + '<div class="dash-card-title">' + escHtml(a.title) + '</div>'
      + '<div class="dash-card-meta">'
      + '<span class="badge badge-muted">' + escHtml(a.category || '—') + '</span>'
      + badgePublished(a.is_published)
      + audioBadge
      + '</div>'
      + '<div class="dash-card-footer">'
      + writerBit
      + '<span class="text-muted text-xs" title="' + fmtDate(a.created_at) + '">' + relativeTime(a.created_at) + '</span>'
      + '</div>'
      + '</div>'
      + '</div>';
  }).join('');

  // Wire click → article preview
  grid.querySelectorAll('.dash-article-card').forEach(card => {
    card.addEventListener('click', () => {
      const article = stats.recent_articles.find(x => x.id === parseInt(card.dataset.id));
      if (article && typeof showArticlePreview === 'function') showArticlePreview(article, null);
    });
  });
}

// ── Helpers ────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function setText(id, val) { const e = el(id); if (e) e.textContent = val; }
function setHtml(id, val) { const e = el(id); if (e) e.innerHTML = val; }

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relativeTime(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return 'just now';
  if (mins  < 60) return mins + 'm ago';
  if (hours < 24) return hours + 'h ago';
  if (days  < 30) return days + 'd ago';
  return fmtDate(dateStr);
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function badgePublished(val) {
  return val
    ? '<span class="badge badge-accent" style="font-size:10px;">Published</span>'
    : '<span class="badge badge-muted" style="font-size:10px;">Draft</span>';
}
