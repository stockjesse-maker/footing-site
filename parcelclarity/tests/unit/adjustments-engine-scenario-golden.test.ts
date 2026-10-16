import { describe, expect, it } from "vitest";
import { evaluateAdjustmentScenario, type AdjustmentScenarioInput } from "@/engine/adjustments";
import { buildContext, fixture, mismatches, policyFnFromProfile, type PolicyProfile, type RulesFile } from "./adjustments-engine-support";

/**
 * Scenario goldens: all 61 cases of tests/fixtures/adjustments/scenarios.json against expected.json. The expected
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
  it("covers every scenario (61) with an expectation and no strays", () => {
    expect(scenarios).toHaveLength(61);
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
