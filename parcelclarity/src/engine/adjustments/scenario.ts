import { calculateShipment } from "../calculate";
import { D, dec, toLb, type Dec } from "../money";
import { latestPerKey, ruleIsCandidate } from "../surcharges";
import { ENGINE_VERSION as PRICING_ENGINE_VERSION } from "../types";
import type { ChargeLine, PackageInput, PricingContext, ShipmentCalculation, SurchargeRule } from "../types";
import type { FeeRule } from "../fees/types";
import { toE4 } from "./num";
import {
  ADJUSTMENT_ENGINE_VERSION,
  type AdjustmentScenarioInput,
  type AdjustmentScenarioOptions,
  type AdjustmentScenarioResult,
  type AdjustmentType,
  type Basis,
  type DeclaredSource,
  type Direction,
  type FeeLine,
  type FeeState,
  type Handling,
  type HandlingBuckets,
  type PackageCorrection,
  type PolicyComponent,
  type PolicyFn,
  type PolicySnapshotEntry,
  type PolicyType,
  type PostageDifferenceComponent,
  type ScenarioNotice,
  type ScenarioSide,
  type ScenarioStatus,
  type ScenarioWarning,
  type SeparateFeeComponent,
  type SidePackage,
  type UndecidedItem,
} from "./types";

/**
 * Scenario evaluation (design v2 section 3.1): what would it cost the customer if this declared package turns out
 * to be a different package? Two independent pricings of the same shipment through the engine's own
 * `calculateShipment`, then a difference. Nothing here prices from anything but the 3PL's customer-facing rate card
 * and rules; there is no field for a carrier cost anywhere.
 *
 *  - The type (reweight / remeasure / combined) is classified from the INPUT diff, never chosen.
 *  - Adjustment-fee categories (reweight, remeasure, shipping_charge_correction) are forced to charge class
 *    `conditional`, so they never enter a counted total. The DECLARED side is priced with none of them; the
 *    CORRECTED side with only the in-scope ones. The postage difference is therefore pure shipping charge.
 *  - postage_difference = counted total (corrected) - counted total (declared), each independently rounded to cents.
 *  - The separate fee is read from the corrected pricing's conditional lines, per package.
 *  - An example whose pricing is unavailable on either side carries no amounts: no extrapolation, no service switch.
 */

const FEE_CATEGORIES: ReadonlySet<string> = new Set(["reweight", "remeasure", "shipping_charge_correction"]);
const ESTIMATE_WARNINGS: ReadonlySet<string> = new Set(["dimensions_missing", "dim_divisor_missing", "zip_list_missing", "assumed_inputs", "unverified_rule_applied"]);
const HANDLING_VALUES: ReadonlySet<string> = new Set(["absorbed", "pass_through", "manual_approval", "unconfigured"]);

/** Fee categories kept on the CORRECTED pricing for each type. `shipping_charge_correction` is kept for every type. */
function categoriesInScope(type: AdjustmentType): ReadonlySet<string> {
  if (type === "reweight") return new Set(["reweight", "shipping_charge_correction"]);
  if (type === "remeasure") return new Set(["remeasure", "shipping_charge_correction"]);
  return new Set(["reweight", "remeasure", "shipping_charge_correction"]);
}

function safeDec(value: unknown): Dec | null {
  try {
    return typeof value === "string" ? dec(value) : null;
  } catch {
    return null;
  }
}

function weightLb(p: PackageInput): Dec | null {
  const w = safeDec(p.weight);
  return w === null ? null : toLb(w, p.weightUnit);
}

/** The corrected packages: each declared package overlaid with the fields its correction carries. */
export function correctedPackages(input: Pick<AdjustmentScenarioInput, "shipment" | "corrections">): PackageInput[] {
  return input.shipment.packages.map((p, i) => mergePackage(p, input.corrections[i] ?? {}));
}

function mergePackage(p: PackageInput, c: PackageCorrection): PackageInput {
  const out: PackageInput = { ...p };
  if (c.weight !== undefined && c.weight !== null) {
    out.weight = c.weight;
    out.weightUnit = c.weightUnit ?? p.weightUnit;
  }
  if (c.length !== undefined && c.length !== null) out.length = c.length;
  if (c.width !== undefined && c.width !== null) out.width = c.width;
  if (c.height !== undefined && c.height !== null) out.height = c.height;
  return out;
}

function weightChanged(a: PackageInput, b: PackageInput): boolean {
  const x = weightLb(a);
  const y = weightLb(b);
  return x === null || y === null ? true : !x.eq(y);
}

/** Dimensions compared AS ENTERED (15.4 to 15.3 is a remeasure although both round to 15); dimensions added where none were known are a change. */
function dimensionsChanged(a: PackageInput, b: PackageInput): boolean {
  for (const key of ["length", "width", "height"] as const) {
    const x = a[key];
    const y = b[key];
    if (x === undefined && y === undefined) continue;
    if (x === undefined || y === undefined) return true;
    const dx = safeDec(x);
    const dy = safeDec(y);
    if (dx === null || dy === null || !dx.eq(dy)) return true;
  }
  return false;
}

function sumAmounts(lines: ChargeLine[]): Dec {
  return lines.reduce((s, l) => s.plus(l.amount.amount), new D(0));
}

function sideStub(c: ShipmentCalculation): ScenarioSide {
  return { status: c.status, unavailableReason: c.unavailableReason, message: c.unavailableMessage, countedTotal: null, unresolved: null, zone: null, packages: [], warnings: [] };
}

function sideFull(c: ShipmentCalculation): ScenarioSide {
  const packages: SidePackage[] = c.packages.map((p) => ({ index: p.packageIndex, billableLb: p.billableLb, basis: p.basis, roundedDimensionsIn: p.roundedDimensionsIn }));
  return {
    status: "ok",
    unavailableReason: null,
    message: null,
    countedTotal: c.totals.expected.amount,
    unresolved: c.totals.unresolved.amount,
    zone: c.zone?.zone ?? null,
    packages,
    warnings: [...new Set(c.warnings.map((w) => w.code as string))],
  };
}

function isEstimate(c: ShipmentCalculation): boolean {
  if (c.lines.some((l) => (l.counted && l.chargeClass === "estimated") || l.status === "unknown")) return true;
  if (dec(c.totals.unresolved.amount).greaterThan(0)) return true;
  return c.warnings.some((w) => ESTIMATE_WARNINGS.has(w.code));
}

function emptyBuckets(): HandlingBuckets {
  return { customerPays: 0, decidedCaseByCase: 0, notBilledToCustomer: 0, notDecided: 0 };
}

function addToBucket(b: HandlingBuckets, handling: Handling, e4: number): void {
  if (handling === "pass_through") b.customerPays += e4;
  else if (handling === "manual_approval") b.decidedCaseByCase += e4;
  else if (handling === "absorbed") b.notBilledToCustomer += e4;
  else b.notDecided += e4;
}

/**
 * How many percent-of-shipping rules a fee schedule holds. They also move when the shipping charge changes; this module
 * only DETECTS them (a staff notice with the count), it does not model them. Pass the result as `percentOfShippingFeeCount`.
 */
export function countPercentOfShippingFees(rules: readonly Pick<FeeRule, "scope" | "basis">[]): number {
  return rules.filter((r) => r.scope === "order" && r.basis === "shipping_percent").length;
}

const money = (d: Dec): string => d.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);

export function evaluateAdjustmentScenario(
  input: AdjustmentScenarioInput,
  ctx: PricingContext,
  policyFn: PolicyFn,
  options: AdjustmentScenarioOptions = {},
): AdjustmentScenarioResult {
  const declaredSource: DeclaredSource = input.declaredSource === "wms_fallback" ? "wms_fallback" : "entered";
  const base = { engineVersion: ADJUSTMENT_ENGINE_VERSION, pricingEngineVersion: PRICING_ENGINE_VERSION, declaredSource, rateCardVersionId: ctx.rateCard.versionId };
  const empty = { adjustmentType: null, direction: null, basis: null, service: null, zone: null, sides: null, components: null, undecided: null, totalsE4: null, policySnapshot: null, warnings: [] as ScenarioWarning[], notices: [] as ScenarioNotice[] };
  const invalid = (message: string, sides: AdjustmentScenarioResult["sides"] = null): AdjustmentScenarioResult => ({ ...base, ...empty, status: "invalid_input", message, sides });

  const shipment = input.shipment;
  const corrections = input.corrections;
  if (input.declaredSource !== "entered" && input.declaredSource !== "wms_fallback") return invalid("The declared weight must say whether it was entered or is the fallback weight your system used at label creation.");
  if (!shipment || !Array.isArray(shipment.packages) || shipment.packages.length === 0 || !Array.isArray(corrections)) return invalid("A shipment with at least one package and a correction for each package is required.");

  // 1. The package count may not differ: one correction entry per declared package.
  if (corrections.length !== shipment.packages.length) {
    return invalid("Each declared package needs exactly one correction entry: the package count cannot differ between the declared and the corrected shipment.");
  }
  for (const c of corrections) {
    if (c && c.weightUnit !== undefined && c.weightUnit !== null && (c.weight === undefined || c.weight === null)) {
      return invalid("A weight unit was given without a corrected weight: enter the corrected weight and its unit together.");
    }
  }
  // 2. A label cannot be created at 0 lb.
  if (declaredSource === "wms_fallback") {
    for (const p of shipment.packages) {
      const w = weightLb(p);
      if (w !== null && w.lessThanOrEqualTo(0)) return invalid("Declared weight: a label cannot be created at 0 lb; enter the fallback your system used.");
    }
  }
  const correctedPkgs = correctedPackages(input);
  // 3. Classify from the INPUT diff.
  let weightDiffers = false;
  let dimensionsDiffer = false;
  const correctedIdx = new Set<number>();
  correctedPkgs.forEach((cp, i) => {
    const w = weightChanged(shipment.packages[i]!, cp);
    const d = dimensionsChanged(shipment.packages[i]!, cp);
    if (w) weightDiffers = true;
    if (d) dimensionsDiffer = true;
    if (w || d) correctedIdx.add(i);
  });
  if (!weightDiffers && !dimensionsDiffer) return invalid("There is nothing to correct: the corrected weight and dimensions are the same as the declared ones.");
  const type: AdjustmentType = weightDiffers && dimensionsDiffer ? "combined" : weightDiffers ? "reweight" : "remeasure";
  const inScope = categoriesInScope(type);

  const handlingOf = (t: PolicyType, c: PolicyComponent): Handling => {
    const v = policyFn(t, c);
    return HANDLING_VALUES.has(v) ? v : "unconfigured";
  };

  // 4. Price both sides. Declared: no adjustment-fee rule at all. Corrected: only the in-scope ones, forced conditional.
  const service = ctx.rateCard.services.find((s) => s.carrierCode === shipment.carrierCode && s.serviceCode === shipment.serviceCode);
  const declaredCtx: PricingContext = { ...ctx, rules: ctx.rules.filter((r) => !FEE_CATEGORIES.has(r.category)) };
  const correctedRules: SurchargeRule[] = [];
  for (const r of ctx.rules) {
    if (!FEE_CATEGORIES.has(r.category)) correctedRules.push(r);
    else if (inScope.has(r.category)) correctedRules.push(r.chargeClass === "conditional" ? r : { ...r, chargeClass: "conditional" });
  }
  const correctedCtx: PricingContext = { ...ctx, rules: correctedRules };
  const declared = calculateShipment(shipment, declaredCtx);
  const corrected = calculateShipment({ ...shipment, packages: correctedPkgs }, correctedCtx);

  const candidates = latestPerKey(ctx.rules.filter((r) => ruleIsCandidate(r, shipment.carrierCode, shipment.serviceCode, shipment.shipDate)))
    .filter((r) => !(service?.excludedSurchargeKeys ?? []).includes(r.key))
    .filter((r) => inScope.has(r.category));
  const warnings: ScenarioWarning[] = [];
  if (candidates.some((r) => r.chargeClass !== "conditional")) warnings.push("adjustment_fee_rule_not_conditional");

  const serviceInfo = declared.service ?? corrected.service;
  const unavailableText = (label: string, c: ShipmentCalculation) => (c.status === "unavailable" ? `${label}: ${c.unavailableMessage ?? "it could not be priced"}` : null);

  // 5. Engine input errors make the whole scenario invalid_input (an input error is not a pricing unavailability).
  if (declared.unavailableReason === "invalid_input" || corrected.unavailableReason === "invalid_input") {
    const parts = [unavailableText("Declared shipment", declared), unavailableText("Corrected shipment", corrected)].filter((x): x is string => x !== null);
    return invalid(parts.join(" "), { declared: sideStub(declared), corrected: sideStub(corrected) });
  }

  // 6. Unavailable sides: no amounts, nothing extrapolated, no other service substituted.
  if (declared.status === "unavailable" || corrected.status === "unavailable") {
    const status: ScenarioStatus = declared.status === "unavailable" && corrected.status === "unavailable" ? "both_unavailable" : declared.status === "unavailable" ? "declared_unavailable" : "corrected_unavailable";
    const parts = [unavailableText("Declared shipment", declared), unavailableText("Corrected shipment", corrected)].filter((x): x is string => x !== null);
    return {
      ...base,
      ...empty,
      status,
      message: parts.join(" "),
      adjustmentType: type,
      service: serviceInfo,
      sides: { declared: sideStub(declared), corrected: sideStub(corrected) },
      warnings,
    };
  }

  // 7. Both priced.
  const declaredTotal = dec(declared.totals.expected.amount);
  const correctedTotal = dec(corrected.totals.expected.amount);
  const delta = correctedTotal.minus(declaredTotal);
  const direction: Direction = delta.greaterThan(0) ? "increase" : delta.lessThan(0) ? "decrease" : "none";
  const billableEqual = declared.packages.length === corrected.packages.length && declared.packages.every((p, i) => dec(p.billableLb).eq(dec(corrected.packages[i]!.billableLb)));
  const noAdjustment = delta.isZero() && billableEqual;
  const basis: Basis = isEstimate(declared) || isEstimate(corrected) ? "estimate" : "exact";

  const pdHandling = handlingOf(type, "postage_difference");
  const postage: PostageDifferenceComponent = {
    kind: "postage_difference",
    state: direction === "decrease" ? "credit" : "computed",
    amount: money(delta),
    declaredTotal: money(declaredTotal),
    correctedTotal: money(correctedTotal),
    handling: pdHandling,
    ...(direction === "decrease" ? { creditAmount: money(delta.abs()) } : {}),
  };

  // Separate fee: lines of the in-scope adjustment-fee rules on the corrected pricing, per corrected package.
  const feeLinesAll = corrected.lines.filter((l) => l.rule !== null && FEE_CATEGORIES.has(l.category));
  const feeLines = feeLinesAll.filter((l) => l.packageIndex === null || correctedIdx.has(l.packageIndex));
  const lineHandling = (l: ChargeLine): Handling => handlingOf(l.category === "shipping_charge_correction" ? "correction" : type, "separate_fee");
  let feeState: FeeState;
  if (noAdjustment) feeState = "not_triggered";
  else if (candidates.length === 0) feeState = "not_configured";
  else if (direction !== "increase") feeState = "not_triggered";
  else if (feeLines.length === 0) feeState = "not_triggered";
  else if (feeLines.some((l) => l.status === "unknown")) feeState = "undecided";
  else if (feeLines.some((l) => l.status === "conditional")) feeState = "conditional";
  else if (feeLines.some((l) => l.status === "waived")) feeState = "waived_for_customer";
  else feeState = "included_in_rate";

  const conditional = feeState === "conditional" ? feeLines.filter((l) => l.status === "conditional") : [];
  // A fee is listed at the scope of its RULE: a per-package rule gives a line per corrected package; a shipment-level
  // rule gives one shipment-level line. (The pricing engine computes a percent rule per package so cents round as a
  // carrier rounds them; the kept package lines of a shipment-level rule are summed back into its one line.)
  const perPackageRule = new Map(candidates.map((r) => [r.key, r.perPackage]));
  const methodOf = new Map(candidates.map((r) => [r.key, r.method]));
  const grouped = new Map<string, { first: ChargeLine; amount: Dec }>();
  for (const l of conditional) {
    const scoped = perPackageRule.get(l.rule!.key) === true;
    const id = scoped ? `${l.rule!.key}|${l.packageIndex ?? "s"}` : `${l.rule!.key}|*`;
    const cur = grouped.get(id);
    grouped.set(id, cur ? { first: cur.first, amount: cur.amount.plus(l.amount.amount) } : { first: l, amount: new D(l.amount.amount) });
  }
  const listed: FeeLine[] = [...grouped.values()]
    .map(({ first, amount }) => ({
      ruleKey: first.rule!.key,
      label: first.label,
      category: first.category as FeeLine["category"],
      packageIndex: perPackageRule.get(first.rule!.key) === true ? first.packageIndex : null,
      amount: money(amount),
      handling: lineHandling(first),
      method: methodOf.get(first.rule!.key) ?? "flat",
    }))
    .sort((a, b) => (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : (a.packageIndex ?? -1) - (b.packageIndex ?? -1)));
  const lineHandlings = [...new Set(listed.map((l) => l.handling))];
  const feeHandling: Handling | "mixed" = listed.length === 0 ? handlingOf(type, "separate_fee") : lineHandlings.length === 1 ? lineHandlings[0]! : "mixed";
  const fee: SeparateFeeComponent = {
    kind: "separate_fee",
    state: feeState,
    amount: feeState === "conditional" ? money(sumAmounts(conditional)) : null,
    handling: feeHandling,
    lines: listed,
    ...(feeState === "undecided" ? { upTo: money(sumAmounts(feeLines.filter((l) => l.status === "unknown"))) } : {}),
  };

  // Undecided: amounts the difference INCLUDES that rest on a charge that could not be decided on the other side.
  const countedKeys = (c: ShipmentCalculation) => new Set(c.lines.filter((l) => l.counted && l.rule).map((l) => `${l.rule!.key}|${l.packageIndex ?? "s"}`));
  const undecided: UndecidedItem[] = [];
  for (const [side, calc, other] of [["declared", declared, corrected], ["corrected", corrected, declared]] as const) {
    const otherCounted = countedKeys(other);
    const items = calc.lines
      .filter((l) => l.status === "unknown" && l.rule && otherCounted.has(`${l.rule.key}|${l.packageIndex ?? "s"}`))
      .map((l) => ({ label: l.label, upTo: l.amount.amount, side, packageIndex: l.packageIndex }))
      .sort((a, b) => (a.packageIndex ?? Number.MAX_SAFE_INTEGER) - (b.packageIndex ?? Number.MAX_SAFE_INTEGER) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    undecided.push(...items);
  }

  // Buckets: only an increase can be billed; a credit never enters a bucket.
  const totals = emptyBuckets();
  if (direction === "increase") {
    addToBucket(totals, pdHandling, toE4(delta));
    for (const l of listed) addToBucket(totals, l.handling, toE4(dec(l.amount)));
  }

  const snapshot: PolicySnapshotEntry[] = [
    { type, component: "postage_difference", handling: pdHandling },
    { type, component: "separate_fee", handling: handlingOf(type, "separate_fee") },
  ];
  if (listed.some((l) => l.category === "shipping_charge_correction")) snapshot.push({ type: "correction", component: "separate_fee", handling: handlingOf("correction", "separate_fee") });

  if (new Set(listed.map((l) => l.ruleKey)).size >= 2) warnings.push("adjustment_fee_rules_stack");

  const notices: ScenarioNotice[] = [];
  if (feeState === "conditional" || feeState === "undecided") notices.push({ code: "fuel_on_adjustment_fee_not_modelled", message: "Fuel on the adjustment fee is not modelled: the fee shown is the fee alone." });
  if ((options.percentOfShippingFeeCount ?? 0) > 0) {
    notices.push({
      code: "percent_of_shipping_fees_not_modelled",
      count: options.percentOfShippingFeeCount,
      message: `Postage only: your fee schedule has ${options.percentOfShippingFeeCount} percent-of-shipping fee(s) that also move when the shipping charge changes. They are not modelled here.`,
    });
  }

  return {
    ...base,
    status: noAdjustment ? "no_adjustment" : "ok",
    message: null,
    adjustmentType: type,
    direction,
    basis,
    service: serviceInfo,
    zone: corrected.zone?.zone ?? declared.zone?.zone ?? null,
    sides: { declared: sideFull(declared), corrected: sideFull(corrected) },
    components: { postage_difference: postage, separate_fee: fee },
    undecided,
    totalsE4: totals,
    policySnapshot: snapshot,
    warnings,
    notices,
  };
}
