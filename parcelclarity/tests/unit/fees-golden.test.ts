import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D } from "@/engine/money";
import { allocate, calculateMonthlyFees, calculateOrderFees, evaluateMinimums, resolveMonthlyRate } from "@/engine/fees";
import type { AllocationInput, FeeScheduleSnapshot, FulfillmentAnswers, MinimumStatus, MonthBucket, OrderFeeContext, OrderFeeInput } from "@/engine/fees/types";

/**
 * Golden tests for the fee engine. `expected.json` was derived by hand from RULES.md and the
 * fixtures by two independent derivers and reconciled by a third, without reading the engine;
 * the engine is wrong whenever they disagree, never the other way round.
 */
const dir = new URL("../fixtures/fees/", import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as T;

const schedules = read<Record<string, FeeScheduleSnapshot>>("schedules.json");
const scenarios = read<{
  defaultContext: OrderFeeContext;
  order: { id: string; schedule: string; input: OrderFeeInput; context?: Partial<OrderFeeContext> }[];
  monthly: {
    id: string;
    schedule: string;
    monthlyOrders: string | null;
    answers: FulfillmentAnswers;
    buckets: Omit<MonthBucket, "unresolvedRuleKeys">[] & { unresolvedRuleKeys?: string[] }[];
    allocation: { months: string; modeledOrders: number; shippingExpectedE4: number; processingE4: number; populationOrders: number };
  }[];
  pins: { id: string; schedule: string; ruleKey: string; monthlyQuantity: string }[];
}>("scenarios.json");
const expected = read<Record<string, Record<string, unknown>>>("expected.json");

type ExpectedLine = { ruleKey: string; quantity: string; amountE4: number; chargeClass: string; unitAmountE4?: number | null };

const sameNumber = (a: string, b: string) => new D(a).minus(b).abs().lt("1e-12");
const plainWord = (schedule: FeeScheduleSnapshot, key: string) => {
  const rule = schedule.rules.find((r) => r.key === key);
  return !!rule && (rule.name.toLowerCase().includes(key) || (rule.driver?.unit ?? "").toLowerCase().includes(key));
};

describe("fee engine golden: order-scope rules", () => {
  for (const sc of scenarios.order) {
    it(sc.id, () => {
      const exp = expected[sc.id] as { status: string; lines: ExpectedLine[]; definiteE4: number; estimatedE4: number; unresolved: { ruleKey: string; reason: string; replacedBy?: string }[]; warnings: string[] };
      expect(exp, `expected.json has no entry for ${sc.id}`).toBeDefined();
      const schedule = schedules[sc.schedule]!;
      const context: OrderFeeContext = { ...scenarios.defaultContext, ...(sc.context ?? {}) };
      const result = calculateOrderFees(sc.input, schedule, context);
      expect(result.status).toBe(exp.status);
      expect(result.lines.map((l) => ({ ruleKey: l.ruleKey, quantity: l.quantity, amountE4: l.amountE4, chargeClass: l.chargeClass }))).toEqual(
        exp.lines.map((l) => ({ ruleKey: l.ruleKey, quantity: l.quantity, amountE4: l.amountE4, chargeClass: l.chargeClass })),
      );
      for (const l of exp.lines) if (l.unitAmountE4 !== undefined) expect(result.lines.find((x) => x.ruleKey === l.ruleKey)?.unitAmountE4).toBe(l.unitAmountE4);
      expect(result.definiteE4).toBe(exp.definiteE4);
      expect(result.estimatedE4).toBe(exp.estimatedE4);
      expect(result.unresolved.map((u) => ({ ruleKey: u.ruleKey, reason: u.reason, ...(u.replacedBy ? { replacedBy: u.replacedBy } : {}) }))).toEqual(
        exp.unresolved.map((u) => ({ ruleKey: u.ruleKey, reason: u.reason, ...(u.replacedBy ? { replacedBy: u.replacedBy } : {}) })),
      );
      expect([...result.warnings].sort()).toEqual([...exp.warnings].sort());
      // Every line explains itself without rule keys (a key that is also a plain word of the rule's name or unit is not a leak).
      for (const l of result.lines) {
        expect(l.explanation.length).toBeGreaterThan(5);
        if (!plainWord(schedule, l.ruleKey)) expect(l.explanation).not.toContain(l.ruleKey);
      }
    });
  }
});

describe("fee engine golden: monthly rules, minimums and allocation", () => {
  for (const sc of scenarios.monthly) {
    it(sc.id, () => {
      const exp = expected[sc.id] as {
        monthlyLines: { ruleKey: string; quantity: string; amountE4: number; chargeClass: string; scalesWithVolume: boolean }[];
        notModeled: { ruleKey: string; reason: string }[];
        unusedAnswers: string[];
        monthlyTotalE4: number;
        minimums: { ruleKey: string; status: MinimumStatus; minimumE4: number; countedE4: number; topUpE4: number; members: { ruleKey: string; state: string }[]; buckets: { month: string; minimumE4: number; countedE4: number; topUpE4: number }[] }[];
        allocation: { coveragePct: string; extrapolated: boolean; monthly: Record<string, string | null>; perOrder: Record<string, string | null> };
      };
      expect(exp, `expected.json has no entry for ${sc.id}`).toBeDefined();
      const schedule = schedules[sc.schedule]!;
      const monthly = calculateMonthlyFees(sc.answers, schedule, sc.monthlyOrders === null ? null : new D(sc.monthlyOrders));
      expect(monthly.lines.length).toBe(exp.monthlyLines.length);
      monthly.lines.forEach((l, i) => {
        const e = exp.monthlyLines[i]!;
        expect(l.ruleKey).toBe(e.ruleKey);
        expect(sameNumber(l.quantity, e.quantity), `${l.ruleKey} quantity ${l.quantity} vs ${e.quantity}`).toBe(true);
        expect(l.amountE4).toBe(e.amountE4);
        expect(l.chargeClass).toBe(e.chargeClass);
        expect(l.scalesWithVolume).toBe(e.scalesWithVolume);
        if (!plainWord(schedule, l.ruleKey)) expect(l.explanation).not.toContain(l.ruleKey);
      });
      expect(monthly.notModeled.map((n) => ({ ruleKey: n.ruleKey, reason: n.reason }))).toEqual(exp.notModeled.map((n) => ({ ruleKey: n.ruleKey, reason: n.reason })));
      expect(monthly.unusedAnswers).toEqual(exp.unusedAnswers);
      expect(monthly.totalE4).toBe(exp.monthlyTotalE4);

      const buckets: MonthBucket[] = sc.buckets.map((b) => ({ ...b, unresolvedRuleKeys: (b as { unresolvedRuleKeys?: string[] }).unresolvedRuleKeys ?? [] }));
      const minimums = evaluateMinimums(buckets, schedule, monthly);
      expect(minimums.map((m) => ({ ruleKey: m.ruleKey, status: m.status, minimumE4: m.minimumE4, countedE4: m.countedE4, topUpE4: m.topUpE4, members: m.members.map((x) => ({ ruleKey: x.ruleKey, state: x.state })), buckets: m.buckets }))).toEqual(
        exp.minimums.map((m) => ({ ruleKey: m.ruleKey, status: m.status, minimumE4: m.minimumE4, countedE4: m.countedE4, topUpE4: m.topUpE4, members: m.members, buckets: m.buckets })),
      );

      // No minimum rule → the top-up is exactly zero.
      const minimumStatus: MinimumStatus = minimums.some((m) => m.status === "not_computed") ? "not_computed" : minimums.some((m) => m.status === "upper_bound") ? "upper_bound" : "exact";
      const input: AllocationInput = {
        months: sc.allocation.months,
        monthlyOrders: sc.monthlyOrders,
        modeledOrders: sc.allocation.modeledOrders,
        shippingExpectedE4: sc.allocation.shippingExpectedE4,
        processingE4: sc.allocation.processingE4,
        populationOrders: sc.allocation.populationOrders,
        monthlyFixedE4: monthly.totalE4,
        minimumTopUpE4: minimums.reduce((n, m) => n + m.topUpE4, 0),
        minimumStatus,
      };
      const allocation = allocate(input);
      expect(allocation.coveragePct).toBe(exp.allocation.coveragePct);
      expect(allocation.extrapolated).toBe(exp.allocation.extrapolated);
      expect(allocation.monthly).toEqual(exp.allocation.monthly);
      expect(allocation.perOrder).toEqual(exp.allocation.perOrder);
    });
  }
});

describe("fee engine golden: pinned monthly rates", () => {
  for (const sc of scenarios.pins) {
    it(sc.id, () => {
      const exp = expected[sc.id] as { rateE4: number | null };
      const rule = schedules[sc.schedule]!.rules.find((r) => r.key === sc.ruleKey)!;
      expect(resolveMonthlyRate(rule.tiers!, new D(sc.monthlyQuantity))).toBe(exp.rateE4);
    });
  }
});
