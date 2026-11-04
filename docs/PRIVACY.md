# Privacy statement

HiBob Monthly Attendance · Last updated 4 November 2026

HiBob Monthly Attendance runs in Chrome and connects to HiBob using your normal signed-in browser session. There is no project server receiving your attendance data. This is an independent extension, not affiliated with HiBob. This version uses HiBob's internal web API; it is not an officially supported HiBob integration.

## Data read from HiBob

After you choose **Sign in to HiBob** and read a month, the extension requests your own attendance data from HiBob's internal API: dates, work and break periods, reported hours, absences, non-working days, attendance periods and locks, and relevant entry details such as notes, reasons and projects. It reads employee/company identifiers and display labels to bind the preview to the authenticated account. Missing or ambiguous account data and impersonation/“View as” sessions block the operation. You must confirm the displayed account and company for each reviewed plan.

Chrome supplies the existing HiBob session cookies with authenticated requests. The extension does not collect passwords, use the Chrome cookies API, extract authentication cookies for reuse, or persist authentication cookies or tokens. No manually supplied HiBob API key or token is required. If sign-in is needed, the extension opens HiBob's normal login window, including your organisation's SSO and MFA where configured; your credentials are entered into HiBob or its identity provider, not into an extension-owned login form.

Direct requests run in the extension background service. When a page context is needed, the extension can open a temporary background HiBob tab, perform the same allowlisted API operations there and close only the tab it still owns. It does not fill attendance forms. **Disconnect** clears local connection state and approval without clearing your browser cookies or logging out other HiBob tabs.

## Local storage and preference backups

Preferences such as work times, break times and holiday region are stored in Chrome's local extension storage. Account connection metadata, attendance snapshots, previews, operation status and run logs use Chrome's session storage. Authentication cookies and tokens are not copied into this storage. Read-only preflight results remain temporary panel memory and are not added to booking history. These records are not uploaded to a project backend. Submission reviews and their account/content scope use session storage; explicit approval exists only for that review and is invalidated on close, edits, another review or restart.

A separate persistent reminder cache stores the reminder switch, a SHA-256 employee/company scope, tracked months, submission states and check timestamps. It contains no clear employee/company identifiers, account labels, attendance entries or credentials. It retains pending months, compacts completed history with a tracking watermark, and is separate from preference backups. A minimal persistent submission journal stores the hashed account scope, month, opaque review/job IDs, dispatch/verification status and timestamp so a restart cannot replay an ambiguous Submit. It contains no attendance or notes. Disconnect hides the active account's badge and result; it does not delete unresolved journal evidence.

You can export preferences to a file you control and import them into another installation. A preferences export excludes attendance snapshots, account context, notes, previews and run history. Manual date exclusions are preferences and can appear in the exported file. Keep or delete exported files yourself.

The separate **Download booking plan** action under **More options** creates a private local review file. It contains the displayed account label, month, preferences, existing and planned attendance segments, any entry details and the current run results. It excludes the API connection context, connection generation and authentication data. Raw change fingerprints may contain entry and employee identifiers; the file is confidential and is not anonymised. This file is not a settings backup and cannot authorize or start a booking. Keep it private; the extension does not upload it.

## Data sent to other services

After your review and explicit final confirmation, the extension sends the approved attendance entries to HiBob through its internal API. Reading, generating a preview and **Check plan — no saving** do not create, update or delete attendance. The preflight checks current account/day data and the plan locally; it does not prove that the server will accept a write.

Each booking requires the same reviewed employee/company and connection generation. Account changes, session expiry and reconnecting invalidate approval. Request failures with an unclear save outcome stop the run rather than repeating a write or falling back to form automation. Earlier 1.4.0 native acceptance covered current and future entry creation with independent readback. The 1.5.0 fast monthly writer is checked with local fixtures; native acceptance is read-only and real writes are not repeated for validation. Live overwriting, interactive SSO and fallback transport remain unverified in this prerelease. Fast mode sends one request at a time without an unconditional delay; server cooldowns remain enforced and a rate-limit response stops new writes without retrying a mutation. Monthly verification occurs after the serial writes; a server acknowledgement alone is not displayed as verified. Local duration and request-count measurements contain no employee IDs, request paths, payloads or notes and are never sent to an analytics service.

Month submission has a separate explicit account/month confirmation. It sends one allowlisted own-account Submit request without query parameters or payload and independently reads back the status and unchanged attendance. No automatic submission, approval, reopening or submission on behalf of another employee is performed. Passive reminder checks read account/period status only, at most hourly while months are due; they never initiate login or open a background tab. Opening the panel does not clear a due reminder. Offline/session-expiry results retain an unknown status until checked again.

The project does not operate a telemetry, advertising, analytics or holiday lookup service. German holiday data is included in the extension package.

A Chrome Web Store installation, once its listing is published, uses Chrome's Store update mechanism. Chrome and Google process those update requests under their own terms. The extension does not send attendance data as part of an update check. A GitHub ZIP installation updates manually. Following a release or support link opens GitHub in your browser.

## Permissions

- Host access to **`https://app.hibob.com/*`** allows API requests to that site and is limited to that HTTPS origin. The extension content security policy allows connections to the same origin only.
- `scripting` supports the API relay in an extension-owned temporary HiBob tab. `activeTab` remains available for user-initiated HiBob context.
- `sidePanel` provides the extension interface.
- `storage` saves preferences and session state, the separate reminder cache and minimal submission journal.
- `alarms` schedules the hourly reminder check and catch-up after startup or wake. The badge and panel notice do not use desktop notifications.

The extension does not request broad permission to read every website, a Chrome cookies permission or an external credential service. Its request handlers allow specific HiBob operations rather than an arbitrary URL proxy. The normal browser login window may navigate to the identity provider configured by your organisation.

## Retention and removal

Session data is temporary and may be cleared when Chrome restarts or the extension reloads or updates. A restart never resumes attendance writes automatically. Version 1.7 uses session format 7 and discards earlier previews and approvals while preserving preferences and existing booking history where available. Disconnecting invalidates the current preview; any retained run history remains subject to Chrome session-storage retention. Preferences remain in local extension storage until removed or the extension is uninstalled. Files you exported or downloaded are separate and must be removed yourself. HiBob retains attendance you saved there according to your organisation's HiBob policies.

## Website hosting and contact

The installation site's code sets no cookies and includes no analytics, external fonts or embedded third-party trackers. GitHub Pages hosts it and may process normal web request logs under the [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

The project is maintained by [thors-github](https://github.com/thors-github). For questions, use the [GitHub issue tracker](https://github.com/thors-github/hibob-chrome-extension/issues). Public issues are visible to other people; do not include attendance records, personal account details or credentials.

