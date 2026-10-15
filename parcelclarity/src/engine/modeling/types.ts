import type { AllocationResult, E4, FeeBasis, FeeCategory, FeeScheduleSnapshot, FeeScope, FeeUnresolvedReason, FulfillmentAnswers, MinimumResult, MinimumStatus, MonthlyFeeResult } from "../fees/types";
import type { DecimalString, SurchargeCategory, UnavailableReason } from "../types";

/**
 * Bulk-modeling contracts (Milestone 3). Pure data: no I/O, no framework imports.
 *
 * A run prices every shipment of an order dataset with `calculateShipment`, stores each result in
 * the compact form below, and folds results into a running `PartialSummary` batch by batch so that
 * finishing a 20,000-shipment run never has to read every result back. `finalizeSummary` turns the
 * partial into the customer-facing `BulkSummary`. All money and weights are decimal strings; nothing
 * here uses floating point for sums.
 *
 * Counting rules (spec §9): rows, orders, shipments and packages are counted separately and never
 * conflated. An order is **modeled** only when it is not cancelled and every one of its shipments
 * priced with status `ok`; totals, averages and breakdowns cover modeled orders only. Orders that
 * could not be modeled stay in the denominator of coverage and are listed by reason. Conditional
 * exposure and unresolved amounts are never averaged per order.
 */

/** Line status codes stored per compact line: charged, included, waived, conditional, unknown. */
export type CompactLineStatus = "c" | "i" | "w" | "n" | "u";
/** Charge class codes: definite, estimated, conditional. */
export type CompactLineClass = "d" | "e" | "c";

/**
 * One itemised line in dictionary-encoded form:
 * `[dictionaryIndex, amountCents, status, class, packageIndex]` (packageIndex null = shipment level).
 * `amountCents` is an integer number of cents (exact for amounts rounded to cents by the engine).
 */
export type CompactLine = [number, number, CompactLineStatus, CompactLineClass, number | null];

/** What a dictionary index stands for. Entry 0 is always the base rate and entry 1 the minimum-charge adjustment. */
export interface LineDictionaryEntry {
  kind: "base" | "minimum" | "rule";
  key: string | null;
  version: number | null;
  versionId: string | null;
  name: string;
  category: SurchargeCategory | "base";
  /** Carrier-published (platform) rule or the 3PL's own configuration. Brand-safe: no source notes. */
  scope: "carrier" | "3pl" | null;
}

export interface CompactResult {
  status: "ok" | "unavailable";
  unavailableReason: UnavailableReason | null;
  rateCardVersionId: string | null;
  /** The date the shipment was actually priced on. */
  shipDate: string | null;
  zone: string | null;
  serviceId: string | null;
  /** Billable weight per package, as the engine reports it (decimal strings). */
  billableLb: DecimalString[];
  definite: DecimalString;
  estimated: DecimalString;
  expected: DecimalString;
  conditionalExposure: DecimalString;
  unresolved: DecimalString;
  lines: CompactLine[];
  /** Warning codes, optionally suffixed with the rule key: "zip_list_missing:ups.das". */
  warningCodes: string[];
}

/** Why a shipment was not sent to the engine at all (decided per run from validation issues and run settings). */
export type ExclusionReason =
  | "order_cancelled"
  | "date_missing"
  | "destination_missing"
  | "destination_invalid"
  | "destination_not_us"
  | "origin_missing"
  | "service_unmapped"
  | "weight_missing"
  | "weight_invalid"
  | "order_inconsistent"
  | "package_inconsistent"
  | "nothing_to_ship"
  | "sku_unknown"
  | "value_out_of_range"
  | "no_packages";

/** The engine's reasons plus pre-pricing exclusions, as they appear in the exclusions table. */
export type RunExclusion = ExclusionReason | UnavailableReason;

export interface AssumedFlags {
  residential: boolean;
  originZip: boolean;
  weight: boolean;
  dimensions: boolean;
}

export interface FoldShipment {
  rowNo: number;
  packageCount: number;
  serviceId: string | null;
  serviceName: string | null;
  carrierCode: string | null;
  /** Set when the shipment was excluded before pricing; `result` is then null. */
  excludedReason: ExclusionReason | null;
  result: CompactResult | null;
  assumed: AssumedFlags;
  /** Packages priced without dimensions (DIM not checked). */
  packagesWithoutDimensions: number;
}

// ---------------------------------------------------------------------------
// Fees (Milestone 4): one fee result per order, folded next to the shipping figures
// ---------------------------------------------------------------------------

/**
 * ok/partial/no_content: the fee engine ran (see OrderFeeResult.status); no_schedule: the brand has no
 * fee schedule; not_effective: none in effect on the fee date; date_missing: no fee date could be
 * determined (ship-date basis, undated order); skipped: the run modeled shipping only.
 */
export type FeeStatus = "ok" | "partial" | "no_content" | "no_schedule" | "not_effective" | "date_missing" | "skipped";

/** What a fee dictionary index stands for: one entry per rule id the run priced with (brand-safe: no sources or notes). */
export interface FeeDictionaryEntry {
  ruleId: string;
  key: string;
  name: string;
  category: FeeCategory;
  basis: FeeBasis;
  scope: FeeScope;
}

/** `[feeDictionaryIndex, amountE4, class]` with class d = definite, e = estimated. */
export type CompactFeeLine = [number, E4, "d" | "e"];

export interface FoldOrderFees {
  status: FeeStatus;
  lines: CompactFeeLine[];
  unresolved: { ruleKey: string; reason: FeeUnresolvedReason; replacedBy?: string }[];
  /** Order-level warning codes from the fee engine (fee_base_excludes_exposure, packaging_defaulted). */
  warnings: string[];
  definiteE4: E4;
  estimatedE4: E4;
  /** Which content quantities were assumed rather than read from the file. */
  assumed: { units?: boolean; lines?: boolean; skus?: boolean; packaging?: boolean };
}

/** A whole order; a batch never splits an order across folds. */
export interface FoldOrder {
  orderKey: string;
  orderDate: string | null;
  /** "YYYY-MM" of the order date, else of the first ship date; null when the order has neither (mirrors simulation_order_results.order_month). */
  orderMonth: string | null;
  cancelled: boolean;
  shipments: FoldShipment[];
  /** The order's fee result (always present in a v2 run; status says whether fees were modeled). */
  fees: FoldOrderFees;
}

export interface FeeRulePartial {
  ruleIds: string[];
  name: string;
  category: FeeCategory;
  basis: FeeBasis;
  scope: FeeScope;
  definiteE4: E4;
  estimatedE4: E4;
  /** Processing orders with at least one line of this rule, and lines in total. */
  orders: number;
  lines: number;
  /** Processing orders where this rule could not be computed, by reason (never "replaced"). */
  unresolvedOrders: number;
  unresolvedBy: Record<string, number>;
  /** Processing orders where this rule was replaced by another rule of its exclusive group. */
  replacedOrders: number;
}

export interface FeeMonthPartial {
  /** Processing orders (shipping-modeled and fee status ok or partial) dated in the month. */
  orders: number;
  /** Order-variable fee amounts of those orders per rule key, E4. */
  byRuleE4: Record<string, E4>;
  /** Expected shipping of those orders, E4 (cents × 100). */
  shippingExpectedE4: E4;
  /** Rule keys unresolved on at least one of those orders (reasons other than "replaced"). */
  unresolvedRuleKeys: string[];
}

/** Fee figures accumulated batch by batch. "Processing orders" = shipping-modeled orders whose fee status is ok or partial. */
export interface FeePartial {
  /** Fee status counts over shipping-modeled orders only (unmodeled orders are not counted here). */
  statusCounts: Partial<Record<FeeStatus, number>>;
  processing: { orders: number; definiteE4: E4; estimatedE4: E4 };
  byRule: Record<string, FeeRulePartial>;
  /** Keyed by "YYYY-MM" or "unknown" (undated orders). */
  byMonth: Record<string, FeeMonthPartial>;
  warnings: Record<string, number>;
  assumed: { units: number; lines: number; skus: number; packaging: number };
}

export interface MoneyBucket {
  definite: DecimalString;
  estimated: DecimalString;
  expected: DecimalString;
}

export interface CountBucket extends MoneyBucket {
  orders: number;
  shipments: number;
  packages: number;
}

export interface ServiceBucket extends CountBucket {
  serviceId: string;
  name: string;
  carrierCode: string;
}

export interface SurchargeBucket {
  key: string;
  name: string;
  category: SurchargeCategory;
  scope: "carrier" | "3pl";
  versions: number[];
  charged: { definite: DecimalString; estimated: DecimalString; shipments: number; packages: number; lines: number };
  unknown: { amount: DecimalString; shipments: number };
  conditional: { amount: DecimalString; shipments: number };
  included: { shipments: number };
  waived: { shipments: number };
}

/** Weight-bracket edges in lb; a package falls in the lowest bracket whose upper edge ≥ its billable weight. */
export const WEIGHT_BRACKET_EDGES: readonly DecimalString[] = ["1", "2", "3", "5", "10", "20", "50", "70", "150"] as const;
export type WeightBracketLabel = "≤1 lb" | "≤2 lb" | "≤3 lb" | "≤5 lb" | "≤10 lb" | "≤20 lb" | "≤50 lb" | "≤70 lb" | "≤150 lb" | ">150 lb";

/** Running state persisted after every batch (jsonb). Version it so a later engine can refuse to resume an older shape (the database refuses a v1 partial on a v2 run). */
export interface PartialSummary {
  version: 2;
  dictionary: LineDictionaryEntry[];
  /** Fee dictionary of the run (shared, appended by the batch core like `dictionary`). */
  feeDictionary: FeeDictionaryEntry[];
  fees: FeePartial;
  orders: { seen: number; modeled: number; cancelled: number };
  shipments: { seen: number; ok: number; unavailable: number; excludedBeforePricing: number; modeled: number };
  packages: { seen: number; modeled: number };
  /** Sums over modeled orders only. */
  totals: { definite: DecimalString; estimated: DecimalString; expected: DecimalString; conditionalExposure: DecimalString; unresolved: DecimalString };
  /** Shipments that priced ok inside orders that were not modeled (another shipment failed): shown, never summed into totals. */
  pricedButExcluded: { shipments: number; expected: DecimalString };
  /** Orders/shipments not modeled, by reason (an order is counted once, under its first failing shipment's reason). */
  exclusions: Record<string, { orders: number; shipments: number }>;
  byZone: Record<string, CountBucket>;
  byService: Record<string, ServiceBucket>;
  /** "YYYY-MM" of the order date, or "unknown". Volume and cost by month of order. */
  byMonth: Record<string, CountBucket>;
  /** Per-package lines by billable-weight bracket; shipment-level lines go to `shipmentLevel`. */
  byWeightBracket: Record<string, CountBucket>;
  shipmentLevel: MoneyBucket & { shipments: number };
  bySurcharge: Record<string, SurchargeBucket>;
  /** Engine warnings by code (optionally "code:ruleKey"), counted in shipments. */
  warnings: Record<string, { shipments: number }>;
  /** Shipments priced on assumed inputs, and packages priced without dimensions. */
  assumptions: { residential: number; originZip: number; weight: number; dimensions: number; packagesWithoutDimensions: number };
  /** Unresolved amounts grouped by what would resolve them. */
  unresolvedBy: Record<"dimensions_missing" | "zip_list_missing" | "other", { shipments: number; amount: DecimalString }>;
  /** Modeled shipments carrying a non-zero conditional / unresolved amount: the N in "up to X across N shipments". */
  exposureShipments: { conditional: number; unresolved: number };
  /** Distinct pricing-configuration problems met while loading (rule names, never keys); merged by the run loop, untouched by the fold. */
  loadIssues: string[];
}

export interface DatasetCounts {
  rows: number;
  orders: number;
  shipments: number;
  packages: number;
}

/** The forecast period and volume the run was started with (computed in SQL by start_simulation_run; never recomputed here). */
export interface RunPeriod {
  from: string | null;
  to: string | null;
  days: number | null;
  /** Calendar months covered, 6 dp, e.g. "2.838710"; null when no order is dated. */
  months: DecimalString | null;
  population: number;
  inPeriod: number;
  trimmed: number;
  undated: number;
  volumeBasis: "file" | "stated" | "none";
  monthlyOrders: DecimalString | null;
  monthlyUnits: DecimalString | null;
  /** One entry per calendar month touched by the period: covered fraction and orders the customer shipped in it. */
  monthProfile: { month: string; fraction: DecimalString; orders: number }[];
}

/** What `finalizeSummary` needs beyond the partial to produce the fee sections (read from the run row and the pinned version). */
export interface FinalizeFeeInput {
  mode: "modeled" | "skipped" | "no_schedule";
  feeEngineVersion: string;
  /** The version pinned for monthly components (null when none is in effect). */
  monthlySchedule: FeeScheduleSnapshot | null;
  answers: FulfillmentAnswers;
  period: RunPeriod;
  /** Fee schedule provenance for the customer: name and the version(s) orders were priced with. */
  provenance: { scheduleName: string; versions: { versionId: string; effectiveDate: string }[] } | null;
}

export type CompletenessState = "priced" | "not_modeled" | "not_in_schedule";

export interface CategoryCompleteness {
  category: FeeCategory;
  state: CompletenessState;
  /** Processing orders on which at least one rule of this category could not be computed. */
  notModeledOrders: number;
  rules: { key: string; name: string; scope: FeeScope; state: CompletenessState; reason: string | null; describe: string }[];
}

export interface FeeSummary {
  mode: FinalizeFeeInput["mode"];
  statusCounts: Partial<Record<FeeStatus, number>>;
  /** Over processing orders. definite/estimated carry four decimals (exact E4 → dollars); perOrder is HALF_UP to cents, null when there are none. */
  processing: { orders: number; definiteE4: E4; estimatedE4: E4; definite: DecimalString; estimated: DecimalString; expected: DecimalString; perOrder: DecimalString | null };
  byRule: Array<FeeRulePartial & { key: string; definite: DecimalString; estimated: DecimalString }>;
  completeness: CategoryCompleteness[];
  warnings: { code: string; orders: number }[];
  assumed: FeePartial["assumed"];
}

export interface BulkSummary {
  version: 2;
  engineVersion: string;
  feeEngineVersion: string;
  imported: DatasetCounts;
  modeled: { orders: number; shipments: number; packages: number };
  /** Percentages with one decimal, as decimal strings ("95.2"). */
  coverage: { ordersPct: DecimalString; shipmentsPct: DecimalString };
  totals: PartialSummary["totals"];
  /** HALF_UP to cents; null when the denominator is zero. */
  averages: {
    expectedPerOrder: DecimalString | null;
    expectedPerShipment: DecimalString | null;
    expectedPerPackage: DecimalString | null;
    definitePerOrder: DecimalString | null;
  };
  /** Upper bounds, never averaged: "up to X if every possible adjustment applied". */
  exposure: { conditional: { amount: DecimalString; shipments: number }; unresolved: { amount: DecimalString; shipments: number; by: PartialSummary["unresolvedBy"] } };
  pricedButExcluded: PartialSummary["pricedButExcluded"];
  exclusions: Array<{ reason: string; orders: number; shipments: number; ordersPct: DecimalString }>;
  byZone: Array<CountBucket & { zone: string; sharePct: DecimalString }>;
  byService: Array<ServiceBucket & { sharePct: DecimalString }>;
  byMonth: Array<CountBucket & { month: string; sharePct: DecimalString }>;
  byWeightBracket: Array<CountBucket & { bracket: string; sharePct: DecimalString }>;
  shipmentLevel: PartialSummary["shipmentLevel"];
  bySurcharge: SurchargeBucket[];
  warnings: Array<{ code: string; ruleKey: string | null; shipments: number }>;
  /** Configuration problems found while loading pricing contexts (rule versions that could not be applied). */
  loadIssues: string[];
  assumptions: PartialSummary["assumptions"];
  dictionary: LineDictionaryEntry[];
  // --- Milestone 4: fees, monthly charges, minimums, period and allocation ---
  feeDictionary: FeeDictionaryEntry[];
  fees: FeeSummary;
  /** Monthly charges from the customer's answers (null when fees were not modeled or no version is in effect). */
  monthly: MonthlyFeeResult | null;
  /** Account minimums of the monthly version; `minimumStatus` folds them into one word ("none" when the version has no minimum). */
  minimums: MinimumResult[];
  minimumStatus: MinimumStatus | "none";
  period: RunPeriod;
  /** Monthly and per-order figures over processing orders; null when fees were not modeled. */
  allocation: AllocationResult | null;
  provenance: FinalizeFeeInput["provenance"];
}
