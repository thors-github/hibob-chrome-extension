import english from './en.json';
import backendEnglish from './backend-en.json';
import domainEnglish from './domain-en.json';

export type Language = 'de' | 'en';
export type MessageParams = Record<string, string | number>;
const translations: Record<string, string> = { ...domainEnglish, ...backendEnglish, ...english };

/** Use the Chrome UI language, not the language of the HiBob page or the OS timezone. */
export function language(): Language {
  let preferred = '';
  try {
    if (typeof chrome !== 'undefined' && typeof chrome.i18n?.getUILanguage === 'function') preferred = chrome.i18n.getUILanguage();
  } catch { /* Local browser previews use navigator.language instead. */ }
  if (!preferred && typeof navigator !== 'undefined') preferred = navigator.language;
  return /^de(?:[-_]|$)/i.test(preferred) ? 'de' : 'en';
}

export function locale(): 'de-DE' | 'en-GB' { return language() === 'de' ? 'de-DE' : 'en-GB'; }

export function t(source: string, params: MessageParams = {}): string {
  const template = language() === 'de' ? source : translations[source] ?? source;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : placeholder);
}

/** Translate extension-owned messages retained in a previous browser session.
 * Unknown text (including user notes and native HiBob values) is returned verbatim.
 */
export function localizeText(value: string): string {
  if (language() === 'de') return value;
  if (Object.prototype.hasOwnProperty.call(translations, value)) return translations[value];
  // Legacy interpolated messages are matched against complete owned templates;
  // placeholders retain their contents instead of translating user-supplied text.
  for (const [source, translated] of Object.entries(translations)) {
    if (!source.includes('{')) continue;
    const names: string[] = [];
    let cursor = 0;
    let pattern = '^';
    for (const match of source.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
      pattern += escapeRegExp(source.slice(cursor, match.index)) + '([\\s\\S]+?)';
      names.push(match[1]);
      cursor = match.index! + match[0].length;
    }
    pattern += escapeRegExp(source.slice(cursor)) + '$';
    const match = new RegExp(pattern).exec(value);
    if (match) return translated.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
      const index = names.indexOf(name);
      return index >= 0 ? match[index + 1] : placeholder;
    });
  }
  return value;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
