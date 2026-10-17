import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdjustmentOverflowError } from "@/engine/adjustments";
import { BRAND, OTHER_TENANT, TENANT, adminSession, makeDb, type FakeDb, type Row } from "./adjustments-actions-support";

/**
 * The history statistics action says "an amount is too large to add up exactly" only for the engine's own refusal (AdjustmentOverflowError).
 * Any other RangeError (a call stack that overflowed on a big array, an invalid array length) is a fault, and the person is not told something
 * false about their amounts (engine review F1, the part that lives in the action).
 */
const h = vi.hoisted(() => ({ ctx: null as unknown, db: null as unknown, thrown: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => undefined, getContext: async () => h.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as { client: unknown }).client }));
vi.mock("@/lib/rate-limit", () => ({ RATE_LIMITED_MESSAGE: "limited", withinRateLimit: async () => true }));
vi.mock("@/lib/pricing/catalog", () => ({ loadServiceCatalog: async () => [] }));
vi.mock("@/engine/adjustments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/engine/adjustments")>()),
  summariseHistory: () => {
    throw h.thrown;
  },
}));

const actions = await import("@/app/actions/adjustments");

const brands = (): Row[] => [{ id: BRAND, tenant_id: TENANT, name: "Alpha Apparel", status: "active" }, { id: "x", tenant_id: OTHER_TENANT, name: "Other", status: "active" }];
beforeEach(() => {
  h.ctx = adminSession;
  h.db = makeDb({ tables: { brands: brands(), adjustment_imports: [], adjustment_baselines: [] } });
});

describe("loadHistoryStatistics: what a thrown RangeError means", () => {
  it("the engine's deliberate overflow refusal is told as 'too large to add up exactly'", async () => {
    h.thrown = new AdjustmentOverflowError();
    expect(await actions.loadHistoryStatistics({ brandId: BRAND })).toEqual({ status: "error", message: "An amount in the history is too large to add up exactly." });
  });

  it("a call stack overflow (also a RangeError) is a fault and is not reported as an amount that is too large", async () => {
    h.thrown = new RangeError("Maximum call stack size exceeded");
    const r = await actions.loadHistoryStatistics({ brandId: BRAND });
    expect(r).toEqual({ status: "error", message: "Your history could not be read. Please try again." });
    h.thrown = new RangeError("Invalid array length");
    expect(await actions.loadHistoryStatistics({ brandId: BRAND })).toMatchObject({ status: "error", message: expect.not.stringContaining("too large") });
    expect((h.db as FakeDb).writes()).toEqual([]);
  });
});
