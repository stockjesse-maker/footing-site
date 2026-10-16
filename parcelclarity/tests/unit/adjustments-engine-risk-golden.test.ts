import { describe, expect, it } from "vitest";
import { forecastAdjustmentRisk, type RiskInputs } from "@/engine/adjustments";
import { fixture, mismatches } from "./adjustments-engine-support";

/**
 * Risk goldens: all 45 cases of scenarios.json "riskCases" against expected.json "risk" (R1-R7, the truth table
 * T1 in both bases, rounding ties, null severity, V = 0, p = 0 and 100, k = 0, the manual-approval range, all four
 * buckets, the refusals). Expected amounts are integer E4 derived by hand and by a Fraction-based second implementation.
 */
interface RiskCase {
  id: string;
  description: string;
  input: RiskInputs;
}
const { riskCases } = fixture<{ riskCases: RiskCase[] }>("scenarios.json");
const expected = fixture<{ risk: Record<string, Record<string, unknown>> }>("expected.json").risk;

describe("adjustment risk forecast goldens", () => {
  it("covers every case (45) with an expectation", () => {
    expect(riskCases).toHaveLength(45);
    expect(Object.keys(expected).sort()).toEqual(riskCases.map((c) => c.id).sort());
  });

  for (const c of riskCases) {
    it(`${c.id}: ${c.description}`, () => {
      const result = forecastAdjustmentRisk(c.input);
      expect(mismatches(result, expected[c.id]!)).toEqual([]);
      expect(JSON.parse(JSON.stringify(result)), `${c.id}: plain JSON (no Decimal, no negative zero)`).toEqual(result);
      if (result.status === "ok" && result.buckets && result.countedHereE4 !== null) {
        // The E4 identity: the four buckets always add up to the counted total, exactly.
        const b = result.buckets;
        expect(b.customerPays + b.decidedCaseByCase + b.notBilledToCustomer + b.notDecided).toBe(result.countedHereE4);
      }
    });
  }

  it("never returns an unknown as zero: a null severity or an unknown incidence is not_computed", () => {
    for (const c of riskCases) {
      const r = forecastAdjustmentRisk(c.input);
      if (r.status !== "ok") continue;
      for (const comp of Object.values(r.components)) {
        if (comp.state === "not_computed") {
          expect(comp.amountE4, c.id).toBeNull();
          expect(comp.reason, c.id).toBeDefined();
        }
      }
    }
  });
});
