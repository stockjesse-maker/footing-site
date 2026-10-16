import Papa from "papaparse";
import readXlsx from "read-excel-file/node";

/**
 * Turns an uploaded CSV or XLSX into plain string tables. Pure: no I/O besides the buffer given.
 * Limits guard against hostile files: the byte-size cap (also enforced by callers), a zip
 * central-directory check that refuses workbooks that would inflate beyond a budget before any
 * inflation happens, and row/cell/sheet caps that reject (never silently truncate) oversized sheets.
 */
export const LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRowsPerSheet: 50_000,
  maxCellsPerSheet: 600_000,
  maxSheets: 20,
  maxColumns: 200,
} as const;

/** Upper bound on what a workbook may inflate to before it is parsed (sheet XML is verbose: ~100 bytes per cell). */
const MAX_XLSX_INFLATED_BYTES = 120 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 200;

export interface Table {
  name: string;
  rows: string[][];
  truncated: boolean;
}

export type FileKind = "csv" | "xlsx";

export class ParseError extends Error {
  constructor(message: string, readonly code: "unsupported_type" | "too_large" | "unreadable" | "empty") {
    super(message);
  }
}

export function detectFileKind(filename: string, mimeType: string, bytes: Uint8Array): FileKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (ext === "xlsx" || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    if (!isZip) throw new ParseError("The file is not a valid .xlsx workbook.", "unreadable");
    return "xlsx";
  }
  if (ext === "csv" || ext === "txt" || mimeType === "text/csv" || mimeType === "text/plain") {
    if (isZip) throw new ParseError("The file looks like a workbook but is named .csv; rename it .xlsx.", "unsupported_type");
    return "csv";
  }
  throw new ParseError("Only .csv and .xlsx files are supported.", "unsupported_type");
}

function cellToString(value: unknown, limits: ParseLimits): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    // A spreadsheet keeps at most 15 significant digits of a number: a long tracking number typed as a number has already lost its tail.
    // Where the limits ask for it, such a cell is handed on in exponent form ("9.2613e+19"), which no reader takes for an exact number.
    if (limits.maxNumericDigits !== undefined && Math.abs(value) >= 10 ** limits.maxNumericDigits) return value.toExponential();
    return String(value);
  }
  return String(value).trim();
}

/** "A", "B", ... "Z", "AA": the name a spreadsheet gives a column. */
function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function capRows(name: string, rows: string[][], limits: ParseLimits): Table {
  if (rows.length > limits.maxRowsPerSheet) throw new ParseError(`Sheet "${name}" has more than ${limits.maxRowsPerSheet.toLocaleString("en-US")} rows; split the file.`, "too_large");
  const kept: string[][] = [];
  for (const source of rows) {
    const cells = source.map((cell) => cellToString(cell, limits));
    if (limits.refuseWideRows) {
      // Never cut a sheet: a column past the limit is a column nobody checked. Empty cells at the end of a row do not count.
      let last = cells.length;
      while (last > 0 && cells[last - 1] === "") last--;
      if (last > limits.maxColumns) throw new ParseError(`Sheet "${name}" has more than ${limits.maxColumns} columns. Remove the columns you do not need, then upload again.`, "too_large");
    }
    if (cells.length > limits.maxColumns) cells.length = limits.maxColumns;
    if (limits.maxCellLength !== undefined) {
      const long = cells.findIndex((c) => c.length > limits.maxCellLength!);
      if (long >= 0) throw new ParseError(`Sheet "${name}" has a cell with more than ${limits.maxCellLength.toLocaleString("en-US")} characters (column ${columnLetters(long)}). Shorten or remove that text, then upload again.`, "too_large");
    }
    kept.push(cells);
  }
  // Drop fully empty trailing rows.
  while (kept.length && kept[kept.length - 1]!.every((c) => c === "")) kept.pop();
  return { name, rows: kept, truncated: false };
}

/**
 * Reads the zip central directory of an .xlsx and refuses archives whose declared uncompressed size
 * or entry count is unreasonable, before anything is inflated (decompression-bomb guard). The
 * directory is at the end of the file: End-Of-Central-Directory record → central directory entries.
 */
export function checkXlsxInflation(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ParseError("The workbook's zip directory could not be read.", "unreadable");
  const entryCount = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (entryCount > MAX_XLSX_ENTRIES) throw new ParseError(`The workbook has too many parts (${entryCount}).`, "too_large");
  if (dirOffset + dirSize > bytes.length) throw new ParseError("The workbook's zip directory could not be read.", "unreadable");
  let pos = dirOffset;
  let total = 0;
  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) throw new ParseError("The workbook's zip directory could not be read.", "unreadable");
    const uncompressed = view.getUint32(pos + 24, true);
    if (uncompressed === 0xffffffff) throw new ParseError("ZIP64 workbooks are not supported.", "too_large");
    total += uncompressed;
    if (total > MAX_XLSX_INFLATED_BYTES) throw new ParseError("The workbook would expand to more than 120 MB; export a smaller sheet.", "too_large");
    pos += 46 + view.getUint16(pos + 28, true) + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
  }
}

export type ParseLimits = {
  maxBytes: number;
  maxRowsPerSheet: number;
  maxCellsPerSheet: number;
  maxSheets: number;
  maxColumns: number;
  /** Optional. A cell with more characters than this refuses the whole sheet (never truncated). Unset: no cap (the other importers). */
  maxCellLength?: number;
  /** Optional. Refuse a sheet with a row wider than `maxColumns` (counting up to the last filled cell) instead of cutting the row. Unset: cut (the other importers). */
  refuseWideRows?: boolean;
  /** Optional. An XLSX number cell with this many digits or more is handed on in exponent form, so a spreadsheet's rounded long number is never read as an exact one. Unset: plain text. */
  maxNumericDigits?: number;
};

/** Order files are wider and longer than rate cards (a Shopify export has ~75 columns, one row per line item). */
export const ORDER_FILE_LIMITS: ParseLimits = { maxBytes: 15 * 1024 * 1024, maxRowsPerSheet: 100_000, maxCellsPerSheet: 4_000_000, maxSheets: 5, maxColumns: 200 };

/**
 * Adjustment history files (Milestone 5): 5 MB and 20,000 DATA rows. `maxRowsPerSheet` only bounds memory: it counts every row of an XLSX
 * sheet (title rows, spacer rows), so it is well above 20,000 and the importer applies the real limit to the non-blank rows under the header
 * once it knows which row is the header (a file with two title rows and 20,000 data rows is accepted). A sheet wider than 200 columns, a cell
 * of more than 10,000 characters and a long number typed as an XLSX number are refused or handed on in exponent form, never cut.
 */
export const ADJUSTMENT_FILE_LIMITS: ParseLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxRowsPerSheet: 60_000,
  maxCellsPerSheet: 4_000_000,
  maxSheets: 5,
  maxColumns: 200,
  maxCellLength: 10_000,
  refuseWideRows: true,
  maxNumericDigits: 15,
};

export async function parseTables(bytes: Uint8Array, kind: FileKind, limits: ParseLimits = LIMITS): Promise<Table[]> {
  if (bytes.length > limits.maxBytes) throw new ParseError(`The file is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`, "too_large");
  if (bytes.length === 0) throw new ParseError("The file is empty.", "empty");

  if (kind === "csv") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy", dynamicTyping: false });
    if (parsed.errors.some((e) => e.code !== "TooFewFields" && e.code !== "TooManyFields" && e.code !== "UndetectableDelimiter")) {
      throw new ParseError(`The CSV could not be read: ${parsed.errors[0]?.message ?? "unknown error"}.`, "unreadable");
    }
    const table = capRows("Sheet1", parsed.data, limits);
    if (!table.rows.length) throw new ParseError("The file has no rows.", "empty");
    return [table];
  }

  checkXlsxInflation(bytes);
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    sheets = (await readXlsx(Buffer.from(bytes))) as { sheet: string; data: unknown[][] }[];
  } catch (err) {
    throw new ParseError(`The workbook could not be read: ${err instanceof Error ? err.message : "unknown error"}.`, "unreadable");
  }
  if (sheets.length > limits.maxSheets) throw new ParseError(`The workbook has more than ${limits.maxSheets} sheets.`, "too_large");
  const tables = sheets.map((s) => capRows(s.sheet, s.data as string[][], limits)).filter((t) => t.rows.length > 0);
  if (!tables.length) throw new ParseError("The workbook has no data.", "empty");
  for (const t of tables) {
    const cells = t.rows.reduce((n, r) => n + r.length, 0);
    if (cells > limits.maxCellsPerSheet) throw new ParseError(`Sheet "${t.name}" has too many cells (${cells}).`, "too_large");
  }
  return tables;
}
