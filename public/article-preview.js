/**
 * Deep Feed AI Admin — Shared article preview modal
 *
 * Usage:
 *   1. Include the modal HTML (see renderArticlePreviewModal())
 *   2. Call showArticlePreview(article, writer?) to open the preview
 *   3. Or call showArticlePreviewBySlug(slug) to fetch + preview
 *
 * Requires: admin.js (escHtml, apiFetch, openModal)
 */

/* ── Modal HTML injection ──────────────────────────────── */
function renderArticlePreviewModal() {
  if (document.getElementById('articlePreviewModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="articlePreviewModal">
      <div class="modal modal-xl modal-dark" style="max-width:860px;">
        <div class="modal-header">
          <div class="modal-title">Article Preview</div>
          <button class="modal-close" data-close-modal>✕</button>
        </div>
        <div class="modal-body" id="articlePreviewBody" style="padding:0;max-height:80vh;overflow-y:auto;"></div>
        <div class="modal-footer" style="gap:8px;">
          <a id="previewLiveLink" href="#" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="display:none;">View on site</a>
          <a id="previewSourceLink" href="#" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="display:none;">View source</a>
          <button class="btn btn-outline" data-close-modal>Close</button>
        </div>
      </div>
    </div>`);
  // Wire close buttons
  document.getElementById('articlePreviewModal').querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => document.getElementById('articlePreviewModal').classList.remove('open'));
  });
  document.getElementById('articlePreviewModal').addEventListener('click', e => {
    if (e.target === document.getElementById('articlePreviewModal')) {
      document.getElementById('articlePreviewModal').classList.remove('open');
    }
  });
}

/* ── Fetch article by slug and show preview ────────────── */
async function showArticlePreviewBySlug(slug) {
  renderArticlePreviewModal();
  document.getElementById('articlePreviewBody').innerHTML =
    '<div style="padding:40px;text-align:center;color:var(--muted);">Loading…</div>';
  openModal('articlePreviewModal');

  try {
    var data = await apiFetch('/articles/preview-by-slug?slug=' + encodeURIComponent(slug));
    var a = data.article;
    var writer = data.writer || null;
    if (!a) {
      document.getElementById('articlePreviewBody').innerHTML =
        '<div style="padding:40px;text-align:center;color:var(--muted);">Article not found</div>';
      return;
    }
    showArticlePreview(a, writer);
  } catch (err) {
    document.getElementById('articlePreviewBody').innerHTML =
      '<div style="padding:40px;text-align:center;color:var(--danger);">' + escHtml(err.message) + '</div>';
  }
}

/* ── Helpers ───────────────────────────────────────────── */
function _apDecodeEntities(str) {
  var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return (str || '')
    .replace(/&#x([0-9a-f]+);/gi, function(_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function(_, dec) { return String.fromCharCode(Number(dec)); })
    .replace(/&(amp|lt|gt|quot|apos);/gi, function(_, name) { return named[name.toLowerCase()] || _; });
}

function _apToSlug(title) {
  return _apDecodeEntities(title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function _apFmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function _apMdInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:var(--bg-card);border:1px solid var(--border);border-radius:4px;padding:0.1em 0.4em;font-size:0.875em;color:var(--accent);">$1</code>');
}

function _apMdCitations(s, refs) {
  return s.replace(/\[(\d+)\]/g, (m, num) => {
    const idx = parseInt(num) - 1;
    if (idx < 0 || idx >= refs.length) return m;
    const ref = refs[idx];
    const href = ref.source_url ? escHtml(ref.source_url) : '#';
    const tip = escHtml((ref.source || '') + ': ' + (ref.title || ''));
    return '<sup style="color:var(--accent);"><a href="' + href + '" target="_blank" rel="noopener" title="' + tip + '" style="color:var(--accent);text-decoration:none;">[' + num + ']</a></sup>';
  });
}

function _apMdBlock(text, refs) {
  var lines = text.split('\n');
  var out = '';
  var inList = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^### (.+)$/.test(line)) {
      if (inList) { out += '</ul>'; inList = false; }
      out += '<h3>' + _apMdInline(escHtml(line.replace(/^### /, '').trim())) + '</h3>';
      continue;
    }
    if (/^> (.+)$/.test(line)) {
      if (inList) { out += '</ul>'; inList = false; }
      out += '<blockquote>' + _apMdInline(_apMdCitations(escHtml(line.replace(/^> /, '').trim()), refs)) + '</blockquote>';
      continue;
    }
    if (/^\s*[-*] (.+)$/.test(line)) {
      if (!inList) { out += '<ul>'; inList = true; }
      out += '<li>' + _apMdInline(_apMdCitations(escHtml(line.replace(/^\s*[-*] /, '').trim()), refs)) + '</li>';
      continue;
    }
    if (inList) { out += '</ul>'; inList = false; }
    if (!line.trim()) continue;
    var para = line;
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^(###|>|\s*[-*] )/.test(lines[i + 1])) {
      i++;
      para += ' ' + lines[i];
    }
    out += '<p>' + _apMdInline(_apMdCitations(escHtml(para.trim()), refs)) + '</p>';
  }
  if (inList) out += '</ul>';
  return out;
}

/* ── Main preview renderer ─────────────────────────────── */
function showArticlePreview(a, writer) {
  renderArticlePreviewModal();

  var slug = a.slug || _apToSlug(a.title);
  var date = a.published_at || a.created_at;
  var fmtPubDate = date ? new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

  var relTime = (function(d) {
    if (!d) return '';
    var diff = Date.now() - new Date(d).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  })(date);

  var textForWordCount = (a.content_type === 'original' && a.full_content) ? a.full_content : (a.summary || '');
  var wordCount = (textForWordCount + ' ' + (a.title || '')).trim().split(/\s+/).filter(Boolean).length;
  var readMins = Math.max(1, Math.round(wordCount / 200));

  var scopedCSS = '<style>'
    + '.ap { font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text); }'
    + '.ap-hero-img { width: 100%; max-height: 400px; object-fit: cover; display: block; border-radius: 0; }'
    + '.ap-body { max-width: 720px; margin: 0 auto; padding: 0 28px 28px; }'
    + '.ap-tag { display: inline-block; color: var(--accent); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; margin-bottom: 8px; margin-top: 24px; }'
    + '.ap-title { font-size: clamp(1.5rem, 3.5vw, 2.2rem); font-weight: 800; line-height: 1.2; margin: 0 0 12px; color: var(--text); }'
    + '.ap-writer-byline { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }'
    + '.ap-writer-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid var(--accent); }'
    + '.ap-writer-name { font-size: 0.9rem; font-weight: 600; color: var(--text); }'
    + '.ap-meta { display: flex; align-items: center; gap: 0.6rem; font-size: 0.9rem; color: var(--muted); flex-wrap: wrap; margin-bottom: 16px; }'
    + '.ap-meta .source { color: var(--text); font-weight: 600; }'
    + '.ap-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; margin-top: 16px; }'
    + '.ap-audio { margin: 20px 0; background: rgba(0,217,255,0.05); border: 1px solid rgba(0,217,255,0.18); border-radius: 14px; padding: 14px 18px; }'
    + '.ap-audio-label { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); background: rgba(0,217,255,0.12); padding: 3px 10px; border-radius: 999px; display: inline-block; margin-bottom: 10px; }'
    + '.ap-audio-voice { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }'
    + '.ap-audio-voice img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }'
    + '.ap-audio-voice span { font-size: 0.82rem; font-weight: 600; color: var(--text); }'
    + '.ap-tldr { background: linear-gradient(135deg, rgba(79,142,247,0.08) 0%, rgba(139,92,246,0.08) 100%); border: 1px solid rgba(79,142,247,0.2); border-radius: 14px; padding: 18px 20px; margin: 20px 0; }'
    + '.ap-tldr-badge { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); background: rgba(79,142,247,0.12); padding: 3px 10px; border-radius: 999px; display: inline-block; margin-bottom: 10px; }'
    + '.ap-tldr-text { font-size: 0.95rem; line-height: 1.75; color: var(--text); margin: 0; }'
    + '.ap-content { font-size: 1rem; line-height: 1.85; color: var(--text); margin: 20px 0; }'
    + '.ap-content p { margin-bottom: 1.25rem; }'
    + '.ap-content h2 { font-size: 1.4rem; font-weight: 700; margin: 2rem 0 0.75rem; }'
    + '.ap-content h3 { font-size: 1.15rem; font-weight: 700; margin: 1.5rem 0 0.6rem; }'
    + '.ap-content ul { padding-left: 1.25rem; margin-bottom: 1.25rem; }'
    + '.ap-content li { margin-bottom: 0.4rem; }'
    + '.ap-content blockquote { border-left: 3px solid var(--accent); padding: 0.5rem 1.25rem; margin: 1.5rem 0; color: var(--muted); font-style: italic; }'
    + '.ap-content a { color: var(--accent); text-decoration: none; }'
    + '.ap-content a:hover { text-decoration: underline; }'
    + '.ap-summary { font-size: 1rem; line-height: 1.85; color: var(--text); margin: 20px 0; }'
    + '.ap-summary p { margin-bottom: 1.25rem; }'
    + '.ap-summary-note { color: var(--muted); font-size: 0.85rem; font-style: italic; }'
    + '.ap-cta { display: inline-block; background: var(--accent); color: #fff; font-weight: 700; font-size: 0.95rem; padding: 12px 28px; border-radius: 99px; text-decoration: none; margin: 8px 0 20px; box-shadow: 0 4px 20px rgba(0,217,255,0.25); }'
    + '.ap-cta:hover { opacity: 0.9; }'
    + '.ap-context { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; margin: 20px 0; font-size: 0.85rem; color: var(--muted); }'
    + '.ap-context strong { color: var(--text); }'
    + '.ap-sources { margin: 20px 0 8px; }'
    + '.ap-sources h3 { font-size: 0.82rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 8px; }'
    + '.ap-sources ul { list-style: none; padding: 0; margin: 0; }'
    + '.ap-sources li { font-size: 0.85rem; color: var(--text); padding: 4px 0; line-height: 1.5; }'
    + '.ap-sources li a { color: var(--accent); text-decoration: none; }'
    + '.ap-sources li a:hover { text-decoration: underline; }'
    + '.ap-sources .ref-num { color: var(--muted); font-size: 0.78rem; margin-right: 4px; }'
    + '.ap-sources .ref-origin { color: var(--muted); font-size: 0.8rem; }'
    + '.ap-video { margin: 20px 0; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }'
    + '.ap-video-badge { font-size: 12px; font-weight: 600; color: #e53e3e; margin-bottom: 10px; }'
    + '.ap-video-wrap { position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 8px; }'
    + '.ap-video-wrap iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; }'
    + '</style>';

  var html = scopedCSS + '<div class="ap">';

  // Hero image
  if (a.image_url) {
    html += '<img class="ap-hero-img" src="' + escHtml(a.image_url) + '" alt="" onerror="this.style.display=\'none\'" />';
  }

  html += '<div class="ap-body">';

  // Admin status badges
  html += '<div class="ap-badges">';
  if (a.is_published) html += '<span class="badge badge-success">Published</span>';
  else html += '<span class="badge badge-muted">Draft</span>';
  if (a.is_featured) html += '<span class="badge badge-accent">Featured #' + (a.featured_priority || '?') + '</span>';
  if (a.content_type === 'original') html += '<span class="badge" style="background:var(--accent);color:#000;">Original</span>';
  if (a.content_type === 'deep-dive') html += '<span class="badge" style="background:var(--accent);color:#000;">Deep Dive</span>';
  if (a.editorial_score) html += '<span class="badge badge-muted">Score: ' + a.editorial_score + '/10</span>';
  html += '</div>';

  // Category + title
  html += '<div class="ap-tag">' + escHtml(a.category || 'Industry') + '</div>';
  html += '<h1 class="ap-title">' + escHtml(a.title) + '</h1>';

  // Writer byline
  if (writer) {
    html += '<div class="ap-writer-byline">';
    if (writer.avatar_url) html += '<img class="ap-writer-avatar" src="' + escHtml(writer.avatar_url) + '" alt="' + escHtml(writer.name) + '" onerror="this.style.display=\'none\'" />';
    html += '<div class="ap-writer-name">by ' + escHtml(writer.name) + '</div>';
    html += '</div>';
  }

  // Meta line
  html += '<div class="ap-meta">';
  if (!writer && a.source) html += '<span class="source">' + escHtml(a.source) + '</span><span>·</span>';
  if (relTime || fmtPubDate) html += '<time title="' + escHtml(fmtPubDate) + '">' + escHtml(relTime || fmtPubDate) + '</time><span>·</span>';
  html += '<span>' + readMins + ' min read</span>';
  html += '</div>';

  // Audio player
  if (a.audio_url) {
    html += '<div class="ap-audio"><span class="ap-audio-label">🎙️ AI Audio Summary</span>';
    if (a.audio_voice_name) {
      html += '<div class="ap-audio-voice">';
      if (a.audio_voice_avatar_url) html += '<img src="' + escHtml(a.audio_voice_avatar_url) + '" alt="" onerror="this.style.display=\'none\'" />';
      html += '<span>' + escHtml(a.audio_voice_name) + '</span></div>';
    }
    html += '<audio controls style="width:100%;height:36px;" src="' + escHtml(a.audio_url) + '"></audio></div>';
  }

  // Video embed
  if (a.embed_url) {
    try {
      var u = new URL(a.embed_url);
      if (u.protocol === 'https:' && (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && u.pathname.startsWith('/embed/')) {
        html += '<div class="ap-video"><div class="ap-video-badge">&#9654; Video</div>';
        html += '<div class="ap-video-wrap"><iframe src="' + escHtml(a.embed_url) + '" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" allowfullscreen loading="lazy"></iframe></div></div>';
      }
    } catch(e) {}
  }

  // TLDR
  if (a.tldr_overview) {
    html += '<div class="ap-tldr"><span class="ap-tldr-badge">✨ AI Summary</span>';
    html += '<div class="ap-tldr-text">' + escHtml(a.tldr_overview) + '</div></div>';
  }

  // Content based on type
  if (a.content_type === 'deep-dive' && a.full_content) {
    var refs = [];
    try { var raw = a.source_article_ids; if (typeof raw === 'string') raw = JSON.parse(raw); if (Array.isArray(raw)) refs = raw; } catch(e) {}
    var meta = a.synthesis_meta;
    if (meta && typeof meta === 'string') try { meta = JSON.parse(meta); } catch(e) { meta = null; }
    var sourceCount = (meta && meta.source_count) ? meta.source_count : refs.length;
    var clusterCount = (meta && meta.cluster_count) ? meta.cluster_count : 0;
    if (sourceCount) html += '<div class="ap-context"><strong>Weekly Deep Dive</strong> — ' + sourceCount + ' sources across ' + clusterCount + ' story threads</div>';
    var sections = a.full_content.split(/^## /m);
    html += '<div class="ap-content">';
    if (sections[0] && sections[0].trim()) html += _apMdBlock(sections[0].trim(), refs);
    for (var si = 1; si < sections.length; si++) {
      var secText = sections[si];
      var nlIdx = secText.indexOf('\n');
      var secTitle = nlIdx !== -1 ? secText.substring(0, nlIdx).trim() : secText.trim();
      var secBody = nlIdx !== -1 ? secText.substring(nlIdx + 1).trim() : '';
      html += '<h2>' + _apMdInline(escHtml(secTitle)) + '</h2>';
      if (secBody) html += _apMdBlock(secBody, refs);
    }
    html += '</div>';
    if (refs.length) {
      html += '<div class="ap-sources"><h3>Sources</h3><ul>';
      refs.forEach(function(r, i) {
        var title = escHtml(r.title || 'Article');
        var source = r.source ? ' <span class="ref-origin">— ' + escHtml(r.source) + '</span>' : '';
        var link = r.source_url ? '<a href="' + escHtml(r.source_url) + '" target="_blank" rel="noopener">' + title + '</a>' : title;
        html += '<li><span class="ref-num">[' + (i + 1) + ']</span> ' + link + source + '</li>';
      });
      html += '</ul></div>';
    }
  } else if (a.content_type === 'original' && a.full_content) {
    var refs = [];
    try { var raw = a.source_article_ids; if (typeof raw === 'string') raw = JSON.parse(raw); if (Array.isArray(raw)) refs = raw; } catch(e) {}
    var meta = a.synthesis_meta;
    if (meta && typeof meta === 'string') try { meta = JSON.parse(meta); } catch(e) { meta = null; }
    if (meta && meta.source_count) {
      var names = meta.source_names || [];
      var nameStr = '';
      if (names.length <= 3) nameStr = names.map(escHtml).join(', ');
      else nameStr = names.slice(0, 2).map(escHtml).join(', ') + ' and ' + (names.length - 2) + ' others';
      var span = meta.timespan_hours;
      var spanStr = span <= 4 ? span + ' hours' : span <= 48 ? Math.round(span / 24) + ' day' + (Math.round(span / 24) !== 1 ? 's' : '') : Math.round(span / 168) + ' week' + (Math.round(span / 168) !== 1 ? 's' : '');
      html += '<div class="ap-context">Based on <strong>' + meta.source_count + ' sources</strong>';
      if (nameStr) html += ' from <strong>' + nameStr + '</strong>';
      html += ' over the last <strong>' + spanStr + '</strong></div>';
    }
    html += '<div class="ap-content"><h2 style="font-size:1.3rem;">Full Analysis</h2>';
    html += _apMdBlock(a.full_content.trim(), refs);
    html += '</div>';
    if (refs.length) {
      html += '<div class="ap-sources"><h3>Sources</h3><ul>';
      refs.forEach(function(r, i) {
        var title = escHtml(r.title || 'Article');
        var source = r.source ? ' <span class="ref-origin">— ' + escHtml(r.source) + '</span>' : '';
        var link = r.source_url ? '<a href="' + escHtml(r.source_url) + '" target="_blank" rel="noopener">' + title + '</a>' : title;
        html += '<li><span class="ref-num">[' + (i + 1) + ']</span> ' + link + source + '</li>';
      });
      html += '</ul></div>';
    }
  } else {
    if (a.summary) {
      html += '<div class="ap-summary"><p>' + escHtml(a.summary) + '</p>';
      html += '<p class="ap-summary-note">' + (a.embed_url ? 'Watch the full video on YouTube.' : 'Source: ' + escHtml(a.source || 'Source') + '. Click below to read the full article.') + '</p></div>';
    }
    if (a.source_url || a.embed_url) {
      html += '<div style="text-align:center;"><a class="ap-cta" href="' + escHtml(a.source_url || a.embed_url || '#') + '" target="_blank" rel="noopener noreferrer">';
      html += (a.embed_url ? 'Watch on YouTube →' : 'Read Full Article on ' + escHtml(a.source || 'Source') + ' →');
      html += '</a></div>';
    }
  }

  html += '</div></div>';

  document.getElementById('articlePreviewBody').innerHTML = html;

  // Footer links
  var liveLink = document.getElementById('previewLiveLink');
  var sourceLink = document.getElementById('previewSourceLink');
  var siteBase = getSiteBase();
  if (a.is_published && slug) {
    liveLink.href = siteBase + '/article/' + slug;
    liveLink.style.display = '';
  } else {
    liveLink.style.display = 'none';
  }
  if (a.source_url) {
    sourceLink.href = a.source_url;
    sourceLink.style.display = '';
  } else {
    sourceLink.style.display = 'none';
  }

  openModal('articlePreviewModal');
}
