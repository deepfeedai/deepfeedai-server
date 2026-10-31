# Newsroom workflow

Open **Editorial → Newsroom workflow** to follow work from evidence to publication. The queue uses the existing source, writer-pitch, source-pitch, commission and authored-article records. It does not copy article text into a new workflow database. Filters and the selected item are addressable in the URL.

## Working through a story

1. **Discover:** review the original source and save a brief from Reader or the source's commission handoff. A source selection does not generate text.
2. **Pitch:** inspect the writer's recorded reasoning or source-based angle. Open a linked commission; repeated requests reopen the same brief. Closed pitches and unavailable sources cannot silently become new work.
3. **Commission:** review the topic, angle, assigned writer and supporting sources. The workspace explains missing prerequisites. Manage sources uses the existing searchable additive picker. Approve commission records a decision only.
4. **Generate draft:** this is a separate paid action with confirmation. Generation state is shown separately from editorial stage. Reloading or returning to the tab checks the persisted result. A failed or interrupted attempt never retries automatically; inspect provider usage before an acknowledged retry.
5. **Draft/review:** open the existing article editor to preserve its source attribution, media, corrections and unsaved-change safeguards. Submit for review is version-checked and duplicate-safe. Publication prerequisites are explained before approval and revalidated by the backend.
6. **Publish:** deliberate approval publishes or schedules according to the existing publication policy. The UI reports the saved result, not an assumed success. Existing daily caps, review and withdrawal protections still apply.
7. **Handoffs:** published authored articles can be curated in the existing Newspaper Editions or Newsletter tools when the user has permission. Opening these links does not create/share an issue, suggest AI text, send mail or print. Those tools retain their own selection and confirmation steps.

Legacy pitch approval, auto-assignment and notification approval no longer hide paid synthesis. They retain the editorial decision and direct the editor to a commission for explicit generation. Existing specialized pages remain available; the workspace connects them rather than replacing their editors.

## State, permissions and recovery

Actions are derived from authoritative records and the current user's permissions. The backend repeats validation on mutation. Assignment action fingerprints detect changed briefs/sources/writers; article publication revisions prevent stale decisions. A duplicate click is not a publication toggle. Commission conversion retains the originating pitch and an idempotent link, while the active queue avoids showing a second copy of the same linked work.

Costs are only displayed when usage is attributable and the user can read financial settings. Missing estimates are unknown, not zero; partial estimates are labeled and provider billing remains authoritative. History includes recorded creation/decision/attempt and publication events. It does not claim a complete retrospective audit or unrecorded human review.

An interrupted request may have reached its provider even if the browser did not receive a response. Check the saved state and provider usage before retrying. The workspace polls a running selected attempt and refreshes when returning to the tab, but never resubmits automatically.

## Migration and compatibility

Startup adds the missing nullable `story_pitches.spawned_article_id` column and a tenant-qualified lookup index if absent. The migration is repeatable and does not guess or backfill historical article links. Existing pitch rows, articles, edition snapshots and settings remain intact. No PR15 alternative print layouts are included.

For a code rollback, leave this additive column/index in place; older code safely ignores them. Do not restore the production database wholesale or drop data to undo the UI. Use the deployment runbook's retained source/image and drift checks.

## Review checklist

- Open a known source or pitch and follow its exact commission link.
- Confirm stage, missing prerequisites and next action agree with the existing record.
- Change selection/filter, use Back/Forward and reload; verify the selected item remains correct.
- Check a read-only account has no enabled mutation controls.
- Inspect a saved draft and existing published article; confirm editor and downstream links.
- Paid generation and live publication remain manual user tests; automated acceptance uses isolated fixtures and simulated providers.

Run `bash scripts/test-newsroom-workflow.sh` for the offline full suite. For browser fixtures set `PLAYWRIGHT_MODULE` and optionally `CHROME_PATH`, then run `node scripts/qa-newsroom-workflow.cjs`. The browser fixture intercepts all API calls and creates no live content. See `newsroom-v2-validation.md` for exact evidence and baseline limitations.
