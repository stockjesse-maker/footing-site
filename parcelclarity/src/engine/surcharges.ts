import { lengthPlusGirth, type PackageMeasurements } from "./dim";
import { dec, type Dec } from "./money";
import { normalizeZone } from "./zones";
import type { PackageInput, RuleCondition, ShipmentInput, SurchargeOverride, SurchargeRule, ZipList } from "./types";

export type ConditionOutcome = "applies" | "not" | "unknown";

export interface PackageContext {
  index: number;
  input: PackageInput;
  m: PackageMeasurements;
}

export interface EvaluationContext {
  shipment: ShipmentInput;
  zone: string | null;
  packages: PackageContext[];
  zipLists: Map<string, ZipListIndex>;
}

export interface ZipListIndex {
  key: string;
  version: number;
  entries: Set<string>;
}

export function indexZipLists(lists: ZipList[]): Map<string, ZipListIndex> {
  const map = new Map<string, ZipListIndex>();
  for (const l of lists) {
    const existing = map.get(l.key);
    if (existing && existing.version >= l.version) continue;
    map.set(l.key, { key: l.key, version: l.version, entries: new Set(l.entries.map((e) => e.trim())) });
  }
  return map;
}

export function zipInList(list: ZipListIndex, zip5: string): boolean {
  for (let n = 5; n >= 3; n--) if (list.entries.has(zip5.slice(0, n))) return true;
  return false;
}

/** Is this rule version in force on the ship date and applicable to the service? */
export function ruleIsCandidate(rule: SurchargeRule, carrierCode: string, serviceCode: string, shipDate: string): boolean {
  if (rule.carrierCode !== carrierCode) return false;
  if (rule.serviceCodes && !rule.serviceCodes.includes(serviceCode)) return false;
  if (shipDate < rule.effectiveDate) return false;
  if (rule.expirationDate && shipDate > rule.expirationDate) return false;
  return true;
}

/** Keeps the highest version per key (the database forbids overlapping published versions, this is belt and braces). */
export function latestPerKey(rules: SurchargeRule[]): SurchargeRule[] {
  const byKey = new Map<string, SurchargeRule>();
  for (const r of rules) {
    const cur = byKey.get(r.key);
    if (!cur || r.version > cur.version) byKey.set(r.key, r);
  }
  return [...byKey.values()];
}

export function activeOverride(overrides: SurchargeOverride[], ruleKey: string, shipDate: string): SurchargeOverride | null {
  const matches = overrides.filter((o) => o.ruleKey === ruleKey && shipDate >= o.effectiveDate && (!o.expirationDate || shipDate <= o.expirationDate));
  // Latest effective date wins if several overlap (the UI prevents overlap; be deterministic anyway).
  return matches.sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : 0))[0] ?? null;
}

function and(a: ConditionOutcome, b: ConditionOutcome): ConditionOutcome {
  if (a === "not" || b === "not") return "not";
  if (a === "unknown" || b === "unknown") return "unknown";
  return "applies";
}

function cmpGt(value: Dec | null, threshold: string): ConditionOutcome {
  if (value === null) return "unknown";
  return value.greaterThan(dec(threshold)) ? "applies" : "not";
}

/** Evaluates one condition for one package (or for the shipment when pkg is null). */
export function evaluateCondition(c: RuleCondition, ctx: EvaluationContext, pkg: PackageContext | null): ConditionOutcome {
  const s = ctx.shipment;
  // Conditions about a package: for shipment-level rules, "any package" satisfies a greater-than
  // test and "all packages" must satisfy a less-than-or-equal test.
  const perPackage = (f: (p: PackageContext) => ConditionOutcome, mode: "any" | "all" = "any"): ConditionOutcome => {
    if (pkg) return f(pkg);
    const outcomes = ctx.packages.map(f);
    if (mode === "any") {
      if (outcomes.includes("applies")) return "applies";
      return outcomes.includes("unknown") ? "unknown" : "not";
    }
    if (outcomes.includes("not")) return "not";
    return outcomes.includes("unknown") ? "unknown" : "applies";
  };

  switch (c.type) {
    case "residential":
      return s.residential === c.value ? "applies" : "not";
    case "weight_gt":
      return perPackage((p) => cmpGt(c.basis === "actual" ? p.m.actualLb : p.m.billableLb, c.valueLb));
    case "weight_lte":
      return perPackage((p) => ((c.basis === "actual" ? p.m.actualLb : p.m.billableLb).lessThanOrEqualTo(dec(c.valueLb)) ? "applies" : "not"), "all");
    case "longest_side_gt":
      return perPackage((p) => cmpGt(p.m.dimsIn ? p.m.dimsIn[0] : null, c.inches));
    case "second_longest_side_gt":
      return perPackage((p) => cmpGt(p.m.dimsIn ? p.m.dimsIn[1] : null, c.inches));
    case "length_plus_girth_gt":
      return perPackage((p) => cmpGt(p.m.dimsIn ? lengthPlusGirth(p.m.dimsIn) : null, c.inches));
    case "cubic_in_gt":
      return perPackage((p) => cmpGt(p.m.cubicIn, c.value));
    case "zone_in":
      if (ctx.zone === null) return "unknown";
      return c.zones.map(normalizeZone).includes(normalizeZone(ctx.zone)) ? "applies" : "not";
    case "destination_zip_in_list": {
      if (!s.destinationZip) return "unknown";
      const list = ctx.zipLists.get(c.listKey);
      if (!list) return "unknown";
      return zipInList(list, s.destinationZip) ? "applies" : "not";
    }
    case "destination_zip_prefix_in":
      if (!s.destinationZip) return "unknown";
      return c.prefixes.some((p) => s.destinationZip!.startsWith(p)) ? "applies" : "not";
    case "declared_value_gt":
      return perPackage((p) => (p.input.declaredValue === undefined ? "not" : cmpGt(dec(p.input.declaredValue), c.amount)));
    case "signature_in":
      return c.values.includes(s.options?.signature ?? "none") ? "applies" : "not";
    case "saturday_delivery":
      return (s.options?.saturdayDelivery ?? false) === c.value ? "applies" : "not";
    case "package_type_in":
      return perPackage((p) => (c.types.includes(p.input.packageType ?? "parcel") ? "applies" : "not"));
    case "flag_present":
      return perPackage((p) => (p.input.flags?.includes(c.flag) ? "applies" : "not"));
    case "ship_date_between":
      return s.shipDate >= c.from && s.shipDate <= c.to ? "applies" : "not";
    case "package_count_gt":
      return s.packages.length > c.value ? "applies" : "not";
  }
}

export function evaluateRule(rule: SurchargeRule, ctx: EvaluationContext, pkg: PackageContext | null): ConditionOutcome {
  let outcome: ConditionOutcome = "applies";
  for (const c of rule.conditions) {
    outcome = and(outcome, evaluateCondition(c, ctx, pkg));
    if (outcome === "not") break;
  }
  return outcome;
}

/** Why a rule's outcome is unknown, for the explanation text. */
export function unknownReason(rule: SurchargeRule, ctx: EvaluationContext, pkg: PackageContext | null): string {
  for (const c of rule.conditions) {
    if (evaluateCondition(c, ctx, pkg) !== "unknown") continue;
    switch (c.type) {
      case "destination_zip_in_list":
        return ctx.zipLists.has(c.listKey) ? "no destination ZIP was given" : `the ZIP list "${c.listKey}" is not loaded`;
      case "destination_zip_prefix_in":
        return "no destination ZIP was given";
      case "zone_in":
        return "the zone could not be resolved";
      default:
        return "package dimensions were not given";
    }
  }
  return "an input needed to decide was missing";
}
