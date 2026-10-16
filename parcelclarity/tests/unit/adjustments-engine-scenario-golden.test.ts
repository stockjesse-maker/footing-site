import { describe, expect, it } from "vitest";
import { evaluateAdjustmentScenario, type AdjustmentScenarioInput } from "@/engine/adjustments";
import { ENGINE_VERSION as PRICING_ENGINE_VERSION } from "@/engine/types";
import { buildContext, fixture, mismatches, policyFnFromProfile, type PolicyProfile, type RulesFile } from "./adjustments-engine-support";

/**
 * Scenario goldens: all 78 cases of tests/fixtures/adjustments/scenarios.json against expected.json. The expected
 * results were derived by hand (and by an independent Python re-pricer) from RULES.md and the M2 fixtures by someone
 * who never saw this engine; nothing here is read back from engine output.
 */
interface Scenario {
  id: string;
  description: string;
  context: string;
  policy: string;
  input: AdjustmentScenarioInput;
}
const rules = fixture<RulesFile>("rules.json");
const { scenarios, policyProfiles } = fixture<{ scenarios: Scenario[]; policyProfiles: Record<string, PolicyProfile> }>("scenarios.json");
const expected = fixture<{ scenarios: Record<string, Record<string, unknown>> }>("expected.json").scenarios;

describe("adjustment scenario goldens", () => {
  it("covers every scenario (78) with an expectation and no strays", () => {
    expect(scenarios).toHaveLength(78);
    expect(Object.keys(expected).sort()).toEqual(scenarios.map((s) => s.id).sort());
    for (const s of scenarios) {
      expect(rules.contexts[s.context], `${s.id}: context ${s.context}`).toBeDefined();
      expect(policyProfiles[s.policy], `${s.id}: policy ${s.policy}`).toBeDefined();
    }
  });

  for (const s of scenarios) {
    it(`${s.id}: ${s.description}`, () => {
      const ctx = buildContext(rules.contexts[s.context]!, rules.rules);
      const result = evaluateAdjustmentScenario(s.input, ctx, policyFnFromProfile(policyProfiles[s.policy]));
      const exp = { ...expected[s.id]! };
      const contains = (exp.messageContains as string[] | undefined) ?? [];
      delete exp.messageContains;
      expect(mismatches(result, exp)).toEqual([]);
      for (const needle of contains) expect(result.message ?? "", `${s.id}: message`).toContain(needle);
      expect(result.engineVersion).toMatch(/^adjustments-/);
      expect(JSON.parse(JSON.stringify(result)), `${s.id}: plain JSON (no Decimal, no negative zero)`).toEqual(result);

      // Fields the expectations do not name, checked against the fixture context, the case's own expected sides and the overlay rules (never against engine output).
      expect(result.rateCardVersionId, `${s.id}: rateCardVersionId`).toBe(ctx.rateCard.versionId);
      expect(result.pricingEngineVersion, `${s.id}: pricingEngineVersion`).toBe(PRICING_ENGINE_VERSION);
      const terms = ctx.rateCard.services.find((t) => t.carrierCode === s.input.shipment.carrierCode && t.serviceCode === s.input.shipment.serviceCode)!;
      const priced = result.status === "ok" || result.status === "no_adjustment";
      const sides = exp.sides as { corrected: { zone?: string } } | undefined;
      if (result.status === "invalid_input") {
        expect(result.service, `${s.id}: service`).toBeNull();
        expect(result.zone, `${s.id}: zone`).toBeNull();
      } else {
        expect(result.service, `${s.id}: service`).toEqual({ serviceId: terms.serviceId, serviceCode: terms.serviceCode, serviceName: terms.serviceName, carrierCode: terms.carrierCode });
        expect(result.zone, `${s.id}: zone`).toBe(priced ? sides!.corrected.zone : null);
      }
      if (priced) expect(result.message, `${s.id}: message`).toBeNull();
      const unavailable = (["declared", "corrected"] as const).filter((side) => result.sides?.[side].status === "unavailable");
      if (result.status.endsWith("_unavailable")) {
        const words = unavailable.map((side) => `${side === "declared" ? "Declared" : "Corrected"} shipment: ${result.sides![side].message}`);
        expect(unavailable.length, `${s.id}: unavailable sides`).toBeGreaterThan(0);
        expect(result.message, `${s.id}: message names each unavailable side with the engine's words`).toBe(words.join(" "));
        for (const side of unavailable) expect(result.sides![side].message, `${s.id}: ${side} message`).toMatch(/\S/);
      }
      for (const line of result.components?.separate_fee.lines ?? []) {
        const rule = rules.rules.find((r) => r.key === line.ruleKey)!;
        expect(line.label, `${s.id}: ${line.ruleKey} label`).toBe(rule.name);
        expect(line.method, `${s.id}: ${line.ruleKey} method`).toBe(rule.method);
        // only a shipment-level percent line names the packages it covers
        expect(line.coveredPackageIndexes === null, `${s.id}: ${line.ruleKey} coveredPackageIndexes`).toBe(!(rule.method === "percent" && !rule.perPackage));
      }
    });
  }

  it("no result field names a carrier cost, a margin or a loss", () => {
    for (const s of scenarios) {
      const ctx = buildContext(rules.contexts[s.context]!, rules.rules);
      const text = JSON.stringify(evaluateAdjustmentScenario(s.input, ctx, policyFnFromProfile(policyProfiles[s.policy]))).toLowerCase();
      for (const banned of ["buy rate", "carrier cost", "margin", "\"loss\"", "profit"]) expect(text, `${s.id}: ${banned}`).not.toContain(banned);
    }
  });
});
