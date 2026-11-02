import { validateSettings } from '../domain/index';
import { t } from '../i18n/index';
import type { Settings } from './types';

export const SETTINGS_BACKUP_APP = 'hibob-monthly-attendance-settings';
export const MAX_SETTINGS_BACKUP_BYTES = 64 * 1024;

export interface SettingsBackup {
  app: typeof SETTINGS_BACKUP_APP;
  schemaVersion: 1;
  settings: Settings;
}

const settingsKeys = ['month', 'state', 'start', 'end', 'useBreak', 'breakStart', 'breakEnd', 'variable', 'variationMinutes', 'excludedDates', 'localHolidays'] as const;
const holidayKeys = ['augsburg', 'assumption', 'corpusChristi'] as const;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function checkedSettings(value: unknown): Settings {
  if (!object(value) || !exactKeys(value, settingsKeys)
    || !['month', 'state', 'start', 'end', 'breakStart', 'breakEnd'].every(key => typeof value[key] === 'string')
    || typeof value.useBreak !== 'boolean' || typeof value.variable !== 'boolean'
    || typeof value.variationMinutes !== 'number'
    || !Array.isArray(value.excludedDates) || !value.excludedDates.every(date => typeof date === 'string')
    || !object(value.localHolidays) || !exactKeys(value.localHolidays, holidayKeys)
    || !holidayKeys.every(key => value.localHolidays && object(value.localHolidays) && (typeof value.localHolidays[key] === 'boolean' || value.localHolidays[key] === null))) {
    throw new Error(t('Die Datei enthält keine gültigen Einstellungen.'));
  }
  // Build a new allowlisted value; account data, scan records and run history
  // are never part of a settings backup, even if present on an input object.
  const settings = projectSettings(value as unknown as Settings);
  const errors = validateSettings(settings);
  if (!/^\d{2}:\d{2}$/.test(settings.breakStart) || !/^\d{2}:\d{2}$/.test(settings.breakEnd)
    || ![settings.breakStart, settings.breakEnd].every(time => Number(time.slice(0, 2)) < 24 && Number(time.slice(3)) < 60)) {
    errors.push(t('Die Datei enthält keine gültigen Einstellungen.'));
  }
  if (errors.length) throw new Error(t('Die Einstellungen sind ungültig: {error}', { error: errors.join(' ') }));
  settings.excludedDates = [...new Set(settings.excludedDates)].sort();
  return settings;
}

function projectSettings(settings: Settings): Settings {
  return {
    month: settings.month, state: settings.state, start: settings.start, end: settings.end,
    useBreak: settings.useBreak, breakStart: settings.breakStart, breakEnd: settings.breakEnd,
    variable: settings.variable, variationMinutes: settings.variationMinutes,
    excludedDates: [...settings.excludedDates],
    localHolidays: { augsburg: settings.localHolidays.augsburg, assumption: settings.localHolidays.assumption, corpusChristi: settings.localHolidays.corpusChristi },
  };
}

export function serializeSettingsBackup(settings: Settings): string {
  const backup: SettingsBackup = { app: SETTINGS_BACKUP_APP, schemaVersion: 1, settings: checkedSettings(projectSettings(settings)) };
  const text = `${JSON.stringify(backup, null, 2)}\n`;
  if (new TextEncoder().encode(text).length > MAX_SETTINGS_BACKUP_BYTES) throw new Error(t('Die Einstellungsdatei darf höchstens 64 KB groß sein.'));
  return text;
}

export function parseSettingsBackup(text: string): Settings {
  if (new TextEncoder().encode(text).length > MAX_SETTINGS_BACKUP_BYTES) throw new Error(t('Die Einstellungsdatei darf höchstens 64 KB groß sein.'));
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(t('Die Datei enthält kein gültiges JSON.')); }
  if (!object(value) || !exactKeys(value, ['app', 'schemaVersion', 'settings']) || value.app !== SETTINGS_BACKUP_APP || value.schemaVersion !== 1) {
    throw new Error(t('Diese Datei ist keine unterstützte HiBob-Einstellungssicherung.'));
  }
  return checkedSettings(value.settings);
}
