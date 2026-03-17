/**
 * Cloudflare R2 storage helpers — backward-compatible re-export from storage.js
 */
const storage = require('./storage');

module.exports = {
  R2_CONFIGURED: storage.backendName === 's3',
  upload:        storage.upload.bind(storage),
  extFromMime:   storage.extFromMime,
};
