# HiBob Monthly Attendance

Prepare and book **your own HiBob attendance** in a compact Chrome side panel. Use your normal login; no API key needed. English/German follows Chrome’s language.

**[Download the 1.6.0-beta.1 prerelease](https://github.com/thors-github/hibob-chrome-extension/releases/tag/v1.6.0-beta.1)** · [Changelog](CHANGELOG.md)

## Install

Requires **Chrome 116+** and permission to edit your own attendance.

1. Download **`hibob-monthly-attendance.zip`** from Releases and extract into a permanent folder. Use the built ZIP, not the source archive.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked**, select the folder containing `manifest.json`, then open the extension.

## Book a month

1. Choose **Sign in to HiBob** and check the employee/company. No permanently open HiBob tab is required.
2. Select the month and choose **Create preview**. Click dates for entries and weekly totals. Resolve conflicts by keeping or overwriting existing entries; removing notes requires confirmation.
3. Review the changes, confirm your account and company, and start booking. Track results or stop remaining days.

## What it handles

- Compact calendar, day/week details and retention of matching entries.
- German statutory holidays, weekends, recognised absences and non-working days.
- Optional variable times with a fixed break and exact weekly targets: **40 net hours for five included workdays**.
- Flat **Settings** screens for times, holidays, booking checks, import/export and connection details. Advanced controls stay out of the everyday workflow.

## Updates and limits

For ZIP updates, export settings, finish active operations and replace files in the **same installation folder**. Click **Reload** in `chrome://extensions`, reconnect and create a fresh preview.

This is an evaluation build using **HiBob’s unsupported internal API**, which can change. Fast mode verifies the month before and after writing; the operation is **not atomic**. Writes are never automatically retried, and the monthly timesheet is never submitted. Live overwrites and the optimized writer still require native write validation.

Authentication stays in Chrome. The extension collects no passwords and provides no external backend. Attendance exports contain private data.

[Privacy](docs/PRIVACY.md) · [Distribution and validation details](docs/STORE_SETUP.md)

## Development

Use **Node 22.12+**:

```sh
npm ci
npx playwright install chromium
npm run check
npm run build
```

Load `dist` for a source installation. Browser tests use local fixtures, not real attendance.
