import { describe, expect, it } from "vitest";
import { calculateShipment, dec, validateShipment } from "@/engine";
import type { ChargeLine, PackageInput, PricingContext, RateRow, ServiceTerms, ShipmentCalculation, ShipmentInput, SurchargeOverride, SurchargeRule } from "@/engine/types";
import { fixtureContext } from "../fixtures/pricing/load";

/**
 * Adversarial review of the pricing engine, lens: numerical correctness (docs-m2-design.md §1).
 * Hunts for rounding at the wrong point, float leakage, formatting that changes a value, ordering
 * mistakes in exclusivity/bundling, sum-of-lines vs totals, and determinism hazards.
 *
 * Every expected value is derived by hand in a comment next to the assertion; nothing was copied
 * from engine output. Tests that expose a defect are kept failing and marked "ENGINE DEFECT".
 * All data is FICTIONAL.
 *
 * Conventions (same as engine-surcharges.test.ts): the test rate table prices zone 2 at 10.00 per
 * billable pound, bracket (n−1, n] lb = 10n.00, so a 1 lb package has a 10.00 base and a 30 lb
 * package a 300.00 base. The test service is DIM-exempt unless a test says otherwise.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE_ID = "svc-num";

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
    serviceName: "Numerics Ground",
    dim: { divisor: "139", thresholdCubicIn: null, dimensionRounding: "nearest_whole", weightRounding: "up_whole_lb", minBillableLb: null, exempt: true },
    minCharge: null,
    includedSurchargeKeys: [],
    excludedSurchargeKeys: [],
    zoneChartKey: "default",
    zoneIndependent: false,
    surchargeMarkupPercent: null,
    sourceReference: "test terms",
    termsVersion: "num-terms-v1",
    ...overrides,
  };
}

function context(opts: { rules?: SurchargeRule[]; overrides?: SurchargeOverride[]; service?: Partial<ServiceTerms> } = {}): PricingContext {
  return {
    rateCard: {
      rateCardId: "num-card",
      rateCardName: "Numerics test card (fictional)",
      versionId: "num-card-v1",
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

function fuel(percent: string, base: SurchargeRule["base"], overrides: Partial<SurchargeRule> = {}): SurchargeRule {
  return rule("fuel", { category: "fuel", name: "Fuel surcharge", method: "percent", amount: null, percent, base, ...overrides });
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

function lineKeys(r: ShipmentCalculation): string[] {
  return r.lines.filter((l) => l.rule).map((l) => l.rule!.key).sort();
}

function amounts(r: ShipmentCalculation): [string, number | null, string][] {
  return r.lines.map((l): [string, number | null, string] => [l.rule?.key ?? l.kind, l.packageIndex, l.amount.amount]);
}

/** Sum of the counted line amounts, in exact decimal, as a 2 dp string. */
function sumCounted(lines: ChargeLine[]): string {
  return lines.filter((l) => l.counted).reduce((s, l) => s.plus(l.amount.amount), dec("0")).toFixed(2);
}

// ---------------------------------------------------------------------------
// Exclusivity tie-break: "ties → highest computed amount" (§1.7)
// ---------------------------------------------------------------------------

describe("exclusivity tie-break by computed amount (§1.7)", () => {
  // ENGINE DEFECT: calculate.ts breaks priority ties with `provisionalAmount`, which is the rule's raw
  // `amount` (percent rules compare as 0, per_unit rules use the per-unit price, the service markup and
  // markup overrides are ignored). §1.7 says ties go to the "highest computed amount". A 50% percent
  // rule whose computed amount is 5.00 therefore loses to a 1.00 flat rule.
  it("a percent rule whose computed amount is larger wins the tie against a smaller flat rule", () => {
    const flat = rule("flat", { exclusivityGroup: "g", amount: "1.00" });
    // 50% of the 10.00 base = 5.00 computed, larger than 1.00 → pct must win.
    const pct = rule("pct", { exclusivityGroup: "g", method: "percent", amount: null, percent: "50", base: { kind: "base_rate" } });
    const r = calc(shipment([ONE_LB]), context({ rules: [flat, pct] }));
    expect(lineKeys(r)).toEqual(["pct"]);
    // 10.00 base + 5.00 = 15.00
    expect(r.totals.expected.amount).toBe("15.00");
  });

  // ENGINE DEFECT: same root cause. With a 25% customer markup on every non-overridden surcharge, rule A's
  // computed amount is 10.00 × 1.25 = 12.50, which beats B's absolute override of 11.00; the engine compares
  // the unscaled 10.00 against 11.00 and lets B win.
  it("the tie-break counts the service markup (published + X%) in the computed amount", () => {
    const a = rule("a", { exclusivityGroup: "g", amount: "10.00" });
    const b = rule("b", { exclusivityGroup: "g", amount: "5.00" });
    const ov: SurchargeOverride = { ruleKey: "b", mode: "override_amount", amount: "11.00", percent: null, effectiveDate: "2026-01-01", expirationDate: null, reference: "AGREEMENT-b" };
    const r = calc(shipment([ONE_LB]), context({ rules: [a, b], overrides: [ov], service: { surchargeMarkupPercent: "25" } }));
    // A computed: 10.00 × (100 + 25) ÷ 100 = 12.50; B computed: override 11.00 (no markup on an absolute override).
    expect(lineKeys(r)).toEqual(["a"]);
    expect(r.lines.find((l) => l.rule?.key === "a")!.amount.amount).toBe("12.50");
    // 10.00 + 12.50 = 22.50
    expect(r.totals.expected.amount).toBe("22.50");
  });
});

// ---------------------------------------------------------------------------
// Order of exclusivity and bundling (§1.7)
// ---------------------------------------------------------------------------

describe("exclusivity before bundling (§1.7)", () => {
  // ENGINE DEFECT: §1.7 resolves exclusivity first and only "for each kept rule" suppresses the keys it
  // lists. calculate.ts resolveConflicts() walks excludesRuleKeys first and exclusivity second, so a rule
  // that then loses its exclusivity group has already bundled (removed) another surcharge. Here A (priority
  // 1, bundles C) loses to B (priority 2); C must still be charged.
  it("a rule that loses its exclusivity group does not bundle away the rules it lists", () => {
    const a = rule("a", { exclusivityGroup: "g", exclusivityPriority: 1, amount: "2.00", excludesRuleKeys: ["c"] });
    const b = rule("b", { exclusivityGroup: "g", exclusivityPriority: 2, amount: "3.00" });
    const c = rule("c", { amount: "4.00" });
    const r = calc(shipment([ONE_LB]), context({ rules: [a, b, c] }));
    expect(lineKeys(r)).toEqual(["b", "c"]);
    // 10.00 base + 3.00 (b) + 4.00 (c) = 17.00
    expect(r.totals.expected.amount).toBe("17.00");
  });
});

// ---------------------------------------------------------------------------
// Billable-weight floors imposed by rules
// ---------------------------------------------------------------------------

describe("billableWeightFloorLb only for rules that end up applying", () => {
  // ENGINE DEFECT: the floor pre-pass (calculate.ts step 2) resolves exclusivity among floor rules only.
  // F (priority 1, 30 lb floor, package-only condition) wins that pre-pass and raises the package to
  // 30 lb; in the main pass Z (priority 2, zone condition, same group) beats F, so F is absent from the
  // itemization (§1.11) yet the package is still billed at 30 lb "that applies with F". The floor is
  // defined as taking effect "when the rule applies"; F does not apply, so the base must be the 1 lb rate.
  it("a floor rule that loses its exclusivity group in the main pass leaves the billable weight alone", () => {
    const f = rule("f", { exclusivityGroup: "g", exclusivityPriority: 1, amount: "2.00", billableWeightFloorLb: "30", conditions: [{ type: "longest_side_gt", inches: "20" }] });
    const z = rule("z", { exclusivityGroup: "g", exclusivityPriority: 2, amount: "3.00", conditions: [{ type: "zone_in", zones: ["2"] }] });
    // 30 × 10 × 10 in, 1 lb, DIM-exempt service: billable 1 lb unless a floor applies.
    const r = calc(shipment([{ weight: "1", weightUnit: "lb", length: "30", width: "10", height: "10" }]), context({ rules: [f, z] }));
    expect(lineKeys(r)).toEqual(["z"]);
    expect(r.packages[0]!.billableLb).toBe("1.0");
    expect(r.packages[0]!.basis).toBe("exempt");
    // 10.00 base (1 lb) + 3.00 (z) = 13.00, not 300.00 + 3.00
    expect(r.totals.expected.amount).toBe("13.00");
  });
});

// ---------------------------------------------------------------------------
// Fuel base and the rule's perPackage flag (§1.8)
// ---------------------------------------------------------------------------

describe("fuel base covers every counted non-fuel line (§1.8)", () => {
  // ENGINE DEFECT: §1.8 defines the base of `base_plus_all_surcharges` as "every counted non-fuel surcharge
  // line" and §1.6 lists fuel among the shipment-level lines. When the fuel rule is configured perPackage
  // (as the fixture's own fuel rule is), calculate.ts only scopes the percent over package lines, so a
  // counted shipment-level surcharge (signature) silently carries no fuel. Under-charges every quote
  // with a shipment-level surcharge and a per-package fuel rule.
  it("a per-package fuel rule still applies to a counted shipment-level signature line", () => {
    const signature = rule("sig", { category: "signature", amount: "6.50", perPackage: false, conditions: [{ type: "signature_in", values: ["direct", "adult"] }] });
    const r = calc(shipment([ONE_LB], { options: { signature: "adult" } }), context({ rules: [signature, fuel("20", { kind: "base_plus_all_surcharges" }, { perPackage: true })] }));
    expect(r.lines.find((l) => l.rule?.key === "sig")!.counted).toBe(true);
    const fuelTotal = r.lines.filter((l) => l.kind === "fuel").reduce((s, l) => s.plus(l.amount.amount), dec("0")).toFixed(2);
    // 20% × 10.00 (base) = 2.00; 20% × 6.50 (signature) = 1.30; fuel in total 3.30
    expect(fuelTotal).toBe("3.30");
    // 10.00 + 6.50 + 2.00 + 1.30 = 19.80
    expect(r.totals.expected.amount).toBe("19.80");
  });
});

// ---------------------------------------------------------------------------
// Formatting that changes a value
// ---------------------------------------------------------------------------

describe("result weights are the weights that were priced", () => {
  // ENGINE DEFECT: dim.ts formats `billableLb` and `actualLb` with fmt(…, 4), which rounds HALF_UP to four
  // decimals. With weightRounding "none" the exact value 1.00004 lb is priced (correctly) on the (1, 2]
  // bracket, but the result reports billableLb "1.0", which lies in the (0, 1] bracket. §1.6 requires
  // weightMin < w ≤ weightMax; the reported w contradicts the bracket the base line names.
  it("billableLb with weightRounding none falls inside the bracket named by the base line", () => {
    const none = { divisor: "139", thresholdCubicIn: null, dimensionRounding: "nearest_whole" as const, weightRounding: "none" as const, minBillableLb: null, exempt: true };
    const r = calc(shipment([{ weight: "1.00004", weightUnit: "lb" }]), context({ service: { dim: none } }));
    const base = r.lines.find((l) => l.kind === "base")!;
    // 1.00004 > 1 → bracket (1, 2] → 20.00
    expect(base.amount.amount).toBe("20.00");
    expect(base.basis).toBe(`rate_card:num-card-v1:${SERVICE_ID}:2:2lb`);
    const reported = dec(r.packages[0]!.billableLb);
    // The reported billable weight must satisfy weightMin < w ≤ weightMax for the (1, 2] bracket.
    expect(reported.greaterThan(1), `reported billableLb ${r.packages[0]!.billableLb} is not > 1`).toBe(true);
    expect(reported.lessThanOrEqualTo(2)).toBe(true);
    // The actual weight is echoed exactly too (it is the input, a decimal string).
    expect(r.packages[0]!.actualLb).toBe("1.00004");
  });

  // ENGINE DEFECT (same cause): a weight just under 1 lb is priced on (0, 1] but reported as "1.0".
  it("a weight just under a bracket maximum is not reported as the maximum", () => {
    const none = { divisor: "139", thresholdCubicIn: null, dimensionRounding: "nearest_whole" as const, weightRounding: "none" as const, minBillableLb: null, exempt: true };
    const r = calc(shipment([{ weight: "0.99996", weightUnit: "lb" }]), context({ service: { dim: none } }));
    // 0.99996 ≤ 1 → bracket (0, 1] → 10.00
    expect(r.lines.find((l) => l.kind === "base")!.amount.amount).toBe("10.00");
    expect(dec(r.packages[0]!.billableLb).lessThan(1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Float leakage in validation
// ---------------------------------------------------------------------------

describe("validation does not go through a JS float", () => {
  // ENGINE DEFECT (minor): validate.ts checks positivity with Number.parseFloat(v) > 0. A positive decimal
  // string whose magnitude is below the smallest IEEE-754 denormal (≈ 4.9e-324) parses as 0 and is
  // rejected as "must be greater than zero", although §1.1 only requires a positive weight and the engine
  // itself handles the value exactly (ceil → 1 lb).
  it("accepts a positive weight whose float representation underflows to 0", () => {
    const tiny = `0.${"0".repeat(330)}1`; // 1e-331: positive, but Number.parseFloat(tiny) === 0
    const v = validateShipment(shipment([{ weight: tiny, weightUnit: "lb" }]));
    expect(v.ok, v.ok ? "" : v.problems.join("; ")).toBe(true);
    const r = calculateShipment(shipment([{ weight: tiny, weightUnit: "lb" }]), context());
    expect(r.status).toBe("ok");
    // ceil(1e-331) = 1 lb → bracket (0, 1] → 10.00
    expect(r.packages[0]?.billableLb).toBe("1.0");
    expect(r.totals.expected.amount).toBe("10.00");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("the result does not depend on the order of the rules, overrides or packages' rules in the context", () => {
    const rules = [
      rule("b", { exclusivityGroup: "g", amount: "2.00" }),
      rule("a", { exclusivityGroup: "g", amount: "2.00" }), // ties with b on priority and amount → key order: a wins
      rule("c", { amount: "3.00", excludesRuleKeys: ["d"] }),
      rule("d", { amount: "4.00" }),
      fuel("15", { kind: "base_plus_all_surcharges" }),
    ];
    const forward = calculateShipment(shipment([ONE_LB]), context({ rules }));
    const reversed = calculateShipment(shipment([ONE_LB]), context({ rules: [...rules].reverse() }));
    expect(forward.status).toBe("ok");
    expect(reversed).toEqual(forward);
    // a (2.00) wins the group, c bundles d: 10.00 + 2.00 + 3.00 = 15.00; fuel 15% × 15.00 = 2.25; total 17.25
    expect(amounts(forward)).toEqual([
      ["base", 0, "10.00"],
      ["a", 0, "2.00"],
      ["c", 0, "3.00"],
      ["fuel", 0, "2.25"],
    ]);
    expect(forward.totals.expected.amount).toBe("17.25");
  });

  // ENGINE DEFECT (minor, environment-dependent): key order is decided with String.prototype.localeCompare,
  // which follows the process locale (ICU). "aa" sorts before "b" under en-US but after it under da-DK
  // (Danish collates "aa" as "å"), so the exclusivity tie-break and the bundling walk order change with
  // LANG on the server. Verified: `LANG=da_DK.UTF-8 node -e 'console.log("aa".localeCompare("b"))'` → 1.
  // This test passes in an en-US process; it would fail under a Danish locale. The contract requires the
  // same output for the same inputs, forever: tie-breaks must use a code-point comparison.
  it("exclusivity ties are broken by code-point key order, whatever the process locale", () => {
    const aa = rule("aa", { exclusivityGroup: "g", amount: "2.00" });
    const b = rule("b", { exclusivityGroup: "g", amount: "2.00" });
    const r = calc(shipment([ONE_LB]), context({ rules: [b, aa] }));
    // Code-point order: "aa" < "b" → aa wins.
    expect(lineKeys(r)).toEqual(["aa"]);
    expect(r.totals.expected.amount).toBe("12.00");
    // The hazard: ICU Danish collation reverses that order.
    expect(new Intl.Collator("da").compare("aa", "b")).toBe(1);
    expect(new Intl.Collator("en").compare("aa", "b")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Rounding and totals: positive checks (single rounding per line, totals = Σ rounded lines)
// ---------------------------------------------------------------------------

describe("single rounding per line and totals equal the sum of lines", () => {
  it("markup, per-unit minimum and fuel each round once; totals are the sum of the rounded lines", () => {
    const sig = rule("sig", { category: "signature", amount: "6.50", perPackage: false, conditions: [{ type: "signature_in", values: ["adult"] }] });
    const dv = rule("dv", {
      category: "declared_value",
      method: "per_unit",
      amount: "1.05",
      perUnit: { basis: "declared_value", unitSize: "100", freeAllowance: "100", minimumCharge: "3.33" },
      conditions: [{ type: "declared_value_gt", amount: "100" }],
    });
    const ctx = context({ rules: [sig, dv, fuel("16.5", { kind: "base_plus_all_surcharges" }, { perPackage: false })], service: { surchargeMarkupPercent: "1.5" } });
    const r = calc(shipment([{ weight: "1", weightUnit: "lb", declaredValue: "250.01" }], { options: { signature: "adult" } }), ctx);
    const by = (key: string, pkg: number | null) => r.lines.find((l) => l.rule?.key === key && l.packageIndex === pkg)!;

    // Signature: 6.50 × 101.5 ÷ 100 = 6.5975 → HALF_UP → 6.60 (not 6.59)
    expect(by("sig", null).amount.amount).toBe("6.60");
    // Declared value: units = ceil((250.01 − 100) ÷ 100) = ceil(1.5001) = 2; 2 × (1.05 × 1.015 = 1.06575) = 2.1315;
    // minimum 3.33 × 1.015 = 3.37995 > 2.1315 → the minimum applies → 3.37995 → 3.38
    expect(by("dv", 0).amount.amount).toBe("3.38");
    // Fuel: 16.5 × 1.015 = 16.7475%. Package 0 base: 10.00 + 3.38 = 13.38 → 16.7475% × 13.38 = 2.2408155 → 2.24.
    // Shipment: 16.7475% × 6.60 = 1.105335 → 1.11.
    expect(by("fuel", 0).amount.amount).toBe("2.24");
    expect(by("fuel", 0).basis).toBe("16.7475% of 13.38");
    expect(by("fuel", null).amount.amount).toBe("1.11");
    // 10.00 + 3.38 + 6.60 + 2.24 + 1.11 = 23.33
    expect(r.totals.expected.amount).toBe("23.33");
    expect(r.totals.definite.amount).toBe("23.33");
    expect(sumCounted(r.lines)).toBe(r.totals.expected.amount);
  });

  it("fixture: fuel on a multi-package residential shipment is rounded per package and the total is the sum of lines", () => {
    // Two UPS Ground packages 90001 → 30301 (zone 7), residential, 2026-10-15 (fuel v2 = 15.5%).
    // P0: 5 lb, 12 × 10 × 8 = 960 cu in ÷ 139 = 6.906… > 5 → 7 lb → zone 7 (6, 7] bracket.
    // P1: 12.3 lb, 14 × 12 × 10 = 1680 ÷ 139 = 12.086… < 12.3 → ceil(12.3) = 13 lb → (12, 13] bracket.
    const r = calc(
      {
        shipDate: "2026-10-15",
        originZip: "90001",
        destinationZip: "30301",
        residential: true,
        carrierCode: "ups",
        serviceCode: "ground",
        packages: [
          { weight: "5", weightUnit: "lb", length: "12", width: "10", height: "8" },
          { weight: "12.3", weightUnit: "lb", length: "14", width: "12", height: "10" },
        ],
      },
      fixtureContext(),
    );
    expect(r.packages.map((p) => p.billableLb)).toEqual(["7.0", "13.0"]);
    const base = (i: number) => dec(r.lines.find((l) => l.kind === "base" && l.packageIndex === i)!.amount.amount);
    const fuelLine = (i: number) => r.lines.find((l) => l.kind === "fuel" && l.packageIndex === i)!;
    for (const i of [0, 1]) {
      // fuel = 15.5% × (base + 5.00 residential), rounded HALF_UP once
      const expected = base(i).plus("5.00").times("15.5").div(100).toDecimalPlaces(2, 4 /* ROUND_HALF_UP */).toFixed(2);
      expect(fuelLine(i).amount.amount).toBe(expected);
      expect(fuelLine(i).basis).toBe(`15.5% of ${base(i).plus("5.00").toString()}`);
    }
    expect(sumCounted(r.lines)).toBe(r.totals.expected.amount);
    expect(r.totals.conditionalExposure.amount).toBe("21.00"); // address correction, per shipment, not counted
  });

  it("a half-cent fuel amount rounds HALF_UP, not HALF_EVEN", () => {
    // base 10.00 + flat 0.30 = 10.30; 15% × 10.30 = 1.545 → HALF_UP 1.55 (HALF_EVEN would give 1.54)
    const r = calc(shipment([ONE_LB]), context({ rules: [rule("s", { amount: "0.30" }), fuel("15", { kind: "base_plus_all_surcharges" })] }));
    expect(r.lines.find((l) => l.kind === "fuel")!.amount.amount).toBe("1.55");
    // and 25% × 10.10 = 2.525 → 2.53 (HALF_EVEN would give 2.52)
    const r2 = calc(shipment([ONE_LB]), context({ rules: [rule("s", { amount: "0.10" }), fuel("25", { kind: "base_plus_all_surcharges" })] }));
    expect(r2.lines.find((l) => l.kind === "fuel")!.amount.amount).toBe("2.53");
  });
});
