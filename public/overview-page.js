(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else {
    root.OverviewPage = factory(root.document, (path, options) => apiFetch(path, options), { search: root.location.search });
    onReady(() => { if (requireAuth()) { renderSidebar(); root.OverviewPage.init(); root.pageRefresh = root.OverviewPage.load; } });
  }
})(typeof window === 'undefined' ? globalThis : window, function createOverview(document, api, options) {
  'use strict';
  options = options || {};
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const destinations = new Set(['pitches.html', 'articles.html', 'article-editor.html', 'sources.html', 'feed-inbox.html', 'writers.html', 'stories.html']);
  function href(value) {
    if (typeof value !== 'string' || !/^\/?[a-z-]+\.html(?:[?#]|$)/.test(value)) return null;
    try { const u = new URL(value, 'https://overview.invalid/'); return u.origin === 'https://overview.invalid' && destinations.has(u.pathname.slice(1)) ? u.pathname + u.search + u.hash : null; }
    catch { return null; }
  }
  const link = (item, label) => { const target = href(item.href); return target ? '<a href="' + escape(target) + '">' + escape(label) + '</a>' : '<span>' + escape(label) + '</span>'; };
  const state = { data: null, loading: false, saving: false };
  let showForVisit = new URLSearchParams(options.search || '').get('onboarding') === 'show';
  let pendingLoad = null;
  function renderGuide() {
    const guide = state.data.onboarding || { items: [] };
    const items = Array.isArray(guide.items) ? guide.items.slice(0, 20) : [];
    const hidden = guide.dismissed === true && !showForVisit;
    $('overviewGuideBody').hidden = hidden;
    $('overviewGuideHidden').hidden = !hidden;
    $('overviewVisitNotice').hidden = !(guide.dismissed === true && showForVisit);
    $('overviewProgress').textContent = items.length ? items.filter(i => i.complete === true).length + ' of ' + items.length + ' milestones evidenced' : 'No checklist steps are available for your current permissions.';
    $('overviewChecklist').innerHTML = items.map(item => '<li><span class="overview-check-marker' + (item.complete === true ? ' complete' : '') + '" aria-label="' + (item.complete === true ? 'Evidence present' : 'Not yet evidenced') + '">' + (item.complete === true ? '&#10003;' : '&#8211;') + '</span><div>' + link(item, item.label) + '<p class="overview-check-detail">' + escape(item.description) + '</p><span class="overview-scope">' + (item.scope === 'personal' ? 'Your personal progress' : 'Workspace evidence') + '</span></div></li>').join('');
  }
  function render() {
    const cards = Array.isArray(state.data.cards) ? state.data.cards.slice(0, 12) : [];
    $('overviewCards').innerHTML = cards.map(card => {
      const target = href(card.href); if (!target) return '';
      const count = Number(card.count); const label = Number.isSafeInteger(count) && count >= 0 ? count.toLocaleString() : 'Unavailable';
      return '<a class="overview-card" href="' + escape(target) + '"><span class="overview-card-top">' + escape(card.label) + '<span aria-hidden="true">&#8594;</span></span><span class="overview-card-count">' + label + '</span><p class="overview-card-description">' + escape(card.description) + '</p></a>';
    }).join('') || '<p class="overview-empty">No attention queues are available for your current permissions.</p>';
    const activity = Array.isArray(state.data.activity) ? state.data.activity.slice(0, 12) : [];
    $('overviewActivity').innerHTML = activity.map(item => {
      const date = new Date(item.at); const valid = item.at && Number.isFinite(date.getTime());
      return '<li>' + link(item, item.title || 'Article update') + '<div class="overview-activity-meta"><span>' + escape(String(item.status || 'Updated').replace(/_/g, ' ')) + '</span>' + (valid ? '<time datetime="' + date.toISOString() + '">' + escape(date.toLocaleString()) + '</time>' : '<span>Time unavailable</span>') + '</div></li>';
    }).join('') || '<li class="overview-empty">No recent activity is available. Saved editorial changes will appear here.</li>';
    renderGuide();
  }
  function load() {
    if (pendingLoad) return pendingLoad;
    if (state.saving) return Promise.resolve();
    state.loading = true; $('overviewRefresh').disabled = true; $('overviewRetry').disabled = true;
    $('overviewContent').hidden = true; $('overviewContent').setAttribute('aria-busy', 'true');
    $('overviewStatus').textContent = 'Loading your newsroom…'; $('overviewRetry').hidden = true;
    pendingLoad = (async () => {
      try {
        const data = await api('/newsroom-overview');
        if (!data || !Array.isArray(data.cards) || !Array.isArray(data.activity) || !data.onboarding) throw new Error('Invalid overview');
        state.data = data; render(); $('overviewContent').hidden = false;
        $('overviewStatus').textContent = 'Overview updated. Counts reflect saved newsroom state.';
      } catch {
        state.data = null; $('overviewStatus').textContent = 'Unable to load the overview. Your work has not changed. Retry to refresh the queues.'; $('overviewRetry').hidden = false;
      } finally {
        state.loading = false; pendingLoad = null; $('overviewRefresh').disabled = false; $('overviewRetry').disabled = false; $('overviewContent').setAttribute('aria-busy', 'false');
      }
    })();
    return pendingLoad;
  }
  async function preference(dismissed) {
    if (state.saving || state.loading || !state.data) return;
    state.saving = true; $('overviewDismiss').disabled = true; $('overviewReopen').disabled = true; $('overviewRefresh').disabled = true;
    $('overviewPreferenceStatus').textContent = 'Saving your preference…';
    try {
      const result = await api('/newsroom-overview/onboarding', { method: 'PUT', body: JSON.stringify({ dismissed, version: 1 }) });
      if (!result || result.version !== 1 || typeof result.dismissed !== 'boolean') throw new Error('Invalid preference');
      state.data.onboarding.dismissed = result.dismissed; showForVisit = false; renderGuide();
      $('overviewPreferenceStatus').textContent = result.dismissed ? 'Checklist hidden for your account in this workspace.' : 'Checklist restored. Completion still reflects saved evidence.';
      $(result.dismissed ? 'overviewReopen' : 'overviewDismiss').focus();
    } catch { $('overviewPreferenceStatus').textContent = 'Could not save your preference. Try again; your checklist has not changed.'; }
    finally { state.saving = false; $('overviewDismiss').disabled = false; $('overviewReopen').disabled = false; $('overviewRefresh').disabled = false; }
  }
  function init() {
    $('overviewRefresh').addEventListener('click', load); $('overviewRetry').addEventListener('click', load);
    $('overviewDismiss').addEventListener('click', () => preference(true)); $('overviewReopen').addEventListener('click', () => preference(false));
    return load();
  }
  return { init, load, state, dismiss: () => preference(true), reopen: () => preference(false), safeHref: href };
});
