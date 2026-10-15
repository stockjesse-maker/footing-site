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

/** A whole order; a batch never splits an order across folds. */
export interface FoldOrder {
  orderKey: string;
  orderDate: string | null;
  cancelled: boolean;
  shipments: FoldShipment[];
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

/** Running state persisted after every batch (jsonb). Version it so a later engine can refuse to resume an older shape. */
export interface PartialSummary {
  version: 1;
  dictionary: LineDictionaryEntry[];
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
}

export interface DatasetCounts {
  rows: number;
  orders: number;
  shipments: number;
  packages: number;
}

export interface BulkSummary {
  engineVersion: string;
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
}
