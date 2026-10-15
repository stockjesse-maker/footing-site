import { describe, expect, it } from "vitest";
import { calculateShipment } from "@/engine";
import {
  centsToMoney,
  createDictionary,
  decodeLines,
  emptyPartial,
  encodeResult,
  finalizeSummary,
  foldBatch,
  moneyToCents,
  weightBracket,
  WEIGHT_BRACKET_EDGES,
  WEIGHT_BRACKET_LABELS,
  type CompactLine,
  type CompactLineClass,
  type CompactLineStatus,
  type CompactResult,
  type FoldOrder,
  type FoldShipment,
  type LineDictionaryEntry,
  type PartialSummary,
} from "@/engine/modeling";
import type { SurchargeCategory } from "@/engine/types";
import { fixtureContext } from "../fixtures/pricing/load";

// ---------------------------------------------------------------------------
// Hand-built inputs. The dictionary is the run's live array: rule entries are appended once and
// every compact line refers to them by index.
// ---------------------------------------------------------------------------

const dictionary = createDictionary();
function addRule(key: string, version: number, name: string, category: SurchargeCategory, scope: "carrier" | "3pl"): number {
  const entry: LineDictionaryEntry = { kind: "rule", key, version, versionId: null, name, category, scope };
  dictionary.push(entry);
  return dictionary.length - 1;
}
const BASE = 0;
const FUEL = addRule("ups.fuel", 3, "Fuel surcharge", "fuel", "carrier");
const RES = addRule("ups.residential", 2, "Residential surcharge", "residential", "carrier");
const DAS = addRule("ups.das", 1, "Delivery area surcharge", "das", "carrier");
const ADDR = addRule("ups.address_correction", 1, "Address correction (if needed)", "address_correction", "carrier");
const HANDLING = addRule("acme.handling", 1, "Special handling", "additional_handling", "3pl");

function line(index: number, cents: number, status: CompactLineStatus = "c", cls: CompactLineClass = "d", packageIndex: number | null = 0): CompactLine {
  return [index, cents, status, cls, packageIndex];
}

/** An ok result whose totals are derived from its lines the way the engine derives them. */
function okResult(opts: { zone?: string; billableLb: string[]; lines: CompactLine[]; warningCodes?: string[]; serviceId?: string | null }): CompactResult {
  const cents = (pred: (l: CompactLine) => boolean) => opts.lines.filter(pred).reduce((s, l) => s + l[1], 0);
  const definite = cents((l) => l[2] === "c" && l[3] === "d");
  const estimated = cents((l) => l[2] === "c" && l[3] === "e");
  return {
    status: "ok",
    unavailableReason: null,
    rateCardVersionId: "rcv-1",
    shipDate: "2026-03-15",
    zone: opts.zone ?? "5",
    serviceId: opts.serviceId === undefined ? "svc-ups-ground" : opts.serviceId,
    billableLb: opts.billableLb,
    definite: centsToMoney(definite),
    estimated: centsToMoney(estimated),
    expected: centsToMoney(definite + estimated),
    conditionalExposure: centsToMoney(cents((l) => l[2] === "n")),
    unresolved: centsToMoney(cents((l) => l[2] === "u")),
    lines: opts.lines,
    warningCodes: opts.warningCodes ?? [],
  };
}

function unavailableResult(reason: CompactResult["unavailableReason"]): CompactResult {
  return {
    status: "unavailable",
    unavailableReason: reason,
    rateCardVersionId: "rcv-1",
    shipDate: "2026-03-15",
    zone: null,
    serviceId: "svc-ups-ground",
    billableLb: [],
    definite: "0.00",
    estimated: "0.00",
    expected: "0.00",
    conditionalExposure: "0.00",
    unresolved: "0.00",
    lines: [],
    warningCodes: [],
  };
}

function ship(rowNo: number, result: CompactResult | null, overrides: Partial<FoldShipment> = {}): FoldShipment {
  return {
    rowNo,
    packageCount: result?.status === "ok" ? result.billableLb.length : 1,
    serviceId: "svc-ups-ground",
    serviceName: "UPS Ground",
    carrierCode: "ups",
    excludedReason: null,
    result,
    assumed: { residential: false, originZip: false, weight: false, dimensions: false },
    packagesWithoutDimensions: 0,
    ...overrides,
  };
}

function order(orderKey: string, shipments: FoldShipment[], opts: { orderDate?: string | null; cancelled?: boolean } = {}): FoldOrder {
  return { orderKey, orderDate: opts.orderDate === undefined ? "2026-03-14" : opts.orderDate, cancelled: opts.cancelled ?? false, shipments };
}

// A: modeled, two shipments in different zones; the second priced on an assumed weight (estimated).
const A = order("A", [
  ship(1, okResult({ zone: "5", billableLb: ["1"], lines: [line(BASE, 1000), line(RES, 500), line(FUEL, 150)] })),
  ship(2, okResult({ zone: "10", billableLb: ["4.5"], lines: [line(BASE, 1200, "c", "e"), line(FUEL, 180, "c", "e")], warningCodes: ["assumed_inputs"] }), { assumed: { residential: false, originZip: false, weight: true, dimensions: false } }),
]);
// B: modeled, one three-package shipment across brackets, a shipment-level fuel line, a 3PL handling rule, an unknown DAS and a conditional address correction.
const B = order(
  "B",
  [
    ship(
      3,
      okResult({
        zone: "5",
        serviceId: "svc-ups-2da",
        billableLb: ["0.5", "2", "160"],
        lines: [line(BASE, 500, "c", "d", 0), line(BASE, 800, "c", "d", 1), line(BASE, 5000, "c", "d", 2), line(RES, 400, "c", "d", 0), line(HANDLING, 2500, "c", "d", 2), line(DAS, 350, "u", "e", 1), line(FUEL, 300, "c", "d", null), line(ADDR, 2100, "n", "c", null)],
        warningCodes: ["zip_list_missing:ups.das"],
      }),
      { serviceId: "svc-ups-2da", serviceName: "UPS 2nd Day Air" },
    ),
  ],
  { orderDate: "2026-04-02" },
);
// C: not modeled, one shipment priced ok and one unavailable.
const C = order("C", [ship(4, okResult({ zone: "8", billableLb: ["3"], lines: [line(BASE, 2000)] })), ship(5, unavailableResult("no_rate_for_weight"))]);
// D: cancelled; its shipment was never sent to the engine.
const D = order("D", [ship(6, null, { excludedReason: "order_cancelled" })], { cancelled: true });
// E: not modeled, excluded before pricing.
const E = order("E", [ship(7, null, { excludedReason: "weight_missing", packageCount: 2 })]);
// F: modeled on assumed residential status and origin, one package without dimensions, no order date.
const F = order(
  "F",
  [
    ship(8, okResult({ zone: "5", billableLb: ["12"], lines: [line(BASE, 1500, "c", "e"), line(DAS, 450, "u", "e")], warningCodes: ["dimensions_missing", "assumed_inputs"] }), {
      assumed: { residential: true, originZip: true, weight: false, dimensions: false },
      packagesWithoutDimensions: 1,
    }),
  ],
  { orderDate: null },
);
const ALL = [A, B, C, D, E, F];

function start(): PartialSummary {
  return { ...emptyPartial(), dictionary };
}

describe("foldBatch: the modeled-order rule", () => {
  it("excludes an order whose shipment priced unavailable and reports its ok shipment as priced but excluded", () => {
    const p = foldBatch(start(), [C]);
    expect(p.orders).toEqual({ seen: 1, modeled: 0, cancelled: 0 });
    expect(p.shipments).toEqual({ seen: 2, ok: 1, unavailable: 1, excludedBeforePricing: 0, modeled: 0 });
    expect(p.packages).toEqual({ seen: 2, modeled: 0 });
    expect(p.exclusions).toEqual({ no_rate_for_weight: { orders: 1, shipments: 1 } });
    expect(p.pricedButExcluded).toEqual({ shipments: 1, expected: "20.00" });
    expect(p.totals).toEqual({ definite: "0.00", estimated: "0.00", expected: "0.00", conditionalExposure: "0.00", unresolved: "0.00" });
    expect(p.byZone).toEqual({});
    expect(p.bySurcharge).toEqual({});
  });

  it("counts cancelled orders under order_cancelled and in orders.cancelled", () => {
    const p = foldBatch(start(), [D]);
    expect(p.orders).toEqual({ seen: 1, modeled: 0, cancelled: 1 });
    expect(p.shipments).toEqual({ seen: 1, ok: 0, unavailable: 0, excludedBeforePricing: 1, modeled: 0 });
    expect(p.exclusions).toEqual({ order_cancelled: { orders: 1, shipments: 1 } });
    expect(p.pricedButExcluded).toEqual({ shipments: 0, expected: "0.00" });
  });

  it("lists a cancelled order's shipments under the cancellation even when one of them was priced", () => {
    const priced = order("X", [ship(9, okResult({ billableLb: ["1"], lines: [line(BASE, 700)] })), ship(10, null, { excludedReason: "order_cancelled" })], { cancelled: true });
    const p = foldBatch(start(), [priced]);
    expect(p.exclusions).toEqual({ order_cancelled: { orders: 1, shipments: 2 } });
    expect(p.pricedButExcluded).toEqual({ shipments: 1, expected: "7.00" });
    expect(p.orders.modeled).toBe(0);
  });

  it("excludes a shipment that was never priced under its own reason", () => {
    const p = foldBatch(start(), [E]);
    expect(p.exclusions).toEqual({ weight_missing: { orders: 1, shipments: 1 } });
    expect(p.packages.seen).toBe(2);
  });

  it("refuses inconsistent shipments instead of guessing", () => {
    expect(() => foldBatch(start(), [order("bad", [ship(1, null)])])).toThrow(/neither priced nor excluded/);
    expect(() => foldBatch(start(), [order("bad", [ship(1, okResult({ billableLb: ["1"], lines: [] }), { excludedReason: "weight_missing" })])])).toThrow(/carries a result/);
    expect(() => foldBatch(start(), [order("bad", [ship(1, okResult({ billableLb: ["1"], lines: [] }), { packageCount: 2 })])])).toThrow(/billable weight/);
    expect(() => foldBatch(start(), [order("bad", [ship(1, okResult({ billableLb: ["1"], lines: [line(BASE, 100, "c", "d", 3)] }))])])).toThrow(/package 4/);
    expect(() => foldBatch(start(), [order("bad", [ship(1, okResult({ billableLb: ["1"], lines: [line(99, 100)] }))])])).toThrow(/dictionary entry 99/);
    expect(() => foldBatch(start(), [order("empty", [])])).toThrow(/no shipments/);
  });
});

describe("foldBatch: breakdowns over modeled orders", () => {
  it("buckets per-package lines by billable weight and shipment-level lines on their own row", () => {
    const p = foldBatch(start(), [B]);
    expect(p.packages).toEqual({ seen: 3, modeled: 3 });
    expect(p.byWeightBracket).toEqual({
      "≤1 lb": { orders: 1, shipments: 1, packages: 1, definite: "9.00", estimated: "0.00", expected: "9.00" },
      "≤2 lb": { orders: 1, shipments: 1, packages: 1, definite: "8.00", estimated: "0.00", expected: "8.00" },
      ">150 lb": { orders: 1, shipments: 1, packages: 1, definite: "75.00", estimated: "0.00", expected: "75.00" },
    });
    expect(p.shipmentLevel).toEqual({ shipments: 1, definite: "3.00", estimated: "0.00", expected: "3.00" });
    expect(p.totals).toEqual({ definite: "95.00", estimated: "0.00", expected: "95.00", conditionalExposure: "21.00", unresolved: "3.50" });
  });

  it("counts included, waived, unknown and conditional lines without summing them into totals", () => {
    const s = order("S", [
      ship(1, okResult({ billableLb: ["3"], lines: [line(BASE, 1000), line(DAS, 350, "u", "e"), line(ADDR, 2100, "n", "c", null), line(RES, 500, "i", "d"), line(HANDLING, 250, "w", "d"), line(FUEL, 150, "c", "e")], warningCodes: ["zip_list_missing:ups.das"] })),
    ]);
    const p = foldBatch(start(), [s]);
    expect(p.totals).toEqual({ definite: "10.00", estimated: "1.50", expected: "11.50", conditionalExposure: "21.00", unresolved: "3.50" });
    expect(p.bySurcharge["ups.das"]).toMatchObject({ scope: "carrier", category: "das", versions: [1], charged: { definite: "0.00", estimated: "0.00", shipments: 0, packages: 0, lines: 0 }, unknown: { amount: "3.50", shipments: 1 } });
    expect(p.bySurcharge["ups.address_correction"]).toMatchObject({ conditional: { amount: "21.00", shipments: 1 }, charged: { shipments: 0 } });
    expect(p.bySurcharge["ups.residential"]).toMatchObject({ included: { shipments: 1 }, charged: { shipments: 0 } });
    expect(p.bySurcharge["acme.handling"]).toMatchObject({ scope: "3pl", waived: { shipments: 1 } });
    expect(p.bySurcharge["ups.fuel"]).toMatchObject({ charged: { definite: "0.00", estimated: "1.50", shipments: 1, packages: 1, lines: 1 } });
    expect(Object.keys(p.bySurcharge).sort()).toEqual(["acme.handling", "ups.address_correction", "ups.das", "ups.fuel", "ups.residential"]);
    expect(p.unresolvedBy).toEqual({ dimensions_missing: { shipments: 0, amount: "0.00" }, zip_list_missing: { shipments: 1, amount: "3.50" }, other: { shipments: 0, amount: "0.00" } });
    expect(p.exposureShipments).toEqual({ conditional: 1, unresolved: 1 });
    expect(p.warnings).toEqual({ "zip_list_missing:ups.das": { shipments: 1 } });
    // The conditional address correction is a shipment-level line: it puts the shipment in the row but adds nothing to it.
    expect(p.shipmentLevel).toEqual({ shipments: 1, definite: "0.00", estimated: "0.00", expected: "0.00" });
  });

  it("counts assumptions, packages without dimensions and unresolved amounts by what would resolve them", () => {
    const p = foldBatch(start(), [F]);
    expect(p.assumptions).toEqual({ residential: 1, originZip: 1, weight: 0, dimensions: 0, packagesWithoutDimensions: 1 });
    expect(p.unresolvedBy.dimensions_missing).toEqual({ shipments: 1, amount: "4.50" });
    expect(p.warnings).toEqual({ dimensions_missing: { shipments: 1 }, assumed_inputs: { shipments: 1 } });
    expect(p.byMonth).toEqual({ unknown: { orders: 1, shipments: 1, packages: 1, definite: "0.00", estimated: "15.00", expected: "15.00" } });
    const other = foldBatch(start(), [order("O", [ship(1, okResult({ billableLb: ["1"], lines: [line(BASE, 100), line(DAS, 200, "u", "e")] }))])]);
    expect(other.unresolvedBy.other).toEqual({ shipments: 1, amount: "2.00" });
  });

  it("counts an order once per zone, service and month however many shipments it has", () => {
    const p = foldBatch(start(), [A]);
    expect(p.byZone).toEqual({
      "5": { orders: 1, shipments: 1, packages: 1, definite: "16.50", estimated: "0.00", expected: "16.50" },
      "10": { orders: 1, shipments: 1, packages: 1, definite: "0.00", estimated: "13.80", expected: "13.80" },
    });
    expect(p.byService).toEqual({ "svc-ups-ground": { serviceId: "svc-ups-ground", name: "UPS Ground", carrierCode: "ups", orders: 1, shipments: 2, packages: 2, definite: "16.50", estimated: "13.80", expected: "30.30" } });
    expect(p.byMonth).toEqual({ "2026-03": { orders: 1, shipments: 2, packages: 2, definite: "16.50", estimated: "13.80", expected: "30.30" } });
    expect(p.assumptions.weight).toBe(1);
  });

  it("folds the whole set with totals that reconcile across every breakdown", () => {
    const p = foldBatch(start(), ALL);
    expect(p.orders).toEqual({ seen: 6, modeled: 3, cancelled: 1 });
    expect(p.shipments).toEqual({ seen: 8, ok: 5, unavailable: 1, excludedBeforePricing: 2, modeled: 4 });
    expect(p.packages).toEqual({ seen: 11, modeled: 6 });
    expect(p.totals).toEqual({ definite: "111.50", estimated: "28.80", expected: "140.30", conditionalExposure: "21.00", unresolved: "8.00" });
    expect(p.pricedButExcluded).toEqual({ shipments: 1, expected: "20.00" });
    expect(p.exclusions).toEqual({ no_rate_for_weight: { orders: 1, shipments: 1 }, order_cancelled: { orders: 1, shipments: 1 }, weight_missing: { orders: 1, shipments: 1 } });
    expect(p.byZone["5"]).toEqual({ orders: 3, shipments: 3, packages: 5, definite: "111.50", estimated: "15.00", expected: "126.50" });
    expect(p.byService["svc-ups-ground"]).toMatchObject({ orders: 2, shipments: 3, packages: 3, definite: "16.50", estimated: "28.80", expected: "45.30" });
    expect(p.byService["svc-ups-2da"]).toMatchObject({ name: "UPS 2nd Day Air", orders: 1, shipments: 1, packages: 3, expected: "95.00" });
    expect(p.byWeightBracket["≤1 lb"]).toEqual({ orders: 2, shipments: 2, packages: 2, definite: "25.50", estimated: "0.00", expected: "25.50" });
    expect(p.byWeightBracket["≤5 lb"]).toEqual({ orders: 1, shipments: 1, packages: 1, definite: "0.00", estimated: "13.80", expected: "13.80" });
    expect(p.byWeightBracket["≤20 lb"]).toEqual({ orders: 1, shipments: 1, packages: 1, definite: "0.00", estimated: "15.00", expected: "15.00" });
    expect(p.bySurcharge["ups.fuel"]).toMatchObject({ versions: [3], charged: { definite: "4.50", estimated: "1.80", shipments: 3, packages: 2, lines: 3 } });
    expect(p.bySurcharge["ups.residential"]).toMatchObject({ charged: { definite: "9.00", estimated: "0.00", shipments: 2, packages: 2, lines: 2 } });
    expect(p.bySurcharge["ups.das"]).toMatchObject({ unknown: { amount: "8.00", shipments: 2 } });
    expect(p.warnings).toEqual({ assumed_inputs: { shipments: 2 }, "zip_list_missing:ups.das": { shipments: 1 }, dimensions_missing: { shipments: 1 } });
    expect(p.exposureShipments).toEqual({ conditional: 1, unresolved: 2 });

    const sum = (amounts: string[]) => amounts.reduce((s, a) => s + moneyToCents(a), 0);
    const totalCents = moneyToCents(p.totals.expected);
    expect(sum(Object.values(p.byZone).map((b) => b.expected))).toBe(totalCents);
    expect(sum(Object.values(p.byService).map((b) => b.expected))).toBe(totalCents);
    expect(sum(Object.values(p.byMonth).map((b) => b.expected))).toBe(totalCents);
    expect(sum([...Object.values(p.byWeightBracket).map((b) => b.expected), p.shipmentLevel.expected])).toBe(totalCents);
    expect(sum(Object.values(p.unresolvedBy).map((u) => u.amount))).toBe(moneyToCents(p.totals.unresolved));
    expect(p.shipments.ok).toBe(p.shipments.modeled + p.pricedButExcluded.shipments);
  });

  it("is a pure fold: two batches equal one batch over the same orders and the input is untouched", () => {
    const base = start();
    const twoBatches = foldBatch(foldBatch(base, [A, B, C]), [D, E, F]);
    const oneBatch = foldBatch(start(), ALL);
    expect(twoBatches).toEqual(oneBatch);
    expect(foldBatch(foldBatch(foldBatch(start(), [A]), [B, C, D]), [E, F])).toEqual(oneBatch);
    expect(base).toEqual(start());
    expect(twoBatches.dictionary).toBe(dictionary);
  });
});

describe("weight brackets", () => {
  it("names one bracket per edge plus the open top bracket and puts a package in the lowest bracket that holds it", () => {
    expect(WEIGHT_BRACKET_LABELS).toHaveLength(WEIGHT_BRACKET_EDGES.length + 1);
    expect(weightBracket("0.3")).toBe("≤1 lb");
    expect(weightBracket("1")).toBe("≤1 lb");
    expect(weightBracket("1.000001")).toBe("≤2 lb");
    expect(weightBracket("70")).toBe("≤70 lb");
    expect(weightBracket("150")).toBe("≤150 lb");
    expect(weightBracket("150.5")).toBe(">150 lb");
  });
});

describe("finalizeSummary", () => {
  it("reports an empty run with null averages and 0% coverage, never a fabricated zero", () => {
    const s = finalizeSummary(emptyPartial(), { rows: 0, orders: 0, shipments: 0, packages: 0 }, [], "2.2.0");
    expect(s.engineVersion).toBe("2.2.0");
    expect(s.modeled).toEqual({ orders: 0, shipments: 0, packages: 0 });
    expect(s.coverage).toEqual({ ordersPct: "0.0", shipmentsPct: "0.0" });
    expect(s.averages).toEqual({ expectedPerOrder: null, expectedPerShipment: null, expectedPerPackage: null, definitePerOrder: null });
    expect(s.exposure).toEqual({ conditional: { amount: "0.00", shipments: 0 }, unresolved: { amount: "0.00", shipments: 0, by: emptyPartial().unresolvedBy } });
    expect(s.exclusions).toEqual([]);
    expect(s.byZone).toEqual([]);
    expect(s.byService).toEqual([]);
    expect(s.byMonth).toEqual([]);
    expect(s.byWeightBracket).toEqual([]);
    expect(s.bySurcharge).toEqual([]);
    expect(s.warnings).toEqual([]);
    expect(s.dictionary).toEqual(createDictionary());
  });

  it("rounds averages HALF_UP to cents and coverage and shares to one decimal, and sorts every table deterministically", () => {
    const p = foldBatch(start(), ALL);
    const s = finalizeSummary(p, { rows: 12, orders: 6, shipments: 8, packages: 11 }, ["rule ups.peak@2: unreadable condition"], "2.2.0");
    expect(s.imported).toEqual({ rows: 12, orders: 6, shipments: 8, packages: 11 });
    expect(s.modeled).toEqual({ orders: 3, shipments: 4, packages: 6 });
    expect(s.coverage).toEqual({ ordersPct: "50.0", shipmentsPct: "50.0" });
    expect(s.totals).toEqual(p.totals);
    expect(s.averages).toEqual({ expectedPerOrder: "46.77", expectedPerShipment: "35.08", expectedPerPackage: "23.38", definitePerOrder: "37.17" });
    expect(s.exposure).toEqual({ conditional: { amount: "21.00", shipments: 1 }, unresolved: { amount: "8.00", shipments: 2, by: p.unresolvedBy } });
    expect(s.pricedButExcluded).toEqual({ shipments: 1, expected: "20.00" });
    expect(s.exclusions).toEqual([
      { reason: "no_rate_for_weight", orders: 1, shipments: 1, ordersPct: "16.7" },
      { reason: "order_cancelled", orders: 1, shipments: 1, ordersPct: "16.7" },
      { reason: "weight_missing", orders: 1, shipments: 1, ordersPct: "16.7" },
    ]);
    expect(s.byZone.map((z) => [z.zone, z.sharePct])).toEqual([
      ["10", "9.8"],
      ["5", "90.2"],
    ]);
    expect(s.byService.map((b) => [b.serviceId, b.expected, b.sharePct])).toEqual([
      ["svc-ups-2da", "95.00", "67.7"],
      ["svc-ups-ground", "45.30", "32.3"],
    ]);
    expect(s.byMonth.map((m) => [m.month, m.sharePct])).toEqual([
      ["2026-03", "21.6"],
      ["2026-04", "67.7"],
      ["unknown", "10.7"],
    ]);
    expect(s.byWeightBracket.map((b) => [b.bracket, b.packages, b.sharePct])).toEqual([
      ["≤1 lb", 2, "18.2"],
      ["≤2 lb", 1, "5.7"],
      ["≤5 lb", 1, "9.8"],
      ["≤20 lb", 1, "10.7"],
      [">150 lb", 1, "53.5"],
    ]);
    expect(s.shipmentLevel).toEqual({ shipments: 1, definite: "3.00", estimated: "0.00", expected: "3.00" });
    expect(s.bySurcharge.map((b) => b.key)).toEqual(["acme.handling", "ups.residential", "ups.fuel", "ups.address_correction", "ups.das"]);
    expect(s.warnings).toEqual([
      { code: "assumed_inputs", ruleKey: null, shipments: 2 },
      { code: "dimensions_missing", ruleKey: null, shipments: 1 },
      { code: "zip_list_missing", ruleKey: "ups.das", shipments: 1 },
    ]);
    expect(s.loadIssues).toEqual(["rule ups.peak@2: unreadable condition"]);
    expect(s.assumptions).toEqual(p.assumptions);
    expect(s.dictionary).toEqual(dictionary);
    expect(s.dictionary).not.toBe(dictionary);
  });

  it("rounds one-decimal percentages HALF_UP", () => {
    const p = foldBatch(start(), [A, C, D]);
    const s = finalizeSummary(p, { rows: 3, orders: 3, shipments: 4, packages: 4 }, [], "2.2.0");
    expect(s.coverage).toEqual({ ordersPct: "33.3", shipmentsPct: "50.0" });
    expect(s.exclusions.map((e) => e.ordersPct)).toEqual(["33.3", "33.3"]);
  });
});

describe("encodeResult and decodeLines", () => {
  const ctx = fixtureContext();
  const input = {
    shipDate: "2026-10-15",
    originZip: "90001",
    destinationZip: "85001",
    residential: true,
    carrierCode: "ups",
    serviceCode: "ground",
    packages: [{ weight: "3", weightUnit: "lb" as const, length: "10", width: "8", height: "6" }],
  };

  it("stores exact cents against a dictionary that names each rule once and decodes back to the engine's lines", () => {
    const calc = calculateShipment(input, ctx);
    expect(calc.status).toBe("ok");
    const dict = createDictionary();
    const compact = encodeResult(calc, dict, { serviceId: "svc-ups-ground" });
    expect(compact).toMatchObject({ status: "ok", unavailableReason: null, rateCardVersionId: "fixture-card-v1", shipDate: "2026-10-15", zone: "5", serviceId: "svc-ups-ground", billableLb: ["4.0"] });
    expect(compact.lines[0]).toEqual([0, 1107, "c", "d", 0]);
    expect(compact.definite).toBe(calc.totals.definite.amount);
    expect(compact.expected).toBe(calc.totals.expected.amount);
    expect(compact.conditionalExposure).toBe(calc.totals.conditionalExposure.amount);
    expect(compact.warningCodes).toEqual([...new Set(calc.warnings.map((w) => (w.ruleKey ? `${w.code}:${w.ruleKey}` : w.code)))]);

    const charged = compact.lines.filter((l) => l[2] === "c").reduce((s, l) => s + l[1], 0);
    expect(centsToMoney(charged)).toBe(compact.expected);

    const rules = dict.slice(2);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((e) => e.kind === "rule" && e.key !== null && e.version !== null && (e.scope === "carrier" || e.scope === "3pl"))).toBe(true);
    expect(new Set(rules.map((e) => `${e.key}@${e.version}`)).size).toBe(rules.length);
    expect(rules.some((e) => "sourceReference" in e || "verificationStatus" in e)).toBe(false);

    // The base and minimum entries are generic for the whole run (the engine's base label names the service); rule lines keep their names.
    const decoded = decodeLines(compact.lines, dict);
    const genericName = (kind: string, label: string) => (kind === "base" ? "Base rate" : kind === "minimum_charge" ? "Minimum charge adjustment" : label);
    expect(decoded.map((l) => [l.name, l.amount, l.status, l.chargeClass, l.packageIndex])).toEqual(calc.lines.map((l) => [genericName(l.kind, l.label), l.amount.amount, l.status, l.chargeClass, l.packageIndex]));
    expect(decoded[0]).toMatchObject({ name: "Base rate", category: "base", scope: null, key: null, version: null });
    expect(decoded.filter((l) => l.key !== null).map((l) => l.name)).toEqual(calc.lines.filter((l) => l.rule !== null).map((l) => l.label));

    const size = dict.length;
    encodeResult(calc, dict, { serviceId: "svc-ups-ground" });
    expect(dict.length).toBe(size);
  });

  it("encodes an unavailable result with no lines and keeps the reason", () => {
    const calc = calculateShipment({ ...input, serviceCode: "overnight_rocket" }, ctx);
    expect(calc.status).toBe("unavailable");
    const compact = encodeResult(calc, createDictionary(), { serviceId: null });
    expect(compact).toMatchObject({ status: "unavailable", unavailableReason: "service_not_on_rate_card", zone: null, serviceId: null, billableLb: [], lines: [], expected: "0.00" });
  });

  it("refuses a dictionary without the fixed base and minimum entries and a dangling index", () => {
    const calc = calculateShipment(input, ctx);
    expect(() => encodeResult(calc, [], { serviceId: null })).toThrow(/base and minimum/);
    expect(() => decodeLines([[7, 100, "c", "d", 0]], createDictionary())).toThrow(/entry 7/);
  });

  it("converts money and cents exactly in both directions", () => {
    expect(moneyToCents("12.34")).toBe(1234);
    expect(moneyToCents("0.00")).toBe(0);
    expect(moneyToCents("1234567.89")).toBe(123456789);
    expect(() => moneyToCents("0.005")).toThrow(/whole number of cents/);
    expect(centsToMoney(0)).toBe("0.00");
    expect(centsToMoney(5)).toBe("0.05");
    expect(centsToMoney(1234)).toBe("12.34");
    expect(centsToMoney(-250)).toBe("-2.50");
    expect(() => centsToMoney(1.5)).toThrow(/integer/);
  });
});
