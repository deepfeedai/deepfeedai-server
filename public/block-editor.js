/**
 * Deep Feed AI Admin — Block Editor Page Controller
 * Full-page article editor built on Editor.js.
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────
  let editor = null;
  let articleId = null;
  let articleData = null;
  let isDirty = false;
  let isSaving = false;
  let writersList = [];

  // ── Init ───────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    // Auth check
    if (!getToken()) {
      window.location.href = '/login.html';
      return;
    }

    // Permission check — need articles.create (new) or articles.update (edit)
    var params = new URLSearchParams(window.location.search);
    var requiredPerm = params.get('id') ? 'articles.update' : 'articles.create';
    if (!hasPermission(requiredPerm)) {
      showAlert('You don\'t have permission to use the article editor', 'error');
      setTimeout(function() { window.location.href = window._editorReturnUrl || '/articles.html'; }, 1500);
      return;
    }

    // Wire up ALL UI listeners immediately — before any async work.
    // This ensures buttons work even if data loading fails.
    document.getElementById('editorSaveBtn').addEventListener('click', saveArticle);
    document.getElementById('editorPreviewBtn').addEventListener('click', openPreview);
    document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);
    const titleEl = document.getElementById('editorTitle');
    titleEl.addEventListener('input', () => { isDirty = true; updateTopbarTitle(); autoResizeTitle(); });

    // Enter on title → focus editor (no newlines in title); Tab also moves to editor
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); focusEditor(); }
      if (e.key === 'Tab') { e.preventDefault(); focusEditor(); }
    });

    // Auto-resize title textarea on load
    autoResizeTitle();

    // Sidebar metadata changes → mark dirty
    ['esSummary', 'esCategory', 'esAuthor', 'esSource', 'esSourceUrl', 'esFeatured'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => { isDirty = true; });
    });
    document.getElementById('esDisableSummary')?.addEventListener('change', () => { isDirty = true; saveArticle(); });
    document.getElementById('editorPublished').disabled=true;
    document.getElementById('editorPublished').title='Use Publish or Unpublish after saving your edits.';

    // Image upload
    document.getElementById('esImageUploadBtn').addEventListener('click', () => document.getElementById('esImageUpload').click());
    document.getElementById('esImageClearBtn').addEventListener('click', () => setImageField(''));
    document.getElementById('esImageUpload').addEventListener('change', handleImageUpload);

    // Warn on unsaved changes
    window.addEventListener('beforeunload', (e) => {
      if (isDirty) { e.preventDefault(); e.returnValue = ''; }
    });

    // Keyboard shortcut: Ctrl/Cmd+S to save
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveArticle();
      }
    });

    // Now load data asynchronously
    initPage();
  });

  async function initPage() {
    const params = new URLSearchParams(window.location.search);
    articleId = params.get('id');

    // Load categories + writers (non-blocking)
    await Promise.all([loadCategories(), loadWriters()]).catch(() => {});

    if (articleId) {
      await loadArticle(articleId);
    } else {
      await initEditorInstance(null);
      document.getElementById('editorLabel').textContent = 'New Article';
    }
  }

  // ── Load Article ───────────────────────────────────────
  async function loadArticle(id) {
    try {
      articleData = await apiFetch('/articles/' + id);
    } catch (err) {
      showAlert('Failed to load article: ' + err.message, 'error');
      return;
    }

    // Populate metadata
    document.getElementById('editorTitle').value = articleData.title || '';
    document.getElementById('esSummary').value = articleData.summary || '';
    populateCategorySelect(articleData.category || 'Industry');
    document.getElementById('esAuthor').value = articleData.author || '';
    document.getElementById('esSource').value = articleData.source || '';
    document.getElementById('esSourceUrl').value = articleData.source_url || '';
    setImageField(articleData.image_url || '');
    populateWriterSelect(articleData.writer_id || null);
    document.getElementById('editorPublished').checked = !!articleData.is_published;
    document.getElementById('esFeatured').value = articleData.is_featured ? (articleData.featured_priority || 1) : 0;
    document.getElementById('esDisableSummary').checked = !!articleData.disable_summary;

    document.getElementById('editorLabel').textContent = 'Edit Article';
    updateTopbarTitle();
    autoResizeTitle();

    // Load content blocks or convert markdown
    let blockData = null;
    if (articleData.content_blocks) {
      blockData = typeof articleData.content_blocks === 'string'
        ? JSON.parse(articleData.content_blocks)
        : articleData.content_blocks;
    } else if (articleData.full_content) {
      // Lazy convert markdown → blocks
      blockData = markdownToBlocks(articleData.full_content);

      // Splice inline images into block data at their original positions
      var inlineImages = articleData.inline_images;
      if (inlineImages && typeof inlineImages === 'string') {
        try { inlineImages = JSON.parse(inlineImages); } catch (e) { inlineImages = []; }
      }
      if (Array.isArray(inlineImages) && inlineImages.length && blockData.blocks.length) {
        // Sort by position descending so splicing doesn't shift indices
        var readyImages = inlineImages
          .filter(function (img) { return img.status === 'ready' && img.url; })
          .sort(function (a, b) { return (b.position || 0) - (a.position || 0); });
        readyImages.forEach(function (img) {
          var pos = (img.position || 0) + 1; // insert after the target paragraph
          if (pos > blockData.blocks.length) pos = blockData.blocks.length;
          blockData.blocks.splice(pos, 0, {
            type: 'image',
            data: { file: { url: img.url }, caption: img.alt || '' }
          });
        });
      }
    }

    await initEditorInstance(blockData);
    initActionsPanel();
  }

  // ── Initialize Editor.js ───────────────────────────────
  async function initEditorInstance(data) {
    if (editor) {
      editor.destroy();
      editor = null;
    }

    // Build tools config — only include plugins that actually loaded from CDN
    const tools = {};
    if (window.Header) {
      tools.header = {
        class: window.Header,
        config: { levels: [2, 3, 4], defaultLevel: 2 },
        shortcut: 'CMD+SHIFT+H',
      };
    }
    const ListClass = window.NestedList || window.List || window.EditorjsList;
    if (ListClass) {
      tools.list = { class: ListClass, inlineToolbar: true };
    }
    if (window.Quote) {
      tools.quote = {
        class: window.Quote,
        inlineToolbar: true,
        config: { quotePlaceholder: 'Enter a quote', captionPlaceholder: 'Quote attribution' },
      };
    }
    if (window.ImageTool) {
      tools.image = {
        class: window.ImageTool,
        config: { uploader: { uploadByFile: uploadImage, uploadByUrl: uploadImageByUrl } },
      };
    }
    if (window.Delimiter) {
      tools.delimiter = { class: window.Delimiter };
    }
    if (window.Embed) {
      tools.embed = {
        class: window.Embed,
        config: {
          services: {
            youtube: true
          }
        }
      };
    }

    const config = {
      holder: 'editorjs',
      placeholder: 'Start writing or press Tab to choose a block type...',
      data: data && data.blocks && data.blocks.length ? data : undefined,
      tools,
      onChange: () => {
        isDirty = true;
        updateStatus('Unsaved changes');
        updateReadingTime();
      },
    };

    if (typeof EditorJS === 'undefined') {
      console.error('EditorJS not loaded — check script tags');
      updateStatus('Editor failed to load');
      showAlert('Editor.js failed to load. Check browser console.', 'error');
      return;
    }

    editor = new EditorJS(config);
    window._dfaEditor = editor; // expose for editor-assist.js

    // Wait for Editor.js to be ready before allowing interaction
    try {
      await editor.isReady;
    } catch (err) {
      console.error('Editor.js init failed:', err);
      editor = null;
      window._dfaEditor = null;
      updateStatus('Editor failed to load');
      showAlert('Editor failed to initialize: ' + err.message, 'error');
    }
  }

  // ── Focus Editor ───────────────────────────────────────
  function focusEditor() {
    if (!editor) return;
    // Focus the first block, or create one if empty
    const editorEl = document.getElementById('editorjs');
    const firstBlock = editorEl && editorEl.querySelector('[contenteditable]');
    if (firstBlock) {
      firstBlock.focus();
    } else {
      // Editor.js caret API
      try { editor.caret.setToFirstBlock('start'); } catch {}
    }
  }

  // ── Image Upload ───────────────────────────────────────
  async function uploadImage(file) {
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetch(API + '/media/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      return { success: 1, file: { url: data.imageUrl } };
    } catch (err) {
      showAlert('Image upload failed: ' + err.message, 'error');
      return { success: 0 };
    }
  }

  async function uploadImageByUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return { success: 0 };
    } catch { return { success: 0 }; }
    return { success: 1, file: { url } };
  }

  // ── Save Article ───────────────────────────────────────
  async function saveArticle() {
    if (isSaving) return;

    if (!editor) {
      showAlert('Editor not initialized — cannot save', 'error');
      return;
    }

    const title = document.getElementById('editorTitle').value.trim();
    if (!title) {
      showAlert('Title is required', 'error');
      return;
    }

    isSaving = true;
    const saveBtn = document.getElementById('editorSaveBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    updateStatus('Saving...');

    try {
      const outputData = await editor.save();

      const payload = {
        title,
        summary: document.getElementById('esSummary').value.trim() || null,
        category: document.getElementById('esCategory').value,
        author: document.getElementById('esAuthor').value.trim() || null,
        source: document.getElementById('esSource').value.trim() || null,
        source_url: document.getElementById('esSourceUrl').value.trim() || null,
        image_url: document.getElementById('esImageUrl').value.trim() || null,
        expected_revision: articleData?.publication_revision,
        is_featured: parseInt(document.getElementById('esFeatured').value) > 0,
        featured_priority: parseInt(document.getElementById('esFeatured').value) || null,
        disable_summary: document.getElementById('esDisableSummary').checked,
        content_blocks: outputData.blocks && outputData.blocks.length
          ? { version: '1.0', blocks: outputData.blocks }
          : null,
      };

      const writerVal = document.getElementById('esWriter').value;
      const writerId = writerVal ? parseInt(writerVal) : null;
    payload.writer_id=writerId;

      let saved;
      if (articleId) {
        saved = await apiFetch('/articles/' + articleId, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        saved = await apiFetch('/articles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (saved && saved.id) {
          articleId = saved.id;
          articleData = saved;
          // Update URL without reload
          const newUrl = '/article-editor.html?id=' + saved.id;
          window.history.replaceState({}, '', newUrl);
          document.getElementById('editorLabel').textContent = 'Edit Article';
        }
      }

      articleData={...articleData,...saved,writer_id:writerId};
      isDirty = false;
      updateStatus('Saved');
      showAlert('Article saved');
    } catch (err) {
      showAlert('Save failed: ' + err.message, 'error');
      updateStatus('Save failed');
    } finally {
      isSaving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  // ── Categories ─────────────────────────────────────────
  let categoryList = [];
  async function loadCategories() {
    try {
      categoryList = await apiFetch('/categories');
    } catch {
      categoryList = [];
    }
    // Fallback if API returns empty
    if (!categoryList.length) {
      categoryList = [
        { name: 'Industry' }, { name: 'Research' }, { name: 'Business' }, { name: 'Policy' }, { name: 'Technical' },
        { name: 'Ethics' }, { name: 'Startups' }, { name: 'Applications' }, { name: 'Hardware' }, { name: 'Culture' },
      ];
    }
    populateCategorySelect(null);
  }

  function populateCategorySelect(selected) {
    const select = document.getElementById('esCategory');
    const names = categoryList.map(function(c) { return c.name || c; });
    // Ensure current article's category is in the list even if custom
    if (selected && !names.includes(selected)) names.push(selected);
    select.innerHTML = names.map(function(name) {
      return '<option value="' + escHtml(name) + '"' + (name === selected ? ' selected' : '') + '>' + escHtml(name) + '</option>';
    }).join('');
  }

  // ── Writers ────────────────────────────────────────────
  async function loadWriters() {
    try {
      writersList = await apiFetch('/writers');
    } catch { writersList = []; }
    populateWriterSelect(null);
  }

  function populateWriterSelect(selectedId) {
    const select = document.getElementById('esWriter');
    select.innerHTML = '<option value="">Unassigned</option>' +
      writersList.map(w =>
        '<option value="' + w.id + '"' + (w.id === selectedId ? ' selected' : '') + '>'
        + escHtml(w.name) + '</option>'
      ).join('');
  }

  // ── Image Field ────────────────────────────────────────
  function setImageField(url) {
    document.getElementById('esImageUrl').value = url || '';
    const status = document.getElementById('esImageStatus');
    const clearBtn = document.getElementById('esImageClearBtn');
    if (url) {
      status.textContent = url.split('/').pop() || url;
      status.title = url;
      clearBtn.style.display = '';
    } else {
      status.textContent = 'No image';
      status.title = '';
      clearBtn.style.display = 'none';
    }
  }

  async function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetch(API + '/media/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setImageField(data.url);
      isDirty = true;
    } catch (err) {
      showAlert('Upload failed: ' + err.message, 'error');
    }
    e.target.value = '';
  }

  // ── Sidebar Toggle ─────────────────────────────────────
  function toggleSidebar() {
    document.getElementById('editorSidebar').classList.toggle('collapsed');
  }

  // ── Preview ────────────────────────────────────────────
  async function openPreview() {
    if (!articleId) {
      showAlert('Save the article first to preview', 'error');
      return;
    }
    // Fetch fresh article data for preview
    try {
      var fresh = await apiFetch('/articles/' + articleId);
      var writer = null;
      if (fresh.writer_id) {
        writer = writersList.find(function(w) { return w.id === fresh.writer_id; }) || null;
      }
      if (typeof showArticlePreview === 'function') {
        showArticlePreview(fresh, writer);
      } else {
        // Open on the public site
        var slug = fresh.slug || '';
        if (slug) window.open(getSiteBase() + '/article/' + slug, '_blank');
      }
    } catch (err) {
      showAlert('Preview failed: ' + err.message, 'error');
    }
  }

  // ── UI Helpers ─────────────────────────────────────────
  function updateTopbarTitle() {
    const title = document.getElementById('editorTitle').value.trim();
    document.getElementById('editorLabel').textContent = title || (articleId ? 'Edit Article' : 'New Article');
  }

  function autoResizeTitle() {
    const el = document.getElementById('editorTitle');
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function updateStatus(text) {
    document.getElementById('editorStatus').textContent = text;
  }

  // ── Markdown → Blocks (client-side lazy migration) ────
  function markdownToBlocks(markdown) {
    if (!markdown || typeof markdown !== 'string') {
      return { version: '1.0', blocks: [] };
    }

    var blocks = [];
    var lines = markdown.split('\n');
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      // Header
      var hm = line.match(/^(#{1,6})\s+(.+)$/);
      if (hm) {
        blocks.push({ type: 'header', data: { text: mdInline(hm[2].trim()), level: hm[1].length } });
        i++; continue;
      }

      // Delimiter
      if (/^-{3,}$/.test(line.trim())) {
        blocks.push({ type: 'delimiter', data: {} });
        i++; continue;
      }

      // Blockquote
      if (line.startsWith('> ')) {
        var qlines = [];
        while (i < lines.length && lines[i].startsWith('> ')) {
          qlines.push(lines[i].slice(2));
          i++;
        }
        var qtext = qlines.join('\n');
        var cm = qtext.match(/^(.+)\n— (.+)$/s);
        blocks.push({
          type: 'quote',
          data: cm
            ? { text: mdInline(cm[1].trim()), caption: cm[2].trim() }
            : { text: mdInline(qtext.trim()), caption: '' }
        });
        continue;
      }

      // List
      if (/^(\d+\.\s|[-*]\s)/.test(line)) {
        var items = [];
        var ordered = /^\d+\./.test(line);
        while (i < lines.length && /^(\d+\.\s|[-*]\s)/.test(lines[i])) {
          items.push(mdInline(lines[i].replace(/^(\d+\.\s|[-*]\s)/, '').trim()));
          i++;
        }
        blocks.push({ type: 'list', data: { style: ordered ? 'ordered' : 'unordered', items: items } });
        continue;
      }

      // Image
      var im = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (im) {
        blocks.push({ type: 'image', data: { file: { url: im[2] }, caption: im[1] } });
        i++; continue;
      }

      // Paragraph — collect until blank or block element
      var plines = [];
      while (i < lines.length && lines[i].trim() &&
        !lines[i].match(/^#{1,6}\s/) && !lines[i].startsWith('> ') &&
        !/^-{3,}$/.test(lines[i].trim()) && !/^(\d+\.\s|[-*]\s)/.test(lines[i])) {
        plines.push(lines[i]);
        i++;
      }
      if (plines.length) {
        blocks.push({ type: 'paragraph', data: { text: mdInline(plines.join(' ')) } });
      }
    }

    return { version: '1.0', blocks: blocks };
  }

  function mdInline(s) {
    return (s || '')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/_(.+?)_/g, '<i>$1</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  // ── Actions Panel ──────────────────────────────────────
  function initActionsPanel() {
    if (!articleId) return;

    const actionsEl = document.getElementById('editorActions');
    actionsEl.style.display = '';

    // Scroll sidebar to reveal Actions section after layout settles
    setTimeout(function() {
      const sidebar = document.getElementById('editorSidebar');
      if (sidebar) sidebar.scrollTop = actionsEl.offsetTop - 20;
    }, 400);

    // Publish toggle label
    syncPublishToggleLabel();

    // Show regenerate + source panel only for originals/deep-dive
    const isOriginal = articleData && (articleData.content_type === 'original' || articleData.content_type === 'deep-dive');
    if (isOriginal) {
      document.getElementById('actionRegenerate').style.display = '';
      renderSourcePanel();
    }

    // Wire listeners
    document.getElementById('actionTogglePublish').addEventListener('click', handleTogglePublish);
    document.getElementById('actionArchive').addEventListener('click', handleArchive);
    document.getElementById('actionRewrite').addEventListener('click', handleRewrite);
    document.getElementById('actionGenAudio').addEventListener('click', handleGenAudio);
    document.getElementById('actionGenThumbnail').addEventListener('click', handleGenThumbnail);
    document.getElementById('actionRegenerate').addEventListener('click', handleRegenerate);
    document.getElementById('actionCopyLink').addEventListener('click', handleCopyLink);
    document.getElementById('actionAddToStory').addEventListener('click', handleAddToStory);
    document.getElementById('actionDelete').addEventListener('click', handleDelete);

    // Reading time — live update on editor change
    updateReadingTime();

    // Load active stories for dropdown
    loadStoriesForDropdown();
  }

  function syncPublishToggleLabel() {
    const btn = document.getElementById('actionTogglePublish');
    if (!btn) return;
    const isPublished = document.getElementById('editorPublished').checked;
    btn.textContent = isPublished ? 'Unpublish' : 'Publish';
  }

  function updateReadingTime() {
    if (!editor) return;
    editor.save().then(function(data) {
      var words = 0;
      (data.blocks || []).forEach(function(b) {
        var text = '';
        if (b.data) {
          text = (b.data.text || '') + ' ' + (b.data.caption || '') + ' ' +
            (Array.isArray(b.data.items) ? b.data.items.join(' ') : '');
        }
        words += text.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
      });
      var mins = Math.max(1, Math.round(words / 200));
      var el = document.getElementById('actionReadingTime');
      if (el) el.textContent = 'Reading time: ~' + mins + ' min (' + words + ' words)';
    }).catch(function() {});
  }

  async function handleTogglePublish() {
    const btn = document.getElementById('actionTogglePublish');
    if(btn.disabled)return;
    if(isDirty){showAlert('Save your edits before changing publication status.','error');return;}
    const published=!articleData.is_published;
    if(!confirm(published?'Publish this reviewed article to readers?':'Unpublish this article from readers?'))return;
    btn.disabled = true;
    try {
      const result = await apiFetch('/articles/' + articleId + '/publish', { method: 'PUT',body:JSON.stringify({published,expected_revision:articleData.publication_revision}) });
      articleData={...articleData,...result};
      const nowPublished = result.is_published === 1;
      document.getElementById('editorPublished').checked = nowPublished;
      articleData.is_published = nowPublished ? 1 : 0;
      syncPublishToggleLabel();
      updateStatus(nowPublished ? 'Published' : 'Unpublished');
      showAlert(nowPublished ? 'Article published' : 'Article unpublished');
    } catch (err) {
      showAlert('Failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function handleArchive() {
    if (!confirm('Archive this article? It will be unpublished and hidden from the feed.')) return;
    const btn = document.getElementById('actionArchive');
    btn.disabled = true;
    try {
      await apiFetch('/articles/' + articleId, { method: 'DELETE' });
      showAlert('Article archived');
      setTimeout(function() { window.location.href = '/articles.html'; }, 1200);
    } catch (err) {
      showAlert('Archive failed: ' + err.message, 'error');
      btn.disabled = false;
    }
  }

  async function handleRewrite() {
    const mode = document.getElementById('actionRewriteMode').value;
    const btn = document.getElementById('actionRewrite');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const result = await apiFetch('/articles/' + articleId + '/rewrite', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      if (mode === 'headline' && result.generated_title) {
        document.getElementById('editorTitle').value = result.generated_title;
        updateTopbarTitle();
        autoResizeTitle();
        isDirty = true;
      } else if (mode === 'summary' && result.summary) {
        document.getElementById('esSummary').value = result.summary;
        isDirty = true;
      } else if (mode === 'full' && result.full_content) {
        // Reload editor with new content
        var blocks = markdownToBlocks(result.full_content);
        await initEditorInstance(blocks);
        isDirty = true;
      }
      updateReadingTime();
      showAlert('Rewrite complete');
    } catch (err) {
      showAlert('Rewrite failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Go';
    }
  }

  async function handleGenAudio() {
    const btn = document.getElementById('actionGenAudio');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      await apiFetch('/media/generate-audio', {
        method: 'POST',
        body: JSON.stringify({ articleId: parseInt(articleId) }),
      });
      showAlert('Audio generation started — check back shortly');
    } catch (err) {
      showAlert('Audio failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate Audio';
    }
  }

  async function handleGenThumbnail() {
    const btn = document.getElementById('actionGenThumbnail');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const result = await apiFetch('/media/generate-image', {
        method: 'POST',
        body: JSON.stringify({ articleId: parseInt(articleId) }),
      });
      if (result && result.imageUrl) {
        setImageField(result.imageUrl);
        isDirty = true;
      }
      showAlert('Thumbnail regenerated');
    } catch (err) {
      showAlert('Thumbnail failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Regenerate Thumbnail';
    }
  }

  async function handleRegenerate() {
    if (!confirm('Regenerate this article from its source articles? This will replace the current content.')) return;
    const btn = document.getElementById('actionRegenerate');
    btn.disabled = true;
    btn.textContent = 'Regenerating…';
    try {
      const result = await apiFetch('/articles/' + articleId + '/regenerate', { method: 'POST' });
      showAlert('Article regenerated — reloading…');
      setTimeout(function() { window.location.reload(); }, 1500);
    } catch (err) {
      showAlert('Regenerate failed: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Regenerate Article';
    }
  }

  function handleCopyLink() {
    if (!articleData) return;
    var slug = articleData.slug || '';
    var url = getSiteBase() + '/article/' + slug;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function() {
        showAlert('Link copied');
      }).catch(function() {
        prompt('Copy this link:', url);
      });
    } else {
      prompt('Copy this link:', url);
    }
  }

  async function loadStoriesForDropdown() {
    try {
      const data = await apiFetch('/story-timelines?status=active,dormant&limit=100');
      const stories = (data && data.stories) ? data.stories : (Array.isArray(data) ? data : []);
      const sel = document.getElementById('actionStorySelect');
      if (!stories.length) {
        sel.innerHTML = '<option value="">No active stories</option>';
        return;
      }
      sel.innerHTML = '<option value="">Select a story…</option>' +
        stories.map(function(s) {
          return '<option value="' + s.id + '">' + escHtml(s.name || ('Story #' + s.id)) + '</option>';
        }).join('');
    } catch (err) {
      document.getElementById('actionStorySelect').innerHTML = '<option value="">Failed to load stories</option>';
    }
  }

  async function handleAddToStory() {
    const storyId = document.getElementById('actionStorySelect').value;
    if (!storyId) { showAlert('Select a story first', 'error'); return; }
    const btn = document.getElementById('actionAddToStory');
    btn.disabled = true;
    try {
      await apiFetch('/story-timelines/' + storyId + '/articles', {
        method: 'POST',
        body: JSON.stringify({ articleId: parseInt(articleId) }),
      });
      showAlert('Added to story');
    } catch (err) {
      showAlert('Failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function handleDelete() {
    const title = document.getElementById('editorTitle').value.trim() || 'this article';
    if (!confirm('Permanently delete "' + title + '"?\n\nThis cannot be undone.')) return;
    if (!confirm('Are you sure? All media and analytics data will be removed.')) return;
    const btn = document.getElementById('actionDelete');
    btn.disabled = true;
    try {
      await apiFetch('/articles/' + articleId + '/purge', { method: 'DELETE' });
      showAlert('Article deleted');
      isDirty = false;
      setTimeout(function() { window.location.href = '/articles.html'; }, 1200);
    } catch (err) {
      showAlert('Delete failed: ' + err.message, 'error');
      btn.disabled = false;
    }
  }

  function renderSourcePanel() {
    let sourceIds;
    try {
      const raw = typeof articleData.source_article_ids === 'string'
        ? JSON.parse(articleData.source_article_ids)
        : (articleData.source_article_ids || []);
      sourceIds = raw.map(function(r) { return (typeof r === 'object' && r !== null) ? r.id : r; }).filter(Boolean);
    } catch { sourceIds = []; }

    if (!sourceIds.length) return;

    const panel = document.getElementById('actionSourcePanel');
    const list = document.getElementById('actionSourceList');
    panel.style.display = '';

    // Fetch source article titles
    Promise.all(sourceIds.map(function(id) {
      return apiFetch('/articles/' + id).catch(function() { return { id: id, title: 'Article #' + id }; });
    })).then(function(sources) {
      list.innerHTML = sources.map(function(s) {
        return '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border-color)">'
          + '<span class="text-sm" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(s.title) + '">' + escHtml(s.title) + '</span>'
          + '<button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px;flex-shrink:0" data-remove-source="' + s.id + '">✕</button>'
          + '</div>';
      }).join('');

      list.addEventListener('click', function(e) {
        const btn = e.target.closest('[data-remove-source]');
        if (!btn) return;
        const srcId = parseInt(btn.getAttribute('data-remove-source'));
        handleRemoveSource(srcId, sourceIds, sources);
      });
    }).catch(function() {});
  }

  async function handleRemoveSource(srcId, sourceIds, sources) {
    if (!confirm('Remove this source article from the synthesis? The article itself will not be deleted.')) return;

    const newIds = sourceIds.filter(function(id) { return id !== srcId; });
    try {
      await apiFetch('/articles/' + articleId, {
        method: 'PUT',
        body: JSON.stringify({ source_article_ids: newIds }),
      });
      // Re-render source panel
      articleData.source_article_ids = JSON.stringify(newIds);
      document.getElementById('actionSourceList').innerHTML = '';
      renderSourcePanel();
      showAlert('Source removed');
    } catch (err) {
      showAlert('Failed: ' + err.message, 'error');
    }
  }
})();
