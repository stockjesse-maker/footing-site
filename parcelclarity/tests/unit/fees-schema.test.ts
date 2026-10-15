import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import type { FeeRule, FeeScheduleSnapshot } from "@/engine/fees/types";
import {
  feeRuleInputSchema,
  fulfillmentAnswerProblems,
  fulfillmentAnswersSchema,
  rowToSnapshotRule,
  ruleFieldErrors,
  ruleFormToRow,
  snapshotRuleToForm,
  tryOrderInputSchema,
  tryOrderToEngine,
} from "@/lib/fees/schema";

/**
 * The editor's Zod schema must accept every fixture rule and refuse the same shapes
 * `app.fee_rule_problem` refuses (20261015000006_fees.sql), so a 3PL sees the problem inline
 * before the database does. The converters must round-trip the fixtures exactly.
 */
const dir = new URL("../fixtures/fees/", import.meta.url);
const schedules = JSON.parse(readFileSync(new URL("schedules.json", dir), "utf8")) as Record<string, FeeScheduleSnapshot>;
const fixtureRules: { schedule: string; rule: FeeRule }[] = Object.entries(schedules)
  .filter(([k]) => !k.startsWith("_"))
  .flatMap(([schedule, s]) => s.rules.map((rule) => ({ schedule, rule })));

const NUMERIC_KEYS = new Set(["amount", "percent", "includedQuantity", "minimumCharge", "upTo"]);

/** Sorted keys, nulls dropped, decimal strings normalised ("2.5000" and "2.5" compare equal). */
function canonical(value: unknown, key: string | null = null): unknown {
  if (Array.isArray(value)) return value.map((v) => canonical(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === null || v === undefined) continue;
      out[k] = canonical(v, k);
    }
    return out;
  }
  if (typeof value === "string" && key !== null && NUMERIC_KEYS.has(key) && /^\d+(\.\d+)?$/.test(value)) return new Decimal(value).toFixed();
  return value;
}

const META = { versionId: "00000000-0000-0000-0000-000000000001", tenantId: "00000000-0000-0000-0000-000000000002", position: 0 };

/** A valid flat per-item rule to mutate in the rejection tests (loosely typed on purpose: the inputs are deliberately malformed). */
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "pick_fee",
  name: "Pick fee",
  category: "pick_pack",
  scope: "order",
  basis: "unit",
  method: "flat",
  amount: "1.25",
  percent: null,
  percentBase: null,
  tiers: null,
  includedQuantity: null,
  includedPer: null,
  minimumCharge: null,
  conditions: null,
  exclusiveGroup: null,
  priority: null,
  driver: null,
  minimum: null,
  description: null,
  helpText: null,
  ...over,
});

const tiers = (brackets: Record<string, unknown>[], over: Record<string, unknown> = {}): Record<string, unknown> => ({ on: "order_quantity", mode: "graduated", pricing: "rate", brackets, ...over });
const minimum = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ amount: "500", appliesTo: { categories: ["pick_pack"], includeRuleKeys: [], excludeRuleKeys: [] }, includesShipping: false, ...over });

function errorsOf(input: unknown): Record<string, string> {
  const result = feeRuleInputSchema.safeParse(input);
  if (result.success) return {};
  return ruleFieldErrors(result.error);
}

describe("feeRuleInputSchema accepts every fixture rule", () => {
  for (const { schedule, rule } of fixtureRules) {
    it(`${schedule}/${rule.key}`, () => {
      const result = feeRuleInputSchema.safeParse(snapshotRuleToForm(rule));
      expect(result.success, result.success ? "" : JSON.stringify(ruleFieldErrors(result.error))).toBe(true);
    });
  }
});

describe("form → row → snapshot round-trips the fixture rules", () => {
  for (const { schedule, rule } of fixtureRules) {
    it(`${schedule}/${rule.key}`, () => {
      const form = feeRuleInputSchema.parse(snapshotRuleToForm(rule));
      const row = ruleFormToRow(form, { ...META, position: rule.position });
      expect(row.version_id).toBe(META.versionId);
      expect(row.tenant_id).toBe(META.tenantId);
      const back = rowToSnapshotRule({ ...row, id: "11111111-1111-1111-1111-111111111111" });
      expect(back.id).toBe("11111111-1111-1111-1111-111111111111");
      const { id: _id, ...roundTripped } = back;
      // resolvedRuleKeys is set by the database at activation, never by the form; and an account
      // minimum's amount lives in minimum.amount only (the database refuses a top-level amount on
      // any non-flat rule), so the fixture's redundant copy is not expected back.
      const { resolvedRuleKeys: _resolved, ...expected } = rule;
      if (expected.method !== "flat") expected.amount = null;
      expect(canonical(roundTripped)).toEqual(canonical(expected));
    });
  }

  it("keeps numeric columns as decimal text even when PostgREST hands them over as numbers", () => {
    const row = { ...ruleFormToRow(feeRuleInputSchema.parse(base({ amount: "0.0125", includedQuantity: "1", minimumCharge: "2.5" })), META), amount: 0.0125, included_quantity: 1, minimum_charge: 2.5 };
    const rule = rowToSnapshotRule(row);
    expect(rule.amount).toBe("0.0125");
    expect(rule.includedQuantity).toBe("1");
    expect(rule.minimumCharge).toBe("2.5");
  });

  it("refuses to build a rule from malformed jsonb rather than pricing on it", () => {
    const row = ruleFormToRow(feeRuleInputSchema.parse(base()), META);
    expect(() => rowToSnapshotRule({ ...row, tiers: { on: "order_quantity", mode: "graduated", pricing: "rate", brackets: [] } })).toThrow(/malformed tiers/);
    expect(() => rowToSnapshotRule({ ...row, driver: { key: "x" } })).toThrow(/malformed driver/);
  });

  it("omits null columns like fee_schedule_snapshot does", () => {
    const rule = rowToSnapshotRule(ruleFormToRow(feeRuleInputSchema.parse(base()), META));
    expect(Object.keys(rule).sort()).toEqual(["amount", "basis", "category", "key", "method", "name", "percent", "position", "scope"]);
    expect(rule.percent).toBeNull();
  });
});

describe("feeRuleInputSchema refuses what app.fee_rule_problem refuses", () => {
  it("bad keys", () => {
    expect(errorsOf(base({ key: "Pick Fee" })).key).toMatch(/short slug/);
    expect(errorsOf(base({ key: "1pick" })).key).toMatch(/short slug/);
    expect(errorsOf(base({ key: "a".repeat(62) })).key).toMatch(/short slug/);
    expect(errorsOf(base({ key: "" })).key).toMatch(/short slug/);
  });

  it("names, categories, scopes, bases and methods are closed sets", () => {
    expect(errorsOf(base({ name: "   " })).name).toMatch(/1–120/);
    expect(errorsOf(base({ name: "x".repeat(121) })).name).toMatch(/1–120/);
    expect(errorsOf(base({ category: "handling" })).category).toBe("unknown category");
    expect(errorsOf(base({ scope: "weekly" })).scope).toBe("unknown scope");
    expect(errorsOf(base({ basis: "weight" })).basis).toBe("unknown basis");
    expect(errorsOf(base({ method: "markup" })).method).toBe("unknown method");
    expect(errorsOf(base({ scope: "monthly" })).basis).toBe("basis does not match a monthly rule");
    expect(errorsOf(base({ scope: "order", basis: "driver", driver: { key: "k", label: "L", unit: "u", kind: "monthly_quantity" } })).basis).toBe("basis does not match an order-scope rule");
  });

  it("percent on a flat rule, and percent rules without a base", () => {
    expect(errorsOf(base({ percent: "5" })).percent).toBe("percent applies to percent-of-shipping rules only");
    expect(errorsOf(base({ percentBase: "shipping_total" })).percentBase).toBe("percent base applies to percent-of-shipping rules only");
    expect(errorsOf(base({ basis: "shipping_percent" })).method).toMatch(/percent method/);
    const pct = base({ basis: "shipping_percent", method: "percent", amount: null, percent: "5", percentBase: "shipping_total" });
    expect(errorsOf(pct)).toEqual({});
    expect(errorsOf({ ...pct, percentBase: null }).percentBase).toBe("choose what the percent is taken of");
    expect(errorsOf({ ...pct, percent: null }).percent).toBe("percent is required");
    expect(errorsOf({ ...pct, percent: "1000.5" }).percent).toMatch(/between 0 and 1000/);
    expect(errorsOf({ ...pct, percent: "-5" }).percent).toBeDefined();
    expect(errorsOf({ ...pct, amount: "1" }).amount).toBe("amount applies to flat rules only");
  });

  it("amount is required on flat rules and refused elsewhere", () => {
    expect(errorsOf(base({ amount: null })).amount).toBe("amount is required");
    expect(errorsOf(base({ amount: "" })).amount).toBe("amount is required");
    expect(errorsOf(base({ amount: "1,000" })).amount).toMatch(/4 decimals/);
    expect(errorsOf(base({ amount: "1.00001" })).amount).toMatch(/4 decimals/);
    expect(errorsOf(base({ amount: "-1" })).amount).toMatch(/4 decimals/);
    expect(errorsOf(base({ amount: "123456789" })).amount).toMatch(/4 decimals/); // numeric(12,4): 8 integer digits
    expect(errorsOf(base({ method: "tiered", amount: "1", tiers: tiers([{ upTo: null, amount: "1" }]) })).amount).toBe("amount applies to flat rules only");
  });

  it("tiers: required iff tiered, ascending edges, open-ended last bracket, closed sets", () => {
    const tiered = base({ method: "tiered", amount: null, tiers: tiers([{ upTo: "1", amount: "3" }, { upTo: "10", amount: "0.5" }, { upTo: null, amount: "0.4" }]) });
    expect(errorsOf(tiered)).toEqual({});
    expect(errorsOf(base({ tiers: tiers([{ upTo: null, amount: "1" }]) })).tiers).toMatch(/required for tiered rules/);
    expect(errorsOf(base({ method: "tiered", amount: null })).tiers).toMatch(/required for tiered rules/);
    expect(errorsOf({ ...tiered, tiers: tiers([{ upTo: "10", amount: "3" }, { upTo: "5", amount: "0.5" }, { upTo: null, amount: "0.4" }]) })["tiers.brackets.1.upTo"]).toBe("bracket edges must ascend");
    expect(errorsOf({ ...tiered, tiers: tiers([{ upTo: "10", amount: "3" }, { upTo: "10", amount: "0.5" }, { upTo: null, amount: "0.4" }]) })["tiers.brackets.1.upTo"]).toBe("bracket edges must ascend");
    expect(errorsOf({ ...tiered, tiers: tiers([{ upTo: "0", amount: "3" }, { upTo: null, amount: "0.4" }]) })["tiers.brackets.0.upTo"]).toBe("bracket edges must ascend");
    expect(errorsOf({ ...tiered, tiers: tiers([{ upTo: "1", amount: "3" }, { upTo: "10", amount: "0.4" }]) })["tiers.brackets.1.upTo"]).toMatch(/open-ended/);
    expect(errorsOf({ ...tiered, tiers: tiers([{ upTo: null, amount: "3" }, { upTo: null, amount: "0.4" }]) })["tiers.brackets.0.upTo"]).toBe("bracket edges must be numbers");
    expect(errorsOf({ ...tiered, tiers: tiers([{ upTo: "1", amount: "x" }, { upTo: null, amount: "0.4" }]) })["tiers.brackets.0.amount"]).toMatch(/4 decimals/);
    expect(errorsOf({ ...tiered, tiers: tiers([]) })["tiers.brackets"]).toBe("tiers need 1–50 brackets");
    expect(errorsOf({ ...tiered, tiers: tiers(Array.from({ length: 51 }, (_, i) => ({ upTo: i === 50 ? null : String(i + 1), amount: "1" }))) })["tiers.brackets"]).toBe("tiers need 1–50 brackets");
    expect(errorsOf({ ...tiered, tiers: tiers([{ upTo: null, amount: "1" }], { mode: "stepped" }) })["tiers.mode"]).toBe("tiers.mode must be graduated or volume");
    expect(errorsOf({ ...tiered, tiers: tiers([{ upTo: null, amount: "1" }], { pricing: "flat" }) })["tiers.pricing"]).toBe("graduated tiers are priced per unit");
    expect(errorsOf({ ...tiered, tiers: { ...tiers([{ upTo: null, amount: "1" }]), extra: 1 } }).tiers).toBe("tiers has an unknown field");
    expect(errorsOf({ ...tiered, tiers: tiers([{ upTo: null, amount: "1", note: "x" }]) })["tiers.brackets.0"]).toBe("a bracket has an unknown field");
    expect(errorsOf({ ...tiered, basis: "shipping_percent", method: "tiered" }).method).toBeDefined();
    expect(errorsOf({ ...tiered, scope: "monthly", basis: "month" }).method).toBe("this basis cannot be tiered");
  });

  it("tiers on the monthly quantity: monthly rules always, order rules only per order/item/package/shipment priced per unit", () => {
    const monthly = base({ scope: "monthly", basis: "driver", method: "tiered", amount: null, driver: { key: "cubic_feet", label: "Cubic feet stored", unit: "cubic feet", kind: "monthly_quantity" }, tiers: tiers([{ upTo: null, amount: "1" }]) });
    expect(errorsOf(monthly)["tiers.on"]).toBe("monthly rules tier on the monthly quantity");
    expect(errorsOf({ ...monthly, tiers: tiers([{ upTo: null, amount: "1" }], { on: "monthly_quantity" }) })).toEqual({});
    const order = base({ basis: "line", method: "tiered", amount: null, tiers: tiers([{ upTo: null, amount: "1" }], { on: "monthly_quantity" }) });
    expect(errorsOf(order)["tiers.on"]).toMatch(/monthly-volume tiers apply to/);
    expect(errorsOf({ ...order, basis: "unit", tiers: tiers([{ upTo: null, amount: "1" }], { on: "monthly_quantity", mode: "volume", pricing: "flat" }) })["tiers.on"]).toMatch(/monthly-volume tiers apply to/);
    expect(errorsOf({ ...order, basis: "unit" })).toEqual({});
  });

  it("included quantity: never on tiered rules, only on per-quantity order rules, includedPer needs a quantity", () => {
    expect(errorsOf(base({ method: "tiered", amount: null, tiers: tiers([{ upTo: null, amount: "1" }]), includedQuantity: "1" })).includedQuantity).toMatch(/no free allowance/);
    expect(errorsOf(base({ basis: "order", includedQuantity: "1" })).includedQuantity).toMatch(/free allowance applies to/);
    expect(errorsOf(base({ scope: "monthly", basis: "month", includedQuantity: "1" })).includedQuantity).toMatch(/free allowance applies to/);
    expect(errorsOf(base({ includedPer: "order" })).includedPer).toBe("includedPer needs an included quantity");
    expect(errorsOf(base({ includedQuantity: "1", includedPer: "line" }))).toEqual({});
    expect(errorsOf(base({ includedQuantity: "1", includedPer: "package" })).includedPer).toMatch(/includedPer must be/);
  });

  it("minimum charge only on per-quantity rules", () => {
    expect(errorsOf(base({ scope: "monthly", basis: "month", minimumCharge: "5" })).minimumCharge).toBe("a minimum charge applies to per-quantity rules only");
    expect(errorsOf(base({ basis: "shipping_percent", method: "percent", amount: null, percent: "5", percentBase: "shipping_total", minimumCharge: "5" })).minimumCharge).toBe("a minimum charge applies to per-quantity rules only");
    expect(errorsOf(base({ minimumCharge: "5" }))).toEqual({});
  });

  it("conditions: order rules only, whole-number bounds, packaging types on per-package rules, normalised and distinct", () => {
    expect(errorsOf(base({ conditions: { packagingTypes: ["box"] } }))["conditions.packagingTypes"]).toBe("packaging types condition applies to per-package rules only");
    expect(errorsOf(base({ basis: "package", conditions: { packagingTypes: ["box"] } }))).toEqual({});
    expect(errorsOf(base({ scope: "monthly", basis: "month", conditions: { minUnits: 1 } })).conditions).toBe("conditions apply to order rules only");
    expect(errorsOf(base({ conditions: { minUnits: 5, maxUnits: 2 } }))["conditions.minUnits"]).toBe("minUnits exceeds maxUnits");
    expect(errorsOf(base({ conditions: { minLines: 1.5 } }))["conditions.minLines"]).toMatch(/whole number/);
    expect(errorsOf(base({ conditions: { maxPackages: -1 } }))["conditions.maxPackages"]).toMatch(/whole number/);
    expect(errorsOf(base({ conditions: { minUnits: "3" } }))).toEqual({}); // form strings become integers
    expect(errorsOf(base({ conditions: { weight: 3 } })).conditions).toBe("conditions has an unknown field");
    expect(errorsOf(base({ basis: "package", conditions: { packagingTypes: ["Box"] } }))["conditions.packagingTypes.0"]).toMatch(/normalised/);
    expect(errorsOf(base({ basis: "package", conditions: { packagingTypes: ["poly  mailer"] } }))["conditions.packagingTypes.0"]).toMatch(/normalised/);
    expect(errorsOf(base({ basis: "package", conditions: { packagingTypes: ["box", "box"] } }))["conditions.packagingTypes"]).toBe("packaging types repeat");
    expect(errorsOf(base({ basis: "package", conditions: { packagingTypes: ["*", "poly mailer"] } }))).toEqual({});
    // An editor that clears every condition sends no conditions at all.
    expect(feeRuleInputSchema.parse(base({ conditions: { minUnits: "", packagingTypes: [] } })).conditions).toBeNull();
    expect(feeRuleInputSchema.parse(base({ conditions: {} })).conditions).toBeNull();
  });

  it("exclusive groups need a priority and vice versa, on order rules only", () => {
    expect(errorsOf(base({ exclusiveGroup: "packaging" })).priority).toBe("a rule in an exclusive group needs a priority");
    expect(errorsOf(base({ priority: 1 })).priority).toBe("priority applies to rules in an exclusive group only");
    expect(errorsOf(base({ exclusiveGroup: "Packaging!", priority: 1 })).exclusiveGroup).toBe("exclusive group must be a short slug");
    expect(errorsOf(base({ scope: "monthly", basis: "month", exclusiveGroup: "g", priority: 1 })).exclusiveGroup).toBe("exclusive groups apply to order rules only");
    expect(errorsOf(base({ exclusiveGroup: "packaging", priority: "2" }))).toEqual({});
  });

  it("drivers: required iff the basis is a driver, with the kind matching the basis", () => {
    const monthlyDriver = { key: "pallets_stored", label: "Pallets stored, on average", unit: "pallets", kind: "monthly_quantity" };
    expect(errorsOf(base({ driver: monthlyDriver })).driver).toMatch(/not allowed otherwise/);
    expect(errorsOf(base({ scope: "monthly", basis: "driver" })).driver).toMatch(/required for driver rules/);
    expect(errorsOf(base({ basis: "order_driver", driver: monthlyDriver }))["driver.kind"]).toBe("a per-order driver is answered as a share of orders");
    expect(errorsOf(base({ scope: "monthly", basis: "driver", driver: { ...monthlyDriver, kind: "order_share" } }))["driver.kind"]).toBe("a monthly driver is a monthly quantity or a returns rate");
    expect(errorsOf(base({ scope: "monthly", basis: "driver", driver: monthlyDriver }))).toEqual({});
    expect(errorsOf(base({ scope: "monthly", basis: "driver", driver: { ...monthlyDriver, kind: "returns_rate" } }))).toEqual({});
    expect(errorsOf(base({ basis: "order_driver", driver: { ...monthlyDriver, kind: "order_share" } }))).toEqual({});
    expect(errorsOf(base({ scope: "monthly", basis: "driver", driver: { ...monthlyDriver, key: "Pallets" } }))["driver.key"]).toBe("driver.key must be a short slug");
    expect(errorsOf(base({ scope: "monthly", basis: "driver", driver: { ...monthlyDriver, label: "" } }))["driver.label"]).toMatch(/1–200/);
    expect(errorsOf(base({ scope: "monthly", basis: "driver", driver: { ...monthlyDriver, unit: "x".repeat(41) } }))["driver.unit"]).toMatch(/1–40/);
    expect(errorsOf(base({ scope: "monthly", basis: "driver", driver: { ...monthlyDriver, kind: "weekly" } }))["driver.kind"]).toMatch(/driver.kind must be/);
    expect(errorsOf(base({ scope: "monthly", basis: "driver", driver: { ...monthlyDriver, extra: true } })).driver).toBe("driver has an unknown field");
  });

  it("billing periods and long-term storage apply to monthly quantities only", () => {
    const d = { key: "pallets_long", label: "Pallets held longer than 180 days", unit: "pallets", kind: "monthly_quantity" };
    const rule = (driver: Record<string, unknown>) => base({ key: "storage_long", scope: "monthly", basis: "driver", driver });
    expect(errorsOf(rule({ ...d, billingPeriod: "week" }))).toEqual({});
    expect(errorsOf(rule({ ...d, billingPeriod: "quarter" }))["driver.billingPeriod"]).toMatch(/month, week or day/);
    expect(errorsOf(rule({ ...d, kind: "returns_rate", billingPeriod: "week" }))["driver.billingPeriod"]).toMatch(/month, week or day/);
    expect(errorsOf(rule({ ...d, longTerm: { mode: "replace", replacesRuleKey: "storage_pallet", thresholdDays: 180 } }))).toEqual({});
    expect(errorsOf(rule({ ...d, longTerm: { mode: "replace", replacesRuleKey: "storage_pallet", thresholdDays: "180" } }))).toEqual({});
    expect(errorsOf(rule({ ...d, longTerm: { mode: "replace", replacesRuleKey: "storage_long", thresholdDays: 180 } }))["driver.longTerm.replacesRuleKey"]).toMatch(/another rule/);
    expect(errorsOf(rule({ ...d, longTerm: { mode: "discount", replacesRuleKey: "storage_pallet", thresholdDays: 180 } }))["driver.longTerm.mode"]).toMatch(/replace or surcharge/);
    expect(errorsOf(rule({ ...d, longTerm: { mode: "replace", replacesRuleKey: "storage_pallet", thresholdDays: 0 } }))["driver.longTerm.thresholdDays"]).toMatch(/1–3650/);
    expect(errorsOf(rule({ ...d, longTerm: { mode: "replace", replacesRuleKey: "storage_pallet", thresholdDays: 3651 } }))["driver.longTerm.thresholdDays"]).toMatch(/1–3650/);
    expect(errorsOf(rule({ ...d, kind: "returns_rate", longTerm: { mode: "replace", replacesRuleKey: "storage_pallet", thresholdDays: 180 } }))["driver.longTerm"]).toBe("longTerm applies to monthly quantities");
    expect(errorsOf(rule({ ...d, longTerm: { mode: "replace", replacesRuleKey: "storage_pallet", thresholdDays: 180, note: 1 } }))["driver.longTerm"]).toBe("longTerm has an unknown field");
  });

  it("minimum shape: required iff the basis is minimum, strict fields, closed categories", () => {
    const min = base({ key: "account_min", category: "account", scope: "monthly", basis: "minimum", method: "minimum", amount: null, minimum: minimum() });
    expect(errorsOf(min)).toEqual({});
    expect(errorsOf({ ...min, minimum: null }).minimum).toMatch(/required for account minimums/);
    expect(errorsOf(base({ minimum: minimum() })).minimum).toMatch(/not allowed otherwise/);
    expect(errorsOf({ ...min, method: "flat", amount: "500" }).method).toMatch(/minimum method/);
    expect(errorsOf({ ...min, amount: "500" }).amount).toBe("amount applies to flat rules only");
    expect(errorsOf({ ...min, minimum: minimum({ amount: "five hundred" }) })["minimum.amount"]).toMatch(/4 decimals/);
    expect(errorsOf({ ...min, minimum: minimum({ includesShipping: "yes" }) })["minimum.includesShipping"]).toBe("minimum.includesShipping must be true or false");
    expect(errorsOf({ ...min, minimum: minimum({ appliesTo: { categories: [] } }) })["minimum.appliesTo.includeRuleKeys"]).toBe("minimum.appliesTo.includeRuleKeys must be a list");
    expect(errorsOf({ ...min, minimum: minimum({ appliesTo: "all" }) })["minimum.appliesTo"]).toBe("minimum.appliesTo must list categories, includeRuleKeys and excludeRuleKeys");
    expect(errorsOf({ ...min, minimum: minimum({ appliesTo: { categories: ["shipping"], includeRuleKeys: [], excludeRuleKeys: [] } }) })["minimum.appliesTo.categories.0"]).toBe("minimum.appliesTo.categories has an unknown category");
    expect(errorsOf({ ...min, minimum: minimum({ appliesTo: { categories: [], includeRuleKeys: ["Pick Fee"], excludeRuleKeys: [] } }) })["minimum.appliesTo.includeRuleKeys.0"]).toBe("minimum rule keys must be slugs");
    expect(errorsOf({ ...min, minimum: minimum({ waived: true }) }).minimum).toBe("minimum has an unknown field");
    expect(errorsOf({ ...min, minimumCharge: "1" }).minimumCharge).toBe("a minimum charge applies to per-quantity rules only");
    expect(errorsOf({ ...min, method: "tiered", tiers: tiers([{ upTo: null, amount: "1" }]) }).method).toBeDefined();
  });

  it("trims text and turns empty optional fields into null", () => {
    const parsed = feeRuleInputSchema.parse(base({ name: "  Pick fee  ", description: "", helpText: "  Count every item.  ", exclusiveGroup: "", priority: "" }));
    expect(parsed.name).toBe("Pick fee");
    expect(parsed.description).toBeNull();
    expect(parsed.helpText).toBe("Count every item.");
    expect(parsed.exclusiveGroup).toBeNull();
    expect(parsed.priority).toBeNull();
    expect(errorsOf(base({ description: "x".repeat(2001) })).description).toBeDefined();
    expect(errorsOf(base({ helpText: "x".repeat(1001) })).helpText).toBeDefined();
  });
});

describe("fulfillmentAnswersSchema mirrors app.validate_fulfillment", () => {
  const answers = { skip: false, monthlyOrders: "1250", drivers: { pallets_stored: "12", long_term_pallets: null, returns_rate: "4.37" }, orderShares: { inserts: { sharePct: "40.00", countPerOrder: 3 }, kits: null }, packagingDefault: "box", orderContent: { rows: [{ units: 1, lines: 1, sharePct: "60.00" }, { units: 3, lines: 2, sharePct: "40" }] } };

  it("accepts a full answer set and the fixture scenarios' answers", () => {
    expect(fulfillmentAnswersSchema.safeParse(answers).success).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({}).success).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({ drivers: null, orderShares: null, orderContent: null, monthlyOrders: null, packagingDefault: null }).success).toBe(true);
    const scenarios = JSON.parse(readFileSync(new URL("scenarios.json", dir), "utf8")) as { monthly: { answers: unknown }[] };
    for (const sc of scenarios.monthly) expect(fulfillmentAnswersSchema.safeParse(sc.answers).success).toBe(true);
  });

  it("refuses unknown fields, out-of-range volumes, bad answers and bad content rows", () => {
    const fails = (v: unknown) => !fulfillmentAnswersSchema.safeParse(v).success;
    expect(fails({ ...answers, extra: 1 })).toBe(true);
    expect(fails({ monthlyOrders: "0" })).toBe(true);
    expect(fails({ monthlyOrders: "5000001" })).toBe(true);
    expect(fails({ monthlyOrders: "12.345" })).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({ monthlyOrders: "" }).data?.monthlyOrders).toBeNull();
    expect(fails({ drivers: { "Pallets Stored": "1" } })).toBe(true);
    expect(fails({ drivers: { pallets_stored: "twelve" } })).toBe(true);
    expect(fails({ drivers: { pallets_stored: "1.00001" } })).toBe(true);
    expect(fails({ drivers: { pallets_stored: "1000000001" } })).toBe(true);
    expect(fails({ drivers: { pallets_stored: 12 } })).toBe(true); // numbers are strings in the contract
    expect(fails({ orderShares: { inserts: { sharePct: "101", countPerOrder: 1 } } })).toBe(true);
    expect(fails({ orderShares: { inserts: { sharePct: "40.123", countPerOrder: 1 } } })).toBe(true);
    expect(fails({ orderShares: { inserts: { sharePct: "40", countPerOrder: 0 } } })).toBe(true);
    expect(fails({ orderShares: { inserts: { sharePct: "40", countPerOrder: 1001 } } })).toBe(true);
    expect(fails({ orderShares: { inserts: { sharePct: "40", countPerOrder: 1, extra: 1 } } })).toBe(true);
    expect(fails({ packagingDefault: "x".repeat(61) })).toBe(true);
    expect(fails({ orderContent: { rows: [] } })).toBe(true);
    expect(fails({ orderContent: { rows: [{ units: 1, lines: 2, sharePct: "100" }] } })).toBe(true);
    expect(fails({ orderContent: { rows: [{ units: 1, lines: 0, sharePct: "100" }] } })).toBe(true);
    expect(fails({ orderContent: { rows: [{ units: 1, lines: 1, sharePct: "60" }, { units: 2, lines: 1, sharePct: "40.01" }] } })).toBe(true);
    expect(fails({ orderContent: { rows: Array.from({ length: 13 }, () => ({ units: 1, lines: 1, sharePct: "7.69" })) } })).toBe(true);
    expect(fulfillmentAnswersSchema.safeParse({ orderContent: { rows: [{ units: 0, lines: 0, sharePct: "100.00" }] } }).success).toBe(true);
  });

  it("checks answered keys, returns rates and long-term quantities against the schedule", () => {
    const standard = schedules.standard!;
    const ok = fulfillmentAnswersSchema.parse({ drivers: { pallets_stored: "100", long_term_pallets: "20", returns_rate: "4.37" }, orderShares: { inserts: { sharePct: "40.00", countPerOrder: 3 } } });
    expect(fulfillmentAnswerProblems(ok, standard)).toEqual({});
    const bad = fulfillmentAnswersSchema.parse({ drivers: { pallets_stored: "10", long_term_pallets: "20", returns_rate: "101", bins: "3" }, orderShares: { inserts: null, kits: { sharePct: "1", countPerOrder: 1 } } });
    expect(fulfillmentAnswerProblems(bad, standard)).toEqual({
      "drivers.long_term_pallets": "This cannot exceed the total pallets stored (10).",
      "drivers.returns_rate": "A returns rate is a percent of orders (0–100).",
      "drivers.bins": "This question is not on the fee schedule.",
      "orderShares.kits": "This question is not on the fee schedule.",
    });
    // An unanswered stored quantity cannot be exceeded; "0" is an answer.
    expect(fulfillmentAnswerProblems(fulfillmentAnswersSchema.parse({ drivers: { long_term_pallets: "20" } }), standard)).toEqual({});
    expect(fulfillmentAnswerProblems(fulfillmentAnswersSchema.parse({ drivers: { pallets_stored: "0", long_term_pallets: "0" } }), standard)).toEqual({});
  });
});

describe("tryOrderInputSchema and the engine conversion", () => {
  it("parses a typed order, converts dollars to E4 and pins monthly-volume rates from stated volumes", () => {
    const parsed = tryOrderInputSchema.parse({ units: "3", lines: 2, distinctSkus: null, packages: [{ packagingType: "Box" }, { packagingType: "" }], shipments: "1", shipping: { total: "10.00", baseFreight: "", estimated: true }, orderShares: { inserts: { sharePct: "40", countPerOrder: "2" } }, monthlyQuantities: { order: "3000", unit: "" }, packagingDefault: "poly mailer" });
    const { input, context } = tryOrderToEngine(parsed, schedules.tiers!);
    expect(input).toEqual({ units: 3, lines: 2, distinctSkus: null, packages: [{ packagingType: "Box" }, { packagingType: null }], shipments: 1, shipping: { totalE4: 100000, baseFreightE4: 100000, estimated: true, hasExposure: false }, assumed: {}, ordinal: 1 });
    expect(context.orderShares).toEqual({ inserts: { sharePct: "40", countPerOrder: 2 } });
    expect(context.packagingDefault).toBe("poly mailer");
    // RULES.md E at Q = 3,000: graduated (1,000 × 3 + 2,000 × 2.5) / 3,000 = 2.6667; volume: the 2.50 bracket.
    expect(context.pinnedRates).toEqual({ pick_monthly_graduated: { rateE4: 26667, monthlyQuantity: "3000" }, pick_monthly_volume: { rateE4: 25000, monthlyQuantity: "3000" } });
  });

  it("leaves unknown quantities unknown and refuses malformed input", () => {
    const parsed = tryOrderInputSchema.parse({ units: null, lines: "", distinctSkus: undefined, packages: [], shipping: null, packagingDefault: null });
    expect(parsed.units).toBeNull();
    expect(parsed.lines).toBeNull();
    expect(parsed.distinctSkus).toBeNull();
    expect(parsed.shipments).toBe(1);
    expect(parsed.ordinal).toBe(1);
    expect(tryOrderToEngine(parsed, schedules.standard!).context.pinnedRates).toEqual({});
    expect(tryOrderInputSchema.safeParse({ units: -1, packages: [], shipping: null, packagingDefault: null }).success).toBe(false);
    expect(tryOrderInputSchema.safeParse({ units: 1, packages: [], shipping: { total: "ten" }, packagingDefault: null }).success).toBe(false);
    expect(tryOrderInputSchema.safeParse({ units: 1, packages: Array.from({ length: 51 }, () => ({ packagingType: "box" })), shipping: null, packagingDefault: null }).success).toBe(false);
  });
});
