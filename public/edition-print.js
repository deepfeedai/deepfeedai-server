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
  function bodyMarkup(content) {
    // Snapshot content is plain text. Interpret only heading/list markers; never accept HTML.
    return String(content || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).filter(x => x.trim()).map(block => {
      const lines = block.trim().split('\n');
      if (lines.length === 1 && /^#{1,6}\s/.test(lines[0])) return '<h3>' + escape(lines[0].replace(/^#{1,6}\s+/, '')) + '</h3>';
      if (lines.every(line => /^[-*]\s+/.test(line))) return '<ul>' + lines.map(line => '<li>' + escape(line.replace(/^[-*]\s+/, '')) + '</li>').join('') + '</ul>';
      return '<p>' + escape(block.trim()) + '</p>';
    }).join('');
  }
  function normalizedSettings(edition) {
    return { paper: edition.settings?.paper === 'A4' ? 'A4' : 'Letter', ink: edition.settings?.ink_saving === true, images: edition.settings?.images !== false };
  }
  function isProof(edition) { return edition.mode === 'proof' || edition.status !== 'finalized'; }
  function paperMarkup(edition) {
    const proof = isProof(edition), images = normalizedSettings(edition).images;
    const articles = Array.isArray(edition.articles) ? edition.articles : [];
    return '<header class="edition-masthead"><p class="edition-kicker">DeepFeedAI / Newspaper Edition</p><h1 class="edition-name">' + escape(edition.name) + '</h1><div class="edition-dateline"><span>' + escape(date(edition.issue_date)) + '</span><span>' + articles.length + (articles.length === 1 ? ' article' : ' articles') + '</span><span>' + (edition.status === 'finalized' ? 'Finalized issue' : 'Working edition') + '</span></div>' + (proof ? '<p class="edition-proof-label">DRAFT / PRIVATE EDITORIAL PROOF</p>' : '') + '</header>' +
      articles.map((article, index) => '<article class="edition-article' + (Number(article.article_id) === Number(edition.lead_article_id) ? ' lead' : '') + '"><p class="edition-category">' + escape(article.category || 'News & analysis') + '</p><h2 class="edition-headline">' + escape(article.title) + '</h2><p class="edition-byline">' + escape(article.byline || 'DeepFeedAI editorial team') + (article.source_updated_at ? ' / ' + escape(date(article.source_updated_at)) : '') + '</p>' +
        (article.withdrawn ? '<p class="edition-withdrawn">Private archive: this article is no longer publicly available.</p>' : '') +
        (images && article.image_path ? '<figure class="edition-figure" data-image-index="' + index + '"><img alt="" hidden><figcaption>Article image</figcaption></figure>' : '') +
        (images && article.image_notice ? '<p class="edition-image-notice">' + escape(article.image_notice) + '</p>' : '') +
        (article.text_kind === 'excerpt' || !article.content && article.summary ? '<p class="edition-excerpt">EXCERPT / Saved article summary; full text is not included.</p>' : '') +
        '<div class="edition-body">' + bodyMarkup(article.content || article.summary || '') + '</div></article>').join('') +
      '<footer class="edition-footer">' + (proof ? 'Private editorial proof. Not for public distribution. ' : '') + 'This edition contains saved article versions. Printed and downloaded copies cannot be recalled.</footer>';
  }
  function safeAssetPath(value, publicMode) {
    const path = String(value || '');
    if (!/^\/api\/editions\/(?:public\/)?[1-9]\d*\/assets\/[1-9]\d*$/.test(path)) return null;
    if (publicMode !== path.startsWith('/api/editions/public/')) return null;
    return path;
  }
  function boot(win) {
    const doc = win.document, $ = id => doc.getElementById(id);
    const params = new URLSearchParams(win.location.search), id = params.get('id'), publicMode = params.get('public') === '1';
    let generation = 0, busy = false, ready = false, urls = [], controller;
    const token = () => { try { return win.localStorage.getItem('deepfeedai_token'); } catch { return null; } };
    const status = (message, error = false) => { $('editionStatus').textContent = message; $('editionStatus').className = 'print-status' + (error ? ' error' : ''); };
    function clear() {
      ready = false; doc.body.classList.remove('print-ready'); $('editionPrint').disabled = true;
      $('editionPaper').hidden = true; $('editionPaper').innerHTML = ''; $('editionWatermark').hidden = true;
      for (const url of urls) win.URL.revokeObjectURL(url); urls = [];
    }
    async function load() {
      controller?.abort(); controller = new win.AbortController(); const signal = controller.signal, request = ++generation;
      const timeout = win.setTimeout(() => { if (request === generation) controller.abort(); }, 25000);
      clear(); busy = true; $('editionReload').disabled = true; status('Checking edition access and loading saved content...');
      try {
        if (!/^[1-9]\d{0,9}$/.test(id || '')) throw new Error('Choose a valid saved edition from the Editions page.');
        const auth = publicMode ? null : token();
        if (!publicMode && !auth) { win.location.assign('/login.html?next=' + encodeURIComponent(win.location.pathname + win.location.search)); return false; }
        const headers = auth ? { Authorization: 'Bearer ' + auth } : {};
        const response = await win.fetch('/api/editions/' + (publicMode ? 'public/' : '') + id, { headers, cache: 'no-store', signal, credentials: publicMode ? 'omit' : 'same-origin' });
        if (!response.ok) throw new Error(response.status === 401 ? 'Your session has expired. Sign in again to view this edition.' : response.status === 403 || response.status === 404 || response.status === 410 ? 'This edition is unavailable or you no longer have access. A public edition may have been withdrawn.' : 'The edition could not be loaded. Please retry.');
        const { edition } = await response.json();
        if (request !== generation) return false;
        if (!edition || !Array.isArray(edition.articles) || (publicMode && (edition.mode !== 'published' || edition.status !== 'finalized' || edition.visibility !== 'public' || edition.articles.some(article => article.withdrawn)))) throw new Error('This edition is not available for public reading.');
        const settings = normalizedSettings(edition);
        let style = doc.getElementById('editionPaperSize');
        if (!style) { style = doc.createElement('style'); style.id = 'editionPaperSize'; doc.head.appendChild(style); }
        style.textContent = '@page { size: ' + settings.paper + '; margin: .5in; }';
        doc.documentElement.style.setProperty('--paper-width', settings.paper === 'A4' ? '210mm' : '8.5in');
        doc.body.classList.toggle('ink-saving', settings.ink);
        doc.title = (isProof(edition) ? 'DRAFT - ' : '') + edition.name + ' | Newspaper edition';
        $('editionPaper').innerHTML = paperMarkup(edition);
        $('editionWatermark').hidden = !isProof(edition);
        $('editionPrintSettings').textContent = settings.paper + ' / ' + (settings.ink ? 'Ink-saving grayscale' : 'Color') + ' / Images ' + (settings.images ? 'on' : 'off') + ' / ' + (edition.status === 'finalized' ? 'Saved finalized snapshot' : 'Working snapshot - save edits in the editor before reloading');
        let missing = 0, assetAccessChanged = false;
        if (settings.images) await Promise.all(edition.articles.map(async (article, index) => {
          if (!article.image_path) return;
          const figure = doc.querySelector('[data-image-index="' + index + '"]');
          try {
            const path = safeAssetPath(article.image_path, publicMode);
            if (!path) throw new Error('Unsafe image path');
            const res = await win.fetch(path, { headers, cache: 'no-store', signal, credentials: publicMode ? 'omit' : 'same-origin' });
            if (publicMode && [401, 403, 404, 410].includes(res.status)) assetAccessChanged = true;
            if (!res.ok || !/^image\/(png|jpeg|webp|gif)(;|$)/i.test(res.headers.get('content-type') || '')) throw new Error('Unavailable image');
            const blob = await res.blob();
            if (request !== generation) return;
            const url = win.URL.createObjectURL(blob); urls.push(url);
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
    $('editionBack').href = publicMode ? '/' : '/editions.html' + (/^[1-9]\d{0,9}$/.test(id || '') ? '?id=' + id : '');
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
  return { escape, date, bodyMarkup, paperMarkup, normalizedSettings, isProof, safeAssetPath, boot };
});
