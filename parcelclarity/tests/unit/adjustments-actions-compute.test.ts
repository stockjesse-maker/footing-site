import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PricingContext } from "@/engine/types";
import { BASIS_REQUIRED_MESSAGE, PUBLISH_REFUSALS } from "@/lib/adjustments/action-schemas";
import {
  BRAND,
  BRAND_B,
  CARD,
  CARD_VERSION,
  ESTIMATE,
  EXAMPLE,
  FOREIGN_BRAND,
  IMPORT,
  NEW_ID,
  OTHER_TENANT,
  RUN,
  SCENARIO,
  TENANT,
  UPS_2DA,
  UPS_GROUND,
  USPS_GA,
  adminSession,
  brandSession,
  fixtureJson,
  makeDb,
  type FakeDb,
  type RpcHandler,
  type Row,
} from "./adjustments-actions-support";
import { buildContext, fixture, mismatches, type RulesFile } from "./adjustments-engine-support";

/**
 * The adjustment server actions that calculate: history statistics, the example builder, sharing an example with a customer and the risk
 * estimate. The session, the database client, the rate limiter and the pricing loader are replaced; the engine, the import library and the
 * schemas are the real ones. The hand-derived goldens (tests/fixtures/adjustments, written before the engine existed) run THROUGH the actions:
 * every history case through the bulk reader, every expressible example, every risk case, so what the screens show is what the goldens say.
 */
const h = vi.hoisted(() => ({
  ctx: null as unknown,
  db: null as unknown,
  limitOk: true,
  limits: [] as string[],
  revalidated: [] as unknown[][],
  loads: [] as Record<string, unknown>[],
  snapshot: null as unknown,
  fees: { status: "no_schedule" } as unknown,
  feeCalls: [] as unknown[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => h.revalidated.push(args) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => undefined, getContext: async () => h.ctx, requireBrandContext: async () => h.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as { client: unknown }).client }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITED_MESSAGE: "limited",
  withinRateLimit: async (_c: unknown, action: string) => {
    h.limits.push(action);
    return h.limitOk;
  },
}));
vi.mock("@/lib/pricing/catalog", () => ({ loadServiceCatalog: async () => [] }));
vi.mock("@/lib/pricing/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pricing/snapshot")>()),
  loadPricingContext: async (_s: unknown, opts: Record<string, unknown>) => {
    h.loads.push(opts);
    return h.snapshot;
  },
}));
vi.mock("@/lib/fees/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fees/queries")>()),
  loadBrandFeeSchedule: async (_s: unknown, brandId: string, date: string) => {
    h.feeCalls.push([brandId, date]);
    return h.fees;
  },
}));

const actions = await import("@/app/actions/adjustments");

const db = () => h.db as FakeDb;
const install = (opts: Parameters<typeof makeDb>[0] = {}) => {
  h.db = makeDb(opts);
  return h.db as FakeDb;
};

/** "Today" is 16 October 2026 (the dates of the goldens). Only the clock is faked; timers and promises are real. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  h.ctx = adminSession;
  h.limitOk = true;
  h.limits = [];
  h.revalidated = [];
  h.loads = [];
  h.feeCalls = [];
  h.fees = { status: "no_schedule" };
  h.snapshot = snapshot();
  install();
});
afterEach(() => {
  vi.useRealTimers();
});

const BRAND_C = "99999999-aaaa-4aaa-8aaa-999999999999";
const ruleFile = fixture<RulesFile>("rules.json");
const scenariosFile = fixtureJson<{
  policyProfiles: Record<string, Record<string, Record<string, string>>>;
  scenarios: { id: string; context: string; policy: string; input: { shipment: Record<string, unknown> & { packages: Record<string, string>[] }; corrections: Record<string, string>[]; declaredSource: string } }[];
  historyCases: { id: string; records: string; baselines: string; filters: Record<string, unknown> }[];
  riskCases: { id: string; input: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}>("scenarios.json");
const expectedFile = fixtureJson<{ scenarios: Record<string, unknown>; history: Record<string, unknown>; risk: Record<string, any> }>("expected.json"); // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
const SERVICE_BY_CODE: Record<string, string> = { "ups/ground": UPS_GROUND, "usps/ground_advantage": USPS_GA, "ups/second_day_air": UPS_2DA };
const SERVICE_ID_BY_FIXTURE: Record<string, string> = { "svc-ups-ground": UPS_GROUND, "svc-usps-ga": USPS_GA, "svc-ups-2da": UPS_2DA };

/** The fixture rate card plus a profile's fee rules (RULES.md A0), with real ids for its services. */
function pricing(profile = "reweight_flat"): PricingContext {
  const base = buildContext(ruleFile.contexts[profile]!, ruleFile.rules);
  const remap = (id: string) => SERVICE_ID_BY_FIXTURE[id] ?? id;
  return { ...base, rateCard: { ...base.rateCard, rateCardId: CARD, versionId: CARD_VERSION, services: base.rateCard.services.map((s) => ({ ...s, serviceId: remap(s.serviceId) })), rows: base.rateCard.rows.map((r) => ({ ...r, serviceId: remap(r.serviceId) })) } };
}

function snapshot(profile = "reweight_flat", over: Record<string, unknown> = {}) {
  const context = pricing(profile);
  return {
    ok: true as const,
    snapshot: {
      context,
      version: { id: CARD_VERSION, versionNumber: 3, effectiveDate: "2026-01-01", expirationDate: null, status: "active" },
      services: context.rateCard.services.map((s) => ({ serviceId: s.serviceId, carrierCode: s.carrierCode, serviceCode: s.serviceCode, serviceName: s.serviceName })),
      tenantId: TENANT,
      issues: [],
      issueVersionIds: [],
      pins: { rateCardVersionId: CARD_VERSION, ruleVersionIds: context.rules.map((r) => r.versionId), zipListIds: [], overrideIds: ["0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"] },
      ...over,
    },
  };
}

const assignment = (over: Row = {}): Row => ({ rate_card_id: CARD, brand_id: BRAND, allowed_service_ids: null, unassigned_at: null, rate_cards: { id: CARD, name: "Fixture rate card", status: "active" }, ...over });
const brandsTable = (): Row[] => [
  { id: BRAND, tenant_id: TENANT, name: "Alpha Apparel", status: "active" },
  { id: BRAND_B, tenant_id: TENANT, name: "Beta Beverages", status: "active" },
  { id: BRAND_C, tenant_id: TENANT, name: "Gamma Goods", status: "active" },
  { id: FOREIGN_BRAND, tenant_id: OTHER_TENANT, name: "Somebody Else", status: "active" },
];

/** Decision rows from a golden policy profile (`{type: {component: handling}}`), in effect since January 2026. */
function policyRows(profile: Record<string, Record<string, string>> | null, brandId: string | null = null, tenant = TENANT): Row[] {
  const rows: Row[] = [];
  let n = 0;
  for (const [type, components] of Object.entries(profile ?? {})) {
    for (const [component, handling] of Object.entries(components)) {
      rows.push({ id: `p000000${n++}-0000-4000-8000-000000000000`, tenant_id: tenant, brand_id: brandId, adjustment_type: type, component, handling, valid_from: "2026-01-01", valid_to: null, internal_note: null, created_at: "2026-01-01T00:00:00Z" });
    }
  }
  return rows;
}

const scenarioDb = (opts: { profile?: string; policy?: string | null; extra?: Parameters<typeof makeDb>[0]; rpc?: Record<string, RpcHandler> } = {}) => {
  h.snapshot = snapshot(opts.profile ?? "reweight_flat");
  return install({
    tables: { brands: brandsTable(), brand_rate_card_assignments: [assignment()], adjustment_policies: policyRows(opts.policy === null ? null : (scenariosFile.policyProfiles[opts.policy ?? "all_pt"] ?? null)), ...opts.extra?.tables },
    rpc: opts.rpc,
    ...(opts.extra ? { errors: opts.extra.errors, inserted: opts.extra.inserted } : {}),
  });
};

/** The builder's form for a golden scenario when the form can express it; null when it cannot (the form refuses it before pricing). */
function formFor(c: (typeof scenariosFile.scenarios)[number], brandId: string | null = BRAND): Record<string, unknown> | null {
  const { shipment, corrections, declaredSource } = c.input;
  if (corrections.length !== shipment.packages.length) return null;
  const positive = (v?: string) => v === undefined || Number(v) > 0;
  const dims = (p: Record<string, string>) => [p.length, p.width, p.height].filter((x) => x !== undefined).length;
  for (const p of shipment.packages) if (!positive(p.weight) || (dims(p) !== 0 && dims(p) !== 3)) return null;
  for (const x of corrections) if (!positive(x.weight) || (dims(x) !== 0 && dims(x) !== 3) || (x.weightUnit !== undefined && x.weight === undefined)) return null;
  const serviceId = SERVICE_BY_CODE[`${shipment.carrierCode}/${shipment.serviceCode}`];
  if (!serviceId) return null;
  return {
    brandId,
    serviceId,
    shipDate: shipment.shipDate,
    originZip: shipment.originZip,
    destinationZip: shipment.destinationZip,
    residential: shipment.residential,
    declaredSource,
    packages: shipment.packages.map((p, i) => ({ declared: p, correction: corrections[i] })),
  };
}

const e2Form = () => formFor(scenariosFile.scenarios.find((s) => s.id === "e2_reweight_bracket_crossing")!)!;

// ---------------------------------------------------------------------------
// History statistics: every golden case through the bulk reader
// ---------------------------------------------------------------------------
const SYMBOLS: Record<string, string> = { "brand-a": BRAND, "brand-b": BRAND_B, "brand-c": BRAND_C, ...SERVICE_ID_BY_FIXTURE };
const baselineSets = fixtureJson<{ baselineSets: Record<string, Record<string, unknown>[]> }>("history-baselines.json").baselineSets;
const recordSets = fixtureJson<{ recordSets: Record<string, Record<string, unknown>[]> }>("history-records.json").recordSets;
Object.values(baselineSets).forEach((set) => set.forEach((b, i) => (SYMBOLS[b.id as string] ??= `b${String(Object.keys(SYMBOLS).length).padStart(7, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`)));

const deepMap = (v: unknown): unknown => (typeof v === "string" ? (SYMBOLS[v] ?? v) : Array.isArray(v) ? v.map(deepMap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepMap(x)])) : v);

/** What the bulk reader answers for one import: its records in row order, paged by the call's own arguments. */
const bulkReader = (rows: Record<string, unknown>[], calls: { from: number; limit: number }[] = []) => (args: Record<string, unknown>) => {
  calls.push({ from: args.p_from as number, limit: args.p_limit as number });
  return { data: rows.filter((r) => (r.rowNo as number) >= (args.p_from as number)).slice(0, args.p_limit as number), error: null };
};
const asBulk = (records: Record<string, unknown>[]) => records.map((r, i) => ({ ...(deepMap(r) as Record<string, unknown>), rowNo: i + 1 }));
const baselineRows = (set: Record<string, unknown>[]): Row[] =>
  set.map((b) => ({ id: SYMBOLS[b.id as string], tenant_id: TENANT, brand_id: b.brandId ? SYMBOLS[b.brandId as string] : null, carrier_code: b.carrierCode, service_id: b.serviceId ? SYMBOLS[b.serviceId as string] : null, period_start: b.periodStart, period_end: b.periodEnd, packages_total: b.packagesTotal, labels_missing_weight: b.labelsMissingWeight, note: null, created_at: "2026-01-01T00:00:00Z" }));
const committedImport = (id: string, count: number, over: Row = {}): Row => ({ id, tenant_id: TENANT, name: "history", status: "committed", row_count: count, accepted_count: count, committed_count: count, skipped_count: 0, attested_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", committed_at: "2026-10-01T00:00:00Z", range_min: null, range_max: null, ...over });

describe("loadHistoryStatistics: the hand-derived history goldens, read through the bulk reader", () => {
  it.each(scenariosFile.historyCases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const records = recordSets[c.records]!;
    h.ctx = adminSession;
    install({
      tables: { brands: brandsTable(), adjustment_imports: records.length ? [committedImport(IMPORT, records.length)] : [], adjustment_baselines: baselineRows(baselineSets[c.baselines]!) },
      rpc: { adjustment_records_json: bulkReader(asBulk(records)) },
    });
    const { today: _today, ...filters } = c.filters;
    const r = await actions.loadHistoryStatistics(deepMap(filters));
    const expected = deepMap(expectedFile.history[c.id]) as { status: string };
    if (expected.status === "refused") {
      expect(r.status).toBe("refused");
      if (r.status === "refused") expect(mismatches(r.refusal, expected)).toEqual([]);
    } else {
      expect(r.status).toBe("ok");
      if (r.status === "ok") expect(mismatches(r.statistics, expected)).toEqual([]);
    }
    // Only a summary comes back: never a record.
    expect(JSON.stringify(r)).not.toMatch(/1Z[A-Z]\d{4}|packageRef/);
  });
});

describe("loadHistoryStatistics: reading, scope and refusals", () => {
  const rows = (n: number, over: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${i}`, rowNo: i + 1, brandId: BRAND, shipDate: "2026-01-05", carrierCode: "ups", serviceId: null, adjustmentType: "reweight", cause: "carrier_reweigh", packageRef: `1ZP${String(i).padStart(6, "0")}`, originalCharge: "10.00", correctedCharge: "12.00", separateFee: "3.00", postageDifference: "2.00", ...over }));

  it("pages 2,350 records of one import in calls of 1,000 from the right row, and summarises all of them", async () => {
    const calls: { from: number; limit: number }[] = [];
    install({
      tables: { brands: brandsTable(), adjustment_imports: [committedImport(IMPORT, 2350)], adjustment_baselines: baselineRows([{ id: "bl", brandId: "brand-a", carrierCode: null, serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 100000, labelsMissingWeight: null }]) },
      rpc: { adjustment_records_json: bulkReader(rows(2350), calls) },
    });
    const r = await actions.loadHistoryStatistics({ brandId: BRAND });
    expect(calls).toEqual([{ from: 1, limit: 1000 }, { from: 1001, limit: 1000 }, { from: 2001, limit: 1000 }]);
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.recordsRead).toBe(2350);
    expect(r.statistics).toMatchObject({ scope: "brand", affected: 2350, recordsInScope: 2350, incidence: { k: 2350, N: 100000, pct4dp: "2.3500" } });
    expect(r.importIds).toEqual([IMPORT]);
    expect(r.asOf).toBe("2026-10-16");
    expect(h.limits).toEqual(["adjustment.statistics"]);
  });

  it("pages exactly 1,000 records with one more call that finds nothing, and reads each committed import in turn (in no other state)", async () => {
    const calls: { from: number; limit: number }[] = [];
    const second = "5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e";
    install({
      tables: {
        brands: brandsTable(),
        adjustment_imports: [committedImport(IMPORT, 1000), committedImport(second, 2), committedImport("6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e", 0), { ...committedImport("7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e", 5), status: "validated" }, { ...committedImport("8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e", 5), tenant_id: OTHER_TENANT }],
      },
      rpc: { adjustment_records_json: (args) => (args.p_import === IMPORT ? bulkReader(rows(1000), calls)(args) : { data: rows(2).map((r) => ({ ...r, id: `s${r.id}`, packageRef: `2${r.packageRef}` })), error: null }) },
    });
    const r = await actions.loadHistoryStatistics({ brandId: null });
    expect(calls.map((c) => c.from)).toEqual([1, 1001]);
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.recordsRead).toBe(1002);
    expect(db().rpcNamed("adjustment_records_json").map((a) => a.p_import)).toEqual([IMPORT, IMPORT, second]);
    expect(r.statistics.incidence).toBeNull();
    expect(r.statistics.incidenceReason).toBe("no_baseline");
  });

  it("names the session's workspace in every query it makes", async () => {
    install({ tables: { brands: brandsTable(), adjustment_imports: [committedImport(IMPORT, 1)], adjustment_baselines: [] }, rpc: { adjustment_records_json: { data: [], error: null } } });
    await actions.loadHistoryStatistics({ brandId: BRAND });
    for (const table of ["adjustment_imports", "adjustment_baselines", "brands"]) {
      for (const call of db().on(table)) expect(call.filters, table).toContainEqual({ op: "eq", column: "tenant_id", value: TENANT });
    }
  });

  it("keeps only the records of the chosen customer, carrier, type and cause in memory, and never counts another customer's", async () => {
    const mixed = [...rows(3), ...rows(2, { brandId: BRAND_B, packageRef: undefined, id: "b" }).map((r, i) => ({ ...r, id: `b${i}`, packageRef: `1ZB${i}`, rowNo: 4 + i }))];
    install({ tables: { brands: brandsTable(), adjustment_imports: [committedImport(IMPORT, 5)], adjustment_baselines: [] }, rpc: { adjustment_records_json: bulkReader(mixed) } });
    const r = await actions.loadHistoryStatistics({ brandId: BRAND });
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.statistics.recordsInScope).toBe(3);
    expect(r.recordsRead).toBe(5);
  });

  it("refuses a customer of another account and a request that is not a statistic, before reading any history", async () => {
    install({ tables: { brands: brandsTable() } });
    expect(await actions.loadHistoryStatistics({ brandId: FOREIGN_BRAND })).toEqual({ status: "error", message: "Customer not found." });
    expect(await actions.loadHistoryStatistics({ brandId: BRAND, window: { from: "2026-02-01", to: "2026-01-01" } })).toMatchObject({ status: "invalid", problems: [expect.stringContaining("ends before it starts")] });
    expect(await actions.loadHistoryStatistics({ brandId: BRAND, cause: "magic" })).toMatchObject({ status: "invalid" });
    expect(await actions.loadHistoryStatistics({ brandId: BRAND, tenantId: OTHER_TENANT })).toMatchObject({ status: "invalid" });
    expect(db().rpcs).toEqual([]);
  });

  it("says when the history cannot be read (a page fails) instead of reporting fewer records, and honours the rate limit", async () => {
    install({ tables: { brands: brandsTable(), adjustment_imports: [committedImport(IMPORT, 5)], adjustment_baselines: [] }, rpc: { adjustment_records_json: { data: null, error: { code: "XX000", message: "SECRET detail" } } } });
    const r = await actions.loadHistoryStatistics({ brandId: BRAND });
    expect(r).toEqual({ status: "error", message: "Your history could not be read. Please try again." });
    h.limitOk = false;
    expect(await actions.loadHistoryStatistics({ brandId: BRAND })).toEqual({ status: "error", message: "limited" });
  });

  it("refuses to read history larger than an account can hold, rather than truncate it", async () => {
    install({
      tables: { brands: brandsTable(), adjustment_imports: [committedImport(IMPORT, 200_000), committedImport("5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e", 60_000)], adjustment_baselines: [] },
      rpc: { adjustment_records_json: (args) => ({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, rowNo: (args.p_from as number) + i, brandId: BRAND, shipDate: "2026-01-05", carrierCode: "ups", adjustmentType: "reweight", cause: "other", packageRef: null, originalCharge: null, correctedCharge: null, separateFee: null, postageDifference: null })), error: null }) },
    });
    // A reader that never returns a short page (a broken function) ends in an error, not a hang or a partial statistic.
    expect(await actions.loadHistoryStatistics({ brandId: BRAND })).toMatchObject({ status: "error" });
  });
});

// ---------------------------------------------------------------------------
// Examples: every expressible golden through the action
// ---------------------------------------------------------------------------
describe("evaluateScenario: the hand-derived scenario goldens, priced through the action", () => {
  const runnable = scenariosFile.scenarios.map((c) => [c, formFor(c)] as const).filter(([, f]) => f !== null);

  it("covers most of the golden catalogue (the rest cannot be typed into the form, which refuses them first)", () => {
    expect(runnable.length).toBeGreaterThanOrEqual(45);
    expect(scenariosFile.scenarios.length).toBe(61);
  });

  it.each(runnable.map(([c, f]) => [c.id, c, f] as const))("%s", async (_id, c, form) => {
    scenarioDb({ profile: c.context, policy: c.policy });
    const r = await actions.evaluateScenario(form);
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    // `messageContains` is the golden's own list of phrases the message must hold (it is not a field of the result).
    const { messageContains, ...expected } = expectedFile.scenarios[c.id] as Record<string, unknown> & { messageContains?: string[] };
    expect(mismatches(r.result, expected)).toEqual([]);
    for (const phrase of messageContains ?? []) expect(r.result.message ?? "").toContain(phrase);
    expect(r.context).toMatchObject({ brandId: BRAND, brandName: "Alpha Apparel", rateCardId: CARD, rateCardVersionNumber: 3, pricedOn: c.input.shipment.shipDate });
  });
});

describe("evaluateScenario", () => {
  it("prices in the customer's own context with the unfiltered rule set, for the date asked, on the service asked", async () => {
    scenarioDb();
    const r = await actions.evaluateScenario(e2Form());
    expect(r.status).toBe("ok");
    expect(h.loads).toEqual([{ rateCardId: CARD, shipDate: "2026-10-15", brandId: BRAND, serviceIds: [UPS_GROUND], adjustmentView: true }]);
    expect(h.limits).toEqual(["adjustment.evaluate"]);
    expect(db().writes()).toEqual([]);
    expect(db().rpcs).toEqual([]);
  });

  it("prices for today when no date is given, and takes the customer from the form only after checking it against the workspace", async () => {
    scenarioDb();
    const { shipDate: _d, ...noDate } = e2Form();
    await actions.evaluateScenario(noDate);
    expect(h.loads[0]).toMatchObject({ shipDate: "2026-10-16" });
    expect(db().on("brands")[0]!.filters).toContainEqual({ op: "eq", column: "tenant_id", value: TENANT });
    expect(db().on("brand_rate_card_assignments")[0]!.filters).toContainEqual({ op: "eq", column: "brand_id", value: BRAND });
  });

  it("resolves who pays for TODAY, from the decisions of this workspace, not from the pricing date", async () => {
    // A decision that started after the pricing date (5 Oct) but before today (16 Oct) is the one in force.
    scenarioDb({ policy: null, extra: { tables: { adjustment_policies: [...policyRows({ reweight: { postage_difference: "absorbed" } }).map((r) => ({ ...r, valid_from: "2026-10-10" })), ...policyRows({ reweight: { postage_difference: "pass_through" } }, null, OTHER_TENANT)] } } });
    const r = await actions.evaluateScenario(e2Form());
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.result.components!.postage_difference.handling).toBe("absorbed");
    // The other workspace's decision never applied; nothing is decided for the separate fee.
    expect(r.result.components!.separate_fee.handling).toBe("unconfigured");
  });

  it("passes on the fee schedule's count of percent-of-shipping fees as a notice, and refuses when the schedule cannot be read", async () => {
    scenarioDb();
    h.fees = { status: "ok", assignment: null, schedule: { id: "s", name: "Std", description: null }, activeVersion: { rules: [{ scope: "order", basis: "shipping_percent" }, { scope: "order", basis: "shipping_percent" }, { scope: "order", basis: "package" }, { scope: "monthly", basis: "month" }] } };
    const r = await actions.evaluateScenario(e2Form());
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.result.notices).toContainEqual(expect.objectContaining({ code: "percent_of_shipping_fees_not_modelled", count: 2 }));
    expect(h.feeCalls).toEqual([[BRAND, "2026-10-15"]]);
    h.fees = { status: "load_failed" };
    expect(await actions.evaluateScenario(e2Form())).toEqual({ status: "error", message: "The customer's fee schedule could not be loaded. Please try again." });
    h.fees = { status: "not_found" };
    expect(await actions.evaluateScenario(e2Form())).toEqual({ status: "error", message: "Customer not found." });
  });

  it("refuses a customer of another account without pricing anything", async () => {
    scenarioDb();
    expect(await actions.evaluateScenario({ ...e2Form(), brandId: FOREIGN_BRAND })).toEqual({ status: "error", message: "Customer not found." });
    expect(h.loads).toEqual([]);
  });

  it("refuses a rate card of another account (a person in two accounts) and a card the customer is not on", async () => {
    scenarioDb();
    h.snapshot = snapshot("reweight_flat", { tenantId: OTHER_TENANT });
    expect(await actions.evaluateScenario(e2Form())).toEqual({ status: "error", message: "That rate card is not available to you." });
    scenarioDb();
    expect(await actions.evaluateScenario({ ...e2Form(), rateCardId: "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1" })).toMatchObject({ status: "invalid", errors: { rateCardId: "That rate card is not assigned to this customer." } });
    scenarioDb({ extra: { tables: { brand_rate_card_assignments: [] } } });
    expect(await actions.evaluateScenario(e2Form())).toMatchObject({ status: "invalid", errors: { rateCardId: expect.stringContaining("No rate card is assigned") } });
  });

  it("says in the form's words when the date has no rates or the service is not on the card or not allowed", async () => {
    scenarioDb();
    h.snapshot = { ok: false, error: "no_version_in_effect" };
    expect(await actions.evaluateScenario(e2Form())).toMatchObject({ status: "invalid", errors: { shipDate: expect.stringContaining("Choose another date") } });
    h.snapshot = { ok: false, error: "load_failed" };
    expect(await actions.evaluateScenario(e2Form())).toEqual({ status: "error", message: "Pricing data could not be loaded right now. Try again in a moment." });
    scenarioDb();
    expect(await actions.evaluateScenario({ ...e2Form(), serviceId: "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2" })).toMatchObject({ status: "invalid", errors: { serviceId: expect.stringContaining("not on the customer's rate card") } });
    scenarioDb({ extra: { tables: { brand_rate_card_assignments: [assignment({ allowed_service_ids: [USPS_GA] })] } } });
    expect(await actions.evaluateScenario(e2Form())).toMatchObject({ status: "invalid", errors: { serviceId: expect.any(String) } });
  });

  it("tries the customer's next card when the first does not carry the service", async () => {
    const second = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
    scenarioDb({ extra: { tables: { brand_rate_card_assignments: [assignment({ rate_card_id: second, rate_cards: { id: second, name: "A second card", status: "active" } }), assignment()] } } });
    let n = 0;
    h.snapshot = null;
    const first = snapshot("reweight_flat", { services: [] });
    const real = snapshot("reweight_flat");
    Object.defineProperty(h, "snapshot", { configurable: true, get: () => (++n === 1 ? first : real), set: () => undefined });
    const r = await actions.evaluateScenario({ ...e2Form(), rateCardId: undefined });
    Object.defineProperty(h, "snapshot", { configurable: true, writable: true, value: real });
    expect(r.status).toBe("ok");
    expect(h.loads.map((l) => l.rateCardId)).toEqual([second, CARD]);
  });

  it("prices an exploration without a customer on a named card of the workspace, and never sees a customer's exceptions", async () => {
    scenarioDb();
    const { brandId: _b, ...rest } = e2Form();
    expect(await actions.evaluateScenario({ ...rest, brandId: null })).toMatchObject({ status: "invalid", errors: { rateCardId: expect.any(String) } });
    const r = await actions.evaluateScenario({ ...rest, brandId: null, rateCardId: CARD });
    expect(r.status).toBe("ok");
    expect(h.loads.at(-1)).toMatchObject({ rateCardId: CARD, brandId: null, adjustmentView: true });
    expect(h.feeCalls).toEqual([]);
  });

  it("returns the engine's own status for an example that cannot be priced, and refuses what the form should have caught", async () => {
    scenarioDb();
    const nothing = await actions.evaluateScenario({ ...e2Form(), packages: [{ declared: { weight: "3", weightUnit: "lb" }, correction: { weight: "3", weightUnit: "lb" } }] });
    expect(nothing).toMatchObject({ status: "ok", result: { status: "invalid_input", message: expect.stringContaining("nothing to correct") } });
    const tooHeavy = await actions.evaluateScenario({ ...e2Form(), packages: [{ declared: { weight: "3", weightUnit: "lb" }, correction: { weight: "151", weightUnit: "lb" } }] });
    expect(tooHeavy).toMatchObject({ status: "ok", result: { status: "corrected_unavailable" } });
    expect(await actions.evaluateScenario({ ...e2Form(), packages: [{ declared: { weight: "0", weightUnit: "lb" }, correction: {} }] })).toMatchObject({ status: "invalid", errors: { packages: expect.any(String) } });
    expect(await actions.evaluateScenario({ ...e2Form(), packages: [] })).toMatchObject({ status: "invalid" });
    expect(await actions.evaluateScenario({ ...e2Form(), packages: Array.from({ length: 21 }, () => ({ declared: { weight: "3", weightUnit: "lb" }, correction: { weight: "4", weightUnit: "lb" } })) })).toMatchObject({ status: "invalid" });
    expect(await actions.evaluateScenario({ ...e2Form(), destinationZip: undefined })).toMatchObject({ status: "invalid", errors: { destinationZip: expect.stringContaining("destination") } });
    expect(await actions.evaluateScenario({ ...e2Form(), declaredSource: "guessed" })).toMatchObject({ status: "invalid" });
    expect(await actions.evaluateScenario({ ...e2Form(), carrierCost: "12.00" })).toMatchObject({ status: "invalid" });
  });

  it("is rate limited", async () => {
    scenarioDb();
    h.limitOk = false;
    expect(await actions.evaluateScenario(e2Form())).toEqual({ status: "error", message: "limited" });
    expect(h.loads).toEqual([]);
  });
});

describe("saveScenario", () => {
  const saved = (profile = "reweight_flat") => scenarioDb({ profile, rpc: { save_adjustment_scenario: { data: SCENARIO, error: null } } });

  it("prices again on the server and stores the engine's own documents, with the session's tenant, the customer and the pins", async () => {
    saved();
    const r = await actions.saveScenario(e2Form(), "  Reweigh 3 lb to 5 lb  ");
    expect(r).toEqual({ ok: true, scenarioId: SCENARIO, message: "Example saved." });
    const [args] = db().rpcNamed("save_adjustment_scenario");
    expect(args).toMatchObject({ p_tenant: TENANT, p_brand: BRAND, p_name: "Reweigh 3 lb to 5 lb", p_type: "reweight", p_engine_version: "adjustments-1.0.0" });
    expect(args!.p_input).toMatchObject({ v: 1, serviceId: UPS_GROUND, residential: false, zone: 5, declaredSource: "entered", declared: { packages: [{ lengthIn: "10.0", widthIn: "8.0", heightIn: "6.0" }] } });
    expect(args!.p_result).toMatchObject({ v: 1, status: "ok", adjustmentType: "reweight", direction: "increase", basis: "exact", components: [expect.objectContaining({ kind: "postage_difference", amount: "0.56" }), expect.objectContaining({ kind: "separate_fee", amount: "3.00" })] });
    expect(args!.p_pins).toMatchObject({ rateCardVersionId: CARD_VERSION, overrideIds: ["0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"], pricedOn: "2026-10-15" });
    expect(h.limits).toEqual(["adjustment.save"]);
    expect(h.revalidated.length).toBeGreaterThan(0);
  });

  it("pins the rules the example depends on: those the engine considers for the service, leaving out fee rules of the other kind", async () => {
    saved("both_flat");
    await actions.saveScenario(e2Form(), "Weight only");
    const weightOnly = db().rpcNamed("save_adjustment_scenario")[0]!.p_pins as { ruleVersionIds: string[] };
    expect(weightOnly.ruleVersionIds).toContain("adj-reweight_flat-1");
    expect(weightOnly.ruleVersionIds).not.toContain("adj-remeasure_flat-1");
    expect(weightOnly.ruleVersionIds.length).toBeGreaterThan(2);
    expect([...weightOnly.ruleVersionIds].sort()).toEqual(weightOnly.ruleVersionIds);
    expect(new Set(weightOnly.ruleVersionIds).size).toBe(weightOnly.ruleVersionIds.length);

    saved("both_flat");
    const dimsOnly = { ...e2Form(), packages: [{ declared: { weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" }, correction: { length: "14", width: "10", height: "8" } }] };
    await actions.saveScenario(dimsOnly, "Dimensions only");
    const pins = db().rpcNamed("save_adjustment_scenario")[0]!.p_pins as { ruleVersionIds: string[] };
    expect(pins.ruleVersionIds).toContain("adj-remeasure_flat-1");
    expect(pins.ruleVersionIds).not.toContain("adj-reweight_flat-1");
    expect(db().rpcNamed("save_adjustment_scenario")[0]!.p_type).toBe("remeasure");
  });

  it("stores an exploration with no customer and no exceptions", async () => {
    saved();
    const { brandId: _b, ...rest } = e2Form();
    expect(await actions.saveScenario({ ...rest, brandId: null, rateCardId: CARD }, "Exploration")).toMatchObject({ ok: true });
    const [args] = db().rpcNamed("save_adjustment_scenario");
    expect(args).toMatchObject({ p_brand: null });
    expect((args!.p_pins as { overrideIds: string[] }).overrideIds).toEqual([]);
  });

  it("refuses to save an example that was not priced, and says why, without calling the database", async () => {
    saved();
    const heavy = { ...e2Form(), packages: [{ declared: { weight: "3", weightUnit: "lb" }, correction: { weight: "151", weightUnit: "lb" } }] };
    const r = await actions.saveScenario(heavy, "Too heavy");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("could not be priced, so it cannot be saved");
    expect(db().rpcNamed("save_adjustment_scenario")).toEqual([]);
    const nothing = await actions.saveScenario({ ...e2Form(), packages: [{ declared: { weight: "3", weightUnit: "lb" }, correction: { weight: "3", weightUnit: "lb" } }] }, "Nothing");
    expect(nothing.ok).toBe(false);
    expect(db().rpcNamed("save_adjustment_scenario")).toEqual([]);
  });

  it("validates the name and the form first, and checks the customer against the workspace", async () => {
    saved();
    expect(await actions.saveScenario(e2Form(), "   ")).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
    expect(await actions.saveScenario(e2Form(), "x".repeat(161))).toMatchObject({ ok: false, errors: { name: expect.stringContaining("at most 160") } });
    expect(await actions.saveScenario({ ...e2Form(), residential: "yes" }, "Name")).toMatchObject({ ok: false });
    expect(await actions.saveScenario({ ...e2Form(), brandId: FOREIGN_BRAND }, "Name")).toEqual({ ok: false, message: "Customer not found." });
    expect(h.loads).toEqual([]);
    expect(db().rpcs).toEqual([]);
  });

  it("reads the database's refusals in words (a decision that changed, a rate card the customer is not on, a full list)", async () => {
    const refuse = async (error: { code: string; message: string }) => {
      scenarioDb({ rpc: { save_adjustment_scenario: { data: null, error } } });
      return actions.saveScenario(e2Form(), "Name");
    };
    expect(await refuse({ code: "PC003", message: "the policy changed while the example was being built; price it again" })).toEqual({ ok: false, message: "The decision on who pays changed while the example was being built. Price it again." });
    expect(await refuse({ code: "P0001", message: "the rate card is not assigned to this customer" })).toEqual({ ok: false, message: "That rate card is not assigned to this customer." });
    expect(await refuse({ code: "P0001", message: "the limit of 200 saved examples is reached; archive some first" })).toMatchObject({ ok: false, message: expect.stringContaining("200 saved examples") });
    expect(await refuse({ code: "P0002", message: "not found" })).toEqual({ ok: false, message: "The customer, rate card or rule was not found." });
    expect(await refuse({ code: "PC001", message: "invalid scenario" })).toMatchObject({ ok: false });
  });
});

describe("archiveScenario", () => {
  it("archives an example of this workspace only", async () => {
    install({ tables: { adjustment_scenarios: [{ id: SCENARIO, tenant_id: TENANT }] }, rpc: { archive_adjustment_scenario: { data: null, error: null } } });
    expect(await actions.archiveScenario(SCENARIO)).toEqual({ ok: true, message: "Example archived." });
    expect(db().rpcNamed("archive_adjustment_scenario")).toEqual([{ p_id: SCENARIO }]);
    install({ tables: { adjustment_scenarios: [{ id: SCENARIO, tenant_id: OTHER_TENANT }] } });
    expect(await actions.archiveScenario(SCENARIO)).toEqual({ ok: false, message: "Example not found." });
    expect(db().rpcs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sharing with a customer
// ---------------------------------------------------------------------------
describe("previewExample, publishExample and retireExample", () => {
  const owned = (over: Parameters<typeof makeDb>[0] = {}) => install({ tables: { adjustment_scenarios: [{ id: SCENARIO, tenant_id: TENANT }], brands: brandsTable(), published_adjustment_examples: [{ id: EXAMPLE, tenant_id: TENANT }] }, ...over });
  const payload = { v: 1, adjustmentType: "reweight", pricedOn: "2026-10-15", input: { service: { carrier: "UPS", service: "UPS Ground" }, direction: "increase", residential: false, zone: 5, declared: { packages: [{ weightLb: "3.0" }] }, corrected: { packages: [{ weightLb: "5.0" }] } }, components: [{ kind: "postage_difference", handling: "pass_through", amount: "0.56", declaredTotal: "12.79", correctedTotal: "13.35" }] };

  it("previews what the customer would read and what is withheld, keeping only the fields it knows", async () => {
    owned({
      rpc: { preview_customer_example: { data: { ok: true, problems: [], payload, hidden: [{ kind: "separate_fee", reason: "absorbed" }], warnings: ["separate_fee_not_configured"], pricedOn: "2026-10-15", ratesEffectiveFrom: "2026-01-01", validThrough: "2026-12-14", pins: { ruleVersionIds: ["SECRET"] }, incidence: "7.3719", absorbed: "91317.29" }, error: null } },
    });
    const r = await actions.previewExample(SCENARIO, BRAND);
    expect(r).toEqual({ ok: true, preview: { ok: true, problems: [], payload, hidden: [{ kind: "separate_fee", reason: "absorbed" }], warnings: ["separate_fee_not_configured"], pricedOn: "2026-10-15", ratesEffectiveFrom: "2026-01-01", validThrough: "2026-12-14" } });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|7\.3719|91317/);
    expect(db().rpcNamed("preview_customer_example")).toEqual([{ p_source: SCENARIO, p_brand: BRAND }]);
  });

  it("returns a refusal to share as data, and refuses a scenario or customer of another account without asking the database", async () => {
    owned({ rpc: { preview_customer_example: { data: { ok: false, problems: [{ code: "estimate_basis", message: "An example built from estimated amounts cannot be shared." }], hidden: [], warnings: [] }, error: null } } });
    expect(await actions.previewExample(SCENARIO, BRAND)).toMatchObject({ ok: true, preview: { ok: false, problems: [{ code: "estimate_basis", message: expect.any(String) }] } });
    install({ tables: { adjustment_scenarios: [{ id: SCENARIO, tenant_id: OTHER_TENANT }], brands: brandsTable() } });
    expect(await actions.previewExample(SCENARIO, BRAND)).toEqual({ ok: false, message: "Example not found." });
    owned();
    expect(await actions.previewExample(SCENARIO, FOREIGN_BRAND)).toEqual({ ok: false, message: "Customer not found." });
    expect(db().rpcs).toEqual([]);
  });

  it("shares an example: only text goes to the database, trimmed, with the ids checked against the workspace", async () => {
    owned({ rpc: { publish_customer_example: { data: EXAMPLE, error: null } } });
    const r = await actions.publishExample({ scenarioId: SCENARIO, brandId: BRAND, title: "  If a 3 lb package is corrected to 5 lb  ", note: " Ask us if anything is unclear. ", validThrough: "2026-11-30", internalNote: "agreed with their ops lead" });
    expect(r).toEqual({ ok: true, exampleId: EXAMPLE, message: "Shared with the customer." });
    expect(db().rpcNamed("publish_customer_example")).toEqual([
      { p_source: SCENARIO, p_brand: BRAND, p_title: "If a 3 lb package is corrected to 5 lb", p_note: "Ask us if anything is unclear.", p_valid_through: "2026-11-30", p_internal_note: "agreed with their ops lead" },
    ]);
    expect(h.revalidated.some((a) => String(a[0]).startsWith("/portal"))).toBe(true);
    // Blank optional text is "none", never an empty string.
    owned({ rpc: { publish_customer_example: { data: EXAMPLE, error: null } } });
    await actions.publishExample({ scenarioId: SCENARIO, brandId: BRAND, title: "A title", note: "  ", validThrough: "", internalNote: "" });
    expect(db().rpcNamed("publish_customer_example")[0]).toMatchObject({ p_note: null, p_valid_through: null, p_internal_note: null });
  });

  it("refuses text a customer must not be shown (angle brackets, hidden characters, a long title, several lines) before the database", async () => {
    owned({ rpc: { publish_customer_example: { data: EXAMPLE, error: null } } });
    const base = { scenarioId: SCENARIO, brandId: BRAND, title: "A title" };
    expect(await actions.publishExample({ ...base, title: "<b>Bold</b>" })).toMatchObject({ ok: false, errors: { title: expect.stringContaining("plain text") } });
    expect(await actions.publishExample({ ...base, title: "Zero width" + String.fromCharCode(0x200b) + "space" })).toMatchObject({ ok: false, errors: { title: expect.any(String) } });
    expect(await actions.publishExample({ ...base, title: "Bell" + String.fromCharCode(7) })).toMatchObject({ ok: false });
    expect(await actions.publishExample({ ...base, title: "x".repeat(121) })).toMatchObject({ ok: false, errors: { title: expect.stringContaining("at most 120") } });
    expect(await actions.publishExample({ ...base, title: "Two\nlines" })).toMatchObject({ ok: false, errors: { title: "Use one line." } });
    expect(await actions.publishExample({ ...base, title: "" })).toMatchObject({ ok: false, errors: { title: expect.any(String) } });
    expect(await actions.publishExample({ ...base, note: "n".repeat(301) })).toMatchObject({ ok: false, errors: { note: expect.stringContaining("at most 300") } });
    expect(await actions.publishExample({ ...base, note: "a > b" })).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
    expect(await actions.publishExample({ ...base, internalNote: "i".repeat(1001) })).toMatchObject({ ok: false, errors: { internalNote: expect.any(String) } });
    expect(await actions.publishExample({ ...base, validThrough: "2026-02-31" })).toMatchObject({ ok: false, errors: { validThrough: expect.any(String) } });
    expect(await actions.publishExample({ ...base, payload: { amount: "1.00" } })).toMatchObject({ ok: false });
    expect(db().rpcs).toEqual([]);
  });

  it("refuses another account's example or customer without asking the database", async () => {
    install({ tables: { adjustment_scenarios: [{ id: SCENARIO, tenant_id: OTHER_TENANT }], brands: brandsTable() } });
    expect(await actions.publishExample({ scenarioId: SCENARIO, brandId: BRAND, title: "T" })).toEqual({ ok: false, message: "Example not found." });
    owned();
    expect(await actions.publishExample({ scenarioId: SCENARIO, brandId: FOREIGN_BRAND, title: "T" })).toEqual({ ok: false, message: "Customer not found." });
    expect(db().rpcs).toEqual([]);
  });

  it("says why an example cannot be shared, for every refusal the database gives (the hint is the code)", async () => {
    for (const [hint, sentence] of Object.entries(PUBLISH_REFUSALS)) {
      owned({ rpc: { publish_customer_example: { data: null, error: { code: "P0001", message: "database wording", hint } } } });
      expect(await actions.publishExample({ scenarioId: SCENARIO, brandId: BRAND, title: "T" }), hint).toEqual({ ok: false, message: sentence });
    }
    const named = (hint: string, message: string) => {
      owned({ rpc: { publish_customer_example: { data: null, error: { code: "P0001", message, hint } } } });
      return actions.publishExample({ scenarioId: SCENARIO, brandId: BRAND, title: "T" });
    };
    expect(await named("undecided_policy", "Decide how the separate adjustment fee is handled for this customer first.")).toEqual({ ok: false, message: "Decide how the separate adjustment fee is handled for this customer first." });
    expect(await named("undecided_policy", "Decide how the shipping charge difference is handled for this customer first.")).toMatchObject({ message: expect.stringContaining("the shipping charge difference") });
    expect(await named("component_below_minimum", "The separate adjustment fee must be at least $0.01 to be shared.")).toEqual({ ok: false, message: "The separate adjustment fee must be at least $0.01 to be shared." });
    expect(await named("component_undecided", "The shipping charge difference could not be decided, so it cannot be shared.")).toMatchObject({ message: "The shipping charge difference could not be decided, so it cannot be shared." });
    expect(await named("", "the limit of 25 shared examples per customer is reached")).toMatchObject({ message: expect.stringContaining("25 shared examples") });
    expect(await named("something_new", "with internal wording 7.3719")).toEqual({ ok: false, message: "That is not allowed right now." });
  });

  it("reads other refusals in words and stops sharing an example of this workspace only", async () => {
    owned({ rpc: { publish_customer_example: { data: null, error: { code: "PC001", message: "the title must be 1 to 120 characters of plain text" } } } });
    expect(await actions.publishExample({ scenarioId: SCENARIO, brandId: BRAND, title: "T" })).toMatchObject({ ok: false, message: expect.stringContaining("Use plain text") });
    owned({ rpc: { retire_customer_example: { data: null, error: null } } });
    expect(await actions.retireExample(EXAMPLE)).toEqual({ ok: true, message: "No longer shared." });
    expect(db().rpcNamed("retire_customer_example")).toEqual([{ p_example: EXAMPLE }]);
    install({ tables: { published_adjustment_examples: [{ id: EXAMPLE, tenant_id: OTHER_TENANT }] } });
    expect(await actions.retireExample(EXAMPLE)).toEqual({ ok: false, message: "Shared example not found." });
    expect(db().rpcs).toEqual([]);
  });

  it("lists the shared examples with the state the database computes now", async () => {
    const row = (id: string, over: Row = {}): Row => ({ id, tenant_id: TENANT, brand_id: BRAND, source_scenario_id: SCENARIO, title: "If a 3 lb package is corrected to 5 lb", note_to_customer: null, internal_note: "private", priced_on: "2026-10-15", rates_effective_from: "2026-01-01", valid_through: "2026-12-14", published_at: "2026-10-15T09:00:00Z", retired_at: null, ...over });
    const second = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
    const third = "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3";
    install({
      tables: { brands: brandsTable(), published_adjustment_examples: [row(EXAMPLE), row(second, { brand_id: BRAND_B }), row(third, { retired_at: "2026-10-16T00:00:00Z" })] },
      rpc: { adjustment_example_states: { data: [{ id: EXAMPLE, brandId: BRAND, state: "current", causes: [] }, { id: second, brandId: BRAND_B, state: "under_review", causes: ["policy_changed", "rate_card_changed"] }], error: null } },
    });
    const r = await actions.listExamples();
    if (!r.ok) throw new Error(r.message);
    expect(r.examples!.map((e) => [e.id, e.state, e.causes, e.brandName])).toEqual([[EXAMPLE, "current", [], "Alpha Apparel"], [second, "under_review", ["policy_changed", "rate_card_changed"], "Beta Beverages"]]);
    expect(db().rpcNamed("adjustment_example_states")).toEqual([{ p_tenant: TENANT }]);
    expect(db().on("published_adjustment_examples")[0]!.filters).toContainEqual({ op: "eq", column: "tenant_id", value: TENANT });
  });

  it("shows a live example the state function did not report as under review, never as current", async () => {
    install({ tables: { brands: brandsTable(), published_adjustment_examples: [{ id: EXAMPLE, tenant_id: TENANT, brand_id: BRAND, source_scenario_id: SCENARIO, title: "T", note_to_customer: null, internal_note: null, priced_on: "2026-10-15", rates_effective_from: "2026-01-01", valid_through: "2026-12-14", published_at: "2026-10-15T09:00:00Z", retired_at: null }] }, rpc: { adjustment_example_states: { data: [], error: null } } });
    const r = await actions.listExamples();
    expect(r.examples![0]).toMatchObject({ state: "under_review", causes: [] });
    install({ tables: { brands: brandsTable() }, rpc: { adjustment_example_states: { data: null, error: { code: "XX000", message: "boom" } } } });
    expect(await actions.listExamples()).toEqual({ ok: false, message: "The shared examples could not be loaded. Please try again." });
  });
});

// ---------------------------------------------------------------------------
// Risk estimate
// ---------------------------------------------------------------------------
const AMOUNT = (e4: number) => (e4 / 10_000).toFixed(4);

/** The form a golden risk case becomes, or null when the form refuses it before any calculation (the schema catches those). */
function riskFormFor(c: (typeof scenariosFile.riskCases)[number]): Record<string, unknown> | null {
  const i = c.input;
  if (!["declared_weights", "actual_weights"].includes(i.basis)) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(String(i.monthlyVolume)) || Number(i.monthlyVolume) > 5_000_000) return null;
  const severity = (s: { source: string; e4: number | null }) => {
    if (s.source === "history") return { source: "history" };
    if (s.e4 !== null && s.e4 < 0) return undefined;
    return { source: "entered", amount: s.e4 === null ? null : AMOUNT(s.e4) };
  };
  const post = severity(i.severity.postage_difference);
  const fee = severity(i.severity.separate_fee);
  if (!post || !fee) return null;
  let incidence: Record<string, unknown>;
  if (i.incidence.source === "entered") {
    const pct = Number(i.incidence.pct);
    if (!(pct >= 0 && pct <= 100)) return null;
    incidence = { source: "entered", pct: i.incidence.pct };
  } else incidence = { source: "history" };
  const usesHistory = incidence.source === "history" || post.source === "history" || fee.source === "history";
  return {
    brandId: null,
    adjustmentType: "reweight",
    basis: i.basis,
    volume: { source: "entered", packagesPerMonth: String(i.monthlyVolume) },
    incidence,
    severity: { postage_difference: post, separate_fee: fee },
    credits: i.credits ? "memo" : "exclude",
    ...(usesHistory ? { history: {} } : {}),
  };
}

/** The database of a golden risk case: policy rows that resolve to the case's handling, and a history that yields its (k, N). */
function riskDbFor(c: (typeof scenariosFile.riskCases)[number]) {
  const i = c.input;
  const handling: Record<string, Record<string, string>> = { reweight: {} };
  for (const comp of ["postage_difference", "separate_fee"]) if (i.handling[comp] !== "unconfigured") handling.reweight![comp] = i.handling[comp];
  const baselines: Row[] = [];
  let records: Record<string, unknown>[] = [];
  if (i.incidence.source === "history" && i.incidence.N > 0) {
    baselines.push({ id: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1", tenant_id: TENANT, brand_id: null, carrier_code: null, service_id: null, period_start: "2026-01-01", period_end: "2026-01-31", packages_total: i.incidence.N, labels_missing_weight: null, note: null, created_at: "2026-01-01T00:00:00Z" });
    // The credits golden has real records (6 charges and 4 credits); every other case counts k packages with no amounts.
    records = c.id === "r5_credits_excluded_from_exposure"
      ? asBulk(recordSets.r5_credits!.map((r) => ({ ...r, brandId: null, shipDate: "2026-01-10" })))
      : Array.from({ length: i.incidence.k }, (_, n) => ({ id: `k${n}`, rowNo: n + 1, brandId: null, shipDate: "2026-01-10", carrierCode: "ups", serviceId: null, adjustmentType: "reweight", cause: "carrier_reweigh", packageRef: `1ZK${n}`, originalCharge: null, correctedCharge: null, separateFee: null, postageDifference: null }));
  }
  return install({
    tables: { brands: brandsTable(), adjustment_policies: policyRows(handling), adjustment_baselines: baselines, adjustment_imports: records.length ? [committedImport(IMPORT, records.length)] : [] },
    rpc: { adjustment_records_json: bulkReader(records), save_risk_estimate: { data: ESTIMATE, error: null } },
  });
}

describe("forecastRisk: the hand-derived risk goldens, through the action", () => {
  const runnable = scenariosFile.riskCases.map((c) => [c, riskFormFor(c)] as const).filter(([c, f]) => f !== null && expectedFile.risk[c.id].status === "ok");

  it("covers every case that calculates (36 of 45); the other nine are refusals the form or the history check makes first", () => {
    expect(runnable.length).toBe(36);
    expect(scenariosFile.riskCases.length).toBe(45);
  });

  it.each(runnable.map(([c, f]) => [c.id, c, f] as const))("%s", async (_id, c, form) => {
    riskDbFor(c);
    const r = await actions.forecastRisk(form);
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(mismatches(r.forecast, expectedFile.risk[c.id])).toEqual([]);
  });

  it("refuses with the engine's own code when an amount is too large to carry (nothing is rounded to fit)", async () => {
    const c = scenariosFile.riskCases.find((x) => x.id === "refuse_overflow_e4")!;
    riskDbFor(c);
    expect(await actions.forecastRisk(riskFormFor(c))).toMatchObject({ status: "refused", code: "overflow" });
  });

  it("refuses what the form should have caught, in the review's own words for the weights basis", async () => {
    const c = scenariosFile.riskCases[0]!;
    riskDbFor(c);
    const form = riskFormFor(c)!;
    const { basis: _b, ...noBasis } = form;
    const r = await actions.forecastRisk(noBasis);
    expect(r).toMatchObject({ status: "invalid", errors: { basis: BASIS_REQUIRED_MESSAGE } });
    expect(BASIS_REQUIRED_MESSAGE).toBe("Choose one. It decides whether postage differences are counted here or are already in your forecast.");
    expect(await actions.forecastRisk({ ...form, credits: undefined })).toMatchObject({ status: "invalid", errors: { credits: "Choose how credits are treated." } });
    expect(await actions.forecastRisk({ ...form, severity: { postage_difference: { source: "entered", amount: "-1.00" }, separate_fee: { source: "entered", amount: "0" } } })).toMatchObject({ status: "invalid" });
    expect(await actions.forecastRisk({ ...form, incidence: { source: "entered", pct: "101" } })).toMatchObject({ status: "invalid", errors: { incidence: expect.stringContaining("between 0 and 100") } });
    expect(await actions.forecastRisk({ ...form, volume: { source: "entered", packagesPerMonth: "5000001" } })).toMatchObject({ status: "invalid" });
    expect(await actions.forecastRisk({ ...form, incidence: { source: "history" }, history: undefined })).toMatchObject({ status: "invalid", errors: { history: "Choose which history to use." } });
    expect(await actions.forecastRisk({ ...form, incidence: { source: "entered", pct: "2" }, credits: "memo" })).toMatchObject({ status: "invalid", errors: { credits: expect.stringContaining("only be shown from your history") } });
    expect(await actions.forecastRisk({ ...form, volume: { source: "run", runId: RUN } })).toMatchObject({ status: "invalid" });
    expect(await actions.forecastRisk({ ...form, tenantId: OTHER_TENANT })).toMatchObject({ status: "invalid" });
  });

  it("does not use a history that refuses to add up (more affected packages than packages shipped) and says so", async () => {
    const c = scenariosFile.riskCases.find((x) => x.id === "refuse_k_gt_n")!;
    riskDbFor(c);
    expect(await actions.forecastRisk(riskFormFor(c))).toMatchObject({ status: "invalid", problems: [expect.stringContaining("More affected packages than packages shipped")] });
  });
});

describe("forecastRisk: where each number comes from", () => {
  const entered = (over: Record<string, unknown> = {}) => ({
    brandId: null,
    adjustmentType: "reweight",
    basis: "declared_weights",
    volume: { source: "entered", packagesPerMonth: "1000" },
    incidence: { source: "entered", pct: "2" },
    severity: { postage_difference: { source: "entered", amount: "10.00" }, separate_fee: { source: "entered", amount: "5.00" } },
    credits: "exclude",
    ...over,
  });
  const decide = (profile: Record<string, Record<string, string>> | null = { reweight: { postage_difference: "pass_through", separate_fee: "pass_through" } }, extra: Parameters<typeof makeDb>[0] = {}) =>
    install({ tables: { brands: brandsTable(), adjustment_policies: policyRows(profile), adjustment_baselines: [], adjustment_imports: [], ...extra.tables }, rpc: { save_risk_estimate: { data: ESTIMATE, error: null }, ...extra.rpc } });

  it("resolves who pays from the decisions of this workspace for the customer asked, for today", async () => {
    decide(null, { tables: { adjustment_policies: [...policyRows({ reweight: { postage_difference: "pass_through", separate_fee: "pass_through" } }), ...policyRows({ reweight: { postage_difference: "absorbed" } }, BRAND), ...policyRows({ reweight: { separate_fee: "absorbed" } }, null, OTHER_TENANT)], brands: brandsTable() } });
    const r = await actions.forecastRisk(entered({ brandId: BRAND }));
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.sources.handling).toEqual({ postage_difference: "absorbed", separate_fee: "pass_through" });
    expect(r.forecast.buckets).toMatchObject({ notBilledToCustomer: 2_000_000, customerPays: 1_000_000 });
    expect(db().on("brands")[0]!.filters).toContainEqual({ op: "eq", column: "tenant_id", value: TENANT });
  });

  it("refuses a customer of another account", async () => {
    decide();
    expect(await actions.forecastRisk(entered({ brandId: FOREIGN_BRAND }))).toEqual({ status: "error", message: "Customer not found." });
  });

  describe("the volume of a finished run", () => {
    const runRow = (over: Row = {}): Row => ({ id: RUN, project_id: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0", tenant_id: TENANT, brand_id: BRAND, kind: "bulk", status: "completed", monthly_packages: 1234.5, finished_at: "2026-10-01T00:00:00Z", assumed_weight: 0, ...over });
    const withRun = (over: Row = {}) => decide(undefined, { tables: { simulation_runs: [runRow(over)], simulation_projects: [{ id: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0", tenant_id: TENANT, name: "August orders" }], brands: brandsTable() } });
    const form = (basis: string) => entered({ brandId: BRAND, basis, volume: { source: "run", runId: RUN } });

    it("uses the run's monthly packages exactly as stored, never the modeled orders", async () => {
      withRun();
      const r = await actions.forecastRisk(form("actual_weights"));
      if (r.status !== "ok") throw new Error(JSON.stringify(r));
      expect(r.sources.volume).toMatchObject({ source: "run", monthlyPackages: "1234.5", run: { runId: RUN, runName: "August orders", weightsFromProductProfiles: false } });
      expect(r.forecast.affected).toMatchObject({ exact: "24.69" });
      for (const call of db().on("simulation_runs")) {
        expect(call.filters).toContainEqual({ op: "eq", column: "tenant_id", value: TENANT });
        expect(call.filters).toContainEqual({ op: "eq", column: "brand_id", value: BRAND });
        expect(call.filters).toContainEqual({ op: "eq", column: "kind", value: "bulk" });
        expect(call.filters).toContainEqual({ op: "eq", column: "status", value: "completed" });
      }
    });

    it("blocks the actual-weights basis when the run priced packages on weights worked out from product weights, and when it cannot tell", async () => {
      withRun({ assumed_weight: 12 });
      expect(await actions.forecastRisk(form("actual_weights"))).toMatchObject({ status: "invalid", errors: { basis: expect.stringContaining("worked out from product weights") } });
      expect(await actions.forecastRisk(form("declared_weights"))).toMatchObject({ status: "ok" });
      withRun({ assumed_weight: null });
      expect(await actions.forecastRisk(form("actual_weights"))).toMatchObject({ status: "invalid", errors: { basis: expect.stringContaining("does not say whether its weights came from product weights") } });
      expect(await actions.forecastRisk(form("declared_weights"))).toMatchObject({ status: "ok", sources: { volume: { run: { weightsFromProductProfiles: null } } } });
    });

    it("does not find a run of another customer, another account, a run that is not finished or has no monthly count", async () => {
      for (const over of [{ brand_id: BRAND_B }, { tenant_id: OTHER_TENANT }, { status: "running" }, { kind: "single" }, { monthly_packages: null }, { monthly_packages: 0 }]) {
        withRun(over);
        expect(await actions.forecastRisk(form("declared_weights")), JSON.stringify(over)).toMatchObject({ status: "invalid", errors: { volume: expect.stringContaining("not available") } });
      }
    });
  });

  describe("a severity from a saved example", () => {
    const scenario = (over: Row = {}): Row => ({
      id: SCENARIO, tenant_id: TENANT, brand_id: BRAND, name: "n", adjustment_type: "reweight", priced_on: "2026-10-15", archived_at: null, created_at: "2026-10-15T00:00:00Z", r_status: "ok", r_direction: "increase", r_basis: "exact",
      input: {}, result: { components: [{ kind: "postage_difference", state: "conditional", amount: "0.56" }, { kind: "separate_fee", state: "waived_for_customer", amount: null }] }, engine_version: "adjustments-1.0.0", rate_card_version_id: null, policy_snapshot: {}, ...over,
    });
    const form = (over: Record<string, unknown> = {}) => entered({ brandId: BRAND, severity: { postage_difference: { source: "example", scenarioId: SCENARIO }, separate_fee: { source: "example", scenarioId: SCENARIO } }, ...over });

    it("uses what the example charges and treats a component that is not a charge as unknown, never as zero", async () => {
      decide(undefined, { tables: { brands: brandsTable(), adjustment_scenarios: [scenario()] } });
      const r = await actions.forecastRisk(form());
      if (r.status !== "ok") throw new Error(JSON.stringify(r));
      expect(r.sources.severity).toEqual({ postage_difference: { source: "example", e4: 5600, n: null }, separate_fee: { source: "example", e4: null, n: null } });
      expect(r.forecast.components.separate_fee).toMatchObject({ state: "not_computed", reason: "severity_unknown", amountE4: null });
      expect(r.forecast.atLeast).toBe(true);
      expect(r.forecast.confidence.postage_difference).toBe("example");
    });

    it("refuses an example of another kind of adjustment, of another customer or another account, or one that is not there", async () => {
      for (const over of [{ adjustment_type: "remeasure" }, { brand_id: BRAND_B }, { tenant_id: OTHER_TENANT }]) {
        decide(undefined, { tables: { brands: brandsTable(), adjustment_scenarios: [scenario(over)] } });
        expect(await actions.forecastRisk(form()), JSON.stringify(over)).toMatchObject({ status: "invalid", errors: { severity: expect.any(String) } });
      }
      decide(undefined, { tables: { brands: brandsTable(), adjustment_scenarios: [] } });
      expect(await actions.forecastRisk(form())).toMatchObject({ status: "invalid" });
    });

    it("accepts an exploration example (no customer)", async () => {
      decide(undefined, { tables: { brands: brandsTable(), adjustment_scenarios: [scenario({ brand_id: null })] } });
      expect(await actions.forecastRisk(form())).toMatchObject({ status: "ok" });
    });
  });

  describe("history", () => {
    const record = (n: number, over: Record<string, unknown> = {}) => ({ id: `r${n}`, rowNo: n + 1, brandId: BRAND, shipDate: "2026-01-10", carrierCode: "ups", serviceId: null, adjustmentType: "reweight", cause: "carrier_reweigh", packageRef: `1ZH${n}`, originalCharge: "10.00", correctedCharge: "12.00", separateFee: "3.00", postageDifference: "2.00", ...over });
    const historyDb = (records: Record<string, unknown>[], extra: Row[] = []) =>
      decide(undefined, {
        tables: {
          brands: brandsTable(),
          adjustment_imports: [committedImport(IMPORT, records.length)],
          adjustment_baselines: baselineRows([{ id: "bl-a-jan", brandId: "brand-a", carrierCode: null, serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 500, labelsMissingWeight: null }, ...extra]),
        },
        rpc: { adjustment_records_json: bulkReader(records.map((r, i) => ({ ...r, rowNo: i + 1 }))) },
      });
    const fromHistory = (over: Record<string, unknown> = {}) => entered({ brandId: BRAND, incidence: { source: "history" }, severity: { postage_difference: { source: "history" }, separate_fee: { source: "history" } }, history: {}, ...over });

    it("takes the incidence and the severities from one reading, counts charges only, and says what it left out", async () => {
      // 4 charges (+2.00 each, fee 3.00), 2 credits (-1.00), 1 unchanged, 1 with no amounts.
      historyDb([record(0), record(1), record(2), record(3), record(4, { correctedCharge: "9.00", postageDifference: "-1.00", separateFee: null }), record(5, { correctedCharge: "9.00", postageDifference: "-1.00", separateFee: null }), record(6, { correctedCharge: "10.00", postageDifference: "0.00", separateFee: null }), record(7, { originalCharge: null, correctedCharge: null, separateFee: null, postageDifference: null })]);
      const r = await actions.forecastRisk(fromHistory({ credits: "memo" }));
      if (r.status !== "ok") throw new Error(JSON.stringify(r));
      expect(r.sources.incidence).toMatchObject({ source: "history", k: 5, N: 500, history: { charges: 4, credits: 2, zeroChange: 1, unknownAmount: 1, counted: 5, affected: 8 } });
      expect(r.sources.severity).toEqual({ postage_difference: { source: "history", e4: 20000, n: 4 }, separate_fee: { source: "history", e4: 30000, n: 4 } });
      expect(r.forecast.incidence).toMatchObject({ source: "history", k: 5, N: 500 });
      // Credits never enter the exposure; they are a memo beside it.
      expect(r.forecast.components.postage_difference.amountE4).toBe(Math.round((1000 * 5 * 20000) / 500));
      expect(r.forecast.creditsMemoE4).toBe(Math.round((1000 * 2 * -10000) / 500));
      expect(r.sources.credits).toBe("memo");
      expect(r.sources.importIds).toEqual([IMPORT]);
      // The type defaults to the estimate's own: only reweigh records were counted.
      expect(r.sources.statistics!.recordsInScope).toBe(8);
    });

    it("counts the records of the estimate's own kind unless the form says every kind", async () => {
      historyDb([record(0), record(1, { adjustmentType: "remeasure" })]);
      const own = await actions.forecastRisk(fromHistory());
      if (own.status !== "ok") throw new Error(JSON.stringify(own));
      expect(own.sources.statistics!.recordsInScope).toBe(1);
      const every = await actions.forecastRisk(fromHistory({ history: { adjustmentType: null } }));
      if (every.status !== "ok") throw new Error(JSON.stringify(every));
      expect(every.sources.statistics!.recordsInScope).toBe(2);
    });

    it("has no incidence at all without a baseline (not computed, never 0.00), and leaves severity unknown without amounts", async () => {
      decide(undefined, { tables: { brands: brandsTable(), adjustment_imports: [committedImport(IMPORT, 1)], adjustment_baselines: [] }, rpc: { adjustment_records_json: bulkReader([{ ...record(0), rowNo: 1, originalCharge: null, correctedCharge: null, separateFee: null, postageDifference: null }]) } });
      const r = await actions.forecastRisk(fromHistory());
      if (r.status !== "ok") throw new Error(JSON.stringify(r));
      expect(r.forecast.incidence).toBeNull();
      expect(r.forecast.incidenceReason).toBe("no_baseline");
      expect(r.forecast.countedHereE4).toBeNull();
      expect(r.forecast.components.postage_difference).toMatchObject({ state: "not_computed", reason: "incidence_unknown", amountE4: null });
      expect(r.sources.incidence.history).toBeNull();
    });
  });

  describe("saveRiskEstimate", () => {
    it("calculates again on the server and stores the estimate with its inputs by value, the imports it cites and the handling it assumed", async () => {
      const calls: { from: number; limit: number }[] = [];
      decide(undefined, {
        tables: { brands: brandsTable(), adjustment_imports: [committedImport(IMPORT, 2)], adjustment_baselines: baselineRows([{ id: "bl-a-jan", brandId: "brand-a", carrierCode: null, serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 500, labelsMissingWeight: null }]) },
        rpc: { adjustment_records_json: bulkReader(asBulk([{ id: "a", brandId: "brand-a", carrierCode: "ups", serviceId: null, shipDate: "2026-01-10", adjustmentType: "reweight", cause: "carrier_reweigh", packageRef: "1Z1", originalCharge: "10.00", correctedCharge: "12.00", separateFee: "3.00", postageDifference: "2.00" }, { id: "b", brandId: "brand-a", carrierCode: "ups", serviceId: null, shipDate: "2026-01-11", adjustmentType: "reweight", cause: "carrier_reweigh", packageRef: "1Z2", originalCharge: "10.00", correctedCharge: "12.00", separateFee: "3.00", postageDifference: "2.00" }]), calls), save_risk_estimate: { data: ESTIMATE, error: null } },
      });
      const form = entered({ brandId: BRAND, incidence: { source: "history" }, severity: { postage_difference: { source: "history" }, separate_fee: { source: "entered", amount: "5" } }, history: { window: { from: "2026-01-01", to: "2026-01-31" } } });
      const r = await actions.saveRiskEstimate(form, "  January, Alpha  ");
      expect(r).toEqual({ ok: true, estimateId: ESTIMATE, message: "Estimate saved." });
      const [args] = db().rpcNamed("save_risk_estimate");
      expect(args).toMatchObject({ p_tenant: TENANT, p_brand: BRAND, p_name: "January, Alpha", p_engine_version: "adjustments-1.0.0" });
      expect(args!.p_inputs).toMatchObject({
        v: 1,
        adjustmentType: "reweight",
        basis: "declared_weights",
        credits: "exclude",
        volume: { source: "entered", monthlyPackages: "1000" },
        incidence: { source: "history", k: 2, N: 500 },
        severity: { postage_difference: { source: "history", e4: 20000, n: 2 }, separate_fee: { source: "entered", e4: 50000, n: null } },
        importIds: [IMPORT],
        history: { filters: { brandId: BRAND, adjustmentType: "reweight", window: { from: "2026-01-01", to: "2026-01-31" } }, recordsInScope: 2, affected: 2, baselineIds: [expect.any(String)] },
      });
      const result = args!.p_result as { v: number; buckets: Record<string, number>; countedE4: number; handling: Record<string, string>; forecast: { status: string } };
      expect(result).toMatchObject({ v: 1, handling: { postage_difference: "pass_through", separate_fee: "pass_through" }, forecast: { status: "ok" } });
      expect(Object.values(result.buckets).reduce((a, b) => a + b, 0)).toBe(result.countedE4);
      expect(h.limits.at(-1)).toBe("adjustment.save");
    });

    it("saves an estimate of entered numbers with no imports cited", async () => {
      decide();
      expect(await actions.saveRiskEstimate(entered(), "Typed")).toMatchObject({ ok: true });
      expect(db().rpcNamed("save_risk_estimate")[0]!.p_inputs).toMatchObject({ importIds: [], history: null, incidence: { source: "entered", pct: "2" } });
    });

    it("refuses to save what cannot be calculated or named, and reads the database's refusals in words", async () => {
      decide();
      expect(await actions.saveRiskEstimate(entered(), " ")).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
      const { basis: _b, ...noBasis } = entered();
      expect(await actions.saveRiskEstimate(noBasis, "Name")).toMatchObject({ ok: false, errors: { basis: BASIS_REQUIRED_MESSAGE } });
      expect(await actions.saveRiskEstimate(entered({ severity: { postage_difference: { source: "entered", amount: "1000000.0000" }, separate_fee: { source: "entered", amount: "0" } }, volume: { source: "entered", packagesPerMonth: "5000000" }, incidence: { source: "entered", pct: "100" } }), "Name")).toMatchObject({ ok: false, message: expect.stringContaining("too large") });
      expect(db().rpcNamed("save_risk_estimate")).toEqual([]);
      const refuse = async (error: { code: string; message: string }) => {
        decide(undefined, { rpc: { save_risk_estimate: { data: null, error } } });
        return actions.saveRiskEstimate(entered(), "Name");
      };
      expect(await refuse({ code: "PC003", message: "the policy changed while the estimate was being made; calculate it again" })).toEqual({ ok: false, message: "The decision on who pays changed while the estimate was being made. Calculate it again." });
      expect(await refuse({ code: "P0001", message: "the limit of 200 saved estimates is reached; archive some first" })).toMatchObject({ message: expect.stringContaining("200 saved estimates") });
      expect(await refuse({ code: "P0002", message: "not found" })).toEqual({ ok: false, message: "The customer or an import was not found." });
    });

    it("refuses an estimate drawn from more than 50 imports instead of citing fewer than it used", async () => {
      const imports = Array.from({ length: 51 }, (_, i) => committedImport(`${String(i + 1).padStart(8, "0")}-0000-4000-8000-000000000000`, 1));
      decide(undefined, {
        tables: { brands: brandsTable(), adjustment_imports: imports, adjustment_baselines: baselineRows([{ id: "bl-t", brandId: null, carrierCode: null, serviceId: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", packagesTotal: 500, labelsMissingWeight: null }]) },
        rpc: { adjustment_records_json: (args) => ({ data: [{ id: String(args.p_import), rowNo: 1, brandId: null, shipDate: "2026-01-10", carrierCode: "ups", serviceId: null, adjustmentType: "reweight", cause: "other", packageRef: `P${String(args.p_import)}`, originalCharge: null, correctedCharge: null, separateFee: null, postageDifference: null }], error: null }), save_risk_estimate: { data: ESTIMATE, error: null } },
      });
      const r = await actions.saveRiskEstimate(entered({ incidence: { source: "history" }, history: {} }), "Name");
      expect(r).toMatchObject({ ok: false, message: expect.stringContaining("more than 50 imports") });
      expect(db().rpcNamed("save_risk_estimate")).toEqual([]);
    });

    it("archives an estimate of this workspace only", async () => {
      install({ tables: { risk_estimates: [{ id: ESTIMATE, tenant_id: TENANT }] }, rpc: { archive_risk_estimate: { data: null, error: null } } });
      expect(await actions.archiveRiskEstimate(ESTIMATE)).toEqual({ ok: true, message: "Estimate archived." });
      install({ tables: { risk_estimates: [{ id: ESTIMATE, tenant_id: OTHER_TENANT }] } });
      expect(await actions.archiveRiskEstimate(ESTIMATE)).toEqual({ ok: false, message: "Estimate not found." });
      expect(db().rpcs).toEqual([]);
    });
  });

  it("is rate limited", async () => {
    decide();
    h.limitOk = false;
    expect(await actions.forecastRisk(entered())).toEqual({ status: "error", message: "limited" });
  });
});

describe("the customer's session reaches none of this", () => {
  it("does nothing for a customer's member, whatever the request (nothing is read, priced or stored)", async () => {
    h.ctx = brandSession;
    scenarioDb();
    expect(await actions.evaluateScenario(e2Form())).toMatchObject({ status: "error", message: expect.stringMatching(/permission/) });
    expect(await actions.forecastRisk({})).toMatchObject({ status: "error" });
    expect(await actions.previewExample(SCENARIO, BRAND)).toMatchObject({ ok: false });
    expect(h.loads).toEqual([]);
    expect(db().calls).toEqual([]);
    expect(db().rpcs).toEqual([]);
    expect(NEW_ID).toBeTruthy();
  });
});
