/* ===== DeepFeedAI Platform — Chat Widget ===== */

(function () {
  'use strict';

  let currentConversationId = null;
  let conversations = [];
  let isStreaming = false;
  let sidebarOpen = false;

  // Detect context: "platform" (platform dashboard) vs "portal" (tenant admin)
  const CHAT_SOURCE = (typeof getUser === 'function') ? 'platform' : 'portal';

  const EMPTY_TEXT = CHAT_SOURCE === 'platform'
    ? 'Ask me anything about your platform &mdash; tenants, AI costs, system health, and more.'
    : 'Ask me anything about your site &mdash; articles, writers, AI costs, and more.';

  // ── SVG Icons ─────────────────────────────────────────────
  const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  const ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const ICON_CLEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  // ── Initialization ────────────────────────────────────────

  function init() {
    // Platform site: getUser() returns JWT payload with type field
    // Portal site: isLoggedIn() + isPlatformAdmin() for auth check
    const isPlatform = typeof getUser === 'function';
    const isPortal = typeof isLoggedIn === 'function' && typeof isPlatformAdmin === 'function';

    if (isPlatform) {
      const user = getUser();
      if (!user) return;
    } else if (isPortal) {
      if (!isLoggedIn()) return;
      // On portal, only show for platform admins (tenant admins can't use chat yet)
      if (!isPlatformAdmin()) return;
    } else {
      return;
    }

    // Check feature flag
    checkFeatureFlag().then(enabled => {
      if (!enabled) return;
      injectDOM();
      bindEvents();
    });
  }

  async function checkFeatureFlag() {
    try {
      const data = await apiFetch('/features');
      return data.platform_chat === true;
    } catch {
      return false;
    }
  }

  // ── DOM Injection ─────────────────────────────────────────

  function injectDOM() {
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'chat-overlay';
    overlay.id = 'chatOverlay';
    document.body.appendChild(overlay);

    // FAB
    const fab = document.createElement('button');
    fab.className = 'chat-fab';
    fab.id = 'chatFab';
    fab.innerHTML = ICON_CHAT;
    fab.title = 'AI Assistant';
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.className = 'chat-panel';
    panel.id = 'chatPanel';
    panel.innerHTML = `
      <div class="chat-sidebar" id="chatSidebar">
        <div class="chat-sidebar-header">
          <h4>Conversations</h4>
          <button class="chat-header-btn" id="chatSidebarClose" title="Back">${ICON_CLOSE}</button>
        </div>
        <div class="chat-conv-list" id="chatConvList"></div>
      </div>
      <div class="chat-main" id="chatMain">
        <div class="chat-header">
          <div class="chat-header-left">
            <button class="chat-header-btn" id="chatListBtn" title="Conversations">${ICON_LIST}</button>
            <span class="chat-header-title" id="chatTitle">AI Assistant</span>
          </div>
          <select class="chat-model-select" id="chatModelSelect" title="AI Model">
            <option value="">Auto</option>
          </select>
          <div class="chat-header-actions">
            <button class="chat-header-btn" id="chatClearBtn" title="Clear chat &amp; context">${ICON_CLEAR}</button>
            <button class="chat-header-btn" id="chatNewBtn" title="New chat">${ICON_NEW}</button>
            <button class="chat-header-btn" id="chatCloseBtn" title="Close">${ICON_CLOSE}</button>
          </div>
        </div>
        <div class="chat-messages" id="chatMessages">
          <div class="chat-empty">${EMPTY_TEXT}</div>
        </div>
        <div class="chat-input-area">
          <div class="chat-input-row">
            <textarea class="chat-input" id="chatInput" placeholder="Ask a question..." rows="1"></textarea>
            <button class="chat-send-btn" id="chatSendBtn" disabled>${ICON_SEND}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(panel);
  }

  // ── Event Binding ─────────────────────────────────────────

  function bindEvents() {
    const fab = document.getElementById('chatFab');
    const overlay = document.getElementById('chatOverlay');
    const closeBtn = document.getElementById('chatCloseBtn');
    const newBtn = document.getElementById('chatNewBtn');
    const listBtn = document.getElementById('chatListBtn');
    const sidebarClose = document.getElementById('chatSidebarClose');
    const sendBtn = document.getElementById('chatSendBtn');
    const input = document.getElementById('chatInput');

    fab.addEventListener('click', togglePanel);
    overlay.addEventListener('click', closePanel);
    closeBtn.addEventListener('click', closePanel);
    document.getElementById('chatClearBtn').addEventListener('click', clearChat);
    newBtn.addEventListener('click', startNewChat);
    listBtn.addEventListener('click', toggleSidebar);
    sidebarClose.addEventListener('click', closeSidebar);
    sendBtn.addEventListener('click', sendMessage);

    // Populate model selector
    loadModelSelector();

    input.addEventListener('input', () => {
      sendBtn.disabled = !input.value.trim() || isStreaming;
      autoResize(input);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (input.value.trim() && !isStreaming) sendMessage();
      }
    });
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  // ── Panel Toggle ──────────────────────────────────────────

  function togglePanel() {
    const panel = document.getElementById('chatPanel');
    const overlay = document.getElementById('chatOverlay');
    const fab = document.getElementById('chatFab');
    const isOpen = panel.classList.contains('open');

    if (isOpen) {
      closePanel();
    } else {
      panel.classList.add('open');
      overlay.classList.add('open');
      fab.classList.add('hidden');
      document.getElementById('chatInput').focus();
      if (conversations.length === 0) loadConversations();
    }
  }

  function closePanel() {
    document.getElementById('chatPanel').classList.remove('open');
    document.getElementById('chatOverlay').classList.remove('open');
    document.getElementById('chatFab').classList.remove('hidden');
    closeSidebar();
  }

  // ── Sidebar ───────────────────────────────────────────────

  function toggleSidebar() {
    const sidebar = document.getElementById('chatSidebar');
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle('open', sidebarOpen);
    if (sidebarOpen) loadConversations();
  }

  function closeSidebar() {
    sidebarOpen = false;
    document.getElementById('chatSidebar').classList.remove('open');
  }

  async function loadConversations() {
    try {
      const data = await apiFetch(`/chat/conversations?source=${CHAT_SOURCE}`);
      conversations = data.conversations || [];
      renderConversationList();
    } catch { /* silent */ }
  }

  function renderConversationList() {
    const list = document.getElementById('chatConvList');
    if (conversations.length === 0) {
      list.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px;text-align:center">No conversations yet</div>';
      return;
    }
    list.innerHTML = conversations.map(c => `
      <div class="chat-conv-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}">
        <span class="chat-conv-title">${escHtml(c.title || 'Untitled')}</span>
        <button class="chat-conv-delete" data-id="${c.id}" title="Delete">&times;</button>
      </div>
    `).join('');

    list.querySelectorAll('.chat-conv-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('chat-conv-delete')) return;
        loadConversation(parseInt(el.dataset.id));
        closeSidebar();
      });
    });

    list.querySelectorAll('.chat-conv-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        await deleteConversation(id);
      });
    });
  }

  // ── Conversation Management ───────────────────────────────

  async function startNewChat() {
    currentConversationId = null;
    document.getElementById('chatTitle').textContent = 'AI Assistant';
    document.getElementById('chatMessages').innerHTML =
      `<div class="chat-empty">${EMPTY_TEXT}</div>`;
    closeSidebar();
    document.getElementById('chatInput').focus();
  }

  async function clearChat() {
    if (isStreaming) return;
    // Delete the current conversation from the backend (clears message history + AI context)
    if (currentConversationId) {
      try {
        await apiFetch(`/chat/conversations/${currentConversationId}`, { method: 'DELETE' });
      } catch { /* best effort */ }
    }
    // Reset UI to empty state
    currentConversationId = null;
    document.getElementById('chatTitle').textContent = 'AI Assistant';
    document.getElementById('chatMessages').innerHTML =
      `<div class="chat-empty">${EMPTY_TEXT}</div>`;
    document.getElementById('chatInput').focus();
    // Refresh sidebar if open
    loadConversations().catch(() => {});
  }

  async function loadConversation(id) {
    try {
      const data = await apiFetch(`/chat/conversations/${id}/messages`);
      currentConversationId = id;
      const conv = conversations.find(c => c.id === id);
      document.getElementById('chatTitle').textContent = conv?.title || 'Chat';

      const messagesEl = document.getElementById('chatMessages');
      messagesEl.innerHTML = '';
      for (const msg of (data.messages || [])) {
        if (msg.role === 'system') continue;
        appendMessage(msg.role, msg.content);
      }
      scrollToBottom();
    } catch (err) {
      if (typeof showToast === 'function') showToast('Failed to load conversation', 'error');
    }
  }

  async function deleteConversation(id) {
    try {
      await apiFetch(`/chat/conversations/${id}`, { method: 'DELETE' });
      if (currentConversationId === id) startNewChat();
      await loadConversations();
    } catch (err) {
      if (typeof showToast === 'function') showToast('Failed to delete conversation', 'error');
    }
  }

  async function ensureConversation() {
    if (currentConversationId) return currentConversationId;
    try {
      const data = await apiFetch('/chat/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'New conversation', source: CHAT_SOURCE }),
      });
      currentConversationId = data.conversation.id;
      conversations.unshift(data.conversation);
      return currentConversationId;
    } catch (err) {
      if (typeof showToast === 'function') showToast('Failed to create conversation', 'error');
      return null;
    }
  }

  // ── Model Selector ────────────────────────────────────────

  async function loadModelSelector() {
    try {
      const data = await apiFetch('/settings/ai-providers');
      const select = document.getElementById('chatModelSelect');
      if (!select || !data.providers) return;

      const status = data.status || {};
      for (const provider of data.providers) {
        // Only show providers that are configured (have a key or are always available)
        if (!status[provider]?.configured && provider !== 'gemini') continue;

        // Fetch models for this provider
        try {
          const modelData = await apiFetch('/settings/available-models?provider=' + encodeURIComponent(provider));
          if (!modelData.models?.length) continue;

          // Add optgroup
          const group = document.createElement('optgroup');
          group.label = provider.charAt(0).toUpperCase() + provider.slice(1);
          for (const m of modelData.models) {
            const opt = document.createElement('option');
            opt.value = provider + ':' + m.id;
            opt.textContent = m.name;
            group.appendChild(opt);
          }
          select.appendChild(group);
        } catch { /* skip provider */ }
      }
    } catch { /* ai-providers not available — keep just "Auto" */ }
  }

  function getSelectedModel() {
    const select = document.getElementById('chatModelSelect');
    if (!select || !select.value) return {};
    const [provider, ...modelParts] = select.value.split(':');
    return { provider, model: modelParts.join(':') };
  }

  // ── Send Message ──────────────────────────────────────────

  async function sendMessage() {
    const input = document.getElementById('chatInput');
    const content = input.value.trim();
    if (!content || isStreaming) return;

    const convId = await ensureConversation();
    if (!convId) return;

    // Clear empty state
    const messagesEl = document.getElementById('chatMessages');
    const emptyEl = messagesEl.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();

    // Show user message
    appendMessage('user', content);
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('chatSendBtn').disabled = true;
    scrollToBottom();

    // Show typing indicator
    const typingEl = showTyping();
    isStreaming = true;

    try {
      const token = typeof getToken === 'function' ? getToken() : null;
      const response = await fetch(API + `/chat/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ content, ...getSelectedModel() }),
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
            msgBubble.innerHTML = renderMarkdown(assistantContent);
            scrollToBottom();
          } else if (data.type === 'clear') {
            // Server is re-generating with data — clear partial response
            assistantContent = '';
            if (msgBubble) msgBubble.innerHTML = '';
          } else if (data.type === 'done') {
            // Update conversation title if it changed
            loadConversations();
          } else if (data.type === 'error') {
            if (typingEl.parentNode) typingEl.remove();
            if (msgBubble) msgBubble.remove();
            if (typeof showToast === 'function') showToast(data.message, 'error');
          }
        }
      }

      // If no content received, remove typing
      if (!msgBubble) typingEl.remove();

    } catch (err) {
      typingEl.remove();
      if (typeof showToast === 'function') showToast(err.message || 'Failed to send message', 'error');
    }

    isStreaming = false;
    document.getElementById('chatSendBtn').disabled = !document.getElementById('chatInput').value.trim();
  }

  // ── UI Helpers ────────────────────────────────────────────

  function appendMessage(role, content) {
    const messagesEl = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `chat-msg chat-msg-${role}`;
    div.innerHTML = role === 'assistant' ? renderMarkdown(content) : escHtml(content);
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function showTyping() {
    const messagesEl = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'chat-typing';
    div.innerHTML = '<div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div>';
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function scrollToBottom() {
    const el = document.getElementById('chatMessages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  // ── Markdown Renderer ─────────────────────────────────────
  // Lightweight inline markdown → HTML. Handles the common cases.

  function renderMarkdown(text) {
    if (!text) return '';

    // Escape HTML first
    let html = escHtml(text);

    // Code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code: `code`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic: *text* (but not inside **)
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

    // Unordered list items: - item
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

    // Ordered list items: 1. item
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    // Wrap consecutive <li> that aren't in <ul> into <ol>
    html = html.replace(/(?<!<\/ul>)(<li>.*<\/li>\n?)+/g, (match) => {
      if (match.includes('<ul>')) return match;
      return `<ol>${match}</ol>`;
    });

    // Headers: ### text
    html = html.replace(/^### (.+)$/gm, '<strong>$1</strong>');
    html = html.replace(/^## (.+)$/gm, '<strong>$1</strong>');

    // Paragraphs: double newline
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Single newlines → <br> (but not inside pre)
    html = html.replace(/<\/p><p>/g, '</p>\n<p>');
    html = html.replace(/(?<!<\/li>)\n(?!<)/g, '<br>');

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>\s*(<(?:ul|ol|pre)>)/g, '$1');
    html = html.replace(/(<\/(?:ul|ol|pre)>)\s*<\/p>/g, '$1');

    return html;
  }

  // ── Bootstrap ─────────────────────────────────────────────

  if (typeof onReady === 'function') {
    onReady(init);
  } else {
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
  }
})();
