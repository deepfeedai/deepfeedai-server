/**
 * Cloudflare R2 storage helpers — backward-compatible re-export from storage.js
 */
const storage = require('./storage');

module.exports = {
  get R2_CONFIGURED() { return storage.backendName === 's3'; },
  upload:        storage.upload.bind(storage),
  extFromMime:   storage.extFromMime,
};
