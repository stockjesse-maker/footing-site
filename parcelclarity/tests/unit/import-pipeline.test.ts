import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectFileKind, parseTables } from "@/lib/import/parse-table";
import { detectRateCard, suggestService, type LongMapping, type ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";
import { applyMapping, parseMoney, parseWeightCell } from "@/lib/import/rate-card-validate";

const catalog: ServiceCatalogEntry[] = [
  { id: "svc-ups-ground", carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" },
  { id: "svc-ups-2da", carrierCode: "ups", carrierName: "UPS", code: "second_day_air", name: "UPS 2nd Day Air" },
  { id: "svc-ups-nda", carrierCode: "ups", carrierName: "UPS", code: "next_day_air", name: "UPS Next Day Air" },
  { id: "svc-fedex-ground", carrierCode: "fedex", carrierName: "FedEx", code: "ground", name: "FedEx Ground" },
  { id: "svc-fedex-home", carrierCode: "fedex", carrierName: "FedEx", code: "home_delivery", name: "FedEx Home Delivery" },
  { id: "svc-usps-ga", carrierCode: "usps", carrierName: "USPS", code: "ground_advantage", name: "USPS Ground Advantage" },
];

const fixtureCsv = readFileSync(path.resolve(__dirname, "../fixtures/pricing/fixture-rate-card.csv"));

describe("cell parsers", () => {
  it("parse money and weights strictly", () => {
    expect(parseMoney("$1,234.5")).toBe("1234.5000");
    expect(parseMoney("12")).toBe("12.0000");
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("-5")).toBeNull();
    expect(parseWeightCell("5")).toEqual({ min: null, max: "5", unit: null });
    expect(parseWeightCell("5 lbs")).toEqual({ min: null, max: "5", unit: "lb" });
    expect(parseWeightCell("1-4 oz")).toEqual({ min: "1", max: "4", unit: "oz" });
    expect(parseWeightCell("up to 16 oz")).toEqual({ min: null, max: "16", unit: "oz" });
    expect(parseWeightCell("heavy")).toBeNull();
  });
});

describe("service suggestions", () => {
  it("match common rate-card labels to catalog services", () => {
    expect(suggestService("UPS Ground", catalog).serviceId).toBe("svc-ups-ground");
    expect(suggestService("Ground", catalog, "UPS").serviceId).toBe("svc-ups-ground");
    expect(suggestService("FedEx Home Delivery", catalog).serviceId).toBe("svc-fedex-home");
    expect(suggestService("2nd Day Air", catalog, "UPS").serviceId).toBe("svc-ups-2da");
    expect(suggestService("USPS Ground Advantage", catalog).serviceId).toBe("svc-usps-ga");
    expect(suggestService("Pallet freight LTL", catalog).serviceId).toBeNull();
  });
});

describe("long-format import of the fixture rate card", () => {
  it("detects the format, suggests a complete mapping, and validates every row", async () => {
    const kind = detectFileKind("fixture-rate-card.csv", "text/csv", fixtureCsv);
    const tables = await parseTables(fixtureCsv, kind);
    expect(tables).toHaveLength(1);
    const detection = detectRateCard(tables, catalog);
    expect(detection.suggestedFormat).toBe("long");
    expect(detection.suggestion?.format).toBe("long");
    const mapping = detection.suggestion!;
    if (mapping.format !== "long") throw new Error("expected long mapping");
    expect(mapping.columns).toMatchObject({ carrier: 0, service: 1, originZip: 2, zone: 3, weightMin: 4, weightMax: 5, weightUnit: 6, price: 7, minCharge: 8 });
    expect(detection.serviceStrings.map((s) => s.suggestedServiceId)).toEqual(["svc-ups-ground", "svc-ups-2da", "svc-usps-ga"]);

    const result = applyMapping(tables, mapping, catalog);
    expect(result.report.errors).toEqual([]);
    expect(result.report.rowCount).toBe(1852);
    expect(result.report.ok).toBe(true);
    const ga = result.report.services.find((s) => s.serviceId === "svc-usps-ga")!;
    expect(ga.originPrefixes).toEqual(["900"]);
    expect(ga.zones).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(ga.maxWeight).toEqual({ value: "70", unit: "lb" });
    // No divisor column in the fixture file → one warning per service.
    expect(result.report.warnings.filter((w) => w.code === "dim_divisor_missing")).toHaveLength(3);
    const row = result.rows.find((r) => r.serviceId === "svc-ups-ground" && r.zone === "5" && r.weightMax === "4")!;
    expect(row).toMatchObject({ weightMin: "3", price: "11.0700", weightUnit: "lb", originPrefix: null });
  });

  it("reports unmapped services, bad prices and overlapping brackets without inventing values", async () => {
    const csv = Buffer.from(
      [
        "service,zone,weight,price",
        "UPS Ground,2,1,7.90",
        "UPS Ground,2,2,eight",
        "UPS Ground,2,2,8.30",
        "Mystery Air,3,1,9.00",
        "UPS Ground,Zone 3,1,$8.35",
        "",
      ].join("\n"),
    );
    const tables = await parseTables(csv, "csv");
    const detection = detectRateCard(tables, catalog);
    const mapping = detection.suggestion!;
    if (mapping.format !== "long") throw new Error("expected long mapping");
    expect(mapping.serviceMap).toEqual({ "ups ground": "svc-ups-ground" });
    const result = applyMapping(tables, mapping, catalog);
    const codes = result.report.errors.map((e) => `${e.code}@${e.row}`);
    expect(codes).toEqual(expect.arrayContaining(["price_invalid@3", "service_unmapped@5"]));
    expect(result.report.ok).toBe(false);
    expect(result.rows.find((r) => r.zone === "3")?.price).toBe("8.3500");
  });
});

describe("grid-format import", () => {
  it("reads weights down and zones across, one sheet per service, deriving brackets", async () => {
    const csv = Buffer.from(["Weight (lbs),Zone 2,Zone 3,Zone 4", "1,7.90,8.35,8.90", "2,8.21,8.71,9.32", "3,8.52,9.07,9.74", ""].join("\n"));
    const tables = await parseTables(csv, "csv");
    const detection = detectRateCard(tables, catalog);
    expect(detection.suggestedFormat).toBe("grid");
    const suggestion = detection.suggestion!;
    if (suggestion.format !== "grid") throw new Error("expected grid mapping");
    expect(suggestion.sheets[0]).toMatchObject({ weightColumn: 0, weightUnit: "lb", zoneColumns: [{ column: 1, zone: "2" }, { column: 2, zone: "3" }, { column: 3, zone: "4" }] });
    suggestion.sheets[0]!.serviceId = "svc-ups-ground";
    suggestion.sheets[0]!.dimDivisor = "139";
    const result = applyMapping(tables, suggestion, catalog);
    expect(result.report.errors).toEqual([]);
    expect(result.rows).toHaveLength(9);
    expect(result.rows.filter((r) => r.zone === "3").map((r) => [r.weightMin, r.weightMax, r.price])).toEqual([["0", "1", "8.3500"], ["1", "2", "8.7100"], ["2", "3", "9.0700"]]);
    expect(result.terms["svc-ups-ground"]).toEqual({ dimDivisor: "139", minCharge: null });
    expect(result.report.warnings).toEqual([]);
  });
});

describe("file guards", () => {
  it("rejects wrong types and empty files", async () => {
    expect(() => detectFileKind("card.pdf", "application/pdf", Buffer.from("%PDF"))).toThrow(/Only .csv and .xlsx/);
    expect(() => detectFileKind("card.xlsx", "application/octet-stream", Buffer.from("not a zip"))).toThrow(/not a valid .xlsx/);
    await expect(parseTables(Buffer.alloc(0), "csv")).rejects.toThrow(/empty/);
  });
});

describe("bracket conventions and strict cells (review fixes)", () => {
  const longMapping = (columns: Partial<LongMapping["columns"]>, serviceMap: Record<string, string>, weightUnit: "lb" | "oz" = "lb"): LongMapping =>
    ({
      format: "long" as const,
      sheet: "Sheet1",
      headerRow: 0,
      columns: { carrier: null, service: 0, originZip: null, zone: 1, weightMin: null, weightMax: 2, weightUnit: null, price: 3, minCharge: null, dimDivisor: null, ...columns },
      defaults: { weightUnit, dimDivisor: null },
      serviceMap,
    });

  it("reads in-cell ranges like '1-4 oz' as contiguous brackets with an exclusive lower bound", async () => {
    const csv = Buffer.from(["service,zone,weight,price", "USPS Ground Advantage,1,1-4 oz,4.00", "USPS Ground Advantage,1,5-8 oz,4.50", "USPS Ground Advantage,1,9-12 oz,5.00", ""].join("\n"));
    const tables = await parseTables(csv, "csv");
    const result = applyMapping(tables, longMapping({}, { "usps ground advantage": "svc-usps-ga" }), catalog);
    expect(result.report.errors).toEqual([]);
    expect(result.rows.map((r) => [r.weightMin, r.weightMax, r.weightUnit])).toEqual([["0", "4", "oz"], ["4", "8", "oz"], ["8", "12", "oz"]]);
    expect(result.report.warnings.map((w) => w.code)).toContain("bracket_contiguous");
    expect(result.report.warnings.map((w) => w.code)).not.toContain("bracket_gap");
  });

  it("reads explicit inclusive-integer minimums (1–5, 6–10) as contiguous, but keeps a real gap as a warning", async () => {
    const csv = Buffer.from(["service,zone,from,to,price", "UPS Ground,2,1,5,9.00", "UPS Ground,2,6,10,9.50", "UPS Ground,2,11,15,9.90", "UPS Ground,3,0,5,9.10", "UPS Ground,3,7,10,9.60", ""].join("\n"));
    const tables = await parseTables(csv, "csv");
    const result = applyMapping(tables, longMapping({ weightMin: 2, weightMax: 3, price: 4 }, { "ups ground": "svc-ups-ground" }), catalog);
    expect(result.report.errors).toEqual([]);
    expect(result.rows.filter((r) => r.zone === "2").map((r) => [r.weightMin, r.weightMax])).toEqual([["0", "5"], ["5", "10"], ["10", "15"]]);
    // Zone 3: 0–5 then 7–10 is not the +1 convention; weights between 5 and 7 lb really have no rate.
    expect(result.rows.filter((r) => r.zone === "3").map((r) => [r.weightMin, r.weightMax])).toEqual([["0", "5"], ["7", "10"]]);
    expect(result.report.warnings.filter((w) => w.code === "bracket_gap")).toHaveLength(1);
  });

  it("refuses unrecognised weight units instead of assuming the default, and accepts the common spellings", async () => {
    const csv = Buffer.from(["service,zone,weight,unit,price", "UPS Ground,2,16,ounces,7.90", "UPS Ground,2,32,OZS,8.30", "UPS Ground,2,48,g,8.70", "UPS Ground,2,4,Pounds,9.00", ""].join("\n"));
    const tables = await parseTables(csv, "csv");
    const result = applyMapping(tables, longMapping({ weightUnit: 3, price: 4 }, { "ups ground": "svc-ups-ground" }), catalog);
    expect(result.report.errors.map((e) => `${e.code}@${e.row}`)).toEqual(["weight_unit_invalid@4"]);
    expect(result.rows.map((r) => [r.weightMax, r.weightUnit])).toEqual([["16", "oz"], ["32", "oz"], ["4", "lb"]]);
  });

  it("refuses prices with more than four decimals rather than truncating them", () => {
    expect(parseMoney("12.3456")).toBe("12.3456");
    expect(parseMoney("12.34567")).toBeNull();
  });

  it("refuses sheets over the row cap instead of silently dropping rows", async () => {
    const lines = ["service,zone,weight,price"];
    for (let i = 1; i <= 50_001; i++) lines.push(`UPS Ground,2,${i},1.00`);
    await expect(parseTables(Buffer.from(lines.join("\n")), "csv")).rejects.toThrow(/more than 50,000 rows/);
  });

  it("refuses a workbook whose zip directory declares an unreasonable inflated size before inflating it", async () => {
    const { checkXlsxInflation } = await import("@/lib/import/parse-table");
    const entry = (name: string, uncompressed: number) => {
      const b = Buffer.alloc(46 + name.length);
      b.writeUInt32LE(0x02014b50, 0);
      b.writeUInt32LE(uncompressed, 24);
      b.writeUInt16LE(name.length, 28);
      b.write(name, 46);
      return b;
    };
    const bomb = (names: string[], each: number) => {
      const dir = Buffer.concat(names.map((n) => entry(n, each)));
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(names.length, 8);
      eocd.writeUInt16LE(names.length, 10);
      eocd.writeUInt32LE(dir.length, 12);
      eocd.writeUInt32LE(0, 16);
      return new Uint8Array(Buffer.concat([dir, eocd]));
    };
    expect(() => checkXlsxInflation(bomb(["xl/worksheets/sheet1.xml"], 2_000_000_000))).toThrow(/would expand/);
    expect(() => checkXlsxInflation(bomb(Array.from({ length: 300 }, (_, i) => `p${i}`), 10))).toThrow(/too many parts/);
    expect(() => checkXlsxInflation(bomb(["xl/worksheets/sheet1.xml", "[Content_Types].xml"], 5_000_000))).not.toThrow();
  });
});
