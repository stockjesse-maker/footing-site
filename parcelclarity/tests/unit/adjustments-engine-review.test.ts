import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  AdjustmentOverflowError, STORED_DECIMALS, evaluateAdjustmentScenario, forecastAdjustmentRisk, incidenceConfidence, scenarioStorageInput, scenarioStorageResult, storableDimension, storableWeight,
  summariseHistory, wilsonFraction, type AdjustmentScenarioInput, type HistoryBaseline, type HistoryRecord, type RiskInputs,
} from "@/engine/adjustments";
import { calculateShipment } from "@/engine";
import { ENGINE_VERSION as PRICING_ENGINE_VERSION, type ChargeLine, type PricingContext, type ShipmentInput, type SurchargeRule } from "@/engine/types";
import { buildContext, fixture, int, pick, policyFnFromProfile, rng, type ContextProfile, type PolicyProfile, type RulesFile } from "./adjustments-engine-support";

/**
 * Regression tests for the engine review (p3-review-engine, F1 to F11). Each block names its finding. Every expected number is arithmetic
 * from the M2 fixture card (UPS Ground zone 5, ship 2026-10-15, fuel 15.50 percent: 3 lb at 10x8x6 bills 4 lb = 12.79, 5 lb = 13.35,
 * 8 lb = 15.05, 3 lb at 14x10x8 bills 9 lb = 15.62), written out in the comments, never read back from the engine.
 */
const rules = fixture<RulesFile>("rules.json");
const { policyProfiles } = fixture<{ policyProfiles: Record<string, PolicyProfile> }>("scenarios.json");
const ctxCache = new Map<string, PricingContext>();
const ctxOf = (name: string): PricingContext => {
  let c = ctxCache.get(name);
  if (!c) {
    c = buildContext(rules.contexts[name]!, rules.rules);
    ctxCache.set(name, c);
  }
  return c;
};
const profileCtx = (ruleKeys: string[]): PricingContext => buildContext({ description: "ad hoc", ruleKeys } as ContextProfile, rules.rules);
const allPt = policyFnFromProfile(policyProfiles.all_pt);

const shipment = (packages: ShipmentInput["packages"], over: Partial<ShipmentInput> = {}): ShipmentInput => ({
  shipDate: "2026-10-15", originZip: "90001", destinationZip: "85001", residential: false, carrierCode: "ups", serviceCode: "ground", packages, ...over,
});
const pkg = (weight: string, dims: [string, string, string] | null = ["10", "8", "6"], unit: "lb" | "oz" = "lb") => ({ weight, weightUnit: unit, ...(dims ? { length: dims[0], width: dims[1], height: dims[2] } : {}) });
const lbCorr = (w: string) => ({ weight: w, weightUnit: "lb" as const });
const input = (s: ShipmentInput, corrections: AdjustmentScenarioInput["corrections"]): AdjustmentScenarioInput => ({ shipment: s, corrections, declaredSource: "entered" });
const run = (i: AdjustmentScenarioInput, ctx: PricingContext, policy = allPt) => evaluateAdjustmentScenario(i, ctx, policy);

/** A rule built from a fixture overlay rule with a patch. */
const overlay = (key: string, patch: Partial<SurchargeRule> = {}): SurchargeRule =>
  ({ brandId: null, billableWeightFloorLb: null, perUnit: null, ...(rules.rules.find((r) => r.key === key) as object), ...patch }) as SurchargeRule;
/** The M2 fixture rule with a patch (a rule the 3PL already has). */
const fixtureRule = (ctx: PricingContext, key: string, patch: Partial<SurchargeRule>): PricingContext => ({ ...ctx, rules: ctx.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) });

const rec = (id: string, over: Partial<HistoryRecord> = {}): HistoryRecord => ({
  id, brandId: "b1", carrierCode: "ups", serviceId: "s1", shipDate: "2026-01-10", adjustmentType: "reweight", cause: "carrier_reweigh", packageRef: id,
  originalCharge: "10.00", correctedCharge: "12.00", separateFee: "3.00", postageDifference: "2.00", ...over,
});
const base = (over: Partial<HistoryBaseline> = {}): HistoryBaseline => ({ id: "bl", brandId: "b1", carrierCode: null, serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 100, labelsMissingWeight: null, ...over });
const stats = (records: HistoryRecord[], baselines: HistoryBaseline[], filters: Record<string, unknown> = {}) => {
  const r = summariseHistory(records, baselines, { brandId: "b1", ...filters });
  if (r.status !== "ok") throw new Error(`refused: ${r.code} ${r.message}`);
  return r;
};
const refusal = (records: readonly HistoryRecord[], baselines: readonly HistoryBaseline[], filters: Record<string, unknown> = { brandId: "b1" }) => {
  const r = summariseHistory(records, baselines, filters as never);
  if (r.status !== "refused") throw new Error("expected a refusal");
  return r;
};

const riskInputs = (over: Partial<RiskInputs> = {}): RiskInputs => ({
  monthlyVolume: "1000",
  incidence: { source: "history", k: 20, N: 1000 },
  severity: { postage_difference: { source: "entered", e4: 100_000 }, separate_fee: { source: "entered", e4: 50_000 } },
  basis: "declared_weights",
  handling: { postage_difference: "pass_through", separate_fee: "pass_through" },
  ...over,
});
const okRisk = (i: RiskInputs) => {
  const r = forecastAdjustmentRisk(i);
  if (r.status !== "ok") throw new Error(`refused ${r.code}`);
  return r;
};

// ---------------------------------------------------------------------------
// F1: the account cap (200,000 records) must not overflow the call stack
// ---------------------------------------------------------------------------
describe("F1: statistics over a very large history", () => {
  const many = (n: number, over: (i: number) => Partial<HistoryRecord> = () => ({})) => Array.from({ length: n }, (_, i) => rec(`r${i}`, over(i)));
  const wide = [base({ packagesTotal: 5_000_000 })];

  it.each([125_000, 200_000])("summarises %i increase records (Math.max over a spread array used to throw a RangeError above ~125,000)", (n) => {
    const s = stats(many(n), wide);
    // every record is +2.00 postage and 3.00 fee: sum n x 20,000 E4, mean, median, p90 and max are all 20,000
    expect(s.affected).toBe(n);
    expect(s.severity.increase.postage).toMatchObject({ n, sumE4: n * 20_000, meanE4: 20_000, medianE4: 20_000, p90E4: 20_000, maxE4: 20_000 });
    expect(s.severity.increase.fee).toMatchObject({ n, sumE4: n * 30_000, meanE4: 30_000 });
    expect(s.topRecordOver25Pct).toEqual({ postage: false, fee: false }); // 20,000 is nowhere near a quarter of n x 20,000
    expect(s.incidence).toMatchObject({ k: n, N: 5_000_000 });
  }, 60_000);

  it("still flags one dominant record among 200,000 (the largest is more than a quarter of the sum)", () => {
    // one charge of 10,000,000.00 (1e11 E4) beside 199,999 charges of 1.00 (1e4 E4 each = 1,999,990,000): max 1e11 > 25% of 1.01999999e11
    const s = stats(many(200_000, (i) => (i === 0 ? { postageDifference: "10000000.00", separateFee: "3.00" } : { postageDifference: "1.00" })), wide);
    expect(s.topRecordOver25Pct).toEqual({ postage: true, fee: false });
    expect(s.severity.increase.postage.maxE4).toBe(100_000_000_000);
  }, 60_000);

  it("an amount that cannot be added exactly throws the deliberate AdjustmentOverflowError (a RangeError), distinguishable from a stack overflow", () => {
    // two charges of 900,719,925,474.0991 dollars: 9,007,199,254,740,991 E4 each (the largest safe integer); their sum is not safe
    const huge = (id: string) => rec(id, { postageDifference: "900719925474.0991", separateFee: null });
    let caught: unknown;
    try {
      summariseHistory([huge("a"), huge("b")], [base()], { brandId: "b1" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AdjustmentOverflowError);
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).message).toMatch(/too large to carry exactly/);
  });
});

// ---------------------------------------------------------------------------
// F2: nothing a fee rule carries may move the postage difference
// ---------------------------------------------------------------------------
describe("F2: the postage difference is priced without any adjustment-fee rule", () => {
  const e2 = (ctx: PricingContext, residential = false) => run(input(shipment([pkg("3")], { residential }), [lbCorr("5")]), ctx);

  it("a fixture surcharge that lists a FEE rule as suppressed neither removes the fee nor moves the postage (the other direction of the bundling)", () => {
    // residential 3 -> 5 lb: declared 11.07 + 5.00 + fuel 15.5% x 16.07 = 2.49 -> 18.56; corrected 11.56 + 5.00 + fuel 15.5% x 16.56 = 2.57 -> 19.13; +0.57
    const ctx = fixtureRule(ctxOf("reweight_flat"), "fixture.ups.residential", { excludesRuleKeys: ["fixture.adj.reweight_flat"] });
    const r = e2(ctx, true);
    expect(r.components!.postage_difference).toMatchObject({ amount: "0.57", declaredTotal: "18.56", correctedTotal: "19.13" });
    expect(r.components!.separate_fee).toMatchObject({ state: "conditional", amount: "3.00" });
    expect(r.warnings).toContain("adjustment_fee_rule_excludes_ignored");
  });

  it("a percent fee on a PER-PACKAGE rule with a 20 lb floor ignores the floor (10% of the 5 lb base 11.56 = 1.16, not 10% of the 20 lb base)", () => {
    const ctx = { ...ctxOf("none"), rules: [...ctxOf("none").rules, overlay("fixture.adj.reweight_pct", { perPackage: true, billableWeightFloorLb: "20" })] };
    const r = e2(ctx);
    expect(r.components!.postage_difference.amount).toBe("0.56");
    expect(r.components!.separate_fee.lines).toEqual([expect.objectContaining({ packageIndex: 0, coveredPackageIndexes: null, amount: "1.16", method: "percent" })]);
    expect(r.warnings).toContain("adjustment_fee_rule_floor_ignored");
  });

  it("a superseded version of a rule never comes back: a key whose newer version is a fee rule leaves no trace in the postage", () => {
    // v1 is a definite 7.00 peak surcharge, v2 (same key, in force too, the one the engine picks) is a reweight fee rule. Splitting by category BEFORE
    // choosing the version would put v1 back into both postage pricings (7.00 and its fuel: 12.79 -> 21.44 would read +0.57 instead of +0.56).
    const v1 = overlay("fixture.adj.reweight_flat", { key: "fixture.adj.shape_shifter", version: 1, category: "peak", chargeClass: "definite", amount: "7.00", name: "Old peak version" });
    const v2 = overlay("fixture.adj.reweight_flat", { key: "fixture.adj.shape_shifter", version: 2, name: "Reweigh fee, version 2" });
    const ctx = { ...ctxOf("none"), rules: [...ctxOf("none").rules, v1, v2] };
    const r = e2(ctx);
    expect(r.components!.postage_difference).toMatchObject({ amount: "0.56", declaredTotal: "12.79", correctedTotal: "13.35" });
    expect(r.components!.separate_fee.lines.map((l) => [l.ruleKey, l.amount])).toEqual([["fixture.adj.shape_shifter", "3.00"]]);
  });

  it("a companion of a fee rule never reaches a percent fee's base either (the fee pass leaves rule_applied on a fee rule unmet, also inside an any_of)", () => {
    // commercial 3 -> 5 lb, a percent fee on base plus all surcharges (10%) next to the reweigh rule and a 1.50 peak companion of that reweigh rule.
    // The percent base is the corrected base 11.56 alone: 1.156 -> 1.16. A companion that applied in the fee pass would add its 1.50 to the shipment-level base (+0.15).
    const companion = (conditions: SurchargeRule["conditions"]) => overlay("fixture.adj.peak_on_reweigh", { conditions });
    const plain = [rules.rules.find((r) => r.key === "fixture.adj.reweight_flat")!, overlay("fixture.adj.reweight_pct_all_surcharges")];
    for (const conditions of [
      [{ type: "rule_applied" as const, ruleKey: "fixture.adj.reweight_flat" }],
      [{ type: "any_of" as const, conditions: [{ type: "rule_applied" as const, ruleKey: "fixture.adj.reweight_flat" }, { type: "residential" as const, value: true }] }],
    ]) {
      const ctx = { ...ctxOf("none"), rules: [...ctxOf("none").rules, ...(plain as SurchargeRule[]).map((r) => overlay(r.key!)), companion(conditions)] };
      const r = e2(ctx);
      expect(r.components!.postage_difference).toMatchObject({ amount: "0.56", declaredTotal: "12.79", correctedTotal: "13.35" });
      expect(r.components!.separate_fee.lines.map((l) => [l.ruleKey, l.amount])).toEqual([["fixture.adj.reweight_flat", "3.00"], ["fixture.adj.reweight_pct_all_surcharges", "1.16"]]);
      expect(r.warnings).toContain("adjustment_fee_rule_companion_ignored");
    }
  });

  it("an outcome that only the FEE rule leaves unknown still makes the example an estimate, with the unknown fee in the corrected side's unresolved total", () => {
    // a reweigh fee that depends on a ZIP list no other rule uses and that is not loaded: every postage line is decided, only the fee is unknown
    const unknownFee = overlay("fixture.adj.reweight_flat", { conditions: [{ type: "destination_zip_in_list", listKey: "fixture.test.not_loaded" }] });
    const r = e2({ ...ctxOf("none"), rules: [...ctxOf("none").rules, unknownFee] });
    expect(r.components!.postage_difference).toMatchObject({ amount: "0.56" });
    expect(r.basis).toBe("estimate");
    expect(r.components!.separate_fee).toMatchObject({ state: "undecided", amount: null, upTo: "3.00" });
    expect(r.sides!.declared).toMatchObject({ unresolved: "0.00", warnings: [] });
    expect(r.sides!.corrected).toMatchObject({ unresolved: "3.00", countedTotal: "13.35" });
    expect(r.sides!.corrected.warnings).toContain("zip_list_missing");
  });

  it("the corrected side's unresolved lines and warnings come from the fee pass, its counted total from the postage pricing", () => {
    // no ZIP lists: DAS (4.00) and extended DAS (6.00) are unknown on both sides (10.00 each) and the DAS-only reweigh rule is unknown on the corrected side (3.00)
    const r = e2(ctxOf("reweight_das_only_no_zip_lists"));
    expect(r.sides!.declared).toMatchObject({ countedTotal: "12.79", unresolved: "10.00" });
    expect(r.sides!.corrected).toMatchObject({ countedTotal: "13.35", unresolved: "13.00" });
    expect(r.sides!.corrected.warnings).toContain("zip_list_missing");
    expect(r.basis).toBe("estimate");
  });

  it("property: with ANY context of rules.json the postage difference, status, direction and counted totals equal those of the same scenario with no fee rule at all (150 draws x every context)", () => {
    const none = ctxOf("none");
    // Contexts that change the postage itself on purpose are left out: customer overrides (residential waived, fuel changed) and a missing ZIP list (DAS becomes unknown).
    const names = Object.keys(rules.contexts).filter((n) => n !== "none" && rules.contexts[n]!.withOverrides !== true && rules.contexts[n]!.withZipLists !== false);
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 29);
      const n = int(r, 1, 3);
      const s = shipment(Array.from({ length: n }, () => pkg(String(int(r, 2, 60)), r() < 0.8 ? [String(int(r, 4, 24)), String(int(r, 4, 20)), String(int(r, 3, 14))] : null)), { residential: r() < 0.4, destinationZip: pick(r, ["85001", "93920", "90210"] as const) });
      const corrections = s.packages.map((p) => (r() < 0.6 ? { weight: String(Number(p.weight) + int(r, 1, 30)), weightUnit: "lb" as const, ...(r() < 0.3 ? { height: String(int(r, 3, 30)) } : {}) } : {}));
      if (corrections.every((c) => Object.keys(c).length === 0)) corrections[0] = lbCorr(String(Number(s.packages[0]!.weight) + 5));
      const i = input(s, corrections);
      const want = run(i, none);
      if (want.status !== "ok" && want.status !== "no_adjustment") continue;
      for (const name of names) {
        const got = run(i, ctxOf(name));
        expect(got.status, `seed ${seed} ${name}`).toBe(want.status);
        expect(got.direction, `seed ${seed} ${name}`).toBe(want.direction);
        expect(got.components!.postage_difference, `seed ${seed} ${name}`).toEqual(want.components!.postage_difference);
        expect(got.sides!.declared.countedTotal).toBe(want.sides!.declared.countedTotal);
        expect(got.sides!.corrected.countedTotal).toBe(want.sides!.corrected.countedTotal);
      }
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// F3: exact edges of the Wilson interval
// ---------------------------------------------------------------------------
describe("F3: k = 0 and k = N are exact", () => {
  const HP = Decimal.clone({ precision: 80 }); // the test's own arithmetic must be more precise than the 60 digits it checks
  const Z2 = new HP("3.8416"); // 1.96 squared, exactly

  it("for every N up to 300 the lower bound at k = 0 is exactly 0 and the upper bound at k = N is exactly 1 (51 and 67 of these used to be off by ~1e-60)", () => {
    for (let N = 1; N <= 300; N++) {
      const none = wilsonFraction(0, N)!;
      const all = wilsonFraction(N, N)!;
      expect(none.lower.isZero(), `k=0 N=${N}`).toBe(true);
      expect(all.upper.eq(1), `k=N N=${N}`).toBe(true);
      // the other edge in closed form: z^2 / (N + z^2) at k = 0, N / (N + z^2) at k = N
      expect(new HP(none.upper.toString()).minus(Z2.div(Z2.plus(N))).abs().lessThan("1e-50"), `upper k=0 N=${N}`).toBe(true);
      expect(new HP(all.lower.toString()).minus(new HP(N).div(Z2.plus(N))).abs().lessThan("1e-50"), `lower k=N N=${N}`).toBe(true);
    }
  });

  it("every other k lies strictly inside (0, 1) and brackets the point estimate, up to the largest safe N (so no clamp is needed)", () => {
    const r = rng(303);
    for (let i = 0; i < 400; i++) {
      const N = i < 4 ? Number.MAX_SAFE_INTEGER : int(r, 2, 5_000_000);
      const k = i % 3 === 0 ? 1 : i % 3 === 1 ? N - 1 : int(r, 1, N - 1);
      const f = wilsonFraction(k, N)!;
      const p = new Decimal(k).div(N);
      expect(f.lower.greaterThan(0) && f.upper.lessThan(1), `k=${k} N=${N}`).toBe(true);
      expect(f.lower.lessThan(p.plus("1e-40")) && f.upper.greaterThan(p.minus("1e-40")), `k=${k} N=${N}`).toBe(true);
    }
  });

  it.each([3, 7, 13])("the forecast range at k = 0, N = %i with unknown severities is 0 at the low end (not null) and null at the high end", (N) => {
    const f = okRisk(riskInputs({ incidence: { source: "history", k: 0, N }, severity: { postage_difference: { source: "history", e4: null, n: 0 }, separate_fee: { source: "history", e4: null, n: 0 } } }));
    expect(f.range).toMatchObject({ lowE4: 0, highE4: null, incidenceLowPct4dp: "0.0000" });
  });

  it.each([6, 13, 15, 17])("the forecast range at k = N = %i ends exactly at V: 42,946.95 shows 42,947.0 affected (HALF_UP), the same as the point estimate", (N) => {
    const f = okRisk(riskInputs({ monthlyVolume: "42946.95", incidence: { source: "history", k: N, N }, severity: { postage_difference: { source: "entered", e4: 1000 }, separate_fee: { source: "entered", e4: 1000 } } }));
    expect(f.range!.highAffected1dp).toBe("42947.0");
    expect(f.affected!.display1dp).toBe("42947.0");
    expect(f.range!.highE4).toBe(85_893_900); // 42,946.95 x 100% x 2,000 E4 = 85,893,900 exactly
    expect(f.range!.incidenceHighPct4dp).toBe("100.0000");
  });
});

// ---------------------------------------------------------------------------
// F4: a package is corrected for the fee only when it moved
// ---------------------------------------------------------------------------
describe("F4: which packages carry a fee", () => {
  const priceOnly = (ctx: PricingContext): PricingContext => ({ ...ctx, rules: ctx.rules.filter((r) => !["reweight", "remeasure", "shipping_charge_correction"].includes(r.category)) });
  const counted = (calc: ReturnType<typeof calculateShipment>, i: number) => calc.lines.filter((l: ChargeLine) => l.counted && l.packageIndex === i).reduce((s, l) => s.plus(l.amount.amount), new Decimal(0));

  it("a shipment-level charge that changes cannot be pinned on one package, so every package changed on paper keeps its fee", () => {
    // a 20x20x20 box bills 58 lb (DIM) whatever it weighs below that. A shipment-level 10.00 'other' charge applies when the actual weight is above 40 lb (no fuel
    // on 'other'): declared 39 lb = 37.53 + fuel 5.82 = 43.35; corrected 41 lb = the same + 10.00 = 53.35. The package itself (billable 58, rounded
    // dimensions, package-level price) did not change, but the shipment-level line did, so the corrected package still draws the per-package fee 3.00.
    const heavy = overlay("fixture.adj.reweight_flat", { key: "fixture.test.heavy_shipment", category: "other", chargeClass: "definite", amount: "10.00", perPackage: false, name: "Heavy shipment charge",
      conditions: [{ type: "weight_gt", valueLb: "40", basis: "actual" }], effectiveDate: "2026-01-01" });
    const ctx = { ...ctxOf("reweight_pp"), rules: [...ctxOf("reweight_pp").rules, heavy] };
    const r = run(input(shipment([pkg("39", ["20", "20", "20"])]), [lbCorr("41")]), ctx);
    expect(r.components!.postage_difference).toMatchObject({ amount: "10.00", declaredTotal: "43.35", correctedTotal: "53.35" });
    expect(r.components!.separate_fee).toMatchObject({ state: "conditional", amount: "3.00" });
    expect(r.components!.separate_fee.lines.map((l) => l.packageIndex)).toEqual([0]);
  });

  it("a package whose billable weight and rounded dimensions did not change but whose price did (a surcharge flipped) is corrected: golden e3 with a per-package fee", () => {
    // 20x20x20 bills 58 lb whatever it weighs below that; at 52 lb (actual above 50) Additional handling 28.00 applies to the package: 43.35 -> 75.69 (+32.34, golden e3)
    const r = run(input(shipment([pkg("49", ["20", "20", "20"])]), [lbCorr("52")]), ctxOf("reweight_pp"));
    expect(r.sides!.declared.packages[0]!.billableLb).toBe("58.0");
    expect(r.sides!.corrected.packages[0]!.billableLb).toBe("58.0");
    expect(r.components!.postage_difference).toMatchObject({ amount: "32.34", declaredTotal: "43.35", correctedTotal: "75.69" });
    expect(r.components!.separate_fee.lines.map((l) => [l.packageIndex, l.amount])).toEqual([[0, "3.00"]]);
  });

  it("a change in an UNCOUNTED line (a conditional charge appears) does not make a package corrected: only counted price counts", () => {
    // package 0 is a 20x20x20 box (bills 58 lb) going 39 -> 41 lb: a per-package conditional 10.00 'other' charge (actual weight above 40) appears on it, but it is
    // conditional (never counted), so nothing the customer is charged moved for package 0. Package 1 really moves (3 -> 8 lb). Only package 1 draws the fee.
    const conditionalHeavy = overlay("fixture.adj.reweight_pp", { key: "fixture.test.heavy_conditional", category: "other", chargeClass: "conditional", amount: "10.00", perPackage: true, name: "Heavy package charge, if applied",
      conditions: [{ type: "weight_gt", valueLb: "40", basis: "actual" }] });
    const ctx = { ...ctxOf("reweight_pp"), rules: [...ctxOf("reweight_pp").rules, conditionalHeavy] };
    const r = run(input(shipment([pkg("39", ["20", "20", "20"]), pkg("3")]), [lbCorr("41"), lbCorr("8")]), ctx);
    expect(r.components!.postage_difference.amount).toBe("2.26"); // package 1: 12.79 -> 15.05; package 0: 43.35 on both sides
    expect(r.components!.separate_fee.lines.map((l) => [l.packageIndex, l.amount])).toEqual([[1, "3.00"]]);
  });

  it("a package whose billable weight changed but whose price did not (a price plateau) is still corrected, beside a package that moved", () => {
    // zone 2 (destination 90210): a 6x4x2 package at 1 lb and at 2 lb bills 1 lb and 2 lb, both below the 8.50 service minimum, so 9.82 on both sides (golden
    // plateau_billable_differs_zero_delta). Alone it is status ok / direction none with no fee; beside package 1 (3 -> 20 lb, a real increase) it draws its fee too.
    const s = shipment([pkg("1", ["6", "4", "2"]), pkg("3")], { destinationZip: "90210" });
    const r = run(input(s, [lbCorr("2"), lbCorr("20")]), ctxOf("reweight_pp"));
    expect(r.direction).toBe("increase");
    expect(r.sides!.declared.packages[0]!.billableLb).toBe("1.0");
    expect(r.sides!.corrected.packages[0]!.billableLb).toBe("2.0");
    expect(r.components!.separate_fee.lines.map((l) => [l.packageIndex, l.amount])).toEqual([[0, "3.00"], [1, "3.00"]]);
    // alone: nothing moved in price, direction none, no fee shown
    const alone = run(input(shipment([pkg("1", ["6", "4", "2"])], { destinationZip: "90210" }), [lbCorr("2")]), ctxOf("reweight_pp"));
    expect(alone).toMatchObject({ status: "ok", direction: "none" });
    expect(alone.components!.separate_fee).toMatchObject({ state: "not_triggered", lines: [] });
  });

  it("three packages, one moved: only the moved package draws the per-package fee", () => {
    const r = run(input(shipment([pkg("3"), pkg("3"), pkg("3")]), [lbCorr("3.2"), lbCorr("8"), lbCorr("3.4")]), ctxOf("reweight_pp"));
    // packages 0 and 2 still bill 4 lb at 12.79; package 1: 4 lb -> 8 lb, 12.79 -> 15.05 (+2.26)
    expect(r.components!.postage_difference.amount).toBe("2.26");
    expect(r.components!.separate_fee.lines.map((l) => [l.packageIndex, l.amount])).toEqual([[1, "3.00"]]);
  });

  it("property: the per-package fee lines are exactly the packages whose billable weight, rounded dimensions or counted price changed, re-derived with the pricing engine (300 draws)", () => {
    for (const name of ["reweight_pp", "remeasure_pp"] as const) {
      const ctx = ctxOf(name);
      const plain = priceOnly(ctx);
      let withFee = 0;
      for (let seed = 1; seed <= 150; seed++) {
        const r = rng(seed * 37 + (name === "reweight_pp" ? 0 : 1000));
        const n = int(r, 2, 4);
        const s = shipment(Array.from({ length: n }, () => pkg(String(int(r, 2, 40)), [String(int(r, 6, 22)), String(int(r, 5, 16)), String(int(r, 3, 12))])));
        const corrections = s.packages.map((p) => {
          if (r() < 0.35) return {};
          if (name === "reweight_pp") return lbCorr((Number(p.weight) + (r() < 0.5 ? int(r, 1, 3) / 10 : int(r, 1, 30))).toFixed(1));
          return r() < 0.5 ? { height: String(Number(p.height) + 1) } : { length: String(Number(p.length) + int(r, 1, 12)) };
        });
        if (corrections.every((c) => Object.keys(c).length === 0)) corrections[0] = name === "reweight_pp" ? lbCorr("45") : { length: "30" };
        const i = input(s, corrections);
        const res = run(i, ctx);
        if (res.status !== "ok" && res.status !== "no_adjustment") continue;
        const declared = calculateShipment(s, plain);
        const corrected = calculateShipment({ ...s, packages: s.packages.map((p, j) => ({ ...p, ...corrections[j] })) }, plain);
        const expectedScope = s.packages.map((_, j) => j).filter((j) => {
          const a = declared.packages[j]!;
          const b = corrected.packages[j]!;
          return !new Decimal(a.billableLb).eq(b.billableLb) || JSON.stringify(a.roundedDimensionsIn?.map(Number)) !== JSON.stringify(b.roundedDimensionsIn?.map(Number)) || !counted(declared, j).eq(counted(corrected, j));
        });
        const listed = res.components!.separate_fee.lines.map((l) => l.packageIndex);
        if (res.status === "no_adjustment" || res.direction !== "increase") {
          expect(listed, `${name} seed ${seed}`).toEqual([]);
          continue;
        }
        withFee++;
        expect(listed, `${name} seed ${seed}`).toEqual(expectedScope);
      }
      expect(withFee, name).toBeGreaterThan(40);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// F5: a shipment-level percent fee says which packages it covers
// ---------------------------------------------------------------------------
describe("F5: coveredPackageIndexes", () => {
  it("three packages, two corrected: the percent line covers [0, 2] and is the sum of the two per-package roundings", () => {
    // 8 lb base (7,8] = 13.03; 10% = 1.303 -> 1.30 per corrected package; the untouched package 1 is left out
    const r = run(input(shipment([pkg("3"), pkg("3"), pkg("3")]), [lbCorr("8"), {}, lbCorr("8")]), ctxOf("reweight_pct"));
    expect(r.components!.separate_fee).toMatchObject({ state: "conditional", amount: "2.60" });
    expect(r.components!.separate_fee.lines).toEqual([expect.objectContaining({ packageIndex: null, coveredPackageIndexes: [0, 2], amount: "2.60", method: "percent" })]);
  });

  it("a percent fee on base plus all surcharges also takes the percent of the shipment-level charges (a signature), rounded on its own, whole whatever packages were corrected", () => {
    // commercial 3 -> 5 lb with an adult-signature option: the package's base is 11.56 -> 10% = 1.156 -> 1.16; the signature is a 6.50 shipment-level charge
    // on both sides -> 10% = 0.65. One line, 1.81, covering package 0. The postage difference is untouched by the signature (it is on both sides): +0.56.
    const r = run(input(shipment([pkg("3")], { options: { signature: "adult" } }), [lbCorr("5")]), ctxOf("reweight_pct_all_surcharges"));
    expect(r.components!.postage_difference).toMatchObject({ amount: "0.56", declaredTotal: "19.29", correctedTotal: "19.85" }); // 12.79 + 6.50 and 13.35 + 6.50
    expect(r.components!.separate_fee.lines).toEqual([expect.objectContaining({ packageIndex: null, coveredPackageIndexes: [0], amount: "1.81", method: "percent" })]);
  });

  it("a flat shipment-level line and a per-package line list no covered packages", () => {
    const flat = run(input(shipment([pkg("3"), pkg("3")]), [lbCorr("8"), lbCorr("8")]), ctxOf("reweight_flat"));
    expect(flat.components!.separate_fee.lines).toEqual([expect.objectContaining({ packageIndex: null, coveredPackageIndexes: null, amount: "3.00", method: "flat" })]);
    const perPackage = run(input(shipment([pkg("3"), pkg("3")]), [lbCorr("8"), {}]), ctxOf("reweight_pp"));
    expect(perPackage.components!.separate_fee.lines).toEqual([expect.objectContaining({ packageIndex: 0, coveredPackageIndexes: null, amount: "3.00" })]);
  });

  it("property: a shipment-level percent fee is the sum over the corrected packages of cents(10% x that package's base rate), and covers exactly them (200 draws)", () => {
    const ctx = ctxOf("reweight_pct");
    const plain = { ...ctx, rules: ctx.rules.filter((r) => r.category !== "reweight") };
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 41);
      const n = int(r, 1, 4);
      const s = shipment(Array.from({ length: n }, () => pkg(String(int(r, 2, 40)), [String(int(r, 6, 22)), String(int(r, 5, 16)), String(int(r, 3, 12))])));
      const corrections = s.packages.map((p) => (r() < 0.4 ? {} : lbCorr(String(Number(p.weight) + int(r, 1, 30)))));
      if (corrections.every((c) => Object.keys(c).length === 0)) corrections[0] = lbCorr(String(Number(s.packages[0]!.weight) + 7));
      const res = run(input(s, corrections), ctx);
      const fee = res.components?.separate_fee;
      if (!fee || fee.state !== "conditional") continue;
      const corrected = calculateShipment({ ...s, packages: s.packages.map((p, j) => ({ ...p, ...corrections[j] })) }, plain);
      const covered = fee.lines[0]!.coveredPackageIndexes!;
      const want = covered.reduce((sum, j) => {
        const baseOf = corrected.lines.filter((l) => l.counted && l.packageIndex === j && l.category === "base").reduce((x, l) => x.plus(l.amount.amount), new Decimal(0));
        return sum.plus(baseOf.times("10").div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
      }, new Decimal(0));
      expect(fee.amount, `seed ${seed}`).toBe(want.toFixed(2));
      expect(covered, `seed ${seed}`).toEqual([...covered].sort((a, b) => a - b));
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// F6 and F7
// ---------------------------------------------------------------------------
describe("F6: the net-of-credits memo", () => {
  const credits = { k: 10, severityE4: -80_000 };
  const sev = { postage_difference: { source: "history" as const, e4: 100_000, n: 40 }, separate_fee: { source: "history" as const, e4: 30_000, n: 40 } };

  it("declared weights: counted 2,600,000 + credits -800,000 = net 1,800,000", () => {
    const f = okRisk(riskInputs({ severity: sev, credits }));
    expect([f.countedHereE4, f.creditsMemoE4, f.netMemoE4]).toEqual([2_600_000, -800_000, 1_800_000]);
  });

  it("actual weights: only the fee (600,000) is counted here, the credit is a memo and the net is null (it used to read -200,000, a gain)", () => {
    const f = okRisk(riskInputs({ severity: sev, credits, basis: "actual_weights" }));
    expect([f.countedHereE4, f.creditsMemoE4, f.netMemoE4]).toEqual([600_000, -800_000, null]);
  });

  it("property: the net memo exists exactly under declared weights with something counted, and then equals counted + credits (300 draws)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 43);
      const N = int(r, 10, 5000);
      const k = int(r, 0, Math.floor(N / 2));
      const basis = pick(r, ["declared_weights", "actual_weights"] as const);
      const f = okRisk(riskInputs({
        monthlyVolume: String(int(r, 0, 100_000)), incidence: { source: "history", k, N }, basis,
        severity: { postage_difference: { source: "entered", e4: r() < 0.2 ? null : int(r, 0, 500_000) }, separate_fee: { source: "entered", e4: r() < 0.2 ? null : int(r, 0, 500_000) } },
        credits: { k: int(r, 0, Math.floor(N / 2)), severityE4: -int(r, 0, 300_000) },
      }));
      if (basis === "actual_weights" || f.countedHereE4 === null) expect(f.netMemoE4, `seed ${seed}`).toBeNull();
      else expect(f.netMemoE4, `seed ${seed}`).toBe(f.countedHereE4 + f.creditsMemoE4!);
    }
  });
});

describe("F7: sums are exact or refused, never imprecise", () => {
  const huge = 9_007_199_254_740_991; // 2^53 - 1
  const sevOf = (post: number, fee: number) => ({ postage_difference: { source: "history" as const, e4: post, n: 30 }, separate_fee: { source: "example" as const, e4: fee, n: 29 } });
  const bothUnconfigured = { postage_difference: "unconfigured" as const, separate_fee: "unconfigured" as const };

  it("two severities that add up beyond 2^53 - 1 are refused with overflow, even at V = 0 (perAffectedE4 used to come back as an imprecise 9007199254758988)", () => {
    const r = forecastAdjustmentRisk(riskInputs({ monthlyVolume: "0", incidence: { source: "history", k: 2, N: 2 }, severity: sevOf(17_996, huge), handling: bothUnconfigured }));
    expect(r).toMatchObject({ status: "refused", code: "overflow" });
  });

  it("the same sum is refused through the range too (V > 0, every individual amount small): 1 affected package in 10^6 of two severities near 2^53", () => {
    const r = forecastAdjustmentRisk(riskInputs({ monthlyVolume: "1", incidence: { source: "history", k: 1, N: 1_000_000 }, severity: sevOf(huge, huge), handling: bothUnconfigured }));
    expect(r).toMatchObject({ status: "refused", code: "overflow" });
  });

  it("two amounts that are each safe but whose TOTAL is not are refused (5,000,000 packages at 100% x 1,000,000,000 E4 is 5e15 a component, 1e16 together)", () => {
    const sev = (e4: number) => ({ postage_difference: { source: "entered" as const, e4 }, separate_fee: { source: "entered" as const, e4 } });
    const volumeAll = { monthlyVolume: "5000000", incidence: { source: "entered", pct: "100" } as const };
    expect(forecastAdjustmentRisk(riskInputs({ ...volumeAll, severity: sev(1_000_000_000) }))).toMatchObject({ status: "refused", code: "overflow" });
    // a tenth of that is carried exactly: 5e14 a component, 1e15 together, 1.2e16 a year is still above 2^53 - 1 = 9.007e15, so the YEAR is refused, not the month:
    expect(forecastAdjustmentRisk(riskInputs({ ...volumeAll, severity: sev(100_000_000) }))).toMatchObject({ status: "refused", code: "overflow" });
    // and a hundredth is fine: 5e13 a component, 1e14 together, 1.2e15 a year
    const fine = okRisk(riskInputs({ ...volumeAll, severity: sev(10_000_000) }));
    expect([fine.countedHereE4, fine.annualE4]).toEqual([100_000_000_000_000, 1_200_000_000_000_000]);
  });

  it("only the deliberate overflow becomes the 'overflow' refusal: any other RangeError (a stack overflow, say) is not an amount that is too large, and is raised as it is", () => {
    const poisoned = { ...riskInputs(), get handling(): never { throw new RangeError("Maximum call stack size exceeded"); } } as unknown as RiskInputs;
    expect(() => forecastAdjustmentRisk(poisoned)).toThrow("Maximum call stack size exceeded");
  });

  it("a credit memo beyond the safe range is refused; a sum that fits is carried exactly", () => {
    expect(forecastAdjustmentRisk(riskInputs({ monthlyVolume: "5000000", incidence: { source: "history", k: 5, N: 1000 }, credits: { k: 5, severityE4: -huge } }))).toMatchObject({ status: "refused", code: "overflow" });
    // 4,503,599,627,370,495 + 4,503,599,627,370,496 = 2^53 - 1: still safe, exactly
    const edge = okRisk(riskInputs({ monthlyVolume: "0", incidence: { source: "history", k: 2, N: 2 }, severity: sevOf(4_503_599_627_370_495, 4_503_599_627_370_496), handling: bothUnconfigured }));
    expect(edge.perAffectedE4).toBe(huge);
  });
});

// ---------------------------------------------------------------------------
// F8: gaps the mutation check found
// ---------------------------------------------------------------------------
describe("F8: targeted tests for the surviving mutants", () => {
  it("s12: a shipping_charge_correction rule is kept for a REMEASURE scenario (4.00 remeasure + 5.00 correction, mixed handling)", () => {
    const ctx = profileCtx(["fixture.adj.remeasure_flat", "fixture.adj.correction_flat"]);
    const mixed = policyFnFromProfile(policyProfiles.reweight_pt_correction_manual); // remeasure rows pass_through, correction row manual_approval
    const r = run(input(shipment([pkg("3")]), [{ length: "14", width: "10", height: "8" }]), ctx, mixed);
    expect(r.adjustmentType).toBe("remeasure");
    expect(r.components!.separate_fee.lines.map((l) => [l.ruleKey, l.amount, l.handling])).toEqual([
      ["fixture.adj.correction_flat", "5.00", "manual_approval"],
      ["fixture.adj.remeasure_flat", "4.00", "pass_through"],
    ]);
    expect(r.components!.separate_fee).toMatchObject({ amount: "9.00", handling: "mixed" });
    expect(r.warnings).toContain("adjustment_fee_rules_stack");
    // 2.83 postage pass_through and 4.00 pass_through are customerPays, 5.00 is decided case by case
    expect(r.totalsE4).toEqual({ customerPays: 68_300, decidedCaseByCase: 50_000, notBilledToCustomer: 0, notDecided: 0 });
  });

  it("h4: baselines that share one day overlap (31 January in both), adjacent baselines do not", () => {
    const touching = refusal([], [base({ id: "jan" }), base({ id: "feb", periodStart: "2026-01-31", periodEnd: "2026-02-28" })]);
    expect(touching).toMatchObject({ code: "baselines_overlap", ids: ["jan", "feb"] });
    expect(stats([rec("a")], [base({ id: "jan" }), base({ id: "feb", periodStart: "2026-02-01", periodEnd: "2026-02-28", packagesTotal: 50 })]).incidence).toMatchObject({ k: 1, N: 150 });
  });

  it("h14: a record with no service OUTSIDE the baseline does not block a service filter; the same record inside does, with its count", () => {
    const outside = [rec("in"), rec("out", { serviceId: null, shipDate: "2025-12-15" })];
    const scoped = [base({ serviceId: "s1" })];
    expect(stats(outside, scoped, { serviceId: "s1" })).toMatchObject({ recordsInScope: 1, affected: 1, excludedOutsideBaseline: 0 });
    const inside = [rec("in"), rec("none", { serviceId: null })];
    expect(refusal(inside, scoped, { brandId: "b1", serviceId: "s1" })).toMatchObject({ code: "service_unresolved", unresolvedCount: 1 });
  });

  it("h17: labels without a weight typed on only SOME of the selected baselines give no rate at all", () => {
    const s = stats([rec("a", { cause: "wms_no_weight" })], [base({ id: "jan", labelsMissingWeight: 40 }), base({ id: "feb", periodStart: "2026-02-01", periodEnd: "2026-02-28", labelsMissingWeight: null })]);
    expect(s).toMatchObject({ labelsMissingWeight: null, missingRatePct: null, correctionRatePct: null, wmsNoWeightAffected: null });
    const all = stats([rec("a", { cause: "wms_no_weight" })], [base({ id: "jan", labelsMissingWeight: 40 }), base({ id: "feb", periodStart: "2026-02-01", periodEnd: "2026-02-28", labelsMissingWeight: 10 })]);
    expect(all).toMatchObject({ labelsMissingWeight: 50, missingRatePct: "25.0000", correctionRatePct: "2.0000", wmsNoWeightAffected: 1 }); // 50 of 200 packages; 1 of 50 labels
  });

  it.each([
    // [k, N, relative half-width of the Wilson interval worked independently with 80-digit decimals, level]
    [9, 27, 0.5029878852, "low"], // just above 0.5 (a threshold moved to 0.51 would call this moderate)
    [7, 16, 0.4996964692, "moderate"], // just below 0.5
    [29, 59, 0.2514767837, "moderate"], // just above 0.25 (a threshold moved to 0.26 would call this adequate)
    [29, 58, 0.249238835, "adequate"], // just below 0.25
    [11, 45, 0.4998748409, "moderate"], // 0.00013 below 0.5 (a threshold moved down to 0.4997 would call this low)
    [14, 134, 0.5000145363, "low"], // 0.000015 above 0.5: the threshold is exactly 0.5, not a hair above
    [35, 86, 0.2498049595, "adequate"], // 0.0002 below 0.25
    [23, 39, 0.2501304177, "moderate"], // 0.00013 above 0.25
  ] as const)("w3, w4: incidence k=%i of N=%i (relative half-width %f) is %s", (k, N, _relative, level) => {
    expect(incidenceConfidence(k, N)).toBe(level);
    const f = wilsonFraction(k, N)!;
    expect(Math.abs(Number(f.upper.minus(f.lower).div(2).div(new Decimal(k).div(N)).toString()) - _relative)).toBeLessThan(1e-9);
  });

  describe("fields no golden asserted", () => {
    const base2 = input(shipment([pkg("3")]), [lbCorr("5")]);

    it("service, zone, rate card version and engine versions", () => {
      const r = run(base2, ctxOf("reweight_flat"));
      expect(r.service).toEqual({ serviceId: "svc-ups-ground", serviceCode: "ground", serviceName: "UPS Ground", carrierCode: "ups" });
      expect(r.zone).toBe("5");
      expect(r.rateCardVersionId).toBe("fixture-card-v1");
      expect(r.pricingEngineVersion).toBe(PRICING_ENGINE_VERSION);
      expect(r.engineVersion).toMatch(/^adjustments-\d+\.\d+\.\d+$/);
      expect(r.message).toBeNull();
    });

    it("the engine's own words for an unavailable side, with the side named", () => {
      // 151 lb in a 20x20x20 box bills 151 lb (DIM 57.55 is lower) and the zone 5 card ends at 150 lb
      const words = "Billable weight 151.0 lb exceeds the heaviest bracket on the rate card for zone 5 (150.0 lb). Rates are not extrapolated. (package 1: billable 151.0 lb)";
      const corrected = run(input(shipment([pkg("140", ["20", "20", "20"])]), [lbCorr("151")]), ctxOf("reweight_flat"));
      expect(corrected.status).toBe("corrected_unavailable");
      expect(corrected.message).toBe(`Corrected shipment: ${words}`);
      expect(corrected.sides!.corrected).toMatchObject({ status: "unavailable", unavailableReason: "no_rate_for_weight", message: words });
      expect(corrected.sides!.declared).toMatchObject({ status: "ok", message: null });
      const declared = run(input(shipment([pkg("151", ["20", "20", "20"])]), [lbCorr("140")]), ctxOf("reweight_flat"));
      expect(declared.message).toBe(`Declared shipment: ${words}`);
      const both = run(input(shipment([pkg("151", ["20", "20", "20"])]), [lbCorr("160")]), ctxOf("reweight_flat"));
      expect(both.status).toBe("both_unavailable");
      expect(both.message).toBe(`Declared shipment: ${words} Corrected shipment: Billable weight 160.0 lb exceeds the heaviest bracket on the rate card for zone 5 (150.0 lb). Rates are not extrapolated. (package 1: billable 160.0 lb)`);
    });

    it("every fee line carries its rule's method and label (flat, percent)", () => {
      for (const [ctxName, key] of [["reweight_flat", "fixture.adj.reweight_flat"], ["reweight_pct", "fixture.adj.reweight_pct"]] as const) {
        const rule = rules.rules.find((x) => x.key === key)!;
        const line = run(base2, ctxOf(ctxName)).components!.separate_fee.lines[0]!;
        expect(line).toMatchObject({ ruleKey: key, label: rule.name, method: rule.method });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// F9: input-shape guards
// ---------------------------------------------------------------------------
describe("F9: hostile input is refused, never thrown", () => {
  it("a scenario with no input, or something that is not an object, is invalid_input", () => {
    for (const bad of [null, undefined, [], "x", 7]) {
      const r = evaluateAdjustmentScenario(bad as never, ctxOf("reweight_flat"), allPt);
      expect(r.status).toBe("invalid_input");
      expect(r.message).toMatch(/shipment/);
      expect(r.components).toBeNull();
    }
    expect(evaluateAdjustmentScenario(input(shipment([pkg("3")]), [lbCorr("5")]), ctxOf("reweight_flat"), allPt, null as never).status).toBe("ok");
  });

  it("a forecast with no inputs is refused (inputs_invalid)", () => {
    for (const bad of [null, undefined, [], "x", 7]) expect(forecastAdjustmentRisk(bad as never)).toMatchObject({ status: "refused", code: "inputs_invalid" });
  });

  describe("history", () => {
    it("missing filters, records or baselines are named refusals", () => {
      expect(summariseHistory([], [], null as never)).toMatchObject({ status: "refused", code: "invalid_filters" });
      expect(summariseHistory([], [], undefined as never)).toMatchObject({ status: "refused", code: "invalid_filters" });
      expect(summariseHistory(null as never, [], { brandId: null })).toMatchObject({ status: "refused", code: "invalid_records" });
      expect(summariseHistory([], null as never, { brandId: null })).toMatchObject({ status: "refused", code: "invalid_baselines" });
    });

    it("a maturity check without a valid today is refused (an immature window must never look mature); with one it is answered", () => {
      for (const today of [undefined, null, "", "yesterday", "2026-1-5", "2026-02-30", "20261016"]) {
        expect(refusal([rec("a")], [base()], { brandId: "b1", maturityDays: 30, today }), String(today)).toMatchObject({ code: "invalid_filters" });
      }
      expect(stats([rec("a")], [base()], { maturityDays: 30, today: "2026-02-10" }).maturity).toMatchObject({ windowEnd: "2026-01-31", daysSinceWindowEnd: 10, maturityDays: 30, immature: true });
      // no maturityDays: today may be anything, nothing is checked
      expect(stats([rec("a")], [base()], { today: "whatever" }).maturity).toBeNull();
    });

    it.each([NaN, Infinity, -5, 1.5, "30"])("maturityDays %s is refused (it used to give immature: false)", (days) => {
      expect(refusal([rec("a")], [base()], { brandId: "b1", maturityDays: days, today: "2026-10-16" })).toMatchObject({ code: "invalid_filters" });
    });

    it("an explicit EMPTY baselineIds list means no baselines (no incidence); null or absent lets the scope choose", () => {
      const empty = stats([rec("a")], [base()], { baselineIds: [] });
      expect(empty.baseline).toMatchObject({ present: false, ids: [], packagesTotal: null });
      expect(empty.incidence).toBeNull();
      expect(empty.incidenceReason).toBe("no_baseline");
      expect(stats([rec("a")], [base()], { baselineIds: null }).incidence).toMatchObject({ k: 1, N: 100 });
      expect(stats([rec("a")], [base()], {}).incidence).toMatchObject({ k: 1, N: 100 });
    });

    it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2])("a selected baseline with %s packages shipped is refused instead of producing NaN percent", (n) => {
      expect(refusal([], [base({ packagesTotal: n })])).toMatchObject({ code: "invalid_baselines", ids: ["bl"] });
    });

    it("a selected baseline with a bad period or impossible labels is refused; a bad baseline of ANOTHER scope does not block", () => {
      expect(refusal([], [base({ periodStart: "2026-02-01", periodEnd: "2026-01-01" })])).toMatchObject({ code: "invalid_baselines" });
      expect(refusal([], [base({ periodStart: "2026-1-1" })])).toMatchObject({ code: "invalid_baselines" });
      expect(refusal([], [base({ labelsMissingWeight: 101 })])).toMatchObject({ code: "invalid_baselines" });
      expect(refusal([], [base({ labelsMissingWeight: -1 })])).toMatchObject({ code: "invalid_baselines" });
      expect(stats([rec("a")], [base(), base({ id: "other", brandId: "b2", packagesTotal: 0 })]).incidence).toMatchObject({ k: 1, N: 100 });
    });

    it.each([
      ["1e3"], ["abc"], [""], ["1,000.00"], [" 5"], ["0x10"], ["5."],
    ])("a record with the amount %j is a named refusal, not a RangeError", (amount) => {
      expect(refusal([rec("a", { postageDifference: amount })], [base()])).toMatchObject({ code: "invalid_records" });
      expect(refusal([rec("a", { separateFee: amount })], [base()])).toMatchObject({ code: "invalid_records" });
    });

    it("a record whose ship date is not a date, or an amount that is a number, is refused; null amounts stay unknown", () => {
      expect(refusal([rec("a", { shipDate: "2026-02-30" })], [base()])).toMatchObject({ code: "invalid_records" });
      expect(refusal([rec("a", { shipDate: "10/01/2026" })], [base()])).toMatchObject({ code: "invalid_records" });
      expect(refusal([rec("a", { postageDifference: 5 as never })], [base()])).toMatchObject({ code: "invalid_records" });
      const unknown = stats([rec("a", { postageDifference: null, separateFee: null, originalCharge: null, correctedCharge: null })], [base()]);
      expect(unknown.incidenceByDirection?.unknown.k).toBe(1);
    });

    it("a window of garbage dates, or one missing an end, is refused", () => {
      expect(refusal([], [base()], { brandId: "b1", window: { from: "abc", to: "xyz" } })).toMatchObject({ code: "invalid_filters" });
      expect(refusal([], [base()], { brandId: "b1", window: { from: "2026-01-01" } })).toMatchObject({ code: "invalid_filters" });
      expect(refusal([], [base()], { brandId: "b1", baselineIds: "bl" })).toMatchObject({ code: "invalid_filters" });
    });
  });
});

// ---------------------------------------------------------------------------
// F10: a stored example never rounds a weight or a dimension
// ---------------------------------------------------------------------------
describe("F10: the stored example prices to the published amount", () => {
  it("storableWeight: ounces are exact at 6 decimals of a pound up to 2 decimals; pounds up to 6; anything else is not storable", () => {
    expect(STORED_DECIMALS).toBe(6);
    expect(storableWeight("16.01", "oz")).toBe(true); // 1.000625 lb
    expect(storableWeight("16.000001", "oz")).toBe(false); // 1.0000000625 lb
    expect(storableWeight("0.001", "oz")).toBe(false); // 0.0000625 lb
    expect(storableWeight("1.000001", "lb")).toBe(true);
    expect(storableWeight("1.0000001", "lb")).toBe(false);
    expect(storableWeight("1.5")).toBe(true); // the unit defaults to lb
    for (const bad of ["abc", "", "1e3", 5, null, undefined]) expect(storableWeight(bad as never, "lb")).toBe(false);
    expect(storableDimension("10.123456")).toBe(true);
    expect(storableDimension("10.1234567")).toBe(false);
    expect(storableDimension("x")).toBe(false);
  });

  it("the reviewer's case: 16.000001 oz declared (billable 2 lb, 11.65) is refused, not stored as 1.0 lb (billable 1 lb, 11.09)", () => {
    const i = input(shipment([pkg("16.000001", null, "oz")]), [lbCorr("20")]);
    const r = run(i, ctxOf("reweight_flat"));
    expect(r.status).toBe("ok");
    expect(r.sides!.declared.packages[0]!.billableLb).toBe("2.0");
    const stored = scenarioStorageInput(i, r);
    expect(stored).toMatchObject({ ok: false, reason: "weight_precision" });
    expect(stored.ok === false && stored.message).toMatch(/fewer decimals/);
  });

  it("a corrected weight, or a dimension with 7 decimals, is refused too; a weight that fits is stored exactly", () => {
    const tooFine = input(shipment([pkg("3")]), [lbCorr("5.0000001")]);
    expect(scenarioStorageInput(tooFine, run(tooFine, ctxOf("reweight_flat")))).toMatchObject({ ok: false, reason: "weight_precision" });
    const fineDim = input(shipment([pkg("3", ["10.1234567", "8", "6"])]), [lbCorr("5")]);
    expect(scenarioStorageInput(fineDim, run(fineDim, ctxOf("reweight_flat")))).toMatchObject({ ok: false, reason: "dimension_precision" });
    const exact = input(shipment([pkg("16.01", ["10.123456", "8", "6"], "oz")]), [lbCorr("20")]);
    const stored = scenarioStorageInput(exact, run(exact, ctxOf("reweight_flat")));
    expect(stored.ok && stored.value.declared.packages[0]).toEqual({ weightLb: "1.000625", lengthIn: "10.123456", widthIn: "8.0", heightIn: "6.0" });
  });

  it("property: the stored packages price to the declared and corrected totals of the example, to the cent (customer calculator parity, 250 draws)", () => {
    const ctx = ctxOf("none");
    let stored = 0;
    for (let seed = 1; seed <= 250; seed++) {
      const r = rng(seed * 47);
      const n = int(r, 1, 3);
      const unit = r() < 0.5 ? "oz" : "lb";
      const s = shipment(Array.from({ length: n }, () => pkg(unit === "oz" ? (int(r, 100, 3000) / 100).toFixed(2) : (int(r, 5, 900) / 10).toFixed(r() < 0.3 ? 6 : 1), [String(int(r, 4, 30)), String(int(r, 4, 24)), String(int(r, 2, 16))], unit)));
      const corrections = s.packages.map((p) => (r() < 0.7 ? { weight: (Number(p.weight) + int(r, 1, 400) / 100).toFixed(2), weightUnit: unit as "lb" | "oz" } : {}));
      if (corrections.every((c) => Object.keys(c).length === 0)) corrections[0] = { weight: (Number(s.packages[0]!.weight) + 3).toFixed(2), weightUnit: unit };
      const i = input(s, corrections);
      const res = run(i, ctx);
      const doc = scenarioStorageInput(i, res);
      if (!doc.ok) continue;
      stored++;
      const price = (pkgs: { weightLb: string; lengthIn?: string; widthIn?: string; heightIn?: string }[]) =>
        calculateShipment({ ...s, packages: pkgs.map((p) => ({ weight: p.weightLb, weightUnit: "lb" as const, length: p.lengthIn, width: p.widthIn, height: p.heightIn })) }, ctx).totals.expected.amount;
      expect(price(doc.value.declared.packages), `seed ${seed} declared`).toBe(res.components!.postage_difference.declaredTotal);
      expect(price(doc.value.corrected.packages), `seed ${seed} corrected`).toBe(res.components!.postage_difference.correctedTotal);
    }
    expect(stored).toBeGreaterThan(150);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// DB-1: what the stored result carries for handling (the SQL checks it against today's policy)
// ---------------------------------------------------------------------------
describe("DB-1: the stored result's handling is emitted consistently", () => {
  const { scenarios } = fixture<{ scenarios: { id: string; context: string; policy: string; input: AdjustmentScenarioInput }[] }>("scenarios.json");
  const HANDLINGS = ["absorbed", "pass_through", "manual_approval", "unconfigured"];

  it("for every priced golden: engineHandling is always present, 'mixed' only when the fee lines differ, handling is present exactly when it equals the type's policy row, lines carry their own handling", () => {
    let checked = 0;
    for (const s of scenarios) {
      const policy = policyFnFromProfile(policyProfiles[s.policy]);
      const result = run(s.input, ctxOf(s.context), policy);
      const doc = scenarioStorageResult(result);
      if (!doc.ok) continue;
      checked++;
      const [postage, fee] = doc.value.components;
      const type = result.adjustmentType!;
      expect(postage!.kind).toBe("postage_difference");
      expect(HANDLINGS, `${s.id} postage`).toContain(postage!.engineHandling);
      expect(postage!.engineHandling, s.id).not.toBe("mixed");
      expect(postage!.handling, s.id).toBe(policy(type, "postage_difference")); // the postage handling is always the type's row
      expect([...HANDLINGS, "mixed"], `${s.id} fee`).toContain(fee!.engineHandling);
      const lineHandlings = [...new Set((fee!.lines ?? []).map((l) => l.handling))];
      for (const h of lineHandlings) expect(HANDLINGS).toContain(h);
      if (lineHandlings.length > 1) expect(fee!.engineHandling, s.id).toBe("mixed");
      else if (lineHandlings.length === 1) expect(fee!.engineHandling, s.id).toBe(lineHandlings[0]);
      else expect(fee!.engineHandling, s.id).toBe(policy(type, "separate_fee"));
      if (fee!.engineHandling === policy(type, "separate_fee")) expect(fee!.handling, s.id).toBe(fee!.engineHandling);
      else expect(fee!.handling, s.id).toBeUndefined();
    }
    expect(checked).toBeGreaterThan(50);
  });
});
