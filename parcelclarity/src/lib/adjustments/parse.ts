import { ADJUSTMENT_FILE_LIMITS, detectFileKind, parseTables, ParseError, type FileKind, type Table } from "../import/parse-table";
import { ENCODING_MESSAGE, IMPORT_LIMITS, NO_HEADER_ROW_MESSAGE } from "./copy";
import { guardTables, hasHeaderRow, type HeaderGuardResult } from "./header-guard";
import { isBlankRow, sheetHeaders } from "./sheet";
import { ADJUSTMENT_MAX_ROWS } from "./validate";

/**
 * Reads an uploaded history file (CSV or XLSX) through the shared parser with the adjustment limits (20,000 rows, 5 MB, 10,000 characters per
 * cell, 200 columns, never cut) and runs the header guard over every sheet. This is the first step of an import and it happens BEFORE any byte
 * is stored: a refused file leaves no uploaded_files row and no adjustment_imports row behind, and the refusal names the
 * headers and never a cell value.
 *
 * A file is refused, and nothing is stored, when
 *   - it is a UTF-16 or binary "CSV" (the guard would read letters between NUL bytes, not column names): "save as CSV UTF-8";
 *   - a sheet is wider than 200 columns or holds a cell of more than 10,000 characters (never cut: a column or text nobody checked);
 *   - a header looks like carrier cost data, or cannot be read (header-guard.ts);
 *   - no row of the first fifty rows of any sheet holds the column names (a ship date and a carrier, service or type column): "put the
 *     column names in row 1".
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

/** True for a UTF-16 or UTF-32 byte order mark, or any NUL byte: text that is not UTF-8 or ASCII cannot be read by this importer. */
export function isUnreadableText(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return true;
  return bytes.indexOf(0) !== -1;
}

export async function parseAdjustmentFile(bytes: Uint8Array, source: FileKind | { filename: string; mimeType: string }): Promise<ParsedAdjustmentFile> {
  let kind: FileKind;
  let tables: Table[];
  try {
    kind = typeof source === "string" ? source : detectFileKind(source.filename, source.mimeType, bytes);
    if (kind === "csv" && isUnreadableText(bytes)) return { status: "error", code: "unreadable", message: ENCODING_MESSAGE };
    tables = await parseTables(bytes, kind, ADJUSTMENT_FILE_LIMITS);
  } catch (err) {
    if (err instanceof ParseError) return { status: "error", code: err.code, message: plainError(err) };
    throw err;
  }
  const guard = guardTables(tables);
  if (!guard.allowed) return { status: "refused", guard, message: guard.message ?? "" };
  // Fail closed: a file whose column names cannot be found cannot be guarded, so it is not stored.
  if (!hasHeaderRow(tables)) return { status: "error", code: "unreadable", message: NO_HEADER_ROW_MESSAGE };
  for (const t of tables) {
    const { headerRow, recognised } = sheetHeaders(t);
    if (!recognised) continue;
    // Only the non-blank rows under the column names count against the limit (title rows and spacer rows do not).
    let data = 0;
    for (let r = headerRow + 1; r < t.rows.length; r++) if (!isBlankRow(t.rows[r]!)) data++;
    if (data > ADJUSTMENT_MAX_ROWS) {
      return { status: "error", code: "too_large", message: `Sheet "${t.name}" has more than ${ADJUSTMENT_MAX_ROWS.toLocaleString("en-US")} rows. Split it by month and import each part.${TOO_LARGE_SUFFIX}` };
    }
  }
  return { status: "ok", kind, tables };
}
