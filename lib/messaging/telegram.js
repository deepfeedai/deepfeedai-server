/**
 * Telegram Bot Integration — send/receive messages via Telegram Bot API.
 * Supports 1:1 chats and group topics (forum mode).
 * Setup: create bot via @BotFather, save token in settings as `telegram_bot_token`.
 */
const db = require('../../db');
const { decryptSetting } = require('../crypto');
const { splitMessage } = require('./split');

const TELEGRAM_API = 'https://api.telegram.org/bot';
const TELEGRAM_CHUNK_DELAY = 100;

/**
 * Get the bot token for a tenant (decrypted from settings).
 */
async function getBotToken(tenantId) {
  const row = await db.prepare(
    "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'telegram_bot_token'"
  ).get(tenantId);
  if (!row?.value) return null;
  try {
    return decryptSetting(row.value);
  } catch {
    return row.value; // may be stored unencrypted during setup
  }
}

/**
 * Send a text message to a Telegram chat (optionally to a specific topic thread).
 */
async function sendTelegramMessage(chatId, text, tenantId, threadId) {
  const token = await getBotToken(tenantId);
  if (!token) return;

  const chunks = splitMessage(text, 'telegram');
  let lastResult;

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, TELEGRAM_CHUNK_DELAY));
    const body = { chat_id: chatId, text: chunks[i] };
    if (threadId) body.message_thread_id = parseInt(threadId);

    const response = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      console.error(`[telegram] sendMessage failed (chat: ${chatId}, thread: ${threadId || 'none'}): ${err.slice(0, 300)}`);
      throw new Error(`Telegram API error ${response.status}: ${err.slice(0, 200)}`);
    }
    lastResult = await response.json();
  }

  return lastResult;
}

/**
 * Set up the webhook URL for receiving messages.
 */
async function setWebhook(tenantId, webhookUrl) {
  const token = await getBotToken(tenantId);
  if (!token) throw new Error('No Telegram bot token configured');

  const response = await fetch(`${TELEGRAM_API}${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Telegram setWebhook error ${response.status}: ${err.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Parse an incoming Telegram update and extract the message.
 * Supports private chats and group topics (forum threads).
 */
function parseUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return null;

  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  return {
    chatId: String(msg.chat.id),
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : null,
    text: isGroup ? msg.text.replace(/@\w+/g, '').trim() : msg.text, // strip @mentions in groups
    senderId: String(msg.from?.id || ''),
    senderName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Unknown',
    isGroup,
  };
}

/**
 * Send a voice message to a Telegram chat.
 * Uses Telegram's sendVoice API which renders as a native voice bubble.
 * @param {string} chatId
 * @param {Buffer} audioBuffer - OGG/MP3 audio data
 * @param {string} caption - Optional text caption
 * @param {number} tenantId
 * @param {string} [threadId] - Optional topic thread ID
 */
async function sendTelegramVoice(chatId, audioBuffer, caption, tenantId, threadId) {
  const token = await getBotToken(tenantId);
  if (!token) return;

  // Telegram sendVoice uses multipart/form-data
  const boundary = '----DeepFeedVoice' + Date.now();
  const filename = `voice-${Date.now()}.mp3`;

  const fields = [
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
  ];

  if (threadId) {
    fields.push(`--${boundary}\r\nContent-Disposition: form-data; name="message_thread_id"\r\n\r\n${parseInt(threadId)}\r\n`);
  }

  if (caption) {
    fields.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption.slice(0, 1024)}\r\n`);
  }

  // Voice file part
  fields.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`
  );

  const bodyParts = [
    Buffer.from(fields.join('')),
    audioBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const body = Buffer.concat(bodyParts);

  const response = await fetch(`${TELEGRAM_API}${token}/sendVoice`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    console.error(`[telegram] sendVoice failed (chat: ${chatId}): ${err.slice(0, 300)}`);
  }

  return response.ok;
}

/**
 * Send a text message with an inline keyboard attached.
 * @param {string|number} chatId
 * @param {string} text             - HTML-formatted text (short; single Telegram message)
 * @param {Array<Array<{text:string, callback_data:string}>>} inlineKeyboard
 * @param {number} tenantId
 * @param {Object} [opts]
 * @param {string} [opts.parseMode='HTML']
 * @param {string} [opts.threadId]
 * @param {boolean} [opts.disableWebPagePreview=true]
 */
async function sendActionable(chatId, text, inlineKeyboard, tenantId, opts = {}) {
  const token = await getBotToken(tenantId);
  if (!token) return;

  const body = {
    chat_id: chatId,
    text,
    parse_mode: opts.parseMode || 'HTML',
    disable_web_page_preview: opts.disableWebPagePreview !== false,
  };
  if (Array.isArray(inlineKeyboard) && inlineKeyboard.length) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  if (opts.threadId) body.message_thread_id = parseInt(opts.threadId);

  const response = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => '');
    console.error(`[telegram] sendActionable failed (chat: ${chatId}): ${err.slice(0, 300)}`);
    throw new Error(`Telegram API error ${response.status}: ${err.slice(0, 200)}`);
  }
  return response.json();
}

/**
 * Respond to a callback_query with a short toast notification.
 * Required by Telegram within ~15s of any callback_query or the button spinner hangs.
 */
async function answerCallbackQuery(callbackQueryId, text, tenantId, { showAlert = false } = {}) {
  const token = await getBotToken(tenantId);
  if (!token) return;
  try {
    await fetch(`${TELEGRAM_API}${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: (text || '').slice(0, 200),
        show_alert: !!showAlert,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('[telegram] answerCallbackQuery failed:', err.message);
  }
}

/**
 * Strip the inline keyboard off an existing message (used after a button is burned).
 */
async function editMessageReplyMarkup(chatId, messageId, tenantId, inlineKeyboard = []) {
  const token = await getBotToken(tenantId);
  if (!token) return;
  try {
    await fetch(`${TELEGRAM_API}${token}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('[telegram] editMessageReplyMarkup failed:', err.message);
  }
}

module.exports = {
  sendTelegramMessage,
  sendTelegramVoice,
  sendActionable,
  answerCallbackQuery,
  editMessageReplyMarkup,
  setWebhook,
  parseUpdate,
  getBotToken,
};
