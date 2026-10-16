import { describe, expect, it } from "vitest";
import { affectedKey, forecastAdjustmentRisk, summariseHistory, type HistoryBaseline, type HistoryRecord, type RiskInputs } from "@/engine/adjustments";

/** Behaviour of the statistics and the forecast that the goldens do not pin. Every expectation is arithmetic done by hand in the comment. */
const rec = (id: string, over: Partial<HistoryRecord> = {}): HistoryRecord => ({
  id, brandId: "b1", carrierCode: "ups", serviceId: "s1", shipDate: "2026-01-10", adjustmentType: "reweight", cause: "carrier_reweigh", packageRef: id,
  originalCharge: "10.00", correctedCharge: "11.00", separateFee: "3.00", postageDifference: "1.00", ...over,
});
const base = (over: Partial<HistoryBaseline> = {}): HistoryBaseline => ({ id: "bl", brandId: "b1", carrierCode: null, serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 100, labelsMissingWeight: null, ...over });
const stats = (records: HistoryRecord[], baselines: HistoryBaseline[], filters = {}) => {
  const r = summariseHistory(records, baselines, { brandId: "b1", ...filters });
  if (r.status !== "ok") throw new Error(`refused: ${r.code}`);
  return r;
};

describe("affected key (design amendment A2)", () => {
  it("a package reference alone is not unique across customers or carriers", () => {
    const rs = [rec("x1", { brandId: "b1", packageRef: "REF" }), rec("x2", { brandId: "b2", packageRef: "REF" }), rec("x3", { brandId: "b1", carrierCode: "usps", packageRef: "REF" }), rec("x4", { brandId: "b1", packageRef: "REF" })];
    expect(new Set(rs.map(affectedKey)).size).toBe(3); // (b1, ups), (b2, ups), (b1, usps); x4 repeats x1
    const tenant = summariseHistory(rs, [base({ brandId: null })], { brandId: null });
    expect(tenant.status === "ok" && tenant.affected).toBe(3);
    expect(tenant.status === "ok" && tenant.recordsInScope).toBe(4);
  });

  it("a record without a reference counts once by itself, and the statistic says so", () => {
    const r = stats([rec("n1", { packageRef: null }), rec("n2", { packageRef: null })], [base()]);
    expect(r.affected).toBe(2);
    expect(r.perRecordCounting).toBe(true);
    expect(r.notes).toContain("counted_per_adjustment_record_not_per_package");
  });

  it("an unmatched-customer record (brand null) is its own scope in the key", () => {
    expect(affectedKey(rec("z", { brandId: null, packageRef: "R" }))).not.toBe(affectedKey(rec("z", { brandId: "b1", packageRef: "R" })));
  });
});

describe("severity arithmetic", () => {
  const charges = (amounts: string[]) => amounts.map((a, i) => rec(`c${i}`, { postageDifference: a, correctedCharge: null, originalCharge: null, separateFee: null }));

  it("p90 is the nearest rank, ceil(0.9 n): the 9th of 10, the 10th of 11, the 27th of 30", () => {
    const p90 = (n: number) => stats(charges(Array.from({ length: n }, (_, i) => `${i + 1}.00`)), [base({ packagesTotal: 1000 })]).severity.increase.postage.p90E4;
    expect(p90(1)).toBe(10_000);
    expect(p90(10)).toBe(90_000);
    expect(p90(11)).toBe(100_000); // ceil(9.9) = 10th smallest
    expect(p90(30)).toBe(270_000); // ceil(27) = 27th
    expect(p90(29)).toBe(270_000); // ceil(26.1) = 27th
  });

  it("the mean is HALF_UP on exact E4 and the median of an even count averages the two middle values", () => {
    const s = stats(charges(["0.0001", "0.0002"]), [base()]).severity.increase.postage; // sum 3 E4 over 2 = 1.5 -> 2
    expect(s.meanE4).toBe(2);
    expect(s.medianE4).toBe(2); // (1 + 2) / 2 = 1.5 -> 2
    expect(stats(charges(["0.0002", "0.0003"]), [base()]).severity.increase.postage.medianE4).toBe(3); // 2.5 -> 3
  });

  it("negative means round away from zero (credits)", () => {
    const rs = ["-0.0001", "-0.0002"].map((a, i) => rec(`d${i}`, { postageDifference: a, correctedCharge: null, originalCharge: null, separateFee: null }));
    expect(stats(rs, [base()]).severity.decrease.postage.meanE4).toBe(-2); // -1.5 -> -2
  });

  it("an explicit zero fee is a fee of zero (counted in n); a null fee is unknown (excluded, n shows it)", () => {
    const rs = [rec("f1", { separateFee: "0.00" }), rec("f2", { separateFee: null }), rec("f3", { separateFee: "3.00" })];
    const fee = stats(rs, [base()]).severity.increase.fee;
    expect(fee).toMatchObject({ n: 2, sumE4: 30_000, meanE4: 15_000 });
  });

  it("weights-only records count for incidence and nothing else", () => {
    const r = stats([rec("w", { originalCharge: null, correctedCharge: null, separateFee: null, postageDifference: null })], [base()]);
    expect(r.affected).toBe(1);
    expect(r.incidenceByDirection?.unknown.k).toBe(1);
    expect(r.chargesOnly).toEqual({ n: 0, meanE4: null });
    expect(r.severity.increase.postage.n).toBe(0);
  });

  it("warns when one record is more than 25 percent of the summed severity, not at exactly 25", () => {
    expect(stats(charges(["25.00", "25.00", "25.00", "25.00"]), [base()]).topRecordOver25Pct.postage).toBe(false); // 25 of 100 is exactly 25 percent
    expect(stats(charges(["26.00", "25.00", "25.00", "24.00"]), [base()]).topRecordOver25Pct.postage).toBe(true);
  });

  it("net of credits is a memo; chargesOnly is never reduced by credits", () => {
    const rs = [rec("a", { postageDifference: "10.00" }), rec("b", { postageDifference: "-4.00" })];
    const r = stats(rs, [base()]);
    expect(r.chargesOnly).toEqual({ n: 1, meanE4: 100_000 });
    expect(r.netOfCredits).toEqual({ n: 2, sumE4: 60_000, meanE4: 30_000 });
  });
});

describe("baseline selection", () => {
  it("refuses an explicit baseline of another carrier or service scope as a denominator", () => {
    const r = summariseHistory([rec("a")], [base({ id: "bl-ups", carrierCode: "ups" })], { brandId: "b1", baselineIds: ["bl-ups"] });
    expect(r).toMatchObject({ status: "refused", code: "scope_mismatch" });
    const ok = summariseHistory([rec("a")], [base({ id: "bl-ups", carrierCode: "ups" })], { brandId: "b1", carrierCode: "ups", baselineIds: ["bl-ups"] });
    expect(ok.status).toBe("ok");
  });

  it("refuses an unknown explicit baseline and a window that ends before it starts", () => {
    expect(summariseHistory([], [base()], { brandId: "b1", baselineIds: ["nope"] })).toMatchObject({ status: "refused", code: "baseline_not_found" });
    expect(summariseHistory([], [base()], { brandId: "b1", window: { from: "2026-02-01", to: "2026-01-01" } })).toMatchObject({ status: "refused", code: "invalid_filters" });
  });

  it("a baseline must lie wholly inside the window; a partly covered one is left out and counted", () => {
    const r = stats([rec("a")], [base()], { window: { from: "2026-01-05", to: "2026-02-05" } });
    expect(r.baseline).toMatchObject({ present: false, outsideWindowCount: 1 });
    expect(r.incidence).toBeNull();
    expect(r.incidenceReason).toBe("no_baseline");
  });

  it("three baselines overlapping through a long one are still caught (not only neighbours)", () => {
    const r = summariseHistory([], [base({ id: "long", periodStart: "2026-01-01", periodEnd: "2026-03-31" }), base({ id: "mid", periodStart: "2026-02-01", periodEnd: "2026-02-10" }), base({ id: "late", periodStart: "2026-03-01", periodEnd: "2026-03-10" })], { brandId: "b1" });
    expect(r).toMatchObject({ status: "refused", code: "baselines_overlap", ids: ["long", "mid"] });
  });

  it("never sums scopes: a brand statistic ignores the tenant-wide and the other brands' baselines", () => {
    const r = stats([rec("a")], [base({ id: "t", brandId: null, packagesTotal: 4000 }), base({ id: "o", brandId: "b2", packagesTotal: 2000 }), base({ id: "mine", packagesTotal: 100 })]);
    expect(r.baseline.ids).toEqual(["mine"]);
    expect(r.incidence?.N).toBe(100);
  });
});

describe("history numerator", () => {
  it("does not mix records outside the baseline period (excluded and counted)", () => {
    const r = stats([rec("in"), rec("before", { shipDate: "2025-12-31", packageRef: "p2" }), rec("after", { shipDate: "2026-02-01", packageRef: "p3" })], [base()]);
    expect(r.recordsInScope).toBe(1);
    expect(r.excludedOutsideBaseline).toBe(2);
  });

  it("k above N is refused rather than shown as more than 100 percent", () => {
    const rs = Array.from({ length: 3 }, (_, i) => rec(`k${i}`));
    expect(summariseHistory(rs, [base({ packagesTotal: 2 })], { brandId: "b1" })).toMatchObject({ status: "refused", code: "k_exceeds_n", k: 3, N: 2 });
  });

  it("a maturity check without a clock is refused (never answered as mature); without a window end it reports nothing instead of guessing", () => {
    expect(summariseHistory([rec("a")], [base()], { brandId: "b1", maturityDays: 30 })).toMatchObject({ status: "refused", code: "invalid_filters" }); // no `today`
    expect(stats([rec("a")], [], { maturityDays: 30, today: "2026-10-16" }).maturity).toBeNull(); // no window, no baseline
    expect(stats([rec("a")], [base()], { maturityDays: 30, today: "2026-01-31" }).maturity).toMatchObject({ windowEnd: "2026-01-31", daysSinceWindowEnd: 0, immature: true });
  });

  it("cause and type filters change the numerator only: the denominator is the same baseline", () => {
    const rs = [rec("a"), rec("b", { cause: "scale_error", packageRef: "pb" })];
    const all = stats(rs, [base()]);
    const one = stats(rs, [base()], { cause: "scale_error" });
    expect(all.incidence?.N).toBe(100);
    expect(one.incidence).toMatchObject({ k: 1, N: 100 });
  });
});

describe("risk forecast inputs", () => {
  const inputs = (over: Partial<RiskInputs> = {}): RiskInputs => ({
    monthlyVolume: "1000",
    incidence: { source: "history", k: 20, N: 1000 },
    severity: { postage_difference: { source: "entered", e4: 100_000 }, separate_fee: { source: "entered", e4: 50_000 } },
    basis: "declared_weights",
    handling: { postage_difference: "pass_through", separate_fee: "pass_through" },
    ...over,
  });
  const ok = (i: RiskInputs) => {
    const r = forecastAdjustmentRisk(i);
    if (r.status !== "ok") throw new Error(`refused: ${r.code}`);
    return r;
  };

  it("accepts a fractional volume and carries the affected count exactly (1000.5 x 2 percent = 20.01)", () => {
    const r = ok(inputs({ monthlyVolume: "1000.5" }));
    expect(r.affected).toEqual({ exact: "20.01", display1dp: "20.0" });
    expect(r.components.postage_difference.amountE4).toBe(2_001_000);
  });

  it("refuses malformed inputs with a specific code each", () => {
    const code = (i: RiskInputs) => {
      const r = forecastAdjustmentRisk(i);
      return r.status === "refused" ? r.code : "ok";
    };
    expect(code(inputs({ monthlyVolume: " 10" }))).toBe("volume_invalid");
    expect(code(inputs({ monthlyVolume: "1e3" }))).toBe("volume_invalid");
    expect(code(inputs({ incidence: { source: "entered", pct: "abc" } }))).toBe("p_invalid");
    expect(code(inputs({ incidence: { source: "history", k: -1, N: 10 } }))).toBe("k_negative");
    expect(code(inputs({ incidence: { source: "history", k: 1.5, N: 10 } }))).toBe("incidence_invalid");
    expect(code(inputs({ incidence: { source: "history", k: 1, N: 0 } }))).toBe("k_exceeds_n");
    expect(code(inputs({ incidence: undefined as never }))).toBe("incidence_invalid");
    expect(code(inputs({ handling: { postage_difference: "free" as never, separate_fee: "pass_through" } }))).toBe("handling_invalid");
    expect(code(inputs({ severity: { postage_difference: { source: "entered", e4: 1.5 }, separate_fee: { source: "entered", e4: 0 } } }))).toBe("severity_invalid");
    expect(code(inputs({ severity: { postage_difference: { source: "guess" as never, e4: 1 }, separate_fee: { source: "entered", e4: 0 } } }))).toBe("severity_invalid");
    expect(code(inputs({ credits: { k: 1, severityE4: 5 } }))).toBe("credits_invalid");
    expect(code(inputs({ credits: { k: 990, severityE4: -5 } }))).toBe("k_exceeds_n"); // 20 charges + 990 credits > 1000 packages
    expect(code(inputs({ basis: "both" as never }))).toBe("basis_required");
  });

  it("a severity from one example shipment is labelled so, never rated, and does not stop the overall from being 'entered'", () => {
    const r = ok(inputs({ incidence: { source: "entered", pct: "2" }, severity: { postage_difference: { source: "example", e4: 5300 }, separate_fee: { source: "example", e4: 300 } } }));
    expect(r.confidence).toMatchObject({ incidence: "entered", postage_difference: "example", separate_fee: "example", overall: "entered" });
  });

  it("a history severity is rated by the records behind it: 29 low, 30 adequate, none behind it none", () => {
    const sev = (n: number | null) => ({ postage_difference: { source: "history" as const, e4: 100_000, n }, separate_fee: { source: "entered" as const, e4: 0 } });
    expect(ok(inputs({ incidence: { source: "entered", pct: "2" }, severity: sev(29) })).confidence).toMatchObject({ postage_difference: "low", overall: "low" });
    expect(ok(inputs({ incidence: { source: "entered", pct: "2" }, severity: sev(30) })).confidence).toMatchObject({ postage_difference: "adequate", overall: "adequate" });
    expect(ok(inputs({ incidence: { source: "entered", pct: "2" }, severity: sev(null) })).confidence).toMatchObject({ postage_difference: "none", overall: "none" });
  });

  it("the weakest rated parameter wins: adequate incidence with a low severity is low", () => {
    const r = ok(inputs({ incidence: { source: "history", k: 280, N: 10_000 }, severity: { postage_difference: { source: "history", e4: 100_000, n: 12 }, separate_fee: { source: "entered", e4: 0 } } }));
    expect(r.confidence).toMatchObject({ incidence: "adequate", postage_difference: "low", overall: "low" });
  });

  it("exposes the exact (unrounded) counted sum and derives per-shipment, per-1,000 and annual figures from it, not from rounded pieces", () => {
    const r = ok(inputs({ monthlyVolume: "1000", incidence: { source: "entered", pct: "0.35" }, severity: { postage_difference: { source: "entered", e4: 357 }, separate_fee: { source: "entered", e4: 357 } } }));
    expect(r.exactCountedHereE4).toBe("2499");
    expect(r.countedHereE4).toBe(2500);
    expect([r.perShipmentE4, r.per1000E4, r.annualE4]).toEqual([2, 2499, 29_988]);
  });

  it("does not warn about unbilled in-forecast postage when its amount is zero", () => {
    const r = ok(inputs({ basis: "actual_weights", incidence: { source: "entered", pct: "0" }, handling: { postage_difference: "absorbed", separate_fee: "pass_through" } }));
    expect(r.warnings).toEqual([]);
    expect(r.inForecastMemoE4).toEqual({ inForecastNotBilledE4: 0, inForecastDecidedCaseByCaseE4: 0 });
  });

  it("credits are a memo only and are ignored for an entered incidence (no N to relate them to)", () => {
    const r = ok(inputs({ incidence: { source: "entered", pct: "2" }, credits: { k: 4, severityE4: -50_000 } }));
    expect(r.creditsMemoE4).toBeNull();
    expect(r.netMemoE4).toBeNull();
  });

  it("every result carries the engine version the application stores", () => {
    expect(ok(inputs()).engineVersion).toMatch(/^adjustments-\d+\.\d+\.\d+$/);
    expect(forecastAdjustmentRisk(inputs({ basis: null })).engineVersion).toMatch(/^adjustments-/);
    expect(summariseHistory([], [], { brandId: null }).engineVersion).toMatch(/^adjustments-/);
  });
});
