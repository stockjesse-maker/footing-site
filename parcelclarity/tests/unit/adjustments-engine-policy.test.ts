import { describe, expect, it } from "vitest";
import { isValidPolicyPair, policyFnFor, resolveHandling, type PolicyRow } from "@/engine/adjustments";
import { POLICY_MATRIX, POLICY_MATRIX_CASES } from "../db/policy-matrix";
import { fixture } from "./adjustments-engine-support";

/**
 * Policy resolution: every query of tests/fixtures/adjustments/policy-matrix.json (28), the seven exclusion
 * examples (the same rules as the database exclusion constraint, checked here without a database), and the pair
 * validity rule. tests/db/adjustments-policy-parity.test.ts runs the SAME file through app.adjustment_handling.
 */
interface MatrixPolicy extends PolicyRow {
  id: string;
}
interface Query {
  id: string;
  brandId: string | null;
  adjustmentType: string;
  component: string;
  on: string;
  expected: string;
  why: string;
}
interface Example {
  id: string;
  rows: MatrixPolicy[];
  overlap: boolean;
  note: string;
}
const matrix = fixture<{ validPairs: { adjustmentType: string; component: string }[]; policies: MatrixPolicy[]; queries: Query[]; constraintExamples: Example[] }>("policy-matrix.json");

describe("resolveHandling against the shared policy matrix", () => {
  it("has 28 queries and 7 exclusion examples", () => {
    expect(matrix.queries).toHaveLength(28);
    expect(matrix.constraintExamples).toHaveLength(7);
  });

  for (const q of matrix.queries) {
    it(`${q.id}: ${q.why}`, () => {
      expect(resolveHandling(matrix.policies, q.brandId, q.adjustmentType, q.component, q.on)).toBe(q.expected);
    });
  }

  it("policyFnFor binds a customer and a date", () => {
    const fn = policyFnFor(matrix.policies, "brandA", "2026-10-16");
    expect(fn("reweight", "postage_difference")).toBe("absorbed");
    expect(fn("reweight", "separate_fee")).toBe("absorbed");
    expect(fn("correction", "separate_fee")).toBe("absorbed");
    expect(fn("combined", "separate_fee")).toBe("pass_through");
  });
});

describe("resolveHandling against the database team's own matrix (tests/db/policy-matrix.ts, 18 more cases)", () => {
  const rows: PolicyRow[] = POLICY_MATRIX.map((p) => ({ brandId: p.brand, adjustmentType: p.type, component: p.component, handling: p.handling, validFrom: p.validFrom, validTo: p.validTo }));
  for (const c of POLICY_MATRIX_CASES) {
    it(`${c.brand ?? "default"} ${c.type}/${c.component} on ${c.on}: ${c.why}`, () => {
      expect(resolveHandling(rows, c.brand, c.type, c.component, c.on)).toBe(c.expected);
    });
  }
});

describe("policy pair validity and robustness", () => {
  it("accepts exactly the seven valid (type, component) pairs", () => {
    const types = ["reweight", "remeasure", "combined", "correction", "other"];
    const components = ["postage_difference", "separate_fee", "surcharge"];
    const valid = types.flatMap((t) => components.filter((c) => isValidPolicyPair(t, c)).map((c) => `${t}/${c}`));
    expect(valid.sort()).toEqual(matrix.validPairs.map((p) => `${p.adjustmentType}/${p.component}`).sort());
  });

  it("an invalid pair is never resolved, even if a row exists for it", () => {
    const rows: PolicyRow[] = [{ brandId: null, adjustmentType: "correction", component: "postage_difference", handling: "absorbed", validFrom: "2026-01-01", validTo: null }];
    expect(resolveHandling(rows, null, "correction", "postage_difference", "2026-06-01")).toBe("unconfigured");
  });

  it("ignores a stored value that is not a handling (never invents one)", () => {
    const rows: PolicyRow[] = [{ brandId: null, adjustmentType: "reweight", component: "separate_fee", handling: "free", validFrom: "2026-01-01", validTo: null }];
    expect(resolveHandling(rows, null, "reweight", "separate_fee", "2026-06-01")).toBe("unconfigured");
  });

  it("is independent of row order", () => {
    const reversed = [...matrix.policies].reverse();
    for (const q of matrix.queries) expect(resolveHandling(reversed, q.brandId, q.adjustmentType, q.component, q.on)).toBe(q.expected);
  });

  it("a tenant-wide query (brand null) never reads a customer's own row", () => {
    expect(resolveHandling(matrix.policies, null, "reweight", "postage_difference", "2026-10-16")).toBe("pass_through");
    expect(resolveHandling(matrix.policies, "brandB", "reweight", "postage_difference", "2026-10-16")).toBe("pass_through");
  });
});

describe("exclusion examples: the same overlap rule as the database constraint", () => {
  /** Rows overlap when they share tenant, brand (null = the account default), type and component and their inclusive date ranges intersect. */
  const overlaps = (a: PolicyRow, b: PolicyRow): boolean =>
    a.brandId === b.brandId && a.adjustmentType === b.adjustmentType && a.component === b.component && a.validFrom <= (b.validTo ?? "9999-12-31") && b.validFrom <= (a.validTo ?? "9999-12-31");

  for (const ex of matrix.constraintExamples) {
    it(`${ex.id}: ${ex.note}`, () => {
      expect(overlaps(ex.rows[0]!, ex.rows[1]!)).toBe(ex.overlap);
    });
  }
});
