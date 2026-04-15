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
  var isEditMode = false;
  var isNewWriter = false;

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Load Data ─────────────────────────────────────────────

  async function loadCategories() {
    try { categoriesList = await apiFetch('/categories'); } catch { categoriesList = []; }
  }

  async function loadWriterDetail() {
    var params = new URLSearchParams(window.location.search);
    isNewWriter = params.get('new') === '1';
    var startEdit = params.get('edit') === '1' || isNewWriter;
    var writerId = parseInt(params.get('id'));

    await loadCategories();

    if (isNewWriter) {
      writerData = { name: '', slug: '', bio: '', beats: [], keywords: [], system_prompt: '', chat_prompt: '', role: 'writer', tone: '', expertise_level: '', style_guide: '', few_shot_examples: [], gender: '', ethnicity: '', beat_angle: '', signature_phrases: [], contrarian_level: 0.5, is_auto: false, synthesis_schedule: 'daily', synthesis_lookback_hours: 168, min_cluster_size: 2, elevenlabs_voice_id: '' };
      document.querySelector('.topbar-title').textContent = 'New Writer';
      setEditMode(true);
      renderEditMode();
      return;
    }

    if (!writerId) {
      document.getElementById('writerDetailContent').innerHTML = '<div class="empty-state"><p>No writer ID provided</p></div>';
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
        document.getElementById('writerDetailContent').innerHTML = '<div class="empty-state"><p>Writer not found</p></div>';
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
      showAlert('Failed to load writer: ' + err.message, 'error');
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
    html += '<h1 class="wd-name">' + esc(w.name) + ' <span class="role-badge role-badge-' + role + '" style="font-size:12px;vertical-align:middle;">' + role.charAt(0).toUpperCase() + role.slice(1) + '</span></h1>';
    if (beats.length) html += '<div>' + beats.map(function (b) { return '<span class="badge badge-muted" style="font-size:12px;margin:2px 3px;">' + esc(b) + '</span>'; }).join('') + '</div>';
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

    // Personality + Style
    html += '<div class="wd-two-col">';
    html += '<div class="wd-card"><div class="wd-section-title">Personality</div>';
    if (w.beat_angle) html += '<div style="margin-bottom:8px;"><strong>Angle:</strong> ' + esc(w.beat_angle) + '</div>';
    if (w.signature_phrases && w.signature_phrases.length) html += '<div style="margin-bottom:8px;"><strong>Phrases:</strong> ' + w.signature_phrases.map(function (p) { return '&ldquo;' + esc(p) + '&rdquo;'; }).join(', ') + '</div>';
    html += '<div style="margin-bottom:4px;"><strong>Contrarian:</strong> ' + contLabel + ' (' + contLevel.toFixed(1) + ')</div>';
    html += '<div style="background:var(--bg-surface, #0a0a0a);border-radius:6px;height:8px;margin-top:4px;"><div style="height:100%;width:' + (contLevel * 100) + '%;background:linear-gradient(90deg, var(--accent), #a855f7);border-radius:6px;"></div></div>';
    html += '</div>';

    html += '<div class="wd-card"><div class="wd-section-title">Style & Voice</div>';
    html += '<div style="margin-bottom:6px;"><strong>Tone:</strong> ' + esc(w.tone || 'Default') + '</div>';
    html += '<div style="margin-bottom:6px;"><strong>Expertise:</strong> ' + esc(w.expertise_level || 'Default') + '</div>';
    html += '<div style="margin-bottom:6px;"><strong>Mode:</strong> ' + (w.is_auto ? 'Auto' : 'Manual') + ' &middot; ' + esc(w.synthesis_schedule || 'daily') + '</div>';
    html += '<div><strong>Voice:</strong> ' + (w.elevenlabs_voice_id ? 'Configured' : 'None') + '</div>';
    if (w.style_guide) html += '<div style="margin-top:8px;padding:8px;background:var(--bg-surface, #0a0a0a);border-radius:6px;font-size:12px;color:var(--muted);">' + esc(w.style_guide) + '</div>';
    html += '</div></div>';

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
    var contLevel = w.contrarian_level != null ? parseFloat(w.contrarian_level) : 0.5;
    var fse = typeof w.few_shot_examples === 'string' ? JSON.parse(w.few_shot_examples || '[]') : (w.few_shot_examples || []);

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
    html += field('Role', '<select class="form-control" id="fRole"><option value="writer"' + sel(w.role, 'writer') + '>Writer</option><option value="editor"' + sel(w.role, 'editor') + '>Editor</option><option value="designer"' + sel(w.role, 'designer') + '>Designer</option><option value="analyst"' + sel(w.role, 'analyst') + '>Analyst</option><option value="moderator"' + sel(w.role, 'moderator') + '>Moderator</option></select>');
    html += '</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';
    html += field('Gender', '<select class="form-control" id="fGender"><option value="">— Not set —</option><option value="male"' + sel(w.gender, 'male') + '>Male</option><option value="female"' + sel(w.gender, 'female') + '>Female</option><option value="non-binary"' + sel(w.gender, 'non-binary') + '>Non-binary</option></select>');
    html += field('Ethnicity', '<select class="form-control" id="fEthnicity"><option value="">— Not set —</option>' + ['African American','African','Asian','East Asian','South Asian','Hispanic/Latino','Middle Eastern','Native American','Pacific Islander','Caucasian','Mixed/Multiracial'].map(function(e) { return '<option' + sel(w.ethnicity, e) + '>' + e + '</option>'; }).join('') + '</select>');
    html += '</div>';
    html += field('Bio', '<textarea class="form-control" id="fBio" rows="2" placeholder="Short bio">' + esc(w.bio || '') + '</textarea>');
    html += '</div>';

    // Avatar Style Overrides
    if (!isNewWriter) {
      var styleFamilies = [
        'editorial-illustration', 'documentary-photo', 'noir', 'minimalist-vector',
        'isometric-tech', 'vintage-print', 'cinematic-poster', 'mixed-media',
      ];
      html += '<div class="wd-card" style="margin-bottom:20px;">';
      html += '<div class="wd-section-title">Avatar Style</div>';
      html += '<div class="text-muted text-sm" style="margin-bottom:10px;">Pin a style family and freeform notes so avatar regenerations stay consistent. Leave blank to use tenant art direction.</div>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';
      html += field('Style Family', '<select class="form-control" id="fAvatarStyleFamily"><option value="">— Auto (tenant default) —</option>' + styleFamilies.map(function(f) { return '<option value="' + f + '"' + sel(w.avatar_style_family, f) + '>' + f + '</option>'; }).join('') + '</select>');
      html += field('Accent Color', '<input type="color" class="form-control" id="fAccentColor" value="' + esc(w.accent_color || '#8b5cf6') + '" style="height:38px;padding:4px;" />');
      html += '</div>';
      html += field('Style Notes', '<textarea class="form-control" id="fAvatarStyleNotes" rows="2" placeholder="e.g. older, greying beard, warm smile, mid-conversation">' + esc(w.avatar_style_notes || '') + '</textarea>');
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

    // Personality
    html += '<div class="wd-card" style="margin-bottom:20px;">';
    html += '<div class="wd-section-title">Personality</div>';
    html += field('Beat Angle', '<input type="text" class="form-control" id="fBeatAngle" value="' + esc(w.beat_angle || '') + '" placeholder="e.g. AI chips through supply chain economics" />');
    html += field('Signature Phrases', '<input type="text" class="form-control" id="fSignaturePhrases" value="' + esc((w.signature_phrases || []).join(', ')) + '" placeholder="Comma-separated, up to 5" />');
    html += field('Contrarian Level', '<div style="display:flex;align-items:center;gap:12px;"><span class="text-muted text-sm">Straight</span><input type="range" id="fContrarian" min="0" max="1" step="0.1" value="' + contLevel + '" style="flex:1;" /><span class="text-muted text-sm">Contrarian</span></div><div class="text-center text-muted text-sm" id="contrarianLabel" style="margin-top:4px;">' + contLevel.toFixed(1) + '</div>');
    html += '</div>';

    // Style Profile
    html += '<div class="wd-card" style="margin-bottom:20px;">';
    html += '<div class="wd-section-title">Style Profile</div>';
    if (!isNewWriter) {
      html += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px;background:var(--surface2);border-radius:6px;margin-bottom:12px;">';
      html += '<div style="flex:1;min-width:200px;"><div style="font-weight:600;font-size:13px;">Regenerate Persona</div><div class="text-muted text-sm">After changing beats, refresh the persona fields to match.</div></div>';
      html += '<button class="btn btn-accent btn-sm" type="button" id="refreshPersonaBtn" title="Keep voice &amp; identity, update bio and beat-specific fields">Refresh</button>';
      html += '<button class="btn btn-outline btn-sm" type="button" id="rewritePersonaBtn" style="color:var(--danger,#c33);border-color:var(--danger,#c33);" title="Full rewrite \u2014 destructive">Rewrite from scratch</button>';
      html += '</div>';
    }
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';
    html += field('Tone', '<select class="form-control" id="fTone"><option value="">Default</option>' + ['analytical','conversational','provocative','authoritative','casual','technical'].map(function(t) { return '<option' + sel(w.tone, t) + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('') + '</select>');
    html += field('Expertise', '<select class="form-control" id="fExpertise"><option value="">Default</option>' + ['beginner-friendly','intermediate','technical','expert'].map(function(t) { return '<option value="' + t + '"' + sel(w.expertise_level, t) + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('') + '</select>');
    html += '</div>';
    html += field('System Prompt', '<textarea class="form-control" id="fSystemPrompt" rows="4" placeholder="You are...">' + esc(w.system_prompt || '') + '</textarea>');
    html += field('Chat Persona <span class="text-muted text-sm" style="font-weight:normal;">(Discord / Telegram / Slack voice)</span>', '<textarea class="form-control" id="fChatPrompt" rows="4" placeholder="Custom personality for messaging conversations...">' + esc(w.chat_prompt || '') + '</textarea><button class="btn btn-outline btn-sm" type="button" id="generateChatPromptBtn" style="margin-top:6px;">Generate Chat Persona</button>');
    html += field('Style Guide', '<textarea class="form-control" id="fStyleGuide" rows="3" placeholder="Editorial guidelines...">' + esc(w.style_guide || '') + '</textarea>');

    // Few-shot examples
    html += '<div class="wd-edit-field"><label>Few-Shot Examples</label><div id="fewShotContainer">';
    fse.forEach(function (ex) {
      html += '<div class="few-shot-row"><input type="text" class="form-control fs-title" value="' + esc(ex.title || '') + '" placeholder="Title" /><textarea class="form-control fs-excerpt" placeholder="Excerpt">' + esc(ex.excerpt || '') + '</textarea><button class="btn btn-ghost btn-sm" type="button" onclick="this.parentElement.remove()">&#10005;</button></div>';
    });
    html += '</div><button class="btn btn-outline btn-sm" type="button" id="addFewShotBtn" style="margin-top:6px;">+ Add Example</button></div>';
    html += '</div>';

    // Automation
    html += '<div class="wd-card" style="margin-bottom:20px;">';
    html += '<div class="wd-section-title">Automation & Voice</div>';
    html += field('ElevenLabs Voice ID', '<input type="text" class="form-control" id="fVoiceId" value="' + esc(w.elevenlabs_voice_id || '') + '" placeholder="e.g. pNInz6obpgDQGcFmaJgB" />');
    html += '<div style="margin-bottom:12px;"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="fIsAuto"' + (w.is_auto ? ' checked' : '') + ' style="width:16px;height:16px;" /> Auto mode</label></div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">';
    html += field('Schedule', '<select class="form-control" id="fSchedule"><option value="daily"' + sel(w.synthesis_schedule, 'daily') + '>Daily</option><option value="weekly"' + sel(w.synthesis_schedule, 'weekly') + '>Weekly</option><option value="manual"' + sel(w.synthesis_schedule, 'manual') + '>Manual</option></select>');
    html += field('Lookback Hours', '<input type="number" class="form-control" id="fLookback" value="' + (w.synthesis_lookback_hours != null ? w.synthesis_lookback_hours : 168) + '" min="1" max="8760" />');
    html += field('Min Cluster', '<input type="number" class="form-control" id="fMinCluster" value="' + (w.min_cluster_size != null ? w.min_cluster_size : 2) + '" min="1" max="100" />');
    html += '</div></div>';

    html += '</div>';
    document.getElementById('writerDetailContent').innerHTML = html;

    // Auto-generate slug from name for new writers
    var nameInput = document.getElementById('fName');
    if (nameInput && isNewWriter) {
      nameInput.addEventListener('input', function () {
        document.getElementById('fSlug').value = this.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      });
    }

    // Contrarian slider
    var slider = document.getElementById('fContrarian');
    if (slider) {
      slider.addEventListener('input', function () {
        var v = parseFloat(this.value);
        var label = v <= 0.2 ? 'Straight reporter' : v <= 0.4 ? 'Mostly balanced' : v <= 0.6 ? 'Balanced' : v <= 0.8 ? 'Pushes back' : 'Contrarian';
        document.getElementById('contrarianLabel').textContent = v.toFixed(1) + ' — ' + label;
      });
    }

    // Add few-shot row
    document.getElementById('addFewShotBtn').addEventListener('click', function () {
      var row = document.createElement('div');
      row.className = 'few-shot-row';
      row.innerHTML = '<input type="text" class="form-control fs-title" placeholder="Title" /><textarea class="form-control fs-excerpt" placeholder="Excerpt"></textarea><button class="btn btn-ghost btn-sm" type="button" onclick="this.parentElement.remove()">&#10005;</button>';
      document.getElementById('fewShotContainer').appendChild(row);
    });

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

    // Regenerate Persona (Refresh / Rewrite)
    function getCheckedBeatIds() {
      return Array.prototype.map.call(document.querySelectorAll('#fBeats input:checked'), function (el) { return parseInt(el.value, 10); });
    }

    async function regeneratePersona(mode, preserveName) {
      if (!writerData.id) { alert('Save the writer first.'); return; }
      if (!getCheckedBeatIds().length) { alert('Assign at least one beat before regenerating the persona.'); return; }
      var body = { mode: mode };
      if (mode === 'rewrite') body.preserveName = preserveName;
      var res = await apiFetch('/admin/writers/' + writerData.id + '/regenerate-persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res || !res.writer) throw new Error('No writer returned');
      var w = res.writer;
      // Update form fields
      if (w.bio !== undefined)            document.getElementById('fBio').value = w.bio || '';
      if (w.tone !== undefined)           document.getElementById('fTone').value = w.tone || '';
      if (w.expertise_level !== undefined) document.getElementById('fExpertise').value = w.expertise_level || '';
      if (w.style_guide !== undefined)    document.getElementById('fStyleGuide').value = w.style_guide || '';
      if (w.system_prompt !== undefined)  document.getElementById('fSystemPrompt').value = w.system_prompt || '';
      if (w.beat_angle !== undefined)     document.getElementById('fBeatAngle').value = w.beat_angle || '';
      if (Array.isArray(w.keywords))      document.getElementById('fKeywords').value = w.keywords.join(', ');
      if (mode === 'rewrite') {
        if (w.gender !== undefined)    document.getElementById('fGender').value = w.gender || '';
        if (w.ethnicity !== undefined) document.getElementById('fEthnicity').value = w.ethnicity || '';
        if (Array.isArray(w.signature_phrases)) document.getElementById('fSignaturePhrases').value = w.signature_phrases.join(', ');
        if (!preserveName && w.name)   document.getElementById('fName').value = w.name;
      }
      // Update local writerData
      Object.assign(writerData, w);
    }

    var refreshBtn = document.getElementById('refreshPersonaBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async function () {
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing...';
        try {
          await regeneratePersona('refresh', true);
          refreshBtn.textContent = 'Refreshed \u2713';
          setTimeout(function () { refreshBtn.textContent = 'Refresh'; refreshBtn.disabled = false; }, 1500);
        } catch (err) {
          alert('Refresh failed: ' + (err.message || err));
          refreshBtn.disabled = false;
          refreshBtn.textContent = 'Refresh';
        }
      });
    }

    // Avatar style: Regenerate + Reset to auto
    var regenAvatarBtn = document.getElementById('regenAvatarBtn');
    if (regenAvatarBtn) {
      regenAvatarBtn.addEventListener('click', async function () {
        if (!writerData.id) { alert('Save the writer first.'); return; }
        // Persist the style overrides first so the server picks them up.
        var famEl = document.getElementById('fAvatarStyleFamily');
        var notesEl = document.getElementById('fAvatarStyleNotes');
        regenAvatarBtn.disabled = true;
        var origLabel = regenAvatarBtn.textContent;
        regenAvatarBtn.textContent = 'Regenerating...';
        try {
          await apiFetch('/admin/writers/' + writerData.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: document.getElementById('fName').value.trim() || writerData.name,
              avatar_style_family: (famEl && famEl.value) || null,
              avatar_style_notes: (notesEl && notesEl.value.trim()) || null,
            }),
          });
          writerData.avatar_style_family = (famEl && famEl.value) || null;
          writerData.avatar_style_notes = (notesEl && notesEl.value.trim()) || null;
          var data = await apiFetch('/admin/writers/' + writerData.id + '/generate-avatar', { method: 'POST' });
          var newUrl = data.avatar_url ? (data.avatar_url + (data.avatar_url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + Date.now()) : null;
          if (newUrl) {
            writerData.avatar_url = data.avatar_url;
            var img = document.getElementById('writerAvatarImg') || document.querySelector('.wd-avatar');
            if (img && img.tagName === 'IMG') {
              img.src = newUrl;
            } else if (img) {
              img.outerHTML = '<img id="writerAvatarImg" class="wd-avatar" src="' + newUrl + '" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--accent);" />';
            }
          }
          showAlert('Avatar regenerated');
        } catch (err) {
          showAlert('Regenerate failed: ' + (err.message || err), 'error');
        } finally {
          regenAvatarBtn.disabled = false;
          regenAvatarBtn.textContent = origLabel;
        }
      });
    }

    var resetAvatarStyleBtn = document.getElementById('resetAvatarStyleBtn');
    if (resetAvatarStyleBtn) {
      resetAvatarStyleBtn.addEventListener('click', async function () {
        if (!writerData.id) { alert('Save the writer first.'); return; }
        if (!confirm('Reset avatar style overrides to auto (tenant default)?')) return;
        resetAvatarStyleBtn.disabled = true;
        try {
          await apiFetch('/admin/writers/' + writerData.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: document.getElementById('fName').value.trim() || writerData.name,
              avatar_style_family: null,
              avatar_style_notes: null,
            }),
          });
          var famEl = document.getElementById('fAvatarStyleFamily'); if (famEl) famEl.value = '';
          var notesEl = document.getElementById('fAvatarStyleNotes'); if (notesEl) notesEl.value = '';
          writerData.avatar_style_family = null;
          writerData.avatar_style_notes = null;
          showAlert('Avatar style reset to auto');
        } catch (err) {
          showAlert('Reset failed: ' + (err.message || err), 'error');
        } finally {
          resetAvatarStyleBtn.disabled = false;
        }
      });
    }

    var rewriteBtn = document.getElementById('rewritePersonaBtn');
    if (rewriteBtn) {
      rewriteBtn.addEventListener('click', async function () {
        var alsoName = confirm('This will REWRITE the persona from scratch: bio, tone, personality, signature phrases, etc.\n\nClick OK to also regenerate the NAME.\nClick Cancel to keep the current name.\n\n(Avatar and voice are always preserved.)');
        // Second confirmation to actually proceed
        if (!confirm('Continue with full rewrite?' + (alsoName ? ' (Name will be regenerated.)' : ' (Name will be kept.)'))) return;
        rewriteBtn.disabled = true;
        rewriteBtn.textContent = 'Rewriting...';
        try {
          await regeneratePersona('rewrite', !alsoName);
          rewriteBtn.textContent = 'Rewritten \u2713';
          setTimeout(function () { rewriteBtn.textContent = 'Rewrite from scratch'; rewriteBtn.disabled = false; }, 1500);
        } catch (err) {
          alert('Rewrite failed: ' + (err.message || err));
          rewriteBtn.disabled = false;
          rewriteBtn.textContent = 'Rewrite from scratch';
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

  document.getElementById('saveWriterBtn').addEventListener('click', async function () {
    var name = document.getElementById('fName').value.trim();
    if (!name) { showAlert('Name is required', 'error'); return; }

    var keywordsRaw = document.getElementById('fKeywords').value.trim();
    var sigRaw = document.getElementById('fSignaturePhrases').value.trim();
    var fse = [];
    document.querySelectorAll('#fewShotContainer .few-shot-row').forEach(function (row) {
      var t = row.querySelector('.fs-title').value.trim();
      var e = row.querySelector('.fs-excerpt').value.trim();
      if (t || e) fse.push({ title: t, excerpt: e });
    });

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
      role: document.getElementById('fRole').value || 'writer',
      tone: document.getElementById('fTone').value || null,
      expertise_level: document.getElementById('fExpertise').value || null,
      style_guide: document.getElementById('fStyleGuide').value.trim() || null,
      few_shot_examples: fse,
      beat_angle: document.getElementById('fBeatAngle').value.trim() || null,
      signature_phrases: sigRaw ? sigRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 5) : null,
      contrarian_level: parseFloat(document.getElementById('fContrarian').value),
      is_auto: document.getElementById('fIsAuto').checked,
      synthesis_schedule: document.getElementById('fSchedule').value,
      synthesis_lookback_hours: parseInt(document.getElementById('fLookback').value) || 168,
      min_cluster_size: parseInt(document.getElementById('fMinCluster').value) || 2,
      elevenlabs_voice_id: document.getElementById('fVoiceId').value.trim() || null,
      gender: document.getElementById('fGender').value || null,
      ethnicity: document.getElementById('fEthnicity').value || null,
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
        showAlert('Writer created');
        window.location.href = '/writer-detail.html?id=' + saved.id;
      } else {
        saved = await apiFetch('/admin/writers/' + writerData.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        showAlert('Writer updated');
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

  onReady(function () {
    if (!requireAuth()) return;
    renderSidebar();
    initModals();
    loadWriterDetail();
  });
})();
