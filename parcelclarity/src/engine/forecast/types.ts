import type { AllocationResult, E4, FeeBasis, FeeCategory, FeeScheduleSnapshot, MinimumResult, MinimumStatus, MonthlyFeeResult, OrderFeeContext } from "../fees/types";
import type { CategoryCompleteness } from "../modeling/types";
import type { DecimalString, PricingContext } from "../types";

/**
 * Forecasts from assumptions (Milestone 4, design §7). Pure data, no I/O.
 *
 * A forecast prices a **weighted profile grid**, not synthetic orders: the brand describes its
 * monthly volume and how it splits by parcel, zone, service, residential share and package count,
 * and what a typical order holds. Every cell of the grid is priced once with the shipping engine
 * and, per content row, with the fee engine; figures are expected values over that mix, never a
 * prediction for any month and never an invoice. Nothing here is definite: every counted line rests
 * on a stated assumption, so `definite` is always "0.00".
 *
 * Money is carried as integer ten-thousandths of a dollar (E4) like the fee engine; aggregates are
 * exact decimals rounded once per reported figure (HALF_UP to E4 for the stored precision, and the
 * cents figures are the display rounding of those E4 figures, so every per-order and monthly figure
 * derives from one rounded total).
 */

export const FORECAST_ENGINE_VERSION = "1.0.0";

export const FORECAST_LIMITS = {
  parcels: 14,
  zones: 30,
  services: 10,
  contentRows: 12,
  cells: 1500,
  monthlyOrdersMin: 1,
  monthlyOrdersMax: 5_000_000,
  packagesPerOrderMin: 2,
  packagesPerOrderMax: 10,
  unitsMax: 99_999,
} as const;

/**
 * The ordinal every forecast order is priced as. Order-share drivers apportion real orders by
 * ordinal (order i qualifies iff floor(i·p) > floor((i−1)·p)); a forecast has no ordinals, only
 * expected values, so every cell is priced as an ordinal that qualifies for every share p that is a
 * whole number of hundredths of a percent (p = n/10000, 1 ≤ n ≤ 10000: floor(10000·p) = n while
 * floor(9999·p) = n − 1), and the resulting order-driver lines are scaled by p afterwards.
 */
export const EXPECTED_VALUE_ORDINAL = 10_000;

// ---------------------------------------------------------------------------
// Inputs (ForecastAssumptions v1, canonical JSON, hashed)
// ---------------------------------------------------------------------------

export interface ForecastParcel {
  /** Actual weight in pounds, up to 4 decimals. */
  weightLb: DecimalString;
  /** Outer dimensions in inches: all three or none. */
  lengthIn?: DecimalString;
  widthIn?: DecimalString;
  heightIn?: DecimalString;
  /** Packaging type as the fee schedule names it; null = unknown (packaging fees are then not computed). */
  packagingType: string | null;
  /** Share of orders shipped in this parcel, percent with up to 2 decimals; the rows add up to exactly 100. */
  sharePct: DecimalString;
  /** "I don't know the size": priced without dimensions (DIM weight not checked) even where a service bills by size. */
  unknownSize?: boolean;
}

export interface ForecastZone {
  /** Zone as the rate card names it ("2".."8", or "ALL" for zone-independent services). */
  zone: string;
  sharePct: DecimalString;
}

export interface ForecastService {
  serviceId: string;
  carrierCode: string;
  serviceCode: string;
  /** Customer-facing service name, echoed in the unpriceable table. */
  name: string;
  sharePct: DecimalString;
}

export interface ForecastContentRow {
  /** Items in the order (≥ 1). */
  units: number;
  /** Order lines with items (1 ≤ lines ≤ units); distinct products are taken as the number of lines. */
  lines: number;
  sharePct: DecimalString;
}

/**
 * What a typical order holds: explicit rows, or averages that are split two-point (floor and ceiling
 * of each average with the shares that reproduce it exactly, lines coupled comonotonically with items).
 */
export type ForecastContent = { rows: ForecastContentRow[] } | { averageUnits: DecimalString; averageLines: DecimalString };

/** The brand's answers to the fee schedule's driver questions (the same shape `start_simulation_run` validates). */
export interface ForecastFulfillment {
  /** True = shipping only; order fees and monthly charges are not modeled. */
  skip?: boolean;
  /** Monthly-quantity and returns-rate drivers: null = "not sure, leave it out"; "0" = "we don't use this". */
  drivers: Record<string, DecimalString | null>;
  /** Order-share drivers: the share of orders that get them and the count per qualifying order. */
  orderShares: Record<string, { sharePct: DecimalString; countPerOrder: number } | null>;
  /** Packaging type assumed for parcels that carry none. */
  packagingDefault?: string | null;
}

export interface ForecastAssumptions {
  version: 1;
  /** Whole number of orders a month, 1..5,000,000. */
  monthlyOrders: DecimalString;
  /** The date rates and fees are read on (YYYY-MM-DD). */
  asOfDate: string;
  originZip: string;
  parcels: ForecastParcel[];
  zones: ForecastZone[];
  services: ForecastService[];
  /** Share of orders delivered to residences, 0..100. */
  residentialPct: DecimalString;
  /** Share of orders that ship as several packages (one shipment of k identical packages); pct "0" = none. */
  multiPackage: { pct: DecimalString; packagesPerOrder: number };
  content: ForecastContent;
  fulfillment: ForecastFulfillment;
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export interface ForecastCell {
  /** Canonical key: service id, zone, parcel index (canonical order), residential, package count. */
  key: string;
  parcelIndex: number;
  zoneIndex: number;
  serviceIndex: number;
  zone: string;
  serviceId: string;
  residential: boolean;
  /** Packages per shipment (1, or packagesPerOrder for the multi-package class). */
  packages: number;
  /** Exact expected orders a month in this cell: monthlyOrders × the product of the shares. */
  weight: DecimalString;
}

export interface ForecastGridCounts {
  parcels: number;
  zones: number;
  services: number;
  /** 1 when residentialPct is 0 or 100, else 2. */
  residentialSplits: number;
  /** 1 when multiPackage.pct is 0 or 100, else 2. */
  packageClasses: number;
  cells: number;
}

export interface ForecastGrid {
  cells: ForecastCell[];
  /** Σ weights, exact; always equal to monthlyOrders. */
  weightSum: DecimalString;
  counts: ForecastGridCounts;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface ForecastDeps {
  pricing: PricingContext;
  /** The fee schedule version in effect on the as-of date; null when the brand has none. */
  schedule: FeeScheduleSnapshot | null;
  /** Monthly-quantity tier rates resolved for this volume (see `forecastPinnedRates`). */
  pinnedRates: OrderFeeContext["pinnedRates"];
  /**
   * Optional: a destination ZIP to price a zone with. By default cells are priced by zone, so
   * surcharges that depend on the destination ZIP (delivery area, remote area) stay undecided and are
   * reported as an upper bound, as the design requires. A caller that supplies a ZIP prices that one
   * ZIP for the whole zone, including its ZIP-dependent surcharges; the ZIP must resolve to the
   * cell's zone on the rate card, otherwise the cell is unpriceable (`zone_mismatch`). null = price by zone.
   */
  destinationZipForZone?: (zone: string) => string | null;
  feeEngineVersion: string;
  engineVersion: string;
  /** Hashes the canonical assumptions JSON (sha-256 hex in production; see src/lib/forecast/hash.ts). */
  hash: (canonicalJson: string) => string;
}

export interface ForecastOptions {
  /** When some cells cannot be priced: average over the priced cells instead of blocking (no imputation, no all-in). */
  priceOnlyCovered?: boolean;
}

export type ForecastFeeMode = "modeled" | "skipped" | "no_schedule";

/** One row of the "could not be priced" table: a service × zone the rate card does not cover, with its share of volume. */
export interface ForecastUnpriceable {
  serviceId: string;
  serviceName: string;
  zone: string;
  /** The shipping engine's reason, or zone_mismatch / service_mismatch when a supplied ZIP or id does not fit the rate card. */
  reason: string;
  message: string;
  weight: DecimalString;
  sharePct: DecimalString;
}

/** `[key, weight, shippingE4]`; shippingE4 null = the cell could not be priced (see `unpriceable`). Compact so 1,500 cells stay well inside the stored summary's size cap. */
export type ForecastCellRecord = [key: string, weight: DecimalString, shippingE4: E4 | null];

export interface ForecastRuleFigure {
  key: string;
  name: string;
  category: FeeCategory;
  basis: FeeBasis;
  /** Expected monthly amount of this rule over the priced volume, E4 (rounded once) and cents. */
  expectedE4: E4;
  expected: DecimalString;
  /** Expected amount per order, cents. */
  perOrder: DecimalString;
  /** Expected chargeable quantity per order (4 dp): "0.4" additional items, "0.8" inserts. */
  quantityPerOrder: DecimalString;
  /** Share of orders that get a line of this rule, percent (2 dp). */
  ordersSharePct: DecimalString;
}

export interface ForecastUnresolvedRule {
  key: string;
  name: string;
  /** The fee engine's reason that affects the most volume. */
  reason: string;
  /** Share of orders (percent, 2 dp) and expected orders a month on which the rule could not be computed. */
  sharePct: DecimalString;
  orders: number;
}

export interface ForecastShipping {
  /** Expected shipping of the priced volume a month: E4 rounded once from the exact sum, then cents. */
  expectedE4: E4;
  expected: DecimalString;
  /** Same figure with four decimals (everything is an estimate). */
  estimated: DecimalString;
  definite: "0.00";
  perOrder: DecimalString;
  baseFreightE4: E4;
  /** Post-shipment adjustments that may apply (address correction, reweigh): an upper bound, never added. */
  conditionalUpToE4: E4;
  conditionalUpTo: DecimalString;
  /** Surcharges that could not be decided from the assumptions (delivery area, remote area): an upper bound, never added. */
  unresolvedUpToE4: E4;
  unresolvedUpTo: DecimalString;
  /** Shipping-engine warning codes with the share of volume they touched. */
  warnings: { code: string; sharePct: DecimalString }[];
}

export interface ForecastProcessing {
  expectedE4: E4;
  expected: DecimalString;
  estimated: DecimalString;
  definite: "0.00";
  perOrder: DecimalString;
  byRule: ForecastRuleFigure[];
  unresolved: ForecastUnresolvedRule[];
  warnings: { code: string; sharePct: DecimalString }[];
}

export type ForecastMinimum = MinimumResult & { includesShipping: boolean };

export type ForecastCaveat =
  | "expected_values"
  | "independent_distributions"
  | "one_shipment_per_order"
  | "exact_weights"
  | "no_shipment_options"
  | "delivery_area_undecided"
  | "effective_dates"
  | "priced_only_covered"
  | "no_fee_schedule"
  | "fulfillment_skipped"
  | "not_all_categories_priced"
  | "minimum_upper_bound";

export interface ForecastProfile {
  monthlyOrders: DecimalString;
  asOfDate: string;
  originZip: string;
  parcels: ForecastParcel[];
  zones: ForecastZone[];
  services: ForecastService[];
  residentialPct: DecimalString;
  multiPackage: { pct: DecimalString; packagesPerOrder: number };
  content: { source: "rows" | "averages"; averageUnits: DecimalString | null; averageLines: DecimalString | null; rows: ForecastContentRow[] };
}

export interface ForecastSummary {
  version: 2;
  basis: "assumptions";
  forecastEngineVersion: string;
  engineVersion: string;
  feeEngineVersion: string;
  assumptionsHash: string;
  asOfDate: string;
  monthlyOrders: DecimalString;
  /** Σ cell weights, exact; equals monthlyOrders. */
  weightSum: DecimalString;
  /** Weight of the cells that were priced (equals weightSum unless `priceOnlyCovered`). */
  pricedWeight: DecimalString;
  pricedSharePct: DecimalString;
  counts: ForecastGridCounts;
  cells: ForecastCellRecord[];
  priceOnlyCovered: boolean;
  unpriceable: ForecastUnpriceable[];
  shipping: ForecastShipping;
  feeMode: ForecastFeeMode;
  /** null when fees were not modeled (no schedule, or fulfillment skipped). */
  processing: ForecastProcessing | null;
  monthly: (MonthlyFeeResult & { total: DecimalString }) | null;
  minimums: ForecastMinimum[];
  minimumStatus: MinimumStatus | "none";
  minimum: { status: MinimumStatus | "none"; topUpE4: E4; topUp: DecimalString | null };
  /** Monthly and per-order figures; null when fees were not modeled or only part of the volume was priced. */
  allocation: AllocationResult | null;
  allocated: { perOrder: DecimalString | null; monthly: DecimalString } | null;
  /** All-in cost per order, a month and a year; null unless every rate-bearing category is priced and every cell was priceable. */
  allIn: { perOrder: DecimalString; monthly: DecimalString; annual: DecimalString } | null;
  complete: boolean;
  completeness: CategoryCompleteness[];
  caveats: ForecastCaveat[];
  provenance: {
    rateCardName: string;
    rateCardEffectiveDate: string;
    rateCardExpirationDate: string | null;
    feeScheduleName: string | null;
    feeScheduleEffectiveDate: string | null;
    feeScheduleExpirationDate: string | null;
  };
  profile: ForecastProfile;
}

export type ForecastResult =
  | { status: "invalid"; problems: string[] }
  | { status: "blocked"; assumptionsHash: string; cellCount: number; unpriceable: ForecastUnpriceable[]; unpriceableSharePct: DecimalString }
  | { status: "ok"; summary: ForecastSummary };

/** The all-in figures at another volume, holding the per-order shipping and processing constant. */
export interface ForecastVolumePoint {
  multiplier: DecimalString;
  monthlyOrders: DecimalString;
  monthly: { shipping: DecimalString; processing: DecimalString; fixed: DecimalString; minimumTopUp: DecimalString | null; total: DecimalString };
  perOrder: { shipping: DecimalString; processing: DecimalString; allocated: DecimalString; allIn: DecimalString };
  minimumStatus: MinimumStatus | "none";
}
