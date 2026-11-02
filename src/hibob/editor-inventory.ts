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
