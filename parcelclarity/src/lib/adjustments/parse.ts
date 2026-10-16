import { ADJUSTMENT_FILE_LIMITS, detectFileKind, parseTables, ParseError, type FileKind, type Table } from "../import/parse-table";
import { IMPORT_LIMITS } from "./copy";
import { guardTables, type HeaderGuardResult } from "./header-guard";
import { sheetHeaders } from "./sheet";
import { ADJUSTMENT_MAX_ROWS } from "./validate";

/**
 * Reads an uploaded history file (CSV or XLSX) through the shared parser with the adjustment limits (20,000 rows, 5 MB) and
 * runs the header guard over every header of every sheet. This is the first step of an import and it happens BEFORE any byte
 * is stored: a refused file leaves no uploaded_files row and no adjustment_imports row behind, and the refusal names the
 * header and never a cell value.
 */
export type ParsedAdjustmentFile =
  | { status: "ok"; kind: FileKind; tables: Table[] }
  | { status: "refused"; guard: HeaderGuardResult; message: string }
  | { status: "error"; code: ParseError["code"]; message: string };

const TOO_LARGE_SUFFIX = ` The limits are ${IMPORT_LIMITS}.`;

function plainError(err: ParseError): string {
  if (err.code === "too_large" && /more than [\d,]+ rows/.test(err.message)) return `The file has more than ${ADJUSTMENT_MAX_ROWS.toLocaleString("en-US")} rows. Split it by month and import each part.${TOO_LARGE_SUFFIX}`;
  if (err.code === "too_large" && /larger than/.test(err.message)) return `The file is larger than 5 MB. Split it by month and import each part.${TOO_LARGE_SUFFIX}`;
  return err.message;
}

export async function parseAdjustmentFile(bytes: Uint8Array, source: FileKind | { filename: string; mimeType: string }): Promise<ParsedAdjustmentFile> {
  let kind: FileKind;
  let tables: Table[];
  try {
    kind = typeof source === "string" ? source : detectFileKind(source.filename, source.mimeType, bytes);
    tables = await parseTables(bytes, kind, ADJUSTMENT_FILE_LIMITS);
  } catch (err) {
    if (err instanceof ParseError) return { status: "error", code: err.code, message: plainError(err) };
    throw err;
  }
  const guard = guardTables(tables);
  if (!guard.allowed) return { status: "refused", guard, message: guard.message ?? "" };
  for (const t of tables) {
    const { headerRow } = sheetHeaders(t);
    if (t.rows.length - headerRow - 1 > ADJUSTMENT_MAX_ROWS) {
      return { status: "error", code: "too_large", message: `Sheet "${t.name}" has more than ${ADJUSTMENT_MAX_ROWS.toLocaleString("en-US")} rows. Split it by month and import each part.${TOO_LARGE_SUFFIX}` };
    }
  }
  return { status: "ok", kind, tables };
}
