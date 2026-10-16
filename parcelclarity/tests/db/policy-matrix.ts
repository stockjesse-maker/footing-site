/**
 * The shared policy-resolution fixture (Milestone 5). The database test runs it through app.adjustment_handling();
 * a TypeScript test of resolveHandling() (src/engine/adjustments) runs the SAME rows through the TypeScript resolver and
 * compares both to `expected`, which was derived by hand from the rules in the comments, never from either implementation.
 *
 * Resolution rules (design v2 §2 table 1, §3.4):
 *   - a policy row is in force on a date when valid_from <= date and (valid_to is null or date <= valid_to);
 *   - the customer's own row in force beats the account default (brand null);
 *   - no row in force = "unconfigured"; combined is its own explicit row (no hidden precedence);
 *   - "correction" has the separate fee only.
 * `brand` is a label ("X", "Y" or null for the account default); the database test maps it to real customer ids.
 */
export type MatrixBrand = "X" | "Y" | null;
export type MatrixType = "reweight" | "remeasure" | "combined" | "correction";
export type MatrixComponent = "postage_difference" | "separate_fee";
export type MatrixHandling = "absorbed" | "pass_through" | "manual_approval";

export interface MatrixPolicy {
  brand: MatrixBrand;
  type: MatrixType;
  component: MatrixComponent;
  handling: MatrixHandling;
  validFrom: string;
  validTo: string | null;
}

export interface MatrixCase {
  brand: MatrixBrand;
  type: MatrixType;
  component: MatrixComponent;
  on: string;
  expected: MatrixHandling | "unconfigured";
  why: string;
}

export const POLICY_MATRIX: MatrixPolicy[] = [
  // Account defaults.
  { brand: null, type: "reweight", component: "postage_difference", handling: "pass_through", validFrom: "2026-01-01", validTo: null },
  { brand: null, type: "reweight", component: "separate_fee", handling: "manual_approval", validFrom: "2026-01-01", validTo: "2026-06-30" },
  { brand: null, type: "reweight", component: "separate_fee", handling: "absorbed", validFrom: "2026-07-01", validTo: null },
  { brand: null, type: "remeasure", component: "separate_fee", handling: "absorbed", validFrom: "2026-01-01", validTo: null },
  { brand: null, type: "combined", component: "postage_difference", handling: "pass_through", validFrom: "2026-01-01", validTo: null },
  // Customer X's own decisions.
  { brand: "X", type: "reweight", component: "postage_difference", handling: "absorbed", validFrom: "2026-03-01", validTo: "2026-04-30" },
  { brand: "X", type: "combined", component: "separate_fee", handling: "pass_through", validFrom: "2026-02-01", validTo: null },
];

export const POLICY_MATRIX_CASES: MatrixCase[] = [
  { brand: null, type: "reweight", component: "postage_difference", on: "2026-02-01", expected: "pass_through", why: "the account default applies" },
  { brand: "X", type: "reweight", component: "postage_difference", on: "2026-02-01", expected: "pass_through", why: "X's own row has not started, so the default applies" },
  { brand: "X", type: "reweight", component: "postage_difference", on: "2026-03-01", expected: "absorbed", why: "X's own row beats the default on its first day" },
  { brand: "X", type: "reweight", component: "postage_difference", on: "2026-04-30", expected: "absorbed", why: "X's own row is in force on its last day (inclusive)" },
  { brand: "X", type: "reweight", component: "postage_difference", on: "2026-05-01", expected: "pass_through", why: "X's own row ended; the default applies again" },
  { brand: "Y", type: "reweight", component: "postage_difference", on: "2026-03-15", expected: "pass_through", why: "another customer's row never applies" },
  { brand: null, type: "reweight", component: "postage_difference", on: "2025-12-31", expected: "unconfigured", why: "before the first row" },
  { brand: null, type: "reweight", component: "separate_fee", on: "2026-06-30", expected: "manual_approval", why: "last day of the first default row" },
  { brand: null, type: "reweight", component: "separate_fee", on: "2026-07-01", expected: "absorbed", why: "first day of the replacement default row" },
  { brand: "Y", type: "reweight", component: "separate_fee", on: "2026-08-01", expected: "absorbed", why: "Y has no row; the default in force on that date applies" },
  { brand: null, type: "remeasure", component: "postage_difference", on: "2026-05-01", expected: "unconfigured", why: "no row for this component" },
  { brand: "X", type: "remeasure", component: "separate_fee", on: "2026-05-01", expected: "absorbed", why: "X has no remeasure row; the default applies" },
  { brand: null, type: "combined", component: "separate_fee", on: "2026-05-01", expected: "unconfigured", why: "combined is explicit: the reweight and remeasure rows are never combined implicitly" },
  { brand: "X", type: "combined", component: "separate_fee", on: "2026-01-31", expected: "unconfigured", why: "X's combined row starts on 2026-02-01" },
  { brand: "X", type: "combined", component: "separate_fee", on: "2026-02-01", expected: "pass_through", why: "X's combined row, first day" },
  { brand: "Y", type: "combined", component: "separate_fee", on: "2026-05-01", expected: "unconfigured", why: "X's combined row never applies to Y" },
  { brand: "X", type: "combined", component: "postage_difference", on: "2026-05-01", expected: "pass_through", why: "the default combined row applies to X" },
  { brand: null, type: "correction", component: "separate_fee", on: "2026-05-01", expected: "unconfigured", why: "no correction row" },
];
