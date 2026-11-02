import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readReleaseInputs, releasePolicy, sha256, zipName } from './distribution.mjs';

export async function verifiedRelease(directory = 'release', expectedCommit = process.env.GITHUB_SHA) {
  const metadata = JSON.parse(await readFile(resolve(directory, 'release.json'), 'utf8'));
  const { manifest, readiness } = await readReleaseInputs();
  const policy = releasePolicy(metadata.tag, manifest, readiness);
  if (metadata.zip !== zipName || metadata.prerelease !== policy.prerelease || metadata.version !== policy.version || metadata.displayVersion !== policy.displayVersion || metadata.stableReleaseReady !== policy.stableReleaseReady) throw new Error('Release metadata does not match the reviewed source.');
  if (expectedCommit && metadata.sourceCommit !== expectedCommit) throw new Error('Release artifact belongs to a different source commit.');
  const files = {};
  const checksumLines = (await readFile(resolve(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
  const expected = new Set([zipName, 'INSTALLATION.txt', 'release.json', 'RELEASE_NOTES.md']);
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match || !expected.delete(match[2])) throw new Error('Invalid, duplicate or unexpected release checksum.');
    const bytes = await readFile(resolve(directory, match[2]));
    if (sha256(bytes) !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
    files[match[2]] = bytes;
  }
  if (expected.size) throw new Error('Release checksums are incomplete.');
  if (metadata.sha256 !== sha256(files[zipName]) || metadata.size !== files[zipName].length) throw new Error('ZIP metadata mismatch.');
  const path = resolve(directory, zipName);
  const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).trim().split('\n');
  if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..') || /(^|\/)(\.env[^/]*|\.DS_Store|node_modules|test-evidence)(\/|$)|\.(pem|key)$/i.test(entry))) throw new Error('Unexpected private or unsafe files in extension ZIP.');
  const packed = JSON.parse(execFileSync('unzip', ['-p', path, 'manifest.json'], { encoding: 'utf8' }));
  if (packed.version !== metadata.version || (packed.version_name || packed.version) !== metadata.displayVersion) throw new Error('Packaged version mismatch.');
  files['SHA256SUMS.txt'] = await readFile(resolve(directory, 'SHA256SUMS.txt'));
  return { metadata, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const { metadata } = await verifiedRelease(process.argv[2]); console.log(`Verified ${metadata.tag}: ${metadata.sha256}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
