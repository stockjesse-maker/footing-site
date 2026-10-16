import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { detectAdjustmentFile } from "@/lib/adjustments/mapping";
import { parseAdjustmentFile } from "@/lib/adjustments/parse";
import { buildAppendChunks } from "@/lib/adjustments/payload";
import type { AdjustmentContext } from "@/lib/adjustments/types";
import { applyAdjustmentMapping } from "@/lib/adjustments/validate";

/**
 * The same history importer over a real .xlsx workbook: several sheets, a title row above the header, numeric amount cells,
 * and a carrier-cost header on a later sheet. The workbook is built here from a few XML parts and a small zip writer (the
 * repository has no workbook writer, and the shared reader needs a genuine archive).
 */

type Cell = string | number;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colName = (i: number) => String.fromCharCode(65 + i);

function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (typeof v === "number" ? `<c r="${colName(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join("")}</row>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function zip(files: [string, string][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0, 12); entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBuf.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function workbook(sheets: { name: string; rows: Cell[][] }[]): Buffer {
  const n = sheets.length;
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]),
  ]);
}

const catalog = [{ id: "00000000-0000-4000-8000-0000000000a1", carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" }];
const brands = [{ id: "00000000-0000-4000-8000-0000000000b1", name: "Alpha Apparel" }];
const ctx: AdjustmentContext = { catalog, brands, today: "2026-10-16" };
const xlsx = { filename: "history.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

const HEADER = ["ship_date", "carrier", "service", "brand", "adjustment_type", "cause", "package_ref", "declared_weight", "actual_weight", "weight_unit", "customer_charge_original", "customer_charge_corrected", "customer_adjustment_fee"];

describe("history import over a workbook", () => {
  it("reads a sheet of text and numeric cells through the shared parser and validates it like a CSV", async () => {
    const book = workbook([
      { name: "History", rows: [HEADER, ["2026-08-03", "UPS", "UPS Ground", "Alpha Apparel", "reweight", "carrier_reweigh", "X1", 4, 6, "lb", 13.35, 14.91, 3], ["2026-08-04", "UPS", "UPS Ground", "Alpha Apparel", "reweight", "carrier_reweigh", "X2", 5, "7", "lb", 15.05, 16.610000000000003, ""]] },
    ]);
    const parsed = await parseAdjustmentFile(book, xlsx);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.kind).toBe("xlsx");
    const d = detectAdjustmentFile(parsed.tables, ctx);
    expect(d.suggestion.columns).toMatchObject({ shipDate: 0, carrier: 1, service: 2, brand: 3, adjustmentType: 4, packageRef: 6, originalCharge: 10, correctedCharge: 11, adjustmentFee: 12 });
    const result = applyAdjustmentMapping(parsed.tables, d.suggestion, ctx);
    expect(result.report.committable).toBe(true);
    expect(result.records.map((r) => [r.packageRef, r.declaredWeightLb, r.actualWeightLb, r.originalCharge, r.correctedCharge, r.separateFee])).toEqual([
      ["X1", "4", "6", "13.35", "14.91", "3.00"],
      // Floating-point noise from a spreadsheet formula is cents again; a blank fee stays unknown.
      ["X2", "5", "7", "15.05", "16.61", null],
    ]);
    expect(buildAppendChunks(result).chunks[0]!.rows).toHaveLength(2);
  });

  it("skips a title block above the header and numbers rows from the header", async () => {
    const book = workbook([{ name: "History", rows: [["Adjustment history, August", "", ""], ["Prepared by the warehouse", "", ""], HEADER, ["2026-08-03", "UPS", "", "", "reweight", "", "T1", 4, 6, "lb", "", "", ""], ["not a date", "UPS", "", "", "reweight", "", "T2", 4, 6, "lb", "", "", ""]] }]);
    const parsed = await parseAdjustmentFile(book, xlsx);
    if (parsed.status !== "ok") throw new Error(parsed.status);
    const d = detectAdjustmentFile(parsed.tables, ctx);
    expect(d.sheets[0]).toMatchObject({ headerRow: 2, rowCount: 2 });
    const { report } = applyAdjustmentMapping(parsed.tables, d.suggestion, ctx);
    expect(report.byCode.invalid_date).toBe(1);
    expect(report.rowNumbers.invalid_date).toEqual([2]);
    expect(report.byCode.no_amounts).toBe(1);
  });

  it("refuses the whole workbook when a later sheet has a carrier-cost header, naming the header and the sheet and storing nothing", async () => {
    const book = workbook([
      { name: "History", rows: [HEADER, ["2026-08-03", "UPS", "UPS Ground", "", "reweight", "", "X1", 4, 6, "lb", 13.35, 14.91, 3]] },
      { name: "Carrier invoice", rows: [["ship_date", "package_ref", "Negotiated Rate", "Postage Cost"], ["2026-08-03", "X1", 71.18, 66.66]] },
    ]);
    const parsed = await parseAdjustmentFile(book, xlsx);
    expect(parsed.status).toBe("refused");
    if (parsed.status !== "refused") return;
    expect(parsed.guard).toMatchObject({ sheet: "Carrier invoice", firstRefusedHeader: "Negotiated Rate", refusedHeaders: ["Negotiated Rate", "Postage Cost"] });
    expect(parsed.message).toContain("Nothing from this file was saved");
    expect(parsed.message).not.toContain("71.18");
    expect(parsed.message).not.toContain("66.66");
    expect("tables" in parsed).toBe(false);
  });

  it("reports a file that is not a workbook, and a workbook whose only sheet is empty", async () => {
    expect(await parseAdjustmentFile(Buffer.from("not a zip"), xlsx)).toMatchObject({ status: "error", code: "unreadable" });
    const empty = workbook([{ name: "History", rows: [] }]);
    expect(await parseAdjustmentFile(empty, xlsx)).toMatchObject({ status: "error", code: "empty" });
  });
});
