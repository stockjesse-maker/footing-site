import type { DecimalString, ShipmentInput, UnavailableReason, WeightUnit } from "../types";

/**
 * Adjustment-risk engine (Milestone 5): public contracts. Pure data, no I/O, no clock.
 *
 * Every amount here is CUSTOMER-FACING: what a customer is charged (or would be charged) under the 3PL's own
 * rate card and authorized rules. The engine never reads, stores or computes a carrier buy rate. "Absorbed" means
 * "not billed to the customer, at customer-facing rates": foregone revenue, never a loss, cost or margin.
 *
 * Unknown is never zero. A figure that cannot be computed is `null` / `not_computed` and says why.
 * Money is carried as integer ten-thousandths of a dollar (E4) wherever it is aggregated; cents strings are
 * the display of the E4 figure (the M4 convention).
 */

/**
 * Stored with every saved scenario and estimate (`engine_version`, 1 to 40 characters). Bump it whenever a change
 * could alter a result for the same inputs. `ENGINE_VERSION` is the same value under the name the application
 * stores; the shipping engine's own `ENGINE_VERSION` (src/engine/types.ts) is reported separately as
 * `pricingEngineVersion` on a scenario result.
 */
export const ADJUSTMENT_ENGINE_VERSION = "adjustments-1.0.0";
export const ENGINE_VERSION = ADJUSTMENT_ENGINE_VERSION;

export type AdjustmentType = "reweight" | "remeasure" | "combined";
/** Policy rows exist for these types. `correction` is the shipping-charge-correction fee (separate fee only). */
export type PolicyType = AdjustmentType | "correction";
export type PolicyComponent = "postage_difference" | "separate_fee";
export type Handling = "absorbed" | "pass_through" | "manual_approval" | "unconfigured";
export type PolicyFn = (type: PolicyType, component: PolicyComponent) => Handling;

export const ADJUSTMENT_TYPES: readonly AdjustmentType[] = ["reweight", "remeasure", "combined"];
export const POLICY_TYPES: readonly PolicyType[] = ["reweight", "remeasure", "combined", "correction"];
export const POLICY_COMPONENTS: readonly PolicyComponent[] = ["postage_difference", "separate_fee"];
export const HANDLINGS: readonly Handling[] = ["absorbed", "pass_through", "manual_approval", "unconfigured"];
export const ADJUSTMENT_CAUSES = ["wms_no_weight", "scale_error", "carrier_reweigh", "carrier_remeasure", "packaging_change", "other"] as const;
export type AdjustmentCause = (typeof ADJUSTMENT_CAUSES)[number];

/** Integer number of ten-thousandths of a dollar: 12500 = $1.25 (same unit as the fee and forecast engines). */
export type E4 = number;

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

/** One policy row as stored (`adjustment_policies`). `brandId` null is the account default. Dates are inclusive. */
export interface PolicyRow {
  brandId: string | null;
  adjustmentType: string;
  component: string;
  handling: string;
  validFrom: string;
  validTo: string | null;
}

// ---------------------------------------------------------------------------
// Scenario evaluation
// ---------------------------------------------------------------------------

/** A correction to one declared package; only the fields present change. A weight is read in `weightUnit`, else in the declared package's unit. */
export interface PackageCorrection {
  weight?: DecimalString;
  weightUnit?: WeightUnit;
  length?: DecimalString;
  width?: DecimalString;
  height?: DecimalString;
}

export type DeclaredSource = "entered" | "wms_fallback";

export interface AdjustmentScenarioInput {
  /** The shipment priced AS DECLARED. */
  shipment: ShipmentInput;
  /** One entry per declared package, in order ({} for an untouched package). The package count cannot differ. */
  corrections: PackageCorrection[];
  /** `wms_fallback`: the declared weight is the fallback the WMS used at label creation (0 is refused). */
  declaredSource: DeclaredSource;
}

/** Staff-side inputs the shipment pricing context cannot carry. */
export interface AdjustmentScenarioOptions {
  /** Number of percent-of-shipping fee rules in the brand's active fee schedule (detected, never modelled). */
  percentOfShippingFeeCount?: number;
}

export type ScenarioStatus = "ok" | "no_adjustment" | "declared_unavailable" | "corrected_unavailable" | "both_unavailable" | "invalid_input";
export type Direction = "increase" | "decrease" | "none";
export type Basis = "exact" | "estimate";
export type FeeState = "conditional" | "waived_for_customer" | "included_in_rate" | "undecided" | "not_configured" | "not_triggered";
export type PostageState = "computed" | "credit";

/** Scenario-level warning codes (compare as a set). Engine pricing warnings live on `sides.<side>.warnings`. */
export type ScenarioWarning = "adjustment_fee_rule_not_conditional" | "adjustment_fee_rules_stack";

/** Always-on staff notes (never customer-visible). */
export interface ScenarioNotice {
  code: "fuel_on_adjustment_fee_not_modelled" | "percent_of_shipping_fees_not_modelled";
  message: string;
  count?: number;
}

export interface SidePackage {
  index: number;
  billableLb: DecimalString;
  basis: string;
  roundedDimensionsIn: [DecimalString, DecimalString, DecimalString] | null;
}

export interface ScenarioSide {
  status: "ok" | "unavailable";
  unavailableReason: UnavailableReason | null;
  /** The engine's own message when unavailable. */
  message: string | null;
  /** Σ counted lines (definite + estimated), cents. null unless the scenario status is ok / no_adjustment. */
  countedTotal: DecimalString | null;
  /** Σ lines that could not be decided (status unknown), cents. null unless ok / no_adjustment. */
  unresolved: DecimalString | null;
  zone: string | null;
  packages: SidePackage[];
  /** Pricing warning codes of this side (informational). */
  warnings: string[];
}

export interface PostageDifferenceComponent {
  kind: "postage_difference";
  state: PostageState;
  /** Corrected counted total minus declared counted total (two independently rounded cent totals); negative for a credit. */
  amount: DecimalString;
  declaredTotal: DecimalString;
  correctedTotal: DecimalString;
  handling: Handling;
  /** Present when state is `credit`: the absolute value, shown to staff in words. */
  creditAmount?: DecimalString;
}

export interface FeeLine {
  ruleKey: string;
  label: string;
  category: "reweight" | "remeasure" | "shipping_charge_correction";
  /** The corrected package of a per-package rule; null for a shipment-level rule (one line, whatever the package count). */
  packageIndex: number | null;
  amount: DecimalString;
  handling: Handling;
  /** How the rule computes the fee. A percent fee is a percent of the CORRECTED base rate (the engine's own basis), with no fuel on it. */
  method: "flat" | "percent" | "per_unit";
}

export interface SeparateFeeComponent {
  kind: "separate_fee";
  state: FeeState;
  /** Sum of the conditional lines (state `conditional`); null otherwise. Never "0.00" for "no fee is configured". */
  amount: DecimalString | null;
  /** State `undecided`: the most the unknown line(s) could add. */
  upTo?: DecimalString;
  /** The single handling of the conditional lines, `mixed` when they differ, else the policy row for the scenario type. */
  handling: Handling | "mixed";
  lines: FeeLine[];
}

export interface UndecidedItem {
  label: string;
  /** The amount the difference includes that rests on a charge that could not be decided. */
  upTo: DecimalString;
  side: "declared" | "corrected";
  packageIndex: number | null;
}

/** The four buckets of an amount by who pays (E4). Their sum is the counted total. */
export interface HandlingBuckets {
  customerPays: E4;
  decidedCaseByCase: E4;
  /** Staff-only. Foregone revenue at customer-facing rates, not a cost. */
  notBilledToCustomer: E4;
  notDecided: E4;
}

export interface PolicySnapshotEntry {
  type: PolicyType;
  component: PolicyComponent;
  handling: Handling;
}

export interface AdjustmentScenarioResult {
  engineVersion: string;
  pricingEngineVersion: string;
  status: ScenarioStatus;
  /** Plain-language reason for invalid_input and the unavailable statuses; null otherwise. */
  message: string | null;
  adjustmentType: AdjustmentType | null;
  direction: Direction | null;
  basis: Basis | null;
  declaredSource: DeclaredSource;
  service: { serviceId: string; serviceCode: string; serviceName: string; carrierCode: string } | null;
  zone: string | null;
  rateCardVersionId: string;
  sides: { declared: ScenarioSide; corrected: ScenarioSide } | null;
  components: { postage_difference: PostageDifferenceComponent; separate_fee: SeparateFeeComponent } | null;
  undecided: UndecidedItem[] | null;
  /** Buckets of this one example (E4). All zero unless the direction is `increase`. */
  totalsE4: HandlingBuckets | null;
  policySnapshot: PolicySnapshotEntry[] | null;
  warnings: ScenarioWarning[];
  notices: ScenarioNotice[];
}

// ---------------------------------------------------------------------------
// History statistics
// ---------------------------------------------------------------------------

/** What the statistics read from one `adjustment_records` row. Money null = UNKNOWN (never 0). */
export interface HistoryRecord {
  id: string;
  brandId: string | null;
  carrierCode: string;
  serviceId: string | null;
  shipDate: string;
  adjustmentType: string;
  cause: string;
  packageRef: string | null;
  originalCharge: DecimalString | null;
  correctedCharge: DecimalString | null;
  separateFee: DecimalString | null;
  /** corrected - original when both are present (the generated column), else null. */
  postageDifference: DecimalString | null;
}

export interface HistoryBaseline {
  id: string;
  brandId: string | null;
  carrierCode: string | null;
  serviceId: string | null;
  periodStart: string;
  periodEnd: string;
  packagesTotal: number;
  labelsMissingWeight: number | null;
}

export interface HistoryFilters {
  /** null = tenant-wide. */
  brandId: string | null;
  carrierCode?: string | null;
  serviceId?: string | null;
  adjustmentType?: string | null;
  cause?: string | null;
  /** Inclusive ship-date window. */
  window?: { from: string; to: string } | null;
  /** Explicit baselines (exactly these); each must match the scope. */
  baselineIds?: string[] | null;
  maturityDays?: number | null;
  /** Today (ISO date), supplied by the caller: the engine has no clock. */
  today?: string | null;
}

export type DirectionGroup = "increase" | "decrease" | "zero" | "unknown";

export interface WilsonBounds {
  lowerPct4dp: string;
  upperPct4dp: string;
  lowerPct10dp: string;
  upperPct10dp: string;
}

export interface IncidenceStat {
  k: number;
  N: number;
  /** k / N as a percent, HALF_UP at 4 decimals (display only; arithmetic uses the exact fraction). */
  pct4dp: string;
  wilson: WilsonBounds;
}

export interface SeverityStat {
  n: number;
  sumE4: E4 | null;
  meanE4: E4 | null;
  medianE4: E4 | null;
  /** Increase group only. Nearest rank. */
  p90E4?: E4 | null;
  maxE4?: E4 | null;
}

export type ConfidenceLevel = "none" | "low" | "moderate" | "adequate";

export type HistoryRefusalCode = "scope_mismatch" | "baseline_not_found" | "baselines_overlap" | "service_unresolved" | "k_exceeds_n" | "invalid_filters";

export interface HistoryRefused {
  engineVersion: string;
  status: "refused";
  code: HistoryRefusalCode;
  message: string;
  ids?: string[];
  unresolvedCount?: number;
  k?: number;
  N?: number;
}

export interface HistoryStatistics {
  engineVersion: string;
  status: "ok";
  scope: "brand" | "tenant";
  baseline: {
    present: boolean;
    ids: string[];
    packagesTotal: number | null;
    periods: { start: string; end: string }[];
    /** Matching baselines left out because they do not lie wholly inside the window. */
    outsideWindowCount: number;
  };
  /** Records matching the numerator filters that fall outside the selected baseline periods (or the window). Records, not keys. */
  excludedOutsideBaseline: number;
  /** Records in the numerator. */
  recordsInScope: number;
  /** k: distinct (brand, carrier, package reference); a record without a reference counts once by itself. */
  affected: number;
  /** True when at least one record has no package reference ("per adjustment record, not per package"). */
  perRecordCounting: boolean;
  incidence: IncidenceStat | null;
  incidenceByDirection: Record<DirectionGroup, { k: number; pct4dp: string; wilson: WilsonBounds }> | null;
  incidenceReason: "no_baseline" | null;
  severity: {
    increase: { postage: SeverityStat; fee: SeverityStat };
    decrease: { postage: SeverityStat; fee: SeverityStat };
    zero: { postage: SeverityStat; fee: SeverityStat };
    unknown: { postage: SeverityStat; fee: SeverityStat };
  };
  /** Charges only: the increase group's postage block. */
  chargesOnly: { n: number; meanE4: E4 | null };
  /** A memo that assumes credits are returned; credits never enter exposure. */
  netOfCredits: { n: number; sumE4: E4 | null; meanE4: E4 | null };
  /** True when the largest record exceeds 25 percent of the summed severity (increase group). */
  topRecordOver25Pct: { postage: boolean; fee: boolean };
  confidence: { incidence: ConfidenceLevel; postage: ConfidenceLevel; fee: ConfidenceLevel };
  maturity: { windowEnd: string; daysSinceWindowEnd: number; maturityDays: number; immature: boolean } | null;
  missingRatePct: string | null;
  correctionRatePct: string | null;
  labelsMissingWeight: number | null;
  wmsNoWeightAffected: number | null;
  /** Statements the screen prints (fixed copy keys, not text). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Risk forecast
// ---------------------------------------------------------------------------

export type ForecastBasis = "declared_weights" | "actual_weights";
export type SeveritySource = "entered" | "history" | "example";

export interface RiskSeverityInput {
  source: SeveritySource;
  /** Integer E4 (a history mean is rounded HALF_UP to E4 once, when the statistic is produced); null = unknown. */
  e4: E4 | null;
  /** Records behind a history severity (rates its confidence). */
  n?: number | null;
}

export type RiskIncidenceInput = { source: "history"; k: number; N: number } | { source: "entered"; pct: DecimalString };

export interface RiskInputs {
  /** Packages a month, a non-negative decimal string up to 5,000,000. */
  monthlyVolume: DecimalString;
  incidence: RiskIncidenceInput;
  severity: { postage_difference: RiskSeverityInput; separate_fee: RiskSeverityInput };
  /** REQUIRED, no default. */
  basis: ForecastBasis | null;
  /** Already resolved by policy. */
  handling: { postage_difference: Handling; separate_fee: Handling };
  /** Optional memo: credit records (history only). Credits never enter exposure. */
  credits?: { k: number; severityE4: E4 } | null;
}

export type RiskRefusalCode =
  | "volume_invalid"
  | "volume_negative"
  | "volume_too_large"
  | "basis_required"
  | "incidence_invalid"
  | "k_negative"
  | "k_exceeds_n"
  | "p_invalid"
  | "p_out_of_range"
  | "severity_invalid"
  | "severity_negative"
  | "handling_invalid"
  | "credits_invalid"
  | "overflow";

export interface RiskRefused {
  engineVersion: string;
  status: "refused";
  code: RiskRefusalCode;
  message: string;
}

export type ComponentState = "computed" | "in_forecast" | "not_computed";

export interface RiskComponent {
  handling: Handling;
  severityE4: E4 | null;
  /** E4 amount for the month; null when not computed. For `in_forecast` it is the amount already inside the user's forecast. */
  amountE4: E4 | null;
  state: ComponentState;
  reason?: "severity_unknown" | "incidence_unknown";
}

export interface RiskRange {
  incidenceLowPct4dp: string;
  incidenceHighPct4dp: string;
  lowAffected1dp: string;
  highAffected1dp: string;
  /** null when no counted-here severity is known (and the lower bound is not exactly 0). */
  lowE4: E4 | null;
  highE4: E4 | null;
}

export interface RiskForecast {
  engineVersion: string;
  status: "ok";
  basis: ForecastBasis;
  incidence: ({ source: "history"; k: number; N: number; pct4dp: string } | { source: "entered"; pctAsEntered: string }) | null;
  incidenceReason: "no_baseline" | null;
  affected: { exact: string; display1dp: string } | null;
  components: { postage_difference: RiskComponent; separate_fee: RiskComponent };
  /** Σ of the counted-here components, each rounded once (E4). null when no counted-here component is computed. */
  countedHereE4: E4 | null;
  /** The same sum before the per-component rounding, as an exact decimal string (the per-shipment, per-1,000 and annual figures derive from it). */
  exactCountedHereE4: string | null;
  buckets: HandlingBuckets | null;
  /** The 3PL's own possible cost of cases it decides one by one: 0 to the whole bucket (no assumed approval share). */
  decidedCaseByCaseRangeE4: { lowE4: 0; highE4: E4 } | null;
  /** Staff memo: postage that is inside the user's forecast although policy says it is not billed / decided case by case. */
  inForecastMemoE4: { inForecastNotBilledE4: E4; inForecastDecidedCaseByCaseE4: E4 } | null;
  /** True while some counted-here amount is not decided: the headline reads "So far". */
  soFar: boolean;
  /** True when a counted-here component could not be computed while another could: the total reads "At least". */
  atLeast: boolean;
  perAffectedE4: E4 | null;
  perShipmentE4: E4 | null;
  per1000E4: E4 | null;
  annualE4: E4 | null;
  warnings: "forecast_includes_unbilled_postage"[];
  range: RiskRange | null;
  creditsMemoE4: E4 | null;
  netMemoE4: E4 | null;
  confidence: {
    incidence: ConfidenceLevel | "entered";
    postage_difference: ConfidenceLevel | "entered" | "example";
    separate_fee: ConfidenceLevel | "entered" | "example";
    overall: ConfidenceLevel | "entered";
  };
}
