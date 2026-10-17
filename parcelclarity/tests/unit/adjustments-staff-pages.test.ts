import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BRANDS, BRAND_A, CATALOG, IMPORT_ID, TENANT_ID, html, importFixture, policy, textOf } from "./adjustments-staff-support";

const h = vi.hoisted(() => ({
  role: "tenant_admin" as string,
  pathname: "/app/adjustments/history",
  rpc: vi.fn(),
  createClient: vi.fn(),
  loadOverview: vi.fn(),
  loadPolicies: vi.fn(),
  loadAdjustmentBrands: vi.fn(),
  listImports: vi.fn(),
  loadBaselines: vi.fn(),
  loadImportWizard: vi.fn(),
  loadServiceCatalog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => undefined,
  getContext: async () => null,
  requireTenantContext: async () => ({ active: { id: "m1", role: h.role, tenantId: TENANT_ID, tenantName: "Acme 3PL", portal: "tenant", brandId: null } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    h.createClient();
    return { rpc: h.rpc };
  },
}));
vi.mock("@/lib/adjustments/queries", () => ({
  loadOverview: h.loadOverview,
  loadPolicies: h.loadPolicies,
  loadAdjustmentBrands: h.loadAdjustmentBrands,
  listImports: h.listImports,
  loadBaselines: h.loadBaselines,
  loadImportWizard: h.loadImportWizard,
}));
vi.mock("@/lib/pricing/catalog", () => ({ loadServiceCatalog: h.loadServiceCatalog }));
vi.mock("@/app/actions/adjustments", () => ({
  setPolicy: vi.fn(),
  endPolicy: vi.fn(),
  uploadAdjustmentFile: vi.fn(),
  saveImportMapping: vi.fn(),
  validateImport: vi.fn(),
  commitImport: vi.fn(),
  discardImport: vi.fn(),
  withdrawImport: vi.fn(),
  saveBaseline: vi.fn(),
  deleteBaseline: vi.fn(),
  loadHistoryStatistics: vi.fn(),
}));

const Layout = (await import("@/app/(tenant)/app/adjustments/layout")).default;
const OverviewPage = (await import("@/app/(tenant)/app/adjustments/page")).default;
const PoliciesPage = (await import("@/app/(tenant)/app/adjustments/policies/page")).default;
const HistoryPage = (await import("@/app/(tenant)/app/adjustments/history/page")).default;
const ImportPage = (await import("@/app/(tenant)/app/adjustments/history/[importId]/page")).default;
const StatisticsPage = (await import("@/app/(tenant)/app/adjustments/history/statistics/page")).default;
const BaselinesPage = (await import("@/app/(tenant)/app/adjustments/history/baselines/page")).default;
const sample = await importFixture("history-sample.csv");

/**
 * The routes of the 3PL's adjustments area, with the server pieces mocked: who is signed in, and the read models. What matters here is what
 * each route does for each kind of member (an administrator reads and manages; an employee reads a notice and nothing is loaded), what it
 * does when a load fails (it says so; it never draws an empty list), and which tenant and id it passes to the loaders.
 */
const everyLoader = () => [h.loadOverview, h.loadPolicies, h.loadAdjustmentBrands, h.listImports, h.loadBaselines, h.loadImportWizard, h.loadServiceCatalog, h.rpc, h.createClient];

const overview = {
  feeRules: { count: 1, byCategory: { reweight: 1 } },
  policies: { cells: 7, decided: 2, undecided: 5, exceptions: 0 },
  scenarios: { active: 0 },
  examples: { live: 0, current: 0, underReview: 0, expired: 0 },
  estimates: { active: 0, latest: null },
  imports: { committed: 0, records: 0 },
  customersSeeingUndecidedRule: [],
};

const importDetail = (over: Record<string, unknown> = {}) => ({
  id: IMPORT_ID,
  name: "august-history",
  status: "uploaded",
  rowCount: 40,
  acceptedCount: 0,
  committedCount: 0,
  skippedCount: 0,
  attestedAt: null,
  createdAt: "2026-10-01T10:00:00Z",
  committedAt: null,
  shipDateFrom: null,
  shipDateTo: null,
  fileId: "f1",
  duplicateHandling: "refuse",
  detected: { sampleRows: sample.sampleRows },
  mapping: null,
  validation: null,
  ...over,
});
const wizardView = (over: Record<string, unknown> = {}, detection: unknown = sample.detection, mapping: unknown = null) => ({ import: importDetail(over), mapping, detection, detectionProblem: detection ? null : "The uploaded file is no longer available. Upload it again.", brands: BRANDS.map((b) => ({ id: b.id, name: b.name })), catalog: CATALOG });

beforeEach(() => {
  h.role = "tenant_admin";
  h.pathname = "/app/adjustments";
  for (const f of everyLoader()) f.mockReset();
  h.loadOverview.mockResolvedValue(overview);
  h.loadPolicies.mockResolvedValue([]);
  h.loadAdjustmentBrands.mockResolvedValue(BRANDS);
  h.listImports.mockResolvedValue([]);
  h.loadBaselines.mockResolvedValue([]);
  h.loadServiceCatalog.mockResolvedValue(CATALOG);
  h.rpc.mockResolvedValue({ data: [], error: null });
});

const renderLayout = async () => html(await Layout({ children: createChild() }));
const createChild = () => createElement("p", null, "CHILD PAGE");

describe("the layout", () => {
  it("an administrator gets the one h1, the description, the five tabs and the page", async () => {
    h.pathname = "/app/adjustments/history";
    const out = await renderLayout();
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(textOf(out)).toContain("Adjustments");
    expect(textOf(out)).toContain("Decide who pays when a package's weight or size is corrected after it was labelled");
    expect(textOf(out)).toContain("Overview Policies History Examples Risk");
    expect(out).toContain("CHILD PAGE");
    expect(out).toMatch(/<a [^>]*aria-current="page"[^>]*>History<\/a>|<a [^>]*href="\/app\/adjustments\/history"[^>]*aria-current="page"/);
  });

  it("an employee gets the heading and the notice, not a 404, not the tabs and not the page", async () => {
    h.role = "tenant_employee";
    const out = await renderLayout();
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(textOf(out)).toContain("Adjustments are for administrators");
    expect(textOf(out)).toContain("You can view customers and rate cards, but only administrators can view or manage adjustment decisions, history, examples and estimates.");
    expect(out).not.toContain("Adjustments sections");
    expect(out).not.toContain("CHILD PAGE");
  });
});

describe("every page checks the permission itself, before it loads anything", () => {
  const params = Promise.resolve({ importId: IMPORT_ID });
  const pages: [string, () => Promise<unknown>][] = [
    ["overview", () => OverviewPage()],
    ["policies", () => PoliciesPage({ searchParams: Promise.resolve({}) })],
    ["history", () => HistoryPage()],
    ["an import", () => ImportPage({ params })],
    ["statistics", () => StatisticsPage()],
    ["packages shipped", () => BaselinesPage()],
  ];

  for (const [name, page] of pages) {
    it(`${name}: an employee reads the notice and no query, no database client and no function runs`, async () => {
      h.role = "tenant_employee";
      const out = html((await page()) as never);
      expect(textOf(out)).toContain("Adjustments are for administrators");
      for (const f of everyLoader()) expect(f).not.toHaveBeenCalled();
    });
  }
});

describe("overview", () => {
  it("loads for the session's own workspace and today, then shows the checklist", async () => {
    const out = html((await OverviewPage()) as never);
    expect(h.loadOverview).toHaveBeenCalledWith(expect.anything(), TENANT_ID, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(h.rpc).toHaveBeenCalledWith("adjustment_legacy_fee_rules", { p_tenant: TENANT_ID });
    expect(textOf(out)).toContain("Set up adjustments");
    expect(textOf(out)).toContain("1 fee rule in force: 1 reweigh.");
    expect(out).not.toContain("saved as fixed charges");
  });

  it("older fee rules found by the database are warned about; a check that fails says it failed", async () => {
    h.rpc.mockResolvedValue({ data: [{ ruleName: "Reweigh fee", versionNumber: 3 }], error: null });
    expect(textOf(html((await OverviewPage()) as never))).toContain("Reweigh fee, version 3");
    h.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(textOf(html((await OverviewPage()) as never))).toContain("The check for older correction fee rules could not be run.");
    h.rpc.mockRejectedValue(new Error("network"));
    expect(textOf(html((await OverviewPage()) as never))).toContain("The check for older correction fee rules could not be run.");
  });

  it("a failed load is reported as a failure, never as an empty account", async () => {
    h.loadOverview.mockRejectedValue(new Error("db down"));
    const t = textOf(html((await OverviewPage()) as never));
    expect(t).toContain("The overview could not be loaded");
    expect(t).not.toContain("Set up adjustments");
    expect(t).not.toContain("0 of 7");
  });
});

describe("policies", () => {
  const render = async (customer?: string) => html((await PoliciesPage({ searchParams: Promise.resolve(customer ? { customer } : {}) })) as never);

  it("loads the account's decisions and customers and shows the matrix for an administrator", async () => {
    const out = await render();
    expect(h.loadPolicies).toHaveBeenCalledWith(expect.anything(), TENANT_ID);
    expect(h.loadAdjustmentBrands).toHaveBeenCalledWith(expect.anything(), TENANT_ID);
    expect(textOf(out)).toContain("No decisions yet.");
    expect(out).toContain("Save decisions");
  });

  it("opens one customer's decisions from ?customer=, and ignores what is not a customer of this account", async () => {
    h.loadPolicies.mockResolvedValue([policy({ adjustmentType: "reweight", component: "separate_fee", handling: "absorbed", brandId: BRAND_A })]);
    expect(textOf(await render(BRAND_A))).toContain("Decisions for Alpha Apparel");
    expect(textOf(await render("dddddddd-dddd-4ddd-8ddd-dddddddddddd"))).not.toContain("Decisions for ");
    expect(textOf(await render("not-an-id"))).not.toContain("Decisions for ");
  });

  it("a failed load is a failure notice", async () => {
    h.loadPolicies.mockRejectedValue(new Error("db down"));
    const t = textOf(await render());
    expect(t).toContain("The decisions on who pays could not be loaded");
    expect(t).not.toContain("Save decisions");
  });
});

describe("history", () => {
  it("empty: the intro, the private notice, the upload and the empty state", async () => {
    const out = html((await HistoryPage()) as never);
    const t = textOf(out);
    expect(h.listImports).toHaveBeenCalledWith(expect.anything(), TENANT_ID);
    expect(t).toContain("Past adjustments");
    expect(t).toContain("Only your team can see this. Customers never do.");
    expect(t).toContain("Upload file");
    expect(t).toContain("No history yet");
    expect(out).toContain('href="/api/templates/adjustments.csv"');
    expect(t).toContain("✓ Imports How often Packages shipped");
  });

  it("with imports: one link each", async () => {
    h.listImports.mockResolvedValue([{ id: "i1", name: "august-history", status: "committed", rowCount: 40, committedCount: 40, skippedCount: 0, createdAt: "2026-10-01T10:00:00Z", committedAt: "2026-10-01T10:05:00Z", shipDateFrom: "2026-08-03", shipDateTo: "2026-09-11" }]);
    const out = html((await HistoryPage()) as never);
    expect(out).toContain('href="/app/adjustments/history/i1"');
    expect(textOf(out)).toContain("40 rows imported");
  });

  it("a failed load is a failure notice, never an empty list", async () => {
    h.listImports.mockRejectedValue(new Error("db down"));
    const t = textOf(html((await HistoryPage()) as never));
    expect(t).toContain("The imports could not be loaded");
    expect(t).not.toContain("No history yet");
  });
});

describe("one import", () => {
  const render = async (importId = IMPORT_ID) => html((await ImportPage({ params: Promise.resolve({ importId }) })) as never);

  it("a URL that is not an id, and an import that is not this account's, are not found", async () => {
    await expect(render("not-an-id")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.loadImportWizard).not.toHaveBeenCalled();
    h.loadImportWizard.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.loadImportWizard).toHaveBeenCalledWith(expect.anything(), TENANT_ID, IMPORT_ID);
  });

  it("an open import shows its name, a status badge, the private notice, the four steps and the wizard", async () => {
    h.loadImportWizard.mockResolvedValue(wizardView());
    const out = await render();
    const t = textOf(out);
    expect(t).toContain("august-history");
    expect(t).toContain("Map the columns");
    expect(t).toContain("Only your team can see this. Customers never do.");
    expect(t).toContain("How we read your file");
    expect(t).toContain("These charge columns hold what my customer was or would be charged. They do not hold what the carrier billed me.");
    expect(out).toContain('aria-label="Import steps"');
    expect(out).toContain('href="/app/adjustments/history"');
    expect(out).not.toMatch(/<h1/);
  });

  it("a validated import offers the import from its stored report", async () => {
    h.loadImportWizard.mockResolvedValue(wizardView({ status: "validated", acceptedCount: 40, validation: sample.report, attestedAt: "2026-10-02T00:00:00Z" }, sample.detection, sample.mapping));
    const t = textOf(await render());
    expect(t).toContain("What we found");
    expect(t).toContain("40 rows will be added to your history, shipped Aug 3, 2026 to Sep 11, 2026.");
    expect(t).toContain("Import rows");
  });

  it("an unreadable file says so and offers Discard", async () => {
    h.loadImportWizard.mockResolvedValue(wizardView({}, null));
    const t = textOf(await render());
    expect(t).toContain("This file cannot be read now");
    expect(t).toContain("Discard import");
  });

  it("a committed import shows what was added and Withdraw; ended imports show a notice", async () => {
    h.loadImportWizard.mockResolvedValue(wizardView({ status: "committed", committedCount: 40, committedAt: "2026-10-02T09:00:00Z", shipDateFrom: "2026-08-03", shipDateTo: "2026-09-11", fileId: null }, null));
    const committed = textOf(await render());
    expect(committed).toContain("40 rows added to your history on Oct 2, 2026.");
    expect(committed).toContain("Withdraw import");
    h.loadImportWizard.mockResolvedValue(wizardView({ status: "withdrawn", fileId: null }, null));
    expect(textOf(await render())).toContain("This import was withdrawn");
    h.loadImportWizard.mockResolvedValue(wizardView({ status: "discarded", fileId: null }, null));
    expect(textOf(await render())).toContain("This import was discarded");
  });

  it("a failed load is a failure notice, not a 404", async () => {
    h.loadImportWizard.mockRejectedValue(new Error("db down"));
    expect(textOf(await render())).toContain("The import could not be loaded");
  });
});

describe("statistics and packages shipped", () => {
  it("statistics without a committed import: the empty state with a link to upload, and no filters", async () => {
    h.listImports.mockResolvedValue([{ id: "i1", name: "x", status: "uploaded", rowCount: 1, committedCount: 0, skippedCount: 0, createdAt: "2026-10-01T10:00:00Z", committedAt: null, shipDateFrom: null, shipDateTo: null }]);
    const out = html((await StatisticsPage()) as never);
    expect(textOf(out)).toContain("No history yet");
    expect(textOf(out)).toContain("Import a file of past adjustments to see how often they happen and what they add.");
    expect(out).toContain('href="/app/adjustments/history"');
    expect(out).not.toContain("Show statistics");
  });

  it("statistics with a committed import: the filters", async () => {
    h.listImports.mockResolvedValue([{ id: "i1", name: "x", status: "committed", rowCount: 1, committedCount: 1, skippedCount: 0, createdAt: "2026-10-01T10:00:00Z", committedAt: "2026-10-01T10:00:00Z", shipDateFrom: null, shipDateTo: null }]);
    const out = html((await StatisticsPage()) as never);
    expect(textOf(out)).toContain("Show statistics");
    expect(textOf(out)).toContain("All customers together");
    expect(textOf(out)).toContain("Only your team can see this. Customers never do.");
  });

  it("a full page of imports without a committed one is not read as 'no history': the newest 200 may hide one further back", async () => {
    h.listImports.mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ id: `i${i}`, name: "x", status: "discarded", rowCount: 1, committedCount: 0, skippedCount: 0, createdAt: "2026-10-01T10:00:00Z", committedAt: null, shipDateFrom: null, shipDateTo: null })));
    expect(textOf(html((await StatisticsPage()) as never))).toContain("Show statistics");
  });

  it("statistics and packages shipped say a failed load failed", async () => {
    h.listImports.mockRejectedValue(new Error("down"));
    expect(textOf(html((await StatisticsPage()) as never))).toContain("The history could not be loaded");
    h.loadBaselines.mockRejectedValue(new Error("down"));
    const t = textOf(html((await BaselinesPage()) as never));
    expect(t).toContain("The packages-shipped figures could not be loaded");
    expect(t).not.toContain("No packages-shipped figures yet");
  });

  it("packages shipped: the figures and the form for an administrator, with the history navigation", async () => {
    h.loadBaselines.mockResolvedValue([{ id: "b1", brandId: null, carrierCode: null, serviceId: null, periodStart: "2026-08-01", periodEnd: "2026-08-31", packagesTotal: 12000, labelsMissingWeight: null, note: null, createdAt: "2026-10-01T00:00:00Z" }]);
    const out = html((await BaselinesPage()) as never);
    expect(textOf(out)).toContain("12,000 packages shipped");
    expect(textOf(out)).toContain("Save packages shipped");
    expect(out).toContain('aria-label="History sections"');
    expect(textOf(out)).toContain("Imports How often ✓ Packages shipped");
    expect(out).toContain('aria-current="page"');
  });
});
