# HiBob Monthly Attendance

Prepare, book and submit **your own HiBob attendance** in a compact Chrome side panel. Use your normal login; no API key needed. English/German follows Chrome’s language.

**[Download the 1.7.0-beta.1 prerelease](https://github.com/thors-github/hibob-chrome-extension/releases/tag/v1.7.0-beta.1)** · [Changelog](CHANGELOG.md)

## Install

Requires **Chrome 116+** and permission to edit your own attendance.

1. Download **`hibob-monthly-attendance.zip`** from Releases and extract into a permanent folder. Use the built ZIP, not the source archive.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked**, select the folder containing `manifest.json`, then open the extension.

## Book a month

1. Choose **Sign in to HiBob** and check the employee/company. No permanently open HiBob tab is required.
2. Select the month and choose **Create preview**. Click dates for entries and weekly totals. Resolve conflicts by keeping or overwriting existing entries; removing notes requires confirmation.
3. Review the changes, confirm your account and company, and start booking. Track results or stop remaining days.

## Submit saved attendance

A red badge and a compact panel notice remind you in the **last seven calendar days** of each month, using **Europe/Berlin**. November starts on **24 November**. Pending months remain after month-end; opening the panel does not dismiss them. Tracking begins with the first connected usage month in this version. Older months can be reviewed manually.

1. Choose **Review month submission** from the reminder, or **Settings → Booking and checks → Submit month** for the selected month.
2. Check the freshly read account, company, saved net hours and HiBob status. Resolve unsaved plans, gaps, incomplete entries and other reported issues first.
3. Explicitly confirm the account/company and saved month, then choose **Submit November now** (or the selected month). This submits only saved attendance; it never creates additional entries.

A single Submit request is followed by independent status and attendance readback. Only confirmed **Submitted**, **Awaiting project approval** or **Approved** results clear the reminder. If the outcome is unclear, review the status again; the extension never retries Submit automatically. Another month cannot be submitted until an unclear earlier submission is resolved. Changes after submission may need reopening or approval in HiBob.

Reminders are enabled by default and can be disabled under **Booking and checks**. While any months are due, passive checks use the existing login at most hourly. They never open tabs or login windows. Offline or expired-login status stays marked **Check submission status**. The badge count includes due months for the connected account only; no desktop notifications are requested.

The ordinary own-account `WaitingForSubmission` and `Rejected` states are supported when HiBob explicitly permits submission. **Early submission while the sheet is `Open` stays blocked**: the policy setting alone does not prove the native feature-toggle permission. Use HiBob directly for early submission, break violations or unsupported conditions. The extension cannot approve, reopen or submit on another person's behalf. Live Submit acceptance is deliberately not part of read-only validation.

## What it handles

- Compact calendar, day/week details and retention of matching entries.
- German statutory holidays, weekends, recognised absences and non-working days.
- Optional variable times with a fixed break and exact weekly targets: **40 net hours for five included workdays**.
- Flat **Settings** screens for times, holidays, booking checks, import/export and connection details. Advanced controls stay out of the everyday workflow.

## Updates and limits

For ZIP updates, export settings, finish active operations and replace files in the **same installation folder**. Click **Reload** in `chrome://extensions`, reconnect and create a fresh preview.

This is an evaluation build using **HiBob’s unsupported internal API**, which can change. Fast mode verifies the month before and after writing; the operation is **not atomic**. Writes are never automatically retried. Month submission is a separate, explicitly confirmed operation with its own journal and readback. Live overwrites and the optimized writer still require native write validation.

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
