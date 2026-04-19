/**
 * Browser-side mirror of lib/pitch-types.js — kept small and static so it
 * can be loaded by any admin page without round-tripping to the API.
 *
 * Keep this list in sync with lib/pitch-types.js. If the two drift the
 * server is authoritative (applyProposal normalises on write).
 */
(function () {
  'use strict';

  window.PITCH_TYPES = [
    { key: 'original',         label: 'Original',         icon: '📝' },
    { key: 'follow_up',        label: 'Follow-up',        icon: '↻'  },
    { key: 'roundup',          label: 'Roundup',          icon: '🧺' },
    { key: 'deep_dive',        label: 'Deep dive',        icon: '🔍' },
    { key: 'explainer',        label: 'Explainer',        icon: '💡' },
    { key: 'counter_angle',    label: 'Counter-angle',    icon: '⚖'  },
    { key: 'prediction_check', label: 'Prediction check', icon: '🎯' },
    { key: 'analysis',         label: 'Analysis',         icon: '📊' },
    { key: 'breaking',         label: 'Breaking',         icon: '⚡' },
  ];
  window.PITCH_TYPE_MAP = Object.fromEntries(window.PITCH_TYPES.map(function (t) { return [t.key, t]; }));

  window.renderPitchTypeBadge = function (key) {
    var t = window.PITCH_TYPE_MAP[key] || window.PITCH_TYPE_MAP.original;
    return '<span class="pitch-type-badge" data-pitch-type="' + t.key + '">'
      + '<span class="pitch-type-badge-icon">' + t.icon + '</span>'
      + '<span class="pitch-type-badge-label">' + t.label + '</span>'
      + '</span>';
  };

  window.renderPitchTypeSelect = function (selected, extraClass) {
    var cur = window.PITCH_TYPE_MAP[selected] ? selected : 'original';
    var opts = window.PITCH_TYPES.map(function (t) {
      return '<option value="' + t.key + '"' + (t.key === cur ? ' selected' : '') + '>'
        + t.icon + ' ' + t.label + '</option>';
    }).join('');
    return '<select class="pitch-type-select' + (extraClass ? ' ' + extraClass : '') + '">' + opts + '</select>';
  };
})();
