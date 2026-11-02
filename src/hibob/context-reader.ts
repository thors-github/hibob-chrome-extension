import { t } from '../i18n';
import type { AttendanceContext } from '../shared/types';

type WithoutDocument<T> = T extends { documentId: string } ? Omit<T, 'documentId'> : never;
export type AttendanceContextEvidence = WithoutDocument<AttendanceContext>;

const OWN_ATTENDANCE_URL = 'https://app.hibob.com/attendance/my-attendance';
const MEDIA_ORIGIN = 'https://media-process.hibob.com';
const RESOURCE = /\/(hibob\/(avatar|private-image)\/(\d+)\/images\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?:\.(?:png|jpe?g|webp|gif))?)$/i;

interface ResourceMarker { path: string; namespace: string }
type MarkerRead = { canonical: string } | { reason: string };

function visible(doc: Document, element: Element): boolean {
  const win = doc.defaultView;
  if (!win || !element.isConnected) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden')) return false;
    const style = win.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 && style.opacity !== '') return false;
  }
  // aria-hidden does not mean visually hidden: decorative avatar images still
  // provide a visible account-change marker. Require actual rendered bounds.
  const bounds = element.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < win.innerWidth && bounds.top < win.innerHeight;
}

function oneVisible<T extends Element>(doc: Document, root: ParentNode, selector: string): T | null {
  const found = [...root.querySelectorAll<T>(selector)].filter(element => visible(doc, element));
  return found.length === 1 ? found[0] : null;
}

function resource(value: string, kind: 'avatar' | 'private-image'): ResourceMarker | null {
  try {
    const url = new URL(value);
    if (url.origin !== MEDIA_ORIGIN || url.username || url.password || url.hash) return null;
    const match = url.pathname.match(RESOURCE);
    if (!match || match[2] !== kind) return null;
    // Resize/transform prefixes and signed query parameters are deliberately
    // excluded. Neither the namespace nor the image UUID is an employee ID.
    return { path: `/${match[1]}`, namespace: match[3] };
  } catch { return null; }
}

function avatar(image: HTMLImageElement): ResourceMarker | null {
  if (!image.complete || image.naturalWidth <= 0) return null;
  const src = resource(image.src, 'avatar');
  const current = image.currentSrc ? resource(image.currentSrc, 'avatar') : src;
  return src && current && src.path === current.path ? src : null;
}

function readMarkers(doc: Document, location: () => string): MarkerRead {
  try {
    if (new URL(location()).href !== OWN_ATTENDANCE_URL) return { reason: t('Der HiBob-Seitenkontext ist nur auf der eigenen Anwesenheitsseite ohne URL-Zusätze verfügbar.') };
  } catch { return { reason: t('Der HiBob-Seitenkontext ist nur auf der eigenen Anwesenheitsseite ohne URL-Zusätze verfügbar.') }; }
  const account = oneVisible<HTMLElement>(doc, doc, '[role="button"][aria-label="My account"]');
  if (!account) return { reason: t('Die sichtbare HiBob-Kontoanzeige ist nicht eindeutig verfügbar. Bitte die Anwesenheitsseite vollständig anzeigen.') };
  const header = oneVisible<HTMLElement>(doc, doc, '#TodayAttendanceHeader_topBar');
  const accountImage = oneVisible<HTMLImageElement>(doc, account, 'b-employee-avatar img');
  const attendanceImage = header && oneVisible<HTMLImageElement>(doc, header, 'b-employee-avatar img');
  const logo = oneVisible<HTMLElement>(doc, account, '.company-logo');
  if (!header || !accountImage || !attendanceImage || !logo) return { reason: t('HiBobs sichtbare Konto-, Anwesenheits- oder Firmenanzeige fehlt oder ist mehrdeutig. Bitte vollständig anzeigen und erneut einlesen.') };
  const accountAvatar = avatar(accountImage);
  const attendanceAvatar = avatar(attendanceImage);
  const background = doc.defaultView!.getComputedStyle(logo).backgroundImage.trim();
  const backgroundUrl = background.match(/^url\((['"]?)(.*?)\1\)$/)?.[2];
  const company = backgroundUrl ? resource(backgroundUrl, 'private-image') : null;
  if (!accountAvatar || !attendanceAvatar || !company) return { reason: t('HiBobs sichtbare Kontomerkmale verwenden ein unbekanntes oder noch nicht geladenes Bildformat. Bitte erneut einlesen.') };
  if (accountAvatar.path !== attendanceAvatar.path) return { reason: t('Kontoanzeige und Anwesenheitsseite zeigen unterschiedliche Kontomerkmale. Bitte das eigene Konto prüfen und erneut einlesen.') };
  if (accountAvatar.namespace !== company.namespace) return { reason: t('HiBobs Konto- und Firmenanzeige gehören nicht zum selben sichtbaren Seitenkontext. Bitte das Konto prüfen.') };
  return { canonical: JSON.stringify([OWN_ATTENDANCE_URL, accountAvatar.path, attendanceAvatar.path, company.path]) };
}

/**
 * Reads only rendered native UI markers. This does not identify an immutable
 * employee: writes additionally require explicit confirmation for one plan.
 * Raw image URLs, signed tokens, display names and resource paths are not saved.
 */
export function makeUiContextReader(doc: Document, location: () => string): () => Promise<AttendanceContextEvidence> {
  return async () => {
    const before = readMarkers(doc, location);
    if ('reason' in before) return { mode: 'unavailable', reason: before.reason };
    const subtle = doc.defaultView?.crypto.subtle;
    if (!subtle) return { mode: 'unavailable', reason: t('Der Browser kann die sichtbaren HiBob-Kontomerkmale nicht sicher vergleichen. Bitte Chrome aktualisieren.') };
    let digest: ArrayBuffer;
    try { digest = await subtle.digest('SHA-256', new TextEncoder().encode(before.canonical)); }
    catch { return { mode: 'unavailable', reason: t('Der Browser kann die sichtbaren HiBob-Kontomerkmale nicht sicher vergleichen. Bitte Chrome aktualisieren.') }; }
    const after = readMarkers(doc, location);
    if ('reason' in after) return { mode: 'unavailable', reason: after.reason };
    if (before.canonical !== after.canonical) return { mode: 'unavailable', reason: t('Die sichtbaren HiBob-Kontomerkmale haben sich während der Prüfung geändert. Bitte erneut einlesen.') };
    const markerFingerprint = `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
    return { mode: 'user-confirmed-ui', pageUrl: OWN_ATTENDANCE_URL, markerFingerprint };
  };
}
