import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkSummary } from "@/engine/modeling";
import type { ModelingView } from "@/lib/modeling/page-context";
import { fakeSupabase, type FakeOptions } from "../fixtures/forecast/fake-supabase";
import { A, B, C, D2, complete, finalize, forecast, noStorageAnswer, partialForecast, schedule, skipped, standard } from "../fixtures/modeling/fee-runs";
import { leanAssumptions, leanColumns } from "../fixtures/modeling/summary-columns";

/**
 * The server side of the results screens with a fake database: the read models (orders, shipping per order,
 * fee contexts, who entered the assumptions), what the run page, hub and compare page show a customer and
 * 3PL staff, and the two CSV exports (sign-in, scoping, audit, pagination, columns).
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
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

// Who is signed in, and the database the export routes read.
const session: { user: { id: string } | null; ctx: unknown } = { user: { id: "u-brand" }, ctx: null };
vi.mock("@/lib/auth/session", () => ({
  getUser: async () => session.user,
  getContext: async () => session.ctx,
}));
const routeDb: { client: unknown } = { client: null };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => routeDb.client }));

const queries = await import("@/lib/modeling/queries");
const views = await import("@/components/modeling/views");
const lists = await import("@/components/modeling/lists");
const ordersRoute = await import("@/app/api/runs/[runId]/orders.csv/route");
const monthlyRoute = await import("@/app/api/runs/[runId]/monthly.csv/route");

const TENANT = "22222222-2222-4222-8222-222222222222";
const BRAND = "77777777-7777-4777-8777-777777777777";
const OTHER_BRAND = "88888888-8888-4888-8888-888888888888";
const PROJECT = "99999999-9999-4999-8999-999999999999";
const RUN = "11111111-1111-4111-8111-111111111111";
const RUN_B = "11111111-1111-4111-8111-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const text = (node: unknown) =>
  renderToStaticMarkup(node as never)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
const html = (node: unknown) => renderToStaticMarkup(node as never);

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------
type ShipRow = { order_id: string; status: string; expected: string };

/** A client whose `simulation_results` read honours `.in(order ids)` and `.range`, and records what it was asked. */
function shippingClient(rows: ShipRow[], error?: string) {
  const calls: { ids: string[]; from: number; to: number }[] = [];
  const client = {
    from() {
      let ids: string[] = [];
      let range: [number, number] = [0, 999];
      const b: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (resolve: (v: unknown) => void) => {
                calls.push({ ids, from: range[0], to: range[1] });
                resolve(error ? { data: null, error: { message: error } } : { data: rows.filter((r) => ids.includes(r.order_id)).slice(range[0], range[1] + 1), error: null });
              };
            }
            if (prop === "in") return (_c: string, v: string[]) => ((ids = v), b);
            if (prop === "range") return (f: number, t: number) => ((range = [f, t]), b);
            return () => b;
          },
        },
      );
      return b;
    },
  };
  return { client: client as never, calls };
}

describe("loadOrderShipping", () => {
  it("sums an order's shipments exactly, and gives no figure to an order with an unpriced shipment", async () => {
    const { client } = shippingClient([
      { order_id: "o1", status: "ok", expected: "0.10" },
      { order_id: "o1", status: "ok", expected: "0.20" },
      { order_id: "o2", status: "ok", expected: "8.00" },
      { order_id: "o2", status: "unavailable", expected: "0" },
    ]);
    const { shipping, error } = await queries.loadOrderShipping(client, "run", ["o1", "o2", "o3"]);
    expect(error).toBeNull();
    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    expect(shipping.get("o1")).toEqual({ expected: "0.30" });
    expect(shipping.get("o2")).toEqual({ expected: null });
    expect(shipping.has("o3")).toBe(false);
  });

  it("reads the ids in chunks of 100, so 1,000 orders never put 1,000 ids in one request", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `order-${i}`);
    const { client, calls } = shippingClient(ids.map((id) => ({ order_id: id, status: "ok", expected: "1.10" })));
    const { shipping } = await queries.loadOrderShipping(client, "run", ids);
    expect(calls.map((c) => c.ids.length).sort((a, b) => b - a)).toEqual([100, 100, 50]);
    expect(shipping.size).toBe(250);
    expect(shipping.get("order-249")).toEqual({ expected: "1.10" });
  });

  it("keeps reading while a chunk fills a page, so a server cap cannot drop shipments silently", async () => {
    const rows: ShipRow[] = Array.from({ length: 1500 }, () => ({ order_id: "big", status: "ok", expected: "0.01" }));
    const { client, calls } = shippingClient(rows);
    const { shipping } = await queries.loadOrderShipping(client, "run", ["big"]);
    expect(calls.map((c) => [c.from, c.to])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(shipping.get("big")).toEqual({ expected: "15.00" });
  });

  it("reports a failed read instead of an empty result", async () => {
    const { client } = shippingClient([], "boom");
    const result = await queries.loadOrderShipping(client, "run", ["o1"]);
    expect(result.error).toBe("boom");
    expect(result.shipping.size).toBe(0);
    expect((await queries.loadOrderShipping(client, "run", [])).error).toBeNull();
  });
});

describe("loadOrderResults", () => {
  const dbRow = (over: Record<string, unknown> = {}) => ({ order_id: "o1", first_row_no: "7", units: 3, lines: null, packages: 1, shipments: 1, assumed: null, fee_status: "ok", processing_definite: "20000", processing_estimated: 0, unresolved: null, in_totals: true, orders: { external_order_id: "ORD-1", order_date: "2026-03-03" }, ...over });

  it("maps a stored order result: ten-thousandths as numbers, unknown stays null, never a zero", async () => {
    const r = await queries.loadOrderResults(fakeSupabase({ tables: { simulation_order_results: [dbRow()] } }), "run", { from: 0, to: 49 });
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([{ orderId: "o1", externalOrderId: "ORD-1", orderDate: "2026-03-03", firstRowNo: 7, units: 3, lines: null, packages: 1, shipments: 1, assumed: {}, feeStatus: "ok", definiteE4: 20000, estimatedE4: 0, unresolved: [], inTotals: true }]);
  });

  it("says so when the read fails", async () => {
    const r = await queries.loadOrderResults(fakeSupabase({ errors: { simulation_order_results: { message: "nope" } } }), "run", { from: 0, to: 49 });
    expect(r).toMatchObject({ rows: [], error: "nope" });
  });
});

describe("loadRunFeeContexts", () => {
  it("lists the versions that priced the run with their dates, and the dates nothing covered", async () => {
    const supabase = fakeSupabase({
      tables: {
        simulation_run_fee_contexts: [
          { fee_date: "2026-01-05", fee_schedule_version_id: null, unavailable_reason: "not_effective" },
          { fee_date: "2026-03-01", fee_schedule_version_id: "v-1", unavailable_reason: null },
          { fee_date: "2026-04-01", fee_schedule_version_id: "v-1", unavailable_reason: null },
        ],
        fee_schedule_versions: [{ id: "v-1", effective_date: "2026-01-20", expiration_date: null }],
      },
    });
    expect(await queries.loadRunFeeContexts(supabase, "run")).toEqual({ versions: [{ versionId: "v-1", effectiveDate: "2026-01-20", expirationDate: null }], uncovered: { from: "2026-01-05", to: "2026-01-05", dates: 1 } });
  });

  it("is null when the read fails (never reported as no versions)", async () => {
    expect(await queries.loadRunFeeContexts(fakeSupabase({ errors: { simulation_run_fee_contexts: { message: "x" } } }), "run")).toBeNull();
  });
});

describe("loadCurrentFeeVersion", () => {
  const assignment = { id: "a", schedule_id: "s", assigned_at: "2026-01-02T00:00:00Z", fee_schedules: { id: "s", name: "Standard", description: null } };
  const current = (rpc: FakeOptions["rpc"]) => queries.loadCurrentFeeVersion(fakeSupabase({ tables: { brand_fee_schedule_assignments: [assignment] }, rpc }), BRAND);

  it("returns the version in effect, none when there is no schedule, and unknown when the lookup fails", async () => {
    expect(await current({ brand_fee_schedule_on: { data: { status: "ok", snapshot: { ...standard, versionId: "v-9" } }, error: null } })).toEqual({ status: "ok", versionId: "v-9" });
    expect(await current({ brand_fee_schedule_on: { data: { status: "no_schedule" }, error: null } })).toEqual({ status: "none" });
    expect(await current({ brand_fee_schedule_on: { data: null, error: { code: "XX000", message: "boom" } } })).toEqual({ status: "unknown" });
  });
});

describe("loadAssumptionsAuthor", () => {
  const input = { createdBy: STAFF, viewerId: USER, viewerCanSeeMembers: true, brandId: BRAND };

  it("is you for your own run, whatever else is known", async () => {
    expect(await queries.loadAssumptionsAuthor(fakeSupabase({}), { ...input, createdBy: USER })).toBe("you");
    expect(await queries.loadAssumptionsAuthor(fakeSupabase({}), { ...input, createdBy: USER, viewerCanSeeMembers: false })).toBe("you");
  });

  it("is the 3PL's team when the creator is not a member of the customer, another user when they are", async () => {
    expect(await queries.loadAssumptionsAuthor(fakeSupabase({ tables: { memberships: [] } }), input)).toBe("tenant");
    expect(await queries.loadAssumptionsAuthor(fakeSupabase({ tables: { memberships: [{ id: "m1" }] } }), input)).toBe("other");
  });

  it("never guesses: without permission to see members, or when the read fails, it is another user", async () => {
    expect(await queries.loadAssumptionsAuthor(fakeSupabase({ tables: { memberships: [] } }), { ...input, viewerCanSeeMembers: false })).toBe("other");
    expect(await queries.loadAssumptionsAuthor(fakeSupabase({ errors: { memberships: { message: "x" } } }), input)).toBe("other");
    expect(await queries.loadAssumptionsAuthor(fakeSupabase({}), { ...input, createdBy: null })).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// The run page
// ---------------------------------------------------------------------------
const orderDb = (id: string, n: number, over: Record<string, unknown> = {}) => ({
  order_id: id,
  first_row_no: n,
  units: 3,
  lines: 2,
  packages: 1,
  shipments: 1,
  assumed: {},
  fee_status: "ok",
  processing_definite: 20000,
  processing_estimated: 0,
  unresolved: [],
  in_totals: true,
  orders: { external_order_id: `ORD-${n}`, order_date: "2026-03-03" },
  ...over,
});

function runRow(summary: unknown, over: Record<string, unknown> = {}, project: Record<string, unknown> = {}) {
  return {
    id: RUN,
    project_id: PROJECT,
    brand_id: BRAND,
    status: "completed",
    kind: "bulk",
    pricing_basis: "fixed_date",
    as_of_date: "2026-03-15",
    service_override_id: null,
    assumptions: { fulfillment: { drivers: { pallets: "10" }, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } } },
    created_at: "2026-10-14T09:00:00Z",
    created_by: USER,
    finished_at: "2026-10-14T09:05:00Z",
    last_progress_at: "2026-10-14T09:05:00Z",
    total_shipments: 4,
    processed_shipments: 4,
    modeled_orders: 4,
    total_expected: "50.00",
    summary,
    monthly_fee_schedule_version_id: "v-1",
    single_input: null,
    single_result: null,
    error: null,
    simulation_projects: { id: PROJECT, name: "March plan", dataset_id: "d-1", shared_with_brand: true, rate_cards: { name: "Fixture card" }, order_datasets: { name: "March orders", mapping: null, validation: null }, ...project },
    shipping_services: null,
    ...over,
  };
}

function modelingView(staff: boolean, tables: Record<string, unknown[]> = {}, rpc: FakeOptions["rpc"] = {}, errors: FakeOptions["errors"] = {}): ModelingView {
  const supabase = fakeSupabase({
    tables: {
      brand_rate_card_assignments: [],
      brand_fee_schedule_assignments: [{ id: "fa", schedule_id: "sched", assigned_at: "2026-01-02T00:00:00Z", fee_schedules: { id: "sched", name: "Standard fulfillment", description: null } }],
      simulation_run_fee_contexts: [{ fee_date: "2026-03-15", fee_schedule_version_id: "v-1", unavailable_reason: null }],
      fee_schedule_versions: [{ id: "v-1", effective_date: "2026-01-01", expiration_date: null }],
      simulation_results: [],
      simulation_order_results: [orderDb("o1", 1), orderDb("o2", 2, { units: null, lines: null, fee_status: "no_content", processing_definite: 0, unresolved: [{ ruleKey: "pick_order", reason: "units_unknown" }] })],
      order_datasets: [{ line_count: 4, validation: { counts: { lines: 4, units: 12 } } }],
      packages: [],
      memberships: [],
      ...tables,
    },
    rpc: {
      dataset_forecast_period: { data: null, error: { message: "not stubbed" } },
      brand_fee_schedule_on: { data: { status: "ok", snapshot: { ...standard, versionId: "v-1" } }, error: null },
      ...rpc,
    },
    errors,
  });
  return {
    supabase,
    tenantId: TENANT,
    tenantName: "Acme 3PL",
    brandId: BRAND,
    brandName: "Acme Goods",
    staff,
    basePath: staff ? `/app/customers/${BRAND}/model` : "/portal/model",
    reportsPath: staff ? `/app/customers/${BRAND}/model/reports` : "/portal/reports",
    tenantDefaultOriginZip: "10001",
  };
}

const FORBIDDEN_TEXT = /pick_order|pack_box|storage_pallet|returns_proc|packaging:[a-z_*]|\br-(pick|box|pallet|admin|min|ins|ret)\b|\bv-1\b|\bs-1\b|sched-standard/;

function signInAs(role: "brand_admin" | "brand_employee" | "tenant_admin", userId = USER) {
  const brand = role !== "tenant_admin";
  session.user = { id: userId };
  session.ctx = { user: { id: userId }, active: { role, portal: brand ? "brand" : "tenant", tenantId: TENANT, tenantName: "Acme 3PL", brandId: brand ? BRAND : null } };
}

beforeEach(() => signInAs("brand_admin"));

async function runPage(summary: BulkSummary | unknown, over: { staff?: boolean; params?: Record<string, string>; run?: Record<string, unknown>; project?: Record<string, unknown>; tables?: Record<string, unknown[]>; rpc?: FakeOptions["rpc"]; errors?: FakeOptions["errors"] } = {}) {
  const v = modelingView(over.staff ?? false, { simulation_runs: [runRow(summary, over.run, over.project)], ...over.tables }, over.rpc, over.errors);
  return views.RunView(v, RUN, over.params ?? {});
}

describe("RunView for a customer", () => {
  it("leads with the all-in cost per order when it is complete, under a view control that says what each contains", async () => {
    const node = await runPage(complete);
    const t = text(node);
    expect(t).toContain("All-in cost per order");
    expect(t).toContain("$275.00");
    expect(t).not.toContain("All-in cost per order, without");
    for (const label of ["Shipping", "Order fees", "All-in"]) expect(t).toContain(label);
    expect(t).toContain("Shipping is the shipping charge from the rate card only. Order fees add the charges that depend on each order");
    const h = html(node);
    expect(h).toContain('href="/portal/model/runs/' + RUN + '?view=shipping"');
    expect(h).toContain('href="/portal/model/runs/' + RUN + '?view=fees"');
    expect(h).toMatch(/aria-current="true"[^>]*>(<span[^>]*>✓<\/span>)?All-in/);
  });

  it("defaults to Shipping when the all-in is not complete, and the All-in view then says what is left out, with Add links", async () => {
    const t = text(await runPage(noStorageAnswer));
    expect(t).toContain("Estimated shipping cost per order");
    expect(t).not.toContain("All-in cost per order, without storage");
    const allIn = await runPage(noStorageAnswer, { params: { view: "allin" } });
    const at = text(allIn);
    expect(at).toContain("All-in cost per order, without storage");
    expect(at).toContain("At least $26.94");
    expect(at).toContain("Not included, because no numbers were given");
    expect(at).toContain("Pallet storage: $18.00 per pallet per month");
    expect(html(allIn)).toContain('href="#run-again"');
    // The minimum could not be worked out exactly: its own sentence, not a hidden gap.
    expect(at).toContain("The account minimum could add up to $496.13 a month");
  });

  it("a monthly figure that leaves a charge out says At least, on the card and on the tile", async () => {
    const t = text(await runPage(noStorageAnswer));
    // Pallet storage has no number: the $25.00 account fee is all that was priced, so it is a lower bound, and the missing charge is named below it.
    expect(t).toContain("At least $25.00 a month, whatever you ship");
    expect(t).toContain("Spread over your orders, that is at least $12.50 per order at 2 orders a month.");
    expect(t).toContain("Not modeled, because no number was given");
    const tiles = text(lists.ModelTiles({ summary: noStorageAnswer }));
    expect(tiles).toContain("At least $25.00 a month");
    expect(tiles).toContain("at least about $12.50 per order, spread over your orders");
    // A complete model keeps the plain figures.
    expect(text(await runPage(complete))).toContain("$205.00 a month, whatever you ship");
    expect(text(lists.ModelTiles({ summary: complete }))).not.toContain("At least $205.00");
  });

  it("a fee schedule with no monthly charges is None, not a missing number", () => {
    const none = finalize([A, B, C, D2], { monthlySchedule: { ...schedule, rules: schedule.rules.filter((r) => r.scope === "order") } });
    const tiles = text(lists.ModelTiles({ summary: none }));
    expect(tiles).toContain("Monthly charges None The fee schedule has no monthly charges.");
    // A skipped model has nothing to say about monthly charges: that one is "not computed".
    expect(text(lists.ModelTiles({ summary: skipped }))).toContain("Monthly charges Not computed Fulfillment costs were not modeled for this run.");
  });

  it("says where the fees and the assumptions came from, and when the fee schedule has changed since", async () => {
    const t = text(await runPage(complete));
    expect(t).toContain("Acme 3PL fee schedule 'Standard fulfillment', in effect from Jan 1, 2026.");
    expect(t).toContain("Assumptions entered by you on Oct 14, 2026.");
    expect(t).not.toContain("Fees have changed since this model was priced");
    const changed = text(await runPage(complete, { rpc: { brand_fee_schedule_on: { data: { status: "ok", snapshot: { ...standard, versionId: "v-2" } }, error: null } } }));
    expect(changed).toContain("Fees have changed since this model was priced.");
    expect(changed).toContain("Run it again");
    // A lookup that failed is not a change.
    expect(text(await runPage(complete, { rpc: { brand_fee_schedule_on: { data: null, error: { code: "XX000", message: "boom" } } } }))).not.toContain("Fees have changed");
  });

  it("says the 3PL entered the assumptions when someone outside the customer's team did", async () => {
    const t = text(await runPage(complete, { run: { created_by: STAFF } }));
    expect(t).toContain("Assumptions entered by Acme 3PL on Oct 14, 2026.");
    const teammate = text(await runPage(complete, { run: { created_by: STAFF }, tables: { memberships: [{ id: "m" }] } }));
    expect(teammate).toContain("Assumptions entered by another user on Oct 14, 2026.");
    // A role that cannot see the customer's members cannot tell the 3PL from a teammate: it says "another user", never a guess.
    signInAs("brand_employee");
    expect(text(await runPage(complete, { run: { created_by: STAFF } }))).toContain("Assumptions entered by another user on Oct 14, 2026.");
    // No answers, no sentence.
    expect(text(await runPage(complete, { run: { assumptions: {} } }))).not.toContain("Assumptions entered by");
  });

  it("shows the order fees, monthly charges, account minimum and not-included cards", async () => {
    const t = text(await runPage(complete));
    expect(t).toContain("Order fees");
    expect(t).toContain("Orders charged");
    expect(t).toContain("From your fee schedule");
    expect(t).toContain("Based on assumptions");
    // Monthly charges lead with dollars a month, never a per-order fee, and print their basis.
    expect(t).toContain("$205.00 a month, whatever you ship");
    expect(t).toContain("This is monthly charges shared across orders, not a per-order fee.");
    expect(t).toContain("Basis: 2 orders a month over Mar 1, 2026–Apr 30, 2026 (2 months).");
    expect(t).toContain("10 pallets × $18.00 = $180.00 a month.");
    expect(t).toContain("The account minimum adds $316.13 a month on top (see Account minimum below), so with it the monthly charges come to about $260.56 per order.");
    expect(t).toContain("The all-in cost per order at other volumes");
    expect(t).toContain("0.5× your volume");
    expect(t).toContain("4× your volume");
    // The account minimum is worked out again at each volume: $537.50 at half the volume, $78.13 at four times it.
    expect(t).toContain("0.5× your volume 1 $537.50 $537.50");
    expect(t).toContain("4× your volume 8 $78.13 $625.00");
    // The minimum, month by month, with what counts toward it.
    expect(t).toContain("Account minimum");
    expect(t).toContain("What counts toward it");
    expect(t).toContain("Added");
    // Not included, in three groups.
    expect(t).toContain("Never included");
    expect(t).toContain("Return shipping.");
  });

  it("lists the orders with units, lines, packages, shipping, order fees and shipping + order fees, and no per-order all-in", async () => {
    const t = text(await runPage(complete, { tables: { simulation_results: [{ order_id: "o1", status: "ok", expected: "10.00" }, { order_id: "o2", status: "ok", expected: "12.00" }] } }));
    for (const heading of ["Units", "Lines", "Packages", "Shipping", "Order fees", "Shipping + order fees"]) expect(t).toContain(heading);
    expect(t).toContain("Monthly charges are not per-order fees and are not shown here.");
    // Order 1: $2.00 of fees + $10.00 of shipping. Order 2 has no item counts: fees not computed, never $0.
    expect(t).toContain("ORD-1 3 2 1 $10.00 $2.00 $12.00");
    expect(t).toMatch(/ORD-2 — — 1 \$12\.00 Not computed Not computed/);
    // No column of the orders table is an all-in or an allocated charge.
    const table = html(await runPage(complete)).match(/<table[^>]*>(?:(?!<\/table>)[\s\S])*Shipping \+ order fees[\s\S]*?<\/table>/)?.[0] ?? "";
    expect(table).not.toMatch(/All-in|Allocated|Monthly/);
  });

  it("offers the three downloads, and no monthly one when fulfillment costs were skipped", async () => {
    const h = html(await runPage(complete));
    expect(h).toContain(`href="/api/runs/${RUN}/results.csv"`);
    expect(h).toContain(`href="/api/runs/${RUN}/orders.csv"`);
    expect(h).toContain(`href="/api/runs/${RUN}/monthly.csv"`);
    const none = html(await runPage(skipped));
    expect(none).toContain("results.csv");
    expect(none).not.toContain("orders.csv");
    expect(none).not.toContain("monthly.csv");
  });

  it("a run that skipped fulfillment costs shows shipping and says every fee was left out, with no orders table", async () => {
    const t = text(await runPage(skipped));
    expect(t).toContain("Estimated shipping cost per order");
    expect(t).toContain("Fulfillment costs were skipped for this model, so only shipping is shown.");
    expect(t).toContain("Left out because fulfillment costs were skipped");
    expect(t).not.toContain("Left out because no numbers were given");
    expect(t).not.toContain("Shipping + order fees");
    expect(t).not.toContain("Account minimum");
  });

  it("opens step 2 of the form with what the run was started with, below the results", async () => {
    const answered = { assumptions: { fulfillment: { drivers: { pallets_stored: "14" }, orderShares: {} } } };
    const h = html(await runPage(complete, { run: answered, rpc: { dataset_forecast_period: { data: { population: 4, dated: 4, undated: 0, from: "2026-03-01", to: "2026-04-30", days: 61, months: "2.000000", inPeriod: 4, trimmed: 0 }, error: null } } }));
    expect(h).toContain('id="run-again"');
    const t = text(h);
    expect(t).toContain("Run again, or change the settings");
    // One form, two steps: step 1 continues to the fulfillment questions, which are answered as the run was.
    expect(t).toContain("Continue to fulfillment costs");
    expect(t).toContain("Step 2 of 2");
    expect(t).toContain("Fulfillment costs");
    expect(h).toContain('name="fulfillment"');
    expect(h).toContain('value="14"');
  });

  describe("step 2 of the run-again form asks the questions of the date the model was priced for", () => {
    const period = { data: { population: 4, dated: 4, undated: 0, from: "2026-03-01", to: "2026-04-30", days: 61, months: "2.000000", inPeriod: 4, trimmed: 0 }, error: null };
    const inEffect = { data: { status: "ok", snapshot: { ...standard, versionId: "v-1" } }, error: null };
    const notInEffect = { data: { status: "not_effective", scheduleId: "sched", name: "Standard fulfillment" }, error: null };

    it("reads the version in effect on the as-of date (not today's), so an Add link on a past model leads to a form that has step 2", async () => {
      const asked: unknown[] = [];
      // Only the model's own date has a version in effect; today does not.
      const rpc = { dataset_forecast_period: period, brand_fee_schedule_on: (args: Record<string, unknown>) => (asked.push(args.p_date), args.p_date === "2026-03-15" ? inEffect : notInEffect) };
      const h = html(await runPage(complete, { run: { pricing_basis: "fixed_date", as_of_date: "2026-03-15" }, rpc }));
      // The first read is the form's (the model's date); the second is the "fees have changed since" notice's, which is about today.
      expect(asked[0]).toBe("2026-03-15");
      expect(text(h)).toContain("Step 2 of 2");
      expect(h).toContain('name="fulfillment"');
    });

    it("reads the version in effect at the end of the file's period for a model priced on each order's own date", async () => {
      const asked: unknown[] = [];
      const rpc = { dataset_forecast_period: period, brand_fee_schedule_on: (args: Record<string, unknown>) => (asked.push(args.p_date), inEffect) };
      await runPage(complete, { run: { pricing_basis: "ship_date", as_of_date: null }, rpc });
      expect(asked[0]).toBe("2026-04-30");
    });

    it("has no step 2 when no version was in effect on that date, and says there are no questions", async () => {
      const rpc = { dataset_forecast_period: period, brand_fee_schedule_on: () => notInEffect };
      const h = html(await runPage(complete, { run: { pricing_basis: "fixed_date", as_of_date: "2019-01-01" }, rpc }));
      expect(text(h)).not.toContain("Step 2 of 2");
      expect(h).not.toContain('name="fulfillment"');
      expect(text(h)).toContain("is not in effect today, so there are no fulfillment questions to answer here");
    });
  });

  it("shows no rule key, id, version or note to the customer", async () => {
    const pages = [await runPage(complete), await runPage(noStorageAnswer, { params: { view: "allin" } }), await runPage(skipped)];
    for (const p of pages) {
      expect(text(p)).not.toMatch(FORBIDDEN_TEXT);
      expect(text(p)).not.toMatch(/version \d/i);
    }
  });

  it("an order list that cannot be read says so instead of an empty table or a wrong 'not priced'", async () => {
    const t = text(await runPage(complete, { errors: { simulation_order_results: { message: "boom" } } }));
    expect(t).toContain("The orders could not be loaded just now.");
    const shipping = text(await runPage(complete, { tables: { simulation_results: [] }, errors: {} }));
    expect(shipping).not.toContain("The orders could not be loaded");
  });

  it("sends a forecast to its own page, and not-found for a run of another customer", async () => {
    await expect(runPage(forecast(), { run: { kind: "forecast" } })).rejects.toMatchObject({ digest: expect.stringContaining(`/portal/model/forecast/${PROJECT}`) });
    await expect(runPage(complete, { run: { brand_id: OTHER_BRAND } })).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404") });
  });

  it("explains a model priced before fees existed, and offers to run it again", async () => {
    const t = text(await runPage({ version: 1, modeled: { orders: 4 } }));
    expect(t).toContain("This model was priced before fulfillment fees were added");
    expect(t).toContain("Run it again below to price shipping and fees together.");
    expect(t).toContain("Run again, or change the settings");
  });
});

describe("RunView for 3PL staff", () => {
  it("adds the on-behalf header and the sharing state, and links the exports with the customer", async () => {
    signInAs("tenant_admin", STAFF);
    const node = await runPage(complete, { staff: true, project: { shared_with_brand: false }, run: { created_by: STAFF } });
    const t = text(node);
    expect(t).toContain("Modeled on behalf of Acme Goods.");
    expect(t).toContain("Private to your team");
    expect(t).toContain("Assumptions entered by you on Oct 14, 2026.");
    const h = html(node);
    expect(h).toContain(`href="/api/runs/${RUN}/orders.csv?brandId=${BRAND}"`);
    expect(h).toContain(`href="/api/runs/${RUN}/monthly.csv?brandId=${BRAND}"`);
    expect(h).toContain(`href="/app/customers/${BRAND}/model/runs/${RUN}?view=shipping"`);
    expect(t).toContain("All-in cost per order");
  });
});

// ---------------------------------------------------------------------------
// Hub and compare
// ---------------------------------------------------------------------------
/** A run row as the lists' lean select answers it: the run's columns and the headline inputs of its summary, never the whole summary. */
const projectRow = (id: string, name: string, runId: string, summary: unknown, over: { kind?: string; run?: Record<string, unknown> } = {}) => ({
  id,
  kind: over.kind ?? "bulk",
  name,
  created_at: "2026-10-14T09:00:00Z",
  shared_with_brand: true,
  archived_at: null,
  dataset_id: over.kind === "forecast" ? null : "d-1",
  rate_cards: { name: "Fixture card" },
  order_datasets: over.kind === "forecast" ? null : { name: "March orders" },
  simulation_runs: [{ id: runId, status: "completed", kind: over.kind ?? "bulk", pricing_basis: "fixed_date", as_of_date: "2026-03-15", created_at: "2026-10-14T09:00:00Z", finished_at: "2026-10-14T09:05:00Z", last_progress_at: "2026-10-14T09:05:00Z", total_shipments: 4, processed_shipments: 4, modeled_orders: 4, total_expected: "50.00", ...leanColumns(summary), service_override_id: null, ...leanAssumptions(null), shipping_services: null, ...over.run }],
});

/** A run as the comparison reads it: the whole summary and every assumption (`loadRunsForCompare`). */
const fullRun = (id: string, summary: unknown, assumptions: unknown = {}, kind = "bulk") => ({ id, kind, summary, assumptions });

describe("ModelHubView", () => {
  it("shows a customer the headline with its completeness label, the forecast card and their fee schedule", async () => {
    const v = modelingView(false, { order_datasets: [], simulation_projects: [projectRow(PROJECT, "March plan", RUN, noStorageAnswer)] });
    const node = await views.ModelHubView(v);
    const t = text(node);
    expect(t).toContain("All-in cost per order, without storage");
    expect(t).toContain("At least $26.94");
    expect(t).toContain("Forecast from assumptions");
    expect(t).toContain("Your fee schedule");
    const h = html(node);
    expect(h).toContain('href="/portal/model/forecast"');
    expect(h).toContain('href="/portal/model/fees"');
    expect(t).not.toMatch(FORBIDDEN_TEXT);
  });

  it("gives staff the forecast card but not the customer's fee schedule page, which has no staff equivalent", async () => {
    signInAs("tenant_admin", STAFF);
    const node = await views.ModelHubView(modelingView(true, { order_datasets: [], simulation_projects: [] }));
    const h = html(node);
    expect(h).toContain(`href="/app/customers/${BRAND}/model/forecast"`);
    expect(h).not.toContain("/fees");
    expect(text(node)).not.toContain("Your fee schedule");
  });

  it("shows forecasts and what-ifs as their own labelled tiles, never mixed into the latest model's figures", async () => {
    const forecastRun = "11111111-1111-4111-8111-333333333333";
    const v = modelingView(false, {
      order_datasets: [],
      simulation_projects: [projectRow(PROJECT, "March plan", RUN, complete), projectRow("99999999-9999-4999-8999-aaaaaaaaaaaa", "Spring plan", forecastRun, forecast(), { kind: "forecast" })],
    });
    const t = text(await views.ModelHubView(v));
    expect(t).toContain("From your latest model");
    expect(t).toContain("Forecasts and what-ifs");
    expect(t).toContain("Forecast from assumptions: All-in cost per order");
    expect(t).toContain("Expected values over the mix you described, never an invoice.");
  });
});

describe("a forecast that priced only part of its volume", () => {
  const forecastRun = "11111111-1111-4111-8111-555555555555";
  const spring = "99999999-9999-4999-8999-dddddddddddd";
  const SENTENCE = "Only 80.00% of the volume could be priced";

  it("says how much on the hub's forecast tile and on its line in the scenario list, never a plain shipping figure", async () => {
    const v = modelingView(false, { order_datasets: [], simulation_projects: [projectRow(spring, "Spring plan", forecastRun, partialForecast(), { kind: "forecast" })] });
    const t = text(await views.ModelHubView(v));
    expect(t).toContain("Forecast from assumptions: Estimated shipping cost per order");
    expect(t).toContain("Forecast at 1,250 orders a month. Only 80.00% of the volume could be priced, so this is an average over that part");
    // The list line: label, figure, then the share, in brackets.
    expect(t).toMatch(/Estimated shipping cost per order: \$[\d.,]+ \(only 80\.00% of the volume could be priced, so this is an average over that part\)/);
    // Once on the tile, once on the list line.
    expect(t.match(/only 80\.00% of the volume could be priced/gi)).toHaveLength(2);
    expect(t).not.toMatch(FORBIDDEN_TEXT);
  });

  it("says nothing of the kind for a forecast that priced everything", async () => {
    const v = modelingView(false, { order_datasets: [], simulation_projects: [projectRow(spring, "Spring plan", forecastRun, forecast(), { kind: "forecast" })] });
    expect(text(await views.ModelHubView(v))).not.toContain("of the volume could be priced");
  });

  it("the customer's overview (the portal page's tiles) carries it too", async () => {
    const projects = (await queries.loadModelingLists(modelingView(false, { simulation_projects: [projectRow(spring, "Spring plan", forecastRun, partialForecast(), { kind: "forecast" })], order_datasets: [] }).supabase, BRAND)).projects;
    const t = text(createElement(lists.OverviewFigures, { projects, basePath: "/portal/model", tenantName: "Acme 3PL", audience: "brand" }));
    expect(t).toContain(SENTENCE);
  });

  it("is flagged in the comparison on the per-order rows, with the share", async () => {
    const projects = [projectRow(PROJECT, "March plan", RUN, complete), projectRow(spring, "Spring plan", forecastRun, partialForecast(), { kind: "forecast" })];
    const runs = [fullRun(RUN, complete), fullRun(forecastRun, partialForecast(), {}, "forecast")];
    const t = text(await views.ReportsView(modelingView(false, { order_datasets: [], simulation_projects: projects, simulation_runs: runs }), { a: forecastRun, b: RUN }));
    expect(t).toContain('averages over the part of its volume that could be priced (80.00% in the first); the rest is not estimated.');
    expect(t).toContain("80.00% of the volume");
  });
});

describe("ReportsView compare", () => {
  const second = "99999999-9999-4999-8999-bbbbbbbbbbbb";
  const projects = [projectRow(PROJECT, "March plan", RUN, complete), projectRow(second, "No storage numbers", RUN_B, noStorageAnswer), projectRow("99999999-9999-4999-8999-cccccccccccc", "Spring forecast", "11111111-1111-4111-8111-444444444444", forecast(), { kind: "forecast" })];

  it("compares two models with the basis first, the comparable row, and greyed all-in rows with a note", async () => {
    const answers = (drivers: Record<string, string | null>) => ({ fulfillment: { drivers, orderShares: {} } });
    const runs = [fullRun(RUN, complete, answers({ pallets: "10" })), fullRun(RUN_B, noStorageAnswer, answers({}))];
    const node = await views.ReportsView(modelingView(false, { order_datasets: [], simulation_projects: projects, simulation_runs: runs }), { a: RUN, b: RUN_B });
    const t = text(node);
    expect(t.indexOf("What each one is based on")).toBeLessThan(t.indexOf("Per order"));
    expect(t.indexOf("Per order")).toBeLessThan(t.indexOf("All-in, with monthly charges spread over orders"));
    expect(t).toContain("Shipping + order fees (comparable)");
    expect(t).toContain("All-in cost per order (not comparable)");
    expect(t).toContain("These two all-in figures leave out different things");
    expect(t).toContain("What differs in the assumptions");
    expect(t).toContain("pallet storage 10 → left out");
    expect(html(node)).toContain('class="text-muted"');
    expect(t).not.toMatch(FORBIDDEN_TEXT);
    expect(t).not.toContain("PDF reports arrive in a later release");
  });

  it("offers forecasts as models to compare with, and compares one through the same rows", async () => {
    const forecastRun = "11111111-1111-4111-8111-444444444444";
    const pick = text(await views.ReportsView(modelingView(false, { order_datasets: [], simulation_projects: projects }), { a: RUN }));
    expect(pick).toContain("Forecast: Spring forecast");
    const runs = [fullRun(RUN, complete), fullRun(forecastRun, forecast(), {}, "forecast")];
    const t = text(await views.ReportsView(modelingView(false, { order_datasets: [], simulation_projects: projects, simulation_runs: runs }), { a: RUN, b: forecastRun }));
    expect(t).toContain("Forecast from assumptions");
    expect(t).toContain("One of these is a forecast from assumptions and the other is built from an orders file.");
    expect(t).toContain("A typical month, as described");
  });
});

// ---------------------------------------------------------------------------
// The two CSV exports
// ---------------------------------------------------------------------------
type OrderDb = ReturnType<typeof orderDb>;

function exportClient(o: { run: unknown; orders?: OrderDb[]; shipments?: ShipRow[]; auditError?: boolean }) {
  const audit: { name: string; args: Record<string, unknown> }[] = [];
  const idCalls: number[] = [];
  const client = {
    from(table: string) {
      let range: [number, number] = [0, 999];
      let ids: string[] = [];
      let single = false;
      const result = () => {
        if (table === "simulation_runs") return { data: single ? o.run : [o.run], error: null };
        if (table === "simulation_order_results") return { data: (o.orders ?? []).slice(range[0], range[1] + 1), count: (o.orders ?? []).length, error: null };
        if (table === "simulation_results") {
          idCalls.push(ids.length);
          return { data: (o.shipments ?? []).filter((r) => ids.includes(r.order_id)).slice(range[0], range[1] + 1), error: null };
        }
        return { data: [], error: null };
      };
      const b: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
            if (prop === "maybeSingle") return () => ((single = true), b);
            if (prop === "range") return (f: number, t: number) => ((range = [f, t]), b);
            if (prop === "in") return (_c: string, v: string[]) => ((ids = v), b);
            return () => b;
          },
        },
      );
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      audit.push({ name, args });
      return { data: null, error: o.auditError ? { message: "audit failed" } : null };
    },
  };
  return { client, audit, idCalls };
}

const exportRun = (summary: unknown, over: Record<string, unknown> = {}) => ({ id: RUN, tenant_id: TENANT, brand_id: BRAND, status: "completed", kind: "bulk", summary, simulation_projects: { name: "March plan", rate_cards: { name: "Fixture card" } }, ...over });
const ctxFor = (url: string) => new NextRequest(`http://localhost${url}`);
const callOrders = (url = `/api/runs/${RUN}/orders.csv`) => ordersRoute.GET(ctxFor(url), { params: Promise.resolve({ runId: RUN }) });
const callMonthly = (url = `/api/runs/${RUN}/monthly.csv`) => monthlyRoute.GET(ctxFor(url), { params: Promise.resolve({ runId: RUN }) });

describe("orders.csv", () => {
  it("exports one row per order under the headline's header, audited, with blanks for what was not computed", async () => {
    const db = exportClient({
      run: exportRun(complete),
      orders: [orderDb("o1", 1), orderDb("o2", 2, { units: null, lines: null, fee_status: "no_content", processing_definite: 0, unresolved: [{ ruleKey: "pick_order", reason: "units_unknown" }] })],
      shipments: [
        { order_id: "o1", status: "ok", expected: "10.00" },
        { order_id: "o2", status: "ok", expected: "12.00" },
      ],
    });
    routeDb.client = db.client;
    const res = await callOrders();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="parcelclarity-orders-11111111.csv"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const lines = (await res.text()).split("\r\n");
    expect(lines.filter((l) => l.startsWith("# ")).length).toBe(5);
    expect(lines[0]).toContain("Acme 3PL fee schedule 'Standard fulfillment', in effect from Jan 1, 2026");
    expect(lines.join("\n")).toContain("monthly.csv");
    const at = lines.findIndex((l) => l.startsWith("order_id,"));
    expect(lines[at]).toBe("order_id,order_date,units,lines,packages,shipments,shipping_expected,order_fees,shipping_plus_fees,fee_status,not_computed");
    expect(lines[at + 1]).toBe("ORD-1,2026-03-03,3,2,1,1,10.00,2.00,12.00,priced,");
    // Order 2 has no item counts: units and lines blank, fees blank, and the rule that could not be computed is named.
    expect(lines[at + 2]).toBe("ORD-2,2026-03-03,,,1,1,12.00,,,not_computed,Order pick");
    expect(db.audit).toEqual([{ name: "log_audit_event", args: { p_tenant: TENANT, p_brand: BRAND, p_action: "export.run_orders", p_entity_type: "simulation_run", p_entity_id: RUN, p_metadata: { kind: "orders_csv" } } }]);
    expect(lines.join("\n")).not.toMatch(FORBIDDEN_TEXT);
  });

  it("reads orders a page at a time and shipping in chunks of 100 ids: 1,500 orders in one file", async () => {
    const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const orders = Array.from({ length: 1500 }, (_, i) => orderDb(id(i), i + 1));
    const db = exportClient({ run: exportRun(complete), orders, shipments: orders.map((o) => ({ order_id: o.order_id, status: "ok", expected: "1.00" })) });
    routeDb.client = db.client;
    const body = await (await callOrders()).text();
    const rows = body.split("\r\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("order_id,"));
    expect(rows.length).toBe(1500);
    expect(rows[0]).toBe("ORD-1,2026-03-03,3,2,1,1,1.00,2.00,3.00,priced,");
    expect(rows[1499]).toBe("ORD-1500,2026-03-03,3,2,1,1,1.00,2.00,3.00,priced,");
    expect(Math.max(...db.idCalls)).toBeLessThanOrEqual(100);
    expect(db.idCalls.length).toBe(15);
  });

  it("is not found for a signed-out visitor, another customer, another 3PL, a forecast, a model without fee results, a run that is not finished, or a bad id", async () => {
    routeDb.client = exportClient({ run: exportRun(complete) }).client;
    session.user = null;
    expect((await callOrders()).status).toBe(404);
    signInAs("brand_admin");
    routeDb.client = exportClient({ run: exportRun(complete, { brand_id: OTHER_BRAND }) }).client;
    expect((await callOrders()).status).toBe(404);
    routeDb.client = exportClient({ run: exportRun(complete, { tenant_id: "33333333-3333-4333-8333-333333333333" }) }).client;
    expect((await callOrders()).status).toBe(404);
    routeDb.client = exportClient({ run: exportRun(complete, { kind: "forecast" }) }).client;
    expect((await callOrders()).status).toBe(404);
    routeDb.client = exportClient({ run: exportRun({ version: 1 }) }).client;
    expect((await callOrders()).status).toBe(404);
    routeDb.client = exportClient({ run: exportRun(complete, { status: "running" }) }).client;
    expect((await callOrders()).status).toBe(404);
    routeDb.client = exportClient({ run: exportRun(complete) }).client;
    expect((await ordersRoute.GET(ctxFor("/api/runs/not-an-id/orders.csv"), { params: Promise.resolve({ runId: "not-an-id" }) })).status).toBe(404);
  });

  it("staff must name the run's own customer; a failed audit write refuses the export", async () => {
    signInAs("tenant_admin", STAFF);
    routeDb.client = exportClient({ run: exportRun(complete), orders: [] }).client;
    expect((await callOrders(`/api/runs/${RUN}/orders.csv?brandId=${OTHER_BRAND}`)).status).toBe(404);
    expect((await callOrders(`/api/runs/${RUN}/orders.csv?brandId=${BRAND}`)).status).toBe(200);
    routeDb.client = exportClient({ run: exportRun(complete), orders: [], auditError: true }).client;
    expect((await callOrders(`/api/runs/${RUN}/orders.csv?brandId=${BRAND}`)).status).toBe(503);
  });
});

describe("monthly.csv", () => {
  it("exports the monthly charges and the minimum month by month, with the period and volume in the header, audited", async () => {
    const db = exportClient({ run: exportRun(complete) });
    routeDb.client = db.client;
    const res = await callMonthly();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="parcelclarity-monthly-11111111.csv"');
    const lines = (await res.text()).split("\r\n");
    expect(lines).toContain("# Basis: 2 orders a month over Mar 1, 2026–Apr 30, 2026 (2 months).");
    expect(lines).toContain("row_type,name,period,status,quantity,unit_amount,amount,class,note");
    expect(lines).toContain("charge,Pallet storage,a month,priced,10,18.00,180.00,based_on_assumptions,10 pallets × $18.00 = $180.00 a month.");
    expect(lines).toContain("charge,Account fee,a month,priced,1,25.00,25.00,from_fee_schedule,$25.00 a month.");
    expect(lines.filter((l) => l.startsWith("minimum,")).length).toBe(2);
    expect(lines.join("\n")).not.toMatch(/per_order|all_in/);
    expect(lines.join("\n")).not.toMatch(FORBIDDEN_TEXT);
    expect(db.audit[0]!.args).toMatchObject({ p_action: "export.run_monthly", p_entity_id: RUN, p_brand: BRAND, p_tenant: TENANT });
  });

  it("lists a charge with no number given as not modeled with its rate, and is not found for what orders.csv refuses", async () => {
    routeDb.client = exportClient({ run: exportRun(noStorageAnswer) }).client;
    const body = await (await callMonthly()).text();
    expect(body).toContain("charge,Pallet storage,a month,not_modeled,,,,,No number was given. Rate: $18.00 per pallet per month.");
    routeDb.client = exportClient({ run: exportRun(complete, { brand_id: OTHER_BRAND }) }).client;
    expect((await callMonthly()).status).toBe(404);
    routeDb.client = exportClient({ run: exportRun({ version: 1 }) }).client;
    expect((await callMonthly()).status).toBe(404);
    routeDb.client = exportClient({ run: exportRun(complete), auditError: true }).client;
    expect((await callMonthly()).status).toBe(503);
  });
});
