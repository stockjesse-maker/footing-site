import { describe, expect, it } from "vitest";
import { evaluateAdjustmentScenario, forecastAdjustmentRisk, summariseHistory, type AdjustmentScenarioInput, type HistoryBaseline, type HistoryFilters, type HistoryRecord, type RiskInputs } from "@/engine/adjustments";
import { buildContext, fixture, int, pick, policyFnFromProfile, rng, type PolicyProfile, type RulesFile } from "./adjustments-engine-support";

/**
 * Hostile and sloppy input never throws and never produces a number out of nothing: every call ends in a typed
 * result (ok, a named refusal, or invalid_input), and the result is plain JSON. Seeded loops, no new dependency.
 */
const rules = fixture<RulesFile>("rules.json");
const { policyProfiles } = fixture<{ policyProfiles: Record<string, PolicyProfile> }>("scenarios.json");
const ctx = buildContext(rules.contexts.both_flat!, rules.rules);
const policy = policyFnFromProfile(policyProfiles.all_pt);

const junk = (r: () => number): unknown =>
  pick(r, [undefined, null, "", " ", "abc", "-1", "1e3", "0", "0.0", "7", "7.5", -1, 0, 1.5, 7, NaN, Infinity, [], {}, true, "9999999999999999999999"] as const);

describe("evaluateAdjustmentScenario on hostile input", () => {
  it("returns a typed status for 400 randomly broken scenarios and never throws", () => {
    const statuses = new Set(["ok", "no_adjustment", "declared_unavailable", "corrected_unavailable", "both_unavailable", "invalid_input"]);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed * 3);
      const pkg = () => ({ weight: junk(r) ?? "3", weightUnit: pick(r, ["lb", "oz", "kg", undefined] as const), length: r() < 0.5 ? junk(r) : "10", width: r() < 0.5 ? junk(r) : "8", height: r() < 0.5 ? junk(r) : "6" });
      const n = int(r, 0, 3);
      const input = {
        shipment: { shipDate: pick(r, ["2026-10-15", "2026-02-30", "", 5, undefined] as const), originZip: pick(r, ["90001", "abc", "", undefined] as const), destinationZip: pick(r, ["85001", "1", undefined] as const), residential: r() < 0.5, carrierCode: pick(r, ["ups", "nope"] as const), serviceCode: pick(r, ["ground", "nope"] as const), packages: Array.from({ length: n }, pkg) },
        corrections: Array.from({ length: pick(r, [n, n, n + 1, Math.max(0, n - 1)] as const) }, () => (r() < 0.2 ? {} : { weight: junk(r), weightUnit: pick(r, ["lb", "oz", undefined] as const), height: r() < 0.3 ? junk(r) : undefined })),
        declaredSource: pick(r, ["entered", "wms_fallback", "other"] as const),
      } as unknown as AdjustmentScenarioInput;
      const result = evaluateAdjustmentScenario(input, ctx, policy);
      expect(statuses.has(result.status), `seed ${seed}: ${result.status}`).toBe(true);
      seen.add(result.status);
      expect(JSON.parse(JSON.stringify(result)), `seed ${seed}`).toEqual(result);
      if (result.status !== "ok" && result.status !== "no_adjustment") {
        expect(result.components, `seed ${seed}`).toBeNull();
        expect(result.totalsE4, `seed ${seed}`).toBeNull();
      }
    }
    expect(seen.has("invalid_input")).toBe(true);
  });
});

describe("forecastAdjustmentRisk on hostile input", () => {
  it("returns ok or a named refusal for 600 randomly broken inputs, never throws, never invents a total", () => {
    let ok = 0;
    let refused = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed * 5);
      const sometimes = <T>(p: number, bad: () => unknown, good: () => T) => (r() < p ? bad() : good());
      const sev = () => ({ source: sometimes(0.05, () => "other", () => pick(r, ["entered", "history", "example"] as const)), e4: sometimes(0.15, () => junk(r), () => int(r, 0, 100_000)), n: sometimes(0.15, () => junk(r), () => int(r, 0, 50)) });
      const inputs = {
        monthlyVolume: sometimes(0.15, () => junk(r), () => String(int(r, 0, 5_000_000))),
        incidence: sometimes(
          0.08,
          () => junk(r),
          () => (r() < 0.5 ? { source: "history", k: sometimes(0.1, () => junk(r), () => int(r, 0, 50)), N: sometimes(0.1, () => junk(r), () => int(r, 40, 500)) } : { source: "entered", pct: sometimes(0.2, () => junk(r), () => String(int(r, 0, 100))) }),
        ),
        severity: { postage_difference: sev(), separate_fee: sev() },
        basis: sometimes(0.1, () => pick(r, [null, "x"] as const), () => pick(r, ["declared_weights", "actual_weights"] as const)),
        handling: { postage_difference: sometimes(0.05, () => pick(r, ["x", undefined] as const), () => pick(r, ["absorbed", "pass_through", "manual_approval", "unconfigured"] as const)), separate_fee: pick(r, ["absorbed", "pass_through", "manual_approval", "unconfigured"] as const) },
        credits: r() < 0.2 ? { k: sometimes(0.5, () => junk(r), () => int(r, 0, 5)), severityE4: sometimes(0.5, () => junk(r), () => -int(r, 0, 1000)) } : undefined,
      } as unknown as RiskInputs;
      const result = forecastAdjustmentRisk(inputs);
      expect(["ok", "refused"], `seed ${seed}`).toContain(result.status);
      expect(JSON.parse(JSON.stringify(result)), `seed ${seed}`).toEqual(result);
      if (result.status === "refused") {
        refused++;
        expect(result.code, `seed ${seed}`).toMatch(/^[a-z_0-9]+$/);
        expect(result.message.length, `seed ${seed}`).toBeGreaterThan(10);
        continue;
      }
      ok++;
      for (const v of [result.countedHereE4, result.perShipmentE4, result.per1000E4, result.annualE4, result.perAffectedE4]) if (v !== null) expect(Number.isSafeInteger(v) && v >= 0, `seed ${seed}: ${v}`).toBe(true);
    }
    expect(ok).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(100);
  });
});

describe("summariseHistory on sloppy structure", () => {
  it("returns ok or a named refusal for 300 random record, baseline and filter sets, and the denominator is always a sum of whole baselines", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 7);
      const records: HistoryRecord[] = Array.from({ length: int(r, 0, 30) }, (_, i) => ({
        id: `r${i}`, brandId: pick(r, ["a", "b", null] as const), carrierCode: pick(r, ["ups", "usps"] as const), serviceId: r() < 0.2 ? null : pick(r, ["s1", "s2"] as const),
        shipDate: `2026-0${int(r, 1, 3)}-${String(int(r, 1, 28)).padStart(2, "0")}`, adjustmentType: pick(r, ["reweight", "remeasure"] as const), cause: pick(r, ["carrier_reweigh", "wms_no_weight"] as const),
        packageRef: r() < 0.3 ? null : `p${int(r, 0, 12)}`, originalCharge: null, correctedCharge: null, separateFee: r() < 0.5 ? null : "1.00", postageDifference: r() < 0.3 ? null : (int(r, -500, 1500) / 100).toFixed(2),
      }));
      const baselines: HistoryBaseline[] = Array.from({ length: int(r, 0, 5) }, (_, i) => {
        const m = int(r, 1, 3);
        return { id: `bl${i}`, brandId: pick(r, ["a", "b", null] as const), carrierCode: r() < 0.7 ? null : "ups", serviceId: r() < 0.8 ? null : "s1", periodStart: `2026-0${m}-01`, periodEnd: `2026-0${m}-${pick(r, ["15", "28"] as const)}`, packagesTotal: int(r, 1, 200), labelsMissingWeight: r() < 0.5 ? null : int(r, 0, 1) };
      });
      const filters: HistoryFilters = {
        brandId: pick(r, ["a", "b", null] as const), carrierCode: r() < 0.3 ? "ups" : null, serviceId: r() < 0.2 ? "s1" : null, adjustmentType: r() < 0.3 ? "reweight" : null, cause: r() < 0.2 ? "wms_no_weight" : null,
        window: r() < 0.4 ? { from: "2026-01-01", to: pick(r, ["2026-01-31", "2026-02-28", "2026-03-31", "2025-12-31"] as const) } : null, baselineIds: r() < 0.15 ? [pick(r, ["bl0", "bl1", "zz"] as const)] : null,
        maturityDays: r() < 0.3 ? int(r, 0, 60) : null, today: r() < 0.3 ? "2026-04-10" : null,
      };
      const result = summariseHistory(records, baselines, filters);
      expect(["ok", "refused"], `seed ${seed}`).toContain(result.status);
      expect(JSON.parse(JSON.stringify(result)), `seed ${seed}`).toEqual(result);
      if (result.status !== "ok") continue;
      if (result.baseline.present) {
        const total = baselines.filter((b) => result.baseline.ids.includes(b.id)).reduce((s, b) => s + b.packagesTotal, 0);
        expect(result.baseline.packagesTotal, `seed ${seed}`).toBe(total);
        expect(result.incidence!.k, `seed ${seed}`).toBeLessThanOrEqual(result.incidence!.N);
        expect(result.incidence!.N).toBe(total);
      } else {
        expect(result.incidence).toBeNull();
        expect(result.incidenceByDirection).toBeNull();
        expect(result.baseline.packagesTotal).toBeNull();
      }
      expect(result.affected).toBeLessThanOrEqual(result.recordsInScope);
      expect(result.recordsInScope + result.excludedOutsideBaseline).toBeLessThanOrEqual(records.length);
    }
  });
});
