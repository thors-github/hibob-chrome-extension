import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishedStoreUrl, repository } from './distribution.mjs';

export async function buildSite(destination, env = process.env) {
  if (!destination) throw new Error('Pass an output directory outside the checkout, for example /tmp/hibob-installation-site.');
  const target = resolve(destination), root = resolve('.');
  if (target === root || target.startsWith(root + sep)) throw new Error('The installation site must be built outside the source checkout.');
  const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
  const readiness = JSON.parse(await readFile('docs/release-readiness.json', 'utf8'));
  if (readiness.version !== manifest.version) throw new Error('Review release readiness before publishing the installation site.');
  const config = {
    storeUrl: publishedStoreUrl(env),
    sourceVersion: manifest.version_name || manifest.version,
    stableReleaseReady: readiness.stableReleaseReady === true,
    blockers: readiness.blockers || [],
    repositoryUrl: `https://github.com/${repository}`,
    releaseUrl: `https://github.com/${repository}/releases`,
    zipUrl: null,
    previewReleaseUrl: null,
  };
  await mkdir(target, { recursive: true });
  await cp('site', target, { recursive: true });
  await cp('public/icons/app-icon.svg', resolve(target, 'app-icon.svg'));
  await writeFile(resolve(target, 'configuration.js'), `window.HIBOB_DISTRIBUTION_CONFIG = ${JSON.stringify(config).replaceAll('<', '\\u003c')};\n`);
  await writeFile(resolve(target, '.nojekyll'), '');
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const config = await buildSite(process.argv[2]); console.log(`Installation site built. Chrome Web Store: ${config.storeUrl ? 'published URL configured' : 'not yet available; button disabled'}.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
