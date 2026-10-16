/**
 * An estimate of the size PostgreSQL gives a value once it is a jsonb (what `pg_column_size(p_mapping)` measures in the import functions),
 * for the library to stay under the limits before the database says no. JSON text is not the same size: jsonb keeps no quotes or escapes
 * (a string is its UTF-8 bytes), but every object key, every value and every array element costs a 4-byte entry, a number is a numeric
 * datum aligned to four bytes, and a container has a 4-byte header. The estimate rounds up (each datum is padded to four bytes), so a
 * document under a limit by this measure is under it in the database; it is checked against real `pg_column_size` values in
 * tests/db/adjustments-actions-flow.test.ts.
 */
const utf8 = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
};
const pad = (n: number): number => (n + 3) & ~3;

export function jsonbSizeEstimate(value: unknown): number {
  if (value === null || value === undefined || typeof value === "boolean") return 4;
  if (typeof value === "number") return 4 + 12;
  if (typeof value === "string") return 4 + pad(utf8(value));
  if (Array.isArray(value)) return 4 + value.reduce<number>((n, v) => n + jsonbSizeEstimate(v), 0);
  if (typeof value === "object") {
    let n = 4;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      n += 4 + pad(utf8(k)) + jsonbSizeEstimate(v);
    }
    return n;
  }
  return 4;
}
