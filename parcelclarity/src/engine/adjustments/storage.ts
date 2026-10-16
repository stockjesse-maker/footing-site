import { dec } from "./num";
import { fmt, toLb } from "../money";
import type { PackageInput, WeightUnit } from "../types";
import { correctedPackages } from "./scenario";
import type { AdjustmentScenarioInput, AdjustmentScenarioResult, Handling, RiskForecast, SeparateFeeComponent } from "./types";
import { ADJUSTMENT_ENGINE_VERSION } from "./types";

/**
 * Serializers for what the application persists (staff-only tables). They produce the JSON contracts of the
 * migration `20261015000007_adjustments.sql` header (adjustment_scenarios.input / .result, risk_estimates.result).
 *
 * These are STAFF documents. They are not a customer projection: the published example is built IN SQL from the
 * stored scenario with a closed allow-list, and this module deliberately has no function that produces customer
 * text. Money strings match `^[0-9]{1,7}\.[0-9]{2}$`; weights are pounds with at most 6 decimals.
 */

const MONEY = /^[0-9]{1,7}\.[0-9]{2}$/;

/** Decimals of a pound and of an inch a stored example keeps (`adjustment_scenarios.input` weights and dimensions). */
export const STORED_DECIMALS = 6;

/**
 * True when `weight` (in `unit`) is exactly a whole number of millionths of a pound once converted to pounds. A weight that is not (an ounce
 * weight with more than 2 decimals, e.g. 16.001 oz = 1.0000625 lb) would be ROUNDED when stored, and a rounded weight can fall on the other side of
 * a billable-weight boundary, so the stored package would no longer price to the amount shown. The action's input schema uses this to refuse such
 * a weight up front; `scenarioStorageInput` refuses it again (it never stores a rounded weight).
 */
export function storableWeight(weight: unknown, unit: WeightUnit | undefined = "lb"): boolean {
  if (typeof weight !== "string") return false;
  try {
    const lb = toLb(dec(weight), unit);
    return lb.eq(lb.toDecimalPlaces(STORED_DECIMALS));
  } catch {
    return false;
  }
}

/** True when a dimension (inches) has at most 6 decimals, so storing it rounds nothing (a rounded dimension can cross a whole-inch DIM rounding boundary). */
export function storableDimension(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const d = dec(value);
    return d.eq(d.toDecimalPlaces(STORED_DECIMALS));
  } catch {
    return false;
  }
}

/** A failure carries a code (`reason`) and, when the person can act on it, a plain sentence (`message`). */
export type StorageOutcome<T> = { ok: true; value: T } | { ok: false; reason: string; message?: string };

export interface StoredScenarioInput {
  v: 1;
  serviceId: string;
  residential: boolean;
  zone: number | null;
  declaredSource: "entered" | "wms_fallback";
  declared: { packages: StoredPackage[] };
  corrected: { packages: StoredPackage[] };
  /** Staff-only extras: what is needed to price the example again. */
  shipment: AdjustmentScenarioInput["shipment"];
  corrections: AdjustmentScenarioInput["corrections"];
}

export interface StoredPackage {
  weightLb: string;
  lengthIn?: string;
  widthIn?: string;
  heightIn?: string;
}

/** The package as stored; never rounds: the caller has checked `storableWeight` and `storableDimension` first. */
const storedPackage = (p: PackageInput): StoredPackage => {
  const out: StoredPackage = { weightLb: fmt(toLb(dec(p.weight), p.weightUnit), STORED_DECIMALS) };
  if (p.length !== undefined && p.width !== undefined && p.height !== undefined) {
    out.lengthIn = fmt(dec(p.length), STORED_DECIMALS);
    out.widthIn = fmt(dec(p.width), STORED_DECIMALS);
    out.heightIn = fmt(dec(p.height), STORED_DECIMALS);
  }
  return out;
};

/** The first reason a package cannot be stored exactly, or null. */
function storageProblem(packages: readonly PackageInput[]): StorageOutcome<never> | null {
  for (const p of packages) {
    if (!storableWeight(p.weight, p.weightUnit)) {
      return { ok: false, reason: "weight_precision", message: "A weight has more decimals than an example can keep exactly (millionths of a pound; ounces to 2 decimals). Enter it with fewer decimals so the saved example prices to the amount shown." };
    }
    for (const d of [p.length, p.width, p.height]) {
      if (d !== undefined && !storableDimension(d)) return { ok: false, reason: "dimension_precision", message: "A dimension has more than 6 decimals. Enter it with fewer decimals so the saved example prices to the amount shown." };
    }
  }
  return null;
}

/** adjustment_scenarios.input. Fails (reason) when the scenario was not priced, since only a priced example can be saved. */
export function scenarioStorageInput(input: AdjustmentScenarioInput, result: AdjustmentScenarioResult): StorageOutcome<StoredScenarioInput> {
  if (result.status !== "ok" && result.status !== "no_adjustment") return { ok: false, reason: "not_priced" };
  if (!result.service) return { ok: false, reason: "no_service" };
  const corrected = correctedPackages(input);
  // Exactness first: the stored example is shown to the customer as the example package, so it must price to the published amount.
  const problem = storageProblem(input.shipment.packages) ?? storageProblem(corrected);
  if (problem) return problem;
  const zone = result.zone !== null && /^[0-9]{1,6}$/.test(result.zone) ? Number(result.zone) : null;
  return {
    ok: true,
    value: {
      v: 1,
      serviceId: result.service.serviceId,
      residential: input.shipment.residential,
      zone,
      declaredSource: input.declaredSource,
      declared: { packages: input.shipment.packages.map(storedPackage) },
      corrected: { packages: corrected.map(storedPackage) },
      shipment: input.shipment,
      corrections: input.corrections,
    },
  };
}

type StoredState = "conditional" | "waived_for_customer" | "included_in_rate" | "undecided" | "not_configured" | "not_triggered";

export interface StoredComponent {
  kind: "postage_difference" | "separate_fee";
  state: StoredState;
  amount: string | null;
  declaredTotal?: string;
  correctedTotal?: string;
  /** Only when it equals the policy row of the scenario's type (the database compares it with today's resolution). */
  handling?: Handling;
  /** Staff extras. */
  engineHandling?: Handling | "mixed";
  creditAmount?: string;
  upTo?: string;
  lines?: SeparateFeeComponent["lines"];
}

export interface StoredScenarioResult {
  v: 1;
  status: "ok" | "no_adjustment";
  adjustmentType: "reweight" | "remeasure" | "combined";
  direction: "increase" | "decrease" | "none";
  basis: "exact" | "estimate";
  components: StoredComponent[];
  /** Staff extras. */
  totalsE4: NonNullable<AdjustmentScenarioResult["totalsE4"]>;
  undecided: NonNullable<AdjustmentScenarioResult["undecided"]>;
  warnings: string[];
  notices: string[];
  engineVersion: string;
  pricingEngineVersion: string;
}

/**
 * adjustment_scenarios.result. A postage difference that is a credit is stored as `not_triggered` with the credit in
 * `creditAmount` (a negative amount is not a money string); every other postage difference is `conditional` with its
 * amount. The handling stored is the engine's only when it equals the type's policy row, so `save_adjustment_scenario`
 * never mistakes a correction-fee line's own decision for a changed policy.
 */
export function scenarioStorageResult(result: AdjustmentScenarioResult): StorageOutcome<StoredScenarioResult> {
  if ((result.status !== "ok" && result.status !== "no_adjustment") || !result.components || !result.adjustmentType || !result.direction || !result.basis || !result.totalsE4 || !result.undecided || !result.policySnapshot) {
    return { ok: false, reason: "not_priced" };
  }
  const pd = result.components.postage_difference;
  const fee = result.components.separate_fee;
  const typeRow = (component: "postage_difference" | "separate_fee"): Handling | undefined => result.policySnapshot!.find((e) => e.type === result.adjustmentType && e.component === component)?.handling;
  const credit = pd.state === "credit";
  const amounts = [credit ? null : pd.amount, pd.declaredTotal, pd.correctedTotal, fee.amount, fee.upTo ?? null].filter((x): x is string => x !== null);
  if (amounts.some((a) => !MONEY.test(a))) return { ok: false, reason: "amount_out_of_range" };
  const postage: StoredComponent = {
    kind: "postage_difference",
    state: credit ? "not_triggered" : "conditional",
    amount: credit ? null : pd.amount,
    declaredTotal: pd.declaredTotal,
    correctedTotal: pd.correctedTotal,
    ...(pd.handling === typeRow("postage_difference") ? { handling: pd.handling } : {}),
    engineHandling: pd.handling,
    ...(credit && pd.creditAmount ? { creditAmount: pd.creditAmount } : {}),
  };
  const feeOut: StoredComponent = {
    kind: "separate_fee",
    state: fee.state,
    amount: fee.amount,
    ...(fee.handling !== "mixed" && fee.handling === typeRow("separate_fee") ? { handling: fee.handling } : {}),
    engineHandling: fee.handling,
    ...(fee.upTo ? { upTo: fee.upTo } : {}),
    lines: fee.lines,
  };
  return {
    ok: true,
    value: {
      v: 1,
      status: result.status,
      adjustmentType: result.adjustmentType,
      direction: result.direction,
      basis: result.basis,
      components: [postage, feeOut],
      totalsE4: result.totalsE4,
      undecided: result.undecided,
      warnings: result.warnings,
      notices: result.notices.map((n) => n.code),
      engineVersion: ADJUSTMENT_ENGINE_VERSION,
      pricingEngineVersion: result.pricingEngineVersion,
    },
  };
}

export interface StoredRiskResult {
  v: 1;
  buckets?: { customerPays: number; decidedCaseByCase: number; notBilledToCustomer: number; notDecided: number };
  countedE4?: number;
  /** The resolved handling per component; the database compares it with today's policy. */
  handling: { postage_difference: Handling; separate_fee: Handling };
  forecast: RiskForecast;
}

/** risk_estimates.result. `buckets` and `countedE4` appear only when a counted-here amount was computed (they then add up exactly). */
export function riskStorageResult(forecast: RiskForecast): StoredRiskResult {
  return {
    v: 1,
    ...(forecast.buckets && forecast.countedHereE4 !== null ? { buckets: forecast.buckets, countedE4: forecast.countedHereE4 } : {}),
    handling: { postage_difference: forecast.components.postage_difference.handling, separate_fee: forecast.components.separate_fee.handling },
    forecast,
  };
}
