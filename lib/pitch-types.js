/**
 * Deep Feed AI — Pitch type taxonomy.
 *
 * Canonical list of pitch types used by BOTH article_pitches (editor /
 * Maxwell-commissioned) and story_pitches (writer-generated). Keeping
 * the vocabulary consistent lets filters, badges, orphan groupings,
 * briefs, and synthesis prompts share the same labels + source-count
 * expectations.
 */
'use strict';

const PITCH_TYPES = [
  { key: 'original',         label: 'Original',         icon: '📝', min_sources: 1, hint: 'Fresh reporting, single angle.' },
  { key: 'follow_up',        label: 'Follow-up',        icon: '↻',  min_sources: 1, hint: 'Continuation of a prior story you own.' },
  { key: 'thread_update',    label: 'Thread update',    icon: '🧵', min_sources: 1, hint: 'Editor-commissioned update to an active story thread (auto-links to the thread\'s prior coverage).' },
  { key: 'roundup',          label: 'Roundup',          icon: '🧺', min_sources: 3, hint: 'A "what happened this week in X" piece spanning 3+ sources.' },
  { key: 'deep_dive',        label: 'Deep dive',        icon: '🔍', min_sources: 2, hint: 'Extended feature connecting 2-4 sources into a broader argument.' },
  { key: 'explainer',        label: 'Explainer',        icon: '💡', min_sources: 1, hint: 'Backgrounder on a topic. Educational tone.' },
  { key: 'counter_angle',    label: 'Counter-angle',    icon: '⚖',  min_sources: 1, hint: 'Alternative take on a source already covered by another writer.' },
  { key: 'prediction_check', label: 'Prediction check', icon: '🎯', min_sources: 1, hint: 'Testing a prior forecast — validated or invalidated?' },
  { key: 'analysis',         label: 'Analysis',         icon: '📊', min_sources: 1, hint: 'Opinion / editorial framing on a news event.' },
  { key: 'breaking',         label: 'Breaking',         icon: '⚡', min_sources: 1, hint: 'Urgent, short-turnaround coverage.' },
];

const PITCH_TYPE_KEYS = PITCH_TYPES.map(t => t.key);
const PITCH_TYPE_MAP  = Object.fromEntries(PITCH_TYPES.map(t => [t.key, t]));

function isValidPitchType(k) { return !!(k && PITCH_TYPE_MAP[String(k)]); }

/**
 * Coerce an arbitrary string to a valid type, falling back to 'original'.
 * Accepts common aliases ('new_story' → 'original', 'followup' → 'follow_up', etc.).
 */
function normalisePitchType(k) {
  if (!k) return 'original';
  const s = String(k).toLowerCase().trim().replace(/[-\s]+/g, '_');
  const aliases = {
    new_story:       'original',
    newstory:        'original',
    new:             'original',
    followup:        'follow_up',
    follow:          'follow_up',
    threadupdate:    'thread_update',
    thread:          'thread_update',
    update:          'thread_update',
    deepdive:        'deep_dive',
    deep:            'deep_dive',
    counterangle:    'counter_angle',
    counter:         'counter_angle',
    predictioncheck: 'prediction_check',
    prediction:      'prediction_check',
  };
  if (aliases[s]) return aliases[s];
  return PITCH_TYPE_MAP[s] ? s : 'original';
}

module.exports = { PITCH_TYPES, PITCH_TYPE_KEYS, PITCH_TYPE_MAP, isValidPitchType, normalisePitchType };
