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
 * The header guard (header-guard.ts) does not trust that choice alone. It tests every row among the first fifty non-blank rows that COULD be a
 * header (headerCandidateRows below): the first row, every header-like row, every text row above the header row, and every row under it that
 * holds no number or date at all. A row under the header row that carries a ship date is data: its free text is not a column name and is not
 * word-checked, so a record with no weight and no amount (a date and a few words such as "Carrier reweigh") is not mistaken for a header.
 * The database applies a coarser rule to the first fifty lines of the stored CSV (`app.adjustment_scan_file`) as a backstop.
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

const REQUIRED_WITH_SHIP_DATE = ["carrier", "service", "adjustmentType"] as const;

/** A row that is a header row by the importer's own definition: a ship date column and a carrier, service or adjustment type column, named as the template or a synonym names them. */
export function isHeaderLikeRow(row: readonly string[]): boolean {
  let shipDate = false;
  let other = false;
  for (const cell of row) {
    if (cell === "" || cell.length > 100) continue;
    const n = normalizeGuardHeader(cell);
    if (SYNONYMS.shipDate.includes(n)) shipDate = true;
    else if (REQUIRED_WITH_SHIP_DATE.some((f) => SYNONYMS[f].includes(n))) other = true;
  }
  return shipDate && other;
}

/** The header row of a sheet's rows: the first of the first fifty non-blank rows that is header-like; null when there is none. */
export function detectHeaderRow(rows: readonly (readonly string[])[]): number | null {
  return scannedRows(rows).find((r) => isHeaderLikeRow(rows[r]!)) ?? null;
}

/** The number of filled cells of a row and how many of them look like a number, an amount or a date. */
function cellCounts(row: readonly string[]): { filled: number; numeric: number } {
  let filled = 0;
  let numeric = 0;
  for (const c of row) {
    if (c === "") continue;
    filled++;
    if (looksNumeric(c)) numeric++;
  }
  return { filled, numeric };
}

/**
 * Row indexes (among the first fifty non-blank rows) that must be guarded as column names:
 *   - the first row, always;
 *   - every header-like row, wherever it sits (a second header block is a header by the importer's own definition);
 *   - every row ABOVE the header row (or, in a sheet with no header row, any row) with at least three filled cells of which at most a quarter
 *     look like numbers or dates (the database scan's rule): a title row or preamble could hide the real header from a reader that takes
 *     the first row that qualifies;
 *   - every row UNDER the header row with at least three filled cells and NOT ONE number or date. A record always carries a ship date, so a
 *     row with none cannot be a valid record and may be a second block of column names; a row with a date is data, and its free text
 *     ("Carrier reweigh" as a reason, a note that says "postage") is a value, not the name of a column. Guarding it would refuse files whose
 *     records carry no weight and no amount, the incidence-only records the importer exists to count.
 * The database applies its coarser rule to the first fifty lines of the stored CSV as a backstop (`app.adjustment_scan_file`).
 */
export function headerCandidateRows(rows: readonly (readonly string[])[]): number[] {
  const header = detectHeaderRow(rows);
  return scannedRows(rows).filter((r, position) => {
    if (position === 0 || isHeaderLikeRow(rows[r]!)) return true;
    const { filled, numeric } = cellCounts(rows[r]!);
    if (filled < 3) return false;
    return header === null || r < header ? numeric * 4 <= filled : numeric === 0;
  });
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
