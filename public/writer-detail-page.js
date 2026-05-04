/**
 * Writer Detail Page — full profile view + inline edit mode.
 * URL params: ?id=<writerId> (view/edit), ?new=1 (create), &edit=1 (start in edit mode)
 */
(function () {
  var writerData = null;
  var memList = [];
  var writerArticles = [];
  var perfData = null;
  var categoriesList = [];
  var writingStylesList = [];
  var isEditMode = false;
  var isNewWriter = false;

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Load Data ─────────────────────────────────────────────

  async function loadCategories() {
    try { categoriesList = await apiFetch('/categories'); } catch { categoriesList = []; }
  }

  async function loadWritingStyles() {
    try { writingStylesList = await apiFetch('/admin/writing-styles'); } catch { writingStylesList = []; }
  }

  async function loadWriterDetail() {
    var params = new URLSearchParams(window.location.search);
    isNewWriter = params.get('new') === '1';
    var startEdit = params.get('edit') === '1' || isNewWriter;
    var writerId = parseInt(params.get('id'));

    await Promise.all([loadCategories(), loadWritingStyles()]);

    if (isNewWriter) {
      writerData = { name: '', slug: '', bio: '', beats: [], keywords: [], system_prompt: '', chat_prompt: '', role: 'writer', tone: '', expertise_level: '', style_guide: '', few_shot_examples: [], gender: '', ethnicity: '', beat_angle: '', signature_phrases: [], contrarian_level: 0.5, is_auto: false, synthesis_schedule: 'daily', synthesis_lookback_hours: 168, min_cluster_size: 2, elevenlabs_voice_id: '', style_id: null };
      document.querySelector('.topbar-title').textContent = 'New Agent';
      setEditMode(true);
      renderEditMode();
      return;
    }

    if (!writerId) {
      document.getElementById('writerDetailContent').innerHTML = '<div class="empty-state"><p>No agent ID provided</p></div>';
      return;
    }

    try {
      var [allWriters, memories, articles, perfRes] = await Promise.all([
        apiFetch('/admin/writers'),
        apiFetch('/admin/writers/' + writerId + '/memories?limit=100').catch(function () { return { memories: [] }; }),
        apiFetch('/articles?type=editorial&limit=100&offset=0').catch(function () { return { articles: [] }; }),
        apiFetch('/admin/writers/performance?range=30d').catch(function () { return []; }),
      ]);

      writerData = allWriters.find(function (x) { return x.id === writerId; });
      if (!writerData) {
        document.getElementById('writerDetailContent').innerHTML = '<div class="empty-state"><p>Agent not found</p></div>';
        return;
      }

      memList = memories.memories || [];
      writerArticles = (articles.articles || []).filter(function (a) { return a.writer_id === writerId; });
      perfData = (Array.isArray(perfRes) ? perfRes : []).find(function (p) { return p.writer_id === writerId || p.id === writerId; });

      document.querySelector('.topbar-title').textContent = writerData.name;

      if (startEdit) {
        setEditMode(true);
        renderEditMode();
      } else {
        setEditMode(false);
        renderViewMode();
      }
    } catch (err) {
      showAlert('Failed to load agent: ' + err.message, 'error');
    }
  }

  // ── Mode Switching ────────────────────────────────────────

  function setEditMode(editing) {
    isEditMode = editing;
    var toggleBtn = document.getElementById('toggleEditBtn');
    var saveBtn = document.getElementById('saveWriterBtn');
    var cancelBtn = document.getElementById('cancelEditBtn');
    if (editing) {
      toggleBtn.style.display = 'none';
      saveBtn.style.display = '';
      cancelBtn.style.display = isNewWriter ? 'none' : '';
    } else {
      toggleBtn.style.display = '';
      saveBtn.style.display = 'none';
      cancelBtn.style.display = 'none';
    }
  }

  document.getElementById('toggleEditBtn').addEventListener('click', function () {
    setEditMode(true);
    renderEditMode();
  });

  document.getElementById('cancelEditBtn').addEventListener('click', function () {
    setEditMode(false);
    renderViewMode();
  });

  // ── View Mode ─────────────────────────────────────────────

  function renderViewMode() {
    var w = writerData;
    var beats = (w.beats || []).map(function (b) { return typeof b === 'string' ? b : b.name; });
    var contLevel = w.contrarian_level != null ? parseFloat(w.contrarian_level) : 0.5;
    var contLabel = contLevel <= 0.2 ? 'Straight reporter' : contLevel <= 0.4 ? 'Mostly balanced' : contLevel <= 0.6 ? 'Balanced' : contLevel <= 0.8 ? 'Pushes back' : 'Contrarian';

    var html = '';

    // Header
    html += '<div class="wd-header">';
    html += w.avatar_url ? '<img src="' + esc(w.avatar_url) + '" class="wd-avatar" id="writerAvatarImg" />' : '<div class="wd-avatar-placeholder">&#9997;&#65039;</div>';
    html += '<div style="flex:1;min-width:0;">';
    var role = w.role || 'writer';
    var roleLabel = role.split('-').map(function(p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(' ');
    var systemTag = w.is_system ? ' <span class="badge" style="font-size:10px;background:rgba(99,102,241,0.15);color:#818cf8;vertical-align:middle;margin-left:4px;">System</span>' : '';
    html += '<h1 class="wd-name">' + esc(w.name) + ' <span class="role-badge role-badge-' + role + '" style="font-size:12px;vertical-align:middle;">' + roleLabel + '</span>' + systemTag + '</h1>';
    if (beats.length) html += '<div>' + beats.map(function (b) { return '<span class="badge badge-muted" style="font-size:12px;margin:2px 3px;">' + esc(b) + '</span>'; }).join('') + '</div>';
    if (w.style_id) {
      var assignedStyle = writingStylesList.find(function (s) { return s.id === w.style_id; });
      if (assignedStyle) html += '<div style="margin-top:4px;"><span class="badge" style="font-size:11px;background:rgba(99,102,241,0.12);color:#818cf8;border-radius:4px;padding:2px 8px;">&#9998; ' + esc(assignedStyle.name) + ' style</span></div>';
    }
    if (w.bio) html += '<p class="wd-bio">' + esc(w.bio) + '</p>';
    html += '</div></div>';

    // Stats
    html += '<div class="wd-stats">';
    [
      { label: 'Articles', value: w.article_count || 0 },
      { label: 'Originals', value: perfData ? (perfData.articles_original || 0) : '—' },
      { label: 'Avg Score', value: perfData ? (parseFloat(perfData.avg_editorial_score) || 0).toFixed(1) : '—' },
      { label: 'Followers', value: w.follower_count || 0 },
      { label: 'Views', value: perfData ? (perfData.total_views || 0) : '—' },
      { label: 'Reactions', value: perfData ? (perfData.total_reactions || 0) : '—' },
      { label: 'Comments', value: perfData ? (perfData.total_comments || 0) : '—' },
      { label: 'Memories', value: memList.length },
    ].forEach(function (s) {
      html += '<div class="wd-stat"><div class="wd-stat-value">' + s.value + '</div><div class="wd-stat-label">' + s.label + '</div></div>';
    });
    html += '</div>';

    // Agent Prompt preview
    if (w.system_prompt) {
      html += '<div class="wd-card" style="margin-bottom:20px;">';
      html += '<div class="wd-section-title">Agent Prompt</div>';
      html += '<pre style="font-size:12px;line-height:1.6;white-space:pre-wrap;color:var(--text-muted,#999);margin:0;max-height:240px;overflow-y:auto;">' + esc(w.system_prompt) + '</pre>';
      html += '</div>';
    }

    html += '<div class="wd-two-col">';
    html += '<div class="wd-card"><div class="wd-section-title">Chat Persona</div>';
    if (w.chat_prompt) {
      html += '<div style="font-size:12px;line-height:1.6;color:var(--text-muted,#999);white-space:pre-wrap;max-height:120px;overflow-y:auto;">' + esc(w.chat_prompt) + '</div>';
    } else {
      html += '<div class="text-muted text-sm">No chat persona set — uses agent prompt.</div>';
    }
    html += '</div>';
    html += '<div class="wd-card"><div class="wd-section-title">Automation</div>';
    html += '<div style="margin-bottom:6px;"><strong>Mode:</strong> ' + (w.is_auto ? 'Auto' : 'Manual') + ' &middot; ' + esc(w.synthesis_schedule || 'daily') + '</div>';
    html += '<div style="margin-bottom:6px;"><strong>Lookback:</strong> ' + (w.synthesis_lookback_hours || 168) + 'h &middot; Min cluster: ' + (w.min_cluster_size || 2) + '</div>';
    html += '<div><strong>Voice:</strong> ' + (w.elevenlabs_voice_id ? 'Configured' : 'None') + '</div>';
    html += '</div>';
    html += '</div>';

    // Articles
    html += '<div class="wd-section"><div class="wd-section-title">Articles (' + writerArticles.length + ')</div><div class="wd-card">';
    if (!writerArticles.length) {
      html += '<div class="text-muted text-sm">No articles yet</div>';
    } else {
      var byMonth = {};
      writerArticles.forEach(function (a) {
        var key = new Date(a.published_at || a.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
        if (!byMonth[key]) byMonth[key] = [];
        byMonth[key].push(a);
      });
      Object.entries(byMonth).forEach(function (entry) {
        html += '<div style="font-weight:600;font-size:12px;color:var(--muted);margin:12px 0 6px;text-transform:uppercase;">' + esc(entry[0]) + '</div>';
        entry[1].forEach(function (a) {
          var typeBadge = a.content_type === 'deep-dive' ? '<span class="badge badge-accent" style="font-size:9px;">Deep Dive</span> ' : '';
          var scoreBadge = a.editorial_score != null ? '<span class="badge ' + (a.editorial_score >= 7 ? 'badge-success' : a.editorial_score >= 5 ? 'badge-warning' : 'badge-danger') + '" style="font-size:10px;min-width:20px;">' + a.editorial_score + '</span> ' : '';
          html += '<div class="wd-article-row">' + scoreBadge + '<span class="badge badge-muted" style="font-size:10px;">' + esc(a.category || '—') + '</span> ' + typeBadge + '<span class="wd-article-title" title="' + esc(a.title) + '">' + esc(a.title) + '</span><span class="text-muted text-sm" style="white-space:nowrap;">' + relativeTime(a.published_at || a.created_at) + '</span></div>';
        });
      });
    }
    html += '</div></div>';

    // Memories
    html += '<div class="wd-section"><div class="wd-section-title">Editorial Memory (' + memList.length + ')</div><div class="wd-card">';
    if (!memList.length) {
      html += '<div class="text-muted text-sm">No memories yet — auto-extracted after synthesis.</div>';
    } else {
      memList.forEach(function (m) {
        html += '<div class="memory-item"><span class="memory-type memory-type-' + m.memory_type + '">' + m.memory_type.replace('_', ' ') + '</span><div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:13px;">' + esc(m.subject) + '</div><div class="text-muted text-sm">' + esc(m.content) + '</div><div class="text-muted" style="font-size:11px;margin-top:2px;">' + relativeTime(m.created_at) + (m.confidence ? ' &middot; confidence: ' + parseFloat(m.confidence).toFixed(2) : '') + (m.expires_at ? ' &middot; expires ' + relativeTime(m.expires_at) : '') + '</div></div></div>';
      });
    }
    html += '</div></div>';

    // Voice samples — curated short exemplars fed into synthesis as
    // few-shot examples so generated articles anchor to this writer's
    // voice instead of drifting to default LLM tone.
    html += renderSamplesSection(w.id);

    // System Prompt
    if (w.system_prompt) {
      html += '<div class="wd-section"><div class="wd-section-title">System Prompt</div><div class="wd-card" style="font-size:13px;white-space:pre-wrap;color:var(--muted);font-family:monospace;max-height:200px;overflow-y:auto;">' + esc(w.system_prompt) + '</div></div>';
    }

    // Chat Persona
    if (w.chat_prompt) {
      html += '<div class="wd-section"><div class="wd-section-title">Chat Persona</div><div class="wd-card" style="font-size:13px;white-space:pre-wrap;color:var(--muted);max-height:200px;overflow-y:auto;">' + esc(w.chat_prompt) + '</div></div>';
    }

    document.getElementById('writerDetailContent').innerHTML = html;
  }

  // ── Edit Mode ─────────────────────────────────────────────

  function renderEditMode() {
    var w = writerData;
    var beats = (w.beats || []).map(function (b) { return typeof b === 'object' ? b.id : b; });

    var html = '<div style="max-width:720px;">';

    // Avatar + Basic Info
    html += '<div class="wd-card" style="margin-bottom:20px;">';
    html += '<div class="wd-section-title">Basic Info</div>';
    if (!isNewWriter) {
      html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">';
      if (w.avatar_url) {
        html += '<img id="writerAvatarImg" src="' + esc(w.avatar_url) + '" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--accent);" />';
      } else {
        html += '<div id="writerAvatarImg" style="width:64px;height:64px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:24px;">&#9997;&#65039;</div>';
      }
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
      html += '<label class="btn btn-outline btn-sm" style="cursor:pointer;margin:0;"><input type="file" accept="image/*" id="avatarFileInput" style="display:none;" onchange="uploadWriterAvatar(this)" />Upload</label>';
      html += '<button class="btn btn-accent btn-sm" id="generateAvatarBtn" onclick="generateWriterAvatar()">Generate</button>';
      html += '</div></div>';
    }
    html += field('Name *', '<input type="text" class="form-control" id="fName" value="' + esc(w.name) + '" placeholder="Agent name" />');
    html += '<div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;">';
    html += field('Slug', '<input type="text" class="form-control" id="fSlug" value="' + esc(w.slug || '') + '" placeholder="Auto-generated from name" />');
    var roleLabel2 = (w.role || 'writer').split('-').map(function(p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(' ');
    html += field('Role', w.is_system
      ? '<span class="role-badge role-badge-' + (w.role || 'writer') + '" style="font-size:12px;">' + roleLabel2 + '</span> <span class="text-muted text-sm">(locked &mdash; system agent)</span>'
      : '<select class="form-control" id="fRole"><option value="writer"' + sel(w.role, 'writer') + '>Writer</option><option value="editor"' + sel(w.role, 'editor') + '>Editor</option><option value="designer"' + sel(w.role, 'designer') + '>Designer</option><option value="copy-editor"' + sel(w.role, 'copy-editor') + '>Copy Editor</option><option value="analyst"' + sel(w.role, 'analyst') + '>Analyst</option><option value="moderator"' + sel(w.role, 'moderator') + '>Moderator</option></select>');
    html += '</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';
    html += field('Gender', '<select class="form-control" id="fGender"><option value="">— Not set —</option><option value="male"' + sel(w.gender, 'male') + '>Male</option><option value="female"' + sel(w.gender, 'female') + '>Female</option><option value="non-binary"' + sel(w.gender, 'non-binary') + '>Non-binary</option></select>');
    html += field('Ethnicity', '<select class="form-control" id="fEthnicity"><option value="">— Not set —</option>' + ['African American','African','Asian','East Asian','South Asian','Hispanic/Latino','Middle Eastern','Native American','Pacific Islander','Caucasian','Mixed/Multiracial'].map(function(e) { return '<option' + sel(w.ethnicity, e) + '>' + e + '</option>'; }).join('') + '</select>');
    html += '</div>';
    html += field('Bio', '<textarea class="form-control" id="fBio" rows="2" placeholder="Short bio">' + esc(w.bio || '') + '</textarea><div id="ctr-fBio" class="char-counter"></div>');
    html += '</div>';

    // Avatar Style Overrides
    if (!isNewWriter) {
      var editorialFamilies = [
        'editorial-illustration', 'documentary-photo', 'noir', 'minimalist-vector',
        'isometric-tech', 'vintage-print', 'cinematic-poster', 'mixed-media',
      ];
      var illustrationFamilies = [
        'anime-portrait', 'cel-shaded', 'studio-illustration', 'comic-book', '3d-render',
      ];
      function familyOpts(list, current) {
        return list.map(function(f) { return '<option value="' + f + '"' + sel(current, f) + '>' + f + '</option>'; }).join('');
      }
      html += '<div class="wd-card" style="margin-bottom:20px;">';
      html += '<div class="wd-section-title">Avatar Style</div>';
      html += '<div class="text-muted text-sm" style="margin-bottom:10px;">Pin a style family and freeform notes so avatar regenerations stay consistent. Leave blank to use tenant art direction.</div>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';
      html += field('Style Family',
        '<select class="form-control" id="fAvatarStyleFamily">'
          + '<option value="">— Auto (tenant default) —</option>'
          + '<optgroup label="Editorial">' + familyOpts(editorialFamilies, w.avatar_style_family) + '</optgroup>'
          + '<optgroup label="Illustration / Animation">' + familyOpts(illustrationFamilies, w.avatar_style_family) + '</optgroup>'
        + '</select>'
        + '<div class="text-muted text-sm" style="margin-top:4px;">Animation styles (anime, cel-shaded, etc.) render best on DALL-E. Imagen quality varies.</div>'
      );
      html += field('Accent Color', '<input type="color" class="form-control" id="fAccentColor" value="' + esc(w.accent_color || '#8b5cf6') + '" style="height:38px;padding:4px;" />');
      html += '</div>';
      html += field('Style Notes', '<textarea class="form-control" id="fAvatarStyleNotes" rows="2" placeholder="e.g. older, greying beard, warm smile, mid-conversation">' + esc(w.avatar_style_notes || '') + '</textarea><div id="ctr-fAvatarStyleNotes" class="char-counter"></div>');
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">';
      html += '<button class="btn btn-accent btn-sm" type="button" id="regenAvatarBtn">Regenerate avatar</button>';
      html += '<button class="btn btn-outline btn-sm" type="button" id="resetAvatarStyleBtn">Reset to auto</button>';
      html += '</div>';
      html += '</div>';
    }

    // Beats + Keywords
    html += '<div class="wd-card" style="margin-bottom:20px;">';
    html += '<div class="wd-section-title">Content Coverage</div>';
    html += field('Beats', '<div id="fBeats" class="checkbox-grid">' + categoriesList.map(function (c) {
      var checked = beats.indexOf(c.id) >= 0 ? ' checked' : '';
      return '<label><input type="checkbox" value="' + c.id + '"' + checked + ' /> ' + esc(c.name) + '</label>';
    }).join('') + '</div>');
    html += field('Keywords', '<input type="text" class="form-control" id="fKeywords" value="' + esc((w.keywords || []).join(', ')) + '" placeholder="Comma-separated" />');
    html += '</div>';

    // Writing Style Template
    html += '<div class="wd-card" style="margin-bottom:20px;">';
    html += '<div class="wd-section-title">Writing Style Template</div>';
    html += '<div class="text-muted text-sm" style="margin-bottom:10px;">A structural overlay applied on top of the agent prompt — defines formatting, pacing, and voice conventions.</div>';
    var styleOpts = '<option value="">— No template —</option>'
      + writingStylesList.map(function (s) {
          var sel = w.style_id === s.id ? ' selected' : '';
          return '<option value="' + s.id + '"' + sel + '>' + esc(s.name) + (s.is_system ? ' (System)' : '') + '</option>';
        }).join('');
    html += field('Template', '<select class="form-control" id="fStyleTemplate">' + styleOpts + '</select>');
    html += '<p class="text-muted text-sm" style="margin-top:4px;">System templates are read-only. <a href="/writing-styles.html" target="_blank" style="color:var(--accent);">Fork or create custom styles ↗</a></p>';
    html += '</div>';

    // Agent Prompt
    html += '<div class="wd-card" style="margin-bottom:20px;">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">';
    html += '<div class="wd-section-title" style="margin-bottom:0;">Agent Prompt</div>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<button type="button" class="btn btn-ghost btn-sm" data-action="template-prompt">Template</button>';
    html += '<button type="button" class="btn btn-ghost btn-sm" data-action="generate-prompt">✶ Generate</button>';
    html += '</div></div>';
    html += '<div class="text-muted text-sm" style="margin-bottom:8px;">Full persona, voice, structure, vocabulary, and rules. Used verbatim in every synthesis.</div>';
    html += '<textarea class="form-control" id="fSystemPrompt" rows="20" style="font-family:monospace;font-size:12px;line-height:1.5;" placeholder="## Identity\nYou are...">' + esc(w.system_prompt || '') + '</textarea>';
    html += '<div id="ctr-fSystemPrompt" class="char-counter"></div>';
    html += '</div>';

    // Chat Persona
    html += '<div class="wd-card" style="margin-bottom:20px;">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">';
    html += '<div class="wd-section-title" style="margin-bottom:0;">Chat Persona <span class="text-muted text-sm" style="font-weight:normal;">(Discord / Telegram / Slack)</span></div>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<button type="button" class="btn btn-ghost btn-sm" data-action="template-chat">Template</button>';
    html += '<button type="button" class="btn btn-ghost btn-sm" id="generateChatPromptBtn">✶ Generate</button>';
    html += '</div></div>';
    html += '<textarea class="form-control" id="fChatPrompt" rows="4" placeholder="You\'re blunt about hype cycles...">' + esc(w.chat_prompt || '') + '</textarea>';
    html += '<div id="ctr-fChatPrompt" class="char-counter"></div>';
    html += '</div>';

    // Automation
    html += '<div class="wd-card" style="margin-bottom:20px;">';
    html += '<div class="wd-section-title">Voice</div>';
    html += field('ElevenLabs Voice ID', '<input type="text" class="form-control" id="fVoiceId" value="' + esc(w.elevenlabs_voice_id || '') + '" placeholder="e.g. pNInz6obpgDQGcFmaJgB" />');
    if (!w.is_system) {
      html += '<div style="margin-bottom:12px;"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="fIsAuto"' + (w.is_auto ? ' checked' : '') + ' style="width:16px;height:16px;" /> Auto mode</label></div>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">';
      html += field('Schedule', '<select class="form-control" id="fSchedule"><option value="daily"' + sel(w.synthesis_schedule, 'daily') + '>Daily</option><option value="weekly"' + sel(w.synthesis_schedule, 'weekly') + '>Weekly</option><option value="manual"' + sel(w.synthesis_schedule, 'manual') + '>Manual</option></select>');
      html += field('Lookback Hours', '<input type="number" class="form-control" id="fLookback" value="' + (w.synthesis_lookback_hours != null ? w.synthesis_lookback_hours : 168) + '" min="1" max="8760" />');
      html += field('Min Cluster', '<input type="number" class="form-control" id="fMinCluster" value="' + (w.min_cluster_size != null ? w.min_cluster_size : 2) + '" min="1" max="100" />');
      html += '</div>';
    }
    html += '</div>';

    html += '</div>';
    document.getElementById('writerDetailContent').innerHTML = html;

    // Char counters
    wireCharCounter('fBio', 2000);
    wireCharCounter('fAvatarStyleNotes', 1000);
    wireCharCounter('fSystemPrompt', 10000);
    wireCharCounter('fChatPrompt', 1000);

    // Auto-generate slug from name for new writers
    var nameInput = document.getElementById('fName');
    if (nameInput && isNewWriter) {
      nameInput.addEventListener('input', function () {
        document.getElementById('fSlug').value = this.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      });
    }



    // Generate Chat Persona
    var genChatBtn = document.getElementById('generateChatPromptBtn');
    if (genChatBtn) {
      genChatBtn.addEventListener('click', async function () {
        if (!writerData.id) { alert('Save the writer first, then generate.'); return; }
        genChatBtn.disabled = true;
        genChatBtn.textContent = 'Generating...';
        try {
          var res = await apiFetch('/admin/writers/' + writerData.id + '/generate-chat-prompt', { method: 'POST' });
          if (res.chat_prompt) {
            document.getElementById('fChatPrompt').value = res.chat_prompt;
          }
        } catch (err) {
          alert('Generation failed: ' + (err.message || err));
        } finally {
          genChatBtn.disabled = false;
          genChatBtn.textContent = 'Generate Chat Persona';
        }
      });
    }

  }

  function field(label, input) {
    return '<div class="wd-edit-field"><label>' + label + '</label>' + input + '</div>';
  }

  function sel(current, value) {
    return current === value ? ' selected' : '';
  }

  // ── Save Writer ───────────────────────────────────────────


  function wireCharCounter(id, max) {
    var el = document.getElementById(id);
    var counter = document.getElementById('ctr-' + id);
    if (!el || !counter) return;
    function update() {
      var len = el.value.length;
      var pct = len / max;
      counter.textContent = len.toLocaleString() + ' / ' + max.toLocaleString();
      counter.style.color = pct >= 0.95 ? 'var(--danger, #c33)' : pct >= 0.8 ? 'var(--warning, #f59e0b)' : 'var(--muted)';
    }
    el.addEventListener('input', update);
    update();
  }

  document.getElementById('saveWriterBtn').addEventListener('click', async function () {
    var name = document.getElementById('fName').value.trim();
    if (!name) { showAlert('Name is required', 'error'); return; }

    var keywordsRaw = document.getElementById('fKeywords').value.trim();

    var beatsChecked = [];
    document.querySelectorAll('#fBeats input[type="checkbox"]:checked').forEach(function (cb) {
      beatsChecked.push(parseInt(cb.value));
    });

    var payload = {
      name: name,
      slug: document.getElementById('fSlug').value.trim() || null,
      bio: document.getElementById('fBio').value.trim() || null,
      beats: beatsChecked,
      keywords: keywordsRaw ? keywordsRaw.split(',').map(function (k) { return k.trim(); }).filter(Boolean) : [],
      system_prompt: document.getElementById('fSystemPrompt').value.trim() || null,
      chat_prompt: document.getElementById('fChatPrompt').value.trim() || null,
      role: (document.getElementById('fRole') || {}).value || writerData.role || 'writer',
      is_auto: document.getElementById('fIsAuto') ? document.getElementById('fIsAuto').checked : (writerData.is_auto || false),
      synthesis_schedule: document.getElementById('fSchedule') ? document.getElementById('fSchedule').value : (writerData.synthesis_schedule || 'daily'),
      synthesis_lookback_hours: document.getElementById('fLookback') ? (parseInt(document.getElementById('fLookback').value) || 168) : (writerData.synthesis_lookback_hours || 168),
      min_cluster_size: document.getElementById('fMinCluster') ? (parseInt(document.getElementById('fMinCluster').value) || 2) : (writerData.min_cluster_size || 2),
      elevenlabs_voice_id: document.getElementById('fVoiceId').value.trim() || null,
      gender: document.getElementById('fGender').value || null,
      ethnicity: document.getElementById('fEthnicity').value || null,
      style_id: (function () { var el = document.getElementById('fStyleTemplate'); return el && el.value ? parseInt(el.value) : null; })(),
    };

    // Avatar style overrides (only present for existing writers)
    var fAvatarStyleFamily = document.getElementById('fAvatarStyleFamily');
    if (fAvatarStyleFamily) {
      payload.avatar_style_family = fAvatarStyleFamily.value || null;
    }
    var fAvatarStyleNotes = document.getElementById('fAvatarStyleNotes');
    if (fAvatarStyleNotes) {
      payload.avatar_style_notes = fAvatarStyleNotes.value.trim() || null;
    }
    var fAccentColor = document.getElementById('fAccentColor');
    if (fAccentColor && fAccentColor.value) {
      payload.accent_color = fAccentColor.value;
    }

    try {
      var saved;
      if (isNewWriter) {
        saved = await apiFetch('/admin/writers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        showAlert('Agent created');
        window.location.href = '/writer-detail.html?id=' + saved.id;
      } else {
        saved = await apiFetch('/admin/writers/' + writerData.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        showAlert('Agent updated');
        // Reload to reflect changes
        window.location.href = '/writer-detail.html?id=' + writerData.id;
      }
    } catch (err) {
      showAlert('Save failed: ' + err.message, 'error');
    }
  });

  // ── Avatar Upload / Generate ──────────────────────────────

  window.uploadWriterAvatar = async function (input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (!writerData || !writerData.id) return;

    var reader = new FileReader();
    reader.onload = async function () {
      try {
        showAlert('Uploading avatar...');
        var data = await apiFetch('/admin/writers/' + writerData.id + '/avatar', {
          method: 'POST',
          body: JSON.stringify({ dataUrl: reader.result }),
        });
        writerData.avatar_url = data.avatar_url;
        var img = document.getElementById('writerAvatarImg');
        if (img && img.tagName === 'IMG') {
          img.src = data.avatar_url;
        } else if (img) {
          img.outerHTML = '<img id="writerAvatarImg" src="' + data.avatar_url + '" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--accent);" />';
        }
        showAlert('Avatar uploaded');
      } catch (err) {
        showAlert('Upload failed: ' + err.message, 'error');
      }
    };
    reader.readAsDataURL(file);
  };

  window.generateWriterAvatar = async function () {
    if (!writerData || !writerData.id) return;
    var btn = document.getElementById('generateAvatarBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }
    try {
      var data = await apiFetch('/admin/writers/' + writerData.id + '/generate-avatar', { method: 'POST' });
      writerData.avatar_url = data.avatar_url;
      var img = document.getElementById('writerAvatarImg');
      if (img && img.tagName === 'IMG') {
        img.src = data.avatar_url;
      } else if (img) {
        img.outerHTML = '<img id="writerAvatarImg" src="' + data.avatar_url + '" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--accent);" />';
      }
      showAlert('Avatar generated');
    } catch (err) {
      showAlert('Generate failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Generate'; }
    }
  };

  // ── Init ──────────────────────────────────────────────────

  var PROMPT_TEMPLATE = [
    '## Identity',
    'You are [Name]. [Editorial conviction or worldview first — one sharp sentence. Beat coverage emerges from the lens.]',
    '',
    '## Tone',
    '[Register, skepticism level, humor, warmth, rhythm — specific to this beat and persona.]',
    '',
    '## Structure',
    '- Opens with: [scene / anecdote / data point / question / thesis]',
    '- Closes with: [open question / forward look / summary / callback to opening]',
    '- Subheads: [avoid — flowing prose / moderate / heavy — structured pieces]',
    '',
    '## Vocabulary',
    'Favored: [3-6 words or phrases this writer reaches for]',
    'Avoided: [3-6 words or phrases that break their voice]',
    '',
    '## Rules',
    '- [Concrete editorial rule #1]',
    '- [Concrete editorial rule #2]',
    '- [Concrete editorial rule #3]',
    '- [Concrete editorial rule #4]',
  ].join('\n');

  var CHAT_TEMPLATE = "You're [adjective] about [beat/topic] — [core attitude in one clause]. When someone mentions [trigger topic], you [reaction]. You drop phrases like \"[catchphrase 1]\" and \"[catchphrase 2].\" [What makes you eye-roll vs what genuinely excites you.]";

  onReady(function () {
    if (!requireAuth()) return;
    renderSidebar();
    initModals();
    loadWriterDetail();
    window.pageRefresh = loadWriterDetail;

    // Delegated handlers for Agent Prompt + Chat Persona buttons (rendered dynamically)
    document.getElementById('writerDetailContent').addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;

      if (action === 'template-prompt') {
        var ta = document.getElementById('fSystemPrompt');
        if (!ta) return;
        if (ta.value.trim() && !confirm('Replace current prompt with the template?')) return;
        ta.value = PROMPT_TEMPLATE;
        ta.focus();
      }

      if (action === 'template-chat') {
        var ta = document.getElementById('fChatPrompt');
        if (!ta) return;
        if (ta.value.trim() && !confirm('Replace current chat persona with the template?')) return;
        ta.value = CHAT_TEMPLATE;
        ta.focus();
      }

      if (action === 'generate-prompt') {
        if (!writerData || !writerData.id) { alert('Save the writer first, then generate.'); return; }
        btn.disabled = true;
        var origLabel = btn.textContent;
        btn.textContent = 'Generating...';
        try {
          var res = await apiFetch('/admin/writers/' + writerData.id + '/generate-prompt', { method: 'POST' });
          if (res && res.prompt) {
            var ta = document.getElementById('fSystemPrompt');
            if (ta) ta.value = res.prompt;
          }
        } catch (err) {
          alert('Generation failed: ' + (err.message || err));
        } finally {
          btn.disabled = false;
          btn.textContent = origLabel;
        }
      }
    });
  });

  // ── Voice samples section ─────────────────────────────────
  // Renders an empty container on load; samples are fetched + rendered
  // asynchronously so the main detail page doesn't block on them.
  var SAMPLE_TYPES = [
    { key: 'original',         label: 'Original',         icon: '📝' },
    { key: 'follow_up',        label: 'Follow-up',        icon: '↻'  },
    { key: 'roundup',          label: 'Roundup',          icon: '🧺' },
    { key: 'deep_dive',        label: 'Deep dive',        icon: '🔍' },
    { key: 'explainer',        label: 'Explainer',        icon: '💡' },
    { key: 'counter_angle',    label: 'Counter-angle',    icon: '⚖'  },
    { key: 'prediction_check', label: 'Prediction check', icon: '🎯' },
    { key: 'analysis',         label: 'Analysis',         icon: '📊' },
    { key: 'breaking',         label: 'Breaking',         icon: '⚡' },
  ];

  function renderSamplesSection(writerId) {
    // Returns placeholder HTML; hydrates after the main render completes
    setTimeout(function () { hydrateSamples(writerId); }, 0);
    return '<div class="wd-section" id="wdSamplesSection">'
      +    '<div class="wd-section-title">Voice Samples</div>'
      +    '<div class="wd-card" id="wdSamplesBody" style="color:var(--muted);font-size:13px;">Loading samples…</div>'
      + '</div>';
  }

  async function hydrateSamples(writerId) {
    var body = document.getElementById('wdSamplesBody');
    if (!body) return;
    var samples;
    try {
      var data = await apiFetch('/admin/writers/' + writerId + '/samples');
      samples = data.samples || [];
    } catch (err) {
      body.innerHTML = '<div style="color:var(--danger);">Failed to load: ' + esc(err.message || err) + '</div>';
      return;
    }

    // Group by pitch_type
    var byType = {};
    samples.forEach(function (s) {
      (byType[s.pitch_type] = byType[s.pitch_type] || []).push(s);
    });

    var html = '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">'
      + 'Short exemplars of this writer\'s voice per pitch type. Pinned + high-quality samples feed into synthesis as few-shot examples (requires <code>voice_samples</code> feature flag).'
      + '</div>';

    SAMPLE_TYPES.forEach(function (t) {
      var list = byType[t.key] || [];
      var countLabel = list.length ? list.length + (list.length === 1 ? ' sample' : ' samples') : 'no samples';
      html += '<div class="wd-sample-type" style="margin-bottom:14px;">'
        +    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">'
        +      '<span style="font-weight:600;font-size:13px;">' + t.icon + ' ' + esc(t.label) + '</span>'
        +      '<span class="text-muted text-sm">' + countLabel + '</span>'
        +      '<button class="btn btn-ghost btn-sm wd-sample-gen" data-type="' + t.key + '" data-writer="' + writerId + '" ' + (list.length >= 5 ? 'disabled title="Max 5 samples per type"' : '') + '>✨ Generate</button>'
        +    '</div>';
      if (list.length) {
        html += '<div class="wd-sample-cards" style="display:flex;flex-direction:column;gap:6px;">';
        list.forEach(function (s) {
          var pinBadge = s.is_pinned ? '<span class="badge badge-accent" style="font-size:10px;">★ pinned</span>' : '';
          var negBadge = s.is_negative ? '<span class="badge badge-danger" style="font-size:10px;">✗ anti-example</span>' : '';
          var preview = esc((s.body || '').slice(0, 180));
          html += '<div class="wd-sample-card" data-sample="' + s.id + '" data-writer="' + writerId + '" style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;">'
            +   '<div style="display:flex;align-items:flex-start;gap:8px;">'
            +     '<div style="flex:1;min-width:0;">'
            +       '<div style="font-weight:600;font-size:13px;margin-bottom:2px;">' + esc(s.title) + ' ' + pinBadge + ' ' + negBadge + '</div>'
            +       '<div class="text-muted" style="font-size:12px;white-space:pre-wrap;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;">' + preview + (s.body && s.body.length > 180 ? '…' : '') + '</div>'
            +     '</div>'
            +     '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">'
            +       '<button class="btn btn-ghost btn-sm wd-sample-pin" data-sample="' + s.id + '" data-writer="' + writerId + '" title="' + (s.is_pinned ? 'Unpin' : 'Pin') + '">' + (s.is_pinned ? '★' : '☆') + '</button>'
            +       '<button class="btn btn-ghost btn-sm wd-sample-edit" data-sample="' + s.id + '" data-writer="' + writerId + '" title="Edit">✏</button>'
            +       '<button class="btn btn-ghost btn-sm wd-sample-del" data-sample="' + s.id + '" data-writer="' + writerId + '" title="Delete">✕</button>'
            +     '</div>'
            +   '</div>'
            + '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
    });

    body.innerHTML = html;
    wireSampleHandlers();
  }

  function wireSampleHandlers() {
    document.querySelectorAll('.wd-sample-gen').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var writerId = parseInt(btn.dataset.writer, 10);
        var pitchType = btn.dataset.type;
        var seed = prompt('Optional seed topic (blank uses the writer\'s beat):');
        if (seed === null) return;
        btn.disabled = true;
        var orig = btn.textContent;
        btn.textContent = 'Generating…';
        try {
          await apiFetch('/admin/writers/' + writerId + '/samples/generate', {
            method: 'POST',
            body: JSON.stringify({ pitch_type: pitchType, seed_topic: seed || undefined }),
          });
          await hydrateSamples(writerId);
        } catch (err) {
          alert('Generation failed: ' + (err.message || err));
        } finally {
          btn.disabled = false;
          btn.textContent = orig;
        }
      });
    });
    document.querySelectorAll('.wd-sample-pin').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var writerId = parseInt(btn.dataset.writer, 10);
        var sampleId = parseInt(btn.dataset.sample, 10);
        var wasPinned = btn.textContent.trim() === '★';
        try {
          await apiFetch('/admin/writers/' + writerId + '/samples/' + sampleId, {
            method: 'PATCH',
            body: JSON.stringify({ is_pinned: !wasPinned }),
          });
          await hydrateSamples(writerId);
        } catch (err) { alert('Update failed: ' + (err.message || err)); }
      });
    });
    document.querySelectorAll('.wd-sample-del').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('Delete this sample?')) return;
        var writerId = parseInt(btn.dataset.writer, 10);
        var sampleId = parseInt(btn.dataset.sample, 10);
        try {
          await apiFetch('/admin/writers/' + writerId + '/samples/' + sampleId, { method: 'DELETE' });
          await hydrateSamples(writerId);
        } catch (err) { alert('Delete failed: ' + (err.message || err)); }
      });
    });
    document.querySelectorAll('.wd-sample-edit').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var writerId = parseInt(btn.dataset.writer, 10);
        var sampleId = parseInt(btn.dataset.sample, 10);
        var card = btn.closest('.wd-sample-card');
        if (!card) return;
        // Fetch full sample body (preview was truncated)
        var list;
        try {
          var data = await apiFetch('/admin/writers/' + writerId + '/samples');
          list = data.samples || [];
        } catch { list = []; }
        var sample = list.find(function (s) { return s.id === sampleId; });
        if (!sample) return alert('Sample not found');
        var newTitle = prompt('Title:', sample.title);
        if (newTitle === null) return;
        var newBody = prompt('Body (markdown):', sample.body);
        if (newBody === null) return;
        try {
          await apiFetch('/admin/writers/' + writerId + '/samples/' + sampleId, {
            method: 'PATCH',
            body: JSON.stringify({ title: newTitle, body: newBody }),
          });
          await hydrateSamples(writerId);
        } catch (err) { alert('Edit failed: ' + (err.message || err)); }
      });
    });
  }
})();
