import { appendFile } from 'node:fs/promises';
import { repository, sha256 } from './distribution.mjs';
import { verifiedRelease } from './verify-release.mjs';

const token = process.env.GH_TOKEN;
if (!token) throw new Error('GH_TOKEN is required for release publication.');
const { metadata, files } = await verifiedRelease();
if (!/^[a-f0-9]{40}$/.test(metadata.sourceCommit || '')) throw new Error('An exact source commit is required.');
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function request(url, options = {}, allowMissing = false) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(60_000) });
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw new Error(`GitHub release request failed (${response.status}). Inspect the draft before retrying; no release asset will be overwritten.`);
  return response.json();
}
const api = `https://api.github.com/repos/${repository}`;
let ref = await request(`${api}/git/ref/tags/${encodeURIComponent(metadata.tag)}`, {}, true);
if (!ref && process.env.HIBOB_BOOTSTRAP_RELEASE !== 'true') throw new Error('The release tag does not exist.');
if (!ref && !metadata.prerelease) throw new Error('Only the configured prerelease may create its bootstrap tag.');
if (ref) {
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = (await request(`${api}/git/tags/${object.sha}`)).object;
  if (object.type !== 'commit' || object.sha !== metadata.sourceCommit) throw new Error('Release tag points to another commit.');
}
let release = await request(`${api}/releases/tags/${encodeURIComponent(metadata.tag)}`, {}, true);
const body = files['RELEASE_NOTES.md'].toString('utf8');
if (!release) {
  release = await request(`${api}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: metadata.tag, target_commitish: metadata.sourceCommit, name: `HiBob Monthly Attendance ${metadata.displayVersion}`, body, draft: true, prerelease: metadata.prerelease, make_latest: 'false' }) });
}
if (release.prerelease !== metadata.prerelease || release.body !== body) throw new Error('Existing release metadata differs; inspect it manually.');
for (const [name, bytes] of Object.entries(files)) {
  const existing = release.assets.find(asset => asset.name === name);
  if (existing) {
    if (existing.state !== 'uploaded' || existing.size !== bytes.length || existing.digest !== `sha256:${sha256(bytes)}`) throw new Error(`Existing release asset differs: ${name}; it was not overwritten.`);
    continue;
  }
  if (!release.draft) throw new Error(`Published release is missing ${name}; inspect it manually.`);
  const upload = new URL(release.upload_url.replace(/\{.*$/, ''));
  if (upload.protocol !== 'https:' || upload.hostname !== 'uploads.github.com') throw new Error('Unexpected upload host.');
  upload.searchParams.set('name', name);
  const asset = await request(upload.href, { method: 'POST', headers: { 'Content-Type': name.endsWith('.zip') ? 'application/zip' : 'text/plain' }, body: bytes });
  if (asset.state !== 'uploaded' || asset.size !== bytes.length || asset.digest !== `sha256:${sha256(bytes)}`) throw new Error(`Uploaded asset verification failed: ${name}. The release remains a draft.`);
}
if (release.draft) release = await request(`${api}/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false, make_latest: metadata.prerelease ? 'false' : 'true' }) });
if (release.draft) throw new Error('GitHub did not confirm release publication.');
const summary = `## GitHub release\n\n[${metadata.tag}](${release.html_url}) published with verified assets.\n\n${metadata.prerelease ? 'Prerelease: Chrome Web Store submission is disabled.' : 'The Store job is separate and requires configured Workload Identity Federation. Store availability is not implied by this GitHub release.'}\n`;
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(release.html_url);
