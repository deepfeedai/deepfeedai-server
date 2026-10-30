# Workflow navigation and clarity implementation plan

Status: approved for implementation, draft PR publication and backed-up deployment; not approved for merge.
Base: server main da120bf792641fbb8784b59f8624f06139e7bcd9. Branch: feature/workflow-navigation.

## Current-state inventory

The portal is a static multi-page admin application using Express APIs. admin.js supplies a sidebar grouped as The Floor, The Wire, The Desk and Reports. The command palette, mobile bottom navigation, breadcrumbs and recent/pinned links have partly independent mappings. Several current links lack UI permission filtering, though API authorization must remain authoritative. The root/login default is classic.html; newsroom.html is an existing specialist hub with chat/discovery/synthesis entry points. These are retained.

Feed Inbox is now the Reader at feed-inbox.html. RSS Sources, Stories, article editing/review/publication and editor assignments already have real APIs and states. Assignments and ordinary pitches are distinct records/workflows surfaced on pitches.html; drafts and published articles are the same article records, not separate content stores. Existing Dashboard totals do not consistently match workflow queues (for example removed feeds and scheduled drafts), so Overview must use explicit matching predicates.

Article, pitch, Story and Reader filters largely live in memory. Some deep links work only through hashes or entity IDs, and existing article-editor return support is not consistently populated. Pitches uses broad tab selectors that can collide with nested controls. Existing onboarding hints store browser-global flags rather than true tenant/user preferences.

## Target information architecture and route mapping

Use one permission-aware catalog for five workflow groups. Primary destinations receive prominence; specialist/reporting tools stay reachable through contextual secondary links, the group expansion and search. Do not remove or redirect existing feature URLs to unrelated screens.

| Group | Primary destinations | Contextual/advanced destinations retained |
|---|---|---|
| Overview | overview.html (new attention dashboard), newsroom-activity.html | classic.html (existing metrics), analytics.html, notifications.html |
| Discover | feed-inbox.html (Reader), sources.html (RSS Sources) | discover.html, pipeline.html, synthesis.html, story-board.html, newsroom-feed.html |
| Editorial | pitches.html (pitches and assignments), articles.html filtered to editorial drafts/review | editorial.html, budget.html (Runsheet), briefs.html, newsroom-chat.html, newsroom.html, editorial-intelligence.html |
| Publish | articles.html filtered to ready/scheduled/published, stories.html | newsletter.html, comments.html, banners.html |
| Manage | writers.html, writing-styles.html, settings.html, ai-usage.html | writer-detail.html, audit.html, users.html, roles.html, setup/wizard/deployment routes where authorized |

Existing direct URLs, entity IDs, hashes and specialist workflows remain valid. Query-sensitive active state must distinguish multiple views of articles.html. Settings keeps its internal navigation. Operational Platform administration stays separate; its already-deployed Reader link is preserved without merging or changing Platform draft PR2.

## Page clarity and truthful next steps

Each major page gets a short purpose statement, a safe primary navigation/action entry point and an accessible Help with this page panel. Reuse existing actions rather than inventing a second create/review/publish mechanism. Explain Reader as evidence gathering, pitches as idea evaluation, and Stories as ongoing timelines of published coverage.

Next-step copy and links use persisted state and current permissions: needs sources -> attach evidence; proposed -> review/approve assignment without generation; approved -> explicit paid draft action; drafting -> check existing status rather than duplicate submission; review -> edit/review draft; scheduled/published -> review publication/corrections. Help and next-step navigation must never invoke a provider, approve, publish, clear data or automatically retry a job. Existing paid confirmations and destructive guards stay intact.

## Overview and onboarding contract

Add an authenticated, no-store, tenant-scoped Overview endpoint. Permission-inaccessible cards are omitted, not represented as zero. Feature-disabled queues are omitted with sensible available alternatives. Explicit queues include writer pitches awaiting decision, editor assignments missing sources, editorial drafts/review items, scheduled publications and current feeds with fetch errors. Derive exact SQL predicates from existing routes and align their destination filters. Label scheduled/overdue honestly; do not call overdue rows upcoming. Activity is a bounded read-only list of real permitted changes, not AI commentary.

Cards link to real filtered existing lists. Add bounded filters/pagination where the destination lacks them. For assignments, extend the existing read API and add an external page-controller compatibility adapter; do not edit the separate deployed Editor button overlay or invent an editor-assignments.html route. Counts must not rely on an arbitrary first100 result set.

Checklist shows workspace evidence separately from personal progress: current feeds exist, sources available/read, a pitch or assignment exists, an editorial draft exists, publication exists. Never equate clicking a link with successful generation/review/publication. Use explicit labels for workspace versus current-user evidence. Store dismissal/restoration only in an additive tenant+principal+checklist-version preferences row; GET has no writes. Help can reopen the checklist. Local presentation state (pins/recents/collapsed groups) is tenant/user scoped and resilient to denied/malformed storage.

## Navigation state and accessibility

Use allowlisted URL parameters for filters, views, pagination and selected entity IDs. Restore after asynchronous options/data are available. Preserve supported hashes such as Sources #duplicates. Back/Forward must restore actual list state and appropriate scroll, without restoring bulk selections, replaying mutations or replacing unsaved editor content. Link article-editor with a validated same-origin return destination. Success notices offer links to created briefs/items without generating content.

Use consistent toolbar/action placement through scoped shared styles; do not restyle unrelated modal implementations. Keyboard navigation, focus-visible, Escape and focus restoration are required. Mobile navigation and search consume the same permission-aware catalog. Avoid enabling turbo navigation globally; preserve its existing opt-in lifecycle.

## Implementation phases and ownership

1. Inventory and this durable plan; agree route/filter/permission contracts before code integration.
2. Backend owner: Overview predicates, metadata, per-user preferences and additive initialization; tests for counts, filters, authorization and no side effects. Root owns db/server integration points.
3. Navigation owner: shared catalog, sidebar/palette/mobile/breadcrumbs/recent links, page-purpose/help and scoped preferences. Preserve every feature entry point.
4. List-flow owner: URL/history/scroll restoration, filtered destinations, assignment compatibility adapter, next-step/success/return links. Coordinate exact predicates with backend owner; keep overlay files untouched.
5. Overview UI owner: responsive attention cards, bounded activity and evidence-based checklist; loading/empty/error/retry states and no paid mutations.
6. Root integration: default landing/login return paths, test fixtures, final source audit, independent review, actual browser QA, draft PR and rollout. Fix review findings before deployment.

## Acceptance tests

- Every previous primary/specialist destination remains reachable through an authorized route/search/context; active groups and breadcrumbs match deep links.
- Owner, read-only and restricted roles have correct menus and actions. APIs deny unauthorized reads; tenant and user preferences cannot cross boundaries.
- Each Overview count matches its destination rows under seeded mixed states (archived/published/review/scheduled/removed/error); zero, loading and failure are distinct.
- GET Overview/help/navigation calls no AI, writes no content and changes no job/publication state. Checklist dismissal is per principal/tenant; completion derives real evidence.
- Missing sources, approval, paid generation, draft review, scheduling and publication are described truthfully; navigation does not bypass existing confirmations.
- Copied URLs, reload, Back/Forward and editor return preserve filters/page/scroll appropriately; selection and paid actions are not replayed.
- Repeated clicks, cancellation, failed request/retry, storage unavailable, keyboard focus and mobile drawer/help are tested with mocks/disposable fixtures.
- Run applicable full server suites/build/typecheck. Existing21 agent-tools TypeScript errors and absent CI are disclosed separately; no unrelated dependency remediation.
- Actual desktop/mobile browser QA covers Overview, Reader, Sources, pitches/assignments, articles/review and Stories, including filtered destinations and guidance dismissal/reopen.

## Rollout and rollback

Publish logical commits on new feature branch(es) and open draft PR(s); verify exact remote heads and any checks. Prefer server-only scope. Do not merge. Preserve deployed Platform PR2 Reader link and the exact separate Editor button overlay manifest 5eba1411f83738b0cf83489ffc33ed07d34fbcd0168bacb06deb1748c4bea60e outside the PR.

Build from a fresh protected live source snapshot plus the tested delta, preserve runtime changelog and all unrelated changes. Back up database/media/config/source/images consistently before apply; stop only the app writer briefly if needed. Apply additive schema only. Keep automation OFF, database internal, settings/credentials/network unchanged. Verify source/served asset hashes, all four HTTPS sites, health, content/config/media aggregates and private API behavior. Exercise destructive or paid paths only in disposable mocked tests.

Retain previous images and source manifest. On failure restore images/affected source safely; leave additive preference schema intact. Database restore must not overwrite later user edits. Record backup path, exact source/image identities, verification and manual review steps in the operational runbook.

## Risks and decisions to validate during implementation

Counts cannot claim exactness if a destination silently truncates, and current content types/statuses require explicit matching filters. Existing feature/permission gates differ across routes; align labels with actual access rather than widening permissions. Assignment UI has an unpublished overlay, so integration must use compatible external hooks and real API metadata; stop for a concrete conflict rather than publish that overlay. Native browser tooling may need fresh tab bindings; report unverified interactions accurately rather than substitute mocked claims. No public or paid behavior is newly enabled by this milestone.