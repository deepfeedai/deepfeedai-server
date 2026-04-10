onReady(async () => {
    if (!requireAuth()) return;
    renderSidebar();

    const user = localStorage.getItem('deepfeedai_user');
    if (user) document.getElementById('topbarUser').textContent = `👤 ${user}`;

    // Show skeletons while data loads
    ['statTotal','statPublished','statDrafts','statToday','statWeek',
     'statFeedTotal','statFeedToday','statFeedWeek','statSources',
     'statAudioTotal','statAudioLive','statAudioHidden','statNoAudio','statImages','statFeatured'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<span class="skeleton sk-stat-value" style="width:50px;height:28px;display:block;"></span>';
    });
    const recentBodyEl = document.getElementById('recentBody');
    if (recentBodyEl) recentBodyEl.innerHTML = skeletonRows(['sk-w-sm','sk-w-full','sk-w-sm','sk-w-sm','sk-w-sm','sk-w-md'], 5);

    try {
      // Fetch articles by type, paginating through the API (max 500 per request)
      async function fetchArticles(type) {
        const PAGE_SIZE = 500;
        let all = [];
        let offset = 0;
        let hasMore = true;
        while (hasMore) {
          const data = await apiFetch(`/articles?type=${type}&limit=${PAGE_SIZE}&offset=${offset}`);
          const batch = Array.isArray(data) ? data : (data.articles || []);
          all = all.concat(batch);
          hasMore = data.hasMore === true;
          offset += batch.length;
          if (!batch.length) break;
        }
        return all;
      }

      const [editorialRaw, curatedRaw, sources, settings, commentsData, queueData] = await Promise.all([
        fetchArticles('editorial'),
        fetchArticles('curated'),
        apiFetch('/sources'),
        apiFetch('/settings').catch(() => ({})),
        apiFetch('/comments/admin').catch(() => ({ comments: [] })),
        apiFetch('/comments/admin/queue').catch(() => ({ queue: [] })),
      ]);

      // Show wizard banner if setup hasn't been completed
      if (!settings.wizard_completed) {
        const banner = document.getElementById('wizardBanner');
        if (banner) banner.style.display = 'block';
      }

      const articles  = editorialRaw;
      const now       = Date.now();
      const DAY_MS    = 86400000;
      const WEEK_MS   = 7 * DAY_MS;

      // Editorial metrics
      const active    = articles.filter(a => !a.is_archived);
      const published = active.filter(a => a.is_published);
      const drafts    = active.filter(a => !a.is_published && a.status !== 'review');
      const inReview  = active.filter(a => a.status === 'review');
      const today     = published.filter(a => now - new Date(a.published_at || a.created_at).getTime() <= DAY_MS);
      const week      = published.filter(a => now - new Date(a.published_at || a.created_at).getTime() <= WEEK_MS);

      const audioReady  = active.filter(a => a.audio_status === 'ready' && a.audio_url);
      const audioLive   = audioReady.filter(a => a.media_enabled);
      const audioHidden = audioReady.filter(a => !a.media_enabled);
      const noAudio     = active.filter(a => !a.audio_status || a.audio_status === 'error');
      const hasImage    = active.filter(a => a.image_url);

      // Ingestion metrics
      const feedActive = curatedRaw.filter(a => !a.is_archived);

      // ── Stat cards ────────────────────────────────────────────
      document.getElementById('statTotal').textContent     = active.length;
      document.getElementById('statPublished').textContent = published.length;
      document.getElementById('statDrafts').textContent    = drafts.length;
      document.getElementById('statToday').textContent     = today.length;
      document.getElementById('statWeek').textContent      = week.length;

      // Ingestion stats
      document.getElementById('statFeedTotal').textContent = feedActive.length;
      document.getElementById('statFeedToday').textContent = feedActive.filter(a => now - new Date(a.created_at).getTime() <= DAY_MS).length;
      document.getElementById('statFeedWeek').textContent  = feedActive.filter(a => now - new Date(a.created_at).getTime() <= WEEK_MS).length;
      document.getElementById('statSources').textContent   = sources.filter(s => s.is_active).length;
      document.getElementById('statAudioTotal').textContent  = audioReady.length;
      document.getElementById('statAudioLive').textContent   = audioLive.length;
      document.getElementById('statAudioHidden').textContent = audioHidden.length;
      document.getElementById('statNoAudio').textContent     = noAudio.length;
      document.getElementById('statImages').textContent      = hasImage.length;
      document.getElementById('statFeatured').textContent    = active.filter(a => a.is_featured).length;

      // Review count
      const reviewEl = document.getElementById('statReview');
      if (reviewEl) reviewEl.textContent = inReview.length;
      if (inReview.length > 0) {
        const reviewCard = document.getElementById('statReviewCard');
        if (reviewCard) reviewCard.classList.add('stat-card-warn');
      }

      // Highlight drafts card if pending
      if (drafts.length > 0) {
        document.getElementById('statDraftsCard').classList.add('stat-card-warn');
      }

      // ── Community stats ───────────────────────────────────────
      const comments     = (commentsData.comments || []).filter(c => !c.isDeleted);
      const flagged      = comments.filter(c => c.reportCount > 0);
      const publicUsers  = new Set(comments.filter(c => c.user).map(c => c.user.id));

      document.getElementById('statComments').textContent    = comments.length;
      document.getElementById('statFlagged').textContent     = flagged.length;
      document.getElementById('statPublicUsers').textContent = publicUsers.size;

      if (flagged.length > 0) {
        document.getElementById('statFlaggedCard').classList.add('stat-card-warn');
      }

      // ── Category breakdown ────────────────────────────────────
      const catCounts = {};
      active.forEach(a => {
        const cat = a.category || 'Uncategorized';
        catCounts[cat] = (catCounts[cat] || 0) + 1;
      });
      const catSorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
      const catMax    = catSorted[0]?.[1] || 1;
      const catColors = {
        'LLMs': '#a78bfa', 'Image AI': '#f472b6', 'Research': '#60a5fa',
        'Tools': '#34d399', 'Business': '#fbbf24', 'Policy': '#f87171',
        'CyberSecurity': '#ff6b35', 'Industry': '#94a3b8'
      };

      document.getElementById('categoryBreakdown').innerHTML = catSorted.length
        ? catSorted.map(([cat, count]) => {
            const pct   = Math.round((count / catMax) * 100);
            const color = catColors[cat] || 'var(--accent)';
            const share = Math.round((count / active.length) * 100);
            return `
              <div class="cat-row">
                <div class="cat-label">${escHtml(cat)}</div>
                <div class="cat-bar-wrap">
                  <div class="cat-bar" style="width:${pct}%;background:${color};"></div>
                </div>
                <div class="cat-count">${count} <span class="cat-pct">${share}%</span></div>
              </div>`;
          }).join('')
        : '<div class="empty-state"><div class="empty-icon">📭</div><p>No articles yet — publish your first one</p></div>';

      // ── Needs Attention ───────────────────────────────────────
      const attention = [];

      if (drafts.length > 0) {
        const stale = drafts.filter(a => now - new Date(a.created_at).getTime() > 3 * DAY_MS);
        if (stale.length > 0) {
          attention.push({
            icon: '📝', level: 'warn',
            text: `${stale.length} draft${stale.length > 1 ? 's' : ''} older than 3 days`,
            link: '/articles.html', linkText: 'View Drafts'
          });
        } else {
          attention.push({
            icon: '📝', level: 'info',
            text: `${drafts.length} unpublished draft${drafts.length > 1 ? 's' : ''} waiting`,
            link: '/articles.html', linkText: 'View Drafts'
          });
        }
      }

      const noImageActive = active.filter(a => a.is_published && !a.image_url);
      if (noImageActive.length > 0) {
        attention.push({
          icon: '🖼️', level: 'warn',
          text: `${noImageActive.length} published article${noImageActive.length > 1 ? 's' : ''} missing an image`,
          link: '/articles.html', linkText: 'Fix in Articles'
        });
      }

      const noAudioPublished = published.filter(a => !a.audio_status || a.audio_status === 'error');
      if (noAudioPublished.length > 0) {
        attention.push({
          icon: '🎵', level: 'info',
          text: `${noAudioPublished.length} published article${noAudioPublished.length > 1 ? 's' : ''} without audio`,
          link: '/articles.html', linkText: 'Generate Audio'
        });
      }

      const queue = queueData.queue || [];
      if (queue.length > 0) {
        attention.push({
          icon: '⏳', level: 'warn',
          text: `${queue.length} comment${queue.length > 1 ? 's' : ''} pending moderation review`,
          link: '/comments.html?tab=queue', linkText: 'Review Queue'
        });
      }

      if (flagged.length > 0) {
        attention.push({
          icon: '🚩', level: 'warn',
          text: `${flagged.length} comment${flagged.length > 1 ? 's' : ''} reported by users`,
          link: '/comments.html?filter=reported', linkText: 'Review Comments'
        });
      }

      const inactiveSources = sources.filter(s => !s.is_active);
      if (inactiveSources.length > 0) {
        attention.push({
          icon: '📡', level: 'muted',
          text: `${inactiveSources.length} source${inactiveSources.length > 1 ? 's' : ''} inactive`,
          link: '/sources.html', linkText: 'Manage Sources'
        });
      }

      // Purge eligibility
      if (settings.purge_days) {
        const purgeDays     = Math.max(parseInt(settings.purge_days) || 30, 7);
        const purgeProtFeat = settings.purge_protect_featured !== '0';
        const purgeProtAud  = settings.purge_protect_audio === '1';
        const purgeCutoff   = Date.now() - purgeDays * 86400000;
        const purgeEligible = active.filter(a => {
          const age = new Date(a.published_at || a.created_at).getTime();
          if (age >= purgeCutoff) return false;
          if (purgeProtFeat && a.is_featured) return false;
          if (purgeProtAud  && a.audio_status === 'ready' && a.audio_url) return false;
          return true;
        });
        if (purgeEligible.length > 0) {
          attention.push({
            icon: '🗑️', level: 'muted',
            text: `${purgeEligible.length} article${purgeEligible.length > 1 ? 's' : ''} eligible for purge (older than ${purgeDays}d)`,
            link: '/settings.html', linkText: 'Manage in Settings'
          });
        }
      }

      const attentionEl = document.getElementById('attentionList');
      if (attention.length === 0) {
        attentionEl.innerHTML = `
          <div class="attention-ok">
            <div style="font-size:32px;">✅</div>
            <div>Everything looks good!</div>
          </div>`;
      } else {
        attentionEl.innerHTML = attention.map(item => `
          <div class="attention-item attention-${item.level}">
            <span class="attention-icon">${item.icon}</span>
            <div class="attention-text">
              <span>${item.text}</span>
              ${item.link ? `<a href="${item.link}" class="attention-link">${item.linkText} →</a>` : ''}
            </div>
          </div>`).join('');
      }

      // ── Recent articles table ─────────────────────────────────
      const recent = [...active]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 12);
      const tbody = document.getElementById('recentBody');

      if (recent.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6">
          <div class="empty-state"><div class="empty-icon">📭</div><p>No articles yet — publish your first one</p></div>
        </td></tr>`;
      } else {
        tbody.innerHTML = recent.map(a => {
          const audioTag = a.audio_status === 'ready' && a.audio_url
            ? `<span class="badge badge-accent" style="font-size:10px;">🎵 ${a.media_enabled ? 'Live' : 'Hidden'}</span>`
            : `<span class="badge badge-muted" style="font-size:10px;">—</span>`;
          const imgTag = a.image_url
            ? `<img src="${escHtml(a.image_url)}" style="width:36px;height:26px;object-fit:cover;border-radius:3px;border:1px solid var(--border);" onerror="this.style.display='none'" />`
            : `<span style="color:var(--border);font-size:18px;">▭</span>`;
          return `
            <tr>
              <td style="text-align:center;">${imgTag}</td>
              <td class="td-title"><a href="#" class="dash-preview-link" data-id="${a.id}"
                style="color:var(--accent);text-decoration:none;cursor:pointer;"
                title="${escHtml(a.title)}">${escHtml(a.title)}</a></td>
              <td><span class="badge badge-muted">${escHtml(a.category || '—')}</span></td>
              <td>${badgePublished(a.is_published)}</td>
              <td>${audioTag}</td>
              <td class="text-muted text-sm"><span title="${fmtDate(a.created_at)}">${relativeTime(a.created_at)}</span></td>
            </tr>`;
        }).join('');

        // Wire preview links
        tbody.querySelectorAll('.dash-preview-link').forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const article = articles.find(x => x.id === parseInt(link.dataset.id));
            if (article) showArticlePreview(article, null);
          });
        });
      }

    } catch (err) {
      showAlert('Failed to load dashboard: ' + err.message, 'error');
    }
  });

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
