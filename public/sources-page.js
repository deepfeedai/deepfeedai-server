(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else {
    root.SourcesPage = factory(root.document, (path, options) => apiFetch(path, options), {
      can: permission => hasPermission(permission), suggestions: root.RSS_SUGGESTIONS || {},
      download(content, mime, filename) {
        const url = URL.createObjectURL(new Blob([content], { type: mime }));
        const link = document.createElement('a'); link.href = url; link.download = filename;
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    });
    onReady(() => { if (requireAuth()) { renderSidebar(); root.SourcesPage.init(); root.pageRefresh = root.SourcesPage.load; } });
  }
})(typeof window === 'undefined' ? globalThis : window, function createSourcesPage(document, api, services) {
  'use strict';
  services = services || {};
  const $ = id => document.getElementById(id);
  const can = permission => services.can ? services.can(permission) : true;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function maskedUrl(value) {
    try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.origin + '/…' : 'Address hidden'; }
    catch { return 'Address hidden'; }
  }
  const safeMessage = message => String(message || '').replace(/https?:\/\/[^\s<>"']+/g, maskedUrl);
  const state = { items: [], total: 0, page: 1, limit: 25, filters: { q: '', status: 'current', folder: '', category: '' }, selected: new Set(), allMatching: false, folders: [], categories: [], preview: null, importSnapshot: null, remove: null, duplicateReport: null, loadVersion: 0, fileVersion: 0, loading: false };
  const locks = new Set(); const focusBefore = new Map();
  const send = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body) });
  function notice(message, error = false) { $('sourcesNotice').hidden = !message; $('sourcesNotice').textContent = safeMessage(message); $('sourcesNotice').className = 'sources-notice' + (error ? ' error' : ''); }
  function message(id, text) { $(id).textContent = safeMessage(text); }
  function open(id) { const dialog = $(id); focusBefore.set(id, document.activeElement); dialog.showModal(); }
  function close(id) {
    const dialog = $(id); if (dialog.dataset.busy === 'true') return false;
    dialog.close(); focusBefore.get(id)?.focus?.();
    if (id === 'sourcesImportDialog') { state.fileVersion++; state.preview = null; state.importSnapshot = null; $('sourcesImportContent').value = ''; $('sourcesImportFile').value = ''; $('sourcesImportFileName').textContent = ''; $('sourcesImportResults').innerHTML = ''; message('sourcesImportMessage', ''); }
    if (id === 'sourcesRemoveDialog') { state.remove = null; $('sourcesClearPhrase').value = ''; $('sourcesExportAcknowledged').checked = false; }
    if (id === 'sourcesEditDialog') $('sourcesEditUrl').value = '';
    return true;
  }
  async function busy(key, dialogId, buttonId, work) {
    if (locks.has(key)) return false;
    locks.add(key); const dialog = dialogId && $(dialogId); const button = buttonId && $(buttonId);
    const controls = dialog ? [...dialog.querySelectorAll('button,input,select,textarea')] : button ? [button] : [];
    const disabled = controls.map(el => el.disabled);
    controls.forEach(el => { el.disabled = true; }); if (dialog) { dialog.dataset.busy = 'true'; dialog.setAttribute('aria-busy', 'true'); }
    try { await work(); return true; }
    finally { controls.forEach((el, i) => { el.disabled = disabled[i]; }); locks.delete(key); if (dialog) { dialog.dataset.busy = 'false'; dialog.removeAttribute('aria-busy'); } updateImportButton(); updateRemoveButton(); }
  }
  function selection() {
    if (state.allMatching) return { mode: 'all_matching', filters: { ...state.filters } };
    return { mode: 'ids', ids: [...state.selected] };
  }
  function selectionCount() { return state.allMatching ? state.total : state.selected.size; }
  function selectionLabel() { return state.allMatching ? 'All ' + state.total + ' matching sources (evaluated when applied)' : state.selected.size + ' selected on this page'; }
  function clearSelection() { state.selected.clear(); state.allMatching = false; renderSelection(); }
  function renderSelection() {
    const count = selectionCount(); $('sourcesSelectionBar').hidden = !count;
    $('sourcesSelectionText').textContent = selectionLabel();
    $('sourcesSelectMatching').hidden = state.allMatching || state.total <= state.items.length;
    $('sourcesSelectPage').checked = !!state.items.length && (state.allMatching || state.items.every(item => state.selected.has(item.id)));
    $('sourcesSelectPage').indeterminate = !state.allMatching && state.selected.size > 0 && state.selected.size < state.items.length;
    $('sourcesSelectPage').disabled = state.loading || !state.items.length;
    for (const box of document.querySelectorAll('[data-source-select]')) { box.checked = state.allMatching || state.selected.has(Number(box.dataset.sourceSelect)); box.closest('tr')?.setAttribute('aria-selected', String(box.checked)); }
    $('sourcesBulkApply').disabled = !count || locks.has('mutation') || !can($('sourcesBulkAction').value === 'remove' ? 'sources.delete' : 'sources.update');
  }
  function selectPage(checked) { state.allMatching = false; state.selected = new Set(checked ? state.items.map(row => row.id) : []); renderSelection(); }
  function selectMatching() { if (!state.total) return; state.selected.clear(); state.allMatching = true; renderSelection(); }
  function dateLabel(value) { if (!value) return 'Not fetched yet'; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not available'; }
  function render() {
    $('sourcesBody').innerHTML = state.items.map(source => {
      const removed = !!source.removed_at; const active = !!source.is_active && !removed;
      const checked = state.allMatching || state.selected.has(source.id);
      const title = source.name || 'Unnamed source';
      return `<tr aria-selected="${checked}"><td class="sources-check"><input type="checkbox" data-source-select="${source.id}" aria-label="Select ${escape(title)}" ${checked ? 'checked' : ''}></td><td><div class="sources-identity"><span class="sources-monogram" aria-hidden="true">${escape(title.slice(0, 2).toUpperCase())}</span><div><div class="sources-name">${escape(title)}</div><div class="sources-url">${escape(maskedUrl(source.display_url || source.url || ''))}</div><div class="sources-subtext">Priority ${Number(source.priority) || 1} · ${Number(source.auto_publish_max) || 50} items / fetch</div></div></div></td><td><div class="sources-folder-label">${escape(source.folder_path || 'No folder')}</div><div class="sources-subtext">${escape(source.default_category || 'Auto category')}</div></td><td><span class="sources-state ${removed ? 'removed' : active ? 'active' : ''}">${removed ? 'Removed' : active ? 'Active' : 'Paused'}</span></td><td><span class="sources-subtext">${escape(dateLabel(source.last_fetched))}</span></td><td><div class="sources-row-actions">${!removed && can('sources.update') ? `<button class="btn btn-ghost btn-sm" data-source-edit="${source.id}">Edit</button>` : ''}${removed && can('sources.update') ? `<button class="btn btn-outline btn-sm" data-source-restore="${source.id}">Restore</button>` : !removed && can('sources.delete') ? `<button class="btn btn-ghost btn-sm" data-source-remove="${source.id}" aria-label="Remove ${escape(title)}">Remove</button>` : ''}</div></td></tr>`;
    }).join('');
    $('sourcesCount').textContent = state.total + (state.total === 1 ? ' source' : ' sources') + ' matching this view';
    $('sourcesEmpty').hidden = !!state.items.length;
    $('sourcesEmptyTitle').textContent = state.filters.status === 'removed' ? 'Nothing in Removed' : state.filters.q || state.filters.folder || state.filters.category ? 'No matching sources' : 'Build your reading list';
    $('sourcesEmptyText').textContent = state.filters.status === 'removed' ? 'Removed subscriptions will appear here, ready to restore.' : 'Try another filter, paste feed URLs or import an OPML file.';
    $('sourcesRetry').hidden = true;
    $('sourcesPageText').textContent = state.total ? `Page ${state.page} of ${Math.max(1, Math.ceil(state.total / state.limit))} · ${state.items.length} shown` : 'No sources to display';
    $('sourcesPrevious').disabled = state.page <= 1; $('sourcesNext').disabled = state.page * state.limit >= state.total;
    renderSelection();
  }
  function options(id, list, first, selected) { $(id).innerHTML = `<option value="">${escape(first)}</option>` + [...new Set([...list, selected])].filter(Boolean).map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join(''); $(id).value = selected || ''; }
  function renderFacets() {
    options('sourcesFolder', state.folders, 'All folders', state.filters.folder);
    options('sourcesCategory', state.categories, 'All categories', state.filters.category);
    options('sourcesEditCategory', state.categories, 'Auto · keyword matching', $('sourcesEditCategory').value);
    $('sourcesFolderOptions').innerHTML = state.folders.map(value => `<option value="${escape(value)}"></option>`).join('');
    $('sourcesCategoryOptions').innerHTML = state.categories.map(value => `<option value="${escape(value)}"></option>`).join('');
  }
  async function load() {
    const version = ++state.loadVersion; state.loading = true; renderSelection();
    const params = new URLSearchParams({ paged: '1', page: String(state.page), limit: String(state.limit), ...state.filters });
    $('sourcesCount').textContent = 'Loading sources…';
    try {
      const data = await api('/sources?' + params); if (version !== state.loadVersion) return;
      state.items = data.items || []; state.total = Number(data.total) || 0;
      state.folders = (data.folders || []).map(value => typeof value === 'string' ? value : value.folder_path).filter(Boolean);
      state.categories = [...new Set([...state.categories, ...(data.categories || []).map(value => typeof value === 'string' ? value : value.name)].filter(Boolean))];
      if (!state.items.length && state.page > 1) { state.page = Math.max(1, Math.ceil(state.total / state.limit)); return load(); }
      renderFacets(); render();
    } catch (error) {
      if (version !== state.loadVersion) return;
      state.items = []; state.total = 0; clearSelection(); render();
      $('sourcesEmptyTitle').textContent = 'Could not load your sources'; $('sourcesEmptyText').textContent = 'Your subscriptions have not been changed. Retry when the connection is available.';
      $('sourcesRetry').hidden = false; notice(error.message, true);
    } finally { if (version === state.loadVersion) { state.loading = false; renderSelection(); } }
  }
  async function filterChanged() { state.filters = { q: $('sourcesSearch').value.trim(), status: $('sourcesStatus').value, folder: $('sourcesFolder').value, category: $('sourcesCategory').value }; state.page = 1; clearSelection(); await load(); }
  async function movePage(delta) { state.page = Math.max(1, state.page + delta); clearSelection(); await load(); }
  function changeBulkAction() { const action = $('sourcesBulkAction').value; $('sourcesBulkValueWrap').hidden = !['folder', 'category'].includes(action); $('sourcesBulkValue').setAttribute('list', action === 'folder' ? 'sourcesFolderOptions' : 'sourcesCategoryOptions'); $('sourcesBulkValue').placeholder = action === 'folder' ? 'Folder / subfolder (blank clears)' : 'Category (blank uses auto)'; renderSelection(); }
  async function applyBulk(action = $('sourcesBulkAction').value, selected = selection()) {
    if (selected.mode === 'ids' && !selected.ids.length) return;
    if (action === 'remove') { openRemoval(false, selected); return; }
    if (!can('sources.update')) return;
    await busy('mutation', null, 'sourcesBulkApply', async () => {
      try { const data = await send('/sources/bulk', { action, selection: selected, ...(['folder', 'category'].includes(action) ? { value: $('sourcesBulkValue').value.trim() || null } : {}) }); notice(`${data.updated || 0} subscription(s) ${action === 'restore' ? 'restored as paused. Resume them when ready' : 'updated'}.`); clearSelection(); await load(); }
      catch (error) { notice(error.message, true); }
    }); renderSelection();
  }
  function openRemoval(all = false, selected = selection()) {
    if (!can('sources.delete') || locks.has('mutation')) return;
    state.remove = { all, selection: selected }; $('sourcesClearConfirmation').hidden = !all; $('sourcesClearPhrase').value = ''; $('sourcesExportAcknowledged').checked = false;
    $('sourcesRemoveTitle').textContent = all ? 'Remove all current sources?' : 'Remove subscriptions?';
    $('sourcesRemoveDescription').textContent = all ? 'This affects every current RSS subscription in this publication, including sources outside your filters.' : selected.mode === 'all_matching' ? 'This affects all sources matching your current filters when the action runs, not just this page.' : `This affects ${selected.ids.length} selected subscription(s).`;
    message('sourcesRemoveMessage', ''); updateRemoveButton(); open('sourcesRemoveDialog');
  }
  function updateRemoveButton() { $('sourcesConfirmRemove').disabled = locks.has('mutation') || !state.remove || state.remove.all && ($('sourcesClearPhrase').value !== 'CLEAR ALL SOURCES' || !$('sourcesExportAcknowledged').checked); }
  async function confirmRemoval() {
    if (!can('sources.delete') || !state.remove || $('sourcesConfirmRemove').disabled) return;
    const request = state.remove; let complete = false;
    await busy('mutation', 'sourcesRemoveDialog', 'sourcesConfirmRemove', async () => {
      try {
        const data = request.all ? await send('/sources/clear', { confirmation: $('sourcesClearPhrase').value, exportAcknowledged: $('sourcesExportAcknowledged').checked }) : await send('/sources/bulk', { action: 'remove', selection: request.selection, confirm: 'REMOVE SELECTED' });
        notice(`${data.updated || data.removed || 0} subscription(s) moved to Removed. Imported articles are preserved.`); complete = true; clearSelection(); await load();
      } catch (error) { message('sourcesRemoveMessage', error.message); }
    });
    if (complete) close('sourcesRemoveDialog');
  }
  async function exportSources(format, selected, messageId = 'sourcesExportMessage') {
    if (selected.mode === 'ids' && !selected.ids.length) { message(messageId, 'Select at least one source or choose all current sources.'); return false; }
    let exported = false;
    await busy('export', $(messageId).closest('dialog')?.id, 'sourcesDownload', async () => {
      try {
        const result = await send('/sources/export', { format, selection: selected });
        if (typeof result.content !== 'string') throw Error('The export response was incomplete. Please retry.');
        services.download?.(result.content, result.mime || 'application/octet-stream', String(result.filename || 'sources.' + format).replace(/[\\/\r\n]/g, '_'));
        message(messageId, 'Export downloaded. Keep private feed URLs secure.'); exported = true;
      } catch (error) { message(messageId, error.message); }
    }); return exported;
  }
  function exportSelection() { const scope = $('sourcesExportScope').value; return scope === 'selected' ? selection() : { mode: 'all_matching', filters: scope === 'matching' ? { ...state.filters } : { status: 'current' } }; }
  function invalidateImport() { state.preview = null; state.importSnapshot = null; $('sourcesImportResults').innerHTML = ''; message('sourcesImportMessage', 'Preview this input before adding feeds.'); updateImportButton(); }
  function importInput() { return { format: $('sourcesImportFormat').value, content: $('sourcesImportContent').value }; }
  function updateImportButton() { $('sourcesCommitImport').disabled = locks.has('import') || !state.preview?.some(item => item.status === 'ready') || !state.importSnapshot || JSON.stringify(importInput()) !== JSON.stringify(state.importSnapshot); }
  function renderImportRows(items) {
    $('sourcesImportResults').innerHTML = items.map(item => {
      const status = ['ready', 'duplicate', 'removed', 'invalid', 'added', 'skipped', 'error', 'restored'].includes(item.status) ? item.status : 'error';
      return `<div class="sources-import-row"><div><strong>${escape(item.name || 'Feed ' + (Number(item.index) + 1))}</strong>${item.display_url ? `<p>${escape(maskedUrl(item.display_url))}</p>` : ''}${item.folder_path ? `<p>Folder: ${escape(item.folder_path)}</p>` : ''}${item.error ? `<p>${escape(safeMessage(item.error))}</p>` : ''}${status === 'removed' ? '<p>Already in Removed. Restore it from that view.</p>' : ''}</div><span class="sources-result-status ${status}">${status}</span></div>`;
    }).join('');
  }
  async function previewImport() {
    if (!can('sources.create')) return;
    const input = importInput(); if (!input.content.trim()) { message('sourcesImportMessage', 'Paste feed URLs or choose a file first.'); return; }
    if (new Blob([input.content]).size > 500000) { message('sourcesImportMessage', 'Use an import file smaller than 500 KB.'); return; }
    await busy('import', 'sourcesImportDialog', 'sourcesPreviewImport', async () => {
      try { const data = await send('/sources/import-preview', input); if (JSON.stringify(input) !== JSON.stringify(importInput())) return; state.preview = data.items || []; state.importSnapshot = input; renderImportRows(state.preview); const ready = state.preview.filter(row => row.status === 'ready').length; message('sourcesImportMessage', `${ready} ready · ${state.preview.length - ready} need no import or attention. Nothing has been added yet.`); }
      catch (error) { state.preview = null; state.importSnapshot = null; message('sourcesImportMessage', error.message); }
    });
  }
  async function commitImport() {
    if (!can('sources.create') || $('sourcesCommitImport').disabled) return;
    const input = { ...state.importSnapshot };
    await busy('import', 'sourcesImportDialog', 'sourcesCommitImport', async () => {
      try {
        const data = await send('/sources/import', input);
        const previews = new Map((state.preview || []).map(row => [row.index, row]));
        const errors = new Map((data.errors || []).map(row => [row.index, row.error]));
        renderImportRows((data.results || []).map(row => ({ ...previews.get(row.index), ...row, ...(errors.has(row.index) ? { error: errors.get(row.index), status: 'error' } : {}) })));
        message('sourcesImportMessage', `${data.added || 0} added · ${data.skipped || 0} skipped · ${(data.errors || []).length} failed. Successful feeds are saved; fix failed input and preview again.`);
        state.preview = null; state.importSnapshot = null; clearSelection(); await load();
      } catch (error) { message('sourcesImportMessage', safeMessage(error.message) + ' The outcome may be incomplete. Preview again before retrying; existing subscriptions will be skipped.'); state.preview = null; state.importSnapshot = null; }
    });
  }
  async function importFile(file) {
    const version = ++state.fileVersion; if (!file) return;
    if (file.size > 500000) { message('sourcesImportMessage', 'Use a file smaller than 500 KB.'); return; }
    try { const content = await file.text(); if (version !== state.fileVersion || !$('sourcesImportDialog').open) return; $('sourcesImportContent').value = content; $('sourcesImportFormat').value = /\.json$/i.test(file.name) ? 'json' : 'opml'; $('sourcesImportFileName').textContent = file.name; invalidateImport(); }
    catch { message('sourcesImportMessage', 'Could not read this file. Choose it again or paste the content.'); }
  }
  function editSource(id) {
    const source = state.items.find(row => row.id === id); if (!source || !can('sources.update')) return;
    $('sourcesEditId').value = source.id; $('sourcesEditName').value = source.name || ''; $('sourcesEditUrl').value = '';
    $('sourcesEditCurrentUrl').textContent = 'Current: ' + maskedUrl(source.display_url || source.url || '');
    $('sourcesEditPriority').value = source.priority || 1; $('sourcesEditCap').value = source.auto_publish_max || 50;
    $('sourcesEditFolder').value = source.folder_path || ''; $('sourcesEditCategory').value = source.default_category || ''; $('sourcesEditActive').checked = !!source.is_active;
    message('sourcesEditMessage', ''); open('sourcesEditDialog');
  }
  async function saveEdit() {
    if (!can('sources.update')) return;
    const name = $('sourcesEditName').value.trim(); const priority = Number($('sourcesEditPriority').value); const cap = Number($('sourcesEditCap').value);
    if (!name || !Number.isInteger(priority) || priority < 1 || priority > 10 || !Number.isInteger(cap) || cap < 1 || cap > 200) { message('sourcesEditMessage', 'Enter a name, priority 1–10 and ingest limit 1–200.'); return; }
    const payload = { name, priority, auto_publish_max: cap, is_active: $('sourcesEditActive').checked, default_category: $('sourcesEditCategory').value || null, folder_path: $('sourcesEditFolder').value.trim() || null };
    if ($('sourcesEditUrl').value.trim()) payload.url = $('sourcesEditUrl').value.trim();
    let saved = false;
    await busy('mutation', 'sourcesEditDialog', 'sourcesSaveEdit', async () => { try { await send('/sources/' + Number($('sourcesEditId').value), payload, 'PUT'); saved = true; notice('Source saved.'); await load(); } catch (error) { message('sourcesEditMessage', error.message); } });
    if (saved) close('sourcesEditDialog');
  }
  async function refreshFeeds() {
    if (!can('fetch.execute')) return;
    await busy('fetch', null, 'sourcesRefresh', async () => { try { notice('Fetching active feeds. No AI enrichment is requested.'); const data = await send('/fetch', {}); notice(`${data.inserted || 0} new articles · ${data.skipped || 0} skipped · ${(data.errors || []).length} feed errors. No AI enrichment requested.`); await load(); } catch (error) { notice(error.message, true); } });
  }
  function renderDuplicates(report) {
    const links = new Map((report.links || []).map(link => [link.article_id, link.canonical_article_id]));
    $('sourcesDuplicatesResults').innerHTML = (report.groups || []).map((group, index) => {
      const primary = Number(group.canonical_article_id);
      return `<section class="sources-duplicate-group" data-duplicate-group="${index}"><h3>Same normalized URL · ${group.articles.length} entries</h3><label class="form-label" for="duplicatePrimary${index}">Primary entry</label><select class="form-control" id="duplicatePrimary${index}" data-duplicate-primary="${index}">${group.articles.map(article => `<option value="${article.id}" ${article.id === primary ? 'selected' : ''}>#${article.id} · ${escape(article.title || 'Untitled')}</option>`).join('')}</select>${group.articles.map(article => `<div class="sources-duplicate-entry"><input type="checkbox" data-duplicate-select="${article.id}" data-group="${index}" aria-label="Collapse entry ${article.id}" ${article.id === primary || links.has(article.id) || !can('articles.update') ? 'disabled' : ''}><div><strong>${escape(article.title || 'Untitled')}</strong><p>#${article.id} · ${escape(article.source || 'Unknown source')}${links.has(article.id) ? ' · Collapsed under #' + links.get(article.id) : ''}</p></div>${links.has(article.id) && can('articles.update') ? `<button class="btn btn-ghost btn-sm" data-duplicate-undo="${article.id}">Undo</button>` : ''}</div>`).join('')}${can('articles.update') ? `<button class="btn btn-primary btn-sm" data-duplicate-apply="${index}">Collapse selected repeats</button>` : ''}</section>`;
    }).join('') || '<p class="sources-help">No repeated URLs found in the scanned entries. No articles were changed.</p>';
  }
  async function loadDuplicates(preserveMessage = false) {
    if (!can('articles.read')) return;
    try {
      const report = await api('/sources/duplicates'); state.duplicateReport = report; renderDuplicates(report);
      if (!preserveMessage) message('sourcesDuplicatesMessage', `Dry run: ${report.scanned || 0} entries scanned; ${(report.groups || []).length} repeated-URL groups.${report.truncated ? ' This report is limited to the first 5,000 entries; it is not a full-library audit.' : ''}`);
    } catch (error) { state.duplicateReport = null; $('sourcesDuplicatesResults').innerHTML = ''; message('sourcesDuplicatesMessage', error.message); }
  }
  function changeDuplicatePrimary(index, id) {
    const linked = new Set((state.duplicateReport?.links || []).map(row => row.article_id));
    for (const box of document.querySelectorAll(`[data-duplicate-select][data-group="${index}"]`)) { const item = Number(box.dataset.duplicateSelect); box.disabled = item === id || linked.has(item) || !can('articles.update'); if (box.disabled) box.checked = false; }
  }
  async function collapseDuplicates(index, primary, ids) {
    const group = state.duplicateReport?.groups?.[index]; if (!group || !can('articles.update')) return;
    const allowed = new Set(group.articles.map(row => row.id));
    const selected = [...new Set(ids)].filter(id => id !== primary && allowed.has(id));
    if (!allowed.has(primary) || !selected.length) { message('sourcesDuplicatesMessage', 'Choose a primary entry and select at least one other entry to collapse.'); return; }
    await busy('duplicates', 'sourcesDuplicatesDialog', null, async () => {
      let succeeded = 0; const failures = [];
      for (const article_id of selected) { try { await send('/sources/duplicates/link', { article_id, canonical_article_id: primary }); succeeded++; } catch (error) { failures.push('#' + article_id + ': ' + safeMessage(error.message)); } }
      await loadDuplicates(true);
      message('sourcesDuplicatesMessage', `${succeeded} repeat(s) collapsed; ${failures.length} failed. Original articles and references are preserved.` + (failures.length ? ' ' + failures.join(' · ') : ' Use Undo to separate them again.'));
    });
  }
  async function undoDuplicate(id) {
    if (!can('articles.update')) return;
    await busy('duplicates', 'sourcesDuplicatesDialog', null, async () => { try { await send('/sources/duplicates/unlink', { article_id: id }); await loadDuplicates(true); message('sourcesDuplicatesMessage', 'Entry restored to separate display. No article content changed.'); } catch (error) { message('sourcesDuplicatesMessage', error.message); } });
  }
  function renderSuggested() {
    const list = services.suggestions?.[$('sourcesSuggestedNiche').value] || [];
    $('sourcesSuggestedList').innerHTML = list.map((item, i) => `<label class="sources-suggested-item"><input type="checkbox" value="${i}" data-suggested><span>${escape(item.name)}<small>${escape(maskedUrl(item.url))}</small></span></label>`).join('');
  }
  function useSuggested() {
    const list = services.suggestions?.[$('sourcesSuggestedNiche').value] || [];
    const urls = [...document.querySelectorAll('[data-suggested]:checked')].map(el => list[Number(el.value)]?.url).filter(Boolean);
    if (!urls.length) return;
    $('sourcesImportContent').value = urls.join('\n'); $('sourcesImportFormat').value = 'urls'; invalidateImport(); close('sourcesSuggestedDialog');
  }
  function bind(id, event, handler) { $(id).addEventListener(event, handler); }
  async function init() {
    for (const button of document.querySelectorAll('[data-permission]')) button.hidden = !can(button.dataset.permission);
    for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => close(button.dataset.close));
    for (const dialog of document.querySelectorAll('.sources-dialog')) {
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(dialog.id); });
    }
    let searchTimer; bind('sourcesSearch', 'input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(filterChanged, 250); });
    for (const id of ['sourcesStatus', 'sourcesFolder', 'sourcesCategory']) bind(id, 'change', filterChanged);
    bind('sourcesPrevious', 'click', () => movePage(-1)); bind('sourcesNext', 'click', () => movePage(1)); bind('sourcesRetry', 'click', load);
    bind('sourcesSelectPage', 'change', event => selectPage(event.target.checked)); bind('sourcesSelectMatching', 'click', selectMatching); bind('sourcesClearSelection', 'click', clearSelection);
    bind('sourcesBody', 'change', event => { if (!event.target.matches('[data-source-select]')) return; if (state.allMatching) { state.allMatching = false; state.selected = new Set(state.items.map(item => item.id)); } const id = Number(event.target.dataset.sourceSelect); event.target.checked ? state.selected.add(id) : state.selected.delete(id); renderSelection(); });
    bind('sourcesBody', 'click', event => { const edit = event.target.closest('[data-source-edit]'), remove = event.target.closest('[data-source-remove]'), restore = event.target.closest('[data-source-restore]'); if (edit) editSource(Number(edit.dataset.sourceEdit)); if (remove) openRemoval(false, { mode: 'ids', ids: [Number(remove.dataset.sourceRemove)] }); if (restore) applyBulk('restore', { mode: 'ids', ids: [Number(restore.dataset.sourceRestore)] }); });
    bind('sourcesBulkAction', 'change', changeBulkAction); bind('sourcesBulkApply', 'click', () => applyBulk()); bind('sourcesRefresh', 'click', refreshFeeds);
    bind('sourcesAdd', 'click', () => { message('sourcesImportMessage', ''); open('sourcesImportDialog'); });
    bind('sourcesImportContent', 'input', () => { state.fileVersion++; invalidateImport(); }); bind('sourcesImportFormat', 'change', invalidateImport); bind('sourcesImportFile', 'change', event => importFile(event.target.files[0]));
    bind('sourcesPreviewImport', 'click', previewImport); bind('sourcesCommitImport', 'click', commitImport);
    bind('sourcesExport', 'click', () => { $('sourcesExportScope').value = selectionCount() ? 'selected' : 'current'; message('sourcesExportMessage', ''); open('sourcesExportDialog'); });
    bind('sourcesDownload', 'click', () => exportSources($('sourcesExportFormat').value, exportSelection()));
    bind('sourcesClearAll', 'click', () => openRemoval(true)); bind('sourcesClearPhrase', 'input', updateRemoveButton); bind('sourcesExportAcknowledged', 'change', updateRemoveButton); bind('sourcesConfirmRemove', 'click', confirmRemoval);
    bind('sourcesBackupBeforeRemove', 'click', () => state.remove && exportSources('opml', state.remove.all ? { mode: 'all_matching', filters: { status: 'current' } } : state.remove.selection, 'sourcesRemoveMessage'));
    bind('sourcesSaveEdit', 'click', saveEdit);
    bind('sourcesDuplicates', 'click', () => { open('sourcesDuplicatesDialog'); loadDuplicates(); }); bind('sourcesDuplicatesReload', 'click', () => loadDuplicates());
    bind('sourcesDuplicatesResults', 'change', event => { if (event.target.matches('[data-duplicate-primary]')) changeDuplicatePrimary(Number(event.target.dataset.duplicatePrimary), Number(event.target.value)); });
    bind('sourcesDuplicatesResults', 'click', event => { const apply = event.target.closest('[data-duplicate-apply]'), undo = event.target.closest('[data-duplicate-undo]'); if (undo) undoDuplicate(Number(undo.dataset.duplicateUndo)); if (apply) { const index = Number(apply.dataset.duplicateApply); const ids = [...document.querySelectorAll(`[data-duplicate-select][data-group="${index}"]:checked`)].map(box => Number(box.dataset.duplicateSelect)); collapseDuplicates(index, Number($('duplicatePrimary' + index).value), ids); } });
    const niches = Object.keys(services.suggestions || {}).filter(key => key !== 'custom');
    $('sourcesSuggestedNiche').innerHTML = niches.map(key => `<option value="${escape(key)}">${escape(key.replace(/-/g, ' '))}</option>`).join('');
    bind('sourcesSuggested', 'click', () => { renderSuggested(); open('sourcesSuggestedDialog'); }); bind('sourcesSuggestedNiche', 'change', renderSuggested); bind('sourcesSuggestedUse', 'click', useSuggested);
    try { const categories = await api('/categories'); state.categories = (Array.isArray(categories) ? categories : categories.categories || []).map(row => row.name); } catch { /* source facets still supply categories */ }
    await load();
  }
  return { init, load, state, selection, selectPage, selectMatching, clearSelection, filterChanged, movePage, render, maskedUrl, safeMessage, open, close, previewImport, commitImport, importFile, invalidateImport, applyBulk, openRemoval, confirmRemoval, updateRemoveButton, editSource, saveEdit, exportSources, exportSelection, refreshFeeds, renderSuggested, useSuggested, loadDuplicates, collapseDuplicates, undoDuplicate };
});
