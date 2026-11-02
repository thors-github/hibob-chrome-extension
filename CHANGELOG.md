# Changelog

## 1.4.0-beta.1

- Simplify the monthly workflow: show the month, connected account and a compact schedule summary first. Move schedule, location and exclusion controls behind a labelled settings button; show advanced controls only when needed.
- Keep day rows compact while retaining expandable work/break segments, existing-entry details, weekly totals and explicit conflict decisions. Reveal blocking errors automatically and keep excluded-day selection consistent while operations are busy.
- Add optional verification checkpoints within one frozen monthly plan. Continuation requires fresh account consent and a full read-only reconciliation of verified and remaining days. Already verified days are never sent again; restart or cancellation requires a fresh scan.
- Recognise observed manual-save response fields, validate returned entry ownership against the authenticated employee, and keep unknown provenance or metadata blocked. Warn clearly when an uncertain result may already be saved.
- Acknowledge long booking jobs promptly and keep lifetime protection limited to active execution. Canonical progress and a status fallback preserve late storage-error visibility; interrupted work never resumes automatically.
- Preserve local preferences and run history while migrating to session format 5. No new permissions, credentials or external services are added.
- Space API requests conservatively and report HTTP 429 cooldowns without automatically retrying writes. Reconcile retained entries before checkpoint continuation.
- Native acceptance covers session connection, month reading, current/future creation, retained-entry recovery and independent readback. The internal API remains an evaluation integration; live overwriting, interactive SSO and fallback transport remain unverified. Stable and Store publication stay blocked.

## 1.3.0-beta.1

- Replace the production form writer with an API-first adapter for HiBob's internal web endpoints. Retain the monthly planner, German calendars, variable times, exclusions and conflict review.
- Add normal HiBob/SSO sign-in and account/company connection status. Prefer browser-session API requests in the extension background; support an extension-owned temporary background tab for API requests when a page context is required. The fallback never fills forms.
- Keep authentication in Chrome: no password collection, manually supplied API tokens, Chrome cookies API or persisted authentication cookies/tokens. Disconnect invalidates the local connection without logging out other HiBob sessions.
- Bind scans and explicit per-plan account consent to the authenticated employee/company and connection generation. Session expiry, account changes and reconnecting invalidate previews and approval.
- Replace native draft staging with **Check plan — no saving**, a read-only account/day preflight and local plan validation. It does not create/delete test entries or claim server-side save acceptance. Results are temporary and separate from booking history.
- Require current-day preconditions, ID-preserving full-day replacement and independent saved-data readback. Replacement that would delete existing segments is blocked. Request construction and overwrite checks are covered by source analysis and local server fixtures; live overwriting remains unverified. Ambiguous requests stop without automatic write retries or fallback to the old DOM writer.
- Add exact host access and connection policy for `https://app.hibob.com/*`. Upgrade adapter protocol to 5 and session format to 4; discard older previews while preserving preferences and booking history.
- Verify the installed candidate in native Chrome: reuse an existing HiBob session through direct API requests, read a complete month, retain a manual exclusion in the preview, require fresh account consent and finish read-only preflight. The result invalidates the scan and approval and requires a fresh scan. No attendance writes, Save or Submit actions were executed. Interactive SSO and the temporary-tab fallback were not exercised natively.
- Correct the attendance policy-details lookup to the observed read-only POST with `fields: ['policyDetails']`. Live API saving and future-day acceptance remain unverified; stable publication and Store submission remain blocked.

## 1.2.3-beta.1

- Verified the actual automated writer in signed-in Chrome through the dedicated draft-only path: three correct segments, Cancel and unchanged readback. No live save was performed; stable and Store release gates remain closed.

- Focus native hour/minute controls before entering values and use real focus transitions to commit the time-picker state. Synthetic blur events alone did not commit values before Add recreated the work card.
- Share draft preparation between booking and a new single-day **Test draft — no saving** action. It cancels the prepared draft and verifies unchanged attendance without reaching Save or Submit.
- Require current plan/account approval for draft tests, invalidate the preview afterwards, and keep test results temporary and distinct from booking history.
- Add phase and field diagnostics without note contents or account identifiers, and model native focusout-only commits in tests.
- Upgrade the internal adapter protocol to 4. Keep session format 3 and the existing permissions. Actual saving and future-day acceptance remain unverified.

## 1.2.2-beta.1

- Fix false failures when HiBob recreates its work and break cards while adding an entry. Match the entry contents instead of relying on the same HTML elements remaining present.
- Require exactly one newly added card and preserve the contents of all existing cards. Missing, duplicate or otherwise ambiguous changes stop before Save.
- Find current cards and time controls again after input, change and blur events, including when HiBob reorders cards. Keep completed work periods distinct so the second work period cannot replace the first.
- Reuse the initial empty work draft. Preserve per-plan account confirmation, context checks, final draft validation, Save checks and persisted readback.
- Keep existing permissions, settings transfer, update controls and distribution automation. Live saving and future-day acceptance remain unverified; stable publication and Store submission remain blocked.

## 1.2.1-beta.1

- Connect a production reader for visible HiBob account context and replace the permanently blocked identity path with explicit manual account confirmation for each reviewed plan.
- Keep automatic employee identity, manual page-context confirmation and unavailable context distinct. Images are change markers, not employee IDs.
- Bind consent to the plan ID, revision and document/context fingerprint; discard it on close, edits, rescans, reloads and restarts. No reusable consent is exported or persisted.
- Require matching authorization in the controller and content script and recheck page context before staging and immediately before Save.
- Upgrade session format and adapter protocol to 3; retain preferences, update controls and run history while discarding old previews.
- Strip image URL tokens and resize transformations before computing marker digests; block ambiguous, missing or inconsistent markers.
- Keep permissions unchanged and provide German/English confirmation messages. Live acceptance covers read-only flows; actual saving and future-day acceptance remain unverified.

## 1.2.0 — Pending native validation

Distribution preview: **1.2.0-beta.1**. The stable release and Store submission remain blocked while the native identity requirement is unresolved.

- Revoke booking approval before changing settings, persist a revisioned invalidation, and reject stale or conflicting edits from other panels. Final confirmation uses the immutable reviewed plan.
- Keep booking blocked after a preference or session-storage failure; retry the same configuration without redistributing its generated times.
- Add employee, tenant and document context guards. Unknown identity permits read-only previews but blocks writes. The currently observed native page does not expose a reliable employee identifier, so the regular release remains gated.
- Reconcile reported hours with complete day entries before writing. Unsupported selected days block the plan without silently reducing weekly targets.
- Wait for complete, stable month grids, reveal virtual rows without assuming equal heights, and retain meaningful interactive absence labels.
- Separate verified HiBob outcomes from local journal failures, retry failed initialization safely, and retain active scan/apply progress across panel reopening.
- Add session migration, revision and job guards; interrupted jobs never resume writes automatically.
- Preserve keyboard focus and scroll position when changing day selections, and show when the newly selected month still needs reading.
- Keep the existing permissions and German/English language selection. Regression tests use local fixtures; no real attendance write is included in this validation.
- Add settings-only JSON export/import for transferring preferences between installations, with explicit import confirmation and no automatic bookings.
- Show the installed version and distribution channel. Expose a pending Chrome Store update only at a safe idle point; ZIP installations keep a manual update path.
- Add a public English installation and privacy site. The Store installation control remains disabled until a real published listing is configured.
- Add CI, one-build GitHub release packaging, checksums, draft-first asset verification and an explicitly configured prerelease bootstrap on the first `main` push.
- Add stable-only Chrome Web Store API v2 submission using Workload Identity Federation and short-lived service-account tokens. The Store account and listing have not yet been created; no Store availability is claimed.

## 1.1.1

- Fix false stale-preview errors caused by Chrome reordering object keys in session storage. Real changes to snapshots, planned times and fingerprints still invalidate the preview.
- Add regression coverage for storage serialization and changed plan contents.

## 1.1.0

- Add an original clock-and-checkmark icon, including Chrome toolbar sizes.
- Follow the Chrome UI language automatically: German and English are supported, with English as the fallback.
- Translate the side panel, preview, conflict decisions, progress and error messages, and Chrome extension metadata.

## 1.0.1

- Distinguish selecting a HiBob tab from successfully reading a month.
- Receive connection updates during panel startup and prevent late startup responses from replacing newer state.
- Clear the previous tab association and preview when the extension is opened on another website.

## 1.0.0

- Introduce monthly attendance planning through the signed-in user's visible HiBob forms.
- Add work and break schedules, German state holidays, absence exclusions, per-day selection and overwrite decisions.
- Add optional minute-level variation with exact weekly net-time targets.
- Require a reviewed preview and final confirmation before saving, then verify each saved day.

## Validation

Version 1.1.1 passed 85 automated unit and DOM tests and an isolated Chromium MV3 package test. Live Chrome testing covered reading a complete month, fixed and variable previews, redistribution, day exclusions and reopening the panel. No attendance was saved in the live account; production writes and future-day acceptance remain unverified there.
