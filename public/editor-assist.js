/**
 * Deep Feed AI Admin — Editor AI Assistant
 * Inline chat panel for AI-assisted article editing.
 * Reads current editor state, streams responses, applies actions.
 */
(function () {
  'use strict';

  let chatHistory = [];
  let isStreaming = false;
  let panelOpen = false;

  // ── SVG Icons ─────────────────────────────────────────────
  const ICON_AI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v1a3 3 0 0 1-3 3h-1v4a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-4H7a3 3 0 0 1-3-3v-1a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4z"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  // ── Initialization ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    if (!getToken()) return;
    injectPanel();
    bindEvents();
  });

  function injectPanel() {
    // FAB button in topbar
    const topbarRight = document.querySelector('.editor-topbar-right');
    if (topbarRight) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-outline btn-sm ea-toggle-btn';
      btn.id = 'eaToggleBtn';
      btn.innerHTML = ICON_AI + ' <span>AI Assist</span>';
      btn.title = 'AI Writing Assistant';
      // Insert before Preview button
      const previewBtn = document.getElementById('editorPreviewBtn');
      if (previewBtn) {
        topbarRight.insertBefore(btn, previewBtn);
      } else {
        topbarRight.prepend(btn);
      }
    }

    // Chat panel — slides in from the right
    const panel = document.createElement('div');
    panel.className = 'ea-panel';
    panel.id = 'eaPanel';
    panel.innerHTML = `
      <div class="ea-header">
        <span class="ea-header-title">${ICON_AI} AI Assistant</span>
        <button class="ea-header-btn" id="eaCloseBtn" title="Close">${ICON_CLOSE}</button>
      </div>
      <div class="ea-messages" id="eaMessages">
        <div class="ea-empty">
          I can help you write, edit, and improve this article. Try:
          <ul>
            <li>"Write an introduction about..."</li>
            <li>"Rewrite in a more formal tone"</li>
            <li>"Generate a summary"</li>
            <li>"Add a section about..."</li>
            <li>"Suggest a better title"</li>
          </ul>
        </div>
      </div>
      <div class="ea-input-area">
        <textarea class="ea-input" id="eaInput" placeholder="Ask AI to help edit..." rows="1"></textarea>
        <button class="ea-send-btn" id="eaSendBtn" disabled>${ICON_SEND}</button>
      </div>`;
    document.body.appendChild(panel);
  }

  function bindEvents() {
    document.getElementById('eaToggleBtn')?.addEventListener('click', togglePanel);
    document.getElementById('eaCloseBtn')?.addEventListener('click', closePanel);
    document.getElementById('eaSendBtn')?.addEventListener('click', sendMessage);

    const input = document.getElementById('eaInput');
    if (input) {
      input.addEventListener('input', () => {
        document.getElementById('eaSendBtn').disabled = !input.value.trim() || isStreaming;
        autoResize(input);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (input.value.trim() && !isStreaming) sendMessage();
        }
      });
    }
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
  }

  // ── Panel Toggle ──────────────────────────────────────────

  function togglePanel() {
    panelOpen ? closePanel() : openPanel();
  }

  function openPanel() {
    const panel = document.getElementById('eaPanel');
    panel.classList.add('open');
    panelOpen = true;
    document.getElementById('eaInput').focus();
    // Adjust editor canvas to make room
    document.querySelector('.editor-canvas')?.classList.add('ea-shifted');
  }

  function closePanel() {
    document.getElementById('eaPanel').classList.remove('open');
    panelOpen = false;
    document.querySelector('.editor-canvas')?.classList.remove('ea-shifted');
  }

  // ── Get Article Context ───────────────────────────────────

  async function getArticleContext() {
    const title = document.getElementById('editorTitle')?.value?.trim() || '';
    const summary = document.getElementById('esSummary')?.value?.trim() || '';
    const category = document.getElementById('esCategory')?.value || '';
    const author = document.getElementById('esAuthor')?.value?.trim() || '';
    const writerSelect = document.getElementById('esWriter');
    const writerId = writerSelect?.value ? parseInt(writerSelect.value) : null;

    // Get blocks from Editor.js
    let blocks = [];
    if (window._dfaEditor && typeof window._dfaEditor.save === 'function') {
      try {
        const data = await window._dfaEditor.save();
        blocks = data.blocks || [];
      } catch { /* editor not ready */ }
    }

    return { title, summary, category, author, writerId, blocks };
  }

  // ── Send Message ──────────────────────────────────────────

  async function sendMessage() {
    const input = document.getElementById('eaInput');
    const content = input.value.trim();
    if (!content || isStreaming) return;

    // Clear empty state
    const messagesEl = document.getElementById('eaMessages');
    const emptyEl = messagesEl.querySelector('.ea-empty');
    if (emptyEl) emptyEl.remove();

    // Show user message
    appendMessage('user', content);
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('eaSendBtn').disabled = true;

    // Show typing
    const typingEl = showTyping();
    isStreaming = true;

    try {
      const articleContext = await getArticleContext();
      const token = getToken();

      const response = await fetch(API + '/article-assist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: content,
          articleContext,
          history: chatHistory.slice(-10),
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      let buffer = '';
      let msgBubble = null;
      let pendingAction = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }

          if (data.type === 'text') {
            if (!msgBubble) {
              typingEl.remove();
              msgBubble = appendMessage('assistant', '');
            }
            assistantContent += data.content;
            // Render but strip any trailing action tags from display
            msgBubble.innerHTML = renderMarkdown(stripActionTags(assistantContent));
            scrollToBottom();
          } else if (data.type === 'action') {
            pendingAction = data.action;
          } else if (data.type === 'done') {
            if (pendingAction) {
              showActionBar(pendingAction, msgBubble);
            }
          } else if (data.type === 'error') {
            if (typingEl.parentNode) typingEl.remove();
            if (msgBubble) msgBubble.remove();
            showAlert(data.message, 'error');
          }
        }
      }

      if (!msgBubble && typingEl.parentNode) typingEl.remove();

      // Update history
      chatHistory.push({ role: 'user', content });
      chatHistory.push({ role: 'assistant', content: stripActionTags(assistantContent) });

    } catch (err) {
      if (typingEl.parentNode) typingEl.remove();
      showAlert(err.message || 'Failed to get AI response', 'error');
    }

    isStreaming = false;
    document.getElementById('eaSendBtn').disabled = !document.getElementById('eaInput').value.trim();
  }

  // ── Action Bar (Accept / Reject) ──────────────────────────

  function showActionBar(action, msgBubble) {
    const bar = document.createElement('div');
    bar.className = 'ea-action-bar';

    const label = getActionLabel(action);
    bar.innerHTML = `
      <span class="ea-action-label">${escHtml(label)}</span>
      <div class="ea-action-buttons">
        <button class="btn btn-sm btn-primary ea-accept-btn">Apply</button>
        <button class="btn btn-sm btn-ghost ea-reject-btn">Dismiss</button>
      </div>`;

    bar.querySelector('.ea-accept-btn').addEventListener('click', () => {
      applyAction(action);
      bar.remove();
      appendSystemMessage('Change applied.');
    });
    bar.querySelector('.ea-reject-btn').addEventListener('click', () => {
      bar.remove();
      appendSystemMessage('Change dismissed.');
    });

    // Insert after the message bubble
    msgBubble.parentNode.insertBefore(bar, msgBubble.nextSibling);
    scrollToBottom();
  }

  function getActionLabel(action) {
    switch (action.type) {
      case 'set_title': return 'Set article title';
      case 'set_summary': return 'Set article summary';
      case 'replace_blocks': return 'Replace all article content';
      case 'insert_after': return `Insert content after block ${action.param}`;
      case 'replace_block': return `Replace block ${action.param}`;
      case 'delete_blocks': return `Delete blocks ${action.param}`;
      default: return `Apply: ${action.type}`;
    }
  }

  // ── Apply Action to Editor ────────────────────────────────

  function applyAction(action) {
    switch (action.type) {
      case 'set_title':
        applySetTitle(action.payload);
        break;
      case 'set_summary':
        applySetSummary(action.payload);
        break;
      case 'replace_blocks':
        applyReplaceBlocks(action.payload);
        break;
      case 'insert_after':
        applyInsertAfter(parseInt(action.param) || 0, action.payload);
        break;
      case 'replace_block':
        applyReplaceBlock(parseInt(action.param) || 0, action.payload);
        break;
      case 'delete_blocks':
        applyDeleteBlocks(action.param);
        break;
    }
  }

  function applySetTitle(text) {
    const el = document.getElementById('editorTitle');
    if (el) {
      el.value = text;
      el.dispatchEvent(new Event('input'));
    }
  }

  function applySetSummary(text) {
    const el = document.getElementById('esSummary');
    if (el) {
      el.value = text;
      el.dispatchEvent(new Event('input'));
    }
  }

  async function applyReplaceBlocks(markdown) {
    if (!window._dfaEditor) return;
    const blocks = markdownToEditorBlocks(markdown);
    try {
      await window._dfaEditor.render({ blocks });
    } catch (err) {
      showAlert('Failed to apply content: ' + err.message, 'error');
    }
  }

  async function applyInsertAfter(afterIndex, markdown) {
    if (!window._dfaEditor) return;
    const newBlocks = markdownToEditorBlocks(markdown);
    try {
      const currentData = await window._dfaEditor.save();
      const allBlocks = currentData.blocks || [];
      // Insert new blocks after the specified index
      const insertAt = Math.min(afterIndex + 1, allBlocks.length);
      allBlocks.splice(insertAt, 0, ...newBlocks);
      await window._dfaEditor.render({ blocks: allBlocks });
    } catch (err) {
      showAlert('Failed to insert content: ' + err.message, 'error');
    }
  }

  async function applyReplaceBlock(index, markdown) {
    if (!window._dfaEditor) return;
    const newBlocks = markdownToEditorBlocks(markdown);
    try {
      const currentData = await window._dfaEditor.save();
      const allBlocks = currentData.blocks || [];
      if (index >= 0 && index < allBlocks.length) {
        allBlocks.splice(index, 1, ...newBlocks);
        await window._dfaEditor.render({ blocks: allBlocks });
      }
    } catch (err) {
      showAlert('Failed to replace block: ' + err.message, 'error');
    }
  }

  async function applyDeleteBlocks(rangeStr) {
    if (!window._dfaEditor) return;
    const parts = (rangeStr || '').split('-').map(Number);
    const start = parts[0] || 0;
    const end = parts.length > 1 ? parts[1] : start;
    try {
      const currentData = await window._dfaEditor.save();
      const allBlocks = currentData.blocks || [];
      if (start >= 0 && end < allBlocks.length) {
        allBlocks.splice(start, end - start + 1);
        await window._dfaEditor.render({ blocks: allBlocks });
      }
    } catch (err) {
      showAlert('Failed to delete blocks: ' + err.message, 'error');
    }
  }

  // ── Markdown → Editor.js Blocks ───────────────────────────
  // Reuses the same logic as the block editor's markdownToBlocks

  function markdownToEditorBlocks(markdown) {
    if (!markdown || typeof markdown !== 'string') return [];

    const blocks = [];
    const lines = markdown.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // Header
      const hm = line.match(/^(#{1,6})\s+(.+)$/);
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
        const qlines = [];
        while (i < lines.length && lines[i].startsWith('> ')) {
          qlines.push(lines[i].slice(2));
          i++;
        }
        const qtext = qlines.join('\n');
        const cm = qtext.match(/^(.+)\n— (.+)$/s);
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
        const items = [];
        const ordered = /^\d+\./.test(line);
        while (i < lines.length && /^(\d+\.\s|[-*]\s)/.test(lines[i])) {
          items.push(mdInline(lines[i].replace(/^(\d+\.\s|[-*]\s)/, '').trim()));
          i++;
        }
        blocks.push({ type: 'list', data: { style: ordered ? 'ordered' : 'unordered', items } });
        continue;
      }

      // Paragraph
      const plines = [];
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

    return blocks;
  }

  function mdInline(s) {
    return (s || '')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/_(.+?)_/g, '<i>$1</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  // ── UI Helpers ────────────────────────────────────────────

  function appendMessage(role, content) {
    const el = document.getElementById('eaMessages');
    const div = document.createElement('div');
    div.className = `ea-msg ea-msg-${role}`;
    div.innerHTML = role === 'assistant' ? renderMarkdown(content) : escHtml(content);
    el.appendChild(div);
    scrollToBottom();
    return div;
  }

  function appendSystemMessage(text) {
    const el = document.getElementById('eaMessages');
    const div = document.createElement('div');
    div.className = 'ea-msg ea-msg-system';
    div.textContent = text;
    el.appendChild(div);
    scrollToBottom();
  }

  function showTyping() {
    const el = document.getElementById('eaMessages');
    const div = document.createElement('div');
    div.className = 'ea-typing';
    div.innerHTML = '<div class="ea-typing-dot"></div><div class="ea-typing-dot"></div><div class="ea-typing-dot"></div>';
    el.appendChild(div);
    scrollToBottom();
    return div;
  }

  function scrollToBottom() {
    const el = document.getElementById('eaMessages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function stripActionTags(text) {
    return (text || '').replace(/\[ACTION:[\w:.\-]+\]\s*[\s\S]*$/, '').trim();
  }

  // ── Markdown Renderer (lightweight) ───────────────────────

  function renderMarkdown(text) {
    if (!text) return '';
    let html = escHtml(text);

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(?<!<\/ul>)(<li>.*<\/li>\n?)+/g, (m) => m.includes('<ul>') ? m : `<ol>${m}</ol>`);
    html = html.replace(/^### (.+)$/gm, '<strong>$1</strong>');
    html = html.replace(/^## (.+)$/gm, '<strong>$1</strong>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<\/p><p>/g, '</p>\n<p>');
    html = html.replace(/(?<!<\/li>)\n(?!<)/g, '<br>');
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>\s*(<(?:ul|ol|pre)>)/g, '$1');
    html = html.replace(/(<\/(?:ul|ol|pre)>)\s*<\/p>/g, '$1');

    return html;
  }
})();
