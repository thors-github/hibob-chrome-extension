import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { storeConfiguration, zipName } from './distribution.mjs';
import { verifiedRelease } from './verify-release.mjs';

export async function submitStorePackage({ metadata, bytes, publisherId, extensionId, token, fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (metadata.prerelease || metadata.stableReleaseReady !== true) throw new Error('Prereleases and unvalidated packages cannot be submitted to the Store.');
  if (!token) throw new Error('A short-lived Chrome Web Store access token is required.');
  const name = `publishers/${publisherId}/items/${extensionId}`;
  const base = `https://chromewebstore.googleapis.com/v2/${name}`;
  async function call(url, options = {}) {
    let response;
    try { response = await fetcher(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers }, signal: AbortSignal.timeout(60_000) }); }
    catch { throw new Error('Chrome Web Store response is unknown. Inspect the Developer Dashboard before retrying; this request was not repeated.'); }
    if (!response.ok) throw new Error(`Chrome Web Store request failed (${response.status}). Inspect the Developer Dashboard before retrying.`);
    return response.json();
  }
  const status = await call(`${base}:fetchStatus`);
  if (status.itemId !== extensionId || status.takenDown || status.warned) throw new Error('Store item identity or policy status requires manual review.');
  const versions = revision => revision?.distributionChannels?.map(channel => channel.crxVersion) || [];
  if (versions(status.publishedItemRevisionStatus).includes(metadata.version)) return { state: 'already_published' };
  if (status.submittedItemRevisionStatus) {
    if (status.submittedItemRevisionStatus.state === 'PENDING_REVIEW' && versions(status.submittedItemRevisionStatus).includes(metadata.version)) return { state: 'already_submitted' };
    throw new Error('A Store submission already exists or requires review; it was not replaced or cancelled.');
  }
  if (status.lastAsyncUploadState === 'IN_PROGRESS') throw new Error('Another Store upload is in progress; it was not replaced.');
  const upload = await call(`https://chromewebstore.googleapis.com/upload/v2/${name}:upload`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes });
  if (upload.itemId !== extensionId) throw new Error('Store upload returned a different item identity.');
  if (upload.crxVersion && upload.crxVersion !== metadata.version) throw new Error('Store upload returned a different version.');
  let state = upload.uploadState;
  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 24; attempt++) {
    await sleep(5000);
    const progress = await call(`${base}:fetchStatus`);
    if (progress.itemId !== extensionId) throw new Error('Store upload status returned a different item.');
    if (progress.crxVersion && progress.crxVersion !== metadata.version) throw new Error('Store upload status returned a different version.');
    state = progress.lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED' || (upload.uploadState === 'SUCCEEDED' && upload.crxVersion !== metadata.version)) throw new Error(`Store upload did not complete successfully (${state || 'unknown'}); no submission was attempted.`);
  const submission = await call(`${base}:publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }) });
  if (submission.itemId !== extensionId || !['PENDING_REVIEW', 'PUBLISHED'].includes(submission.state)) throw new Error('Store submission was not confirmed; inspect the Developer Dashboard.');
  return { state: submission.state === 'PUBLISHED' ? 'published' : 'submitted_for_review', version: metadata.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = storeConfiguration(process.env);
    const { metadata, files } = await verifiedRelease();
    const result = await submitStorePackage({ metadata, bytes: files[zipName], ...config, token: process.env.CWS_ACCESS_TOKEN });
    console.log(`Chrome Web Store: ${result.state}. Google review and rollout remain separate from GitHub publication.`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n## Chrome Web Store\n\nVersion ${metadata.version}: **${result.state}**. An upload/submission is not a promise that a version is already available to users.\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
