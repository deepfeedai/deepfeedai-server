/**
 * Deep Feed AI Admin — banners-page.js
 * Tenant-level banner management (CRUD).
 */
(function () {
  'use strict';

  // apiFetch, showToast, openModal, closeModal are globals from admin.js

  const TYPE_ICONS = { info: '\u2139\uFE0F', warning: '\u26A0\uFE0F', error: '\uD83D\uDEA8', success: '\u2705' };

  // ── Load banners ────────────────────────────────────────────
  async function loadBanners() {
    const body = document.getElementById('bannersBody');
    try {
      const banners = await apiFetch('/banners');
      if (!banners.length) {
        body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No banners yet. Click <strong>+ New Banner</strong> to create one.</div></td></tr>';
        return;
      }
      body.innerHTML = banners.map(b => {
        const active = b.is_active;
        const now = new Date();
        const started = !b.starts_at || new Date(b.starts_at) <= now;
        const expired = b.expires_at && new Date(b.expires_at) <= now;
        let statusHtml;
        if (!active) statusHtml = '<span class="badge badge-muted">Inactive</span>';
        else if (expired) statusHtml = '<span class="badge badge-muted">Expired</span>';
        else if (!started) statusHtml = '<span class="badge" style="background:var(--accent);color:#fff;">Scheduled</span>';
        else statusHtml = '<span class="badge badge-success">Live</span>';

        const scheduleHtml = [
          b.starts_at ? 'From ' + shortDate(b.starts_at) : '',
          b.expires_at ? 'Until ' + shortDate(b.expires_at) : '',
        ].filter(Boolean).join('<br>') || '<span class="text-muted">Always</span>';

        return `<tr>
          <td>
            <div style="max-width:400px;">
              <div style="font-weight:500;">${esc(b.message)}</div>
              ${b.link_text ? '<div class="text-muted text-sm">' + esc(b.link_text) + ' &rarr; ' + esc(b.link_url || '') + '</div>' : ''}
            </div>
          </td>
          <td class="text-center"><span class="banner-type-badge banner-type-badge--${b.type || 'info'}">${b.type || 'info'}</span></td>
          <td class="text-center">${statusHtml}</td>
          <td class="text-center text-sm">${scheduleHtml}</td>
          <td class="text-center">
            <div style="display:flex;gap:4px;justify-content:center;">
              <button class="btn btn-outline btn-sm" data-edit="${b.id}" title="Edit">Edit</button>
              <button class="btn btn-outline btn-sm ${active ? '' : 'btn-primary'}" data-toggle="${b.id}" data-active="${active}" title="${active ? 'Deactivate' : 'Activate'}">${active ? 'Deactivate' : 'Activate'}</button>
              <button class="btn btn-outline btn-sm btn-danger" data-delete="${b.id}" title="Delete">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('');

      // Wire up action buttons
      body.querySelectorAll('[data-edit]').forEach(btn => {
        btn.addEventListener('click', () => editBanner(banners.find(b => b.id === parseInt(btn.dataset.edit))));
      });
      body.querySelectorAll('[data-toggle]').forEach(btn => {
        btn.addEventListener('click', () => toggleBanner(parseInt(btn.dataset.toggle), btn.dataset.active === 'true'));
      });
      body.querySelectorAll('[data-delete]').forEach(btn => {
        btn.addEventListener('click', () => deleteBanner(parseInt(btn.dataset.delete)));
      });
    } catch (err) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty-state text-danger">Failed to load banners</div></td></tr>';
    }
  }

  // ── Create / Edit ────────────────────────────────────────────
  function resetForm() {
    document.getElementById('bannerId').value = '';
    document.getElementById('bannerMessage').value = '';
    document.getElementById('bannerType').value = 'info';
    document.getElementById('bannerPriority').value = '0';
    document.getElementById('bannerLinkText').value = '';
    document.getElementById('bannerLinkUrl').value = '';
    document.getElementById('bannerStartsAt').value = '';
    document.getElementById('bannerExpiresAt').value = '';
    document.getElementById('bannerDismissible').checked = true;
    updatePreview();
  }

  function editBanner(b) {
    document.getElementById('bannerModalTitle').textContent = 'Edit Banner';
    document.getElementById('bannerId').value = b.id;
    document.getElementById('bannerMessage').value = b.message || '';
    document.getElementById('bannerType').value = b.type || 'info';
    document.getElementById('bannerPriority').value = b.priority || 0;
    document.getElementById('bannerLinkText').value = b.link_text || '';
    document.getElementById('bannerLinkUrl').value = b.link_url || '';
    document.getElementById('bannerStartsAt').value = b.starts_at ? toLocalInput(b.starts_at) : '';
    document.getElementById('bannerExpiresAt').value = b.expires_at ? toLocalInput(b.expires_at) : '';
    document.getElementById('bannerDismissible').checked = b.dismissible !== false && b.dismissible !== 0;
    updatePreview();
    openModal('bannerModal');
  }

  async function saveBanner() {
    const id = document.getElementById('bannerId').value;
    const payload = {
      message:     document.getElementById('bannerMessage').value.trim(),
      type:        document.getElementById('bannerType').value,
      priority:    parseInt(document.getElementById('bannerPriority').value) || 0,
      linkText:    document.getElementById('bannerLinkText').value.trim() || null,
      linkUrl:     document.getElementById('bannerLinkUrl').value.trim() || null,
      startsAt:    document.getElementById('bannerStartsAt').value ? new Date(document.getElementById('bannerStartsAt').value).toISOString() : null,
      expiresAt:   document.getElementById('bannerExpiresAt').value ? new Date(document.getElementById('bannerExpiresAt').value).toISOString() : null,
      dismissible: document.getElementById('bannerDismissible').checked,
    };

    if (!payload.message) {
      showToast('Message is required', 'error');
      return;
    }

    try {
      if (id) {
        await apiFetch('/banners/' + id, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Banner updated');
      } else {
        await apiFetch('/banners', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Banner created');
      }
      closeModal('bannerModal');
      loadBanners();
    } catch (err) {
      showToast(err.message || 'Failed to save banner', 'error');
    }
  }

  async function toggleBanner(id, currentlyActive) {
    try {
      await apiFetch('/banners/' + id, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !currentlyActive }),
      });
      showToast(currentlyActive ? 'Banner deactivated' : 'Banner activated');
      loadBanners();
    } catch (err) {
      showToast(err.message || 'Failed to toggle banner', 'error');
    }
  }

  async function deleteBanner(id) {
    if (!confirm('Delete this banner?')) return;
    try {
      await apiFetch('/banners/' + id, { method: 'DELETE' });
      showToast('Banner deleted');
      loadBanners();
    } catch (err) {
      showToast(err.message || 'Failed to delete banner', 'error');
    }
  }

  // ── Live preview ─────────────────────────────────────────────
  function updatePreview() {
    const preview = document.getElementById('bannerPreview');
    const message = document.getElementById('bannerMessage').value || 'Your banner message will appear here';
    const type = document.getElementById('bannerType').value;
    const linkText = document.getElementById('bannerLinkText').value;
    const icon = TYPE_ICONS[type] || TYPE_ICONS.info;

    preview.className = 'banner-preview banner-preview--' + type;
    preview.innerHTML = '<span>' + icon + ' ' + esc(message) +
      (linkText ? ' <strong>' + esc(linkText) + '</strong>' : '') + '</span>';
  }

  // ── Helpers ──────────────────────────────────────────────────
  function esc(str) { return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function toLocalInput(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ── Init ─────────────────────────────────────────────────────
  renderSidebar();

  document.getElementById('addBannerBtn')?.addEventListener('click', () => {
    document.getElementById('bannerModalTitle').textContent = 'New Banner';
    resetForm();
    openModal('bannerModal');
  });

  document.getElementById('saveBannerBtn')?.addEventListener('click', saveBanner);

  // Live preview updates
  document.getElementById('bannerMessage')?.addEventListener('input', updatePreview);
  document.getElementById('bannerType')?.addEventListener('change', updatePreview);
  document.getElementById('bannerLinkText')?.addEventListener('input', updatePreview);

  loadBanners();
})();
