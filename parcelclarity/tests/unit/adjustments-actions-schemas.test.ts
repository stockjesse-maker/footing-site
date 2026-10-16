import { describe, expect, it, vi } from "vitest";
import {
  BASIS_REQUIRED_MESSAGE,
  PUBLISH_REFUSALS,
  RATE_LIMITS,
  ROW_PROBLEMS,
  TOO_OFTEN_MESSAGE,
  dollarsToE4,
  hasForbiddenText,
  publishRefusalMessage,
  riskHistoryCounts,
  riskInputSchema,
  riskInputsFrom,
  rpcFailure,
  scenarioInputSchema,
  setPolicySchema,
  todayIso,
  zodProblems,
  type RiskFormInput,
} from "@/lib/adjustments/action-schemas";
import type { HistoryStatistics } from "@/engine/adjustments";

vi.mock("server-only", () => ({}));

/**
 * The part of the adjustment actions that is not an action: the request schemas, the sentences for the database's refusals and the
 * pure assembly of a risk estimate's inputs. These run without a server, a database or a session.
 */
const UUID = "77777777-7777-4777-8777-777777777777";
const SCENARIO = "abababab-abab-4bab-8bab-abababababab";

describe("rpcFailure: the database's refusals, in words", () => {
  const e = (code: string, message = "internal text with 7.3719 and SENTINEL", extra: { hint?: string; details?: string } = {}) => ({ code, message, ...extra });

  it("reads each SQLSTATE class of the adjustment functions", () => {
    expect(rpcFailure(e("42501"))).toMatch(/permission/);
    expect(rpcFailure(e("P0002"))).toBe("That item was not found.");
    expect(rpcFailure(e("P0002"), { notFound: "Import not found." })).toBe("Import not found.");
    expect(rpcFailure(e("P0004"))).toMatch(/current state/);
    expect(rpcFailure(e("P0004"), { state: "This import is no longer being edited." })).toBe("This import is no longer being edited.");
    expect(rpcFailure(e("P0007"))).toMatch(/overlaps/);
    expect(rpcFailure(e("23P01"), { overlap: "End that one first." })).toBe("End that one first.");
    expect(rpcFailure(e("PC001"))).toMatch(/not accepted/);
    expect(rpcFailure(e("PC001"), { badInput: "Use plain text." })).toBe("Use plain text.");
    expect(rpcFailure(e("PC002"))).toMatch(/Start the import again/);
    expect(rpcFailure(e("PC003"))).toMatch(/did not reconcile/);
    expect(rpcFailure(e("PC003"), { reconcile: "Price it again." })).toBe("Price it again.");
    expect(rpcFailure(e("53400"))).toBe(TOO_OFTEN_MESSAGE);
    expect(rpcFailure(e("XX000"))).toBe("Something went wrong. Please try again.");
    expect(rpcFailure({ message: "no code at all" })).toBe("Something went wrong. Please try again.");
  });

  it("never repeats what a row held: a message the application does not recognise says nothing of its own", () => {
    for (const code of ["42501", "P0002", "P0004", "P0007", "P0001", "PC001", "PC002", "PC003", "53400", "XX000", "22P02"]) {
      const text = rpcFailure(e(code));
      expect(text, code).not.toMatch(/7\.3719|SENTINEL|internal text/);
    }
  });

  it("names the row and the reason (a code from a list) of a refused history chunk, never the value", () => {
    expect(rpcFailure(e("PC001", "row 17: invalid_weight"))).toBe("Row 17 of the file was refused: a weight is zero, negative or unreadable. Nothing from this import was kept.");
    expect(rpcFailure(e("PC001", "row 3: some_new_reason"))).toContain("a value is not valid");
    for (const [code, sentence] of Object.entries(ROW_PROBLEMS)) {
      expect(sentence, code).toMatch(/^[a-z]/);
      expect(sentence, code).not.toMatch(/\d{3,}/);
      expect(rpcFailure(e("PC001", `row 9: ${code}`)), code).toContain(sentence);
    }
  });

  it("reads the refusals to share by their hint code, naming the component from the database's curated message when it has one", () => {
    expect(PUBLISH_REFUSALS.not_an_increase).toContain("credit");
    for (const [hint, sentence] of Object.entries(PUBLISH_REFUSALS)) {
      expect(rpcFailure(e("P0001", "x", { hint })), hint).toBe(sentence);
      expect(publishRefusalMessage(e("P0001", "x", { hint })), hint).toBe(sentence);
    }
    expect(rpcFailure(e("P0001", "Decide how the separate adjustment fee is handled for this customer first.", { hint: "undecided_policy" }))).toBe("Decide how the separate adjustment fee is handled for this customer first.");
    expect(rpcFailure(e("P0001", "unreadable", { hint: "undecided_policy" }))).toBe("Decide how the adjustment is handled for this customer first.");
    expect(rpcFailure(e("P0001", "The shipping charge difference must be at least $0.01 to be shared.", { hint: "component_below_minimum" }))).toBe("The shipping charge difference must be at least $0.01 to be shared.");
    expect(publishRefusalMessage(e("P0001", "x"))).toBeNull();
  });

  it("reads the refusals without a hint by the words the migration uses", () => {
    expect(rpcFailure(e("P0001", "too many imports are in progress; finish or discard one first"))).toMatch(/five imports/);
    expect(rpcFailure(e("P0001", "this file already has an import"))).toMatch(/already been imported/);
    expect(rpcFailure(e("P0001", "the attestation is missing"))).toMatch(/not what the carrier billed you/);
    expect(rpcFailure(e("P0001", "confirm that the amounts are what your customers were charged"))).toMatch(/not what the carrier billed you/);
    expect(rpcFailure(e("P0001", "saved risk estimates are based on this import; archive them first"))).toBe("Saved risk estimates are based on this import. Archive them first.");
    expect(rpcFailure(e("P0001", "the history limit of 200,000 records per account is reached"))).toMatch(/200,000/);
    expect(rpcFailure(e("P0001", "the limit of 500 baselines is reached"))).toMatch(/500 baselines/);
    expect(rpcFailure(e("P0001", "the limit of 25 shared examples per customer is reached"))).toMatch(/25 shared examples/);
    expect(rpcFailure(e("P0001", "a column that looks like carrier cost data cannot be mapped"))).toMatch(/carrier cost data/);
    expect(rpcFailure(e("P0001", "something the app has never heard of"))).toBe("That is not allowed right now.");
  });
});

describe("the sentences and limits the actions share", () => {
  it("keeps the rate-limit sentence equal to the one every other action uses", async () => {
    const real = await import("@/lib/rate-limit");
    expect(TOO_OFTEN_MESSAGE).toBe(real.RATE_LIMITED_MESSAGE);
  });

  it("names rate limits the database accepts (letters, dots and underscores only) and never one the database's own functions use", () => {
    const names = Object.values(RATE_LIMITS).map((l) => l.action);
    for (const name of names) expect(name).toMatch(/^[a-z_.]{2,60}$/);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("adjustment.import");
    expect(names).not.toContain("adjustment.append");
    for (const l of Object.values(RATE_LIMITS)) {
      expect(l.limit).toBeGreaterThan(0);
      expect(l.windowSeconds).toBeLessThanOrEqual(86_400);
    }
  });

  it("uses the review's exact words for the weights basis error", () => {
    expect(BASIS_REQUIRED_MESSAGE).toBe("Choose one. It decides whether postage differences are counted here or are already in your forecast.");
  });

  it("gives today as an ISO date in UTC", () => {
    expect(todayIso(new Date("2026-10-16T23:59:59Z"))).toBe("2026-10-16");
    expect(todayIso(new Date("2026-10-17T00:00:00Z"))).toBe("2026-10-17");
  });

  it("turns a failed request into a short list of 'field: message' lines", () => {
    const parsed = setPolicySchema.safeParse({ brandId: "x", adjustmentType: "nope" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const lines = zodProblems(parsed.error);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(20);
      expect(lines.every((l) => /^[A-Za-z.0-9]+: /.test(l))).toBe(true);
    }
  });
});

describe("plain text a customer may read", () => {
  const ch = (code: number) => String.fromCodePoint(code);

  it("refuses control, bidirectional and zero-width characters and angle brackets (the database's own list)", () => {
    const refused = [0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f, 0x80, 0x9f, 0x2028, 0x2029, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202d, 0x202e, 0x2066, 0x2067, 0x2069, 0xfeff];
    for (const code of refused) expect(hasForbiddenText(`a${ch(code)}b`), code.toString(16)).toBe(true);
    expect(hasForbiddenText("a<b")).toBe(true);
    expect(hasForbiddenText("a>b")).toBe(true);
    expect(hasForbiddenText("<script>")).toBe(true);
  });

  it("allows what a title and a note ordinarily contain", () => {
    for (const text of ["If a 3 lb package is corrected to 5 lb", "Café déjà vu — “quoted” & ok (really)!", "Tab\tand newline\nare the database's business", "日本語", "50% of $12.00", ch(0xa0) + "spaced", "emoji " + ch(0x1f4e6)]) {
      expect(hasForbiddenText(text), text).toBe(false);
    }
  });
});

describe("dollarsToE4", () => {
  it("is exact: no floating point, up to four decimals", () => {
    expect(dollarsToE4("5.30")).toBe(53000);
    expect(dollarsToE4("0")).toBe(0);
    expect(dollarsToE4("0.0001")).toBe(1);
    expect(dollarsToE4("10")).toBe(100000);
    expect(dollarsToE4("2.025")).toBe(20250);
    expect(dollarsToE4("1234567.8912")).toBe(12345678912);
    expect(dollarsToE4("0.35")).toBe(3500);
    expect(dollarsToE4("9999999.9999")).toBe(99999999999);
  });
});

describe("scenario and risk schemas", () => {
  const form = () => ({ brandId: UUID, serviceId: UUID, originZip: "90001", destinationZip: "85001", residential: false, declaredSource: "entered", packages: [{ declared: { weight: "3", weightUnit: "lb" }, correction: { weight: "5" } }] });

  it("accepts the builder's form and fills nothing in", () => {
    const parsed = scenarioInputSchema.safeParse(form());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.packages[0]!.correction).toEqual({ weight: "5" });
  });

  it("refuses a correction that is a unit without a weight, partial dimensions, zero, and a form with no destination", () => {
    const bad = (over: Record<string, unknown>) => scenarioInputSchema.safeParse({ ...form(), ...over });
    expect(bad({ packages: [{ declared: { weight: "3", weightUnit: "lb" }, correction: { weightUnit: "oz" } }] }).success).toBe(false);
    expect(bad({ packages: [{ declared: { weight: "3", weightUnit: "lb", length: "10" }, correction: { weight: "5" } }] }).success).toBe(false);
    expect(bad({ packages: [{ declared: { weight: "3", weightUnit: "lb" }, correction: { length: "10", width: "8" } }] }).success).toBe(false);
    expect(bad({ packages: [{ declared: { weight: "0", weightUnit: "lb" }, correction: {} }] }).success).toBe(false);
    expect(bad({ packages: [{ declared: { weight: "1234567", weightUnit: "lb" }, correction: {} }] }).success).toBe(false);
    expect(bad({ packages: [{ declared: { weight: "1.1234567", weightUnit: "lb" }, correction: {} }] }).success).toBe(false);
    expect(bad({ packages: [{ declared: { weight: "3", weightUnit: "kg" }, correction: {} }] }).success).toBe(false);
    expect(bad({ destinationZip: undefined }).success).toBe(false);
    expect(bad({ destinationZip: undefined, destinationZone: "5" }).success).toBe(true);
    expect(bad({ brandId: null }).success).toBe(false);
    expect(bad({ brandId: null, rateCardId: UUID }).success).toBe(true);
    expect(bad({ shipDate: "2026-13-01" }).success).toBe(false);
    expect(bad({ extra: 1 }).success).toBe(false);
  });

  const risk = (over: Record<string, unknown> = {}) => ({
    brandId: null,
    adjustmentType: "reweight",
    basis: "declared_weights",
    volume: { source: "entered", packagesPerMonth: "1000" },
    incidence: { source: "entered", pct: "2" },
    severity: { postage_difference: { source: "entered", amount: "10.00" }, separate_fee: { source: "entered", amount: null } },
    credits: "exclude",
    ...over,
  });

  it("requires the basis, the credits treatment and each severity's source, with no default for any of them", () => {
    expect(riskInputSchema.safeParse(risk()).success).toBe(true);
    for (const missing of ["basis", "credits", "severity", "volume", "incidence", "adjustmentType"]) {
      const { [missing]: _gone, ...rest } = risk() as Record<string, unknown>;
      expect(riskInputSchema.safeParse(rest).success, missing).toBe(false);
    }
    // An entered severity says its amount, or says it is not known (null / blank): leaving it out is not an answer.
    const omitted = riskInputSchema.safeParse(risk({ severity: { postage_difference: { source: "entered" }, separate_fee: { source: "entered", amount: "1" } } }));
    expect(omitted.success).toBe(false);
    if (!omitted.success) expect(omitted.error.issues[0]!.message).toBe("Enter an amount in dollars, or leave it blank if you do not know it.");
    expect(riskInputSchema.safeParse(risk({ severity: { postage_difference: { source: "guess" }, separate_fee: { source: "entered", amount: "1" } } })).success).toBe(false);
  });

  it("reads a blank severity amount as 'not known' (null), never as zero", () => {
    const parsed = riskInputSchema.safeParse(risk({ severity: { postage_difference: { source: "entered", amount: "" }, separate_fee: { source: "entered", amount: "0" } } }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.severity).toEqual({ postage_difference: { source: "entered", amount: null }, separate_fee: { source: "entered", amount: "0" } });
  });

  it("refuses amounts below zero or beyond four decimals, an incidence outside 0 to 100, and more than 5,000,000 packages a month", () => {
    const sev = (amount: string) => ({ postage_difference: { source: "entered", amount }, separate_fee: { source: "entered", amount: "1" } });
    expect(riskInputSchema.safeParse(risk({ severity: sev("-1") })).success).toBe(false);
    expect(riskInputSchema.safeParse(risk({ severity: sev("1.23456") })).success).toBe(false);
    expect(riskInputSchema.safeParse(risk({ incidence: { source: "entered", pct: "100.0001" } })).success).toBe(false);
    expect(riskInputSchema.safeParse(risk({ incidence: { source: "entered", pct: "100" } })).success).toBe(true);
    expect(riskInputSchema.safeParse(risk({ incidence: { source: "entered", pct: "0" } })).success).toBe(true);
    expect(riskInputSchema.safeParse(risk({ volume: { source: "entered", packagesPerMonth: "5000001" } })).success).toBe(false);
    expect(riskInputSchema.safeParse(risk({ volume: { source: "entered", packagesPerMonth: "5000000" } })).success).toBe(true);
    expect(riskInputSchema.safeParse(risk({ volume: { source: "entered", packagesPerMonth: "-5" } })).success).toBe(false);
  });

  it("needs a history choice whenever anything comes from history, a customer for a run, and history for the credits memo", () => {
    expect(riskInputSchema.safeParse(risk({ incidence: { source: "history" } })).success).toBe(false);
    expect(riskInputSchema.safeParse(risk({ incidence: { source: "history" }, history: {} })).success).toBe(true);
    expect(riskInputSchema.safeParse(risk({ severity: { postage_difference: { source: "history" }, separate_fee: { source: "entered", amount: "1" } } })).success).toBe(false);
    expect(riskInputSchema.safeParse(risk({ volume: { source: "run", runId: UUID } })).success).toBe(false);
    expect(riskInputSchema.safeParse(risk({ volume: { source: "run", runId: UUID }, brandId: UUID })).success).toBe(true);
    expect(riskInputSchema.safeParse(risk({ credits: "memo" })).success).toBe(false);
    expect(riskInputSchema.safeParse(risk({ credits: "memo", incidence: { source: "history" }, history: {} })).success).toBe(true);
    expect(riskInputSchema.safeParse(risk({ severity: { postage_difference: { source: "example", scenarioId: SCENARIO }, separate_fee: { source: "entered", amount: "1" } } })).success).toBe(true);
  });
});

describe("riskInputsFrom and riskHistoryCounts", () => {
  /** The parts of the statistics these functions read. */
  const stats = (over: { affected?: number; up?: number; down?: number; zero?: number; unknown?: number; N?: number | null; postage?: { n: number; meanE4: number | null }; fee?: { n: number; meanE4: number | null }; creditMean?: number | null } = {}): HistoryStatistics => {
    const g = (k: number) => ({ k, pct4dp: "0.0000", wilson: { lowerPct4dp: "0", upperPct4dp: "0", lowerPct10dp: "0", upperPct10dp: "0" } });
    const N = over.N === undefined ? 1000 : over.N;
    const severity = (s: { n: number; meanE4: number | null }) => ({ n: s.n, sumE4: null, meanE4: s.meanE4, medianE4: null });
    return {
      baseline: { present: N !== null, ids: [], packagesTotal: N, periods: [], outsideWindowCount: 0 },
      affected: over.affected ?? 10,
      incidence: N === null ? null : { k: over.affected ?? 10, N, pct4dp: "1.0000", wilson: { lowerPct4dp: "0", upperPct4dp: "0", lowerPct10dp: "0", upperPct10dp: "0" } },
      incidenceByDirection: N === null ? null : { increase: g(over.up ?? 6), decrease: g(over.down ?? 4), zero: g(over.zero ?? 0), unknown: g(over.unknown ?? 0) },
      severity: {
        increase: { postage: severity(over.postage ?? { n: 6, meanE4: 100000 }), fee: severity(over.fee ?? { n: 0, meanE4: null }) },
        decrease: { postage: severity({ n: over.down ?? 4, meanE4: over.creditMean === undefined ? -50000 : over.creditMean }), fee: severity({ n: 0, meanE4: null }) },
        zero: { postage: severity({ n: 0, meanE4: null }), fee: severity({ n: 0, meanE4: null }) },
        unknown: { postage: severity({ n: 0, meanE4: null }), fee: severity({ n: 0, meanE4: null }) },
      },
    } as unknown as HistoryStatistics;
  };
  const form = (over: Record<string, unknown> = {}): RiskFormInput =>
    ({ brandId: null, adjustmentType: "reweight", basis: "declared_weights", volume: { source: "entered", packagesPerMonth: "1000" }, incidence: { source: "history" }, severity: { postage_difference: { source: "history" }, separate_fee: { source: "entered", amount: "5.00" } }, credits: "exclude", history: {}, ...over }) as RiskFormInput;
  const parts = (statistics: HistoryStatistics | null) => ({ volume: "1000", handling: { postage_difference: "pass_through", separate_fee: "pass_through" } as const, statistics, exampleSeverity: {} });

  it("counts the packages whose charge went up and those with no amounts; credits and unchanged ones are left out and named", () => {
    expect(riskHistoryCounts(stats({ affected: 10, up: 6, down: 4 }))).toEqual({ charges: 6, credits: 4, zeroChange: 0, unknownAmount: 0, counted: 6, affected: 10 });
    expect(riskHistoryCounts(stats({ affected: 12, up: 5, down: 2, zero: 1, unknown: 4 }))).toEqual({ charges: 5, credits: 2, zeroChange: 1, unknownAmount: 4, counted: 9, affected: 12 });
    // Counted never exceeds the packages affected (a package in two groups would count twice).
    expect(riskHistoryCounts(stats({ affected: 7, up: 5, down: 0, unknown: 4 }))!.counted).toBe(7);
    expect(riskHistoryCounts(stats({ N: null }))).toBeNull();
  });

  it("builds the engine's inputs: incidence from the counted packages, charges-only severities, entered severities as exact E4", () => {
    const r = riskInputsFrom(form(), parts(stats()));
    expect(r).toEqual({
      ok: true,
      inputs: { monthlyVolume: "1000", incidence: { source: "history", k: 6, N: 1000 }, severity: { postage_difference: { source: "history", e4: 100000, n: 6 }, separate_fee: { source: "entered", e4: 50000 } }, basis: "declared_weights", handling: { postage_difference: "pass_through", separate_fee: "pass_through" }, credits: null },
    });
  });

  it("has no incidence without a baseline (zero packages, never a guess) and leaves a severity without records unknown", () => {
    const r = riskInputsFrom(form(), parts(stats({ N: null, postage: { n: 0, meanE4: null } })));
    expect(r.ok && r.inputs.incidence).toEqual({ source: "history", k: 0, N: 0 });
    const none = riskInputsFrom(form(), parts(stats({ postage: { n: 0, meanE4: null } })));
    expect(none.ok && none.inputs.severity.postage_difference).toEqual({ source: "history", e4: null, n: 0 });
  });

  it("adds the credits memo from the credit records only when asked, and says 'none' (zero records), not unknown, when there are none", () => {
    const memo = riskInputsFrom(form({ credits: "memo" }), parts(stats()));
    expect(memo.ok && memo.inputs.credits).toEqual({ k: 4, severityE4: -50000 });
    const none = riskInputsFrom(form({ credits: "memo" }), parts(stats({ down: 0 })));
    expect(none.ok && none.inputs.credits).toEqual({ k: 0, severityE4: 0 });
    const noBaseline = riskInputsFrom(form({ credits: "memo" }), parts(stats({ N: null })));
    expect(noBaseline.ok && noBaseline.inputs.credits).toBeNull();
    const off = riskInputsFrom(form({ credits: "exclude" }), parts(stats()));
    expect(off.ok && off.inputs.credits).toBeNull();
  });

  it("takes an example's amount only when it is a charge (null otherwise) and an entered blank as unknown", () => {
    const f = form({ incidence: { source: "entered", pct: "2" }, severity: { postage_difference: { source: "example", scenarioId: SCENARIO }, separate_fee: { source: "entered", amount: null } }, history: undefined });
    const r = riskInputsFrom(f, { ...parts(null), exampleSeverity: { postage_difference: 5600 } });
    expect(r).toMatchObject({ ok: true, inputs: { incidence: { source: "entered", pct: "2" }, severity: { postage_difference: { source: "example", e4: 5600 }, separate_fee: { source: "entered", e4: null } } } });
    const unknown = riskInputsFrom(f, { ...parts(null), exampleSeverity: { postage_difference: null } });
    expect(unknown.ok && unknown.inputs.severity.postage_difference.e4).toBeNull();
  });

  it("reports a missing reading of the history instead of inventing one", () => {
    const r = riskInputsFrom(form(), parts(null));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toContain("could not be read");
  });
});
