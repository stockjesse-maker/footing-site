import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { calculateShipment } from "@/engine";
import { calculateOrderFees } from "@/engine/fees";
import type { FeeScheduleSnapshot } from "@/engine/fees/types";
import type { ShipmentCalculation } from "@/engine/types";
import { CalculationResult, OrderFeesSection, feesTotalText } from "@/components/pricing/calculation-result";
import { BoxBlock, BoxNote } from "@/components/pricing/calculator-form";
import type { BrandFeeSchedule } from "@/lib/fees/queries";
import {
  BOX_COUNT_MAX,
  PACKAGING_OTHER,
  boxFromDrafts,
  boxOptionsFromSnapshot,
  boxProblems,
  boxSchema,
  boxToOrderFeeInput,
  calculatorBoxRequestSchema,
  calculatorRequestSchema,
  describeBox,
  emptyBoxDrafts,
  offeredPackaging,
  parseCount,
  shippingInputFromCalculation,
  type CalculatorBox,
  type CalculatorFeesResponse,
  type OrderFeesView,
} from "@/lib/pricing/calculator-schema";
import { priceOrderFees } from "@/lib/pricing/customer-safe";
import { fixtureContext } from "../fixtures/pricing/load";

/**
 * The calculator's "What's in the box" block: the box schema, the form's drafts, the options a fee
 * schedule offers, the mapping of the box into the fee engine's input, and the customer-safe fee view.
 * Money expectations were worked out by hand from the fixture rates (tests/fixtures/fees/RULES.md), never
 * from the code: standard schedule = pick $2.50 per order, $0.50 per item after the first, poly mailer
 * $0.30 / box or carton $0.85 / any other packaging $0.60 (group, priority 1 / 2 / 9), inserts $0.25 each
 * after the first, handling 5% of shipping; the fixture UPS Ground shipment costs $11.07 + $5.00 + $2.49 =
 * $18.56 with $21.00 of address-correction exposure that is not counted.
 */
// The result component imports the rate-card editor's verification badge, whose module graph reaches server actions
// (session, Supabase, environment). Only staff reference lines use it, and none of these tests render them.
vi.mock("@/components/pricing/rule-form", () => ({ VerificationBadge: () => null }));
// The form imports the calculator and scenario server actions; rendering the box block calls neither.
vi.mock("@/app/actions/calculator", () => ({ priceShipment: async () => ({ ok: false }), loadCalculatorBox: async () => ({ status: "unavailable" }) }));
vi.mock("@/app/actions/modeling", () => ({ saveSingleScenario: async () => ({ ok: false }) }));

const dir = new URL("../fixtures/fees/", import.meta.url);
const schedules = JSON.parse(readFileSync(new URL("schedules.json", dir), "utf8")) as Record<string, FeeScheduleSnapshot>;
const standard = schedules.standard!;
const lineSchedule = schedules.lines!;
const tiers = schedules.tiers!;
const monthlyOnly = schedules.storage_surcharge!;

const RATE_CARD = "3f6c1c1e-2b7a-4c53-8d1e-9a3f2a1b4c5d";
const baseRequest = {
  rateCardId: RATE_CARD,
  shipDate: "2026-10-15",
  originZip: "90001",
  destinationZip: "85001",
  residential: true,
  service: "ups/ground",
  packages: [{ weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" }],
};

function shipment(): ShipmentCalculation {
  return calculateShipment(
    {
      shipDate: "2026-10-15",
      originZip: "90001",
      destinationZip: "85001",
      residential: true,
      carrierCode: "ups",
      serviceCode: "ground",
      packages: [{ weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" }],
    },
    fixtureContext(),
  );
}

const okSchedule = (activeVersion: FeeScheduleSnapshot): BrandFeeSchedule => ({ status: "ok", assignment: null, schedule: { id: "s", name: activeVersion.name, description: null }, activeVersion });

function computed(response: CalculatorFeesResponse): (OrderFeesView | null)[] {
  if (response.status !== "computed") throw new Error(`expected computed, got ${response.status}`);
  return response.byService;
}

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) => (result.success ? [] : result.error!.issues.map((i) => i.path.join(".")));

// ---------------------------------------------------------------------------
describe("box schema", () => {
  it("accepts the items alone, and every field together", () => {
    expect(boxSchema.safeParse({ units: 3 }).success).toBe(true);
    const full = boxSchema.safeParse({ units: 5, products: 3, lines: 4, packaging: "poly mailer", counts: { inserts: 2, kits: 0 } });
    expect(full.success).toBe(true);
    expect(full.data).toEqual({ units: 5, products: 3, lines: 4, packaging: "poly mailer", counts: { inserts: 2, kits: 0 } });
    // The boundaries: products = items, lines = items, products = lines are all fine.
    expect(boxSchema.safeParse({ units: 3, products: 3, lines: 3 }).success).toBe(true);
    expect(boxSchema.safeParse({ units: BOX_COUNT_MAX }).success).toBe(true);
  });

  it("normalises the packaging type and accepts null for 'Not sure'", () => {
    expect(boxSchema.parse({ units: 1, packaging: "  Poly_Mailer " }).packaging).toBe("poly mailer");
    expect(boxSchema.parse({ units: 1, packaging: PACKAGING_OTHER }).packaging).toBe(PACKAGING_OTHER);
    expect(boxSchema.parse({ units: 1, packaging: null }).packaging).toBeNull();
  });

  it("rejects items that are not whole numbers of at least 1", () => {
    for (const units of [0, -1, 1.5, BOX_COUNT_MAX + 1, Number.NaN, "3", null]) {
      expect(boxSchema.safeParse({ units }).success, `units ${String(units)}`).toBe(false);
    }
    expect(boxSchema.safeParse({}).success).toBe(false);
  });

  it("rejects more different products than items (the inline validation, enforced on the server)", () => {
    const r = boxSchema.safeParse({ units: 3, products: 4 });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["products"]);
    expect(r.error!.issues[0]!.message).toBe("Different products can't be more than the items in the box.");
  });

  it("rejects more order lines than items, and more products than order lines", () => {
    expect(issuePaths(boxSchema.safeParse({ units: 3, lines: 4 }))).toEqual(["lines"]);
    const r = boxSchema.safeParse({ units: 5, products: 3, lines: 2 });
    expect(issuePaths(r)).toEqual(["products"]);
    expect(r.error!.issues[0]!.message).toBe("Different products can't be more than the order lines.");
  });

  it("rejects counts that are not whole numbers, unknown fields, odd keys and too many counts", () => {
    expect(boxSchema.safeParse({ units: 1, products: 0 }).success).toBe(false);
    expect(boxSchema.safeParse({ units: 1, lines: 1.5 }).success).toBe(false);
    expect(boxSchema.safeParse({ units: 1, counts: { inserts: -1 } }).success).toBe(false);
    expect(boxSchema.safeParse({ units: 1, counts: { inserts: 1.5 } }).success).toBe(false);
    expect(boxSchema.safeParse({ units: 1, counts: { "Bad Key": 1 } }).success).toBe(false);
    expect(boxSchema.safeParse({ units: 1, packaging: "" }).success).toBe(false);
    expect(boxSchema.safeParse({ units: 1, weight: 5 }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`count_${i}`, 1]));
    expect(boxSchema.safeParse({ units: 1, counts: many }).success).toBe(false);
  });

  it("is optional on the request: a request without a box is unchanged", () => {
    const without = calculatorRequestSchema.safeParse(baseRequest);
    expect(without.success).toBe(true);
    expect(without.data?.box).toBeUndefined();
    const withBox = calculatorRequestSchema.safeParse({ ...baseRequest, box: { units: 3, products: 2, packaging: "box" } });
    expect(withBox.success).toBe(true);
    expect(withBox.data?.box).toEqual({ units: 3, products: 2, packaging: "box" });
    const bad = calculatorRequestSchema.safeParse({ ...baseRequest, box: { units: 3, products: 5 } });
    expect(issuePaths(bad)).toEqual(["box.products"]);
  });

  it("the options request wants a real calendar date", () => {
    expect(calculatorBoxRequestSchema.safeParse({ shipDate: "2026-10-15" }).success).toBe(true);
    expect(calculatorBoxRequestSchema.safeParse({ shipDate: "2026-10-15", brandId: RATE_CARD }).success).toBe(true);
    expect(calculatorBoxRequestSchema.safeParse({ shipDate: "2026-02-30" }).success).toBe(false);
    expect(calculatorBoxRequestSchema.safeParse({ shipDate: "10/15/2026" }).success).toBe(false);
    expect(calculatorBoxRequestSchema.safeParse({ shipDate: "2026-10-15", brandId: "nope" }).success).toBe(false);
  });

  it("boxProblems ignores counts that are missing", () => {
    expect(boxProblems({})).toEqual({});
    expect(boxProblems({ units: 3, products: 3 })).toEqual({});
    expect(boxProblems({ products: 9 })).toEqual({});
    expect(boxProblems({ units: 3, products: 4 }).products).toMatch(/more than the items/);
  });
});

// ---------------------------------------------------------------------------
describe("what a fee schedule offers", () => {
  it("lists the packaging it prices, the catch-all, and one count per order-share driver; no per-line question", () => {
    const options = boxOptionsFromSnapshot(standard);
    expect(options.scheduleName).toBe("Fictional Standard Fulfillment 2026");
    expect(options.effectiveDate).toBe("2026-01-01");
    expect(options.packaging).toEqual([
      { value: "poly mailer", label: "Poly mailer" },
      { value: "box", label: "Box" },
      { value: "carton", label: "Carton" },
    ]);
    expect(options.allowOtherPackaging).toBe(true);
    expect(options.showLines).toBe(false);
    expect(options.hasOrderFees).toBe(true);
    expect(options.counts).toHaveLength(1);
    expect(options.counts[0]).toMatchObject({ key: "inserts", label: "Inserts in this order", unit: "inserts" });
    // The rate in the customer's words (the fee editor's description), without the run-setup question's "share of orders" clause.
    expect(options.counts[0]!.rate).toBe("$0.25 per insert after the first insert in each order.");
  });

  it("asks for order lines only when a rule reads them", () => {
    expect(boxOptionsFromSnapshot(lineSchedule).showLines).toBe(true);
    expect(boxOptionsFromSnapshot(tiers).showLines).toBe(false);
    const minLines: FeeScheduleSnapshot = { ...tiers, rules: [{ ...tiers.rules[0]!, tiers: null, method: "flat", amount: "1.0000", conditions: { minLines: 3 } }] };
    expect(boxOptionsFromSnapshot(minLines).showLines).toBe(true);
    const perLineAllowance: FeeScheduleSnapshot = { ...tiers, rules: [{ ...tiers.rules[0]!, tiers: null, method: "flat", amount: "1.0000", basis: "unit", includedQuantity: "1", includedPer: "line" }] };
    expect(boxOptionsFromSnapshot(perLineAllowance).showLines).toBe(true);
  });

  it("offers nothing to answer when there is no packaging or order-driver rule, and says when every fee is monthly", () => {
    const t = boxOptionsFromSnapshot(tiers);
    expect(t.packaging).toEqual([]);
    expect(t.allowOtherPackaging).toBe(false);
    expect(t.counts).toEqual([]);
    expect(t.hasOrderFees).toBe(true);
    expect(boxOptionsFromSnapshot(monthlyOnly).hasOrderFees).toBe(false);
  });

  it("carries no rule keys", () => {
    const text = JSON.stringify(boxOptionsFromSnapshot(standard));
    for (const key of ["pick_order", "pick_additional", "pack_mailer", "pack_box", "pack_other", "handling_pct"]) expect(text).not.toContain(key);
  });
});

// ---------------------------------------------------------------------------
describe("form drafts to box", () => {
  const options = boxOptionsFromSnapshot(standard);
  const lines = boxOptionsFromSnapshot(lineSchedule);
  const drafts = (patch: Partial<ReturnType<typeof emptyBoxDrafts>>) => ({ ...emptyBoxDrafts(), ...patch });

  it("parses counts the way a person types them", () => {
    expect(parseCount("")).toEqual({ kind: "empty" });
    expect(parseCount("  ")).toEqual({ kind: "empty" });
    expect(parseCount("12")).toEqual({ kind: "ok", value: 12 });
    expect(parseCount("1,200")).toEqual({ kind: "ok", value: 1200 });
    for (const bad of ["2.5", "abc", "-1", "1e3"]) expect(parseCount(bad), bad).toEqual({ kind: "invalid" });
    // A long run of digits is a whole number that is too big, and is told so (not "enter a whole number").
    expect(parseCount("123456789")).toEqual({ kind: "ok", value: 123_456_789 });
    expect(boxFromDrafts(drafts({ units: "2,000,000" }), options).errors["box.units"]).toBe("Enter 1,000,000 or fewer.");
  });

  it("sends no box and shows no error while nothing has been entered", () => {
    const r = boxFromDrafts(emptyBoxDrafts(), options);
    expect(r).toEqual({ box: null, errors: {}, started: false });
    expect(boxFromDrafts(emptyBoxDrafts(), null).box).toBeNull();
  });

  it("builds the box from the items alone, with 'Not sure' as null packaging", () => {
    const r = boxFromDrafts(drafts({ units: "3" }), options);
    expect(r.errors).toEqual({});
    expect(r.box).toEqual({ units: 3, packaging: null });
  });

  it("asks for the items when anything else is entered without them", () => {
    expect(boxFromDrafts(drafts({ products: "2" }), options).errors["box.units"]).toBe("Enter the number of items to see order fees.");
    expect(boxFromDrafts(drafts({ packaging: "box" }), options).errors["box.units"]).toBeDefined();
    expect(boxFromDrafts(drafts({ counts: { inserts: "1" } }), options).errors["box.units"]).toBeDefined();
    expect(boxFromDrafts(drafts({ packaging: "box" }), options).box).toBeNull();
  });

  it("flags products above items inline, and builds nothing until it is fixed", () => {
    const bad = boxFromDrafts(drafts({ units: "2", products: "3" }), options);
    expect(bad.errors["box.products"]).toBe("Different products can't be more than the items in the box.");
    expect(bad.box).toBeNull();
    const fixed = boxFromDrafts(drafts({ units: "3", products: "3" }), options);
    expect(fixed.errors).toEqual({});
    expect(fixed.box).toEqual({ units: 3, products: 3, packaging: null });
  });

  it("flags values that are not whole numbers or are below the minimum", () => {
    expect(boxFromDrafts(drafts({ units: "2.5" }), options).errors["box.units"]).toBe("Enter a whole number, for example 3.");
    expect(boxFromDrafts(drafts({ units: "0" }), options).errors["box.units"]).toBe("Enter at least 1 item.");
    expect(boxFromDrafts(drafts({ units: "2", products: "0" }), options).errors["box.products"]).toBe("Enter at least 1 product.");
    expect(boxFromDrafts(drafts({ units: "2", counts: { inserts: "-1" } }), options).errors["box.counts.inserts"]).toBe("Enter a whole number, for example 3.");
  });

  it("keeps a blank count out of the box (unknown, not zero) and a typed 0 in it", () => {
    expect(boxFromDrafts(drafts({ units: "2", counts: { inserts: "" } }), options).box?.counts).toBeUndefined();
    expect(boxFromDrafts(drafts({ units: "2", counts: { inserts: "0" } }), options).box?.counts).toEqual({ inserts: 0 });
    expect(boxFromDrafts(drafts({ units: "2", counts: { inserts: "2" } }), options).box?.counts).toEqual({ inserts: 2 });
  });

  it("ignores answers to fields the schedule in effect does not have", () => {
    // Order lines are not asked on the standard schedule: a stale "9" is neither an error nor sent.
    const r = boxFromDrafts(drafts({ units: "2", products: "2", lines: "9", counts: { kits: "4" } }), options);
    expect(r.errors).toEqual({});
    expect(r.box).toEqual({ units: 2, products: 2, packaging: null });
    // On a schedule with a per-line rule the same lines value counts, and is checked against items.
    expect(boxFromDrafts(drafts({ units: "4", products: "2", lines: "3" }), lines).box).toEqual({ units: 4, products: 2, lines: 3, packaging: null });
    expect(boxFromDrafts(drafts({ units: "4", lines: "5" }), lines).errors["box.lines"]).toBe("Order lines can't be more than the items in the box.");
  });

  it("drops a packaging choice the schedule in effect does not offer (it must not survive a change of ship date unseen)", () => {
    // "box" was picked under a schedule that prices it; under the tiers schedule (no packaging rule) and under a schedule with
    // other types only, the select would show "Not sure", so "Not sure" is what is priced.
    const tiersOptions = boxOptionsFromSnapshot(tiers);
    expect(offeredPackaging("box", options)).toBe("box");
    expect(offeredPackaging(PACKAGING_OTHER, options)).toBe(PACKAGING_OTHER);
    expect(offeredPackaging("box", tiersOptions)).toBe("");
    expect(offeredPackaging(PACKAGING_OTHER, tiersOptions)).toBe("");
    expect(offeredPackaging("box", null)).toBe("");
    const mailerOnly: FeeScheduleSnapshot = { ...standard, rules: standard.rules.filter((r) => r.key === "pack_mailer") };
    const mailerOptions = boxOptionsFromSnapshot(mailerOnly);
    expect(mailerOptions.allowOtherPackaging).toBe(false);
    expect(boxFromDrafts(drafts({ units: "2", packaging: "box" }), mailerOptions).box).toEqual({ units: 2, packaging: null });
    expect(boxFromDrafts(drafts({ units: "2", packaging: PACKAGING_OTHER }), mailerOptions).box).toEqual({ units: 2, packaging: null });
    expect(boxFromDrafts(drafts({ units: "2", packaging: "poly mailer" }), mailerOptions).box).toEqual({ units: 2, packaging: "poly mailer" });
    // A hidden stale choice is not "something typed in the block": items blank + stale packaging is an empty block, not an error.
    expect(boxFromDrafts(drafts({ packaging: "box" }), tiersOptions)).toEqual({ box: null, errors: {}, started: false });
  });

  it("the built box is what the schema accepts", () => {
    const r = boxFromDrafts(drafts({ units: "5", products: "3", packaging: "carton", counts: { inserts: "2" } }), options);
    expect(boxSchema.safeParse(r.box).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("describeBox", () => {
  const options = boxOptionsFromSnapshot(standard);
  it("echoes every field in plain words", () => {
    expect(describeBox({ units: 3, products: 2, packaging: "poly mailer", counts: { inserts: 2 } }, options)).toBe("3 items, 2 different products, packaging: Poly mailer, 2 inserts");
    expect(describeBox({ units: 1, products: 1, packaging: null, counts: { inserts: 1 } }, options)).toBe("1 item, 1 different product, packaging not specified, 1 insert");
    expect(describeBox({ units: 4, products: 2, lines: 3, packaging: PACKAGING_OTHER }, options)).toBe("4 items, 2 different products, 3 order lines, packaging: another type");
    expect(describeBox({ units: 1200 }, null)).toBe("1,200 items, packaging not specified");
  });

  it("does not say 'packaging not specified' when the schedule never asked about packaging", () => {
    const noPackaging = boxOptionsFromSnapshot(tiers);
    expect(describeBox({ units: 5, products: 2 }, noPackaging)).toBe("5 items, 2 different products");
    expect(describeBox({ units: 5 }, options)).toBe("5 items, packaging not specified");
  });
});

// ---------------------------------------------------------------------------
describe("shipping input from the calculation", () => {
  it("reads the fixture shipment: expected cost, base rate only, no estimate, exposure present", () => {
    const calc = shipment();
    expect(calc.status).toBe("ok");
    // $11.07 base + $5.00 residential + $2.49 fuel = $18.56 counted; $21.00 address correction is conditional.
    expect(shippingInputFromCalculation(calc)).toEqual({ totalE4: 185_600, baseFreightE4: 110_700, estimated: false, hasExposure: true });
  });

  it("counts the minimum-charge adjustment as base freight and flags estimates", () => {
    const money = (amount: string) => ({ amount, currency: "USD" });
    const calc = {
      status: "ok",
      lines: [
        { kind: "base", counted: true, status: "charged", amount: money("8.00") },
        { kind: "minimum_charge", counted: true, status: "charged", amount: money("1.50") },
        { kind: "surcharge", counted: true, status: "charged", amount: money("2.00") },
        { kind: "surcharge", counted: false, status: "conditional", amount: money("21.00") },
      ],
      totals: { expected: money("11.50"), estimated: money("2.00"), conditionalExposure: money("21.00"), unresolved: money("0.00") },
    } as unknown as ShipmentCalculation;
    expect(shippingInputFromCalculation(calc)).toEqual({ totalE4: 115_000, baseFreightE4: 95_000, estimated: true, hasExposure: true });
  });

  it("is null when the shipment could not be priced", () => {
    expect(shippingInputFromCalculation({ ...shipment(), status: "unavailable" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("mapping the box into the fee engine's input", () => {
  const box = (patch: Partial<CalculatorBox> = {}): CalculatorBox => ({ units: 3, products: 2, packaging: "poly mailer", counts: { inserts: 2 }, ...patch });
  const map = (b: CalculatorBox, over: Partial<Parameters<typeof boxToOrderFeeInput>[1]> = {}) => boxToOrderFeeInput(b, { packageCount: 1, shipping: null, showLines: false, countKeys: ["inserts"], ...over });

  it("maps items, products, one shipment of N packages carrying the packaging, ordinal 1", () => {
    const { input, context } = map(box(), { packageCount: 2 });
    expect(input.units).toBe(3);
    expect(input.distinctSkus).toBe(2);
    expect(input.packages).toEqual([{ packagingType: "poly mailer" }, { packagingType: "poly mailer" }]);
    expect(input.shipments).toBe(1);
    expect(input.ordinal).toBe(1);
    expect(context).toEqual({ orderShares: { inserts: { sharePct: "100", countPerOrder: 2 } }, pinnedRates: {}, packagingDefault: null });
  });

  it("sets lines = products (flagged assumed) when the schedule has no per-line rule, and leaves them unknown when it asks and nothing was entered", () => {
    const derived = map(box()).input;
    expect(derived.lines).toBe(2);
    expect(derived.assumed).toEqual({ lines: true });
    const asked = map(box({ lines: 3 }), { showLines: true }).input;
    expect(asked.lines).toBe(3);
    expect(asked.assumed).toEqual({});
    const blank = map(box({ lines: undefined }), { showLines: true }).input;
    expect(blank.lines).toBeNull();
    // No products: nothing is inferred.
    const none = map(box({ products: undefined })).input;
    expect(none.lines).toBeNull();
    expect(none.distinctSkus).toBeNull();
    expect(none.assumed).toEqual({});
  });

  it("packaging 'Not sure' is a null type: packaging fees are not computed, never $0", () => {
    const { input, context } = map(box({ packaging: null, counts: { inserts: 0 } }));
    expect(input.packages).toEqual([{ packagingType: null }]);
    const result = calculateOrderFees(input, standard, context);
    expect(result.unresolved.filter((u) => u.reason === "packaging_unknown").map((u) => u.ruleKey)).toEqual(["pack_mailer", "pack_box", "pack_other"]);
    expect(result.lines.map((l) => l.ruleKey)).toEqual(["pick_order", "pick_additional"]);
    expect(result.status).toBe("partial");
  });

  it("an unlisted real packaging type, and 'Another type', fall to the catch-all ($0.60); listed types win their own rule", () => {
    const priced = (packaging: string) => {
      const { input, context } = map(box({ packaging, counts: { inserts: 0 } }), { shipping: { totalE4: 0, baseFreightE4: 0, estimated: false, hasExposure: false } });
      const r = calculateOrderFees(input, standard, context);
      return r.lines.find((l) => l.category === "packaging")?.amountE4;
    };
    expect(priced("poly mailer")).toBe(3_000);
    expect(priced("box")).toBe(8_500);
    expect(priced("carton")).toBe(8_500);
    expect(priced("foam wrap")).toBe(6_000);
    expect(priced(PACKAGING_OTHER)).toBe(6_000);
  });

  it("a blank count stays unanswered (not computed); a typed one is an answer of 100% of orders", () => {
    const blank = map(box({ counts: undefined }));
    expect(blank.context.orderShares).toEqual({ inserts: null });
    const r = calculateOrderFees(blank.input, standard, blank.context);
    expect(r.unresolved.find((u) => u.ruleKey === "inserts")?.reason).toBe("assumption_missing");
    expect(r.lines.find((l) => l.ruleKey === "inserts")).toBeUndefined();
    // inserts 2, first one included: 1 × $0.25, estimated (an order driver is always based on an assumption).
    const given = map(box());
    const g = calculateOrderFees(given.input, standard, given.context);
    expect(g.lines.find((l) => l.ruleKey === "inserts")).toMatchObject({ amountE4: 2_500, chargeClass: "estimated" });
  });

  it("only the keys the schedule asks for become answers", () => {
    expect(map(box({ counts: { inserts: 1, stale: 5 } })).context.orderShares).toEqual({ inserts: { sharePct: "100", countPerOrder: 1 } });
  });

  it("does not pin a monthly-volume rate: those fees are not computed", () => {
    const { input, context } = boxToOrderFeeInput({ units: 5 }, { packageCount: 1, shipping: null, showLines: false, countKeys: [] });
    const r = calculateOrderFees(input, tiers, context);
    expect(r.unresolved.filter((u) => u.reason === "assumption_missing").map((u) => u.ruleKey)).toEqual(["pick_monthly_graduated", "pick_monthly_volume"]);
  });
});

// ---------------------------------------------------------------------------
describe("order fees for a calculation (customer-safe view)", () => {
  const box: CalculatorBox = { units: 3, products: 2, packaging: "poly mailer", counts: { inserts: 2 } };
  const priceStandard = (audience: "brand" | "staff", b: CalculatorBox = box) => computed(priceOrderFees({ schedule: okSchedule(standard), box: b, calculations: [shipment()], audience }))[0]!;

  it("prices the fixture order: $4.98 of fees, $23.54 with the $18.56 shipping", () => {
    const view = priceStandard("brand");
    // pick $2.50 + 2 additional items × $0.50 + poly mailer $0.30 + 1 insert × $0.25 + 5% × $18.56 = $0.928 -> $4.978.
    expect(view.lines.map((l) => [l.name, l.amount, l.chargeClass])).toEqual([
      ["Pick & pack, per order", "2.50", "definite"],
      ["Each additional item", "1.00", "definite"],
      ["Poly mailer", "0.30", "definite"],
      ["Marketing inserts", "0.25", "estimated"],
      ["Shipping handling", "0.93", "definite"],
    ]);
    expect(view.status).toBe("ok");
    expect(view.notComputed).toEqual([]);
    expect(view.shipping).toBe("18.56");
    expect(view.orderFees).toBe("4.98");
    // Rounded once from the exact $18.56 + $4.978 = $23.538, not from rounded parts.
    expect(view.combined).toBe("23.54");
    expect(view.notes.join(" ")).toMatch(/after shipping/); // the 5% is taken on shipping that leaves out the $21.00 exposure
    expect(view.box).toBe("3 items, 2 different products, packaging: Poly mailer, 2 inserts");
    expect(view.schedule).toEqual({ name: "Fictional Standard Fulfillment 2026", effectiveDate: "2026-01-01" });
  });

  it("explains each fee line in plain words", () => {
    const view = priceStandard("brand");
    expect(view.lines[1]!.explanation).toBe("2 items × $0.50 = $1.00.");
    expect(view.lines[4]!.explanation).toContain("5% of the shipping cost ($18.56)");
  });

  it("brand views carry no rule keys; staff views carry them and the version number", () => {
    const brand = priceStandard("brand", { units: 1 });
    const brandText = JSON.stringify(brand);
    expect(brandText).not.toContain("ruleKey");
    for (const key of ["pick_order", "pack_mailer", "pack_box", "pack_other", "handling_pct"]) expect(brandText).not.toContain(key);
    expect(brand.schedule.versionNumber).toBeUndefined();
    const staff = priceStandard("staff");
    expect(staff.lines[0]!.ruleKey).toBe("pick_order");
    expect(staff.schedule.versionNumber).toBe(1);
  });

  it("lists what could not be computed with the reason, the rate and what to add, and says 'at least'", () => {
    // Packaging not sure, inserts left blank: five fees need something the box does not say.
    const view = priceStandard("brand", { units: 3, products: 2, packaging: null });
    expect(view.status).toBe("partial");
    expect(view.notComputed.map((n) => [n.name, n.reason, n.add?.field])).toEqual([
      ["Poly mailer", "Needs the packaging used.", "packaging"],
      ["Box", "Needs the packaging used.", "packaging"],
      ["Other packaging", "Needs the packaging used.", "packaging"],
      ["Marketing inserts", "Needs the number of inserts in this order.", "count:inserts"],
    ]);
    expect(view.notComputed[0]!.rate).toBe("$0.30 per package, only for packaging: poly mailer.");
    expect(view.notComputed[3]!.rate).toBe("$0.25 per insert after the first insert in each order.");
    expect(view.notComputed[3]!.add).toEqual({ field: "count:inserts", label: "Add inserts" });
    // Pick $2.50 + 2 additional items $1.00 + 5% of $18.56 $0.93 are counted; the rest are left out, not $0.
    expect(view.orderFees).toBe("4.43");
    expect(view.combined).toBe("22.99");
    expect(feesTotalText(view)).toBe("At least $22.99");
    expect(JSON.stringify(view)).not.toMatch(/pack_mailer|pack_box|"inserts"|ruleKey/);
  });

  it("shows monthly-volume tiers as not computed because they depend on your monthly volume", () => {
    const [view] = computed(priceOrderFees({ schedule: okSchedule(tiers), box: { units: 5 }, calculations: [shipment()], audience: "brand" }));
    expect(view!.status).toBe("partial");
    expect(view!.notComputed.map((n) => [n.name, n.reason, n.add])).toEqual([
      ["Pick fee by monthly volume (graduated)", "Depends on your monthly volume.", null],
      ["Pick fee by monthly volume (volume)", "Depends on your monthly volume.", null],
    ]);
    expect(view!.notComputed[0]!.rate).toContain("your monthly orders");
    // Graduated 1 × $3.00 + 4 × $0.50 = $5.00; volume 5 × $0.50 = $2.50; flat bracket $5.00: $12.50 + $18.56 shipping.
    expect(view!.lines.map((l) => l.amount)).toEqual(["5.00", "2.50", "5.00"]);
    expect(view!.orderFees).toBe("12.50");
    expect(view!.combined).toBe("31.06");
  });

  it("never prints $0 when nothing could be computed", () => {
    const packagingOnly: FeeScheduleSnapshot = { ...standard, rules: standard.rules.filter((r) => r.key === "pack_mailer") };
    const [view] = computed(priceOrderFees({ schedule: okSchedule(packagingOnly), box: { units: 1, packaging: null }, calculations: [shipment()], audience: "brand" }));
    expect(view!.status).toBe("no_content");
    expect(view!.lines).toEqual([]);
    expect(view!.orderFees).toBeNull();
    expect(view!.combined).toBeNull();
    expect(feesTotalText(view)).toBe("Not computed");
  });

  it("a service that could not be priced has no fee view; the others do", () => {
    const calculations = [shipment(), { ...shipment(), status: "unavailable" as const }];
    const byService = computed(priceOrderFees({ schedule: okSchedule(standard), box, calculations, audience: "brand" }));
    expect(byService[0]).not.toBeNull();
    expect(byService[1]).toBeNull();
    expect(feesTotalText(byService[1])).toBe("—");
  });

  it("says so when there is no fee schedule in effect, and when it could not be read, instead of pricing", () => {
    const run = (schedule: BrandFeeSchedule) => priceOrderFees({ schedule, box, calculations: [shipment()], audience: "brand" });
    expect(run({ status: "no_schedule" })).toEqual({ status: "no_schedule" });
    expect(run({ status: "not_effective", assignment: null, schedule: { id: "s", name: "x", description: null } })).toEqual({ status: "not_effective" });
    expect(run({ status: "load_failed" })).toEqual({ status: "load_failed" });
    expect(run({ status: "not_found" })).toEqual({ status: "load_failed" });
  });

  it("percent-of-shipping fees are read per service from that service's shipping cost", () => {
    const cheaper = { ...shipment(), totals: { ...shipment().totals, expected: { amount: "10.00", currency: "USD" as const }, estimated: { amount: "0.00", currency: "USD" as const } } };
    const [a, b] = computed(priceOrderFees({ schedule: okSchedule(standard), box, calculations: [shipment(), cheaper], audience: "brand" }));
    expect(a!.lines.at(-1)!.amount).toBe("0.93");
    expect(b!.lines.at(-1)!.amount).toBe("0.50");
    expect(b!.shipping).toBe("10.00");
  });
});

// ---------------------------------------------------------------------------
describe("rendering", () => {
  const view = (): OrderFeesView => computed(priceOrderFees({ schedule: okSchedule(standard), box: { units: 3, products: 2, packaging: null }, calculations: [shipment()], audience: "brand" }))[0]!;
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("prints the heading, the echo, the figures, every line and every fee left out with its reason and rate", () => {
    const html = renderToStaticMarkup(createElement(OrderFeesSection, { fees: view(), audience: "brand", uid: "u1" }));
    const t = text(html);
    expect(t).toContain("Shipping + order fees for this order (monthly charges not included)");
    expect(t).toContain("In the box: 3 items, 2 different products, packaging not specified.");
    expect(t).toMatch(/Fee schedule Fictional Standard Fulfillment 2026 ?, in effect from Jan 1, 2026/);
    expect(t).toContain("Shipping + order fees (at least)");
    expect(t).toContain("$22.99");
    expect(t).toContain("2 items");
    expect(t).toContain("× $0.50 = $1.00");
    expect(t).toContain("Not computed");
    expect(t).toContain("Needs the packaging used.");
    expect(t).toContain("Rate: $0.30 per package");
    expect(t).toContain("left out of the totals above, not counted as $0");
    // Brand vocabulary for the classes: fee lines come from the fee schedule, never "from your rate card" (that is shipping).
    expect(t).toContain("From your fee schedule");
    expect(t).not.toContain("From your rate card");
    expect(t).toContain("Estimated shipping cost of this shipment");
    expect(t).not.toContain("Expected shipping cost");
    for (const key of ["pick_order", "pack_mailer", "handling_pct", "ruleKey"]) expect(html).not.toContain(key);
  });

  it("does not call a figure 'charged' (an estimate is not an invoice), whether or not something was left out", () => {
    const complete = computed(priceOrderFees({ schedule: okSchedule(standard), box: { units: 3, products: 2, packaging: "poly mailer", counts: { inserts: 2 } }, calculations: [shipment()], audience: "brand" }))[0]!;
    const t = text(renderToStaticMarkup(createElement(OrderFeesSection, { fees: complete, audience: "brand", uid: "u1" })));
    expect(t).not.toContain("Charged on this order");
    expect(t).toContain("Every fee that applies to this box is counted. An estimate, not an invoice.");
    expect(t).toContain("Shipping + order fees $23.54");
    const none: FeeScheduleSnapshot = { ...standard, rules: standard.rules.filter((r) => r.key === "pick_additional") };
    const [empty] = computed(priceOrderFees({ schedule: okSchedule(none), box: { units: 1 }, calculations: [shipment()], audience: "brand" }));
    expect(empty!.status).toBe("ok");
    expect(empty!.lines).toEqual([]);
    const emptyText = text(renderToStaticMarkup(createElement(OrderFeesSection, { fees: empty!, audience: "brand", uid: "u1" })));
    expect(emptyText).toContain("No fee applies to this box.");
    expect(emptyText).toContain("No order fees apply to what is in the box.");
  });

  it("staff see the rule keys and the staff class names", () => {
    const staffView = computed(priceOrderFees({ schedule: okSchedule(standard), box: { units: 3, products: 2, packaging: null }, calculations: [shipment()], audience: "staff" }))[0]!;
    const t = text(renderToStaticMarkup(createElement(OrderFeesSection, { fees: staffView, audience: "staff", uid: "u1" })));
    expect(t).toContain("pick_order");
    expect(t).toContain("(version 1)");
    expect(t).toContain("Definite");
  });

  it("offers the Add buttons only where the page can act on them", () => {
    const without = renderToStaticMarkup(createElement(OrderFeesSection, { fees: view(), audience: "brand", uid: "u1" }));
    expect(without).not.toContain("<button");
    const withAdd = renderToStaticMarkup(createElement(OrderFeesSection, { fees: view(), audience: "brand", uid: "u1", onAdd: () => undefined }));
    expect(withAdd).toContain("Choose packaging");
    expect(withAdd).toContain("Add inserts");
  });

  it("a saved single result brings its fees back; an explicit null hides them", () => {
    const calc = shipment();
    const stored = { ...calc, orderFees: view() };
    const shown = text(renderToStaticMarkup(createElement(CalculationResult, { result: stored, audience: "brand", cardName: "Card", effectiveDate: null, shipDate: "2026-10-15" })));
    expect(shown).toContain("Shipping + order fees for this order (monthly charges not included)");
    const hidden = text(renderToStaticMarkup(createElement(CalculationResult, { result: stored, audience: "brand", cardName: "Card", effectiveDate: null, shipDate: "2026-10-15", fees: null })));
    expect(hidden).not.toContain("order fees for this order");
    const plain = text(renderToStaticMarkup(createElement(CalculationResult, { result: calc, audience: "brand", cardName: "Card", effectiveDate: null, shipDate: "2026-10-15" })));
    expect(plain).not.toContain("order fees for this order");
  });
});

// ---------------------------------------------------------------------------
describe("the box block in the form", () => {
  const render = (options = boxOptionsFromSnapshot(standard), drafts = emptyBoxDrafts(), errors: Record<string, string> = {}, packageCount = 1) =>
    renderToStaticMarkup(createElement(BoxBlock, { idPrefix: "t", options, drafts, errors, packageCount, onChange: () => undefined }));
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("is a labelled group 'What's in the box' with items, products, packaging and one field per count", () => {
    const html = render();
    expect(html).toContain("<fieldset");
    expect(text(html)).toContain("What's in the box");
    for (const label of ["Items (units)", "Different products", "Packaging", "Inserts in this order"]) expect(html).toContain(`>${label}</label>`);
    // Every control has its label: for= matches an id.
    for (const id of ["t-box-units", "t-box-products", "t-box-packaging", "t-box-count-inserts"]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain("Order lines");
    expect(text(html)).toContain("monthly charges are not included");
  });

  it("offers 'Not sure', the schedule's packaging types and 'Another type (not listed)' in the packaging select", () => {
    const html = render();
    const options = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["", "Not sure"],
      ["poly mailer", "Poly mailer"],
      ["box", "Box"],
      ["carton", "Carton"],
      [PACKAGING_OTHER, "Another type (not listed)"],
    ]);
  });

  it("asks for order lines only when the schedule has a per-line rule, and drops the packaging select when nothing is priced by packaging", () => {
    expect(render(boxOptionsFromSnapshot(lineSchedule))).toContain(">Order lines</label>");
    const tiersHtml = render(boxOptionsFromSnapshot(tiers));
    expect(tiersHtml).not.toContain(">Packaging</label>");
    expect(tiersHtml).not.toContain("count-");
  });

  it("shows the inline error on the field, marks it invalid and ties it to the control", () => {
    const html = render(undefined, { ...emptyBoxDrafts(), units: "2", products: "3" }, { "box.products": "Different products can't be more than the items in the box." });
    expect(html).toContain('id="t-box-products-error"');
    expect(html).toMatch(/id="t-box-products"[^>]*aria-invalid="true"/);
    expect(html).toMatch(/id="t-box-products"[^>]*aria-describedby="[^"]*t-box-products-error/);
    expect(text(html)).toContain("Different products can't be more than the items in the box.");
    expect(html).not.toContain('id="t-box-units-error"');
  });

  it("shows 'Not sure' when the drafted packaging is not one this schedule offers", () => {
    const mailerOnly: FeeScheduleSnapshot = { ...standard, rules: standard.rules.filter((r) => r.key === "pack_mailer") };
    const html = render(boxOptionsFromSnapshot(mailerOnly), { ...emptyBoxDrafts(), units: "2", packaging: "box" });
    expect(html).toMatch(/<option value="" selected="">Not sure<\/option>/);
    expect(html).not.toMatch(/<option value="box"/);
    const picked = render(boxOptionsFromSnapshot(mailerOnly), { ...emptyBoxDrafts(), units: "2", packaging: "poly mailer" });
    expect(picked).toMatch(/<option value="poly mailer" selected="">Poly mailer<\/option>/);
  });

  it("says the packaging applies to every package when there are several", () => {
    expect(text(render(undefined, emptyBoxDrafts(), {}, 2))).toContain("Used for every package in this shipment.");
  });

  it("says there is no fee schedule in effect, rather than showing a block or $0", () => {
    const note = (o: Parameters<typeof BoxNote>[0]["options"]) => text(renderToStaticMarkup(createElement(BoxNote, { options: o })));
    expect(note({ status: "no_schedule" })).toContain("No fee schedule in effect on this date.");
    expect(note({ status: "not_effective" })).toContain("No fee schedule in effect on this date.");
    expect(note({ status: "load_failed" })).toContain("could not be loaded");
    expect(note({ status: "unavailable" })).toBe("");
    expect(note({ ...boxOptionsFromSnapshot(monthlyOnly) })).toContain("no per-order fees");
  });
});
