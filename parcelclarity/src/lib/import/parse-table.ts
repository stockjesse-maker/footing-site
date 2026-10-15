import Papa from "papaparse";
import readXlsx from "read-excel-file/node";

/**
 * Turns an uploaded CSV or XLSX into plain string tables. Pure: no I/O besides the buffer given.
 * Limits guard against hostile files (zip bombs, enormous sheets); the caller has already
 * enforced the byte-size limit.
 */
export const LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRowsPerSheet: 50_000,
  maxCellsPerSheet: 600_000,
  maxSheets: 20,
  maxColumns: 200,
} as const;

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

function capRows(name: string, rows: string[][]): Table {
  const truncated = rows.length > LIMITS.maxRowsPerSheet;
  const kept = rows.slice(0, LIMITS.maxRowsPerSheet).map((r) => r.slice(0, LIMITS.maxColumns).map(cellToString));
  // Drop fully empty trailing rows.
  while (kept.length && kept[kept.length - 1]!.every((c) => c === "")) kept.pop();
  return { name, rows: kept, truncated };
}

export async function parseTables(bytes: Uint8Array, kind: FileKind): Promise<Table[]> {
  if (bytes.length > LIMITS.maxBytes) throw new ParseError("The file is larger than 5 MB.", "too_large");
  if (bytes.length === 0) throw new ParseError("The file is empty.", "empty");

  if (kind === "csv") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy", dynamicTyping: false });
    if (parsed.errors.some((e) => e.code !== "TooFewFields" && e.code !== "TooManyFields" && e.code !== "UndetectableDelimiter")) {
      throw new ParseError(`The CSV could not be read: ${parsed.errors[0]?.message ?? "unknown error"}.`, "unreadable");
    }
    const table = capRows("Sheet1", parsed.data);
    if (!table.rows.length) throw new ParseError("The file has no rows.", "empty");
    return [table];
  }

  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    sheets = (await readXlsx(Buffer.from(bytes))) as { sheet: string; data: unknown[][] }[];
  } catch (err) {
    throw new ParseError(`The workbook could not be read: ${err instanceof Error ? err.message : "unknown error"}.`, "unreadable");
  }
  const tables = sheets.slice(0, LIMITS.maxSheets).map((s) => capRows(s.sheet, s.data as string[][])).filter((t) => t.rows.length > 0);
  if (!tables.length) throw new ParseError("The workbook has no data.", "empty");
  for (const t of tables) {
    const cells = t.rows.reduce((n, r) => n + r.length, 0);
    if (cells > LIMITS.maxCellsPerSheet) throw new ParseError(`Sheet "${t.name}" has too many cells (${cells}).`, "too_large");
  }
  return tables;
}
