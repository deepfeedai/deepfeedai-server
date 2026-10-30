'use strict';
const express = require('express');
// A 500,000-byte decoded import may use six JSON bytes per ASCII character.
// Allow that encoding plus a small envelope, without raising other API limits.
const IMPORT_BODY_LIMIT = 3_010_000;
const paths = new Set(['/api/sources/import', '/api/sources/import-preview', '/api/sources/import-opml', '/api/sources/bulk-add']);
function rssImportBodyParser() {
  const parse = express.json({ limit: IMPORT_BODY_LIMIT });
  return (req, res, next) => {
    const path = req.path.replace(/\/$/, '').toLowerCase();
    if (req.method === 'POST' && paths.has(path)) return parse(req, res, next);
    next();
  };
}
module.exports = { rssImportBodyParser, IMPORT_BODY_LIMIT };
