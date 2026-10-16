import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { evaluateForecast, type ForecastAssumptions } from "@/engine/forecast";
import { FEE_ENGINE_VERSION, type FeeScheduleSnapshot } from "@/engine/fees/types";
import { ENGINE_VERSION } from "@/engine/types";
import { fakeSupabase, type FakeResult } from "../fixtures/forecast/fake-supabase";

// The read models are server-only modules; the marker package refuses to load outside a server build.
vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/surcharges", () => ({ addSurchargeRuleVersion: vi.fn(), createSurchargeRule: vi.fn(), retireRuleVersion: vi.fn(), uploadZipList: vi.fn() }));

const { loadForecastContext, loadSavedForecast } = await import("@/lib/forecast/queries");
const { loadForecastZones, loadZoneZips } = await import("@/lib/forecast/zones");
const { sha256Hex } = await import("@/lib/forecast/hash");
const { fixtureContext } = await import("../fixtures/pricing/load");

/**
 * The server-side glue of the forecast screens, run against a fake Supabase client that answers each
 * table and function with the rows the test gives it: which rate card and services a customer gets, the
 * zones per service from the origin, the fee schedule's statuses, and how a saved forecast is read back.
 * Filters (`eq`, `is`, …) are not applied by the fake; each table holds only the rows that query is about.
 */
const schedules = JSON.parse(readFileSync(new URL("../fixtures/fees/schedules.json", import.meta.url), "utf8")) as Record<string, FeeScheduleSnapshot>;
const standard = schedules.standard!;
const pricing = fixtureContext();
const UPS = "svc-ups-ground";
const USPS = "svc-usps-ga";
const UPS_2DA = "svc-ups-2da";

type Result = FakeResult;
const fake = fakeSupabase;

const termRows = pricing.rateCard.services.map((t) => ({
  service_id: t.serviceId,
  dim_divisor: t.dim.divisor,
  dim_threshold_cubic_in: t.dim.thresholdCubicIn,
  dimension_rounding: t.dim.dimensionRounding,
  weight_rounding: t.dim.weightRounding,
  min_billable_lb: t.dim.minBillableLb,
  dim_exempt: t.dim.exempt,
  min_charge: t.minCharge,
  included_surcharge_keys: t.includedSurchargeKeys,
  excluded_surcharge_keys: t.excludedSurchargeKeys,
  zone_chart_key: "default",
  zone_independent: false,
  surcharge_markup_percent: null,
  source_reference: "FIXTURE",
  shipping_services: { id: t.serviceId, carrier_code: t.carrierCode, code: t.serviceCode, name: t.serviceName },
}));

const assignment = (id: string, name: string, over: Record<string, unknown> = {}) => ({ rate_card_id: id, allowed_service_ids: null, default_origin_zip: "90001", rate_cards: { id, name, status: "active" }, ...over });
const version = { id: "fixture-card-v1", version_number: 1, status: "active", effective_date: "2026-01-01", expiration_date: null };
const feeAssignment = { id: "fa", schedule_id: "sched", assigned_at: "2026-01-02T00:00:00Z", fee_schedules: { id: "sched", name: standard.name, description: null } };

function client(over: { tables?: Record<string, unknown[]>; errors?: Record<string, { code?: string; message: string }>; rpc?: Record<string, Result | ((a: Record<string, unknown>) => Result)> } = {}) {
  return fake({
    tables: { brand_rate_card_assignments: [assignment("fixture-card", "Fixture rate card")], rate_card_versions: [version], rate_card_service_terms: termRows, brand_fee_schedule_assignments: [feeAssignment], ...over.tables },
    errors: over.errors,
    rpc: {
      rate_card_rows_json: { data: pricing.rateCard.rows, error: null },
      rate_card_zones_json: { data: pricing.rateCard.zones, error: null },
      brand_fee_schedule_on: { data: { status: "ok", snapshot: standard }, error: null },
      ...over.rpc,
    },
  });
}

const input = { brandId: "b", tenantDefaultOriginZip: "10001" as string | null, asOfDate: "2026-03-15" };

describe("loadForecastContext", () => {
  it("gives the customer's services with the zones the rate card prices, the fee schedule's questions and packaging", async () => {
    const ctx = await loadForecastContext(client(), input);
    if (ctx.status !== "ok") throw new Error(`expected ok, got ${ctx.status}`);
    expect(ctx).toMatchObject({ asOfDate: "2026-03-15", originZip: "90001", rateCard: { id: "fixture-card", name: "Fixture rate card", effectiveDate: "2026-01-01", expirationDate: null }, cards: [{ id: "fixture-card", name: "Fixture rate card" }], warnings: [] });
    const ups = ctx.services.find((s) => s.serviceId === UPS)!;
    expect(ups).toMatchObject({ name: "UPS Ground", carrierCode: "ups", serviceCode: "ground", zoneIndependent: false, dimExempt: false });
    expect(ups.zones).toEqual(["2", "3", "4", "5", "6", "7", "8"]);
    expect(ctx.services.find((s) => s.serviceId === USPS)!.zones).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    if (ctx.schedule.status !== "ok") throw new Error("schedule");
    expect(ctx.schedule).toMatchObject({ name: standard.name, effectiveDate: "2026-01-01", readsOrderContent: true, allowOtherPackaging: true });
    expect(ctx.schedule.packaging.map((p) => p.value)).toEqual(["poly mailer", "box", "carton"]);
    expect(ctx.schedule.questions.map((q) => q.key).sort()).toEqual(["cases_received", "inserts", "long_term_pallets", "pallets_received", "pallets_stored", "returns_rate"]);
  });

  it("carries no rule key, id or note in the questions a brand reads", async () => {
    const ctx = await loadForecastContext(client(), input);
    if (ctx.status !== "ok" || ctx.schedule.status !== "ok") throw new Error("expected ok");
    const json = JSON.stringify(ctx.schedule);
    for (const rule of standard.rules.filter((r) => r.key.includes("_"))) expect(json, rule.key).not.toContain(rule.key);
  });

  it("limits the services to the ones the assignment allows", async () => {
    const ctx = await loadForecastContext(client({ tables: { brand_rate_card_assignments: [assignment("fixture-card", "Fixture rate card", { allowed_service_ids: [UPS, USPS] })] } }), input);
    if (ctx.status !== "ok") throw new Error("expected ok");
    expect(ctx.services.map((s) => s.serviceId).sort()).toEqual([UPS, USPS].sort());
    expect(ctx.services.some((s) => s.serviceId === UPS_2DA)).toBe(false);
  });

  it("uses the brand's default ship-from ZIP, then the tenant's, and the one given first of all", async () => {
    const noBrandDefault = client({ tables: { brand_rate_card_assignments: [assignment("fixture-card", "Fixture rate card", { default_origin_zip: null })] } });
    expect((await loadForecastContext(noBrandDefault, input)).status === "ok" && (await loadForecastContext(noBrandDefault, input))).toMatchObject({ originZip: "10001" });
    expect(await loadForecastContext(client(), { ...input, originZip: "90002" })).toMatchObject({ originZip: "90002" });
    // Not a 5-digit ZIP: the default applies.
    expect(await loadForecastContext(client(), { ...input, originZip: "9000" })).toMatchObject({ originZip: "90001" });
    // Nothing known at all: blank, for the form to block on.
    const none = client({ tables: { brand_rate_card_assignments: [assignment("fixture-card", "Fixture rate card", { default_origin_zip: null })] } });
    expect(await loadForecastContext(none, { ...input, tenantDefaultOriginZip: null })).toMatchObject({ originZip: "" });
  });

  it("lists every zone while no origin is known, and warns when the carrier's zone chart does not cover the origin", async () => {
    const none = client({ tables: { brand_rate_card_assignments: [assignment("fixture-card", "Fixture rate card", { default_origin_zip: null })] } });
    const blank = await loadForecastContext(none, { ...input, tenantDefaultOriginZip: null });
    if (blank.status !== "ok") throw new Error("expected ok");
    expect(blank.services.find((s) => s.serviceId === USPS)!.zones).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(blank.warnings).toEqual([]);
    // 10001 is on no chart row of the fixture card; USPS rows are priced per origin prefix 900, so it has no zones from there.
    const off = await loadForecastContext(client(), { ...input, originZip: "10001" });
    if (off.status !== "ok") throw new Error("expected ok");
    expect(off.services.find((s) => s.serviceId === USPS)!.zones).toEqual([]);
    expect(off.warnings).toHaveLength(3);
    expect(off.warnings).toContain("UPS Ground: ZIP code 10001 is not on the zone chart of this rate card, so real shipments from it could not be zoned and priced. Check the ZIP code you ship from.");
  });

  it("picks the card asked for, else the first by name, and lists them all", async () => {
    const two = client({ tables: { brand_rate_card_assignments: [assignment("b-card", "Beta card"), assignment("a-card", "Alpha card")] } });
    expect(await loadForecastContext(two, input)).toMatchObject({ rateCard: { id: "a-card" }, cards: [{ id: "a-card", name: "Alpha card" }, { id: "b-card", name: "Beta card" }] });
    expect(await loadForecastContext(two, { ...input, rateCardId: "b-card" })).toMatchObject({ rateCard: { id: "b-card" } });
    expect(await loadForecastContext(two, { ...input, rateCardId: "someone-elses" })).toMatchObject({ rateCard: { id: "a-card" } });
  });

  it("is no_card for a customer with no active rate card, and ignores a retired one", async () => {
    expect(await loadForecastContext(client({ tables: { brand_rate_card_assignments: [] } }), input)).toEqual({ status: "no_card" });
    const retired = assignment("fixture-card", "Fixture rate card", { rate_cards: { id: "fixture-card", name: "Fixture rate card", status: "retired" } });
    expect(await loadForecastContext(client({ tables: { brand_rate_card_assignments: [retired] } }), input)).toEqual({ status: "no_card" });
  });

  it("says so when no rate card version is in effect on the date, and never as 'no services'", async () => {
    const ctx = await loadForecastContext(client({ tables: { rate_card_versions: [] } }), input);
    expect(ctx).toEqual({ status: "no_rates", cards: [{ id: "fixture-card", name: "Fixture rate card" }], message: "Fixture rate card has no rates in effect on Mar 15, 2026. Choose another date." });
  });

  it("reports a failed read as a failure, never as an empty rate card", async () => {
    expect(await loadForecastContext(client({ errors: { brand_rate_card_assignments: { message: "boom" } } }), input)).toMatchObject({ status: "failed" });
    expect(await loadForecastContext(client({ errors: { rate_card_versions: { message: "boom" } } }), input)).toMatchObject({ status: "failed" });
    expect(await loadForecastContext(client({ errors: { rate_card_service_terms: { message: "boom" } } }), input)).toMatchObject({ status: "failed" });
    const zones = await loadForecastContext(client({ rpc: { rate_card_zones_json: { data: null, error: { message: "boom" } } } }), input);
    expect(zones).toMatchObject({ status: "failed" });
  });

  it("reads the fee schedule's status for the date: none, not in effect, unreadable, or customer not found", async () => {
    const withStatus = (data: unknown, error: Result["error"] = null) => client({ rpc: { brand_fee_schedule_on: { data, error } } });
    expect(await loadForecastContext(withStatus({ status: "no_schedule" }), input)).toMatchObject({ schedule: { status: "none" } });
    expect(await loadForecastContext(withStatus({ status: "not_effective", scheduleId: "sched", name: "Old" }), input)).toMatchObject({ schedule: { status: "not_effective", name: standard.name } });
    expect(await loadForecastContext(withStatus(null, { code: "XX000", message: "boom" }), input)).toMatchObject({ schedule: { status: "unavailable" } });
    expect(await loadForecastContext(withStatus(null, { code: "P0002", message: "customer not found" }), input)).toEqual({ status: "failed", message: "This customer could not be found." });
  });

  it("asks the fee schedule for the date it was given", async () => {
    const seen: unknown[] = [];
    await loadForecastContext(client({ rpc: { brand_fee_schedule_on: (args) => (seen.push(args), { data: { status: "no_schedule" }, error: null }) } }), { ...input, asOfDate: "2026-07-04" });
    expect(seen).toEqual([{ p_brand: "b", p_date: "2026-07-04" }]);
  });
});

describe("zones of a rate card version", () => {
  const services = pricing.rateCard.services.map((t) => ({ serviceId: t.serviceId, zoneIndependent: false, carrierCode: t.carrierCode, zoneChartKey: "default" }));

  it("returns the zones per service, the representative ZIPs and the services whose chart misses the origin", async () => {
    const found = await loadForecastZones(client(), "fixture-card-v1", "90001", services);
    if (!found.ok) throw new Error("expected ok");
    expect(found.data.zonesByService[UPS]).toEqual(["2", "3", "4", "5", "6", "7", "8"]);
    expect(found.data.zipsByService[UPS]).toEqual({ "2": "90000", "3": "93600", "4": "96200", "5": "80000", "6": "60000", "7": "30000", "8": "00500" });
    expect(found.data.originNotOnChart).toEqual([]);
    const off = await loadForecastZones(client(), "fixture-card-v1", "10001", services);
    if (!off.ok) throw new Error("expected ok");
    expect(off.data.originNotOnChart.sort()).toEqual([UPS, UPS_2DA, USPS].sort());
    expect(off.data.zipsByService[UPS]).toEqual({});
  });

  it("asks the database for the services given and gives zone-independent ones the zone ALL with no ZIP", async () => {
    const asked: unknown[] = [];
    const c = client({ rpc: { rate_card_rows_json: (args) => (asked.push(args), { data: pricing.rateCard.rows, error: null }) } });
    const found = await loadForecastZones(c, "v", "90001", [{ serviceId: UPS, zoneIndependent: true, carrierCode: "ups", zoneChartKey: "default" }]);
    if (!found.ok) throw new Error("expected ok");
    expect(asked).toEqual([{ p_version: "v", p_service_ids: [UPS] }]);
    expect(found.data.zonesByService[UPS]).toEqual(["ALL"]);
    expect(found.data.zipsByService).toEqual({});
  });

  it("makes no chart lookup without an origin, and fails when either read fails", async () => {
    const none = await loadForecastZones(client(), "v", null, services);
    if (!none.ok) throw new Error("expected ok");
    expect(none.data).toMatchObject({ zipsByService: {}, originNotOnChart: [] });
    expect(none.data.zonesByService[USPS]).toHaveLength(8);
    expect(await loadForecastZones(client({ rpc: { rate_card_rows_json: { data: null, error: { message: "boom" } } } }), "v", "90001", services)).toEqual({ ok: false });
    expect(await loadForecastZones(client({ rpc: { rate_card_zones_json: { data: null, error: { message: "boom" } } } }), "v", "90001", services)).toEqual({ ok: false });
  });

  it("loadZoneZips: the lowest destination prefix of each zone for the origin, per service", async () => {
    const found = await loadZoneZips(client(), "fixture-card-v1", "90210", services);
    expect(found).toEqual({ ok: true, zips: { [UPS]: { "3": "90300" }, [UPS_2DA]: { "3": "90300" }, [USPS]: { "3": "90300" } }, originNotOnChart: [] });
    expect(await loadZoneZips(client({ rpc: { rate_card_zones_json: { data: null, error: { message: "boom" } } } }), "v", "90001", services)).toEqual({ ok: false });
  });
});

describe("loadSavedForecast", () => {
  const assumptions: ForecastAssumptions = {
    version: 1,
    monthlyOrders: "1000",
    asOfDate: "2026-03-15",
    originZip: "90001",
    parcels: [{ weightLb: "1", lengthIn: "10", widthIn: "8", heightIn: "4", packagingType: "box", sharePct: "100" }],
    zones: [{ zone: "2", sharePct: "100" }],
    services: [{ serviceId: UPS, carrierCode: "ups", serviceCode: "ground", name: "UPS Ground", sharePct: "100" }],
    residentialPct: "50",
    multiPackage: { pct: "0", packagesPerOrder: 2 },
    content: { rows: [{ units: 2, lines: 1, sharePct: "100" }] },
    fulfillment: { drivers: {}, orderShares: {} },
  };
  const evaluated = evaluateForecast(assumptions, { pricing, schedule: standard, pinnedRates: {}, feeEngineVersion: FEE_ENGINE_VERSION, engineVersion: ENGINE_VERSION, hash: sha256Hex });
  if (evaluated.status !== "ok") throw new Error("fixture forecast must price");
  const summary = evaluated.summary;
  const project = (runs: unknown[], over: Record<string, unknown> = {}) => ({ id: "p1", name: "Spring plan", created_at: "2026-03-16T10:00:00Z", shared_with_brand: true, archived_at: null, rate_card_id: "card-1", rate_cards: { name: "Fixture rate card" }, simulation_runs: runs, ...over });
  const run = (over: Record<string, unknown> = {}) => ({ id: "r1", kind: "forecast", status: "completed", as_of_date: "2026-03-15", created_at: "2026-03-16T10:00:00Z", summary, assumptions, ...over });

  it("reads back the project, its completed run, the summary and the assumptions that prefill an edit", async () => {
    const saved = await loadSavedForecast(fake({ tables: { simulation_projects: [project([run()])] } }), "b", "p1");
    expect(saved).toMatchObject({ projectId: "p1", runId: "r1", name: "Spring plan", sharedWithBrand: true, archivedAt: null, rateCardId: "card-1", rateCardName: "Fixture rate card", asOfDate: "2026-03-15" });
    expect(saved!.summary.basis).toBe("assumptions");
    expect(saved!.assumptions).toEqual(assumptions);
  });

  it("is null for a project that is not there (or not visible), has no completed forecast run, or holds another kind of summary", async () => {
    expect(await loadSavedForecast(fake({ tables: { simulation_projects: [] } }), "b", "p1")).toBeNull();
    expect(await loadSavedForecast(fake({ tables: { simulation_projects: [project([])] } }), "b", "p1")).toBeNull();
    expect(await loadSavedForecast(fake({ tables: { simulation_projects: [project([run({ status: "running" })])] } }), "b", "p1")).toBeNull();
    expect(await loadSavedForecast(fake({ tables: { simulation_projects: [project([run({ summary: { version: 2, basis: "file" } })])] } }), "b", "p1")).toBeNull();
    expect(await loadSavedForecast(fake({ tables: { simulation_projects: [project([run({ kind: "bulk" })])] } }), "b", "p1")).toBeNull();
  });

  it("shows the forecast even when its assumptions no longer validate; only the prefill is lost", async () => {
    const saved = await loadSavedForecast(fake({ tables: { simulation_projects: [project([run({ assumptions: { version: 1, nonsense: true } })])] } }), "b", "p1");
    expect(saved).not.toBeNull();
    expect(saved!.assumptions).toBeNull();
    expect(saved!.summary.monthlyOrders).toBe("1000");
  });

  it("takes the latest completed run, and reports archive and sharing state", async () => {
    const older = run({ id: "old", created_at: "2026-03-01T00:00:00Z" });
    const newer = run({ id: "new", created_at: "2026-03-20T00:00:00Z" });
    const saved = await loadSavedForecast(fake({ tables: { simulation_projects: [project([older, newer], { archived_at: "2026-04-01T00:00:00Z", shared_with_brand: false })] } }), "b", "p1");
    expect(saved).toMatchObject({ runId: "new", archivedAt: "2026-04-01T00:00:00Z", sharedWithBrand: false });
  });

  it("carries who saved it, for the line that says whose assumptions these are (null when that account is gone)", async () => {
    const by = await loadSavedForecast(fake({ tables: { simulation_projects: [project([run({ created_by: "user-1" })])] } }), "b", "p1");
    expect(by!.createdBy).toBe("user-1");
    expect((await loadSavedForecast(fake({ tables: { simulation_projects: [project([run()])] } }), "b", "p1"))!.createdBy).toBeNull();
  });

  it("throws on a failed query instead of answering 'not found'", async () => {
    await expect(loadSavedForecast(fake({ errors: { simulation_projects: { message: "boom" } } }), "b", "p1")).rejects.toThrow("the forecast could not be loaded: boom");
  });
});
