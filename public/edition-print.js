(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EditionPrint = api; root.addEventListener('DOMContentLoaded', () => api.boot(root)); }
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function date(value) {
    const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(String(value || ''));
    if (!match) return '';
    const d = new Date(match[1] + 'T12:00:00Z');
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }
  function safeReferenceUrl(value) {
    if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      for (const key of url.searchParams.keys()) if (/(?:token|password|secret|authorization|credential|signature|session|jwt|api[-_]?key|access[-_]?key|^key$|^sig$|^code$|^auth$|^x-amz-)/i.test(key)) return null;
      if (/(?:token|password|secret|signature|credential|session|jwt|api[-_]?key|access[-_]?key)\s*=/i.test(decodeURIComponent(url.hash))) return null;
      return url.href;
    } catch { return null; }
  }
  function referenceContext(article, index) {
    const items = Array.isArray(article.references) ? article.references.filter(r => r && Number.isSafeInteger(r.number) && r.number > 0 && r.number <= 1000000) : [];
    const counts = new Map(); for (const r of items) counts.set(r.number, (counts.get(r.number) || 0) + 1);
    const known = new Set(items.filter(r => counts.get(r.number) === 1 && (typeof r.title === 'string' && r.title.trim() || safeReferenceUrl(r.url))).map(r => r.number));
    return { items, known, counts, unresolved: new Set(), prefix: 'edition-ref-' + (Number.isSafeInteger(article.article_id) && article.article_id > 0 ? article.article_id : 'item-' + index) + '-', warnings: Array.isArray(article.reference_warnings) ? article.reference_warnings.filter(x => typeof x === 'string' && x.trim()) : [] };
  }
  function referenceMarkup(context) {
    const warnings = [...context.warnings];
    if (context.unresolved.size) warnings.push('Source details unavailable for ' + [...context.unresolved].map(n => '[' + n + ']').join(', ') + '. These markers have not been matched to a source.');
    if (!context.items.length && !warnings.length) return '';
    return '<section class="edition-sources" aria-label="Article sources"><h3>Sources</h3>' +
      (context.items.length ? '<ul>' + context.items.map(r => {
        const url = safeReferenceUrl(r.url), title = typeof r.title === 'string' && r.title.trim() ? r.title : 'Source details unavailable';
        const unique = context.counts.get(r.number) === 1;
        const warning = !unique ? 'Ambiguous source number; no citation link was created.' : r.warning || (!url ? 'Source URL unavailable or omitted for safety.' : '');
        return '<li' + (unique ? ' id="' + context.prefix + r.number + '"' : '') + '><span class="edition-source-number">[' + r.number + ']</span> <span class="edition-source-title">' + escape(title) + '</span>' +
          (typeof r.publisher === 'string' && r.publisher.trim() ? ' — ' + escape(r.publisher) : '') +
          (url ? '<a class="edition-source-url" href="' + escape(url) + '" rel="noopener noreferrer">' + escape(url) + '</a>' : '') +
          (warning ? '<span class="edition-source-warning">' + escape(warning) + '</span>' : '') + '</li>';
      }).join('') + '</ul>' : '') + warnings.map(w => '<p class="edition-source-warning">' + escape(w) + '</p>').join('') + '</section>';
  }
  function bodyMarkup(content, references) {
    // Render a bounded Markdown subset from snapshot text. Every literal is escaped;
    // HTML, images and unresolved reference-style/citation markers remain inert text.
    const safeLink = safeReferenceUrl;
    // Bound unsuccessful delimiter scans across this article. On exhaustion,
    // preserve the remaining text literally rather than freezing or truncating it.
    let remainingWork = 1000000;
    function inline(value, depth = 0, links = true) {
      if (depth > 12) return escape(value);
      function find(needle, start) {
        if (remainingWork <= 0) return -1;
        const result = value.indexOf(needle, start);
        remainingWork -= (result < 0 ? value.length : result) - start + needle.length;
        return result;
      }
      const hasClosingBracket = value.includes(']');
      let out = '', i = 0;
      while (i < value.length) {
        if (--remainingWork <= 0) { out += escape(value.slice(i)); break; }
        const rest = value.slice(i);
        if (rest[0] === '\\' && rest.length > 1 && /[\\`*_[\]{}()#+.!>~-]/.test(rest[1])) { out += escape(rest[1]); i += 2; continue; }
        if (rest[0] === '`') {
          const ticks = /^`+/.exec(rest)[0], end = find(ticks, i + ticks.length);
          if (end >= 0) { out += '<code>' + escape(value.slice(i + ticks.length, end).replace(/\n/g, ' ')) + '</code>'; i = end + ticks.length; continue; }
        }
        if (links && hasClosingBracket && rest[0] === '[' && value[i - 1] !== '!') {
          let close = i + 1, balance = 1;
          for (; close < Math.min(value.length, i + 2048) && balance; close++) { if (value[close] === '\\') { close++; continue; } if (value[close] === '[') balance++; if (value[close] === ']') balance--; }
          if (balance && close >= i + 2048) { out += escape(value.slice(i, close)); i = close; continue; }
          if (!balance && value[close] === '(') {
            let end = close + 1, parens = 1;
            for (; end < Math.min(value.length, close + 4096) && parens; end++) { if (value[end] === '\\') { end++; continue; } if (value[end] === '(') parens++; if (value[end] === ')') parens--; }
            if (!parens) {
              const target = value.slice(close + 1, end - 1).trim(), parsed = /^(\S+?)(?:\s+["']([^"']*)["'])?$/.exec(target);
              const href = parsed && safeLink(parsed[1].replace(/^<|>$/g, ''));
              if (href) { out += '<a href="' + escape(href) + '" rel="noopener noreferrer">' + inline(value.slice(i + 1, close - 1), depth + 1, false) + '</a>'; i = end; continue; }
              // Retain unsafe/malformed link notation as text, not a partially parsed anchor.
              out += escape(value.slice(i, end)); i = end; continue;
            }
          }
        }
        const citation = links && references && /^\[([1-9]\d{0,5})\]/.exec(rest);
        if (citation && value[i - 1] !== '!' && rest[citation[0].length] !== '(') {
          const number = Number(citation[1]);
          if (references.known.has(number)) out += '<a class="edition-citation" href="#' + references.prefix + number + '" aria-label="Source ' + number + '">' + citation[0] + '</a>';
          else { out += escape(citation[0]); references.unresolved.add(number); }
          i += citation[0].length; continue;
        }
        let handled = false;
        for (const [marker, open, shut] of [['***','<strong><em>','</em></strong>'],['___','<strong><em>','</em></strong>'],['**','<strong>','</strong>'],['__','<strong>','</strong>'],['~~','<del>','</del>'],['*','<em>','</em>'],['_','<em>','</em>']]) {
          if (!rest.startsWith(marker) || /\s/.test(rest[marker.length] || ' ') || marker[0] === '_' && /[\p{L}\p{N}]/u.test(value[i - 1] || '')) continue;
          let end = find(marker, i + marker.length);
          while (end >= 0 && (marker.length === 1 && (value[end - 1] === marker || value[end + 1] === marker) || /\s/.test(value[end - 1]) || value[end - 1] === '\\' || marker[0] === '_' && /[\p{L}\p{N}]/u.test(value[end + marker.length] || ''))) end = find(marker, end + marker.length);
          if (end >= 0 && marker.length === 2 && value[end + 2] === marker[0]) end++;
          if (end >= 0) { out += open + inline(value.slice(i + marker.length, end), depth + 1, links) + shut; i = end + marker.length; handled = true; break; }
        }
        if (handled) continue;
        out += escape(value[i++]);
      }
      return out;
    }
    const list = line => /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    const heading = line => /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    const fence = line => /^\s{0,3}(`{3,}|~{3,})[^`]*$/.exec(line);
    const rule = line => /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
    const start = line => heading(line) || fence(line) || list(line) || /^\s{0,3}>/.test(line) || rule(line);
    function blocks(lines, depth = 0) {
      if (depth > 8) return '<p>' + escape(lines.join('\n')) + '</p>';
      let out = '', i = 0;
      while (i < lines.length) {
        const line = lines[i]; if (!line.trim()) { i++; continue; }
        const code = fence(line), title = heading(line), item = list(line);
        if (code) { const body = [], end = new RegExp('^\\s{0,3}' + code[1][0] + '{' + code[1].length + ',}\\s*$'); i++; while (i < lines.length && !end.test(lines[i])) body.push(lines[i++]); if (i < lines.length) i++; out += '<pre><code>' + escape(body.join('\n')) + '</code></pre>'; continue; }
        if (title) { out += '<h3>' + inline(title[1]) + '</h3>'; i++; continue; }
        if (i + 1 < lines.length && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) && !start(line)) { out += '<h3>' + inline(line.trim()) + '</h3>'; i += 2; continue; }
        if (rule(line)) { out += '<hr>'; i++; continue; }
        if (/^\s{0,3}>/.test(line)) { const quote = []; while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}> ?/, '')); out += '<blockquote>' + blocks(quote, depth + 1) + '</blockquote>'; continue; }
        if (item) {
          const ordered = /^\d/.test(item[2]), indent = item[1].length, tag = ordered ? 'ol' : 'ul', number = ordered ? Number.parseInt(item[2], 10) : 1;
          out += '<' + tag + (ordered && number > 1 && number <= 1000000 ? ' start="' + number + '"' : '') + '>';
          while (i < lines.length) {
            const row = list(lines[i]); if (!row || row[1].length !== indent || /^\d/.test(row[2]) !== ordered) break;
            const body = [row[3]]; i++;
            while (i < lines.length && lines[i].trim() && /^\s/.test(lines[i]) && lines[i].search(/\S/) > indent) { body.push(lines[i].slice(Math.min(lines[i].search(/\S/), indent + 2))); i++; }
            out += '<li>' + (body.length > 1 ? blocks(body, depth + 1) : inline(body[0])) + '</li>';
          }
          out += '</' + tag + '>'; continue;
        }
        const paragraph = [line]; i++;
        while (i < lines.length && lines[i].trim() && !start(lines[i]) && !(i + 1 < lines.length && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1]))) paragraph.push(lines[i++]);
        out += '<p>' + inline(paragraph.join('\n').trim()) + '</p>';
      }
      return out;
    }
    return blocks(String(content || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  }
  function normalizedSettings(edition) {
    return { paper: edition.settings?.paper === 'A4' ? 'A4' : 'Letter', ink: edition.settings?.ink_saving === true, images: edition.settings?.images !== false };
  }
  const formatNames = { newspaper: 'Classic Newspaper', 'morning-brief': 'Morning Brief', 'large-print': 'Large Print', magazine: 'Magazine' };
  function layoutSettings(edition) {
    const format = Object.hasOwn(formatNames, edition.settings?.format) ? edition.settings.format : 'newspaper';
    return { format, excerpt: format === 'morning-brief' || edition.settings?.content_mode === 'excerpt', sources: edition.settings?.sources !== false };
  }
  function excerptText(article) {
    const summary = typeof article.summary === 'string' ? article.summary.trim() : '';
    const source = summary || String(article.content || '');
    // A literal prefix avoids inventing prose or interpreting a cut Markdown delimiter.
    // Retain whole citation markers and Unicode characters at the boundary.
    let text = Array.from(source).slice(0, 900).join('');
    if (text.length < source.length) {
      const boundary = text.lastIndexOf(' ');
      if (boundary > 600) text = text.slice(0, boundary);
      text = text.replace(/\[\d{0,6}$/, '');
    }
    return { text, shortened: text.length < source.length, summary: !!summary };
  }
  function excerptMarkup(text) {
    // Literal previews retain numbered markers beside the unchanged Sources list.
    // Do not infer links from markers inside code, escaped text or cut Markdown.
    return '<p>' + escape(text) + '</p>';
  }
  function editionLink(edition, publicMode, articleId) {
    if (!opaqueId(edition.id)) return null;
    return '/edition-print.html?id=' + edition.id + (publicMode ? '&public=1' : '') + (articleId ? '&article=' + articleId : '');
  }
  function selectedArticle(edition, value) {
    return /^[1-9]\d*$/.test(String(value || '')) && Number.isSafeInteger(Number(value)) && (edition.articles || []).some(a => a.article_id === Number(value)) ? Number(value) : null;
  }
  function isProof(edition) { return edition.mode === 'proof' || edition.status !== 'finalized'; }
  function contributorDetails(c, full) {
    if (!c) return '';
    return '<strong>' + escape(c.name) + '</strong>' +
      (c.kind === 'ai_persona' ? '<span class="edition-persona-label">AI writer persona</span>' : '') +
      (c.role || c.focus ? '<span class="edition-contributor-focus">' + escape([c.role, c.focus].filter(Boolean).join(' / ')) + '</span>' : '') +
      '<span class="edition-contribution">' + escape(c.contribution || 'Assigned writer for this article') + '</span>' +
      (full && c.bio ? '<p class="edition-contributor-bio"><span>Configured ' + (c.kind === 'ai_persona' ? 'persona' : 'profile') + ' description:</span> ' + escape(c.bio) + '</p>' : '');
  }
  function portraitMarkup(path, key, enabled) {
    return enabled && path ? '<figure class="edition-portrait" data-portrait-key="' + key + '"><img alt="Writer profile portrait" hidden><figcaption class="sr-only">Saved writer portrait</figcaption></figure>' : '';
  }
  function contributorMarkup(edition) {
    if (edition.settings?.contributors !== true || !Array.isArray(edition.contributors) || !edition.contributors.length) return '';
    const portraits = normalizedSettings(edition).images && edition.settings.portraits === true;
    return '<section class="edition-contributors" aria-labelledby="edition-contributors-title"><h2 id="edition-contributors-title">Meet the contributors</h2><p class="edition-contributors-intro">These are the writer profiles captured for this issue. AI personas are software-configured identities, not human reporters. Assignment credits do not attest to interviews, fact-checking or human review.</p>' + edition.contributors.map((group, gi) =>
      '<section class="edition-contributor-group">' + (group.profile_versions_differ ? '<p class="edition-image-notice">This issue preserves different saved profile versions for this contributor.</p>' : '') + (group.versions || []).map((c, vi) => {
        const articles = (edition.articles || []).filter(a => (c.article_ids || []).includes(a.article_id));
        return '<div class="edition-contributor-card">' + portraitMarkup(c.portrait_path, 'group-' + gi + '-' + vi, portraits) + '<div>' + contributorDetails(c, true) + '<p class="edition-contributor-count">Assigned to ' + articles.length + (articles.length === 1 ? ' article' : ' articles') + ' in this issue</p><ul>' + articles.map(a => '<li><a href="#edition-article-' + Number(a.article_id) + '">' + escape(a.title) + '</a></li>').join('') + '</ul></div></div>';
      }).join('') + '</section>').join('') + '</section>';
  }
  function paperMarkup(edition, options = {}) {
    const proof = isProof(edition), images = normalizedSettings(edition).images;
    const layout = layoutSettings(edition), selected = selectedArticle(edition, options.article);
    const articles = Array.isArray(edition.articles) ? edition.articles : [];
    return '<header class="edition-masthead"><p class="edition-kicker">DeepFeedAI / Newspaper Edition</p><h1 class="edition-name">' + escape(edition.name) + '</h1><div class="edition-dateline"><span>' + escape(date(edition.issue_date)) + '</span><span>' + articles.length + (articles.length === 1 ? ' article' : ' articles') + '</span><span>' + (edition.status === 'finalized' ? 'Finalized issue' : 'Working edition') + '</span></div>' + (proof ? '<p class="edition-proof-label">DRAFT / PRIVATE EDITORIAL PROOF</p>' : '') + '</header>' +
      (selected ? '<p class="edition-view-label">FULL SAVED ARTICLE VIEW ' + (editionLink(edition, options.publicMode) ? '<a class="edition-return-link" href="' + escape(editionLink(edition, options.publicMode)) + '">Return to complete edition</a>' : '') + '</p>' : '') +
      articles.map((article, index) => { if (selected && article.article_id !== selected) return ''; const references = referenceContext(article, index), excerpt = layout.excerpt && !selected, selection = excerpt ? excerptText(article) : null;
        const body = excerpt ? excerptMarkup(selection.text) : bodyMarkup(article.content || article.summary || '', layout.sources ? references : null);
        const fullLink = excerpt && Number.isSafeInteger(article.article_id) && article.article_id > 0 ? editionLink(edition, options.publicMode, article.article_id) : null;
        return '<article id="edition-article-' + Number(article.article_id) + '" class="edition-article' + (Number(article.article_id) === Number(edition.lead_article_id) ? ' lead' : '') + '"><p class="edition-category">' + escape(article.category || 'News & analysis') + '</p><h2 class="edition-headline">' + escape(article.title) + '</h2><div class="edition-byline">' + portraitMarkup(article.portrait_path, 'article-' + index, images && edition.settings?.portraits === true) + '<div>' + (article.contributor ? contributorDetails(article.contributor, !!selected) : escape(article.byline || 'DeepFeedAI editorial team')) + (article.source_updated_at ? ' / ' + escape(date(article.source_updated_at)) : '') + '</div></div>' +
        (images && edition.settings?.portraits === true && article.contributor?.portrait_notice ? '<p class="edition-image-notice">' + escape(article.contributor.portrait_notice) + '</p>' : '') +
        (article.withdrawn ? '<p class="edition-withdrawn">Private archive: this article is no longer publicly available.</p>' : '') +
        (images && article.image_path ? '<figure class="edition-figure" data-image-index="' + index + '"><img alt="" hidden><figcaption>Article image</figcaption></figure>' : '') +
        (images && article.image_notice ? '<p class="edition-image-notice">' + escape(article.image_notice) + '</p>' : '') +
        (excerpt ? '<p class="edition-excerpt">EXCERPT / ' + (selection.summary ? 'Saved article description' : 'Opening text from saved article') + (selection.shortened ? ' (shortened)' : '') + '. Shown literally; no generated summary.</p>' : article.text_kind === 'excerpt' || !article.content && article.summary ? '<p class="edition-excerpt">EXCERPT / Saved article summary; full text is not included.</p>' : '') +
        '<div class="edition-body">' + body + '</div>' + (fullLink ? '<p class="edition-full-link"><a href="' + escape(fullLink) + '">' + (article.text_kind === 'excerpt' || !article.content ? 'Read complete saved excerpt' : 'Read full saved article') + '</a></p>' : '') +
        (layout.sources ? referenceMarkup(references) : '<p class="edition-excerpt">Sources omitted by edition setting; citation numbers are preserved as text.</p>') + '</article>'; }).join('') +
      (selected ? '' : contributorMarkup(edition)) + '<footer class="edition-footer">' + (proof ? 'Private editorial proof. Not for public distribution. ' : '') + 'This edition contains saved article versions. Printed and downloaded copies cannot be recalled.</footer>';
  }
  const opaqueId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  const privateId = value => opaqueId(value) || /^[1-9]\d{0,9}$/.test(String(value || ''));
  function safeAssetPath(value, publicMode) {
    const path = String(value || '');
    if (!/^\/api\/editions\/(?:public\/)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:assets|portraits)\/[1-9]\d*$/.test(path)) return null;
    if (publicMode !== path.startsWith('/api/editions/public/')) return null;
    return path;
  }
  function rasterDataUrl(win, blob, signal) {
    // Protected image requests need Bearer auth. Render the fetched bytes using
    // the existing data: image policy, without widening CSP to allow blob:.
    const type = String(blob?.type || '').toLowerCase().split(';')[0];
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type) || !blob.size || blob.size > 5 * 1024 * 1024) return Promise.reject(new Error('Unsupported snapshot image'));
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Image loading aborted')); return; }
      const reader = new win.FileReader();
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        reader.onload = reader.onerror = reader.onabort = null;
        if (error) reject(error); else resolve(value);
      }
      function abort() { reader.abort(); finish(new Error('Image loading aborted')); }
      reader.onload = () => {
        const result = String(reader.result || '');
        if (!result.startsWith('data:' + type + ';base64,')) finish(new Error('Invalid snapshot image'));
        else finish(null, result);
      };
      reader.onerror = () => finish(new Error('Image could not be read'));
      reader.onabort = () => finish(new Error('Image loading aborted'));
      signal.addEventListener('abort', abort, { once: true });
      try { reader.readAsDataURL(blob.slice(0, blob.size, type)); } catch (error) { finish(error); }
    });
  }
  function boot(win) {
    const doc = win.document, $ = id => doc.getElementById(id);
    const params = new URLSearchParams(win.location.search), publicMode = params.get('public') === '1';
    let id = params.get('id');
    let generation = 0, busy = false, ready = false, controller;
    const token = () => { try { return win.localStorage.getItem('deepfeedai_token'); } catch { return null; } };
    const status = (message, error = false) => { $('editionStatus').textContent = message; $('editionStatus').className = 'print-status' + (error ? ' error' : ''); };
    function clear() {
      ready = false; doc.body.classList.remove('print-ready'); $('editionPrint').disabled = true;
      $('editionPaper').hidden = true; $('editionPaper').innerHTML = ''; $('editionWatermark').hidden = true;

    }
    async function load() {
      controller?.abort(); controller = new win.AbortController(); const signal = controller.signal, request = ++generation;
      const timeout = win.setTimeout(() => { if (request === generation) controller.abort(); }, 25000);
      clear(); busy = true; $('editionReload').disabled = true; status('Checking edition access and loading saved content...');
      try {
        if (!(publicMode ? opaqueId(id) : privateId(id))) throw new Error('Choose a valid saved edition from the Editions page.');
        const auth = publicMode ? null : token();
        if (!publicMode && !auth) { win.location.assign('/login.html?next=' + encodeURIComponent(win.location.pathname + win.location.search)); return false; }
        const headers = auth ? { Authorization: 'Bearer ' + auth } : {};
        const response = await win.fetch('/api/editions/' + (publicMode ? 'public/' : '') + id, { headers, cache: 'no-store', signal, credentials: publicMode ? 'omit' : 'same-origin' });
        if (!response.ok) throw new Error(response.status === 401 ? 'Your session has expired. Sign in again to view this edition.' : response.status === 403 || response.status === 404 || response.status === 410 ? 'This edition is unavailable or you no longer have access. A public edition may have been withdrawn.' : 'The edition could not be loaded. Please retry.');
        const { edition } = await response.json();
        if (request !== generation) return false;
        if (!edition || !Array.isArray(edition.articles) || (publicMode && (edition.mode !== 'published' || edition.status !== 'finalized' || edition.visibility !== 'public' || edition.articles.some(article => article.withdrawn)))) throw new Error('This edition is not available for public reading.');
        if (!opaqueId(edition.id)) throw new Error('This edition has no valid canonical identifier. Reload from Editions.');
        if (!publicMode && id !== edition.id) { id = edition.id; params.set('id', id); win.history.replaceState({}, '', win.location.pathname + '?' + params); $('editionBack').href = '/editions.html?id=' + id; }
        const settings = normalizedSettings(edition);
        const layout = layoutSettings(edition);
        let style = doc.getElementById('editionPaperSize');
        if (!style) { style = doc.createElement('style'); style.id = 'editionPaperSize'; doc.head.appendChild(style); }
        style.textContent = '@page { size: ' + settings.paper + '; margin: .5in; }';
        doc.documentElement.style.setProperty('--paper-width', settings.paper === 'A4' ? '210mm' : '8.5in');
        doc.body.classList.toggle('ink-saving', settings.ink);
        doc.body.dataset.format = layout.format;
        doc.title = (isProof(edition) ? 'DRAFT - ' : '') + edition.name + ' | Newspaper edition';
        $('editionPaper').innerHTML = paperMarkup(edition, { publicMode, article: params.get('article') });
        $('editionWatermark').hidden = !isProof(edition);
        $('editionPrintSettings').textContent = formatNames[layout.format] + ' / ' + settings.paper + ' / ' + (settings.ink ? 'Ink-saving grayscale' : 'Color') + ' / Images ' + (settings.images ? 'on' : 'off') + ' / ' + (edition.status === 'finalized' ? 'Saved finalized snapshot' : 'Working snapshot - save edits in the editor before reloading');
        let missing = 0, assetAccessChanged = false;
        const imageJobs = edition.articles.filter(a => a.image_path).map(article => ({ path: article.image_path, selector: '[data-image-index="' + edition.articles.indexOf(article) + '"]' }));
        if (settings.images && edition.settings?.portraits === true) {
          edition.articles.forEach((a, i) => { if (a.portrait_path) imageJobs.push({ path: a.portrait_path, selector: '[data-portrait-key="article-' + i + '"]' }); });
          if (edition.settings.contributors === true) (edition.contributors || []).forEach((g, gi) => (g.versions || []).forEach((c, vi) => { if (c.portrait_path) imageJobs.push({ path: c.portrait_path, selector: '[data-portrait-key="group-' + gi + '-' + vi + '"]' }); }));
        }
        const rasterRequests = new Map();
        if (settings.images) await Promise.all(imageJobs.map(async job => {
          const figure = doc.querySelector(job.selector);
          if (!figure) return;
          try {
            const path = safeAssetPath(job.path, publicMode);
            if (!path) throw new Error('Unsafe image path');
            if (!rasterRequests.has(path)) rasterRequests.set(path, (async () => {
              const res = await win.fetch(path, { headers, cache: 'no-store', signal, credentials: publicMode ? 'omit' : 'same-origin' });
              if (publicMode && [401, 403, 404, 410].includes(res.status)) assetAccessChanged = true;
              if (!res.ok || !/^image\/(png|jpeg|webp)(;|$)/i.test(res.headers.get('content-type') || '')) throw new Error('Unavailable image');
              return rasterDataUrl(win, await res.blob(), signal);
            })());
            const url = await rasterRequests.get(path);
            if (request !== generation || signal.aborted) return;
            const img = figure.querySelector('img'); img.src = url; await img.decode();
            if (request !== generation) return;
            img.hidden = false;
          } catch (err) {
            if (request !== generation || signal.aborted) return;
            missing++; figure.innerHTML = '<figcaption>Image unavailable. Article text is preserved.</figcaption>';
          }
        }));
        if (request !== generation) return false;
        if (signal.aborted) throw new Error('Loading timed out. Please retry before printing.');
        if (assetAccessChanged) throw new Error('This public edition is no longer available. Reload to check its publication status.');
        $('editionPaper').hidden = false; doc.body.classList.add('print-ready'); ready = true; $('editionPrint').disabled = edition.articles.length === 0;
        status(edition.articles.length ? (missing ? missing + ' image(s) unavailable. You can print the complete text or retry loading.' : 'Ready to preview and print. No articles were published or changed.') : 'This edition has no articles. Add articles in the editor first.');
        return edition.articles.length > 0;
      } catch (err) { if (request === generation) { clear(); status(signal.aborted ? 'Loading timed out. Please retry before printing.' : err.message || 'Unable to load this edition. Please retry.', true); } return false;
      } finally { win.clearTimeout(timeout); if (request === generation) { busy = false; $('editionReload').disabled = false; } }
    }
    $('editionBack').href = publicMode ? '/' : '/editions.html' + (privateId(id) ? '?id=' + id : '');
    $('editionBack').textContent = publicMode ? 'Back to publication' : 'Back to edition';
    // A shared preview may be served on the admin host. Do not guess its reader origin.
    $('editionBack').hidden = publicMode;
    $('editionReload').addEventListener('click', () => { if (!busy) load(); });
    $('editionPrint').addEventListener('click', async () => {
      if (busy || !ready) return;
      // Revalidate publication/authorization immediately before explicit print; no paid calls.
      if (await load()) { await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))); win.print(); }
    });
    win.addEventListener('pagehide', () => { generation++; controller?.abort(); clear(); });
    win.addEventListener('pageshow', event => { if (event.persisted) load(); });
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible' && !busy) load(); });
    win.addEventListener('storage', event => { if (!publicMode && event.key === 'deepfeedai_token') { generation++; controller?.abort(); clear(); load(); } });
    load();
    return { load, clear, get ready() { return ready; } };
  }
  return { escape, date, bodyMarkup, paperMarkup, normalizedSettings, layoutSettings, excerptText, selectedArticle, isProof, safeAssetPath, rasterDataUrl, boot };
});
