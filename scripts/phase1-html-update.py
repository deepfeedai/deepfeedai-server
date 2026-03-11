#!/usr/bin/env python3
"""
Phase 1 HTML updater:
- Replaces emoji nav icons with Heroicons SVGs in all HTML files
- Extracts common inline styles to CSS classes
"""

import re
import os

PUBLIC = os.path.join(os.path.dirname(__file__), '..', 'public')

# ── SVG icon definitions ──────────────────────────────────────────────────────
ICON_DASHBOARD = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>'

ICON_ARTICLES = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>'

ICON_SOURCES = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12.75 19.5v-.75a7.5 7.5 0 00-7.5-7.5H4.5m0-6.75h.75c7.87 0 14.25 6.38 14.25 14.25v.75M6 18.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" /></svg>'

ICON_VOICES = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" /></svg>'

ICON_COMMENTS = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>'

ICON_SETTINGS = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>'

ICON_LOGOUT = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" /></svg>'


def replace_nav_icons(html: str) -> str:
    """Replace <span class="icon">emoji</span> in nav links with SVGs."""
    replacements = [
        ('<span class="icon">📊</span>', ICON_DASHBOARD),
        ('<span class="icon">📰</span>', ICON_ARTICLES),
        ('<span class="icon">📡</span>', ICON_SOURCES),
        ('<span class="icon">🎙️</span>', ICON_VOICES),
        ('<span class="icon">💬</span>', ICON_COMMENTS),
        ('<span class="icon">⚙️</span>', ICON_SETTINGS),
        ('<span class="icon">🚪</span>', ICON_LOGOUT),
    ]
    for old, new in replacements:
        html = html.replace(old, new)
    return html


def update_topbar_user(html: str) -> str:
    """Replace inline-styled topbar user span with class."""
    return html.replace(
        '<span id="topbarUser" style="color:var(--muted);font-size:13px;"></span>',
        '<span id="topbarUser" class="topbar-user"></span>'
    )


def update_index(html: str) -> str:
    """index.html specific inline style removals."""
    # stat-grid overrides — use stat-grid-sm class
    html = html.replace(
        'class="stat-grid" id="statGrid" style="grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));"',
        'class="stat-grid stat-grid-sm" id="statGrid"'
    )
    html = html.replace(
        'class="stat-grid" style="grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 28px;"',
        'class="stat-grid stat-grid-sm mb-7"'
    )
    # Two community stat-grids
    html = re.sub(
        r'class="stat-grid" style="grid-template-columns: repeat\(auto-fit, minmax\(160px, 1fr\)\); margin-bottom: 28px;"',
        'class="stat-grid stat-grid-sm mb-7"',
        html
    )
    # Recent articles section header margin
    html = html.replace(
        'class="section-header" style="margin-top:28px;"',
        'class="section-header mt-8"'
    )
    return html


def update_articles(html: str) -> str:
    """articles.html specific inline style removals."""
    # Section header inner btn group
    html = html.replace(
        '<div style="display:flex;gap:8px;align-items:center;">',
        '<div class="btn-group">'
    )
    # show-archived label
    html = html.replace(
        '<label id="showArchivedWrap" style="font-size:13px;color:var(--muted);display:flex;align-items:center;gap:6px;cursor:pointer;">',
        '<label id="showArchivedWrap" class="text-sm text-muted" style="display:flex;align-items:center;gap:6px;cursor:pointer;">'
    )
    # Image preview modal
    html = html.replace(
        '<div class="modal" style="max-width:780px;background:var(--bg);">',
        '<div class="modal modal-xl modal-dark">'
    )
    html = html.replace(
        '<div class="modal-body" style="padding:0;">',
        '<div class="modal-body modal-body-flush">'
    )
    html = html.replace(
        '<img id="imgPreviewEl" src="" alt="Article image preview"\n        style="width:100%;border-radius:0 0 0 0;display:block;max-height:460px;object-fit:contain;background:#000;" />',
        '<img id="imgPreviewEl" src="" alt="Article image preview" class="article-img-preview" />'
    )
    html = html.replace(
        '<div class="modal-footer" style="justify-content:flex-end;">',
        '<div class="modal-footer">'
    )
    # Article modal form toggles
    html = html.replace(
        '<div style="display:flex;gap:24px;margin-top:8px;">',
        '<div class="form-toggles">'
    )
    # Delete / purge / voice-picker modals
    html = html.replace(
        '<div class="modal" style="max-width:420px;">\n    <div class="modal-header">\n      <div class="modal-title">Archive Article</div>',
        '<div class="modal modal-sm">\n    <div class="modal-header">\n      <div class="modal-title">Archive Article</div>'
    )
    html = html.replace(
        '<div class="modal" style="max-width:420px;">\n    <div class="modal-header">\n      <div class="modal-title">Permanently Delete</div>',
        '<div class="modal modal-sm">\n    <div class="modal-header">\n      <div class="modal-title">Permanently Delete</div>'
    )
    html = html.replace(
        '<div class="modal" style="max-width:480px;">',
        '<div class="modal modal-md">'
    )
    # Modal body text colours
    html = html.replace(
        '<p style="color:var(--muted);">This article will be archived',
        '<p class="text-muted">This article will be archived'
    )
    html = html.replace(
        '<p style="color:var(--muted);margin-top:8px;">You can restore',
        '<p class="text-muted mt-2">You can restore'
    )
    html = html.replace(
        '<p style="color:var(--muted);">This will <strong style="color:#f87171;">permanently delete</strong>',
        '<p class="text-muted">This will <strong class="text-danger">permanently delete</strong>'
    )
    html = html.replace(
        '<p style="color:var(--muted);margin-bottom:16px;">Select a voice',
        '<p class="text-muted mb-4">Select a voice'
    )
    html = html.replace(
        '<div id="voicePickerList" style="display:flex;flex-direction:column;gap:10px;"></div>',
        '<div id="voicePickerList" class="voice-picker-list"></div>'
    )
    # th width
    html = html.replace(
        '<th style="width:60px;">Image</th>',
        '<th class="th-img">Image</th>'
    )
    # Loading td
    html = html.replace(
        '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted);">\n              <span class="spinner"></span>\n            </td></tr>',
        '<tr><td colspan="9" class="td-loading"><span class="spinner"></span></td></tr>'
    )
    return html


def update_sources(html: str) -> str:
    """sources.html specific inline style removals."""
    # Section header btn group
    html = html.replace(
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">',
        '<div class="btn-group">'
    )
    # Loading td
    html = html.replace(
        '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted);">\n              <span class="spinner"></span>\n            </td></tr>',
        '<tr><td colspan="7" class="td-loading"><span class="spinner"></span></td></tr>'
    )
    # Suggested feeds modal
    html = html.replace(
        '<div class="modal" style="max-width:640px;">',
        '<div class="modal modal-lg">'
    )
    html = html.replace(
        '<div class="modal-body" style="padding:0;">\n      <div id="suggestedList" style="max-height:460px;overflow-y:auto;"></div>',
        '<div class="modal-body modal-body-flush">\n      <div id="suggestedList" class="suggested-list"></div>'
    )
    # Delete source modal
    html = html.replace(
        '<div class="modal" style="max-width:400px;">\n    <div class="modal-header">\n      <div class="modal-title">Delete Source</div>',
        '<div class="modal modal-sm">\n    <div class="modal-header">\n      <div class="modal-title">Delete Source</div>'
    )
    html = html.replace(
        '<p style="color:var(--muted);">Are you sure you want to delete this source?',
        '<p class="text-muted">Are you sure you want to delete this source?'
    )
    # Form toggles
    html = html.replace(
        '<div style="display:flex;gap:24px;margin-top:12px;flex-wrap:wrap;">',
        '<div class="form-toggles mt-3">'
    )
    # maxPublishGroup — only remove the static margin-top, keep display:none for JS
    html = html.replace(
        '<div class="form-group" id="maxPublishGroup" style="margin-top:12px;display:none;">',
        '<div class="form-group mt-3" id="maxPublishGroup" style="display:none;">'
    )
    # narrow input
    html = html.replace(
        '<input class="form-control" type="number" id="fSAutoPublishMax" min="1" max="50" value="5" style="max-width:120px;" />',
        '<input class="form-control input-narrow" type="number" id="fSAutoPublishMax" min="1" max="50" value="5" />'
    )
    # form help small
    html = html.replace(
        '<small style="color:var(--muted);font-size:12px;display:block;margin-top:4px;">',
        '<small class="form-help">'
    )
    return html


def update_voices(html: str) -> str:
    """voices.html specific inline style removals."""
    # Voice Test Studio card
    html = html.replace(
        '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:24px;">',
        '<div class="voice-studio">'
    )
    html = html.replace(
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">',
        '<div class="voice-studio-header">'
    )
    html = html.replace(
        '<span style="font-size:16px;">🎙️</span>',
        '<span class="voice-studio-icon">🎙️</span>'
    )
    html = html.replace(
        '<div style="font-weight:600;font-size:15px;">Voice Test Studio</div>',
        '<div class="voice-studio-title">Voice Test Studio</div>'
    )
    html = html.replace(
        '<p style="color:var(--muted);font-size:13px;margin-bottom:16px;">Audition any voice with custom sample text before publishing.</p>',
        '<p class="voice-studio-desc">Audition any voice with custom sample text before publishing.</p>'
    )
    html = html.replace(
        '<div style="display:flex;flex-direction:column;gap:12px;">',
        '<div class="voice-studio-body">'
    )
    html = html.replace(
        '<div style="text-align:right;font-size:11px;color:var(--muted);margin-top:4px;"><span id="studioCharCount">0</span> / 500</div>',
        '<div class="voice-studio-char-count"><span id="studioCharCount">0</span> / 500</div>'
    )
    html = html.replace(
        '<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">',
        '<div class="voice-studio-controls">'
    )
    html = html.replace(
        '<div style="flex:1;min-width:160px;">',
        '<div class="voice-studio-select-wrap">'
    )
    # Player wrap
    html = html.replace(
        '<div id="studioPlayerWrap" style="display:none;margin-top:4px;">',
        '<div id="studioPlayerWrap" class="voice-player-wrap" style="display:none;">'
    )
    html = html.replace(
        '<div style="display:flex;align-items:center;gap:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">',
        '<div class="voice-player">'
    )
    html = html.replace(
        '<div id="studioVoiceInfo" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">',
        '<div id="studioVoiceInfo" class="voice-player-info">'
    )
    html = html.replace(
        '<div id="studioAvatar" style="width:36px;height:36px;border-radius:50%;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🎙️</div>',
        '<div id="studioAvatar" class="voice-player-avatar">🎙️</div>'
    )
    html = html.replace(
        '<div id="studioVoiceName" style="font-weight:600;font-size:13px;"></div>',
        '<div id="studioVoiceName" class="voice-player-name"></div>'
    )
    html = html.replace(
        '<div style="font-size:11px;color:var(--muted);">Test playback</div>',
        '<div class="voice-player-label">Test playback</div>'
    )
    html = html.replace(
        '<div id="studioStatus" style="font-size:12px;color:var(--accent);">⏳ Generating…</div>',
        '<div id="studioStatus" class="voice-player-status">⏳ Generating…</div>'
    )
    # Table header widths
    html = html.replace(
        '<th style="width:56px;">Avatar</th>',
        '<th class="th-avatar">Avatar</th>'
    )
    html = html.replace(
        '<th style="width:80px;text-align:center;">Default</th>',
        '<th class="th-center-sm">Default</th>'
    )
    html = html.replace(
        '<th style="width:120px;">Actions</th>',
        '<th class="th-actions">Actions</th>'
    )
    # Loading td
    html = html.replace(
        '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted);">\n              <span class="spinner"></span>\n            </td></tr>',
        '<tr><td colspan="6" class="td-loading"><span class="spinner"></span></td></tr>'
    )
    # Voice modal size
    html = html.replace(
        '<div class="modal" style="max-width:520px;">',
        '<div class="modal modal-md">'
    )
    # Required asterisks in voice modal
    html = html.replace(
        '<span style="color:#f87171;">*</span>',
        '<span class="required">*</span>'
    )
    # Avatar preview
    html = html.replace(
        '<div id="avatarPreviewWrap" style="margin-top:10px;display:none;">',
        '<div id="avatarPreviewWrap" class="mt-2" style="display:none;">'
    )
    html = html.replace(
        '<img id="avatarPreview" src="" alt="Avatar preview"\n               style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--border);" />',
        '<img id="avatarPreview" src="" alt="Avatar preview" class="avatar-preview-img" />'
    )
    # Default checkbox form group
    html = html.replace(
        '<div class="form-group" style="display:flex;align-items:center;gap:8px;">',
        '<div class="form-check">'
    )
    html = html.replace(
        '<label for="fVoiceDefault" class="form-label" style="margin:0;cursor:pointer;">Set as Default voice</label>',
        '<label for="fVoiceDefault" class="form-check-label">Set as Default voice</label>'
    )
    # Preview status
    html = html.replace(
        '<span id="previewStatus" style="font-size:12px;color:var(--muted);margin-left:10px;"></span>',
        '<span id="previewStatus" class="text-sm text-muted" style="margin-left:10px;"></span>'
    )
    # Delete voice modal muted text
    html = html.replace(
        '<p style="color:var(--muted);">Are you sure you want to delete',
        '<p class="text-muted">Are you sure you want to delete'
    )
    html = html.replace(
        '<p id="deleteVoiceWarn" style="color:#f87171;display:none;">',
        '<p id="deleteVoiceWarn" class="text-danger" style="display:none;">'
    )
    return html


def update_comments(html: str) -> str:
    """comments.html specific inline style removals."""
    # Loading td
    html = html.replace(
        '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px;">\n            <span class="spinner"></span>\n          </td></tr>',
        '<tr><td colspan="6" class="td-loading"><span class="spinner"></span></td></tr>'
    )
    # Slug filter input
    html = html.replace(
        '<input type="text" id="slugFilter" class="input" placeholder="Filter by slug…"\n               style="width:200px;height:32px;font-size:13px;" />',
        '<input type="text" id="slugFilter" class="form-control filter-slug-input" placeholder="Filter by slug…" />'
    )
    return html


def update_settings(html: str) -> str:
    """settings.html specific inline style removals."""
    # ElevenLabs card
    html = html.replace(
        '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:600px;margin-bottom:20px;">',
        '<div class="settings-card">'
    )
    # Image generation card (same pattern, second occurrence)
    html = html.replace(
        '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:600px;">',
        '<div class="settings-card">'
    )
    # Content Lifecycle card
    html = html.replace(
        '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:600px;margin-top:20px;">',
        '<div class="settings-card mt-5">'
    )
    # Card headers
    html = html.replace(
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">',
        '<div class="settings-card-header">'
    )
    # Card icons
    html = html.replace('<div style="font-size:28px;">🎙️</div>', '<div class="settings-card-icon">🎙️</div>')
    html = html.replace('<div style="font-size:28px;">🎨</div>', '<div class="settings-card-icon">🎨</div>')
    html = html.replace('<div style="font-size:28px;">🗑️</div>', '<div class="settings-card-icon">🗑️</div>')
    # Card titles
    html = html.replace(
        '<div style="font-weight:700;font-size:16px;">ElevenLabs</div>',
        '<div class="settings-card-title">ElevenLabs</div>'
    )
    html = html.replace(
        '<div style="font-weight:700;font-size:16px;">Image Generation</div>',
        '<div class="settings-card-title">Image Generation</div>'
    )
    html = html.replace(
        '<div style="font-weight:700;font-size:16px;">Content Lifecycle</div>',
        '<div class="settings-card-title">Content Lifecycle</div>'
    )
    # Card subtitles
    html = html.replace(
        '<div style="font-size:13px;color:var(--muted);">Text-to-speech for AI audio summaries</div>',
        '<div class="settings-card-subtitle">Text-to-speech for AI audio summaries</div>'
    )
    html = html.replace(
        '<div style="font-size:13px;color:var(--muted);">Google Imagen / Gemini for AI article thumbnails</div>',
        '<div class="settings-card-subtitle">Google Imagen / Gemini for AI article thumbnails</div>'
    )
    html = html.replace(
        '<div style="font-size:13px;color:var(--muted);">Auto-archive old articles to keep the feed fresh</div>',
        '<div class="settings-card-subtitle">Auto-archive old articles to keep the feed fresh</div>'
    )
    # API key input rows
    html = html.replace(
        '<div style="display:flex;gap:8px;align-items:center;">\n            <input type="password" class="form-control" id="elApiKey"',
        '<div class="input-action-row">\n            <input type="password" class="form-control" id="elApiKey"'
    )
    html = html.replace(
        'style="flex:1;" autocomplete="off" />',
        'autocomplete="off" />'
    )
    html = html.replace(
        '<div style="display:flex;gap:8px;align-items:center;">\n            <input type="password" class="form-control" id="imagenApiKey"',
        '<div class="input-action-row">\n            <input type="password" class="form-control" id="imagenApiKey"'
    )
    html = html.replace(
        'style="flex:1;" autocomplete="off" />',
        'autocomplete="off" />'
    )
    # Help paragraphs
    html = re.sub(
        r'<p style="font-size:12px;color:var\(--muted\);margin-top:8px;line-height:1\.5;">',
        '<p class="form-help">',
        html
    )
    # API key status divs
    html = html.replace(
        '<div id="apiKeyStatus" style="font-size:12px;color:var(--muted);margin-bottom:12px;"></div>',
        '<div id="apiKeyStatus" class="settings-status"></div>'
    )
    html = html.replace(
        '<div id="imagenKeyStatus" style="font-size:12px;color:var(--muted);margin-bottom:12px;"></div>',
        '<div id="imagenKeyStatus" class="settings-status"></div>'
    )
    # imagen select width
    html = html.replace(
        '<select class="form-control" id="imagenModel" style="max-width:400px;">',
        '<select class="form-control input-wide" id="imagenModel">'
    )
    # Purge toggle label
    html = html.replace(
        '<label class="form-label" style="display:flex;align-items:center;gap:10px;">',
        '<label class="form-check">'
    )
    # Purge days row
    html = html.replace(
        '<div class="form-row" style="margin-top:12px;">',
        '<div class="form-row mt-3">'
    )
    html = html.replace(
        '<div style="display:flex;align-items:center;gap:8px;">',
        '<div class="input-row">'
    )
    html = html.replace(
        '<span style="color:var(--muted);font-size:13px;">days (minimum 7)</span>',
        '<span class="text-muted text-sm">days (minimum 7)</span>'
    )
    # Protection rules toggle list
    html = html.replace(
        '<div class="form-group" style="margin-top:12px;">',
        '<div class="form-group mt-3">'
    )
    html = html.replace(
        '<div style="display:flex;flex-direction:column;gap:10px;margin-top:6px;">',
        '<div class="toggle-list">'
    )
    # Purge buttons row
    html = html.replace(
        '<div style="display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;">',
        '<div class="btn-group mt-5">'
    )
    html = html.replace(
        '<div id="purgeSettingsStatus" style="font-size:12px;color:var(--muted);margin-top:10px;"></div>',
        '<div id="purgeSettingsStatus" class="settings-status"></div>'
    )
    # Spam Detection section title
    html = html.replace(
        '<div class="section-title" style="margin-top:32px;">🛡️ Spam Detection</div>',
        '<div class="settings-section-title">🛡️ Spam Detection</div>'
    )
    # Spam detection dash-panel margin
    html = html.replace(
        '<div class="dash-panel" style="margin-bottom:24px;">\n        <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">',
        '<div class="dash-panel mb-6">\n        <p class="text-muted text-sm mb-4">'
    )
    # Perspective API key row
    html = html.replace(
        '<div style="margin-top:10px;display:flex;align-items:center;gap:8px;">',
        '<div class="input-action-row mt-3">'
    )
    html = html.replace(
        '<input type="password" class="form-control" id="perspectiveKey"\n                   placeholder="AIza…" style="flex:1;font-family:monospace;" />',
        '<input type="password" class="form-control input-mono" id="perspectiveKey" placeholder="AIza…" />'
    )
    # Spam help text
    html = re.sub(
        r'<p style="color:var\(--muted\);font-size:12px;margin-top:4px;">',
        '<p class="form-help">',
        html
    )
    # Threshold grid
    html = html.replace(
        '<div class="form-group" style="margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:16px;">',
        '<div class="form-grid-2">'
    )
    # Threshold input rows
    html = re.sub(
        r'<div style="display:flex;align-items:center;gap:8px;margin-top:6px;">',
        '<div class="input-row">',
        html
    )
    # Number inputs
    html = re.sub(
        r'(<input type="number" class="form-control" id="spamBlockThreshold"[^/]*)style="width:80px;" />',
        r'\1class="input-number-sm" />',
        html
    )
    html = re.sub(
        r'(<input type="number" class="form-control" id="spamQueueThreshold"[^/]*)style="width:80px;" />',
        r'\1class="input-number-sm" />',
        html
    )
    # Threshold helper spans
    html = re.sub(
        r'<span style="color:var\(--muted\);font-size:12px;">0\.0 – 1\.0</span>',
        '<span class="text-sm text-muted">0.0 – 1.0</span>',
        html
    )
    # Spam save buttons row
    html = html.replace(
        '<div style="display:flex;gap:10px;margin-top:20px;">\n          <button class="btn btn-primary" id="saveSpamSettingsBtn">Save Settings</button>',
        '<div class="btn-group mt-5">\n          <button class="btn btn-primary" id="saveSpamSettingsBtn">Save Settings</button>'
    )
    html = html.replace(
        '<div id="spamSettingsStatus" style="font-size:12px;color:var(--muted);margin-top:10px;"></div>',
        '<div id="spamSettingsStatus" class="settings-status"></div>'
    )
    # Mod Queue section title
    html = html.replace(
        '<div class="section-title" style="margin-top:32px;">💬 Comment Moderation Queue</div>',
        '<div class="settings-section-title">💬 Comment Moderation Queue</div>'
    )
    # Mod queue panel
    html = html.replace(
        '<div class="dash-panel" style="margin-bottom:24px;">\n        <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">\n          Hold new users',
        '<div class="dash-panel mb-6">\n        <p class="text-muted text-sm mb-4">\n          Hold new users'
    )
    # Mod queue threshold input row
    html = html.replace(
        '<div style="display:flex;align-items:center;gap:10px;margin-top:6px;">',
        '<div class="input-row">'
    )
    html = html.replace(
        '<span style="color:var(--muted);font-size:13px;">approved comment(s)</span>',
        '<span class="text-muted text-sm">approved comment(s)</span>'
    )
    # Mod queue buttons
    html = html.replace(
        '<div style="display:flex;gap:10px;margin-top:20px;">\n          <button class="btn btn-primary" id="saveModQueueBtn">Save Settings</button>',
        '<div class="btn-group mt-5">\n          <button class="btn btn-primary" id="saveModQueueBtn">Save Settings</button>'
    )
    html = html.replace(
        '<div id="modQueueStatus" style="font-size:12px;color:var(--muted);margin-top:10px;"></div>',
        '<div id="modQueueStatus" class="settings-status"></div>'
    )
    return html


def update_login(html: str) -> str:
    """login.html specific inline style removals."""
    html = html.replace(
        '<div class="form-group" style="margin-bottom: 24px;">',
        '<div class="form-group mb-6">'
    )
    return html


def process_file(name: str, extra_fn=None):
    path = os.path.join(PUBLIC, name)
    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()

    html = replace_nav_icons(html)
    html = update_topbar_user(html)

    if extra_fn:
        html = extra_fn(html)

    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f'✓ {name}')


if __name__ == '__main__':
    process_file('index.html',    update_index)
    process_file('articles.html', update_articles)
    process_file('sources.html',  update_sources)
    process_file('voices.html',   update_voices)
    process_file('comments.html', update_comments)
    process_file('settings.html', update_settings)
    process_file('login.html',    update_login)
    print('\nAll files updated.')
