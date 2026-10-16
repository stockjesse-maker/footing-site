import { readFileSync } from "node:fs";
import { evaluateForecast, type ForecastAssumptions, type ForecastDeps, type ForecastSummary } from "@/engine/forecast";
import { FEE_ENGINE_VERSION, type FeeRule, type FeeScheduleSnapshot } from "@/engine/fees/types";
import { emptyPartial, finalizeSummary, foldBatch, type BulkSummary, type CompactFeeLine, type DatasetCounts, type FeeDictionaryEntry, type FeeStatus, type FinalizeFeeInput, type FoldOrder, type FoldOrderFees, type PartialSummary, type RunPeriod } from "@/engine/modeling";
import { ENGINE_VERSION } from "@/engine/types";
import { sha256Hex } from "@/lib/forecast/hash";
import { fixtureContext } from "../pricing/load";

/**
 * Fee-aware run summaries for the results tests: real `finalizeSummary` output over a hand-built partial,
 * and real forecast summaries over the fixture rate card and standard fee schedule. Every expectation in
 * the tests that use them is derived by hand from the numbers below:
 *
 *   orders A, B, C, D2: shipping $10 + $12 + $20 + $8 = $50.00; order fees $2.00 + $1.50 + $2.50 + $1.75 = $7.75
 *   2 orders a month over 2 months (Mar 1 to Apr 30, 2026), so V = 2 and 4 modeled orders
 *   monthly: shipping 50 x 2 / 4 = 25.00, order fees 7.75 x 2 / 4 = 3.875, storage 10 pallets x $18 = 180, account fee 25
 *   minimum $500 a month over pick, box, inserts, storage: March counts 183.50 (added 316.50), April 184.25 (added 315.75)
 */

// ---------------------------------------------------------------------------
// Fixture: the finalize test's small schedule
// ---------------------------------------------------------------------------
export function rule(r: Partial<FeeRule> & Pick<FeeRule, "id" | "key" | "name" | "category" | "scope" | "basis" | "method" | "position">): FeeRule {
  return { amount: null, percent: null, ...r };
}

export const schedule: FeeScheduleSnapshot = {
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
export const noMinimum: FeeScheduleSnapshot = { ...schedule, rules: schedule.rules.filter((r) => r.basis !== "minimum") };

export const feeDictionary: FeeDictionaryEntry[] = [
  { ruleId: "r-pick", key: "pick_order", name: "Order pick", category: "pick_pack", basis: "order", scope: "order" },
  { ruleId: "r-box", key: "pack_box", name: "Box", category: "packaging", basis: "package", scope: "order" },
  { ruleId: "r-ins", key: "inserts", name: "Inserts", category: "other", basis: "order_driver", scope: "order" },
];
export const PICK = 0;
export const BOX = 1;
export const INSERTS = 2;

export const feeLine = (index: number, amountE4: number, cls: "d" | "e" = "d"): CompactFeeLine => [index, amountE4, cls];

export function fees(status: FeeStatus, opts: Partial<Omit<FoldOrderFees, "status" | "definiteE4" | "estimatedE4">> = {}): FoldOrderFees {
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

export function modeledOrder(key: string, rowNo: number, orderDate: string | null, shippingExpected: string, orderFees: FoldOrderFees): FoldOrder {
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

export const A = modeledOrder("A", 1, "2026-03-03", "10.00", fees("ok", { lines: [feeLine(PICK, 15000), feeLine(BOX, 5000)] }));
export const B = modeledOrder("B", 2, "2026-03-20", "12.00", fees("ok", { lines: [feeLine(PICK, 15000)] }));
export const C = modeledOrder("C", 3, "2026-04-05", "20.00", fees("ok", { lines: [feeLine(PICK, 15000), feeLine(BOX, 10000)] }));
export const D2 = modeledOrder("D", 4, "2026-04-18", "8.00", fees("ok", { lines: [feeLine(PICK, 15000), feeLine(INSERTS, 2500, "e")] }));

export const period: RunPeriod = {
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
export const counts: DatasetCounts = { rows: 4, orders: 4, shipments: 4, packages: 4 };

export function fold(orders: FoldOrder[]): PartialSummary {
  return foldBatch({ ...emptyPartial(), feeDictionary }, orders);
}

export function input(overrides: Partial<FinalizeFeeInput> = {}): FinalizeFeeInput {
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

export const finalize = (orders: FoldOrder[], over: Partial<FinalizeFeeInput> = {}, c: DatasetCounts = counts): BulkSummary => finalizeSummary(fold(orders), c, [], "2.2.0", input(over));

export const ADD = "/portal/model/runs/run-1#run-again";

// The scenarios
export const complete = finalize([A, B, C, D2]);
export const noStorageAnswer = finalize([A, B, C, D2], { answers: { drivers: {}, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } } });
export const noMinimumRun = finalize([A, B, C, D2], { monthlySchedule: noMinimum });
export const undatedOrder = modeledOrder("U", 5, null, "5.00", fees("ok", { lines: [feeLine(PICK, 15000)] }));
export const undated = finalize([A, B, C, D2, undatedOrder], { period: { ...period, population: 5, undated: 1 } }, { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 });
export const orderE = modeledOrder("E", 3, "2026-03-28", "8.00", fees("ok", { lines: [feeLine(PICK, 15000)] }));
export const lowCoverage = finalize([A, B, orderE], { period: { ...period, to: "2026-03-31", days: 31, months: "1.000000", population: 5, inPeriod: 5, monthlyOrders: "5.0000", monthProfile: [{ month: "2026-03", fraction: "1.000000", orders: 5 }] } }, { rows: 5, orders: 5, shipments: 5, packages: 5 });
export const skipped = finalize([A, B, C, D2].map((o) => ({ ...o, fees: fees("skipped") })), { mode: "skipped" });
export const noSchedule = finalize([A, B, C, D2].map((o) => ({ ...o, fees: fees("no_schedule") })), { mode: "no_schedule", monthlySchedule: null, provenance: null });
export const noContent = finalize([A, B, C, D2].map((o) => ({ ...o, fees: fees("no_content", { unresolved: [{ ruleKey: "pick_order", reason: "units_unknown" }] }) })));
export const notEffective = finalize([A, B, C, D2].map((o) => ({ ...o, fees: fees("not_effective") })));
export const zeroVolume = finalize([A, B, C, D2], { period: { ...period, monthlyOrders: "0", volumeBasis: "stated" } });
export const noVolume = finalize([A, B, C, D2], { period: { ...period, from: null, to: null, days: null, months: null, monthlyOrders: null, volumeBasis: "none", monthProfile: [] } });
export const oneMonth = finalize([A, B], { period: { ...period, to: "2026-03-31", days: 31, months: "1.000000", population: 2, inPeriod: 2, monthlyOrders: "2.0000", monthProfile: [{ month: "2026-03", fraction: "1.000000", orders: 2 }] } }, { rows: 2, orders: 2, shipments: 2, packages: 2 });

// Returns processing scales with volume: 1,000 orders a month, 10 % returned at $3.00 each.
export const withReturns: FeeScheduleSnapshot = {
  ...noMinimum,
  rules: [...noMinimum.rules, rule({ id: "r-ret", key: "returns_proc", name: "Returns processing", category: "returns", scope: "monthly", basis: "driver", method: "flat", amount: "3.00", driver: { key: "returns_rate", label: "Percent of orders returned", unit: "returns", kind: "returns_rate" }, position: 6 })],
};
export const returnsRun = finalize([A, B, C, D2], { monthlySchedule: withReturns, answers: { drivers: { pallets: "10", returns_rate: "10" }, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } }, period: { ...period, monthlyOrders: "1000.0000" } });

// ---------------------------------------------------------------------------
// Forecasts: real summaries from the forecast engine over the fixture rate card and standard fee schedule
// ---------------------------------------------------------------------------
export const schedules = JSON.parse(readFileSync(new URL("../fees/schedules.json", import.meta.url), "utf8")) as Record<string, FeeScheduleSnapshot>;
export const standard = schedules.standard!;
export const UPS_GROUND = { serviceId: "svc-ups-ground", carrierCode: "ups", serviceCode: "ground", name: "UPS Ground" };
export const USPS_GA = { serviceId: "svc-usps-ga", carrierCode: "usps", serviceCode: "ground_advantage", name: "USPS Ground Advantage" };

export function forecastAssumptions(over: Partial<ForecastAssumptions> = {}): ForecastAssumptions {
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

export function forecast(assumptions: ForecastAssumptions = forecastAssumptions(), options: { priceOnlyCovered?: boolean } = {}): ForecastSummary {
  const deps: ForecastDeps = { pricing: fixtureContext(), schedule: standard, pinnedRates: {}, feeEngineVersion: FEE_ENGINE_VERSION, engineVersion: ENGINE_VERSION, hash: sha256Hex };
  const result = evaluateForecast(assumptions, deps, options);
  if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.summary;
}


/** A forecast saved with "price only what the rate card covers" whose zone 9 the rate card does not price: 80.00% of the volume is priced. */
export const partialForecast = (): ForecastSummary =>
  forecast(forecastAssumptions({ zones: [{ zone: "2", sharePct: "40" }, { zone: "5", sharePct: "24" }, { zone: "8", sharePct: "16" }, { zone: "9", sharePct: "20" }] }), { priceOnlyCovered: true });
