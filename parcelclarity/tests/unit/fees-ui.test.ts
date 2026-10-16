import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NOT_SUPPORTED_ITEMS, NotSupportedPanel } from "@/components/fees/not-supported";
import { PRESETS, blank, buildInput, splitTypes, valuesFromRule, type Values } from "@/components/fees/rule-model";
import { FeeScheduleView, describeEffectivity, describeRounding } from "@/components/fees/schedule-view";
import { dollars, moneyE4, resolveMinimumMembers, slugify, textOf, tidy } from "@/components/fees/shared";
import { buildTryOrderInput, tryOrderShape, type TryFields } from "@/components/fees/try-order-model";
import { calculateMonthlyFees, calculateOrderFees } from "@/engine/fees";
import type { FeeRule, FeeScheduleSnapshot, OrderFeeContext } from "@/engine/fees/types";
import { D } from "@/engine/money";
import { feeRuleInputSchema, rowToSnapshotRule, ruleFieldErrors, ruleFormToRow, snapshotRuleToForm, tryOrderInputSchema, tryOrderProblems, tryOrderToEngine } from "@/lib/fees/schema";

/**
 * The fee-schedule screens' pure parts: the rule editor's model (form ⇄ schema input, presets), the
 * "Try an order" request shape, and the customer's fee-schedule view. Expectations that involve money
 * were worked out by hand from the fixtures' rates (tests/fixtures/fees/RULES.md), never from the code.
 */
const dir = new URL("../fixtures/fees/", import.meta.url);
const schedules = JSON.parse(readFileSync(new URL("schedules.json", dir), "utf8")) as Record<string, FeeScheduleSnapshot>;
const standard = schedules.standard!;

/** Visible text of rendered markup: tags dropped, the few entities React emits decoded. */
function textOfHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ");
}

function schedule(rules: FeeRule[], over: Partial<FeeScheduleSnapshot> = {}): FeeScheduleSnapshot {
  return { scheduleId: "s", name: "Test", versionId: "v", versionNumber: 1, effectiveDate: "2026-01-01", expirationDate: null, rounding: "invoice_line", ...over, rules };
}

/** A rule the way the editor builds it: a preset (or a blank form), the typed amounts, the schema, the snapshot shape. */
function built(patch: Partial<Values>, position = 0): FeeRule {
  const v: Values = { ...blank(), ...patch };
  if (!v.key) v.key = slugify(v.name);
  const parsed = feeRuleInputSchema.safeParse(buildInput(v));
  if (!parsed.success) throw new Error(`form does not validate: ${JSON.stringify(ruleFieldErrors(parsed.error))}`);
  return rowToSnapshotRule(ruleFormToRow(parsed.data, { versionId: "v", tenantId: "t", position }));
}
const preset = (id: string, patch: Partial<Values>, position = 0): FeeRule => {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return built({ ...p.values, ...patch }, position);
};

const noContext: OrderFeeContext = { orderShares: {}, pinnedRates: {}, packagingDefault: null };
const order = (over: Partial<Parameters<typeof calculateOrderFees>[0]> = {}): Parameters<typeof calculateOrderFees>[0] => ({
  units: 1,
  lines: 1,
  distinctSkus: 1,
  packages: [{ packagingType: null }],
  shipments: 1,
  shipping: null,
  assumed: {},
  ordinal: 1,
  ...over,
});

// ---------------------------------------------------------------------------
describe("shared helpers", () => {
  it("shows rates exactly, to the fraction of a cent they need", () => {
    expect(moneyE4(12500)).toBe("$1.25");
    expect(moneyE4(125)).toBe("$0.0125");
    expect(moneyE4(0)).toBe("$0.00");
    expect(moneyE4(-30000)).toBe("−$3.00");
    expect(dollars("2.5000")).toBe("$2.50");
    expect(dollars("0.0125")).toBe("$0.0125");
    expect(dollars(null)).toBe("—");
    expect(dollars("")).toBe("—");
  });

  it("tidies numeric text from the database", () => {
    expect(tidy("2.5000")).toBe("2.5");
    expect(tidy("15.0000")).toBe("15");
    expect(tidy("0")).toBe("0");
    expect(textOf(1.25)).toBe("1.25");
    expect(textOf("100")).toBe("100");
    expect(textOf(null)).toBe("");
    expect(textOf(undefined)).toBe("");
  });

  it("derives keys the schema accepts", () => {
    const slug = /^[a-z][a-z0-9_]{0,60}$/;
    for (const name of ["Pick & pack, per order", "Poly mailer", "3PL handling (rush)", "  ", "Receiving – per pallet", "A".repeat(200)]) {
      const key = slugify(name);
      if (key) expect(key, name).toMatch(slug);
    }
    expect(slugify("Pick & pack, per order")).toBe("pick_and_pack_per_order");
    expect(slugify("3PL handling")).toBe("r_3pl_handling");
    expect(slugify("   ")).toBe("");
  });

  it("resolves the minimum's members exactly as activation does", () => {
    for (const [name, sched] of Object.entries(schedules)) {
      if (name.startsWith("_")) continue;
      for (const rule of sched.rules.filter((r) => r.basis === "minimum" && r.minimum)) {
        expect(resolveMinimumMembers(sched.rules, rule.minimum!).map((r) => r.key), `${name}.${rule.key}`).toEqual(rule.resolvedRuleKeys);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("rule editor model: form ⇄ schema input", () => {
  const NUMERIC = new Set(["amount", "percent", "includedQuantity", "minimumCharge", "upTo"]);
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
    if (key && NUMERIC.has(key) && (typeof value === "string" || typeof value === "number")) return new D(value).toFixed();
    return value;
  }

  const fixtureRules = Object.entries(schedules)
    .filter(([k]) => !k.startsWith("_"))
    .flatMap(([name, s]) => s.rules.map((rule) => ({ name, rule })));

  it("can express every rule the engine fixtures use, without losing anything", () => {
    expect(fixtureRules.length).toBeGreaterThan(30);
    for (const { name, rule } of fixtureRules) {
      const parsed = feeRuleInputSchema.safeParse(buildInput(valuesFromRule(rule, null)));
      expect(parsed.success, `${name}.${rule.key}: ${parsed.success ? "" : JSON.stringify(ruleFieldErrors(parsed.error))}`).toBe(true);
      if (!parsed.success) continue;
      expect(canonical(parsed.data), `${name}.${rule.key}`).toEqual(canonical(snapshotRuleToForm(rule)));
    }
  });

  it("never sends a field that does not apply to the chosen basis and method", () => {
    // A stale value left in a hidden control must not reach the server.
    const stale: Partial<Values> = { includedQuantity: "1", includedPer: "line", minimumCharge: "5", minUnits: "2", exclusiveGroup: "g", priority: "1", amount: "9", percent: "7", driverKey: "x", driverLabel: "y", driverUnit: "z" };

    const tiered = buildInput({ ...blank(), ...stale, name: "T", key: "t", basis: "unit", method: "tiered", brackets: [{ upTo: "5", amount: "1" }, { upTo: "", amount: "0.5" }] });
    expect(tiered.amount).toBeNull();
    expect(tiered.percent).toBeNull();
    expect(tiered.includedQuantity).toBeNull(); // a tiered rule has no allowance
    expect(tiered.includedPer).toBeNull();
    expect(tiered.driver).toBeNull();
    expect(tiered.minimum).toBeNull();
    expect((tiered.tiers as { brackets: { upTo: string | null }[] }).brackets.map((b) => b.upTo)).toEqual(["5", null]); // the last bracket is open-ended

    const percent = buildInput({ ...blank(), ...stale, name: "P", key: "p", basis: "shipping_percent", method: "percent", percent: "5" });
    expect(percent.amount).toBeNull();
    expect(percent.includedQuantity).toBeNull();
    expect(percent.minimumCharge).toBeNull(); // not allowed on a percent rule
    expect(percent.percentBase).toBe("shipping_total");

    const monthly = buildInput({ ...blank(), ...stale, name: "M", key: "m", scope: "monthly", basis: "month", method: "flat", amount: "99" });
    expect(monthly.amount).toBe("99");
    expect(monthly.conditions).toBeNull();
    expect(monthly.exclusiveGroup).toBeNull();
    expect(monthly.priority).toBeNull();
    expect(monthly.includedQuantity).toBeNull();
    expect(monthly.minimumCharge).toBeNull();
    expect(monthly.driver).toBeNull();

    const noAllowance = buildInput({ ...blank(), name: "O", key: "o", basis: "unit", amount: "1", includedQuantity: "" });
    expect(noAllowance.includedQuantity).toBe("");
    expect(noAllowance.includedPer).toBeNull(); // an allowance unit without a quantity is refused by the schema
  });

  it("normalises packaging types the way the engine matches them", () => {
    expect(splitTypes("Poly Mailer, BOX\n  Padded  Envelope ,*")).toEqual(["poly mailer", "box", "padded envelope", "*"]);
    expect(splitTypes("")).toEqual([]);
    const rule = built({ name: "Boxes", key: "boxes", basis: "package", amount: "0.85", packagingTypes: "Box, Carton" });
    expect(rule.conditions?.packagingTypes).toEqual(["box", "carton"]);
  });

  it("shows the problems the server would raise, on the fields the form has", () => {
    const errorsOf = (patch: Partial<Values>) => {
      const parsed = feeRuleInputSchema.safeParse(buildInput({ ...blank(), name: "R", key: "r", ...patch }));
      return parsed.success ? {} : ruleFieldErrors(parsed.error);
    };
    expect(errorsOf({ basis: "unit", amount: "" })).toHaveProperty("amount");
    expect(errorsOf({ basis: "unit", amount: "1.23456" })).toHaveProperty("amount"); // more than 4 decimals
    expect(errorsOf({ basis: "unit", amount: "-1" })).toHaveProperty("amount"); // no credits
    expect(errorsOf({ basis: "shipping_percent", method: "percent", percent: "" })).toHaveProperty("percent");
    expect(errorsOf({ basis: "shipping_percent", method: "percent", percent: "1001" })).toHaveProperty("percent");
    expect(errorsOf({ exclusiveGroup: "packaging", priority: "", basis: "order", amount: "1" })).toHaveProperty("priority");
    expect(errorsOf({ basis: "unit", method: "tiered", brackets: [{ upTo: "10", amount: "1" }, { upTo: "", amount: "2" }, { upTo: "", amount: "3" }] })).toHaveProperty("tiers.brackets.1.upTo");
    expect(errorsOf({ basis: "unit", method: "tiered", brackets: [{ upTo: "10", amount: "1" }, { upTo: "5", amount: "2" }, { upTo: "", amount: "3" }] })).toHaveProperty("tiers.brackets.1.upTo"); // must ascend
    expect(errorsOf({ scope: "monthly", basis: "driver", amount: "1", driverKey: "", driverLabel: "", driverUnit: "" })).toHaveProperty("driver.key");
    expect(errorsOf({ scope: "monthly", basis: "driver", amount: "1", driverKey: "k", driverLabel: "Q", driverUnit: "pallets", longTerm: true, ltReplaces: "", ltDays: "180" })).toHaveProperty("driver.longTerm.replacesRuleKey");
    expect(errorsOf({ scope: "monthly", basis: "minimum", method: "minimum", minAmount: "" })).toHaveProperty("minimum.amount");
    expect(errorsOf({ basis: "unit", amount: "1", minUnits: "5", maxUnits: "2" })).toHaveProperty("conditions.minUnits");
    expect(errorsOf({ basis: "unit", amount: "1", includedQuantity: "1", method: "tiered", brackets: [{ upTo: "", amount: "1" }] })).toEqual({}); // the allowance is dropped for tiers, not refused
  });
});

// ---------------------------------------------------------------------------
describe("presets", () => {
  it("never carry an amount: the 3PL types every number", () => {
    for (const p of PRESETS) {
      expect(p.values.amount ?? "", p.id).toBe("");
      expect(p.values.percent ?? "", p.id).toBe("");
      expect(p.values.minAmount ?? "", p.id).toBe("");
      expect(p.values.minimumCharge ?? "", p.id).toBe("");
    }
  });

  it("are refused until an amount is entered, then validate", () => {
    const withAmounts: Record<string, Partial<Values>> = {
      first_pick: { amount: "2.5" },
      additional_units: { amount: "0.5" },
      per_line: { amount: "0.4" },
      additional_packages: { amount: "0.3" },
      percent_shipping: { percent: "5" },
      storage: { amount: "15" },
      long_term: { amount: "22", ltReplaces: "storage_pallet" },
      receiving_pallet: { amount: "12" },
      returns: { amount: "3" },
      minimum: { minAmount: "500", minCategories: ["pick_pack"] },
      flat_monthly: { amount: "99" },
    };
    expect(PRESETS.map((p) => p.id).sort()).toEqual(Object.keys(withAmounts).sort());
    for (const p of PRESETS) {
      const base: Values = { ...blank(), ...p.values, key: slugify(p.values.name ?? ""), ltReplaces: p.id === "long_term" ? "storage_pallet" : "" };
      expect(feeRuleInputSchema.safeParse(buildInput(base)).success, `${p.id} without an amount`).toBe(false);
      expect(() => built({ ...p.values, ...withAmounts[p.id], key: slugify(p.values.name ?? "") }), p.id).not.toThrow();
    }
  });

  it("price orders the way their names say", () => {
    // "First pick included" + "Additional units": $2.50 an order, $0.50 for each item after the first.
    const pick = schedule([preset("first_pick", { amount: "2.5" }, 0), preset("additional_units", { amount: "0.5" }, 1)]);
    expect(calculateOrderFees(order({ units: 1 }), pick, noContext).definiteE4).toBe(25000);
    expect(calculateOrderFees(order({ units: 3 }), pick, noContext).definiteE4).toBe(35000);
    expect(calculateOrderFees(order({ units: 7 }), pick, noContext).definiteE4).toBe(55000);

    // "Per line, first unit of each line free" with a per-line fee: 2 lines holding 3 + 1 units = $1.00 × 2 + $0.40 × 2 = $2.80.
    const perLine = schedule([built({ name: "First unit of each line", basis: "line", amount: "1" }, 0), preset("per_line", { amount: "0.4" }, 1)]);
    const result = calculateOrderFees(order({ units: 4, lines: 2, distinctSkus: 2 }), perLine, noContext);
    expect(result.definiteE4).toBe(28000);
    expect(result.status).toBe("ok");
    // A file with no line data does not pay $0 for the allowance: the rule is left out and listed.
    const noLines = calculateOrderFees(order({ units: 4, lines: null, distinctSkus: null }), perLine, noContext);
    expect(noLines.unresolved.map((u) => u.reason)).toContain("lines_unknown");
    expect(noLines.lines.every((l) => l.ruleKey !== "additional_units_within_a_line")).toBe(true);

    // "Additional packages": the first package of an order is included.
    const packages = schedule([preset("additional_packages", { amount: "0.3" })]);
    expect(calculateOrderFees(order({ packages: [{ packagingType: "box" }, { packagingType: "box" }, { packagingType: "box" }] }), packages, noContext).definiteE4).toBe(6000);
    expect(calculateOrderFees(order({ packages: [{ packagingType: "box" }] }), packages, noContext).lines).toEqual([]);

    // "Percent of shipping": 5% of a $10.00 shipping cost.
    const handling = schedule([preset("percent_shipping", { percent: "5" })]);
    const shipping = { totalE4: 100000, baseFreightE4: 90000, estimated: false, hasExposure: false };
    expect(calculateOrderFees(order({ shipping }), handling, noContext).definiteE4).toBe(5000);
    expect(calculateOrderFees(order({ shipping: null }), handling, noContext).unresolved.map((u) => u.reason)).toEqual(["shipping_unknown"]);
  });

  it("price a month the way their names say", () => {
    const monthlyRules = schedule([
      preset("storage", { amount: "15" }, 0),
      preset("long_term", { amount: "22", ltReplaces: "pallet_storage" }, 1),
      preset("receiving_pallet", { amount: "12" }, 2),
      preset("returns", { amount: "3" }, 3),
      preset("flat_monthly", { amount: "99" }, 4),
    ]);
    // 10 pallets stored, 4 of them long-term: 6 × $15 + 4 × $22 = $178. 3 pallets received = $36. 5 returns per 100 orders at 1,000 orders = 50 × $3 = $150. Flat $99.
    const answers = { drivers: { pallets_stored: "10", long_term_pallets: "4", pallets_received: "3", returns_rate: "5" }, orderShares: {} };
    const result = calculateMonthlyFees(answers, monthlyRules, new D(1000));
    const byName = Object.fromEntries(result.lines.map((l) => [l.name, l.amountE4]));
    expect(byName).toEqual({ "Pallet storage": 900000, "Long-term pallet storage": 880000, "Pallet receiving": 360000, "Returns processing": 1500000, "Account administration": 990000 });
    expect(result.notModeled).toEqual([]);
    // An unanswered question is not modeled, never $0.
    const unanswered = calculateMonthlyFees({ drivers: { pallets_stored: "10", long_term_pallets: "4" }, orderShares: {} }, monthlyRules, new D(1000));
    expect(unanswered.notModeled.map((n) => n.name).sort()).toEqual(["Pallet receiving", "Returns processing"]);
  });

  it("long-term storage asks its question once, as part of the standard quantity", () => {
    const standardStorage = preset("storage", { amount: "15" }, 0);
    const longTerm = preset("long_term", { amount: "22", ltReplaces: standardStorage.key }, 1);
    expect(longTerm.driver?.longTerm).toEqual({ mode: "replace", replacesRuleKey: standardStorage.key, thresholdDays: 180 });
    expect(longTerm.driver?.unit).toBe(standardStorage.driver?.unit);
  });
});

// ---------------------------------------------------------------------------
describe("'Try an order' request", () => {
  const empty: TryFields = { units: "", lines: "", products: "", packages: [{ type: "" }], packagingDefault: "", shipments: "", shipTotal: "", baseFreight: "", estimated: false, shares: {}, shareKeys: ["inserts"], monthly: {}, tierBases: ["order"], ordinal: "1" };

  it("reads what the version asks for", () => {
    expect(tryOrderShape(standard.rules)).toEqual({ shareDrivers: [["inserts", "Orders that get marketing inserts"]], tierBases: [] });
    const tiers = schedules.tiers!;
    expect(tryOrderShape(tiers.rules).tierBases.sort()).toEqual(["order"]);
  });

  it("sends blanks as unknown, which the server reads as null, never zero", () => {
    const parsed = tryOrderInputSchema.parse(buildTryOrderInput(empty));
    expect(parsed.units).toBeNull();
    expect(parsed.lines).toBeNull();
    expect(parsed.distinctSkus).toBeNull();
    expect(parsed.shipping).toBeNull();
    expect(parsed.shipments).toBe(1);
    expect(parsed.packages).toEqual([{ packagingType: null }]);
    expect(parsed.packagingDefault).toBeNull();
    expect(parsed.orderShares).toEqual({ inserts: null });
    expect(parsed.monthlyQuantities.order).toBeNull();
    expect(parsed.ordinal).toBe(1);

    const { input, context } = tryOrderToEngine(parsed, standard);
    const result = calculateOrderFees(input, standard, context);
    const reasons = new Set(result.unresolved.map((u) => u.reason));
    expect(reasons.has("units_unknown")).toBe(true);
    expect(reasons.has("shipping_unknown")).toBe(true);
    expect(reasons.has("assumption_missing")).toBe(true);
    // Only fees that need no unknown are charged: the per-order fee.
    expect(result.lines.map((l) => l.ruleKey)).toEqual(["pick_order"]);
    expect(result.status).toBe("partial");
  });

  it("prices a described order on the version", () => {
    const parsed = tryOrderInputSchema.parse(
      buildTryOrderInput({ ...empty, units: "3", lines: "2", products: "2", packages: [{ type: "Poly Mailer" }], shipments: "1", shipTotal: "10", shares: { inserts: { sharePct: "100", count: "2" } } }),
    );
    expect(tryOrderProblems(parsed, standard)).toEqual({});
    const { input, context } = tryOrderToEngine(parsed, standard);
    const result = calculateOrderFees(input, standard, context);
    // $2.50 order + 2 × $0.50 after the first item + $0.30 poly mailer + 1 chargeable insert × $0.25 + 5% of $10.00 shipping.
    expect(result.lines.map((l) => [l.ruleKey, l.amountE4, l.chargeClass])).toEqual([
      ["pick_order", 25000, "definite"],
      ["pick_additional", 10000, "definite"],
      ["pack_mailer", 3000, "definite"],
      ["inserts", 2500, "estimated"],
      ["handling_pct", 5000, "definite"],
    ]);
    expect(result.definiteE4).toBe(43000);
    expect(result.estimatedE4).toBe(2500);
    expect(result.status).toBe("ok");
    // The box rule does not match a poly mailer; the catch-all matched but lost to the mailer's lower priority, so only it is listed.
    expect(result.unresolved.map((u) => [u.ruleKey, u.reason, u.replacedBy])).toEqual([["pack_other", "replaced", "pack_mailer"]]);
  });

  it("names the field when a number is wrong", () => {
    const bad = tryOrderInputSchema.safeParse(buildTryOrderInput({ ...empty, units: "three", shipTotal: "abc", shares: { inserts: { sharePct: "150", count: "2" } } }));
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const paths = Object.keys(ruleFieldErrors(bad.error));
      expect(paths).toContain("units");
      expect(paths).toContain("shipping.total");
      expect(paths.some((p) => p.startsWith("orderShares.inserts"))).toBe(true);
    }
    // A base rate without a total is sent as typed so the server can say the total is missing.
    const baseOnly = tryOrderInputSchema.safeParse(buildTryOrderInput({ ...empty, baseFreight: "7" }));
    expect(baseOnly.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("customer's fee schedule view", () => {
  // The brand's snapshot as the database returns it, with internal markers that must never reach the page.
  const SENTINELS = { scheduleId: "SCHED-SENTINEL-1234", versionId: "VERSION-SENTINEL-5678", versionNumber: 4242 };
  const withIds: FeeScheduleSnapshot = {
    ...standard,
    ...SENTINELS,
    effectiveDate: "2026-03-01",
    rules: standard.rules.map((r, i) => ({
      ...r,
      id: `RULE-ID-SENTINEL-${i}`,
      description: r.key === "pick_order" ? "Covers picking the first item and packing the order." : r.description,
      helpText: r.key === "storage_pallet" ? "Count the pallets in your cage on the first of the month." : r.helpText,
    })),
  };
  const brand = textOfHtml(renderToStaticMarkup(createElement(FeeScheduleView, { snapshot: withIds, audience: "brand" })));
  const brandHtml = renderToStaticMarkup(createElement(FeeScheduleView, { snapshot: withIds, audience: "brand" }));

  it("never prints rule keys, ids or version numbers", () => {
    for (const sentinel of [...Object.values(SENTINELS).map(String), "RULE-ID-SENTINEL"]) {
      expect(brandHtml).not.toContain(sentinel);
    }
    // Keys that are not plain words (they contain an underscore) cannot appear in the text or in any attribute.
    for (const rule of standard.rules) {
      if (rule.key.includes("_")) expect(brandHtml, rule.key).not.toContain(rule.key);
      if (rule.driver?.key.includes("_")) expect(brandHtml, rule.driver.key).not.toContain(rule.driver.key);
    }
    expect(brand).not.toMatch(/version\s*\d/i);
    expect(brand).not.toMatch(/source|staff|note/i);
  });

  it("groups charges by category in the schedule's order, each in the customer's words", () => {
    const headings = [...brandHtml.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => textOfHtml(m[1] ?? "").trim());
    expect(headings).toEqual(["Pick & pack", "Packaging", "Receiving", "Storage", "Returns", "Account", "Other"]);
    expect(brand).toContain("$2.50 per order.");
    expect(brand).toContain("$0.50 per item after the first"); // the allowance wording is describeFeeRule's
    expect(brand).toContain("$0.30 per package, only for packaging: poly mailer.");
    expect(brand).toContain("5% of the shipping cost of each order.");
    expect(brand).toContain("$15.00 per pallet per month.");
    expect(brand).toContain("$99.00 a month.");
    expect(brand).toContain("Covers picking the first item and packing the order.");
  });

  it("says what the customer is asked, and with the 3PL's help text", () => {
    expect(brand).toContain("Depends on what you tell us: Pallets of your products stored, on average");
    expect(brand).toContain("Count the pallets in your cage on the first of the month.");
    expect(brand).toContain("Only one of these applies each time: Poly mailer, Box, Other packaging.");
  });

  it("lists the minimum's members by name", () => {
    const from = brandHtml.indexOf("Fees counted toward this minimum");
    expect(from).toBeGreaterThan(0);
    const members = textOfHtml(brandHtml.slice(from, brandHtml.indexOf("</ul>", from)));
    for (const name of ["Pick & pack, per order", "Each additional item", "Poly mailer", "Box", "Other packaging", "Pallet storage", "Long-term pallet storage (over 180 days)", "Pallet receiving", "Loose carton receiving"]) {
      expect(members, name).toContain(name);
    }
    for (const name of ["Account administration", "Returns processing", "Marketing inserts", "Shipping handling"]) expect(members, name).not.toContain(name);
  });

  it("states the dates and the rounding", () => {
    expect(brand).toContain("In effect from Mar 1, 2026, with no end date.");
    expect(brand).toContain(describeRounding("invoice_line"));
    expect(describeEffectivity("2026-01-01", "2026-12-31", "brand")).toBe("In effect Jan 1, 2026 – Dec 31, 2026.");
    expect(describeRounding("transaction")).toBe("The fee on each order is rounded to the nearest cent.");
  });

  it("previews a draft for staff: dates and the minimum's members are fixed at activation", () => {
    const draft: FeeScheduleSnapshot = { ...standard, effectiveDate: null as unknown as string, rules: standard.rules.map(({ resolvedRuleKeys: _omit, ...r }) => ({ ...r })) };
    const staff = textOfHtml(renderToStaticMarkup(createElement(FeeScheduleView, { snapshot: draft, audience: "staff" })));
    expect(staff).toContain("Dates are set when this version is activated.");
    expect(staff).toContain("Which fees count is fixed when the version is activated.");
    expect(staff.slice(staff.indexOf("Fees counted toward this minimum"))).toContain("Pallet storage");
    // The customer never reads those sentences.
    const asBrand = textOfHtml(renderToStaticMarkup(createElement(FeeScheduleView, { snapshot: draft, audience: "brand" })));
    expect(asBrand).not.toContain("when this version is activated");
    expect(describeEffectivity(null, null, "brand")).toBe("");
  });

  it("says so when a draft has no rules", () => {
    expect(textOfHtml(renderToStaticMarkup(createElement(FeeScheduleView, { snapshot: { ...standard, rules: [] }, audience: "staff" })))).toContain("no rules yet");
  });
});

// ---------------------------------------------------------------------------
describe("what the tool cannot model", () => {
  it("lists design section 0's deferred items unchanged", () => {
    expect(NOT_SUPPORTED_ITEMS).toEqual([
      "seasonal windows inside a version (use a version per season)",
      "weight- or value-based handling fees",
      "discounts/credits (amounts ≥ 0 only)",
      "fees as a percent of another fee",
      "per-hour special projects (quoted outside the tool)",
      "inventory dimensions / per-SKU storage from dimensions",
      "peak-based storage billing (quantities are average occupancy)",
      "nested minimums (sets must be disjoint)",
      "per-receipt size lists (receipt fees assume equal receipts)",
      "return shipping postage",
      "delivery-area/remote surcharges in forecasts (need ZIP codes)",
      "dependent mixes (segments)",
      "prospects without a brand record",
      "spreadsheet import of fee schedules",
    ]);
  });

  it("renders every item in a disclosure the keyboard can open", () => {
    const html = renderToStaticMarkup(createElement(NotSupportedPanel));
    expect(html).toMatch(/^<details/);
    expect(html).toContain("<summary");
    const text = textOfHtml(html);
    for (const item of NOT_SUPPORTED_ITEMS) expect(text, item).toContain(item);
  });
});
