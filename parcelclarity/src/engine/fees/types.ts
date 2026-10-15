import type { DecimalString } from "../types";

/**
 * Fulfillment fee engine: public contracts (Milestone 4). Pure data, no I/O.
 *
 * A **fee schedule** is the 3PL's customer-facing list of processing charges, versioned like a
 * rate card. Every rule here is a charge the 3PL authored; the engine never invents an amount.
 * Order-scope rules are computed per order from the order's own data (units, lines, SKUs,
 * packages, shipments, shipping cost); monthly-scope rules are computed per forecast month from
 * quantities the customer stated (pallets stored, pallets received, …). Where an input is unknown
 * and nothing was assumed, the rule is **not computed** for that order and is reported as such:
 * never as a definite $0.
 *
 * Money: fee line amounts are carried as integer ten-thousandths of a dollar (E4) so a rate with
 * four decimals ($0.0125 per unit) is exact; aggregates are rounded HALF_UP to cents once.
 */

export const FEE_ENGINE_VERSION = "1.0.0";

/** Integer number of ten-thousandths of a dollar: 12500 = $1.25. */
export type E4 = number;

export type FeeCategory = "pick_pack" | "packaging" | "kitting" | "labeling" | "receiving" | "storage" | "returns" | "account" | "other";
export const FEE_CATEGORIES: readonly FeeCategory[] = ["pick_pack", "packaging", "kitting", "labeling", "receiving", "storage", "returns", "account", "other"];

export type FeeScope = "order" | "monthly";

/**
 * What one unit of the charge is. Order scope: `order` (1 per order), `unit`, `line` (order lines
 * with units > 0), `sku` (distinct non-null SKUs), `package`, `shipment`, `shipping_percent`
 * (a percentage of the order's shipping cost), `order_driver` (a per-order quantity the customer
 * states as a share of orders and a count per qualifying order: inserts, kits, labels). Monthly
 * scope: `month` (flat per month), `driver` (a stated monthly quantity), `minimum` (account minimum).
 */
export type FeeBasis = "order" | "unit" | "line" | "sku" | "package" | "shipment" | "shipping_percent" | "order_driver" | "month" | "driver" | "minimum";
export const ORDER_BASES: readonly FeeBasis[] = ["order", "unit", "line", "sku", "package", "shipment", "shipping_percent", "order_driver"];
export const MONTHLY_BASES: readonly FeeBasis[] = ["month", "driver", "minimum"];

export type FeeMethod = "flat" | "tiered" | "percent" | "minimum";

export type IncludedPer = "order" | "line" | "sku" | "shipment";

export interface FeeTierBracket {
  /** Inclusive upper edge of the bracket; null for the open-ended last bracket. */
  upTo: DecimalString | null;
  amount: DecimalString;
}

export interface FeeTiers {
  /** The quantity the brackets are read against: this order's own quantity, or the month's total of the rule's basis. */
  on: "order_quantity" | "monthly_quantity";
  /** graduated: each bracket priced at its own rate; volume: the whole quantity at the rate of the bracket it falls in. */
  mode: "graduated" | "volume";
  /** rate: `amount` is per unit of the basis; flat: `amount` is the whole price for a quantity in the bracket (volume mode only). */
  pricing: "rate" | "flat";
  brackets: FeeTierBracket[];
}

export interface FeeConditions {
  minUnits?: number;
  maxUnits?: number;
  minLines?: number;
  maxLines?: number;
  minPackages?: number;
  maxPackages?: number;
  /** Normalised packaging types (lower case, trimmed, single spaces); "*" matches every package with a type. */
  packagingTypes?: string[];
}

export type BillingPeriod = "month" | "week" | "day";

export interface FeeDriver {
  /** Stable key of the question the customer answers; several rules may share one. */
  key: string;
  /** The question, in the customer's words ("Pallets of your products stored, on average"). */
  label: string;
  /** Unit word for the answer ("pallets", "cases", "returns"). */
  unit: string;
  /** monthly_quantity: a number per month; order_share: a share of orders and a count per qualifying order; returns_rate: percent of orders that come back. */
  kind: "monthly_quantity" | "order_share" | "returns_rate";
  /** For monthly quantities billed per week or per day (converted with 30.4375 days a month). */
  billingPeriod?: BillingPeriod;
  /** Long-term storage: `replace` bills these units at this rule's rate instead of the standard rule's; `surcharge` adds to it. */
  longTerm?: { mode: "replace" | "surcharge"; replacesRuleKey: string; thresholdDays: number };
}

export interface FeeMinimum {
  amount: DecimalString;
  appliesTo: { categories: FeeCategory[]; includeRuleKeys: string[]; excludeRuleKeys: string[] };
  /** When true the customer's expected shipping charges count toward the minimum too. */
  includesShipping: boolean;
}

export interface FeeRule {
  /** Database id of the rule when the snapshot came from the database (absent in fixtures). Never shown to customers. */
  id?: string;
  key: string;
  name: string;
  category: FeeCategory;
  scope: FeeScope;
  basis: FeeBasis;
  method: FeeMethod;
  amount: DecimalString | null;
  percent: DecimalString | null;
  /** shipping_percent only: what the percentage is taken of. */
  percentBase?: "shipping_total" | "base_freight";
  tiers?: FeeTiers | null;
  /** Free allowance subtracted from the quantity, per `includedPer` (null = once per order/month). */
  includedQuantity?: DecimalString | null;
  includedPer?: IncludedPer | null;
  /** Charged instead of the computed amount when that is lower and the chargeable quantity is above zero. */
  minimumCharge?: DecimalString | null;
  conditions?: FeeConditions | null;
  /** Rules in one group compete: the lowest priority that applies is charged, the others are listed as replaced. */
  exclusiveGroup?: string | null;
  priority?: number;
  driver?: FeeDriver | null;
  minimum?: FeeMinimum | null;
  /** Resolved at activation from `minimum.appliesTo`: the rule keys the minimum is measured against. */
  resolvedRuleKeys?: string[] | null;
  /** Customer-visible wording the 3PL added. */
  description?: string | null;
  helpText?: string | null;
  position: number;
}

export interface FeeScheduleSnapshot {
  scheduleId: string;
  name: string;
  versionId: string;
  versionNumber: number;
  effectiveDate: string;
  expirationDate: string | null;
  /** invoice_line: lines carried exactly and rounded at monthly aggregates; transaction: each order line rounded to cents. */
  rounding: "invoice_line" | "transaction";
  rules: FeeRule[];
}

// ---------------------------------------------------------------------------
// Order-scope inputs and results
// ---------------------------------------------------------------------------

/** Shipping figures of the order as the shipping engine produced them, for percent-of-shipping rules. */
export interface OrderShippingInput {
  /** Counted definite + estimated shipping lines of every shipment, in E4. */
  totalE4: E4;
  /** Base-rate and minimum-charge lines only, in E4. */
  baseFreightE4: E4;
  /** True when any counted shipping line was an estimate. */
  estimated: boolean;
  /** True when the order carries conditional or unresolved shipping exposure that the base excludes. */
  hasExposure: boolean;
}

export interface OrderFeeInput {
  /** null = unknown (the file carries no such data and nothing was assumed). */
  units: number | null;
  lines: number | null;
  distinctSkus: number | null;
  packages: { packagingType: string | null }[];
  shipments: number;
  /** null = the order's shipping could not be priced. */
  shipping: OrderShippingInput | null;
  /** Which of the quantities above came from an assumption rather than the file. */
  assumed: { units?: boolean; lines?: boolean; skus?: boolean; packaging?: boolean };
  /** Dense 1-based ordinal of the order within its file; drives the deterministic apportionment of order-share drivers. */
  ordinal: number;
}

/** Per-run answers and pins the order-scope rules read. */
export interface OrderFeeContext {
  /** order_share drivers: { key: { sharePct, countPerOrder } }; null = not answered. */
  orderShares: Record<string, { sharePct: DecimalString; countPerOrder: number } | null>;
  /** Monthly-quantity tier rates resolved once per run: rule key → rate per unit in E4 (rate pricing) with the quantity it was read at. */
  pinnedRates: Record<string, { rateE4: E4; monthlyQuantity: DecimalString }>;
  /** Packaging type assumed for packages that carry none (normalised), or null. */
  packagingDefault: string | null;
}

export type FeeChargeClass = "definite" | "estimated";

export type FeeUnresolvedReason = "units_unknown" | "lines_unknown" | "skus_unknown" | "packaging_unknown" | "packaging_unmatched" | "shipping_unknown" | "assumption_missing" | "replaced";

export interface FeeLine {
  ruleKey: string;
  name: string;
  category: FeeCategory;
  basis: FeeBasis;
  /** Chargeable quantity after the free allowance (decimal string; integers for counts). */
  quantity: DecimalString;
  /** Rate per unit of the basis in E4 (null for percent and flat-bracket lines). */
  unitAmountE4: E4 | null;
  amountE4: E4;
  chargeClass: FeeChargeClass;
  /** Plain-language explanation for the customer (names, quantities and rates; never keys). */
  explanation: string;
}

export interface OrderFeeResult {
  /** ok: every applicable rule computed; partial: at least one rule could not be computed; no_content: nothing could be computed. */
  status: "ok" | "partial" | "no_content";
  lines: FeeLine[];
  definiteE4: E4;
  estimatedE4: E4;
  unresolved: { ruleKey: string; name: string; reason: FeeUnresolvedReason; replacedBy?: string }[];
  /** Warning codes: fee_base_excludes_exposure, packaging_defaulted. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Monthly scope, minimums and allocation
// ---------------------------------------------------------------------------

/** The customer's answers to the schedule's driver questions. null = "not sure, leave it out"; "0" = "we don't use this". */
export interface FulfillmentAnswers {
  drivers: Record<string, DecimalString | null>;
  orderShares: Record<string, { sharePct: DecimalString; countPerOrder: number } | null>;
}

export interface MonthlyFeeLine {
  ruleKey: string;
  name: string;
  category: FeeCategory;
  driverKey: string | null;
  /** Quantity billed in the month (after billing-period conversion and long-term replacement). */
  quantity: DecimalString;
  unitAmountE4: E4 | null;
  /** The month's amount in E4, exact. */
  amountE4: E4;
  chargeClass: FeeChargeClass;
  /** True when the quantity scales with order volume (a returns rate). */
  scalesWithVolume: boolean;
  explanation: string;
}

export interface MonthlyNotModeled {
  ruleKey: string;
  name: string;
  category: FeeCategory;
  driverKey: string | null;
  reason: "no_answer" | "replaced_rule_missing" | "volume_unknown";
  /** The rate, for the "add numbers" prompt. */
  describe: string;
}

export interface MonthlyFeeResult {
  lines: MonthlyFeeLine[];
  notModeled: MonthlyNotModeled[];
  /** Driver keys the customer answered that no rule of the schedule reads. */
  unusedAnswers: string[];
  totalE4: E4;
}

/** One calendar month of a run, for the minimum evaluation. */
export interface MonthBucket {
  /** "YYYY-MM"; "average" for a single synthetic month. */
  month: string;
  /** Share of the month covered by the period, 0 < f ≤ 1. */
  fraction: DecimalString;
  /** Order-variable charges of modeled orders dated in this month, per rule key, in E4. */
  orderVariableByRuleE4: Record<string, E4>;
  /** Modeled orders dated in the month and the orders the customer actually shipped in it (for coverage scaling). */
  modeledOrders: number;
  shippedOrders: number;
  /** Expected shipping of modeled orders dated in the month, E4 (for minimums that include shipping). */
  shippingExpectedE4: E4;
  /** Order-scope rule keys left unresolved on at least one modeled order dated in the month (makes a minimum an upper bound). */
  unresolvedRuleKeys: string[];
}

export type MinimumStatus = "exact" | "upper_bound" | "not_computed";

export interface MinimumResult {
  ruleKey: string;
  name: string;
  minimumE4: E4;
  /** Σ over buckets of max(0, f·M − counted), in E4. */
  topUpE4: E4;
  status: MinimumStatus;
  reasons: string[];
  /** What was counted toward the minimum over the whole period, in E4. */
  countedE4: E4;
  members: { ruleKey: string; name: string; state: "priced" | "not_modeled" | "not_in_schedule" }[];
  buckets: { month: string; minimumE4: E4; countedE4: E4; topUpE4: E4 }[];
}

export interface AllocationInput {
  /** Forecast period in months (numeric, 6 dp) and the customer's monthly order volume. */
  months: DecimalString;
  monthlyOrders: DecimalString | null;
  /** Modeled (priced) orders over the period and their exact totals. */
  modeledOrders: number;
  shippingExpectedE4: E4;
  processingE4: E4;
  /** Orders in the population the volume was derived from (non-cancelled, with shipments). */
  populationOrders: number;
  monthlyFixedE4: E4;
  minimumTopUpE4: E4;
  minimumStatus: MinimumStatus | null;
}

export interface AllocationResult {
  /** Monthly figures from exact totals, rounded once (decimal strings, 2 dp); null when the volume is unknown. */
  monthly: { shipping: DecimalString | null; processing: DecimalString | null; fixed: DecimalString; minimumTopUp: DecimalString | null; total: DecimalString | null; annual: DecimalString | null };
  perOrder: { shipping: DecimalString | null; processing: DecimalString | null; allocated: DecimalString | null; allIn: DecimalString | null };
  /** Coverage of the modeled orders against the population; monthly shipping/processing extrapolate the average only at ≥ 80%. */
  coveragePct: DecimalString;
  extrapolated: boolean;
  caveats: string[];
}
