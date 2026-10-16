import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { evaluateMinimums, NOT_IN_SCHEDULE_NAME } from "@/engine/fees";
import type { FeeScheduleSnapshot } from "@/engine/fees/types";
import type { BulkSummary } from "@/engine/modeling";
import { allocationBasisSentence, defaultView, headlineFigures, headlineReason, minimumViews, monthlyCharges, notIncludedGroups, pricedVolumeNote, type HeadlineInput } from "@/lib/modeling/headline";
import { fakeSupabase } from "../fixtures/forecast/fake-supabase";
import { A, B, C, D2, complete, finalize, forecast, lowCoverage, noContent, noMinimumRun, noSchedule, noStorageAnswer, noVolume, notEffective, oneMonth, partialForecast, returnsRun, schedule, skipped, undated, zeroVolume } from "../fixtures/modeling/fee-runs";
import { leanAssumptions, leanColumns } from "../fixtures/modeling/summary-columns";

/**
 * The lists, tiles and overview read the headline inputs of a run's summary, never the whole summary (a file run
 * carries every breakdown and the line dictionary, a forecast its grid of cells). These tests pin that the select
 * asks for no more than the headline needs, that what comes back rebuilds exactly the figures the whole summary
 * gives, and, for the results screens that must not carry identifiers, that no React key is a rule key.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/modeling", () => ({
  advanceRun: vi.fn(),
  archiveScenario: vi.fn(),
  cancelRun: vi.fn(),
  createBulkScenario: vi.fn(),
  discardDataset: vi.fn(),
  materialiseDataset: vi.fn(),
  renameScenario: vi.fn(),
  rerunScenario: vi.fn(),
  saveOrderMapping: vi.fn(),
  saveSingleScenario: vi.fn(),
  shareDataset: vi.fn(),
  shareScenario: vi.fn(),
  uploadOrderFile: vi.fn(),
  uploadSkuProfiles: vi.fn(),
}));

// The results components share money formatting with the calculator, whose module graph reaches the actions and the session.
vi.mock("@/app/actions/surcharges", () => ({ addSurchargeRuleVersion: vi.fn(), createSurchargeRule: vi.fn(), retireRuleVersion: vi.fn(), uploadZipList: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getUser: async () => null, getContext: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

const queries = await import("@/lib/modeling/queries");
const results = await import("@/components/modeling/run-results");
const { scrubForecast } = await import("@/components/forecast/result-model");

const BRAND = "77777777-7777-4777-8777-777777777777";

const fileSummaries: [string, BulkSummary][] = [
  ["complete", complete],
  ["no storage answer", noStorageAnswer],
  ["no minimum", noMinimumRun],
  ["undated orders", undated],
  ["low coverage", lowCoverage],
  ["fees skipped", skipped],
  ["no schedule", noSchedule],
  ["no order content", noContent],
  ["not effective", notEffective],
  ["zero volume", zeroVolume],
  ["no volume", noVolume],
  ["one month", oneMonth],
  ["returns rate", returnsRun],
];
const forecastSummaries = [
  ["forecast", forecast()],
  ["partial forecast", partialForecast()],
] as const;

const HEADLINE_VIEWS = ["shipping", "fees", "allin"] as const;

describe("the lists' select", () => {
  /** A client that records the select list of each table it is asked for and answers with the rows it is given. */
  function recording(projects: unknown[]) {
    const selects: Record<string, string> = {};
    const client = {
      from(table: string) {
        const b: unknown = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: table === "simulation_projects" ? projects : [], error: null });
              if (prop === "select") return (cols: string) => ((selects[table] = cols), b);
              return () => b;
            },
          },
        );
        return b;
      },
    };
    return { client: client as never, selects };
  }

  it("asks for the headline inputs as JSON paths of the summary, and for neither the whole summary nor the whole assumptions", async () => {
    const { client, selects } = recording([]);
    await queries.loadModelingLists(client, BRAND);
    const select = selects.simulation_projects!;
    expect(select).toContain("simulation_runs(");
    for (const [alias, path] of queries.SUMMARY_PARTS) expect(select).toContain(`${alias}:summary->${path}`);
    expect(select).toContain("a_overrideAllServices:assumptions->overrideAllServices");
    // A bare `summary` or `assumptions` column would bring back the whole document.
    expect(select).not.toMatch(/(^|[\s(,])summary([\s),]|$)/);
    expect(select).not.toMatch(/(^|[\s(,])assumptions([\s),]|$)/);
    for (const heavy of ["partial_summary", "single_result", "single_input", "reference_data"]) expect(select).not.toContain(heavy);
    // Every part names something the headline reads: nothing that is only a breakdown.
    for (const breakdown of ["byZone", "byService", "byMonth", "byWeightBracket", "bySurcharge", "dictionary", "feeDictionary", "cells", "totals", "exposure", "byRule"]) expect(select).not.toContain(`->${breakdown}`);
  });

  it("rebuilds the runs of each project, newest first, without any select column left on them", async () => {
    const row = (id: string, created: string, summary: unknown, over: Record<string, unknown> = {}) => ({
      id,
      status: "completed",
      kind: "bulk",
      pricing_basis: "fixed_date",
      as_of_date: "2026-03-15",
      created_at: created,
      finished_at: created,
      last_progress_at: created,
      total_shipments: 4,
      processed_shipments: 4,
      modeled_orders: 4,
      total_expected: "50.00",
      service_override_id: null,
      shipping_services: null,
      ...leanColumns(summary),
      ...leanAssumptions(null),
      ...over,
    });
    const project = { id: "p1", kind: "bulk", name: "March plan", created_at: "2026-10-14T09:00:00Z", shared_with_brand: true, archived_at: null, dataset_id: "d-1", rate_cards: { name: "Fixture card" }, order_datasets: { name: "March orders" }, simulation_runs: [row("r-old", "2026-10-13T09:00:00Z", complete), row("r-new", "2026-10-14T09:00:00Z", noStorageAnswer, { ...leanAssumptions({ overrideAllServices: true }) })] };
    const { projects } = await queries.loadModelingLists(fakeSupabase({ tables: { order_datasets: [], simulation_projects: [project] } }), BRAND);
    const runs = projects[0]!.simulation_runs;
    expect(runs.map((r) => r.id)).toEqual(["r-new", "r-old"]);
    for (const r of runs) expect(Object.keys(r).filter((k) => k.startsWith("s_") || k.startsWith("a_"))).toEqual([]);
    expect(queries.isWhatIf(runs[0]!)).toBe(true);
    expect(queries.isWhatIf(runs[1]!)).toBe(false);
    expect(runs[1]!.summary && "fees" in runs[1]!.summary ? runs[1]!.summary.fees.mode : null).toBe("modeled");
    expect(queries.fileSummaryOf(runs[1]!)).not.toBeNull();
    expect(queries.forecastSummaryOf(runs[1]!)).toBeNull();
  });

  it("is smaller than the whole summary: a forecast's grid of cells is not selected", () => {
    const whole = forecast();
    const lean = leanColumns(whole);
    expect(whole.cells.length).toBeGreaterThan(0);
    expect(JSON.stringify(lean)).not.toContain(whole.cells[0]![0]);
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(whole).length * 0.6);
    expect(JSON.stringify(leanColumns(complete)).length).toBeLessThan(JSON.stringify(complete).length * 0.6);
  });
});

describe("the headline inputs rebuilt from the selected columns give the figures of the whole summary", () => {
  const rebuilt = (summary: unknown): HeadlineInput => {
    const lean = queries.summaryFromColumns(leanColumns(summary));
    expect(lean, "the summary must rebuild").not.toBeNull();
    return lean!;
  };
  const all: [string, HeadlineInput][] = [...fileSummaries, ...forecastSummaries].map(([name, s]) => [name, s]);

  for (const [name, whole] of all) {
    it(name, () => {
      const lean = rebuilt(whole);
      for (const view of HEADLINE_VIEWS) {
        expect(headlineFigures(lean, view, { addHref: "#run-again" }), view).toEqual(headlineFigures(whole, view, { addHref: "#run-again" }));
        expect(headlineFigures(lean, view, {}, "staff"), `${view} (staff)`).toEqual(headlineFigures(whole, view, {}, "staff"));
      }
      expect(defaultView(lean)).toBe(defaultView(whole));
      expect(headlineReason(headlineFigures(lean, "allin"))).toBe(headlineReason(headlineFigures(whole, "allin")));
      expect(monthlyCharges(lean)).toEqual(monthlyCharges(whole));
      expect(minimumViews(lean)).toEqual(minimumViews(whole));
      expect(notIncludedGroups(lean, { addHref: "#a" })).toEqual(notIncludedGroups(whole, { addHref: "#a" }));
      expect(allocationBasisSentence(lean)).toBe(allocationBasisSentence(whole));
      expect(pricedVolumeNote(lean)).toBe(pricedVolumeNote(whole));
    });
  }
});

describe("what is not rebuilt", () => {
  it("is null for no summary, a summary of an older shape, and a document that lacks something the headline needs", () => {
    expect(queries.summaryFromColumns({})).toBeNull();
    expect(queries.summaryFromColumns(leanColumns(null))).toBeNull();
    // A model priced before fulfillment fees existed (version 1): the lists say to run it again.
    expect(queries.summaryFromColumns(leanColumns({ version: 1, modeled: { orders: 4 }, totals: { expected: "50.00" } }))).toBeNull();
    const { fees: _fees, ...noFees } = complete as unknown as Record<string, unknown>;
    expect(queries.summaryFromColumns(leanColumns(noFees))).toBeNull();
    const { shipping: _shipping, ...noShipping } = forecast() as unknown as Record<string, unknown>;
    expect(queries.summaryFromColumns(leanColumns(noShipping))).toBeNull();
  });

  it("the run's kind still decides which kind of summary a row has", () => {
    const fileRow = { kind: "bulk", summary: queries.summaryFromColumns(leanColumns(complete)) };
    const forecastRow = { kind: "forecast", summary: queries.summaryFromColumns(leanColumns(forecast())) };
    expect(queries.fileSummaryOf(fileRow)).not.toBeNull();
    expect(queries.forecastSummaryOf(fileRow)).toBeNull();
    expect(queries.forecastSummaryOf(forecastRow)).not.toBeNull();
    expect(queries.fileSummaryOf(forecastRow)).toBeNull();
    expect(queries.fileSummaryOf({ kind: "single", summary: fileRow.summary })).toBeNull();
  });
});

describe("loadRunsForCompare", () => {
  it("returns the whole summaries and assumptions of the runs asked for, and null when one is missing or the read fails", async () => {
    const rows = [
      { id: "r1", kind: "bulk", summary: complete, assumptions: { fulfillment: { drivers: { pallets: "10" } } } },
      { id: "r2", kind: "forecast", summary: forecast(), assumptions: {} },
      { id: "r3", kind: "bulk", summary: { version: 1 }, assumptions: {} },
    ];
    const ok = await queries.loadRunsForCompare(fakeSupabase({ tables: { simulation_runs: rows } }), BRAND, ["r1", "r2"]);
    expect([...ok!.keys()]).toEqual(["r1", "r2"]);
    expect(ok!.get("r1")!.summary).toBe(complete);
    expect(await queries.loadRunsForCompare(fakeSupabase({ tables: { simulation_runs: rows } }), BRAND, ["r1", "r3"])).toBeNull();
    expect(await queries.loadRunsForCompare(fakeSupabase({ tables: { simulation_runs: rows } }), BRAND, ["r1", "nope"])).toBeNull();
    expect(await queries.loadRunsForCompare(fakeSupabase({ errors: { simulation_runs: { message: "boom" } } }), BRAND, ["r1"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// An account-minimum member whose rule is gone is never named by its key
// ---------------------------------------------------------------------------
describe("an account minimum whose member is no longer on the schedule", () => {
  const GONE = "retired_storage_rule";
  const withGone = (): FeeScheduleSnapshot => ({ ...schedule, rules: schedule.rules.map((r) => (r.basis === "minimum" ? { ...r, resolvedRuleKeys: [...(r.resolvedRuleKeys ?? []), GONE] } : r)) });

  it("is named neutrally by the engine, so no key can reach a stored summary or a screen", () => {
    const summary = finalize([A, B, C, D2], { monthlySchedule: withGone() });
    const member = summary.minimums[0]!.members.find((m) => m.state === "not_in_schedule")!;
    expect(member.name).toBe(NOT_IN_SCHEDULE_NAME);
    expect(NOT_IN_SCHEDULE_NAME).toBe("a rule no longer in the schedule");
    // The key is still the member's identity inside the engine, but no name carries it.
    expect(member.ruleKey).toBe(GONE);
    expect(summary.minimums[0]!.members.map((m) => m.name).join("|")).not.toContain(GONE);
    expect(JSON.stringify(evaluateMinimums([], withGone(), { lines: [], notModeled: [], totalE4: 0, unusedAnswers: [] } as never).map((m) => m.members.map((x) => x.name)))).not.toContain(GONE);
  });

  it("is worded the same on the run page whatever name an older stored summary carries", () => {
    const summary = finalize([A, B, C, D2], { monthlySchedule: withGone() });
    const older = { ...summary, minimums: summary.minimums.map((m) => ({ ...m, members: m.members.map((x) => (x.state === "not_in_schedule" ? { ...x, name: GONE } : x)) })) } as BulkSummary;
    for (const s of [summary, older]) {
      const html = renderToStaticMarkup(createElement(results.MinimumCard, { summary: s }));
      expect(html).toContain("A charge that is no longer on the fee schedule");
      expect(html).not.toContain(GONE);
    }
  });

  it("is worded the same on a forecast for a brand: an older stored forecast's key is replaced when the summary is scrubbed", () => {
    const base = forecast();
    const minimum = base.minimums[0] ?? ({ ruleKey: "minimum", name: "Monthly minimum", status: "exact", minimumE4: 5000000, countedE4: 0, topUpE4: 0, buckets: [], members: [], reasons: [], includesShipping: false } as never);
    const stored = { ...base, minimums: [{ ...minimum, members: [{ ruleKey: GONE, name: GONE, state: "not_in_schedule" as const }] }] };
    const scrubbed = scrubForecast(stored, "brand");
    expect(JSON.stringify(scrubbed)).not.toContain(GONE);
    expect(scrubbed.minimums[0]!.members[0]!.name).toBe("A charge that is no longer on the fee schedule");
  });
});

// ---------------------------------------------------------------------------
// React keys travel in the page payload: none of them is a rule key
// ---------------------------------------------------------------------------
/**
 * The keys of every element of a server-rendered tree. Function components are called (they hold no hooks here), host elements
 * are walked: what comes out is what the serialised page carries, which is how a rule key once reached the customer
 * through `key={rule.key}` although nothing printed it.
 */
function keysOf(node: ReactNode, into: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) keysOf(child, into);
    return into;
  }
  if (!isValidElement(node)) return into;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.key !== null) into.push(String(element.key));
  if (typeof element.type === "function") keysOf((element.type as (props: unknown) => ReactNode)(element.props), into);
  else keysOf(element.props.children, into);
  return into;
}

describe("the run page's results carry no rule key in any React key", () => {
  const SURCHARGE_KEY = "fuel_surcharge_rule";
  const surchargeBucket = (name: string, key: string) => ({
    key,
    name,
    scope: "carrier" as const,
    charged: { shipments: 2, definite: "4.00", estimated: "0.00" },
    unknown: { shipments: 0, amount: "0.00" },
    conditional: { shipments: 0, amount: "0.00" },
    waived: { shipments: 0 },
    included: { shipments: 0 },
  });

  it("surcharge rows and the warning rows are keyed by position, never by the surcharge rule's key", () => {
    const summary = {
      ...complete,
      byService: [{ serviceId: "svc-ups-ground-id", name: "UPS Ground", orders: 4, shipments: 4, expected: "50.00", sharePct: "100.0" }],
      bySurcharge: [surchargeBucket("Fuel", SURCHARGE_KEY)],
      warnings: [{ code: "rule_overridden", ruleKey: SURCHARGE_KEY, shipments: 2 }],
      exclusions: [],
    } as unknown as BulkSummary;
    const keys = [...keysOf(createElement(results.RunBreakdowns, { summary })), ...keysOf(createElement(results.RunExclusions, { summary, fixHref: null, staff: false }))];
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      expect(key, key).not.toContain(SURCHARGE_KEY);
      expect(key, key).not.toContain("svc-ups-ground-id");
    }
    // And what is printed names the rows in words.
    const html = renderToStaticMarkup(createElement(results.RunBreakdowns, { summary }));
    expect(html).toContain("Fuel");
    expect(html).not.toContain(SURCHARGE_KEY);
  });
});
