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
      setTimeout(function() { window.location.href = '/articles.html'; }, 1500);
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
    document.getElementById('editorPublished')?.addEventListener('change', () => { isDirty = true; saveArticle(); });

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
        is_published: document.getElementById('editorPublished').checked,
        is_featured: parseInt(document.getElementById('esFeatured').value) > 0,
        featured_priority: parseInt(document.getElementById('esFeatured').value) || null,
        disable_summary: document.getElementById('esDisableSummary').checked,
        content_blocks: outputData.blocks && outputData.blocks.length
          ? { version: '1.0', blocks: outputData.blocks }
          : null,
      };

      const writerVal = document.getElementById('esWriter').value;
      const writerId = writerVal ? parseInt(writerVal) : null;

      let saved;
      if (articleId) {
        saved = await apiFetch('/articles/' + articleId, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        await apiFetch('/articles/' + articleId + '/assign-writer', {
          method: 'PUT',
          body: JSON.stringify({ writerId }),
        });
      } else {
        saved = await apiFetch('/articles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (saved && saved.id) {
          articleId = saved.id;
          articleData = saved;
          await apiFetch('/articles/' + saved.id + '/assign-writer', {
            method: 'PUT',
            body: JSON.stringify({ writerId }),
          });
          // Update URL without reload
          const newUrl = '/article-editor.html?id=' + saved.id;
          window.history.replaceState({}, '', newUrl);
          document.getElementById('editorLabel').textContent = 'Edit Article';
        }
      }

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
})();
