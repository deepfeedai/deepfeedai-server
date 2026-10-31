(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else {
    root.EditionsPage = factory(root.document, (path, options) => apiFetch(path, options), {
      search: root.location.search,
      publicOrigin: root.location.origin,
      copyText: text => root.navigator.clipboard ? root.navigator.clipboard.writeText(text) : Promise.reject(new Error('Clipboard unavailable')),
      canPublish: () => hasPermission('articles.publish'),
      canCreate: () => hasPermission('articles.create'),
      canUpdate: () => hasPermission('articles.update'),
      canDelete: () => hasPermission('articles.delete'),
      uuid: () => root.crypto.randomUUID(),
      navigate: (id, replace = false) => { const u = new URL(root.location.href); if (id) u.searchParams.set('id', id); else u.searchParams.delete('id'); root.history[replace ? 'replaceState' : 'pushState']({}, '', u); },
      beforeUnload: handler => root.addEventListener('beforeunload', handler),
      onPopState: handler => root.addEventListener('popstate', () => handler(root.location.search)),
    });
    onReady(() => { if (requireAuth()) { renderSidebar(); root.EditionsPage.init(); root.pageRefresh = root.EditionsPage.loadList; } });
  }
})(typeof window === 'undefined' ? globalThis : window, function createEditions(document, api, options) {
  'use strict';
  options = options || {};
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const copy = value => JSON.parse(JSON.stringify(value));
  const safeId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const editionId = value => /^(?:[1-9]\d{0,9}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
  const state = { edition: null, saved: null, dirty: false, busy: false, opening: false, view: 'active', listBusy: false, listOffset: 0, listTotal: 0, list: [], picked: new Map(), results: [], searchOffset: 0, searchTotal: 0, searchBusy: false, query: '', requestId: null };
  let listVersion = 0, searchVersion = 0, openVersion = 0, pickerReturn = null, confirmResolve = null, confirmFields = null;
  const notice = text => { $('editionNotice').textContent = text; };
  function failureReason(error) {
    const message = String(error?.message || '');
    if (/edition changed|request ID was already used/.test(message)) return 'The saved state or create request changed. Use Reload saved edition (or the saved editions list for a new issue) before retrying.';
    if (/available authored article|withdrawn|republished/.test(message)) return 'A selected source is no longer eligible. Refresh a working edition or remove the unavailable article; finalized issues need a new edition.';
    if (/readable article text/.test(message)) return 'A selected article has no readable text. Remove it or edit its source before saving.';
    if (/too long|exceed 25 MB/.test(message)) return 'The selected content exceeds edition limits. Choose fewer or shorter articles.';
    if (/name must contain/.test(message)) return 'Use an edition name between 1 and 120 characters.';
    if (/permission|Forbidden/.test(message)) return 'Your account does not have permission for this action.';
    return '';
  }
  function revisionBody() { return { revision: state.edition.revision }; }
  function isArchived() { return Boolean(state.edition?.archived_at); }
  function isFinal() { return state.edition?.status === 'finalized'; }
  function formatDate(value) { return String(value || '').slice(0, 10); }
  function confirmAction(title, text, label, fields = {}) {
    if (confirmResolve) return Promise.resolve(false);
    $('editionConfirmTitle').textContent = title; $('editionConfirmText').textContent = text; $('editionConfirmAccept').textContent = label || 'Continue';
    confirmFields = fields; $('editionConfirmReasonWrap').hidden = !fields.reason; $('editionConfirmReason').value = ''; $('editionConfirmValueWrap').hidden = !fields.value; $('editionConfirmValueLabel').textContent = fields.value || ''; $('editionConfirmValue').value = fields.initial || ''; $('editionConfirmError').textContent = '';
    return new Promise(resolve => { confirmResolve = resolve; $('editionConfirm').showModal(); $('editionConfirmCancel').focus(); });
  }
  function finishConfirm(value) { if (value && confirmFields) { const reason = $('editionConfirmReason').value.trim(), entered = $('editionConfirmValue').value.trim(); if ((confirmFields.reason && !reason) || (confirmFields.value && !entered) || (confirmFields.exact != null && entered !== confirmFields.exact)) { $('editionConfirmError').textContent = confirmFields.exact != null ? 'Enter the exact edition title and a reason.' : 'Complete the required fields.'; return; } } const done = confirmResolve; confirmResolve = null; $('editionConfirm').close(); if (done) done(value); }
  async function canLeave() { return !state.dirty || await confirmAction('Discard unsaved edition changes?', 'Your saved edition will stay unchanged. Discard the edits in this form?', 'Discard changes'); }
  function markDirty() { if (state.busy || isFinal() || isArchived()) return; state.dirty = true; updateActions(); }
  function updateActions() {
    const e = state.edition, permissionLocked = e?.id ? (options.canUpdate && !options.canUpdate()) : (options.canCreate && !options.canCreate()), locked = !e || isFinal() || isArchived() || permissionLocked, saved = Boolean(e?.id);
    $('editionFields').disabled = state.busy || locked;
    $('editionSave').disabled = state.busy || locked;
    $('editionSave').hidden = locked;
    $('editionCancel').disabled = state.busy || !state.dirty;
    $('editionCancel').hidden = locked;
    $('editionReloadCurrent').hidden = !saved;
    $('editionReloadCurrent').disabled = state.busy;
    $('editionRefresh').hidden = !saved || locked;
    $('editionRefresh').disabled = state.busy || state.dirty;
    $('editionFinalize').hidden = !saved || locked;
    $('editionFinalize').disabled = state.busy || state.dirty || !e?.articles?.length;
    $('editionPreview').hidden = !saved;
    $('editionPreview').setAttribute('aria-disabled', String(state.busy || state.dirty));
    $('editionPreview').setAttribute('tabindex', state.busy || state.dirty ? '-1' : '0');
    $('editionPreview').href = saved ? '/edition-print.html?id=' + e.id : '#';
    $('editionVisibility').hidden = !saved || isArchived() || !isFinal() || e?.mode !== 'published' || !(options.canPublish ? options.canPublish() : true);
    $('editionVisibility').disabled = state.busy;
    $('editionVisibility').textContent = e?.visibility === 'public' ? 'Make edition private' : e?.retracted_at ? 'Share reader edition again' : 'Share reader edition';
    const updateAllowed = !(options.canUpdate && !options.canUpdate());
    for (const [id, hidden] of [['editionRetract', !saved || isArchived() || Boolean(e?.retracted_at) || !isFinal() || !(options.canPublish ? options.canPublish() : true)], ['editionArchive', !saved || isArchived() || !updateAllowed || !(options.canPublish ? options.canPublish() : true)], ['editionRestore', !saved || !isArchived() || !updateAllowed], ['editionRename', !saved || isArchived() || !isFinal() || !updateAllowed || (e?.visibility === 'public' && !(options.canPublish ? options.canPublish() : true))], ['editionDelete', !saved || !isArchived() || !(options.canDelete ? options.canDelete() : false)]]) { $(id).hidden = hidden; $(id).disabled = state.busy || state.dirty; }
    $('editionClose').disabled = state.busy; $('editionNew').disabled = state.busy || Boolean(options.canCreate && !options.canCreate());
    $('editionSaveNote').textContent = state.dirty ? 'Unsaved changes. Save before previewing, refreshing or finalizing.' : saved ? (isFinal() ? 'Finalized: text, order and layout are locked; Rename issue changes only its display title. A withdrawn source makes the shared issue unavailable. Printed copies cannot be recalled.' : permissionLocked ? 'Read-only access. You can preview this saved working edition; editing requires article update permission.' : 'Saved snapshot. Refresh explicitly to include newer article text. Finalizing never publishes articles.') : 'Save to enable preview. Nothing here publishes a source article.';
    $('editionCopyLink').disabled = state.busy;
    $('editionEditor').setAttribute('aria-busy', String(state.busy));
  }
  function renderSelection() {
    const e = state.edition;
    $('editionSelection').innerHTML = e.articles.length ? e.articles.map((a, index) => {
      const id = safeId(a.article_id || a.id), lead = id === Number(e.lead_article_id);
      return '<li class="edition-story-card"><span class="edition-story-number">' + (index + 1) + '</span><div>' + (lead ? '<span class="edition-lead">Lead story</span>' : '') + '<h4>' + esc(a.title || 'Untitled article') + '</h4><p class="edition-note">' + esc([a.byline || a.author, a.category, formatDate(a.source_updated_at || a.published_at)].filter(Boolean).join(' · ')) + '</p>' + (a.withdrawn ? '<p class="edition-note">Source withdrawn or no longer eligible. Retained in this private archive; sharing is unavailable.</p>' : '') + (a.image_notice ? '<p class="edition-note">' + esc(a.image_notice) + '</p>' : '') + (!isFinal() && !isArchived() ? '<div class="edition-story-controls"><button class="btn btn-outline" type="button" data-action="lead" data-id="' + id + '"' + (lead ? ' disabled' : '') + '>Make lead</button><button class="btn btn-outline" type="button" data-action="up" data-id="' + id + '" aria-label="Move ' + esc(a.title) + ' up"' + (index === 0 ? ' disabled' : '') + '>↑ Up</button><button class="btn btn-outline" type="button" data-action="down" data-id="' + id + '" aria-label="Move ' + esc(a.title) + ' down"' + (index === e.articles.length - 1 ? ' disabled' : '') + '>↓ Down</button><button class="btn btn-ghost" type="button" data-action="remove" data-id="' + id + '">Remove from edition</button></div>' : '') + '</div></li>';
    }).join('') : '<li class="edition-empty">No articles selected. Add published original articles, or use a private proof for drafts.</li>';
  }
  function renderEditor() {
    renderList();
    const e = state.edition; $('editionEditor').hidden = !e; $('editionWelcome').hidden = Boolean(e); if (!e) return;
    $('editionEditorTitle').textContent = e.id ? e.name : 'New edition';
    $('editionState').textContent = (isArchived() ? 'Archived' : isFinal() ? 'Finalized' : 'Working edition') + (e.retracted_at ? ' / Retracted' : '') + ' · ' + (e.visibility === 'public' ? 'Shared reader issue' : 'Private') + (e.mode === 'proof' ? ' · DRAFT PROOF' : '');
    $('editionPolicy').textContent = e.mode === 'proof' ? 'Private editorial proof: drafts may be included. Every printed page is marked DRAFT. This edition cannot be publicly shared.' : 'Reader edition: only published, platform-authored articles are eligible. Saving and finalizing do not publish source articles.';
    $('editionName').value = e.name; $('editionDate').value = formatDate(e.issue_date); $('editionMode').value = e.mode;
    $('editionPaper').value = e.settings.paper; $('editionInk').checked = e.settings.ink_saving; $('editionImages').checked = e.settings.images; $('editionContributors').checked = e.settings.contributors === true; $('editionPortraits').checked = e.settings.portraits === true;
    $('editionMode').disabled = Boolean(e.id); // Mode is fixed after first save.
    $('editionPublicLink').hidden = e.visibility !== 'public'; $('editionCopyLink').hidden = e.visibility !== 'public' || isArchived() || Boolean(e.retracted_at); $('editionCopyLink').disabled = state.busy;
    $('editionShareUrl').value = (options.publicOrigin || '') + '/edition-print.html?id=' + encodeURIComponent(e.id || '') + '&public=1'; $('editionShareUrlWrap').hidden = $('editionCopyLink').hidden;
    $('editionPublicLink').innerHTML = e.visibility === 'public' ? '<a href="/edition-print.html?id=' + e.id + '&amp;public=1" target="_blank" rel="noopener">Open shared reader edition</a> · Shared editions stop serving if any source is withdrawn.' : '';
    renderSelection(); updateActions();
  }
  async function copyShareLink() {
    const e = state.edition; if (!e?.id || e.visibility !== 'public' || e.archived_at || e.retracted_at || state.busy) return;
    const text = $('editionShareUrl').value;
    try { if (!options.copyText) throw new Error('Unavailable'); await options.copyText(text); if (state.edition === e) notice('Reader share link copied.'); }
    catch { if (state.edition === e) { $('editionShareUrl').focus(); $('editionShareUrl').select?.(); notice('Clipboard unavailable. Select and copy the visible reader link.'); } }
  }
  function acceptEdition(edition) { $('editionHistory').innerHTML = '';  state.edition = copy(edition); state.saved = copy(edition); state.dirty = false; state.requestId = null; renderEditor(); }
  async function newEdition() {
    if (state.busy || (options.canCreate && !options.canCreate()) || !(await canLeave())) return;
    ++openVersion;
    state.edition = { name: '', issue_date: new Date().toISOString().slice(0, 10), mode: 'published', status: 'working', visibility: 'private', settings: { paper: 'Letter', ink_saving: false, images: true, contributors: true, portraits: true }, articles: [], lead_article_id: null };
    state.saved = null; state.dirty = false; state.requestId = options.uuid ? options.uuid() : '00000000-0000-4000-8000-000000000001';
    renderEditor(); options.navigate?.(null); $('editionName').focus(); notice('New private edition. Choose your articles, then save.');
  }
  async function openEdition(id, navigate = true) {
    id = editionId(id); if (!id || (state.busy && !state.opening)) return false;
    const version = ++openVersion; if (!(await canLeave()) || version !== openVersion) return false;
    state.busy = true; state.opening = true; updateActions(); notice('Loading edition.');
    try { const result = await api('/editions/' + id); if (version !== openVersion) return false; acceptEdition(result.edition); options.navigate?.(result.edition.id, !navigate || String(result.edition.id) !== id); notice('Edition loaded.'); loadHistory(); return true; }
    catch { if (version === openVersion) { options.navigate?.(state.edition?.id, true); notice('Could not open this edition. Check your access or try again. Your current form has been preserved.'); } return false; }
    finally { if (version === openVersion) { state.busy = false; state.opening = false; updateActions(); } }
  }
  async function loadHistory() {
    const id = state.edition?.id, revision = state.edition?.revision; if (!id) return;
    try { const result = await api('/editions/' + id + '/history'); if (state.edition?.id !== id || state.edition?.revision !== revision) return;
      $('editionHistory').innerHTML = (result.history || []).map(h => '<li><strong>' + esc(h.action) + '</strong> / ' + esc(String(h.created_at || '').replace('T', ' ').slice(0, 19)) + (h.reason ? '<p>' + esc(h.reason) + '</p>' : '') + '</li>').join('') || '<li>No recorded lifecycle actions.</li>';
    } catch { if (state.edition?.id === id && state.edition?.revision === revision) $('editionHistory').textContent = 'History unavailable. Reload the edition to retry.'; }
  }
  function renderList() {
    $('editionList').innerHTML = state.list.length ? state.list.map(e => '<button class="edition-library-item" data-open="' + esc(editionId(e.id)) + '" aria-current="' + (String(e.id) === String(state.edition?.id)) + '"><strong>' + esc(e.name) + '</strong><span>' + esc(formatDate(e.issue_date)) + ' · ' + esc(e.archived_at ? 'archived' : e.retracted_at ? 'retracted' : e.status) + '</span><span>' + (e.mode === 'proof' ? 'Private draft proof' : e.visibility === 'public' ? 'Shared reader issue' : 'Private reader edition') + '</span></button>').join('') : '<p class="edition-empty">No saved editions yet. Create your first issue with the articles already in your newsroom.</p>';
    $('editionListPrev').disabled = state.listBusy || state.listOffset === 0; $('editionListNext').disabled = state.listBusy || state.listOffset + 20 >= state.listTotal;
    $('editionListPage').textContent = state.listTotal ? (state.listOffset + 1) + '–' + Math.min(state.listOffset + 20, state.listTotal) + ' of ' + state.listTotal : '0 editions';
  }
  async function loadList() {
    const version = ++listVersion; state.listBusy = true; $('editionList').setAttribute('aria-busy', 'true'); $('editionReload').disabled = true; renderList();
    try { const result = await api('/editions?limit=20&offset=' + state.listOffset + '&view=' + state.view); if (version !== listVersion) return; state.list = result.editions || []; state.listTotal = Number(result.total) || 0; }
    catch { if (version !== listVersion) return; state.list = []; state.listTotal = 0; notice('Unable to load saved editions. Use Reload to try again; your current edits are preserved.'); }
    finally { if (version === listVersion) { state.listBusy = false; $('editionReload').disabled = false; $('editionList').setAttribute('aria-busy', 'false'); renderList(); } }
  }
  function payload() {
    const e = state.edition;
    return { name: $('editionName').value.trim(), issue_date: $('editionDate').value, mode: e.mode, article_ids: e.articles.map(a => Number(a.article_id || a.id)), lead_article_id: e.lead_article_id, settings: { paper: $('editionPaper').value, ink_saving: $('editionInk').checked, images: $('editionImages').checked, contributors: $('editionContributors').checked, portraits: $('editionPortraits').checked } };
  }
  async function save() {
    if (state.busy || !state.edition || isFinal() || isArchived()) return;
    const body = payload();
    if (!body.name || !body.issue_date || !body.article_ids.length) { notice('Add an edition name, issue date, and at least one eligible article before saving.'); return; }
    const id = state.edition.id;
    if (id) body.revision = state.edition.revision; else body.request_id = state.requestId;
    state.busy = true; updateActions(); notice('Saving edition…');
    try { const result = await api('/editions' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); acceptEdition(result.edition); loadHistory(); if (!id) options.navigate?.(result.edition.id); notice('Edition saved. Preview is ready; no source articles were changed.'); await loadList(); }
    catch (error) { notice('Could not confirm the save. Your edits are preserved. ' + (failureReason(error) || 'Retry is safe with unchanged details; reload the saved edition before changing an uncertain save.')); }
    finally { state.busy = false; updateActions(); }
  }
  async function action(kind) {
    if (state.busy || !state.edition?.id || state.dirty) return;
    const e = state.edition;
    if (kind === 'visibility' && e.visibility === 'public') return lifecycle('retract');
    const descriptions = {
      refresh: ['Refresh article snapshots?', 'Replace this working edition’s captured text and images with the latest eligible source versions. This does not change or publish the source articles.', 'Refresh snapshots'],
      finalize: ['Finalize this issue?', 'Lock the saved article text, order and layout. Its display title can still be renamed separately; captured content remains locked. Source articles will not be published.', 'Finalize issue'],
      visibility: e.visibility === 'public' ? ['Make this issue private?', 'The shared reader link will stop serving this issue. Previously printed or downloaded copies cannot be recalled.', 'Make private'] : ['Share this reader issue?', 'Anyone with its public link may read and print this finalized edition. Only eligible published articles may be included. No source article will be published by this action.', 'Share reader issue'],
    };
    if (!descriptions[kind] || !(await confirmAction(...descriptions[kind]))) return;
    if (state.busy || state.edition !== e) return;
    state.busy = true; updateActions(); notice('Updating edition…');
    const body = revisionBody(); if (kind === 'visibility') body.visibility = e.visibility === 'public' ? 'private' : 'public';
    try { const result = await api('/editions/' + e.id + '/' + kind, { method: 'POST', body: JSON.stringify(body) }); acceptEdition(result.edition); loadHistory(); notice(kind === 'finalize' ? 'Issue finalized and ready to preview. Source publication has not changed.' : kind === 'refresh' ? 'Article snapshots refreshed.' : result.edition.visibility === 'public' ? 'Reader issue shared. Use its public link below.' : 'Issue is private.'); await loadList(); }
    catch (error) { notice('Could not confirm this update. ' + (failureReason(error) || 'Reload the edition to check its saved state before retrying. No automatic repeat was sent.')); }
    finally { state.busy = false; updateActions(); }
  }
  async function lifecycle(kind) {
    if (state.busy || state.dirty || !state.edition?.id) return;
    const e = state.edition, canUpdate = !(options.canUpdate && !options.canUpdate());
    if (kind === 'delete' ? !e.archived_at || !(options.canDelete && options.canDelete()) : kind === 'retract' ? e.archived_at || e.retracted_at || !isFinal() || !(options.canPublish ? options.canPublish() : true) : !canUpdate || (kind === 'restore' ? !e.archived_at : e.archived_at) || (kind === 'rename' && !isFinal())) return;
    if ((kind === 'archive' || (kind === 'rename' && e.visibility === 'public')) && !(options.canPublish ? options.canPublish() : true)) return;
    const prompts = {
      retract: ['Retract this issue?', 'Stop public access and record why. Saved snapshots stay intact; printed/downloaded copies cannot be recalled.', 'Retract issue', { reason: true }],
      archive: ['Archive this issue?', 'Move it to the private archive and stop public access. Source articles stay unchanged. You can restore the issue privately.', 'Archive issue', { reason: true }],
      restore: ['Restore this issue privately?', 'Return this issue to the active list. Restoration does not share it or publish articles.', 'Restore privately'],
      rename: ['Rename finalized issue', 'Change only the displayed issue title, including its print masthead. Saved article text, images, references and order remain unchanged.', 'Save title', { value: 'New edition title', initial: e.name }],
      delete: ['Permanently delete archived issue?', 'Delete this edition and its captured assets permanently. Source articles stay unchanged. Printed/downloaded copies cannot be recalled. This cannot be undone.', 'Delete permanently', { reason: true, value: 'Type the exact edition title: ' + e.name, exact: e.name }],
    };
    if (!prompts[kind] || !(await confirmAction(...prompts[kind])) || state.edition !== e || state.busy) return;
    const body = { revision: e.revision }; if (['retract', 'archive', 'delete'].includes(kind)) body.reason = $('editionConfirmReason').value.trim();
    if (kind === 'rename') body.name = $('editionConfirmValue').value.trim(); if (kind === 'delete') body.confirmation = $('editionConfirmValue').value.trim();
    state.busy = true; updateActions();
    try { const result = await api('/editions/' + e.id + (kind === 'delete' ? '' : '/' + kind), { method: kind === 'delete' ? 'DELETE' : 'POST', body: JSON.stringify(body) });
      if (kind === 'delete') { ++openVersion; state.edition = null; state.saved = null; renderEditor(); options.navigate?.(null); notice('Archived edition deleted. Source articles were not changed.'); }
      else { acceptEdition(result.edition); loadHistory(); notice(kind === 'rename' ? 'Issue title updated; captured articles are unchanged.' : kind === 'restore' ? 'Issue restored privately.' : kind === 'archive' ? 'Issue archived privately.' : 'Issue retracted. Public access has stopped.'); }
      await loadList();
    } catch (error) { notice('Could not confirm this action. ' + (failureReason(error) || 'Reload the edition to check its saved state before retrying. No automatic repeat was sent.')); }
    finally { state.busy = false; updateActions(); }
  }
  async function discard() { if (state.busy || !state.dirty || !(await canLeave())) return; if (state.saved) acceptEdition(state.saved); else { state.dirty = false; await newEdition(); } notice('Unsaved changes discarded.'); }
  async function closeEditor() { if (state.busy || !(await canLeave())) return; ++openVersion; state.edition = null; state.saved = null; state.dirty = false; renderEditor(); options.navigate?.(null); $('editionNew').focus(); }
  function selectedAction(kind, id) {
    if (state.busy || !state.edition || isFinal() || isArchived()) return;
    const e = state.edition, index = e.articles.findIndex(a => Number(a.article_id || a.id) === Number(id)); if (index < 0) return;
    if (kind === 'lead') { e.lead_article_id = Number(id); e.articles.unshift(e.articles.splice(index, 1)[0]); }
    if (kind === 'up' && index > 0) [e.articles[index - 1], e.articles[index]] = [e.articles[index], e.articles[index - 1]];
    if (kind === 'down' && index < e.articles.length - 1) [e.articles[index + 1], e.articles[index]] = [e.articles[index], e.articles[index + 1]];
    if (kind === 'remove') { e.articles.splice(index, 1); if (e.lead_article_id === Number(id)) e.lead_article_id = Number(e.articles[0]?.article_id || e.articles[0]?.id) || null; }
    if (kind === 'up' || kind === 'down') e.lead_article_id = Number(e.articles[0]?.article_id || e.articles[0]?.id) || null;
    markDirty(); renderSelection(); notice(kind === 'remove' ? 'Removed from this edition only. Save to keep the change.' : 'Article order or lead changed. Save to keep the change.');
  }
  function renderPicked() { $('editionPickedCount').textContent = state.picked.size + ' selected · ' + state.edition.articles.length + ' already in edition'; $('editionPickerApply').disabled = !state.picked.size || state.busy; $('editionPickerApply').textContent = 'Add ' + state.picked.size + ' article' + (state.picked.size === 1 ? '' : 's'); }
  function renderResults() {
    const attached = new Set(state.edition.articles.map(a => Number(a.article_id || a.id)));
    $('editionResults').innerHTML = state.results.length ? state.results.map(a => { const id = Number(a.id || a.article_id), added = attached.has(id); return '<label class="edition-result"><input type="checkbox" data-pick="' + id + '"' + (added || state.picked.has(id) ? ' checked' : '') + (added ? ' disabled' : '') + '><span><strong>' + esc(a.title) + '</strong><small>' + esc([a.byline || a.author, a.category, formatDate(a.published_at || a.created_at), added ? 'Already added' : a.is_published ? 'Published' : 'Editorial proof source'].filter(Boolean).join(' · ')) + '</small><p>' + esc(String(a.summary || '').slice(0, 500)) + '</p></span></label>'; }).join('') : '<p class="edition-empty">No eligible articles match this search. Try another title, or review your content mode.</p>';
    $('editionSearchPrev').disabled = state.searchBusy || state.searchOffset === 0; $('editionSearchNext').disabled = state.searchBusy || state.searchOffset + 20 >= state.searchTotal;
    $('editionSearchPage').textContent = state.searchTotal ? (state.searchOffset + 1) + '–' + Math.min(state.searchOffset + 20, state.searchTotal) + ' of ' + state.searchTotal : '0 articles'; renderPicked();
  }
  async function searchArticles() {
    if (!state.edition) return;
    const version = ++searchVersion; state.searchBusy = true; $('editionPickerStatus').textContent = 'Searching eligible articles…'; $('editionResults').setAttribute('aria-busy', 'true'); renderResults();
    try { const result = await api('/editions/articles?mode=' + state.edition.mode + '&q=' + encodeURIComponent(state.query) + '&limit=20&offset=' + state.searchOffset); if (version !== searchVersion) return; state.results = result.articles || []; state.searchTotal = Number(result.total) || 0; $('editionPickerStatus').textContent = state.searchTotal + ' eligible article' + (state.searchTotal === 1 ? '' : 's') + '. Selections are retained across searches and pages.'; }
    catch { if (version !== searchVersion) return; state.results = []; state.searchTotal = 0; $('editionPickerStatus').textContent = 'Unable to load articles. Search again to retry. Your selections are preserved.'; }
    finally { if (version === searchVersion) { state.searchBusy = false; $('editionResults').setAttribute('aria-busy', 'false'); renderResults(); } }
  }
  function openPicker() {
    if (state.busy || !state.edition || isFinal() || isArchived()) return;
    pickerReturn = document.activeElement; state.picked.clear(); state.results = []; state.query = ''; state.searchOffset = 0; $('editionSearch').value = '';
    $('editionPickerPolicy').textContent = state.edition.mode === 'proof' ? 'Private proof: platform-authored drafts and published articles. No RSS full text. Your edition will be marked DRAFT.' : 'Published, platform-authored articles only. Imported RSS full text is not eligible.';
    $('editionPicker').showModal(); $('editionSearch').focus(); return searchArticles();
  }
  function closePicker() { ++searchVersion; state.searchBusy = false; state.picked.clear(); $('editionPicker').close(); pickerReturn?.focus?.(); }
  function togglePick(id, checked) {
    id = Number(id); if (checked) { if (state.edition.articles.length + state.picked.size >= 20) { $('editionPickerStatus').textContent = 'An edition can include up to 20 articles. Remove a selection before adding another.'; renderResults(); return; } const a = state.results.find(a => Number(a.id || a.article_id) === id); if (a) state.picked.set(id, copy(a)); } else state.picked.delete(id); renderPicked();
  }
  function applyPicker() {
    if (state.busy || !state.edition || !state.picked.size) return;
    const ids = new Set(state.edition.articles.map(a => Number(a.article_id || a.id))); for (const [id, a] of state.picked) { if (!ids.has(id) && state.edition.articles.length < 20) { state.edition.articles.push({ ...a, article_id: id }); ids.add(id); } }
    if (!state.edition.lead_article_id) state.edition.lead_article_id = Number(state.edition.articles[0].article_id || state.edition.articles[0].id);
    markDirty(); renderSelection(); closePicker(); notice('Articles added to your working selection. Save to capture their text and images.');
  }
  async function changeMode() { const e = state.edition; if (!e || e.id || state.busy) return; const desired = $('editionMode').value; if (e.articles.length && !(await confirmAction('Change content mode?', 'Clear this unsaved article selection before switching modes? Source articles stay unchanged.', 'Change mode'))) { $('editionMode').value = e.mode; return; } e.mode = desired; e.articles = []; e.lead_article_id = null; markDirty(); $('editionPolicy').textContent = desired === 'proof' ? 'Private editorial proof: drafts may be included. This edition cannot be publicly shared.' : 'Only published, platform-authored articles are eligible.'; renderSelection(); }
  function init() {
    updateActions();
    $('editionCopyLink').addEventListener('click', copyShareLink);
    $('editionListView').addEventListener('change', () => { state.view = $('editionListView').value; state.listOffset = 0; loadList(); });
    for (const kind of ['retract','archive','restore','rename','delete']) $('edition' + kind[0].toUpperCase() + kind.slice(1)).addEventListener('click', () => lifecycle(kind));
    $('editionNew').addEventListener('click', newEdition); $('editionReload').addEventListener('click', loadList);
    $('editionList').addEventListener('click', event => { const target = event.target.closest('[data-open]'); if (target) openEdition(target.dataset.open); });
    $('editionListPrev').addEventListener('click', () => { if (!state.listBusy) { state.listOffset = Math.max(0, state.listOffset - 20); loadList(); } });
    $('editionListNext').addEventListener('click', () => { if (!state.listBusy) { state.listOffset += 20; loadList(); } });
    $('editionForm').addEventListener('submit', event => { event.preventDefault(); save(); });
    for (const id of ['editionName','editionDate','editionPaper','editionInk','editionImages','editionContributors','editionPortraits']) $(id).addEventListener('input', markDirty);
    $('editionMode').addEventListener('change', changeMode); $('editionCancel').addEventListener('click', discard); $('editionClose').addEventListener('click', closeEditor);
    $('editionReloadCurrent').addEventListener('click', () => openEdition(state.edition?.id, false));
    $('editionRefresh').addEventListener('click', () => action('refresh')); $('editionFinalize').addEventListener('click', () => action('finalize')); $('editionVisibility').addEventListener('click', () => action('visibility'));
    $('editionPreview').addEventListener('click', event => { if (state.dirty || state.busy) { event.preventDefault(); notice('Save your changes before opening preview.'); } });
    $('editionSelection').addEventListener('click', event => { const target = event.target.closest('[data-action]'); if (target) selectedAction(target.dataset.action, target.dataset.id); });
    $('editionAdd').addEventListener('click', openPicker); $('editionPickerClose').addEventListener('click', closePicker); $('editionPicker').addEventListener('cancel', event => { event.preventDefault(); closePicker(); });
    $('editionPickerApply').addEventListener('click', applyPicker); $('editionResults').addEventListener('change', event => { if (event.target.dataset.pick) togglePick(event.target.dataset.pick, event.target.checked); });
    $('editionSearchForm').addEventListener('submit', event => { event.preventDefault(); state.query = $('editionSearch').value.trim(); state.searchOffset = 0; searchArticles(); });
    $('editionSearchPrev').addEventListener('click', () => { if (!state.searchBusy) { state.searchOffset = Math.max(0, state.searchOffset - 20); searchArticles(); } });
    $('editionSearchNext').addEventListener('click', () => { if (!state.searchBusy) { state.searchOffset += 20; searchArticles(); } });
    $('editionConfirmCancel').addEventListener('click', () => finishConfirm(false)); $('editionConfirmAccept').addEventListener('click', () => finishConfirm(true)); $('editionConfirm').addEventListener('cancel', event => { event.preventDefault(); finishConfirm(false); });
    options.beforeUnload?.(event => { if (state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
    options.onPopState?.(async search => { const id = editionId(new URLSearchParams(search).get('id')); if (state.dirty || (state.busy && !state.opening)) { options.navigate?.(state.edition?.id, true); notice('Finish or discard your edition changes before navigating back.'); return; } if (id) await openEdition(id, false); else { ++openVersion; state.busy = false; state.opening = false; state.edition = null; state.saved = null; renderEditor(); } });
    const id = editionId(new URLSearchParams(options.search || '').get('id')); return Promise.all([loadList(), id ? openEdition(id, false) : Promise.resolve()]);
  }
  return { init, state, loadList, newEdition, openEdition, save, action, lifecycle, copyShareLink, discard, closeEditor, openPicker, closePicker, searchArticles, togglePick, applyPicker, selectedAction, changeMode, finishConfirm, renderEditor, markDirty, payload };
});
