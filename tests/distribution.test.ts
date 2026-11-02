// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishedStoreUrl, releasePolicy, resolveWorkflowRelease, storeConfiguration } from '../scripts/distribution.mjs';
import { submitStorePackage } from '../scripts/webstore.mjs';
import { buildSite } from '../scripts/build-site.mjs';
import { probePages } from '../scripts/pages-status.mjs';

const previewManifest = { version: '1.2.0', version_name: '1.2.0-beta.1' };
const blocked = { schemaVersion: 1, version: '1.2.0', stableReleaseReady: false, bootstrapTag: 'v1.2.0-beta.1', blockers: ['Native identity is unresolved.'], validationEvidence: [] };
const ready = { ...blocked, stableReleaseReady: true, blockers: [], validationEvidence: ['Native identity verified in a reviewed acceptance report.'] };
const fakeId = 'a'.repeat(32);
const fakeToken = 'test-only-short-lived-token';
const stableMetadata = { version: '1.2.0', prerelease: false, stableReleaseReady: true };
const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('distribution policy', () => {
  it('permits the exact labelled preview but rejects stable release and tag/version mismatches', () => {
    expect(releasePolicy('v1.2.0-beta.1', previewManifest, blocked).prerelease).toBe(true);
    expect(() => releasePolicy('v1.2.0', { version: '1.2.0' }, blocked)).toThrow('Stable release blocked');
    expect(() => releasePolicy('v1.2.0-beta.2', previewManifest, blocked)).toThrow('version_name');
    expect(() => releasePolicy('v1.2.1-beta.1', previewManifest, blocked)).toThrow('manifest version');
    expect(() => releasePolicy('v1.2.0', previewManifest, ready)).toThrow('prerelease version_name');
    expect(() => releasePolicy('v1.2.0', { version: '1.2.0' }, { ...ready, validationEvidence: [] })).toThrow('Stable release blocked');
    expect(releasePolicy('v1.2.0', { version: '1.2.0' }, ready).prerelease).toBe(false);
  });

  it('bootstraps only the explicitly configured prerelease and skips an existing tag', async () => {
    const env = { GITHUB_REPOSITORY: 'thors-github/hibob-chrome-extension', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GH_TOKEN: fakeToken };
    const absent = vi.fn(async () => new Response('', { status: 404 }));
    const result = await resolveWorkflowRelease(env, absent as typeof fetch, { manifest: previewManifest, readiness: blocked });
    expect(result).toMatchObject({ enabled: true, bootstrap: true, prerelease: true, tag: 'v1.2.0-beta.1' });
    expect(absent).toHaveBeenCalledTimes(1);
    expect(await resolveWorkflowRelease(env, (async () => Response.json({ ref: 'exists' })) as typeof fetch, { manifest: previewManifest, readiness: blocked })).toMatchObject({ enabled: false });
    expect(await resolveWorkflowRelease(env, (async () => Response.json({ ref: 'exists' })) as typeof fetch, { manifest: { version: '1.3.0' }, readiness: blocked })).toMatchObject({ enabled: false });
    await expect(resolveWorkflowRelease(env, (async () => new Response('', { status: 403 })) as typeof fetch, { manifest: previewManifest, readiness: blocked })).rejects.toThrow('no release was attempted');
    await expect(resolveWorkflowRelease(env, absent as typeof fetch, { manifest: { version: '1.2.0' }, readiness: { ...ready, bootstrapTag: 'v1.2.0' } })).rejects.toThrow('only permits');
  });

  it('keeps Store setup disabled until real explicit configuration exists', () => {
    expect(() => storeConfiguration({})).toThrow('setup is incomplete');
    expect(publishedStoreUrl({ CWS_STORE_URL: `https://chromewebstore.google.com/detail/${fakeId}` })).toBeNull();
    expect(publishedStoreUrl({ CWS_STORE_PUBLISHED: 'true', CWS_STORE_URL: `https://chromewebstore.google.com/detail/test/${fakeId}` })).toBe(`https://chromewebstore.google.com/detail/test/${fakeId}`);
    for (const bad of ['https://example.com/detail/'+fakeId, 'https://user:password@chromewebstore.google.com/detail/'+fakeId, 'https://chromewebstore.google.com/detail/'+fakeId+'?token=x']) {
      expect(() => publishedStoreUrl({ CWS_STORE_PUBLISHED: 'true', CWS_STORE_URL: bad })).toThrow('Store link');
    }
  });
});

describe('Chrome Web Store API v2 submission', () => {
  function mockApi(responses: unknown[]) {
    const calls: { url: string; options: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: String(url), options });
      const value = responses.shift();
      if (value instanceof Error) throw value;
      if (value instanceof Response) return value;
      if (value === undefined) throw new Error('Unexpected request');
      return Response.json(value);
    }) as unknown as typeof fetch;
    return { fetcher, calls };
  }
  const request = (fetcher: typeof fetch) => ({ metadata: stableMetadata, bytes: new Uint8Array([1, 2, 3]), publisherId: 'test-publisher', extensionId: fakeId, token: fakeToken, fetcher, sleep: async () => {} });

  it('uploads the exact bytes once and submits after confirmed upload with review enabled', async () => {
    const api = mockApi([{ itemId: fakeId }, { itemId: fakeId, crxVersion: '1.2.0', uploadState: 'SUCCEEDED' }, { itemId: fakeId, state: 'PENDING_REVIEW' }]);
    const options = request(api.fetcher);
    expect(await submitStorePackage(options)).toMatchObject({ state: 'submitted_for_review' });
    expect(api.calls.map(call => call.url)).toEqual([
      `https://chromewebstore.googleapis.com/v2/publishers/test-publisher/items/${fakeId}:fetchStatus`,
      `https://chromewebstore.googleapis.com/upload/v2/publishers/test-publisher/items/${fakeId}:upload`,
      `https://chromewebstore.googleapis.com/v2/publishers/test-publisher/items/${fakeId}:publish`,
    ]);
    expect(api.calls[1].options?.body).toBe(options.bytes);
    expect(JSON.parse(api.calls[2].options?.body as string)).toEqual({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true });
  });

  it('polls an asynchronous upload without repeating it, then submits', async () => {
    const api = mockApi([{ itemId: fakeId }, { itemId: fakeId, uploadState: 'IN_PROGRESS' }, { itemId: fakeId, lastAsyncUploadState: 'IN_PROGRESS' }, { itemId: fakeId, lastAsyncUploadState: 'SUCCEEDED' }, { itemId: fakeId, state: 'PENDING_REVIEW' }]);
    await expect(submitStorePackage(request(api.fetcher))).resolves.toMatchObject({ state: 'submitted_for_review' });
    expect(api.calls.filter(call => call.url.endsWith(':upload'))).toHaveLength(1);
    expect(api.calls.filter(call => call.url.endsWith(':publish'))).toHaveLength(1);
  });

  it('does not upload or submit a prerelease, an existing pending version, or a conflicting submission', async () => {
    const never = mockApi([]);
    await expect(submitStorePackage({ ...request(never.fetcher), metadata: { ...stableMetadata, prerelease: true } })).rejects.toThrow('cannot be submitted');
    expect(never.calls).toHaveLength(0);
    const pending = mockApi([{ itemId: fakeId, submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.2.0' }] } }]);
    expect(await submitStorePackage(request(pending.fetcher))).toEqual({ state: 'already_submitted' });
    expect(pending.calls).toHaveLength(1);
    const conflict = mockApi([{ itemId: fakeId, submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.1.0' }] } }]);
    await expect(submitStorePackage(request(conflict.fetcher))).rejects.toThrow('not replaced');
    expect(conflict.calls).toHaveLength(1);
  });

  it('stops on failed, unknown or mismatched upload status and never publishes', async () => {
    for (const result of [{ itemId: fakeId, uploadState: 'FAILED' }, { itemId: fakeId, uploadState: 'UNKNOWN' }, { itemId: fakeId, crxVersion: '9.0.0', uploadState: 'SUCCEEDED' }, new Error('network disconnected')]) {
      const api = mockApi([{ itemId: fakeId }, result]);
      await expect(submitStorePackage(request(api.fetcher))).rejects.toThrow();
      expect(api.calls).toHaveLength(2);
      expect(api.calls.some(call => call.url.endsWith(':publish'))).toBe(false);
    }
    const wrongProgress = mockApi([{ itemId: fakeId }, { itemId: fakeId, uploadState: 'IN_PROGRESS' }, { itemId: fakeId, crxVersion: '1.1.0', lastAsyncUploadState: 'SUCCEEDED' }]);
    await expect(submitStorePackage(request(wrongProgress.fetcher))).rejects.toThrow('different version');
  });
});

describe('installation site', () => {
  it('treats missing Pages setup as a setup gate, while authentication and server errors remain failures', async () => {
    expect(await probePages(fakeToken, (async () => new Response('', { status: 404 })) as typeof fetch)).toBe(false);
    expect(await probePages(fakeToken, (async () => Response.json({ build_type: 'legacy' })) as typeof fetch)).toBe(false);
    expect(await probePages(fakeToken, (async () => Response.json({ build_type: 'workflow' })) as typeof fetch)).toBe(true);
    for (const status of [403, 500]) await expect(probePages(fakeToken, (async () => new Response('', { status })) as typeof fetch)).rejects.toThrow('not treated as');
  });
  it('generates no active Store link before publication and enables only explicitly published URLs', async () => {
    const output = await mkdtemp(join(tmpdir(), 'hibob-site-'));
    temporaryDirectories.push(output);
    const config = await buildSite(output, {});
    expect(config.storeUrl).toBeNull();
    const html = await readFile(join(output, 'index.html'), 'utf8');
    const js = await readFile(join(output, 'site.js'), 'utf8');
    document.open();
    document.write(html);
    document.close();
    Object.assign(window, { HIBOB_DISTRIBUTION_CONFIG: config });
    window.eval(js);
    expect(document.querySelector('#store-install')?.tagName).toBe('BUTTON');
    expect(document.querySelector('#store-install')?.hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('#github-release')?.getAttribute('href')).toBe('https://github.com/thors-github/hibob-chrome-extension/releases');
    const published = await buildSite(output, { CWS_STORE_PUBLISHED: 'true', CWS_STORE_URL: `https://chromewebstore.google.com/detail/${fakeId}` });
    Object.assign(window, { HIBOB_DISTRIBUTION_CONFIG: published });
    window.eval(js);
    expect(document.querySelector('#store-install')?.tagName).toBe('A');
    expect(document.querySelector('#store-install')?.getAttribute('href')).toBe(published.storeUrl);
    expect(await readFile(join(output, 'privacy.html'), 'utf8')).toContain('Privacy');
  });
});
