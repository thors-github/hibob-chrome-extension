# HiBob Monthly Attendance

A Chrome extension for preparing and recording your own HiBob attendance for an entire month. Review work periods and breaks before sending the entries through HiBob's internal web API, using your normal HiBob login. No manually supplied API key or token is required. The interface is available in English and German.

**Version 1.4.0-beta.1:** simplifies the monthly workflow. Choose a month, check the compact schedule summary and prepare its preview. Use the labelled settings button only when you need to change times, breaks, variation, location or exclusions. Daily rows and optional checks expand on demand; account identity, weekly totals, conflicts and errors stay clear.

The API-first connection uses your normal HiBob session without collecting a password or manually supplied API token. Direct background requests are preferred; an owned temporary tab is an API-only fallback. Each booking still requires explicit account consent. Optional verification checkpoints preserve one frozen monthly allocation and require fresh consent plus a complete read-only reconciliation before continuing. They never resend verified days. Native acceptance has covered direct connection, month reading, current and future entry creation, retained-entry recovery and saved-data reconciliation. The internal API remains an evaluation integration.

**[Download from GitHub releases](https://github.com/thors-github/hibob-chrome-extension/releases)** · **[Privacy](docs/PRIVACY.md)**

The installation website is prepared but not deployed yet. Use the installation instructions below until GitHub Pages is enabled.

The planned Chrome Web Store distribution is **unlisted**: anyone with its Store link will be able to install it. **There is no published Store listing yet.** The installation site's Store button stays disabled until the real published URL is configured. The public GitHub repository hosts source code and built ZIP releases. The configured automated distribution release is `v1.4.0-beta.1`, an API evaluation prerelease with per-plan account confirmation. The release remains an evaluation build: native creation and readback do not establish that every company policy, overwrite scenario or authentication flow is supported.

## Installation

Requirements: Google Chrome 116 or later and a HiBob account that allows access to your own attendance. Chrome must be running; a permanently open HiBob tab is not required.

1. Choose a clearly labelled release from [GitHub releases](https://github.com/thors-github/hibob-chrome-extension/releases). New releases provide **`hibob-monthly-attendance.zip`**; older releases may use a versioned filename. Download the built extension ZIP and extract it into a folder you intend to keep. Chrome cannot install this ZIP directly. GitHub's generated **Source code** archives require a build first.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder containing `manifest.json`. If installing from source, first run `npm ci` and `npm run build`, then select the generated `dist` folder. Build output is not included in the source repository.
4. Select **HiBob Monthly Attendance** from Chrome’s extensions menu on any page. Its side panel opens. You can also pin the extension to the toolbar.
5. Choose **Sign in to HiBob**. If needed, complete the normal HiBob login, company SSO and MFA in the window it opens. Allow the declared site access to `https://app.hibob.com/*` if Chrome requests it, then check the employee and company displayed in the panel.

This ZIP path is a manual installation. Once the Store listing is published, the installation page will also offer **Install from Chrome Web Store**, followed by Chrome's own installation confirmation. Ordinary macOS and Windows Chrome installations cannot use a GitHub-hosted CRX as an independent native auto-update channel. See [Chrome's distribution rules](https://developer.chrome.com/docs/extensions/how-to/distribute).

### Updates and moving to the Store

- **ZIP installation:** export your preferences first, finish any active operation, and replace the files in the **same installation folder**. Click **Reload** in `chrome://extensions`, reconnect to HiBob, and read the month again. Version 1.3 adds access to the HiBob site for API requests; review Chrome's permission prompt when updating. There is no silent ZIP self-updater and no GitHub token is stored in the extension.
- **Store installation, after publication:** Chrome downloads approved Store updates automatically. A new GitHub release is not itself a Store update; Google must approve and publish that version. The panel displays a downloaded update and offers **Update now** only when no scan or booking is active. An interrupted operation must be resolved by reading the month again before applying an update. The extension does not poll `requestUpdateCheck()` on a timer.
- **One-time ZIP-to-Store migration:** choose **Export settings** in the old copy, install the real Store copy, choose **Import settings**, and confirm replacement of preferences. Disable the old copy so both do not run together. The Store copy normally has a different extension ID and separate storage. Attendance snapshots, previews and run history are excluded from the settings backup; read the month again.

Chrome can also update after the extension becomes idle or the browser restarts. An open side panel can delay idle updates. Long booking commands acknowledge job start promptly; progress and final errors come from canonical session state, with an active-panel status fallback if session storage cannot publish an update. A bounded Chrome API pulse runs only while execution is active. No workflow promises to prevent a browser restart, enterprise intervention or a crash. Interrupted writes never resume automatically. See [Chrome's update lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle).

The connection status is independent of the browser tab you are viewing. **Sign in to HiBob** connects your account, **Create preview** reads its attendance data and prepares the plan, and a successful scan shows **Month read**. The panel identifies whether the connection uses direct API requests or a temporary background tab. **Disconnect** removes local connection state and approval without logging you out of HiBob in other tabs.

After choosing a different month, the panel asks you to read that selected month. A previous scan does not approve a new month. If saving settings or session state fails, booking remains blocked: use the displayed retry action after the storage issue is resolved. Retrying the same settings preserves the generated time distribution.

## Usage

1. Connect to HiBob and check the employee and company displayed in the panel.
2. Choose a month and check the schedule summary. The settings button opens work times, break, variation, federal state and manual exclusions. Defaults are Hesse, Monday to Friday, **08:00–16:30**, with a **12:00–12:30** break. Saved preferences are preserved.
3. Prepare the monthly preview. Workdays appear as compact rows with start/end and net time; expand a row for work/break segments or existing details. Weekends, statutory holidays, recognised non-working days and full or partial absences are excluded. Skipped days and reasons can be expanded.
4. Resolve any displayed conflicts. Decide whether to retain or overwrite each affected day; removing notes still needs explicit acknowledgement. Unsupported deletion, reasons, projects or other metadata remain blocked. Errors and conflicts are always revealed.
5. Review the day count, weekly totals and connected account. Open the final review and confirm that this is your own account in the correct company, then start booking. The account checkbox is initially unchecked and applies only to that unchanged plan.

Only the primary action for the current step is prominent. The settings and **More options** sections hold configuration, refresh, redistribution, settings transfer, version and connection details. Opening a section does not change times or regenerate the plan. Invalid hidden fields are revealed and focused. The interface follows Chrome's language, German or English.

**Download booking plan** in **More options** saves a local review file containing the exact planned and existing attendance and current run results. It excludes the API connection context and authentication data, sends no data elsewhere and cannot start or resume a booking. Raw change fingerprints may still contain attendance-entry and employee identifiers; this is a private attendance export, not an anonymised file. Keep this attendance file private; it is separate from a preferences backup.

The review's **Additional checks** section provides optional read-only preflight and **Pause for verification**. Preflight reads account/day data and validates the plan locally without creating, updating or deleting attendance; it does not certify server-side save acceptance and requires a fresh month scan afterwards. Verification pauses occur after the first saved day and the first future saved day, when applicable, while retaining exactly the original allocation. Continuation requires new account consent and checks the full month: verified entries must still match, and all remaining day fingerprints must be unchanged. No verified date is sent again.

During a booking, the panel shows the current date and verified progress. **Stop remaining days** stops subsequent work; a dispatched request may already have reached HiBob. Unknown outcomes stop without automatic write retries. Requests are spaced conservatively to reduce bursts. HTTP 429 reports a bounded server cooldown; it never starts a write retry, and a fresh scan is required before another reviewed run. Previously saved days are not rolled back. An interrupted or restarted worker cannot resume automatically: read the month again and reconcile actual attendance before approving another plan. Retaining existing entries can regenerate a new allocation, so a seed alone is not proof of unchanged remaining times.

The connection works on any browser tab and direct requests do not require an open HiBob page. The temporary-tab fallback closes only a tab still owned by the extension. The extension never submits the monthly timesheet. Detailed results can be expanded; failures and uncertain outcomes remain visible. Updates cannot activate during a running or paused booking. Settings export/import never starts a booking and excludes attendance and run history.

## Variable times

The optional variable-times mode adjusts start and end times in whole minutes. The default range is **±5 minutes**, configurable from 0 to 30 minutes. Break times stay fixed. The weekly target is eight net hours per included weekday: five days give **40 hours**, and four days give **32 hours**. Month boundaries and excluded days are handled proportionally; dates outside the selected month are never changed.

Existing entries that you keep count towards the target using their actual hours. The remaining days compensate for the difference within the permitted time ranges. Saving is blocked if the target is unreachable, existing data is incomplete, or conflict decisions remain unresolved. Different daily durations are generated when the configured limits allow them. The preview stays stable until you choose **Redistribute** or change settings or decisions. Check that the generated times reflect the attendance you actually need to record before saving.

For example, HiBob receives three separate entries: **Work 08:00–12:00**, **Break 12:00–12:30**, and **Work 12:30–16:30**. A break is not inserted inside an overlapping, continuous work entry.

## Public holidays

All 16 German federal states are supported using locally bundled German calendar data from [date-holidays](https://github.com/commenthol/date-holidays). Only statutory public holidays (`public`) are excluded automatically. Christmas Eve and New Year’s Eve are not automatically treated as non-working days. Use manual exclusions for company closures.

Bavaria requires additional choices for the local holiday in Augsburg and the Assumption of Mary at the place of work. Saxony and Thuringia require a choice for locally applicable Corpus Christi holidays. These settings refer to the **place of work**. Reference sources: [Hesse’s public holidays](https://innen.hessen.de/buerger-staat/feiertage), [Bavarian municipality lookup](https://www.statistik.bayern.de/statistik/gebiet_bevoelkerung/zensus/himmelfahrt/index.php), and [Saxony’s Corpus Christi regulation](https://www.revosax.sachsen.de/vorschrift/4142-FronleichnamsVO). Historical holiday accuracy is not guaranteed for arbitrary earlier decades.

## Language and icon

Since version **1.1.0**, the extension automatically follows **Chrome’s interface language**. German locales (`de`, including `de-DE`, `de-AT` and `de-CH`) use German; English and all other browser languages use English. During local development without extension APIs, `navigator.language` determines the language. No manual language selection is needed. Names, notes, time values and other original HiBob data are not translated.

Forms, monthly previews, dialogs, statuses, errors, holiday names, federal-state names and date labels are localised. Both languages use German holiday calendars, 24-hour time inputs and the `Europe/Berlin` time zone. This localisation applies to the extension. API parsing uses the observed response contract rather than translated labels in HiBob's interface.

The icon combines a gold clock with a green confirmation tick. Its editable source is `public/icons/app-icon.svg`. PNG exports at 16, 32, 48 and 128 pixels are used by Chrome’s toolbar and extension manager. The side panel and browser tab use the same design. A 512-pixel export is also included for previews.

## Compatibility and limitations

- The integration uses **HiBob's internal web API**, not its supported public Attendance API. Internal response formats, endpoints and authentication requirements can change without a public compatibility guarantee. Unknown structures or missing required fields stop the operation.
- Account binding uses consistent employee/company identifiers returned by the authenticated session and a connection generation. Missing or ambiguous identity and impersonation/“View as” sessions are blocked. You still explicitly confirm the displayed account and company for each reviewed plan; reconnecting or a changed session invalidates the preview and consent.
- Reported hours must agree with complete work and break entries. Unknown entry types, unsupported metadata, incomplete times or inconsistent day data block the affected operation until checked or explicitly excluded. A blocked selected day does not silently reduce a variable week's target.
- Complete month data includes attendance periods and locks, absences, non-working days and the details needed to interpret existing entries. There is no virtualised-table or visible-column requirement and the production connection does not invoke the old DOM writer.
- The implemented overwrite contract reuses every existing segment ID in a full-day replacement. Its request construction and readback checks are covered by source analysis and local server fixtures; live overwriting has not been verified. Replacement that would delete an existing segment is blocked. Existing notes are shown for explicit removal confirmation; unsupported reasons, projects or other metadata remain blocked.
- Only periods and days reported as available for your account can be used. Future entries may be rejected by HiBob. The supported public API has separate service-user/partner authentication and explicitly excludes future entry creation; that does not establish the behaviour of these internal endpoints. See the [HiBob Attendance documentation](https://apidocs.hibob.com/docs/explore-attendance-api).
- **Read-only preflight has a deliberate limit:** it checks the account, current day and locally constructed plan. It does not stage an unsaved server draft or demonstrate that a future save will be accepted. A successful result is not recorded as a saved booking.
- **Validation status for 1.4.0-beta.1:** automated tests cover realistic server response fields, employee ownership, weekly arithmetic, conflicts, retained entries, cancellation and uncertain outcomes. Native Chrome acceptance covers direct session connection, full-month reading, explicit conflict retention, current and future creation, verification pauses and independent saved-data readback. Live overwriting, interactive SSO, the temporary-tab fallback and an uninterrupted native run exceeding five minutes without DevTools remain unverified. The long-run lifecycle is covered by controlled tests exceeding six minutes. Stable and Store publication remain blocked. Private reports and personal attendance data are excluded from Git.
- A month is processed one day at a time, rather than as a server transaction. Errors or ambiguous responses stop the run. Already saved days remain, and an incomplete run may not meet the weekly target. Re-read and inspect the actual entries before trying again. There is no automatic write retry or fallback to form writes after an uncertain API request.

## Version notes

- **1.4.0-beta.1** adds a compact monthly workflow, expandable configuration/day details and consent-bound verification checkpoints. Session format 5 discards old previews while preserving preferences/history; no new permissions or credentials are added.

- **1.3.0-beta.1** moves the production connection to the internal web API, adds normal HiBob/SSO sign-in and direct or temporary-tab transport, and binds review to the authenticated employee/company and connection generation. Read-only preflight replaces native form staging. Adapter protocol 5 and session format 4 discard old previews while preserving preferences and booking history. The new host permission is limited to `app.hibob.com`; live API saving remains unverified.
- **1.2.3-beta.1** commits native time-picker values through actual focus and focusout transitions. Booking and the optional draft-only test share one staging routine. The test cannot invoke Save or Submit, cancels its draft and verifies unchanged attendance; a fresh scan is required afterwards. Adapter protocol 4 rejects older content scripts, while session format 3, preferences and booking history remain supported.
- **1.2.2-beta.1** matches native draft entries by their contents instead of HTML element identity. It tolerates HiBob recreating or reordering cards while adding entries and updating time fields, reuses the initial empty work draft, and checks that existing entries remain unchanged. Account confirmation, the final Save checks and persisted readback remain required. Live saving and future-day acceptance remain unverified.
- **1.2.1-beta.1** replaces the never-connected native identity reader with a production UI-context reader and explicit per-plan account confirmation. Session format and adapter protocol 3 discard old previews while retaining preferences and run history. Image URL tokens and resize parameters do not become identity data or saved settings.
- **1.2.0 (historical candidate)** invalidates booking approval before settings change, guards revisions across panels, preserves verified results when local journaling fails, restores active progress after reopening, and improves grid readiness, absence parsing and keyboard focus. Old session previews are discarded during migration; preferences and run history are retained.
- **1.2.0-beta.1 distribution preview** adds settings transfer, safe pending-update controls, an English installation/privacy site, and gated GitHub/Store release automation. The prerelease is ZIP-only; the Store is not yet available.
- **1.1.1** fixes preview comparisons after Chrome storage operations reorder object keys. Equivalent data remains valid; actual changes to days, time values or fingerprints are still rejected.
- **1.1.0** adds automatic German/English localisation and the clock-and-tick icon.
- **1.0.1** distinguishes a selected HiBob tab from a successfully read month and clears the previous tab selection and preview when the extension is opened on another website.

## Privacy and permissions

`sidePanel` provides the interface and `storage` keeps settings locally and the connection, preview and run log in Chrome's session storage. The exact `https://app.hibob.com/*` host permission allows authenticated API requests and, when needed, injection into an extension-owned temporary HiBob tab using `scripting`. `activeTab` remains available for user-initiated site context. The extension's connection policy permits that HiBob origin only; it does not request access to every website.

Chrome manages the HiBob session cookies used by authenticated requests. The extension does not collect your password, use the Chrome cookies API, or persist authentication cookies or tokens. The normal login window can use your organisation's identity provider as part of HiBob SSO. There is no project backend, telemetry or holiday lookup service. Attendance is sent only to HiBob after your explicit confirmation. Store-installed versions use Chrome's update service; release/support links visit GitHub. Settings exports include preferences and manual exclusion dates, but exclude account data, attendance snapshots, notes and history. Read the [privacy statement](docs/PRIVACY.md) for details.

## Development and testing

Use Node.js 22.12 or later. Development was checked with Node 26.

```sh
npm ci
npx playwright install chromium
npm test
npm run build
npm run test:e2e
```

`npm run check` runs tests, type checking, translation validation, the build and browser checks. `npm run build` creates `dist`, **`release/hibob-monthly-attendance.zip`**, English installation instructions, release metadata and SHA-256 checksums. Run `node scripts/verify-release.mjs` to verify that artifact against the current source. Dependency versions are locked in `package-lock.json`.

## Release and Store automation

`.github/workflows/check.yml` checks pull requests and `main`. The release workflow builds and tests a package **once**, then uses that same verified ZIP for GitHub and, when configured, the Chrome Web Store API v2. GitHub publication first uploads to a draft and verifies each asset before publishing. Unknown responses stop the process; existing differing assets are never overwritten automatically.

`docs/release-readiness.json` is the committed release gate. Stable tags must match the numeric manifest version, have reviewed validation evidence, and have no remaining blockers. Prerelease tags must also match `version_name`. The current gate is closed: **`v1.4.0` cannot be published as a stable release or submitted to the Store.** `v1.4.0-beta.1` is the ZIP-only evaluation prerelease; its automated/native evidence and artifact verification are required before publication. The explicitly configured `bootstrapTag` lets the first push to `main` create this prerelease through GitHub Actions; an existing tag is left alone. Future normal releases are triggered by version tags on commits contained in `main`.

Store submission is disabled until the developer account, real item, initial unlisted listing, service account and Workload Identity Federation have been configured. Future stable submissions then use short-lived credentials and remain subject to Google review. The pipeline serialises releases; it must be the **exclusive package publisher** while running. Do not upload another package through the Developer Dashboard during a publishing job. The API's asynchronous completion status does not expose a draft ZIP digest or draft version, so it is not a replacement for this concurrency rule.

See **[Store and distribution setup](docs/STORE_SETUP.md)** for the remaining external steps, repository variables, publication checks and recovery. Pages is not yet enabled. The Pages workflow builds the site artifact and probes repository settings with a read request. Until an administrator selects **Settings → Pages → Build and deployment → Source → GitHub Actions**, it records that one-time setup step and skips deployment. Rerun **Publish installation site** after activation. The website becomes available only after a successful deployment; the workflow does not introduce a broad administrator token to enable it.

Build the installation site locally without altering tracked files:

```sh
node scripts/build-site.mjs /tmp/hibob-installation-site
```

Start the local development server with:

```sh
npm run dev
```

Then open `http://127.0.0.1:5173/sidepanel.html?demo=1`. The clearly labelled **local test mode** simulates reading, conflicts, saving and cancellation using example data only. It sends no HiBob commands. Without `?demo=1`, the page cannot connect to HiBob outside an installed extension.

Vitest checks calendars, minute allocation, the write queue, API/session parsing and controlled transport fixtures, including account changes, expired sessions, malformed responses, cancellation and ambiguous writes. Legacy DOM fixtures remain regression evidence for older adapters; they do not exercise the production API transport. Playwright checks the interface in an isolated Chromium, including read-only preflight, account consent and 320- and 700-pixel viewport widths. Write tests use only local fixture data.

After updating `date-holidays`, run `npm run holidays:update` to regenerate the checked-in German calendar data from the locally installed package. Runtime code and data licences are listed in `THIRD_PARTY_NOTICES.txt` in the extension package. The current parser dependency reports a low-severity transitive `deepmerge` audit finding. Here it processes only bundled holiday rules, not external or user-supplied rules.

`npm run i18n:check` validates English translations for all static `t()` messages and checks that placeholders are preserved. The three English dictionaries are in `src/i18n`; German uses the source strings. Native Chrome text for the extension name, description and toolbar action is in `public/_locales/de` and `public/_locales/en`. Run `npm run icons:update` to regenerate the checked-in PNGs from the SVG. That icon-generation step requires the Chromium installed by Playwright; a normal build does not.
