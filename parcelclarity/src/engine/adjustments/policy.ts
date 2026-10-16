import type { Handling, PolicyComponent, PolicyRow, PolicyType } from "./types";

/**
 * Policy resolution, mirroring the SQL function `app.adjustment_handling(tenant, brand, type, component, date)`.
 * A shared fixture (tests/fixtures/adjustments/policy-matrix.json) runs through both in tests.
 *
 *  - A row is in effect on a date when validFrom <= date and (validTo is null or date <= validTo): both ends inclusive.
 *  - The customer's own row in effect beats the account default (brandId null).
 *  - No row in effect resolves to `unconfigured`. Nothing is derived from another type: `combined` is its own explicit row.
 *  - `correction` has the separate fee only; (correction, postage_difference) is invalid and resolves to `unconfigured`.
 */
const HANDLING_VALUES: ReadonlySet<string> = new Set(["absorbed", "pass_through", "manual_approval"]);

/** The seven valid (type, component) pairs. */
export function isValidPolicyPair(type: string, component: string): boolean {
  if (component === "separate_fee") return type === "reweight" || type === "remeasure" || type === "combined" || type === "correction";
  if (component === "postage_difference") return type === "reweight" || type === "remeasure" || type === "combined";
  return false;
}

export function resolveHandling(policies: readonly PolicyRow[], brandId: string | null, type: PolicyType | string, component: PolicyComponent | string, date: string): Handling {
  if (!isValidPolicyPair(type, component)) return "unconfigured";
  let best: PolicyRow | null = null;
  let bestOwn = false;
  for (const p of policies) {
    if (p.adjustmentType !== type || p.component !== component) continue;
    if (!HANDLING_VALUES.has(p.handling)) continue;
    if (p.validFrom > date || (p.validTo !== null && p.validTo < date)) continue;
    const own = brandId !== null && p.brandId === brandId;
    if (!own && p.brandId !== null) continue; // another customer's row never applies
    // The customer's own row wins; among rows of the same standing (the database forbids overlap) the latest start wins.
    if (best === null || (own && !bestOwn) || (own === bestOwn && p.validFrom > best.validFrom)) {
      best = p;
      bestOwn = own;
    }
  }
  return best ? (best.handling as Handling) : "unconfigured";
}

/** A `PolicyFn` over a set of rows for one customer on one date (what the scenario evaluation takes). */
export function policyFnFor(policies: readonly PolicyRow[], brandId: string | null, date: string): (type: PolicyType, component: PolicyComponent) => Handling {
  return (type, component) => resolveHandling(policies, brandId, type, component, date);
}
