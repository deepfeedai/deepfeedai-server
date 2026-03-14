/**
 * Cloudflare R2 storage helpers.
 * Shared by avatar uploads (voices) and branding assets (settings).
 */
const fs   = require('fs');
const path = require('path');

const R2_CONFIGURED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME
);

function getR2Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region:   'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function extFromMime(mimeType) {
  if (mimeType === 'image/png')  return 'png';
  if (mimeType === 'image/gif')  return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/svg+xml') return 'svg';
  return 'jpg';
}

/**
 * Upload a buffer to R2 (or local fallback).
 * @param {Buffer} buf
 * @param {string} mimeType
 * @param {string} r2Key       e.g. "avatars/voice-3.png" or "branding/site-logo.png"
 * @param {string} localDir    local fallback directory (absolute)
 * @param {string} localName   local fallback filename
 * @returns {Promise<string>}  public URL
 */
async function upload(buf, mimeType, r2Key, localDir, localName) {
  if (R2_CONFIGURED) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = getR2Client();
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         r2Key,
      Body:        buf,
      ContentType: mimeType,
    }));
    const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    return `${publicUrl}/${r2Key}`;
  }
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, localName), buf);
  return `/media/${localName}`;
}

module.exports = { R2_CONFIGURED, getR2Client, extFromMime, upload };
