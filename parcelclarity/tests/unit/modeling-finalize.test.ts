import { describe, expect, it } from "vitest";
import { FEE_CATEGORIES } from "@/engine/fees";
import type { FeeCategory, FeeRule, FeeScheduleSnapshot } from "@/engine/fees/types";
import { emptyPartial, finalizeSummary, foldBatch, type CategoryCompleteness, type CompactFeeLine, type DatasetCounts, type FeeDictionaryEntry, type FeeStatus, type FinalizeFeeInput, type FoldOrder, type FoldOrderFees, type PartialSummary, type RunPeriod } from "@/engine/modeling";

/**
 * finalizeSummary v2: the fee sections (processing, completeness, monthly charges, minimums,
 * allocation) over a hand-built partial. Expected figures are derived by hand from RULES.md
 * sections B–D and the design's completeness rules, not from the code.
 */

// ---------------------------------------------------------------------------
// A small fee schedule version: three order rules, one storage driver, one flat account fee, one minimum.
// ---------------------------------------------------------------------------
function rule(r: Partial<FeeRule> & Pick<FeeRule, "id" | "key" | "name" | "category" | "scope" | "basis" | "method" | "position">): FeeRule {
  return { amount: null, percent: null, ...r };
}

const schedule: FeeScheduleSnapshot = {
  scheduleId: "s-1",
  name: "Standard fulfillment",
  versionId: "v-1",
  versionNumber: 1,
  effectiveDate: "2026-01-01",
  expirationDate: null,
  rounding: "invoice_line",
  rules: [
    rule({ id: "r-pick", key: "pick_order", name: "Order pick", category: "pick_pack", scope: "order", basis: "order", method: "flat", amount: "1.50", position: 0 }),
    rule({ id: "r-box", key: "pack_box", name: "Box", category: "packaging", scope: "order", basis: "package", method: "flat", amount: "0.50", conditions: { packagingTypes: ["box"] }, position: 1 }),
    rule({ id: "r-ins", key: "inserts", name: "Inserts", category: "other", scope: "order", basis: "order_driver", method: "flat", amount: "0.25", driver: { key: "inserts", label: "Orders that get an insert", unit: "inserts", kind: "order_share" }, position: 2 }),
    rule({ id: "r-pallet", key: "storage_pallet", name: "Pallet storage", category: "storage", scope: "monthly", basis: "driver", method: "flat", amount: "18.00", driver: { key: "pallets", label: "Pallets stored, on average", unit: "pallets", kind: "monthly_quantity" }, position: 3 }),
    rule({ id: "r-admin", key: "admin", name: "Account fee", category: "account", scope: "monthly", basis: "month", method: "flat", amount: "25.00", position: 4 }),
    rule({
      id: "r-min",
      key: "minimum",
      name: "Monthly minimum",
      category: "account",
      scope: "monthly",
      basis: "minimum",
      method: "minimum",
      minimum: { amount: "500", appliesTo: { categories: [], includeRuleKeys: [], excludeRuleKeys: [] }, includesShipping: false },
      resolvedRuleKeys: ["pick_order", "pack_box", "inserts", "storage_pallet"],
      position: 5,
    }),
  ],
};

const feeDictionary: FeeDictionaryEntry[] = [
  { ruleId: "r-pick", key: "pick_order", name: "Order pick", category: "pick_pack", basis: "order", scope: "order" },
  { ruleId: "r-box", key: "pack_box", name: "Box", category: "packaging", basis: "package", scope: "order" },
  { ruleId: "r-ins", key: "inserts", name: "Inserts", category: "other", basis: "order_driver", scope: "order" },
];
const PICK = 0;
const BOX = 1;
const INSERTS = 2;

function feeLine(index: number, amountE4: number, cls: "d" | "e" = "d"): CompactFeeLine {
  return [index, amountE4, cls];
}

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

/** A shipping-modeled order with one ok shipment of the given expected cost (dollars) and the given fee result. */
function modeledOrder(key: string, rowNo: number, orderDate: string | null, shippingExpected: string, orderFees: FoldOrderFees): FoldOrder {
  return {
    orderKey: key,
    orderDate,
    orderMonth: orderDate?.slice(0, 7) ?? null,
    cancelled: false,
    shipments: [
      {
        rowNo,
        packageCount: 1,
        serviceId: "svc-1",
        serviceName: "Ground",
        carrierCode: "ups",
        excludedReason: null,
        result: {
          status: "ok",
          unavailableReason: null,
          rateCardVersionId: "rcv-1",
          shipDate: orderDate ?? "2026-03-15",
          zone: "5",
          serviceId: "svc-1",
          billableLb: ["1"],
          definite: shippingExpected,
          estimated: "0.00",
          expected: shippingExpected,
          conditionalExposure: "0.00",
          unresolved: "0.00",
          lines: [[0, Math.round(Number(shippingExpected) * 100), "c", "d", 0]],
          warningCodes: [],
        },
        assumed: { residential: false, originZip: false, weight: false, dimensions: false },
        packagesWithoutDimensions: 0,
      },
    ],
    fees: orderFees,
  };
}

const A = modeledOrder("A", 1, "2026-03-03", "10.00", fees("ok", { lines: [feeLine(PICK, 15000), feeLine(BOX, 5000)] }));
const B = modeledOrder("B", 2, "2026-03-20", "12.00", fees("ok", { lines: [feeLine(PICK, 15000)] }));
const C = modeledOrder("C", 3, "2026-04-05", "20.00", fees("ok", { lines: [feeLine(PICK, 15000), feeLine(BOX, 10000)] }));
// D: inserts were not answered, so the rule could not be computed for it.
const D = modeledOrder("D", 4, "2026-04-18", "8.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "inserts", reason: "assumption_missing" }] }));
// D2: the same order with inserts answered (this order is one of the share that gets one).
const D2 = modeledOrder("D", 4, "2026-04-18", "8.00", fees("ok", { lines: [feeLine(PICK, 15000), feeLine(INSERTS, 2500, "e")] }));

const period: RunPeriod = {
  from: "2026-03-01",
  to: "2026-04-30",
  days: 61,
  months: "2.000000",
  population: 4,
  inPeriod: 4,
  trimmed: 0,
  undated: 0,
  volumeBasis: "file",
  monthlyOrders: "2.0000",
  monthlyUnits: null,
  monthProfile: [
    { month: "2026-03", fraction: "1.000000", orders: 2 },
    { month: "2026-04", fraction: "1.000000", orders: 2 },
  ],
};
const counts: DatasetCounts = { rows: 4, orders: 4, shipments: 4, packages: 4 };

function fold(orders: FoldOrder[]): PartialSummary {
  return foldBatch({ ...emptyPartial(), feeDictionary }, orders);
}

function input(overrides: Partial<FinalizeFeeInput> = {}): FinalizeFeeInput {
  return {
    mode: "modeled",
    feeEngineVersion: "1.0.0",
    monthlySchedule: schedule,
    answers: { drivers: { pallets: "10" }, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } },
    period,
    provenance: { scheduleName: "Standard fulfillment", versions: [{ versionId: "v-1", effectiveDate: "2026-01-01" }] },
    ...overrides,
  };
}

/** Completeness rows by category; the summary always lists every category exactly once. */
const byCategory = (s: ReturnType<typeof finalizeSummary>) => Object.fromEntries(s.fees.completeness.map((c) => [c.category, c])) as Record<FeeCategory, CategoryCompleteness>;

describe("finalizeSummary: completeness per category", () => {
  it("marks a category priced, not modeled (with the orders it could not be computed for) or not in the schedule", () => {
    const s = finalizeSummary(fold([A, B, C, D]), counts, [], "2.2.0", input());
    const c = byCategory(s);
    expect(s.fees.completeness.map((x) => x.category)).toEqual([...FEE_CATEGORIES]);
    expect(c.pick_pack).toEqual({ category: "pick_pack", state: "priced", notModeledOrders: 0, rules: [{ key: "pick_order", name: "Order pick", scope: "order", state: "priced", reason: null, describe: "$1.50 per order." }] });
    expect(c.packaging).toMatchObject({ state: "priced", notModeledOrders: 0, rules: [{ key: "pack_box", state: "priced", reason: null }] });
    expect(c.other).toEqual({ category: "other", state: "not_modeled", notModeledOrders: 1, rules: [{ key: "inserts", name: "Inserts", scope: "order", state: "not_modeled", reason: "assumption_missing", describe: "$0.25 per insert, on the share of orders you say get them." }] });
    expect(c.storage).toMatchObject({ state: "priced", rules: [{ key: "storage_pallet", scope: "monthly", state: "priced", reason: null, describe: "$18.00 per pallet per month." }] });
    // The minimum is reported through minimumStatus, not as a rate-bearing rule of its category.
    expect(c.account).toMatchObject({ state: "priced", rules: [{ key: "admin", scope: "monthly", state: "priced", describe: "$25.00 a month." }] });
    for (const category of ["kitting", "labeling", "receiving", "returns"] as const) expect(c[category]).toEqual({ category, state: "not_in_schedule", notModeledOrders: 0, rules: [] });
    // Customer-facing text never carries ids or version numbers.
    expect(JSON.stringify(s.fees.completeness)).not.toMatch(/r-pick|r-box|v-1/);
  });

  it("marks a monthly rule not modeled when its question was not answered, with the engine's reason", () => {
    const s = finalizeSummary(fold([A, B, C, D2]), counts, [], "2.2.0", input({ answers: { drivers: {}, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } } }));
    const c = byCategory(s);
    expect(c.storage).toMatchObject({ state: "not_modeled", notModeledOrders: 0, rules: [{ key: "storage_pallet", state: "not_modeled", reason: "no_answer" }] });
    expect(c.other).toMatchObject({ state: "priced" });
    expect(s.monthly?.notModeled.map((n) => n.ruleKey)).toEqual(["storage_pallet"]);
    expect(s.monthly?.lines.map((l) => [l.ruleKey, l.amountE4])).toEqual([["admin", 250000]]);
    expect(s.monthly?.totalE4).toBe(250000);
  });

  it("counts a packaging type no rule prices against the packaging category", () => {
    const tube = modeledOrder("T", 5, "2026-04-20", "9.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "packaging:tube", reason: "packaging_unmatched" }] }));
    const s = finalizeSummary(fold([A, B, C, D2, tube]), { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 }, [], "2.2.0", input());
    const c = byCategory(s);
    expect(c.packaging.state).toBe("not_modeled");
    expect(c.packaging.notModeledOrders).toBe(1);
    expect(c.packaging.rules.map((r) => [r.key, r.name, r.state, r.reason])).toEqual([
      ["pack_box", "Box", "priced", null],
      ["packaging:tube", "Packaging (tube)", "not_modeled", "packaging_unmatched"],
    ]);
  });

  it("reports every rule as not modeled when fees were skipped, and nothing in the schedule when the brand has none", () => {
    const skipped = finalizeSummary(fold([A, B, C, D2].map((o) => ({ ...o, fees: fees("skipped") }))), counts, [], "2.2.0", input({ mode: "skipped" }));
    expect(skipped.fees.mode).toBe("skipped");
    expect(skipped.fees.statusCounts).toEqual({ skipped: 4 });
    expect(skipped.fees.processing).toMatchObject({ orders: 0, definite: "0.0000", perOrder: null });
    expect(byCategory(skipped).pick_pack).toMatchObject({ state: "not_modeled", notModeledOrders: 0, rules: [{ key: "pick_order", state: "not_modeled", reason: "skipped" }] });
    expect(byCategory(skipped).kitting.state).toBe("not_in_schedule");
    expect(skipped.monthly).toBeNull();
    expect(skipped.minimums).toEqual([]);
    expect(skipped.minimumStatus).toBe("none");
    expect(skipped.allocation).toBeNull();

    const none = finalizeSummary(fold([A, B, C, D2].map((o) => ({ ...o, fees: fees("no_schedule") }))), counts, [], "2.2.0", input({ mode: "no_schedule", monthlySchedule: null, provenance: null }));
    expect(none.fees.statusCounts).toEqual({ no_schedule: 4 });
    expect(none.fees.completeness.every((c) => c.state === "not_in_schedule" && c.rules.length === 0)).toBe(true);
    expect(none.monthly).toBeNull();
    expect(none.minimumStatus).toBe("none");
    expect(none.allocation).toBeNull();
    expect(none.provenance).toBeNull();
  });
});

describe("finalizeSummary: monthly charges, minimums and allocation", () => {
  it("computes the monthly charges, an exact minimum top-up per calendar month and the allocation over the customer's volume", () => {
    const s = finalizeSummary(fold([A, B, C, D2]), counts, [], "2.2.0", input());
    expect(s.version).toBe(2);
    expect(s.feeEngineVersion).toBe("1.0.0");
    expect(s.fees.processing).toEqual({ orders: 4, definiteE4: 75000, estimatedE4: 2500, definite: "7.5000", estimated: "0.2500", expected: "7.7500", perOrder: "1.94" });
    // The database reconciles the top-level mirror of the processing figures.
    expect(s.processing).toEqual(s.fees.processing);
    expect(s.fees.byRule.map((r) => [r.key, r.definite, r.estimated, r.orders])).toEqual([
      ["pick_order", "6.0000", "0.0000", 4],
      ["pack_box", "1.5000", "0.0000", 2],
      ["inserts", "0.0000", "0.2500", 1],
    ]);
    // Monthly: 10 pallets × $18.00 + $25.00 flat.
    expect(s.monthly?.lines.map((l) => [l.ruleKey, l.quantity, l.amountE4, l.chargeClass])).toEqual([
      ["storage_pallet", "10", 1800000, "estimated"],
      ["admin", "1", 250000, "definite"],
    ]);
    expect(s.monthly?.totalE4).toBe(2050000);
    // Minimum $500 a month against pick + box + inserts + storage: March counts $3.00 + $0.50 + $180.00, April $3.00 + $1.00 + $0.25 + $180.00.
    expect(s.minimums).toHaveLength(1);
    const m = s.minimums[0]!;
    expect(m).toMatchObject({ ruleKey: "minimum", name: "Monthly minimum", status: "exact", minimumE4: 10000000, countedE4: 3677500, topUpE4: 6322500, reasons: [] });
    expect(m.buckets).toEqual([
      { month: "2026-03", minimumE4: 5000000, countedE4: 1835000, topUpE4: 3165000 },
      { month: "2026-04", minimumE4: 5000000, countedE4: 1842500, topUpE4: 3157500 },
    ]);
    expect(m.members.map((x) => [x.ruleKey, x.state])).toEqual([
      ["pick_order", "priced"],
      ["pack_box", "priced"],
      ["inserts", "priced"],
      ["storage_pallet", "priced"],
    ]);
    expect(s.minimumStatus).toBe("exact");
    // Allocation at 2 orders a month over 2 months, 100% coverage: shipping $50.00 / 4 × 2, processing $7.75 / 4 × 2, fixed $205.00, top-up $632.25 / 2.
    expect(s.allocation).toMatchObject({
      coveragePct: "100.0",
      extrapolated: false,
      monthly: { shipping: "25.00", processing: "3.88", fixed: "205.00", minimumTopUp: "316.13", total: "550.00", annual: "6600.00" },
      perOrder: { shipping: "12.50", processing: "1.94", allocated: "260.56", allIn: "275.00" },
    });
    expect(s.period).toEqual(period);
    expect(s.period).not.toBe(period);
    expect(s.provenance).toEqual({ scheduleName: "Standard fulfillment", versions: [{ versionId: "v-1", effectiveDate: "2026-01-01" }] });
  });

  it("makes the minimum an upper bound when a member rule could not be computed on a processing order, and leaves the top-up out of the allocation", () => {
    const s = finalizeSummary(fold([A, B, C, D]), counts, [], "2.2.0", input());
    const m = s.minimums[0]!;
    expect(m.status).toBe("upper_bound");
    expect(m.reasons).toEqual(["Inserts not modeled"]);
    expect(m.members.find((x) => x.ruleKey === "inserts")?.state).toBe("not_modeled");
    expect(m.topUpE4).toBe(6325000);
    expect(s.minimumStatus).toBe("upper_bound");
    expect(s.allocation?.monthly.minimumTopUp).toBeNull();
    expect(s.allocation?.monthly.total).toBe("233.75");
    expect(s.allocation?.perOrder.allocated).toBe("102.50");
    expect(s.allocation?.caveats).toContain("minimum_upper_bound");
  });

  it("makes an exact minimum an upper bound when processing orders have no date", () => {
    const undated = modeledOrder("U", 5, null, "5.00", fees("ok", { lines: [feeLine(PICK, 15000)] }));
    const s = finalizeSummary(fold([A, B, C, D2, undated]), { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 }, [], "2.2.0", input({ period: { ...period, population: 5, undated: 1 } }));
    expect(s.fees.processing.orders).toBe(5);
    const m = s.minimums[0]!;
    expect(m.status).toBe("upper_bound");
    expect(m.reasons).toEqual(["1 order without a date"]);
    // The undated order is in no calendar month: the buckets are unchanged.
    expect(m.topUpE4).toBe(6322500);
    expect(s.minimumStatus).toBe("upper_bound");
    expect(s.allocation?.monthly.minimumTopUp).toBeNull();
  });

  it("makes the minimum an upper bound when a member is unresolved on an order dated outside the period's months", () => {
    const outlier = modeledOrder("O", 5, "2026-07-01", "5.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "inserts", reason: "assumption_missing" }] }));
    const s = finalizeSummary(fold([A, B, C, D2, outlier]), { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 }, [], "2.2.0", input({ period: { ...period, population: 5, trimmed: 1 } }));
    const m = s.minimums[0]!;
    expect(m.status).toBe("upper_bound");
    expect(m.reasons).toEqual(["Inserts not modeled"]);
    expect(m.members.find((x) => x.ruleKey === "inserts")?.state).toBe("not_modeled");
    expect(m.buckets.map((b) => b.month)).toEqual(["2026-03", "2026-04"]);
  });

  it("folds minimum statuses: not computed without month data, with the top-up left out and the months defaulting to one", () => {
    const s = finalizeSummary(fold([A, B, C, D2]), counts, [], "2.2.0", input({ period: { ...period, from: null, to: null, days: null, months: null, monthlyOrders: null, volumeBasis: "none", monthProfile: [] } }));
    expect(s.minimums[0]).toMatchObject({ status: "not_computed", minimumE4: 0, countedE4: 0, topUpE4: 0, buckets: [] });
    expect(s.minimumStatus).toBe("not_computed");
    expect(s.allocation).toMatchObject({ monthly: { shipping: null, processing: null, fixed: "205.00", minimumTopUp: null, total: null, annual: null }, perOrder: { shipping: "12.50", processing: "1.94", allocated: null, allIn: null } });
    expect(s.allocation?.caveats).toContain("volume_unknown");
  });

  it("reports no minimum when the version has none, and then allocates with a zero top-up", () => {
    const noMinimum: FeeScheduleSnapshot = { ...schedule, rules: schedule.rules.filter((r) => r.basis !== "minimum") };
    const s = finalizeSummary(fold([A, B, C, D2]), counts, [], "2.2.0", input({ monthlySchedule: noMinimum }));
    expect(s.minimums).toEqual([]);
    expect(s.minimumStatus).toBe("none");
    // $25.00 + $3.875 + $205.00 = $233.875, rounded once; the annual figure is twelve times the exact total, rounded once.
    expect(s.allocation?.monthly).toEqual({ shipping: "25.00", processing: "3.88", fixed: "205.00", minimumTopUp: "0.00", total: "233.88", annual: "2806.50" });
    expect(byCategory(s).account).toMatchObject({ state: "priced" });
  });

  it("extrapolates monthly figures from the modeled average at 80% coverage or more, and reports 'at least' below", () => {
    // Three modeled orders of a population of five in March only: 60% coverage.
    const partial = fold([A, B, modeledOrder("E", 3, "2026-03-28", "8.00", fees("ok", { lines: [feeLine(PICK, 15000)] }))]);
    const low = finalizeSummary(partial, { rows: 5, orders: 5, shipments: 5, packages: 5 }, [], "2.2.0", input({ period: { ...period, to: "2026-03-31", days: 31, months: "1.000000", population: 5, inPeriod: 5, monthlyOrders: "5.0000", monthProfile: [{ month: "2026-03", fraction: "1.000000", orders: 5 }] } }));
    expect(low.allocation?.coveragePct).toBe("60.0");
    expect(low.allocation?.extrapolated).toBe(false);
    expect(low.allocation?.caveats).toContain("at_least");
    expect(low.minimums[0]?.status).toBe("upper_bound");
    expect(low.minimums[0]?.reasons).toEqual(["coverage 60.0% in 2026-03"]);
    // Four of five: 80%, extrapolated from the per-order averages.
    const partial4 = fold([A, B, C, D2]);
    const high = finalizeSummary(partial4, { rows: 5, orders: 5, shipments: 5, packages: 5 }, [], "2.2.0", input({ period: { ...period, population: 5, inPeriod: 5, monthlyOrders: "2.5000", monthProfile: [{ month: "2026-03", fraction: "1.000000", orders: 2 }, { month: "2026-04", fraction: "1.000000", orders: 3 }] } }));
    expect(high.allocation?.coveragePct).toBe("80.0");
    expect(high.allocation?.extrapolated).toBe(true);
    expect(high.allocation?.monthly.shipping).toBe("31.25");
    expect(high.minimums[0]?.reasons).toEqual(["coverage 66.7% in 2026-04"]);
  });

  it("refuses a partial summary of an older shape", () => {
    expect(() => finalizeSummary({ ...emptyPartial(), version: 1 } as unknown as PartialSummary, counts, [], "2.2.0", input())).toThrow(/not supported/);
  });
});
