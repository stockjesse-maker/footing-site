/**
 * ParcelClarity pricing engine: public contracts.
 *
 * The engine is a pure, deterministic library. It depends on nothing but decimal.js and
 * receives everything it needs as plain data (a rate-card snapshot, surcharge rules, zip
 * lists). It never fetches, never reads the clock, and never invents a value: when a
 * figure is unavailable it says so in the result rather than guessing.
 *
 * Money and weights travel as decimal strings ("12.50", "0.875") so no precision is lost
 * between PostgreSQL `numeric`, JSON and this module.
 */

/** Bumped whenever a behavioural change could alter a result for the same inputs. Recorded in every result. */
export const ENGINE_VERSION = "2.2.0";

/** Decimal number encoded as a string, e.g. "12.5000". Never a JS float. */
export type DecimalString = string;

export type CurrencyCode = "USD";

export interface Money {
  amount: DecimalString; // rounded to 2 decimal places
  currency: CurrencyCode;
}

export type WeightUnit = "lb" | "oz";
export type DimensionUnit = "in";

export type CarrierCode = "ups" | "fedex" | "usps" | "dhl_ecommerce" | (string & {});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type PackageType = "parcel" | "carrier_flat_rate" | "envelope" | "tube" | "pallet";

export interface PackageInput {
  /** Actual scale weight. */
  weight: DecimalString;
  weightUnit: WeightUnit;
  /** Outer dimensions. All three required for DIM; omit all three for weight-only pricing. */
  length?: DecimalString;
  width?: DecimalString;
  height?: DecimalString;
  dimensionUnit?: DimensionUnit;
  packageType?: PackageType;
  /** Declared value for carrier liability, in the shipment currency. */
  declaredValue?: DecimalString;
  /** Free-form special handling flags understood by rule conditions (e.g. "hazmat", "fragile"). */
  flags?: string[];
  /** Caller reference (order line, SKU, …) echoed back in the result. */
  reference?: string;
}

export type SignatureOption = "none" | "indirect" | "direct" | "adult";

export interface ShipmentOptions {
  signature?: SignatureOption;
  saturdayDelivery?: boolean;
}

export interface ShipmentInput {
  /** Ship date in ISO calendar form (YYYY-MM-DD). Drives rate-card and rule effective dates. */
  shipDate: string;
  originZip: string;
  /** Either a destination ZIP (resolved through the rate card's zone chart) or an explicit zone. */
  destinationZip?: string;
  destinationZone?: string;
  destinationCountry?: "US";
  residential: boolean;
  carrierCode: CarrierCode;
  serviceCode: string;
  packages: PackageInput[];
  options?: ShipmentOptions;
  orderId?: string;
  shipmentId?: string;
  /**
   * Inputs the caller filled in by assumption rather than from the shipment record (bulk modeling
   * of files that lack them). Every counted line that depends on an assumed input is classed
   * **estimated**, never definite, and the result carries an `assumed_inputs` warning.
   */
  assumed?: AssumedInputs;
}

export interface AssumedInputs {
  /** Residential/commercial was not in the record; the value given is a default. */
  residential?: boolean;
  /** The origin ZIP is a default (e.g. the 3PL's warehouse) rather than the shipment's own. */
  originZip?: boolean;
  /** Package weight was derived (e.g. from product weights) rather than measured. */
  weight?: boolean;
  /** Package dimensions were derived rather than measured. */
  dimensions?: boolean;
}

// ---------------------------------------------------------------------------
// Rate card snapshot (what the 3PL published for this customer)
// ---------------------------------------------------------------------------

export type DimensionRounding = "none" | "nearest_whole" | "up_whole";
/**
 * Billable-weight rounding. `postal` = whole ounces below one pound, whole pounds from one pound
 * (postal/economy products); `up_whole_oz` = always to the next ounce; `up_whole_lb` = next pound.
 */
export type WeightRounding = "none" | "up_whole_lb" | "up_whole_oz" | "postal";

/**
 * Dimensional-weight and billable-weight rules for one service, as agreed with the customer.
 * The divisor comes from the customer-facing rate card. Rounding behaviour defaults to the
 * carrier adapter's structural defaults unless the 3PL overrides it here.
 */
export interface DimRules {
  /** null = the rate card does not state a divisor; the engine then prices on actual weight and flags the result. */
  divisor: DecimalString | null;
  /** DIM weight applies only when L×W×H (cubic inches) exceeds this; null = always applies. */
  thresholdCubicIn: DecimalString | null;
  dimensionRounding: DimensionRounding;
  weightRounding: WeightRounding;
  /** Billable weight floor in pounds, e.g. "1" where a carrier bills a minimum of 1 lb. null = none. */
  minBillableLb: DecimalString | null;
  /** Service is exempt from dimensional weight (e.g. carrier flat-rate packaging). */
  exempt: boolean;
}

export interface ServiceTerms {
  serviceId: string;
  carrierCode: CarrierCode;
  serviceCode: string;
  serviceName: string;
  dim: DimRules;
  /** Minimum base charge for the service regardless of bracket. */
  minCharge: DecimalString | null;
  /** Surcharge rule keys the customer agreement bundles into the base price: listed, not charged. */
  includedSurchargeKeys: string[];
  /** Surcharge rule keys the customer agreement waives: neither listed as charges nor charged. */
  excludedSurchargeKeys: string[];
  /** Which of the card's zone charts this service uses ("default" when the card has one). */
  zoneChartKey: string;
  /** Priced without a zone: rows carry zone "ALL" and no zone is resolved. */
  zoneIndependent: boolean;
  /** Customer-facing markup on every surcharge that is not included, excluded or individually overridden ("published + X%"). */
  surchargeMarkupPercent: DecimalString | null;
  /**
   * Where these terms come from (activation is the 3PL's approval of them). Staff-only text: the database keeps it in
   * `rate_card_service_term_sources`, which brand members cannot read, so `loadServiceTerms` (which brand-reachable code
   * calls) never loads it and the engine never puts it in a result. Absent unless a staff-only caller supplies it.
   */
  sourceReference?: string;
  /** Explicit reference recorded in results so a number can be traced to its published terms. */
  termsVersion: string;
}

/**
 * One cell of the customer-facing rate table: the base price for a service, (optional origin),
 * zone and weight bracket. Bracket semantics: weightMin < billable ≤ weightMax, in the row's unit.
 */
export interface RateRow {
  serviceId: string;
  /** Origin ZIP prefix (3 or 5 digits) when the card prices per origin; null = any origin. */
  originPrefix: string | null;
  /** Zone, or "ALL" for zone-independent services. */
  zone: string;
  weightMin: DecimalString;
  weightMax: DecimalString;
  weightUnit: WeightUnit;
  price: DecimalString;
  /** Row-level minimum charge, if the card states one. */
  minCharge: DecimalString | null;
}

/** Zone chart row: origin prefix → inclusive destination prefix range → zone, within a named chart. */
export interface ZoneRow {
  carrierCode: CarrierCode;
  originPrefix: string;
  destPrefixFrom: string;
  destPrefixTo: string;
  zone: string;
  zoneChartKey: string;
}

export interface RateCardSnapshot {
  rateCardId: string;
  rateCardName: string;
  versionId: string;
  versionNumber: number;
  currency: CurrencyCode;
  effectiveDate: string;
  expirationDate: string | null;
  services: ServiceTerms[];
  rows: RateRow[];
  zones: ZoneRow[];
}

// ---------------------------------------------------------------------------
// Surcharge rules
// ---------------------------------------------------------------------------

export const SURCHARGE_CATEGORIES = [
  "fuel", "residential", "das", "das_extended", "remote_area", "additional_handling", "oversize", "peak", "address_correction",
  "signature", "declared_value", "saturday_delivery", "reweight", "remeasure", "shipping_charge_correction", "other",
] as const;

/**
 * Categories whose rules are post-shipment corrections the carrier may apply (a reweigh, a remeasure, a corrected shipping
 * charge). They are always conditional charges, never counted in a total. The surcharge-rule form and action enforce it, and the
 * database trigger `app.guard_adjustment_fee_class` refuses any other charge class (SQLSTATE 23514).
 */
export const ADJUSTMENT_FEE_CATEGORIES = ["reweight", "remeasure", "shipping_charge_correction"] as const;
export type AdjustmentFeeCategory = (typeof ADJUSTMENT_FEE_CATEGORIES)[number];
export const isAdjustmentFeeCategory = (category: string): category is AdjustmentFeeCategory => (ADJUSTMENT_FEE_CATEGORIES as readonly string[]).includes(category);
/** What the rule form and action tell a 3PL who gives one of those categories another charge class (the database refuses it with 23514). */
export const ADJUSTMENT_FEE_CLASS_MESSAGE =
  "A reweigh, remeasure or shipping charge correction fee is charged only if the carrier applies it after shipping, so it must be a conditional adjustment. It is shown as possible exposure and never counted in a total.";

export type SurchargeCategory =
  | "fuel"
  | "residential"
  | "das"
  | "das_extended"
  | "remote_area"
  | "additional_handling"
  | "oversize"
  | "peak"
  | "address_correction"
  | "signature"
  | "declared_value"
  | "saturday_delivery"
  | "reweight"
  | "remeasure"
  | "shipping_charge_correction"
  | "other";

/**
 * How certain a charge is at quote time.
 *  - definite: follows from the inputs and published terms.
 *  - estimated: depends on an assumption or on data the engine did not have (e.g. no ZIP list loaded).
 *  - conditional: a post-shipment adjustment that may or may not occur (reweight, address correction).
 */
export type ChargeClass = "definite" | "estimated" | "conditional";

export type CalculationMethod = "flat" | "percent" | "per_unit";

/** What a percentage-based surcharge (fuel) is applied to. */
export type CalculationBase =
  | { kind: "base_rate" }
  | { kind: "base_plus_all_surcharges" }
  | { kind: "base_plus_categories"; categories: SurchargeCategory[] };

export type RuleCondition =
  | { type: "residential"; value: boolean }
  | { type: "weight_gt"; valueLb: DecimalString; basis: "actual" | "billable" }
  | { type: "weight_lte"; valueLb: DecimalString; basis: "actual" | "billable" }
  | { type: "longest_side_gt"; inches: DecimalString }
  | { type: "second_longest_side_gt"; inches: DecimalString }
  | { type: "length_plus_girth_gt"; inches: DecimalString }
  | { type: "cubic_in_gt"; value: DecimalString }
  | { type: "zone_in"; zones: string[] }
  | { type: "destination_zip_in_list"; listKey: string }
  | { type: "destination_zip_prefix_in"; prefixes: string[] }
  | { type: "declared_value_gt"; amount: DecimalString }
  | { type: "signature_in"; values: SignatureOption[] }
  | { type: "saturday_delivery"; value: boolean }
  | { type: "package_type_in"; types: PackageType[] }
  | { type: "flag_present"; flag: string }
  | { type: "ship_date_between"; from: string; to: string }
  | { type: "package_count_gt"; value: number }
  /** Holds when at least one inner condition holds (OR). */
  | { type: "any_of"; conditions: RuleCondition[] }
  /** Holds when the named rule ended up applying (after exclusivity and overrides); companion surcharges such as peak-on-handling. */
  | { type: "rule_applied"; ruleKey: string };

export type VerificationStatus = "unverified" | "verified" | "approved_3pl_config";

export interface SurchargeRule {
  /** Stable key, unique within its scope, e.g. "ups.residential" or "acme.custom_handling". */
  key: string;
  ruleId: string;
  versionId: string;
  version: number;
  scope: "platform" | "tenant";
  /** Tenant rule limited to one brand customer (the data layer only supplies rules for the brand being priced). */
  brandId: string | null;
  carrierCode: CarrierCode;
  /** null = every service of the carrier. */
  serviceCodes: string[] | null;
  category: SurchargeCategory;
  name: string;
  chargeClass: ChargeClass;
  method: CalculationMethod;
  /** Flat amount (method = flat) or amount per unit (method = per_unit). */
  amount: DecimalString | null;
  /** Percentage, e.g. "16.5" for 16.5% (method = percent). */
  percent: DecimalString | null;
  /** For per_unit: charge `amount` for each started `unitSize` of the basis above `freeAllowance`, at least `minimumCharge`. */
  perUnit: { basis: "declared_value"; unitSize: DecimalString; freeAllowance: DecimalString; minimumCharge: DecimalString | null } | null;
  /** Structural effect: when the rule applies, the package bills at no less than this weight (e.g. large-package minimums). */
  billableWeightFloorLb: DecimalString | null;
  base: CalculationBase;
  /** All conditions must hold (logical AND). An empty list always applies. */
  conditions: RuleCondition[];
  /** Rules sharing a group are mutually exclusive; the highest priority (then highest amount) wins. */
  exclusivityGroup: string | null;
  exclusivityPriority: number;
  /** Rule keys suppressed when this rule applies (bundled surcharges). */
  excludesRuleKeys: string[];
  /** Evaluated and charged once per package (true) or once per shipment (false). */
  perPackage: boolean;
  effectiveDate: string;
  expirationDate: string | null;
  sourceReference: string;
  sourceUrl: string | null;
  verificationStatus: VerificationStatus;
}

export interface ZipList {
  key: string;
  /** 5-digit ZIPs or shorter prefixes. A ZIP matches if it equals an entry or starts with a prefix entry. */
  entries: string[];
  version: number;
  sourceReference: string;
  effectiveDate: string;
  expirationDate: string | null;
}

/**
 * Customer-specific exception to a rule, configured by the 3PL.
 *  - exclude: the rule is waived (listed, not charged).
 *  - override_amount / override_percent: replace the figure.
 *  - markup_percent: the published figure plus a percentage ("carrier published + 10%").
 *  - add_percent_points: for percent rules, the published percentage plus N points.
 */
export interface SurchargeOverride {
  ruleKey: string;
  mode: "exclude" | "override_amount" | "override_percent" | "markup_percent" | "add_percent_points";
  amount: DecimalString | null;
  percent: DecimalString | null;
  effectiveDate: string;
  expirationDate: string | null;
  /**
   * A label for the exception, never the 3PL's own note about the agreement behind it: that note lives in
   * `customer_surcharge_override_notes` (staff only) and `pricing_rules_for_card` returns a fixed label here. The engine uses it
   * only to order two overrides that start on the same day, and never copies it into an explanation, a warning or a reference
   * (customers read all three).
   */
  reference: string;
}

export interface PricingContext {
  rateCard: RateCardSnapshot;
  rules: SurchargeRule[];
  zipLists: ZipList[];
  overrides: SurchargeOverride[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface RuleReference {
  key: string;
  version: number;
  scope: "platform" | "tenant";
  sourceReference: string;
  verificationStatus: VerificationStatus;
}

export type LineKind = "base" | "minimum_charge" | "surcharge" | "fuel";

/**
 * Why a line is or is not part of a total.
 *  - charged: counted in definite or estimated.
 *  - unknown: an input needed to decide was missing; shown as an estimate, not counted.
 *  - included: bundled into the base rate under the customer's terms; not counted.
 *  - waived: excluded for this customer; not counted.
 *  - conditional: a possible post-shipment adjustment; not counted.
 */
export type LineStatus = "charged" | "unknown" | "included" | "waived" | "conditional";

export interface ChargeLine {
  kind: LineKind;
  category: SurchargeCategory | "base";
  label: string;
  amount: Money;
  chargeClass: ChargeClass;
  /** false = listed for transparency but not included in any total (see `status`). */
  counted: boolean;
  status: LineStatus;
  /** Package this line belongs to, when the charge is per package. */
  packageIndex: number | null;
  /** Human explanation: which inputs and terms produced the amount. */
  explanation: string;
  /** Machine-readable basis (e.g. "16.5% of 42.10"). */
  basis: string;
  rule: RuleReference | null;
}

export interface PackageWeightResult {
  packageIndex: number;
  actualLb: DecimalString;
  roundedDimensionsIn: [DecimalString, DecimalString, DecimalString] | null;
  cubicIn: DecimalString | null;
  dimLb: DecimalString | null;
  billableLb: DecimalString;
  /** Why billable is what it is. `rule_minimum` = a surcharge rule's billable-weight floor applied. */
  basis: "dim" | "actual" | "minimum" | "rule_minimum" | "exempt" | "no_dimensions" | "no_divisor";
  explanation: string;
}

export interface ZoneResult {
  zone: string;
  source: "input" | "zone_chart" | "zone_independent";
  explanation: string;
}

export type WarningCode =
  | "dim_divisor_missing"
  | "zip_list_missing"
  | "unverified_rule_applied"
  | "dimensions_missing"
  | "zone_chart_missing"
  | "rate_card_not_effective"
  | "rule_overridden"
  | "override_not_applicable"
  | "assumed_inputs"
  | "rule_reference_cycle";

export interface CalculationWarning {
  code: WarningCode;
  message: string;
  ruleKey?: string;
}

export type UnavailableReason =
  | "service_not_on_rate_card"
  | "zone_unresolved"
  | "zone_ambiguous"
  | "no_rate_for_weight"
  | "no_rate_for_zone"
  | "no_rate_for_origin"
  | "rate_card_not_effective"
  | "invalid_input";

export interface Totals {
  /** Base + definite surcharges + fuel on them. */
  definite: Money;
  /** Counted lines whose figure rests on an assumption (e.g. DIM could not be checked, unverified source). */
  estimated: Money;
  /** Definite + estimated: the best single estimate of the shipping charge. */
  expected: Money;
  /** Sum of conditional adjustment lines (not part of expected). */
  conditionalExposure: Money;
  /** Sum of surcharges that could not be decided from the inputs (status "unknown"); not part of expected. */
  unresolved: Money;
}

export interface ShipmentCalculation {
  status: "ok" | "unavailable";
  unavailableReason: UnavailableReason | null;
  unavailableMessage: string | null;
  currency: CurrencyCode;
  input: ShipmentInput;
  service: { serviceId: string; serviceCode: string; serviceName: string; carrierCode: CarrierCode } | null;
  zone: ZoneResult | null;
  packages: PackageWeightResult[];
  lines: ChargeLine[];
  totals: Totals;
  references: {
    engineVersion: string;
    rateCardId: string;
    rateCardVersionId: string;
    rateCardVersionNumber: number;
    termsVersion: string | null;
    rules: RuleReference[];
    zipLists: { key: string; version: number; sourceReference: string }[];
    overrides: { ruleKey: string; mode: SurchargeOverride["mode"] }[];
  };
  warnings: CalculationWarning[];
}
