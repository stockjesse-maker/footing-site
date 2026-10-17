import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelingView } from "@/lib/modeling/page-context";
import { fakeSupabase, type FakeOptions } from "../fixtures/forecast/fake-supabase";
import { EXAMPLE_ID, EXAMPLE_ID_2, EXAMPLE_ID_3, TENANT, caseOnlyPayload, chargedPayload, example, flattenHeadings, headings, hidden, html, mixedPayload, readableAttributes, textOf, withoutAllowedSentences } from "./adjustments-customer-support";

/**
 * The customer's page and hub card, with the server pieces mocked: who is signed in, the database function the page reads and nothing
 * else. The page needs `brand.view`, takes the brand from the session, reads ONLY `brand_adjustment_examples` and renders what that
 * returns; the hub card appears only for a customer and only while one example is current.
 */
const h = vi.hoisted(() => ({
  ctx: null as unknown,
  permissions: [] as (string | undefined)[],
  rpcCalls: [] as { name: string; args: unknown }[],
  fromCalls: [] as string[],
  result: { data: [], error: null } as { data: unknown; error: { message: string } | null },
  throws: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/modeling", () => ({
  advanceRun: vi.fn(),
  archiveScenario: vi.fn(),
  cancelRun: vi.fn(),
  createBulkScenario: vi.fn(),
  discardDataset: vi.fn(),
  materialiseDataset: vi.fn(),
  renameScenario: vi.fn(),
  rerunScenario: vi.fn(),
  saveOrderMapping: vi.fn(),
  saveSingleScenario: vi.fn(),
  shareDataset: vi.fn(),
  shareScenario: vi.fn(),
  uploadOrderFile: vi.fn(),
  uploadSkuProfiles: vi.fn(),
}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/pricing/catalog", () => ({ loadServiceCatalog: async () => [] }));
vi.mock("@/lib/auth/session", () => ({
  getUser: async () => ({ id: "u" }),
  getContext: async () => h.ctx,
  requireUser: async () => undefined,
  requireBrandContext: async (permission?: string) => {
    h.permissions.push(permission);
    if (!h.ctx) throw new Error("NEXT_REDIRECT");
    return h.ctx;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: unknown) => {
      h.rpcCalls.push({ name, args });
      if (h.throws) throw new Error("network down");
      return h.result;
    },
    from: (table: string) => {
      h.fromCalls.push(table);
      throw new Error(`the page must not select ${table}`);
    },
  }),
}));

const Page = (await import("@/app/(brand)/portal/model/adjustments/page")).default;
const pageModule = await import("@/app/(brand)/portal/model/adjustments/page");
const views = await import("@/components/modeling/views");
const { PossibleAdjustmentsView, orderExamples } = await import("@/components/adjustments/customer");
const { exampleFromPreview } = await import("@/components/adjustments/customer/from-preview");
const { hasCurrentAdjustmentExample, PossibleAdjustmentsHubCard } = await import("@/components/adjustments/customer/hub-card");
const { ExampleView } = await import("@/components/adjustments/customer");
const { findBannedTokens } = await import("@/lib/adjustments/customer-copy");

const BRAND = "77777777-7777-4777-8777-777777777777";
const OTHER = "88888888-8888-4888-8888-888888888888";
const brandSession = { active: { portal: "brand", brandId: BRAND, brandName: "Acme Goods", tenantId: "t", tenantName: TENANT } };

beforeEach(() => {
  h.ctx = brandSession;
  h.permissions = [];
  h.rpcCalls = [];
  h.fromCalls = [];
  h.result = { data: [], error: null };
  h.throws = false;
});

const renderPage = async () => html(await Page());

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------
describe("the page /portal/model/adjustments", () => {
  it("is titled 'Possible adjustments'", () => {
    expect(pageModule.metadata).toEqual({ title: "Possible adjustments" });
  });

  it("needs brand.view, takes the brand from the session, and calls ONE database function with the brand as its only argument", async () => {
    h.result = { data: [example()], error: null };
    await renderPage();
    expect(h.permissions).toEqual(["brand.view"]);
    expect(h.rpcCalls).toEqual([{ name: "brand_adjustment_examples", args: { p_brand: BRAND } }]);
    // Never a table: a customer has no grant on any adjustment table.
    expect(h.fromCalls).toEqual([]);
  });

  it("shows nothing and reads nothing for a viewer the guard refuses (a 3PL user, a signed-out visitor)", async () => {
    h.ctx = null;
    await expect(Page()).rejects.toThrow("NEXT_REDIRECT");
    expect(h.rpcCalls).toEqual([]);
  });

  it("renders the title, what the examples are, a way back, and each example, current ones first", async () => {
    h.result = { data: [hidden("expired"), hidden("under_review"), example({ id: EXAMPLE_ID })], error: null };
    const out = await renderPage();
    const t = textOf(out);
    expect(t).toContain("Possible adjustments");
    expect(t).toContain("Examples of charges Acme 3PL may add after a package ships if its weight or size turns out to be different from what was entered at the time.");
    expect(t).toContain("They show how a charge is worked out, not what will happen to your orders, and they are not invoices.");
    expect(out).toContain('href="/portal/model"');
    expect(t).toContain("← Model Costs");
    // Order: the example with amounts, then the one under review, then the expired one.
    expect(t.indexOf("If a 5 lb package is corrected to 20 lb")).toBeLessThan(t.indexOf("is updating this example"));
    expect(t.indexOf("is updating this example")).toBeLessThan(t.indexOf("is no longer current"));
  });

  it("the empty list is an invitation to ask, never 'no adjustments exist'", async () => {
    h.result = { data: [], error: null };
    const out = await renderPage();
    const t = textOf(out);
    expect(t).toContain("No examples shared yet");
    expect(t).toContain("Acme 3PL has not shared any adjustment examples yet. That does not mean no adjustment can ever be charged. Ask Acme 3PL how corrected weights and sizes are handled for your account.");
    expect(t).not.toMatch(/no adjustments? (?:exist|apply|can be charged)/i);
    expect(out).not.toMatch(/<article\b/);
  });

  it("a customer of someone else's brand gets the same empty page (the function returns an empty list, the page does not 404 or leak)", async () => {
    h.result = { data: [], error: null };
    expect(textOf(await renderPage())).toContain("No examples shared yet");
  });

  it("says it could not load, and what to do, when the function fails, throws an unexpected shape, or breaks its promise (never an empty list)", async () => {
    for (const result of [
      { data: null, error: { message: "boom" } },
      { data: "nope", error: null },
      { data: [example({ state: "current", payload: null })], error: null },
      { data: [example({ payload: { ...chargedPayload(), components: [{ kind: "separate_fee", handling: "absorbed", amount: "2.00" }] } as never })], error: null },
    ]) {
      h.result = result;
      const out = await renderPage();
      const t = textOf(out);
      expect(t).toContain("We could not load your adjustment examples. Reload the page to try again. If it keeps happening, contact Acme 3PL.");
      expect(t).not.toContain("No examples shared yet");
      expect(out).toContain('role="alert"');
      expect(out).not.toMatch(/<article\b/);
    }
  });

  it("drops anything the database sends beyond the projection before it reaches the page (a sentinel never renders)", async () => {
    const leaky = { ...example({ payload: mixedPayload() }), incidence: "7.3719", internalNote: "SENTINEL_PRIVATE", pins: { ruleVersionIds: ["SENTINEL_RULE_VERSION"] }, sourceScenarioId: "SENTINEL_SOURCE" };
    h.result = { data: [{ ...leaky, payload: { ...mixedPayload(), notBilledToCustomer: "42.6143", absorbed: "91317.29" } }], error: null };
    const out = await renderPage();
    for (const s of ["7.3719", "SENTINEL", "42.6143", "91317"]) expect(out, s).not.toContain(s);
    expect(textOf(out)).toContain("Separate adjustment fee $2.00 if charged");
  });

  it("keeps the outline: one h1, each example an h2, its groups h3, in every state; the empty and failed states add no skipped level", async () => {
    const cases: unknown[][] = [
      [example({ payload: mixedPayload() }), example({ id: EXAMPLE_ID_2, payload: chargedPayload() }), hidden("under_review"), hidden("expired")],
      [example()],
      [hidden("under_review")],
      [],
    ];
    for (const data of cases) {
      h.result = { data, error: null };
      const hs = headings(await renderPage());
      expect(hs.filter((x) => x.level === 1)).toEqual([{ level: 1, text: "Possible adjustments" }]);
      expect(hs[0]!.level).toBe(1);
      for (let i = 1; i < hs.length; i++) expect(hs[i]!.level - hs[i - 1]!.level, `${hs[i - 1]!.text} -> ${hs[i]!.text}`).toBeLessThanOrEqual(1);
      expect(hs.filter((x) => x.level === 2)).toHaveLength(Math.max(1, data.length));
    }
    h.result = { data: null, error: { message: "boom" } };
    expect(headings(await renderPage()).map((x) => x.level)).toEqual([1]);
  });

  it("shows up to 25 examples (the most the database sends), each with its own heading id, and never an example's id", async () => {
    h.result = { data: Array.from({ length: 25 }, (_, i) => example({ id: `e0e0e0e0-e0e0-4e0e-8e0e-${String(i).padStart(12, "0")}` })), error: null };
    const out = await renderPage();
    expect((out.match(/<article\b/g) ?? []).length).toBe(25);
    const ids = [...out.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out).toContain('id="example-24-title"');
    expect(out).not.toMatch(/e0e0e0e0-e0e0-4e0e/);
  });

  it("holds no banned word, in text or attributes or class names, in any state, and never says 'scenario'", async () => {
    const cases: unknown[][] = [[example(), example({ payload: mixedPayload(), note: "Ground only." }), example({ payload: caseOnlyPayload() }), hidden("under_review"), hidden("expired")], []];
    for (const data of cases) {
      h.result = { data, error: null };
      const out = await renderPage();
      expect(findBannedTokens(out)).toEqual([]);
      for (const a of readableAttributes(out)) expect(findBannedTokens(a), a).toEqual([]);
      expect(out).not.toMatch(/scenario/i);
    }
    h.result = { data: null, error: { message: "boom" } };
    expect(findBannedTokens(await renderPage())).toEqual([]);
  });

  it("holds no table, no horizontal scroll container and no fixed width, so it reads at 360 px", async () => {
    h.result = { data: [example({ payload: mixedPayload() }), hidden("under_review")], error: null };
    const out = await renderPage();
    expect(out).not.toMatch(/<table|<thead|<tr[\s>]|overflow-x-|whitespace-nowrap/);
    expect(out).toContain("[overflow-wrap:anywhere]");
  });

  it("orders examples without disturbing the database's order inside each state", () => {
    const a = example({ title: "a" });
    const b = example({ title: "b" });
    const u1 = hidden("under_review", { title: "u1" });
    const u2 = hidden("under_review", { title: "u2" });
    const x = hidden("expired", { title: "x" });
    expect(orderExamples([x, u1, a, u2, b]).map((e) => e.title)).toEqual(["a", "b", "u1", "u2", "x"]);
    expect(orderExamples([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The hub card
// ---------------------------------------------------------------------------
const TABLES: NonNullable<FakeOptions["tables"]> = { order_datasets: [], simulation_projects: [], brand_rate_card_assignments: [], brand_fee_schedule_assignments: [], memberships: [] };

function hubView(staff: boolean, rpc: FakeOptions["rpc"] = {}) {
  const base = fakeSupabase({ tables: TABLES, rpc: { dataset_forecast_period: { data: null, error: { message: "not stubbed" } }, ...rpc } });
  const calls: string[] = [];
  const supabase = { from: (t: string) => (base as unknown as { from: (t: string) => unknown }).from(t), rpc: async (name: string, args: Record<string, unknown>) => (calls.push(name), (base as unknown as { rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> }).rpc(name, args)) };
  const v: ModelingView = {
    supabase: supabase as never,
    tenantId: "t",
    tenantName: TENANT,
    brandId: BRAND,
    brandName: "Acme Goods",
    staff,
    basePath: staff ? `/app/customers/${BRAND}/model` : "/portal/model",
    reportsPath: staff ? `/app/customers/${BRAND}/model/reports` : "/portal/reports",
    tenantDefaultOriginZip: "10001",
  };
  return { v, calls };
}
const examplesRpc = (data: unknown, error: { message: string } | null = null): FakeOptions["rpc"] => ({ brand_adjustment_examples: { data, error } });

describe("the hub card 'Possible adjustments'", () => {
  it("appears for a customer with at least one current example, links to the page and carries no figure", async () => {
    const { v, calls } = hubView(false, examplesRpc([hidden("under_review"), example(), hidden("expired")]));
    const node = await views.ModelHubView(v);
    const out = html(node);
    const t = textOf(out);
    expect(calls).toContain("brand_adjustment_examples");
    expect(t).toContain("Possible adjustments");
    expect(t).toContain("Examples of charges Acme 3PL may add after a package ships if its weight or size is corrected. They are not part of your cost models.");
    expect(t).toContain("See examples of adjustments →");
    expect(out).toContain('href="/portal/model/adjustments"');
    // The card tells nothing about the examples: no count, no amount.
    const card = textOf(html(createElement(PossibleAdjustmentsHubCard, { tenantName: TENANT })));
    expect(card.replace(TENANT, "")).not.toMatch(/\d/);
    expect(card).not.toContain("$");
    expect(findBannedTokens(card)).toEqual([]);
  });

  it("is absent when the customer has none, only hidden ones, or the read fails or throws, and the hub still renders", async () => {
    for (const rpc of [examplesRpc([]), examplesRpc([hidden("under_review"), hidden("expired")]), examplesRpc(null, { message: "boom" }), examplesRpc("nope"), {}]) {
      const { v } = hubView(false, rpc);
      const out = html(await views.ModelHubView(v));
      expect(out).not.toContain("/portal/model/adjustments");
      expect(textOf(out)).not.toContain("Possible adjustments");
      expect(textOf(out)).toContain("Price one shipment");
      expect(textOf(out)).toContain("Your fee schedule");
    }
    const failing = hubView(false);
    (failing.v.supabase as unknown as { rpc: () => never }).rpc = () => {
      throw new Error("network down");
    };
    expect(html(await views.ModelHubView(failing.v))).not.toContain("/portal/model/adjustments");
  });

  it("is never shown on the 3PL's on-behalf hub, and the database function is not even called there", async () => {
    const { v, calls } = hubView(true, examplesRpc([example()]));
    const out = html(await views.ModelHubView(v));
    expect(calls).not.toContain("brand_adjustment_examples");
    expect(calls).toEqual([]);
    expect(textOf(out)).not.toContain("Possible adjustments");
    expect(out).not.toContain("adjustments");
  });

  it("reads through the one customer function and only asks whether a current example exists", async () => {
    const { v, calls } = hubView(false, examplesRpc([example()]));
    expect(await hasCurrentAdjustmentExample(v.supabase, BRAND)).toBe(true);
    expect(calls).toEqual(["brand_adjustment_examples"]);
    expect(await hasCurrentAdjustmentExample(hubView(false, examplesRpc([hidden("under_review")])).v.supabase, BRAND)).toBe(false);
    expect(await hasCurrentAdjustmentExample(hubView(false, examplesRpc([])).v.supabase, OTHER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The preview feeds the same view
// ---------------------------------------------------------------------------
describe("the 3PL's preview through the customer projection", () => {
  const preview = (over: Record<string, unknown> = {}) => ({ payload: mixedPayload(), pricedOn: "2026-10-16", ratesEffectiveFrom: "2026-01-01", validThrough: "2026-12-31", ...over });

  it("turns the preview function's result into the props ExampleView takes, and renders what the customer would read", () => {
    const e = exampleFromPreview({ title: "  Standard box  ", note: "  Ground only.  ", preview: preview(), sharedOn: "2026-10-20" })!;
    expect(e).toEqual({ title: "Standard box", note: "Ground only.", payload: mixedPayload(), pricedOn: "2026-10-16", ratesEffectiveFrom: "2026-01-01", validThrough: "2026-12-31", publishedAt: "2026-10-20", state: "current" });
    const t = textOf(html(createElement(ExampleView, { example: e, tenantName: TENANT, mode: "staffPreview" })));
    expect(t).toContain("Standard box");
    expect(t).toContain("Note from Acme 3PL Ground only.");
    expect(t).toContain("Shared by Acme 3PL on Oct 20, 2026");
    expect(t).toContain("Separate adjustment fee $2.00 if charged");
  });

  it("renders the same markup as the customer's page would for the example once shared (heading level aside)", () => {
    const e = exampleFromPreview({ title: "Standard box", note: null, preview: preview(), sharedOn: "2026-10-20" })!;
    const asPreview = html(createElement(ExampleView, { example: e, tenantName: TENANT, mode: "staffPreview" }));
    const asCustomer = html(createElement(ExampleView, { example: { ...e, publishedAt: "2026-10-20T08:00:00.000000+00:00" }, tenantName: TENANT }));
    expect(flattenHeadings(asPreview)).toBe(flattenHeadings(asCustomer));
  });

  it("uses the neutral title for an empty one, and no note for a blank one", () => {
    const e = exampleFromPreview({ title: "   ", note: "   ", preview: preview(), sharedOn: "2026-10-20" })!;
    expect(e.title).toBe("Example");
    expect(e.note).toBeNull();
  });

  it("strips every key the customer projection does not carry, so a preview can never show more than a customer would see", () => {
    const e = exampleFromPreview({ title: "t", note: null, preview: preview({ payload: { ...mixedPayload(), absorbed: "91317.29", notBilledToCustomer: "42.6143", pins: { x: 1 } } }), sharedOn: "2026-10-20" })!;
    expect(JSON.stringify(e)).not.toMatch(/91317|42\.6143|pins|absorbed/);
    expect(Object.keys(e.payload!).sort()).toEqual(["adjustmentType", "components", "input", "pricedOn", "v"]);
  });

  it("refuses a preview a customer could not be shown: an absorbed charge, no payload, a bad date, a title over the limit", () => {
    const absorbed = { ...chargedPayload(), components: [{ kind: "separate_fee", handling: "absorbed", amount: "2.00" }] };
    expect(exampleFromPreview({ title: "t", note: null, preview: preview({ payload: absorbed }), sharedOn: "2026-10-20" })).toBeNull();
    expect(exampleFromPreview({ title: "t", note: null, preview: preview({ payload: undefined }), sharedOn: "2026-10-20" })).toBeNull();
    expect(exampleFromPreview({ title: "t", note: null, preview: preview({ pricedOn: undefined }), sharedOn: "2026-10-20" })).toBeNull();
    expect(exampleFromPreview({ title: "t", note: null, preview: preview({ validThrough: "later" }), sharedOn: "2026-10-20" })).toBeNull();
    expect(exampleFromPreview({ title: "x".repeat(121), note: null, preview: preview(), sharedOn: "2026-10-20" })).toBeNull();
    expect(exampleFromPreview({ title: "t", note: "n".repeat(301), preview: preview(), sharedOn: "2026-10-20" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What the source says
// ---------------------------------------------------------------------------
const root = path.resolve(__dirname, "../..");
const customerDir = path.join(root, "src/components/adjustments/customer");
const files = [
  ...readdirSync(customerDir).map((f) => path.join(customerDir, f)),
  path.join(root, "src/app/(brand)/portal/model/adjustments/page.tsx"),
  path.join(root, "src/lib/adjustments/customer-copy.ts"),
];
const source = (f: string) => readFileSync(f, "utf8");
const code = (f: string) => source(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the customer side, read as source", () => {
  it("never selects a table: no query builder, no embedded select, in any customer file", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      expect(code(f), path.basename(f)).not.toMatch(/\.from\(|\.select\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(|createClient|createAdminClient/);
    }
  });

  it("reads customer data through the customer read model only (queries.ts: loadSessionBrandExamples, loadBrandExamples, projectBrandExamples)", () => {
    const rpcUsers = files.filter((f) => /\.rpc\(/.test(code(f)));
    expect(rpcUsers).toEqual([]);
    const page = code(path.join(root, "src/app/(brand)/portal/model/adjustments/page.tsx"));
    expect(page).toContain("loadSessionBrandExamples");
    const imports = [...page.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)].map((m) => `${m[2]}: ${m[1]!.trim()}`);
    expect(imports).toContain("@/lib/adjustments/queries: loadSessionBrandExamples");
  });

  it("keeps the copy file free of imports and 'use server', so a client or server component can read it", () => {
    expect(code(path.join(root, "src/lib/adjustments/customer-copy.ts"))).not.toMatch(/^\s*import\s/m);
    for (const f of files) expect(source(f), path.basename(f)).not.toMatch(/^\s*["']use (?:server|client)["']/m);
  });

  it("keys lists by position, never by an id or a rule key", () => {
    for (const f of files) {
      for (const m of code(f).matchAll(/\bkey=\{(`[^`]*`)\}/g)) {
        expect(m[1], `${path.basename(f)}: key=${m[1]}`).not.toMatch(/\.id\b|\.ruleKey|\.key\b|\.serviceId|\.brandId|\.title\b/);
        expect(m[1], path.basename(f)).toMatch(/^`[a-z]+-\$\{i\}`$/);
      }
      // Every key is a position template: no other form of key exists.
      expect([...code(f).matchAll(/\bkey=/g)].length, path.basename(f)).toBe([...code(f).matchAll(/\bkey=\{`[a-z]+-\$\{i\}`\}/g)].length);
    }
  });

  it("uses no carrier cost, rate or margin identifier anywhere (a customer's page never touches one)", () => {
    // The copy file is the one place that NAMES the banned words (its list of them); every other file must not contain them.
    for (const f of files.filter((x) => !x.endsWith("customer-copy.ts"))) expect(code(f), path.basename(f)).not.toMatch(/buyRate|buy_rate|carrierCost|carrier_cost|netRate|negotiated|margin|incidence|exposure|notBilled|absorbed|policySnapshot|internalNote|internal_note/);
  });

  it("the three example ids used in these tests are distinct (so an id that leaks would be noticed)", () => {
    expect(new Set([EXAMPLE_ID, EXAMPLE_ID_2, EXAMPLE_ID_3]).size).toBe(3);
  });

  it("renders the page body in every state without a server (PossibleAdjustmentsView is pure)", () => {
    const out = [
      html(createElement(PossibleAdjustmentsView, { result: { status: "ok", examples: [] }, tenantName: TENANT })),
      html(createElement(PossibleAdjustmentsView, { result: { status: "load_failed" }, tenantName: null })),
      html(createElement(PossibleAdjustmentsView, { result: { status: "ok", examples: [example()] }, tenantName: undefined })),
    ];
    expect(textOf(out[1]!)).toContain("contact your 3PL.");
    expect(textOf(out[2]!)).toContain("Your 3PL charges this fee to you when a correction is made.");
    for (const o of out) expect(withoutAllowedSentences(textOf(o))).not.toMatch(/undefined|null|\[object/);
  });
});
