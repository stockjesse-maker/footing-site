import { describe, expect, it } from "vitest";
import { calculateShipment } from "@/engine";
import type { FeeBasis, FeeCategory, FeeScope } from "@/engine/fees/types";
import {
  centsToMoney,
  createDictionary,
  decodeLines,
  emptyPartial,
  encodeResult,
  finalizeSummary,
  foldBatch,
  moneyToCents,
  readStoredPartial,
  weightBracket,
  PACKAGING_OTHER_KEY,
  WEIGHT_BRACKET_EDGES,
  WEIGHT_BRACKET_LABELS,
  type CompactFeeLine,
  type CompactLine,
  type CompactLineClass,
  type CompactLineStatus,
  type CompactResult,
  type FeeDictionaryEntry,
  type FeeStatus,
  type FinalizeFeeInput,
  type FoldOrder,
  type FoldOrderFees,
  type FoldShipment,
  type LineDictionaryEntry,
  type PartialSummary,
  type RunPeriod,
} from "@/engine/modeling";
import type { SurchargeCategory } from "@/engine/types";
import { fixtureContext } from "../fixtures/pricing/load";

// ---------------------------------------------------------------------------
// Hand-built inputs. The dictionary is the run's live array: rule entries are appended once and
// every compact line refers to them by index. The fee dictionary works the same way, keyed by rule id.
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

const feeDictionary: FeeDictionaryEntry[] = [];
function addFee(ruleId: string, key: string, name: string, category: FeeCategory, basis: FeeBasis, scope: FeeScope = "order"): number {
  feeDictionary.push({ ruleId, key, name, category, basis, scope });
  return feeDictionary.length - 1;
}
const PICK = addFee("r-pick", "pick_order", "Order pick", "pick_pack", "order");
const PICK_V2 = addFee("r-pick-v2", "pick_order", "Order pick", "pick_pack", "order");
const ADDL = addFee("r-addl", "pick_additional", "Additional item pick", "pick_pack", "unit");
const BOX = addFee("r-box", "pack_box", "Box", "packaging", "package");
addFee("r-mailer", "pack_mailer", "Mailer", "packaging", "package");
const INSERTS = addFee("r-ins", "inserts", "Inserts", "other", "order_driver");
addFee("r-pct", "handling_pct", "Handling", "other", "shipping_percent");

function line(index: number, cents: number, status: CompactLineStatus = "c", cls: CompactLineClass = "d", packageIndex: number | null = 0): CompactLine {
  return [index, cents, status, cls, packageIndex];
}

function feeLine(index: number, amountE4: number, cls: "d" | "e" = "d"): CompactFeeLine {
  return [index, amountE4, cls];
}

/** A fee result whose totals are derived from its lines the way the engine derives them. */
function fees(status: FeeStatus, opts: Partial<Omit<FoldOrderFees, "status" | "definiteE4" | "estimatedE4">> = {}): FoldOrderFees {
  const lines = opts.lines ?? [];
  return {
    status,
    lines,
    unresolved: opts.unresolved ?? [],
    warnings: opts.warnings ?? [],
    definiteE4: lines.filter((l) => l[2] === "d").reduce((s, l) => s + l[1], 0),
    estimatedE4: lines.filter((l) => l[2] === "e").reduce((s, l) => s + l[1], 0),
    assumed: opts.assumed ?? {},
  };
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

function order(orderKey: string, shipments: FoldShipment[], opts: { orderDate?: string | null; orderMonth?: string | null; cancelled?: boolean; fees?: FoldOrderFees } = {}): FoldOrder {
  const orderDate = opts.orderDate === undefined ? "2026-03-14" : opts.orderDate;
  return {
    orderKey,
    orderDate,
    orderMonth: opts.orderMonth === undefined ? (orderDate?.slice(0, 7) ?? null) : opts.orderMonth,
    cancelled: opts.cancelled ?? false,
    shipments,
    fees: opts.fees ?? fees("ok", { lines: [feeLine(PICK, 15000)] }),
  };
}

// A: modeled, two shipments in different zones; the second priced on an assumed weight (estimated). Fees ok, with an inserts line from an order-share answer.
const A = order(
  "A",
  [
    ship(1, okResult({ zone: "5", billableLb: ["1"], lines: [line(BASE, 1000), line(RES, 500), line(FUEL, 150)] })),
    ship(2, okResult({ zone: "10", billableLb: ["4.5"], lines: [line(BASE, 1200, "c", "e"), line(FUEL, 180, "c", "e")], warningCodes: ["assumed_inputs"] }), { assumed: { residential: false, originZip: false, weight: true, dimensions: false } }),
  ],
  { fees: fees("ok", { lines: [feeLine(PICK, 15000), feeLine(ADDL, 5000), feeLine(INSERTS, 2500, "e")] }) },
);
// B: modeled, one three-package shipment across brackets, a shipment-level fuel line, a 3PL handling rule, an unknown DAS and a conditional address correction.
// Fees partial: the box was priced on a packaging default (estimated), the mailer rule lost to it, inserts were not answered.
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
  {
    orderDate: "2026-04-02",
    fees: fees("partial", {
      lines: [feeLine(PICK, 15000), feeLine(BOX, 5000, "e")],
      unresolved: [
        { ruleKey: "inserts", reason: "assumption_missing" },
        { ruleKey: "pack_mailer", reason: "replaced", replacedBy: "pack_box" },
      ],
      warnings: ["packaging_defaulted", "fee_base_excludes_exposure"],
      assumed: { units: true, lines: true, skus: true, packaging: true },
    }),
  },
);
// C: not modeled, one shipment priced ok and one unavailable. Its fee result must count nowhere.
const C = order("C", [ship(4, okResult({ zone: "8", billableLb: ["3"], lines: [line(BASE, 2000)] })), ship(5, unavailableResult("no_rate_for_weight"))]);
// D: cancelled; its shipment was never sent to the engine.
const D = order("D", [ship(6, null, { excludedReason: "order_cancelled" })], { cancelled: true, fees: fees("skipped") });
// E: not modeled, excluded before pricing.
const E = order("E", [ship(7, null, { excludedReason: "weight_missing", packageCount: 2 })], { fees: fees("date_missing") });
// F: modeled on assumed residential status and origin, one package without dimensions, no order date (and so no fee month).
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
// G: modeled, but no fee could be computed (the file has no item counts). H: modeled, the brand had no fee schedule.
const G = order("G", [ship(9, okResult({ billableLb: ["1"], lines: [line(BASE, 900)] }))], { fees: fees("no_content", { unresolved: [{ ruleKey: "handling_pct", reason: "shipping_unknown" }] }) });
const H = order("H", [ship(10, okResult({ billableLb: ["1"], lines: [line(BASE, 800)] }))], { fees: fees("no_schedule") });
const ALL = [A, B, C, D, E, F];

function start(): PartialSummary {
  return { ...emptyPartial(), dictionary, feeDictionary };
}

const emptyPeriod: RunPeriod = { from: null, to: null, days: null, months: null, population: 0, inPeriod: 0, trimmed: 0, undated: 0, volumeBasis: "none", monthlyOrders: null, monthlyUnits: null, monthProfile: [] };

/** Fees were not modeled: the shipping-only summary of a brand without a fee schedule. */
function noFees(): FinalizeFeeInput {
  return { mode: "no_schedule", feeEngineVersion: "1.0.0", monthlySchedule: null, answers: { drivers: {}, orderShares: {} }, period: emptyPeriod, provenance: null };
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

  it("refuses a partial summary of an older shape", () => {
    expect(() => foldBatch({ ...start(), version: 1 } as unknown as PartialSummary, [])).toThrow(/not supported/);
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
    // The fee month buckets cover the same processing orders, and their expected shipping is the modeled shipping total.
    expect(Object.values(p.fees.byMonth).reduce((n, m) => n + m.shippingExpectedE4, 0)).toBe(totalCents * 100);
  });

  it("is a pure fold: two batches equal one batch over the same orders and the input is untouched", () => {
    const base = start();
    const twoBatches = foldBatch(foldBatch(base, [A, B, C]), [D, E, F]);
    const oneBatch = foldBatch(start(), ALL);
    expect(twoBatches).toEqual(oneBatch);
    expect(foldBatch(foldBatch(foldBatch(start(), [A]), [B, C, D]), [E, F])).toEqual(oneBatch);
    expect(base).toEqual(start());
    expect(twoBatches.dictionary).toBe(dictionary);
    expect(twoBatches.feeDictionary).toBe(feeDictionary);
  });
});

describe("foldBatch: fees of processing orders", () => {
  it("starts with an empty fee section", () => {
    expect(emptyPartial().version).toBe(2);
    expect(emptyPartial().feeDictionary).toEqual([]);
    expect(emptyPartial().fees).toEqual({ statusCounts: {}, processing: { orders: 0, definiteE4: 0, estimatedE4: 0 }, byRule: {}, byMonth: {}, warnings: {}, assumed: { units: 0, lines: 0, skus: 0, packaging: 0 } });
  });

  it("counts fee statuses over shipping-modeled orders only and folds the figures of ok and partial orders", () => {
    const p = foldBatch(start(), [A, B, C, D, E, F, G, H]);
    // C (unavailable shipment), D (cancelled) and E (excluded) are not shipping-modeled: their fee results count nowhere.
    expect(p.fees.statusCounts).toEqual({ ok: 2, partial: 1, no_content: 1, no_schedule: 1 });
    expect(p.fees.processing).toEqual({ orders: 3, definiteE4: 50000, estimatedE4: 7500 });
    expect(p.fees.byRule.pick_order).toEqual({ ruleIds: ["r-pick"], name: "Order pick", category: "pick_pack", basis: "order", scope: "order", definiteE4: 45000, estimatedE4: 0, orders: 3, lines: 3, unresolvedOrders: 0, unresolvedBy: {}, replacedOrders: 0 });
    expect(p.fees.byRule.pick_additional).toMatchObject({ ruleIds: ["r-addl"], definiteE4: 5000, estimatedE4: 0, orders: 1, lines: 1 });
    expect(p.fees.byRule.inserts).toEqual({ ruleIds: ["r-ins"], name: "Inserts", category: "other", basis: "order_driver", scope: "order", definiteE4: 0, estimatedE4: 2500, orders: 1, lines: 1, unresolvedOrders: 1, unresolvedBy: { assumption_missing: 1 }, replacedOrders: 0 });
    expect(p.fees.byRule.pack_box).toMatchObject({ definiteE4: 0, estimatedE4: 5000, orders: 1, lines: 1, unresolvedOrders: 0 });
    expect(p.fees.byRule.pack_mailer).toEqual({ ruleIds: ["r-mailer"], name: "Mailer", category: "packaging", basis: "package", scope: "order", definiteE4: 0, estimatedE4: 0, orders: 0, lines: 0, unresolvedOrders: 0, unresolvedBy: {}, replacedOrders: 1 });
    // G could not be priced at all: it is counted by status, and its unresolved rules are not "processing orders where the rule could not be computed".
    expect(p.fees.byRule.handling_pct).toBeUndefined();
    expect(p.fees.byMonth).toEqual({
      "2026-03": { orders: 1, byRuleE4: { pick_order: 15000, pick_additional: 5000, inserts: 2500 }, shippingExpectedE4: 303000, unresolvedRuleKeys: [] },
      "2026-04": { orders: 1, byRuleE4: { pick_order: 15000, pack_box: 5000 }, shippingExpectedE4: 950000, unresolvedRuleKeys: ["inserts"] },
      unknown: { orders: 1, byRuleE4: { pick_order: 15000 }, shippingExpectedE4: 150000, unresolvedRuleKeys: [] },
    });
    expect(p.fees.warnings).toEqual({ packaging_defaulted: 1, fee_base_excludes_exposure: 1 });
    expect(p.fees.assumed).toEqual({ units: 1, lines: 1, skus: 1, packaging: 1 });
    // Processing totals reconcile with the per-rule and per-month figures.
    const byRule = Object.values(p.fees.byRule).reduce((n, r) => n + r.definiteE4 + r.estimatedE4, 0);
    const byMonth = Object.values(p.fees.byMonth).reduce((n, m) => n + Object.values(m.byRuleE4).reduce((a, b) => a + b, 0), 0);
    expect(byRule).toBe(57500);
    expect(byMonth).toBe(57500);
  });

  it("counts a rule once per order however many lines it produced, and keeps every rule id seen under the key", () => {
    const twoVersions = order("V", [ship(1, okResult({ billableLb: ["1"], lines: [line(BASE, 1000)] }))], { fees: fees("ok", { lines: [feeLine(PICK, 15000), feeLine(PICK_V2, 15000)] }) });
    const p = foldBatch(start(), [twoVersions]);
    expect(p.fees.byRule.pick_order).toMatchObject({ ruleIds: ["r-pick", "r-pick-v2"], definiteE4: 30000, orders: 1, lines: 2 });
    expect(p.fees.byMonth["2026-03"]!.byRuleE4).toEqual({ pick_order: 30000 });
  });

  it("names an unresolved rule from the fee dictionary when it produced no line, and an unmatched packaging type from its key", () => {
    const o = order("U", [ship(1, okResult({ billableLb: ["1"], lines: [line(BASE, 1000)] }))], {
      fees: fees("partial", {
        lines: [feeLine(PICK, 15000)],
        unresolved: [
          { ruleKey: "pack_mailer", reason: "packaging_unknown" },
          { ruleKey: "packaging:tube", reason: "packaging_unmatched" },
          { ruleKey: "pack_mailer", reason: "packaging_unknown" },
        ],
      }),
    });
    const p = foldBatch(start(), [o]);
    expect(p.fees.byRule.pack_mailer).toEqual({ ruleIds: ["r-mailer"], name: "Mailer", category: "packaging", basis: "package", scope: "order", definiteE4: 0, estimatedE4: 0, orders: 0, lines: 0, unresolvedOrders: 1, unresolvedBy: { packaging_unknown: 1 }, replacedOrders: 0 });
    expect(p.fees.byRule["packaging:tube"]).toEqual({ ruleIds: [], name: "Packaging (tube)", category: "packaging", basis: "package", scope: "order", definiteE4: 0, estimatedE4: 0, orders: 0, lines: 0, unresolvedOrders: 1, unresolvedBy: { packaging_unmatched: 1 }, replacedOrders: 0 });
    expect(p.fees.byMonth["2026-03"]!.unresolvedRuleKeys).toEqual(["pack_mailer", "packaging:tube"]);
    const unknownRule = order("U2", [ship(1, okResult({ billableLb: ["1"], lines: [line(BASE, 1000)] }))], { fees: fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "mystery", reason: "units_unknown" }] }) });
    expect(() => foldBatch(start(), [unknownRule])).toThrow(/not in the fee dictionary/);
  });

  it("keeps at most 50 unmatched packaging types by name and folds every further type into one 'other' row, whatever the batch boundaries", () => {
    // 52 orders, each with a packaging type no rule prices, plus one that repeats the first type.
    const typed = (n: number) =>
      order(`P${n}`, [ship(n, okResult({ billableLb: ["1"], lines: [line(BASE, 1000)] }))], {
        fees: fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: `packaging:type ${n}`, reason: "packaging_unmatched" }] }),
      });
    const orders = [...Array.from({ length: 52 }, (_, i) => typed(i + 1)), order("P53", [ship(53, okResult({ billableLb: ["1"], lines: [line(BASE, 1000)] }))], { fees: fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "packaging:type 1", reason: "packaging_unmatched" }] }) })];
    const p = foldBatch(start(), orders);
    const packagingKeys = Object.keys(p.fees.byRule).filter((k) => k.startsWith("packaging:"));
    expect(packagingKeys).toHaveLength(51);
    expect(packagingKeys.filter((k) => k !== PACKAGING_OTHER_KEY)).toEqual(Array.from({ length: 50 }, (_, i) => `packaging:type ${i + 1}`));
    expect(p.fees.byRule["packaging:type 1"]).toMatchObject({ unresolvedOrders: 2, unresolvedBy: { packaging_unmatched: 2 } });
    expect(p.fees.byRule[PACKAGING_OTHER_KEY]).toEqual({ ruleIds: [], name: "Packaging (other types)", category: "packaging", basis: "package", scope: "order", definiteE4: 0, estimatedE4: 0, orders: 0, lines: 0, unresolvedOrders: 2, unresolvedBy: { packaging_unmatched: 2 }, replacedOrders: 0 });
    expect(p.fees.byMonth["2026-03"]!.unresolvedRuleKeys).toEqual([...Array.from({ length: 50 }, (_, i) => `packaging:type ${i + 1}`), PACKAGING_OTHER_KEY]);
    // Two types beyond the cap in one order count that order once under "other".
    const two = order("P54", [ship(54, okResult({ billableLb: ["1"], lines: [line(BASE, 1000)] }))], {
      fees: fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "packaging:type 60", reason: "packaging_unmatched" }, { ruleKey: "packaging:type 61", reason: "packaging_unmatched" }] }),
    });
    expect(foldBatch(p, [two]).fees.byRule[PACKAGING_OTHER_KEY]!.unresolvedOrders).toBe(3);
    // Batch boundaries never change which types keep their rows.
    expect(foldBatch(foldBatch(start(), orders.slice(0, 30)), orders.slice(30))).toEqual(p);
  });

  it("counts a warning once per order and refuses fee results that do not add up", () => {
    const o = order("W", [ship(1, okResult({ billableLb: ["1"], lines: [line(BASE, 1000)] }))], { fees: fees("ok", { lines: [feeLine(PICK, 15000)], warnings: ["packaging_defaulted", "packaging_defaulted"] }) });
    expect(foldBatch(start(), [o]).fees.warnings).toEqual({ packaging_defaulted: 1 });

    const shipments = [ship(1, okResult({ billableLb: ["1"], lines: [line(BASE, 1000)] }))];
    expect(() => foldBatch(start(), [order("bad", shipments, { fees: { ...fees("ok", { lines: [feeLine(PICK, 15000)] }), definiteE4: 14000 } })])).toThrow(/add up to/);
    expect(() => foldBatch(start(), [order("bad", shipments, { fees: { ...fees("skipped"), lines: [feeLine(PICK, 15000)] } })])).toThrow(/carries fee lines/);
    expect(() => foldBatch(start(), [order("bad", shipments, { fees: fees("ok", { lines: [feeLine(99, 15000)] }) })])).toThrow(/fee dictionary entry 99/);
    expect(() => foldBatch(start(), [order("bad", shipments, { fees: fees("ok", { lines: [feeLine(PICK, 1.5)] }) })])).toThrow(/ten-thousandths/);
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
    const s = finalizeSummary(emptyPartial(), { rows: 0, orders: 0, shipments: 0, packages: 0 }, [], "2.2.0", noFees());
    expect(s.version).toBe(2);
    expect(s.engineVersion).toBe("2.2.0");
    expect(s.feeEngineVersion).toBe("1.0.0");
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
    expect(s.loadIssueCount).toBe(0);
    expect(s.dictionary).toEqual(createDictionary());
    expect(s.feeDictionary).toEqual([]);
    expect(s.fees.mode).toBe("no_schedule");
    expect(s.fees.processing).toEqual({ orders: 0, definiteE4: 0, estimatedE4: 0, definite: "0.0000", estimated: "0.0000", expected: "0.0000", perOrder: null });
    expect(s.processing).toEqual(s.fees.processing);
    expect(s.monthly).toBeNull();
    expect(s.minimums).toEqual([]);
    expect(s.minimumStatus).toBe("none");
    expect(s.allocation).toBeNull();
    expect(s.provenance).toBeNull();
    expect(s.period).toEqual(emptyPeriod);
  });

  it("rounds averages HALF_UP to cents and coverage and shares to one decimal, and sorts every table deterministically", () => {
    const p = foldBatch(start(), ALL);
    // A problem found at finalize time is named by its rule version id, never by what it says.
    const s = finalizeSummary(p, { rows: 12, orders: 6, shipments: 8, packages: 11 }, ["00000000-0000-4000-8000-0000000000a2"], "2.2.0", noFees());
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
    // Was `s.loadIssues` (the problem text, which names the 3PL's rules and reached the customer in the stored summary): now a count and nothing else.
    expect(s.loadIssueCount).toBe(1);
    expect("loadIssues" in s).toBe(false);
    expect(s.assumptions).toEqual(p.assumptions);
    expect(s.dictionary).toEqual(dictionary);
    expect(s.dictionary).not.toBe(dictionary);
    expect(s.feeDictionary).toEqual(feeDictionary);
    expect(s.feeDictionary).not.toBe(feeDictionary);
    // Fee tables: per rule by amount, warnings by orders, exact four-decimal dollars and a cents average.
    expect(s.fees.byRule.map((r) => [r.key, r.definite, r.estimated])).toEqual([
      ["pick_order", "4.5000", "0.0000"],
      ["pack_box", "0.0000", "0.5000"],
      ["pick_additional", "0.5000", "0.0000"],
      ["inserts", "0.0000", "0.2500"],
      ["pack_mailer", "0.0000", "0.0000"],
    ]);
    expect(s.fees.processing).toEqual({ orders: 3, definiteE4: 50000, estimatedE4: 7500, definite: "5.0000", estimated: "0.7500", expected: "5.7500", perOrder: "1.92" });
    expect(s.fees.warnings).toEqual([
      { code: "fee_base_excludes_exposure", orders: 1 },
      { code: "packaging_defaulted", orders: 1 },
    ]);
    expect(s.fees.statusCounts).toEqual({ ok: 2, partial: 1 });
  });

  it("lists orders the fold never saw (nothing to ship) as excluded, so modeled plus excluded reconciles to imported", () => {
    const p = foldBatch(start(), ALL);
    const s = finalizeSummary(p, { rows: 14, orders: 8, shipments: 8, packages: 11 }, [], "2.2.0", noFees());
    const excluded = s.exclusions.reduce((n, e) => n + e.orders, 0);
    expect(s.modeled.orders + excluded).toBe(8);
    expect(s.exclusions.find((e) => e.reason === "nothing_to_ship")).toEqual({ reason: "nothing_to_ship", orders: 2, shipments: 0, ordersPct: "25.0" });
    expect(s.coverage.ordersPct).toBe("37.5");
  });

  it("rounds one-decimal percentages HALF_UP", () => {
    const p = foldBatch(start(), [A, C, D]);
    const s = finalizeSummary(p, { rows: 3, orders: 3, shipments: 4, packages: 4 }, [], "2.2.0", noFees());
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

describe("load issues in a run summary", () => {
  const counts = { rows: 0, orders: 0, shipments: 0, packages: 0 };
  const withKeys = (keys: string[]): PartialSummary => ({ ...emptyPartial(), loadIssueKeys: keys });

  it("counts each rule version once, across the partial and the finalize call, and keeps no text", () => {
    const s = finalizeSummary(withKeys(["v-a", "v-b"]), counts, ["v-b", "v-c"], "2.2.0", noFees());
    expect(s.loadIssueCount).toBe(3);
    expect(JSON.stringify(s)).not.toContain("v-a");
    expect(s.loadIssueCount).toBe(finalizeSummary(withKeys(["v-b", "v-a", "v-c", "v-a"]), counts, [], "2.2.0", noFees()).loadIssueCount);
  });

  it("the fold leaves the partial's keys alone and starts from none", () => {
    expect(emptyPartial().loadIssueKeys).toEqual([]);
    expect(foldBatch(withKeys(["v-a"]), []).loadIssueKeys).toEqual(["v-a"]);
  });

  it("reads a stored partial: none is an empty one, a current one is returned as it is", () => {
    expect(readStoredPartial(null)).toEqual(emptyPartial());
    const current = withKeys(["v-a"]);
    expect(readStoredPartial(current)).toBe(current);
  });

  it("drops the text of a partial written by an earlier release (the run is customer-readable) and keeps one key per distinct problem", () => {
    const earlier = { ...emptyPartial(), loadIssues: ['The surcharge rule "Acme secret fee" has an invalid condition or base and was not applied.', "again", "again"] } as unknown as PartialSummary;
    const read = readStoredPartial(earlier);
    expect("loadIssues" in read).toBe(false);
    expect(read.loadIssueKeys).toHaveLength(2);
    expect(JSON.stringify(read)).not.toContain("Acme");
    // Reading it again (every window re-reads the stored partial until it is rewritten) changes nothing.
    expect(readStoredPartial(read)).toBe(read);
    expect(readStoredPartial(earlier).loadIssueKeys).toEqual(read.loadIssueKeys);
    expect(finalizeSummary(read, counts, [], "2.2.0", noFees()).loadIssueCount).toBe(2);
  });
});
