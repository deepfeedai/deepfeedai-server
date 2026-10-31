(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoginDestination = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const pages = new Set(['overview','classic','newsroom','newsroom-workflow','newsroom-chat','newsroom-feed','newsroom-activity','editorial-intelligence','budget','pitches','editorial','briefs','feed-inbox','editions','edition-print','stories','story-board','discover','pipeline','synthesis','sources','articles','article-editor','writers','writer-detail','writing-styles','newsletter','comments','banners','analytics','ai-usage','audit','settings','notifications','users','roles','wizard','deploy-wizard'].map(name => '/' + name + '.html'));
  function resolveNext(value, origin) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '/overview.html';
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin || !pages.has(url.pathname)) return '/overview.html';
      for (const key of [...url.searchParams.keys()]) if (/token|password|secret|authorization|^code$/i.test(key)) url.searchParams.delete(key);
      return url.pathname + url.search + url.hash;
    } catch (_) { return '/overview.html'; }
  }
  function remember(location, storage) {
    const next = new URLSearchParams(location.search).get('next');
    if (next === null) return;
    try { storage.setItem('dfa_login_return', resolveNext(next, location.origin)); } catch (_) {}
  }
  function consume(location, storage) {
    let next = new URLSearchParams(location.search).get('next');
    try { if (next === null) next = storage.getItem('dfa_login_return'); storage.removeItem('dfa_login_return'); } catch (_) {}
    return resolveNext(next, location.origin);
  }
  return { resolveNext, remember, consume };
});
