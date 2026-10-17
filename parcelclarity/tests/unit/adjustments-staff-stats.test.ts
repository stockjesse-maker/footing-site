import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { summariseHistory } from "@/engine/adjustments";
import type { HistoryRecord, HistoryRefused } from "@/engine/adjustments/types";
import { CONFIDENCE_LABELS, PER_RECORD_NOTE, RANGE_SENTENCE, STATS_NO_BASELINE, STATS_PENDING } from "@/lib/adjustments/staff-copy";
import { BRANDS, BRAND_A, CATALOG, SVC_UPS_GROUND, TODAY, accessibleNames, baseline, bannedIn, histRecord, html, idProblems, statistics, textOf, unnamedControls } from "./adjustments-staff-support";

vi.mock("@/app/actions/adjustments", () => ({ loadHistoryStatistics: vi.fn() }));

const model = await import("@/components/adjustments/staff/stats-model");
const { StatisticsView } = await import("@/components/adjustments/staff/stats-view");
const { StatsWorkspaceView } = await import("@/components/adjustments/staff/stats-workspace");

/**
 * Statistics of the imported history. The figures come from the real engine over invented records, so a view that prints a number the engine
 * did not produce, or a zero where the engine said "unknown", fails here. Expectations about the figures are derived by hand in the comments.
 */
const charges = (n: number, over: Partial<HistoryRecord> = {}) => Array.from({ length: n }, (_, i) => histRecord(i + 1, over));
const credits = (n: number, start = 100) => Array.from({ length: n }, (_, i) => histRecord(start + i, { originalCharge: "10.00", correctedCharge: "8.00", postageDifference: "-2.00", separateFee: null }));
const noAmounts = (n: number, start = 200) => Array.from({ length: n }, (_, i) => histRecord(start + i, { originalCharge: null, correctedCharge: null, postageDifference: null, separateFee: null }));

const render = (stats: ReturnType<typeof statistics>, scopeName = "Alpha Apparel") => html(createElement(StatisticsView, { stats, scopeName, headingId: "stats-h" }));

describe("with typed packages shipped for the window", () => {
  // 20 charges of $2.00 postage + $3.00 fee, 5 credits of -$2.00, in a month with 1,000 packages shipped:
  // k = 25 of N = 1,000 = 2.5000%; charges only mean 2.00 (n 20); net of credits = (20*2.00 - 5*2.00) / 25 = 1.20 (n 25).
  const stats = statistics([...charges(20), ...credits(5)], [baseline()]);
  const out = render(stats);
  const t = textOf(out);

  it("shows how often to four decimals with the counts, and the range with the sentence that it reflects incidence uncertainty only", () => {
    expect(stats.incidence).toMatchObject({ k: 25, N: 1000, pct4dp: "2.5000" });
    expect(t).toContain("2.5000%");
    expect(t).toContain("25 of 1,000 packages shipped");
    expect(t).toMatch(/Range \d+\.\d{4}% to \d+\.\d{4}%/);
    expect(t).toContain(RANGE_SENTENCE);
    expect(t.toLowerCase()).toContain("range reflects incidence uncertainty only");
  });

  it("shows 'Charges only' and 'Net of credits' means, each with how many records it rests on", () => {
    expect(t).toContain("Charges only $2.00 average of 20 records");
    expect(t).toContain("Net of credits $1.20 average of 25 records");
    expect(t).toContain("A memo that assumes credits are returned to the customer. It is not used in an estimate.");
  });

  it("splits by direction: charges, credits, no change, no amounts recorded, each with its count and what it means", () => {
    expect(t).toContain("By direction");
    for (const label of ["Charges", "Credits", "No change", "No amounts recorded"]) expect(t).toContain(label);
    expect(t).toContain("20 packages, 2.0000%");
    expect(t).toContain("5 packages, 0.5000%");
    expect(t).toContain("The corrected charge is lower than the original charge. This is a credit, not an adjustment charge.");
  });

  it("labels the confidence of each parameter with words and a badge", () => {
    expect(t).toContain(`${CONFIDENCE_LABELS[stats.confidence.incidence]} confidence`);
    expect(t).toContain(`${CONFIDENCE_LABELS[stats.confidence.postage]} confidence`);
    expect(t).toContain("How much to trust how often:");
    expect(t).toContain("Shipping charge difference:");
    expect(t).toContain("Separate adjustment fee:");
  });

  it("shows the shipping charge difference and the separate fee separately, with the average, the middle value, 9 in 10 and the largest", () => {
    expect(t).toContain("Shipping charge difference, charges only");
    expect(t).toContain("Separate adjustment fee, on charges");
    expect(t).toContain("Records with an amount 20 Average $2.00 Middle value $2.00 9 in 10 are at or below $2.00 Largest $2.00");
    expect(t).toContain("Records with an amount 20 Average $3.00 Middle value $3.00");
  });

  it("is a region labelled by a heading, in sections with headings, and sets the credits aside from what an estimate counts", () => {
    expect(out).toContain('aria-labelledby="stats-h"');
    expect(out).toContain('id="stats-h" tabindex="-1"');
    expect(t).toContain("Credits are shown separately and never reduce what a risk estimate counts.");
    expect(out).not.toMatch(/<h1/);
  });

  it("uses no table: the figures are definition lists that stack on a phone", () => {
    expect(out).not.toContain("<table");
    expect(out).toContain("grid-cols-2");
    expect(out).toContain("sm:grid-cols-5");
  });
});

describe("without packages shipped", () => {
  const stats = statistics(charges(20), []);
  const out = render(stats);
  const t = textOf(out);

  it("replaces incidence with the sentence that says what to add, and shows averages only", () => {
    expect(stats.incidence).toBeNull();
    expect(t).toContain(STATS_NO_BASELINE);
    expect(t).not.toContain("Adjusted ");
    expect(t).not.toContain("By direction");
    expect(t).not.toMatch(/\d\.\d{4}%/);
    expect(t).toContain("Average $2.00");
    expect(out).toContain('href="/app/adjustments/history/baselines"');
  });
});

describe("an unknown amount is never zero", () => {
  it("records with no amounts: every figure reads Not computed and no $0.00 appears", () => {
    const out = render(statistics(noAmounts(12), [baseline()]));
    const t = textOf(out);
    expect(t).toContain("Not computed");
    expect(t).not.toContain("$0.00");
    expect(t).toContain("12 packages, 1.2000%");
    expect(t).toContain("Charges only Not computed");
    expect(t).toContain("Net of credits Not computed");
  });

  it("the severity row of a block with no amounts is Not computed throughout, with a count of zero", () => {
    const stats = statistics(noAmounts(3), []);
    expect(model.severityRow(stats.severity.increase.postage)).toEqual({ n: 0, mean: "Not computed", median: "Not computed", p90: "Not computed", largest: "Not computed" });
    expect(model.amountText(null)).toBe("Not computed");
    expect(model.amountText(0)).toBe("$0.00");
  });

  it("no records match: says so and how to change that", () => {
    const t = textOf(render(statistics([], [baseline()])));
    expect(t).toContain("No adjustment records match these filters. Change the filters, or import more history.");
    expect(t).not.toContain("$0.00");
  });
});

describe("what the figures rest on", () => {
  it("a period that ended recently may not be complete", () => {
    const recent = statistics(charges(5, { shipDate: "2026-10-05" }), [baseline({ periodStart: "2026-10-01", periodEnd: "2026-10-10" })], { maturityDays: 30 });
    expect(recent.maturity?.immature).toBe(true);
    const t = textOf(render(recent));
    expect(t).toContain("This period may not be complete");
    expect(t).toContain("This period ended 7 days ago. Adjustments can still be added for 30 days after a period ends, so the counts for it may rise.");
    const old = statistics(charges(5), [baseline()], { maturityDays: 30 });
    expect(textOf(render(old))).not.toContain("may not be complete");
    expect(textOf(render(statistics(charges(5), [baseline()])))).not.toContain("may not be complete");
  });

  it("without a package reference, it says the count is per adjustment record, not per package", () => {
    const stats = statistics(charges(10, { packageRef: null }), [baseline()]);
    expect(stats.perRecordCounting).toBe(true);
    const t = textOf(render(stats));
    expect(t).toContain(PER_RECORD_NOTE);
    expect(t).toContain("per adjustment record, not per package");
    expect(textOf(render(statistics(charges(10), [baseline()])))).not.toContain("per adjustment record, not per package");
  });

  it("one record that is more than a quarter of the total is called out for each amount", () => {
    const records = [...charges(9), histRecord(50, { postageDifference: "40.00", separateFee: "3.00", correctedCharge: "50.00" })];
    const t = textOf(render(statistics(records, [baseline()])));
    expect(t).toContain("One record is more than a quarter of the shipping charge differences");
    expect(t).not.toContain("more than a quarter of the separate adjustment fees");
  });

  it("labels printed without a weight, when the packages shipped carry them", () => {
    const records = [...charges(8, { cause: "wms_no_weight" }), ...charges(2, {}).map((r, i) => ({ ...r, id: `x${i}`, packageRef: `1ZX${i}` }))];
    const stats = statistics(records, [baseline({ labelsMissingWeight: 50 })]);
    const t = textOf(render(stats));
    expect(t).toContain("Labels printed without a weight");
    expect(t).toContain("Labels without a weight 50");
    expect(t).toContain("Share of packages shipped 5.0000%");
    expect(t).toContain("Of those, corrected later 16.0000% 8 packages");
    expect(textOf(render(statistics(records, [baseline()])))).not.toContain("Labels printed without a weight");
  });

  it("records outside the periods that have packages shipped are left out of how often, and the reader is told", () => {
    const records = [...charges(5), ...charges(2, { shipDate: "2026-03-01" }).map((r, i) => ({ ...r, id: `old${i}`, packageRef: `1ZOLD${i}` }))];
    const stats = statistics(records, [baseline()]);
    expect(stats.excludedOutsideBaseline).toBe(2);
    expect(textOf(render(stats))).toContain("2 adjustment records fall outside the periods you gave packages shipped for, so they are left out of how often.");
  });

  it("a packages-shipped period that does not lie inside the window is not used, and the reader is told", () => {
    const stats = statistics(charges(5), [baseline()], { window: { from: "2026-08-10", to: "2026-08-20" } });
    expect(stats.baseline.outsideWindowCount).toBe(1);
    expect(textOf(render(stats))).toContain("1 packages-shipped period does not lie wholly inside the window, so it is not used.");
  });

  it("never calls the 3PL's own amounts a cost, a loss, a margin or a profit", () => {
    for (const stats of [statistics([...charges(20), ...credits(5)], [baseline()]), statistics(charges(3), []), statistics(noAmounts(3), [baseline()])]) expect(bannedIn(textOf(render(stats)))).toEqual([]);
  });
});

describe("the filters become the action's input", () => {
  const form = model.EMPTY_STATS_FORM;

  it("start with all customers, any carrier and kind, no window, and a 30 day maturity that can be cleared", () => {
    expect(model.statsInput(form)).toEqual({ ok: true, input: { brandId: null, carrierCode: null, serviceId: null, adjustmentType: null, cause: null, window: null, maturityDays: 30 } });
    expect(model.statsInput({ ...form, maturityDays: "" })).toMatchObject({ ok: true, input: { maturityDays: null } });
  });

  it("carry every chosen filter", () => {
    const built = model.statsInput({ brandId: BRAND_A, carrierCode: "ups", serviceId: SVC_UPS_GROUND, adjustmentType: "reweight", cause: "carrier_reweigh", from: "2026-08-01", to: "2026-08-31", maturityDays: "0" });
    expect(built).toEqual({ ok: true, input: { brandId: BRAND_A, carrierCode: "ups", serviceId: SVC_UPS_GROUND, adjustmentType: "reweight", cause: "carrier_reweigh", window: { from: "2026-08-01", to: "2026-08-31" }, maturityDays: 0 } });
  });

  it("say what to fix, and send nothing", () => {
    expect(model.statsInput({ ...form, from: "2026-08-01" })).toEqual({ ok: false, errors: { window: "Enter both dates of the window, or neither." } });
    expect(model.statsInput({ ...form, to: "2026-08-01" })).toEqual({ ok: false, errors: { window: "Enter both dates of the window, or neither." } });
    expect(model.statsInput({ ...form, from: "2026-08-31", to: "2026-08-01" })).toEqual({ ok: false, errors: { window: "The window ends before it starts." } });
    for (const bad of ["-1", "3.5", "abc", "3651", "99999"]) expect(model.statsInput({ ...form, maturityDays: bad }), bad).toEqual({ ok: false, errors: { maturityDays: "Enter a whole number of days from 0 to 3,650, or leave it empty." } });
  });

  it("read a refused statistic with the engine's sentence, and where to fix it when there is somewhere", () => {
    const refusal = (code: HistoryRefused["code"], extra: Partial<HistoryRefused> = {}): HistoryRefused => ({ engineVersion: "x", status: "refused", code, message: "The engine's sentence.", ...extra });
    expect(model.refusalAdvice(refusal("k_exceeds_n", { k: 30, N: 20 }))).toEqual({ message: "The engine's sentence. (30 adjusted packages, 20 packages shipped.)", link: { href: "/app/adjustments/history/baselines", label: "Check packages shipped" } });
    expect(model.refusalAdvice(refusal("baselines_overlap")).link?.href).toBe("/app/adjustments/history/baselines");
    expect(model.refusalAdvice(refusal("service_unresolved", { unresolvedCount: 3 }))).toEqual({ message: "The engine's sentence. (3 records without a matched service.)", link: null });
    expect(model.refusalAdvice(refusal("invalid_filters"))).toEqual({ message: "The engine's sentence.", link: null });
  });

  it("describe a refusal from the real engine (a service filter with unmatched records)", () => {
    const refused = summariseHistory([histRecord(1, { serviceId: null })], [], { brandId: BRAND_A, serviceId: SVC_UPS_GROUND });
    expect(refused.status).toBe("refused");
    if (refused.status === "refused") expect(model.refusalAdvice(refused).message).toContain("1 record without a matched service");
  });
});

describe("the statistics screen", () => {
  const props = (over: Partial<Parameters<typeof StatsWorkspaceView>[0]> = {}): Parameters<typeof StatsWorkspaceView>[0] => ({
    brands: BRANDS.map((b) => ({ id: b.id, name: b.name })),
    catalog: CATALOG,
    form: model.EMPTY_STATS_FORM,
    errors: {},
    outcome: { kind: "idle" },
    onChange: () => undefined,
    onSubmit: () => undefined,
    prefix: "s",
    ...over,
  });
  const render = (over: Partial<Parameters<typeof StatsWorkspaceView>[0]> = {}) => html(createElement(StatsWorkspaceView, props(over)));

  it("idle: every filter has a label, 16px-friendly controls, the three customers, and the button names its action", () => {
    const out = render();
    const t = textOf(out);
    for (const label of ["Customer", "Carrier", "Service", "Kind of adjustment", "Cause", "From", "To", "Adjustments can still be added for (days)"]) expect(t).toContain(label);
    expect(t).toContain("All customers together");
    expect(t).toContain("Any carrier");
    expect(t).toContain("Any kind");
    expect(t).toContain("Any cause");
    expect(t).toContain("Show statistics");
    expect(t).toContain("Alpha Apparel");
    expect((out.match(/<label[^>]*for="/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(out).toContain('value="30"');
    expect(out).not.toContain('role="alert"');
    expect(out).not.toMatch(/<h1/);
  });

  it("the service filter waits for a carrier and then lists only that carrier's services", () => {
    const before = render();
    expect(before).toMatch(/<select[^>]*id="s-service"[^>]*disabled=""|<select[^>]*disabled=""[^>]*id="s-service"/);
    expect(textOf(before)).toContain("Choose a carrier first.");
    const after = render({ form: { ...model.EMPTY_STATS_FORM, carrierCode: "ups" } });
    expect(after).toContain("UPS: UPS Ground");
    expect(after).not.toContain("USPS: USPS Ground Advantage");
    expect(after).not.toMatch(/<select[^>]*id="s-service"[^>]*disabled=""/);
  });

  it("while working: a busy button, a status line, and the result region says it is busy", () => {
    const out = render({ outcome: { kind: "pending" } });
    expect(out).toMatch(/<button[^>]*aria-busy="true"[^>]*>/);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(`<p role="status" class="text-sm text-muted">${STATS_PENDING}</p>`);
  });

  it("with a result: the statistics, under a live region", () => {
    const stats = statistics(charges(20), [baseline()]);
    const out = render({ outcome: { kind: "ok", stats, scopeName: "Alpha Apparel", recordsRead: 20 } });
    expect(out).toContain('aria-live="polite"');
    expect(textOf(out)).toContain("How often adjustments happen");
    expect(textOf(out)).toContain("2.0000%");
  });

  it("refused: the engine's sentence as a warning, with the link to fix packages shipped", () => {
    const out = render({ outcome: { kind: "refused", refusal: { engineVersion: "x", status: "refused", code: "baselines_overlap", message: "Two baselines for the same scope cover some of the same days; they cannot be added." } } });
    expect(textOf(out)).toContain("These statistics cannot be worked out as asked");
    expect(textOf(out)).toContain("Two baselines for the same scope cover some of the same days; they cannot be added.");
    expect(out).toContain('href="/app/adjustments/history/baselines"');
  });

  it("a failed call is an alert that takes focus; a bad filter is a field error", () => {
    const failed = render({ outcome: { kind: "problem", message: "Your history could not be read. Please try again.", attempt: 1 } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('tabindex="-1"');
    expect(textOf(failed)).toContain("Your history could not be read. Please try again.");
    const bad = render({ errors: { window: "The window ends before it starts.", maturityDays: "Enter a whole number of days from 0 to 3,650, or leave it empty." } });
    expect(bad).toContain('aria-invalid="true"');
    expect(textOf(bad)).toContain("The window ends before it starts.");
    expect(accessibleNames(bad)).toEqual([]);
  });

  it("is well formed for assistive technology, with and without a result", () => {
    const stats = statistics([...charges(20), ...credits(5)], [baseline()]);
    for (const out of [render(), render({ outcome: { kind: "ok", stats, scopeName: "Alpha Apparel", recordsRead: 25 } }), render({ errors: { window: "x", maturityDays: "y" } })]) {
      expect(idProblems(out)).toEqual([]);
      expect(unnamedControls(out)).toEqual([]);
    }
  });

  it("never calls the 3PL's own amounts a cost, a loss, a margin or a profit", () => {
    expect(bannedIn(textOf(render()))).toEqual([]);
    expect(TODAY).toBe("2026-10-17");
  });
});
