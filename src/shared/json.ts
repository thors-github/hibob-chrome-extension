/** Chrome storage and runtime messages do not preserve object insertion order.
 * Match JSON values while retaining array order and normal JSON handling of
 * absent optional fields. This is also used for reviewed-plan equality.
 */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown) => JSON.stringify(value, (_key, current: unknown) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(Object.entries(current).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return canonical(left) === canonical(right);
}
