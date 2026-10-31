# Newsroom v2 implementation and acceptance tracker

Base: `2032157045692fda1ac2aa528449004a46a7e501`. Branch: `feature/newsroom-v2`.
Owner: implementation agent with independent architecture, security/OSS, UX and final code review.
Original 2026-10-31 14:00 UTC target was interrupted by a usage limit. Work resumed after explicit user confirmation at approximately 18:00 UTC. Estimate after inventory: 3–5 hours, contingent on regression and review findings; this is not a reduced scope or guaranteed deadline.

## Goal and architecture

One connected editorial journey: discovery → pitch → commission → draft → review → deliberate publication → existing newspaper/newsletter tools. Each item explains its actual stage, blockers, primary action, alternatives and consequences. Generation progress is separate from editorial status. Read operations never generate content or publish it.

Keep existing authoritative `articles`, `story_pitches` and `article_pitches` records. Editor assignments remain the `is_editor_assignment` subtype of article pitches. A typed read projection joins their relationships instead of creating another universal content table or shadow status. The backend derives permission-aware actions; existing mutation services independently enforce prerequisites, concurrency, idempotency and tenant boundaries. Legacy approval/assignment must not hide paid drafting.

## Current routes and integration

- Reader/source selection remains `/reader.html` and existing source picker.
- Existing pitch and assignment editing stays reachable at `/pitches.html`; a new connected workspace exposes queue and item detail without duplicating editors.
- Article editing/review uses `/article-editor.html`; desired publication state and revision safeguards remain authoritative.
- Newspaper editions use `/editions.html`; finalized snapshots and withdrawal protections remain unchanged.
- Newsletter handoff opens the existing newsletter workflow, never sends or suggests paid text on page load.
- Existing specialist synthesis, source management and administration remain reachable.

## Workstream tracker

| Workstream | State | Acceptance evidence / next step |
|---|---|---|
| Inventory and plan | complete | Clean isolated branch from verified current main; existing three pitch concepts mapped |
| Architecture/backend | complete (local) | Canonical projection, shared rules, explicit paid boundary, stale guards, additive schema and connection-safe bridge implemented |
| Workspace UX | complete (local) | 1440/390px browser fixtures passed; fixed mobile pagination and pending-action navigation |
| Navigation/caller integration | complete (local) | 35 focused tests; Reader, pitches, assignment and article editor typed links; final combined tests pending |
| Security/OSS | active | Baseline advisory/license inventory complete; independent implementation review underway |
| Integration and usability tests | active | Eight real-route acceptance subtests prepared; initial 1440/390px browser checks passed, expanded final run pending |
| Independent final review | complete (source) | Architecture/security/quality reviewers verified fixes; final frozen-head execution remains required |
| Draft PR and CI | pending | Logical commits, exact remote head, no merge; inspect triggered checks |
| Backup/candidate/deployment | pending | Consistent backup, isolated restore, runtime/assets/data fingerprints and rollback |
| Overall deliverable | active | Complete only after draft PR and verified deployment; disclose remaining limits |

## Acceptance matrix

1. Sources connect to a pitch/commission without implicit provider requests; identities and citations remain canonical.
2. Source-free ideas clearly require supporting evidence and writer selection before approval/drafting.
3. Approval and assignment are distinct from explicitly confirmed paid draft generation. Repeated/stale requests cannot create duplicate work; uncertain outcomes guide reconciliation before retry.
4. Detail includes brief, sources, writer, linked draft, recorded history and honest recorded/unknown costs. Never invent totals or human review.
5. Draft/review/publication state comes from the authoritative article; unavailable/rejected/withdrawn content is not mislabeled published. Existing optimistic publication rules remain enforced.
6. Existing editor, Reader, edition and newsletter tools are connected with truthful consequences; no new delivery or print subsystem.
7. Tenant and role isolation, safe text/URL rendering, no incidental AI or public mutation on read, and existing snapshot/image protections pass regressions.
8. Desktop/mobile, keyboard focus, deep links/back-forward, stale selection, repeated clicks, cancel and failure/retry receive automated/browser coverage.

## Rollout and rollback

Freeze exact head, run applicable full tests/typecheck and independent review, publish draft PR and inspect exact-head CI. Baseline 21 agent TypeScript errors are separate from new failures. Build a candidate on Titan using the established private VM workflow. Back up database, media, configuration and source consistently; retain rollback image and verify an isolated restore. Apply only necessary components; preserve current settings/media/editions and other app versions. Verify readiness, all four HTTPS sites, exact served assets, automation OFF, internal database, and before/after data hashes. Roll back source/image on recoverable failure; never overwrite production data wholesale.

No merge, paid generation, live publication/destructive QA, new credentials/security policy, printer jobs, newsletter delivery implementation, or PR15 layouts. No obsolete button overlay.
