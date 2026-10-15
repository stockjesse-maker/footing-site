import { categoryRank } from "./carriers";
import { measurePackage } from "./dim";
import { D, dec, fmt, sumMoney, toMoney, zeroMoney, type Dec } from "./money";
import { lookupRate } from "./rates";
import { activeOverride, evaluateRule, indexZipLists, latestPerKey, ruleIsCandidate, unknownReason, type ConditionOutcome, type EvaluationContext, type PackageContext } from "./surcharges";
import type {
  CalculationWarning,
  ChargeClass,
  ChargeLine,
  Money,
  PricingContext,
  RuleReference,
  ServiceTerms,
  ShipmentCalculation,
  ShipmentInput,
  SurchargeOverride,
  SurchargeRule,
  Totals,
  UnavailableReason,
  ZoneResult,
} from "./types";
import { validateShipment } from "./validate";
import { resolveZone } from "./zones";

interface Candidate {
  rule: SurchargeRule;
  packageIndex: number | null;
  outcome: ConditionOutcome;
  override: SurchargeOverride | null;
  suppressed: string | null; // reason text when suppressed by exclusivity/bundling
}

function ruleRef(rule: SurchargeRule): RuleReference {
  return { key: rule.key, version: rule.version, scope: rule.scope, sourceReference: rule.sourceReference, verificationStatus: rule.verificationStatus };
}

function emptyTotals(currency: ShipmentCalculation["currency"]): Totals {
  const z = zeroMoney(currency);
  return { definite: z, estimated: z, expected: z, conditionalExposure: z };
}

function unavailable(input: ShipmentInput, ctx: PricingContext, reason: UnavailableReason, message: string, extra: Partial<ShipmentCalculation> = {}): ShipmentCalculation {
  const currency = ctx.rateCard.currency;
  return {
    status: "unavailable",
    unavailableReason: reason,
    unavailableMessage: message,
    currency,
    input,
    service: null,
    zone: null,
    packages: [],
    lines: [],
    totals: emptyTotals(currency),
    references: { rateCardId: ctx.rateCard.rateCardId, rateCardVersionId: ctx.rateCard.versionId, rateCardVersionNumber: ctx.rateCard.versionNumber, termsVersion: null, rules: [] },
    warnings: [],
    ...extra,
  };
}

/**
 * Prices one shipment against a customer-facing rate card and the surcharge rules in force on the
 * ship date. Pure and deterministic: same inputs, same output, forever.
 */
export function calculateShipment(rawInput: ShipmentInput, ctx: PricingContext): ShipmentCalculation {
  const validated = validateShipment(rawInput);
  if (!validated.ok) {
    return unavailable(rawInput, ctx, "invalid_input", `The shipment could not be priced: ${validated.problems.join("; ")}.`);
  }
  const input = validated.value as ShipmentInput;
  const card = ctx.rateCard;
  const currency = card.currency;
  const warnings: CalculationWarning[] = [];

  if (input.shipDate < card.effectiveDate || (card.expirationDate && input.shipDate > card.expirationDate)) {
    return unavailable(input, ctx, "rate_card_not_effective", `Rate card "${card.rateCardName}" version ${card.versionNumber} is not in effect on ${input.shipDate} (effective ${card.effectiveDate}${card.expirationDate ? ` to ${card.expirationDate}` : ""}).`);
  }

  const service: ServiceTerms | undefined = card.services.find((s) => s.carrierCode === input.carrierCode && s.serviceCode === input.serviceCode);
  if (!service) {
    return unavailable(input, ctx, "service_not_on_rate_card", `${input.carrierCode}/${input.serviceCode} is not on rate card "${card.rateCardName}".`);
  }
  const serviceInfo = { serviceId: service.serviceId, serviceCode: service.serviceCode, serviceName: service.serviceName, carrierCode: service.carrierCode };
  const references = { rateCardId: card.rateCardId, rateCardVersionId: card.versionId, rateCardVersionNumber: card.versionNumber, termsVersion: service.termsVersion, rules: [] as RuleReference[] };

  // 1. Billable weight per package
  const packages: PackageContext[] = input.packages.map((p, index) => ({ index, input: p, m: measurePackage(p, index, service.dim) }));
  let baseClass: ChargeClass = "definite";
  for (const p of packages) {
    if (p.m.result.basis === "no_divisor") {
      baseClass = "estimated";
      if (!warnings.some((w) => w.code === "dim_divisor_missing")) warnings.push({ code: "dim_divisor_missing", message: `The rate card states no DIM divisor for ${service.serviceName}; prices assume actual weight and are estimates.` });
    } else if (p.m.result.basis === "no_dimensions") {
      baseClass = "estimated";
      if (!warnings.some((w) => w.code === "dimensions_missing")) warnings.push({ code: "dimensions_missing", message: "Package dimensions were not given, so dimensional weight could not be checked; prices assume actual weight and are estimates." });
    }
  }

  // 2. Zone
  let zone: ZoneResult | null = null;
  if (input.destinationZone) {
    zone = { zone: input.destinationZone.trim().toUpperCase(), source: "input", explanation: `Zone ${input.destinationZone.trim().toUpperCase()} as entered.` };
  } else {
    zone = resolveZone(card.zones, input.carrierCode, input.originZip, input.destinationZip!);
    if (!zone) {
      if (!card.zones.some((z) => z.carrierCode === input.carrierCode)) warnings.push({ code: "zone_chart_missing", message: `Rate card "${card.rateCardName}" has no zone chart for ${input.carrierCode}; enter the zone directly or add a zone chart.` });
      return unavailable(input, ctx, "zone_unresolved", `No zone could be determined from ${input.originZip} to ${input.destinationZip} on this rate card.`, { service: serviceInfo, packages: packages.map((p) => p.m.result), warnings, references });
    }
  }

  // 3. Base rate per package
  const lines: ChargeLine[] = [];
  for (const p of packages) {
    const found = lookupRate(card.rows, service.serviceId, input.originZip, zone.zone, p.m.billableLb);
    if (!found.ok) {
      return unavailable(input, ctx, found.reason, `${found.message} (package ${p.index + 1}: billable ${p.m.result.billableLb} lb)`, { service: serviceInfo, zone, packages: packages.map((q) => q.m.result), warnings, references });
    }
    const price = dec(found.row.price);
    lines.push({
      kind: "base",
      category: "base",
      label: `${service.serviceName} base rate`,
      amount: toMoney(price, currency),
      chargeClass: baseClass,
      counted: true,
      packageIndex: p.index,
      explanation: `Zone ${zone.zone}, ${fmt(found.comparedWeight, 3)} ${found.row.weightUnit} billable (bracket ${fmt(dec(found.row.weightMin), 3)}–${fmt(dec(found.row.weightMax), 3)} ${found.row.weightUnit})${found.originScope === "any_origin" ? "" : ` from origin ${found.originScope === "origin_5" ? input.originZip : input.originZip.slice(0, 3)}`}, rate card "${card.rateCardName}" v${card.versionNumber}.`,
      basis: `rate_card:${card.versionId}:${service.serviceId}:${found.row.zone}:${found.row.weightMax}${found.row.weightUnit}`,
      rule: null,
    });
    const minimum = [found.row.minCharge, service.minCharge].filter((m): m is string => m !== null).map((m) => dec(m)).sort((a, b) => b.comparedTo(a))[0];
    if (minimum && minimum.greaterThan(price)) {
      lines.push({
        kind: "minimum_charge",
        category: "base",
        label: "Minimum charge adjustment",
        amount: toMoney(minimum.minus(price), currency),
        chargeClass: baseClass,
        counted: true,
        packageIndex: p.index,
        explanation: `The rate card minimum charge of ${fmt(minimum, 2)} exceeds the bracket rate of ${fmt(price, 2)}.`,
        basis: `minimum:${fmt(minimum, 2)}`,
        rule: null,
      });
    }
  }

  // 4. Surcharge candidates
  const evalCtx: EvaluationContext = { shipment: input, zone: zone.zone, packages, zipLists: indexZipLists(ctx.zipLists) };
  const rules = latestPerKey(ctx.rules.filter((r) => ruleIsCandidate(r, input.carrierCode, input.serviceCode, input.shipDate)))
    .filter((r) => !service.excludedSurchargeKeys.includes(r.key))
    .sort((a, b) => categoryRank(input.carrierCode, a.category) - categoryRank(input.carrierCode, b.category) || a.key.localeCompare(b.key));

  const candidates: Candidate[] = [];
  for (const rule of rules) {
    const override = activeOverride(ctx.overrides, rule.key, input.shipDate);
    const scopes: (PackageContext | null)[] = rule.perPackage ? packages : [null];
    for (const scope of scopes) {
      const outcome = evaluateRule(rule, evalCtx, scope);
      if (outcome === "not") continue;
      candidates.push({ rule, packageIndex: scope ? scope.index : null, outcome, override, suppressed: null });
    }
  }

  // 5. Exclusivity: within a group (and package scope) only the top-priority applying rule survives.
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.rule.exclusivityGroup) continue;
    const key = `${c.rule.exclusivityGroup}|${c.packageIndex ?? "shipment"}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const members of groups.values()) {
    const applying = members.filter((m) => m.outcome === "applies" && !(m.override && m.override.mode === "exclude"));
    if (!applying.length) continue;
    const winner = applying.sort((a, b) => b.rule.exclusivityPriority - a.rule.exclusivityPriority || provisionalAmount(b).comparedTo(provisionalAmount(a)) || a.rule.key.localeCompare(b.rule.key))[0]!;
    for (const m of members) if (m !== winner) m.suppressed = `${winner.rule.name} applies instead (mutually exclusive, group "${winner.rule.exclusivityGroup}").`;
  }
  // 6. Bundling: an applying rule suppresses the keys it lists.
  for (const c of candidates) {
    if (c.suppressed || c.outcome !== "applies" || !c.rule.excludesRuleKeys.length) continue;
    for (const other of candidates) {
      if (other !== c && !other.suppressed && c.rule.excludesRuleKeys.includes(other.rule.key) && (other.packageIndex === c.packageIndex || c.packageIndex === null)) {
        other.suppressed = `Bundled into ${c.rule.name}; not charged separately.`;
      }
    }
  }

  // 7. Amounts. Flat and per-unit first, then percentages (fuel last) over the lines counted so far.
  const ordered = candidates.filter((c) => !c.suppressed).sort((a, b) => Number(a.rule.method === "percent") - Number(b.rule.method === "percent") || Number(a.rule.category === "fuel") - Number(b.rule.category === "fuel"));
  for (const c of ordered) {
    const rule = c.rule;
    const classification: ChargeClass = c.outcome === "unknown" ? "estimated" : rule.chargeClass;
    const included = service.includedSurchargeKeys.includes(rule.key);
    const waived = c.override?.mode === "exclude";
    const counted = !included && !waived && c.outcome === "applies" && rule.chargeClass !== "conditional";

    const emit = (amount: Dec, basis: string, packageIndex: number | null, baseNote: string) => {
      let explanation = baseNote;
      if (c.outcome === "unknown") explanation = `Could not confirm whether ${rule.name} applies: ${unknownReason(rule, evalCtx, packageIndex === null ? null : packages[packageIndex]!)}. Shown as an estimate and not included in the total.`;
      else if (waived) explanation = `${baseNote} Waived for this customer (${c.override!.reference}); not charged.`;
      else if (included) explanation = `${baseNote} Included in the base rate under the rate card terms; not charged separately.`;
      else if (rule.chargeClass === "conditional") explanation = `${baseNote} Charged only if the carrier applies it after shipping; shown as potential exposure, not included in the total.`;
      if (c.override && c.override.mode !== "exclude") explanation = `${explanation} Customer-specific rate applied (${c.override.reference}).`;
      lines.push({
        kind: rule.category === "fuel" ? "fuel" : "surcharge",
        category: rule.category,
        label: rule.name,
        amount: toMoney(amount, currency),
        chargeClass: classification,
        counted,
        packageIndex,
        explanation,
        basis,
        rule: ruleRef(rule),
      });
    };

    const amountValue = c.override?.mode === "override_amount" ? dec(c.override.amount!) : rule.amount ? dec(rule.amount) : null;
    const percentValue = c.override?.mode === "override_percent" ? dec(c.override.percent!) : rule.percent ? dec(rule.percent) : null;

    if (rule.method === "flat") {
      emit(amountValue ?? new D(0), `flat ${fmt(amountValue ?? new D(0), 2)}`, c.packageIndex, `${rule.name}: flat ${fmt(amountValue ?? new D(0), 2)}${c.packageIndex === null ? " per shipment" : " per package"}.`);
    } else if (rule.method === "per_unit") {
      const units = perUnitCount(c, packages);
      if (units === null) continue;
      const total = (amountValue ?? new D(0)).times(units);
      emit(total, `${fmt(amountValue ?? new D(0), 2)} × ${units} units`, c.packageIndex, `${rule.name}: ${units} × ${fmt(amountValue ?? new D(0), 2)} per ${fmt(dec(rule.perUnit!.unitSize), 0)} of declared value above ${fmt(dec(rule.perUnit!.freeAllowance), 0)}.`);
    } else {
      const pct = percentValue ?? new D(0);
      const scopes = c.packageIndex === null ? [...packages.map((p) => p.index as number | null), null] : [c.packageIndex];
      // For a per-shipment percent rule we still apply it per package (carriers compute fuel on each
      // package's charges), plus once over shipment-level lines, so rounding matches carrier billing.
      for (const scope of scopes) {
        const { base, estimated: baseIsEstimated } = percentBase(rule, lines, scope);
        if (base.isZero()) continue;
        const amount = base.times(pct).div(100);
        const before = lines.length;
        emit(amount, `${fmt(pct, 4)}% of ${fmt(base, 2)}`, scope, `${rule.name}: ${fmt(pct, 2)}% of ${fmt(base, 2)} (${baseDescription(rule)}).`);
        // A percentage of an estimated amount is itself an estimate, whatever the rule's own class.
        const line = lines[before];
        if (line && baseIsEstimated && line.chargeClass === "definite") {
          line.chargeClass = "estimated";
          line.explanation = `${line.explanation} Marked as an estimate because part of its base is estimated.`;
        }
      }
    }
  }

  // 8. Order lines for display: per package (base, minimum, surcharges by carrier order), then shipment-level, fuel last.
  lines.sort((a, b) => {
    const pa = a.packageIndex ?? Number.MAX_SAFE_INTEGER;
    const pb = b.packageIndex ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    const fa = a.kind === "fuel" ? 1 : 0;
    const fb = b.kind === "fuel" ? 1 : 0;
    if (fa !== fb) return fa - fb;
    const ka = a.kind === "base" ? 0 : a.kind === "minimum_charge" ? 1 : 2;
    const kb = b.kind === "base" ? 0 : b.kind === "minimum_charge" ? 1 : 2;
    if (ka !== kb) return ka - kb;
    return categoryRank(input.carrierCode, a.category) - categoryRank(input.carrierCode, b.category) || a.label.localeCompare(b.label);
  });

  // 9. Totals and references
  const sum = (pred: (l: ChargeLine) => boolean): Money => sumMoney(lines.filter(pred).map((l) => l.amount), currency);
  const definite = sum((l) => l.counted && l.chargeClass === "definite");
  const estimated = sum((l) => l.counted && l.chargeClass === "estimated");
  const expected = sumMoney([definite, estimated], currency);
  const conditionalExposure = sum((l) => l.chargeClass === "conditional" && !l.counted && !service.includedSurchargeKeys.includes(l.rule?.key ?? ""));

  const seen = new Set<string>();
  for (const l of lines) {
    if (l.rule && !seen.has(`${l.rule.key}@${l.rule.version}`)) {
      seen.add(`${l.rule.key}@${l.rule.version}`);
      references.rules.push(l.rule);
      if (l.counted && l.rule.verificationStatus === "unverified") warnings.push({ code: "unverified_rule_applied", ruleKey: l.rule.key, message: `"${l.label}" uses a rule that has not been verified (${l.rule.sourceReference}).` });
    }
  }
  for (const c of candidates) {
    if (c.override?.mode === "exclude" && !warnings.some((w) => w.ruleKey === c.rule.key && w.code === "rule_overridden")) {
      warnings.push({ code: "rule_overridden", ruleKey: c.rule.key, message: `${c.rule.name} is waived for this customer (${c.override.reference}).` });
    }
  }
  if (evalCtx.zipLists.size === 0 && candidates.some((c) => c.outcome === "unknown" && c.rule.conditions.some((k) => k.type === "destination_zip_in_list"))) {
    warnings.push({ code: "zip_list_missing", message: "A surcharge depends on a ZIP code list that is not loaded; it is shown as an estimate." });
  }

  return {
    status: "ok",
    unavailableReason: null,
    unavailableMessage: null,
    currency,
    input,
    service: serviceInfo,
    zone,
    packages: packages.map((p) => p.m.result),
    lines,
    totals: { definite, estimated, expected, conditionalExposure },
    references,
    warnings,
  };
}

/** Amount used only to break exclusivity ties between flat rules (percent rules compare as zero). */
function provisionalAmount(c: Candidate): Dec {
  if (c.override?.mode === "override_amount") return dec(c.override.amount!);
  return c.rule.amount ? dec(c.rule.amount) : new D(0);
}

function perUnitCount(c: Candidate, packages: PackageContext[]): number | null {
  const unit = c.rule.perUnit;
  if (!unit) return null;
  const targets = c.packageIndex === null ? packages : [packages[c.packageIndex]!];
  let units = 0;
  for (const p of targets) {
    if (p.input.declaredValue === undefined) continue;
    const excess = dec(p.input.declaredValue).minus(dec(unit.freeAllowance));
    if (excess.lessThanOrEqualTo(0)) continue;
    units += excess.div(dec(unit.unitSize)).toDecimalPlaces(0, D.ROUND_CEIL).toNumber();
  }
  return units > 0 ? units : null;
}

/** Sum of counted lines (for the package scope) that the rule's calculation base includes, and whether any of them is an estimate. */
function percentBase(rule: SurchargeRule, lines: ChargeLine[], packageIndex: number | null): { base: Dec; estimated: boolean } {
  let base = new D(0);
  let estimated = false;
  for (const l of lines) {
    if (!l.counted || l.packageIndex !== packageIndex || l.kind === "fuel") continue;
    const isBase = l.kind === "base" || l.kind === "minimum_charge";
    const include =
      rule.base.kind === "base_rate" ? isBase
      : rule.base.kind === "base_plus_all_surcharges" ? true
      : isBase || (l.category !== "base" && rule.base.categories.includes(l.category));
    if (include) {
      base = base.plus(l.amount.amount);
      if (l.chargeClass === "estimated") estimated = true;
    }
  }
  return { base, estimated };
}

function baseDescription(rule: SurchargeRule): string {
  switch (rule.base.kind) {
    case "base_rate":
      return "base rate";
    case "base_plus_all_surcharges":
      return "base rate plus all surcharges";
    case "base_plus_categories":
      return `base rate plus ${rule.base.categories.join(", ")}`;
  }
}
