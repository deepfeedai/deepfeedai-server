# Newsroom navigation

The default landing page is **Overview**. Existing page URLs remain valid. The navigation catalog in `public/admin.js` supplies the sidebar, search, breadcrumbs, mobile destinations and contextual Help.

| Group | Everyday work | More tools |
| --- | --- | --- |
| Overview | Attention queues and recent editorial changes | Activity, metrics, analytics, notifications |
| Discover | Reader and RSS Sources | Discovery, synthesis pipeline, Story Board and Wire |
| Editorial | Pitches, assignments and editorial drafts | Review, Runsheet, briefs, Maxwell and specialist newsroom tools |
| Publish | Published articles and Stories | Scheduled queue, newsletter, comments and banners |
| Manage | AI Team, writing styles, settings and usage | Audit, users, roles and setup tools |

Links are filtered using existing permissions. APIs remain authoritative; this change does not grant roles new access. Operational Platform administration stays separate.

## Attention queues and next steps

Overview uses saved database state, not AI-generated estimates. Its queues distinguish writer pitches from editor assignments. Editorial drafts exclude imported inbox content; review and scheduled queues include all eligible article formats. Scheduled includes overdue items. Feed errors include paused current subscriptions but exclude removed feeds.

An assignment needing sources is not ready for paid drafting. Approval and generation remain distinct. Each assignment card explains the next step from its persisted effective state, including archived or unavailable linked drafts. Navigating, filtering, refreshing, reading Help and dismissing the checklist do not generate content, approve work or publish articles.

The checklist distinguishes workspace evidence from your personal reading state. Completion is derived from records rather than page visits. Hiding it is stored by tenant, principal type, user and checklist version. Help's **Getting started checklist** link can show it for one visit without changing that preference.

## Navigation and recovery

Copy a filtered Articles, Pitches, Reader, Sources or Stories URL to return to that view. Back/Forward restores allowlisted filters and page/scroll state where supported; it does not replay selected bulk actions. Open unsaved source or Story editors block conflicting view restoration. Article editor links carry a local return destination. Login and expired API authentication preserve safe local page destinations, never external or action URLs.

On narrow screens use the navigation button or **More**. The drawer supports Tab focus containment and Escape to return focus. **Help with this page** explains purpose, adjacent tools and relevant paid/destructive boundaries without starting a tour or operation.

## Validation

From a checkout with Docker and Bash:

```sh
bash scripts/test-workflow-navigation.sh
```

This builds a test image, uses a disposable named database and internal network, stubs provider operations, runs the aggregate server/route/UI acceptance suites and removes its owned fixtures. It never uses production environment files or volumes. Dependency/image downloads happen during setup; test execution has no external route.

`tests/acceptance/navigation-browser-fixture.js` provides owner and read-only test accounts, mixed article states, a failed paused feed, a writer pitch and a source-free assignment. It can run only with the guarded acceptance database and automation disabled. Do not mount its fixture routes in production.

Manual review: open each Overview queue; compare its filters and count; switch Articles tabs and use Back; filter the Reader and reload; open assignment sources then cancel; open Help with keyboard, dismiss/reopen the checklist, and verify a separate account has its own preference. No paid generation is needed.

## Rollout and limitations

### Navigation paint readiness

Shared workflow CSS is imported by the blocking admin stylesheet, and page guidance initializes from the existing parser-loaded admin script. This avoids white native navigation buttons and late guidance insertion while retaining normal document navigation, modifier-click/new-tab behavior, authentication, history and existing page initialization. No body-hiding delay, transition animation or automatic Turbo opt-in is added.

For a slow-resource diagnostic in the disposable acceptance environment, run `node -r tsx/cjs tests/acceptance/navigation-paint-fixture.js` instead of the regular browser fixture and open `/__fixture/paint-login` (or `?skin=daylight`). It deliberately delays workflow CSS by one second and logs DOM-ready/first-frame/settled layout samples. Do not expose this fixture in production. On the observed desktop baseline, first-frame buttons had the browser's light background and guidance shifted the content from 56px to 168.8px. With the repair, guidance and final button styling are present at the first frame and the measured content position remains stable. Ordinary document loads and page-specific data loading still occur; this is not a single-page router.

Startup adds the idempotent `navigation_preferences` table. It does not rewrite articles, assignments or provider settings. Roll back the application image/source if needed; leave this additive table in place so preferences remain available. Do not restore an old whole database over newer user edits merely to undo navigation.

The existing Articles workspace still retrieves article pages for client-side filtering; very large publications may benefit from a separate server-filtered list optimization. Legacy specialist screens retain their own detailed layouts. This milestone consolidates discovery and guidance without rewriting those workflows. Existing agent-tool TypeScript errors and dependency audit findings are separate from this change.
