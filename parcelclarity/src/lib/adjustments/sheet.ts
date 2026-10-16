import type { Table } from "../import/parse-table";

/**
 * Which row of a sheet is the header. The same rule the orders importer uses: the first of the first fifteen rows
 * with at least three filled cells of which at most a quarter look like numbers or dates; row 0 when none does.
 * A sheet's title rows above it are never read as data and never stored.
 */
export function findHeaderRow(rows: string[][]): number {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r]!;
    const nonEmpty = row.filter((c) => c !== "").length;
    const numeric = row.filter((c) => /^[\d.$,/-]+$/.test(c)).length;
    if (nonEmpty >= 3 && numeric <= nonEmpty / 4) return r;
  }
  return 0;
}

export function sheetHeaders(table: Table): { headerRow: number; headers: string[] } {
  const headerRow = findHeaderRow(table.rows);
  return { headerRow, headers: table.rows[headerRow] ?? [] };
}
