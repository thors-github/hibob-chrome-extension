import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const paths = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8' }).trim().split('\n').filter(p => p && p !== process.cwd());
// date-holidays supplies the committed DE data even when used only as an update tool.
paths.push(resolve('node_modules/date-holidays'));
const sections = [
  'THIRD-PARTY NOTICES — HiBob Monthly Attendance',
  'German holiday data: date-holidays (commenthol and contributors). Germany-only extraction, holiday rules unchanged.\nSource: https://github.com/commenthol/date-holidays/blob/master/data/countries/DE.yaml\nAttribution: https://de.wikipedia.org/wiki/Feiertage_in_Deutschland\nData license: CC BY-SA 3.0 — https://creativecommons.org/licenses/by-sa/3.0/\nThe source extraction is included as holidays-de.json in this distribution.',
];
for (const path of [...new Set(paths)].sort()) {
  const pkg = JSON.parse(await readFile(`${path}/package.json`, 'utf8'));
  const files = (await readdir(path)).filter(name => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(name));
  if (!files.length) throw new Error(`License text missing for ${pkg.name}`);
  const texts = await Promise.all(files.map(file => readFile(`${path}/${file}`, 'utf8')));
  sections.push(`${pkg.name} ${pkg.version}\n${pkg.homepage || pkg.repository?.url || ''}\n${texts.join('\n')}`);
}
await writeFile('public/THIRD_PARTY_NOTICES.txt', sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
