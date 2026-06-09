const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addDaysToDateString,
  localDateTimeToUtc,
  windowKeyForIso,
} = require('../lib/news-budget');

test('addDaysToDateString rolls calendar dates in UTC', () => {
  assert.equal(addDaysToDateString('2026-06-09', 1), '2026-06-10');
  assert.equal(addDaysToDateString('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysToDateString('2026-01-01', -1), '2025-12-31');
});

test('localDateTimeToUtc converts newsroom-local drop windows to UTC', () => {
  assert.equal(localDateTimeToUtc('2026-06-09', '07:00', 'America/Denver').toISOString(), '2026-06-09T13:00:00.000Z');
  assert.equal(localDateTimeToUtc('2026-01-09', '07:00', 'America/Denver').toISOString(), '2026-01-09T14:00:00.000Z');
});

test('windowKeyForIso buckets timestamps in the configured newsroom timezone', () => {
  assert.equal(windowKeyForIso('2026-06-09T13:00:00.000Z', 'America/Denver'), 'Morning');
  assert.equal(windowKeyForIso('2026-06-09T23:30:00.000Z', 'America/Denver'), 'Afternoon');
  assert.equal(windowKeyForIso('2026-06-10T01:30:00.000Z', 'America/Denver'), 'Evening');
  assert.equal(windowKeyForIso(null, 'America/Denver'), 'Unscheduled');
});
