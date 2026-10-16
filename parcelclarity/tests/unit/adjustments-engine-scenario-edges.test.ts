import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countPercentOfShippingFees, evaluateAdjustmentScenario, type AdjustmentScenarioInput, type PolicyFn } from "@/engine/adjustments";
import type { ShipmentInput } from "@/engine/types";
import { buildContext, fixture, policyFnFromProfile, type PolicyProfile, type RulesFile } from "./adjustments-engine-support";

/** Behaviour the goldens do not pin: input validation, representation, notices, multi-package percent fees, purity. */
const rules = fixture<RulesFile>("rules.json");
const { policyProfiles } = fixture<{ policyProfiles: Record<string, PolicyProfile> }>("scenarios.json");
const ctxOf = (name: string) => buildContext(rules.contexts[name]!, rules.rules);
const allPt = policyFnFromProfile(policyProfiles.all_pt);

const shipment = (over: Partial<ShipmentInput> = {}): ShipmentInput => ({
  shipDate: "2026-10-15", originZip: "90001", destinationZip: "85001", residential: false, carrierCode: "ups", serviceCode: "ground",
  packages: [{ weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" }], ...over,
});
const input = (over: Partial<AdjustmentScenarioInput> = {}): AdjustmentScenarioInput => ({ shipment: shipment(), corrections: [{ weight: "5", weightUnit: "lb" }], declaredSource: "entered", ...over });

describe("scenario input validation", () => {
  it("refuses a weight unit without a weight (ambiguous), naming what to enter", () => {
    const r = evaluateAdjustmentScenario(input({ corrections: [{ weightUnit: "oz" }] }), ctxOf("reweight_flat"), allPt);
    expect(r.status).toBe("invalid_input");
    expect(r.message).toContain("corrected weight");
  });

  it("refuses an unknown declared source", () => {
    const r = evaluateAdjustmentScenario({ ...input(), declaredSource: "guess" as never }, ctxOf("reweight_flat"), allPt);
    expect(r.status).toBe("invalid_input");
  });

  it("reads a corrected weight in the declared package's unit when none is given", () => {
    const oz = shipment({ packages: [{ weight: "48", weightUnit: "oz", length: "10", width: "8", height: "6" }] });
    const r = evaluateAdjustmentScenario({ shipment: oz, corrections: [{ weight: "80" }], declaredSource: "entered" }, ctxOf("reweight_flat"), allPt);
    expect(r.status).toBe("ok"); // 3 lb to 5 lb, as in E2
    expect(r.components?.postage_difference.amount).toBe("0.56");
  });

  it("an unparseable weight is an engine input error, never a crash", () => {
    const r = evaluateAdjustmentScenario(input({ corrections: [{ weight: "heavy", weightUnit: "lb" }] }), ctxOf("reweight_flat"), allPt);
    expect(r.status).toBe("invalid_input");
    expect(r.components).toBeNull();
  });

  it("an empty shipment or missing corrections is invalid, not an exception", () => {
    expect(evaluateAdjustmentScenario({ ...input(), shipment: shipment({ packages: [] }), corrections: [] }, ctxOf("reweight_flat"), allPt).status).toBe("invalid_input");
    expect(evaluateAdjustmentScenario({ ...input(), corrections: undefined as never }, ctxOf("reweight_flat"), allPt).status).toBe("invalid_input");
  });

  it("does not mutate its inputs and is deterministic", () => {
    const i = input();
    const frozen = structuredClone(i);
    const ctx = ctxOf("both_flat");
    const a = evaluateAdjustmentScenario(i, ctx, allPt);
    const b = evaluateAdjustmentScenario(i, ctx, allPt);
    expect(i).toEqual(frozen);
    expect(b).toEqual(a);
    expect(ctxOf("both_flat").rules.map((r) => r.chargeClass)).toEqual(ctx.rules.map((r) => r.chargeClass));
  });
});

describe("no amounts without a priced example", () => {
  it("unavailable and invalid results carry no totals, no components and no side amounts", () => {
    const cases: AdjustmentScenarioInput[] = [
      input({ shipment: shipment({ packages: [{ weight: "140", weightUnit: "lb" }] }), corrections: [{ weight: "151", weightUnit: "lb" }] }),
      input({ shipment: shipment({ packages: [{ weight: "151", weightUnit: "lb" }] }), corrections: [{ weight: "140", weightUnit: "lb" }] }),
      input({ shipment: shipment({ originZip: "abc" }) }),
      input({ corrections: [{}] }),
    ];
    for (const c of cases) {
      const r = evaluateAdjustmentScenario(c, ctxOf("reweight_flat"), allPt);
      expect(["declared_unavailable", "corrected_unavailable", "both_unavailable", "invalid_input"]).toContain(r.status);
      expect(r.components).toBeNull();
      expect(r.totalsE4).toBeNull();
      expect(r.direction).toBeNull();
      expect(r.basis).toBeNull();
      for (const side of Object.values(r.sides ?? {})) {
        expect(side.countedTotal).toBeNull();
        expect(side.unresolved).toBeNull();
      }
    }
  });

  it("an unavailable result names the side and keeps the engine's own words", () => {
    const r = evaluateAdjustmentScenario(input({ shipment: shipment({ packages: [{ weight: "3", weightUnit: "lb" }] }), corrections: [{ weight: "151", weightUnit: "lb" }] }), ctxOf("reweight_flat"), allPt);
    expect(r.status).toBe("corrected_unavailable");
    expect(r.message).toMatch(/Corrected shipment:/);
    expect(r.adjustmentType).toBe("reweight");
  });
});

describe("fee state for a package that did not change", () => {
  it("no_adjustment says the fee is not triggered even when no fee rule exists (design v2 3.1 step 6)", () => {
    const r = evaluateAdjustmentScenario(input({ corrections: [{ weight: "3.4", weightUnit: "lb" }] }), ctxOf("none"), allPt);
    expect(r.status).toBe("no_adjustment");
    expect(r.components?.separate_fee.state).toBe("not_triggered");
  });

  it("a price plateau (status ok, direction none) with no fee rule configured still reads not_configured", () => {
    const plateau = fixture<{ scenarios: { id: string; input: AdjustmentScenarioInput }[] }>("scenarios.json").scenarios.find((s) => s.id === "plateau_billable_differs_zero_delta")!;
    const r = evaluateAdjustmentScenario(plateau.input, ctxOf("none"), allPt);
    expect(r.status).toBe("ok");
    expect(r.direction).toBe("none");
    expect(r.components?.separate_fee.state).toBe("not_configured");
  });
});

describe("percent fee of a shipment-level rule on several packages", () => {
  it("is one shipment-level line over the corrected packages only (10 percent of the corrected package's base rate)", () => {
    const three = shipment({
      packages: [
        { weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" },
        { weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" },
        { weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" },
      ],
    });
    const r = evaluateAdjustmentScenario({ shipment: three, corrections: [{}, { weight: "5", weightUnit: "lb" }, {}], declaredSource: "entered" }, ctxOf("reweight_pct"), allPt);
    expect(r.status).toBe("ok");
    const fee = r.components!.separate_fee;
    expect(fee.state).toBe("conditional");
    expect(fee.lines).toHaveLength(1);
    expect(fee.lines[0]).toMatchObject({ ruleKey: "fixture.adj.reweight_pct", packageIndex: null, amount: "1.16" }); // 10% of 11.56, the corrected package only
    expect(fee.amount).toBe("1.16");
  });

  it("a per-package rule gives one line per corrected package, never one for an untouched package", () => {
    const three = shipment({
      packages: [
        { weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" },
        { weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" },
        { weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" },
      ],
    });
    const r = evaluateAdjustmentScenario({ shipment: three, corrections: [{ weight: "5", weightUnit: "lb" }, {}, { weight: "5", weightUnit: "lb" }], declaredSource: "entered" }, ctxOf("reweight_pp"), allPt);
    expect(r.components!.separate_fee.lines.map((l) => [l.packageIndex, l.amount])).toEqual([[0, "3.00"], [2, "3.00"]]);
    expect(r.components!.separate_fee.amount).toBe("6.00");
  });
});

describe("staff notices", () => {
  it("states that fuel on the adjustment fee is not modelled whenever a fee is shown", () => {
    const r = evaluateAdjustmentScenario(input(), ctxOf("reweight_flat"), allPt);
    expect(r.notices.map((n) => n.code)).toContain("fuel_on_adjustment_fee_not_modelled");
  });

  it("detects (never models) percent-of-shipping fees of the fee schedule", () => {
    const r = evaluateAdjustmentScenario(input(), ctxOf("reweight_flat"), allPt, { percentOfShippingFeeCount: 2 });
    const n = r.notices.find((x) => x.code === "percent_of_shipping_fees_not_modelled");
    expect(n?.count).toBe(2);
    expect(n?.message).toContain("2 percent-of-shipping fee(s)");
    expect(evaluateAdjustmentScenario(input(), ctxOf("reweight_flat"), allPt).notices.map((x) => x.code)).not.toContain("percent_of_shipping_fees_not_modelled");
  });
});

describe("percent-of-shipping fee detection", () => {
  it("counts only order-scope shipping_percent rules of a fee schedule", () => {
    expect(countPercentOfShippingFees([
      { scope: "order", basis: "shipping_percent" }, { scope: "order", basis: "shipping_percent" }, { scope: "order", basis: "order" }, { scope: "monthly", basis: "month" }, { scope: "order", basis: "package" },
    ])).toBe(2);
    expect(countPercentOfShippingFees([])).toBe(0);
  });
});

describe("policy function", () => {
  it("anything that is not a handling reads as unconfigured (never invented)", () => {
    const junk: PolicyFn = () => "free" as never;
    const r = evaluateAdjustmentScenario(input(), ctxOf("reweight_flat"), junk);
    expect(r.components!.postage_difference.handling).toBe("unconfigured");
    expect(r.totalsE4!.notDecided).toBe(35600);
  });

  it("is asked only about the scenario's own type (plus correction when a correction-fee line is shown)", () => {
    const asked: string[] = [];
    evaluateAdjustmentScenario(input(), ctxOf("reweight_flat"), (t, c) => {
      asked.push(`${t}/${c}`);
      return "pass_through";
    });
    expect([...new Set(asked)].sort()).toEqual(["reweight/postage_difference", "reweight/separate_fee"]);
  });
});

describe("the engine is pure", () => {
  const dir = path.resolve(__dirname, "../../src/engine/adjustments");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(path.join(dir, f), "utf8")] as const);

  it("reads no clock, no randomness, no network, no environment and no file", () => {
    expect(sources.length).toBeGreaterThanOrEqual(9);
    for (const [name, text] of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, name).not.toMatch(/Date\.now\(|new Date\(\s*\)|Math\.random|performance\.now|fetch\(|process\.env|from "node:|require\(|XMLHttpRequest|localStorage/);
    }
  });

  it("imports nothing from the application, the data layer or the UI", () => {
    for (const [name, text] of sources) expect(text, name).not.toMatch(/from "@\/(lib|app|components)|@supabase|from "react|from "next/);
  });

  it("has no carrier-cost field or word in any exported type or code identifier", () => {
    for (const [name, text] of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, name).not.toMatch(/buyRate|carrierCost|carrierRate|wholesale|margin\b|profit/i);
    }
  });
});
