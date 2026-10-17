import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, ORDER_FILE_LIMITS, ADJUSTMENT_FILE_LIMITS, ParseError, parseTables, type Table } from "@/lib/import/parse-table";
import { normalizeHeader, normalizeServiceText, type ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";
import { canonicalPackageRef, cleanText, detectDateFormat, normalizeValue, parseMoneyCell, readDateCell, readDimension, readPackageRef, readWeight } from "@/lib/adjustments/cells";
import { DUPLICATE_RULE_NOTE, ENCODING_MESSAGE, NO_HEADER_ROW_MESSAGE, ROW_NUMBERING_NOTE } from "@/lib/adjustments/copy";
import { classifyHeader, guardCandidateCell, guardHeader, isAutoMappableMoneyHeader, refusalMessage } from "@/lib/adjustments/header-guard";
import { CONFUSABLE_CHARACTERS, foldHeader, normalizeGuardHeader } from "@/lib/adjustments/header-text";
import { jsonbSizeEstimate, scrubJsonb } from "@/lib/adjustments/jsonb-size";
import { DETECTED_MAX_BYTES, MAPPING_MAX_BYTES, buildDetected, compactMapping, detectAdjustmentFile, serviceKeyOf, suggestBrand, suggestCarrier, suggestCause, suggestType, toStoredMapping, validateMapping } from "@/lib/adjustments/mapping";
import { adjustmentMappingSchema } from "@/lib/adjustments/mapping-schema";
import { isUnreadableText, parseAdjustmentFile } from "@/lib/adjustments/parse";
import { looksNumeric } from "@/lib/adjustments/sheet";
import type { AdjustmentContext, AdjustmentMapping, AdjustmentRecord } from "@/lib/adjustments/types";
import { STORED_VALIDATION_MAX_BYTES, adjustmentRecordKey, applyAdjustmentMapping, mergeAmounts, sentenceFor, toStoredValidation } from "@/lib/adjustments/validate";

/**
 * Regression tests for the adversarial review of the history import (p3-review-import.md, findings F1 to F14). Every test names the finding it
 * pins and states the expected result from the review's reproduction or from a hand calculation, never from running the code: each one fails
 * on the library as it was when the review ran (the 5 MB attacks hang, the title-row file is stored, the ragged row moves its amounts, ...).
 */

const ID = { ups: "00000000-0000-4000-8000-0000000000a1", usps: "00000000-0000-4000-8000-0000000000a2", alpha: "00000000-0000-4000-8000-0000000000b1", beta: "00000000-0000-4000-8000-0000000000b2" };
const catalog: ServiceCatalogEntry[] = [
  { id: ID.ups, carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" },
  { id: ID.usps, carrierCode: "usps", carrierName: "USPS", code: "ground_advantage", name: "USPS Ground Advantage" },
];
const brands = [
  { id: ID.alpha, name: "Alpha Apparel" },
  { id: ID.beta, name: "Beta Beverages" },
];
const ctx = (over: Partial<AdjustmentContext> = {}): AdjustmentContext => ({ catalog, brands, today: "2026-10-16", ...over });
const enc = (s: string) => new TextEncoder().encode(s);
const fixtureJson = <T>(name: string): T => JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/adjustments", name), "utf8")) as T;

/** A CSV field as the format writes it. */
const field = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (...rows: string[][]) => `${rows.map((r) => r.map(field).join(",")).join("\n")}\n`;

const H = ["ship_date", "carrier", "service", "brand", "adjustment_type", "cause", "reason", "package_ref", "declared_weight", "actual_weight", "weight_unit", "customer_charge_original", "customer_charge_corrected", "customer_adjustment_fee"];
type RowFields = Partial<Record<(typeof H)[number], string>>;
const BASE: RowFields = { ship_date: "2026-09-01", carrier: "UPS", service: "UPS Ground", brand: "Alpha Apparel", adjustment_type: "reweight", cause: "carrier_reweigh", package_ref: "1Z0001", declared_weight: "3", actual_weight: "5", weight_unit: "lb", customer_charge_original: "12.00", customer_charge_corrected: "13.50", customer_adjustment_fee: "3.00" };
const row = (o: RowFields = {}): string[] => H.map((h) => (o[h] ?? BASE[h] ?? ""));
const file = (rows: RowFields[]) => csv(H, ...rows.map(row));

async function run(text: string, edit?: (m: AdjustmentMapping) => void, over: Partial<AdjustmentContext> = {}) {
  const parsed = await parseAdjustmentFile(enc(text), "csv");
  if (parsed.status !== "ok") return { parsed, result: null, mapping: null, detection: null, tables: [] as Table[] };
  const detection = detectAdjustmentFile(parsed.tables, ctx());
  const mapping = structuredClone(detection.suggestion);
  edit?.(mapping);
  return { parsed, detection, mapping, tables: parsed.tables, result: applyAdjustmentMapping(parsed.tables, mapping, ctx(over)) };
}
const okRun = async (...args: Parameters<typeof run>) => {
  const r = await run(...args);
  if (!r.result || !r.mapping) throw new Error(`file not accepted: ${r.parsed.status}`);
  return { ...r, result: r.result, mapping: r.mapping, detection: r.detection! };
};

const elapsed = (f: () => unknown): number => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
/**
 * The best of three runs, so a busy machine cannot fail a linear reader; a first run that is far over the limit (a quadratic reader needs seconds)
 * is returned at once, so a regression fails in seconds, not in minutes.
 */
const fastest = (f: () => unknown): number => {
  const first = elapsed(f);
  return first < 50 || first > 500 ? first : Math.min(first, elapsed(f), elapsed(f));
};

// ---------------------------------------------------------------------------
// F1: no input of any length may take time that grows with its square
// ---------------------------------------------------------------------------
describe("F1: hostile cells of 100,000 characters are read in under 50 ms by every reader", () => {
  const BIG = 100_000;
  const HOSTILE: Record<string, string> = {
    "uppercase letters": "A".repeat(BIG),
    spaces: " ".repeat(BIG),
    "a five, spaces, an x": `5${" ".repeat(BIG)}x`,
    "a five, dashes, an x": `5${"-".repeat(BIG)}x`,
    "a five, usd, an x": `5${"usd".repeat(BIG / 3)}x`,
    "digits and commas": "1,".repeat(BIG / 2),
    "alternating case": "Aa".repeat(BIG / 2),
    "capitals then a lower-case letter": `${"A".repeat(BIG)}a`,
    "repeated words": "weigh ".repeat(BIG / 6),
    "zero-width characters": "a\u200b".repeat(BIG / 2),
    "repeated units": `1${" lb".repeat(BIG / 3)}`,
    "dots and digits": `.${"1".repeat(BIG)}`,
  };
  const READERS: Record<string, (s: string) => unknown> = {
    normalizeGuardHeader,
    foldHeader,
    guardHeader,
    guardCandidateCell,
    classifyHeader,
    isAutoMappableMoneyHeader,
    parseMoneyCell,
    "readWeight (value)": (s) => readWeight(s, "", "lb"),
    "readWeight (unit column)": (s) => readWeight("1", s, "lb"),
    "readDimension (value)": (s) => readDimension(s, "", "in"),
    "readDimension (unit column)": (s) => readDimension("1", s, "in"),
    readDateCell: (s) => readDateCell(s, "mdy"),
    detectDateFormat: (s) => detectDateFormat([s]),
    readPackageRef,
    "cleanText (120)": (s) => cleanText(s, 120),
    normalizeValue,
    "suggestType": (s) => suggestType(normalizeValue(s)),
    "suggestCause": (s) => suggestCause(normalizeValue(s)),
    serviceKeyOf: (s) => serviceKeyOf(s, s),
    looksNumeric,
    canonicalPackageRef,
    "scrubJsonb": (s) => scrubJsonb({ s }),
  };

  it("completes every reader on every hostile shape within 50 ms (the review measured 6 to 14 seconds for two of them)", () => {
    const slow: string[] = [];
    for (const [reader, f] of Object.entries(READERS)) {
      for (const [shape, text] of Object.entries(HOSTILE)) {
        const ms = fastest(() => f(text));
        if (ms >= 50) slow.push(`${reader} on ${shape}: ${ms.toFixed(1)} ms`);
      }
    }
    expect(slow).toEqual([]);
  });

  it("the two readers the review caught are linear: doubling the length does not quadruple the time", () => {
    const at = (n: number) => fastest(() => parseMoneyCell(`5${" ".repeat(n)}x`)) + fastest(() => normalizeGuardHeader("A".repeat(n)));
    // 20,000 to 160,000 characters: quadratic code takes 64 times as long, linear code 8 times; the ratio below separates them with room to spare.
    expect(at(160_000)).toBeLessThan(Math.max(at(20_000), 1) * 30);
    expect(at(160_000)).toBeLessThan(100);
  });

  it("a cell longer than 64 characters is invalid before any money, weight, dimension or date pattern sees it, and 64 is still readable", () => {
    const sixtyFourZeros = `${"0".repeat(60)}1.00`; // 64 characters: 1.00
    expect(sixtyFourZeros).toHaveLength(64);
    expect(parseMoneyCell(sixtyFourZeros)).toEqual({ amount: "1.00", negative: false });
    expect(parseMoneyCell(`0${sixtyFourZeros}`)).toBe("invalid");
    expect(readWeight(`${"0".repeat(63)}1`, "", "lb")).toEqual({ status: "ok", lb: "1" });
    expect(readWeight(`${"0".repeat(64)}1`, "", "lb")).toEqual({ status: "invalid" });
    expect(readWeight("1", "l".repeat(65), "lb")).toEqual({ status: "invalid" });
    expect(readDimension(`${"0".repeat(63)}1`, "", "in")).toEqual({ status: "ok", inches: "1" });
    expect(readDimension(`${"0".repeat(64)}1`, "", "in")).toEqual({ status: "invalid" });
    expect(readDateCell(`2026-09-01${" ".repeat(60)}`.trim(), "iso")).toBe("2026-09-01");
    expect(readDateCell(`2026-09-01 ${"x".repeat(60)}`, "iso")).toBe("invalid");
    // A timestamp is a date as written; one padded past 64 characters is not read at all.
    expect(readDateCell("2026-09-01T10:00:00.000", "iso")).toBe("2026-09-01");
    expect(readDateCell(`2026-09-01T10:00:00.${"0".repeat(60)}`, "iso")).toBe("invalid");
    expect(detectDateFormat([`09/13/2026 ${"0".repeat(60)}`])).toEqual({ format: "iso", ambiguous: false });
  });

  it("a file with a 100,000-character cell anywhere is refused at parse, never cut, in under 50 ms", async () => {
    await parseAdjustmentFile(enc(file([{}])), "csv"); // warm the parser
    const longHeader = csv([...H, "x".repeat(BIG)], [...row(), "1"]);
    const longMoney = csv(H, row({ customer_charge_corrected: `5${" ".repeat(BIG)}x` }));
    const longText = csv(H, row({ reason: "r".repeat(BIG) }));
    for (const text of [longHeader, longMoney, longText]) {
      const started = performance.now();
      const parsed = await parseAdjustmentFile(enc(text), "csv");
      const ms = performance.now() - started;
      expect(parsed).toMatchObject({ status: "error", code: "too_large" });
      expect((parsed as { message: string }).message).toContain("10,000 characters");
      expect(ms).toBeLessThan(50);
    }
  });

  it("a header longer than 200 characters is refused with a plain message, exactly 200 is read; the guard never folds a long header at all", async () => {
    const withHeader = (name: string) => csv([...H, name], [...row(), "1"]);
    const refused = await parseAdjustmentFile(enc(withHeader("x".repeat(201))), "csv");
    expect(refused).toMatchObject({ status: "refused" });
    expect((refused as { message: string }).message).toContain("longer than 200 characters");
    expect((refused as { message: string }).message).toContain("Nothing from this file was saved");
    expect(await parseAdjustmentFile(enc(withHeader("x".repeat(200))), "csv")).toMatchObject({ status: "ok" });
    const ms = fastest(() => guardHeader("A".repeat(9_000)));
    expect(guardHeader("A".repeat(9_000))).toMatchObject({ allowed: false, reason: "too_long" });
    expect(ms).toBeLessThan(5);
  });

  it("detect runs the guard once per header: 200 headers of 200 characters are classified in under 50 ms", async () => {
    const headers = Array.from({ length: 200 }, (_, i) => `${["ship_date", "carrier", "adjustment_type"][i] ?? `column ${String(i).padStart(3, "0")} `}`.padEnd(200, "z"));
    headers[0] = "ship_date";
    headers[1] = "carrier";
    headers[2] = "adjustment_type";
    const parsed = await parseAdjustmentFile(enc(csv(headers, headers.map(() => "1"))), "csv");
    if (parsed.status !== "ok") throw new Error(parsed.status);
    expect(fastest(() => detectAdjustmentFile(parsed.tables, ctx()))).toBeLessThan(50);
  });

  it("the new parse limit is additive: the rate-card and orders importers keep their limits and their behaviour", async () => {
    for (const limits of [LIMITS, ORDER_FILE_LIMITS]) {
      expect(limits).not.toHaveProperty("maxCellLength");
      expect(limits).not.toHaveProperty("refuseWideRows");
      expect(limits).not.toHaveProperty("maxNumericDigits");
    }
    const longCell = `a,b\n${"x".repeat(20_000)},1\n`;
    expect(await parseTables(enc(longCell), "csv", ORDER_FILE_LIMITS)).toHaveLength(1);
    await expect(parseTables(enc(longCell), "csv", ADJUSTMENT_FILE_LIMITS)).rejects.toThrow(ParseError);
    // A 201st column is still cut for the other importers (their behaviour is unchanged) and refused for the adjustment file.
    const wide = `${Array.from({ length: 201 }, (_, i) => `c${i}`).join(",")}\n${Array.from({ length: 201 }, () => "1").join(",")}\n`;
    expect((await parseTables(enc(wide), "csv", LIMITS))[0]!.rows[0]).toHaveLength(200);
    await expect(parseTables(enc(wide), "csv", ADJUSTMENT_FILE_LIMITS)).rejects.toThrow(/more than 200 columns/);
  });

  it("the older header normalisers (rate card, orders) are linear on the same hostile text (checked, not changed: they hold no nested pattern)", () => {
    for (const text of Object.values(HOSTILE)) {
      expect(fastest(() => normalizeHeader(text))).toBeLessThan(50);
      expect(fastest(() => normalizeServiceText(text))).toBeLessThan(50);
    }
  });
});

// ---------------------------------------------------------------------------
// F2: the guard looks at every row that could be the header, and a file with no header row is refused
// ---------------------------------------------------------------------------
describe("F2: title rows, a header further down, and headerless files", () => {
  const COST_HEADER = ["ship_date", "carrier", "adjustment_type", "Net Charge", "Carrier Cost"];
  const DATA = ["2026-09-01", "UPS", "reweight", "12.00", "9.10"];

  it("a title row of three text cells no longer hides the real header: the file is refused and the cost headers are named", async () => {
    const parsed = await parseAdjustmentFile(enc(csv(["Acme Logistics", "Weekly report", "Run 7"], COST_HEADER, DATA)), "csv");
    expect(parsed.status).toBe("refused");
    if (parsed.status !== "refused") return;
    expect(parsed.guard.refusedHeaders).toEqual(expect.arrayContaining(["Carrier Cost"]));
    expect(parsed.message).toContain("Nothing from this file was saved");
    expect(parsed.message).not.toContain("9.10");
    // The same file with a two-cell title row was refused before; it still is.
    expect((await parseAdjustmentFile(enc(csv(["Acme", "Report"], COST_HEADER, DATA)), "csv")).status).toBe("refused");
  });

  it("sixteen title rows above a cost header do not hide it either (the old window was 15 rows)", async () => {
    const titles = Array.from({ length: 16 }, (_, i) => [`Note ${i}`, "line", "x"]);
    expect((await parseAdjustmentFile(enc(csv(...titles, COST_HEADER, DATA)), "csv")).status).toBe("refused");
  });

  it("a headerless carrier export is refused and stores nothing: 'put the column names in row 1'", async () => {
    const parsed = await parseAdjustmentFile(enc(csv(["2026-09-01", "UPS Ground", "1Z999AA10123456784", "12.34", "9.10", "3.2", "reweight"])), "csv");
    expect(parsed).toMatchObject({ status: "error", message: NO_HEADER_ROW_MESSAGE });
    expect((parsed as { message: string }).message).toContain("Put the column names in row 1");
    expect((parsed as { message: string }).message).toContain("Nothing from this file was saved");
  });

  it("the header row is found among the first fifty non-blank rows: row 50 is read, row 51 is not (fail closed)", async () => {
    const titles = (n: number) => Array.from({ length: n }, (_, i) => [`Title ${i}`, "x", "y"]);
    const good = H.slice(0, 5);
    expect((await parseAdjustmentFile(enc(csv(...titles(49), good, ["2026-09-01", "UPS", "UPS Ground", "", "reweight"])), "csv")).status).toBe("ok");
    expect(await parseAdjustmentFile(enc(csv(...titles(50), good, ["2026-09-01", "UPS", "UPS Ground", "", "reweight"])), "csv")).toMatchObject({ status: "error", message: NO_HEADER_ROW_MESSAGE });
  });

  it("a second block of column names under a clean header is refused too, whether it is header-like or only a line of text with no date in it", async () => {
    const good = [H.slice(0, 5), ["2026-09-01", "UPS", "UPS Ground", "", "reweight"], ["2026-09-02", "UPS", "UPS Ground", "", "reweight"]];
    expect((await parseAdjustmentFile(enc(csv(...good)), "csv")).status).toBe("ok");
    const headerLike = await parseAdjustmentFile(enc(csv(...good, [], ["ship_date", "carrier", "adjustment_type", "Carrier Cost"], ["2026-09-03", "UPS", "reweight", "9.10"])), "csv");
    expect(headerLike).toMatchObject({ status: "refused", guard: { refusedHeaders: ["Carrier Cost"] } });
    const textOnly = await parseAdjustmentFile(enc(csv(...good, ["Summary", "Postage Cost", "Net Rate"])), "csv");
    expect(textOnly).toMatchObject({ status: "refused", guard: { refusedHeaders: ["Postage Cost", "Net Rate"] } });
    // The first row is always read as a possible header, however few cells it has.
    expect((await parseAdjustmentFile(enc(csv(["Carrier Cost", "note"], ...good)), "csv")).status).toBe("refused");
  });

  it("a record with a date but no weight and no amount is data, not a header: its free text may say 'Carrier reweigh' or 'postage' and the file is accepted", async () => {
    const text = csv(H, row({ package_ref: "N1", declared_weight: "", actual_weight: "", weight_unit: "", customer_charge_original: "", customer_charge_corrected: "", customer_adjustment_fee: "", reason: "Carrier reweigh", cause: "carrier_reweigh" }), row({ package_ref: "N2", declared_weight: "", actual_weight: "", weight_unit: "", customer_charge_original: "", customer_charge_corrected: "", customer_adjustment_fee: "", reason: "Postage correction note", cause: "other" }));
    const { result } = await okRun(text);
    expect(result.report.committable).toBe(true);
    expect(result.report.byCode).toMatchObject({ no_amounts: 2, missing_weight: 2 });
  });

  it("a legitimate header under title rows is detected at its own row; the first data row is never stored as the column names", async () => {
    const text = csv(["Acme Logistics", "Weekly report", "Run 7"], ["Prepared by", "the warehouse"], H, row());
    const { tables, detection, mapping } = await okRun(text);
    expect(detection.sheets[0]).toMatchObject({ headerRow: 2, recognised: true, headers: H });
    const detected = buildDetected(tables, mapping);
    expect(detected.headerRow).toBe(2);
    expect(detected.headers).toEqual(H);
    expect(detected.headers).not.toContain("1Z0001");
    expect(JSON.stringify(detected)).not.toContain("Acme Logistics");
  });

  it("a mapping may only point at the detected header row: a title row or a data row is refused, in the library and by the schema-checked re-validation", async () => {
    const text = csv(["Acme Logistics", "Weekly report", "Run 7"], H, row());
    const { tables, mapping } = await okRun(text);
    expect(validateMapping(mapping, tables, ctx())).toEqual([]);
    for (const wrong of [0, 2]) {
      const issues = validateMapping({ ...mapping, headerRow: wrong }, tables, ctx());
      expect(issues.map((i) => i.code), `headerRow ${wrong}`).toEqual(["header_row_invalid"]);
    }
    expect(applyAdjustmentMapping(tables, { ...mapping, headerRow: 0 }, ctx()).report).toMatchObject({ ok: false, committable: false });
    // Pointing at the title row would have put the Carrier Cost column (further down the file) out of the guard's sight: the row is the detected one, never another.
    expect(adjustmentMappingSchema.safeParse({ ...mapping, headerRow: 51 }).success).toBe(false);
  });

  it("a workbook sheet with a notes sheet first is read from the sheet that has the column names; a sheet with none is never mapped", async () => {
    const notes: Table = { name: "Notes", rows: [["How to use this file", "", ""], ["Fill in the second sheet", "", ""]], truncated: false };
    const data: Table = { name: "History", rows: [H, row()], truncated: false };
    const detection = detectAdjustmentFile([notes, data], ctx());
    expect(detection.sheets.map((s) => [s.name, s.recognised])).toEqual([["Notes", false], ["History", true]]);
    expect(detection.suggestion.sheet).toBe("History");
    expect(detection.sheets[0]!.headers).toEqual([]);
    const onlyNotes = detectAdjustmentFile([notes], ctx());
    expect(onlyNotes.notes).toEqual([NO_HEADER_ROW_MESSAGE]);
  });
});

// ---------------------------------------------------------------------------
// F3: encodings, wide files, the replacement character
// ---------------------------------------------------------------------------
describe("F3: UTF-16 and binary text, sheets wider than 200 columns, text that was not UTF-8", () => {
  const WITH_COST = "ship_date,carrier,adjustment_type,Carrier Cost\r\n2026-01-01,UPS,reweight,9.50\r\n";
  const utf16le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const utf16be = (text: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);

  it.each([
    ["UTF-16LE with a byte order mark", utf16le(WITH_COST)],
    ["UTF-16BE with a byte order mark", utf16be(WITH_COST)],
    ["UTF-16LE tab separated (Excel 'Unicode Text')", utf16le(WITH_COST.replace(/,/g, "\t"))],
    ["a NUL byte in an otherwise plain file", Buffer.from(`ship_date,carrier,adjustment_type,Carrier\u0000Cost\n2026-01-01,UPS,reweight,9.50\n`)],
    ["a NUL byte only in a data row", Buffer.from("ship_date,carrier,adjustment_type\n2026-01-01,UPS,rew\u0000eight\n")],
  ])("%s is refused with 'save as CSV UTF-8' and nothing is stored", async (_label, bytes) => {
    for (const source of [{ filename: "x.csv", mimeType: "text/csv" }, { filename: "x.txt", mimeType: "text/plain" }, "csv" as const]) {
      const parsed = await parseAdjustmentFile(new Uint8Array(bytes), source);
      expect(parsed).toMatchObject({ status: "error", code: "unreadable", message: ENCODING_MESSAGE });
      expect((parsed as { message: string }).message).toContain("CSV UTF-8");
      expect("tables" in parsed).toBe(false);
    }
  });

  it("the encoding test reads the byte order mark and any NUL byte on their own: UTF-16 text is unreadable even when no byte is NUL, and a UTF-8 mark is fine", () => {
    expect(isUnreadableText(new Uint8Array([0xff, 0xfe, 0x61, 0x62]))).toBe(true);
    expect(isUnreadableText(new Uint8Array([0xfe, 0xff, 0x61, 0x62]))).toBe(true);
    expect(isUnreadableText(new Uint8Array([0x61, 0x00, 0x62]))).toBe(true);
    expect(isUnreadableText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]))).toBe(false);
    expect(isUnreadableText(enc("ship_date,carrier\n2026-01-01,UPS\n"))).toBe(false);
    expect(isUnreadableText(new Uint8Array([0xff]))).toBe(false);
    expect(isUnreadableText(new Uint8Array([]))).toBe(false);
  });

  it("a sheet wider than 200 columns is refused, never cut: a cost header in column 201 is not left unchecked", async () => {
    const plain = (n: number) => Array.from({ length: n }, (_, i) => `note ${i}`);
    const wideHeader = ["ship_date", "carrier", "adjustment_type", ...plain(196), "Net Amount", "Carrier Cost"]; // 201 columns
    expect(wideHeader).toHaveLength(201);
    const parsed = await parseAdjustmentFile(enc(csv(wideHeader, wideHeader.map(() => "1"))), "csv");
    expect(parsed).toMatchObject({ status: "error", code: "too_large" });
    expect((parsed as { message: string }).message).toContain("more than 200 columns");
    // With the same two headers at columns 199 and 200 the guard sees them.
    const fits = ["ship_date", "carrier", "adjustment_type", ...plain(195), "Net Amount", "Carrier Cost"];
    expect(fits).toHaveLength(200);
    expect(await parseAdjustmentFile(enc(csv(fits, fits.map(() => "1"))), "csv")).toMatchObject({ status: "refused" });
  });

  it("a data row wider than 200 columns is refused too; empty cells past column 200 do not count", async () => {
    const header = ["ship_date", "carrier", "adjustment_type"];
    const wideData = [...header.map(() => "1"), ...Array.from({ length: 198 }, () => ""), "x"]; // 202 cells, the last one filled
    expect(await parseAdjustmentFile(enc(csv(header, wideData)), "csv")).toMatchObject({ status: "error", code: "too_large" });
    const trailingEmpties = `${[...header, ...Array.from({ length: 210 }, () => "")].join(",")}\n2026-01-01,UPS,reweight\n`;
    expect(await parseAdjustmentFile(enc(trailingEmpties), "csv")).toMatchObject({ status: "ok" });
  });

  it("a header with the replacement character (a file in a legacy encoding) is refused, naming the column and the fix", async () => {
    const parsed = await parseAdjustmentFile(enc(csv(["ship_date", "carrier", "adjustment_type", "Co\ufffdst"], ["2026-01-01", "UPS", "reweight", "1"])), "csv");
    expect(parsed.status).toBe("refused");
    expect((parsed as { message: string }).message).toContain('save the file as "CSV UTF-8"');
    // A windows-1252 byte is decoded to U+FFFD by the shared parser, so a header written in that encoding is caught the same way.
    const latin1 = Buffer.concat([Buffer.from("ship_date,carrier,adjustment_type,Pr"), Buffer.from([0xe9]), Buffer.from("cis\n2026-01-01,UPS,reweight,1\n")]);
    expect((await parseAdjustmentFile(new Uint8Array(latin1), "csv")).status).toBe("refused");
  });

  it("a package reference with the replacement character is an error row, not a stored reference", async () => {
    const latin1Ref = Buffer.concat([Buffer.from(`${H.join(",")}\n2026-09-01,UPS,UPS Ground,Alpha Apparel,reweight,carrier_reweigh,,1Z`), Buffer.from([0xe9]), Buffer.from(",3,5,lb,12.00,13.50,3.00\n")]);
    const parsed = await parseAdjustmentFile(new Uint8Array(latin1Ref), "csv");
    if (parsed.status !== "ok") throw new Error(parsed.status);
    const mapping = detectAdjustmentFile(parsed.tables, ctx()).suggestion;
    const { report, records } = applyAdjustmentMapping(parsed.tables, mapping, ctx());
    expect(report.byCode.invalid_package_ref).toBe(1);
    expect(report.committable).toBe(false);
    expect(records).toEqual([]);
    expect(readPackageRef("1Z\ufffd9")).toBe("invalid");
    expect(canonicalPackageRef("1Z\ufffd9")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F4: obfuscated headers
// ---------------------------------------------------------------------------
describe("F4: invisible, look-alike and fullwidth characters do not get a cost header past the guard", () => {
  const OBFUSCATED = ["Co\u200bst", "Cos\u200dt", "Co\u00adst", "\u0421ost", "C\u043est", "\uff23\uff2f\uff33\uff34", "\uff23\uff41\uff52\uff52\uff49\uff45\uff52 \uff23\uff4f\uff53\uff54", "C\u00f3st", "Co\u017ft"];

  it.each(OBFUSCATED)("the header %j is refused when it is in a file", async (header) => {
    const parsed = await parseAdjustmentFile(enc(csv(["ship_date", "carrier", "adjustment_type", header], ["2026-01-01", "UPS", "reweight", "1"])), "csv");
    expect(parsed.status).toBe("refused");
  });

  it("every look-alike letter of the fold table, in place of a letter of 'Carrier Cost', is refused", () => {
    const target = "Carrier Cost";
    const imitating = (letter: string) => CONFUSABLE_CHARACTERS.filter((c) => foldHeader(c) === letter);
    let tried = 0;
    for (let i = 0; i < target.length; i++) {
      for (const sub of imitating(target[i]!)) {
        tried++;
        const header = target.slice(0, i) + sub + target.slice(i + 1);
        expect(guardHeader(header).allowed, JSON.stringify(header)).toBe(false);
      }
    }
    expect(tried).toBeGreaterThan(20);
  });

  it("a header that is nothing but invisible or symbol characters is refused (a header that reads as nothing is a header nobody could check), unless it is a template header", () => {
    for (const header of ["#", "$", "\u200b", "\u200b\u200b", "\uff0a", "\u2063", "\u00ad"]) expect(guardHeader(header), JSON.stringify(header)).toMatchObject({ allowed: false });
    for (const header of ["", "   ", "\t"]) expect(guardHeader(header).allowed, JSON.stringify(header)).toBe(true);
    for (const header of ["ship_date", "SHIP DATE", "Customer_Charge_Corrected"]) expect(guardHeader(header).allowed, header).toBe(true);
  });

  it("a header in a script the guard cannot read, or a mix of scripts, is refused rather than waved through", () => {
    for (const header of ["\u4e1c\u4eac", "\u0434\u0430\u0442\u0430 ship", "\u03a3\u03c4\u03bf\u03b9\u03c7\u03b5\u03af\u03bf"]) expect(guardHeader(header).allowed, header).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F5: ragged rows
// ---------------------------------------------------------------------------
describe("F5: a row with a different number of cells than the column names", () => {
  const RAGGED = [
    "ship_date,carrier,adjustment_type,package_ref,customer_charge_original,customer_charge_corrected",
    "2026-09-01,UPS,reweight,PKG-7,12.00,13.50",
    "2026-09-02,UPS,reweight,PKG,8,12.00,13.50", // an unquoted comma inside the reference: every later cell has moved one column to the left
    "2026-09-03,UPS,reweight,PKG-9",
  ].join("\n");

  it("a row with a non-empty cell beyond the header width is an error row, so its amounts cannot land in the wrong column", async () => {
    const { result } = await okRun(RAGGED);
    expect(result.report.byCode.ragged_row).toBe(1);
    expect(result.report.rowNumbers.ragged_row).toEqual([2]);
    expect(result.report.counts).toMatchObject({ rows: 3, errorRows: 1 });
    expect(result.report.committable).toBe(false);
    // The review's reproduction stored PKG with 8.00 and 12.00 (a difference of 4.00 where the file says 1.50); no record is made of that row now.
    expect(result.records.map((r) => r.packageRef)).toEqual(["PKG-7", "PKG-9"]);
    expect(result.records.map((r) => [r.originalCharge, r.correctedCharge])).toEqual([["12.00", "13.50"], [null, null]]);
    const sentence = result.report.codes.find((c) => c.code === "ragged_row")!;
    expect(sentence.severity).toBe("error");
    expect(sentence.message).toMatch(/^Data row 2 has more cells than the column names/);
    expect(sentence.message).toContain("put quotes around that text");
    expect(sentence.message).not.toMatch(/PKG|8\.00|13\.50/);
  });

  it("a row with fewer cells than the column names is information when a mapped column is missing, and its missing amounts are unknown, not zero", async () => {
    const { result } = await okRun(RAGGED);
    expect(result.report.byCode.short_row).toBe(1);
    expect(result.report.rowNumbers.short_row).toEqual([3]);
    expect(result.report.codes.find((c) => c.code === "short_row")).toMatchObject({ severity: "information", message: expect.stringContaining("unknown, not zero") });
    expect(result.report.byCode.no_amounts).toBe(1);
    // A short row whose missing cells are not mapped is not reported: nothing was lost.
    const trimmed = await okRun("ship_date,carrier,adjustment_type,notes,extra\n2026-09-01,UPS,reweight\n");
    expect(trimmed.result.report.byCode.short_row).toBe(0);
  });

  it("extra cells that are all empty (trailing commas) are not a ragged row", async () => {
    const { result } = await okRun(`${RAGGED.split("\n")[0]}\n2026-09-01,UPS,reweight,PKG-7,12.00,13.50,,,\n`);
    expect(result.report.byCode.ragged_row).toBe(0);
    expect(result.report.committable).toBe(true);
  });

  it("the ragged sentence lists the first rows and counts the rest, and never a cell value", () => {
    expect(sentenceFor("ragged_row", 1, [2])).toMatch(/^Data row 2 has more cells/);
    expect(sentenceFor("ragged_row", 3, [2, 5, 9])).toMatch(/^Data rows 2, 5 and 9 have more cells/);
    expect(sentenceFor("ragged_row", 8, [2, 5, 9, 11, 14, 20, 21, 30])).toMatch(/^Data rows 2, 5, 9, 11, 14 and 3 more have more cells/);
  });

  it("a ragged row is not read as a duplicate of the row before it, and its other problems are not reported (nothing in it can be trusted)", async () => {
    const text = `${RAGGED.split("\n")[0]}\n2026-09-01,UPS,reweight,PKG,12.00,13.50\n2026-09-02,UPS,reweight,PKG,8,12.00,13.50\n`;
    const { result } = await okRun(text);
    expect(result.report.byCode.ragged_row).toBe(1);
    expect(result.report.byCode.duplicate_reference).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F6: duplicate_handling "sum" adds differences, never invents an amount
// ---------------------------------------------------------------------------
describe("F6: summing repeated packages", () => {
  const SUM = (m: AdjustmentMapping) => void (m.duplicateHandling = "sum");
  const MONEY_HEADER = ["ship_date", "carrier", "brand", "adjustment_type", "package_ref", "customer_charge_original", "customer_charge_corrected", "customer_adjustment_fee"];
  const moneyFile = (...rows: string[][]) => csv(MONEY_HEADER, ...rows.map(([original, corrected, fee]) => ["2026-09-01", "UPS", "Alpha Apparel", "reweight", "1Z0001", original ?? "", corrected ?? "", fee ?? ""]));
  const only = (r: { records: AdjustmentRecord[] }) => {
    expect(r.records).toHaveLength(1);
    return r.records[0]!;
  };

  it("the review's case: an original charge missing on the first row and present on the second no longer produces a postage difference of 15.00", async () => {
    const { result } = await okRun(moneyFile(["", "13.50"], ["12.00", "13.50"]), SUM);
    const r = only(result);
    // Either row alone is unknown or 1.50; 12.00 beside 27.00 was invented. The pair is unknown, not zero, and the report says so.
    expect([r.originalCharge, r.correctedCharge, r.separateFee]).toEqual([null, null, null]);
    expect(result.report.byCode).toMatchObject({ merged_duplicate: 1, merged_amounts_unknown: 1 });
    expect(result.report.committable).toBe(true);
    expect(result.report.codes.find((c) => c.code === "merged_amounts_unknown")!.message).toContain("unknown, not zero");
  });

  it("two complete rows keep the first row's charges and add the second row's DIFFERENCE: 12.00 to 13.50 twice is 12.00 to 15.00 (a difference of 3.00)", async () => {
    const { result } = await okRun(moneyFile(["12.00", "13.50"], ["12.00", "13.50"]), SUM);
    const r = only(result);
    expect([r.originalCharge, r.correctedCharge]).toEqual(["12.00", "15.00"]);
    expect(result.report.byCode.merged_amounts_unknown).toBe(0);
  });

  it("three rows: 12.00 to 13.50, 10.00 to 10.75 and 8.00 to 8.00 add differences of 1.50, 0.75 and 0.00 to the first row's pair", async () => {
    const { result } = await okRun(moneyFile(["12.00", "13.50"], ["10.00", "10.75"], ["8.00", "8.00"]), SUM);
    const r = only(result);
    expect([r.originalCharge, r.correctedCharge]).toEqual(["12.00", "14.25"]);
  });

  it("a repeat that is a credit lowers the corrected charge by its difference; one so large that no charge could be that low makes the pair unknown", async () => {
    const credit = only((await okRun(moneyFile(["12.00", "13.50"], ["12.00", "11.00"]), SUM)).result);
    expect([credit.originalCharge, credit.correctedCharge]).toEqual(["12.00", "12.50"]);
    const tooLarge = (await okRun(moneyFile(["12.00", "13.50"], ["30.00", "10.00"]), SUM)).result;
    expect([only(tooLarge).originalCharge, only(tooLarge).correctedCharge]).toEqual([null, null]);
    expect(tooLarge.report.byCode.merged_amounts_unknown).toBe(1);
  });

  it("separate fees are added only when both rows have one; otherwise the merged fee is unknown and the report says so; two blank fees stay blank without a word", async () => {
    const both = only((await okRun(moneyFile(["12.00", "13.50", "3.00"], ["12.00", "13.50", "3.00"]), SUM)).result);
    expect(both.separateFee).toBe("6.00");
    const oneBlank = await okRun(moneyFile(["12.00", "13.50", "3.00"], ["12.00", "13.50", ""]), SUM);
    expect(only(oneBlank.result).separateFee).toBeNull();
    expect(oneBlank.result.report.byCode.merged_amounts_unknown).toBe(1);
    expect([only(oneBlank.result).originalCharge, only(oneBlank.result).correctedCharge]).toEqual(["12.00", "15.00"]);
    const noneAtAll = await okRun(moneyFile(["", ""], ["", ""]), SUM);
    expect([only(noneAtAll.result).originalCharge, only(noneAtAll.result).correctedCharge, only(noneAtAll.result).separateFee]).toEqual([null, null, null]);
    expect(noneAtAll.result.report.byCode.merged_amounts_unknown).toBe(0);
  });

  it("property: with every amount known the merged difference is the sum of the differences; with any amount unknown the pair is unknown (3,000 seeded merges)", () => {
    let seed = 20261016;
    const next = (n: number) => (seed = (seed * 1664525 + 1013904223) % 4294967296) % n;
    const money = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    const blank = (p: number) => next(100) < p;
    const make = (): AdjustmentRecord => ({ originalCharge: blank(15) ? null : money(next(50_000)), correctedCharge: blank(15) ? null : money(next(50_000)), separateFee: blank(20) ? null : money(next(5_000)) }) as AdjustmentRecord;
    let known = 0;
    for (let i = 0; i < 3000; i++) {
      const a = make();
      const b = make();
      const before = { a: { ...a }, b: { ...b } };
      const lost = mergeAmounts(a, b);
      const bothPairs = before.a.originalCharge !== null && before.a.correctedCharge !== null && before.b.originalCharge !== null && before.b.correctedCharge !== null;
      if (bothPairs) {
        const cents = (v: string) => Math.round(Number(v) * 100);
        const sum = cents(before.a.correctedCharge!) + cents(before.b.correctedCharge!) - cents(before.b.originalCharge!);
        if (sum < 0) expect([a.originalCharge, a.correctedCharge], "no negative charge").toEqual([null, null]);
        else {
          known++;
          expect(a.originalCharge).toBe(before.a.originalCharge);
          expect(cents(a.correctedCharge!) - cents(a.originalCharge!)).toBe(cents(before.a.correctedCharge!) - cents(before.a.originalCharge!) + cents(before.b.correctedCharge!) - cents(before.b.originalCharge!));
        }
      } else {
        expect([a.originalCharge, a.correctedCharge], "an unknown amount is never carried over from one row to the other").toEqual([null, null]);
        expect(lost).toBe([before.a.originalCharge, before.a.correctedCharge, before.b.originalCharge, before.b.correctedCharge].some((v) => v !== null) || lost);
      }
      expect(a.separateFee === null).toBe(before.a.separateFee === null || before.b.separateFee === null);
    }
    expect(known).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// F7: customers in other scripts
// ---------------------------------------------------------------------------
describe("F7: customer, carrier and value-map matching with names that are not Latin letters", () => {
  const cyrillic = [{ id: ID.alpha, name: "Яндекс" }, { id: ID.beta, name: "Beta Beverages" }]; // Яндекс
  const CUSTOMER_FILE = file([
    { brand: "Сбербанк", package_ref: "R1" }, // Сбербанк
    { brand: "東京商店", package_ref: "R2" }, // 東京商店
    { brand: "Яндекс", package_ref: "R3" }, // Яндекс
  ]);

  it("the review's case: only the customer whose name is written the same way is matched; the other scripts are unknown customers, not the one brand that also read as empty", async () => {
    const { result, detection } = await okRun(CUSTOMER_FILE, undefined, { brands: cyrillic });
    expect(result.records.map((r) => r.brandId)).toEqual([null, null, ID.alpha]);
    expect(result.report.byCode.unknown_customer).toBe(2);
    expect(result.report.customers.map((c) => [c.text, c.rows, c.brandId]).sort()).toEqual([["Сбербанк", 1, null], ["Яндекс", 1, ID.alpha], ["東京商店", 1, null]].sort());
    // The value-map step now lists every customer text (the empty key hid them all before).
    void detection;
    const listed = detectAdjustmentFile((await okRun(CUSTOMER_FILE)).tables, { catalog, brands: cyrillic }).distinct.customers;
    expect(listed.map((c) => c.text).sort()).toEqual(["Сбербанк", "Яндекс", "東京商店"].sort());
    expect(listed.find((c) => c.text === "Яндекс")!.suggested).toBe(ID.alpha);
  });

  it("two brands written in other scripts are told apart; with two customers that read the same, nobody is guessed", async () => {
    const two = [{ id: ID.alpha, name: "Яндекс" }, { id: ID.beta, name: "東京商店" }];
    const { result } = await okRun(CUSTOMER_FILE, undefined, { brands: two });
    expect(result.records.map((r) => r.brandId)).toEqual([null, ID.beta, ID.alpha]);
    const twins = [{ id: ID.alpha, name: "Яндекс" }, { id: ID.beta, name: "яндекс" }];
    expect((await okRun(CUSTOMER_FILE, undefined, { brands: twins })).result.records.map((r) => r.brandId)).toEqual([null, null, null]);
  });

  it("a name with no letter or digit has the empty key, which matches nobody, however many names read as nothing", async () => {
    expect(normalizeValue("!!!")).toBe("");
    expect(suggestBrand("", [{ id: ID.alpha, name: "!!!" }, { id: ID.beta, name: "Beta" }])).toBeNull();
    expect(suggestBrand("", [{ id: ID.alpha, name: "!!!" }])).toBeNull();
    expect(suggestCarrier("", [{ id: "s", carrierCode: "x", carrierName: "!!", code: "g", name: "G" }])).toBeNull();
    const bang = [{ id: ID.alpha, name: "!!!" }];
    const { result } = await okRun(file([{ brand: "???" }, { brand: "!!!", package_ref: "Z2" }]), undefined, { brands: bang });
    expect(result.records.map((r) => r.brandId)).toEqual([null, null]);
    expect(result.report.byCode.unknown_customer).toBe(2);
    // A value-map entry under the empty key is never consulted either.
    const mapped = await okRun(file([{ brand: "???" }]), (m) => void (m.brandMap[""] = ID.alpha), { brands: bang });
    expect(mapped.result.records.map((r) => r.brandId)).toEqual([null]);
  });

  it("the key is Unicode-aware: compatibility forms and invisible characters do not change it, and every script has one", () => {
    expect(normalizeValue("\uff21\uff4c\uff50\uff48\uff41  Apparel")).toBe("alpha apparel");
    expect(normalizeValue("Al\u200bpha")).toBe("alpha");
    expect(normalizeValue("Яндекс, Inc.")).toBe("яндекс inc");
    expect(normalizeValue("\u6771\u4eac\u5546\u5e97")).toBe("\u6771\u4eac\u5546\u5e97");
    expect(normalizeValue("Caf\u00e9")).toBe("caf\u00e9");
  });
});

// ---------------------------------------------------------------------------
// F8: the 8 KB mapping is never a dead end
// ---------------------------------------------------------------------------
describe("F8: value maps are compacted, and the cause list is capped", () => {
  const names = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i));

  it("500 distinct reasons and no cause column: the suggested mapping stays far below the limit, the file validates, and the cause list says it is capped", async () => {
    const rows: RowFields[] = names(500, (i) => `Operator remark number ${i}`).map((reason, i) => ({ reason, cause: "", package_ref: `P${i}` }));
    const text = csv(H.filter((h) => h !== "cause"), ...rows.map((r) => row(r).filter((_, i) => H[i] !== "cause")));
    const { detection, result, tables, mapping } = await okRun(text);
    expect(Object.keys(detection.suggestion.causeMap).length).toBeLessThanOrEqual(50);
    expect(detection.distinct.causes.length).toBeLessThanOrEqual(50);
    expect(jsonbSizeEstimate(toStoredMapping(detection.suggestion, tables[0]!.rows[0]!, ctx()))).toBeLessThan(MAPPING_MAX_BYTES);
    expect(validateMapping(mapping, tables, ctx()).map((i) => i.code)).not.toContain("mapping_too_large");
    expect(result.report.committable).toBe(true);
    expect(result.records.every((r) => r.cause === "other")).toBe(true);
    expect(detection.notes.join(" ")).toMatch(/500 different causes or reasons/);
  });

  it("500 distinct reasons that each read as a named cause keep entries for the 50 most common only; the rest are stored under the default cause, and the 3PL is told", async () => {
    // "WMS sent no weight, case N" reads as the cause wms_no_weight, which is not what an unmatched text gets, so each one would need an entry of its own.
    const rows: RowFields[] = names(500, (i) => `WMS sent no weight, case ${i}`).map((reason, i) => ({ reason, cause: "", package_ref: `W${i}` }));
    const text = csv(H.filter((h) => h !== "cause"), ...rows.map((r) => row(r).filter((_, i) => H[i] !== "cause")));
    const { detection, result, tables } = await okRun(text);
    expect(Object.keys(detection.suggestion.causeMap)).toHaveLength(50);
    expect(detection.distinct.causes).toHaveLength(50);
    expect(Object.values(detection.suggestion.causeMap).every((c) => c === "wms_no_weight")).toBe(true);
    expect(validateMapping(detection.suggestion, tables, ctx())).toEqual([]);
    expect(jsonbSizeEstimate(toStoredMapping(detection.suggestion, tables[0]!.rows[0]!, ctx()))).toBeLessThan(MAPPING_MAX_BYTES);
    expect(result.report.committable).toBe(true);
    expect(result.records.filter((r) => r.cause === "wms_no_weight")).toHaveLength(50);
    expect(result.records.filter((r) => r.cause === "other")).toHaveLength(450);
    expect(detection.notes.join(" ")).toContain("The 50 most common are matched to a cause; the others are stored under the default cause");
  });

  it("400 distinct customers that match nobody store no entries at all, and every row still validates", async () => {
    const text = file(names(400, (i) => `Customer ${i} Trading Company`).map((brand, i) => ({ brand, package_ref: `C${i}` })));
    const { detection, result, tables, mapping } = await okRun(text);
    expect(detection.suggestion.brandMap).toEqual({});
    expect(jsonbSizeEstimate(toStoredMapping(mapping, tables[0]!.rows[0]!, ctx()))).toBeLessThan(2_000);
    expect(validateMapping(mapping, tables, ctx())).toEqual([]);
    expect(result.report.counts).toMatchObject({ rows: 400, accepted: 400 });
    expect(result.report.byCode.unknown_customer).toBe(400);
    // The most common of them are listed for the value-map step (the list is capped, the mapping is not affected).
    expect(detection.distinct.customers.length).toBe(400);
  });

  it("compactMapping drops exactly the entries that applying the mapping works out by itself: the result applies identically, and compacting twice changes nothing", async () => {
    const text = file([
      { brand: "Alpha Apparel", carrier: "UPS", adjustment_type: "reweight", cause: "scale error", package_ref: "A1" },
      { brand: "alfa", carrier: "ups", adjustment_type: "Re-weigh", cause: "WMS sent no weight", package_ref: "A2" },
      { brand: "Beta Beverages", carrier: "USPS", adjustment_type: "dims", cause: "mystery", package_ref: "A3" },
      { brand: "Nobody Ltd", carrier: "fedex?", adjustment_type: "reweight", cause: "other", package_ref: "A4" },
    ]);
    const { tables, mapping } = await okRun(text);
    const full: AdjustmentMapping = {
      ...mapping,
      // Redundant entries (what the old detect wrote) beside the choices a person made.
      typeMap: { reweight: "reweight", remeasure: "remeasure", "re weigh": "reweight", dims: "remeasure", "something else": null },
      causeMap: { "scale error": "scale_error", "wms sent no weight": "wms_no_weight", mystery: "other", other: "other" },
      carrierMap: { ups: "ups", usps: "usps", "fedex": null, fedex_x: null },
      serviceMap: { "ups ground": ID.ups, "usps ground": null },
      brandMap: { "alpha apparel": ID.alpha, "beta beverages": ID.beta, alfa: ID.alpha, "nobody ltd": null },
    };
    const compact = compactMapping(full, ctx());
    expect(compact.typeMap).toEqual({ "re weigh": "reweight", dims: "remeasure" });
    expect(compact.causeMap).toEqual({ "wms sent no weight": "wms_no_weight" });
    expect(compact.carrierMap).toEqual({});
    expect(compact.serviceMap).toEqual({ "ups ground": ID.ups });
    expect(compact.brandMap).toEqual({ alfa: ID.alpha });
    expect(compactMapping(compact, ctx())).toEqual(compact);
    const withFull = applyAdjustmentMapping(tables, full, ctx());
    const withCompact = applyAdjustmentMapping(tables, compact, ctx());
    expect(withCompact.records).toEqual(withFull.records);
    // The only difference is information: "mystery" was mapped to "other" by a person in the full mapping and is "not matched" without the entry, and
    // either way it is stored under the default cause "other". Everything else, the counts and every error included, is the same.
    const { cause_defaulted: compactDefaulted, ...compactCodes } = withCompact.report.byCode;
    const { cause_defaulted: fullDefaulted, ...fullCodes } = withFull.report.byCode;
    expect(compactCodes).toEqual(fullCodes);
    expect([fullDefaulted, compactDefaulted]).toEqual([0, 1]);
    expect(withCompact.report.counts).toEqual(withFull.report.counts);
  });

  it("a choice that differs from what the text would give by itself is kept, so a person's decision is never compacted away", () => {
    const base: AdjustmentMapping = { ...({} as AdjustmentMapping), defaults: { adjustmentType: null, cause: "scale_error", brandId: null }, typeMap: { reweight: null }, causeMap: { other: "other", reason: "other" }, carrierMap: { ups: null }, serviceMap: {}, brandMap: { "alpha apparel": null } };
    const kept = compactMapping(base, ctx());
    // "reweight" declined, a free text mapped to "other" under a default cause that is not "other", UPS declined, and an exact customer name left
    // unassigned: all four are the person's own choices. ("other" spelled as a cause is recomputed from its spelling, so it needs no entry.)
    expect(kept.typeMap).toEqual({ reweight: null });
    expect(kept.causeMap).toEqual({ reason: "other" });
    expect(kept.carrierMap).toEqual({ ups: null });
    expect(kept.brandMap).toEqual({ "alpha apparel": null });
  });

  it("a mapping a person posts with a NUL or a control character in a value-map key is refused before it can fail a database call", () => {
    const valid = detectAdjustmentFile([{ name: "S", rows: [H, row()], truncated: false }], ctx()).suggestion;
    expect(adjustmentMappingSchema.safeParse(valid).success).toBe(true);
    for (const key of ["a\u0000b", "a\nb", "\ud800", "x\u007f"]) {
      expect(adjustmentMappingSchema.safeParse({ ...valid, brandMap: { [key]: null } }).success, JSON.stringify(key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// F9: the stored report is bounded whatever the file's headers are
// ---------------------------------------------------------------------------
describe("F9: ignored and amount columns, headers of every length, NUL characters", () => {
  const wideHeaders = (n: number, make: (i: number) => string) => ["ship_date", "carrier", "adjustment_type", ...Array.from({ length: n }, (_, i) => make(i))];

  it("200 columns of 120-character headers: the report lists at most 50, each cut to 80 characters, and the stored report is under 24 KB by the jsonb measure", async () => {
    const headers = wideHeaders(197, (i) => `Column ${String(i).padStart(3, "0")} `.padEnd(120, "q"));
    expect(headers).toHaveLength(200);
    const { result } = await okRun(csv(headers, ["2026-09-01", "UPS", "reweight", ...headers.slice(3).map(() => "1")]));
    expect(result.report.committable).toBe(true);
    expect(result.report.ignoredColumns).toHaveLength(50);
    expect(result.report.ignoredColumns.every((c) => c.header.length <= 80)).toBe(true);
    const stored = toStoredValidation(result.report);
    expect(jsonbSizeEstimate(stored)).toBeLessThanOrEqual(STORED_VALIDATION_MAX_BYTES);
    expect(stored.counts).toEqual(result.report.counts);
  });

  it("amount columns that need a choice are capped at 50 and their headers cleaned and cut", async () => {
    const headers = wideHeaders(120, (i) => `Customer Charge ${i} `.padEnd(150, "z"));
    const { detection } = await okRun(csv(headers, headers.map(() => "1")));
    expect(detection.amountColumnsNeedingChoice).toHaveLength(50);
    expect(detection.amountColumnsNeedingChoice.every((c) => c.header.length <= 80)).toBe(true);
  });

  it("a header with a NUL (binary garbage) cannot make the report or the details fail the database: NUL and lone surrogates become spaces everywhere", () => {
    const table: Table = { name: "S", rows: [["ship_date", "carrier", "adjustment_type", "bad\u0000name", "second\u0000column"], ["2026-09-01", "UPS", "reweight", "1", "2"]], truncated: false };
    const detection = detectAdjustmentFile([table], ctx());
    const { report } = applyAdjustmentMapping([table], detection.suggestion, ctx());
    const stored = toStoredValidation(report);
    const everything = JSON.stringify([stored, buildDetected([table], detection.suggestion), toStoredMapping(detection.suggestion, table.rows[0]!, ctx())]);
    expect(everything).not.toContain("\\u0000");
    expect(everything).not.toMatch(/\\ud800(?!\\udc)/i);
    expect(stored.ignoredColumns.map((c) => c.header)).toEqual(["bad name", "second column"]);
    expect(scrubJsonb({ ["k\u0000"]: ["a\u0000b", { v: "\ud800" }], n: 3, ok: "\ud83d\ude00" })).toEqual({ "k ": ["a b", { v: " " }], n: 3, ok: "\ud83d\ude00" });
  });

  it("a pathological report is cut to the limit in a fixed order and keeps the counts the database reads", () => {
    const sheet: Table = { name: "S", rows: [H, row()], truncated: false };
    const base = applyAdjustmentMapping([sheet], detectAdjustmentFile([sheet], ctx()).suggestion, ctx()).report;
    const rowNumbers = Object.fromEntries(Object.keys(base.byCode).map((c) => [c, Array.from({ length: 50 }, (_, i) => i + 1)]));
    const customers = Array.from({ length: 50 }, (_, i) => ({ text: `Customer ${i} `.padEnd(120, "c"), rows: 1, brandId: null }));
    const ignoredColumns = Array.from({ length: 50 }, (_, i) => ({ index: i, header: `h${i} `.padEnd(80, "h"), moneyLike: i % 2 === 0 }));
    const issues = Array.from({ length: 100 }, (_, i) => ({ code: "invalid_date" as const, severity: "error" as const, row: i + 1 }));
    const report = { ...base, rowNumbers, customers, ignoredColumns, issues, issuesTruncated: false };
    // The report as built is over the limit, so the cut is really exercised.
    expect(jsonbSizeEstimate(report)).toBeGreaterThan(STORED_VALIDATION_MAX_BYTES);
    const stored = toStoredValidation(report);
    expect(jsonbSizeEstimate(stored)).toBeLessThanOrEqual(STORED_VALIDATION_MAX_BYTES);
    expect(stored.counts).toEqual(report.counts);
    expect(stored.issuesTruncated).toBe(true);
  });

  it("the details stored with an import (header names and sample rows) stay under the database's 64 KB however long the cells are: sample rows are dropped from the end, the headers are kept", () => {
    const fields = ["ship_date", "adjusted_on", "carrier", "service", "brand", "adjustment_type", "cause", "reason", "package_ref", "declared_weight", "actual_weight", "weight_unit", "original_length", "original_width", "original_height", "corrected_length", "corrected_width", "corrected_height", "dimension_unit", "customer_charge_original", "customer_charge_corrected", "customer_adjustment_fee", "handling"];
    const junk = (i: number) => fields.map((f, c) => `${f}-${i}-${c} `.padEnd(150, "j"));
    const table: Table = { name: "S", rows: [fields, ...Array.from({ length: 30 }, (_, i) => junk(i))], truncated: false };
    const detection = detectAdjustmentFile([table], ctx());
    const detected = buildDetected([table], detection.suggestion);
    expect(Object.values(detection.suggestion.columns).filter((c) => c !== null)).toHaveLength(23);
    expect(jsonbSizeEstimate(detected)).toBeLessThanOrEqual(DETECTED_MAX_BYTES);
    expect(detected.sampleRows.length).toBeGreaterThan(0);
    expect(detected.sampleRows.length).toBeLessThan(20);
    expect(detected.headers).toEqual(fields);
    // An ordinary file keeps all twenty sample rows.
    const ordinary: Table = { name: "S", rows: [H, ...Array.from({ length: 30 }, (_, i) => row({ package_ref: `P${i}` }))], truncated: false };
    expect(buildDetected([ordinary], detectAdjustmentFile([ordinary], ctx()).suggestion).sampleRows).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// F12: package reference identity
// ---------------------------------------------------------------------------
describe("F12: one package, one key", () => {
  const refs = fixtureJson<{ cases: { input: string; canonical: string | null; note: string }[] }>("package-refs.json");

  it("the TypeScript canonical form gives every hand-derived answer of package-refs.json (the database test runs the same list through app.canon_package_ref)", () => {
    expect(refs.cases.length).toBeGreaterThanOrEqual(30);
    expect(refs.cases.filter((c) => canonicalPackageRef(c.input) !== c.canonical).map((c) => `${JSON.stringify(c.input)}: ${c.note}`)).toEqual([]);
  });

  it("spellings of one reference are duplicates in one file: case, internal spaces and a zero-width character no longer make four packages", async () => {
    const { result } = await okRun(file(["1Z0001AB", "1z0001ab", "1Z0001 AB", "1Z0001AB\u200b"].map((package_ref) => ({ package_ref }))));
    expect(result.report.byCode.duplicate_reference).toBe(3);
    expect(result.report.counts.accepted).toBe(1);
    expect(result.records[0]!.packageRef).toBe("1Z0001AB");
  });

  it("'already imported' reads another spelling of the same package as the same package, and a different carrier, customer or type as another", async () => {
    const existing = new Set([adjustmentRecordKey(ID.alpha, "ups", "1z 0001 ab", "reweight")]);
    const { result } = await okRun(file([{ package_ref: "1Z0001AB" }, { package_ref: "1Z0001AB", adjustment_type: "remeasure" }, { package_ref: "1Z0001AB", brand: "Beta Beverages" }]), undefined, { existingKeys: existing });
    expect(result.report.byCode.already_imported).toBe(1);
    expect(result.report.rowNumbers.already_imported).toEqual([1]);
    expect(result.records.map((r) => [r.adjustmentType, r.brandId])).toEqual([["remeasure", ID.alpha], ["reweight", ID.beta]]);
    const k = (ref: string) => adjustmentRecordKey("b", "ups", ref, "reweight");
    expect(new Set(["1Z0001AB", "1z0001ab", "1Z0001 AB", "1Z0001AB\u200b", " 1z 0001 ab "].map(k)).size).toBe(1);
  });

  it("a reference that is only invisible characters is blank, not a package", () => {
    expect(readPackageRef("\u200b \u2060")).toEqual({ ref: null });
    expect(readPackageRef('  ="1z 99"  ')).toEqual({ ref: "1Z99" });
    expect(readPackageRef("'1z 99")).toEqual({ ref: "1Z99" });
  });
});

// ---------------------------------------------------------------------------
// F13: header refusals
// ---------------------------------------------------------------------------
describe("F13: the refusal names every header and does not accuse a harmless one", () => {
  it("one upload with three bad headers names all three, each with what to do, and keeps the wording about the NAME, not what the column holds", async () => {
    const parsed = await parseAdjustmentFile(enc(csv(["ship_date", "carrier", "adjustment_type", "Net Weight", "Carrier Cost", "Label Date"], ["2026-09-01", "UPS", "reweight", "3", "9.10", "2026-08-30"])), "csv");
    expect(parsed.status).toBe("refused");
    if (parsed.status !== "refused") return;
    expect(parsed.guard.refusedHeaders).toEqual(["Net Weight", "Carrier Cost", "Label Date"]);
    for (const header of ["Net Weight", "Carrier Cost", "Label Date"]) expect(parsed.message).toContain(`"${header}"`);
    expect(parsed.message).toContain('rename it "declared_weight" or "actual_weight"'); // for Net Weight
    expect(parsed.message).toContain('rename it "ship_date" or "adjusted_on"'); // for Label Date
    expect(parsed.message).not.toContain("looks like what a carrier bills you");
    expect(parsed.message).not.toMatch(/9\.10|2026-08-30/);
  });

  it("a carrier's own name beside an amount word is refused (UPS Charge, UPS Amount, FedEx Billed) unless the header says the customer paid", () => {
    for (const header of ["UPS Charge", "UPS Amount", "FedEx Billed", "DHL Total", "USPS Price", "OnTrac Fee", "LaserShip Amount"]) expect(guardHeader(header), header).toMatchObject({ allowed: false, reason: "brand_money" });
    for (const header of ["UPS Charge to Customer", "UPS Amount Billed To Customer", "UPS Ground", "Customer UPS Fee"]) expect(guardHeader(header).allowed, header).toBe(true);
    expect(refusalMessage(["UPS Charge"])).toContain("carrier's name and an amount word");
  });

  it("'Billed To Account' and 'Charged To Account' name an account, not an amount: they are never offered as a customer charge; an amount does need a money word", () => {
    for (const header of ["Billed To Account", "Charged To Account", "Bill To Account"]) expect(isAutoMappableMoneyHeader(header), header).toBe(false);
    for (const header of ["Amount Billed To Customer", "Charged To Customer Amount", "Total Charged To Customer", "Fee Charged To Customer"]) expect(isAutoMappableMoneyHeader(header), header).toBe(true);
  });

  it("the headers the review listed as harmless are still asked for a rename, with the reason for the rename, not an accusation", () => {
    for (const header of ["Net Weight", "Carrier Name", "Label ID", "Invoice Number", "Cost Center"]) {
      const message = refusalMessage([header]);
      expect(message, header).toContain(`"${header}"`);
      expect(message).not.toMatch(/looks like (what )?a carrier/i);
    }
  });
});

// ---------------------------------------------------------------------------
// F14: boundaries, row numbers, the cross-file rule
// ---------------------------------------------------------------------------
describe("F14: limits count data rows, rounding cannot push a value over its bound, row numbers say what they count", () => {
  const dataLine = (i: number) => `2026-09-01,UPS,reweight,R${i}`;
  const big = (titles: number, data: number, blank = 0) => `${Array.from({ length: titles }, (_, i) => `Title ${i},x,y`).join("\n")}${titles ? "\n" : ""}ship_date,carrier,adjustment_type,package_ref\n${Array.from({ length: data }, (_, i) => dataLine(i) + (blank && i % blank === 0 ? "\n\n" : "")).join("\n")}\n`;

  it("two title rows and 20,000 data rows are accepted; 20,001 are refused; blank lines never count", async () => {
    expect((await parseAdjustmentFile(enc(big(2, 20_000)), "csv")).status).toBe("ok");
    expect(await parseAdjustmentFile(enc(big(2, 20_001)), "csv")).toMatchObject({ status: "error", code: "too_large", message: expect.stringContaining("more than 20,000 rows") });
    expect((await parseAdjustmentFile(enc(big(0, 19_990, 10)), "csv")).status).toBe("ok");
  });

  it("a value that is inside its bound only before rounding is invalid, as the database would refuse it", () => {
    expect(readWeight("999999.9999996", "", "lb")).toEqual({ status: "invalid" });
    expect(readWeight("999999.999999", "", "lb")).toEqual({ status: "ok", lb: "999999.999999" });
    expect(readWeight("453592.37", "", "kg")).toEqual({ status: "invalid" }); // 1,000,000.0 lb after conversion
    expect(readDimension("999999.99995", "", "in")).toEqual({ status: "invalid" });
    expect(readDimension("999999.9999", "", "in")).toEqual({ status: "ok", inches: "999999.9999" });
    expect(readDimension("2540000", "", "cm")).toEqual({ status: "invalid" });
  });

  it("report row numbers are positions among the rows under the column names that are not blank, in a CSV with blank lines, and the report says so", async () => {
    const text = "Title,x,y\n\nship_date,carrier,adjustment_type\n\n\n2026-09-01,UPS,reweight\n\nnot a date,UPS,reweight\n";
    const { result } = await okRun(text);
    expect(result.report.rowNumbers.invalid_date).toEqual([2]);
    expect(ROW_NUMBERING_NOTE).toBe("Row numbers count the rows under the column names that are not blank (blank lines are not counted).");
    expect(sentenceFor("ragged_row", 1, [2])).toMatch(/^Data row 2/);
  });

  it("the cross-file rule is stated in one place for the wizard: an earlier file's package is skipped even when its amounts differ", () => {
    expect(DUPLICATE_RULE_NOTE).toContain("already added");
    expect(DUPLICATE_RULE_NOTE).toContain("even when its amounts differ");
    expect(DUPLICATE_RULE_NOTE).toContain("Repeats inside this one file");
  });

  it("an already-imported row with different amounts is skipped and counted, never merged into the earlier file's record", async () => {
    const existing = new Set([adjustmentRecordKey(ID.alpha, "ups", "1Z0001", "reweight")]);
    const { result } = await okRun(file([{ customer_charge_corrected: "99.00" }]), undefined, { existingKeys: existing });
    expect(result.report.counts).toMatchObject({ rows: 1, accepted: 0, alreadyImported: 1 });
    expect(result.records).toEqual([]);
  });
});
