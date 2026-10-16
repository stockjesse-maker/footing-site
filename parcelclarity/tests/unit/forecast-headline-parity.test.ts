import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { evaluateForecast, forecastPinnedRates, type ForecastAssumptions, type ForecastDeps, type ForecastSummary } from "@/engine/forecast";
import { FEE_ENGINE_VERSION, type FeeScheduleSnapshot } from "@/engine/fees/types";
import { ENGINE_VERSION } from "@/engine/types";
import { defaultView, headlineFigures } from "@/lib/modeling/headline";
import { sha256Hex } from "@/lib/forecast/hash";
import { fixtureContext } from "../fixtures/pricing/load";
import { forecastAssumptions } from "../fixtures/modeling/fee-runs";

/**
 * The completeness rule that decides a headline's label exists twice: `headlineFigures` (file runs, and every list,
 * tile and comparison, forecasts included) and `forecastHeadline` (the forecast page and its preview). The design
 * called for one function. They are two implementations of one rule, so this pins that they agree: for every kind of
 * forecast, the kind the forecast page earns, the label, the figure and its "At least" are what the lists and tiles
 * print for the same summary.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/surcharges", () => ({ addSurchargeRuleVersion: vi.fn(), createSurchargeRule: vi.fn(), retireRuleVersion: vi.fn(), uploadZipList: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getUser: async () => null, getContext: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

const { forecastHeadline } = await import("@/components/forecast/result-model");

const schedules = JSON.parse(readFileSync(new URL("../fixtures/fees/schedules.json", import.meta.url), "utf8")) as Record<string, FeeScheduleSnapshot>;
const NONE = { drivers: {}, orderShares: {} };
const SKIP = { skip: true, drivers: {}, orderShares: {} };
const partial = { zones: [{ zone: "2", sharePct: "80" }, { zone: "9", sharePct: "20" }] };

const cases: [string, Partial<ForecastAssumptions>, string | null, { priceOnlyCovered?: boolean }][] = [
  ["answered", {}, "standard", {}],
  ["no answers", { fulfillment: NONE }, "standard", {}],
  ["skipped", { fulfillment: SKIP }, "standard", {}],
  ["no schedule", { fulfillment: NONE }, null, {}],
  ["partial", partial, "standard", { priceOnlyCovered: true }],
  ["partial, skipped", { ...partial, fulfillment: SKIP }, "standard", { priceOnlyCovered: true }],
  ["partial, no schedule", { ...partial, fulfillment: NONE }, null, { priceOnlyCovered: true }],
  ["minimum with shipping", { fulfillment: NONE }, "minimum_with_shipping", {}],
  ["minimum with shipping, partial", { ...partial, fulfillment: NONE }, "minimum_with_shipping", { priceOnlyCovered: true }],
  ["per-line fees", { fulfillment: NONE }, "lines", {}],
  ["fees tiered on the monthly volume", { fulfillment: NONE }, "tiers", {}],
  ["storage only, no answers", { fulfillment: NONE }, "storage_surcharge", {}],
];

function summaryOf(over: Partial<ForecastAssumptions>, schedule: string | null, options: { priceOnlyCovered?: boolean }): ForecastSummary {
  const a = forecastAssumptions(over);
  const s = schedule === null ? null : schedules[schedule]!;
  const deps: ForecastDeps = { pricing: fixtureContext(), schedule: s, pinnedRates: forecastPinnedRates(a, s), feeEngineVersion: FEE_ENGINE_VERSION, engineVersion: ENGINE_VERSION, hash: sha256Hex };
  const result = evaluateForecast(a, deps, options);
  if (result.status !== "ok") throw new Error(`expected an ok forecast, got ${result.status}`);
  return result.summary;
}

describe("the forecast page's headline and the lists' headline agree", () => {
  for (const [name, over, schedule, options] of cases) {
    it(name, () => {
      const summary = summaryOf(over, schedule, options);
      const page = forecastHeadline(summary);
      const list = headlineFigures(summary, "allin");
      const shipping = headlineFigures(summary, "shipping");
      // Shipping is the same figure on both.
      expect(shipping.amount).toBe(summary.shipping.perOrder);
      expect(page.parts.shipping).toBe(summary.shipping.perOrder);
      switch (page.kind) {
        case "all_in":
          expect(list).toMatchObject({ amount: page.perOrder, qualifier: "", complete: true, label: page.label });
          expect(defaultView(summary)).toBe("allin");
          break;
        case "at_least":
          expect(list.amount).toBe(page.perOrder);
          expect(list.amount).not.toBeNull();
          expect(list.qualifier).toBe("At least");
          expect(list.complete).toBe(false);
          expect(list.label).toBe(page.label);
          expect(defaultView(summary)).toBe("shipping");
          break;
        case "partial":
          // Only part of the volume was priced: no all-in anywhere, and the lists say how much was priced.
          expect(page.perOrder).toBeNull();
          expect(list.amount).toBeNull();
          expect(list.complete).toBe(false);
          expect(shipping.basisSentence).toContain(`Only ${summary.pricedSharePct}% of the volume could be priced`);
          expect(defaultView(summary)).toBe("shipping");
          break;
        case "shipping_only":
          // Fees were skipped or no schedule applies: no all-in anywhere.
          expect(list.amount).toBeNull();
          expect(list.unavailable).not.toBeNull();
          expect(defaultView(summary)).toBe("shipping");
          break;
      }
    });
  }

  it("covers every kind the forecast page can earn", () => {
    const kinds = new Set(cases.map(([, over, schedule, options]) => forecastHeadline(summaryOf(over, schedule, options)).kind));
    expect([...kinds].sort()).toEqual(["all_in", "at_least", "partial", "shipping_only"]);
  });
});
