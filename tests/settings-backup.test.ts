import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/domain/index';
import { MAX_SETTINGS_BACKUP_BYTES, parseSettingsBackup, serializeSettingsBackup } from '../src/shared/settings-backup';

describe('settings-only migration backups', () => {
  it('round-trips preferences and allowlists the export without account or attendance records', () => {
    const settings = { ...defaultSettings('2026-11'), variable: true, excludedDates: ['2026-11-05'], employeeLabel: 'Private name', snapshot: { days: ['private'] }, run: { status: 'running' } };
    const json = serializeSettingsBackup(settings);
    expect(parseSettingsBackup(json)).toEqual({
      ...defaultSettings('2026-11'), variable: true, excludedDates: ['2026-11-05'],
    });
    expect(JSON.parse(json)).toMatchObject({ app: 'hibob-monthly-attendance-settings', schemaVersion: 1 });
    expect(json).not.toMatch(/"(?:employeeLabel|snapshot|run|days)"|Private name/);
  });

  it('rejects another app, incompatible schemas and unexpected embedded data', () => {
    const backup = JSON.parse(serializeSettingsBackup(defaultSettings('2026-11')));
    for (const changed of [{ ...backup, app: 'other' }, { ...backup, schemaVersion: 2 }, { ...backup, snapshot: {} }, { ...backup, settings: { ...backup.settings, employeeKey: 'private' } }]) {
      expect(() => parseSettingsBackup(JSON.stringify(changed))).toThrow();
    }
  });

  it('rejects malformed JSON and oversized files before using their settings', () => {
    expect(() => parseSettingsBackup('{')).toThrow('JSON');
    expect(() => parseSettingsBackup(' '.repeat(MAX_SETTINGS_BACKUP_BYTES + 1))).toThrow('64 KB');
  });

  it('validates settings types, dates, time bounds and local-holiday decisions', () => {
    const valid = JSON.parse(serializeSettingsBackup(defaultSettings('2026-11')));
    const bad = [
      { variationMinutes: 31 }, { useBreak: 'yes' }, { state: 'XX' }, { start: '08:99' },
      { excludedDates: ['2026-02-30'] }, { localHolidays: { augsburg: false, assumption: 1, corpusChristi: null } },
      { state: 'BY' }, { useBreak: false, breakEnd: '99:99' }, { month: '2101-01' },
    ];
    for (const fields of bad) expect(() => parseSettingsBackup(JSON.stringify({ ...valid, settings: { ...valid.settings, ...fields } }))).toThrow();
  });

  it('preserves regional choices and de-duplicates excluded days', () => {
    const settings = { ...defaultSettings('2026-11'), state: 'BY', localHolidays: { augsburg: false, assumption: true, corpusChristi: null }, excludedDates: ['2026-11-09', '2026-11-05', '2026-11-09'] };
    const restored = parseSettingsBackup(serializeSettingsBackup(settings));
    expect(restored.localHolidays).toEqual(settings.localHolidays);
    expect(restored.excludedDates).toEqual(['2026-11-05', '2026-11-09']);
  });
});
