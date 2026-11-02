/**
 * Regenerate committed German holiday data after upgrading date-holidays.
 * This script reads the locally installed package; it makes no network calls.
 *
 * Upstream data license, verbatim from date-holidays/LICENSE:
 * The data contained in `holidays.yaml` is available under CC BY-SA 3.0
 * <http://creativecommons.org/licenses/by-sa/3.0/> as the data obtained
 * relies on wikipedia articles.
 * The required attribution can be found inside the file.
 *
 * Data is a Germany-only extraction; holiday rules are unchanged. Preserve the
 * license, source and attribution in the JSON and THIRD_PARTY_NOTICES.txt.
 */
import { data } from 'date-holidays/data';
import { writeFile } from 'node:fs/promises';

if (!data.holidays.DE || Object.keys(data.holidays.DE.states).length !== 16) {
  throw new Error('Expected German holiday data with all 16 states.');
}
const nameKeys = new Set(['substitutes']);
function collectNames(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value._name === 'string') nameKeys.add(value._name);
  for (const item of Object.values(value)) collectNames(item);
}
collectNames(data.holidays.DE);

const subset = {
  version: data.version,
  license: data.license,
  source: 'https://github.com/commenthol/date-holidays/blob/master/data/countries/DE.yaml',
  attribution: [
    'date-holidays, Copyright (c) 2015-present commenthol and contributors',
    'https://de.wikipedia.org/wiki/Feiertage_in_Deutschland',
    'https://creativecommons.org/licenses/by-sa/3.0/',
    'Germany-only extraction; holiday rules unchanged.',
  ],
  holidays: { DE: data.holidays.DE },
  names: Object.fromEntries([...nameKeys].filter(key => data.names[key]).map(key => [key, data.names[key]])),
};
await writeFile(new URL('../src/domain/holidays-de.json', import.meta.url), `${JSON.stringify(subset, null, 2)}\n`);
console.log(`German holiday data ${subset.version}: 16 states, ${Object.keys(subset.names).length} referenced names.`);
