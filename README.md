# HiBob Monthly Attendance

A Chrome extension for preparing and recording your own HiBob attendance for an entire month. Review work periods and breaks before saving them through HiBob’s normal forms, using your existing login. No API key is required. The extension interface is available in English and German.

**Version 1.2.1-beta.1:** the existing HiBob login is supported through explicit account confirmation for each booking plan. A valid preview opens the final review, where you confirm that the attendance page belongs to your own account and company. Visible account markers and the browser document are checked again before writing. This is manual confirmation of the reviewed page, not automatic verification of an immutable employee ID. Actual saving in a live account remains unverified.

**[Download from GitHub releases](https://github.com/thors-github/hibob-chrome-extension/releases)** · **[Privacy](docs/PRIVACY.md)**

The installation website is prepared but not deployed yet. Use the installation instructions below until GitHub Pages is enabled.

The planned Chrome Web Store distribution is **unlisted**: anyone with its Store link will be able to install it. **There is no published Store listing yet.** The installation site's Store button stays disabled until the real published URL is configured. The public GitHub repository hosts source code and built ZIP releases. Its first automated distribution release is `v1.2.1-beta.1`, a prerelease with per-plan manual account confirmation. Live acceptance by the assistant covers reading, previews and the confirmation dialog only.

## Installation

Requirements: Google Chrome 116 or later and a signed-in HiBob account that allows you to edit your own attendance.

1. Choose a clearly labelled release from [GitHub releases](https://github.com/thors-github/hibob-chrome-extension/releases). New releases provide **`hibob-monthly-attendance.zip`**; older releases may use a versioned filename. Download the built extension ZIP and extract it into a folder you intend to keep. Chrome cannot install this ZIP directly. GitHub's generated **Source code** archives require a build first.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder containing `manifest.json`. If installing from source, first run `npm ci` and `npm run build`, then select the generated `dist` folder. Build output is not included in the source repository.
4. Open `https://app.hibob.com/home` or **Time → My attendance** in Chrome.
5. Select **HiBob Monthly Attendance** from Chrome’s extensions menu. Its side panel opens. You can also pin the extension to the toolbar.

This ZIP path is a manual installation. Once the Store listing is published, the installation page will also offer **Install from Chrome Web Store**, followed by Chrome's own installation confirmation. Ordinary macOS and Windows Chrome installations cannot use a GitHub-hosted CRX as an independent native auto-update channel. See [Chrome's distribution rules](https://developer.chrome.com/docs/extensions/how-to/distribute).

### Updates and moving to the Store

- **ZIP installation:** export your preferences first, finish any active operation, and replace the files in the **same installation folder**. Click **Reload** in `chrome://extensions`, reload HiBob, and read the month again. There is no silent ZIP self-updater and no GitHub token is stored in the extension.
- **Store installation, after publication:** Chrome downloads approved Store updates automatically. A new GitHub release is not itself a Store update; Google must approve and publish that version. The panel displays a downloaded update and offers **Update now** only when no scan or booking is active. An interrupted operation must be resolved by reading the month again before applying an update. The extension does not poll `requestUpdateCheck()` on a timer.
- **One-time ZIP-to-Store migration:** choose **Export settings** in the old copy, install the real Store copy, choose **Import settings**, and confirm replacement of preferences. Disable the old copy so both do not run together. The Store copy normally has a different extension ID and separate storage. Attendance snapshots, previews and run history are excluded from the settings backup; read the month again.

Chrome can also update after the extension becomes idle or the browser restarts. An open side panel can delay idle updates. No workflow promises to prevent a browser restart, enterprise intervention or a crash. Interrupted writes never resume automatically. See [Chrome's update lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle).

If the panel says **Select a HiBob tab**, click the extension icon while viewing HiBob. The status changes to **HiBob tab selected**, with an instruction to **Read month**. A successful scan changes it to **Month read**. Opening the extension on another website clears the previous tab selection and preview.

After choosing a different month, the panel asks you to read that selected month. A previous scan does not approve a new month. If saving settings or session state fails, booking remains blocked: use the displayed retry action after the storage issue is resolved. Retrying the same settings preserves the generated time distribution.

## Usage

1. Choose a month, German federal state, work times and break. Defaults are Hesse, Monday to Friday, **08:00–16:30**, with a **12:00–12:30** break.
2. Click **Read month**. HiBob must offer the selected month in its period selector. If starting from HiBob’s home page, the extension opens your own attendance page. Finish or cancel any other open HiBob forms yourself first.
3. Review the complete monthly preview. Weekends, public holidays, recognised non-working days, and full or partial absences are excluded. You can exclude additional dates using the day checkboxes or date list.
4. Open **Review existing entries** and choose whether to skip or overwrite each affected day. Bulk choices are available. Additional details are shown, and removing existing notes requires explicit confirmation.
5. Click **Book now** to review the final summary. Check the HiBob page on the left and explicitly confirm that it shows your own attendance for the selected month in the correct company account. The checkbox starts unchecked every time; closing the dialog or changing the plan discards its consent. Only **Start booking** saves attendance. The extension then reopens each saved day and checks its persisted segments and hours.

Keep the HiBob tab open while reading or saving attendance, and avoid editing it manually at the same time. **Cancel** stops before the next save; a save already in progress is still verified. Previously confirmed days are not rolled back. After completion, cancellation or an error, read the month again before starting another run. The extension never clicks HiBob’s **Submit** button to submit a timesheet.

Reopening the panel during a scan or booking run shows the active operation and its cancel control. Restarting Chrome or its extension worker never resumes writes automatically. Interrupted operations require a fresh scan. If a saved day was read back successfully but writing the local run log then fails, it stays labelled as verified for the current session and the run stops. After a restart, an older persisted log may instead require checking that day again.

If a scan finished while another panel was opening, **Create preview** prepares a review from the stored scan without reading the month again. **Retry connection** retries failed initialization; it does not start a booking or reset saved run history.

## Variable times

The optional variable-times mode adjusts start and end times in whole minutes. The default range is **±5 minutes**, configurable from 0 to 30 minutes. Break times stay fixed. The weekly target is eight net hours per included weekday: five days give **40 hours**, and four days give **32 hours**. Month boundaries and excluded days are handled proportionally; dates outside the selected month are never changed.

Existing entries that you keep count towards the target using their actual hours. The remaining days compensate for the difference within the permitted time ranges. Saving is blocked if the target is unreachable, existing data is incomplete, or conflict decisions remain unresolved. Different daily durations are generated when the configured limits allow them. The preview stays stable until you choose **Redistribute** or change settings or decisions. Check that the generated times reflect the attendance you actually need to record before saving.

For example, HiBob receives three separate entries: **Work 08:00–12:00**, **Break 12:00–12:30**, and **Work 12:30–16:30**. A break is not inserted inside an overlapping, continuous work entry.

## Public holidays

All 16 German federal states are supported using locally bundled German calendar data from [date-holidays](https://github.com/commenthol/date-holidays). Only statutory public holidays (`public`) are excluded automatically. Christmas Eve and New Year’s Eve are not automatically treated as non-working days. Use manual exclusions for company closures.

Bavaria requires additional choices for the local holiday in Augsburg and the Assumption of Mary at the place of work. Saxony and Thuringia require a choice for locally applicable Corpus Christi holidays. These settings refer to the **place of work**. Reference sources: [Hesse’s public holidays](https://innen.hessen.de/buerger-staat/feiertage), [Bavarian municipality lookup](https://www.statistik.bayern.de/statistik/gebiet_bevoelkerung/zensus/himmelfahrt/index.php), and [Saxony’s Corpus Christi regulation](https://www.revosax.sachsen.de/vorschrift/4142-FronleichnamsVO). Historical holiday accuracy is not guaranteed for arbitrary earlier decades.

## Language and icon

Since version **1.1.0**, the extension automatically follows **Chrome’s interface language**. German locales (`de`, including `de-DE`, `de-AT` and `de-CH`) use German; English and all other browser languages use English. During local development without extension APIs, `navigator.language` determines the language. No manual language selection is needed. Names, notes, time values and other original HiBob data are not translated.

Forms, monthly previews, dialogs, statuses, errors, holiday names, federal-state names and date labels are localised. Both languages use German holiday calendars, 24-hour time inputs and the `Europe/Berlin` time zone. This localisation applies to the extension; the HiBob adapter continues to support the observed English HiBob interface.

The icon combines a gold clock with a green confirmation tick. Its editable source is `public/icons/app-icon.svg`. PNG exports at 16, 32, 48 and 128 pixels are used by Chrome’s toolbar and extension manager. The side panel and browser tab use the same design. A 512-pixel export is also included for previews.

## Compatibility and limitations

- The adapter was checked against the observed **English HiBob interface**, using `DD/MM/YYYY` dates and 24-hour start/end times. It stops with a message if the interface changes or required columns are missing. Holidays, absences, start/end times, hours, reasons, notes and projects must be shown in HiBob for the scan. Enlarge the browser window or scroll horizontally if needed.
- Booking requires explicit consent for the unchanged plan and the same readable page context. The current integration compares the My account avatar, the attendance-header avatar and the company image as change markers. Missing, hidden, ambiguous, unsupported or inconsistent markers block writing. A profile image and company image must be available in the observed English HiBob layout. Reloading HiBob invalidates earlier consent. Image resources are not employee IDs: identical visible markers or an account switch not yet reflected in the page can escape this comparison. Check the actual account and company before confirming.
- Reported hours must be readable and agree exactly with complete work and break entries. An unknown format, unsupported marker or inconsistent day blocks the plan until it is checked or explicitly excluded. Such a day does not silently reduce a variable week's target. Meaningful absence labels on buttons, links and chips are retained.
- A changed period label alone does not mean its table has finished loading. The reader waits for complete, stable month data and stops with a loading error on timeout. Virtual rows are revealed using measured scroll positions rather than assuming equal row heights.
- Overwriting edits existing segments in the day’s form and adds missing ones. If replacement would require removing saved work or break segments individually, the day is stopped before saving. Individual deletion behaviour has not been verified on the real account, so the extension does not delete persisted segments individually. Amend the affected day manually if necessary, then read the month again.
- Existing notes can be removed after confirmation. Reasons that cannot be safely removed, project assignments and unknown entry types are reported as unsupported. An already open day editor is neither taken over nor discarded.
- Only monthly periods offered by HiBob and available for editing can be used. Future days can be prepared, but HiBob may reject them depending on its policy. The public API has different access requirements and excludes future attendance entries; this extension does not use it. See the [HiBob Attendance documentation](https://apidocs.hibob.com/docs/explore-attendance-api).
- **Production saving has not yet been verified:** the signed-in account was used to inspect the table structure, period selector, day view and unsaved input forms. No real attendance entries were saved. Production saving and acceptance of future days therefore remain unverified on the real account. The first live write test should use one deliberately selected day.
- **Live acceptance with version 1.2.1-beta.1:** the existing unpacked installation was backed up and updated in place. November 2026 read all 30 dates, with 21 workdays, 168 net hours and nine weekend exclusions. The UI context was recognised. Book now opened the account confirmation dialog; Start booking remained disabled until its checkbox was checked. Closing and reopening reset consent. The final booking action was not clicked and HiBob remained at zero payable hours.
- **Live read-only test with version 1.1.1:** the installed extension read all 30 days of November 2026 in Chrome. Its preview showed 21 workdays, 168 net hours and nine excluded weekend days. Variable times and redistribution kept full weeks at exactly 40 hours. Excluding one workday reduced its week to 32 hours and the month to 160 hours; selecting it again restored 168 hours. The preview remained after closing and reopening the panel. This test saved no attendance in HiBob.
- A month is saved one day at a time, rather than as a server transaction. Errors or ambiguous responses stop the run. Already saved days remain, and an incomplete run may not meet the weekly target. After an error, check the actual HiBob entries and read the month again. There is no automatic retry.

## Version notes

- **1.2.1-beta.1** replaces the never-connected native identity reader with a production UI-context reader and explicit per-plan account confirmation. Session format and adapter protocol 3 discard old previews while retaining preferences and run history. Image URL tokens and resize parameters do not become identity data or saved settings.
- **1.2.0 (historical candidate)** invalidates booking approval before settings change, guards revisions across panels, preserves verified results when local journaling fails, restores active progress after reopening, and improves grid readiness, absence parsing and keyboard focus. Old session previews are discarded during migration; preferences and run history are retained.
- **1.2.0-beta.1 distribution preview** adds settings transfer, safe pending-update controls, an English installation/privacy site, and gated GitHub/Store release automation. The prerelease is ZIP-only; the Store is not yet available.
- **1.1.1** fixes preview comparisons after Chrome storage operations reorder object keys. Equivalent data remains valid; actual changes to days, time values or fingerprints are still rejected.
- **1.1.0** adds automatic German/English localisation and the clock-and-tick icon.
- **1.0.1** distinguishes a selected HiBob tab from a successfully read month and clears the previous tab selection and preview when the extension is opened on another website.

## Privacy and permissions

`activeTab` and `scripting` allow interaction with the HiBob tab you explicitly activate. `sidePanel` provides the interface. `storage` keeps settings locally and stores the preview and run log in Chrome’s session storage. Credentials and cookies are not read. There is no backend, telemetry, holiday lookup service or third-party runtime service. The extension operates only on your own HiBob attendance page. HiBob’s normal form sends the attendance entries you confirm to HiBob. Store-installed versions use Chrome's update service; opening a release link visits GitHub. Settings exports contain preferences, including any manually excluded dates, but exclude account data, attendance snapshots, notes and history. Read the [privacy statement](docs/PRIVACY.md) for retention and hosting details.

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

`docs/release-readiness.json` is the committed release gate. Stable tags must match the numeric manifest version, have reviewed validation evidence, and have no remaining blockers. Prerelease tags must also match `version_name`. The current gate is closed: **`v1.2.1` cannot be published as a stable release or submitted to the Store.** `v1.2.1-beta.1` is allowed as a ZIP-only prerelease; its manual-confirmation flow is enabled, while actual live saving remains unverified. The explicitly configured `bootstrapTag` lets the first push to `main` create this prerelease through GitHub Actions; an existing tag is left alone. Future normal releases are triggered by version tags on commits contained in `main`.

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

Vitest checks calendars, minute allocation, the write queue and a local HiBob DOM fixture, including virtualised rows, saved segments, invalid times, cancellation and ambiguous responses. Playwright checks the interface in an isolated Chromium, including 320- and 700-pixel viewport widths. Write tests use only local fixture data.

After updating `date-holidays`, run `npm run holidays:update` to regenerate the checked-in German calendar data from the locally installed package. Runtime code and data licences are listed in `THIRD_PARTY_NOTICES.txt` in the extension package. The current parser dependency reports a low-severity transitive `deepmerge` audit finding. Here it processes only bundled holiday rules, not external or user-supplied rules.

`npm run i18n:check` validates English translations for all static `t()` messages and checks that placeholders are preserved. The three English dictionaries are in `src/i18n`; German uses the source strings. Native Chrome text for the extension name, description and toolbar action is in `public/_locales/de` and `public/_locales/en`. Run `npm run icons:update` to regenerate the checked-in PNGs from the SVG. That icon-generation step requires the Chromium installed by Playwright; a normal build does not.
