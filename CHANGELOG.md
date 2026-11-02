# Changelog

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
