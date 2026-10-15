import { categoryRank } from "./carriers";
import { measurePackage, type RuleFloor } from "./dim";
import { D, dec, fmt, sumMoney, toMoney, zeroMoney, type Dec } from "./money";
import { lookupRate } from "./rates";
import {
  activeOverride,
  compareKeys,
  evaluateRule,
  indexZipLists,
  latestPerKey,
  referencedRuleKeys,
  referencesRule,
  ruleIsCandidate,
  unknownReason,
  type ConditionOutcome,
  type EvaluationContext,
  type PackageContext,
} from "./surcharges";
import {
  ENGINE_VERSION,
  type CalculationWarning,
  type ChargeClass,
  type ChargeLine,
  type LineStatus,
  type Money,
  type PricingContext,
  type RuleReference,
  type ServiceTerms,
  type ShipmentCalculation,
  type ShipmentInput,
  type SurchargeOverride,
  type SurchargeRule,
  type Totals,
  type UnavailableReason,
  type ZoneResult,
} from "./types";
import { validateShipment } from "./validate";
import { normalizeZone, resolveZone } from "./zones";

interface Candidate {
  rule: SurchargeRule;
  packageIndex: number | null;
  outcome: ConditionOutcome;
  override: SurchargeOverride | null;
  /** Lost its exclusivity group to this rule (name), or null. */
  excludedBy: string | null;
  /** Bundled into this rule (name), or null. */
  bundledBy: string | null;
  /** A higher-priority member of its group could not be decided; noted on the line (the unknown member carries the exposure). */
  uncertainNote: string | null;
}

const isWaived = (c: Candidate) => c.override?.mode === "exclude";
const suppressed = (c: Candidate) => c.excludedBy !== null || c.bundledBy !== null;
const live = (c: Candidate) => c.outcome === "applies" && !isWaived(c) && !suppressed(c);

function ruleRef(rule: SurchargeRule): RuleReference {
  return { key: rule.key, version: rule.version, scope: rule.scope, sourceReference: rule.sourceReference, verificationStatus: rule.verificationStatus };
}

function emptyTotals(currency: ShipmentCalculation["currency"]): Totals {
  const z = zeroMoney(currency);
  return { definite: z, estimated: z, expected: z, conditionalExposure: z, unresolved: z };
}

function emptyReferences(ctx: PricingContext): ShipmentCalculation["references"] {
  return {
    engineVersion: ENGINE_VERSION,
    rateCardId: ctx.rateCard.rateCardId,
    rateCardVersionId: ctx.rateCard.versionId,
    rateCardVersionNumber: ctx.rateCard.versionNumber,
    termsVersion: null,
    rules: [],
    zipLists: [],
    overrides: [],
  };
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
    references: emptyReferences(ctx),
    warnings: [],
    ...extra,
  };
}

/** Deterministic order: priority desc, then key (code points), then package. */
function candidateOrder(a: Candidate, b: Candidate): number {
  return b.rule.exclusivityPriority - a.rule.exclusivityPriority || compareKeys(a.rule.key, b.rule.key) || (a.packageIndex ?? -1) - (b.packageIndex ?? -1);
}

/**
 * Resolves mutual exclusion and bundling until stable:
 *  1. Exclusivity: within each group (per package scope), among members that apply, are not waived
 *     and are not bundled away, the highest priority wins (ties: the larger computed amount, then
 *     key order); the other applying members are dropped, except a waived member that would have won
 *     (it is shown as waived, since the waiver is what changed the bill). Unknown members stay (they
 *     are listed as uncounted estimates); when one outranks the winner, the winner's line says so.
 *  2. Bundling: starting from every kept applying rule, the rules it lists in `excludesRuleKeys`
 *     are bundled away, and so on transitively (a bundled rule still absorbs what it lists), so the
 *     outcome never depends on key spelling. Per-package rules bundle only within their package.
 * Bundling can remove a group winner, which re-opens that group: iterate to a fixed point.
 */
function resolveConflicts(candidates: Candidate[], amountOf: (c: Candidate) => Dec): void {
  for (let iteration = 0; iteration < 20; iteration++) {
    const before = candidates.map((c) => `${c.excludedBy}|${c.bundledBy}`).join(";");
    for (const c of candidates) {
      c.excludedBy = null;
      c.uncertainNote = null;
    }
    const groups = new Map<string, Candidate[]>();
    for (const c of candidates) {
      if (!c.rule.exclusivityGroup || c.bundledBy) continue;
      const key = `${c.rule.exclusivityGroup}|${c.packageIndex ?? "shipment"}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const members of groups.values()) {
      const applying = members.filter((m) => m.outcome === "applies" && !isWaived(m) && !m.bundledBy);
      if (!applying.length) continue;
      const rank = (a: Candidate, b: Candidate) => b.rule.exclusivityPriority - a.rule.exclusivityPriority || amountOf(b).comparedTo(amountOf(a)) || compareKeys(a.rule.key, b.rule.key);
      const winner = applying.sort(rank)[0]!;
      for (const m of members) {
        if (m === winner || m.outcome === "unknown") continue;
        // A waived member that would have won stays visible as waived: the waiver is what changed the bill.
        if (isWaived(m) && m.outcome === "applies" && rank(m, winner) < 0) continue;
        m.excludedBy = winner.rule.name;
      }
      const outranking = members.filter((m) => m.outcome === "unknown" && m.rule.exclusivityPriority > winner.rule.exclusivityPriority);
      if (outranking.length) winner.uncertainNote = `${outranking.map((m) => m.rule.name).join(" or ")} could apply instead if it can be decided, so this charge may be replaced.`;
    }

    for (const c of candidates) c.bundledBy = null;
    const queue = candidates.filter(live);
    const seen = new Set<Candidate>(queue);
    while (queue.length) {
      const c = queue.shift()!;
      if (!c.rule.excludesRuleKeys.length) continue;
      for (const other of candidates) {
        if (other === c || other.bundledBy || !c.rule.excludesRuleKeys.includes(other.rule.key)) continue;
        if (c.packageIndex !== null && other.packageIndex !== null && other.packageIndex !== c.packageIndex) continue;
        other.bundledBy = c.rule.name;
        if (!seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
    const after = candidates.map((c) => `${c.excludedBy}|${c.bundledBy}`).join(";");
    if (after === before) return;
  }
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
  const warn = (w: CalculationWarning) => {
    if (!warnings.some((x) => x.code === w.code && x.ruleKey === w.ruleKey)) warnings.push(w);
  };

  if (input.shipDate < card.effectiveDate || (card.expirationDate && input.shipDate > card.expirationDate)) {
    return unavailable(input, ctx, "rate_card_not_effective", `Rate card "${card.rateCardName}" version ${card.versionNumber} is not in effect on ${input.shipDate} (effective ${card.effectiveDate}${card.expirationDate ? ` to ${card.expirationDate}` : ""}).`);
  }

  const service: ServiceTerms | undefined = card.services.find((s) => s.carrierCode === input.carrierCode && s.serviceCode === input.serviceCode);
  if (!service) {
    return unavailable(input, ctx, "service_not_on_rate_card", `${input.carrierCode}/${input.serviceCode} is not on rate card "${card.rateCardName}".`);
  }
  const serviceInfo = { serviceId: service.serviceId, serviceCode: service.serviceCode, serviceName: service.serviceName, carrierCode: service.carrierCode };
  const references = { ...emptyReferences(ctx), termsVersion: service.termsVersion };

  // 1. Candidate rules in force for this service, with customer overrides.
  const rules = latestPerKey(ctx.rules.filter((r) => ruleIsCandidate(r, input.carrierCode, input.serviceCode, input.shipDate))).filter((r) => !service.excludedSurchargeKeys.includes(r.key));
  const overrideFor = (rule: SurchargeRule) => activeOverride(ctx.overrides, rule.key, input.shipDate);

  // 2. Billable weight per package, before any rule-imposed floor (floors never feed back into conditions).
  let packages: PackageContext[] = input.packages.map((p, index) => ({ index, input: p, m: measurePackage(p, index, service.dim) }));
  const dimUnknown = (p: PackageContext) => !service.dim.exempt && (p.m.dimsIn === null || service.dim.divisor === null);
  for (const p of packages) {
    if (service.dim.exempt) continue;
    if (p.m.dimsIn === null) warn({ code: "dimensions_missing", message: "Package dimensions were not given, so dimensional weight could not be checked; prices assume actual weight and are estimates." });
    else if (service.dim.divisor === null) warn({ code: "dim_divisor_missing", message: `The rate card states no DIM divisor for ${service.serviceName}; prices assume actual weight and are estimates.` });
  }

  // 3. Zone
  let zone: ZoneResult;
  if (service.zoneIndependent) {
    zone = { zone: "ALL", source: "zone_independent", explanation: `${service.serviceName} is priced without zones on this rate card.` };
  } else if (input.destinationZone) {
    const z = normalizeZone(input.destinationZone);
    zone = { zone: z, source: "input", explanation: `Zone ${z} as entered.` };
  } else {
    const lookup = resolveZone(card.zones, input.carrierCode, service.zoneChartKey, input.originZip, input.destinationZip!);
    if (!lookup.ok) {
      if (lookup.reason === "no_chart") warn({ code: "zone_chart_missing", message: `${lookup.message} Enter the zone directly or add a zone chart.` });
      return unavailable(input, ctx, lookup.reason === "ambiguous" ? "zone_ambiguous" : "zone_unresolved", lookup.message, {
        service: serviceInfo,
        packages: packages.map((p) => p.m.result),
        warnings,
        references,
      });
    }
    zone = lookup.zone;
  }

  // 4. Surcharge applicability: first pass, then rules conditioned on other rules, then conflicts.
  const evalCtx: EvaluationContext = { shipment: input, zone: zone.zone, packages, zipLists: indexZipLists(ctx.zipLists, input.shipDate), applied: null };
  const ordered = [...rules].sort((a, b) => categoryRank(input.carrierCode, a.category) - categoryRank(input.carrierCode, b.category) || compareKeys(a.key, b.key));
  const firstPass = ordered.filter((r) => !r.conditions.some(referencesRule));
  const secondPass = ordered.filter((r) => r.conditions.some(referencesRule));
  const secondPassKeys = new Set(secondPass.map((r) => r.key));

  // Provisional base per package (pre-floor) so exclusivity ties can compare computed amounts.
  const provisionalBase = packages.map((p) => {
    const found = lookupRate(card.rows, service.serviceId, input.originZip, zone.zone, p.m.billableLb);
    return found.ok ? dec(found.row.price) : new D(0);
  });
  const markupOf = (c: Candidate): Dec | null => {
    if (c.override?.mode === "markup_percent") return dec(c.override.percent!);
    if (c.override) return null; // an absolute override replaces the published figure; no markup on top
    return service.surchargeMarkupPercent !== null ? dec(service.surchargeMarkupPercent) : null;
  };
  const scaleBy = (c: Candidate, v: Dec) => {
    const m = markupOf(c);
    return m ? v.times(m.plus(100)).div(100) : v;
  };
  const amountValueOf = (c: Candidate): Dec | null => (c.override?.mode === "override_amount" ? dec(c.override.amount!) : c.rule.amount ? scaleBy(c, dec(c.rule.amount)) : null);
  const percentValueOf = (c: Candidate): Dec | null =>
    c.override?.mode === "override_percent" ? dec(c.override.percent!)
    : c.override?.mode === "add_percent_points" ? (c.rule.percent ? dec(c.rule.percent) : new D(0)).plus(dec(c.override.percent!))
    : c.rule.percent ? scaleBy(c, dec(c.rule.percent)) : null;
  const computedAmountOf = (c: Candidate): Dec => {
    const rule = c.rule;
    if (rule.method === "flat") return amountValueOf(c) ?? new D(0);
    if (rule.method === "per_unit") {
      const units = perUnitCount(c, packages) ?? 0;
      let total = (amountValueOf(c) ?? new D(0)).times(units);
      if (rule.perUnit?.minimumCharge !== null && rule.perUnit?.minimumCharge !== undefined) {
        const min = c.override?.mode === "override_amount" ? dec(rule.perUnit.minimumCharge) : scaleBy(c, dec(rule.perUnit.minimumCharge));
        if (units > 0 && total.lessThan(min)) total = min;
      }
      return total;
    }
    const base = c.packageIndex === null ? provisionalBase.reduce((s, b) => s.plus(b), new D(0)) : (provisionalBase[c.packageIndex] ?? new D(0));
    return base.times(percentValueOf(c) ?? new D(0)).div(100);
  };

  const candidates: Candidate[] = [];
  const collect = (rule: SurchargeRule) => {
    const override = overrideFor(rule);
    const scopes: (PackageContext | null)[] = rule.perPackage ? packages : [null];
    for (const scope of scopes) {
      const outcome = evaluateRule(rule, evalCtx, scope);
      if (outcome === "not") continue;
      candidates.push({ rule, packageIndex: scope ? scope.index : null, outcome, override, excludedBy: null, bundledBy: null, uncertainNote: null });
    }
  };
  for (const rule of firstPass) collect(rule);
  resolveConflicts(candidates, computedAmountOf);

  if (secondPass.length) {
    const applied = { shipment: new Set<string>(), packages: packages.map(() => new Set<string>()), unknownShipment: new Set<string>(), unknownPackages: packages.map(() => new Set<string>()) };
    for (const c of candidates) {
      if (suppressed(c) || isWaived(c)) continue;
      const target = c.outcome === "applies" ? (c.packageIndex === null ? applied.shipment : applied.packages[c.packageIndex]!) : c.packageIndex === null ? applied.unknownShipment : applied.unknownPackages[c.packageIndex]!;
      target.add(c.rule.key);
    }
    evalCtx.applied = applied;
    for (const rule of secondPass) {
      if (rule.conditions.flatMap(referencedRuleKeys).some((k) => secondPassKeys.has(k))) {
        warn({ code: "rule_reference_cycle", ruleKey: rule.key, message: `${rule.name} depends on another dependent rule; such chains are not evaluated.` });
        continue;
      }
      collect(rule);
    }
    resolveConflicts(candidates, computedAmountOf);
  }

  // 5. Billable-weight floors from the rules that actually survived, then base lines.
  const floorsByPackage = new Map<number, RuleFloor>();
  for (const c of candidates) {
    if (!live(c) || c.packageIndex === null || c.rule.billableWeightFloorLb === null) continue;
    const floor: RuleFloor = { lb: dec(c.rule.billableWeightFloorLb), ruleKey: c.rule.key, ruleName: c.rule.name };
    const current = floorsByPackage.get(c.packageIndex);
    if (!current || floor.lb.greaterThan(current.lb)) floorsByPackage.set(c.packageIndex, floor);
  }
  if (floorsByPackage.size) {
    packages = packages.map((p) => (floorsByPackage.has(p.index) ? { ...p, m: measurePackage(p.input, p.index, service.dim, floorsByPackage.get(p.index)!) } : p));
    evalCtx.packages = packages;
  }

  const lines: ChargeLine[] = [];
  for (const p of packages) {
    const found = lookupRate(card.rows, service.serviceId, input.originZip, zone.zone, p.m.billableLb);
    if (!found.ok) {
      return unavailable(input, ctx, found.reason, `${found.message} (package ${p.index + 1}: billable ${p.m.result.billableLb} lb)`, { service: serviceInfo, zone, packages: packages.map((q) => q.m.result), warnings, references });
    }
    const baseClass: ChargeClass = dimUnknown(p) ? "estimated" : "definite";
    const price = dec(found.row.price);
    lines.push({
      kind: "base",
      category: "base",
      label: `${service.serviceName} base rate`,
      amount: toMoney(price, currency),
      chargeClass: baseClass,
      counted: true,
      status: "charged",
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
        status: "charged",
        packageIndex: p.index,
        explanation: `The rate card minimum charge of ${fmt(minimum, 2)} exceeds the bracket rate of ${fmt(price, 2)}.`,
        basis: `minimum:${fmt(minimum, 2)}`,
        rule: null,
      });
    }
  }

  // 6. Amounts. Phase 1: flat and per-unit. Phase 2: percentage rules other than fuel, over phase-1
  //    lines. Phase 3: fuel over every counted non-fuel line. Percent rules are computed per package
  //    (plus one shipment-level line over shipment-level charges) so rounding matches carrier billing.
  const surviving = candidates.filter((c) => !suppressed(c));
  const phase = (c: Candidate) => (c.rule.method !== "percent" ? 1 : c.rule.category === "fuel" ? 3 : 2);
  surviving.sort((a, b) => phase(a) - phase(b) || candidateOrder(a, b));
  const shipmentLevelEmitted = new Set<string>();

  let phase1Snapshot: ChargeLine[] | null = null;
  for (const c of surviving) {
    const rule = c.rule;
    if (phase(c) >= 2 && phase1Snapshot === null) phase1Snapshot = [...lines];
    const included = service.includedSurchargeKeys.includes(rule.key);
    const waived = isWaived(c);
    const status: LineStatus = waived ? "waived" : included ? "included" : c.outcome === "unknown" ? "unknown" : rule.chargeClass === "conditional" ? "conditional" : "charged";
    const counted = status === "charged";
    let classification: ChargeClass = c.outcome === "unknown" ? "estimated" : rule.chargeClass;
    if (counted && classification === "definite" && rule.verificationStatus === "unverified") classification = "estimated";
    const markup = markupOf(c);
    const overrideNote = c.override && !waived ? ` Customer-specific rate applied (${c.override.reference}).` : markup && !markup.isZero() ? ` Includes the ${fmt(markup, 2)}% markup agreed in the rate card terms.` : "";

    const emit = (amount: Dec, basis: string, packageIndex: number | null, baseNote: string, forceClass?: ChargeClass) => {
      let explanation = baseNote;
      if (status === "unknown") explanation = `Could not confirm whether ${rule.name} applies: ${unknownReason(rule, evalCtx, packageIndex === null ? null : packages[packageIndex]!)}. Shown as an estimate and not included in the total.`;
      else if (status === "waived") explanation = `${baseNote} Waived for this customer (${c.override!.reference}); not charged.`;
      else if (status === "included") explanation = `${baseNote} Included in the base rate under the rate card terms; not charged separately.`;
      else if (status === "conditional") explanation = `${baseNote} Charged only if the carrier applies it after shipping; shown as potential exposure, not included in the total.`;
      explanation += overrideNote;
      if (counted && rule.verificationStatus === "unverified") explanation += " The rule's source has not been verified, so this is an estimate.";
      if (counted && c.uncertainNote) explanation += ` ${c.uncertainNote}`;
      lines.push({
        kind: rule.category === "fuel" ? "fuel" : "surcharge",
        category: rule.category,
        label: rule.name,
        amount: toMoney(amount, currency),
        chargeClass: forceClass ?? classification,
        counted,
        status,
        packageIndex,
        explanation,
        basis,
        rule: ruleRef(rule),
      });
    };

    const amountValue = amountValueOf(c);
    const percentValue = percentValueOf(c);

    if (rule.method === "flat") {
      const amount = amountValue ?? new D(0);
      emit(amount, `flat ${fmt(amount, 2)}`, c.packageIndex, `${rule.name}: flat ${fmt(amount, 2)}${c.packageIndex === null ? " per shipment" : " per package"}.`);
    } else if (rule.method === "per_unit") {
      const units = perUnitCount(c, packages);
      if (units === null) continue;
      const perUnitAmount = amountValue ?? new D(0);
      let total = perUnitAmount.times(units);
      let note = `${rule.name}: ${units} × ${fmt(perUnitAmount, 2)} per ${fmt(dec(rule.perUnit!.unitSize), 0)} of declared value above ${fmt(dec(rule.perUnit!.freeAllowance), 0)}.`;
      if (rule.perUnit!.minimumCharge !== null) {
        const min = c.override?.mode === "override_amount" ? dec(rule.perUnit!.minimumCharge) : scaleBy(c, dec(rule.perUnit!.minimumCharge));
        if (total.lessThan(min)) {
          total = min;
          note = `${rule.name}: ${units} × ${fmt(perUnitAmount, 2)} is below the minimum charge of ${fmt(min, 2)}, which applies.`;
        }
      }
      emit(total, `${fmt(perUnitAmount, 2)} × ${units} units`, c.packageIndex, note);
    } else {
      const pct = percentValue ?? new D(0);
      const baseLines = phase(c) === 2 ? phase1Snapshot! : lines;
      // A per-package percent rule covers its package; shipment-level charges get one line, emitted once per rule.
      const scopes: (number | null)[] = c.packageIndex === null ? [...packages.map((p) => p.index as number | null), null] : [c.packageIndex, null];
      for (const scope of scopes) {
        if (scope === null) {
          if (shipmentLevelEmitted.has(rule.key)) continue;
          shipmentLevelEmitted.add(rule.key);
        }
        const { base, estimated: baseIsEstimated } = percentBase(rule, baseLines, scope);
        if (base.isZero()) continue;
        const amount = base.times(pct).div(100);
        const forced: ChargeClass | undefined = baseIsEstimated && classification === "definite" ? "estimated" : undefined;
        emit(amount, `${fmt(pct, 4)}% of ${fmt(base, 2)}`, scope, `${rule.name}: ${fmt(pct, 2)}% of ${fmt(base, 2)} (${baseDescription(rule)}).${forced ? " Marked as an estimate because part of its base is estimated." : ""}`, forced);
      }
    }
  }

  // 7. Order lines for display: per package (base, minimum, surcharges by carrier order), then shipment-level, fuel last.
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
    return categoryRank(input.carrierCode, a.category) - categoryRank(input.carrierCode, b.category) || compareKeys(a.label, b.label);
  });

  // 8. Totals, references, warnings
  const sum = (pred: (l: ChargeLine) => boolean): Money => sumMoney(lines.filter(pred).map((l) => l.amount), currency);
  const definite = sum((l) => l.counted && l.chargeClass === "definite");
  const estimated = sum((l) => l.counted && l.chargeClass === "estimated");
  const expected = sumMoney([definite, estimated], currency);
  const conditionalExposure = sum((l) => l.status === "conditional");
  const unresolved = sum((l) => l.status === "unknown");

  const seen = new Set<string>();
  for (const l of lines) {
    if (l.rule && !seen.has(`${l.rule.key}@${l.rule.version}`)) {
      seen.add(`${l.rule.key}@${l.rule.version}`);
      references.rules.push(l.rule);
      if (l.counted && l.rule.verificationStatus === "unverified") warn({ code: "unverified_rule_applied", ruleKey: l.rule.key, message: `"${l.label}" uses a rule that has not been verified (${l.rule.sourceReference}); it is counted as an estimate.` });
    }
  }
  references.zipLists = [...evalCtx.zipLists.values()].map((z) => ({ key: z.key, version: z.version, sourceReference: z.sourceReference }));
  const overrideSeen = new Set<string>();
  for (const c of candidates) {
    if (!c.override || suppressed(c) || overrideSeen.has(c.rule.key)) continue;
    overrideSeen.add(c.rule.key);
    references.overrides.push({ ruleKey: c.rule.key, mode: c.override.mode, reference: c.override.reference });
    if (c.override.mode === "exclude") warn({ code: "rule_overridden", ruleKey: c.rule.key, message: `${c.rule.name} is waived for this customer (${c.override.reference}).` });
  }
  for (const c of candidates) {
    if (c.outcome !== "unknown" || suppressed(c)) continue;
    const missing = c.rule.conditions.flatMap(listKeysOf).filter((k) => !evalCtx.zipLists.has(k));
    for (const k of missing) warn({ code: "zip_list_missing", ruleKey: c.rule.key, message: `${c.rule.name} depends on the ZIP code list "${k}", which is not loaded for this date; it is shown as an estimate.` });
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
    totals: { definite, estimated, expected, conditionalExposure, unresolved },
    references,
    warnings,
  };
}

function listKeysOf(c: SurchargeRule["conditions"][number]): string[] {
  if (c.type === "destination_zip_in_list") return [c.listKey];
  if (c.type === "any_of") return c.conditions.flatMap(listKeysOf);
  return [];
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
