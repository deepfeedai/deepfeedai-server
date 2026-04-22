/**
 * Structural brief definitions per article subtype.
 * Each brief is injected into the synthesis prompt to enforce
 * type-appropriate structure, length, and opening/closing conventions.
 *
 * Subtypes: breaking | followup | analysis | explainer | feature | roundup | opinion
 */

const STRUCTURAL_BRIEFS = {
  breaking: `
ARTICLE TYPE — BREAKING NEWS:
- Lead with the single most critical fact in sentence one (who, what, where, when).
- Inverted pyramid: most important information first, background last.
- No scene-setting, no anecdote open, no "what this means" analysis.
- Short sentences. Tight paragraphs. One idea per paragraph.
- Hedge unconfirmed information: "according to", "sources say", "reported but unconfirmed".
- Do NOT speculate about causes, implications, or next steps.
- Target: 150–300 words. Speed and accuracy over style.`,

  followup: `
ARTICLE TYPE — FOLLOW-UP / DEVELOPING:
- This story already has prior coverage. The reader knows the background.
- Open with WHAT IS NEW or WHAT HAS CHANGED — not a recap of the original.
- Do NOT re-explain what was already reported. Build on it.
- Reference prior reporting naturally: "Since Friday's report...", "New details confirm..."
- Focus exclusively on the delta: new facts, confirmations, corrections, developments.
- Add context only when essential for understanding the new information.
- Target: 250–450 words.`,

  analysis: `
ARTICLE TYPE — ANALYSIS:
- Open with the "so what" — why this matters — not the event itself.
- The nut graf is critical: state explicitly why this is different, why this is happening now.
- Context and history are load-bearing, not filler.
- Include an explicit implications section: what does this mean for readers, for the industry?
- Carry stronger POV than a news piece — you are the analyst.
- Address counterarguments or alternative interpretations.
- Target: 600–1000 words. Substance over length.`,

  explainer: `
ARTICLE TYPE — EXPLAINER:
- Open by plainly naming the thing you are explaining and why it matters now.
- Assume the reader is intelligent but unfamiliar with the specifics.
- Structure: context/background → current state → why it matters → what to watch.
- Each section should answer the logical next question the reader has.
- Define jargon once on first use, then use it naturally.
- Anchor every abstract concept with a concrete example.
- Close with "what to watch" — where does this go from here?
- Target: 500–800 words. Clear and complete beats long.`,

  feature: `
ARTICLE TYPE — NARRATIVE FEATURE:
- Open with a specific scene, person, or moment — never an abstraction, a thesis, or a news lede.
- The nut graf (why this matters now) must appear by paragraph two or three.
- Body: evidence, tension, voices. Show, don't tell.
- Name your characters — describe them. "Industry experts" and "analysts" are not characters.
- Subheadings only where the structure genuinely shifts — not as organizational crutches.
- Address the counterargument or alternative reading head-on, not as a footnote.
- Close by leaving the reader with something to think about — not a summary of what you said.
- Target: 800–2000 words.`,

  roundup: `
ARTICLE TYPE — ROUNDUP / SYNTHESIS:
- Open with a thesis that holds the synthesis together — not a list of what you found.
- Attribution is prominent: name sources, perspectives, and voices explicitly.
- Structure: thesis → perspective A → perspective B → tension or synthesis.
- Where sources disagree, make the disagreement explicit and interesting.
- Do not hide behind "experts say" — name them.
- Close with your synthesis: what does the full picture reveal?
- Target: 400–700 words.`,

  opinion: `
ARTICLE TYPE — OPINION / COMMENTARY:
- State your thesis in the first paragraph. Do not bury it.
- Evidence serves the argument — not the other way around.
- Steel-man the opposing view before dismantling it.
- Write with strong implied or explicit POV — this is a take, not a report.
- Avoid false balance — you have a position, defend it.
- Close with a clear, confident conclusion — your point restated with force.
- Target: 500–900 words.`,
};

/**
 * Return the structural brief string for a given article subtype.
 * Returns empty string if subtype is unknown or not set.
 */
function getStructuralBrief(subtype) {
  return STRUCTURAL_BRIEFS[subtype] || '';
}

module.exports = { getStructuralBrief, STRUCTURAL_BRIEFS };
