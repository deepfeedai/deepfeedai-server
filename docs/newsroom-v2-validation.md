# Newsroom v2 validation record

## Reproduction

Run `bash scripts/test-newsroom-workflow.sh` with Docker available. It creates a uniquely named internal network and disposable database, runs the full unit/integration/acceptance suite with mocked AI and automation disabled, then removes its owned fixtures. It does not use production credentials or data. Dependency/image downloads are setup only. Browser fixture instructions and exact results are recorded below when complete.

## Baseline security and open source review

Independent review of main `2032157` found legacy pitch approval/auto-assignment paths could call synthesis implicitly. The v2 implementation must remove this ambiguity and retain explicit, guarded generation separately; final review remains required.

`npm audit --package-lock-only --ignore-scripts` on the unchanged baseline lockfile reported 45 vulnerable package entries: 2 critical, 17 high, 25 moderate and 1 low. Counts describe advisory matches, not proven exploitability. Critical transitive entries include protobufjs 7.5.4 ([GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg)) and proxy-addr 2.0.7 ([GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)). The application uses numeric `trust proxy: 1`, not the latter advisory's IPv6 trust-subnet configuration. No dependency upgrades or security settings were changed as part of this workflow milestone.

Lockfile metadata covers 407 packages: predominantly MIT (230), Apache-2.0 (144), BSD (17), ISC (11), plus three other permissive labels. Two entries, busboy 1.6.0 and streamsearch 1.1.0, lack lockfile license metadata. Their matching locally installed package versions were checked separately: both distributed LICENSE files contain the MIT permission and disclaimer text. This is an inventory, not legal certification.

Existing CodeQL JavaScript/TypeScript and Python checks run for main-targeting PRs; Debricked scans pushes. Inspected workflows do not deploy or invoke paid providers. Exact final-head results must be checked before rollout. Baseline TypeScript errors: 21 in `lib/agents/tools/index.ts`; new regressions must be distinguished.

## Final evidence

Integrated pre-freeze run: 597 tests passed, 40 suites, zero failures/skips. A later connection-pool regression and its fix are included in the final frozen-head rerun. Desktop 1440px/mobile 390px browser fixtures passed, including repeated/cancelled actions, stale responses, reload, keyboard navigation, pagination and failure recovery. Browser APIs were intercepted; actual API/database journey tests used disposable PostgreSQL and stubbed AI. No provider or production mutation calls were made.

Independent reviewers identified and verified fixes for lost pitch reasoning, unknown costs shown as zero, stale review submissions, token-based scheduling bypass, a missing legacy link column and nested connection-pool acquisition. Final exact-head tests/CI and deployment evidence are retained in the rollout record; source review does not substitute for those checks.
