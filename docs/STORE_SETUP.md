# Distribution and Chrome Web Store setup

This guide describes the one-time external setup and the release automation shipped with the source. All configuration is explicit. No publisher ID, Store item ID, cloud account, access token or successful Store publication is invented by the build.

## Current status

- The public source repository is `thors-github/hibob-chrome-extension`.
- The current source is **1.5.0-beta.1**, an API evaluation build. Review is bound to the authenticated employee/company and connection generation, with explicit account confirmation for each plan. Earlier 1.4.0 native acceptance covered direct session connection, full-month reading, current/future creation, retained-entry recovery and independent readback. The fast 1.5.0 monthly write sequence requires separate native write acceptance; local fixtures verify its shared month checks, minimum-change planning, request budget and timing without real attendance writes. Interactive SSO and the temporary-tab fallback were not exercised natively. `docs/release-readiness.json` blocks a stable 1.5.0 release and every Store submission while the unsupported internal contract and unverified overwrite/authentication paths remain.
- The first push to `main` may create the explicitly configured **v1.5.0-beta.1** prerelease after tests pass. This bootstrap is prerelease-only, targets that exact tested commit, and does nothing if the tag already exists. Future normal releases use version tags on commits contained in `main`.
- **No Chrome Web Store developer account or published listing exists yet.** Store submission is disabled. The installation site's Store button remains disabled.
- **GitHub Pages has not yet been enabled.** The Pages workflow builds an artifact and reports the one-time administrator step instead of claiming a live website or failing a known-unconfigured deployment.

## 1. Enable the installation and privacy site

A repository administrator must open **Settings → Pages → Build and deployment → Source → GitHub Actions**. Then run the **Publish installation site** workflow manually. A successful deployment exposes:

- Installation: `https://thors-github.github.io/hibob-chrome-extension/`
- Privacy: `https://thors-github.github.io/hibob-chrome-extension/privacy.html`

Verify both URLs in a signed-out browser before using them in a Store listing. The site uses no analytics, third-party fonts or embedded trackers.

The workflow first sends an authenticated, read-only `GET /repos/thors-github/hibob-chrome-extension/pages`. A missing or branch-based Pages configuration produces the setup note and a downloadable `github-pages` site artifact. It does not attempt to enable Pages with the normal workflow token. Authentication or server errors fail clearly. Once Pages uses Actions, the workflow configures and deploys it normally. No administrator PAT is introduced.

## 2. Finish native validation before a stable release

Validate the exact API build, including normal HiBob/SSO login, consistent own-employee/company identity, session generation, account changes, expired sessions, readback and interruption behaviour. Test direct background requests with no open HiBob tab, plus the extension-owned temporary-tab fallback. The fallback must use API requests only, never the old form writer.

Earlier **1.3.0-beta.1** native read-only acceptance used its actual API adapter: existing-session connection through direct requests, a complete month scan, preview with a retained manual exclusion and **Check plan — no saving**. Fresh account consent was required, and the successful result discarded the scan and approval. No attendance writes, Save or Submit actions were executed. Interactive SSO and the temporary-tab fallback remain outside this native acceptance.

Preflight is not an unsaved server draft or proof of write acceptance. Do not create then delete real entries as a test. The ID-preserving full-day replacement contract is checked by source analysis and local server fixtures; live overwriting remains unverified, and replacements that would delete existing segments are blocked. Live API saving and future-entry acceptance require their own deliberately scoped acceptance before a stable release.

Review the new exact `https://app.hibob.com/*` host permission and matching `connect-src` policy in the Store disclosures. Chrome manages session cookies; the extension must not collect passwords, use the cookies API, persist authentication cookies/tokens or broaden access to arbitrary hosts. A login popup uses normal HiBob and organisation SSO pages. Update screenshots and privacy descriptions to show the account connection rather than the former tab/image-marker workflow.

The session API connection and session format 6 discard older previews/approval while preserving preferences and booking history. Reconnect and perform a fresh scan after updating. Native evidence and personal account values must remain outside the public repository. Changing release flags is not a substitute for validation.

For the exact numeric manifest version, update `docs/release-readiness.json` with:

- `stableReleaseReady: true` only after the remaining blockers are resolved;
- an empty `blockers` array;
- non-empty `validationEvidence` pointing to reviewable acceptance evidence without personal HiBob data.

A stable tag must equal `v` plus `manifest.version`. A prerelease tag must also match `manifest.version_name`, for example `v1.5.0-beta.1`. The current stable gate remains false. Changing a flag is not a substitute for validation.

## 3. Create the real unlisted Store item

The publisher must perform these one-time steps using their Google account:

1. [Register as a Chrome Web Store developer](https://chrome.google.com/webstore/devconsole/register), complete the required account verification and enable two-step verification.
2. Create an extension item in the Developer Dashboard using the tested release ZIP. Complete its English listing, screenshots, support details, single-purpose explanation and privacy declarations. Use the deployed privacy URL above after verifying it is reachable.
3. Choose **Unlisted** visibility. Anyone with the Store URL can install an unlisted item; this is not private distribution. The GitHub source remains public.
4. Complete the first publication through the dashboard. Google review is required. The API uses the item's existing visibility; after changing visibility in the dashboard, publish that setting manually at least once before relying on automated submissions.
5. Record the actual **publisher ID**, **extension ID**, and published **Chrome Web Store URL**. Keep the same item for future versions. Update the current-status statements in this guide and the README when publication is verified; do not leave a claim that the Store is unavailable after enabling its real published link.

The extension package is submitted unchanged from the tested GitHub release ZIP. The Store signs and delivers its own CRX. Windows and macOS users obtain normal installation and native automatic updates through the Store; a GitHub ZIP cannot grant itself that capability.

## 4. Configure keyless publishing with Workload Identity Federation

Use a Google Cloud project controlled by the publisher. Enable the Chrome Web Store API, IAM API, IAM Service Account Credentials API and Security Token Service API. Create a dedicated service account, for example `hibob-cws-publisher`, without a downloadable key.

In the **Chrome Web Store Developer Dashboard → Account**, add that service account's actual email address to grant access to the publisher's items. Cloud IAM alone does not grant Chrome Web Store publisher access.

Configure a GitHub OIDC Workload Identity pool/provider and let it impersonate the service account with `roles/iam.workloadIdentityUser` on that service account. No service-account JSON key, OAuth refresh token, client secret or personal GitHub token belongs in the extension or this pipeline.

Restrict the provider admission condition to all of the following:

- the numeric repository ID and numeric owner ID of this exact repository;
- version-tag pushes, with `assertion.ref.startsWith('refs/tags/v')`;
- the `chrome-web-store` GitHub environment subject;
- this repository's `.github/workflows/release.yml` workflow.

The provider's claim mapping must include `google.subject=assertion.sub` and `attribute.repository_id=assertion.repository_id`. A condition template is:

```text
assertion.repository_id == 'YOUR_NUMERIC_REPOSITORY_ID' &&
assertion.repository_owner_id == 'YOUR_NUMERIC_OWNER_ID' &&
assertion.ref.startsWith('refs/tags/v') &&
assertion.sub == 'repo:thors-github/hibob-chrome-extension:environment:chrome-web-store' &&
assertion.workflow_ref.startsWith('thors-github/hibob-chrome-extension/.github/workflows/release.yml@refs/tags/v')
```

Replace the placeholders with verified numeric IDs. Obtain them from GitHub's repository and owner metadata. Grant the corresponding `principalSet` restricted by `attribute.repository_id` the Workload Identity User role on this service account. Do not grant an entire identity pool permission to impersonate a broad cloud administrator.

Create the GitHub **chrome-web-store** environment and restrict deployments to version tags. The intended future submission flow is automatic; required human environment reviewers would intentionally make it manual. Protect `main` and release-tag creation so only trusted changes can enter the publishing workflow.

The pinned official `google-github-actions/auth` step exchanges the job's OIDC identity for a **600-second** service-account access token with only the `https://www.googleapis.com/auth/chromewebstore` OAuth scope. It creates no credential file. The token is passed only to the Store submitter step.

Follow the official setup documentation:

- [Chrome Web Store service accounts](https://developer.chrome.com/docs/webstore/service-accounts)
- [Google's GitHub authentication action and WIF setup](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account)
- [Store API v2 usage](https://developer.chrome.com/docs/webstore/using-api)

## 5. Set repository variables

These are configuration variables, not long-lived credentials. Leave the enablement flags unset until the corresponding setup is complete.

| Variable | Required value |
| --- | --- |
| `CWS_AUTOMATION_ENABLED` | `true` only when the publisher, item, initial publication and WIF setup are ready |
| `CWS_PUBLISHER_ID` | Actual publisher ID from the Developer Dashboard |
| `CWS_EXTENSION_ID` | Actual 32-character Chrome Web Store item ID |
| `CWS_WIF_PROVIDER` | Full `projects/.../locations/global/workloadIdentityPools/.../providers/...` resource name |
| `CWS_SERVICE_ACCOUNT` | Actual dedicated service-account email |
| `CWS_STORE_PUBLISHED` | `true` only after manually verifying the Store listing is published and installable |
| `CWS_STORE_URL` | Exact `https://chromewebstore.google.com/detail/...` URL for the published item, without credentials, query parameters or fragments |

The two Store-link variables control the installation site, not publishing credentials. A syntactically valid link does not prove availability; the publisher must verify publication before enabling it. Rerun **Publish installation site** after changing them. Setting only the URL keeps the Store button disabled.

## 6. Release flow

1. Review and merge a versioned change into `main`. Update numeric `manifest.version`, `version_name`, package versions, changelog and the readiness record consistently.
2. Create the matching version tag on a commit contained in `main`. The explicitly configured first prerelease bootstrap is the only exception to needing an existing tag.
3. The release workflow runs unit tests, translation/type checks, the production build and browser tests. It builds **one** `hibob-monthly-attendance.zip` and records its source commit, size and SHA-256 in `release.json`.
4. The GitHub job downloads that immutable workflow artifact, verifies its checksums and source context, and uploads assets to a draft release. Existing differing assets are never overwritten. It publishes the release only after GitHub confirms uploaded asset sizes and digests.
5. Prereleases stop there and are not marked as the latest stable release. Stable releases are eligible for Store submission only when the committed readiness gate and explicit Store setup flags pass.
6. The Store job downloads the same artifact without rebuilding. It verifies the ZIP again, obtains the short-lived WIF token, uploads through **API v2**, waits for a successful upload, and submits with review enabled and publication after approval.
7. A successful submission is reported as **submitted for review**, not as already available. Google review, publication and Chrome's eventual idle-time rollout remain separate stages.

The workflow serialises all releases. **It must be the exclusive Store package publisher while a job is active. Do not concurrently upload another package through the Developer Dashboard or another pipeline.** API v2's asynchronous `fetchStatus` reports completion for an item, but exposes neither a draft ZIP digest nor a guaranteed draft-upload version. Exact-artifact verification happens before upload, and the async completion flow relies on this exclusive-publisher rule. Any returned version or item identity mismatch stops submission.

## Failure and recovery

- **Native validation incomplete:** stable release resolution fails before publishing. Earlier 1.4.0 passed native existing-session/direct connection, full-month reading, current/future creation, retained-entry recovery and independent readback. The optimized 1.5.0 writer has not been exercised by automatically repeating real attendance writes. Interactive SSO, the temporary-tab fallback and live overwriting still need their own native evidence. A successful preflight is not a successful save. Store authentication is never attempted for a prerelease.
- **Bootstrap tag already exists:** a new `main` push skips bootstrap publication. If the first publishing job failed with a draft, rerun that failed job from the original workflow run while its artifact is retained; do not recreate or move the tag.
- **Tests or checksums fail:** no GitHub release or Store submission is attempted. Repair the source and create a new reviewed version/tag where appropriate.
- **Asset upload fails:** the GitHub release remains a draft. A rerun accepts matching assets and uploads only missing ones. It stops on a different digest rather than overwriting it.
- **Store setup absent:** the Store job stays disabled. If explicitly enabled with incomplete values, its configuration gate fails before Google authentication.
- **A Store submission already exists:** the same pending version is reported without re-uploading. A different or rejected/staged submission requires manual inspection; automation does not replace or cancel it.
- **Timeout or unknown Store response:** the request is not repeated blindly. Inspect the Developer Dashboard before rerunning. There are no automatic POST retries.
- **Store review rejected or delayed:** the GitHub release remains downloadable; it is not evidence of Store availability. Fix the issue, publish a higher version if needed, and submit again.
- **Pages not enabled:** download the generated site artifact if useful, complete the one-time Settings step, then rerun the Pages workflow. A failed deployment never makes the website publicly available.

## Acceptance checks

- A clean tagged checkout produces the tested ZIP, English installation guide, metadata and matching SHA-256 checksums.
- Record which flows the exact installed API candidate passes without real attendance changes. For **1.3.0-beta.1**, existing-session/direct connection, full-month read, preview, fresh account consent and read-only preflight passed; the new candidate needs its own acceptance. Interactive SSO and the temporary-tab fallback were not exercised natively; account/session-change and interruption checks also require their own evidence before stable release.
- Permission/privacy disclosures match the exact HiBob host scope; no authentication cookies, tokens or private native evidence are included in the ZIP or repository.
- The current stable tag is blocked while the current prerelease is permitted; its Store job is skipped.
- No published Store configuration leaves the installation control disabled. A verified published URL enables the real Store link without changing source code.
- A missing Pages configuration produces setup guidance and an artifact; a configured Actions site deploys; authentication errors are not hidden as a setup state.
- Settings-only export/import works between separate extension IDs. No imported snapshot authorises a booking; a fresh month scan is required.
- A Store update never triggers an extension-initiated reload during a scan or booking. ZIP installations continue to state that replacement is manual.
