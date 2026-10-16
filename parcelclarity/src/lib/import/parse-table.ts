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

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  return String(value).trim();
}

function capRows(name: string, rows: string[][], limits: ParseLimits): Table {
  if (rows.length > limits.maxRowsPerSheet) throw new ParseError(`Sheet "${name}" has more than ${limits.maxRowsPerSheet.toLocaleString("en-US")} rows; split the file.`, "too_large");
  const kept = rows.map((r) => r.slice(0, limits.maxColumns).map(cellToString));
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

export type ParseLimits = { maxBytes: number; maxRowsPerSheet: number; maxCellsPerSheet: number; maxSheets: number; maxColumns: number };

/** Order files are wider and longer than rate cards (a Shopify export has ~75 columns, one row per line item). */
export const ORDER_FILE_LIMITS: ParseLimits = { maxBytes: 15 * 1024 * 1024, maxRowsPerSheet: 100_000, maxCellsPerSheet: 4_000_000, maxSheets: 5, maxColumns: 200 };

/**
 * Adjustment history files (Milestone 5): 20,000 data rows and 5 MB. `maxRowsPerSheet` counts the header row too, so it is
 * 20,001 (a header plus 20,000 rows); the importer re-checks the data-row count once it knows which row is the header.
 */
export const ADJUSTMENT_FILE_LIMITS: ParseLimits = { maxBytes: 5 * 1024 * 1024, maxRowsPerSheet: 20_001, maxCellsPerSheet: 4_000_000, maxSheets: 5, maxColumns: 200 };

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
