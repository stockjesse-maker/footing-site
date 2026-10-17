import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/auth/permissions";
import { BANNED_OWN_AMOUNT, BRAND_A, BRAND_B, TENANT_ID, accessibleNames, bannedIn, html, textOf } from "./adjustments-staff-support";

const h = vi.hoisted(() => ({
  role: "tenant_admin" as string,
  pathname: "/app/adjustments",
  loadOverview: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => undefined,
  getContext: async () => null,
  requireTenantContext: async () => ({
    active: { id: "m1", role: h.role, tenantId: TENANT_ID, tenantName: "Acme 3PL", portal: "tenant", brandId: null },
    profile: { email: "admin@acme.test", fullName: "Ada Admin" },
    memberships: [{ id: "m1", brandName: null, tenantName: "Acme 3PL" }],
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/adjustments/queries", () => ({ loadOverview: h.loadOverview }));
vi.mock("@/components/shell/app-shell", () => ({ AppShell: () => null }));

const model = await import("@/components/adjustments/staff/checklist-model");
const { OverviewView } = await import("@/components/adjustments/staff/overview-view");
const { AdjustmentTabsView } = await import("@/components/adjustments/staff/tabs");
const { AdjustmentsRestricted } = await import("@/components/adjustments/staff/restricted");
const { PrivateNotice } = await import("@/components/adjustments/staff/private-notice");
const { HistoryNav, HISTORY_SECTIONS } = await import("@/components/adjustments/staff/history-nav");
const { AdjustmentsTile, AdjustmentsTileView, estimateBasisText } = await import("@/components/adjustments/staff/overview-tile");
const { CustomerAdjustmentsCard, CustomerAdjustmentsCardView, customerExamplesHref, customerPoliciesHref } = await import("@/components/adjustments/staff/customer-card");
const { adjustmentPermissions } = await import("@/components/adjustments/staff/access");
const { TabBar, SidebarNav } = await import("@/components/shell/nav-links");
const TenantLayout = (await import("@/app/(tenant)/app/layout")).default;
const { NO_SEPARATE_FEE_HELP } = await import("@/lib/adjustments/staff-copy");

type Overview = Parameters<typeof model.checklistSteps>[0];
const fresh = (): Overview => ({
  feeRules: { count: 0, byCategory: {} },
  policies: { cells: 7, decided: 0, undecided: 7, exceptions: 0 },
  scenarios: { active: 0 },
  examples: { live: 0, current: 0, underReview: 0, expired: 0 },
  customersSeeingUndecidedRule: [],
  estimates: { active: 0, latest: null },
  imports: { committed: 0, records: 0 },
});
const complete = (): Overview => ({
  feeRules: { count: 3, byCategory: { reweight: 2, shipping_charge_correction: 1 } },
  policies: { cells: 7, decided: 7, undecided: 0, exceptions: 2 },
  scenarios: { active: 4 },
  examples: { live: 3, current: 2, underReview: 1, expired: 0 },
  customersSeeingUndecidedRule: [],
  estimates: { active: 2, latest: { name: "Q4 reweigh estimate", basis: "declared_weights", createdAt: "2026-10-10T10:00:00Z" } },
  imports: { committed: 2, records: 4120 },
});
const steps = (o: Overview) => model.checklistSteps(o, { noSeparateFee: NO_SEPARATE_FEE_HELP });

beforeEach(() => {
  h.role = "tenant_admin";
  h.pathname = "/app/adjustments";
  h.loadOverview.mockReset();
});

describe("the checklist", () => {
  it("a new account has four steps, none done, in the design's order, each with where to go", () => {
    const s = steps(fresh());
    expect(s.map((x) => x.title)).toEqual(["Add a fee rule for corrections", "Decide who pays", "Build an example", "Share it with a customer"]);
    expect(s.map((x) => x.done)).toEqual([false, false, false, false]);
    expect(s.map((x) => x.action?.href)).toEqual(["/app/surcharges/new", "/app/adjustments/policies", "/app/adjustments/examples", "/app/adjustments/examples"]);
    expect(s[0]!.detail).toBe("No reweigh, remeasure or correction fee rule is in force.");
    expect(s[1]!.detail).toBe("0 of 7 decisions are made for all customers. 7 still read Not decided.");
  });

  it("step 1 says what the page cannot know: a choice not to charge a separate fee is not stored, so the step stays open with help", () => {
    const first = steps(fresh())[0]!;
    expect(first.done).toBe(false);
    expect(first.help).toBe(NO_SEPARATE_FEE_HELP);
    expect(NO_SEPARATE_FEE_HELP).toContain("This page cannot record that choice");
    expect(steps(complete())[0]!.help).toBeNull();
  });

  it("a complete account has every step done, and says how many rules of which kind", () => {
    const s = steps(complete());
    expect(s.map((x) => x.done)).toEqual([true, true, true, true]);
    expect(s[0]!.detail).toBe("3 fee rules in force: 2 reweigh, 1 other correction fee.");
    expect(s[1]!.detail).toBe("All 7 decisions are made for all customers. 2 decisions are set for individual customers.");
    expect(s[2]!.detail).toBe("4 saved examples.");
    expect(s[3]!.detail).toBe("3 examples shared: 2 current, 1 under review.");
    expect(s[3]!.action?.label).toBe("Review shared examples");
  });

  it("is computed from the data, never stored: the same input gives the same steps", () => {
    expect(steps(complete())).toEqual(steps(complete()));
  });

  it("step 4 is done only when a shared example is current", () => {
    const o = complete();
    o.examples = { live: 1, current: 0, underReview: 1, expired: 0 };
    expect(steps(o)[3]!.done).toBe(false);
    o.examples = { live: 0, current: 0, underReview: 0, expired: 0 };
    expect(steps(o)[3]!.detail).toBe("Nothing is shared yet.");
  });

  it("step 3 is done by a saved example, or by a shared one", () => {
    const o = fresh();
    o.examples = { live: 1, current: 1, underReview: 0, expired: 0 };
    expect(steps(o)[2]!.done).toBe(true);
    expect(steps(o)[2]!.detail).toBe("No saved examples, but examples are shared with customers.");
  });
});

describe("the warning about what customers can see", () => {
  it("is null when no customer sees an undecided rule", () => {
    expect(model.undecidedRuleWarning(fresh())).toBeNull();
  });

  it("names each customer and the kind of rule, capped at ten with a count of the rest", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ brandId: `b${i}`, brandName: `Customer ${i}`, categories: ["reweight", "shipping_charge_correction"] }));
    const w = model.undecidedRuleWarning({ customersSeeingUndecidedRule: many })!;
    expect(w.customers).toHaveLength(10);
    expect(w.more).toBe(3);
    expect(w.customers[0]).toEqual({ brandId: "b0", brandName: "Customer 0", words: "reweigh, other correction fee" });
  });

  it("older fee rules are read defensively: a failed or malformed answer is 'could not be read', never 'none'", () => {
    expect(model.parseLegacyFeeRules([])).toEqual([]);
    expect(model.parseLegacyFeeRules([{ ruleName: "Reweigh fee", versionNumber: 2 }])).toEqual([{ ruleName: "Reweigh fee", versionNumber: 2 }]);
    for (const bad of [null, undefined, "x", {}, [1], [{ ruleName: "a" }], [{ ruleName: "a", versionNumber: 1.5 }], [{ ruleName: 3, versionNumber: 1 }]]) expect(model.parseLegacyFeeRules(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("the Overview", () => {
  const render = (data: Overview, over: { legacy?: Parameters<typeof OverviewView>[0]["legacy"]; canManage?: boolean } = {}) => html(createElement(OverviewView, { data, legacy: over.legacy, canManage: over.canManage ?? true }));

  it("a new account: the private notice, the four steps not done, and where things stand with no figure invented", () => {
    const out = render(fresh());
    const t = textOf(out);
    expect(t).toContain("Only your team can see this. Customers never do.");
    expect(t).toContain("Set up adjustments");
    expect((t.match(/Not done/g) ?? []).length).toBe(4);
    expect(t).toContain("Step 1: Add a fee rule for corrections");
    expect(t).toContain("Step 4: Share it with a customer");
    expect(t).toContain("Add a surcharge rule");
    expect(t).toContain(NO_SEPARATE_FEE_HELP);
    expect(t).toContain("0 of 7 made");
    expect(t).toContain("None yet");
    expect(t).toContain("None shared");
    expect(t).toContain("None saved");
    expect(t).not.toContain("$");
    expect(out).toContain('data-testid="checklist-fee-rule"');
    expect(out).toContain('href="/app/surcharges/new"');
  });

  it("every step shows its status as words and a badge", () => {
    const t = textOf(render(complete()));
    expect((t.match(/Done/g) ?? []).length).toBe(4);
    expect(t).not.toContain("Not done");
  });

  it("a complete account shows what is imported, shared and saved, with the latest estimate's basis in words", () => {
    const t = textOf(render(complete()));
    expect(t).toContain("4,120 records from 2 imports");
    expect(t).toContain("3 shared");
    expect(t).toContain("2 current, 1 under review");
    expect(t).toContain("2 saved");
    expect(t).toContain("Latest: Q4 reweigh estimate, Declared weights");
  });

  it("warns, naming the customers, when customers can read a fee rule nobody has decided who pays", () => {
    const o = fresh();
    o.customersSeeingUndecidedRule = [
      { brandId: BRAND_A, brandName: "Alpha Apparel", categories: ["reweight"] },
      { brandId: BRAND_B, brandName: "Beta Beverages", categories: ["remeasure", "shipping_charge_correction"] },
    ];
    const out = render(o);
    const t = textOf(out);
    expect(t).toContain("Customers can see a fee rule that nobody has decided who pays");
    expect(t).toContain("These 2 customers read a reweigh, remeasure or correction fee rule in their pricing as a charge that may be added after shipping, but you have not decided who pays it.");
    expect(t).toMatch(/Alpha Apparel\s*: reweigh/);
    expect(t).toMatch(/Beta Beverages\s*: remeasure, other correction fee/);
    expect(t).toContain("If you decide the separate adjustment fee is not billed to the customer, the rule is hidden from them.");
    expect(out).toContain('role="status"');
    expect(render(fresh())).not.toContain("Customers can see a fee rule");
  });

  it("older fee rules saved as fixed charges get their own warning, listing them; a failed check says it failed", () => {
    const warn = textOf(render(fresh(), { legacy: [{ ruleName: "Reweigh fee", versionNumber: 1 }] }));
    expect(warn).toContain("Some correction fee rules are saved as fixed charges");
    expect(warn).toContain("Reweigh fee, version 1");
    expect(warn).toContain("Retire each one and publish it again as a conditional charge.");
    expect(textOf(render(fresh(), { legacy: null }))).toContain("The check for older correction fee rules could not be run. Reload the page to try again.");
    for (const none of [undefined, []]) expect(textOf(render(fresh(), { legacy: none }))).not.toContain("saved as fixed charges");
  });

  it("read-only: says so and still shows everything", () => {
    const t = textOf(render(complete(), { canManage: false }));
    expect(t).toContain("You can view adjustments, but only administrators can manage them.");
    expect(t).toContain("Set up adjustments");
  });

  it("uses headings under the layout's h1 only, and never calls the 3PL's own amounts a cost, a loss, a margin or a profit", () => {
    for (const out of [render(fresh()), render(complete()), render(fresh(), { legacy: [{ ruleName: "Reweigh fee", versionNumber: 1 }] })]) {
      expect(out).not.toMatch(/<h1/);
      expect(bannedIn(textOf(out))).toEqual([]);
    }
    expect(BANNED_OWN_AMOUNT.length).toBeGreaterThan(0);
  });

  it("the private notice has a text label as well as the badge", () => {
    const out = html(createElement(PrivateNotice));
    expect(textOf(out)).toBe("Private Only your team can see this. Customers never do.");
  });
});

describe("the tabs", () => {
  const render = (pathname: string) => html(createElement(AdjustmentTabsView, { pathname }));

  it("are a navigation named for the section, with the five tabs as links, each at least 44px tall", () => {
    const out = render("/app/adjustments");
    expect(out).toContain('aria-label="Adjustments sections"');
    expect(textOf(out)).toBe("Overview Policies History Examples Risk");
    expect((out.match(/<a /g) ?? []).length).toBe(5);
    expect((out.match(/min-h-11/g) ?? []).length).toBe(5);
    expect(out).toContain("overflow-x-auto");
  });

  it("mark the current tab with aria-current and with weight, not colour alone; subpages keep their tab current", () => {
    const current = (pathname: string) => [...render(pathname).matchAll(/<a [^>]*aria-current="page"[^>]*>(.*?)<\/a>/g)].map((m) => textOf(m[1]!));
    expect(current("/app/adjustments")).toEqual(["Overview"]);
    expect(current("/app/adjustments/policies")).toEqual(["Policies"]);
    expect(current("/app/adjustments/history/statistics")).toEqual(["History"]);
    expect(current("/app/adjustments/examples")).toEqual(["Examples"]);
    expect(current("/app/adjustments/risk")).toEqual(["Risk"]);
    expect(render("/app/adjustments/policies")).toContain("font-semibold");
  });
});

describe("the History sections", () => {
  it("are Imports, How often and Packages shipped, with their own routes under History", () => {
    expect(HISTORY_SECTIONS.map((x) => [x.label, x.href])).toEqual([
      ["Imports", "/app/adjustments/history"],
      ["How often", "/app/adjustments/history/statistics"],
      ["Packages shipped", "/app/adjustments/history/baselines"],
    ]);
  });

  it("mark the current one with aria-current, a tick and weight (not colour alone), each link at least 44px tall", () => {
    for (const current of ["imports", "statistics", "baselines"] as const) {
      const out = html(createElement(HistoryNav, { current }));
      expect((out.match(/aria-current="page"/g) ?? []).length).toBe(1);
      expect((out.match(/✓/g) ?? []).length).toBe(1);
      expect((out.match(/min-h-11/g) ?? []).length).toBe(3);
      expect(out).toContain('aria-label="History sections"');
      const currentLink = /<a [^>]*aria-current="page"[^>]*>(.*?)<\/a>/.exec(out)![0];
      expect(currentLink).toContain("font-semibold");
      expect(currentLink).toContain('aria-hidden="true">✓</span>');
    }
  });
});

describe("who may use the area", () => {
  it("an administrator views and manages; an employee does neither", () => {
    expect(adjustmentPermissions("tenant_admin")).toEqual({ canView: true, canManage: true });
    expect(adjustmentPermissions("tenant_employee")).toEqual({ canView: false, canManage: false });
    expect(adjustmentPermissions("brand_admin" as Role)).toEqual({ canView: false, canManage: false });
  });

  it("what a member without the permission reads is a page that says who can, with a way back and nothing of the area", () => {
    const out = html(createElement(AdjustmentsRestricted));
    const t = textOf(out);
    expect(t).toContain("Adjustments are for administrators");
    expect(t).toContain("You can view customers and rate cards, but only administrators can view or manage adjustment decisions, history, examples and estimates.");
    expect(out).toContain('href="/app"');
    expect(out).toContain('aria-label="Adjustments are restricted"');
    expect(t).not.toContain("Policies");
  });
});

describe("the tile on the account overview", () => {
  it("shows the decisions not made, the shared examples and the latest saved estimate with its basis, and no money figure", () => {
    const out = html(createElement(AdjustmentsTileView, { state: { kind: "ok", data: { undecided: 3, cells: 7, sharedExamples: 2, latestEstimate: { name: "Q4 reweigh estimate", basis: "actual_weights", createdAt: "2026-10-10T10:00:00Z" } } } }));
    const t = textOf(out);
    expect(t).toContain("Adjustments");
    expect(t).toContain("Decisions not made yet 3 of 7");
    expect(t).toContain("Shown as Not decided on the Policies tab.");
    expect(t).toContain("Examples shared with customers 2");
    expect(t).toContain("Latest saved estimate Q4 reweigh estimate Actual weights, saved Oct 10, 2026");
    expect(t).toContain("Only your team can see this. Customers never do.");
    expect(t).not.toContain("$");
    expect(out).toContain('href="/app/adjustments"');
    expect(out).toContain('aria-labelledby="adjustments-tile-heading"');
  });

  it("nothing undecided and nothing saved read as such", () => {
    const t = textOf(html(createElement(AdjustmentsTileView, { state: { kind: "ok", data: { undecided: 0, cells: 7, sharedExamples: 0, latestEstimate: null } } })));
    expect(t).toContain("0 of 7");
    expect(t).toContain("Every decision for all customers is made.");
    expect(t).toContain("None saved");
  });

  it("a load that failed says so; it never shows zeros", () => {
    const out = html(createElement(AdjustmentsTileView, { state: { kind: "failed" } }));
    expect(textOf(out)).toContain("The adjustments summary could not be loaded. Reload the page to try again.");
    expect(out).toContain('role="alert"');
    expect(textOf(out)).not.toContain("0 of");
  });

  it("an estimate with no recorded basis says so", () => {
    expect(estimateBasisText(null)).toBe("Basis not recorded");
    expect(estimateBasisText("declared_weights")).toBe("Declared weights");
  });

  it("reads loadOverview for an administrator, renders nothing and reads nothing for anyone else", async () => {
    h.loadOverview.mockResolvedValue({ ...complete(), policies: { cells: 7, decided: 4, undecided: 3, exceptions: 0 }, examples: { live: 5, current: 5, underReview: 0, expired: 0 }, estimates: { active: 1, latest: { id: "e", brandId: null, name: "Latest", createdAt: "2026-10-12T00:00:00Z", archivedAt: null, basis: "declared_weights", countedE4: 14_600_000 } } });
    const el = await AdjustmentsTile();
    const t = textOf(html(el!));
    expect(h.loadOverview).toHaveBeenCalledTimes(1);
    expect(h.loadOverview.mock.calls[0]![1]).toBe(TENANT_ID);
    expect(t).toContain("3 of 7");
    expect(t).toContain("Latest Declared weights, saved Oct 12, 2026");
    // The estimate's money figure is not shown on the tile.
    expect(t).not.toContain("1,460");
    h.role = "tenant_employee";
    h.loadOverview.mockClear();
    expect(await AdjustmentsTile()).toBeNull();
    expect(h.loadOverview).not.toHaveBeenCalled();
  });

  it("a failing load becomes the failure state", async () => {
    h.loadOverview.mockRejectedValue(new Error("db down"));
    const el = await AdjustmentsTile();
    expect(el).not.toBeNull();
    const t = textOf(html(el!));
    expect(t).toContain("could not be loaded");
    expect(t).not.toContain("0 of");
  });
});

describe("the card on the customer page", () => {
  it("links to the examples filtered to this customer and to this customer's decisions", () => {
    const out = html(createElement(CustomerAdjustmentsCardView, { brandId: BRAND_A, brandName: "Alpha Apparel" }));
    expect(customerExamplesHref(BRAND_A)).toBe(`/app/adjustments/examples?brand=${BRAND_A}`);
    expect(customerPoliciesHref(BRAND_A)).toBe(`/app/adjustments/policies?customer=${BRAND_A}`);
    expect(out).toContain(`href="/app/adjustments/examples?brand=${BRAND_A}"`);
    expect(out).toContain(`href="/app/adjustments/policies?customer=${BRAND_A}"`);
    expect(textOf(out)).toContain("Adjustment examples for Alpha Apparel");
    expect(textOf(out)).toContain("Open examples");
    expect(textOf(out)).toContain("Decide who pays");
    expect(out).toContain(`aria-labelledby="adjustments-card-heading-${BRAND_A}"`);
    expect(bannedIn(textOf(out))).toEqual([]);
  });

  it("is shown to an administrator and to nobody else", async () => {
    expect(await CustomerAdjustmentsCard({ brandId: BRAND_A, brandName: "Alpha Apparel" })).not.toBeNull();
    h.role = "tenant_employee";
    expect(await CustomerAdjustmentsCard({ brandId: BRAND_A, brandName: "Alpha Apparel" })).toBeNull();
  });
});

describe("the navigation", () => {
  /** The layout hands the shell its navigation as a prop: read it off the element the layout returns. */
  const navOf = async (role: string) => {
    h.role = role;
    const el = (await TenantLayout({ children: null })) as { props: { nav: { href: string; label: string; icon: string }[] } };
    return el.props.nav;
  };
  const labels = async (role: string) => (await navOf(role)).map((n) => n.label);

  it("an administrator gets one new entry, Adjustments, after Calculator: ten in all", async () => {
    expect(await labels("tenant_admin")).toEqual(["Overview", "Customers", "Rate cards", "Fee schedules", "Surcharges", "Calculator", "Adjustments", "Team", "Activity", "Settings"]);
    expect((await navOf("tenant_admin")).find((n) => n.label === "Adjustments")).toEqual({ href: "/app/adjustments", label: "Adjustments", icon: "scale" });
  });

  it("an employee does not get it", async () => {
    expect(await labels("tenant_employee")).toEqual(["Overview", "Customers", "Rate cards", "Fee schedules", "Surcharges", "Calculator", "Settings"]);
  });

  const items = [
    { href: "/app", label: "Overview", icon: "home" as const, exact: true },
    { href: "/app/calculator", label: "Calculator", icon: "calculator" as const },
    { href: "/app/adjustments", label: "Adjustments", icon: "scale" as const },
    { href: "/app/settings", label: "Settings", icon: "settings" as const },
  ];

  it("the phone tab bar marks the area current on every page under it, keeps a 44px+ target and does not clip the longest label", () => {
    h.pathname = "/app/adjustments/history/statistics";
    const out = html(createElement(TabBar, { items }));
    const current = [...out.matchAll(/<a [^>]*aria-current="page"[^>]*>(.*?)<\/a>/g)].map((m) => textOf(m[1]!));
    expect(current).toEqual(["Adjustments"]);
    expect(out).toContain("min-h-14");
    // 76px: "Adjustments" at 11px is wider than the 64px that 72px leaves after padding.
    expect(out).toContain("min-w-[4.75rem]");
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("<svg");
  });

  it("the sidebar lists the entry with an icon and the same current marker", () => {
    h.pathname = "/app/adjustments";
    const out = html(createElement(SidebarNav, { items }));
    expect(textOf(out)).toBe("Overview Calculator Adjustments Settings");
    expect(accessibleNames(out)).toEqual(["Primary"]);
    expect([...out.matchAll(/<a [^>]*aria-current="page"[^>]*>(.*?)<\/a>/g)].map((m) => textOf(m[1]!))).toEqual(["Adjustments"]);
  });
});
