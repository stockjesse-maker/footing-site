import type { ShipmentCalculation } from "@/engine/types";

export const CUSTOMER_RULE_LABEL = "Your 3PL's approved pricing configuration";

/**
 * What a customer may hold of an engine result: amounts, names, categories, statuses, classes and
 * plain-language explanations. Rule keys and versions, the 3PL's source notes, ids, the engine
 * version and the 3PL's exception references are removed on the server, so no client rendering
 * (and no stored copy a customer can read) can leak them. Verification state stays: it is what
 * makes a line an estimate rather than a definite charge, and the result already says so.
 */
export function customerSafe(result: ShipmentCalculation): ShipmentCalculation {
  const safeRule = (rule: ShipmentCalculation["lines"][number]["rule"]) =>
    rule ? { key: "", version: 0, scope: rule.scope, sourceReference: rule.scope === "platform" ? rule.sourceReference : CUSTOMER_RULE_LABEL, verificationStatus: rule.verificationStatus } : rule;
  return {
    ...result,
    lines: result.lines.map((l) => ({ ...l, rule: safeRule(l.rule) })),
    warnings: result.warnings.map((w) => ({ code: w.code, message: w.message })),
    references: {
      ...result.references,
      rateCardId: "",
      rateCardVersionId: "",
      rateCardVersionNumber: 0,
      termsVersion: null,
      engineVersion: "",
      rules: [],
      zipLists: [],
      overrides: [],
    },
  };
}
