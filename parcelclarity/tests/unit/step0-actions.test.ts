import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADJUSTMENT_FEE_CATEGORIES, ADJUSTMENT_FEE_CLASS_MESSAGE, isAdjustmentFeeCategory } from "@/engine/types";

/**
 * Milestone 5, step 0, application side. The database now keeps three things away from customers that earlier milestones
 * stored where a customer's own session could read them: a rate card term's source note, the note about the agreement behind a
 * customer exception, and (separately tested with the run screens) load-issue text and run error text. These tests drive the
 * server actions and the pricing loader with a recording database client and pin:
 *   - an exception is inserted WITHOUT its note, then the note goes to the staff-only table (and an exception whose note could
 *     not be saved is ended again, never left in force);
 *   - a new draft version copies each term's source note to the new term ids (staff-only table);
 *   - brand-reachable loading (terms and pricing rules) never selects the staff-only tables or the dropped columns;
 *   - a reweigh, remeasure or shipping charge correction rule can only be a conditional charge (form action and database trigger).
 */
interface Call {
  table: string;
  op: "select" | "insert" | "update";
  cols?: string;
  payload?: unknown;
  filters: Array<[string, unknown]>;
  single: boolean;
  returning: boolean;
}
type Result = { data?: unknown; error?: { code?: string; message: string } | null };

const h = vi.hoisted(() => ({
  calls: [] as unknown[],
  rpcs: [] as { name: string; args: unknown }[],
  handle: ((_call: unknown): unknown => undefined) as (call: unknown) => unknown,
  rpc: ((_name: string, _args: unknown): unknown => ({ data: [], error: null })) as (name: string, args: unknown) => unknown,
  limitOk: true,
}));
const calls = () => h.calls as Call[];
const handle = (fn: (call: Call) => Result | undefined) => {
  h.handle = fn as (call: unknown) => unknown;
};

function fakeClient() {
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [], single: false, returning: false };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (value: unknown) => void) => {
              h.calls.push(call);
              const given = h.handle(call) as Result | undefined;
              const dflt: Result = call.op === "select" ? { data: call.single ? null : [], error: null } : { data: call.returning ? (call.single ? { id: "new-id" } : []) : null, error: null };
              const r = { ...dflt, ...(given ?? {}) };
              const data = call.single && Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
              resolve({ data: r.error ? null : data, error: r.error ?? null });
            };
          }
          if (prop === "select") {
            return (cols?: string) => {
              if (call.op === "select") call.cols = cols;
              else call.returning = true;
              return proxy;
            };
          }
          if (prop === "insert" || prop === "update") {
            return (payload: unknown) => {
              call.op = prop as "insert" | "update";
              call.payload = payload;
              return proxy;
            };
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => {
              call.single = true;
              return proxy;
            };
          }
          return (...args: unknown[]) => {
            call.filters.push([String(prop), args[0]]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return {
    from,
    rpc: async (name: string, args: unknown) => {
      h.rpcs.push({ name, args });
      return h.rpc(name, args);
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ requireTenantContext: async () => ({ active: { tenantId: "22222222-2222-4222-8222-222222222222", role: "tenant_admin" } }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/rate-limit", () => ({ RATE_LIMITED_MESSAGE: "limited", withinRateLimit: async () => h.limitOk }));
vi.mock("@/lib/pricing/catalog", () => ({
  loadServiceCatalog: async () => [
    { id: "s1", carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" },
    { id: "s2", carrierCode: "usps", carrierName: "USPS", code: "ga", name: "USPS Ground Advantage" },
  ],
}));
vi.mock("@/lib/import/parse-table", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/import/parse-table")>()), parseTables: () => [], detectFileKind: () => "csv" }));
vi.mock("@/lib/import/rate-card-validate", () => ({
  applyMapping: () => ({
    rows: [
      { serviceId: "s1", originPrefix: null, zone: "1", weightMin: "0", weightMax: "1", weightUnit: "lb", price: "5.0000", minCharge: null },
      { serviceId: "s2", originPrefix: null, zone: "1", weightMin: "0", weightMax: "1", weightUnit: "lb", price: "4.0000", minCharge: null },
    ],
    terms: {},
    report: { ok: true, rowCount: 2, warningCount: 0, services: [{ serviceId: "s1" }, { serviceId: "s2" }] },
  }),
}));

const surcharges = await import("@/app/actions/surcharges");
const rateCards = await import("@/app/actions/rate-cards");
const snapshotLib = await import("@/lib/pricing/snapshot");

const TENANT = "22222222-2222-4222-8222-222222222222";
const BRAND = "77777777-7777-4777-8777-777777777777";
const RULE = "99999999-9999-4999-8999-999999999999";
const OVERRIDE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMPORT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CARD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FILE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOTE = "Pricing addendum, 1 Sep 2026 (private)";

beforeEach(() => {
  h.calls = [];
  h.rpcs = [];
  h.limitOk = true;
  h.handle = () => undefined;
  h.rpc = () => ({ data: [], error: null });
});

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};
const at = (table: string, op: Call["op"]) => calls().filter((c) => c.table === table && c.op === op);

// ---------------------------------------------------------------------------
// Customer exceptions: the note is a separate, staff-only row
// ---------------------------------------------------------------------------
describe("createOverride", () => {
  const overrideForm = () => form({ brandId: BRAND, ruleId: RULE, mode: "exclude", amount: "", percent: "", effectiveDate: "2026-10-01", expirationDate: "", reference: NOTE });
  const ruleRow = { id: RULE, brand_id: null, surcharge_rule_versions: [{ method: "flat", status: "published", version_number: 1 }] };

  it("inserts the exception without the note, then the note against the new id, in that order", async () => {
    handle((c) => (c.table === "surcharge_rules" ? { data: ruleRow } : c.table === "customer_surcharge_overrides" && c.op === "insert" ? { data: { id: OVERRIDE } } : undefined));
    const result = await surcharges.createOverride({ ok: false }, overrideForm());
    expect(result).toEqual({ ok: true, message: "Exception saved." });
    const [override] = at("customer_surcharge_overrides", "insert");
    expect(override!.payload).toEqual({ tenant_id: TENANT, brand_id: BRAND, rule_id: RULE, mode: "exclude", amount: null, percent: null, effective_date: "2026-10-01", expiration_date: null });
    expect(Object.keys(override!.payload as object)).not.toContain("reference");
    expect(JSON.stringify(override!.payload)).not.toContain("addendum");
    const [note] = at("customer_surcharge_override_notes", "insert");
    expect(note!.payload).toEqual({ override_id: OVERRIDE, tenant_id: TENANT, reference: NOTE });
    expect(calls().indexOf(override!)).toBeLessThan(calls().indexOf(note!));
  });

  it("ends the exception again when its note cannot be saved, instead of leaving it in force without its reference", async () => {
    handle((c) => {
      if (c.table === "surcharge_rules") return { data: ruleRow };
      if (c.table === "customer_surcharge_overrides" && c.op === "insert") return { data: { id: OVERRIDE } };
      if (c.table === "customer_surcharge_override_notes") return { error: { code: "42501", message: "row-level security" } };
      return undefined;
    });
    const result = await surcharges.createOverride({ ok: false }, overrideForm());
    expect(result).toEqual({ ok: false, message: "Something went wrong. Please try again." });
    const [ended] = at("customer_surcharge_overrides", "update");
    expect(ended!.payload).toEqual({ ended_at: expect.any(String) });
    expect(ended!.filters).toContainEqual(["eq", "id"]);
    expect(ended!.filters).toContainEqual(["eq", "tenant_id"]);
  });

  it("writes no note when the exception itself is refused, and says why in words", async () => {
    handle((c) => (c.table === "surcharge_rules" ? { data: ruleRow } : c.table === "customer_surcharge_overrides" ? { error: { code: "23P01", message: "conflicting key value violates exclusion constraint" } } : undefined));
    const result = await surcharges.createOverride({ ok: false }, overrideForm());
    expect(result).toMatchObject({ ok: false, errors: { effectiveDate: expect.stringContaining("Another exception") } });
    expect(at("customer_surcharge_override_notes", "insert")).toHaveLength(0);
  });

  it("still requires the reference: it is the 3PL's own record of the agreement", async () => {
    const result = await surcharges.createOverride({ ok: false }, form({ brandId: BRAND, ruleId: RULE, mode: "exclude", amount: "", percent: "", effectiveDate: "2026-10-01", expirationDate: "", reference: "  " }));
    expect(result).toMatchObject({ ok: false, errors: { reference: expect.any(String) } });
    expect(calls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reweigh, remeasure and correction fees are conditional charges
// ---------------------------------------------------------------------------
describe("charge class of reweigh, remeasure and shipping charge correction rules", () => {
  const ruleFields = (over: Record<string, string> = {}) => ({
    name: "Carrier reweigh fee",
    carrierCode: "ups",
    category: "reweight",
    chargeClass: "conditional",
    method: "flat",
    amount: "3.00",
    percent: "",
    effectiveDate: "2026-10-01",
    expirationDate: "",
    sourceReference: "Customer agreement, section 4",
    sourceUrl: "",
    ...over,
  });

  it("names the three categories once, for the form, the action and the database trigger", () => {
    expect([...ADJUSTMENT_FEE_CATEGORIES]).toEqual(["reweight", "remeasure", "shipping_charge_correction"]);
    for (const c of ADJUSTMENT_FEE_CATEGORIES) expect(isAdjustmentFeeCategory(c)).toBe(true);
    for (const c of ["fuel", "residential", "address_correction", "other", ""]) expect(isAdjustmentFeeCategory(c)).toBe(false);
  });

  it.each(ADJUSTMENT_FEE_CATEGORIES)("refuses a %s rule that is a definite or estimated charge, with a message on the charge class field and nothing written", async (category) => {
    for (const chargeClass of ["definite", "estimated"]) {
      h.calls = [];
      const result = await surcharges.createSurchargeRule({ ok: false }, form(ruleFields({ category, chargeClass })));
      expect(result).toEqual({ ok: false, errors: { chargeClass: ADJUSTMENT_FEE_CLASS_MESSAGE } });
      expect(calls()).toHaveLength(0);
    }
    expect(ADJUSTMENT_FEE_CLASS_MESSAGE).toMatch(/conditional adjustment/);
    expect(ADJUSTMENT_FEE_CLASS_MESSAGE).toMatch(/never counted in a total/);
  });

  it.each(ADJUSTMENT_FEE_CATEGORIES)("accepts a %s rule as a conditional charge", async (category) => {
    handle((c) => (c.table === "surcharge_rules" ? { data: { id: RULE } } : c.table === "surcharge_rule_versions" ? { data: { id: "v1" } } : undefined));
    await expect(surcharges.createSurchargeRule({ ok: false }, form(ruleFields({ category, chargeClass: "conditional" })))).rejects.toThrow(`NEXT_REDIRECT:/app/surcharges/${RULE}`);
    const [version] = at("surcharge_rule_versions", "insert");
    expect(version!.payload).toMatchObject({ charge_class: "conditional" });
  });

  it("leaves every other category free to be definite", async () => {
    handle((c) => (c.table === "surcharge_rules" ? { data: { id: RULE } } : c.table === "surcharge_rule_versions" ? { data: { id: "v1" } } : undefined));
    await expect(surcharges.createSurchargeRule({ ok: false }, form(ruleFields({ category: "residential", chargeClass: "definite" })))).rejects.toThrow("NEXT_REDIRECT");
    expect(at("surcharge_rule_versions", "insert")[0]!.payload).toMatchObject({ charge_class: "definite" });
  });

  it("maps the database trigger's refusal (23514) to the same message instead of a generic failure", async () => {
    handle((c) => (c.table === "surcharge_rules" ? { data: { id: RULE } } : c.table === "surcharge_rule_versions" ? { error: { code: "23514", message: "a reweigh, remeasure or correction fee is a conditional charge" } } : undefined));
    expect(await surcharges.createSurchargeRule({ ok: false }, form(ruleFields()))).toEqual({ ok: false, errors: { chargeClass: ADJUSTMENT_FEE_CLASS_MESSAGE } });
  });

  describe("a new version of an existing rule", () => {
    const versionForm = (over: Record<string, string> = {}) => form({ ...ruleFields(over), ruleId: RULE });
    const stored = (category: string) => (c: Call): Result | undefined => (c.table === "surcharge_rules" && c.op === "select" ? { data: { id: RULE, tenant_id: TENANT, scope: "tenant", carrier_code: "ups", category } } : c.table === "surcharge_rule_versions" && c.op === "select" ? { data: null } : undefined);

    it("is checked against the category the rule was created with, whatever the form posts", async () => {
      handle(stored("reweight"));
      const result = await surcharges.addSurchargeRuleVersion({ ok: false }, versionForm({ category: "residential", chargeClass: "definite" }));
      expect(result).toEqual({ ok: false, errors: { chargeClass: ADJUSTMENT_FEE_CLASS_MESSAGE } });
      expect(at("surcharge_rule_versions", "insert")).toHaveLength(0);
    });

    it("lets a rule that is not an adjustment fee stay definite even if the form claims a reweigh category", async () => {
      handle(stored("residential"));
      const result = await surcharges.addSurchargeRuleVersion({ ok: false }, versionForm({ category: "reweight", chargeClass: "definite" }));
      expect(result).toEqual({ ok: true, message: "Draft version added." });
      expect(at("surcharge_rule_versions", "insert")[0]!.payload).toMatchObject({ charge_class: "definite", version_number: 1 });
    });

    it("accepts a conditional version of an adjustment fee, and maps the trigger's refusal", async () => {
      handle(stored("remeasure"));
      expect(await surcharges.addSurchargeRuleVersion({ ok: false }, versionForm({ category: "remeasure", chargeClass: "conditional" }))).toEqual({ ok: true, message: "Draft version added." });
      handle((c) => (c.table === "surcharge_rule_versions" && c.op === "insert" ? { error: { code: "23514", message: "check" } } : stored("remeasure")(c)));
      expect(await surcharges.addSurchargeRuleVersion({ ok: false }, versionForm({ category: "remeasure", chargeClass: "conditional" }))).toEqual({ ok: false, errors: { chargeClass: ADJUSTMENT_FEE_CLASS_MESSAGE } });
    });
  });
});

// ---------------------------------------------------------------------------
// A new draft version carries each term's source note forward
// ---------------------------------------------------------------------------
describe("createDraftFromImport and the terms' source notes", () => {
  const TERM_COLUMNS = { dim_divisor: "139", dim_threshold_cubic_in: "1728", dimension_rounding: "up", weight_rounding: "up", min_billable_lb: null, dim_exempt: false, min_charge: null, included_surcharge_keys: [], excluded_surcharge_keys: [], zone_chart_key: "default", zone_independent: false, surcharge_markup_percent: null };
  const STANDING = "Carrier structural defaults (verify against the carrier service guide)";

  function scenario(over: { sourcesError?: boolean } = {}) {
    handle((c) => {
      if (c.table === "rate_card_imports" && c.op === "select") return { data: { id: IMPORT, tenant_id: TENANT, rate_card_id: CARD, file_id: FILE, status: "validated", mapping: { sheets: [] }, version_id: null } };
      if (c.table === "uploaded_files") return { data: { filename: "rates.csv", mime_type: "text/csv", content: "\\x6162" } };
      if (c.table === "rate_cards") return { data: { status: "active" } };
      if (c.table === "rate_card_versions" && c.op === "select") return { data: c.filters.some(([k]) => k === "in") ? { id: "prev-version", version_number: 1 } : { version_number: 1 } };
      if (c.table === "rate_card_versions" && c.op === "insert") return { data: { id: "new-version" } };
      if (c.table === "rate_card_service_terms" && c.op === "select") return { data: [{ id: "prev-term-1", service_id: "s1", ...TERM_COLUMNS }] };
      if (c.table === "rate_card_service_terms" && c.op === "insert") return { data: [{ id: "new-term-1", service_id: "s1" }, { id: "new-term-2", service_id: "s2" }] };
      if (c.table === "rate_card_service_term_sources" && c.op === "select") return { data: [{ term_id: "prev-term-1", source_reference: "Master agreement section 4, 2026-01-15" }] };
      if (c.table === "rate_card_service_term_sources" && c.op === "insert") return over.sourcesError ? { error: { code: "42501", message: "row-level security" } } : { data: null };
      if (c.table === "rate_card_imports" && c.op === "update") return { data: [{ id: IMPORT }] };
      return undefined;
    });
  }

  it("copies the previous term's note to the new term of the same service, and the standing label to a service with no earlier term", async () => {
    scenario();
    const result = await rateCards.createDraftFromImport(IMPORT);
    expect(result).toEqual({ ok: true, versionId: "new-version", carriedFromVersion: 1 });
    const [terms] = at("rate_card_service_terms", "insert");
    // The note is not a column of the term any more: it is neither sent nor carried from the previous term, and no id is carried over.
    for (const row of terms!.payload as Record<string, unknown>[]) {
      expect(Object.keys(row)).not.toContain("source_reference");
      expect(Object.keys(row)).not.toContain("id");
    }
    const previousSelect = at("rate_card_service_terms", "select")[0]!;
    expect(previousSelect.cols).toMatch(/^id, service_id,/);
    expect(previousSelect.cols).not.toContain("source_reference");
    const [sources] = at("rate_card_service_term_sources", "insert");
    expect(sources!.payload).toEqual([
      { term_id: "new-term-1", tenant_id: TENANT, source_reference: "Master agreement section 4, 2026-01-15" },
      { term_id: "new-term-2", tenant_id: TENANT, source_reference: STANDING },
    ]);
    expect(calls().indexOf(terms!)).toBeLessThan(calls().indexOf(sources!));
    // The previous notes were read from the staff-only table, by the previous term ids.
    const read = at("rate_card_service_term_sources", "select")[0]!;
    expect(read.filters).toContainEqual(["in", "term_id"]);
  });

  it("gives a first version's terms the standing label, and reads no previous notes", async () => {
    handle((c) => {
      if (c.table === "rate_card_imports" && c.op === "select") return { data: { id: IMPORT, tenant_id: TENANT, rate_card_id: CARD, file_id: FILE, status: "validated", mapping: { sheets: [] }, version_id: null } };
      if (c.table === "uploaded_files") return { data: { filename: "rates.csv", mime_type: "text/csv", content: "\\x6162" } };
      if (c.table === "rate_cards") return { data: { status: "active" } };
      if (c.table === "rate_card_versions" && c.op === "select") return { data: null };
      if (c.table === "rate_card_versions" && c.op === "insert") return { data: { id: "new-version" } };
      if (c.table === "rate_card_service_terms" && c.op === "insert") return { data: [{ id: "new-term-1", service_id: "s1" }, { id: "new-term-2", service_id: "s2" }] };
      if (c.table === "rate_card_imports" && c.op === "update") return { data: [{ id: IMPORT }] };
      return undefined;
    });
    expect(await rateCards.createDraftFromImport(IMPORT)).toEqual({ ok: true, versionId: "new-version", carriedFromVersion: null });
    expect(at("rate_card_service_term_sources", "select")).toHaveLength(0);
    expect(at("rate_card_service_term_sources", "insert")[0]!.payload).toEqual([
      { term_id: "new-term-1", tenant_id: TENANT, source_reference: STANDING },
      { term_id: "new-term-2", tenant_id: TENANT, source_reference: STANDING },
    ]);
  });

  it("discards the draft version when the notes cannot be saved, like any other part of the copy", async () => {
    scenario({ sourcesError: true });
    expect(await rateCards.createDraftFromImport(IMPORT)).toEqual({ ok: false, message: "Something went wrong. Please try again." });
    expect(h.rpcs).toContainEqual({ name: "archive_rate_card_version", args: { p_version: "new-version" } });
    expect(at("rate_card_imports", "update")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// What brand-reachable pricing loads never includes the staff-only notes
// ---------------------------------------------------------------------------
describe("loading pricing data on a path a customer can reach", () => {
  const VERSION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const BAD_VERSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const GOOD_VERSION = "12121212-1212-4212-8212-121212121212";
  const LABEL = "Your 3PL's approved pricing configuration";

  const TERMS = { dim_divisor: "139", dim_threshold_cubic_in: "1728", dimension_rounding: "up", weight_rounding: "up", min_billable_lb: null, dim_exempt: false, min_charge: null, included_surcharge_keys: [], excluded_surcharge_keys: [], zone_chart_key: "default", zone_independent: false, surcharge_markup_percent: null };

  const payloadRule = (over: Record<string, unknown>) => ({
    key: "ups.rule",
    ruleId: "r",
    versionId: GOOD_VERSION,
    version: 1,
    scope: "tenant",
    brandId: null,
    carrierCode: "ups",
    category: "residential",
    name: "Residential",
    chargeClass: "definite",
    method: "flat",
    amount: "5.00",
    percent: null,
    perUnit: null,
    billableWeightFloorLb: null,
    base: { kind: "base_rate" },
    conditions: [],
    appliesToServiceIds: null,
    exclusivityGroup: null,
    exclusivityPriority: 0,
    excludesRuleKeys: [],
    perPackage: true,
    effectiveDate: "2026-01-01",
    expirationDate: null,
    sourceReference: LABEL,
    sourceUrl: null,
    verificationStatus: "approved_3pl_config",
    ...over,
  });

  it("selects the service terms without the source note, never touching the staff-only table", async () => {
    handle((c) =>
      c.table === "rate_card_service_terms"
        ? { data: [{ service_id: "s1", ...TERMS, shipping_services: { id: "s1", carrier_code: "ups", code: "ground", name: "UPS Ground" } }] }
        : undefined,
    );
    const terms = await snapshotLib.loadServiceTerms(fakeClient() as never, VERSION);
    expect(terms).toHaveLength(1);
    expect("sourceReference" in terms[0]!).toBe(false);
    const [select] = at("rate_card_service_terms", "select");
    expect(select!.cols).not.toContain("source_reference");
    expect(calls().map((c) => c.table)).toEqual(["rate_card_service_terms"]);
  });

  it("asks for the unfiltered rules context only when a staff caller says so, and sends the old request otherwise", async () => {
    const asked: unknown[] = [];
    handle((c) => {
      if (c.table === "rate_cards") return { data: { id: CARD, name: "Card", tenant_id: TENANT, status: "active" } };
      if (c.table === "rate_card_versions") return { data: { id: VERSION, version_number: 1, effective_date: "2026-01-01", expiration_date: null, status: "active" } };
      if (c.table === "rate_card_service_terms") return { data: [{ service_id: "s1", ...TERMS, shipping_services: { id: "s1", carrier_code: "ups", code: "ground", name: "UPS Ground" } }] };
      return undefined;
    });
    h.rpc = (name, args) => {
      if (name === "pricing_rules_for_card") {
        asked.push(args);
        return { data: { rules: [], zipLists: [], overrides: [], brandId: null }, error: null };
      }
      return { data: [], error: null };
    };
    await snapshotLib.loadPricingContext(fakeClient() as never, { rateCardId: CARD, shipDate: "2026-03-01", brandId: BRAND });
    await snapshotLib.loadPricingContext(fakeClient() as never, { rateCardId: CARD, shipDate: "2026-03-01", brandId: BRAND, adjustmentView: true });
    expect(asked).toEqual([
      { p_rate_card: CARD, p_ship_date: "2026-03-01", p_brand: BRAND, p_known_lists: null },
      { p_rate_card: CARD, p_ship_date: "2026-03-01", p_brand: BRAND, p_known_lists: null, p_adjustment_view: true },
    ]);
  });

  it("names the rule versions that could not be applied by id, keeps the text for staff, and passes the exception label through untouched", async () => {
    handle((c) => {
      if (c.table === "rate_cards") return { data: { id: CARD, name: "Card", tenant_id: TENANT, status: "active" } };
      if (c.table === "rate_card_versions") return { data: { id: VERSION, version_number: 1, effective_date: "2026-01-01", expiration_date: null, status: "active" } };
      if (c.table === "brand_rate_card_assignments") return { data: { allowed_service_ids: null } };
      if (c.table === "rate_card_service_terms") return { data: [{ service_id: "s1", ...TERMS, shipping_services: { id: "s1", carrier_code: "ups", code: "ground", name: "UPS Ground" } }] };
      return undefined;
    });
    h.rpc = (name) => {
      if (name === "pricing_rules_for_card") {
        return {
          data: {
            rules: [payloadRule({}), payloadRule({ key: "ups.bad", versionId: BAD_VERSION, name: "Acme secret peak fee", conditions: [{ type: "not_a_condition" }] })],
            zipLists: [],
            overrides: [{ id: OVERRIDE, ruleKey: "ups.rule", mode: "exclude", amount: null, percent: null, effectiveDate: "2026-01-01", expirationDate: null, reference: LABEL }],
            brandId: BRAND,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    };
    const loaded = await snapshotLib.loadPricingContext(fakeClient() as never, { rateCardId: CARD, shipDate: "2026-03-01", brandId: BRAND });
    if (!loaded.ok) throw new Error(loaded.error);
    const { snapshot } = loaded;
    expect(snapshot.issueVersionIds).toEqual([BAD_VERSION]);
    expect(snapshot.issues).toEqual(['The surcharge rule "Acme secret peak fee" has an invalid condition or base and was not applied.']);
    expect(snapshot.context.rules.map((r) => r.versionId)).toEqual([GOOD_VERSION]);
    expect(snapshot.context.overrides).toEqual([expect.objectContaining({ ruleKey: "ups.rule", mode: "exclude", reference: LABEL })]);
    // Nothing on this path asked for a staff-only table or a dropped column.
    const tables = calls().map((c) => c.table);
    expect(tables).not.toContain("rate_card_service_term_sources");
    expect(tables).not.toContain("customer_surcharge_override_notes");
    for (const c of calls()) expect(c.cols ?? "", c.table).not.toContain("source_reference");
  });
});
