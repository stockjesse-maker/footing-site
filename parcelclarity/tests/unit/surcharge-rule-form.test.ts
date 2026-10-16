import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RuleFormInitial } from "@/components/pricing/rule-form";

// The form calls server actions on submit only; rendering it needs no server.
vi.mock("@/app/actions/surcharges", () => ({ addSurchargeRuleVersion: vi.fn(), createSurchargeRule: vi.fn(), retireRuleVersion: vi.fn(), uploadZipList: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { RuleForm } = await import("@/components/pricing/rule-form");

/**
 * The surcharge rule form after Milestone 5's step 0: a reweigh, remeasure or shipping charge correction rule can only be a conditional
 * charge (the form shows no other class for it, and a new version of an existing rule follows the rule's own category), and the form
 * warns that rule keys, which come out of the name, can be read by the 3PL's customers.
 */
const RULE_KEY_SENTENCE = "Rule keys can be read by your customers through the API, so do not put customer names or margins in them.";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const base = {
  catalog: [{ id: "s1", carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" }],
  carriers: [{ code: "ups", name: "UPS" }],
  knownGroups: {},
  today: "2026-10-16",
};
const initial = (over: Partial<RuleFormInitial> = {}): RuleFormInitial => ({
  name: "Carrier reweigh fee",
  carrierCode: "ups",
  category: "reweight",
  chargeClass: "conditional",
  method: "flat",
  amount: "3.00",
  percent: null,
  perUnitSize: null,
  perUnitFreeAllowance: null,
  perUnitMinimumCharge: null,
  billableWeightFloorLb: null,
  base: { kind: "base_rate" },
  conditions: [],
  appliesToServiceIds: [],
  exclusivityGroup: null,
  exclusivityPriority: 0,
  excludesRuleKeys: [],
  perPackage: true,
  effectiveDate: "2026-01-01",
  expirationDate: null,
  sourceReference: "Customer agreement, section 4",
  sourceUrl: null,
  ...over,
});

/** The <select> with this name, as markup, and the labels of its options. */
function select(html: string, name: string): { tag: string; options: string[]; selected: string[] } {
  const match = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (!match) throw new Error(`no select named ${name}`);
  const tag = /<select[^>]*>/.exec(match[0])![0];
  const options = [...match[1]!.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]!);
  const selected = [...match[1]!.matchAll(/<option[^>]*selected=""[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]!);
  return { tag, options, selected };
}

describe("RuleForm, creating a rule", () => {
  const html = renderToStaticMarkup(createElement(RuleForm, { ...base, mode: "create" }));

  it("tells the 3PL, beside the key it derives from the name, that customers can read rule keys", () => {
    expect(text(html).split(RULE_KEY_SENTENCE)).toHaveLength(2);
    expect(text(html)).toContain("Key: ups.rule");
  });

  it("offers every charge class for an ordinary category, and lets the category be chosen", () => {
    expect(select(html, "chargeClass").options).toEqual(["Definite charge", "Estimate", "Conditional adjustment"]);
    expect(select(html, "category").tag).not.toMatch(/\sdisabled=""/);
  });
});

describe("RuleForm, adding a version", () => {
  it.each(["reweight", "remeasure", "shipping_charge_correction"] as const)("shows a %s rule's charge class as conditional only, even when its last version was another class, and says why", (category) => {
    const html = renderToStaticMarkup(createElement(RuleForm, { ...base, mode: "version", ruleId: "r1", initial: initial({ category, chargeClass: "definite" }) }));
    const cls = select(html, "chargeClass");
    expect(cls.options).toEqual(["Conditional adjustment"]);
    expect(cls.selected).toEqual(["Conditional adjustment"]);
    expect(text(html)).toContain("Always a conditional adjustment for this category");
    expect(text(html)).toContain("never counted in a total");
  });

  it("fixes the category once a rule exists (the version never changes it; the server checks the stored one)", () => {
    const html = renderToStaticMarkup(createElement(RuleForm, { ...base, mode: "version", ruleId: "r1", initial: initial({ category: "residential", chargeClass: "definite" }) }));
    expect(select(html, "category").tag).toMatch(/\sdisabled=""/);
    expect(text(html)).toContain("The category is fixed once a rule exists.");
    expect(select(html, "chargeClass").options).toHaveLength(3);
    expect(select(html, "chargeClass").selected).toEqual(["Definite charge"]);
  });

  it("does not repeat the warning about rule keys: the key was fixed when the rule was created and a rename does not change it", () => {
    const html = renderToStaticMarkup(createElement(RuleForm, { ...base, mode: "version", ruleId: "r1", initial: initial() }));
    expect(text(html)).not.toContain(RULE_KEY_SENTENCE);
    expect(text(html)).toContain("The key it was created with does not change.");
  });
});
