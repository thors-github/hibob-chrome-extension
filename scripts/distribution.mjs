import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const repository = 'thors-github/hibob-chrome-extension';
export const zipName = 'hibob-monthly-attendance.zip';
export const storeScope = 'https://www.googleapis.com/auth/chromewebstore';

export function releasePolicy(tag, manifest, readiness) {
  const match = /^v(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/.exec(tag);
  if (!match || match[1] !== manifest.version) throw new Error('Release tag must match the manifest version, optionally followed by -alpha.N, -beta.N or -rc.N.');
  if (readiness.schemaVersion !== 1 || readiness.version !== manifest.version) throw new Error('Release readiness must be reviewed for this exact manifest version.');
  if (typeof readiness.stableReleaseReady !== 'boolean' || !Array.isArray(readiness.blockers) || !Array.isArray(readiness.validationEvidence)
    || ![...readiness.blockers, ...readiness.validationEvidence].every(value => typeof value === 'string' && value.trim())) throw new Error('Release readiness must contain a boolean gate and explicit blocker/evidence lists.');
  const prerelease = Boolean(match[2]);
  if (prerelease && manifest.version_name !== tag.slice(1)) throw new Error('Prerelease tags must match manifest.version_name exactly.');
  if (!prerelease && manifest.version_name && manifest.version_name !== manifest.version) throw new Error('A prerelease version_name cannot be published as a stable release.');
  if (!prerelease && (readiness.stableReleaseReady !== true || !Array.isArray(readiness.validationEvidence) || readiness.validationEvidence.length === 0 || readiness.blockers?.length)) {
    throw new Error('Stable release blocked: native validation is incomplete. Use a matching prerelease tag for evaluation.');
  }
  return { tag, version: manifest.version, displayVersion: manifest.version_name || manifest.version, prerelease, stableReleaseReady: readiness.stableReleaseReady === true };
}

export function storeConfiguration(env) {
  const names = ['CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID', 'CWS_WIF_PROVIDER', 'CWS_SERVICE_ACCOUNT'];
  const missing = names.filter(name => !env[name]?.trim());
  if (env.CWS_AUTOMATION_ENABLED !== 'true') missing.unshift('CWS_AUTOMATION_ENABLED=true');
  if (missing.length) throw new Error(`Chrome Web Store setup is incomplete: ${missing.join(', ')}. See docs/STORE_SETUP.md.`);
  if (!/^[a-p]{32}$/.test(env.CWS_EXTENSION_ID)) throw new Error('CWS_EXTENSION_ID must be the real 32-character Chrome Web Store item ID.');
  if (!/^[A-Za-z0-9_-]+$/.test(env.CWS_PUBLISHER_ID)) throw new Error('Invalid publisher ID.');
  if (!/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(env.CWS_WIF_PROVIDER)) throw new Error('Invalid Workload Identity provider resource name.');
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(env.CWS_SERVICE_ACCOUNT)) throw new Error('Invalid service account email.');
  return { publisherId: env.CWS_PUBLISHER_ID, extensionId: env.CWS_EXTENSION_ID };
}

export function publishedStoreUrl(env) {
  if (env.CWS_STORE_PUBLISHED !== 'true') return null;
  let url;
  try { url = new URL(env.CWS_STORE_URL); } catch { throw new Error('Published Store configuration requires a real HTTPS Chrome Web Store URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'chromewebstore.google.com' || url.username || url.password || url.port || url.search || url.hash || !/^\/detail\/(?:[^/]+\/)?[a-p]{32}$/.test(url.pathname)) {
    throw new Error('Store link must be an exact chromewebstore.google.com/detail/... item URL without credentials, query or fragment.');
  }
  return url.href;
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readReleaseInputs() {
  return {
    manifest: JSON.parse(await readFile('public/manifest.json', 'utf8')),
    readiness: JSON.parse(await readFile('docs/release-readiness.json', 'utf8')),
  };
}

export async function resolveWorkflowRelease(env, fetcher = fetch, inputs) {
  if (env.GITHUB_REPOSITORY !== repository) throw new Error('Publishing is restricted to the canonical repository.');
  const { manifest, readiness } = inputs || await readReleaseInputs();
  const bootstrap = env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'push';
  const tag = bootstrap ? readiness.bootstrapTag : env.GITHUB_REF?.replace(/^refs\/tags\//, '');
  if (!tag) return { enabled: false };
  if (bootstrap) {
    if (!/^v\d+\.\d+\.\d+-(alpha|beta|rc)\.[1-9]\d*$/.test(tag)) throw new Error('Bootstrap distribution only permits an explicitly configured prerelease.');
    const response = await fetcher(`https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return { enabled: false, reason: 'Bootstrap tag already exists.' };
    if (response.status !== 404) throw new Error(`Could not check bootstrap tag (${response.status}); no release was attempted.`);
  } else if (!env.GITHUB_REF?.startsWith('refs/tags/')) {
    throw new Error('A normal release requires a version tag.');
  }
  const result = releasePolicy(tag, manifest, readiness);
  return { ...result, enabled: true, bootstrap };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'store-config') {
      storeConfiguration(process.env);
      console.log('Chrome Web Store configuration is complete.');
    } else if (process.argv[2] === 'workflow') {
      const metadata = await resolveWorkflowRelease(process.env);
      for (const [key, value] of Object.entries({ enabled: metadata.enabled, tag: metadata.tag || '', prerelease: metadata.prerelease || false, bootstrap: metadata.bootstrap || false })) {
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
      }
      console.log(metadata.enabled ? `Prepared ${metadata.tag} (${metadata.prerelease ? 'prerelease, ZIP only' : 'stable'}).` : (metadata.reason || 'No bootstrap release configured.'));
    } else {
      const { manifest, readiness } = await readReleaseInputs();
      console.log(JSON.stringify(releasePolicy(process.argv[2], manifest, readiness)));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
