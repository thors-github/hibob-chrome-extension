# Privacy statement

HiBob Monthly Attendance · Last updated 2 November 2026

HiBob Monthly Attendance runs in Chrome and uses your existing HiBob login. There is no project server receiving your attendance data. This is an independent extension, not affiliated with HiBob.

## Data read from HiBob

After you explicitly activate the extension on HiBob and read a month, it reads the visible attendance interface: dates, work and break periods, reported hours, absences, non-working days, and relevant entry details such as notes, reasons and projects. The extension compares visible account change markers and the browser document. You must confirm the account and company for each reviewed booking plan; this is not automatic employee-ID verification.

The extension does not read passwords or cookies and does not require a HiBob API key.

## Local storage and preference backups

Preferences such as work times, break times and holiday region are stored in Chrome's local extension storage. Attendance snapshots, previews, operation status and run logs use Chrome's session storage. These records are not uploaded to a project backend.

You can export preferences to a file you control and import them into another installation. A preferences export excludes attendance snapshots, account context, notes, previews and run history. Manual date exclusions are preferences and can appear in the exported file. Keep or delete exported files yourself.

## Data sent to other services

After your review and explicit final confirmation, HiBob's normal attendance form sends entries to HiBob. Reading and generating a preview do not save attendance. This prerelease requires explicit per-plan account confirmation and matching visible UI context before booking. Marker fingerprints are kept only with the session preview; image URL tokens and query parameters are not stored. Reading and dialog tests do not establish live saving support.

The project does not operate a telemetry, advertising, analytics or holiday lookup service. German holiday data is included in the extension package.

A Chrome Web Store installation, once its listing is published, uses Chrome's Store update mechanism. Chrome and Google process those update requests under their own terms. The extension does not send attendance data as part of an update check. A GitHub ZIP installation updates manually. Following a release or support link opens GitHub in your browser.

## Permissions

- `activeTab` and `scripting` allow interaction with the HiBob tab you explicitly activate.
- `sidePanel` provides the extension interface.
- `storage` saves preferences and session state.

The extension does not request broad permission to read every website.

## Retention and removal

Session data is temporary and may be cleared when Chrome restarts or the extension reloads or updates. Preferences remain in local extension storage until removed or the extension is uninstalled. Files you exported or downloaded are separate and must be removed yourself. HiBob retains attendance you saved there according to your organisation's HiBob policies.

## Website hosting and contact

The installation site's code sets no cookies and includes no analytics, external fonts or embedded third-party trackers. GitHub Pages hosts it and may process normal web request logs under the [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

The project is maintained by [thors-github](https://github.com/thors-github). For questions, use the [GitHub issue tracker](https://github.com/thors-github/hibob-chrome-extension/issues). Public issues are visible to other people; do not include attendance records, personal account details or credentials.
