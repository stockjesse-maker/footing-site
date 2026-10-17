import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEE_RULE_COMPANION_MESSAGE, FEE_RULE_EXCLUDES_MESSAGE, FEE_RULE_FLOOR_MESSAGE, RULE_DEPENDS_ON_FEE_MESSAGE } from "@/lib/adjustments/copy";
import { BRAND, NEW_ID, TENANT, adminSession, makeDb, type FakeDb, type Row } from "./adjustments-actions-support";

/**
 * The surcharge rule actions after the adversarial review of the adjustment engine (finding F2, rule-form part): a reweigh, remeasure or shipping
 * charge correction rule is a conditional charge shown beside a quote and never counted in it, so it must not change what IS counted. It cannot
 * suppress other rules, carry a billable weight floor or depend on another rule being applied, and no counted rule may depend on one of these
 * fees. The actions refuse with friendly messages before anything is written. Also pinned here: the override action's embed of a rule's versions
 * names the relationship (`surcharge_rule_versions` has two foreign keys to `surcharge_rules`, and an unhinted embed answers PGRST201).
 */
const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ requireTenantContext: async () => ({ ...adminSession }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as FakeDb).client }));
vi.mock("@/lib/rate-limit", () => ({ RATE_LIMITED_MESSAGE: "limited", withinRateLimit: async () => true }));

const actions = await import("@/app/actions/surcharges");

const RULE = "5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a";
const db = () => h.db as FakeDb;
const install = (opts: Parameters<typeof makeDb>[0] = {}) => {
  h.db = makeDb(opts);
  return h.db as FakeDb;
};
beforeEach(() => {
  install({ inserted: { surcharge_rules: { id: RULE }, surcharge_rule_versions: { id: NEW_ID } } });
});

const FEE_CATEGORIES = ["reweight", "remeasure", "shipping_charge_correction"] as const;

/** The fields the rule form posts, for a conditional flat fee that is valid in every category. */
function form(over: Record<string, string | string[]> = {}): FormData {
  const f = new FormData();
  const base: Record<string, string> = {
    name: "Carrier reweigh fee",
    carrierCode: "ups",
    category: "reweight",
    chargeClass: "conditional",
    method: "flat",
    amount: "3.00",
    percent: "",
    perUnitSize: "",
    billableWeightFloorLb: "",
    brandId: "",
    base: JSON.stringify({ kind: "base_rate" }),
    conditions: "[]",
    exclusivityGroup: "",
    exclusivityPriority: "0",
    excludesRuleKeys: "",
    effectiveDate: "2026-01-01",
    expirationDate: "",
    sourceReference: "Customer agreement, section 4",
    sourceUrl: "",
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) {
    if (Array.isArray(v)) v.forEach((x) => f.append(k, x));
    else f.set(k, v);
  }
  return f;
}
const created = async (f: FormData) => actions.createSurchargeRule({ ok: false }, f).catch((e: Error) => e.message);

describe("createSurchargeRule: a fee rule that would change what is counted is refused, with a message that says why", () => {
  it.each(FEE_CATEGORIES)("%s: suppressing other rules, a billable weight floor and a dependency on another rule each come back as a field message, and nothing is written", async (category) => {
    const suppress = await actions.createSurchargeRule({ ok: false }, form({ category, excludesRuleKeys: "ups.residential" }));
    expect(suppress).toMatchObject({ ok: false, errors: { excludesRuleKeys: FEE_RULE_EXCLUDES_MESSAGE } });
    const floor = await actions.createSurchargeRule({ ok: false }, form({ category, billableWeightFloorLb: "20" }));
    expect(floor).toMatchObject({ ok: false, errors: { billableWeightFloorLb: FEE_RULE_FLOOR_MESSAGE } });
    const companion = await actions.createSurchargeRule({ ok: false }, form({ category, conditions: JSON.stringify([{ type: "rule_applied", ruleKey: "ups.residential" }]) }));
    expect(companion).toMatchObject({ ok: false, errors: { conditions: FEE_RULE_COMPANION_MESSAGE } });
    const nested = await actions.createSurchargeRule({ ok: false }, form({ category, conditions: JSON.stringify([{ type: "any_of", conditions: [{ type: "residential", value: true }, { type: "rule_applied", ruleKey: "ups.das" }] }]) }));
    expect(nested).toMatchObject({ ok: false, errors: { conditions: FEE_RULE_COMPANION_MESSAGE } });
    expect(db().writes(), "refused before any write").toEqual([]);
    for (const text of [FEE_RULE_EXCLUDES_MESSAGE, FEE_RULE_FLOOR_MESSAGE, FEE_RULE_COMPANION_MESSAGE]) expect(text).toMatch(/^A reweigh, remeasure or correction fee cannot /);
  });

  it("all three at once are all reported (the form shows each under its own field)", async () => {
    const r = await actions.createSurchargeRule({ ok: false }, form({ excludesRuleKeys: "ups.das, ups.residential", billableWeightFloorLb: "5", conditions: JSON.stringify([{ type: "rule_applied", ruleKey: "ups.das" }]) }));
    expect(r).toMatchObject({ ok: false, errors: { excludesRuleKeys: FEE_RULE_EXCLUDES_MESSAGE, billableWeightFloorLb: FEE_RULE_FLOOR_MESSAGE, conditions: FEE_RULE_COMPANION_MESSAGE } });
  });

  it.each(FEE_CATEGORIES)("%s: a plain conditional fee (conditions on the package, an exclusivity group among fee rules, a zero floor) is created as a conditional draft", async (category) => {
    const result = await created(form({ category, billableWeightFloorLb: "0", exclusivityGroup: "adjustment_fees", conditions: JSON.stringify([{ type: "residential", value: true }]) }));
    expect(result).toBe(`NEXT_REDIRECT:/app/surcharges/${RULE}`);
    const [rule, version] = db().inserts();
    expect(rule!.table).toBe("surcharge_rules");
    expect(rule!.payload).toMatchObject({ category, tenant_id: TENANT });
    expect(version!.payload).toMatchObject({ charge_class: "conditional", excludes_rule_keys: [], rule_id: RULE });
  });

  it("the same options stay available to every other category, and the class stays free there", async () => {
    const result = await created(form({ category: "residential", chargeClass: "definite", excludesRuleKeys: "ups.das", billableWeightFloorLb: "20", conditions: JSON.stringify([{ type: "rule_applied", ruleKey: "ups.das" }]) }));
    expect(result).toBe(`NEXT_REDIRECT:/app/surcharges/${RULE}`);
    expect(db().inserts()[1]!.payload).toMatchObject({ charge_class: "definite", excludes_rule_keys: ["ups.das"], billable_weight_floor_lb: "20" });
  });

  it("a fee rule must be conditional (the class is refused with the engine's own sentence)", async () => {
    const r = await actions.createSurchargeRule({ ok: false }, form({ chargeClass: "definite" }));
    expect(r).toMatchObject({ ok: false, errors: { chargeClass: expect.stringMatching(/conditional/i) } });
    expect(db().writes()).toEqual([]);
  });
});

describe("createSurchargeRule: no counted rule may depend on a fee rule being applied", () => {
  it("a residential rule whose condition names a reweigh rule is refused; one that names a counted rule is created", async () => {
    install({ tables: { surcharge_rules: [{ rule_key: "ups.reweigh_flat", category: "reweight" }, { rule_key: "ups.das", category: "das" }] }, inserted: { surcharge_rules: { id: RULE }, surcharge_rule_versions: { id: NEW_ID } } });
    const dependsOnFee = await actions.createSurchargeRule({ ok: false }, form({ category: "residential", chargeClass: "definite", conditions: JSON.stringify([{ type: "rule_applied", ruleKey: "ups.reweigh_flat" }]) }));
    expect(dependsOnFee).toMatchObject({ ok: false, errors: { conditions: RULE_DEPENDS_ON_FEE_MESSAGE } });
    expect(db().writes()).toEqual([]);
    const nested = await actions.createSurchargeRule({ ok: false }, form({ category: "residential", chargeClass: "definite", conditions: JSON.stringify([{ type: "any_of", conditions: [{ type: "residential", value: true }, { type: "rule_applied", ruleKey: "ups.reweigh_flat" }] }]) }));
    expect(nested).toMatchObject({ ok: false, errors: { conditions: RULE_DEPENDS_ON_FEE_MESSAGE } });
    expect(await created(form({ category: "residential", chargeClass: "definite", conditions: JSON.stringify([{ type: "rule_applied", ruleKey: "ups.das" }]) }))).toBe(`NEXT_REDIRECT:/app/surcharges/${RULE}`);
  });
});

describe("addSurchargeRuleVersion: the category is the stored rule's, whatever the form says", () => {
  const stored = (category: string): Row => ({ id: RULE, tenant_id: TENANT, scope: "tenant", carrier_code: "ups", category });
  const addForm = (over: Record<string, string> = {}) => {
    const f = form(over);
    f.set("ruleId", RULE);
    return f;
  };

  it("a new version of a reweigh rule with a weight floor is refused even when the form claims another category", async () => {
    install({ tables: { surcharge_rules: [stored("reweight")] }, inserted: { surcharge_rule_versions: { id: NEW_ID } } });
    const r = await actions.addSurchargeRuleVersion({ ok: false }, addForm({ category: "residential", billableWeightFloorLb: "20" }));
    expect(r).toMatchObject({ ok: false, errors: { billableWeightFloorLb: FEE_RULE_FLOOR_MESSAGE } });
    const r2 = await actions.addSurchargeRuleVersion({ ok: false }, addForm({ category: "residential", excludesRuleKeys: "ups.das" }));
    expect(r2).toMatchObject({ ok: false, errors: { excludesRuleKeys: FEE_RULE_EXCLUDES_MESSAGE } });
    expect(db().inserts()).toEqual([]);
  });

  it("a valid new version of a fee rule is added as a conditional draft; the same extras on a counted rule are fine", async () => {
    install({ tables: { surcharge_rules: [stored("remeasure")], surcharge_rule_versions: [{ rule_id: RULE, version_number: 1 }] }, inserted: { surcharge_rule_versions: { id: NEW_ID } } });
    expect(await actions.addSurchargeRuleVersion({ ok: false }, addForm({ category: "remeasure" }))).toEqual({ ok: true, message: "Draft version added." });
    expect(db().inserts().at(-1)!.payload).toMatchObject({ charge_class: "conditional", version_number: 2 });
    install({ tables: { surcharge_rules: [stored("das")], surcharge_rule_versions: [] }, inserted: { surcharge_rule_versions: { id: NEW_ID } } });
    expect(await actions.addSurchargeRuleVersion({ ok: false }, addForm({ chargeClass: "definite", excludesRuleKeys: "ups.das", billableWeightFloorLb: "20" }))).toEqual({ ok: true, message: "Draft version added." });
  });

  it("another account's rule, and a platform rule, are not found", async () => {
    install({ tables: { surcharge_rules: [{ ...stored("reweight"), tenant_id: "other" }] } });
    expect(await actions.addSurchargeRuleVersion({ ok: false }, addForm())).toEqual({ ok: false, message: "Rule not found." });
    install({ tables: { surcharge_rules: [{ ...stored("reweight"), scope: "platform" }] } });
    expect(await actions.addSurchargeRuleVersion({ ok: false }, addForm())).toEqual({ ok: false, message: "Rule not found." });
  });
});

describe("createOverride: the embed of the rule's versions names its relationship", () => {
  it("selects surcharge_rule_versions through the srv_rule_in_tenant foreign key (without the hint PostgREST answers PGRST201, 'more than one relationship')", async () => {
    install({ tables: { surcharge_rules: [{ id: RULE, brand_id: null, surcharge_rule_versions: [{ method: "flat", status: "published", version_number: 1 }] }] }, inserted: { customer_surcharge_overrides: { id: NEW_ID } } });
    const f = new FormData();
    for (const [k, v] of Object.entries({ brandId: BRAND, ruleId: RULE, mode: "exclude", effectiveDate: "2026-01-01", reference: "Agreement of May" })) f.set(k, v);
    await actions.createOverride({ ok: false }, f);
    const select = db().on("surcharge_rules", "select")[0]!;
    expect(select.columns).toContain("surcharge_rule_versions!srv_rule_in_tenant(");
    expect(select.columns).not.toMatch(/surcharge_rule_versions\(/);
    // The staff-only note goes to its own table, never into the exception row the customer can read.
    expect(db().on("customer_surcharge_override_notes", "insert")).toHaveLength(1);
    expect(JSON.stringify(db().on("customer_surcharge_overrides", "insert")[0]!.payload)).not.toContain("Agreement of May");
  });
});
