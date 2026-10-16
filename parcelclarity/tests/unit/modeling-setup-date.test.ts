import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialFulfillmentState, monthlyFeeDate, reconcileFulfillmentState, type FulfillmentFormContext } from "@/lib/modeling/assumptions";
import { fakeSupabase, type FakeResult } from "../fixtures/forecast/fake-supabase";
import { standard } from "../fixtures/modeling/fee-runs";

/**
 * Run setup step 2 asks the questions of the fee schedule version in effect on the day the run takes its monthly
 * charges from, not always today's: the pure rules for which day that is and for keeping answers across two question
 * sets, the server action that reads another day's questions (who may call it, what it refuses), and the run page,
 * whose "Add" links must lead to the questions of the date the model was priced for.
 */
const h = vi.hoisted(() => ({
  ctx: null as unknown,
  supabase: null as unknown,
  limitOk: true,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: () => { throw new Error("not found"); } }));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => undefined, getUser: async () => ({ id: "u" }), getContext: async () => h.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.supabase }));
vi.mock("@/lib/rate-limit", () => ({ RATE_LIMITED_MESSAGE: "limited", withinRateLimit: async () => h.limitOk }));
vi.mock("@/app/actions/surcharges", () => ({ addSurchargeRuleVersion: vi.fn(), createSurchargeRule: vi.fn(), retireRuleVersion: vi.fn(), uploadZipList: vi.fn() }));

const { loadFulfillmentSetup } = await import("@/app/actions/modeling");
const { driverQuestions, packagingTypes } = await import("@/lib/fees/queries");

const TENANT = "22222222-2222-4222-8222-222222222222";
const BRAND = "77777777-7777-4777-8777-777777777777";
const OTHER_BRAND = "88888888-8888-4888-8888-888888888888";
const DATASET = "99999999-9999-4999-8999-999999999999";

const brandCtx = { active: { role: "brand_admin", portal: "brand", tenantId: TENANT, brandId: BRAND, tenantName: "Acme 3PL", brandName: "Acme Goods" } };
const staffCtx = { active: { role: "tenant_admin", portal: "tenant", tenantId: TENANT, tenantName: "Acme 3PL" } };

describe("monthlyFeeDate: the day a run's monthly questions come from", () => {
  it("is the as-of date when the rates are those of one date", () => {
    expect(monthlyFeeDate("fixed_date", "2026-03-15", { to: "2026-04-30" })).toBe("2026-03-15");
    expect(monthlyFeeDate("fixed_date", "", { to: "2026-04-30" })).toBeNull();
    expect(monthlyFeeDate("fixed_date", null, null)).toBeNull();
    expect(monthlyFeeDate("fixed_date", "15/03/2026", null)).toBeNull();
  });

  it("is the end of the file's period when each order is priced on its own date", () => {
    expect(monthlyFeeDate("ship_date", "2026-03-15", { to: "2026-04-30" })).toBe("2026-04-30");
    expect(monthlyFeeDate("ship_date", null, { to: null })).toBeNull();
    expect(monthlyFeeDate("ship_date", null, null)).toBeNull();
  });
});

describe("reconcileFulfillmentState: answers across two question sets", () => {
  const questions = driverQuestions(standard);
  const ctxOf = (qs = questions): FulfillmentFormContext => ({ questions: qs, canDeriveVolume: true, showPackaging: true, showContent: true });
  const filled = () => {
    const state = initialFulfillmentState(ctxOf(), null);
    const first = questions.find((q) => q.answers === "drivers")!;
    const share = questions.find((q) => q.answers === "orderShares");
    state.drivers[first.key] = { choice: "number", value: "12" };
    if (share) state.shares[share.key] = { choice: "number", sharePct: "40", count: "2" };
    state.packagingDefault = "box";
    state.volumeMode = "stated";
    state.volume = "900";
    state.skip = false;
    return { state, first, share };
  };

  it("keeps the answers to questions both sets ask, with the volume, and the packaging the new set still prices", () => {
    const { state, first, share } = filled();
    const next = reconcileFulfillmentState(state, ctxOf(), packagingTypes(standard));
    expect(next.drivers[first.key]).toEqual({ choice: "number", value: "12" });
    if (share) expect(next.shares[share.key]).toEqual({ choice: "number", sharePct: "40", count: "2" });
    expect(next.volume).toBe("900");
    expect(next.volumeMode).toBe("stated");
    expect(next.packagingDefault).toBe("box");
  });

  it("drops a question the new set no longer asks and starts a new one unanswered", () => {
    const { state, first } = filled();
    const kept = questions.filter((q) => q.key !== first.key);
    const added = { ...first, key: "newly_asked", label: "Something new" };
    const next = reconcileFulfillmentState(state, ctxOf([...kept, added]), packagingTypes(standard));
    expect(Object.keys(next.drivers)).not.toContain(first.key);
    expect(next.drivers.newly_asked).toEqual({ choice: null, value: "" });
    // A question that was already answered is still answered.
    for (const q of kept.filter((k) => k.answers === "drivers")) expect(next.drivers[q.key]).toEqual(state.drivers[q.key]);
  });

  it("clears a packaging default the new set does not price, and states the volume when it cannot be derived", () => {
    const { state } = filled();
    expect(reconcileFulfillmentState(state, ctxOf(), ["tube"]).packagingDefault).toBe("");
    expect(reconcileFulfillmentState({ ...state, volumeMode: "file" }, { ...ctxOf(), canDeriveVolume: false }, ["box"]).volumeMode).toBe("stated");
  });
});

// ---------------------------------------------------------------------------
// The server action
// ---------------------------------------------------------------------------
interface Db {
  datasets?: unknown[];
  asked?: Record<string, unknown>[];
  schedule?: (args: Record<string, unknown>) => FakeResult;
  period?: FakeResult;
}

const okSchedule = (versionId: string) => ({ data: { status: "ok", snapshot: { ...standard, versionId } }, error: null }) as FakeResult;

function db(over: Db = {}) {
  const asked = over.asked ?? [];
  return fakeSupabase({
    tables: {
      order_datasets: over.datasets ?? [{ id: DATASET, brand_id: BRAND, status: "ready", line_count: 4, validation: { counts: { lines: 4, units: 12 } } }],
      brand_fee_schedule_assignments: [{ id: "fa", schedule_id: "sched", assigned_at: "2026-01-02T00:00:00Z", fee_schedules: { id: "sched", name: "Standard fulfillment", description: null } }],
      packages: [],
    },
    rpc: {
      dataset_forecast_period: over.period ?? { data: { population: 4, dated: 4, undated: 0, from: "2026-03-01", to: "2026-04-30", days: 61, months: "2.000000", inPeriod: 4, trimmed: 0 }, error: null },
      brand_fee_schedule_on: (args) => {
        asked.push(args);
        return over.schedule ? over.schedule(args) : okSchedule("v-1");
      },
    },
  });
}

beforeEach(() => {
  h.ctx = brandCtx;
  h.limitOk = true;
  h.supabase = db();
});

describe("loadFulfillmentSetup", () => {
  it("reads the questions of the fee schedule version in effect on the chosen date, and says which date they are for", async () => {
    const asked: Record<string, unknown>[] = [];
    h.supabase = db({ asked, schedule: (args) => (args.p_date === "2025-06-01" ? okSchedule("v-old") : okSchedule("v-1")) });
    const response = await loadFulfillmentSetup(DATASET, "2025-06-01");
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(asked).toEqual([{ p_brand: BRAND, p_date: "2025-06-01" }]);
    expect(response.setup.date).toBe("2025-06-01");
    expect(response.setup.schedule.status).toBe("ok");
    if (response.setup.schedule.status !== "ok") return;
    expect(response.setup.schedule.questions.map((q) => q.key)).toEqual(driverQuestions(standard).map((q) => q.key));
    expect(response.setup.hasUnits).toBe(true);
    // Customer-safe: no rule key, id, version number or note travels back to the browser.
    const json = JSON.stringify(response.setup);
    for (const rule of standard.rules) if (rule.key.includes("_")) expect(json).not.toContain(rule.key);
    expect(json).not.toContain("v-old");
  });

  it("reports a date no version covers as not in effect, and a failed read as unavailable, never as 'no fees'", async () => {
    h.supabase = db({ schedule: () => ({ data: { status: "not_effective", scheduleId: "sched", name: "Standard fulfillment" }, error: null }) });
    const none = await loadFulfillmentSetup(DATASET, "2020-01-01");
    expect(none.ok && none.setup.schedule).toEqual({ status: "not_effective", name: "Standard fulfillment" });
    h.supabase = db({ schedule: () => ({ data: null, error: { code: "XX000", message: "boom" } }) });
    const failed = await loadFulfillmentSetup(DATASET, "2020-01-01");
    expect(failed.ok && failed.setup.schedule).toEqual({ status: "unavailable" });
  });

  it("is refused for nobody signed in with the right, a file that is not the caller's brand's, a file not ready, and a bad date or id", async () => {
    h.ctx = null;
    expect(await loadFulfillmentSetup(DATASET, "2026-03-15")).toMatchObject({ ok: false, message: "You don't have permission to model costs for this customer." });
    h.ctx = brandCtx;
    h.supabase = db({ datasets: [{ id: DATASET, brand_id: OTHER_BRAND, status: "ready" }] });
    expect(await loadFulfillmentSetup(DATASET, "2026-03-15")).toMatchObject({ ok: false, message: "The orders file is not ready." });
    h.supabase = db({ datasets: [{ id: DATASET, brand_id: BRAND, status: "uploaded" }] });
    expect(await loadFulfillmentSetup(DATASET, "2026-03-15")).toMatchObject({ ok: false, message: "The orders file is not ready." });
    h.supabase = db({ datasets: [] });
    expect(await loadFulfillmentSetup(DATASET, "2026-03-15")).toMatchObject({ ok: false });
    h.supabase = db();
    for (const [id, date] of [["not-a-uuid", "2026-03-15"], [DATASET, "2026-02-30"], [DATASET, "15/03/2026"], [DATASET, ""]]) expect(await loadFulfillmentSetup(id!, date!)).toEqual({ ok: false, message: "Choose a valid date." });
  });

  it("is rate limited", async () => {
    h.limitOk = false;
    expect(await loadFulfillmentSetup(DATASET, "2026-03-15")).toEqual({ ok: false, message: "limited" });
  });

  it("resolves the customer from the session: a brand member is bound to their own, staff must name one of their tenant's", async () => {
    // A brand member naming another brand reads their own brand's schedule (the argument is ignored).
    const asked: Record<string, unknown>[] = [];
    h.supabase = db({ asked });
    await loadFulfillmentSetup(DATASET, "2026-03-15", OTHER_BRAND);
    expect(asked[0]).toMatchObject({ p_brand: BRAND });
    // Staff without a customer, or naming a customer of another tenant, get nothing.
    h.ctx = staffCtx;
    expect(await loadFulfillmentSetup(DATASET, "2026-03-15")).toMatchObject({ ok: false, message: "You don't have permission to model costs for this customer." });
    h.supabase = fakeSupabase({ tables: { brands: [{ id: BRAND, tenant_id: "another-tenant", status: "active" }] } });
    expect(await loadFulfillmentSetup(DATASET, "2026-03-15", BRAND)).toMatchObject({ ok: false });
    // Staff naming their own customer read that customer's.
    h.supabase = fakeSupabase({
      tables: { brands: [{ id: BRAND, tenant_id: TENANT, status: "active" }], order_datasets: [{ id: DATASET, brand_id: BRAND, status: "ready", line_count: 1, validation: {} }], brand_fee_schedule_assignments: [], packages: [] },
      rpc: { dataset_forecast_period: { data: null, error: { message: "x" } }, brand_fee_schedule_on: () => okSchedule("v-1") },
    });
    expect((await loadFulfillmentSetup(DATASET, "2026-03-15", BRAND)).ok).toBe(true);
  });
});
