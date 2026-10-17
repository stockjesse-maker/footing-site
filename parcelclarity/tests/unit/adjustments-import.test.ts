import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADJUSTMENT_FILE_LIMITS, type Table } from "@/lib/import/parse-table";
import type { ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";
import { addMoney, cleanText, detectDateFormat, isNegativeMoney, normalizeValue, parseMoneyCell, readDimension, readPackageRef, readWeight, shipDateInRange, subtractMoney } from "@/lib/adjustments/cells";
import {
  ADJUSTMENT_TEMPLATE_HEADERS,
  flaggedMappingMessage,
  guardHeader,
  guardHeaders,
  guardTables,
  isAutoMappableMoneyHeader,
  isMoneyLikeHeader,
  isTemplateHeader,
  moneyFieldOfHeader,
  normalizeGuardHeader,
  refusalMessage,
} from "@/lib/adjustments/header-guard";
import { buildDetected, detectAdjustmentFile, fromStoredMapping, MAPPING_MAX_BYTES, serviceKeyOf, suggestCause, suggestType, toStoredMapping, validateMapping } from "@/lib/adjustments/mapping";
import { ATTESTATION_TEXT, HISTORY_EMPTY, IMPORT_LIMITS, IMPORT_NOTICE, MONEY_FIELD_HINT, MONEY_FIELD_LABELS, REFUSAL_TITLE } from "@/lib/adjustments/copy";
import { adjustmentMappingSchema, parseStoredMapping } from "@/lib/adjustments/mapping-schema";
import { parseAdjustmentFile } from "@/lib/adjustments/parse";
import { APPEND_CHUNK_ROWS, buildAppendChunks, ChunkError, reconcileCommit, remainingChunks, toAppendRow } from "@/lib/adjustments/payload";
import { ADJUSTMENTS_TEMPLATE_CSV } from "@/lib/adjustments/template";
import type { AdjustmentContext, AdjustmentMapping, AdjustmentRecord, ImportCode } from "@/lib/adjustments/types";
import { adjustmentRecordKey, applyAdjustmentMapping, sentenceFor, toStoredValidation } from "@/lib/adjustments/validate";
import { weightToLb } from "@/lib/orders/cells";

/**
 * Milestone 5 history import. Expectations come from the hand-derived fixtures in tests/fixtures/adjustments (header-guard.json,
 * import-expected.json) and from reading the CSV files, never from running this library. The kg and g rows of history-sample.csv
 * are not asserted by the goldens: their pound values are derived here with the shared factor (1 kg = 2.20462262185 lb, HALF_UP at
 * six decimals) and pinned.
 */

const fx = (name: string) => path.resolve(__dirname, "../fixtures/adjustments", name);
const read = (name: string) => readFileSync(fx(name));
const json = <T>(name: string): T => JSON.parse(readFileSync(fx(name), "utf8")) as T;

const ID = {
  upsGround: "00000000-0000-4000-8000-0000000000a1",
  uspsGa: "00000000-0000-4000-8000-0000000000a2",
  alpha: "00000000-0000-4000-8000-0000000000b1",
  beta: "00000000-0000-4000-8000-0000000000b2",
};
const catalog: ServiceCatalogEntry[] = [
  { id: ID.upsGround, carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" },
  { id: ID.uspsGa, carrierCode: "usps", carrierName: "USPS", code: "ground_advantage", name: "USPS Ground Advantage" },
];
const brands = [
  { id: ID.alpha, name: "Alpha Apparel" },
  { id: ID.beta, name: "Beta Beverages" },
];
const ctx = (over: Partial<AdjustmentContext> = {}): AdjustmentContext => ({ catalog, brands, today: "2026-10-16", ...over });

const csvTable = (text: string): Table => {
  // Minimal CSV reader for small synthetic files (no quotes): the shared parser is exercised through parseAdjustmentFile elsewhere.
  const rows = text.trim().split("\n").map((l) => l.split(","));
  return { name: "Sheet1", rows, truncated: false };
};

async function load(name: string) {
  const parsed = await parseAdjustmentFile(read(name), "csv");
  if (parsed.status !== "ok") throw new Error(`fixture ${name} was not accepted: ${parsed.status}`);
  return parsed.tables;
}

// ---------------------------------------------------------------------------
// Header guard
// ---------------------------------------------------------------------------
interface GuardCase { header: string; guard: "pass" | "refuse"; autoMapsToMoney: boolean }
const guardTable = json<{ templateHeaders: string[]; cases: GuardCase[]; stems: string[] }>("header-guard.json");

describe("header guard: the hand-derived outcomes (71 plain headers and 67 hostile ones)", () => {
  it("covers 138 headers and the template header list matches the fixture", () => {
    expect(guardTable.cases).toHaveLength(138);
    expect(guardTable.cases.filter((c) => !(c as { group?: string }).group)).toHaveLength(71);
    expect(guardTable.cases.filter((c) => (c as { group?: string }).group === "hostile")).toHaveLength(67);
    expect([...ADJUSTMENT_TEMPLATE_HEADERS]).toEqual(guardTable.templateHeaders);
    expect(guardTable.cases.filter((c) => c.guard === "refuse")).toHaveLength(26 + 47);
    expect(guardTable.cases.filter((c) => c.autoMapsToMoney)).toHaveLength(10 + 4);
  });

  it.each(guardTable.cases.map((c) => [c.header, c] as const))("%s", (_h, c) => {
    expect(guardHeader(c.header).allowed, `guard for ${c.header}`).toBe(c.guard === "pass");
    expect(isAutoMappableMoneyHeader(c.header), `auto-map for ${c.header}`).toBe(c.autoMapsToMoney);
    // A refusal always says why: a stem for the word rules, or one of the other reasons (a carrier's name beside an amount word, nothing readable, characters we cannot check).
    if (c.guard === "refuse") expect(guardHeader(c.header).reason).not.toBeNull();
    else expect(guardHeader(c.header).reason).toBeNull();
  });

  it("passes every exact template header however it is cased or punctuated, and refuses carrier lookalikes", () => {
    for (const h of ADJUSTMENT_TEMPLATE_HEADERS) {
      expect(guardHeader(h).allowed).toBe(true);
      expect(isTemplateHeader(h.toUpperCase())).toBe(true);
    }
    expect(guardHeader("Carrier").allowed).toBe(true);
    expect(guardHeader("CARRIER ").allowed).toBe(true);
    expect(guardHeader("Carrier Name").allowed).toBe(false);
    expect(guardHeader("carrier_service").allowed).toBe(false);
  });

  it("refuses plurals, camelCase and unseparated long stems beyond the table, never by substring of a short word", () => {
    for (const h of ["Costs", "Rates", "CarrierCost", "PostageCost", "UPSCost", "BuyRate", "Invoiced", "invoiced_amount", "postagecost", "WholesalePrice", "NegotiatedRate2", "Cost1", "Rate_2", "1Rate", "Net2"]) {
      expect(guardHeader(h).allowed, h).toBe(false);
    }
    // Short stems inside longer words are not refused: "separate", "generated", "internet", "buyer" are not cost words.
    for (const h of ["Separate Fee Note", "Generated On", "Internet Order", "Buyer Name", "Ratey", "Costume"]) expect(guardHeader(h).allowed, h).toBe(true);
    expect(normalizeGuardHeader("UPSCostPerLb")).toBe("ups cost per lb");
  });

  it("the stem list is the one in the fixture", () => {
    expect(guardTable.stems).toEqual(["cost", "rate", "postage", "label", "carrier", "net", "wholesale", "negotiated", "paid", "invoice", "buy"]);
    for (const stem of guardTable.stems) if (stem !== "carrier") expect(guardHeader(`${stem} amount`).allowed, stem).toBe(false);
  });

  it("money roles come from the header's own words; a bare customer charge needs a choice", () => {
    expect(moneyFieldOfHeader("customer_charge_original")).toBe("originalCharge");
    expect(moneyFieldOfHeader("Customer Charge Corrected")).toBe("correctedCharge");
    expect(moneyFieldOfHeader("Corrected Charge Billed to Customer")).toBe("correctedCharge");
    expect(moneyFieldOfHeader("Original Amount Charged to Customer")).toBe("originalCharge");
    expect(moneyFieldOfHeader("customer_adjustment_fee")).toBe("adjustmentFee");
    expect(moneyFieldOfHeader("Customer Fee")).toBe("adjustmentFee");
    expect(moneyFieldOfHeader("Customer Charge")).toBeNull();
    expect(moneyFieldOfHeader("Charged to Customer")).toBeNull();
    expect(moneyFieldOfHeader("Corrected Charge")).toBeNull();
    expect(moneyFieldOfHeader("Customer Postage Charge")).toBeNull();
  });

  it("an amount-like header that is not customer-facing is money-like but never auto-mapped", () => {
    for (const h of ["Adjustment Amount", "Original Charge", "Corrected Charge", "Billed Amount", "Total", "Amount", "Fee", "Price"]) {
      expect(isMoneyLikeHeader(h), h).toBe(true);
      expect(isAutoMappableMoneyHeader(h), h).toBe(false);
    }
    for (const h of ["Tracking Number", "Order Number", "Reference", "Customer Name", "Notes", "Created", "SKU"]) expect(isMoneyLikeHeader(h), h).toBe(false);
  });

  it("the refusal names every refused header with what to do about it, never claims what a column holds, and never carries a cell value", () => {
    const message = refusalMessage("Carrier Rate");
    expect(message.startsWith(`${REFUSAL_TITLE}. Nothing from this file was saved.`)).toBe(true);
    expect(message).toContain('"Carrier Rate" (its name has the word "carrier"; if it is what your customer was charged, rename it "customer_charge_original", "customer_charge_corrected" or "customer_adjustment_fee"; if it is what a carrier bills you, remove the column)');
    expect(message).toContain("Rename or remove that column and upload again.");
    // It says the NAME looks like a cost column; it never says the column is a carrier bill.
    expect(message).not.toMatch(/looks like what a carrier bills you/);
    expect(flaggedMappingMessage("Carrier Rate", true)).toBe('The column "Carrier Rate" cannot be used for a charge: its name looks like a carrier cost column. Rename it in your file if it is not one.');
    expect(flaggedMappingMessage("Carrier Rate", false)).toBe('The column "Carrier Rate" cannot be used for this field: its name looks like a carrier cost column. Rename it in your file if it is not one.');
    expect(refusalMessage(`Postage\u0000Cost\n${"x".repeat(200)}`).length).toBeLessThan(900);
    const result = guardHeaders(["ship_date", "Carrier Rate", "Postage Cost"]);
    expect(result).toMatchObject({ allowed: false, firstRefusedHeader: "Carrier Rate", refusedHeaders: ["Carrier Rate", "Postage Cost"], refusedCount: 2 });
    // One message for both, each with its own hint.
    expect(result.message).toContain('"Carrier Rate" (');
    expect(result.message).toContain('"Postage Cost" (');
    expect(result.message).toContain("Rename or remove those columns and upload again.");
  });

  it("the hint depends on what the name says: a weight, a date, a package number, the carrier's own name, an amount", () => {
    expect(refusalMessage("Net Weight")).toContain('"Net Weight" (its name has the word "net"; if it holds a weight, rename it "declared_weight" or "actual_weight")');
    expect(refusalMessage("Label Date")).toContain('if it holds a date, rename it "ship_date" or "adjusted_on"');
    expect(refusalMessage("Label ID")).toContain('if it holds a package or tracking number, rename it "package_ref"');
    expect(refusalMessage("Carrier Name")).toContain('if it names the carrier or the service, rename it "carrier" or "service"');
    expect(refusalMessage("UPS Charge")).toContain('say so in the name (for example "UPS charge to customer")');
    expect(refusalMessage("Cost Center")).toContain("if it is what your customer was charged");
  });

  it("a header refused for another reason than a cost word says so, and does not say the file looks like carrier cost data", () => {
    for (const [header, text] of [
      ["#", "the name has no letters or digits"],
      ["\u200b", "the name has no letters or digits"],
      ["東京", "the name uses characters we cannot check"],
      ["Co\ufffdst", "save the file as \"CSV UTF-8\""],
      ["x".repeat(201), "the name is longer than 200 characters"],
    ] as const) {
      const m = refusalMessage(header);
      expect(m, header).toContain(text);
      expect(m.startsWith("Some column names in this file cannot be accepted. Nothing from this file was saved."), header).toBe(true);
      expect(m).not.toContain(REFUSAL_TITLE);
    }
  });

  it("lists up to 20 refused headers in one message and counts the rest", () => {
    const headers = Array.from({ length: 25 }, (_, i) => `Carrier Cost ${i + 1}`);
    const r = guardHeaders(headers);
    expect(r.refusedCount).toBe(25);
    expect(r.refusedHeaders).toHaveLength(20);
    expect(r.message!.match(/"Carrier Cost \d+"/g)).toHaveLength(20);
    expect(r.message).toContain("and 5 more.");
  });

  it("runs over every sheet of a workbook, each at its own header row, and the first refused header in sheet order wins", () => {
    const ok: Table = { name: "Good", rows: [["ship_date", "carrier", "service"], ["2026-01-01", "UPS", "Ground"]], truncated: false };
    const bad: Table = { name: "Costs", rows: [["Report title", "", ""], ["ship_date", "Negotiated Rate", "Carrier Rate", "carrier"], ["2026-01-01", "1.00", "2.00", "UPS"]], truncated: false };
    const r = guardTables([ok, bad]);
    expect(r).toMatchObject({ allowed: false, sheet: "Costs", firstRefusedHeader: "Negotiated Rate", refusedHeaders: ["Negotiated Rate", "Carrier Rate"] });
    expect(r.message).not.toContain("1.00");
    expect(guardTables([ok]).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cell parsers
// ---------------------------------------------------------------------------
describe("parseMoneyCell", () => {
  it.each([
    ["13.35", "13.35", false],
    ["13", "13.00", false],
    ["$1,234.50", "1234.50", false],
    ["$ 5", "5.00", false],
    ["USD 12", "12.00", false],
    ["12.5 USD", "12.50", false],
    ["(3.20)", "3.20", true],
    ["($3.20)", "3.20", true],
    ["-5.00", "5.00", true],
    ["$-5.00", "5.00", true],
    ["-$5.00", "5.00", true],
    ["5.00-", "5.00", true],
    ["−5.00", "5.00", true],
    ["0.00", "0.00", false],
    ["(0.00)", "0.00", false],
    ["-0", "0.00", false],
    [".5", "0.50", false],
    ["12.500", "12.50", false],
    ["1,250", "1250.00", false],
    ["16.610000000000003", "16.61", false],
  ] as const)("reads %j", (raw, amount, negative) => {
    const r = parseMoneyCell(raw);
    expect(r).toEqual({ amount, negative });
  });

  it("refuses decimal commas and European formats, never reading 12,50 as 12.50 or 1250", () => {
    for (const raw of ["12,50", "1.234,50", "2,5", "1 234.50", "12,5", "€5.00", "5.00 EUR", "1e3", "abc", "--5", "(-5)", "12.345", "0.005", "99999999999.00", "$", "()"]) {
      expect(parseMoneyCell(raw), raw).toBe("invalid");
    }
  });

  it("a blank cell is unknown (null), never 0", () => {
    expect(parseMoneyCell("")).toBeNull();
    expect(parseMoneyCell("   ")).toBeNull();
  });

  it("round-trips 2,000 seeded amounts written four ways", () => {
    let seed = 20261016;
    const next = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 2000; i++) {
      const cents = Math.floor(next() * 100_000_000);
      const amount = (cents / 100).toFixed(2);
      const withCommas = Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      for (const written of [amount, `$${amount}`, `$${withCommas}`, `USD ${amount}`]) expect(parseMoneyCell(written), written).toEqual({ amount, negative: false });
      if (cents > 0) expect(parseMoneyCell(`(${amount})`), amount).toEqual({ amount, negative: true });
    }
  });

  it("adds and subtracts known amounts exactly (an unknown amount is never passed to these: the caller decides what it means)", () => {
    expect(addMoney("0.10", "0.20")).toBe("0.30");
    expect(subtractMoney("13.35", "12.79")).toBe("0.56");
    expect(subtractMoney("12.79", "13.35")).toBe("-0.56");
    expect(isNegativeMoney("-0.56")).toBe(true);
    expect(isNegativeMoney("0.00")).toBe(false);
    expect(isNegativeMoney("-0.00")).toBe(false);
  });
});

describe("weights, dimensions, dates and text", () => {
  it("reads weights in lb, oz, g and kg into pounds at up to six decimals", () => {
    expect(readWeight("4", "", "lb")).toEqual({ status: "ok", lb: "4" });
    expect(readWeight("4.0", "lb", "oz")).toEqual({ status: "ok", lb: "4" });
    expect(readWeight("8.5", "oz", "lb")).toEqual({ status: "ok", lb: "0.53125" });
    expect(readWeight("7", "", "oz")).toEqual({ status: "ok", lb: "0.4375" });
    expect(readWeight("3.5 lb", "", "oz")).toEqual({ status: "ok", lb: "3.5" });
    expect(readWeight("1500", "g", "lb")).toEqual({ status: "ok", lb: "3.306934" });
    expect(readWeight("2.5", "kg", "lb")).toEqual({ status: "ok", lb: "5.511557" });
    expect(readWeight("1,250 g", "", "lb")).toEqual({ status: "ok", lb: "2.755778" });
    expect(readWeight("7.123", "oz", "lb")).toEqual({ status: "ok", lb: "0.445188" });
    // The shared factor, pinned.
    expect(weightToLb("1", "kg").toString()).toBe("2.204623");
  });

  it("distinguishes blank, unreadable and zero-or-less weights", () => {
    expect(readWeight("", "", "lb")).toEqual({ status: "blank" });
    expect(readWeight("  ", "", "lb")).toEqual({ status: "blank" });
    for (const raw of ["0", "0.0", "-2", "- 3", "0 oz", "0.0000001 kg"]) expect(readWeight(raw, "", "lb"), raw).toEqual({ status: "non_positive" });
    for (const raw of ["abc", "2,5", "3 stone", "1e3", "999999999 lb", "1000000"]) expect(readWeight(raw, "", "lb"), raw).toEqual({ status: "invalid" });
    expect(readWeight("5", "furlongs", "lb")).toEqual({ status: "invalid" });
  });

  it("reads dimensions in inches (or centimetres converted at four decimals) and refuses zero and text", () => {
    expect(readDimension("10", "", "in")).toEqual({ status: "ok", inches: "10" });
    expect(readDimension("10.5 in", "", "in")).toEqual({ status: "ok", inches: "10.5" });
    expect(readDimension('10"', "", "in")).toEqual({ status: "ok", inches: "10" });
    expect(readDimension("25.4", "cm", "in")).toEqual({ status: "ok", inches: "10" });
    expect(readDimension("30 cm", "", "in")).toEqual({ status: "ok", inches: "11.811" });
    expect(readDimension("10.123456", "", "in")).toEqual({ status: "ok", inches: "10.1235" });
    expect(readDimension("", "", "in")).toEqual({ status: "blank" });
    for (const raw of ["0", "-3", "abc", "1,5", "10 ft", "999999999"]) expect(readDimension(raw, "", "in"), raw).toEqual({ status: "invalid" });
    expect(readDimension("5", "yards", "in")).toEqual({ status: "invalid" });
  });

  it("limits ship dates to 2015-01-01 through tomorrow and detects day-first and month-first", () => {
    expect(shipDateInRange("2015-01-01", "2026-10-16")).toBe(true);
    expect(shipDateInRange("2014-12-31", "2026-10-16")).toBe(false);
    expect(shipDateInRange("2026-10-17", "2026-10-16")).toBe(true);
    expect(shipDateInRange("2026-10-18", "2026-10-16")).toBe(false);
    expect(shipDateInRange("2026-01-01", "2025-12-31")).toBe(true);
    expect(detectDateFormat(["13/01/2026"])).toEqual({ format: "dmy", ambiguous: false });
    expect(detectDateFormat(["01/13/2026"])).toEqual({ format: "mdy", ambiguous: false });
    expect(detectDateFormat(["03/04/2026"])).toEqual({ format: "mdy", ambiguous: true });
    expect(detectDateFormat(["2026-03-04"])).toEqual({ format: "iso", ambiguous: false });
  });

  it("reads a package reference as text: wrappers removed, scientific notation and over-long values refused", () => {
    expect(readPackageRef("1Z9A000001")).toEqual({ ref: "1Z9A000001" });
    expect(readPackageRef("  '1Z9A000001 ")).toEqual({ ref: "1Z9A000001" });
    expect(readPackageRef('="9400111899223856928499"')).toEqual({ ref: "9400111899223856928499" });
    expect(readPackageRef("")).toEqual({ ref: null });
    expect(readPackageRef("   ")).toEqual({ ref: null });
    for (const raw of ["9.40011E+21", "9.4e21", "1E+10", "x".repeat(121)]) expect(readPackageRef(raw), raw).toBe("invalid");
    // The reference is read in its canonical form (upper case, no whitespace or invisible characters), the one the database stores and compares.
    expect(readPackageRef("x".repeat(120))).toEqual({ ref: "X".repeat(120) });
    // Digits and letters that merely contain an e are fine.
    expect(readPackageRef("1E2F3")).toEqual({ ref: "1E2F3" });
    expect(readPackageRef("12345678901234567890")).toEqual({ ref: "12345678901234567890" });
  });

  it("cleans free text: control characters, bidirectional overrides and length", () => {
    expect(cleanText("  a\u0000b\tc\n d  ", 120)).toEqual({ text: "a b c d", truncated: false });
    expect(cleanText("‮evil‬", 120).text).toBe("evil");
    expect(cleanText("   ", 120)).toEqual({ text: null, truncated: false });
    // A lone surrogate would fail a whole database chunk; a proper pair (an emoji) is kept.
    expect(cleanText("ab\ud800cd", 120).text).toBe("ab cd");
    expect(cleanText("ab\udc00cd", 120).text).toBe("ab cd");
    expect(cleanText("box \ud83d\udce6", 120).text).toBe("box \ud83d\udce6");
    expect(JSON.parse(JSON.stringify(cleanText("x\ud800y", 10)))).toEqual({ text: "x y", truncated: false });
    expect(cleanText("x".repeat(130), 120)).toEqual({ text: "x".repeat(120), truncated: true });
    expect(normalizeValue("  UPS  Ground!! ")).toBe("ups ground");
  });
});

// ---------------------------------------------------------------------------
// history-sample.csv: the 40 fictional rows
// ---------------------------------------------------------------------------
interface SampleExpected {
  rows: number; errorRows: number; committable: boolean; acceptedRows: number; skippedAlreadyImported: number;
  shipDateRange: { min: string; max: string };
  counts: Record<string, number>; rowNumbers: Record<string, number[]>;
  byType: Record<string, number>; byCarrier: Record<string, number>;
  distinctCustomerNames: Record<string, number>;
  reimportSameFileAfterCommit: { alreadyImported: number; newRows: number };
}
interface ErrorsExpected {
  rows: number; errorRows: number; cleanRows: number; committable: boolean;
  counts: Record<string, number>; rowNumbers: Record<string, number[]>;
  duplicateHandling: Record<"refuse" | "sum" | "first", { errorRows: number; duplicate_reference: number; merged: number; ignored: number }>;
}
const expected = json<{ sample: SampleExpected; errors: ErrorsExpected; carrierCost: { refusedHeaders: string[]; firstRefusedHeader: string; messageMustContain: string[]; messageMustNotContain: string[] } }>("import-expected.json");

const VALIDATION_CODES = ["invalid_date", "non_positive_weight", "partial_dimensions", "negative_amount", "invalid_amount", "duplicate_reference", "credit_row", "no_amounts", "missing_weight", "possible_double_count", "unknown_customer"] as const;
const key = (rec: AdjustmentRecord) => adjustmentRecordKey(rec.brandId, rec.carrierCode, rec.packageRef!, rec.adjustmentType);

describe("history-sample.csv", () => {
  it("is read through the shared parser with the adjustment limits and passes the header guard", async () => {
    const parsed = await parseAdjustmentFile(read("history-sample.csv"), { filename: "history.csv", mimeType: "text/csv" });
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.kind).toBe("csv");
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.tables[0]!.rows).toHaveLength(41);
    // The shared parser bounds memory (rows of every kind, columns, cell length) and never cuts a sheet; the 20,000 DATA rows are counted by the importer, under the column names.
    expect(ADJUSTMENT_FILE_LIMITS).toMatchObject({ maxBytes: 5 * 1024 * 1024, maxRowsPerSheet: 60_000, maxColumns: 200, maxCellLength: 10_000, refuseWideRows: true, maxNumericDigits: 15 });
  });

  it("detects every template column, the iso date format, and the services, causes and customers with their row counts", async () => {
    const tables = await load("history-sample.csv");
    const d = detectAdjustmentFile(tables, ctx());
    expect(d.suggestion.columns).toEqual({
      shipDate: 0, adjustedOn: 1, carrier: 2, service: 3, brand: 4, adjustmentType: 5, cause: 6, reason: 7, packageRef: 8, declaredWeight: 9, actualWeight: 10, weightUnit: 11,
      originalLength: 12, originalWidth: 13, originalHeight: 14, correctedLength: 15, correctedWidth: 16, correctedHeight: 17, dimensionUnit: 18,
      originalCharge: 19, correctedCharge: 20, adjustmentFee: 21, handling: 22,
    });
    expect(d.suggestion.dateFormat).toBe("iso");
    expect(d.dateFormatAmbiguous).toBe(false);
    expect(d.weightUnitMustBeChosen).toBe(false);
    expect(d.ignoredColumns).toEqual([]);
    expect(d.amountColumnsNeedingChoice).toEqual([]);
    expect(d.sheets[0]).toMatchObject({ name: "Sheet1", headerRow: 0, rowCount: 40 });

    expect(d.distinct.customers.map((c) => [c.text, c.rows, c.suggested])).toEqual([["Beta Beverages", 20, ID.beta], ["Alpha Apparel", 14, ID.alpha], ["Gamma Goods", 3, null]]);
    expect(d.distinct.types.map((t) => [t.text, t.rows, t.suggested])).toEqual([["reweight", 22, "reweight"], ["remeasure", 10, "remeasure"], ["combined", 5, "combined"], ["correction", 3, "correction"]]);
    expect(d.distinct.carriers.map((t) => [t.text, t.rows, t.suggested])).toEqual([["UPS", 32, "ups"], ["USPS", 8, "usps"]]);
    expect(d.distinct.services.map((t) => [t.normalized, t.rows, t.suggested])).toEqual([["ups ground", 32, ID.upsGround], ["usps ground advantage", 8, ID.uspsGa]]);
    expect(Object.fromEntries(d.distinct.causes.map((c) => [c.normalized, [c.rows, c.suggested]]))).toEqual({
      "carrier reweigh": [21, "carrier_reweigh"], "carrier remeasure": [8, "carrier_remeasure"], "wms no weight": [4, "wms_no_weight"], "other": [3, "other"],
      "scale error": [2, "scale_error"], "packaging change": [2, "packaging_change"],
    });
    // The suggested mapping keeps only what applying it would not work out by itself: exact customer, carrier and cause matches are recomputed, so nothing is stored for them.
    expect(d.suggestion.brandMap).toEqual({});
    expect(d.suggestion.carrierMap).toEqual({});
    // A service is the one thing no rule can recompute (it needs the catalog match the 3PL confirmed), so those entries stay.
    expect(d.suggestion.serviceMap).toEqual({ "ups ground": ID.upsGround, "usps ground advantage": ID.uspsGa });
    // (The cause column of this file spells the causes exactly, so nothing is stored for them either.)
    expect(d.suggestion.causeMap).toEqual({});
    expect(d.suggestion.typeMap).toEqual({});
  });

  it("validates to the hand-counted numbers of import-expected.json, row by row", async () => {
    const tables = await load("history-sample.csv");
    const d = detectAdjustmentFile(tables, ctx());
    const { records, report } = applyAdjustmentMapping(tables, d.suggestion, ctx());
    const e = expected.sample;
    expect(report.ok).toBe(true);
    expect(report.mappingIssues).toEqual([]);
    expect(report.counts).toEqual({ rows: e.rows, errorRows: e.errorRows, cleanRows: 40, accepted: e.acceptedRows, merged: 0, ignored: 0, alreadyImported: e.skippedAlreadyImported });
    expect(report.committable).toBe(e.committable);
    for (const code of VALIDATION_CODES) expect(report.byCode[code], code).toBe(e.counts[code]);
    for (const [code, rowNumbers] of Object.entries(e.rowNumbers)) expect(report.rowNumbers[code as ImportCode], code).toEqual(rowNumbers);
    // Nothing else fires on this file: every non-zero code is one the hand count lists.
    const nonZero = Object.entries(report.byCode).filter(([, v]) => v > 0).map(([k]) => k).sort();
    expect(nonZero).toEqual(["credit_row", "missing_weight", "no_amounts", "possible_double_count", "unknown_customer"]);
    expect(report.shipDateRange).toEqual(e.shipDateRange);
    expect(report.byType).toEqual(e.byType);
    expect(report.byCarrier).toEqual({ ups: e.byCarrier.UPS, usps: e.byCarrier.USPS });
    expect(Object.fromEntries(report.customers.map((c) => [c.text, c.rows]))).toEqual({ "Beta Beverages": 20, "Alpha Apparel": 14, "Gamma Goods": 3 });
    expect(report.unassignedRows).toBe(e.distinctCustomerNames[""]);
    expect(records).toHaveLength(40);
    expect(report.notice).toBe("Only your team can see this. Customers never do.");
    expect(report.limits).toBe("5 MB, 20,000 rows; split by month");
  });

  it("says each code in one plain sentence with its count, and no sentence carries a cell value", async () => {
    const tables = await load("history-sample.csv");
    const { report } = applyAdjustmentMapping(tables, detectAdjustmentFile(tables, ctx()).suggestion, ctx());
    const sentence = (code: ImportCode) => report.codes.find((c) => c.code === code)!.message;
    expect(sentence("credit_row")).toBe("4 rows are credits (the corrected charge is lower than the original charge); they are kept and shown separately, never netted against charges.");
    expect(sentence("no_amounts")).toBe("3 rows have no amounts; they count toward how often adjustments happen, not toward how much they cost.");
    expect(sentence("missing_weight")).toBe("4 rows have no declared weight (for example the WMS sent none); they are kept and marked as missing, never as zero.");
    expect(sentence("possible_double_count")).toContain("2 rows may count the adjustment fee twice");
    expect(sentence("unknown_customer")).toBe("3 rows name a customer that is not in your account. They stay in your history but count for no customer.");
    expect(sentenceFor("unknown_customer", 1)).toBe("1 row names a customer that is not in your account. It stays in your history but counts for no customer.");
    expect(report.codes.every((c) => c.severity === "information")).toBe(true);
    expect(sentenceFor("credit_row", 1)).toBe("1 row is a credit (the corrected charge is lower than the original charge); it is kept and shown separately, never netted against charges.");
    expect(sentenceFor("missing_weight", 1)).toContain("1 row has no declared weight");
    const text = JSON.stringify(report);
    for (const value of ["1Z9A000001", "13.35", "14.91", "carrier_reweigh"]) expect(text, value).not.toContain(value);
    // Row references are numbers only.
    expect(report.issues.every((i) => Number.isInteger(i.row) && !("value" in i))).toBe(true);
  });

  it("stores each record as the file says, in pounds and inches, with blank money left null and never 0", async () => {
    const tables = await load("history-sample.csv");
    const { records } = applyAdjustmentMapping(tables, detectAdjustmentFile(tables, ctx()).suggestion, ctx());
    const byRef = (ref: string) => records.find((r) => r.packageRef === ref)!;

    expect(byRef("1Z9A000001")).toEqual({
      rowNo: 1, shipDate: "2026-08-03", adjustedOn: "2026-08-09", carrierCode: "ups", serviceId: ID.upsGround, serviceText: "UPS Ground", brandId: ID.beta, adjustmentType: "reweight",
      cause: "carrier_reweigh", reasonText: "Carrier reweigh", packageRef: "1Z9A000001", declaredWeightLb: "4", declaredWeightBasis: "measured", actualWeightLb: "6",
      original: { length: "10", width: "8", height: "6" }, corrected: null, originalCharge: "13.35", correctedCharge: "14.91", separateFee: "3.00", handlingRecorded: "absorbed",
    });
    // Row 3: the WMS sent no weight: missing, not zero; no handling recorded.
    expect(byRef("1Z9A000003")).toMatchObject({ declaredWeightLb: null, declaredWeightBasis: "missing", actualWeightLb: "8", cause: "wms_no_weight", handlingRecorded: null, originalCharge: "14.50", correctedCharge: "15.06", separateFee: "3.00" });
    // Row 5: ounces to pounds exactly (7 oz = 0.4375 lb, 8.5 oz = 0.53125 lb).
    expect(byRef("9400000005")).toMatchObject({ carrierCode: "usps", serviceId: ID.uspsGa, declaredWeightLb: "0.4375", actualWeightLb: "0.53125" });
    // Rows 16 and 17: the kg and g conversions, derived with the shared factor and pinned (1500 g = 1.5 kg x 2.20462262185 = 3.306933932775 -> 3.306934, and so on).
    expect(byRef("1Z9A000016")).toMatchObject({ declaredWeightLb: "3.306934", actualWeightLb: "4.188783" });
    expect(byRef("1Z9A000017")).toMatchObject({ declaredWeightLb: "4.409245", actualWeightLb: "5.732019" });
    // "$15.05" and "$15.61" lose the dollar sign; a blank fee stays null.
    expect(byRef("1Z9A000012")).toMatchObject({ originalCharge: "15.05", correctedCharge: "15.61", separateFee: null, handlingRecorded: "pass_through" });
    // Row 7: an explicit fee of 0.00 is a fee of zero, not unknown.
    expect(byRef("1Z9A000007")).toMatchObject({ separateFee: "0.00" });
    // Row 11 has no amounts at all: all three are null.
    expect(byRef("1Z9A000011")).toMatchObject({ originalCharge: null, correctedCharge: null, separateFee: null });
    // Row 23: a remeasure with corrected dimensions.
    expect(byRef("1Z9A000023")).toMatchObject({ adjustmentType: "remeasure", cause: "carrier_remeasure", original: { length: "10", width: "8", height: "6" }, corrected: { length: "14", width: "10", height: "8" }, separateFee: "4.00" });
    // Row 38: an unknown customer (Gamma Goods) stays unassigned; a fee-only correction has no shipping amounts.
    expect(byRef("1Z9A000038")).toMatchObject({ brandId: null, adjustmentType: "correction", cause: "other", originalCharge: null, correctedCharge: null, separateFee: "5.00", handlingRecorded: "manual_approval", adjustedOn: "2026-09-16" });
    expect(byRef("9400000040")).toMatchObject({ declaredWeightLb: "0.25", actualWeightLb: "0.25" });
    // Blank customers are unassigned too.
    expect(byRef("1Z9A000036").brandId).toBeNull();
    // Every record has a unique key.
    expect(new Set(records.map(key)).size).toBe(40);
  });

  it("builds one chunk with dense row numbers and the exact append row keys", async () => {
    const tables = await load("history-sample.csv");
    const result = applyAdjustmentMapping(tables, detectAdjustmentFile(tables, ctx()).suggestion, ctx());
    const { chunks, accepted } = buildAppendChunks(result);
    expect(accepted).toBe(40);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.fromRow).toBe(1);
    expect(chunks[0]!.rows).toHaveLength(40);
    expect(Object.keys(chunks[0]!.rows[0]!)).toEqual([
      "ship_date", "adjusted_on", "carrier_code", "service_id", "service_text", "brand_id", "adjustment_type", "cause", "reason_text", "package_ref", "declared_weight_lb",
      "declared_weight_basis", "actual_weight_lb", "orig_length_in", "orig_width_in", "orig_height_in", "corr_length_in", "corr_width_in", "corr_height_in",
      "original_charge", "corrected_charge", "separate_fee", "handling_recorded",
    ]);
    expect(chunks[0]!.rows[0]).toEqual({
      ship_date: "2026-08-03", adjusted_on: "2026-08-09", carrier_code: "ups", service_id: ID.upsGround, service_text: "UPS Ground", brand_id: ID.beta, adjustment_type: "reweight",
      cause: "carrier_reweigh", reason_text: "Carrier reweigh", package_ref: "1Z9A000001", declared_weight_lb: "4", declared_weight_basis: "measured", actual_weight_lb: "6",
      orig_length_in: "10", orig_width_in: "8", orig_height_in: "6", corr_length_in: null, corr_width_in: null, corr_height_in: null,
      original_charge: "13.35", corrected_charge: "14.91", separate_fee: "3.00", handling_recorded: "absorbed",
    });
    expect(reconcileCommit(40, { applied: true, inserted: 40, skipped: 0, nextRow: 41, committed: 40, skippedTotal: 0 })).toMatchObject({ ok: true, committed: 40, skipped: 0 });
  });

  it("re-importing the same file after a commit skips all 40 rows as already imported", async () => {
    const tables = await load("history-sample.csv");
    const suggestion = detectAdjustmentFile(tables, ctx()).suggestion;
    const first = applyAdjustmentMapping(tables, suggestion, ctx());
    const existingKeys = new Set(first.records.map(key));
    const again = applyAdjustmentMapping(tables, suggestion, ctx({ existingKeys }));
    const e = expected.sample.reimportSameFileAfterCommit;
    expect(again.report.counts).toMatchObject({ rows: 40, errorRows: 0, accepted: e.newRows, alreadyImported: e.alreadyImported });
    expect(again.report.byCode.already_imported).toBe(40);
    expect(again.report.byCode.duplicate_reference).toBe(0);
    expect(again.report.committable).toBe(false);
    expect(again.report.codes.find((c) => c.code === "already_imported")!.message).toBe("40 rows are already imported from an earlier file and will be skipped.");
    expect(() => buildAppendChunks(again)).toThrow(ChunkError);

    const some = applyAdjustmentMapping(tables, suggestion, ctx({ existingKeys: new Set(first.records.slice(0, 2).map(key)) }));
    expect(some.report.counts).toMatchObject({ accepted: 38, alreadyImported: 2 });
    expect(some.report.committable).toBe(true);
    expect(buildAppendChunks(some).chunks[0]!.rows).toHaveLength(38);
  });

  it("a declared weight with the cause 'WMS sent no weight' is a fallback, and a blank one is missing", () => {
    const t = csvTable(["ship_date,carrier,adjustment_type,cause,package_ref,declared_weight,actual_weight,weight_unit", "2026-08-03,UPS,reweight,wms_no_weight,R1,1,6,lb", "2026-08-04,UPS,reweight,wms_no_weight,R2,,6,lb", "2026-08-05,UPS,reweight,carrier_reweigh,R3,3,6,lb"].join("\n"));
    const d = detectAdjustmentFile([t], ctx());
    const { records } = applyAdjustmentMapping([t], d.suggestion, ctx());
    expect(records.map((r) => [r.packageRef, r.declaredWeightLb, r.declaredWeightBasis])).toEqual([["R1", "1", "fallback"], ["R2", null, "missing"], ["R3", "3", "measured"]]);
  });
});

// ---------------------------------------------------------------------------
// history-errors.csv: one defect per defective row
// ---------------------------------------------------------------------------
describe("history-errors.csv", () => {
  it("counts every defect per code as hand counted and cannot be committed", async () => {
    const tables = await load("history-errors.csv");
    const d = detectAdjustmentFile(tables, ctx());
    const result = applyAdjustmentMapping(tables, d.suggestion, ctx());
    const e = expected.errors;
    expect(result.report.ok).toBe(true);
    expect(result.report.counts).toMatchObject({ rows: e.rows, errorRows: e.errorRows, cleanRows: e.cleanRows, accepted: 2, merged: 0, ignored: 0 });
    expect(result.report.committable).toBe(false);
    for (const code of VALIDATION_CODES) expect(result.report.byCode[code], code).toBe(e.counts[code]);
    for (const [code, rowNumbers] of Object.entries(e.rowNumbers)) expect(result.report.rowNumbers[code as ImportCode], code).toEqual(rowNumbers);
    // Each defective row has exactly one defect, so the per-code counts add up to the error rows.
    expect(result.report.codes.filter((c) => c.severity === "error").reduce((s, c) => s + c.rows, 0)).toBe(e.errorRows);
    expect(result.records.map((r) => r.packageRef)).toEqual(["1ZE0000009", "1ZE0000011"]);
    expect(() => buildAppendChunks(result)).toThrow(/must be fixed/);
  });

  it("states the errors as plain sentences with counts, without values", async () => {
    const tables = await load("history-errors.csv");
    const { report } = applyAdjustmentMapping(tables, detectAdjustmentFile(tables, ctx()).suggestion, ctx());
    const sentence = (code: ImportCode) => report.codes.find((c) => c.code === code)!.message;
    expect(sentence("invalid_date")).toContain("2 rows have a ship date that cannot be read");
    expect(sentence("non_positive_weight")).toBe("2 rows have a weight of zero or less.");
    expect(sentence("partial_dimensions")).toBe("2 rows give only some of the length, width and height; give all three or none.");
    expect(sentence("negative_amount")).toContain("2 rows have a negative amount");
    expect(sentence("invalid_amount")).toBe("1 row has an amount that cannot be read as dollars and cents (write 12.50, not 12,50).");
    expect(sentence("duplicate_reference")).toContain("1 row repeats a package reference");
    const text = JSON.stringify(report);
    for (const value of ["(3.20)", "-5.00", "not a date", "2026-13-45", "1ZE0000009", "13.35", "12.79"]) expect(text, value).not.toContain(value);
  });

  it.each(["refuse", "sum", "first"] as const)("duplicate handling %s", async (mode) => {
    const tables = await load("history-errors.csv");
    const mapping: AdjustmentMapping = { ...detectAdjustmentFile(tables, ctx()).suggestion, duplicateHandling: mode };
    const { report, records } = applyAdjustmentMapping(tables, mapping, ctx());
    const e = expected.errors.duplicateHandling[mode];
    expect(report.counts.errorRows).toBe(e.errorRows);
    expect(report.byCode.duplicate_reference).toBe(e.duplicate_reference);
    expect(report.counts.merged).toBe(e.merged);
    expect(report.counts.ignored).toBe(e.ignored);
    expect(report.byCode.merged_duplicate).toBe(e.merged);
    expect(report.byCode.ignored_duplicate).toBe(e.ignored);
    const nine = records.find((r) => r.packageRef === "1ZE0000009")!;
    // "sum" adds the repeat's DIFFERENCE (13.35 - 12.79 = 0.56) to the corrected charge; the original charge is not added to itself; fees are added.
    if (mode === "sum") expect([nine.originalCharge, nine.correctedCharge, nine.separateFee]).toEqual(["12.79", "13.91", "6.00"]);
    else expect([nine.originalCharge, nine.correctedCharge, nine.separateFee]).toEqual(["12.79", "13.35", "3.00"]);
    // The repeat is never counted as an error row twice and never as accepted.
    expect(report.counts.accepted).toBe(2);
    expect(report.committable).toBe(false);
  });

  it("with the defects fixed, sum and first make the file committable, and refuse does not until the repeat is removed", () => {
    const body = ["ship_date,carrier,adjustment_type,package_ref,customer_charge_original,customer_charge_corrected,customer_adjustment_fee", "2026-08-03,UPS,reweight,R1,10.00,11.00,", "2026-08-03,UPS,reweight,R1,10.00,11.00,", "2026-08-04,UPS,reweight,R2,10.00,11.00,"].join("\n");
    const t = csvTable(body);
    const base = detectAdjustmentFile([t], ctx()).suggestion;
    expect(applyAdjustmentMapping([t], base, ctx()).report).toMatchObject({ committable: false, byCode: expect.objectContaining({ duplicate_reference: 1 }) });
    const summed = applyAdjustmentMapping([t], { ...base, duplicateHandling: "sum" }, ctx());
    expect(summed.report.committable).toBe(true);
    // The repeat is a second adjustment of the same package: its difference (1.00) is added to the corrected charge; the original charge stays what it was.
    expect(summed.records.map((r) => [r.packageRef, r.originalCharge, r.correctedCharge, r.separateFee])).toEqual([["R1", "10.00", "12.00", null], ["R2", "10.00", "11.00", null]]);
    const first = applyAdjustmentMapping([t], { ...base, duplicateHandling: "first" }, ctx());
    expect(first.records.map((r) => [r.packageRef, r.originalCharge])).toEqual([["R1", "10.00"], ["R2", "10.00"]]);
  });

  it("amounts added up by 'sum' that no longer fit the stored column make the first row an error row instead of failing at commit", () => {
    const t = csvTable(["ship_date,carrier,adjustment_type,package_ref,customer_charge_original,customer_charge_corrected,customer_adjustment_fee", "2026-08-03,UPS,reweight,R1,1.00,9000000000.00,9000000000.00", "2026-08-03,UPS,reweight,R1,1.00,9000000000.00,1.00"].join("\n"));
    const base = detectAdjustmentFile([t], ctx()).suggestion;
    const { report, records } = applyAdjustmentMapping([t], { ...base, duplicateHandling: "sum" }, ctx());
    expect(report.byCode).toMatchObject({ invalid_amount: 1, merged_duplicate: 1 });
    expect(report.committable).toBe(false);
    expect(records).toEqual([]);
    expect(parseMoneyCell("9999999999.99")).toEqual({ amount: "9999999999.99", negative: false });
    expect(parseMoneyCell("10000000000.00")).toBe("invalid");
  });

  it("the same reference for a different carrier, customer or type is not a repeat (the key the database enforces)", () => {
    const body = [
      "ship_date,carrier,brand,adjustment_type,package_ref,customer_charge_corrected",
      "2026-08-03,UPS,Alpha Apparel,reweight,R1,1.00",
      "2026-08-03,USPS,Alpha Apparel,reweight,R1,1.00",
      "2026-08-03,UPS,Beta Beverages,reweight,R1,1.00",
      "2026-08-03,UPS,Alpha Apparel,remeasure,R1,1.00",
      "2026-08-03,UPS,Alpha Apparel,reweight,,1.00",
      "2026-08-03,UPS,Alpha Apparel,reweight,,1.00",
    ].join("\n");
    const t = csvTable(body);
    const { report, records } = applyAdjustmentMapping([t], detectAdjustmentFile([t], ctx()).suggestion, ctx());
    expect(report.byCode.duplicate_reference).toBe(0);
    expect(report.committable).toBe(true);
    expect(records).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// history-carrier-cost.csv: refused before anything is stored
// ---------------------------------------------------------------------------
describe("history-carrier-cost.csv", () => {
  it("is refused by name with nothing stored, and the message never contains a cell value", async () => {
    const parsed = await parseAdjustmentFile(read("history-carrier-cost.csv"), "csv");
    expect(parsed.status).toBe("refused");
    if (parsed.status !== "refused") return;
    const e = expected.carrierCost;
    expect(parsed.guard.firstRefusedHeader).toBe(e.firstRefusedHeader);
    expect(parsed.guard.refusedHeaders).toEqual(e.refusedHeaders);
    for (const s of e.messageMustContain) expect(parsed.message).toContain(s);
    for (const s of e.messageMustNotContain) expect(parsed.message).not.toContain(s);
    expect("tables" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("77.31");
  });

  it("refuses a file whose only cost-like header is a plain one", async () => {
    const csv = Buffer.from("ship_date,carrier,Net Charge\n2026-01-01,UPS,4.00\n");
    const parsed = await parseAdjustmentFile(csv, "csv");
    expect(parsed).toMatchObject({ status: "refused", guard: { firstRefusedHeader: "Net Charge" } });
  });

  it("reports the limits in plain words: too many rows, too large, empty, wrong type", async () => {
    const big = Buffer.from(["ship_date,carrier,service", ...Array.from({ length: 20_001 }, () => "2026-01-01,UPS,Ground")].join("\n"));
    const tooMany = await parseAdjustmentFile(big, "csv");
    expect(tooMany).toMatchObject({ status: "error", code: "too_large" });
    expect(tooMany.status === "error" && tooMany.message).toMatch(/more than 20,000 rows.*split it by month/i);
    const justFits = Buffer.from(["ship_date,carrier,service", ...Array.from({ length: 20_000 }, () => "2026-01-01,UPS,Ground")].join("\n"));
    expect((await parseAdjustmentFile(justFits, "csv")).status).toBe("ok");
    expect(await parseAdjustmentFile(Buffer.alloc(5 * 1024 * 1024 + 1, 97), "csv")).toMatchObject({ status: "error", code: "too_large", message: expect.stringContaining("larger than 5 MB") });
    expect(await parseAdjustmentFile(Buffer.alloc(0), "csv")).toMatchObject({ status: "error", code: "empty" });
    expect(await parseAdjustmentFile(Buffer.from("x"), { filename: "x.pdf", mimeType: "application/pdf" })).toMatchObject({ status: "error", code: "unsupported_type" });
  });
});

// ---------------------------------------------------------------------------
// Mapping suggestion and re-validation
// ---------------------------------------------------------------------------
describe("mapping suggestion", () => {
  const files = (headers: string[], row: string[]) => csvTable([headers.join(","), row.join(",")].join("\n"));

  it("maps money columns only by exact template header or a customer-facing synonym, and lists everything else money-like as ignored", () => {
    const t = files(
      ["ship_date", "carrier", "service", "adjustment_type", "package_ref", "Adjustment Amount", "Original Charge", "Total", "Customer Charge Corrected", "Charged to Customer", "Notes"],
      ["2026-01-01", "UPS", "UPS Ground", "reweight", "T1", "9.99", "8.88", "7.77", "6.66", "5.55", "secret note"],
    );
    const d = detectAdjustmentFile([t], ctx());
    expect(d.suggestion.columns.correctedCharge).toBe(8);
    expect(d.suggestion.columns.originalCharge).toBeNull();
    expect(d.suggestion.columns.adjustmentFee).toBeNull();
    expect(d.amountColumnsNeedingChoice).toEqual([{ index: 9, header: "Charged to Customer" }]);
    expect(d.ignoredColumns).toEqual([
      { index: 5, header: "Adjustment Amount", moneyLike: true },
      { index: 6, header: "Original Charge", moneyLike: true },
      { index: 7, header: "Total", moneyLike: true },
      { index: 10, header: "Notes", moneyLike: false },
    ]);
    expect(d.notes.join(" ")).toMatch(/Amount-like columns that do not say they are charged to the customer are left out/);
    const { report } = applyAdjustmentMapping([t], d.suggestion, ctx());
    // The report lists what THIS mapping does not read, so the unplaced customer-facing column is ignored too until the 3PL maps it.
    expect(report.ignoredColumns.filter((c) => c.moneyLike).map((c) => c.header)).toEqual(["Adjustment Amount", "Original Charge", "Total", "Charged to Customer"]);
    expect(report.ignoredColumns.map((c) => c.header)).toContain("Notes");
    // Mapping it by hand reads it.
    const chosen = applyAdjustmentMapping([t], { ...d.suggestion, columns: { ...d.suggestion.columns, adjustmentFee: 9 } }, ctx());
    expect(chosen.records[0]).toMatchObject({ separateFee: "5.55", correctedCharge: "6.66", originalCharge: null });
    expect(chosen.report.ignoredColumns.map((c) => c.header)).not.toContain("Charged to Customer");
  });

  it("never claims a header from a fragment: 'Service Fee' is not the service column and 'Customer Zip' is not the customer", () => {
    const t = files(["ship_date", "carrier", "Service Fee", "Customer Zip", "adjustment_type"], ["2026-01-01", "UPS", "4.00", "90001", "reweight"]);
    const d = detectAdjustmentFile([t], ctx());
    expect(d.suggestion.columns.service).toBeNull();
    expect(d.suggestion.columns.brand).toBeNull();
    expect(d.ignoredColumns.map((c) => c.header)).toEqual(["Service Fee", "Customer Zip"]);
  });

  it("reads units from weight and dimension headers and asks for a unit when nothing states one", () => {
    const withUnit = detectAdjustmentFile([files(["ship_date", "carrier", "adjustment_type", "Declared Weight (oz)", "Actual Weight (oz)", "Original Length (cm)", "Original Width (cm)", "Original Height (cm)"], ["2026-01-01", "UPS", "reweight", "8", "9", "30", "20", "10"])], ctx());
    expect(withUnit.weightUnitFromHeader).toBe("oz");
    expect(withUnit.suggestion.weightUnit).toBe("oz");
    expect(withUnit.suggestion.dimensionUnit).toBe("cm");
    expect(withUnit.suggestion.columns).toMatchObject({ declaredWeight: 3, actualWeight: 4, originalLength: 5, originalWidth: 6, originalHeight: 7 });
    expect(withUnit.weightUnitMustBeChosen).toBe(false);
    const noUnit = detectAdjustmentFile([files(["ship_date", "carrier", "adjustment_type", "declared_weight"], ["2026-01-01", "UPS", "reweight", "8"])], ctx());
    expect(noUnit.weightUnitMustBeChosen).toBe(true);
    expect(noUnit.notes.join(" ")).toMatch(/confirm pounds or ounces/);
    const cellUnit = detectAdjustmentFile([files(["ship_date", "carrier", "adjustment_type", "declared_weight"], ["2026-01-01", "UPS", "reweight", "8 oz"])], ctx());
    expect(cellUnit.weightUnitMustBeChosen).toBe(false);
  });

  it("proposes value maps: types by wording, causes with 'other' as the safe default, services through the catalog, customers by exact name only", () => {
    expect(suggestType("weight adjustment")).toBe("reweight");
    expect(suggestType("dimension adjustment")).toBe("remeasure");
    expect(suggestType("weight and dimension")).toBe("combined");
    expect(suggestType("address correction")).toBe("correction");
    expect(suggestType("mystery")).toBeNull();
    expect(suggestCause("wms did not send weight")).toBe("wms_no_weight");
    expect(suggestCause("scale error at pack bench")).toBe("scale_error");
    expect(suggestCause("carrier remeasure")).toBe("carrier_remeasure");
    expect(suggestCause("carrier reweigh")).toBe("carrier_reweigh");
    expect(suggestCause("packaging changed")).toBe("packaging_change");
    expect(suggestCause("who knows")).toBe("other");
    expect(serviceKeyOf("UPS", "UPS Ground")).toBe("ups ground");
    expect(serviceKeyOf("UPS", "Ground")).toBe("ups ground");
    expect(serviceKeyOf(null, "Ground")).toBe("ground");
    const t = files(["ship_date", "carrier", "service", "brand", "adjustment_type"], ["2026-01-01", "United Parcel Service", "Ground", "alpha apparel", "Weight Adjustment"]);
    const d = detectAdjustmentFile([t], ctx());
    // What each text would be mapped to is listed for the person; the mapping itself keeps only what applying it cannot work out (a type written in words).
    expect(d.distinct.carriers.map((c) => [c.normalized, c.suggested])).toEqual([["united parcel service", null]]);
    expect(d.distinct.customers.map((c) => [c.normalized, c.suggested])).toEqual([["alpha apparel", ID.alpha]]);
    expect(d.suggestion.carrierMap).toEqual({});
    expect(d.suggestion.brandMap).toEqual({});
    expect(d.suggestion.typeMap).toEqual({ "weight adjustment": "reweight" });
    const { report, records } = applyAdjustmentMapping([t], d.suggestion, ctx());
    expect(report.byCode.unknown_carrier).toBe(1);
    expect(records).toHaveLength(0);
    // The 3PL maps the carrier text by hand and the row passes.
    const fixed = applyAdjustmentMapping([t], { ...d.suggestion, carrierMap: { "united parcel service": "ups" } }, ctx());
    expect(fixed.report.committable).toBe(true);
    expect(fixed.records[0]).toMatchObject({ carrierCode: "ups", brandId: ID.alpha, adjustmentType: "reweight", serviceId: null, serviceText: "Ground" });
    expect(fixed.report.byCode.service_unmapped).toBe(1);
  });

  it("with no cause column, the distinct reason texts become the cause map and the reason text is kept", () => {
    const t = csvTable([
      "ship_date,carrier,adjustment_type,reason,package_ref",
      "2026-01-01,UPS,reweight,Carrier reweigh,R1",
      "2026-01-02,UPS,reweight,WMS did not send weight,R2",
      "2026-01-03,UPS,reweight,Scale error at pack bench,R3",
      "2026-01-04,UPS,correction,Address and charge correction,R4",
      "2026-01-05,UPS,remeasure,Carrier reweigh,R5",
    ].join("\n"));
    const d = detectAdjustmentFile([t], ctx());
    expect(d.suggestion.columns.cause).toBeNull();
    expect(d.distinct.causes.map((c) => [c.text, c.rows, c.suggested])).toEqual([
      ["Carrier reweigh", 2, "carrier_reweigh"], ["Address and charge correction", 1, "other"], ["Scale error at pack bench", 1, "scale_error"], ["WMS did not send weight", 1, "wms_no_weight"],
    ]);
    const { records, report } = applyAdjustmentMapping([t], d.suggestion, ctx());
    expect(records.map((r) => [r.packageRef, r.cause, r.reasonText])).toEqual([
      ["R1", "carrier_reweigh", "Carrier reweigh"], ["R2", "wms_no_weight", "WMS did not send weight"], ["R3", "scale_error", "Scale error at pack bench"],
      ["R4", "other", "Address and charge correction"], ["R5", "carrier_reweigh", "Carrier reweigh"],
    ]);
    // The reason that matches no cause has no entry (the default cause is what applying the mapping does anyway), so it is counted as defaulted.
    expect(report.byCode.cause_defaulted).toBe(1);
    expect(report.rowNumbers.cause_defaulted).toEqual([4]);
    // The 3PL changes one entry of the map and the records follow it.
    const changed = applyAdjustmentMapping([t], { ...d.suggestion, causeMap: { ...d.suggestion.causeMap, "address and charge correction": "packaging_change" } }, ctx());
    expect(changed.records[3]!.cause).toBe("packaging_change");
    // A text that is not in the map falls back to the default cause and is counted; a text that is exactly a cause name ("Carrier reweigh" is carrier_reweigh) needs no map entry.
    const missing = applyAdjustmentMapping([t], { ...d.suggestion, causeMap: {} }, ctx());
    expect(missing.report.byCode.cause_defaulted).toBe(3);
    expect(missing.records.map((r) => r.cause)).toEqual(["carrier_reweigh", "other", "other", "other", "carrier_reweigh"]);
  });

  it("a default type, cause and customer apply to blank cells; a missing type column without a default is a mapping problem", () => {
    const t = files(["ship_date", "carrier", "package_ref"], ["2026-01-01", "UPS", "A1"]);
    const d = detectAdjustmentFile([t], ctx());
    expect(d.notes.join(" ")).toMatch(/No adjustment type column/);
    expect(applyAdjustmentMapping([t], d.suggestion, ctx()).report).toMatchObject({ ok: false, mappingIssues: [expect.objectContaining({ code: "type_missing" })] });
    const mapping: AdjustmentMapping = { ...d.suggestion, defaults: { adjustmentType: "reweight", cause: "scale_error", brandId: ID.beta } };
    const { records, report } = applyAdjustmentMapping([t], mapping, ctx());
    expect(report.ok).toBe(true);
    expect(records[0]).toMatchObject({ adjustmentType: "reweight", cause: "scale_error", brandId: ID.beta });
    expect(report.byCode.cause_defaulted).toBe(1);
  });
});

describe("mapping re-validation", () => {
  const flaggedTable: Table = {
    name: "Sheet1",
    rows: [
      ["ship_date", "carrier", "adjustment_type", "package_ref", "Carrier Cost", "customer_charge_corrected"],
      ["2026-01-01", "UPS", "reweight", "F1", "70.00", "12.00"],
    ],
    truncated: false,
  };

  it("a header the guard refuses can never be mapped to a money field, not even by hand", () => {
    const base = detectAdjustmentFile([flaggedTable], ctx()).suggestion;
    expect(base.columns.originalCharge).toBeNull();
    const manual: AdjustmentMapping = { ...base, columns: { ...base.columns, originalCharge: 4 } };
    const issues = validateMapping(manual, [flaggedTable], ctx());
    expect(issues.map((i) => i.code)).toContain("flagged_header_mapped");
    expect(issues.find((i) => i.code === "flagged_header_mapped")).toMatchObject({ field: "originalCharge" });
    expect(issues.find((i) => i.code === "flagged_header_mapped")!.message).toBe('The column "Carrier Cost" cannot be used for a charge: its name looks like a carrier cost column. Rename it in your file if it is not one.');
    const result = applyAdjustmentMapping([flaggedTable], manual, ctx());
    expect(result.report.ok).toBe(false);
    expect(result.report.committable).toBe(false);
    expect(result.records).toEqual([]);
    expect(JSON.stringify(result.report)).not.toContain("70.00");
    // Even the untouched suggestion is refused: the file as a whole carries a flagged header.
    expect(validateMapping(base, [flaggedTable], ctx()).map((i) => i.code)).toContain("forbidden_header");
  });

  it("every money field refuses a flagged column (the same for corrected charge and fee)", () => {
    const base = detectAdjustmentFile([flaggedTable], ctx()).suggestion;
    for (const field of ["originalCharge", "correctedCharge", "adjustmentFee"] as const) {
      const issues = validateMapping({ ...base, columns: { ...base.columns, [field]: 4 } }, [flaggedTable], ctx());
      expect(issues.some((i) => i.code === "flagged_header_mapped" && i.field === field), field).toBe(true);
    }
  });

  it("an amount column that passes the guard may be mapped by hand", () => {
    const t: Table = { name: "Sheet1", rows: [["ship_date", "carrier", "adjustment_type", "Adjustment Amount"], ["2026-01-01", "UPS", "reweight", "$3.00"]], truncated: false };
    const base = detectAdjustmentFile([t], ctx()).suggestion;
    expect(base.columns.adjustmentFee).toBeNull();
    const manual: AdjustmentMapping = { ...base, columns: { ...base.columns, adjustmentFee: 3 } };
    expect(validateMapping(manual, [t], ctx())).toEqual([]);
    expect(applyAdjustmentMapping([t], manual, ctx()).records[0]).toMatchObject({ separateFee: "3.00" });
  });

  it("refuses a column mapped twice, a column outside the sheet, an unknown sheet and a moved header row", () => {
    const t = csvTable("ship_date,carrier,adjustment_type\n2026-01-01,UPS,reweight");
    const base = detectAdjustmentFile([t], ctx()).suggestion;
    expect(validateMapping({ ...base, columns: { ...base.columns, adjustedOn: 0 } }, [t], ctx()).map((i) => i.code)).toContain("column_mapped_twice");
    expect(validateMapping({ ...base, columns: { ...base.columns, adjustedOn: 9 } }, [t], ctx()).map((i) => i.code)).toContain("column_out_of_range");
    expect(validateMapping({ ...base, sheet: "Nope" }, [t], ctx())).toEqual([expect.objectContaining({ code: "sheet_missing" })]);
    expect(validateMapping({ ...base, headerRow: 5 }, [t], ctx())).toEqual([expect.objectContaining({ code: "header_row_invalid" })]);
    // A mapping can only point at the row the importer reads as the column names: moving it to another row (whose cells would then be stored as column names) is refused.
    const moved: Table = { name: "Sheet1", rows: [["ship_date", "carrier", "adjustment_type"], ["Postage Cost", "x", "y"], ["2026-01-01", "UPS", "reweight"]], truncated: false };
    expect(validateMapping({ ...base, headerRow: 1 }, [moved], ctx())).toEqual([expect.objectContaining({ code: "header_row_invalid" })]);
    expect(validateMapping({ ...base, headerRow: 2 }, [moved], ctx())).toEqual([expect.objectContaining({ code: "header_row_invalid" })]);
    // And the guard reads that second block of text too (the file is refused before any mapping exists).
    expect(guardTables([moved])).toMatchObject({ allowed: false, firstRefusedHeader: "Postage Cost" });
  });

  it("refuses customers, carriers and services in the mapping that are not in the account or catalog, and a mapping too large to store", () => {
    const t = csvTable("ship_date,carrier,adjustment_type\n2026-01-01,UPS,reweight");
    const base = detectAdjustmentFile([t], ctx()).suggestion;
    const codes = (m: AdjustmentMapping) => validateMapping(m, [t], ctx()).map((i) => i.code);
    expect(codes({ ...base, brandMap: { x: "00000000-0000-4000-8000-000000000999" } })).toContain("unknown_customer_in_map");
    expect(codes({ ...base, defaults: { ...base.defaults, brandId: "00000000-0000-4000-8000-000000000999" } })).toContain("unknown_customer_in_map");
    expect(codes({ ...base, carrierMap: { x: "dhl" } })).toContain("unknown_carrier_in_map");
    expect(codes({ ...base, serviceMap: { x: "00000000-0000-4000-8000-000000000999" } })).toContain("unknown_service_in_map");
    // 150 customers the account does not have: the suggestion stores nothing for them (applying the mapping leaves them unassigned anyway) and fits.
    const names = Array.from({ length: 150 }, (_, i) => `Customer ${String(i).padStart(3, "0")}`);
    const big = csvTable(["ship_date,carrier,brand,adjustment_type", ...names.map((n) => `2026-01-01,UPS,${n},reweight`)].join("\n"));
    const d = detectAdjustmentFile([big], ctx());
    expect(validateMapping(d.suggestion, [big], ctx())).toEqual([]);
    expect(Object.keys(d.suggestion.brandMap)).toEqual([]);
    expect(JSON.stringify(toStoredMapping(d.suggestion, big.rows[0]!, ctx())).length).toBeLessThan(2500);
    // The 3PL assigns every one of them to a customer by hand: that many entries cannot be stored in 8 KB.
    const assigned = { ...d.suggestion, brandMap: Object.fromEntries(names.map((n) => [normalizeValue(n), ID.alpha])) };
    expect(validateMapping(assigned, [big], ctx()).map((i) => i.code)).toContain("mapping_too_large");
    expect(JSON.stringify(toStoredMapping(assigned, big.rows[0]!, ctx())).length).toBeGreaterThan(MAPPING_MAX_BYTES - 1500);
    // A typical mapping is far below the 8 KB the database allows.
    const small = detectAdjustmentFile([csvTable("ship_date,carrier,adjustment_type\n2026-01-01,UPS,reweight")], ctx());
    expect(JSON.stringify(toStoredMapping(small.suggestion, ["ship_date", "carrier", "adjustment_type"])).length).toBeLessThan(2500);
  });

  it("an example row from the template is an error and can never become history", async () => {
    const tables = await load("history-sample.csv");
    const t: Table = { name: "Sheet1", rows: [tables[0]!.rows[0]!, ...ADJUSTMENTS_TEMPLATE_CSV.trim().split("\n").slice(1).map((l) => l.split(","))], truncated: false };
    const d = detectAdjustmentFile([t], ctx());
    const { report, records } = applyAdjustmentMapping([t], d.suggestion, ctx());
    expect(report.byCode.example_row).toBe(2);
    expect(report.counts.errorRows).toBe(2);
    expect(report.committable).toBe(false);
    expect(records).toEqual([]);
    expect(report.codes.find((c) => c.code === "example_row")!.message).toBe("2 rows are the fictional example rows from the template. Delete them before importing.");
  });
});

describe("import copy", () => {
  it("is the wording the design and the customer review give, kept in one place", () => {
    expect(REFUSAL_TITLE).toBe("This file looks like carrier cost data");
    expect(MONEY_FIELD_HINT).toBe("Enter what your customer is charged, never what the carrier bills you.");
    expect(MONEY_FIELD_LABELS).toEqual({ originalCharge: "Original charge to your customer", correctedCharge: "Corrected charge to your customer", adjustmentFee: "Separate adjustment fee charged to your customer" });
    expect(ATTESTATION_TEXT).toBe("These charge columns hold what my customer was or would be charged. They do not hold what the carrier billed me.");
    expect(IMPORT_NOTICE).toBe("Only your team can see this. Customers never do.");
    expect(IMPORT_LIMITS).toBe("5 MB, 20,000 rows; split by month");
    expect(HISTORY_EMPTY).toContain("Only your team can see it.");
    // Nothing in the copy presents an amount as an invoice, a loss or a cost.
    for (const text of [MONEY_FIELD_HINT, ATTESTATION_TEXT, IMPORT_NOTICE, HISTORY_EMPTY]) expect(text).not.toMatch(/\binvoice\b|\bloss\b|margin/i);
  });
});

describe("stored mapping, detected details and validation", () => {
  it("round-trips the stored form (mapped columns plus the header each reads) through zod", async () => {
    const tables = await load("history-sample.csv");
    const d = detectAdjustmentFile(tables, ctx());
    const headers = tables[0]!.rows[0]!;
    const stored = toStoredMapping(d.suggestion, headers);
    expect(stored.fields).toMatchObject({ shipDate: "ship_date", originalCharge: "customer_charge_original", adjustmentFee: "customer_adjustment_fee", packageRef: "package_ref" });
    expect(stored.columns.shipDate).toBe(0);
    expect(JSON.stringify(stored).length).toBeLessThan(2500);
    const roundTrip = parseStoredMapping(JSON.parse(JSON.stringify(stored)));
    expect(roundTrip).toEqual(d.suggestion);
    expect(fromStoredMapping(stored)).toEqual(d.suggestion);
    expect(adjustmentMappingSchema.safeParse(d.suggestion).success).toBe(true);
    expect(parseStoredMapping({ ...JSON.parse(JSON.stringify(stored)), dateFormat: "ymd" })).toBeNull();
    expect(parseStoredMapping({ ...JSON.parse(JSON.stringify(stored)), serviceMap: { x: "not-a-uuid" } })).toBeNull();
    expect(parseStoredMapping(null)).toBeNull();
    expect(parseStoredMapping([])).toBeNull();
  });

  it("detected keeps the header names and at most 20 sample rows of MAPPED columns only", () => {
    const rows = ["ship_date,carrier,adjustment_type,package_ref,Total,Notes,customer_charge_corrected", ...Array.from({ length: 30 }, (_, i) => `2026-01-0${(i % 9) + 1},UPS,reweight,P${i},TOTALVALUE${i},NOTEVALUE${i},9.${String(i).padStart(2, "0")}`)].join("\n");
    const t = csvTable(rows);
    const d = detectAdjustmentFile([t], ctx());
    const detected = buildDetected([t], d.suggestion);
    expect(detected.headers).toEqual(["ship_date", "carrier", "adjustment_type", "package_ref", "Total", "Notes", "customer_charge_corrected"]);
    expect(detected.sampleRows).toHaveLength(20);
    expect(Object.keys(detected.sampleRows[0]!)).toEqual(["ship_date", "carrier", "adjustment_type", "package_ref", "customer_charge_corrected"]);
    expect(JSON.stringify(detected)).not.toContain("TOTALVALUE");
    expect(JSON.stringify(detected)).not.toContain("NOTEVALUE");
    expect(detected.rowCount).toBe(30);
    expect(new TextEncoder().encode(JSON.stringify(detected)).length).toBeLessThan(65_536);
  });

  it("trims a stored validation report to the database's size without touching the counts it reads", () => {
    const rowNumbers = Object.fromEntries(["invalid_date", "invalid_amount", "negative_amount", "invalid_weight", "non_positive_weight", "partial_dimensions", "duplicate_reference", "unknown_customer", "no_amounts", "credit_row"].map((c) => [c, Array.from({ length: 5000 }, (_, i) => 10_000 + i)]));
    const huge = { ...fakeReport(), rowNumbers, customers: Array.from({ length: 50 }, (_, i) => ({ text: "x".repeat(120) + i, rows: 1, brandId: null })), issues: Array.from({ length: 100 }, (_, i) => ({ code: "invalid_date" as const, severity: "error" as const, row: i + 1 })) };
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeGreaterThan(30_000);
    const out = toStoredValidation(huge);
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(30_000);
    expect(out.counts).toEqual(huge.counts);
    expect(Math.max(...Object.values(out.rowNumbers).map((v) => v!.length))).toBeLessThanOrEqual(10);
    expect(out.issuesTruncated).toBe(true);
    const small = toStoredValidation(fakeReport());
    expect(small).toEqual(fakeReport());
  });
});

function fakeReport() {
  return applyAdjustmentMapping([csvTable("ship_date,carrier,adjustment_type\n2026-01-01,UPS,reweight")], detectAdjustmentFile([csvTable("ship_date,carrier,adjustment_type\n2026-01-01,UPS,reweight")], ctx()).suggestion, ctx()).report;
}

// ---------------------------------------------------------------------------
// Chunking and reconciliation
// ---------------------------------------------------------------------------
describe("a full-size file", () => {
  it("20,000 rows parse, validate and chunk into ten chunks of 2,000, with every row accounted for", async () => {
    const header = "ship_date,adjusted_on,carrier,service,brand,adjustment_type,cause,reason,package_ref,declared_weight,actual_weight,weight_unit,customer_charge_original,customer_charge_corrected,customer_adjustment_fee";
    const lines = Array.from({ length: 20_000 }, (_, i) => `2026-08-${String((i % 27) + 1).padStart(2, "0")},2026-09-01,UPS,UPS Ground,${i % 2 ? "Alpha Apparel" : "Beta Beverages"},reweight,carrier_reweigh,Carrier reweigh,1ZF${String(i).padStart(9, "0")},${(i % 9) + 1},${(i % 9) + 2},lb,12.00,13.50,${i % 5 === 0 ? "" : "3.00"}`);
    const bytes = Buffer.from([header, ...lines].join("\n"));
    expect(bytes.length).toBeLessThan(5 * 1024 * 1024);
    const started = Date.now();
    const parsed = await parseAdjustmentFile(bytes, "csv");
    if (parsed.status !== "ok") throw new Error(parsed.status);
    const d = detectAdjustmentFile(parsed.tables, ctx());
    const result = applyAdjustmentMapping(parsed.tables, d.suggestion, ctx());
    const { chunks, accepted } = buildAppendChunks(result);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.report.counts).toEqual({ rows: 20_000, errorRows: 0, cleanRows: 20_000, accepted: 20_000, merged: 0, ignored: 0, alreadyImported: 0 });
    expect(accepted).toBe(20_000);
    expect(chunks.map((c) => c.rows.length)).toEqual(Array(10).fill(2000));
    expect(chunks.map((c) => c.fromRow)).toEqual(Array.from({ length: 10 }, (_, k) => k * 2000 + 1));
    expect(new Set(chunks.flatMap((c) => c.rows.map((r) => r.package_ref))).size).toBe(20_000);
    // A blank fee in every fifth row stays unknown; the others are 3.00.
    expect(chunks.flatMap((c) => c.rows).filter((r) => r.separate_fee === null)).toHaveLength(4000);
    expect(new TextEncoder().encode(JSON.stringify(toStoredValidation(result.report))).length).toBeLessThan(32 * 1024);
  });
});

describe("the chunk builder", () => {
  const record = (i: number): AdjustmentRecord => ({
    rowNo: i, shipDate: "2026-08-03", adjustedOn: null, carrierCode: "ups", serviceId: null, serviceText: null, brandId: null, adjustmentType: "reweight", cause: "other", reasonText: null,
    packageRef: `P${i}`, declaredWeightLb: null, declaredWeightBasis: "missing", actualWeightLb: null, original: null, corrected: null, originalCharge: null, correctedCharge: null, separateFee: null, handlingRecorded: null,
  });
  const resultOf = (n: number) => {
    const records = Array.from({ length: n }, (_, i) => record(i + 1));
    const report = { ...fakeReport(), committable: true, counts: { rows: n, errorRows: 0, cleanRows: n, accepted: n, merged: 0, ignored: 0, alreadyImported: 0 } };
    return { records, report };
  };

  it("chunks of at most 2,000 with dense row numbers, for sizes around every boundary and 200 seeded sizes", () => {
    expect(APPEND_CHUNK_ROWS).toBe(2000);
    const sizes = [1, 2, 1999, 2000, 2001, 3999, 4000, 4001, 20_000];
    let seed = 7;
    for (let i = 0; i < 200; i++) sizes.push(1 + (seed = (seed * 1103515245 + 12345) % 2147483648) % 20_000);
    for (const n of sizes) {
      const { chunks, accepted } = buildAppendChunks(resultOf(n));
      expect(accepted).toBe(n);
      expect(chunks).toHaveLength(Math.ceil(n / 2000));
      let next = 1;
      for (const c of chunks) {
        expect(c.fromRow).toBe(next);
        expect(c.rows.length).toBeGreaterThanOrEqual(1);
        expect(c.rows.length).toBeLessThanOrEqual(2000);
        next += c.rows.length;
      }
      expect(next - 1).toBe(n);
      expect(chunks.flatMap((c) => c.rows.map((r) => r.package_ref))).toEqual(Array.from({ length: n }, (_, k) => `P${k + 1}`));
    }
  });

  it("20,000 rows are ten chunks of 2,000", () => {
    const { chunks } = buildAppendChunks(resultOf(20_000));
    expect(chunks.map((c) => [c.fromRow, c.rows.length])).toEqual(Array.from({ length: 10 }, (_, k) => [k * 2000 + 1, 2000]));
  });

  it("refuses a result that is not committable, or whose record count differs from the validated count, or a bad chunk size", () => {
    const ok = resultOf(5);
    expect(() => buildAppendChunks({ ...ok, report: { ...ok.report, committable: false } })).toThrow(/must be fixed/);
    expect(() => buildAppendChunks({ ...ok, report: { ...ok.report, ok: false } })).toThrow(ChunkError);
    expect(() => buildAppendChunks({ records: ok.records.slice(1), report: ok.report })).toThrow(/do not match the validated count/);
    expect(() => buildAppendChunks(ok, 0)).toThrow(ChunkError);
    expect(() => buildAppendChunks(ok, 2001)).toThrow(ChunkError);
    expect(buildAppendChunks(ok, 2).chunks.map((c) => [c.fromRow, c.rows.length])).toEqual([[1, 2], [3, 2], [5, 1]]);
  });

  it("sends unknown values as null, never 0 or an empty string", () => {
    const row = toAppendRow(record(1));
    expect(row).toMatchObject({ declared_weight_lb: null, actual_weight_lb: null, original_charge: null, corrected_charge: null, separate_fee: null, orig_length_in: null, corr_height_in: null, adjusted_on: null, brand_id: null });
    expect(Object.values(row).filter((v) => v === "" || v === 0)).toEqual([]);
  });

  it("reconciles stored plus skipped with the accepted count, and reads a replayed chunk's totals", () => {
    expect(reconcileCommit(10, { committed: 10, skippedTotal: 0 })).toMatchObject({ ok: true, committed: 10, skipped: 0, message: "10 rows were added." });
    expect(reconcileCommit(10, { committed: 7, skippedTotal: 3 })).toMatchObject({ ok: true, committed: 7, skipped: 3, message: "7 rows were added; 3 were already imported and skipped." });
    expect(reconcileCommit(1, { committed: 1, skippedTotal: 0 }).message).toBe("1 row was added.");
    // A replayed chunk answers with the totals as committed and skipped.
    expect(reconcileCommit(10, { applied: false, nextRow: 11, committed: 8, skipped: 2 })).toMatchObject({ ok: true, committed: 8, skipped: 2 });
    for (const bad of [{ committed: 9, skippedTotal: 0 }, { committed: 10, skippedTotal: 1 }, null]) {
      const r = reconcileCommit(10, bad);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not finished/);
    }
    expect(reconcileCommit(0, { committed: 0, skippedTotal: 0 }).ok).toBe(false);
  });

  it("resumes from the database cursor", () => {
    const { chunks } = buildAppendChunks(resultOf(5000));
    expect(remainingChunks(chunks, 1).map((c) => c.fromRow)).toEqual([1, 2001, 4001]);
    expect(remainingChunks(chunks, 2001).map((c) => c.fromRow)).toEqual([2001, 4001]);
    expect(remainingChunks(chunks, 4001).map((c) => c.fromRow)).toEqual([4001]);
    expect(remainingChunks(chunks, 5001)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Safety properties
// ---------------------------------------------------------------------------
describe("hard rules", () => {
  it("no carrier-cost header can reach a money field: 500 seeded mappings over a flagged table", () => {
    const refusedHeaders = guardTable.cases.filter((c) => c.guard === "refuse").map((c) => c.header);
    let seed = 99;
    const rnd = (n: number) => (seed = (seed * 1664525 + 1013904223) % 4294967296) % n;
    for (let i = 0; i < 500; i++) {
      const header = refusedHeaders[rnd(refusedHeaders.length)]!;
      const t: Table = { name: "Sheet1", rows: [["ship_date", "carrier", "adjustment_type", header], ["2026-01-01", "UPS", "reweight", "50.00"]], truncated: false };
      const base = detectAdjustmentFile([t], ctx()).suggestion;
      // The suggestion never reads it...
      expect(Object.values(base.columns).includes(3), header).toBe(false);
      // ...and neither does any manual choice of field.
      const field = (["originalCharge", "correctedCharge", "adjustmentFee", "declaredWeight", "reason", "shipDate"] as const)[rnd(6)]!;
      const result = applyAdjustmentMapping([t], { ...base, columns: { ...base.columns, [field]: 3 } }, ctx());
      expect(result.report.ok, `${header} -> ${field}`).toBe(false);
      expect(result.records).toEqual([]);
    }
  });

  it("every record in the sample carries only customer-facing money fields: the three amounts and nothing else money-like", async () => {
    const tables = await load("history-sample.csv");
    const { records } = applyAdjustmentMapping(tables, detectAdjustmentFile(tables, ctx()).suggestion, ctx());
    const moneyKeys = Object.keys(toAppendRow(records[0]!)).filter((k) => /charge|fee|cost|rate|price|amount|paid|net/.test(k));
    expect(moneyKeys).toEqual(["original_charge", "corrected_charge", "separate_fee"]);
  });

  it("names that collide with object properties are just names: a customer, carrier, service, type or cause called 'constructor'", () => {
    const t = csvTable(["ship_date,carrier,service,brand,adjustment_type,cause,package_ref", "2026-01-01,constructor,constructor,constructor,constructor,constructor,C1"].join("\n"));
    const base = detectAdjustmentFile([t], ctx()).suggestion;
    for (const mapping of [base, { ...base, typeMap: {}, carrierMap: {}, brandMap: {}, causeMap: {}, serviceMap: {} }]) {
      const { report, records } = applyAdjustmentMapping([t], mapping, ctx());
      expect(report.byCode).toMatchObject({ unknown_carrier: 1, invalid_type: 1, unknown_customer: 1, service_unmapped: 1 });
      expect(records).toEqual([]);
    }
    // Mapped on purpose, the same names work like any other.
    const only = <T,>(key: string, value: T) => Object.fromEntries([[key, value]]) as Record<string, T>;
    const mapped: AdjustmentMapping = { ...base, typeMap: only("constructor", "reweight" as const), carrierMap: only("constructor", "ups"), brandMap: only("constructor", ID.alpha), causeMap: only("constructor", "scale_error" as const), serviceMap: only("ups constructor", ID.upsGround) };
    const { records, report } = applyAdjustmentMapping([t], mapped, ctx());
    expect(report.committable).toBe(true);
    expect(records[0]).toMatchObject({ adjustmentType: "reweight", carrierCode: "ups", brandId: ID.alpha, cause: "scale_error", serviceId: null });
  });

  it("a sheet with a header and no rows, or no usable sheet, is a mapping problem rather than an empty success", () => {
    const t = csvTable("ship_date,carrier,adjustment_type");
    const r = applyAdjustmentMapping([t], detectAdjustmentFile([t], ctx()).suggestion, ctx());
    expect(r.report).toMatchObject({ ok: false, committable: false, mappingIssues: [expect.objectContaining({ code: "no_rows" })] });
    expect(detectAdjustmentFile([], ctx()).notes).toEqual(["The file has no rows."]);
  });

  it("detects the sheet that is asked for", () => {
    const a: Table = { name: "Notes", rows: [["read", "me", "first"], ["x", "y", "z"]], truncated: false };
    const b: Table = { name: "History", rows: [["ship_date", "carrier", "adjustment_type"], ["2026-01-01", "UPS", "reweight"]], truncated: false };
    // The first sheet that has column names we can find (a workbook may start with a notes sheet); the notes sheet is not recognised and cannot be mapped.
    expect(detectAdjustmentFile([a, b], ctx()).suggestion.sheet).toBe("History");
    expect(detectAdjustmentFile([a, b], ctx()).sheets.map((s) => s.recognised)).toEqual([false, true]);
    expect(detectAdjustmentFile([a, b], ctx(), "Notes").notes.join(" ")).toMatch(/put the column names in row 1/i);
    const d = detectAdjustmentFile([a, b], ctx(), "History");
    expect(d.suggestion).toMatchObject({ sheet: "History", columns: expect.objectContaining({ shipDate: 0, carrier: 1, adjustmentType: 2 }) });
    expect(d.sheets.map((s) => s.name)).toEqual(["Notes", "History"]);
  });

  it("a package reference that a spreadsheet turned into scientific notation is an error row, so mangled tracking numbers cannot collide", () => {
    const t = csvTable(["ship_date,carrier,adjustment_type,package_ref", "2026-01-01,UPS,reweight,9.40011E+21", "2026-01-01,UPS,reweight,9.40011E+21", "2026-01-02,UPS,reweight,'1Z999", "2026-01-02,UPS,reweight,1Z999"].join("\n"));
    const { report, records } = applyAdjustmentMapping([t], detectAdjustmentFile([t], ctx()).suggestion, ctx());
    expect(report.byCode.invalid_package_ref).toBe(2);
    expect(report.rowNumbers.invalid_package_ref).toEqual([1, 2]);
    // The apostrophe wrapper is removed, so the two forms of 1Z999 are the same reference and the second is a repeat.
    expect(report.byCode.duplicate_reference).toBe(1);
    expect(records.map((r) => r.packageRef)).toEqual(["1Z999"]);
    expect(report.codes.find((c) => c.code === "invalid_package_ref")!.message).toContain("scientific notation");
  });

  it("is deterministic and order-independent for counts: shuffling the rows of the sample changes no per-code count", async () => {
    const tables = await load("history-sample.csv");
    const header = tables[0]!.rows[0]!;
    const body = tables[0]!.rows.slice(1);
    const base = detectAdjustmentFile(tables, ctx()).suggestion;
    const baseline = applyAdjustmentMapping(tables, base, ctx()).report.byCode;
    let seed = 5;
    for (let round = 0; round < 10; round++) {
      const shuffled = [...body];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = (seed = (seed * 1103515245 + 12345) % 2147483648) % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const t: Table = { name: "Sheet1", rows: [header, ...shuffled], truncated: false };
      const r = applyAdjustmentMapping([t], base, ctx());
      expect(r.report.byCode).toEqual(baseline);
      expect(r.report.counts.accepted).toBe(40);
    }
  });
});
