import { describe, expect, it } from "vitest";
import { calculateShipment } from "@/engine";
import type { ChargeLine, PackageInput, PricingContext, RateRow, ServiceTerms, ShipmentCalculation, ShipmentInput, SurchargeOverride, SurchargeRule } from "@/engine/types";

/**
 * Adversarial semantics review of calculate.ts / surcharges.ts against docs-m2-design.md §1.4–§1.11
 * (exclusivity and bundling order, overrides, rule_applied companions, billable-weight floors,
 * warnings). Every expected value is derived by hand in a comment next to the assertion; nothing was
 * copied from engine output. Tests marked "ENGINE DEFECT" are expected to FAIL until the engine is
 * fixed; the comment states the contract clause and the wrong vs right output. All data is FICTIONAL.
 *
 * Harness (same conventions as engine-surcharges.test.ts):
 *  - Zone 2, any origin: bracket (n−1, n] lb costs 10n.00, so base = 10 × billable lb.
 *  - The test service is DIM-exempt: billable = actual weight rounded up to the whole pound, but
 *    dimensions are still measured for dimension conditions.
 *  - rule() is a flat 1.00 per-package rule with no conditions unless overridden.
 */

const SERVICE_ID = "svc-review";

/** Zone 2, any origin: bracket (n−1, n] lb costs 10n.00 for n = 1..100. */
const ROWS: RateRow[] = Array.from({ length: 100 }, (_, i) => {
  const n = i + 1;
  return { serviceId: SERVICE_ID, originPrefix: null, zone: "2", weightMin: String(n - 1), weightMax: String(n), weightUnit: "lb", price: `${n * 10}.00`, minCharge: null };
});

function terms(overrides: Partial<ServiceTerms> = {}): ServiceTerms {
  return {
    serviceId: SERVICE_ID,
    carrierCode: "ups",
    serviceCode: "ground",
    serviceName: "Review Ground",
    dim: { divisor: "139", thresholdCubicIn: null, dimensionRounding: "nearest_whole", weightRounding: "up_whole_lb", minBillableLb: null, exempt: true },
    minCharge: null,
    includedSurchargeKeys: [],
    excludedSurchargeKeys: [],
    zoneChartKey: "default",
    zoneIndependent: false,
    surchargeMarkupPercent: null,
    sourceReference: "review terms",
    termsVersion: "review-terms-v1",
    ...overrides,
  };
}

function context(opts: { rules?: SurchargeRule[]; overrides?: SurchargeOverride[]; service?: Partial<ServiceTerms> } = {}): PricingContext {
  return {
    rateCard: {
      rateCardId: "review-card",
      rateCardName: "Semantics review card (fictional)",
      versionId: "review-card-v1",
      versionNumber: 1,
      currency: "USD",
      effectiveDate: "2026-01-01",
      expirationDate: null,
      services: [terms(opts.service)],
      rows: ROWS,
      zones: [],
    },
    rules: opts.rules ?? [],
    zipLists: [],
    overrides: opts.overrides ?? [],
  };
}

/** A flat 1.00 per-package rule with no conditions unless overridden. */
function rule(key: string, overrides: Partial<SurchargeRule> = {}): SurchargeRule {
  return {
    key,
    brandId: null,
    billableWeightFloorLb: null,
    ruleId: `id-${key}`,
    versionId: `id-${key}-v1`,
    version: 1,
    scope: "tenant",
    carrierCode: "ups",
    serviceCodes: null,
    category: "other",
    name: `Rule ${key}`,
    chargeClass: "definite",
    method: "flat",
    amount: "1.00",
    percent: null,
    perUnit: null,
    base: { kind: "base_rate" },
    conditions: [],
    exclusivityGroup: null,
    exclusivityPriority: 0,
    excludesRuleKeys: [],
    perPackage: true,
    effectiveDate: "2026-01-01",
    expirationDate: null,
    sourceReference: "TEST: fictional amount",
    sourceUrl: null,
    verificationStatus: "approved_3pl_config",
    ...overrides,
  };
}

function override(ruleKey: string, mode: SurchargeOverride["mode"], extra: Partial<SurchargeOverride> = {}): SurchargeOverride {
  return { ruleKey, mode, amount: null, percent: null, effectiveDate: "2026-01-01", expirationDate: null, reference: `AGREEMENT-${ruleKey}`, ...extra };
}

const ONE_LB: PackageInput = { weight: "1", weightUnit: "lb" };

function shipment(packages: PackageInput[], extra: Partial<ShipmentInput> = {}): ShipmentInput {
  return { shipDate: "2026-10-15", originZip: "90001", destinationZone: "2", residential: false, carrierCode: "ups", serviceCode: "ground", packages, ...extra };
}

function calc(input: ShipmentInput, ctx: PricingContext): ShipmentCalculation {
  const r = calculateShipment(input, ctx);
  expect(r.status, r.unavailableMessage ?? "").toBe("ok");
  return r;
}

function linesFor(r: ShipmentCalculation, key: string): ChargeLine[] {
  return r.lines.filter((l) => l.rule?.key === key);
}

function lineFor(r: ShipmentCalculation, key: string, packageIndex: number | null = 0): ChargeLine {
  const l = linesFor(r, key).find((x) => x.packageIndex === packageIndex);
  expect(l, `expected a line for ${key} on ${packageIndex === null ? "the shipment" : `package ${packageIndex}`}`).toBeDefined();
  return l!;
}

function totals(r: ShipmentCalculation) {
  return { definite: r.totals.definite.amount, estimated: r.totals.estimated.amount, expected: r.totals.expected.amount, conditionalExposure: r.totals.conditionalExposure.amount, unresolved: r.totals.unresolved.amount };
}

function countedKeys(r: ShipmentCalculation): string[] {
  return [...new Set(r.lines.filter((l) => l.rule && l.counted).map((l) => l.rule!.key))].sort();
}

// ---------------------------------------------------------------------------
// §1.7 Exclusivity THEN bundling
// ---------------------------------------------------------------------------

describe("exclusivity before bundling (§1.7)", () => {
  // ENGINE DEFECT: §1.7 says "keep the one with highest exclusivityPriority ... Then for each KEPT rule,
  // suppress rules listed in its excludesRuleKeys". calculate.ts resolveConflicts() runs bundling first
  // and exclusivity second, so a rule that then LOSES its exclusivity group has already bundled other
  // rules away. Real-world analogue: Additional Handling bundles a handling fee; Large Package beats
  // Additional Handling; the handling fee must then be charged, but the engine silently drops it.
  it("an exclusivity loser must not bundle other rules away", () => {
    const rules = [
      rule("lo", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "20.00", excludesRuleKeys: ["c"] }),
      rule("hi", { exclusivityGroup: "grp", exclusivityPriority: 2, amount: "6.00" }),
      rule("c", { amount: "3.00" }),
    ];
    const r = calc(shipment([ONE_LB]), context({ rules }));
    // Exclusivity: hi (priority 2) beats lo (priority 1); lo is dropped. Kept rules: hi and c; hi bundles
    // nothing, so c is charged. Lines: base 10.00 + hi 6.00 + c 3.00 = 19.00.
    // Engine: lo bundles c first, then loses to hi → c absent → 16.00.
    expect(lineFor(r, "hi").amount.amount).toBe("6.00");
    expect(linesFor(r, "lo")).toHaveLength(0);
    expect(lineFor(r, "c").counted).toBe(true);
    expect(totals(r).expected).toBe("19.00");
  });

  // ENGINE DEFECT: bundling is "walk by priority then key; a rule not yet suppressed suppresses what it
  // lists". With a chain (top bundles mid, mid bundles low) the outcome therefore depends on the KEY
  // SPELLING of equal-priority rules: whichever key sorts first walks first. §1.7 says every kept rule
  // suppresses the rules it lists, which is transitive and independent of names (top bundles mid, mid
  // still bundles low: only top is charged). Real-world: Over Maximum Limits bundles Large Package,
  // Large Package bundles Additional Handling; renaming keys must not change whether AH is billed.
  it("a bundling chain gives the same result regardless of key spelling", () => {
    // Variant A: keys sort top < mid < low. Walk: top suppresses mid; mid is now suppressed and (engine)
    // bundles nothing; low survives → engine 10.00 + 1.00 + 1.00 = 12.00.
    const a = calc(shipment([ONE_LB]), context({ rules: [rule("a_top", { excludesRuleKeys: ["b_mid"] }), rule("b_mid", { excludesRuleKeys: ["c_low"] }), rule("c_low")] }));
    // Variant B: keys sort low < mid < top. Walk: low (nothing), mid suppresses low, top suppresses mid →
    // only top → 10.00 + 1.00 = 11.00.
    const b = calc(shipment([ONE_LB]), context({ rules: [rule("c_top", { excludesRuleKeys: ["b_mid"] }), rule("b_mid", { excludesRuleKeys: ["a_low"] }), rule("a_low")] }));
    // Right (§1.7, every kept rule suppresses what it lists): only the top rule in both variants: 11.00.
    expect(countedKeys(b)).toEqual(["c_top"]);
    expect(totals(b).expected).toBe("11.00");
    expect(countedKeys(a)).toEqual(["a_top"]);
    expect(totals(a).expected).toBe("11.00");
  });
});

// ---------------------------------------------------------------------------
// Billable-weight floors imposed by rules that end up not applying
// ---------------------------------------------------------------------------

describe("rule-imposed billable-weight floors", () => {
  // ENGINE DEFECT: calculate.ts step 2 decides floor rules in a pre-pass that resolves exclusivity and
  // bundling ONLY among floor rules. A non-floor rule that later beats the floor rule (higher priority
  // in the same group, or bundling it via excludesRuleKeys) drops the floor rule from the itemization,
  // but the floor it imposed stays on the package: the base rate is priced at the floor weight and the
  // package explanation cites a rule that is not charged. The base line is then labelled "definite"
  // with the wrong amount.
  it("a floor rule dropped by exclusivity or bundling must not raise the billable weight", () => {
    const BIG: PackageInput = { weight: "10", weightUnit: "lb", length: "50", width: "10", height: "10" }; // longest side 50 > 48
    const lp = rule("lp", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "100.00", billableWeightFloorLb: "90", conditions: [{ type: "longest_side_gt", inches: "48" }] });
    const cases: [string, SurchargeRule][] = [
      // Same group, higher priority: big wins, lp is dropped.
      ["exclusivity", rule("big", { exclusivityGroup: "grp", exclusivityPriority: 2, amount: "50.00", conditions: [{ type: "longest_side_gt", inches: "48" }] })],
      // No group; big bundles lp away.
      ["bundling", rule("big", { amount: "50.00", excludesRuleKeys: ["lp"], conditions: [{ type: "longest_side_gt", inches: "48" }] })],
    ];
    for (const [label, big] of cases) {
      const r = calc(shipment([BIG]), context({ rules: [lp, big] }));
      expect(linesFor(r, "lp"), label).toHaveLength(0);
      expect(lineFor(r, "big").amount.amount, label).toBe("50.00");
      // lp did not apply, so no floor: 10 lb actual on a DIM-exempt service → 10.0 lb billable (basis exempt),
      // bracket (9, 10] → base 100.00. Total 100.00 + 50.00 = 150.00.
      // Engine: the 90 lb floor of the dropped lp is kept → bracket (89, 90] → base 900.00 → 950.00.
      expect(r.packages[0]!.billableLb, label).toBe("10.0");
      expect(r.packages[0]!.basis, label).toBe("exempt");
      expect(r.packages[0]!.explanation, label).not.toContain("lp");
      expect(r.lines.find((l) => l.kind === "base")!.amount.amount, label).toBe("100.00");
      expect(totals(r).expected, label).toBe("150.00");
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown outcomes inside exclusivity groups
// ---------------------------------------------------------------------------

describe("unknown members of an exclusivity group", () => {
  // ENGINE DEFECT: §1.7 resolves exclusivity "among APPLYING rules sharing an exclusivityGroup" and
  // says an unknown rule is "emitted with chargeClass: estimated, counted: false". resolveConflicts()
  // drops every non-winning member "applying or unknown", so a higher-priority rule that could not be
  // decided vanishes without a trace: no estimated line, no unresolved amount, and the lower-priority
  // winner is shown as a definite charge although the carrier may bill the other one instead.
  // Real-world: 55 lb actual, dimensions unknown → Additional Handling (weight) shown definite, while
  // Large Package (priority 2, 100.00) might apply and replace it.
  it("an unknown higher-priority member is still listed as an uncounted estimate", () => {
    const rules = [
      rule("lp", { exclusivityGroup: "grp", exclusivityPriority: 2, amount: "100.00", conditions: [{ type: "longest_side_gt", inches: "48" }] }), // no dims → unknown
      rule("ahw", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "28.00", conditions: [{ type: "weight_gt", valueLb: "50", basis: "actual" }] }), // 55 > 50 → applies
    ];
    const r = calc(shipment([{ weight: "55", weightUnit: "lb" }]), context({ rules }));
    // ahw is the only applying member → charged: 28.00. Base: 55 lb → bracket (54, 55] → 550.00.
    expect(lineFor(r, "ahw").counted).toBe(true);
    expect(lineFor(r, "ahw").amount.amount).toBe("28.00");
    // lp is unknown (dimensions not given): listed, estimated, uncounted, amount as if it applied.
    const lp = lineFor(r, "lp");
    expect(lp.chargeClass).toBe("estimated");
    expect(lp.counted).toBe(false);
    expect(lp.amount.amount).toBe("100.00");
    // definite = 550.00 + 28.00 = 578.00; unresolved = 100.00 (lp). Engine: unresolved 0.00, no lp line.
    expect(totals(r)).toEqual({ definite: "578.00", estimated: "0.00", expected: "578.00", conditionalExposure: "0.00", unresolved: "100.00" });
  });
});

// ---------------------------------------------------------------------------
// rule_applied companions
// ---------------------------------------------------------------------------

describe("rule_applied companion rules", () => {
  // ENGINE DEFECT: types.ts: rule_applied "holds when the named rule ended up applying". When the parent
  // rule is UNKNOWN (dimensions missing) the applied set does not contain it, so evaluateCondition()
  // returns "not" and the companion is silently absent, although unknownReason() even carries the text
  // "it depends on X, which could not be decided" for exactly this case (dead code today). The parent
  // is shown as an unresolved estimate; its companion must be too, otherwise the unresolved total is
  // understated. Real-world: peak surcharge on Large Package when dimensions were not given.
  it("a companion of an unknown parent is unknown, not absent", () => {
    const rules = [
      rule("lp", { amount: "100.00", conditions: [{ type: "longest_side_gt", inches: "48" }] }), // no dims → unknown
      rule("peak_lp", { category: "peak", amount: "7.00", conditions: [{ type: "rule_applied", ruleKey: "lp" }] }),
    ];
    const r = calc(shipment([ONE_LB]), context({ rules }));
    expect(lineFor(r, "lp").counted).toBe(false);
    const companion = lineFor(r, "peak_lp");
    expect(companion.chargeClass).toBe("estimated");
    expect(companion.counted).toBe(false);
    expect(companion.amount.amount).toBe("7.00");
    expect(companion.explanation).toContain("it depends on Rule lp, which could not be decided");
    // definite = base 10.00; unresolved = 100.00 + 7.00 = 107.00. Engine: unresolved 100.00, no peak_lp line.
    expect(totals(r)).toEqual({ definite: "10.00", estimated: "0.00", expected: "10.00", conditionalExposure: "0.00", unresolved: "107.00" });
  });

  // ENGINE DEFECT: evaluateCondition() for rule_applied on a PER-PACKAGE rule only looks in that
  // package's applied set; a per-shipment parent is recorded in applied.shipment, so a per-package
  // companion of a per-shipment parent is always "not". The reverse direction (per-shipment companion
  // of a per-package parent) is handled explicitly, so this is an asymmetry, not a design choice.
  // Real-world: a per-package peak fee that applies when Saturday delivery (per shipment) was taken.
  it("a per-package companion of a per-shipment parent applies on every package", () => {
    const rules = [
      rule("sig", { category: "signature", amount: "6.50", perPackage: false, conditions: [{ type: "signature_in", values: ["adult"] }] }),
      rule("sig_pkg_fee", { amount: "2.00", conditions: [{ type: "rule_applied", ruleKey: "sig" }] }),
    ];
    const r = calc(shipment([ONE_LB, ONE_LB], { options: { signature: "adult" } }), context({ rules }));
    expect(lineFor(r, "sig", null).counted).toBe(true);
    expect(linesFor(r, "sig_pkg_fee").map((l) => [l.packageIndex, l.counted])).toEqual([
      [0, true],
      [1, true],
    ]);
    // 10.00 + 10.00 + 6.50 + 2 × 2.00 = 30.50. Engine: 26.50 (no companion lines).
    expect(totals(r).expected).toBe("30.50");
  });

  // ENGINE DEFECT: the rule_reference_cycle check in calculate.ts step 5 only inspects top-level
  // `rule_applied` conditions. A dependent rule referenced through an `any_of` group is neither warned
  // about nor evaluated correctly: the applied sets were frozen before the second pass, so the
  // condition is silently "not". The engine's own contract (PRICING_ENGINE.md step 7) says such a rule
  // "is skipped with warning rule_reference_cycle".
  it("a rule_applied nested in any_of that references a dependent rule raises rule_reference_cycle", () => {
    const rules = [
      rule("p"), // applies
      rule("q", { conditions: [{ type: "rule_applied", ruleKey: "p" }] }), // dependent, applies
      rule("r", { conditions: [{ type: "any_of", conditions: [{ type: "rule_applied", ruleKey: "q" }] }] }), // depends on a dependent rule
    ];
    const r = calc(shipment([ONE_LB]), context({ rules }));
    // p and q are charged: 10.00 + 1.00 + 1.00 = 12.00 (r is skipped either way).
    expect(countedKeys(r)).toEqual(["p", "q"]);
    expect(totals(r).expected).toBe("12.00");
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: "rule_reference_cycle", ruleKey: "r" }));
  });
});

// ---------------------------------------------------------------------------
// Overrides and exclusivity tie-breaks
// ---------------------------------------------------------------------------

describe("overrides inside exclusivity groups", () => {
  // ENGINE DEFECT: §1.7 breaks exclusivity ties by "highest COMPUTED amount". provisionalAmount() uses
  // the published amount (or an override_amount) but ignores a markup_percent override, so a rule
  // whose customer-specific figure is the higher one can lose the tie.
  it("ties are broken on the amount after a markup_percent override", () => {
    const rules = [
      rule("a", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "20.00" }),
      rule("b", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "19.00" }),
    ];
    // b computed = 19.00 × (100 + 10) ÷ 100 = 20.90 > a 20.00 → b wins. Engine compares 19.00 < 20.00 → a wins.
    const r = calc(shipment([ONE_LB]), context({ rules, overrides: [override("b", "markup_percent", { percent: "10" })] }));
    expect(lineFor(r, "b").amount.amount).toBe("20.90");
    expect(linesFor(r, "a")).toHaveLength(0);
    // 10.00 + 20.90 = 30.90
    expect(totals(r).expected).toBe("30.90");
  });

  // ENGINE DEFECT: §1.11 adds rule_overridden only when the waiver changes what is charged (the existing
  // surcharge tests already require no warning when the waived rule does not apply). A waived rule
  // that loses its exclusivity group is absent from the itemization (it could never have been charged),
  // yet calculate.ts step 8 warns "<rule> is waived for this customer" for every candidate carrying an
  // exclude override, suppressed or not, and lists the override in references.overrides.
  it("no rule_overridden warning for a waived rule that lost its exclusivity group", () => {
    const rules = [
      rule("hi", { exclusivityGroup: "grp", exclusivityPriority: 2, amount: "6.00" }),
      rule("lo", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "20.00" }),
    ];
    const r = calc(shipment([ONE_LB]), context({ rules, overrides: [override("lo", "exclude")] }));
    expect(lineFor(r, "hi").counted).toBe(true);
    expect(linesFor(r, "lo")).toHaveLength(0);
    // 10.00 + 6.00 = 16.00
    expect(totals(r).expected).toBe("16.00");
    expect(r.warnings).toEqual([]);
    expect(r.references.overrides).toEqual([]);
  });
});
