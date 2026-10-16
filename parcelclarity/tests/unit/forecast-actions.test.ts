import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeAssumptions, type ForecastAssumptions } from "@/engine/forecast";
import { FEE_ENGINE_VERSION, type FeeScheduleSnapshot } from "@/engine/fees/types";
import type { PricingContext } from "@/engine/types";
import { ENGINE_VERSION } from "@/engine/types";
import { fakeSupabase, type FakeResult } from "../fixtures/forecast/fake-supabase";

/**
 * The forecast server actions, with the session, the database client, the rate limiter and the pricing
 * loader replaced: who may preview or save, what is checked on the server whatever the browser sent
 * (services come from the rate card, answers must fit the schedule in effect on the date), what a
 * customer is and is not told, and exactly what is handed to `save_forecast_run`.
 */
const h = vi.hoisted(() => ({
  ctx: null as unknown,
  supabase: null as unknown,
  limitOk: true,
  snapshot: null as unknown,
  revalidated: [] as unknown[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => h.revalidated.push(args) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => undefined, getContext: async () => h.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.supabase }));
vi.mock("@/lib/rate-limit", () => ({ RATE_LIMITED_MESSAGE: "limited", withinRateLimit: async () => h.limitOk }));
vi.mock("@/lib/pricing/snapshot", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/pricing/snapshot")>()), loadPricingContext: async () => h.snapshot }));
vi.mock("@/app/actions/surcharges", () => ({ addSurchargeRuleVersion: vi.fn(), createSurchargeRule: vi.fn(), retireRuleVersion: vi.fn(), uploadZipList: vi.fn() }));

const { previewForecast, saveForecast, loadForecastFormContext } = await import("@/app/actions/forecast");
const { fixtureContext } = await import("../fixtures/pricing/load");

const schedules = JSON.parse(readFileSync(new URL("../fixtures/fees/schedules.json", import.meta.url), "utf8")) as Record<string, FeeScheduleSnapshot>;
const standard = { ...schedules.standard!, versionId: "55555555-5555-4555-8555-555555555555" };

const UPS = "11111111-1111-4111-8111-111111111111";
const USPS = "22222222-2222-4222-8222-222222222222";
const UPS_2DA = "33333333-3333-4333-8333-333333333333";
const OTHER_SERVICE = "44444444-4444-4444-8444-444444444444";
const CARD = "66666666-6666-4666-8666-666666666666";
const BRAND = "77777777-7777-4777-8777-777777777777";
const TENANT = "88888888-8888-4888-8888-888888888888";
const PROJECT = "99999999-9999-4999-8999-999999999999";
const RATE_CARD_VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDS: Record<string, string> = { "svc-ups-ground": UPS, "svc-usps-ga": USPS, "svc-ups-2da": UPS_2DA };

/** The fixture rate card with real UUIDs for its services (the action refuses ids that are not UUIDs). */
function pricing(): PricingContext {
  const base = fixtureContext();
  const card = base.rateCard;
  const remap = (id: string) => IDS[id] ?? id;
  return { ...base, rateCard: { ...card, rateCardId: CARD, versionId: RATE_CARD_VERSION, services: card.services.map((s) => ({ ...s, serviceId: remap(s.serviceId) })), rows: card.rows.map((r) => ({ ...r, serviceId: remap(r.serviceId) })) } };
}

function snapshot(context = pricing()) {
  return {
    ok: true as const,
    snapshot: {
      context,
      version: { id: RATE_CARD_VERSION, versionNumber: 1, effectiveDate: "2026-01-01", expirationDate: null, status: "active" },
      services: context.rateCard.services.map((s) => ({ serviceId: s.serviceId, carrierCode: s.carrierCode, serviceCode: s.serviceCode, serviceName: s.serviceName })),
      tenantId: TENANT,
      issues: ["A surcharge rule could not be applied."],
      pins: { rateCardVersionId: RATE_CARD_VERSION, ruleVersionIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], zipListIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"], overrideIds: [] },
    },
  };
}

function assumptions(over: Partial<ForecastAssumptions> = {}): ForecastAssumptions {
  return {
    version: 1,
    monthlyOrders: "1250",
    asOfDate: "2026-03-15",
    originZip: "90001",
    parcels: [
      { weightLb: "1", lengthIn: "10", widthIn: "8", heightIn: "4", packagingType: "box", sharePct: "60" },
      { weightLb: "0.5", packagingType: "poly mailer", sharePct: "40", unknownSize: true },
    ],
    zones: [
      { zone: "2", sharePct: "50" },
      { zone: "5", sharePct: "30" },
      { zone: "8", sharePct: "20" },
    ],
    // The names and codes are the browser's word; the action replaces them with the rate card's.
    services: [
      { serviceId: UPS, carrierCode: "x", serviceCode: "x", name: "Hacked name", sharePct: "70" },
      { serviceId: USPS, carrierCode: "x", serviceCode: "x", name: "Also hacked", sharePct: "30" },
    ],
    residentialPct: "80",
    multiPackage: { pct: "10", packagesPerOrder: 2 },
    content: { rows: [{ units: 1, lines: 1, sharePct: "60" }, { units: 3, lines: 2, sharePct: "40" }] },
    fulfillment: {
      drivers: { pallets_stored: "10", long_term_pallets: "2", pallets_received: "4", cases_received: "20", returns_rate: "3" },
      orderShares: { inserts: { sharePct: "40", countPerOrder: 2 } },
      packagingDefault: null,
    },
    ...over,
  };
}

const brandCtx = { active: { role: "brand_admin", portal: "brand", tenantId: TENANT, brandId: BRAND, tenantName: "Fixture 3PL", brandName: "Acme" } };
const staffCtx = { active: { role: "tenant_employee", portal: "tenant", tenantId: TENANT, tenantName: "Fixture 3PL" } };

interface Db {
  saved: Record<string, unknown>[];
  save?: FakeResult | ((args: Record<string, unknown>) => FakeResult);
  feeStatus?: unknown;
  feeError?: FakeResult["error"];
  cards?: unknown[];
  tables?: Record<string, unknown[]>;
}

function install(db: Db = { saved: [] }) {
  h.supabase = fakeSupabase({
    tables: {
      brand_rate_card_assignments: db.cards ?? [{ rate_card_id: CARD, allowed_service_ids: null, default_origin_zip: "90001", rate_cards: { id: CARD, name: "Fixture rate card", status: "active" } }],
      brand_fee_schedule_assignments: [{ id: "fa", schedule_id: "sched", assigned_at: "2026-01-02T00:00:00Z", fee_schedules: { id: "sched", name: standard.name, description: null } }],
      brands: [{ id: BRAND, tenant_id: TENANT, status: "active" }],
      tenants: [{ default_origin_zip: "10001" }],
      ...db.tables,
    },
    rpc: {
      brand_fee_schedule_on: { data: db.feeStatus ?? { status: "ok", snapshot: standard }, error: db.feeError ?? null },
      save_forecast_run: (args) => {
        db.saved.push(args);
        return typeof db.save === "function" ? db.save(args) : (db.save ?? { data: PROJECT, error: null });
      },
    },
  });
}

beforeEach(() => {
  h.ctx = brandCtx;
  h.limitOk = true;
  h.snapshot = snapshot();
  h.revalidated = [];
  install({ saved: [] });
});

describe("previewForecast", () => {
  it("prices the forecast for a customer without storing anything, and hands back a brand-safe result", async () => {
    const db: Db = { saved: [] };
    install(db);
    const response = await previewForecast(assumptions());
    if (response.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(response)}`);
    const { summary, headline, sensitivity } = response.result;
    expect(headline).toMatchObject({ kind: "all_in", label: "All-in cost per order", perOrder: "19.10" });
    expect(sensitivity.map((p) => p.multiplier)).toEqual(["0.5", "1", "2", "4"]);
    expect(db.saved).toEqual([]);
    // The services are the rate card's, not what the browser sent.
    expect(summary.profile.services.map((s) => s.name).sort()).toEqual(["UPS Ground", "USPS Ground Advantage"]);
    // Nothing a brand must not see reaches it: no service id, rule key, hash or engine version, and no per-cell records.
    const json = JSON.stringify(response);
    for (const id of [UPS, USPS, "pick_additional", "pack_box", "storage_pallet"]) expect(json, id).not.toContain(id);
    expect(summary.assumptionsHash).toBe("");
    expect(summary.cells).toEqual([]);
  });

  it("gives staff the same figures with the keys kept", async () => {
    h.ctx = staffCtx;
    const response = await previewForecast(assumptions(), BRAND);
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.result.headline.perOrder).toBe("19.10");
    expect(response.result.summary.processing!.byRule[0]!.key).not.toBe("");
    expect(response.result.summary.assumptionsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a caller who may not model costs, and staff who name a customer of another tenant or none", async () => {
    h.ctx = null;
    expect(await previewForecast(assumptions())).toEqual({ status: "error", message: "You don't have permission to model costs for this customer." });
    h.ctx = staffCtx;
    expect(await previewForecast(assumptions())).toMatchObject({ status: "error" });
    expect(await previewForecast(assumptions(), "not-a-uuid")).toMatchObject({ status: "error" });
    install({ saved: [], tables: { brands: [{ id: BRAND, tenant_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", status: "active" }] } });
    expect(await previewForecast(assumptions(), BRAND)).toMatchObject({ status: "error", message: "You don't have permission to model costs for this customer." });
  });

  it("is rate limited", async () => {
    h.limitOk = false;
    expect(await previewForecast(assumptions())).toEqual({ status: "error", message: "limited" });
  });

  it("returns the engine's problems for assumptions that do not validate", async () => {
    const volume = await previewForecast(assumptions({ monthlyOrders: "0" }));
    expect(volume).toEqual({ status: "invalid", problems: ["monthlyOrders: must be between 1 and 5,000,000"] });
    const shares = await previewForecast(assumptions({ parcels: [{ weightLb: "1", packagingType: null, sharePct: "50", unknownSize: true }] }));
    expect(shares).toEqual({ status: "invalid", problems: ["parcels: shares add up to 50.00%, not 100.00%"] });
    expect(await previewForecast("not an object")).toMatchObject({ status: "invalid" });
    expect(await previewForecast({ ...assumptions(), extra: 1 })).toMatchObject({ status: "invalid" });
  });

  it("refuses a request that is far larger than a forecast can be, before doing any work", async () => {
    const big = assumptions({ fulfillment: { drivers: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`driver_${i}`, "1"])), orderShares: {} } });
    expect(await previewForecast(big)).toEqual({ status: "invalid", problems: ["The forecast is too large. Use fewer rows."] });
  });

  it("refuses a service that is not a UUID or not on the customer's rate card", async () => {
    const response = await previewForecast(assumptions({ services: [{ serviceId: "svc-ups-ground", carrierCode: "ups", serviceCode: "ground", name: "UPS Ground", sharePct: "100" }] }));
    expect(response).toEqual({ status: "invalid", problems: ["A selected service is not available on your rate card."] });
    const missing = await previewForecast(assumptions({ services: [{ serviceId: OTHER_SERVICE, carrierCode: "ups", serviceCode: "ground", name: "Elsewhere", sharePct: "100" }] }));
    expect(missing).toEqual({ status: "invalid", problems: ["Elsewhere is not available on your rate card."] });
  });

  it("stops with a message when the rate card has no rates on the date, or could not be loaded", async () => {
    h.snapshot = { ok: false, error: "no_version_in_effect" };
    expect(await previewForecast(assumptions())).toEqual({ status: "invalid", problems: ["asOfDate: your rate card has no rates in effect on Mar 15, 2026. Choose another date."] });
    h.snapshot = { ok: false, error: "load_failed" };
    expect(await previewForecast(assumptions())).toEqual({ status: "error", message: "Your rate card could not be loaded. Please try again." });
    h.snapshot = { ok: false, error: "rate_card_not_found" };
    expect(await previewForecast(assumptions())).toEqual({ status: "error", message: "That rate card is not available to this customer." });
  });

  it("never treats a fee schedule it could not read as 'no fees'", async () => {
    install({ saved: [], feeStatus: null, feeError: { code: "XX000", message: "boom" } });
    expect(await previewForecast(assumptions())).toEqual({ status: "error", message: "Your fee schedule could not be loaded. Please try again." });
    install({ saved: [], feeStatus: null, feeError: { code: "P0002", message: "customer not found" } });
    expect(await previewForecast(assumptions())).toMatchObject({ status: "error", message: "You don't have permission to model costs for this customer." });
  });

  it("prices shipping only, with the reason, when the customer has no fee schedule", async () => {
    install({ saved: [], feeStatus: { status: "no_schedule" } });
    const response = await previewForecast(assumptions({ fulfillment: { drivers: {}, orderShares: {} } }));
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.result.headline).toMatchObject({ kind: "shipping_only", note: "No fee schedule is in effect for you on Mar 15, 2026, so this is shipping only." });
  });

  it("refuses answers for fees that are not on the schedule in effect on the date, and for a customer with no schedule", async () => {
    const stale = assumptions({ fulfillment: { drivers: { pallets_stored: "10", bins_stored: "3" }, orderShares: {} } });
    expect(await previewForecast(stale)).toEqual({ status: "invalid", problems: ["Some of your answers are for fees that are not on the fee schedule in effect on Mar 15, 2026. Reload the page, then answer again."] });
    install({ saved: [], feeStatus: { status: "no_schedule" } });
    expect(await previewForecast(assumptions())).toMatchObject({ status: "invalid" });
    // Skipping fulfillment costs ignores every answer.
    const skipped = assumptions({ fulfillment: { skip: true, drivers: { bins_stored: "3" }, orderShares: {} } });
    expect(await previewForecast(skipped)).toMatchObject({ status: "ok" });
  });

  it("blocks when part of the volume cannot be priced, tells a brand only the curated reason, and prices the rest when asked", async () => {
    const a = assumptions({ zones: [{ zone: "2", sharePct: "80" }, { zone: "9", sharePct: "20" }] });
    const brand = await previewForecast(a);
    if (brand.status !== "blocked") throw new Error(`expected blocked, got ${brand.status}`);
    expect(brand.unpriceableSharePct).toBe("20.00");
    expect(brand.unpriceable.length).toBeGreaterThan(0);
    expect(brand.unpriceable.every((u) => u.serviceId === "" && u.message === "" && u.reason === "no_rate_for_zone")).toBe(true);
    h.ctx = staffCtx;
    const staff = await previewForecast(a, BRAND);
    if (staff.status !== "blocked") throw new Error("expected blocked");
    expect(staff.unpriceable.every((u) => u.serviceId !== "" && u.message !== "")).toBe(true);
    const covered = await previewForecast(a, BRAND, { priceOnlyCovered: true });
    if (covered.status !== "ok") throw new Error("expected ok");
    expect(covered.result.headline.kind).toBe("partial");
    expect(covered.result.summary.priceOnlyCovered).toBe(true);
  });

  it("refuses a rate card that is not assigned to the customer", async () => {
    expect(await previewForecast(assumptions(), undefined, { rateCardId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })).toEqual({ status: "error", message: "That rate card is not assigned to this customer." });
    expect(await previewForecast(assumptions(), undefined, { rateCardId: CARD })).toMatchObject({ status: "ok" });
    expect(await previewForecast(assumptions(), undefined, { rateCardId: "nope" } as never)).toMatchObject({ status: "error" });
    install({ saved: [], cards: [] });
    expect(await previewForecast(assumptions())).toEqual({ status: "error", message: "No rate card is assigned to this customer yet, so nothing can be priced." });
  });
});

describe("saveForecast", () => {
  it("evaluates again on the server and hands save_forecast_run the canonical assumptions, the full summary and the pins", async () => {
    const db: Db = { saved: [] };
    install(db);
    const response = await saveForecast(assumptions(), "  Spring plan  ");
    expect(response).toEqual({ status: "saved", projectId: PROJECT, href: `/portal/model/forecast/${PROJECT}` });
    expect(db.saved).toHaveLength(1);
    const args = db.saved[0]!;
    expect(args).toMatchObject({ p_brand: BRAND, p_rate_card: CARD, p_name: "Spring plan", p_engine_version: ENGINE_VERSION, p_fee_engine_version: FEE_ENGINE_VERSION });
    // The stored assumptions carry the rate card's names, in canonical form (rows in canonical order, decimals normalised).
    const stored = args.p_assumptions as ForecastAssumptions;
    expect(stored).toEqual(canonicalizeAssumptions({ ...assumptions(), services: stored.services }));
    expect(stored.services.map((s) => s.name)).toEqual(["UPS Ground", "USPS Ground Advantage"]);
    // The summary is the full one (with its cells), and identical to what a preview shows.
    const summary = args.p_summary as { basis: string; cells: unknown[]; weightSum: string; monthlyOrders: string; allIn: { perOrder: string }; shipping: { definite: string }; processing: { definite: string } };
    expect(summary).toMatchObject({ basis: "assumptions", weightSum: "1250", monthlyOrders: "1250", allIn: { perOrder: "19.10" }, shipping: { definite: "0.00" }, processing: { definite: "0.00" } });
    expect(summary.cells).toHaveLength(48);
    expect(args.p_pins).toEqual({ rateCardVersionId: RATE_CARD_VERSION, ruleVersionIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], zipListIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"], overrideIds: [], loadIssues: ["A surcharge rule could not be applied."], feeScheduleVersionId: standard.versionId });
    expect(h.revalidated).toEqual([["/portal/model", "layout"], ["/portal", "layout"]]);
  });

  it("sends a staff forecast to the customer's pages", async () => {
    h.ctx = staffCtx;
    const db: Db = { saved: [] };
    install(db);
    expect(await saveForecast(assumptions(), "For Acme", BRAND)).toEqual({ status: "saved", projectId: PROJECT, href: `/app/customers/${BRAND}/model/forecast/${PROJECT}` });
    expect(db.saved[0]).toMatchObject({ p_brand: BRAND });
    expect(h.revalidated).toEqual([[`/app/customers/${BRAND}/model`, "layout"], [`/app/customers/${BRAND}`, "layout"]]);
  });

  it("pins the fee schedule version in effect even when fulfillment costs are skipped, and none when there is no schedule", async () => {
    const db: Db = { saved: [] };
    install(db);
    await saveForecast(assumptions({ fulfillment: { skip: true, drivers: {}, orderShares: {} } }), "Shipping only");
    expect((db.saved[0]!.p_pins as { feeScheduleVersionId: string | null }).feeScheduleVersionId).toBe(standard.versionId);
    expect((db.saved[0]!.p_summary as { feeMode: string }).feeMode).toBe("skipped");
    const none: Db = { saved: [], feeStatus: { status: "no_schedule" } };
    install(none);
    await saveForecast(assumptions({ fulfillment: { drivers: {}, orderShares: {} } }), "No schedule");
    expect((none.saved[0]!.p_pins as { feeScheduleVersionId: string | null }).feeScheduleVersionId).toBeNull();
  });

  it("needs a name, and stores nothing when the forecast is invalid, blocked or refused", async () => {
    const db: Db = { saved: [] };
    install(db);
    expect(await saveForecast(assumptions(), "   ")).toEqual({ status: "invalid", problems: ["name: Give the forecast a name."] });
    expect(await saveForecast(assumptions(), "x".repeat(161))).toEqual({ status: "invalid", problems: ["name: Use at most 160 characters."] });
    expect(await saveForecast(assumptions({ monthlyOrders: "0" }), "Bad")).toMatchObject({ status: "invalid" });
    expect(await saveForecast(assumptions({ zones: [{ zone: "2", sharePct: "80" }, { zone: "9", sharePct: "20" }] }), "Blocked")).toMatchObject({ status: "blocked" });
    h.limitOk = false;
    expect(await saveForecast(assumptions(), "Limited")).toEqual({ status: "error", message: "limited" });
    h.ctx = null;
    expect(await saveForecast(assumptions(), "Nobody")).toMatchObject({ status: "error" });
    expect(db.saved).toEqual([]);
  });

  it("saves a forecast that prices only what the rate card covers, with the flag in its summary", async () => {
    const db: Db = { saved: [] };
    install(db);
    const a = assumptions({ zones: [{ zone: "2", sharePct: "80" }, { zone: "9", sharePct: "20" }] });
    expect((await saveForecast(a, "Covered only", undefined, { priceOnlyCovered: true })).status).toBe("saved");
    expect(db.saved[0]!.p_summary).toMatchObject({ priceOnlyCovered: true, allIn: null });
  });

  it("explains the database's refusals in words and never shows its message", async () => {
    const refuse = async (error: { code?: string; message: string }) => {
      install({ saved: [], save: { data: null, error } });
      return saveForecast(assumptions(), "Plan");
    };
    expect(await refuse({ code: "P0002", message: "customer not found" })).toEqual({ status: "error", message: "Customer not found." });
    expect(await refuse({ code: "PC001", message: "rate card is not assigned to this customer" })).toEqual({ status: "error", message: "That rate card is not assigned to this customer." });
    expect(await refuse({ code: "PC001", message: "no fee schedule is in effect for this customer on that date" })).toMatchObject({ status: "error", message: expect.stringContaining("No fee schedule is in effect") });
    expect(await refuse({ code: "PC003", message: "forecast monthly charges do not reconcile (sql 12345)" })).toEqual({ status: "error", message: "The forecast could not be saved because its figures did not reconcile. Please try again; if it keeps failing, contact support." });
    const other = await refuse({ code: "XX000", message: "relation public.secret_table does not exist" });
    expect(other).toEqual({ status: "error", message: "Something went wrong. Please try again." });
    install({ saved: [], save: { data: { not: "a uuid" }, error: null } });
    expect(await saveForecast(assumptions(), "Plan")).toEqual({ status: "error", message: "Something went wrong. Please try again." });
  });
});

describe("loadForecastFormContext", () => {
  const input = { asOfDate: "2026-03-15" };
  const withVersions = () =>
    install({
      saved: [],
      tables: {
        rate_card_versions: [{ id: RATE_CARD_VERSION, version_number: 1, status: "active", effective_date: "2026-01-01", expiration_date: null }],
        rate_card_service_terms: pricing().rateCard.services.map((t) => ({
          service_id: t.serviceId,
          dim_divisor: t.dim.divisor,
          dim_threshold_cubic_in: t.dim.thresholdCubicIn,
          dimension_rounding: t.dim.dimensionRounding,
          weight_rounding: t.dim.weightRounding,
          min_billable_lb: t.dim.minBillableLb,
          dim_exempt: t.dim.exempt,
          min_charge: t.minCharge,
          included_surcharge_keys: [],
          excluded_surcharge_keys: [],
          zone_chart_key: "default",
          zone_independent: false,
          surcharge_markup_percent: null,
          source_reference: "FIXTURE",
          shipping_services: { id: t.serviceId, carrier_code: t.carrierCode, code: t.serviceCode, name: t.serviceName },
        })),
      },
    });

  it("loads what the form can choose from, for the customer's own rate card", async () => {
    withVersions();
    h.supabase = Object.assign(h.supabase as object, {});
    const fixture = pricing();
    const db = h.supabase as { rpc: (name: string, args: Record<string, unknown>) => Promise<FakeResult> };
    const original = db.rpc.bind(db);
    db.rpc = async (name, args) => (name === "rate_card_rows_json" ? { data: fixture.rateCard.rows, error: null } : name === "rate_card_zones_json" ? { data: fixture.rateCard.zones, error: null } : original(name, args));
    const ctx = await loadForecastFormContext({ ...input, originZip: "90001" });
    if (ctx.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(ctx)}`);
    expect(ctx).toMatchObject({ originZip: "90001", rateCard: { id: CARD, name: "Fixture rate card" } });
    expect(ctx.services.map((s) => s.name).sort()).toEqual(["UPS 2nd Day Air", "UPS Ground", "USPS Ground Advantage"]);
    expect(ctx.schedule.status).toBe("ok");
  });

  it("refuses an unreadable date or ZIP, a caller who may not model, and a rate limited one", async () => {
    expect(await loadForecastFormContext({ asOfDate: "2026-02-30" })).toEqual({ status: "failed", message: "Choose a valid date." });
    expect(await loadForecastFormContext({ asOfDate: "tomorrow" })).toEqual({ status: "failed", message: "Choose a valid date." });
    expect(await loadForecastFormContext({ ...input, extra: true })).toMatchObject({ status: "failed" });
    expect(await loadForecastFormContext({ ...input, originZip: "x".repeat(11) })).toMatchObject({ status: "failed" });
    h.limitOk = false;
    expect(await loadForecastFormContext(input)).toEqual({ status: "failed", message: "limited" });
    h.limitOk = true;
    h.ctx = null;
    expect(await loadForecastFormContext(input)).toMatchObject({ status: "failed" });
  });
});
