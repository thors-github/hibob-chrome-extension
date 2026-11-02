export interface EditorValue {
  kind: string;
  fields: [string, string, string, string];
  note: string;
  reason: string;
  metadata: string[];
}

/** Padding is presentation; an empty native field is never equivalent to zero. */
export function fieldValue(raw: string): string {
  const value = raw.trim();
  return /^\d{1,2}$/.test(value) ? value.padStart(2, '0') : value;
}

export const editorKey = (value: EditorValue): string => JSON.stringify([value.kind, value.fields, value.note, value.reason, value.metadata]);
export const inventoryKey = (values: EditorValue[]): string => JSON.stringify(values.map(editorKey).sort());
export const sameInventory = (a: EditorValue[], b: EditorValue[]): boolean => inventoryKey(a) === inventoryKey(b);

/** Multiset subtraction: duplicates retain their full occurrence counts. */
export function subtractInventory(values: EditorValue[], protectedValues: EditorValue[]): EditorValue[] | null {
  const remaining = [...values];
  for (const protectedValue of protectedValues) {
    const key = editorKey(protectedValue);
    const index = remaining.findIndex(value => editorKey(value) === key);
    if (index < 0) return null;
    remaining.splice(index, 1);
  }
  return remaining;
}

/** Diagnostics expose field names, never their contents. */
export function changedFieldNames(expected: EditorValue[], observed: EditorValue[]): string[] {
  const names = ['clock-in-hours', 'clock-in-minutes', 'clock-out-hours', 'clock-out-minutes'];
  const changed = new Set<string>();
  for (const value of expected) {
    if (observed.some(candidate => editorKey(candidate) === editorKey(value))) continue;
    const candidates = observed.filter(candidate => candidate.kind === value.kind);
    if (candidates.length !== 1) { changed.add('card-identity'); continue; }
    const candidate = candidates[0];
    names.forEach((name, index) => { if (candidate.fields[index] !== value.fields[index]) changed.add(name); });
    if (candidate.note !== value.note) changed.add('note');
    if (candidate.reason !== value.reason) changed.add('reason');
    if (JSON.stringify(candidate.metadata) !== JSON.stringify(value.metadata)) changed.add('metadata');
  }
  return [...changed].sort();
}
