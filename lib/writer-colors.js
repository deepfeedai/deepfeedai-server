/**
 * Deep Feed AI — writer accent color resolver.
 *
 * Writers can set an explicit accent_color via admin UI. When null, we hash the
 * writer id into a 12-hue palette of pleasant, theme-neutral colors so every
 * writer gets a stable, distinguishable bubble tint in the newsroom chat.
 */
'use strict';

const PALETTE = [
  '#8b5cf6', // violet
  '#3b82f6', // blue
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#22c55e', // green
  '#eab308', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#ec4899', // pink
  '#a855f7', // purple
  '#14b8a6', // teal
  '#6366f1', // indigo
];

function paletteFor(writerId) {
  const n = Number(writerId);
  if (!Number.isFinite(n)) return PALETTE[0];
  // simple stable hash — just writerId mod palette length is fine given the
  // palette is already visually distinct; no collisions within small tenants.
  const idx = ((n % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[idx];
}

function resolveAccent(writer) {
  if (!writer) return PALETTE[0];
  const explicit = (writer.accent_color || '').trim();
  if (explicit) return explicit;
  return paletteFor(writer.id);
}

module.exports = { resolveAccent, PALETTE };
