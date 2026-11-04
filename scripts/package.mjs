import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { releasePolicy, sha256, zipName } from './distribution.mjs';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const readiness = JSON.parse(await readFile('docs/release-readiness.json', 'utf8'));
const tag = process.env.HIBOB_RELEASE_TAG || `v${manifest.version_name || manifest.version}`;
const metadata = releasePolicy(tag, manifest, readiness);
await writeFile('dist/README.md', await readFile('README.md'));
await writeFile('dist/PRIVACY.md', await readFile('docs/PRIVACY.md'));
await mkdir('dist/docs', { recursive: true });
for (const name of ['PRIVACY.md', 'STORE_SETUP.md']) await writeFile(`dist/docs/${name}`, await readFile(`docs/${name}`));
await writeFile('dist/holidays-de.json', await readFile('src/domain/holidays-de.json'));
for (const path of [manifest.background.service_worker, manifest.side_panel.default_path]) await readFile(`dist/${path}`);
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  const png = await readFile(`dist/${path}`);
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== Number(size) || png.readUInt32BE(20) !== Number(size)) throw new Error(`Invalid ${size}px extension icon.`);
}
for (const locale of ['de', 'en']) {
  const messages = JSON.parse(await readFile(`dist/_locales/${locale}/messages.json`, 'utf8'));
  if (!messages.appName?.message || !messages.appDescription?.message || !messages.actionTitle?.message) throw new Error(`Missing ${locale} Chrome locale messages.`);
}
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://app.hibob.com/*']) || manifest.optional_host_permissions || manifest.permissions.some(p => !['sidePanel', 'storage', 'activeTab', 'scripting', 'alarms'].includes(p)) || manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'none'; connect-src https://app.hibob.com") throw new Error('Unexpected permissions or network origins in the manifest.');
await mkdir('release', { recursive: true });
const target = resolve('release', zipName);
await rm(target, { force: true });
execFileSync('zip', ['-q', '-r', target, '.'], { cwd: resolve('dist') });
const releaseUrl = `https://github.com/thors-github/hibob-chrome-extension/releases/tag/${tag}`;
const gateNote = metadata.stableReleaseReady ? '' : '\nPRERELEASE: Uses HiBob\'s internal session API. Booking requires explicit account confirmation for each plan and matching API account context. The internal API is unsupported; live overwrite, interactive SSO and fallback transport remain unverified.\n';
await writeFile('release/INSTALLATION.txt', `HiBob Monthly Attendance ${metadata.displayVersion}\n${gateNote}\nChrome Web Store installation\nStore availability is configured only after the real listing has been published. The installation website is not deployed yet; use the GitHub ZIP instructions below. Store-installed copies update through Chrome after a Store version is approved; publishing a GitHub release alone does not update them.\n\nGitHub ZIP installation\n1. Download ${zipName} from ${releaseUrl} and extract it into a permanent folder.\n2. Open chrome://extensions in Chrome and enable Developer mode.\n3. Choose Load unpacked and select the extracted folder containing manifest.json.\n4. Click the extension icon on any tab, choose Connect to HiBob, and complete the normal HiBob login if requested.\n5. Choose the month, check the schedule summary, click Create preview, and review the planned days. Use the settings button only to adjust your defaults.\n\nUpdating a ZIP installation\nExport your preferences from the existing extension first. Replace the files in the SAME installation folder, click Reload under chrome://extensions, and reopen the panel. Connect to HiBob and read the month again. ZIP copies do not install updates automatically. Never replace files during an active scan, booking or submission.\n\nMoving to the Chrome Web Store\nAfter the real Store listing is published, export preferences from the ZIP copy, install through the Store, import preferences, and disable the old copy. Do not run both copies. Attendance previews and run history are not transferred; read the month again.\n\nSaved months can be submitted separately through Settings > Booking and checks > Submit month. Review the saved hours, confirm the account/month, and use the explicit final Submit control. The red badge begins in the last seven Berlin calendar days and remains until submission is verified. This operation never books additional entries. Early Open-state submission and break violations must be handled in HiBob.\n\nThe interface follows Chrome's language: German or English, with English as the fallback. Documentation: README.md and PRIVACY.md.\n`);
const packageBytes = await readFile(target);
await writeFile('release/release.json', JSON.stringify({ ...metadata, zip: zipName, sha256: sha256(packageBytes), size: packageBytes.length, sourceCommit: process.env.GITHUB_SHA || null }, null, 2) + '\n');
const notes = `# HiBob Monthly Attendance ${metadata.displayVersion}\n\n${metadata.prerelease ? '**Prerelease with manual account confirmation.** The Chrome Web Store is not submitted for this release.\n' : 'Stable extension package. Chrome Web Store submission is a separate workflow step and remains subject to Google review.\n'}${gateNote}\nDownload **${zipName}** below for a manual ZIP installation. Extract it, then use Chrome → chrome://extensions → Developer mode → Load unpacked. The generated GitHub source archives require building first.\n\nThere is no published Chrome Web Store listing or live installation website yet. ZIP installations are updated manually; follow [README.md](https://github.com/thors-github/hibob-chrome-extension/blob/${tag}/README.md).\n\nSee [CHANGELOG.md](https://github.com/thors-github/hibob-chrome-extension/blob/${tag}/CHANGELOG.md) for changes and [README.md](https://github.com/thors-github/hibob-chrome-extension/blob/${tag}/README.md) for validation status, permissions and limitations.\n\nThe ZIP, installation guide and metadata below were built and checked together. SHA256SUMS.txt covers these release assets. The automated test suite uses local fixtures. Native acceptance and live-booking evidence are described in README.md.\n`;
await writeFile('release/RELEASE_NOTES.md', notes);
const assetNames = [zipName, 'INSTALLATION.txt', 'release.json', 'RELEASE_NOTES.md'];
await writeFile('release/SHA256SUMS.txt', (await Promise.all(assetNames.map(async name => `${sha256(await readFile(`release/${name}`))}  ${name}`))).join('\n') + '\n');
console.log(`Extension: dist/\nZIP: ${target}\nChannel: ${metadata.prerelease ? 'prerelease; Store submission disabled' : 'stable'}`);
