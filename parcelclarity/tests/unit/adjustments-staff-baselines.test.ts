import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { BANNED_OWN_AMOUNT, BRANDS, BRAND_A, CATALOG, SVC_UPS_GROUND, accessibleNames, bannedIn, html, idProblems, textOf, unnamedControls } from "./adjustments-staff-support";

vi.mock("@/app/actions/adjustments", () => ({ saveBaseline: vi.fn(), deleteBaseline: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const model = await import("@/components/adjustments/staff/baselines-model");
const { BaselineList, BaselineFormView, BaselinesPanel } = await import("@/components/adjustments/staff/baselines-panel");

/**
 * Packages shipped ("baselines"): the denominator of how often adjustments happen. The unit is the carrier package and is said so; a period
 * for the same scope cannot overlap another (the action says so in words); nothing is summed across scopes.
 */
const brands = BRANDS.map((b) => ({ id: b.id, name: b.name }));
type Figure = { id: string; brandId: string | null; carrierCode: string | null; serviceId: string | null; periodStart: string; periodEnd: string; packagesTotal: number; labelsMissingWeight: number | null; note: string | null };
const one: Figure = { id: "b1", brandId: BRAND_A, carrierCode: "ups", serviceId: SVC_UPS_GROUND, periodStart: "2026-08-01", periodEnd: "2026-08-31", packagesTotal: 12000, labelsMissingWeight: 340, note: "From the WMS shipment report" };
const two: Figure = { id: "b2", brandId: null, carrierCode: null, serviceId: null, periodStart: "2026-09-01", periodEnd: "2026-09-30", packagesTotal: 1, labelsMissingWeight: null, note: null };

describe("the form's input", () => {
  const filled: Parameters<typeof model.baselineInput>[0] = { brandId: BRAND_A, carrierCode: "ups", serviceId: SVC_UPS_GROUND, periodStart: "2026-08-01", periodEnd: "2026-08-31", packages: "12,000", labelsMissing: "340", note: " From the WMS " };

  it("becomes the action's input: whole numbers, trimmed note, empty choices as null", () => {
    expect(model.baselineInput(filled)).toEqual({ ok: true, input: { brandId: BRAND_A, carrierCode: "ups", serviceId: SVC_UPS_GROUND, periodStart: "2026-08-01", periodEnd: "2026-08-31", packagesTotal: 12000, labelsMissingWeight: 340, note: "From the WMS" } });
    expect(model.baselineInput({ ...filled, brandId: "", carrierCode: "", serviceId: "", labelsMissing: "", note: "" })).toEqual({
      ok: true,
      input: { brandId: null, carrierCode: null, serviceId: null, periodStart: "2026-08-01", periodEnd: "2026-08-31", packagesTotal: 12000, labelsMissingWeight: null, note: undefined },
    });
  });

  it("says what to fix, per field, and sends nothing", () => {
    expect(model.baselineInput(model.EMPTY_BASELINE_FORM)).toEqual({ ok: false, errors: { periodStart: "Enter the first day of the period.", periodEnd: "Enter the last day of the period.", packages: "Enter a whole number of packages, at least 1." } });
    expect(model.baselineInput({ ...filled, periodEnd: "2026-07-01" })).toMatchObject({ ok: false, errors: { periodEnd: "The period ends before it starts." } });
    for (const bad of ["0", "-5", "1.5", "many", ""]) expect(model.baselineInput({ ...filled, packages: bad }), bad).toMatchObject({ ok: false, errors: { packages: "Enter a whole number of packages, at least 1." } });
    expect(model.baselineInput({ ...filled, labelsMissing: "12001" })).toMatchObject({ ok: false, errors: { labelsMissing: "Labels without a weight cannot be more than the packages shipped." } });
    expect(model.baselineInput({ ...filled, labelsMissing: "x" })).toMatchObject({ ok: false, errors: { labelsMissing: "Enter a whole number, or leave it empty." } });
  });

  it("names a figure's scope in words, including all customers, all carriers and all services", () => {
    expect(model.baselineScope(one, brands, CATALOG)).toBe("Alpha Apparel, UPS, UPS Ground");
    expect(model.baselineScope(two, brands, CATALOG)).toBe("All customers together, All carriers, All services");
    expect(model.baselineScope({ brandId: "gone", carrierCode: "zzz", serviceId: "gone" }, brands, CATALOG)).toBe("A customer that is no longer listed, zzz, A service that is no longer listed");
  });

  it("names the period and the size in words, with the unit", () => {
    expect(model.baselinePeriod(one)).toBe("Aug 1, 2026 to Aug 31, 2026");
    expect(model.baselinePeriod({ periodStart: "2026-08-01", periodEnd: "2026-08-01" })).toBe("Aug 1, 2026");
    expect(model.baselineSize(one)).toBe("12,000 packages shipped");
    expect(model.baselineSize(two)).toBe("1 package shipped");
  });

  it("lists the newest period first and keeps the order stable", () => {
    expect(model.sortBaselines([one, two]).map((b) => b.id)).toEqual(["b2", "b1"]);
    expect(model.sortBaselines([{ ...one, id: "z" }, { ...one, id: "a" }]).map((b) => b.id)).toEqual(["a", "z"]);
  });
});

describe("the saved figures", () => {
  const render = (baselines: Figure[], canManage = true) => html(createElement(BaselineList, { baselines, brands, catalog: CATALOG, canManage }));

  it("empty: invites the next action", () => {
    const t = textOf(render([]));
    expect(t).toContain("No packages-shipped figures yet");
    expect(t).toContain("Add how many packages you shipped in a period to see how often adjustments happen.");
  });

  it("populated: scope, period, packages shipped with the unit, labels without a weight, and the private note", () => {
    const out = render([one, two]);
    const t = textOf(out);
    expect(t).toContain("Alpha Apparel, UPS, UPS Ground");
    expect(t).toContain("Aug 1, 2026 to Aug 31, 2026");
    expect(t).toMatch(/12,000 packages shipped\s*,\s*340 printed without a weight/);
    expect(t).toContain("1 package shipped");
    expect(t).toContain("From the WMS shipment report");
    expect(out).toContain('aria-label="Packages shipped, by period"');
    // Newest period first.
    expect(t.indexOf("Sep 1, 2026")).toBeLessThan(t.indexOf("Aug 1, 2026"));
  });

  it("Delete is a two-step control in a group named for the figure it deletes, for an administrator only", () => {
    const out = render([one]);
    expect(accessibleNames(out)).toContain("Delete packages shipped: Alpha Apparel, UPS, UPS Ground, Aug 1, 2026 to Aug 31, 2026");
    expect(textOf(out)).toContain("Delete");
    const readOnly = render([one], false);
    expect(readOnly).not.toContain("Delete");
    expect(textOf(readOnly)).toContain("12,000 packages shipped");
  });

  it("a phone shows each figure as a stacked card", () => {
    const out = render([one]);
    expect(out).toContain("flex-col");
    expect(out).toContain("sm:flex-row");
  });
});

describe("the add form", () => {
  const props = (over: Partial<Parameters<typeof BaselineFormView>[0]> = {}): Parameters<typeof BaselineFormView>[0] => ({ brands, catalog: CATALOG, form: model.EMPTY_BASELINE_FORM, errors: {}, pending: false, failure: null, saved: false, onChange: () => undefined, onSubmit: () => undefined, prefix: "p", ...over });
  const render = (over: Partial<Parameters<typeof BaselineFormView>[0]> = {}) => html(createElement(BaselineFormView, props(over)));

  it("names the unit (carrier packages, one label is one package) and every field", () => {
    const out = render();
    const t = textOf(out);
    expect(t).toContain("Add packages shipped");
    expect(t).toContain("One label is one package.");
    expect(t).toContain("Packages shipped");
    expect(t).toContain("Carrier packages, not orders.");
    for (const label of ["Customer", "Carrier", "Service", "First day of the period", "Last day of the period", "Labels printed without a weight (optional)", "Private note (optional)"]) expect(t).toContain(label);
    expect(t).toContain("All customers together");
    expect(t).toContain("All carriers");
    expect(t).toContain("All services");
    expect(t).toContain("Only your team can read this.");
    expect(t).toContain("Save packages shipped");
    expect((out.match(/<label[^>]*for="/g) ?? []).length).toBe(8);
    expect(out).not.toMatch(/<h1/);
  });

  it("explains that periods for the same customer, carrier and service cannot overlap", () => {
    expect(textOf(render())).toContain("Periods for the same customer, carrier and service cannot overlap.");
  });

  it("the service waits for a carrier, then lists that carrier's services", () => {
    expect(render()).toMatch(/<select[^>]*id="p-service"[^>]*disabled=""|<select[^>]*disabled=""[^>]*id="p-service"/);
    const chosen = render({ form: { ...model.EMPTY_BASELINE_FORM, carrierCode: "usps" } });
    expect(chosen).toContain("USPS: USPS Ground Advantage");
    expect(chosen).not.toContain("UPS: UPS Ground");
  });

  it("an overlapping period is refused in the action's words, as an alert that takes focus", () => {
    const message = "This overlaps another baseline for the same customer, carrier and service. Change the dates or edit that one.";
    const out = render({ failure: { message, attempt: 1 } });
    expect(out).toContain('role="alert"');
    expect(out).toContain('tabindex="-1"');
    expect(textOf(out)).toContain(message);
  });

  it("field errors are attached to their fields; saving shows a busy button and then Saved.", () => {
    const bad = render({ errors: { packages: "Enter a whole number of packages, at least 1.", periodStart: "Enter the first day of the period." } });
    expect((bad.match(/aria-invalid="true"/g) ?? []).length).toBe(2);
    expect(textOf(bad)).toContain("Enter a whole number of packages, at least 1.");
    expect(render({ pending: true })).toMatch(/<button[^>]*aria-busy="true"[^>]*>/);
    expect(textOf(render({ saved: true }))).toContain("Saved.");
    expect(textOf(render())).not.toContain("Saved.");
  });
});

describe("the panel's wiring", () => {
  it("is well formed for assistive technology: unique ids, every reference resolves, every control has a name", () => {
    const out = html(createElement(BaselinesPanel, { baselines: [one, two], brands, catalog: CATALOG, canManage: true }));
    expect(idProblems(out)).toEqual([]);
    expect(unnamedControls(out)).toEqual([]);
  });
});

describe("the panel", () => {
  it("for an administrator: the title, the figures, and the add form", () => {
    const t = textOf(html(createElement(BaselinesPanel, { baselines: [one], brands, catalog: CATALOG, canManage: true })));
    expect(t).toContain("Packages shipped");
    expect(t).toContain("How many packages you shipped in a period.");
    expect(t).toContain("Save packages shipped");
    expect(t).not.toContain("only administrators can manage");
  });

  it("read-only: says so, shows the figures, and has no form and no Delete", () => {
    const out = html(createElement(BaselinesPanel, { baselines: [one], brands, catalog: CATALOG, canManage: false }));
    expect(textOf(out)).toContain("You can view adjustments, but only administrators can manage them.");
    expect(textOf(out)).toContain("12,000 packages shipped");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("Delete");
  });

  it("never calls the 3PL's own amounts a cost, a loss, a margin or a profit", () => {
    for (const canManage of [true, false]) expect(bannedIn(textOf(html(createElement(BaselinesPanel, { baselines: [one, two], brands, catalog: CATALOG, canManage }))))).toEqual([]);
    expect(BANNED_OWN_AMOUNT.length).toBeGreaterThan(0);
  });
});
