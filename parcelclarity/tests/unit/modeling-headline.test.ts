import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateForecast, type ForecastAssumptions, type ForecastDeps, type ForecastSummary } from "@/engine/forecast";
import { FEE_ENGINE_VERSION, type FeeRule, type FeeScheduleSnapshot } from "@/engine/fees/types";
import { emptyPartial, finalizeSummary, foldBatch, type BulkSummary, type CompactFeeLine, type DatasetCounts, type FeeDictionaryEntry, type FeeStatus, type FinalizeFeeInput, type FoldOrder, type FoldOrderFees, type PartialSummary, type RunPeriod } from "@/engine/modeling";
import { ENGINE_VERSION } from "@/engine/types";
import { sha256Hex } from "@/lib/forecast/hash";
import {
  assumptionsLine,
  categoryName,
  compareFacts,
  defaultView,
  describeMinimumReason,
  diffForecastProfiles,
  feeScheduleLine,
  feeStatusSentences,
  feesChangedSince,
  headlineFigures,
  headlineText,
  isForecastSummary,
  joinWords,
  minimumViews,
  monthLabel,
  monthlyCharges,
  notIncludedGroups,
  orderFeeRows,
  orderRowFigures,
  parseView,
  ruleNameIndex,
  toCents,
  usd,
  volumeDiffers,
  volumeSensitivity,
} from "@/lib/modeling/headline";
import { fixtureContext } from "../fixtures/pricing/load";

/**
 * The headline function (design section 6, the F1 rule of section 10) and the pure helpers behind the
 * run page, hub, overview, list, compare and CSV headers. Summaries are produced by the real
 * `finalizeSummary` over a hand-built partial; every expectation below is derived by hand from the fixture:
 *
 *   orders A, B, C, D2: shipping $10 + $12 + $20 + $8 = $50.00; order fees $2.00 + $1.50 + $2.50 + $1.75 = $7.75
 *   2 orders a month over 2 months (Mar 1 to Apr 30, 2026), so V = 2 and 4 modeled orders
 *   monthly: shipping 50 x 2 / 4 = 25.00, order fees 7.75 x 2 / 4 = 3.875, storage 10 pallets x $18 = 180, account fee 25
 *   minimum $500 a month over pick, box, inserts, storage: March counts 183.50 (added 316.50), April 184.25 (added 315.75)
 */

// ---------------------------------------------------------------------------
// Fixture: the finalize test's small schedule
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
const noMinimum: FeeScheduleSnapshot = { ...schedule, rules: schedule.rules.filter((r) => r.basis !== "minimum") };

const feeDictionary: FeeDictionaryEntry[] = [
  { ruleId: "r-pick", key: "pick_order", name: "Order pick", category: "pick_pack", basis: "order", scope: "order" },
  { ruleId: "r-box", key: "pack_box", name: "Box", category: "packaging", basis: "package", scope: "order" },
  { ruleId: "r-ins", key: "inserts", name: "Inserts", category: "other", basis: "order_driver", scope: "order" },
];
const PICK = 0;
const BOX = 1;
const INSERTS = 2;

const feeLine = (index: number, amountE4: number, cls: "d" | "e" = "d"): CompactFeeLine => [index, amountE4, cls];

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

const finalize = (orders: FoldOrder[], over: Partial<FinalizeFeeInput> = {}, c: DatasetCounts = counts): BulkSummary => finalizeSummary(fold(orders), c, [], "2.2.0", input(over));

const ADD = "/portal/model/runs/run-1#run-again";

// The scenarios
const complete = finalize([A, B, C, D2]);
const noStorageAnswer = finalize([A, B, C, D2], { answers: { drivers: {}, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } } });
const noMinimumRun = finalize([A, B, C, D2], { monthlySchedule: noMinimum });
const undatedOrder = modeledOrder("U", 5, null, "5.00", fees("ok", { lines: [feeLine(PICK, 15000)] }));
const undated = finalize([A, B, C, D2, undatedOrder], { period: { ...period, population: 5, undated: 1 } }, { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 });
const orderE = modeledOrder("E", 3, "2026-03-28", "8.00", fees("ok", { lines: [feeLine(PICK, 15000)] }));
const lowCoverage = finalize([A, B, orderE], { period: { ...period, to: "2026-03-31", days: 31, months: "1.000000", population: 5, inPeriod: 5, monthlyOrders: "5.0000", monthProfile: [{ month: "2026-03", fraction: "1.000000", orders: 5 }] } }, { rows: 5, orders: 5, shipments: 5, packages: 5 });
const skipped = finalize([A, B, C, D2].map((o) => ({ ...o, fees: fees("skipped") })), { mode: "skipped" });
const noSchedule = finalize([A, B, C, D2].map((o) => ({ ...o, fees: fees("no_schedule") })), { mode: "no_schedule", monthlySchedule: null, provenance: null });
const noContent = finalize([A, B, C, D2].map((o) => ({ ...o, fees: fees("no_content", { unresolved: [{ ruleKey: "pick_order", reason: "units_unknown" }] }) })));
const notEffective = finalize([A, B, C, D2].map((o) => ({ ...o, fees: fees("not_effective") })));
const zeroVolume = finalize([A, B, C, D2], { period: { ...period, monthlyOrders: "0", volumeBasis: "stated" } });
const noVolume = finalize([A, B, C, D2], { period: { ...period, from: null, to: null, days: null, months: null, monthlyOrders: null, volumeBasis: "none", monthProfile: [] } });
const oneMonth = finalize([A, B], { period: { ...period, to: "2026-03-31", days: 31, months: "1.000000", population: 2, inPeriod: 2, monthlyOrders: "2.0000", monthProfile: [{ month: "2026-03", fraction: "1.000000", orders: 2 }] } }, { rows: 2, orders: 2, shipments: 2, packages: 2 });

// Returns processing scales with volume: 1,000 orders a month, 10 % returned at $3.00 each.
const withReturns: FeeScheduleSnapshot = {
  ...noMinimum,
  rules: [...noMinimum.rules, rule({ id: "r-ret", key: "returns_proc", name: "Returns processing", category: "returns", scope: "monthly", basis: "driver", method: "flat", amount: "3.00", driver: { key: "returns_rate", label: "Percent of orders returned", unit: "returns", kind: "returns_rate" }, position: 6 })],
};
const returnsRun = finalize([A, B, C, D2], { monthlySchedule: withReturns, answers: { drivers: { pallets: "10", returns_rate: "10" }, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } }, period: { ...period, monthlyOrders: "1000.0000" } });

// ---------------------------------------------------------------------------
// Forecasts: real summaries from the forecast engine over the fixture rate card and standard fee schedule
// ---------------------------------------------------------------------------
const schedules = JSON.parse(readFileSync(new URL("../fixtures/fees/schedules.json", import.meta.url), "utf8")) as Record<string, FeeScheduleSnapshot>;
const standard = schedules.standard!;
const UPS_GROUND = { serviceId: "svc-ups-ground", carrierCode: "ups", serviceCode: "ground", name: "UPS Ground" };
const USPS_GA = { serviceId: "svc-usps-ga", carrierCode: "usps", serviceCode: "ground_advantage", name: "USPS Ground Advantage" };

function forecastAssumptions(over: Partial<ForecastAssumptions> = {}): ForecastAssumptions {
  return {
    version: 1,
    monthlyOrders: "1250",
    asOfDate: "2026-03-15",
    originZip: "90001",
    parcels: [
      { weightLb: "1", lengthIn: "10", widthIn: "8", heightIn: "4", packagingType: "box", sharePct: "60" },
      { weightLb: "0.5", packagingType: "poly mailer", sharePct: "40", unknownSize: true },
    ],
    zones: [
      { zone: "2", sharePct: "50" },
      { zone: "5", sharePct: "30" },
      { zone: "8", sharePct: "20" },
    ],
    services: [
      { ...UPS_GROUND, sharePct: "70" },
      { ...USPS_GA, sharePct: "30" },
    ],
    residentialPct: "80",
    multiPackage: { pct: "10", packagesPerOrder: 2 },
    content: { rows: [{ units: 1, lines: 1, sharePct: "60" }, { units: 3, lines: 2, sharePct: "40" }] },
    fulfillment: {
      drivers: { pallets_stored: "10", long_term_pallets: "2", pallets_received: "4", cases_received: "20", returns_rate: "3" },
      orderShares: { inserts: { sharePct: "40", countPerOrder: 2 } },
      packagingDefault: null,
    },
    ...over,
  };
}

function forecast(assumptions: ForecastAssumptions = forecastAssumptions()): ForecastSummary {
  const deps: ForecastDeps = { pricing: fixtureContext(), schedule: standard, pinnedRates: {}, feeEngineVersion: FEE_ENGINE_VERSION, engineVersion: ENGINE_VERSION, hash: sha256Hex };
  const result = evaluateForecast(assumptions, deps);
  if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.summary;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
describe("formatting", () => {
  it("rounds to cents HALF_UP exactly once and groups thousands", () => {
    expect(toCents("2.675")).toBe("2.68");
    expect(toCents("12.3450")).toBe("12.35");
    expect(usd("1234.5")).toBe("$1,234.50");
    expect(usd("0.005")).toBe("$0.01");
    expect(usd("-3.1")).toBe("−$3.10");
    expect(usd("1000000")).toBe("$1,000,000.00");
  });

  it("never prints a missing amount as $0", () => {
    expect(usd(null)).toBe("—");
    expect(usd(undefined)).toBe("—");
  });

  it("words: month labels, lists, categories and the view parameter", () => {
    expect(monthLabel("2026-03")).toBe("Mar 2026");
    expect(monthLabel("average")).toBe("A typical month");
    expect(joinWords(["storage"])).toBe("storage");
    expect(joinWords(["storage", "receiving"])).toBe("storage and receiving");
    expect(joinWords(["storage", "receiving", "returns"])).toBe("storage, receiving and returns");
    expect(categoryName("kitting")).toBe("kitting & assembly");
    expect(parseView("allin")).toBe("allin");
    expect(parseView("fees")).toBe("fees");
    expect(parseView("shipping")).toBe("shipping");
    expect(parseView("everything")).toBeNull();
    expect(parseView(undefined)).toBeNull();
  });

  it("puts engine minimum reasons in plain words and never echoes text it does not know", () => {
    expect(describeMinimumReason("Pallet storage not modeled")).toBe("Pallet storage is not modeled");
    expect(describeMinimumReason("coverage 60.0% in 2026-03")).toBe("only 60.0% of the orders shipped in Mar 2026 could be priced");
    expect(describeMinimumReason("1 order without a date")).toBe("1 order has no date");
    expect(describeMinimumReason("3 orders without a date")).toBe("3 orders have no date");
    expect(describeMinimumReason("rule storage_pallet exploded")).toBe("something it counts could not be worked out");
  });

  it("says why orders have no fee figure, one sentence per status", () => {
    expect(feeStatusSentences({ ok: 10, no_content: 1, not_effective: 3 })).toEqual(["1 order has no item counts or order content to price fees from.", "3 orders were dated outside the fee schedule's dates."]);
    expect(feeStatusSentences({ ok: 4 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Headline: complete
// ---------------------------------------------------------------------------
describe("headlineFigures: a complete run", () => {
  const h = headlineFigures(complete, "allin", { addHref: ADD }, "brand");

  it("uses the plain label and an exact figure when every category is priced and the minimum is exact", () => {
    expect(h.label).toBe("All-in cost per order");
    expect(h.amount).toBe("275.00");
    expect(h.qualifier).toBe("");
    expect(h.complete).toBe(true);
    expect(h.unavailable).toBeNull();
    expect(h.notIncluded).toEqual([]);
    expect(h.minimumCouldAdd).toBeNull();
    expect(h.caveats).toEqual([]);
    expect(headlineText(h)).toBe("$275.00");
  });

  it("prints the basis of the allocated figure, and the split per order", () => {
    expect(h.basisSentence).toBe("2 orders a month over Mar 1, 2026–Apr 30, 2026 (2 months)");
    expect(h.parts).toEqual([
      { label: "Shipping", amount: "12.50", note: null },
      { label: "Order fees", amount: "1.94", note: null },
      { label: "Monthly charges, spread over your orders", amount: "260.56", note: "at 2 orders a month" },
    ]);
  });

  it("offers All-in by default, and the other two views carry their own labels", () => {
    expect(defaultView(complete)).toBe("allin");
    const fees = headlineFigures(complete, "fees");
    expect(fees).toMatchObject({ label: "Order fees per order", amount: "1.94", qualifier: "", complete: true, basisSentence: "Fees priced for 4 of 4 orders that could be priced" });
    const shipping = headlineFigures(complete, "shipping");
    expect(shipping).toMatchObject({ label: "Estimated shipping cost per order", amount: "12.50", qualifier: "", basisSentence: "Based on 4 of 4 orders (100.0%)" });
  });

  it("without a minimum rule the all-in is the same kind of exact figure", () => {
    const h2 = headlineFigures(noMinimumRun, "allin");
    // 25.00 + 3.875 + 205.00 = 233.875 a month over 2 orders = 116.9375
    expect(h2).toMatchObject({ label: "All-in cost per order", amount: "116.94", qualifier: "", complete: true, minimumCouldAdd: null });
  });
});

// ---------------------------------------------------------------------------
// Headline: missing storage numbers
// ---------------------------------------------------------------------------
describe("headlineFigures: a category left out because no numbers were given", () => {
  const h = headlineFigures(noStorageAnswer, "allin", { addHref: ADD }, "brand");

  it("names what is left out, says At least, and lists the rate with an Add link", () => {
    expect(h.label).toBe("All-in cost per order, without storage");
    // monthly 25.00 + 3.875 + 25.00 account fee (storage left out, minimum left out) = 53.875 over 2 orders
    expect(h.amount).toBe("26.94");
    expect(h.qualifier).toBe("At least");
    expect(h.complete).toBe(false);
    expect(headlineText(h)).toBe("At least $26.94");
    expect(h.notIncluded).toEqual([{ name: "Pallet storage", category: "storage", rate: "$18.00 per pallet per month.", reason: "no number was given", addHref: ADD }]);
    expect(defaultView(noStorageAnswer)).toBe("shipping");
  });

  it("states the account minimum it could not count: member not modeled makes it an upper bound", () => {
    // March 35,000 E4 counted of 5,000,000; April 42,500: top-ups 4,965,000 + 4,957,500 = $992.25 over 2 months = $496.125 a month
    expect(h.minimumCouldAdd).toEqual({
      perMonth: "496.13",
      perOrder: "248.06",
      sentence: "The account minimum could add up to $496.13 a month (about $248.06 per order) on top of this. It could not be worked out exactly: Pallet storage is not modeled.",
    });
  });

  it("leaves the add link off when the viewer cannot rerun", () => {
    const h2 = headlineFigures(noStorageAnswer, "allin");
    expect(h2.notIncluded).toEqual([{ name: "Pallet storage", category: "storage", rate: "$18.00 per pallet per month.", reason: "no number was given" }]);
  });

  it("the Order fees view is not diluted by a monthly gap: storage is a monthly charge", () => {
    const fees = headlineFigures(noStorageAnswer, "fees", { addHref: ADD });
    expect(fees).toMatchObject({ label: "Order fees per order", amount: "1.94", qualifier: "", complete: true, notIncluded: [] });
  });

  it("splits the group lists: numbers needed, not on the schedule, never included", () => {
    const g = notIncludedGroups(noStorageAnswer, { addHref: ADD }, "brand");
    expect(g.needNumbers.map((i) => i.name)).toEqual(["Pallet storage"]);
    expect(g.notOnSchedule.map((i) => i.label)).toEqual(["Kitting & assembly", "Labeling", "Receiving", "Returns"]);
    expect(g.notOnSchedule[0]?.detail).toBe("Your fee schedule has no kitting & assembly charge.");
    expect(g.neverIncluded).toEqual(["Special projects and anything else outside the fee schedule (these are quoted separately).", "Carrier adjustments billed after shipping, such as address corrections and reweighs.", "Taxes.", "Return shipping."]);
    expect(notIncludedGroups(noStorageAnswer, {}, "staff").notOnSchedule[0]?.detail).toBe("This customer's fee schedule has no kitting & assembly charge.");
  });
});

// ---------------------------------------------------------------------------
// F1: the minimum is an upper bound only through undated orders or coverage
// ---------------------------------------------------------------------------
describe("headlineFigures: F1, a minimum that is an upper bound through undated orders or coverage", () => {
  it("keeps the label and every category, reads At least, and says the minimum could add up to $X", () => {
    const h = headlineFigures(undated, "allin");
    // 5 processing orders, V = 2: shipping 55 x 2 / 5 = 22.00, order fees 9.25 x 2 / 5 = 3.70, fixed 205.00, top-up left out: 230.70 / 2 = 115.35
    expect(h.label).toBe("All-in cost per order");
    expect(h.amount).toBe("115.35");
    expect(h.qualifier).toBe("At least");
    expect(h.complete).toBe(false);
    expect(h.notIncluded).toEqual([]);
    expect(h.minimumCouldAdd).toEqual({
      perMonth: "316.13",
      perOrder: "158.06",
      sentence: "The account minimum could add up to $316.13 a month (about $158.06 per order) on top of this. It could not be worked out exactly: 1 order has no date.",
    });
    expect(defaultView(undated)).toBe("shipping");
  });

  it("coverage below 80 %: the figure counts only the orders that could be priced, so it is at least that", () => {
    const h = headlineFigures(lowCoverage, "allin");
    // 3 of 5 orders: shipping 30.00 and order fees 5.00 over one month, fixed 205.00: 240.00 / 5 orders = 48.00
    expect(h.label).toBe("All-in cost per order");
    expect(h.amount).toBe("48.00");
    expect(h.qualifier).toBe("At least");
    expect(h.caveats).toEqual(["Only 60.0% of your orders could be priced, so the monthly figures count just those orders: the real cost is at least this."]);
    // March: pick 4,500 scaled 5/3 = 7,500; box 500 scaled = 83.33 -> $0.83; storage 180.00: counted 1,883,300 E4 of 5,000,000 -> top-up $311.67
    expect(h.minimumCouldAdd?.perMonth).toBe("311.67");
    expect(h.minimumCouldAdd?.perOrder).toBe("62.33");
    expect(h.minimumCouldAdd?.sentence).toContain("only 60.0% of the orders shipped in Mar 2026 could be priced");
  });
});

// ---------------------------------------------------------------------------
// Skipped, no schedule, zero volume, no volume, nothing priced
// ---------------------------------------------------------------------------
describe("headlineFigures: fees skipped, no schedule, no volume, nothing priced", () => {
  it("skipped: shipping only, the all-in and fees views say why, and every rule is listed with its rate and an Add link", () => {
    for (const view of ["allin", "fees"] as const) {
      const h = headlineFigures(skipped, view, { addHref: ADD });
      expect(h.amount).toBeNull();
      expect(h.unavailable).toBe("Fulfillment costs were skipped for this model, so only shipping is shown.");
      expect(h.complete).toBe(false);
      expect(headlineText(h)).toBe("Not computed");
    }
    expect(headlineFigures(skipped, "shipping")).toMatchObject({ amount: "12.50", complete: true });
    expect(defaultView(skipped)).toBe("shipping");
    const g = notIncludedGroups(skipped, { addHref: ADD });
    expect(g.needNumbers.map((i) => [i.name, i.reason, i.addHref])).toEqual([
      ["Order pick", "fulfillment costs were skipped", ADD],
      ["Box", "fulfillment costs were skipped", ADD],
      ["Pallet storage", "fulfillment costs were skipped", ADD],
      ["Account fee", "fulfillment costs were skipped", ADD],
      ["Inserts", "fulfillment costs were skipped", ADD],
    ]);
  });

  it("no fee schedule: shipping only, with one line saying so", () => {
    const h = headlineFigures(noSchedule, "allin");
    expect(h).toMatchObject({ amount: null, unavailable: "No fee schedule was in effect for this model, so only shipping is shown.", parts: [] });
    expect(defaultView(noSchedule)).toBe("shipping");
    expect(notIncludedGroups(noSchedule)).toMatchObject({ needNumbers: [], notOnSchedule: [{ label: "Every fulfillment fee", detail: "No fee schedule was in effect for this model." }] });
    expect(monthlyCharges(noSchedule)).toBeNull();
    expect(minimumViews(noSchedule)).toEqual([]);
    expect(volumeSensitivity(noSchedule)).toEqual([]);
  });

  it("zero volume: the monthly charges are still listed, but no per-order figure exists", () => {
    const h = headlineFigures(zeroVolume, "allin");
    expect(h.amount).toBeNull();
    expect(h.unavailable).toBe("Your monthly order volume is 0, so charges cannot be spread per order.");
    expect(h.parts).toEqual([]);
    expect(h.basisSentence).toBe("Your monthly order volume is 0, so monthly charges are not spread over orders.");
    const m = monthlyCharges(zeroVolume)!;
    expect(m.totalPerMonth).toBe("205.00");
    expect(m.perOrder).toBeNull();
    expect(volumeSensitivity(zeroVolume)).toEqual([]);
  });

  it("no volume at all: says to state one rather than showing a figure", () => {
    const h = headlineFigures(noVolume, "allin");
    expect(h.amount).toBeNull();
    expect(h.unavailable).toBe("No monthly order volume is known, so monthly charges cannot be spread over your orders. State a volume and run the model again.");
    expect(h.basisSentence).toBe("No monthly volume is known, so monthly charges are not spread over your orders.");
    // The minimum could not be worked out without dates; the card says so and gives no dollar figure.
    expect(minimumViews(noVolume)[0]).toMatchObject({ status: "not_computed", couldAdd: "This minimum could not be worked out because no order in the file has a date. It is not included in the all-in figure." });
  });

  it("no order priced with fees: never an all-in made of monthly charges alone", () => {
    for (const run of [noContent, notEffective]) {
      for (const view of ["allin", "fees"] as const) {
        const h = headlineFigures(run, view);
        expect(h.amount).toBeNull();
        expect(h.complete).toBe(false);
      }
      expect(headlineFigures(run, "shipping").amount).toBe("12.50");
    }
    expect(headlineFigures(noContent, "allin").unavailable).toBe("No order could be priced with fees: there is no order content to price from.");
    expect(headlineFigures(notEffective, "fees").unavailable).toBe("No order could be priced with fees: no fee schedule was in effect on the order date.");
    // The rules are named as not modeled, with the reason, and "add" is offered for missing content.
    const g = notIncludedGroups(noContent, { addHref: ADD });
    expect(g.needNumbers.map((i) => i.name)).toEqual(["Order pick", "Box", "Inserts"]);
    expect(notIncludedGroups(notEffective, { addHref: ADD }).needNumbers).toEqual([]);
    expect(notIncludedGroups(notEffective, { addHref: ADD }).notOnSchedule.map((i) => i.label)).toEqual(expect.arrayContaining(["Order pick", "Box", "Inserts"]));
  });
});

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------
describe("volumeSensitivity", () => {
  it("reproduces the stored figures at 1x and scales shipping and order fees from exact totals", () => {
    // Exact monthly: shipping 25.00 + order fees 3.875 = 28.875; fixed 205.00 (storage 180 + account fee 25)
    expect(volumeSensitivity(noMinimumRun)).toEqual([
      { multiplier: "0.5", monthlyOrders: "1", monthlyTotal: "219.44", allInPerOrder: "219.44", known: true }, // 14.4375 + 205 = 219.4375
      { multiplier: "1", monthlyOrders: "2", monthlyTotal: "233.88", allInPerOrder: "116.94", known: true }, // stored
      { multiplier: "2", monthlyOrders: "4", monthlyTotal: "262.75", allInPerOrder: "65.69", known: true }, // 57.75 + 205 = 262.75; /4 = 65.6875
      { multiplier: "4", monthlyOrders: "8", monthlyTotal: "320.50", allInPerOrder: "40.06", known: true }, // 115.5 + 205 = 320.5; /8 = 40.0625
    ]);
  });

  it("scales only the monthly charges that follow volume (a returns rate)", () => {
    // V = 1,000: shipping 12,500 + order fees 1,937.50 = 14,437.50 variable; fixed 205.00; returns 100 x $3 = 300.00 scales with volume
    expect(volumeSensitivity(returnsRun)).toEqual([
      { multiplier: "0.5", monthlyOrders: "500", monthlyTotal: "7573.75", allInPerOrder: "15.15", known: true }, // 7,218.75 + 205 + 150 = 7,573.75; /500 = 15.1475
      { multiplier: "1", monthlyOrders: "1000", monthlyTotal: "14942.50", allInPerOrder: "14.94", known: true },
      { multiplier: "2", monthlyOrders: "2000", monthlyTotal: "29680.00", allInPerOrder: "14.84", known: true }, // 28,875 + 205 + 600
      { multiplier: "4", monthlyOrders: "4000", monthlyTotal: "59155.00", allInPerOrder: "14.79", known: true }, // 57,750 + 205 + 1,200 = 59,155; /4000 = 14.78875
    ]);
  });

  it("does not guess an account minimum that has to be re-evaluated per month: only the stated volume is known", () => {
    const points = volumeSensitivity(complete);
    expect(points.map((p) => [p.multiplier, p.known])).toEqual([["0.5", false], ["1", true], ["2", false], ["4", false]]);
    expect(points[1]).toMatchObject({ monthlyTotal: "550.00", allInPerOrder: "275.00" });
    expect(points[0]).toMatchObject({ monthlyTotal: null, allInPerOrder: null });
  });

  it("rejects a multiplier that is not a positive decimal", () => {
    expect(() => volumeSensitivity(noMinimumRun, ["0"])).toThrow(/positive decimal/);
    expect(() => volumeSensitivity(noMinimumRun, ["-1"])).toThrow(/positive decimal/);
  });
});

// ---------------------------------------------------------------------------
// Monthly charges
// ---------------------------------------------------------------------------
describe("monthlyCharges", () => {
  it("echoes the inputs of every line and splits fixed charges from the ones that follow volume", () => {
    const m = monthlyCharges(complete)!;
    expect(m.lines.map((l) => [l.name, l.quantity, l.unitAmount, l.amount, l.chargeClass, l.scalesWithVolume])).toEqual([
      ["Pallet storage", "10", "18.00", "180.00", "estimated", false],
      ["Account fee", "1", "25.00", "25.00", "definite", false],
    ]);
    expect(m.lines[0]?.explanation).toContain("10 pallets");
    expect(m.lines[0]?.explanation).toContain("$180.00");
    expect(m).toMatchObject({ fixedPerMonth: "205.00", volumeLinkedPerMonth: null, totalPerMonth: "205.00", perOrder: "102.50", notModeled: [] });
    expect(m.basisSentence).toBe("2 orders a month over Mar 1, 2026–Apr 30, 2026 (2 months)");
    // The per-order figure is the allocation's own (the minimum top-up is the next card's business).
    expect(complete.allocation?.perOrder.allocated).toBe("260.56");
  });

  it("lists a charge with no number given with its rate, never as $0", () => {
    const m = monthlyCharges(noStorageAnswer)!;
    expect(m.lines.map((l) => l.name)).toEqual(["Account fee"]);
    expect(m.notModeled).toEqual([{ name: "Pallet storage", category: "storage", rate: "$18.00 per pallet per month", reason: "no number was given", addable: true }]);
    expect(m.totalPerMonth).toBe("25.00");
  });

  it("separates the volume-linked part: $205.00 whatever you ship plus $300.00 that grows with orders", () => {
    const m = monthlyCharges(returnsRun)!;
    expect(m).toMatchObject({ fixedPerMonth: "205.00", volumeLinkedPerMonth: "300.00", totalPerMonth: "505.00", perOrder: "0.51" }); // 0.505, HALF_UP
    expect(returnsRun.allocation?.perOrder.allocated).toBe("0.51");
  });
});

// ---------------------------------------------------------------------------
// Order fees table and per-order rows
// ---------------------------------------------------------------------------
describe("orderFeeRows", () => {
  it("lists every order rule of the schedule with its rate, the totals by class and the orders charged", () => {
    expect(orderFeeRows(complete)).toEqual([
      { name: "Order pick", category: "pick_pack", rate: "$1.50 per order.", definite: "6.00", estimated: "0.00", orders: 4, notComputed: null, addable: false, replacedOrders: 0 },
      { name: "Box", category: "packaging", rate: expect.stringContaining("$0.50"), definite: "1.50", estimated: "0.00", orders: 2, notComputed: null, addable: false, replacedOrders: 0 },
      { name: "Inserts", category: "other", rate: expect.stringContaining("$0.25"), definite: "0.00", estimated: "0.25", orders: 1, notComputed: null, addable: false, replacedOrders: 0 },
    ]);
  });

  it("says how many orders a rule could not be computed on, and why", () => {
    const D = modeledOrder("D", 4, "2026-04-18", "8.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "inserts", reason: "assumption_missing" }] }));
    const rows = orderFeeRows(finalize([A, B, C, D]));
    expect(rows.find((r) => r.name === "Inserts")).toMatchObject({ orders: 0, notComputed: "1 order: no answer was given", addable: true });
  });

  it("turns an unmatched packaging type into a row named in words", () => {
    const tube = modeledOrder("T", 5, "2026-04-20", "9.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "packaging:tube", reason: "packaging_unmatched" }] }));
    const rows = orderFeeRows(finalize([A, B, C, D2, tube], {}, { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 }));
    expect(rows.find((r) => r.name === "Packaging (tube)")).toMatchObject({ rate: "No charge on the fee schedule covers this packaging type.", notComputed: "1 order: no charge on the fee schedule covers the packaging type", addable: false });
  });
});

describe("orderRowFigures", () => {
  const names = ruleNameIndex(complete);

  it("adds exact amounts and rounds once: $1.2345 of fees plus $2.50 of shipping is $3.73, fees alone $1.23", () => {
    const row = orderRowFigures({ feeStatus: "ok", definiteE4: 12345, estimatedE4: 0, shippingExpected: "2.50", unresolved: [] }, names);
    expect(row).toEqual({ shipping: "2.50", fees: "1.23", feesAtLeast: false, combined: "3.73", feeStatus: "priced", notComputed: null });
  });

  it("a rule that could not be computed makes the fees a lower bound and names the rule (a replaced rule is not a gap)", () => {
    const row = orderRowFigures({ feeStatus: "partial", definiteE4: 15000, estimatedE4: 0, shippingExpected: "8.00", unresolved: [{ ruleKey: "inserts", reason: "assumption_missing" }, { ruleKey: "pack_box", reason: "replaced" }] }, names);
    expect(row).toMatchObject({ fees: "1.50", feesAtLeast: true, combined: "9.50", feeStatus: "partly priced", notComputed: "Inserts" });
  });

  it("an order whose fees were not computed has no fee figure and no combined figure, with the reason", () => {
    const row = orderRowFigures({ feeStatus: "no_content", definiteE4: 0, estimatedE4: 0, shippingExpected: "8.00", unresolved: [] }, names);
    expect(row).toEqual({ shipping: "8.00", fees: null, feesAtLeast: false, combined: null, feeStatus: "not computed", notComputed: "There is no order content to price from" });
    expect(orderRowFigures({ feeStatus: "not_effective", definiteE4: 0, estimatedE4: 0, shippingExpected: null, unresolved: [] }, names).notComputed).toBe("No fee schedule was in effect on the order date");
  });

  it("an order whose shipping was not priced has fees but no combined figure", () => {
    const row = orderRowFigures({ feeStatus: "ok", definiteE4: 20000, estimatedE4: 0, shippingExpected: null, unresolved: [] }, names);
    expect(row).toMatchObject({ shipping: null, fees: "2.00", combined: null });
  });

  it("never prints a rule key, even for a key the summary does not know", () => {
    const row = orderRowFigures({ feeStatus: "partial", definiteE4: 0, estimatedE4: 0, shippingExpected: "1.00", unresolved: [{ ruleKey: "secret_rule_key", reason: "units_unknown" }] }, names);
    expect(row.notComputed).toBe("A fee");
  });
});

// ---------------------------------------------------------------------------
// Account minimum
// ---------------------------------------------------------------------------
describe("minimumViews", () => {
  it("shows an exact minimum month by month, with the average added, and marks every member", () => {
    const [m] = minimumViews(complete);
    expect(m).toMatchObject({ name: "Monthly minimum", status: "exact", includesShipping: false, oneLine: null, couldAdd: null, averageAdded: "316.13" });
    expect(m?.buckets).toEqual([
      { label: "Mar 2026", minimum: "500.00", counted: "183.50", added: "316.50", prorated: false },
      { label: "Apr 2026", minimum: "500.00", counted: "184.25", added: "315.75", prorated: false },
    ]);
    expect(m?.members.map((x) => [x.name, x.label])).toEqual([["Order pick", "Counted"], ["Box", "Counted"], ["Inserts", "Counted"], ["Pallet storage", "Counted"]]);
  });

  it("a one-month period reads as one line: fees counted, minimum, added", () => {
    const [m] = minimumViews(oneMonth);
    expect(m?.oneLine).toBe("Fees counted toward the minimum: $183.50 · Minimum: $500.00 · Added: $316.50");
  });

  it("an upper bound says what it could add at most and why it is not exact; the unmodeled member is marked", () => {
    const [m] = minimumViews(noStorageAnswer);
    expect(m).toMatchObject({ status: "upper_bound", buckets: [], oneLine: null, averageAdded: null, couldAdd: "This minimum could add up to $496.13 a month. It is not included in the all-in figure because it could not be worked out exactly: Pallet storage is not modeled." });
    expect(m?.members.find((x) => x.name === "Pallet storage")?.label).toBe("Not modeled");
  });

  it("names a member that left the schedule generically: the engine only knows its key", () => {
    const base = minimumViews(complete);
    expect(base).toHaveLength(1);
    const tampered = { ...complete, minimums: [{ ...complete.minimums[0]!, members: [{ ruleKey: "gone_rule_key", name: "gone_rule_key", state: "not_in_schedule" as const }] }] } as BulkSummary;
    const [m] = minimumViews(tampered);
    expect(m?.members).toEqual([{ name: "A charge that is no longer on the fee schedule", state: "not_in_schedule", label: "Not on your fee schedule" }]);
    expect(JSON.stringify(m)).not.toContain("gone_rule_key");
  });

  it("a run whose version has no minimum has nothing to show", () => {
    expect(minimumViews(noMinimumRun)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
describe("provenance lines", () => {
  it("names the tenant, the schedule and the date it came into effect", () => {
    expect(feeScheduleLine("Acme 3PL", complete.provenance)).toBe("Acme 3PL fee schedule 'Standard fulfillment', in effect from Jan 1, 2026");
    expect(feeScheduleLine("Acme 3PL", null)).toBeNull();
    expect(feeScheduleLine("Acme 3PL", { scheduleName: "Standard", versions: [{ effectiveDate: "2026-07-01" }, { effectiveDate: "2026-01-01" }] })).toBe("Acme 3PL fee schedule 'Standard', in effect from Jan 1, 2026 (with changes from Jul 1, 2026 for later orders)");
    expect(JSON.stringify(feeScheduleLine("Acme 3PL", complete.provenance))).not.toContain("v-1");
  });

  it("says who entered the assumptions", () => {
    expect(assumptionsLine("tenant", "Acme 3PL", "2026-10-14T09:00:00Z")).toBe("Assumptions entered by Acme 3PL on Oct 14, 2026");
    expect(assumptionsLine("you", "Acme 3PL", "2026-10-14T09:00:00Z")).toBe("Assumptions entered by you on Oct 14, 2026");
    expect(assumptionsLine("other", "Acme 3PL", "2026-10-14")).toBe("Assumptions entered by another user on Oct 14, 2026");
  });

  it("fees have changed when the version in effect today is not one the run was priced with", () => {
    expect(feesChangedSince(["v-1"], { status: "ok", versionId: "v-1" })).toBe(false);
    expect(feesChangedSince(["v-1"], { status: "ok", versionId: "v-2" })).toBe(true);
    expect(feesChangedSince(["v-1", "v-2"], { status: "ok", versionId: "v-2" })).toBe(false);
    expect(feesChangedSince(["v-1"], { status: "none" })).toBe(true);
    // A failed lookup is never reported as a change, and a run priced without fees has nothing to compare.
    expect(feesChangedSince(["v-1"], { status: "unknown" })).toBe(false);
    expect(feesChangedSince([], { status: "ok", versionId: "v-2" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------
describe("compareFacts", () => {
  it("states the basis of a file run, with the fee schedule date, what is left out and the minimum status", () => {
    const f = compareFacts(complete);
    expect(f).toMatchObject({
      source: "file",
      sourceText: "Orders file",
      ordersPerMonthText: "2 (from the file)",
      periodText: "Mar 1, 2026–Apr 30, 2026 (2 months)",
      feeScheduleText: "'Standard fulfillment', in effect from Jan 1, 2026",
      leftOutText: "Nothing left out",
      minimumText: "Adds $316.13 a month",
      shippingPerOrder: "12.50",
      feesPerOrder: "1.94",
      shippingPlusFees: "14.44",
      shippingPlusFeesAtLeast: false,
      monthlyChargesPerOrder: "260.56",
    });
    expect(f.allIn.amount).toBe("275.00");
  });

  it("two runs are only comparable on the all-in rows when they leave out the same things", () => {
    const a = compareFacts(complete);
    const b = compareFacts(noStorageAnswer);
    expect(a.allInSetKey).not.toBe(b.allInSetKey);
    expect(compareFacts(finalize([A, B, C, D2])).allInSetKey).toBe(a.allInSetKey);
    expect(b).toMatchObject({ leftOutText: "storage", minimumText: "Up to $496.13 a month, not included", shippingPlusFees: "14.44", shippingPlusFeesAtLeast: false });
  });

  it("skipped and no-schedule runs have shipping but no fee or all-in figures", () => {
    expect(compareFacts(skipped)).toMatchObject({ feeScheduleText: "Fulfillment costs skipped", leftOutText: "Every fulfillment fee (skipped)", minimumText: "No account minimum", shippingPlusFees: null, feesPerOrder: null, shippingPerOrder: "12.50" });
    expect(compareFacts(noSchedule)).toMatchObject({ feeScheduleText: "No fee schedule", leftOutText: "Every fulfillment fee (no fee schedule)", shippingPlusFees: null });
    expect(compareFacts(skipped).allInSetKey).not.toBe(compareFacts(noSchedule).allInSetKey);
  });

  it("a stated volume is labelled as stated", () => {
    expect(compareFacts(zeroVolume).ordersPerMonthText).toBe("0 (you stated it)");
    expect(compareFacts(noVolume).ordersPerMonthText).toBe("Not known");
  });

  it("flags volumes that differ by more than 5 % of the larger", () => {
    expect(volumeDiffers("1000", "1049")).toBe(false);
    expect(volumeDiffers("950", "1000")).toBe(false); // exactly 5 %
    expect(volumeDiffers("1000", "1060")).toBe(true);
    expect(volumeDiffers(null, "1000")).toBe(false);
    expect(volumeDiffers("0", "0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Forecasts from assumptions go through the same function
// ---------------------------------------------------------------------------
describe("forecast summaries", () => {
  const summary = forecast();

  it("is recognised, and its headline reads the stored allocation", () => {
    expect(isForecastSummary(summary)).toBe(true);
    expect(isForecastSummary(complete)).toBe(false);
    const h = headlineFigures(summary, "allin");
    expect(h.amount).toBe(summary.allocation!.perOrder.allIn);
    expect(h.basisSentence).toBe("1,250 orders a month, as described in the forecast");
    expect(h.caveats[0]).toMatch(/^A forecast from your assumptions/);
    expect(headlineFigures(summary, "shipping").amount).toBe(summary.shipping.perOrder);
    expect(headlineFigures(summary, "fees").amount).toBe(summary.processing!.perOrder);
    expect(headlineFigures(summary, "shipping").basisSentence).toBe("Forecast at 1,250 orders a month");
  });

  it("labels a forecast by its completeness exactly as a file run", () => {
    const complete = summary.completeness.every((c) => c.state !== "not_modeled");
    const h = headlineFigures(summary, "allin");
    if (complete && (summary.minimumStatus === "exact" || summary.minimumStatus === "none")) {
      expect(h.label).toBe("All-in cost per order");
      expect(h.qualifier).toBe("");
    }
    const noPallets = forecast(forecastAssumptions({ fulfillment: { ...forecastAssumptions().fulfillment, drivers: { pallets_stored: null, long_term_pallets: null, pallets_received: "4", cases_received: "20", returns_rate: "3" } } }));
    const h2 = headlineFigures(noPallets, "allin", { addHref: "/portal/model/forecast/p-1" });
    expect(h2.label).toMatch(/^All-in cost per order, without /);
    expect(h2.qualifier).toBe("At least");
    expect(h2.notIncluded.length).toBeGreaterThan(0);
    expect(h2.notIncluded.every((i) => i.addHref === "/portal/model/forecast/p-1")).toBe(true);
  });

  it("the sensitivity at 1x is the stored allocation, and the other rows re-evaluate the minimum in the engine", () => {
    const points = volumeSensitivity(summary);
    expect(points.map((p) => p.multiplier)).toEqual(["0.5", "1", "2", "4"]);
    expect(points[1]).toMatchObject({ monthlyOrders: "1250", monthlyTotal: summary.allocation!.monthly.total, allInPerOrder: summary.allocation!.perOrder.allIn, known: true });
    expect(points.every((p) => p.known)).toBe(true);
  });

  it("compare facts say it is a forecast over a typical month", () => {
    const f = compareFacts(summary);
    expect(f).toMatchObject({ source: "assumptions", sourceText: "Forecast from assumptions", periodText: "A typical month, as described", ordersPerMonthText: "1,250 (as described)" });
    expect(f.shippingPlusFees).not.toBeNull();
    expect(f.feeScheduleText).toContain("in effect from");
  });

  it("diffs two forecasts' assumptions in words", () => {
    const a = forecast().profile;
    const b = forecast(forecastAssumptions({ monthlyOrders: "1400", residentialPct: "60" })).profile;
    expect(diffForecastProfiles(a, b)).toEqual(["orders a month 1,250 → 1,400", "home deliveries 80% → 60%"]);
    expect(diffForecastProfiles(a, a)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Brand safety: nothing the customer sees carries a rule key, an id or a version
// ---------------------------------------------------------------------------
describe("customer-safe output", () => {
  const FORBIDDEN = /pick_order|pack_box|storage_pallet|returns_proc|packaging:[a-z_*]|\br-(pick|box|pallet|admin|min|ins|ret)\b|\bv-1\b|\bs-1\b/;
  const everything = (s: BulkSummary) =>
    JSON.stringify({
      headlines: (["shipping", "fees", "allin"] as const).map((v) => headlineFigures(s, v, { addHref: ADD }, "brand")),
      groups: notIncludedGroups(s, { addHref: ADD }, "brand"),
      monthly: monthlyCharges(s),
      rows: orderFeeRows(s),
      minimums: minimumViews(s),
      facts: compareFacts(s),
      sensitivity: volumeSensitivity(s),
      provenance: feeScheduleLine("Acme 3PL", s.provenance),
    });

  it("holds for every scenario", () => {
    for (const s of [complete, noStorageAnswer, noMinimumRun, undated, lowCoverage, skipped, noSchedule, noContent, notEffective, zeroVolume, noVolume, returnsRun]) {
      expect(everything(s)).not.toMatch(FORBIDDEN);
    }
  });

  it("holds for a packaging type nobody prices", () => {
    const tube = modeledOrder("T", 5, "2026-04-20", "9.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "packaging:tube", reason: "packaging_unmatched" }] }));
    const s = finalize([A, B, C, D2, tube], {}, { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 });
    expect(everything(s)).not.toMatch(FORBIDDEN);
    const h = headlineFigures(s, "allin", { addHref: ADD });
    expect(h.label).toBe("All-in cost per order, without packaging");
    // Not fixable by entering numbers, so it is listed as not covered by the schedule rather than offered an Add link.
    expect(h.notIncluded.map((i) => i.name)).not.toContain("Packaging (tube)");
    expect(notIncludedGroups(s, { addHref: ADD }).notOnSchedule.map((i) => i.label)).toContain("Packaging (tube)");
  });
});
