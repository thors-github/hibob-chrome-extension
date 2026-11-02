// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { makeUiContextReader } from '../src/hibob/context-reader';
import { attendanceUrl, avatarA, avatarB, installUiContextFixture, logoA, markerUrl, nativeDigest } from './fixtures/ui-context';

beforeEach(() => { document.body.innerHTML = ''; });

describe('visible native account marker reader', () => {
  it('returns a hashed manual-confirmation context, never an employee ID', async () => {
    installUiContextFixture(document);
    const context = await makeUiContextReader(document, () => attendanceUrl)();
    expect(context).toMatchObject({ mode: 'user-confirmed-ui', pageUrl: attendanceUrl, markerFingerprint: expect.stringMatching(/^sha256:[a-f\d]{64}$/) });
    for (const privateValue of ['fixture-secret', 'media-process', '/hibob/avatar/', avatarA, logoA]) expect(JSON.stringify(context)).not.toContain(privateValue);
    expect(context).not.toHaveProperty('employeeKey');
    expect(context).not.toHaveProperty('tenantKey');
    expect(context).not.toHaveProperty('documentId');
  });

  it('ignores renewed URL tokens and resize/transform prefixes', async () => {
    const ui = installUiContextFixture(document);
    const read = makeUiContextReader(document, () => attendanceUrl);
    const original = await read();
    ui.accountImage.src = markerUrl('avatar', avatarA, { prefix: '/resize:width:128/quality:80', query: '?token=renewed-secret&w=128' });
    ui.attendanceImage.src = markerUrl('avatar', avatarA, { prefix: '/resize:width:64', query: '?token=another-secret&w=64' });
    ui.company.style.backgroundImage = `url("${markerUrl('private-image', logoA, { prefix: '/transform/logo:wide', query: '?token=rotated' })}")`;
    expect(await read()).toEqual(original);
  });

  it('changes the marker when the visible avatar resource changes', async () => {
    const ui = installUiContextFixture(document);
    const read = makeUiContextReader(document, () => attendanceUrl);
    const original = await read();
    ui.accountImage.src = ui.attendanceImage.src = markerUrl('avatar', avatarB);
    const changed = await read();
    expect(changed.mode).toBe('user-confirmed-ui');
    expect(changed).not.toEqual(original);
  });

  it('changes the marker when the visible company resource changes', async () => {
    const ui = installUiContextFixture(document);
    const read = makeUiContextReader(document, () => attendanceUrl);
    const original = await read();
    ui.company.style.backgroundImage = `url("${markerUrl('private-image', avatarB)}")`;
    expect(await read()).not.toEqual(original);
  });

  it('accepts visually rendered decorative aria-hidden images', async () => {
    const ui = installUiContextFixture(document);
    expect(ui.accountImage.getAttribute('aria-hidden')).toBe('true');
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('user-confirmed-ui');
  });

  it.each(['?view=month', '#attendance', '/'])('rejects page URL suffix %s', async suffix => {
    installUiContextFixture(document);
    expect((await makeUiContextReader(document, () => attendanceUrl + suffix)()).mode).toBe('unavailable');
  });

  it('rejects a missing account scope', async () => {
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });

  it('rejects two visible account scopes but ignores a CSS-hidden duplicate', async () => {
    const ui = installUiContextFixture(document);
    const duplicate = ui.account.cloneNode(true) as HTMLElement;
    duplicate.getBoundingClientRect = ui.bounds;
    ui.root.append(duplicate);
    const read = makeUiContextReader(document, () => attendanceUrl);
    expect((await read()).mode).toBe('unavailable');
    duplicate.style.display = 'none';
    expect((await read()).mode).toBe('user-confirmed-ui');
  });

  it.each(['accountImage', 'attendanceImage', 'company', 'header'] as const)('rejects a missing %s', async key => {
    const ui = installUiContextFixture(document);
    ui[key].remove();
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });

  it.each(['display:none', 'visibility:hidden', 'opacity:0'])('rejects an account scope hidden by %s', async css => {
    const ui = installUiContextFixture(document);
    ui.account.style.cssText = css;
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });

  it('requires positive visible layout bounds', async () => {
    const ui = installUiContextFixture(document);
    ui.attendanceImage.getBoundingClientRect = () => ({ ...ui.bounds(), width: 0, height: 0 });
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });

  it('rejects an image still loading rather than treating its future URL as visible identity', async () => {
    const ui = installUiContextFixture(document);
    Object.defineProperty(ui.accountImage, 'complete', { configurable: true, value: false });
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });

  it('rejects conflicting src/currentSrc resources during image transition', async () => {
    const ui = installUiContextFixture(document);
    Object.defineProperty(ui.accountImage, 'currentSrc', { configurable: true, value: markerUrl('avatar', avatarB) });
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });

  it('rejects different account and attendance-header avatars', async () => {
    const ui = installUiContextFixture(document);
    ui.attendanceImage.src = markerUrl('avatar', avatarB);
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });

  it('rejects mismatched avatar/company resource namespaces', async () => {
    const ui = installUiContextFixture(document);
    ui.company.style.backgroundImage = `url("${markerUrl('private-image', logoA, { namespace: '987654321' })}")`;
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });

  it.each([
    'https://evil.example/hibob/avatar/123/images/11111111-1111-4111-8111-111111111111',
    'http://media-process.hibob.com/hibob/avatar/123/images/11111111-1111-4111-8111-111111111111',
    'https://user:secret@media-process.hibob.com/hibob/avatar/123/images/11111111-1111-4111-8111-111111111111',
    'https://media-process.hibob.com/default-avatar.svg',
    'https://media-process.hibob.com/hibob/avatar/123/images/not-a-supported-resource',
  ])('rejects an unknown avatar resource without leaking its URL', async src => {
    const ui = installUiContextFixture(document);
    ui.accountImage.src = ui.attendanceImage.src = src;
    const context = await makeUiContextReader(document, () => attendanceUrl)();
    expect(context.mode).toBe('unavailable');
    expect(JSON.stringify(context)).not.toContain(src);
  });

  it('rejects a company logo without a supported single background resource', async () => {
    const ui = installUiContextFixture(document);
    ui.company.style.backgroundImage = 'linear-gradient(red, blue)';
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });

  it('rejects markers that change while their digest is being calculated', async () => {
    const ui = installUiContextFixture(document);
    Object.defineProperty(window.crypto, 'subtle', { configurable: true, value: {
      digest: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        ui.accountImage.src = ui.attendanceImage.src = markerUrl('avatar', avatarB);
        return nativeDigest(algorithm, data as Parameters<typeof nativeDigest>[1]);
      },
    } });
    const context = await makeUiContextReader(document, () => attendanceUrl)();
    expect(context).toMatchObject({ mode: 'unavailable', reason: expect.stringContaining('während der Prüfung geändert') });
  });

  it('fails closed if browser hashing is unavailable', async () => {
    installUiContextFixture(document);
    Object.defineProperty(window.crypto, 'subtle', { configurable: true, value: undefined });
    expect((await makeUiContextReader(document, () => attendanceUrl)()).mode).toBe('unavailable');
  });
});
