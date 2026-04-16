/* global apiFetch, openModal, closeModal */
/**
 * Shared "Discuss with an agent" picker.
 * Included on any admin page that needs a 💬 Discuss button.
 * Creates its own modal DOM on first call — no HTML changes needed per page.
 */
(function () {
  'use strict';

  var _agentCache = null;
  var _pendingArticle = null;

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Modal DOM (injected once) ─────────────────────────────
  function ensureModal() {
    if (document.getElementById('discussPickerModal')) return;
    var el = document.createElement('div');
    el.innerHTML = [
      '<div class="modal-overlay" id="discussPickerModal">',
      '  <div class="modal" style="max-width:460px;padding:0;">',
      '    <div class="modal-header">',
      '      <div class="modal-title">Discuss with\u2026</div>',
      '      <button class="modal-close" data-close-modal>\u2715</button>',
      '    </div>',
      '    <div style="padding:10px 16px 8px;background:var(--surface2);border-bottom:1px solid var(--border);">',
      '      <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Article</div>',
      '      <div id="discussArticleContext" style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>',
      '    </div>',
      '    <div class="modal-body" id="discussPickerBody" style="padding:0;max-height:60vh;overflow-y:auto;"></div>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(el.firstElementChild);
    // Re-init modals so close buttons work (admin.js exposes initModals)
    if (typeof initModals === 'function') initModals();
  }

  // ── Agent loader (cached) ─────────────────────────────────
  async function loadAgents() {
    if (_agentCache) return _agentCache;
    try {
      var data = await apiFetch('/newsroom-chat/writers');
      _agentCache = data.writers || [];
    } catch (_) {
      _agentCache = [];
    }
    return _agentCache;
  }

  // ── Render picker ─────────────────────────────────────────
  function agentRow(w, articleCategory) {
    var avatarInner = w.avatar_url
      ? '<img class="discuss-picker-avatar" src="' + escHtml(w.avatar_url) + '" alt="" style="width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;" />'
      : '<div class="discuss-picker-avatar" style="background:' + escHtml(w.accent || '#6366f1') + ';color:#fff;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;">'
        + escHtml((w.name || '?').charAt(0).toUpperCase()) + '</div>';
    var sub = w.beat || w.role || '';
    var artCat = (articleCategory || '').toLowerCase();
    var beat = (w.beat || '').toLowerCase();
    var isMatch = artCat && beat && beat.includes(artCat);
    var match = isMatch ? '<span class="discuss-picker-match">Beat match</span>' : '';
    return '<div class="discuss-picker-item" data-writer-id="' + w.id + '" style="cursor:pointer;">'
      + avatarInner
      + '<div class="discuss-picker-meta" style="flex:1;min-width:0;margin-left:10px;">'
        + '<div class="discuss-picker-name">' + escHtml(w.name) + '</div>'
        + (sub ? '<div class="discuss-picker-sub">' + escHtml(sub) + '</div>' : '')
      + '</div>'
      + match
      + '</div>';
  }

  async function renderPicker(articleId, title, category) {
    var bodyEl = document.getElementById('discussPickerBody');
    var ctxEl = document.getElementById('discussArticleContext');
    if (ctxEl) ctxEl.textContent = title || ('Article #' + articleId);
    if (bodyEl) bodyEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;">Loading agents\u2026</div>';

    var agents = await loadAgents();
    if (!agents.length) {
      if (bodyEl) bodyEl.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:13px;">No agents found. Enable the Editor Workspace feature first.</div>';
      return;
    }

    var system = agents.filter(function (w) { return w.is_system; });
    var writers = agents.filter(function (w) { return !w.is_system; });
    // Sort writer agents so beat-matches come first
    var artCat = (category || '').toLowerCase();
    writers.sort(function (a, b) {
      var aMatch = artCat && (a.beat || '').toLowerCase().includes(artCat) ? 1 : 0;
      var bMatch = artCat && (b.beat || '').toLowerCase().includes(artCat) ? 1 : 0;
      return bMatch - aMatch;
    });

    var html = '';
    if (system.length) {
      html += '<div class="discuss-picker-section"><div class="discuss-picker-heading">System Agents</div>'
        + system.map(function (w) { return agentRow(w, category); }).join('')
        + '</div>';
    }
    if (writers.length) {
      html += '<div class="discuss-picker-section" style="' + (system.length ? 'border-top:1px solid var(--border);' : '') + '">'
        + '<div class="discuss-picker-heading">Writer Agents</div>'
        + writers.map(function (w) { return agentRow(w, category); }).join('')
        + '</div>';
    }
    if (bodyEl) {
      bodyEl.innerHTML = html;
      bodyEl.querySelectorAll('[data-writer-id]').forEach(function (el) {
        el.addEventListener('click', function () {
          var writerId = parseInt(el.dataset.writerId, 10);
          closeModal('discussPickerModal');
          window.location.href = '/newsroom-chat.html?writer_id=' + writerId + '&article_id=' + articleId;
        });
      });
    }
  }

  // ── Public API ────────────────────────────────────────────
  window.discussArticle = function (articleId, title, category) {
    ensureModal();
    _pendingArticle = { id: articleId, title: title, category: category };
    openModal('discussPickerModal');
    renderPicker(articleId, title, category);
  };
})();
