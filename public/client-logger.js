/**
 * Deep Feed AI — Client Logger
 * Captures JS errors, API failures, and slow requests.
 * Batches events and sends to POST /api/client-logs.
 *
 * Config (set before this script loads):
 *   window.DFAClientLogger = { source: 'portal' }
 *   - source: 'web' | 'portal' | 'platform'
 *   - endpoint: override API base URL (default: auto-detect)
 */
(function() {
  'use strict';

  var config = window.DFAClientLogger || {};
  var source = config.source || 'web';
  var baseUrl = config.endpoint
    || (window.DFAConfig && window.DFAConfig.ADMIN_BASE)
    || '';
  var endpoint = baseUrl + '/api/analytics/client-logs';

  var queue = [];
  var recentMessages = {}; // msg → timestamp (dedup within 10s)
  var FLUSH_INTERVAL = 5000;
  var MAX_BATCH = 10;
  var DEDUP_WINDOW = 10000;
  var flushTimer = null;

  function queueLog(level, message, extra) {
    if (!message) return;
    message = String(message).slice(0, 2000);

    // Deduplicate: skip if same message within 10s
    var now = Date.now();
    if (recentMessages[message] && now - recentMessages[message] < DEDUP_WINDOW) return;
    recentMessages[message] = now;

    queue.push({
      level: level,
      message: message,
      source: source,
      url: location.href,
      stack: extra && extra.stack ? String(extra.stack).slice(0, 4000) : null,
      extra: extra ? (function() { var o = {}; for (var k in extra) { if (k !== 'stack' && extra.hasOwnProperty(k)) o[k] = extra[k]; } return Object.keys(o).length ? o : null; })() : null,
    });

    if (queue.length >= MAX_BATCH) flush();
    else startTimer();
  }

  function startTimer() {
    if (flushTimer) return;
    flushTimer = setTimeout(function() { flushTimer = null; flush(); }, FLUSH_INTERVAL);
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!queue.length) return;

    var batch = queue.splice(0, 20);
    var body = JSON.stringify({ events: batch });

    try {
      // Use sendBeacon if available and during unload, otherwise fetch
      if (navigator.sendBeacon && document.visibilityState === 'hidden') {
        navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', endpoint, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(body);
      }
    } catch (e) {
      // Logging must never break the app
    }
  }

  // Prune dedup map every 30s
  setInterval(function() {
    var now = Date.now();
    for (var k in recentMessages) {
      if (now - recentMessages[k] > DEDUP_WINDOW) delete recentMessages[k];
    }
  }, 30000);

  // ── Error capture ──────────────────────────────────────

  // Uncaught JS errors
  var _prevOnError = window.onerror;
  window.onerror = function(msg, url, line, col, err) {
    queueLog('error', msg, {
      stack: err ? err.stack : null,
      line: line,
      col: col,
      file: url,
    });
    if (_prevOnError) return _prevOnError.apply(this, arguments);
  };

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', function(e) {
    var reason = e.reason;
    var msg = reason instanceof Error ? reason.message : String(reason || 'Unhandled rejection');
    queueLog('error', msg, {
      stack: reason instanceof Error ? reason.stack : null,
      type: 'unhandledrejection',
    });
  });

  // ── Fetch monkey-patch ─────────────────────────────────

  if (window.fetch) {
    var _origFetch = window.fetch;
    window.fetch = function(input, init) {
      var url;
      try { url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input)); } catch (e) { url = ''; }
      var method = (init && init.method) || 'GET';

      // Skip logging our own client-logs endpoint to avoid recursion
      if (url.indexOf('/client-logs') !== -1) return _origFetch.apply(this, arguments);

      var start = Date.now();
      return _origFetch.apply(this, arguments).then(function(res) {
        var ms = Date.now() - start;
        var path = url;
        try { path = new URL(url, location.origin).pathname; } catch (e) {}

        // Log 5xx server errors
        if (res.status >= 500) {
          queueLog('error', 'API ' + res.status + ': ' + method + ' ' + path, {
            statusCode: res.status,
            durationMs: ms,
          });
        }
        // Log slow requests (>3s, skip media/static)
        if (ms > 3000 && path.indexOf('/api/') !== -1) {
          queueLog('warn', 'Slow API: ' + method + ' ' + path + ' (' + ms + 'ms)', {
            durationMs: ms,
          });
        }
        return res;
      }).catch(function(err) {
        var path = url;
        try { path = new URL(url, location.origin).pathname; } catch (e) {}
        queueLog('error', 'Network error: ' + method + ' ' + path, {
          error: err.message,
        });
        throw err;
      });
    };
  }

  // ── Flush on page unload ───────────────────────────────

  window.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);

  // Expose for manual use: window.dfaLog('error', 'Something broke', { detail: 123 })
  window.dfaLog = queueLog;

})();
