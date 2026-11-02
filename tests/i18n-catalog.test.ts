import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import english from '../src/i18n/en.json';
import backend from '../src/i18n/backend-en.json';
import domain from '../src/i18n/domain-en.json';
import { localizeText, t } from '../src/i18n';

afterEach(() => vi.unstubAllGlobals());

describe('local translation assets', () => {
  it('keeps all interpolation slots intact and every translation non-empty', () => {
    const slots = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]).sort();
    for (const [source, value] of Object.entries({ ...domain, ...backend, ...english })) {
      expect(value.trim()).not.toBe('');
      expect(slots(value)).toEqual(slots(source));
    }
  });

  it('translates owned messages without modifying unknown text or parameter contents', () => {
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'en-US' } });
    expect(t('Notiz: {note}', { note: 'Mein unveränderter Vermerk {date}' })).toBe('Note: Mein unveränderter Vermerk {date}');
    expect(localizeText('Monat eingelesen')).toBe('Month read');
    expect(localizeText('Lese 2026-11-02')).toBe('Reading 2026-11-02');
    expect(localizeText('Thorsten · eigene Notiz / Urlaub')).toBe('Thorsten · eigene Notiz / Urlaub');
  });

  it('provides both Chrome metadata locales and valid raster icons without new permissions', () => {
    const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
    expect(manifest.default_locale).toBe('en');
    expect(manifest.name).toBe('__MSG_appName__');
    expect(manifest.permissions).toEqual(['sidePanel', 'storage', 'activeTab', 'scripting']);
    for (const lang of ['de', 'en']) {
      const messages = JSON.parse(readFileSync(`public/_locales/${lang}/messages.json`, 'utf8'));
      for (const key of ['appName', 'appDescription', 'actionTitle']) expect(messages[key].message.length).toBeGreaterThan(0);
    }
    for (const size of [16, 32, 48, 128]) {
      const file = readFileSync(`public/${manifest.icons[size]}`);
      expect(file.toString('hex', 0, 8)).toBe('89504e470d0a1a0a');
      expect(file.readUInt32BE(16)).toBe(size);
      expect(file.readUInt32BE(20)).toBe(size);
      expect(manifest.action.default_icon[size]).toBe(manifest.icons[size]);
    }
  });
});
