import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { evaluateForecast, type ForecastAssumptions } from "@/engine/forecast";
import { FEE_ENGINE_VERSION, type FeeScheduleSnapshot } from "@/engine/fees/types";
import { ENGINE_VERSION } from "@/engine/types";
import type { ModelingView } from "@/lib/modeling/page-context";
import { fakeSupabase } from "../fixtures/forecast/fake-supabase";

// The pages' server render with a fake database: what a customer and what 3PL staff are shown, and
// that a forecast that is not there is "not found" rather than an empty page.
vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/surcharges", () => ({ addSurchargeRuleVersion: vi.fn(), createSurchargeRule: vi.fn(), retireRuleVersion: vi.fn(), uploadZipList: vi.fn() }));
vi.mock("@/app/actions/forecast", () => ({ previewForecast: vi.fn(), saveForecast: vi.fn(), loadForecastFormContext: vi.fn() }));
vi.mock("@/app/actions/modeling", () => ({ archiveScenario: vi.fn(), renameScenario: vi.fn(), shareScenario: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { ForecastNewView, ForecastSavedView } = await import("@/components/forecast/views");
const { sha256Hex } = await import("@/lib/forecast/hash");
const { fixtureContext } = await import("../fixtures/pricing/load");

const schedules = JSON.parse(readFileSync(new URL("../fixtures/fees/schedules.json", import.meta.url), "utf8")) as Record<string, FeeScheduleSnapshot>;
const standard = schedules.standard!;
const pricing = fixtureContext();
const BRAND = "77777777-7777-4777-8777-777777777777";
const PROJECT = "99999999-9999-4999-8999-999999999999";
const text = (node: unknown) =>
  renderToStaticMarkup(node as never)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const assumptions: ForecastAssumptions = {
  version: 1,
  monthlyOrders: "1000",
  asOfDate: "2026-03-15",
  originZip: "90001",
  parcels: [{ weightLb: "1", lengthIn: "10", widthIn: "8", heightIn: "4", packagingType: "box", sharePct: "100" }],
  zones: [{ zone: "2", sharePct: "100" }],
  services: [{ serviceId: "svc-ups-ground", carrierCode: "ups", serviceCode: "ground", name: "UPS Ground", sharePct: "100" }],
  residentialPct: "50",
  multiPackage: { pct: "0", packagesPerOrder: 2 },
  content: { rows: [{ units: 2, lines: 1, sharePct: "100" }] },
  fulfillment: { drivers: {}, orderShares: {} },
};
const evaluated = evaluateForecast(assumptions, { pricing, schedule: standard, pinnedRates: {}, feeEngineVersion: FEE_ENGINE_VERSION, engineVersion: ENGINE_VERSION, hash: sha256Hex });
if (evaluated.status !== "ok") throw new Error("fixture forecast must price");

const termRows = pricing.rateCard.services.map((t) => ({
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
}));

function view(staff: boolean, tables: Record<string, unknown[]> = {}): ModelingView {
  const supabase = fakeSupabase({
    tables: {
      brand_rate_card_assignments: [{ rate_card_id: "card", allowed_service_ids: null, default_origin_zip: "90001", rate_cards: { id: "card", name: "Fixture rate card", status: "active" } }],
      rate_card_versions: [{ id: "v1", version_number: 1, status: "active", effective_date: "2026-01-01", expiration_date: null }],
      rate_card_service_terms: termRows,
      brand_fee_schedule_assignments: [{ id: "fa", schedule_id: "sched", assigned_at: "2026-01-02T00:00:00Z", fee_schedules: { id: "sched", name: standard.name, description: null } }],
      simulation_projects: [
        {
          id: PROJECT,
          name: "Spring plan",
          created_at: "2026-03-16T10:00:00Z",
          shared_with_brand: true,
          archived_at: null,
          rate_cards: { name: "Fixture rate card" },
          simulation_runs: [{ id: "r1", kind: "forecast", status: "completed", as_of_date: "2026-03-15", created_at: "2026-03-16T10:00:00Z", summary: evaluated.summary, assumptions }],
        },
      ],
      ...tables,
    },
    rpc: {
      rate_card_rows_json: { data: pricing.rateCard.rows, error: null },
      rate_card_zones_json: { data: pricing.rateCard.zones, error: null },
      brand_fee_schedule_on: { data: { status: "ok", snapshot: standard }, error: null },
    },
  });
  return {
    supabase,
    tenantId: "t",
    tenantName: "Fixture 3PL",
    brandId: BRAND,
    brandName: "Acme Goods",
    staff,
    basePath: staff ? `/app/customers/${BRAND}/model` : "/portal/model",
    reportsPath: staff ? `/app/customers/${BRAND}/model/reports` : "/portal/reports",
    tenantDefaultOriginZip: "10001",
  };
}

describe("ForecastNewView", () => {
  it("shows the form for a customer, in the customer's words", async () => {
    const t = text(await ForecastNewView(view(false), {}));
    expect(t).toContain("Forecast from your assumptions");
    expect(t).toContain("Describe the orders you expect and see the expected cost per order on your rate card and fee schedule. A forecast is an estimate, never an invoice or a quote.");
    expect(t).toContain("Model Costs");
    expect(t).toContain("Orders a month");
    expect(t).toContain("Your fee schedule Fictional Standard Fulfillment 2026");
    expect(t).not.toContain("private to your team");
  });

  it("shows staff the customer's name, the customer's wording and that nothing is shared until they say so", async () => {
    const t = text(await ForecastNewView(view(true), {}));
    expect(t).toContain("Model costs for Acme Goods");
    expect(t).toContain("on the customer's rate card and fee schedule");
    expect(t).toContain("What you prepare stays private to your team until you share it with the customer.");
    expect(t).toContain("The customer's fee schedule Fictional Standard Fulfillment 2026");
  });

  it("starts from a saved forecast with ?from=, and says so; an unknown one starts from scratch with a note", async () => {
    const from = text(await ForecastNewView(view(false), { from: PROJECT }));
    expect(from).toContain("Starting from Spring plan (priced on Mar 15, 2026).");
    const missing = text(await ForecastNewView(view(false, { simulation_projects: [] }), { from: PROJECT }));
    expect(missing).toContain("That forecast could not be found, so you are starting from scratch.");
    expect(missing).not.toContain("Starting from");
    // Not an id: ignored.
    expect(text(await ForecastNewView(view(false), { from: "../../etc/passwd" }))).not.toContain("could not be found");
  });

  it("says what is missing instead of showing a form that cannot work", async () => {
    expect(text(await ForecastNewView(view(false, { brand_rate_card_assignments: [] }), {}))).toContain("Fixture 3PL has not assigned a rate card to your account yet.");
    expect(text(await ForecastNewView(view(true, { brand_rate_card_assignments: [] }), {}))).toContain("Assign an active rate card to this customer first.");
    expect(text(await ForecastNewView(view(false, { rate_card_versions: [] }), {}))).toContain("has no rates in effect on");
    expect(text(await ForecastNewView(view(false, {}), {}))).not.toContain("Choose another date");
  });
});

describe("ForecastSavedView", () => {
  it("shows the saved result with its provenance, Edit as new forecast, rename, archive and what was described", async () => {
    const node = await ForecastSavedView(view(false), PROJECT);
    const html = renderToStaticMarkup(node as never);
    const t = text(node);
    expect(t).toContain("Spring plan");
    expect(t).toContain("Saved forecast");
    expect(t).toContain("Saved Mar 16, 2026 · Fixture rate card · priced on Mar 15, 2026. The forecast does not change afterwards; to try other numbers, edit it as a new forecast.");
    expect(html).toContain(`href="/portal/model/forecast?from=${PROJECT}"`);
    expect(t).toContain("Edit as new forecast");
    expect(t).toContain("Rename");
    expect(t).toContain("Archive");
    expect(t).toContain("Forecast from your assumptions at 1,000 orders a month. Each figure is the expected value over the mix you described; not a prediction for any month and not an invoice.");
    expect(t).toContain("What you described");
    // A brand does not share or hide: that is the 3PL's switch.
    expect(t).not.toContain("Share with customer");
    expect(t).not.toContain("Hide from customer");
    // Nothing a brand must not see.
    expect(html).not.toContain("svc-ups-ground");
    expect(html).not.toContain("pick_additional");
  });

  it("gives staff the share switch and a private-to-the-team badge until it is shared", async () => {
    const t = text(await ForecastSavedView(view(true, { simulation_projects: [{ id: PROJECT, name: "Prep", created_at: "2026-03-16T10:00:00Z", shared_with_brand: false, archived_at: null, rate_cards: { name: "Fixture rate card" }, simulation_runs: [{ id: "r1", kind: "forecast", status: "completed", as_of_date: "2026-03-15", created_at: "2026-03-16T10:00:00Z", summary: evaluated.summary, assumptions }] }] }), PROJECT));
    expect(t).toContain("Private to your team");
    expect(t).toContain("Share with customer");
    expect(t).toContain("Definite");
    const shared = text(await ForecastSavedView(view(true), PROJECT));
    expect(shared).not.toContain("Private to your team");
    expect(shared).toContain("Hide from customer");
  });

  it("marks an archived forecast and offers no second archive", async () => {
    const archived = view(false, { simulation_projects: [{ id: PROJECT, name: "Old", created_at: "2026-03-16T10:00:00Z", shared_with_brand: true, archived_at: "2026-04-01T00:00:00Z", rate_cards: { name: "Fixture rate card" }, simulation_runs: [{ id: "r1", kind: "forecast", status: "completed", as_of_date: "2026-03-15", created_at: "2026-03-16T10:00:00Z", summary: evaluated.summary, assumptions }] }] });
    const t = text(await ForecastSavedView(archived, PROJECT));
    expect(t).toContain("Archived");
    expect(t).not.toMatch(/Rename\s+Archive/);
  });

  it("is not found for an id that is not a UUID, a project that is not there, or one with no completed forecast", async () => {
    await expect(ForecastSavedView(view(false), "nope")).rejects.toThrow();
    await expect(ForecastSavedView(view(false, { simulation_projects: [] }), PROJECT)).rejects.toThrow();
    await expect(ForecastSavedView(view(false, { simulation_projects: [{ id: PROJECT, name: "x", created_at: "2026-03-16T10:00:00Z", shared_with_brand: true, archived_at: null, rate_cards: null, simulation_runs: [] }] }), PROJECT)).rejects.toThrow();
  });

  it("renders a saved forecast of staff and brand alike without throwing, whatever the summary holds", async () => {
    for (const staff of [false, true]) expect(createElement("div", null, await ForecastSavedView(view(staff), PROJECT))).toBeTruthy();
  });
});
