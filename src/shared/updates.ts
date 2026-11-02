/** Chrome manifest versions are one to four unsigned 16-bit numeric components. */
export function isExtensionVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 23 && /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(value)
    && value.split('.').every(part => Number(part) <= 65535);
}

export function isNewerExtensionVersion(candidate: unknown, installed: unknown): candidate is string {
  if (!isExtensionVersion(candidate) || !isExtensionVersion(installed)) return false;
  const left = candidate.split('.').map(Number), right = installed.split('.').map(Number);
  for (let index = 0; index < 4; index++) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return false;
}
