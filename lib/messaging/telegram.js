/**
 * Telegram Bot Integration — send/receive messages via Telegram Bot API.
 * Setup: create bot via @BotFather, save token in settings as `telegram_bot_token`.
 */
const db = require('../../db');
const { decryptSetting } = require('../crypto');

const TELEGRAM_API = 'https://api.telegram.org/bot';

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
 * Send a text message to a Telegram chat.
 */
async function sendTelegramMessage(chatId, text, tenantId) {
  const token = await getBotToken(tenantId);
  if (!token) return;

  const response = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Telegram API error ${response.status}: ${err.slice(0, 200)}`);
  }

  return response.json();
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
 */
function parseUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return null;
  return {
    chatId: String(msg.chat.id),
    text: msg.text,
    senderId: String(msg.from?.id || ''),
    senderName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Unknown',
  };
}

module.exports = { sendTelegramMessage, setWebhook, parseUpdate, getBotToken };
