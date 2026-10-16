import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import * as engine from "@/engine/adjustments";
import {
  evaluateAdjustmentScenario, forecastAdjustmentRisk, riskStorageResult, scenarioStorageInput, scenarioStorageResult, summariseHistory,
  type AdjustmentScenarioInput, type Handling, type HistoryBaseline, type HistoryFilters, type HistoryRecord, type RiskForecast, type RiskInputs,
} from "@/engine/adjustments";
import { calculateShipment } from "@/engine";
import type { ShipmentInput } from "@/engine/types";
import { buildContext, fixture, int, pick, policyFnFromProfile, rng, type PolicyProfile, type RulesFile } from "./adjustments-engine-support";

/**
 * Property tests (design v2 section 9): seeded loops, no new dependency. Every failure reproduces from its seed.
 * The risk properties are checked against an INDEPENDENT oracle written in BigInt rational arithmetic, so "exact
 * arithmetic" is verified rather than assumed.
 */
/** Test-side decimals: 80 digits, so no assertion is weakened by the default 20-digit precision of decimal.js. */
const HP = Decimal.clone({ precision: 80 });
const HANDLING: readonly Handling[] = ["absorbed", "pass_through", "manual_approval", "unconfigured"];
const rules = fixture<RulesFile>("rules.json");
const { policyProfiles, historyCases } = fixture<{ policyProfiles: Record<string, PolicyProfile>; historyCases: { records: string; baselines: string; filters: HistoryFilters }[] }>("scenarios.json");
const recordSets = fixture<{ recordSets: Record<string, HistoryRecord[]> }>("history-records.json").recordSets;
const baselineSets = fixture<{ baselineSets: Record<string, HistoryBaseline[]> }>("history-baselines.json").baselineSets;

// ---------------------------------------------------------------------------
// Risk forecast: random inputs and an independent BigInt oracle
// ---------------------------------------------------------------------------
/** N values for which V x k / N terminates, so the engine's decimal result is exactly the rational result. */
const TERMINATING_N = [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 625, 800, 1000, 2000, 2500, 4000, 5000, 10_000];

interface Drawn {
  inputs: RiskInputs;
  /** Volume in hundredths (V = vCents / 100). */
  vCents: bigint;
  /** Incidence as a rational p = pNum / pDen (history: k / N; entered: P / 100000 for a percent with three decimals). */
  pNum: bigint;
  pDen: bigint;
}

function draw(r: () => number, opts: { terminating?: boolean } = {}): Drawn {
  const vCents = BigInt(r() < 0.15 ? int(r, 0, 5000) : r() < 0.5 ? int(r, 0, 5_000_000) * 100 : int(r, 0, 500_000_000));
  const monthlyVolume = `${vCents / 100n}.${(vCents % 100n).toString().padStart(2, "0")}`;
  let incidence: RiskInputs["incidence"];
  let pNum: bigint;
  let pDen: bigint;
  if (r() < 0.55) {
    const N = opts.terminating === false ? int(r, 1, 100_000) : pick(r, TERMINATING_N);
    const k = r() < 0.15 ? 0 : r() < 0.1 ? N : int(r, 0, N);
    incidence = { source: "history", k, N };
    pNum = BigInt(k);
    pDen = BigInt(N);
  } else {
    const thousandths = r() < 0.1 ? 0 : r() < 0.05 ? 100_000 : int(r, 0, 100_000); // percent in thousandths of a percent
    incidence = { source: "entered", pct: `${Math.floor(thousandths / 1000)}.${String(thousandths % 1000).padStart(3, "0")}` };
    pNum = BigInt(thousandths);
    pDen = 100_000n;
  }
  const sev = (): RiskInputs["severity"]["postage_difference"] => ({ source: pick(r, ["entered", "history", "example"] as const), e4: r() < 0.2 ? null : int(r, 0, 2_000_000), n: int(r, 0, 60) });
  const inputs: RiskInputs = {
    monthlyVolume,
    incidence,
    severity: { postage_difference: sev(), separate_fee: sev() },
    basis: pick(r, ["declared_weights", "actual_weights"] as const),
    handling: { postage_difference: pick(r, HANDLING), separate_fee: pick(r, HANDLING) },
  };
  return { inputs, vCents, pNum, pDen };
}

/** floor((2a + b) / 2b): round half up for a non-negative rational a / b. */
const roundHalfUp = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

function oracle(d: Drawn) {
  // affected = V x p = vCents x pNum / (100 x pDen); component c = affected x s_c.
  const den = 100n * d.pDen;
  const countedHere = (c: "postage_difference" | "separate_fee") => c === "separate_fee" || d.inputs.basis === "declared_weights";
  const comps = (["postage_difference", "separate_fee"] as const).map((c) => {
    const s = d.inputs.severity[c].e4;
    const zero = d.vCents === 0n || d.pNum === 0n;
    const num = s === null ? null : d.vCents * d.pNum * BigInt(s);
    return { c, s, zero, num, amount: zero ? 0n : num === null ? null : roundHalfUp(num, den) };
  });
  const here = comps.filter((x) => countedHere(x.c) && x.amount !== null);
  const sumNum = here.reduce((acc, x) => acc + (x.zero ? 0n : x.num!), 0n);
  return {
    comps,
    here,
    counted: here.length ? here.reduce((acc, x) => acc + x.amount!, 0n) : null,
    perShipment: here.length && d.vCents !== 0n ? roundHalfUp(sumNum * 100n, den * d.vCents) : null,
    per1000: here.length && d.vCents !== 0n ? roundHalfUp(sumNum * 100_000n, den * d.vCents) : null,
    annual: here.length ? roundHalfUp(sumNum * 12n, den) : null,
  };
}

const okForecast = (i: RiskInputs): RiskForecast => {
  const f = forecastAdjustmentRisk(i);
  if (f.status !== "ok") throw new Error(`refused ${f.code}`);
  return f;
};

describe("risk forecast: exact arithmetic against an independent oracle", () => {
  it.each([
    ["a terminating history incidence or an entered percentage", true],
    ["an arbitrary history incidence (V x k / N does not terminate)", false],
  ])("matches BigInt rational arithmetic for every amount, total, per-shipment, per-1,000 and annual figure: %s (600 draws)", (_label, terminating) => {
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed);
      const d = draw(r, { terminating });
      if (d.inputs.incidence.source === "history" && d.inputs.incidence.N === 0) continue;
      const got = okForecast(d.inputs);
      const want = oracle(d);
      for (const x of want.comps) {
        const comp = got.components[x.c];
        const here = x.c === "separate_fee" || d.inputs.basis === "declared_weights";
        if (x.amount === null) {
          expect(comp.state, `seed ${seed} ${x.c}`).toBe("not_computed");
          expect(comp.amountE4).toBeNull();
        } else {
          expect(comp.state, `seed ${seed} ${x.c}`).toBe(here ? "computed" : "in_forecast");
          expect(BigInt(comp.amountE4!), `seed ${seed} ${x.c} amount`).toBe(x.amount);
        }
      }
      expect(got.countedHereE4 === null ? null : BigInt(got.countedHereE4), `seed ${seed} total`).toBe(want.counted);
      expect(got.perShipmentE4 === null ? null : BigInt(got.perShipmentE4), `seed ${seed} per shipment`).toBe(want.perShipment);
      expect(got.per1000E4 === null ? null : BigInt(got.per1000E4), `seed ${seed} per 1000`).toBe(want.per1000);
      expect(got.annualE4 === null ? null : BigInt(got.annualE4), `seed ${seed} annual`).toBe(want.annual);
    }
  });

  it("component identity: the four buckets add up to the counted total in E4, which is the sum of the counted-here components (600 draws)", () => {
    for (let seed = 1000; seed < 1600; seed++) {
      const d = draw(rng(seed), { terminating: false });
      if (d.inputs.incidence.source === "history" && d.inputs.incidence.N === 0) continue;
      const f = okForecast(d.inputs);
      const counted = (["postage_difference", "separate_fee"] as const).filter((c) => c === "separate_fee" || f.basis === "declared_weights").filter((c) => f.components[c].state === "computed");
      if (counted.length === 0) {
        expect(f.buckets, `seed ${seed}`).toBeNull();
        expect(f.countedHereE4).toBeNull();
        continue;
      }
      const sum = counted.reduce((s, c) => s + f.components[c].amountE4!, 0);
      expect(f.countedHereE4, `seed ${seed}`).toBe(sum);
      const b = f.buckets!;
      expect(b.customerPays + b.decidedCaseByCase + b.notBilledToCustomer + b.notDecided, `seed ${seed}`).toBe(sum);
      expect(f.soFar).toBe(b.notDecided > 0);
      expect(f.decidedCaseByCaseRangeE4).toEqual({ lowE4: 0, highE4: b.decidedCaseByCase });
    }
  });

  it("exposure total = affected x per-affected, exactly, when the incidence terminates (600 draws)", () => {
    for (let seed = 2000; seed < 2600; seed++) {
      const d = draw(rng(seed));
      if (d.inputs.incidence.source === "history" && d.inputs.incidence.N === 0) continue;
      const f = okForecast(d.inputs);
      if (f.exactCountedHereE4 === null) continue;
      const gap = f.perAffectedE4 === null ? new HP(0) : new HP(f.affected!.exact).times(f.perAffectedE4).minus(f.exactCountedHereE4).abs();
      expect(gap.isZero(), `seed ${seed}: gap ${gap.toString()}`).toBe(true);
    }
  });

  it("scale invariance: x m on the volume scales every exact amount by m and leaves the per-shipment and per-1,000 figures alone (400 draws)", () => {
    for (let seed = 3000; seed < 3400; seed++) {
      const r = rng(seed);
      const d = draw(r);
      const m = pick(r, [2, 3, 10] as const);
      if (d.vCents === 0n || d.vCents * BigInt(m) > 500_000_000n) continue;
      if (d.inputs.incidence.source === "history" && d.inputs.incidence.N === 0) continue;
      const a = okForecast(d.inputs);
      const scaled = okForecast({ ...d.inputs, monthlyVolume: new HP(d.inputs.monthlyVolume).times(m).toFixed(2) });
      if (a.exactCountedHereE4 === null) {
        expect(scaled.exactCountedHereE4).toBeNull();
        continue;
      }
      expect(new HP(scaled.exactCountedHereE4!).eq(new HP(a.exactCountedHereE4).times(m)), `seed ${seed}`).toBe(true);
      expect(new HP(scaled.affected!.exact).eq(new HP(a.affected!.exact).times(m))).toBe(true);
      expect(scaled.perShipmentE4, `seed ${seed}`).toBe(a.perShipmentE4);
      expect(scaled.per1000E4, `seed ${seed}`).toBe(a.per1000E4);
    }
  });

  it("scale invariance in severity: x m on both severities scales the exact total and the annual figure by m (300 draws)", () => {
    for (let seed = 3500; seed < 3800; seed++) {
      const r = rng(seed);
      const d = draw(r);
      const m = pick(r, [2, 5] as const);
      if (d.inputs.incidence.source === "history" && d.inputs.incidence.N === 0) continue;
      const times = (s: RiskInputs["severity"]["postage_difference"]) => ({ ...s, e4: s.e4 === null ? null : s.e4 * m });
      const a = okForecast(d.inputs);
      const b = okForecast({ ...d.inputs, severity: { postage_difference: times(d.inputs.severity.postage_difference), separate_fee: times(d.inputs.severity.separate_fee) } });
      if (a.exactCountedHereE4 === null) continue;
      expect(new HP(b.exactCountedHereE4!).eq(new HP(a.exactCountedHereE4).times(m)), `seed ${seed}`).toBe(true);
    }
  });

  it("flipping the basis never changes what is not billed to the customer once the in-forecast memo is added (design amendment A1), nor the fee components (500 draws)", () => {
    for (let seed = 4000; seed < 4500; seed++) {
      const d = draw(rng(seed), { terminating: false });
      if (d.inputs.incidence.source === "history" && d.inputs.incidence.N === 0) continue;
      const decl = okForecast({ ...d.inputs, basis: "declared_weights" });
      const act = okForecast({ ...d.inputs, basis: "actual_weights" });
      const bd = decl.buckets;
      const ba = act.buckets;
      const pdComputed = decl.components.postage_difference.state === "computed";
      // Only meaningful when postage was computed (a null postage severity is not_computed in both bases).
      expect(decl.components.separate_fee, `seed ${seed}`).toEqual(act.components.separate_fee);
      if (!pdComputed) continue;
      const notBilledDecl = (bd?.notBilledToCustomer ?? 0) + decl.inForecastMemoE4!.inForecastNotBilledE4;
      const notBilledAct = (ba?.notBilledToCustomer ?? 0) + act.inForecastMemoE4!.inForecastNotBilledE4;
      expect(notBilledAct, `seed ${seed} not billed`).toBe(notBilledDecl);
      const caseDecl = (bd?.decidedCaseByCase ?? 0) + decl.inForecastMemoE4!.inForecastDecidedCaseByCaseE4;
      const caseAct = (ba?.decidedCaseByCase ?? 0) + act.inForecastMemoE4!.inForecastDecidedCaseByCaseE4;
      expect(caseAct, `seed ${seed} case by case`).toBe(caseDecl);
    }
  });

  it("a history range brackets the expected exposure (the exact sum, within the half-E4 of the range's own rounding) and plain low <= expected <= high when well above rounding (800 draws)", () => {
    let plain = 0;
    for (let seed = 5000; seed < 5800; seed++) {
      const d = draw(rng(seed), { terminating: false });
      if (d.inputs.incidence.source !== "history" || d.inputs.incidence.N === 0) continue;
      const f = okForecast(d.inputs);
      if (!f.range) continue;
      // lowE4 is null only when no counted-here severity is known AND the lower bound is not exactly 0; k = 0 always gives 0 (the exact Wilson edge)
      if (d.inputs.incidence.k === 0) expect(f.range.lowE4, `seed ${seed} k = 0`).toBe(0);
      if (f.range.lowE4 === null) {
        expect(f.range.highE4, `seed ${seed}`).toBeNull();
        expect(d.inputs.incidence.k, `seed ${seed}`).toBeGreaterThan(0);
        expect(f.perAffectedE4, `seed ${seed}`).toBeNull();
        continue;
      }
      if (f.range.highE4 === null || f.exactCountedHereE4 === null) continue;
      const exact = new HP(f.exactCountedHereE4);
      expect(new HP(f.range.lowE4).minus(0.5).lessThanOrEqualTo(exact), `seed ${seed} low`).toBe(true);
      expect(new HP(f.range.highE4).plus(0.5).greaterThanOrEqualTo(exact), `seed ${seed} high`).toBe(true);
      expect(f.range.lowE4).toBeLessThanOrEqual(f.range.highE4);
      const p = d.inputs.incidence.k / d.inputs.incidence.N;
      if (f.countedHereE4! >= 10_000 && p > 0 && p <= 0.9) {
        plain++;
        expect(f.range.lowE4, `seed ${seed} plain low`).toBeLessThanOrEqual(f.countedHereE4!);
        expect(f.countedHereE4!, `seed ${seed} plain high`).toBeLessThanOrEqual(f.range.highE4);
      }
    }
    expect(plain).toBeGreaterThan(50);
  });

  it("credits never enter exposure: adding a credits memo changes only the memo fields (200 draws)", () => {
    for (let seed = 6000; seed < 6200; seed++) {
      const r = rng(seed);
      const d = draw(r);
      if (d.inputs.incidence.source !== "history" || d.inputs.incidence.N < 2) continue;
      const room = d.inputs.incidence.N - d.inputs.incidence.k;
      const credits = { k: int(r, 0, Math.min(room, 50)), severityE4: -int(r, 0, 200_000) };
      const without = okForecast(d.inputs);
      const withCredits = okForecast({ ...d.inputs, credits });
      expect({ ...withCredits, creditsMemoE4: null, netMemoE4: null }).toEqual(without);
      expect(withCredits.creditsMemoE4 === null || withCredits.creditsMemoE4 <= 0).toBe(true);
    }
  });

  it("never turns an unknown into a zero: a null severity with a non-zero multiplier is never a computed amount (300 draws)", () => {
    for (let seed = 7000; seed < 7300; seed++) {
      const d = draw(rng(seed));
      if (d.inputs.incidence.source === "history" && d.inputs.incidence.N === 0) continue;
      const f = okForecast(d.inputs);
      const multiplierZero = d.vCents === 0n || d.pNum === 0n;
      for (const c of ["postage_difference", "separate_fee"] as const) {
        if (d.inputs.severity[c].e4 === null && !multiplierZero) {
          expect(f.components[c].state, `seed ${seed} ${c}`).toBe("not_computed");
          expect(f.components[c].amountE4).toBeNull();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// History statistics
// ---------------------------------------------------------------------------
function shuffled<T>(items: readonly T[], r: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("history statistics: order invariance", () => {
  it("record order and baseline order never change a statistic, over all 37 golden cases x 5 shuffles", () => {
    for (const c of historyCases) {
      const records = recordSets[c.records]!;
      const baselines = baselineSets[c.baselines]!;
      const reference = JSON.stringify(summariseHistory(records, baselines, c.filters));
      for (let seed = 1; seed <= 5; seed++) {
        const r = rng(seed * 101);
        expect(JSON.stringify(summariseHistory(shuffled(records, r), shuffled(baselines, r), c.filters)), `${c.records}/${c.baselines} seed ${seed}`).toBe(reference);
      }
    }
  });

  it("holds on random synthetic histories too (150 draws)", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 7919);
      const n = int(r, 0, 60);
      const records: HistoryRecord[] = Array.from({ length: n }, (_, i) => {
        const original = r() < 0.2 ? null : (int(r, 500, 5000) / 100).toFixed(2);
        const diff = original === null ? null : ((int(r, -300, 1500) / 100)).toFixed(2);
        return {
          id: `r${i}`, brandId: pick(r, ["b1", "b2", null] as const), carrierCode: pick(r, ["ups", "usps"] as const), serviceId: r() < 0.1 ? null : pick(r, ["s1", "s2"] as const),
          shipDate: `2026-01-${String(int(r, 1, 31)).padStart(2, "0")}`, adjustmentType: pick(r, ["reweight", "remeasure"] as const), cause: pick(r, ["carrier_reweigh", "wms_no_weight", "other"] as const),
          packageRef: r() < 0.2 ? null : `ref${int(r, 0, 25)}`, originalCharge: original, correctedCharge: original === null ? null : new HP(original).plus(diff!).toFixed(2),
          separateFee: r() < 0.3 ? null : (int(r, 0, 500) / 100).toFixed(2), postageDifference: diff,
        };
      });
      const baselines: HistoryBaseline[] = [{ id: "bl", brandId: pick(r, ["b1", null] as const), carrierCode: null, serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 500, labelsMissingWeight: r() < 0.5 ? null : int(r, 0, 50) }];
      const filters: HistoryFilters = { brandId: baselines[0]!.brandId, adjustmentType: r() < 0.3 ? "reweight" : null, cause: r() < 0.2 ? "carrier_reweigh" : null };
      const reference = JSON.stringify(summariseHistory(records, baselines, filters));
      expect(JSON.stringify(summariseHistory(shuffled(records, r), shuffled(baselines, r), filters)), `seed ${seed}`).toBe(reference);
    }
  });

  it("affected never exceeds the records in scope, and the four direction groups account for every affected package of an exclusive set (150 draws)", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 31);
      const records: HistoryRecord[] = Array.from({ length: int(r, 0, 40) }, (_, i) => {
        const diff = r() < 0.15 ? null : (int(r, -300, 1500) / 100).toFixed(2);
        return { id: `r${i}`, brandId: "b1", carrierCode: "ups", serviceId: "s1", shipDate: "2026-01-10", adjustmentType: "reweight", cause: "other", packageRef: `unique${i}`, originalCharge: null, correctedCharge: null, separateFee: null, postageDifference: diff };
      });
      const s = summariseHistory(records, [{ id: "bl", brandId: "b1", carrierCode: null, serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 1000, labelsMissingWeight: null }], { brandId: "b1" });
      if (s.status !== "ok") throw new Error("refused");
      expect(s.affected).toBeLessThanOrEqual(s.recordsInScope);
      const by = s.incidenceByDirection!;
      expect(by.increase.k + by.decrease.k + by.zero.k + by.unknown.k).toBe(s.affected); // unique references: no package in two groups
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario evaluation
// ---------------------------------------------------------------------------
/** Scenario properties price thousands of shipments; give them room when the whole suite runs in parallel. */
const SLOW = 60_000;
const PROFILES = Object.keys(rules.contexts);
/** Contexts are read-only to the engine (a test above checks it), so each profile is built once: the fixture loader reads files. */
const contexts = new Map<string, ReturnType<typeof buildContext>>();
const ctxOf = (name: string) => {
  let c = contexts.get(name);
  if (!c) {
    c = buildContext(rules.contexts[name]!, rules.rules);
    contexts.set(name, c);
  }
  return c;
};
const DATES = ["2026-10-15", "2026-09-15", "2026-12-01"] as const;
/** Contexts whose fee rule carries something that means nothing for a fee charged after shipping (a definite class, a suppression list, a floor, a shared group, a companion). */
const MISCONFIGURED = new Set(["reweight_definite", "reweight_excludes_residential", "reweight_pp_das_group", "reweight_pp_das_group_low", "reweight_with_companion", "reweight_pp_floor20", "reweight_pct_all_excl_residential"]);

function randomShipment(r: () => number, withDims: boolean): { shipment: ShipmentInput; dims: ([string, string, string] | null)[] } {
  const n = int(r, 1, 3);
  const dims: ([string, string, string] | null)[] = [];
  const packages = Array.from({ length: n }, () => {
    const d: [string, string, string] | null = withDims ? [String(int(r, 4, 40)), String(int(r, 4, 30)), String(int(r, 2, 24))] : null;
    dims.push(d);
    return { weight: (int(r, 5, 700) / 10).toFixed(1), weightUnit: "lb" as const, ...(d ? { length: d[0], width: d[1], height: d[2] } : {}) };
  });
  return { shipment: { shipDate: pick(r, DATES), originZip: "90001", destinationZip: "85001", residential: r() < 0.4, carrierCode: "ups", serviceCode: "ground", packages }, dims };
}

describe("scenario evaluation properties", () => {
  it("a heavier corrected weight at the same dimensions never lowers the difference on the fixture card (400 draws, none and reweight rules)", () => {
    let priced = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed * 13);
      const { shipment } = randomShipment(r, r() < 0.7);
      const corrections = shipment.packages.map((p) => (r() < 0.6 ? { weight: new HP(p.weight).plus(int(r, 1, 300) / 10).toFixed(1), weightUnit: "lb" as const } : {}));
      if (corrections.every((c) => Object.keys(c).length === 0)) corrections[0] = { weight: new HP(shipment.packages[0]!.weight).plus(1).toFixed(1), weightUnit: "lb" };
      const res = evaluateAdjustmentScenario({ shipment, corrections, declaredSource: "entered" }, ctxOf(pick(r, ["none", "reweight_flat"] as const)), policyFnFromProfile(policyProfiles.all_pt));
      if (res.status !== "ok" && res.status !== "no_adjustment") continue;
      priced++;
      expect(res.adjustmentType, `seed ${seed}`).toBe("reweight");
      expect(res.direction, `seed ${seed}`).not.toBe("decrease");
      expect(new HP(res.components!.postage_difference.amount).greaterThanOrEqualTo(0), `seed ${seed}: ${res.components!.postage_difference.amount}`).toBe(true);
    }
    expect(priced).toBeGreaterThan(250);
  }, SLOW);

  it("a conditional adjustment fee never exceeds the existing conditional upper bound for the same shipment, and is never added to it (400 draws)", () => {
    let shown = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed * 17);
      const profile = pick(r, PROFILES.filter((p) => !MISCONFIGURED.has(p))); // these contexts carry a fee rule that is misconfigured by definition (the engine warns and isolates it: see adjustments-engine-review.test.ts)
      const { shipment } = randomShipment(r, r() < 0.7);
      const corrections = shipment.packages.map((p) => (r() < 0.7 ? { weight: new HP(p.weight).plus(int(r, 1, 200) / 10).toFixed(1), weightUnit: "lb" as const } : {}));
      if (corrections.every((c) => Object.keys(c).length === 0)) corrections[0] = { weight: new HP(shipment.packages[0]!.weight).plus(2).toFixed(1), weightUnit: "lb" };
      const input: AdjustmentScenarioInput = { shipment, corrections, declaredSource: "entered" };
      const ctx = ctxOf(profile);
      const res = evaluateAdjustmentScenario(input, ctx, policyFnFromProfile(policyProfiles.all_pt));
      const fee = res.components?.separate_fee;
      if (!fee || fee.state !== "conditional") continue;
      shown++;
      const correctedShipment = { ...shipment, packages: engine.correctedPackages(input) };
      const existing = calculateShipment(correctedShipment, ctx);
      expect(existing.status).toBe("ok");
      expect(new HP(fee.amount!).lessThanOrEqualTo(existing.totals.conditionalExposure.amount), `seed ${seed} ${profile}: fee ${fee.amount} vs upper bound ${existing.totals.conditionalExposure.amount}`).toBe(true);
      // The fee never enters a counted total: the corrected counted total equals the shipment priced without it.
      expect(res.sides!.corrected.countedTotal).toBe(existing.totals.expected.amount);
    }
    expect(shown).toBeGreaterThan(100);
  }, SLOW);

  it("the buckets of one example add up to the shipping difference plus the listed fee lines, in E4, and are all zero unless it is an increase (500 draws)", () => {
    const profileNames = Object.keys(policyProfiles);
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed * 19);
      const { shipment } = randomShipment(r, r() < 0.6);
      const corrections = shipment.packages.map((p) => {
        const c: { weight?: string; weightUnit?: "lb"; length?: string } = {};
        if (r() < 0.6) {
          c.weight = Math.max(0.1, Number(p.weight) + (int(r, -200, 300) / 10)).toFixed(1);
          c.weightUnit = "lb";
        }
        if (p.length && r() < 0.4) c.length = String(int(r, 4, 45));
        return c;
      });
      const res = evaluateAdjustmentScenario({ shipment, corrections, declaredSource: "entered" }, ctxOf(pick(r, PROFILES)), policyFnFromProfile(policyProfiles[pick(r, profileNames)]));
      if (!res.components || !res.totalsE4) continue;
      const t = res.totalsE4;
      const total = t.customerPays + t.decidedCaseByCase + t.notBilledToCustomer + t.notDecided;
      if (res.direction !== "increase") {
        expect(total, `seed ${seed}`).toBe(0);
        continue;
      }
      const pd = new HP(res.components.postage_difference.amount).times(10_000).toNumber();
      const fee = res.components.separate_fee.lines.reduce((s, l) => s + new HP(l.amount).times(10_000).toNumber(), 0);
      expect(total, `seed ${seed}`).toBe(pd + fee);
    }
  }, SLOW);

  it("classification follows the input diff only: weight-only is reweight, dimensions-only is remeasure, both is combined (300 draws)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 23);
      const { shipment } = randomShipment(r, true);
      const i = int(r, 0, shipment.packages.length - 1);
      const w = r() < 0.5;
      const dd = r() < 0.5;
      if (!w && !dd) continue;
      const p = shipment.packages[i]!;
      const corrections = shipment.packages.map((_, j) => (j === i ? { ...(w ? { weight: new HP(p.weight).plus(7).toFixed(1), weightUnit: "lb" as const } : {}), ...(dd ? { height: String(Number(p.height) + 3) } : {}) } : {}));
      const res = evaluateAdjustmentScenario({ shipment, corrections, declaredSource: "entered" }, ctxOf("both_flat"), policyFnFromProfile(policyProfiles.all_pt));
      if (res.status === "invalid_input") continue;
      expect(res.adjustmentType, `seed ${seed}`).toBe(w && dd ? "combined" : w ? "reweight" : "remeasure");
    }
  }, SLOW);

  it("the same package corrected the same way gives the same answer however many unchanged packages ride along (the corrected package alone decides the fee)", () => {
    const base: ShipmentInput = { shipDate: "2026-10-15", originZip: "90001", destinationZip: "85001", residential: false, carrierCode: "ups", serviceCode: "ground", packages: [{ weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" }] };
    const one = evaluateAdjustmentScenario({ shipment: base, corrections: [{ weight: "5", weightUnit: "lb" }], declaredSource: "entered" }, ctxOf("reweight_pct"), policyFnFromProfile(policyProfiles.all_pt));
    for (const extra of [1, 2, 4]) {
      const shipment = { ...base, packages: [...base.packages, ...Array.from({ length: extra }, () => ({ weight: "8", weightUnit: "lb" as const, length: "12", width: "12", height: "12" }))] };
      const res = evaluateAdjustmentScenario({ shipment, corrections: [{ weight: "5", weightUnit: "lb" }, ...Array.from({ length: extra }, () => ({}))], declaredSource: "entered" }, ctxOf("reweight_pct"), policyFnFromProfile(policyProfiles.all_pt));
      expect(res.components!.separate_fee.amount).toBe(one.components!.separate_fee.amount);
      expect(res.components!.postage_difference.amount).toBe(one.components!.postage_difference.amount);
    }
  });
});

// ---------------------------------------------------------------------------
// Staff documents and the customer boundary
// ---------------------------------------------------------------------------
const SENTINEL = "SENTINEL_9f3a";

describe("what leaves the engine", () => {
  it("exports no customer projection or publishing helper: the published payload is built in SQL", () => {
    const names = Object.keys(engine);
    expect(names.filter((n) => /customer|publish|brandVisible|projection|toPayload/i.test(n))).toEqual([]);
  });

  it("planted sentinels in source references, override references, the rate card name and ZIP-list references never reach the stored scenario documents (deep walk, every golden input)", () => {
    const { scenarios } = fixture<{ scenarios: { id: string; context: string; policy: string; input: AdjustmentScenarioInput }[] }>("scenarios.json");
    const walk = (v: unknown, visit: (key: string, value: unknown) => void): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { visit(k, x); walk(x, visit); }
    };
    let stored = 0;
    for (const s of scenarios) {
      const clean = ctxOf(s.context);
      const ctx = {
        ...clean,
        rateCard: { ...clean.rateCard, rateCardName: `${SENTINEL}_card`, services: clean.rateCard.services.map((t) => ({ ...t, sourceReference: `${SENTINEL}_terms`, termsVersion: `${SENTINEL}_tv` })) },
        rules: clean.rules.map((x) => ({ ...x, sourceReference: `${SENTINEL}_rule`, sourceUrl: `https://${SENTINEL}.example` })),
        zipLists: clean.zipLists.map((z) => ({ ...z, sourceReference: `${SENTINEL}_zip` })),
        overrides: clean.overrides.map((o) => ({ ...o, reference: `${SENTINEL}_override` })),
      };
      const result = evaluateAdjustmentScenario(s.input, ctx, policyFnFromProfile(policyProfiles[s.policy]));
      const doc = scenarioStorageResult(result);
      const input = scenarioStorageInput(s.input, result);
      if (!doc.ok) continue;
      stored++;
      expect(JSON.stringify(doc.value), s.id).not.toContain(SENTINEL);
      expect(JSON.stringify(input), s.id).not.toContain(SENTINEL);
      // Only whitelisted keys appear anywhere in the stored result (deep walk).
      const allowed = new Set(["v", "status", "adjustmentType", "direction", "basis", "components", "totalsE4", "undecided", "warnings", "notices", "engineVersion", "pricingEngineVersion", "kind", "state", "amount", "declaredTotal", "correctedTotal", "handling", "engineHandling", "creditAmount", "upTo", "lines", "ruleKey", "label", "category", "packageIndex", "coveredPackageIndexes", "method", "customerPays", "decidedCaseByCase", "notBilledToCustomer", "notDecided", "side"]);
      walk(doc.value, (key) => {
        if (/^\d+$/.test(key)) return;
        expect(allowed.has(key), `${s.id}: unexpected key ${key}`).toBe(true);
      });
    }
    expect(stored).toBeGreaterThan(40);
  });

  it("the stored scenario result satisfies the database contract (statuses, states, money strings) for every priced golden input", () => {
    const { scenarios } = fixture<{ scenarios: { id: string; context: string; policy: string; input: AdjustmentScenarioInput }[] }>("scenarios.json");
    const MONEY = /^[0-9]{1,7}\.[0-9]{2}$/;
    const STATES = ["conditional", "waived_for_customer", "included_in_rate", "undecided", "not_configured", "not_triggered"];
    for (const s of scenarios) {
      const result = evaluateAdjustmentScenario(s.input, ctxOf(s.context), policyFnFromProfile(policyProfiles[s.policy]));
      const doc = scenarioStorageResult(result);
      if (result.status !== "ok" && result.status !== "no_adjustment") {
        expect(doc.ok, s.id).toBe(false);
        continue;
      }
      expect(doc.ok, s.id).toBe(true);
      if (!doc.ok) continue;
      const v = doc.value;
      expect(["ok", "no_adjustment"]).toContain(v.status);
      expect(["increase", "decrease", "none"]).toContain(v.direction);
      expect(["exact", "estimate"]).toContain(v.basis);
      expect(v.components.map((c) => c.kind)).toEqual(["postage_difference", "separate_fee"]);
      for (const c of v.components) {
        expect(STATES, `${s.id} ${c.kind}`).toContain(c.state);
        for (const a of [c.amount, c.declaredTotal, c.correctedTotal]) if (a !== null && a !== undefined) expect(a, `${s.id} ${c.kind}`).toMatch(MONEY);
        if (c.handling !== undefined) expect(HANDLING).toContain(c.handling);
      }
      const input = scenarioStorageInput(s.input, result);
      expect(input.ok, s.id).toBe(true);
      if (input.ok) {
        for (const p of [...input.value.declared.packages, ...input.value.corrected.packages]) {
          expect(p.weightLb).toMatch(/^[0-9]{1,6}(\.[0-9]{1,6})?$/);
          for (const d of [p.lengthIn, p.widthIn, p.heightIn]) if (d !== undefined) expect(d).toMatch(/^[0-9]{1,6}(\.[0-9]{1,6})?$/);
        }
        expect(input.value.declared.packages).toHaveLength(input.value.corrected.packages.length);
      }
    }
  });

  it("the risk storage document adds up (buckets = countedE4) and carries the resolved handling", () => {
    const f = okForecast({
      monthlyVolume: "1000", incidence: { source: "history", k: 20, N: 1000 },
      severity: { postage_difference: { source: "entered", e4: 100_000 }, separate_fee: { source: "entered", e4: 50_000 } },
      basis: "declared_weights", handling: { postage_difference: "manual_approval", separate_fee: "unconfigured" },
    });
    const doc = riskStorageResult(f);
    const b = doc.buckets!;
    expect(b.customerPays + b.decidedCaseByCase + b.notBilledToCustomer + b.notDecided).toBe(doc.countedE4);
    expect(doc.handling).toEqual({ postage_difference: "manual_approval", separate_fee: "unconfigured" });
    const none = riskStorageResult(okForecast({ ...{ monthlyVolume: "1000", incidence: { source: "history", k: 0, N: 0 } as const, severity: { postage_difference: { source: "entered", e4: 1 }, separate_fee: { source: "entered", e4: 1 } }, basis: "declared_weights" as const, handling: { postage_difference: "pass_through" as const, separate_fee: "pass_through" as const } } }));
    expect(none.buckets).toBeUndefined();
    expect(none.countedE4).toBeUndefined();
  });
});
