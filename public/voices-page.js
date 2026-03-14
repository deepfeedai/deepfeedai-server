let voices = [];
  let pendingDeleteId = null;
  let pendingAvatarDataUrl = null;

  async function loadVoices() {
    try {
      voices = await apiFetch('/voices');
      renderVoices();
      if (typeof populateStudioVoices === 'function') populateStudioVoices();
    } catch (err) {
      showAlert('Failed to load voices: ' + err.message, 'error');
    }
  }

  function renderVoices() {
    const tbody = document.getElementById('voicesBody');
    if (!voices.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">🎙️</div><p>No voices configured — add one to get started</p></div></td></tr>';
      return;
    }

    tbody.innerHTML = voices.map(v => {
      const avatarHtml = v.avatar_url
        ? `<img src="${v.avatar_url}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" onerror="this.outerHTML='<div style=\\'width:36px;height:36px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;\\'>🎙️</div>'" />`
        : '<div style="width:36px;height:36px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;">🎙️</div>';

      const defaultBadge = v.is_default
        ? '<span class="badge badge-accent" style="font-size:10px;">⭐ Default</span>'
        : `<button class="btn btn-ghost btn-sm" onclick="setDefault(${v.id})" title="Set as default">⭐</button>`;

      return `<tr>
        <td>${avatarHtml}</td>
        <td><strong>${esc(v.name)}</strong></td>
        <td><code style="font-size:11px;color:var(--muted);">${esc(v.voice_id)}</code></td>
        <td class="text-muted">${esc(v.description || '')}</td>
        <td style="text-align:center;">${defaultBadge}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm btn-icon" title="Edit" onclick="openEdit(${v.id})">✏️</button>
            <button class="btn btn-ghost btn-sm btn-icon" title="Delete" onclick="openDelete(${v.id})">🗑️</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }


  function openAdd() {
    document.getElementById('voiceModalTitle').textContent = 'Add Voice';
    document.getElementById('editVoiceId').value = '';
    document.getElementById('fVoiceName').value = '';
    document.getElementById('fVoiceId').value = '';
    document.getElementById('fVoiceDesc').value = '';
    document.getElementById('fVoiceDefault').checked = false;
    document.getElementById('avatarPreviewWrap').style.display = 'none';
    document.getElementById('fVoiceAvatar').value = '';
    pendingAvatarDataUrl = null;
    openModal('voiceModal');
    document.getElementById('fVoiceName').focus();
  }

  function openEdit(id) {
    const v = voices.find(x => x.id === id);
    if (!v) return;
    document.getElementById('voiceModalTitle').textContent = 'Edit Voice';
    document.getElementById('editVoiceId').value = v.id;
    document.getElementById('fVoiceName').value = v.name;
    document.getElementById('fVoiceId').value = v.voice_id;
    document.getElementById('fVoiceDesc').value = v.description || '';
    document.getElementById('fVoiceDefault').checked = !!v.is_default;
    pendingAvatarDataUrl = null;
    document.getElementById('fVoiceAvatar').value = '';
    if (v.avatar_url) {
      document.getElementById('avatarPreview').src = v.avatar_url;
      document.getElementById('avatarPreviewWrap').style.display = 'block';
    } else {
      document.getElementById('avatarPreviewWrap').style.display = 'none';
    }
    openModal('voiceModal');
    document.getElementById('fVoiceName').focus();
  }

  function openDelete(id) {
    const v = voices.find(x => x.id === id);
    if (!v) return;
    pendingDeleteId = id;
    document.getElementById('deleteVoiceName').textContent = v.name;
    const warn = document.getElementById('deleteVoiceWarn');
    const btn  = document.getElementById('confirmDeleteVoiceBtn');
    if (voices.length <= 1) {
      warn.style.display = 'block';
      btn.disabled = true;
    } else {
      warn.style.display = 'none';
      btn.disabled = false;
    }
    openModal('deleteVoiceModal');
  }

  async function setDefault(id) {
    try {
      await apiFetch(`/voices/${id}/default`, { method: 'PUT' });
      showAlert('Default voice updated');
      await loadVoices();
    } catch (err) {
      showAlert('Failed to set default: ' + err.message, 'error');
    }
  }

  document.getElementById('fVoiceAvatar').addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
      pendingAvatarDataUrl = e.target.result;
      document.getElementById('avatarPreview').src = pendingAvatarDataUrl;
      document.getElementById('avatarPreviewWrap').style.display = 'block';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('previewVoiceBtn').addEventListener('click', async function() {
    const voiceId = document.getElementById('fVoiceId').value.trim();
    if (!voiceId) { showAlert('Enter a Voice ID first', 'error'); return; }
    const statusEl = document.getElementById('previewStatus');
    statusEl.textContent = '⏳ Generating preview…';
    try {
      const data = await apiFetch('/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_id: voiceId })
      });
      const audioEl = document.getElementById('previewAudioEl');
      audioEl.src = `data:${data.mimeType};base64,${data.audio}`;
      audioEl.style.display = 'none';
      await audioEl.play();
      statusEl.textContent = '🔊 Playing…';
      audioEl.onended = () => { statusEl.textContent = ''; };
    } catch (err) {
      statusEl.textContent = '';
      showAlert('Preview failed: ' + err.message, 'error');
    }
  });

  document.getElementById('saveVoiceBtn').addEventListener('click', async function() {
    const editId  = document.getElementById('editVoiceId').value;
    const name    = document.getElementById('fVoiceName').value.trim();
    const voiceId = document.getElementById('fVoiceId').value.trim();
    const desc    = document.getElementById('fVoiceDesc').value.trim();
    const isDef   = document.getElementById('fVoiceDefault').checked;

    if (!name || !voiceId) { showAlert('Name and Voice ID are required', 'error'); return; }

    const payload = {
      name, voice_id: voiceId, description: desc, is_default: isDef ? 1 : 0,
    };

    try {
      let savedVoice;
      if (editId) {
        savedVoice = await apiFetch(`/voices/${editId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        savedVoice = await apiFetch('/voices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      // Close modal immediately — voice is saved
      closeModal('voiceModal');
      showAlert(editId ? 'Voice updated ✓' : 'Voice created ✓');

      // Upload avatar separately (non-blocking on modal close)
      if (pendingAvatarDataUrl && savedVoice && savedVoice.id) {
        try {
          await apiFetch(`/voices/${savedVoice.id}/avatar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl: pendingAvatarDataUrl })
          });
        } catch (avatarErr) {
          showAlert('Voice saved, but avatar upload failed: ' + avatarErr.message, 'error');
        }
        pendingAvatarDataUrl = null;
      }

      await loadVoices();
    } catch (err) {
      showAlert('Save failed: ' + err.message, 'error');
    }
  });

  document.getElementById('confirmDeleteVoiceBtn').addEventListener('click', async function() {
    if (!pendingDeleteId) return;
    try {
      await apiFetch(`/voices/${pendingDeleteId}`, { method: 'DELETE' });
      closeModal('deleteVoiceModal');
      pendingDeleteId = null;
      showAlert('Voice deleted');
      await loadVoices();
    } catch (err) {
      showAlert('Delete failed: ' + err.message, 'error');
    }
  });

  document.getElementById('addVoiceBtn').addEventListener('click', openAdd);

  // ── Voice Test Studio ───────────────────────────────────────────
  const studioText        = document.getElementById('studioText');
  const studioCharCount   = document.getElementById('studioCharCount');
  const studioVoiceSelect = document.getElementById('studioVoiceSelect');
  const studioTestBtn     = document.getElementById('studioTestBtn');
  const studioStopBtn     = document.getElementById('studioStopBtn');
  const studioPlayerWrap  = document.getElementById('studioPlayerWrap');
  const studioAudio       = document.getElementById('studioAudio');
  const studioStatus      = document.getElementById('studioStatus');
  const studioVoiceName   = document.getElementById('studioVoiceName');
  const studioAvatar      = document.getElementById('studioAvatar');

  studioText.addEventListener('input', () => {
    const len = studioText.value.length;
    studioCharCount.textContent = Math.min(len, 500);
    studioCharCount.style.color = len > 450 ? 'var(--danger)' : 'var(--muted)';
    if (len > 500) studioText.value = studioText.value.slice(0, 500);
  });

  function populateStudioVoices() {
    studioVoiceSelect.innerHTML = voices.map(v =>
      `<option value="${v.id}" data-voice-id="${esc(v.voice_id)}" data-name="${esc(v.name)}" data-avatar="${esc(v.avatar_url || '')}">${esc(v.name)}${v.is_default ? ' (default)' : ''}</option>`
    ).join('');
  }

  studioTestBtn.addEventListener('click', async () => {
    const opt = studioVoiceSelect.options[studioVoiceSelect.selectedIndex];
    if (!opt) { showAlert('No voices available', 'error'); return; }

    const voiceId   = opt.dataset.voiceId;
    const name      = opt.dataset.name;
    const avatarUrl = opt.dataset.avatar;
    const text      = studioText.value.trim();

    // Update voice info display
    studioVoiceName.textContent = name;
    if (avatarUrl) {
      studioAvatar.innerHTML = `<img src="${avatarUrl}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" onerror="this.outerHTML='🎙️'" />`;
    } else {
      studioAvatar.textContent = '🎙️';
    }

    // Show player, disable button
    studioPlayerWrap.style.display = 'block';
    studioStatus.textContent = '⏳ Generating…';
    studioStatus.style.color = 'var(--accent)';
    studioTestBtn.disabled = true;
    studioTestBtn.textContent = '⏳ Generating…';
    studioAudio.pause();
    studioAudio.src = '';
    studioStopBtn.style.display = 'none';

    try {
      const data = await apiFetch('/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_id: voiceId, text: text || undefined })
      });

      studioAudio.src = `data:${data.mimeType};base64,${data.audio}`;
      await studioAudio.play();
      studioStatus.textContent = '🔊 Playing…';
      studioStatus.style.color = 'var(--success)';
      studioStopBtn.style.display = '';

      studioAudio.onended = () => {
        studioStatus.textContent = '✓ Done';
        studioStatus.style.color = 'var(--muted)';
        studioStopBtn.style.display = 'none';
        studioTestBtn.disabled = false;
        studioTestBtn.textContent = '▶ Test Voice';
      };
    } catch (err) {
      studioStatus.textContent = '✕ Failed: ' + err.message;
      studioStatus.style.color = 'var(--danger)';
      studioTestBtn.disabled = false;
      studioTestBtn.textContent = '▶ Test Voice';
      studioStopBtn.style.display = 'none';
    }
  });

  studioStopBtn.addEventListener('click', () => {
    studioAudio.pause();
    studioAudio.currentTime = 0;
    studioStatus.textContent = '⏹ Stopped';
    studioStatus.style.color = 'var(--muted)';
    studioStopBtn.style.display = 'none';
    studioTestBtn.disabled = false;
    studioTestBtn.textContent = '▶ Test Voice';
  });

  // Initialize
  async function init() {
    renderSidebar();
    initModals();
    await loadVoices();
    populateStudioVoices();
  }

  onReady(() => {
    if (!requireAuth()) return;
    init();
  });