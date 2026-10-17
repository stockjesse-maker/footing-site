import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOMER_PRICING_ISSUE } from "@/lib/adjustments/copy";
import { fixtureContext } from "../fixtures/pricing/load";

/**
 * Review finding F10 (Milestone 5, step 0). The calculator returns the pricing loader's `issues` with every quote, and the form renders them.
 * The loader's text names the 3PL's rule ('The surcharge rule "<name>" has an invalid condition or base and was not applied.'), and a rule's name
 * is the 3PL's own text that a customer's session must not receive (decision D6(b) took the same text out of every stored run). A customer gets
 * ONE fixed sentence; staff keep the text. The same must hold for the rendered form, whatever the server sent.
 */
const h = vi.hoisted(() => ({
  ctx: null as unknown,
  loaded: null as unknown,
  limitOk: true,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => undefined, getContext: async () => h.ctx }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: null, error: null }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  }),
}));
vi.mock("@/lib/rate-limit", () => ({ RATE_LIMITED_MESSAGE: "slow down", withinRateLimit: async () => h.limitOk }));
vi.mock("@/lib/pricing/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pricing/snapshot")>()),
  loadPricingContext: async () => h.loaded,
}));

const { priceShipment } = await import("@/app/actions/calculator");
const { CalculatorIssues } = await import("@/components/pricing/calculator-form");

const TENANT = "22222222-2222-4222-8222-222222222222";
const BRAND = "77777777-7777-4777-8777-777777777777";
const CARD = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const RULE_NAME = "Acme secret peak fee";
const ENGINE_TEXT = `The surcharge rule "${RULE_NAME}" has an invalid condition or base and was not applied.`;

const session = (role: string, portal: "tenant" | "brand") => ({
  user: { id: "u" },
  profile: { id: "u", email: "x@example.test", fullName: null },
  memberships: [],
  active: { id: "m", tenantId: TENANT, tenantName: "Fixture 3PL", brandId: portal === "brand" ? BRAND : null, brandName: null, role, portal },
});

function loaded(issues: string[]) {
  const context = fixtureContext();
  return {
    ok: true as const,
    snapshot: {
      context,
      version: { id: "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2", versionNumber: 3, effectiveDate: "2026-01-01", expirationDate: null, status: "active" },
      services: context.rateCard.services.map((s) => ({ serviceId: s.serviceId, carrierCode: s.carrierCode, serviceCode: s.serviceCode, serviceName: s.serviceName })),
      tenantId: TENANT,
      issues,
      issueVersionIds: issues.map((_, i) => `0000000${i}-0000-4000-8000-000000000000`),
      pins: { rateCardVersionId: "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2", ruleVersionIds: [], zipListIds: [], overrideIds: [] },
    },
  };
}

const request = {
  rateCardId: CARD,
  shipDate: "2026-10-15",
  originZip: "90001",
  destinationZip: "85001",
  residential: true,
  service: "ups/ground",
  packages: [{ weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" }],
};

beforeEach(() => {
  h.ctx = session("brand_admin", "brand");
  h.loaded = loaded([ENGINE_TEXT]);
  h.limitOk = true;
});

describe("priceShipment: the pricing issues a customer may read", () => {
  it("gives a customer one fixed sentence and no rule name anywhere in the response", async () => {
    const response = await priceShipment(request);
    expect(response.ok).toBe(true);
    expect(response.issues).toEqual([CUSTOMER_PRICING_ISSUE]);
    expect(JSON.stringify(response)).not.toContain(RULE_NAME);
    expect(JSON.stringify(response)).not.toContain("invalid condition");
  });

  it("gives a customer no issues when there are none (the sentence is not a standing warning)", async () => {
    h.loaded = loaded([]);
    expect((await priceShipment(request)).issues).toEqual([]);
  });

  it("collapses several issues to the one sentence, never a count of the 3PL's rules", async () => {
    h.loaded = loaded([ENGINE_TEXT, 'The surcharge rule "Another rule" has an invalid condition or base and was not applied.']);
    const response = await priceShipment(request);
    expect(response.issues).toEqual([CUSTOMER_PRICING_ISSUE]);
    expect(JSON.stringify(response)).not.toContain("Another rule");
  });

  it("keeps the text for the 3PL's own staff, who write the rules and must fix them", async () => {
    h.ctx = session("tenant_admin", "tenant");
    const response = await priceShipment(request);
    expect(response.ok).toBe(true);
    expect(response.issues).toEqual([ENGINE_TEXT]);
  });
});

describe("the calculator form renders the sentence, not the engine's text", () => {
  const html = (audience: "brand" | "staff", issues: string[]) => renderToStaticMarkup(createElement(CalculatorIssues, { audience, issues }));

  it("renders the fixed sentence for a customer even if the server sent the engine's text", () => {
    const out = html("brand", [ENGINE_TEXT]);
    expect(out).toContain(CUSTOMER_PRICING_ISSUE);
    expect(out).not.toContain(RULE_NAME);
    expect(out).toContain("ask your 3PL before relying on it");
  });

  it("renders the engine's text for staff", () => {
    const out = html("staff", [ENGINE_TEXT]);
    expect(out).toContain(RULE_NAME.replace(/"/g, "&quot;"));
    expect(out).toContain("fix the rules before relying on it");
  });

  it("renders nothing when there are no issues", () => {
    expect(html("brand", [])).toBe("");
    expect(html("staff", [])).toBe("");
  });
});
