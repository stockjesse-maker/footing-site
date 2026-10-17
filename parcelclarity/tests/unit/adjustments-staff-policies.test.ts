import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { currentPolicyCells, POLICY_CELLS, type PolicyRecord } from "@/lib/adjustments/action-schemas";
import { BANNED_OWN_AMOUNT, BRAND_A, BRAND_B, BRAND_C, BRANDS, TODAY, accessibleNames, bannedIn, html, idProblems, policy, textOf, unnamedControls } from "./adjustments-staff-support";

const h = vi.hoisted(() => ({ setPolicy: vi.fn(), endPolicy: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/actions/adjustments", () => ({ setPolicy: h.setPolicy, endPolicy: h.endPolicy }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: h.refresh }) }));

const model = await import("@/components/adjustments/staff/policy-model");
const { PolicyMatrix } = await import("@/components/adjustments/staff/policy-matrix");
const { PoliciesWorkspace } = await import("@/components/adjustments/staff/policies-workspace");

/**
 * The Policies screen: four rows (Reweigh, Remeasure, Both together, Other correction fee) by two columns (Shipping charge difference,
 * Separate adjustment fee), for all customers and then for one. The model decides what each select shows and which calls a save makes;
 * the markup is checked for the states (empty, populated, an exception, read-only) and for what a phone needs (labelled 16px selects, one
 * card per row, a decision always in words plus a badge).
 */
const accountAll: PolicyRecord[] = [
  policy({ adjustmentType: "reweight", component: "postage_difference", handling: "pass_through" }),
  policy({ adjustmentType: "reweight", component: "separate_fee", handling: "manual_approval" }),
  policy({ adjustmentType: "remeasure", component: "postage_difference", handling: "absorbed" }),
];
const exception = policy({ adjustmentType: "reweight", component: "separate_fee", handling: "absorbed", brandId: BRAND_A, validFrom: "2026-09-01" });
const account = { kind: "account" } as const;
const customer = { kind: "customer", brandId: BRAND_A, brandName: "Alpha Apparel" } as const;

describe("the matrix model", () => {
  it("has four rows in the design's order and two columns, and only a correction fee lacks a shipping charge difference", () => {
    expect(model.MATRIX_ROWS.map((r) => r.label)).toEqual(["Reweigh", "Remeasure", "Both together", "Other correction fee"]);
    for (const row of model.MATRIX_ROWS) expect(row.cells.map((c) => c.label)).toEqual(["Shipping charge difference", "Separate adjustment fee"]);
    const notApplicable = model.MATRIX_ROWS.flatMap((r) => r.cells.filter((c) => !c.applicable).map((c) => `${r.type}:${c.component}`));
    expect(notApplicable).toEqual(["correction:postage_difference"]);
    expect(POLICY_CELLS).toHaveLength(7);
  });

  it("starts the draft at what is saved: a decision, or nothing", () => {
    const cells = currentPolicyCells(accountAll, TODAY);
    const draft = model.draftFrom(cells, account);
    expect(draft["reweight:postage_difference"]).toBe("pass_through");
    expect(draft["reweight:separate_fee"]).toBe("manual_approval");
    expect(draft["remeasure:postage_difference"]).toBe("absorbed");
    expect(draft["remeasure:separate_fee"]).toBe("");
    expect(Object.keys(draft)).toHaveLength(7);
  });

  it("an unchanged draft makes no calls", () => {
    const cells = currentPolicyCells(accountAll, TODAY);
    expect(model.policyChanges(cells, model.draftFrom(cells, account), account)).toEqual([]);
  });

  it("a changed cell sets, and clearing a saved decision ends it (the all-customers decision applies again)", () => {
    const cells = currentPolicyCells([...accountAll, exception], TODAY);
    const own = model.draftFrom(cells, customer);
    expect(own["reweight:separate_fee"]).toBe("absorbed");
    expect(model.policyChanges(cells, { ...own, "reweight:separate_fee": "" }, customer)).toEqual([{ type: "reweight", component: "separate_fee", action: "end", policyId: exception.id }]);
    expect(model.policyChanges(cells, { ...own, "reweight:postage_difference": "manual_approval" }, customer)).toEqual([{ type: "reweight", component: "postage_difference", action: "set", handling: "manual_approval" }]);
    // Clearing a cell that has no decision of its own makes no call: there is nothing to end.
    expect(model.policyChanges(cells, { ...own, "remeasure:separate_fee": "" }, customer)).toEqual([]);
  });

  it("the same decisions as another row copy every cell both rows have", () => {
    const cells = currentPolicyCells(accountAll, TODAY);
    const draft = model.draftFrom(cells, account);
    const copied = model.copyRowDraft(draft, "reweight", "combined");
    expect(copied["combined:postage_difference"]).toBe("pass_through");
    expect(copied["combined:separate_fee"]).toBe("manual_approval");
    // Copying into the correction row only takes the fee: it has no shipping charge difference.
    const toCorrection = model.copyRowDraft(draft, "reweight", "correction");
    expect(toCorrection["correction:separate_fee"]).toBe("manual_approval");
    expect("correction:postage_difference" in toCorrection).toBe(false);
  });

  it("a customer's own decision beats the all-customers one, and nothing at all is Not decided", () => {
    const cells = currentPolicyCells([...accountAll, exception], TODAY);
    const at = (type: "reweight" | "remeasure", component: "postage_difference" | "separate_fee", scope: typeof account | typeof customer) => model.effectiveDecision(cells.find((c) => c.type === type && c.component === component), scope);
    expect(at("reweight", "separate_fee", customer)).toMatchObject({ handling: "absorbed", source: "own" });
    expect(at("reweight", "postage_difference", customer)).toMatchObject({ handling: "pass_through", source: "all" });
    expect(at("remeasure", "separate_fee", customer)).toMatchObject({ handling: "unconfigured", source: "none" });
    expect(at("reweight", "separate_fee", account)).toMatchObject({ handling: "manual_approval", source: "own" });
  });

  it("lists the customers that have decisions of their own, by name, and knows when nothing is decided", () => {
    const list = model.exceptionSummary([...accountAll, exception, policy({ adjustmentType: "remeasure", component: "separate_fee", handling: "pass_through", brandId: BRAND_B })], BRANDS, TODAY);
    expect(list.map((c) => c.brandName)).toEqual(["Alpha Apparel", "Beta Beverages"]);
    expect(list[0]!.decisions).toEqual([{ type: "reweight", component: "separate_fee", handling: "absorbed" }]);
    expect(model.nothingDecided([], TODAY)).toBe(true);
    expect(model.nothingDecided(accountAll, TODAY)).toBe(false);
    expect(model.nothingDecided([exception], TODAY)).toBe(false);
    // A decision that ended before today is not a decision.
    expect(model.nothingDecided([policy({ adjustmentType: "reweight", component: "separate_fee", handling: "absorbed", validTo: "2026-02-01" })], TODAY)).toBe(true);
  });

  it("names each decision control by its row, column and scope", () => {
    expect(model.decisionName("reweight", "postage_difference", "all customers")).toBe("Reweigh: Shipping charge difference (all customers)");
    expect(model.decisionName("correction", "separate_fee", "Alpha Apparel")).toBe("Other correction fee: Separate adjustment fee (Alpha Apparel)");
  });
});

describe("the all-customers matrix, rendered", () => {
  const render = (policies: PolicyRecord[], canManage = true, scope: typeof account | typeof customer = account) => html(createElement(PolicyMatrix, { scope, policies, today: TODAY, canManage }));

  it("empty: seven selects, each reading Not decided with a badge and the reason to decide", () => {
    const out = render([]);
    const t = textOf(out);
    expect((out.match(/<select/g) ?? []).length).toBe(7);
    expect((t.match(/Not decided/g) ?? []).length).toBeGreaterThanOrEqual(14); // the option text and the badge, seven times
    expect(t).toContain("Choose who pays before you share an example that includes this.");
    expect(out).toMatch(/Not decided<\/span>/);
    expect(t).toContain("Other correction fee");
    expect(t).toContain("Not applicable. A correction fee has no shipping charge difference.");
  });

  it("every select has an accessible name that includes its row, its column and its scope, and a visible label for a phone", () => {
    const out = render([]);
    const names = accessibleNames(out);
    for (const row of ["Reweigh", "Remeasure", "Both together", "Other correction fee"]) {
      for (const col of ["Shipping charge difference", "Separate adjustment fee"]) {
        if (row === "Other correction fee" && col === "Shipping charge difference") continue;
        expect(names, `${row}: ${col}`).toContain(`${row}: ${col} (all customers)`);
      }
    }
    expect((out.match(/<label[^>]*for="/g) ?? []).length).toBe(7);
  });

  it("lists the three choices with their exact names, and the agreement help", () => {
    const out = render([policy({ adjustmentType: "reweight", component: "postage_difference", handling: "pass_through" })]);
    const t = textOf(out);
    for (const option of ["Passed through under the customer agreement", "Decided case by case", "Not billed to the customer (at your customer rates)"]) expect(t).toContain(option);
    expect(t).toContain("Choose this only if your agreement with this customer lets you charge it.");
    expect(out).toContain('<option value="pass_through" selected="">Passed through under the customer agreement</option>');
  });

  it("a saved decision is words plus a badge, with when it applies from", () => {
    const t = textOf(render(accountAll));
    expect(t).toContain("Passed through");
    expect(t).toContain("Case by case");
    expect(t).toContain("Not billed");
    expect(t).toContain("From Jan 1, 2026");
  });

  it("is a set of labelled groups, not a table, and each row is one card below 640px and a grid row from it", () => {
    const out = render(accountAll);
    expect(out).not.toContain("<table");
    expect(out).toContain('role="group" aria-label="Who pays, all customers"');
    expect((out.match(/role="group" aria-labelledby=/g) ?? []).length).toBe(4);
    expect(out).toContain("sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_minmax(0,1fr)]");
    expect(out).toContain("rounded-card border border-line");
    // The column heads exist for sighted users from 640px and are hidden from assistive technology: every select carries its own name.
    expect(out).toContain('aria-hidden="true" class="hidden');
  });

  it("offers one button to save, disabled until something changed, and a way to copy a row into Both together", () => {
    const out = render(accountAll);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Save decisions<\/button>/);
    expect(textOf(out)).toContain("Nothing to save. Change a decision first.");
    expect(textOf(out)).toContain("Use the same decisions as Reweigh");
    expect(textOf(out)).toContain("Use the same decisions as Remeasure");
  });

  it("read-only: decisions as text, no select, no save button, no copy buttons", () => {
    const out = render(accountAll, false);
    expect(out).not.toContain("<select");
    expect(out).not.toContain("Save decisions");
    expect(out).not.toContain("Use the same decisions as");
    expect(textOf(out)).toContain("Passed through under the customer agreement");
    expect(textOf(out)).toContain("Not decided");
  });

  it("never calls the 3PL's own amounts a cost, a loss, a margin or a profit", () => {
    for (const out of [render([]), render(accountAll), render(accountAll, false)]) expect(bannedIn(textOf(out))).toEqual([]);
    expect(BANNED_OWN_AMOUNT.length).toBeGreaterThan(0);
  });
});

describe("one customer's matrix, rendered", () => {
  const render = (policies: PolicyRecord[], canManage = true) => html(createElement(PolicyMatrix, { scope: customer, policies, today: TODAY, canManage }));

  it("the first option clears the exception, and the select is named for the customer", () => {
    const out = render([...accountAll, exception]);
    expect(textOf(out)).toContain("Use the all-customers decision");
    expect(out).toContain('<option value="">Use the all-customers decision</option>');
    expect(accessibleNames(out)).toContain("Reweigh: Separate adjustment fee (Alpha Apparel)");
    expect(textOf(out)).toContain("Set for Alpha Apparel, from Sep 1, 2026");
    expect(textOf(out)).toContain("Same as all customers");
  });

  it("says when the all-customers decision is itself not made", () => {
    expect(textOf(render([]))).toContain("All customers: Not decided");
  });
});

describe("the workspace", () => {
  const render = (policies: PolicyRecord[], over: { canManage?: boolean; initialCustomerId?: string | null; brands?: typeof BRANDS } = {}) =>
    html(createElement(PoliciesWorkspace, { policies, brands: over.brands ?? BRANDS, today: TODAY, canManage: over.canManage ?? true, initialCustomerId: over.initialCustomerId }));

  it("empty: the empty state, then the all-customers matrix, then the customer picker", () => {
    const t = textOf(render([]));
    expect(t).toContain("No decisions yet. Choose who pays for each kind of adjustment. Until you do, nothing can be shared with a customer.");
    expect(t).toContain("For all customers");
    expect(t).toContain("Exceptions for one customer");
    expect(t).toContain("No customer has a decision of its own yet.");
    expect(t).toContain("Choose a customer…");
  });

  it("with decisions: no empty state, and the customers with their own decisions are listed with an Edit button each", () => {
    const out = render([...accountAll, exception]);
    const t = textOf(out);
    expect(t).not.toContain("No decisions yet");
    expect(t).toContain("Customers with their own decisions");
    expect(t).toContain("Alpha Apparel");
    expect(accessibleNames(out)).toContain("Edit decisions for Alpha Apparel");
  });

  it("preselects a customer of this account, and ignores an id that is not one", () => {
    const withCustomer = render(accountAll, { initialCustomerId: BRAND_B });
    expect(textOf(withCustomer)).toContain("Decisions for Beta Beverages");
    expect(withCustomer).toContain('role="region" aria-label="Decisions for Beta Beverages"');
    const guess = render(accountAll, { initialCustomerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    expect(textOf(guess)).not.toContain("Decisions for ");
  });

  it("marks a suspended customer in the picker, and says so when there are no customers", () => {
    const out = render([], {});
    expect(out).toContain("Gamma Goods (suspended)");
    expect(BRAND_C).toBeTruthy();
    const none = textOf(render([], { brands: [] }));
    expect(none).toContain("You have no customers yet.");
    expect(none).toContain("Add a customer");
  });

  it("read-only: says so, hides every control, and still shows the decisions", () => {
    const out = render([...accountAll, exception], { canManage: false });
    expect(textOf(out)).toContain("You can view adjustments, but only administrators can manage them.");
    expect(out).not.toContain("Save decisions");
    expect(accessibleNames(out)).toContain("Show decisions for Alpha Apparel");
    expect(textOf(out)).toContain("Passed through under the customer agreement");
  });

  it("uses h2 and h3 only: the page's h1 belongs to the layout", () => {
    expect(render(accountAll)).not.toMatch(/<h1/);
  });

  it("is well formed for assistive technology: unique ids, every reference resolves, every control has a name, even with two matrices on one page", () => {
    for (const out of [render([]), render([...accountAll, exception], { initialCustomerId: BRAND_A }), render(accountAll, { canManage: false, initialCustomerId: BRAND_A })]) {
      expect(idProblems(out)).toEqual([]);
      expect(unnamedControls(out)).toEqual([]);
    }
    expect((render(accountAll, { initialCustomerId: BRAND_A }).match(/<select/g) ?? []).length).toBe(7 + 7 + 1);
  });
});
