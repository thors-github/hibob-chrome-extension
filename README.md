# HiBob Monthly Attendance

A Chrome extension for preparing and recording your own HiBob attendance for an entire month. Review work periods and breaks before saving them through HiBob’s normal forms, using your existing login. No API key is required. The extension interface is available in English and German.

**[Download the latest release](https://github.com/thors-github/hibob-chrome-extension/releases/latest)** to install the extension. Extract the release ZIP, then use Chrome’s **Load unpacked** option to select the extracted folder containing `manifest.json`.

## Installation

Requirements: Google Chrome 116 or later and a signed-in HiBob account that allows you to edit your own attendance.

1. Download the extension ZIP from the [latest GitHub release](https://github.com/thors-github/hibob-chrome-extension/releases/latest) and extract it into a folder you intend to keep. Chrome cannot install this ZIP directly.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder containing `manifest.json`. If installing from source, first run `npm ci` and `npm run build`, then select the generated `dist` folder. Build output is not included in the source repository.
4. Open `https://app.hibob.com/home` or **Time → My attendance** in Chrome.
5. Select **HiBob Monthly Attendance** from Chrome’s extensions menu. Its side panel opens. You can also pin the extension to the toolbar.

The extension is installed locally and is not published in the Chrome Web Store. To update a ZIP installation, replace the contents of its installation folder with the extracted files from the new release. Click **Reload** for the extension in `chrome://extensions`, reload the HiBob tab, and open the extension again from that tab. Follow the same reload steps after a new source build.

If the panel says **Select a HiBob tab**, click the extension icon while viewing HiBob. The status changes to **HiBob tab selected**, with an instruction to **Read month**. A successful scan changes it to **Month read**. Opening the extension on another website clears the previous tab selection and preview.

## Usage

1. Choose a month, German federal state, work times and break. Defaults are Hesse, Monday to Friday, **08:00–16:30**, with a **12:00–12:30** break.
2. Click **Read month**. HiBob must offer the selected month in its period selector. If starting from HiBob’s home page, the extension opens your own attendance page. Finish or cancel any other open HiBob forms yourself first.
3. Review the complete monthly preview. Weekends, public holidays, recognised non-working days, and full or partial absences are excluded. You can exclude additional dates using the day checkboxes or date list.
4. Open **Review existing entries** and choose whether to skip or overwrite each affected day. Bulk choices are available. Additional details are shown, and removing existing notes requires explicit confirmation.
5. Click **Book now** to review the final summary. Only **Start booking** saves attendance. The extension then reopens each saved day and checks its persisted segments and hours.

Keep the HiBob tab open while reading or saving attendance, and avoid editing it manually at the same time. **Cancel** stops before the next save; a save already in progress is still verified. Previously confirmed days are not rolled back. After completion, cancellation or an error, read the month again before starting another run. The extension never clicks HiBob’s **Submit** button to submit a timesheet.

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
- Overwriting edits existing segments in the day’s form and adds missing ones. If replacement would require removing saved work or break segments individually, the day is stopped before saving. Individual deletion behaviour has not been verified on the real account, so the extension does not delete persisted segments individually. Amend the affected day manually if necessary, then read the month again.
- Existing notes can be removed after confirmation. Reasons that cannot be safely removed, project assignments and unknown entry types are reported as unsupported. An already open day editor is neither taken over nor discarded.
- Only monthly periods offered by HiBob and available for editing can be used. Future days can be prepared, but HiBob may reject them depending on its policy. The public API has different access requirements and excludes future attendance entries; this extension does not use it. See the [HiBob Attendance documentation](https://apidocs.hibob.com/docs/explore-attendance-api).
- **Production saving has not yet been verified:** the signed-in account was used to inspect the table structure, period selector, day view and unsaved input forms. No real attendance entries were saved. Production saving and acceptance of future days therefore remain unverified on the real account. The first live write test should use one deliberately selected day.
- **Live read-only test with version 1.1.1:** the installed extension read all 30 days of November 2026 in Chrome. Its preview showed 21 workdays, 168 net hours and nine excluded weekend days. Variable times and redistribution kept full weeks at exactly 40 hours. Excluding one workday reduced its week to 32 hours and the month to 160 hours; selecting it again restored 168 hours. The preview remained after closing and reopening the panel. This test saved no attendance in HiBob.
- A month is saved one day at a time, rather than as a server transaction. Errors or ambiguous responses stop the run. Already saved days remain, and an incomplete run may not meet the weekly target. After an error, check the actual HiBob entries and read the month again. There is no automatic retry.

## Version notes

- **1.1.1** fixes preview comparisons after Chrome storage operations reorder object keys. Equivalent data remains valid; actual changes to days, time values or fingerprints are still rejected.
- **1.1.0** adds automatic German/English localisation and the clock-and-tick icon.
- **1.0.1** distinguishes a selected HiBob tab from a successfully read month and clears the previous tab selection and preview when the extension is opened on another website.

## Privacy and permissions

`activeTab` and `scripting` allow interaction with the HiBob tab you explicitly activate. `sidePanel` provides the interface. `storage` keeps settings locally and stores the preview and run log in Chrome’s session storage. Credentials and cookies are not read. There is no backend, telemetry, holiday lookup service or third-party runtime service. The extension operates only on your own HiBob attendance page. HiBob’s normal form sends the attendance entries you confirm to HiBob.

## Development and testing

Use Node.js 22.12 or later. Development was checked with Node 26.

```sh
npm ci
npx playwright install chromium
npm test
npm run build
npm run test:e2e
```

`npm run check` runs tests, type checking, translation validation, the build and browser checks. `npm run build` creates `dist` and `release/hibob-monatsbuchung-1.1.1.zip`. Dependency versions are locked in `package-lock.json`.

Start the local development server with:

```sh
npm run dev
```

Then open `http://127.0.0.1:5173/sidepanel.html?demo=1`. The clearly labelled **local test mode** simulates reading, conflicts, saving and cancellation using example data only. It sends no HiBob commands. Without `?demo=1`, the page cannot connect to HiBob outside an installed extension.

Vitest checks calendars, minute allocation, the write queue and a local HiBob DOM fixture, including virtualised rows, saved segments, invalid times, cancellation and ambiguous responses. Playwright checks the interface in an isolated Chromium, including 320- and 700-pixel viewport widths. Write tests use only local fixture data.

After updating `date-holidays`, run `npm run holidays:update` to regenerate the checked-in German calendar data from the locally installed package. Runtime code and data licences are listed in `THIRD_PARTY_NOTICES.txt` in the extension package. The current parser dependency reports a low-severity transitive `deepmerge` audit finding. Here it processes only bundled holiday rules, not external or user-supplied rules.

`npm run i18n:check` validates English translations for all static `t()` messages and checks that placeholders are preserved. The three English dictionaries are in `src/i18n`; German uses the source strings. Native Chrome text for the extension name, description and toolbar action is in `public/_locales/de` and `public/_locales/en`. Run `npm run icons:update` to regenerate the checked-in PNGs from the SVG. That icon-generation step requires the Chromium installed by Playwright; a normal build does not.
