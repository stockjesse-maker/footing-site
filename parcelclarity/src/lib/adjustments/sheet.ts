import type { Table } from "../import/parse-table";
import { normalizeGuardHeader } from "./header-text";
import { SYNONYMS } from "./synonyms";

/**
 * Which row of a sheet holds the column names, and which rows might (Milestone 5, review finding F2).
 *
 * The header row is the first of the first fifty non-blank rows that holds a ship date column AND a carrier, service or adjustment type
 * column, named as the template names them or by one of the synonyms (synonyms.ts). A sheet with no such row has no header row: the
 * importer refuses it and stores nothing, because a header it cannot find is a header it cannot guard.
 *
 * The header guard (header-guard.ts) does not trust that choice alone. It tests every row among the first fifty non-blank rows that COULD
 * be a header: the first row always, and any later row with at least three filled cells of which at most a quarter look like numbers or
 * dates (a title row, a second header block). This is the same rule the database applies to the first fifty lines of a stored CSV file
 * (`app.adjustment_scan_file`), so the two layers look at the same rows.
 */

export const HEADER_SCAN_ROWS = 50;
/** Cells longer than this are never numbers, money or dates (and are not tested with a pattern at all). */
const NUMERIC_CELL_MAX = 64;

const NUMBER_LIKE = /^[^0-9a-z]*[0-9][0-9,. ]*[^0-9a-z]*(usd)?$/i;
const DATE_LIKE = /^[0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4}/;

/** A cell that reads as a number, an amount of money or a date (the database scan's test). Long cells are not: the patterns only ever see up to 64 characters. */
export function looksNumeric(cell: string): boolean {
  if (cell.length > NUMERIC_CELL_MAX) return false;
  return NUMBER_LIKE.test(cell) || DATE_LIKE.test(cell);
}

export const isBlankRow = (row: readonly string[]): boolean => row.every((c) => c === "");

/** Indexes of the first fifty non-blank rows. */
export function scannedRows(rows: readonly (readonly string[])[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < rows.length && out.length < HEADER_SCAN_ROWS; r++) if (!isBlankRow(rows[r]!)) out.push(r);
  return out;
}

/** Row indexes (among the first fifty non-blank rows) that could be a header and must be guarded: the first row always, later rows by the filled-and-mostly-text rule. */
export function headerCandidateRows(rows: readonly (readonly string[])[]): number[] {
  return scannedRows(rows).filter((r, position) => {
    if (position === 0) return true;
    const row = rows[r]!;
    let filled = 0;
    let numeric = 0;
    for (const c of row) {
      if (c === "") continue;
      filled++;
      if (looksNumeric(c)) numeric++;
    }
    return filled >= 3 && numeric * 4 <= filled;
  });
}

const REQUIRED_WITH_SHIP_DATE = ["carrier", "service", "adjustmentType"] as const;

/** The header row of a sheet's rows: the first of the first fifty non-blank rows with a ship date and a carrier, service or type column; null when there is none. */
export function detectHeaderRow(rows: readonly (readonly string[])[]): number | null {
  for (const r of scannedRows(rows)) {
    let shipDate = false;
    let other = false;
    for (const cell of rows[r]!) {
      if (cell === "" || cell.length > 100) continue;
      const n = normalizeGuardHeader(cell);
      if (SYNONYMS.shipDate.includes(n)) shipDate = true;
      else if (REQUIRED_WITH_SHIP_DATE.some((f) => SYNONYMS[f].includes(n))) other = true;
    }
    if (shipDate && other) return r;
  }
  return null;
}

export interface SheetHeaders {
  /** The header row's index; 0 for a sheet with no recognisable header row. */
  headerRow: number;
  /** The header row's cells; empty for a sheet with no recognisable header row (a data row is never read as column names). */
  headers: string[];
  recognised: boolean;
}

export function sheetHeaders(table: Table): SheetHeaders {
  const found = detectHeaderRow(table.rows);
  if (found === null) return { headerRow: 0, headers: [], recognised: false };
  return { headerRow: found, headers: table.rows[found] ?? [], recognised: true };
}
