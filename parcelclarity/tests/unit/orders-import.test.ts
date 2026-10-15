import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTables } from "@/lib/import/parse-table";
import type { ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";
import { isCancelledCell, parseDeclaredValue, parseOrderDate, parseUnits, parseWeightCell, parseZip, weightToLb } from "@/lib/orders/cells";
import { detectOrderFile } from "@/lib/orders/mapping";
import { orderMappingSchema } from "@/lib/orders/mapping-schema";
import { buildMaterialisePayloads } from "@/lib/orders/materialise";
import type { OrderMapping, ParsedOrder } from "@/lib/orders/types";
import { applyOrderMapping } from "@/lib/orders/validate";

/**
 * Expectations here were derived by reading the fixture files, not by running the code: every
 * count distinguishes rows, orders, shipments, packages and lines (spec §9).
 */

const catalog: ServiceCatalogEntry[] = [
  { id: "svc-ups-ground", carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" },
  { id: "svc-ups-2da", carrierCode: "ups", carrierName: "UPS", code: "second_day_air", name: "UPS 2nd Day Air" },
  { id: "svc-fedex-ground", carrierCode: "fedex", carrierName: "FedEx", code: "ground", name: "FedEx Ground" },
  { id: "svc-usps-ga", carrierCode: "usps", carrierName: "USPS", code: "ground_advantage", name: "USPS Ground Advantage" },
];

const fixture = (name: string) => readFileSync(path.resolve(__dirname, "../fixtures/modeling", name));
const order = (orders: ParsedOrder[], id: string) => orders.find((o) => o.externalOrderId === id)!;

describe("cell parsers", () => {
  it("read dates as written and never shift them to UTC", () => {
    expect(parseOrderDate("2026-05-01 23:30:00 -0700", "iso")).toBe("2026-05-01");
    expect(parseOrderDate("2026-03-31T23:30:00Z", "mdy")).toBe("2026-03-31");
    expect(parseOrderDate("3/4/2026", "mdy")).toBe("2026-03-04");
    expect(parseOrderDate("3/4/2026", "dmy")).toBe("2026-04-03");
    expect(parseOrderDate("31/12/26", "dmy")).toBe("2026-12-31");
    expect(parseOrderDate("13/13/2026", "mdy")).toBe("invalid");
    expect(parseOrderDate("not a date", "iso")).toBe("invalid");
    expect(parseOrderDate("", "iso")).toBeNull();
  });

  it("clean ZIPs the way spreadsheets mangle them and pad only when told to", () => {
    expect(parseZip("'85001", false)).toEqual({ status: "ok", zip: "85001" });
    expect(parseZip("=\"10001\"", false)).toEqual({ status: "ok", zip: "10001" });
    expect(parseZip("85001-1234", false)).toEqual({ status: "ok", zip: "85001" });
    expect(parseZip("2134", false)).toEqual({ status: "short", digits: "2134" });
    expect(parseZip("2134", true)).toEqual({ status: "ok", zip: "02134" });
    expect(parseZip("SW1A 1AA", false)).toEqual({ status: "invalid" });
  });

  it("converts metric weights to pounds at six decimals and keeps lb/oz exact", () => {
    expect(weightToLb("1", "lb").toString()).toBe("1");
    expect(weightToLb("8", "oz").toString()).toBe("0.5");
    expect(weightToLb("1000", "g").toString()).toBe("2.204623");
    expect(weightToLb("2.5", "kg").toString()).toBe("5.511557");
  });
});

describe("generic one-row-per-package file", () => {
  it("detects columns, grouping and services, and validates every order with exact counts", async () => {
    const tables = await parseTables(fixture("orders-generic.csv"), "csv");
    const detection = detectOrderFile(tables, catalog);
    expect(detection.format).toBe("generic");
    expect(detection.dateFormatAmbiguous).toBe(false);
    const mapping = detection.suggestion!;
    expect(mapping.columns).toMatchObject({ orderId: 0, shipmentId: 1, orderDate: 2, originZip: 3, destinationZip: 4, residential: 5, service: 6, packageId: 7, weight: 8, weightUnit: 9, length: 10, width: 11, height: 12, sku: 13, units: 14, packaging: 15 });
    expect(mapping.grouping).toEqual({ shipments: "by_shipment_id", packages: "by_package_columns" });
    expect(mapping.dateFormat).toBe("iso");
    expect(mapping.serviceMap).toEqual({ "ups ground": "svc-ups-ground", "ups 2nd day air": "svc-ups-2da", "usps ground advantage": "svc-usps-ga", "pony express": null });
    expect(detection.serviceStrings.map((s) => [s.text, s.rows])).toEqual([["UPS Ground", 24], ["USPS Ground Advantage", 2], ["Pony Express", 1], ["UPS 2nd Day Air", 1]]);

    const { orders, report } = applyOrderMapping(tables, mapping);
    expect(report.ok).toBe(true);
    // 28 rows; 24 orders; A-1016 has two shipments; A-1006 ships two packages; every row carries a line.
    expect(report.counts).toEqual({ rows: 28, orders: 24, shipments: 25, packages: 26, lines: 28, units: 33 });
    expect(report.dateRange).toEqual({ from: "2026-03-02", to: "2026-04-01" });

    expect(order(orders, "A-1006").shipments[0]!.packages.map((p) => [p.seq, p.weight, p.weightUnit, p.length])).toEqual([[1, "12", "lb", "20"], [2, "9", "lb", "18"]]);
    expect(order(orders, "A-1016").shipments.map((s) => s.externalShipmentId)).toEqual(["S-1016", "S-1017"]);
    // Two line rows repeating package 1 collapse into one package; both lines are kept.
    const a1017 = order(orders, "A-1017");
    expect(a1017.shipments[0]!.packages).toHaveLength(1);
    expect(a1017.lines.map((l) => [l.sku, l.units])).toEqual([["SKU-RED", 1], ["SKU-BLUE", 2]]);
    expect(a1017.shipments[0]!.issues).toContain("rows_collapsed_to_package");
    expect(order(orders, "A-1009").shipments[0]!.packages[0]).toMatchObject({ weight: "12", weightUnit: "oz" });
    expect(order(orders, "A-1011").shipments[0]!.packages[0]).toMatchObject({ weight: "5", length: null, width: null, height: null });
    expect(order(orders, "A-1001")).toMatchObject({ orderDate: "2026-03-02", destinationZip: "85001", originZip: "90001", residential: true, units: 2, cancelled: false });

    // Problems are reported on the order or shipment, never guessed around.
    expect(order(orders, "A-1012").shipments[0]!.issues).toContain("weight_missing");
    expect(order(orders, "A-1013").issues).toContain("destination_missing");
    expect(order(orders, "A-1014").shipments[0]!.issues).toContain("service_unmapped");
    expect(order(orders, "A-1020").shipments[0]!.issues).toContain("weight_exceeds_parcel");
    expect(order(orders, "A-1021").shipments[0]!.issues).toContain("package_inconsistent");
    expect(order(orders, "A-1024").issues).toEqual(expect.arrayContaining(["date_invalid", "date_missing"]));
    expect(order(orders, "A-1015").destinationZip).toBe("00401");
    // Blocking: A-1012 (weight), A-1013 (destination), A-1014 (service), A-1021 (package) → 20 of 24 modelable.
    expect(report.modelableOrders).toBe(20);
    expect(report.weights).toMatchObject({ count: 25, over150Lb: 1 });
    expect(report.issuesByCode.find((i) => i.code === "service_unmapped")).toMatchObject({ orders: 1, rows: 1, severity: "error" });
  });

  it("assigns dense dataset-wide row numbers with each order's shipments contiguous, ordered by first ship date", async () => {
    const tables = await parseTables(fixture("orders-generic.csv"), "csv");
    const mapping = detectOrderFile(tables, catalog).suggestion!;
    const { orders } = applyOrderMapping(tables, mapping);
    const payloads = buildMaterialisePayloads(orders, 10);
    expect(payloads).toHaveLength(3); // 24 orders in chunks of 10
    const shipments = payloads.flatMap((p) => p.shipments);
    expect(shipments.map((s) => s.row_no)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    // The undated order sorts last; A-1023 (April) just before it; the first rows are the March 2 orders by id.
    expect(shipments.slice(0, 2).map((s) => s.external_order_id)).toEqual(["A-1001", "A-1002"]);
    expect(shipments.slice(-2).map((s) => s.external_order_id)).toEqual(["A-1023", "A-1024"]);
    const a1016 = shipments.filter((s) => s.external_order_id === "A-1016").map((s) => s.row_no);
    expect(a1016[1]! - a1016[0]!).toBe(1);
    expect(payloads[0]!.packages.filter((p) => p.external_order_id === "A-1006").map((p) => [p.shipment_seq, p.seq])).toEqual([[1, 1], [1, 2]]);
    expect(payloads[0]!.orders.find((o) => o.external_order_id === "A-1001")).toMatchObject({ line_count: 1, units: 2, cancelled: false });
  });
});

describe("Shopify order export (one row per line item, no weights)", () => {
  it("groups continuation rows into orders and can only be priced from product weights", async () => {
    const tables = await parseTables(fixture("orders-shopify.csv"), "csv");
    const detection = detectOrderFile(tables, catalog);
    expect(detection.format).toBe("shopify");
    const suggestion = detection.suggestion!;
    expect(suggestion.columns).toMatchObject({ orderId: 0, orderDate: 11, units: 12, sku: 15, requiresShipping: 16, destinationZip: 20, country: 22, service: 10, shipDate: 5, weight: null, shipmentId: null });
    expect(suggestion.grouping).toEqual({ shipments: "one_per_order", packages: "one_per_shipment" });
    expect(suggestion.useSkuProfiles).toBe(true);
    expect(detection.notes.join(" ")).toContain("product weights");
    // Shopify method names do not match carrier services on their own; the customer maps them.
    expect(suggestion.serviceMap).toEqual({ "standard shipping": null, "express shipping": null });

    const mapping: OrderMapping = { ...suggestion, serviceMap: { "standard shipping": "svc-ups-ground", "express shipping": "svc-ups-2da" } };
    const withoutWeights = applyOrderMapping(tables, mapping);
    expect(withoutWeights.report.counts).toEqual({ rows: 7, orders: 6, shipments: 5, packages: 5, lines: 7, units: 9 });
    expect(order(withoutWeights.orders, "#2001").shipments[0]!.issues).toContain("sku_unknown");
    expect(withoutWeights.report.modelableOrders).toBe(0);

    const profiles = [
      { sku: "SKU-RED", unitWeightLb: "0.75", lengthIn: "8", widthIn: "6", heightIn: "4" },
      { sku: "sku-blue", unitWeightLb: "0.5", lengthIn: null, widthIn: null, heightIn: null },
      { sku: "SKU-GREEN", unitWeightLb: "1.25", lengthIn: null, widthIn: null, heightIn: null },
    ];
    const { orders, report } = applyOrderMapping(tables, mapping, { skuProfiles: profiles });
    // #2001: 2 × 0.75 + 1 × 0.5 = 2 lb, derived, no dimensions (several lines).
    expect(order(orders, "#2001").shipments[0]!.packages[0]).toMatchObject({ weight: "2", weightUnit: "lb", weightDerived: true, dimensionsDerived: false, length: null });
    expect(order(orders, "#2001")).toMatchObject({ orderDate: "2026-05-01", destinationZip: "85001", units: 3, lines: [{ lineNo: 1, sku: "SKU-RED", units: 2 }, { lineNo: 2, sku: "SKU-BLUE", units: 1 }] });
    // #2002: one unit of one SKU with dimensions on file → weight and dimensions derived.
    expect(order(orders, "#2002").shipments[0]!.packages[0]).toMatchObject({ weight: "0.75", weightDerived: true, length: "8", width: "6", height: "4", dimensionsDerived: true });
    expect(order(orders, "#2003").shipments[0]!).toMatchObject({ serviceId: "svc-ups-2da", shipDate: "2026-05-03" });
    expect(order(orders, "#2004").shipments[0]!.shipDate).toBeNull(); // unfulfilled: no ship date, the order date will be used
    // #2005 only sells a gift card: nothing ships, nothing is priced.
    expect(order(orders, "#2005")).toMatchObject({ shipments: [], issues: expect.arrayContaining(["nothing_to_ship"]) });
    expect(order(orders, "#2006").issues).toContain("destination_missing");
    expect(report.counts).toEqual({ rows: 7, orders: 6, shipments: 5, packages: 5, lines: 7, units: 9 });
    expect(report.modelableOrders).toBe(4);
    expect(report.issuesByCode.find((i) => i.code === "weight_derived")).toMatchObject({ orders: 5 }); // #2001–#2004 and #2006 (its destination is missing, but its weight still derives)

    // The mapping the server stores is the mapping the wizard approved: "requires shipping" is kept, so the gift-card order still ships nothing.
    const stored = { ...orderMappingSchema.parse({ ...mapping, serviceMap: {} }), serviceMap: mapping.serviceMap };
    expect(stored).toEqual(mapping);
    const reapplied = applyOrderMapping(tables, stored, { skuProfiles: profiles });
    expect(order(reapplied.orders, "#2005").shipments).toEqual([]);
    expect(reapplied.report.counts).toEqual(report.counts);
  });
});

describe("edge cases in the generic layout", () => {
  const csv = (text: string) => parseTables(Buffer.from(text), "csv");
  const mapFor = async (text: string, tweak: (m: OrderMapping) => OrderMapping = (m) => m) => {
    const tables = await csv(text);
    const mapping = tweak(detectOrderFile(tables, catalog).suggestion!);
    return { tables, mapping };
  };

  it("reads the template's layout: items listed under a package on their own rows are not a second, weightless package", async () => {
    const { tables, mapping } = await mapFor(
      [
        "order_id,shipment_id,order_date,origin_zip,destination_zip,residential,service,package_seq,weight,weight_unit,length,width,height,sku,units,packaging",
        "T-1,S-1,2026-01-15,90001,85001,yes,UPS Ground,1,3.5,lb,10,8,6,SKU-A,2,box",
        "T-1,S-1,,,,,,,,,,,,SKU-B,1,",
        "",
      ].join("\n"),
    );
    const { orders, report } = applyOrderMapping(tables, mapping);
    expect(report.counts).toEqual({ rows: 2, orders: 1, shipments: 1, packages: 1, lines: 2, units: 3 });
    expect(order(orders, "T-1").shipments[0]!.packages).toHaveLength(1);
    expect(order(orders, "T-1").shipments[0]!.packages[0]).toMatchObject({ weight: "3.5", length: "10" });
    expect(order(orders, "T-1").shipments[0]!.issues).not.toContain("weight_missing");
    expect(report.modelableOrders).toBe(1);
  });

  it("without line columns, two identical package rows are two packages", async () => {
    const { tables, mapping } = await mapFor(["order_id,order_date,destination_zip,service,weight", "P-1,2026-01-15,85001,UPS Ground,2", "P-1,2026-01-15,85001,UPS Ground,2", ""].join("\n"));
    const { orders, report } = applyOrderMapping(tables, mapping);
    expect(order(orders, "P-1").shipments[0]!.packages.map((p) => p.weight)).toEqual(["2", "2"]);
    expect(report.issuesByCode.map((i) => i.code)).not.toContain("rows_collapsed_to_package");
  });

  it("a row without a shipment id continues the shipment above it, with a note", async () => {
    const { tables, mapping } = await mapFor(["order_id,shipment_id,order_date,destination_zip,service,weight,sku,units", "D-1,S1,2026-01-15,85001,UPS Ground,2,SKU-A,1", "D-1,,2026-01-15,85001,UPS Ground,,SKU-B,1", ""].join("\n"));
    const { orders, report } = applyOrderMapping(tables, mapping);
    expect(order(orders, "D-1").shipments).toHaveLength(1);
    expect(order(orders, "D-1").shipments[0]!.packages).toHaveLength(1);
    expect(report.issuesByCode.find((i) => i.code === "shipment_id_missing")).toMatchObject({ severity: "warning", orders: 1, rows: 2 });
  });

  it("refuses to derive a weight from product weights when a line quantity could not be read", async () => {
    const { tables, mapping } = await mapFor(["order_id,order_date,destination_zip,service,sku,units", "U-1,2026-01-15,85001,UPS Ground,SKU-A,1", "U-1,2026-01-15,85001,UPS Ground,SKU-B,two", ""].join("\n"), (m) => ({ ...m, useSkuProfiles: true }));
    const profiles = [
      { sku: "SKU-A", unitWeightLb: "1", lengthIn: null, widthIn: null, heightIn: null },
      { sku: "SKU-B", unitWeightLb: "2", lengthIn: null, widthIn: null, heightIn: null },
    ];
    const { orders, report } = applyOrderMapping(tables, mapping, { skuProfiles: profiles });
    expect(order(orders, "U-1").shipments[0]!.packages[0]!.weight).toBeNull();
    expect(order(orders, "U-1").shipments[0]!.issues).toContain("weight_missing");
    expect(report.modelableOrders).toBe(0);
  });

  it("refuses values the database cannot store instead of truncating them", async () => {
    const longId = "X".repeat(121);
    const { tables, mapping } = await mapFor(["order_id,order_date,destination_zip,service,weight", `${longId},2026-01-15,85001,UPS Ground,2`, "R-2,2026-01-15,85001,UPS Ground,1000000", ""].join("\n"));
    const { orders, report } = applyOrderMapping(tables, mapping);
    expect(order(orders, longId).issues).toContain("value_out_of_range");
    expect(order(orders, "R-2").shipments[0]!.issues).toContain("value_out_of_range");
    expect(report.modelableOrders).toBe(0);
  });

  it("records an issue's severity before the detail cap, so a blocking issue first seen late still reads as blocking", async () => {
    const rows = ["order_id,order_date,destination_zip,service,weight"];
    for (let i = 0; i < 520; i++) rows.push(`O-${i},2026-01-15,85001,UPS Ground,1`);
    rows.push("BAD-1,2026-01-15,ABCDE,UPS Ground,1", "");
    const { tables, mapping } = await mapFor(rows.join("\n"));
    const { report } = applyOrderMapping(tables, mapping);
    expect(report.issuesTruncated).toBe(true);
    expect(report.issuesByCode.find((i) => i.code === "destination_invalid")).toMatchObject({ severity: "error", orders: 1 });
  });
});

describe("cell parsers: commas and flags", () => {
  it("reads thousands separators and refuses decimal commas rather than misreading them tenfold", () => {
    expect(parseWeightCell("1,250 g")).toEqual({ value: "1250", unit: "g" });
    expect(parseWeightCell("2,5")).toBe("invalid");
    expect(parseUnits("1,000")).toBe(1000);
    expect(parseUnits("2,5")).toBe("invalid");
    expect(parseUnits("3000000000")).toBe("invalid");
    expect(parseDeclaredValue("$1,250.50")).toBe("1250.50");
    expect(parseDeclaredValue("12,50")).toBe("invalid");
  });

  it("treats 1 as a cancelled flag like yes and true", () => {
    expect(isCancelledCell("1")).toBe(true);
    expect(isCancelledCell("0")).toBe(false);
  });
});

describe("ShipHero-style shipment export (one row per shipment)", () => {
  it("reads shipments, carrier-qualified services, residential flags and package counts", async () => {
    const tables = await parseTables(fixture("orders-shiphero.csv"), "csv");
    const detection = detectOrderFile(tables, catalog);
    expect(detection.format).toBe("shiphero");
    expect(detection.weightUnitFromHeader).toBe("lb");
    const mapping = detection.suggestion!;
    expect(mapping.columns).toMatchObject({ orderId: 0, shipmentId: 1, shipDate: 2, originZip: 3, destinationZip: 4, residential: 5, carrier: 6, service: 7, packageId: 8, weight: 9, length: 10, width: 11, height: 12, packageCount: 13, units: 15 });
    expect(mapping.grouping).toEqual({ shipments: "by_shipment_id", packages: "by_package_columns" });
    expect(mapping.serviceMap).toEqual({ "ups ground": "svc-ups-ground", "usps ground advantage": "svc-usps-ga", "ups 2nd day air": "svc-ups-2da" });

    const { orders, report } = applyOrderMapping(tables, mapping);
    expect(report.counts).toEqual({ rows: 6, orders: 5, shipments: 6, packages: 6, lines: 6, units: 12 });
    expect(order(orders, "SH-3002").shipments.map((s) => [s.externalShipmentId, s.shipDate, s.packages[0]!.weight])).toEqual([["SHP-3002", "2026-06-01", "12.0"], ["SHP-3003", "2026-06-02", "9.0"]]);
    expect(order(orders, "SH-3001")).toMatchObject({ residential: true, originZip: "90001", destinationZip: "85001" });
    expect(order(orders, "SH-3003").shipments[0]!).toMatchObject({ serviceId: "svc-usps-ga", residential: true });
    expect(order(orders, "SH-3005").shipments[0]!.issues).toContain("package_count_mismatch");
    expect(report.modelableOrders).toBe(5);
    // Weights 0.75, 2, 3, 9, 12, 40: the median of an even count is the mean of the two middle values.
    expect(report.weights).toEqual({ count: 6, medianLb: "6", p90Lb: "40", over150Lb: 0 });
    // The approved mapping survives the schema the server applies to it, columns the wizard offers included (service ids are UUIDs in the app; the test catalog's are not).
    expect(orderMappingSchema.parse({ ...mapping, serviceMap: {} })).toEqual({ ...mapping, serviceMap: {} });
    expect(report.derivation.shipments).toContain("shipment id");
  });
});
