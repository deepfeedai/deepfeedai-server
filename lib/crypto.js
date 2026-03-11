/**
 * AES-256-GCM encryption helpers for sensitive settings values.
 *
 * Encrypted values are stored as: enc:iv:authTag:ciphertext  (all base64)
 * Plaintext values that don't start with "enc:" pass through unchanged
 * (backward-compatible with existing unencrypted rows).
 *
 * Set SETTINGS_ENCRYPTION_KEY in .env to a 64-char hex string (32 bytes).
 * Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX    = 'enc:';

// Keys whose values should be encrypted at rest
const SENSITIVE_KEYS = new Set([
  'elevenlabs_api_key',
  'imagen_api_key',
  'spam_perspective_key',
  'gemini_api_key',
]);

function getKey() {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    console.warn('[crypto] SETTINGS_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Encryption disabled.');
    return null;
  }
  return buf;
}

/**
 * Encrypt a plaintext string.
 * Returns the encrypted token or the original string if no key is configured.
 */
function encryptSetting(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  if (!key) return plaintext; // no key configured — store as-is with a warning

  const iv         = crypto.randomBytes(12);
  const cipher     = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt a stored value.
 * Passes through unchanged if not encrypted (backward-compatible).
 * Returns empty string on decryption failure (key mismatch / corrupted data).
 */
function decryptSetting(stored) {
  if (!stored || !stored.startsWith(PREFIX)) return stored;
  const key = getKey();
  if (!key) {
    console.warn('[crypto] Cannot decrypt: SETTINGS_ENCRYPTION_KEY not set');
    return '';
  }

  try {
    const [, ivB64, authTagB64, dataB64] = stored.split(':');
    const iv        = Buffer.from(ivB64, 'base64');
    const authTag   = Buffer.from(authTagB64, 'base64');
    const encrypted = Buffer.from(dataB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch (err) {
    console.error('[crypto] Decryption failed:', err.message);
    return '';
  }
}

module.exports = { encryptSetting, decryptSetting, SENSITIVE_KEYS };
