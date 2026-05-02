/**
 * N3 story-threads — pure helpers + pitch_type extension.
 *   node --test tests/story-threads.test.js
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { _humanizeTag, VALID_STATUS } = require('../lib/story-threads');
const { PITCH_TYPE_KEYS, normalisePitchType, isValidPitchType } = require('../lib/pitch-types');

// ── _humanizeTag ────────────────────────────────────────────
test('humanizes hyphenated tags into title case', () => {
  assert.equal(_humanizeTag('openai-board-crisis'), 'Openai Board Crisis');
  assert.equal(_humanizeTag('us-china-tariffs'), 'Us China Tariffs');
  assert.equal(_humanizeTag('bitcoin-price-rally'), 'Bitcoin Price Rally');
});

test('humanizes single-word tags', () => {
  assert.equal(_humanizeTag('openai'), 'Openai');
});

test('handles empty / null tags', () => {
  assert.equal(_humanizeTag(''), '');
  assert.equal(_humanizeTag(null), '');
  assert.equal(_humanizeTag(undefined), '');
});

test('VALID_STATUS contains the lifecycle states', () => {
  assert.ok(VALID_STATUS.has('active'));
  assert.ok(VALID_STATUS.has('dormant'));
  assert.ok(VALID_STATUS.has('closed'));
  assert.ok(!VALID_STATUS.has('open'));
});

// ── pitch_types: thread_update ──────────────────────────────
test('thread_update is a registered pitch type', () => {
  assert.ok(PITCH_TYPE_KEYS.includes('thread_update'));
  assert.ok(isValidPitchType('thread_update'));
});

test('aliases normalise to thread_update', () => {
  assert.equal(normalisePitchType('threadupdate'), 'thread_update');
  assert.equal(normalisePitchType('thread'), 'thread_update');
  assert.equal(normalisePitchType('update'), 'thread_update');
  assert.equal(normalisePitchType('Thread Update'), 'thread_update');
});

test('original / follow_up unchanged by N3', () => {
  assert.equal(normalisePitchType('original'), 'original');
  assert.equal(normalisePitchType('follow_up'), 'follow_up');
  assert.equal(normalisePitchType('followup'), 'follow_up');
});
