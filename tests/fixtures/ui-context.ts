import { webcrypto } from 'node:crypto';

const nativeSubtle = webcrypto.subtle;
export const nativeDigest = nativeSubtle.digest.bind(nativeSubtle);

export const attendanceUrl = 'https://app.hibob.com/attendance/my-attendance';
export const avatarA = '11111111-1111-4111-8111-111111111111';
export const avatarB = '22222222-2222-4222-8222-222222222222';
export const logoA = '33333333-3333-4333-8333-333333333333';
export const namespace = '123456789';

export const markerUrl = (kind: 'avatar' | 'private-image', resource: string, options: { namespace?: string; prefix?: string; query?: string } = {}) =>
  `https://media-process.hibob.com${options.prefix ?? ''}/hibob/${kind}/${options.namespace ?? namespace}/images/${resource}${options.query ?? '?token=fixture-secret&w=48'}`;

/** Sanitized native-style DOM shape. Values are synthetic, never captured account data. */
export function installUiContextFixture(doc: Document) {
  const root = doc.createElement('section');
  root.innerHTML = `<div role="button" aria-label="My account"><span class="company-logo" aria-hidden="true"></span><b-employee-avatar><img aria-hidden="true" alt=""></b-employee-avatar></div>
    <div id="TodayAttendanceHeader_topBar"><b-employee-avatar><img aria-hidden="true" alt=""></b-employee-avatar></div>`;
  doc.body.prepend(root);
  const bounds = () => ({ top: 10, bottom: 42, height: 32, left: 10, right: 42, width: 32, x: 10, y: 10, toJSON() {} });
  for (const element of [root, ...root.querySelectorAll('*')]) element.getBoundingClientRect = bounds;
  const account = root.querySelector<HTMLElement>('[aria-label="My account"]')!;
  const header = root.querySelector<HTMLElement>('#TodayAttendanceHeader_topBar')!;
  const accountImage = account.querySelector('img')!;
  const attendanceImage = header.querySelector('img')!;
  const company = account.querySelector<HTMLElement>('.company-logo')!;
  for (const image of [accountImage, attendanceImage]) {
    image.src = markerUrl('avatar', avatarA);
    Object.defineProperties(image, {
      complete: { configurable: true, get: () => true },
      naturalWidth: { configurable: true, get: () => 64 },
      currentSrc: { configurable: true, get: () => image.src },
    });
  }
  company.style.backgroundImage = `url("${markerUrl('private-image', logoA)}")`;
  // Use a wrapper so test mutations never replace Node's shared native SubtleCrypto.
  Object.defineProperty(doc.defaultView!, 'crypto', { configurable: true, value: {
    subtle: nativeSubtle,
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  } });
  return { root, account, header, accountImage, attendanceImage, company, bounds };
}
