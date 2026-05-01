'use strict';

// Exponential backoff with jitter.
// attempt is 1-based (the attempt number that just failed).
const BASE_SECS  = [null,  30,  120,  600, 1800, 3600];
const JITTER_MAX = [null,  15,   30,  120,  300,  600];

/**
 * Returns the Date at which a failed job should next be attempted.
 * @param {number} attempt - 1-based attempt number that just failed
 */
function nextRunAt(attempt) {
  const idx    = Math.min(attempt, BASE_SECS.length - 1);
  const base   = BASE_SECS[idx];
  const jitter = Math.floor(Math.random() * JITTER_MAX[idx]);
  return new Date(Date.now() + (base + jitter) * 1000);
}

module.exports = { nextRunAt };
