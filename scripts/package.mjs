import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
await writeFile('dist/README.md', await readFile('README.md'));
await writeFile('dist/holidays-de.json', await readFile('src/domain/holidays-de.json'));
for (const path of [manifest.background.service_worker, manifest.side_panel.default_path, 'content.js']) {
  await readFile(`dist/${path}`);
}
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  const png = await readFile(`dist/${path}`);
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== Number(size) || png.readUInt32BE(20) !== Number(size)) throw new Error(`Invalid ${size}px extension icon.`);
}
for (const locale of ['de', 'en']) {
  const messages = JSON.parse(await readFile(`dist/_locales/${locale}/messages.json`, 'utf8'));
  if (!messages.appName?.message || !messages.appDescription?.message || !messages.actionTitle?.message) throw new Error(`Missing ${locale} Chrome locale messages.`);
}
if (manifest.host_permissions || manifest.permissions.some(p => !['sidePanel', 'storage', 'activeTab', 'scripting'].includes(p))) throw new Error('Unexpected permissions in the manifest.');
await mkdir('release', { recursive: true });
const target = resolve(`release/hibob-monatsbuchung-${manifest.version}.zip`);
// Delete the old archive first so removed files cannot linger in an incremental ZIP.
const { rm } = await import('node:fs/promises');
await rm(target, { force: true });
execFileSync('zip', ['-q', '-r', target, '.'], { cwd: resolve('dist') });
await writeFile('release/INSTALLATION.txt', `HiBob Monthly Attendance ${manifest.version}\n\n1. Download the extension ZIP from https://github.com/thors-github/hibob-chrome-extension/releases/latest and extract it into a permanent folder.\n2. Open chrome://extensions in Chrome and enable Developer mode.\n3. Choose Load unpacked and select the extracted folder containing manifest.json. The ZIP itself cannot be loaded directly.\n4. Open https://app.hibob.com/attendance/my-attendance and click the extension icon.\n5. Select the month, federal state, work times and break, then click Read month. Review the preview before booking.\n\nThe extension follows the Chrome UI language: German or English, with English as the fallback.\nBooking requires a verified employee and tenant identity. If that identity is unavailable, the preview is read-only. See README.md for the current native validation status.\n\nTo update an existing unpacked installation, replace the files in its folder, click Reload under chrome://extensions, reload the HiBob tab, and reopen the extension.\n\nDocumentation: README.md\n`);
const assetNames = [`hibob-monatsbuchung-${manifest.version}.zip`, 'INSTALLATION.txt'];
const checksums = await Promise.all(assetNames.map(async name => `${createHash('sha256').update(await readFile(`release/${name}`)).digest('hex')}  ${name}`));
await writeFile('release/SHA256SUMS.txt', checksums.join('\n') + '\n');
console.log(`Extension: dist/\nZIP: ${target}`);
