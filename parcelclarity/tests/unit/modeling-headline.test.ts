import { describe, expect, it } from "vitest";
import type { BulkSummary } from "@/engine/modeling";
import type { CompareRunInput } from "@/lib/modeling/headline";
import {
  MONTHLY_CSV_COLUMNS,
  ORDERS_CSV_COLUMNS,
  assumptionsLine,
  buildComparison,
  categoryName,
  compareFacts,
  csvCell,
  csvComment,
  csvText,
  defaultView,
  describeMinimumReason,
  diffForecastProfiles,
  feeScheduleLine,
  feeStatusSentences,
  feesChangedSince,
  headlineFigures,
  headlineReason,
  headlineText,
  isForecastSummary,
  joinWords,
  minimumViews,
  monthLabel,
  monthlyCharges,
  monthlyCsv,
  notIncludedGroups,
  orderFeeRows,
  ordersCsvComments,
  ordersCsvRecord,
  orderRowFigures,
  parseView,
  ruleNameIndex,
  toCents,
  uncoveredFeeDatesNote,
  unresolvedRuleNames,
  usd,
  volumeDiffers,
  volumeSensitivity,
} from "@/lib/modeling/headline";
import {
  A,
  ADD,
  B,
  C,
  D2,
  PICK,
  complete,
  counts,
  feeLine,
  fees,
  finalize,
  forecast,
  forecastAssumptions,
  lowCoverage,
  modeledOrder,
  noContent,
  noMinimum,
  noMinimumRun,
  noSchedule,
  noStorageAnswer,
  noVolume,
  notEffective,
  oneMonth,
  period,
  returnsRun,
  schedule,
  skipped,
  undated,
  zeroVolume,
} from "../fixtures/modeling/fee-runs";

/**
 * The headline function (design section 6, the F1 rule of section 10) and the pure helpers behind the
 * run page, hub, overview, list, compare and CSV headers. Summaries are produced by the real
 * `finalizeSummary` over a hand-built partial; every expectation below is derived by hand from the fixture:
 *
 *   orders A, B, C, D2: shipping $10 + $12 + $20 + $8 = $50.00; order fees $2.00 + $1.50 + $2.50 + $1.75 = $7.75
 *   2 orders a month over 2 months (Mar 1 to Apr 30, 2026), so V = 2 and 4 modeled orders
 *   monthly: shipping 50 x 2 / 4 = 25.00, order fees 7.75 x 2 / 4 = 3.875, storage 10 pallets x $18 = 180, account fee 25
 *   minimum $500 a month over pick, box, inserts, storage: March counts 183.50 (added 316.50), April 184.25 (added 315.75)
 */

// The scenarios live in tests/fixtures/modeling/fee-runs.ts (shared with the results tests).
// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
describe("formatting", () => {
  it("rounds to cents HALF_UP exactly once and groups thousands", () => {
    expect(toCents("2.675")).toBe("2.68");
    expect(toCents("12.3450")).toBe("12.35");
    expect(usd("1234.5")).toBe("$1,234.50");
    expect(usd("0.005")).toBe("$0.01");
    expect(usd("-3.1")).toBe("−$3.10");
    expect(usd("1000000")).toBe("$1,000,000.00");
  });

  it("never prints a missing amount as $0", () => {
    expect(usd(null)).toBe("—");
    expect(usd(undefined)).toBe("—");
  });

  it("words: month labels, lists, categories and the view parameter", () => {
    expect(monthLabel("2026-03")).toBe("Mar 2026");
    expect(monthLabel("average")).toBe("A typical month");
    expect(joinWords(["storage"])).toBe("storage");
    expect(joinWords(["storage", "receiving"])).toBe("storage and receiving");
    expect(joinWords(["storage", "receiving", "returns"])).toBe("storage, receiving and returns");
    expect(categoryName("kitting")).toBe("kitting & assembly");
    expect(parseView("allin")).toBe("allin");
    expect(parseView("fees")).toBe("fees");
    expect(parseView("shipping")).toBe("shipping");
    expect(parseView("everything")).toBeNull();
    expect(parseView(undefined)).toBeNull();
  });

  it("puts engine minimum reasons in plain words and never echoes text it does not know", () => {
    expect(describeMinimumReason("Pallet storage not modeled")).toBe("Pallet storage is not modeled");
    expect(describeMinimumReason("coverage 60.0% in 2026-03")).toBe("only 60.0% of the orders shipped in Mar 2026 could be priced");
    expect(describeMinimumReason("1 order without a date")).toBe("1 order has no date");
    expect(describeMinimumReason("3 orders without a date")).toBe("3 orders have no date");
    expect(describeMinimumReason("rule storage_pallet exploded")).toBe("something it counts could not be worked out");
  });

  it("says why orders have no fee figure, one sentence per status", () => {
    expect(feeStatusSentences({ ok: 10, no_content: 1, not_effective: 3 })).toEqual(["1 order has no item counts or order content to price fees from.", "3 orders were dated outside the fee schedule's dates."]);
    expect(feeStatusSentences({ ok: 4 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Headline: complete
// ---------------------------------------------------------------------------
describe("headlineFigures: a complete run", () => {
  const h = headlineFigures(complete, "allin", { addHref: ADD }, "brand");

  it("uses the plain label and an exact figure when every category is priced and the minimum is exact", () => {
    expect(h.label).toBe("All-in cost per order");
    expect(h.amount).toBe("275.00");
    expect(h.qualifier).toBe("");
    expect(h.complete).toBe(true);
    expect(h.unavailable).toBeNull();
    expect(h.notIncluded).toEqual([]);
    expect(h.minimumCouldAdd).toBeNull();
    expect(h.caveats).toEqual([]);
    expect(headlineText(h)).toBe("$275.00");
  });

  it("prints the basis of the allocated figure, and the split per order", () => {
    expect(h.basisSentence).toBe("2 orders a month over Mar 1, 2026–Apr 30, 2026 (2 months)");
    expect(h.parts).toEqual([
      { label: "Shipping", amount: "12.50", note: null },
      { label: "Order fees", amount: "1.94", note: null },
      { label: "Monthly charges, spread over your orders", amount: "260.56", note: "at 2 orders a month, with the account minimum" },
    ]);
  });

  it("offers All-in by default, and the other two views carry their own labels", () => {
    expect(defaultView(complete)).toBe("allin");
    const fees = headlineFigures(complete, "fees");
    expect(fees).toMatchObject({ label: "Order fees per order", amount: "1.94", qualifier: "", complete: true, basisSentence: "Fees priced for 4 of 4 orders that could be priced" });
    const shipping = headlineFigures(complete, "shipping");
    expect(shipping).toMatchObject({ label: "Estimated shipping cost per order", amount: "12.50", qualifier: "", basisSentence: "Based on 4 of 4 orders (100.0%)" });
  });

  it("without a minimum rule the all-in is the same kind of exact figure", () => {
    const h2 = headlineFigures(noMinimumRun, "allin");
    // 25.00 + 3.875 + 205.00 = 233.875 a month over 2 orders = 116.9375
    expect(h2).toMatchObject({ label: "All-in cost per order", amount: "116.94", qualifier: "", complete: true, minimumCouldAdd: null });
  });
});

// ---------------------------------------------------------------------------
// Headline: missing storage numbers
// ---------------------------------------------------------------------------
describe("headlineFigures: a category left out because no numbers were given", () => {
  const h = headlineFigures(noStorageAnswer, "allin", { addHref: ADD }, "brand");

  it("names what is left out, says At least, and lists the rate with an Add link", () => {
    expect(h.label).toBe("All-in cost per order, without storage");
    // monthly 25.00 + 3.875 + 25.00 account fee (storage left out, minimum left out) = 53.875 over 2 orders
    expect(h.amount).toBe("26.94");
    expect(h.qualifier).toBe("At least");
    expect(h.complete).toBe(false);
    expect(headlineText(h)).toBe("At least $26.94");
    expect(h.notIncluded).toEqual([{ name: "Pallet storage", category: "storage", rate: "$18.00 per pallet per month.", reason: "no number was given", addHref: ADD }]);
    expect(defaultView(noStorageAnswer)).toBe("shipping");
  });

  it("states the account minimum it could not count: member not modeled makes it an upper bound", () => {
    // March 35,000 E4 counted of 5,000,000; April 42,500: top-ups 4,965,000 + 4,957,500 = $992.25 over 2 months = $496.125 a month
    expect(h.minimumCouldAdd).toEqual({
      perMonth: "496.13",
      perOrder: "248.06",
      sentence: "The account minimum could add up to $496.13 a month (about $248.06 per order) on top of this. It could not be worked out exactly: Pallet storage is not modeled.",
    });
  });

  it("gives one sentence on why a tile is not the plain figure", () => {
    expect(headlineReason(h)).toBe("Not included yet: Pallet storage. Add your numbers for the full figure. The account minimum could add up to $496.13 a month (about $248.06 per order) on top of this. It could not be worked out exactly: Pallet storage is not modeled.");
    expect(headlineReason(headlineFigures(complete, "allin"))).toBeNull();
    expect(headlineReason(headlineFigures(skipped, "allin"))).toBe("Fulfillment costs were skipped for this model, so only shipping is shown.");
    expect(headlineReason(headlineFigures(undated, "allin"))).toBe("The account minimum could add up to $316.13 a month (about $158.06 per order) on top of this. It could not be worked out exactly: 1 order has no date.");
  });

  it("leaves the add link off when the viewer cannot rerun", () => {
    const h2 = headlineFigures(noStorageAnswer, "allin");
    expect(h2.notIncluded).toEqual([{ name: "Pallet storage", category: "storage", rate: "$18.00 per pallet per month.", reason: "no number was given" }]);
  });

  it("the Order fees view is not diluted by a monthly gap: storage is a monthly charge", () => {
    const fees = headlineFigures(noStorageAnswer, "fees", { addHref: ADD });
    expect(fees).toMatchObject({ label: "Order fees per order", amount: "1.94", qualifier: "", complete: true, notIncluded: [] });
  });

  it("splits the group lists: numbers needed, not on the schedule, never included", () => {
    const g = notIncludedGroups(noStorageAnswer, { addHref: ADD }, "brand");
    expect(g.needNumbers.map((i) => i.name)).toEqual(["Pallet storage"]);
    expect(g.notOnSchedule.map((i) => i.label)).toEqual(["Kitting & assembly", "Labeling", "Receiving", "Returns"]);
    expect(g.notOnSchedule[0]?.detail).toBe("Your fee schedule has no kitting & assembly charge.");
    expect(g.neverIncluded).toEqual(["Special projects and anything else outside the fee schedule (these are quoted separately).", "Carrier adjustments billed after shipping, such as address corrections and reweighs.", "Taxes.", "Return shipping."]);
    expect(notIncludedGroups(noStorageAnswer, {}, "staff").notOnSchedule[0]?.detail).toBe("This customer's fee schedule has no kitting & assembly charge.");
  });
});

// ---------------------------------------------------------------------------
// F1: the minimum is an upper bound only through undated orders or coverage
// ---------------------------------------------------------------------------
describe("headlineFigures: F1, a minimum that is an upper bound through undated orders or coverage", () => {
  it("keeps the label and every category, reads At least, and says the minimum could add up to $X", () => {
    const h = headlineFigures(undated, "allin");
    // 5 processing orders, V = 2: shipping 55 x 2 / 5 = 22.00, order fees 9.25 x 2 / 5 = 3.70, fixed 205.00, top-up left out: 230.70 / 2 = 115.35
    expect(h.label).toBe("All-in cost per order");
    expect(h.amount).toBe("115.35");
    expect(h.qualifier).toBe("At least");
    expect(h.complete).toBe(false);
    expect(h.notIncluded).toEqual([]);
    expect(h.minimumCouldAdd).toEqual({
      perMonth: "316.13",
      perOrder: "158.06",
      sentence: "The account minimum could add up to $316.13 a month (about $158.06 per order) on top of this. It could not be worked out exactly: 1 order has no date.",
    });
    expect(defaultView(undated)).toBe("shipping");
  });

  it("coverage below 80 %: the figure counts only the orders that could be priced, so it is at least that", () => {
    const h = headlineFigures(lowCoverage, "allin");
    // 3 of 5 orders: shipping 30.00 and order fees 5.00 over one month, fixed 205.00: 240.00 / 5 orders = 48.00
    expect(h.label).toBe("All-in cost per order");
    expect(h.amount).toBe("48.00");
    expect(h.qualifier).toBe("At least");
    expect(h.caveats).toEqual(["Only 60.0% of your orders could be priced, so the monthly figures count just those orders: the real cost is at least this."]);
    // March: pick 4,500 scaled 5/3 = 7,500; box 500 scaled = 83.33 -> $0.83; storage 180.00: counted 1,883,300 E4 of 5,000,000 -> top-up $311.67
    expect(h.minimumCouldAdd?.perMonth).toBe("311.67");
    expect(h.minimumCouldAdd?.perOrder).toBe("62.33");
    expect(h.minimumCouldAdd?.sentence).toContain("only 60.0% of the orders shipped in Mar 2026 could be priced");
  });
});

// ---------------------------------------------------------------------------
// Skipped, no schedule, zero volume, no volume, nothing priced
// ---------------------------------------------------------------------------
describe("headlineFigures: fees skipped, no schedule, no volume, nothing priced", () => {
  it("skipped: shipping only, the all-in and fees views say why, and every rule is listed with its rate and an Add link", () => {
    for (const view of ["allin", "fees"] as const) {
      const h = headlineFigures(skipped, view, { addHref: ADD });
      expect(h.amount).toBeNull();
      expect(h.unavailable).toBe("Fulfillment costs were skipped for this model, so only shipping is shown.");
      expect(h.complete).toBe(false);
      expect(headlineText(h)).toBe("Not computed");
    }
    expect(headlineFigures(skipped, "shipping")).toMatchObject({ amount: "12.50", complete: true });
    expect(defaultView(skipped)).toBe("shipping");
    const g = notIncludedGroups(skipped, { addHref: ADD });
    expect(g.needNumbers.map((i) => [i.name, i.reason, i.addHref])).toEqual([
      ["Order pick", "fulfillment costs were skipped", ADD],
      ["Box", "fulfillment costs were skipped", ADD],
      ["Pallet storage", "fulfillment costs were skipped", ADD],
      ["Account fee", "fulfillment costs were skipped", ADD],
      ["Inserts", "fulfillment costs were skipped", ADD],
    ]);
  });

  it("no fee schedule: shipping only, with one line saying so", () => {
    const h = headlineFigures(noSchedule, "allin");
    expect(h).toMatchObject({ amount: null, unavailable: "No fee schedule was in effect for this model, so only shipping is shown.", parts: [] });
    expect(defaultView(noSchedule)).toBe("shipping");
    expect(notIncludedGroups(noSchedule)).toMatchObject({ needNumbers: [], notOnSchedule: [{ label: "Every fulfillment fee", detail: "No fee schedule was in effect for this model." }] });
    expect(monthlyCharges(noSchedule)).toBeNull();
    expect(minimumViews(noSchedule)).toEqual([]);
    expect(volumeSensitivity(noSchedule)).toEqual([]);
  });

  it("zero volume: the monthly charges are still listed, but no per-order figure exists", () => {
    const h = headlineFigures(zeroVolume, "allin");
    expect(h.amount).toBeNull();
    expect(h.unavailable).toBe("Your monthly order volume is 0, so charges cannot be spread per order.");
    expect(h.parts).toEqual([]);
    expect(h.basisSentence).toBe("Your monthly order volume is 0, so monthly charges are not spread over orders.");
    const m = monthlyCharges(zeroVolume)!;
    expect(m.totalPerMonth).toBe("205.00");
    expect(m.perOrder).toBeNull();
    expect(volumeSensitivity(zeroVolume)).toEqual([]);
  });

  it("no volume at all: says to state one rather than showing a figure", () => {
    const h = headlineFigures(noVolume, "allin");
    expect(h.amount).toBeNull();
    expect(h.unavailable).toBe("No monthly order volume is known, so monthly charges cannot be spread over your orders. State a volume and run the model again.");
    expect(h.basisSentence).toBe("No monthly volume is known, so monthly charges are not spread over your orders.");
    // The minimum could not be worked out without dates; the card says so and gives no dollar figure.
    expect(minimumViews(noVolume)[0]).toMatchObject({ status: "not_computed", couldAdd: "This minimum could not be worked out because no order in the file has a date. It is not included in the all-in figure." });
  });

  it("no order priced with fees: never an all-in made of monthly charges alone", () => {
    for (const run of [noContent, notEffective]) {
      for (const view of ["allin", "fees"] as const) {
        const h = headlineFigures(run, view);
        expect(h.amount).toBeNull();
        expect(h.complete).toBe(false);
      }
      expect(headlineFigures(run, "shipping").amount).toBe("12.50");
    }
    expect(headlineFigures(noContent, "allin").unavailable).toBe("No order could be priced with fees: there is no order content to price from.");
    expect(headlineFigures(notEffective, "fees").unavailable).toBe("No order could be priced with fees: no fee schedule was in effect on the order date.");
    // The rules are named as not modeled, with the reason, and "add" is offered for missing content.
    const g = notIncludedGroups(noContent, { addHref: ADD });
    expect(g.needNumbers.map((i) => i.name)).toEqual(["Order pick", "Box", "Inserts"]);
    expect(notIncludedGroups(notEffective, { addHref: ADD }).needNumbers).toEqual([]);
    expect(notIncludedGroups(notEffective, { addHref: ADD }).notOnSchedule.map((i) => i.label)).toEqual(expect.arrayContaining(["Order pick", "Box", "Inserts"]));
  });
});

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------
describe("volumeSensitivity", () => {
  it("reproduces the stored figures at 1x and scales shipping and order fees from exact totals", () => {
    // Exact monthly: shipping 25.00 + order fees 3.875 = 28.875; fixed 205.00 (storage 180 + account fee 25)
    expect(volumeSensitivity(noMinimumRun)).toEqual([
      { multiplier: "0.5", monthlyOrders: "1", monthlyTotal: "219.44", allInPerOrder: "219.44", known: true }, // 14.4375 + 205 = 219.4375
      { multiplier: "1", monthlyOrders: "2", monthlyTotal: "233.88", allInPerOrder: "116.94", known: true }, // stored
      { multiplier: "2", monthlyOrders: "4", monthlyTotal: "262.75", allInPerOrder: "65.69", known: true }, // 57.75 + 205 = 262.75; /4 = 65.6875
      { multiplier: "4", monthlyOrders: "8", monthlyTotal: "320.50", allInPerOrder: "40.06", known: true }, // 115.5 + 205 = 320.5; /8 = 40.0625
    ]);
  });

  it("scales only the monthly charges that follow volume (a returns rate)", () => {
    // V = 1,000: shipping 12,500 + order fees 1,937.50 = 14,437.50 variable; fixed 205.00; returns 100 x $3 = 300.00 scales with volume
    expect(volumeSensitivity(returnsRun)).toEqual([
      { multiplier: "0.5", monthlyOrders: "500", monthlyTotal: "7573.75", allInPerOrder: "15.15", known: true }, // 7,218.75 + 205 + 150 = 7,573.75; /500 = 15.1475
      { multiplier: "1", monthlyOrders: "1000", monthlyTotal: "14942.50", allInPerOrder: "14.94", known: true },
      { multiplier: "2", monthlyOrders: "2000", monthlyTotal: "29680.00", allInPerOrder: "14.84", known: true }, // 28,875 + 205 + 600
      { multiplier: "4", monthlyOrders: "4000", monthlyTotal: "59155.00", allInPerOrder: "14.79", known: true }, // 57,750 + 205 + 1,200 = 59,155; /4000 = 14.78875
    ]);
  });

  it("works the account minimum out again for each month at each volume, from the stored month figures", () => {
    // Order charges counted in March 3.50 and in April 4.25, storage 180 in both; the $500 minimum is checked month by month.
    //   0.5x: March 1.75 + 180, April 2.125 + 180: adds 318.25 + 317.875 = 636.125, 318.0625 a month; total 14.4375 + 205 + 318.0625 = 537.50
    //   2x:   March 7.00 + 180, April 8.50 + 180:  adds 313.00 + 311.50 = 624.50,  312.25 a month;   total 57.75 + 205 + 312.25 = 575.00
    //   4x:   March 14.00 + 180, April 17.00 + 180: adds 306.00 + 303.00 = 609.00, 304.50 a month;   total 115.50 + 205 + 304.50 = 625.00
    expect(volumeSensitivity(complete)).toEqual([
      { multiplier: "0.5", monthlyOrders: "1", monthlyTotal: "537.50", allInPerOrder: "537.50", known: true },
      { multiplier: "1", monthlyOrders: "2", monthlyTotal: "550.00", allInPerOrder: "275.00", known: true },
      { multiplier: "2", monthlyOrders: "4", monthlyTotal: "575.00", allInPerOrder: "143.75", known: true },
      { multiplier: "4", monthlyOrders: "8", monthlyTotal: "625.00", allInPerOrder: "78.13", known: true }, // 78.125
    ]);
  });

  it("a minimum that is not exact stays out, as in the headline; a monthly charge inside its set that follows volume grows with it", () => {
    const points = volumeSensitivity(noStorageAnswer);
    expect(points[0]).toMatchObject({ monthlyOrders: "1", known: true });
    // Without the minimum: 14.4375 + 25 = 39.4375 a month, per order 39.44 at half the volume.
    expect(points[0]).toMatchObject({ monthlyTotal: "39.44", allInPerOrder: "39.44" });
    // A schedule with no minimum rule has no top-up at any volume.
    expect(volumeSensitivity(returnsRun).every((p) => p.known)).toBe(true);
  });

  it("rejects a multiplier that is not a positive decimal", () => {
    expect(() => volumeSensitivity(noMinimumRun, ["0"])).toThrow(/positive decimal/);
    expect(() => volumeSensitivity(noMinimumRun, ["-1"])).toThrow(/positive decimal/);
  });
});

// ---------------------------------------------------------------------------
// Monthly charges
// ---------------------------------------------------------------------------
describe("monthlyCharges", () => {
  it("echoes the inputs of every line and splits fixed charges from the ones that follow volume", () => {
    const m = monthlyCharges(complete)!;
    expect(m.lines.map((l) => [l.name, l.quantity, l.unitAmount, l.amount, l.chargeClass, l.scalesWithVolume])).toEqual([
      ["Pallet storage", "10", "18.00", "180.00", "estimated", false],
      ["Account fee", "1", "25.00", "25.00", "definite", false],
    ]);
    expect(m.lines[0]?.explanation).toContain("10 pallets");
    expect(m.lines[0]?.explanation).toContain("$180.00");
    expect(m).toMatchObject({ fixedPerMonth: "205.00", volumeLinkedPerMonth: null, totalPerMonth: "205.00", perOrder: "102.50", notModeled: [] });
    expect(m.basisSentence).toBe("2 orders a month over Mar 1, 2026–Apr 30, 2026 (2 months)");
    // The per-order figure is the allocation's own (the minimum top-up is the next card's business).
    expect(complete.allocation?.perOrder.allocated).toBe("260.56");
  });

  it("lists a charge with no number given with its rate, never as $0", () => {
    const m = monthlyCharges(noStorageAnswer)!;
    expect(m.lines.map((l) => l.name)).toEqual(["Account fee"]);
    expect(m.notModeled).toEqual([{ name: "Pallet storage", category: "storage", rate: "$18.00 per pallet per month", reason: "no number was given", addable: true }]);
    expect(m.totalPerMonth).toBe("25.00");
  });

  it("separates the volume-linked part: $205.00 whatever you ship plus $300.00 that grows with orders", () => {
    const m = monthlyCharges(returnsRun)!;
    expect(m).toMatchObject({ fixedPerMonth: "205.00", volumeLinkedPerMonth: "300.00", totalPerMonth: "505.00", perOrder: "0.51" }); // 0.505, HALF_UP
    expect(returnsRun.allocation?.perOrder.allocated).toBe("0.51");
  });
});

// ---------------------------------------------------------------------------
// Order fees table and per-order rows
// ---------------------------------------------------------------------------
describe("orderFeeRows", () => {
  it("lists every order rule of the schedule with its rate, the totals by class and the orders charged", () => {
    expect(orderFeeRows(complete)).toEqual([
      { name: "Order pick", category: "pick_pack", rate: "$1.50 per order.", definite: "6.00", estimated: "0.00", orders: 4, notComputed: null, addable: false, replacedOrders: 0 },
      { name: "Box", category: "packaging", rate: expect.stringContaining("$0.50"), definite: "1.50", estimated: "0.00", orders: 2, notComputed: null, addable: false, replacedOrders: 0 },
      { name: "Inserts", category: "other", rate: expect.stringContaining("$0.25"), definite: "0.00", estimated: "0.25", orders: 1, notComputed: null, addable: false, replacedOrders: 0 },
    ]);
  });

  it("says how many orders a rule could not be computed on, and why", () => {
    const D = modeledOrder("D", 4, "2026-04-18", "8.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "inserts", reason: "assumption_missing" }] }));
    const rows = orderFeeRows(finalize([A, B, C, D]));
    expect(rows.find((r) => r.name === "Inserts")).toMatchObject({ orders: 0, notComputed: "1 order: no answer was given", addable: true });
  });

  it("turns an unmatched packaging type into a row named in words", () => {
    const tube = modeledOrder("T", 5, "2026-04-20", "9.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "packaging:tube", reason: "packaging_unmatched" }] }));
    const rows = orderFeeRows(finalize([A, B, C, D2, tube], {}, { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 }));
    expect(rows.find((r) => r.name === "Packaging (tube)")).toMatchObject({ rate: "No charge on the fee schedule covers this packaging type.", notComputed: "1 order: no charge on the fee schedule covers the packaging type", addable: false });
  });
});

describe("orderRowFigures", () => {
  const names = ruleNameIndex(complete);

  it("adds exact amounts and rounds once: $1.2345 of fees plus $2.50 of shipping is $3.73, fees alone $1.23", () => {
    const row = orderRowFigures({ feeStatus: "ok", definiteE4: 12345, estimatedE4: 0, shippingExpected: "2.50", unresolved: [] }, names);
    expect(row).toEqual({ shipping: "2.50", fees: "1.23", feesAtLeast: false, combined: "3.73", feeStatus: "priced", notComputed: null });
  });

  it("a rule that could not be computed makes the fees a lower bound and names the rule (a replaced rule is not a gap)", () => {
    const row = orderRowFigures({ feeStatus: "partial", definiteE4: 15000, estimatedE4: 0, shippingExpected: "8.00", unresolved: [{ ruleKey: "inserts", reason: "assumption_missing" }, { ruleKey: "pack_box", reason: "replaced" }] }, names);
    expect(row).toMatchObject({ fees: "1.50", feesAtLeast: true, combined: "9.50", feeStatus: "partly priced", notComputed: "Inserts" });
  });

  it("an order whose fees were not computed has no fee figure and no combined figure, with the reason", () => {
    const row = orderRowFigures({ feeStatus: "no_content", definiteE4: 0, estimatedE4: 0, shippingExpected: "8.00", unresolved: [] }, names);
    expect(row).toEqual({ shipping: "8.00", fees: null, feesAtLeast: false, combined: null, feeStatus: "not computed", notComputed: "There is no order content to price from" });
    expect(orderRowFigures({ feeStatus: "not_effective", definiteE4: 0, estimatedE4: 0, shippingExpected: null, unresolved: [] }, names).notComputed).toBe("No fee schedule was in effect on the order date");
  });

  it("an order whose shipping was not priced has fees but no combined figure", () => {
    const row = orderRowFigures({ feeStatus: "ok", definiteE4: 20000, estimatedE4: 0, shippingExpected: null, unresolved: [] }, names);
    expect(row).toMatchObject({ shipping: null, fees: "2.00", combined: null });
  });

  it("never prints a rule key, even for a key the summary does not know", () => {
    const row = orderRowFigures({ feeStatus: "partial", definiteE4: 0, estimatedE4: 0, shippingExpected: "1.00", unresolved: [{ ruleKey: "secret_rule_key", reason: "units_unknown" }] }, names);
    expect(row.notComputed).toBe("A fee");
  });
});

// ---------------------------------------------------------------------------
// Account minimum
// ---------------------------------------------------------------------------
describe("minimumViews", () => {
  it("shows an exact minimum month by month, with the average added, and marks every member", () => {
    const [m] = minimumViews(complete);
    expect(m).toMatchObject({ name: "Monthly minimum", status: "exact", includesShipping: false, oneLine: null, couldAdd: null, averageAdded: "316.13" });
    expect(m?.buckets).toEqual([
      { label: "Mar 2026", minimum: "500.00", counted: "183.50", added: "316.50", prorated: false },
      { label: "Apr 2026", minimum: "500.00", counted: "184.25", added: "315.75", prorated: false },
    ]);
    expect(m?.members.map((x) => [x.name, x.label])).toEqual([["Order pick", "Counted"], ["Box", "Counted"], ["Inserts", "Counted"], ["Pallet storage", "Counted"]]);
  });

  it("a one-month period reads as one line: fees counted, minimum, added", () => {
    const [m] = minimumViews(oneMonth);
    expect(m?.oneLine).toBe("Fees counted toward the minimum: $183.50 · Minimum: $500.00 · Added: $316.50");
  });

  it("an upper bound says what it could add at most and why it is not exact; the unmodeled member is marked", () => {
    const [m] = minimumViews(noStorageAnswer);
    expect(m).toMatchObject({ status: "upper_bound", buckets: [], oneLine: null, averageAdded: null, couldAdd: "This minimum could add up to $496.13 a month. It is not included in the all-in figure because it could not be worked out exactly: Pallet storage is not modeled." });
    expect(m?.members.find((x) => x.name === "Pallet storage")?.label).toBe("Not modeled");
  });

  it("names a member that left the schedule generically: the engine only knows its key", () => {
    const base = minimumViews(complete);
    expect(base).toHaveLength(1);
    const tampered = { ...complete, minimums: [{ ...complete.minimums[0]!, members: [{ ruleKey: "gone_rule_key", name: "gone_rule_key", state: "not_in_schedule" as const }] }] } as BulkSummary;
    const [m] = minimumViews(tampered);
    expect(m?.members).toEqual([{ name: "A charge that is no longer on the fee schedule", state: "not_in_schedule", label: "Not on your fee schedule" }]);
    expect(JSON.stringify(m)).not.toContain("gone_rule_key");
  });

  it("a minimum that counts shipping says so: what was counted is fees and shipping, never labelled as fees alone", () => {
    const withShipping = { ...schedule, rules: schedule.rules.map((r) => (r.basis === "minimum" ? { ...r, minimum: { ...r.minimum!, includesShipping: true } } : r)) };
    const march = { ...period, to: "2026-03-31", days: 31, months: "1.000000", population: 2, inPeriod: 2, monthlyOrders: "2.0000", monthProfile: [{ month: "2026-03", fraction: "1.000000", orders: 2 }] };
    const s = finalize([A, B], { monthlySchedule: withShipping, period: march }, { rows: 2, orders: 2, shipments: 2, packages: 2 });
    // Pick $3.00 + box $0.50 + storage $180.00 + expected shipping $22.00 = $205.50 counted toward $500.00.
    expect(s.minimums[0]).toMatchObject({ includesShipping: true, countedE4: 2055000 });
    const [m] = minimumViews(s);
    expect(m).toMatchObject({ includesShipping: true, oneLine: "Fees and shipping counted toward the minimum: $205.50 · Minimum: $500.00 · Added: $294.50" });
    // A minimum that does not count shipping keeps the plain wording.
    expect(minimumViews(oneMonth)[0]).toMatchObject({ includesShipping: false });
    expect(minimumViews(oneMonth)[0]?.oneLine).toMatch(/^Fees counted toward the minimum: /);
  });

  it("a run whose version has no minimum has nothing to show", () => {
    expect(minimumViews(noMinimumRun)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
describe("provenance lines", () => {
  it("names the tenant, the schedule and the date it came into effect", () => {
    expect(feeScheduleLine("Acme 3PL", complete.provenance)).toBe("Acme 3PL fee schedule 'Standard fulfillment', in effect from Jan 1, 2026");
    expect(feeScheduleLine("Acme 3PL", null)).toBeNull();
    expect(feeScheduleLine("Acme 3PL", { scheduleName: "Standard", versions: [{ effectiveDate: "2026-07-01" }, { effectiveDate: "2026-01-01" }] })).toBe("Acme 3PL fee schedule 'Standard', in effect from Jan 1, 2026 (with changes from Jul 1, 2026 for later orders)");
    expect(JSON.stringify(feeScheduleLine("Acme 3PL", complete.provenance))).not.toContain("v-1");
  });

  it("says who entered the assumptions", () => {
    expect(assumptionsLine("tenant", "Acme 3PL", "2026-10-14T09:00:00Z")).toBe("Assumptions entered by Acme 3PL on Oct 14, 2026");
    expect(assumptionsLine("you", "Acme 3PL", "2026-10-14T09:00:00Z")).toBe("Assumptions entered by you on Oct 14, 2026");
    expect(assumptionsLine("other", "Acme 3PL", "2026-10-14")).toBe("Assumptions entered by another user on Oct 14, 2026");
  });

  it("fees have changed when the version in effect today is not one the run was priced with", () => {
    expect(feesChangedSince(["v-1"], { status: "ok", versionId: "v-1" })).toBe(false);
    expect(feesChangedSince(["v-1"], { status: "ok", versionId: "v-2" })).toBe(true);
    expect(feesChangedSince(["v-1", "v-2"], { status: "ok", versionId: "v-2" })).toBe(false);
    expect(feesChangedSince(["v-1"], { status: "none" })).toBe(true);
    // A failed lookup is never reported as a change, and a run priced without fees has nothing to compare.
    expect(feesChangedSince(["v-1"], { status: "unknown" })).toBe(false);
    expect(feesChangedSince([], { status: "ok", versionId: "v-2" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------
describe("compareFacts", () => {
  it("states the basis of a file run, with the fee schedule date, what is left out and the minimum status", () => {
    const f = compareFacts(complete);
    expect(f).toMatchObject({
      source: "file",
      sourceText: "Orders file",
      ordersPerMonthText: "2 (from the file)",
      periodText: "Mar 1, 2026–Apr 30, 2026 (2 months)",
      feeScheduleText: "'Standard fulfillment', in effect from Jan 1, 2026",
      leftOutText: "Nothing left out",
      minimumText: "Adds $316.13 a month",
      shippingPerOrder: "12.50",
      feesPerOrder: "1.94",
      shippingPlusFees: "14.44",
      shippingPlusFeesAtLeast: false,
      monthlyChargesPerOrder: "260.56",
    });
    expect(f.allIn.amount).toBe("275.00");
  });

  it("two runs are only comparable on the all-in rows when they leave out the same things", () => {
    const a = compareFacts(complete);
    const b = compareFacts(noStorageAnswer);
    expect(a.allInSetKey).not.toBe(b.allInSetKey);
    expect(compareFacts(finalize([A, B, C, D2])).allInSetKey).toBe(a.allInSetKey);
    expect(b).toMatchObject({ leftOutText: "storage", minimumText: "Up to $496.13 a month, not included", shippingPlusFees: "14.44", shippingPlusFeesAtLeast: false });
  });

  it("skipped and no-schedule runs have shipping but no fee or all-in figures", () => {
    expect(compareFacts(skipped)).toMatchObject({ feeScheduleText: "Fulfillment costs skipped", leftOutText: "Every fulfillment fee (skipped)", minimumText: "No account minimum", shippingPlusFees: null, feesPerOrder: null, shippingPerOrder: "12.50" });
    expect(compareFacts(noSchedule)).toMatchObject({ feeScheduleText: "No fee schedule", leftOutText: "Every fulfillment fee (no fee schedule)", shippingPlusFees: null });
    expect(compareFacts(skipped).allInSetKey).not.toBe(compareFacts(noSchedule).allInSetKey);
  });

  it("a stated volume is labelled as stated", () => {
    expect(compareFacts(zeroVolume).ordersPerMonthText).toBe("0 (you stated it)");
    expect(compareFacts(noVolume).ordersPerMonthText).toBe("Not known");
  });

  it("flags volumes that differ by more than 5 % of the larger", () => {
    expect(volumeDiffers("1000", "1049")).toBe(false);
    expect(volumeDiffers("950", "1000")).toBe(false); // exactly 5 %
    expect(volumeDiffers("1000", "1060")).toBe(true);
    expect(volumeDiffers(null, "1000")).toBe(false);
    expect(volumeDiffers("0", "0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Forecasts from assumptions go through the same function
// ---------------------------------------------------------------------------
describe("forecast summaries", () => {
  const summary = forecast();

  it("is recognised, and its headline reads the stored allocation", () => {
    expect(isForecastSummary(summary)).toBe(true);
    expect(isForecastSummary(complete)).toBe(false);
    const h = headlineFigures(summary, "allin");
    expect(h.amount).toBe(summary.allocation!.perOrder.allIn);
    expect(h.basisSentence).toBe("1,250 orders a month, as described in the forecast");
    expect(h.caveats[0]).toMatch(/^A forecast from your assumptions/);
    expect(headlineFigures(summary, "shipping").amount).toBe(summary.shipping.perOrder);
    expect(headlineFigures(summary, "fees").amount).toBe(summary.processing!.perOrder);
    expect(headlineFigures(summary, "shipping").basisSentence).toBe("Forecast at 1,250 orders a month");
  });

  it("labels a forecast by its completeness exactly as a file run", () => {
    const complete = summary.completeness.every((c) => c.state !== "not_modeled");
    const h = headlineFigures(summary, "allin");
    if (complete && (summary.minimumStatus === "exact" || summary.minimumStatus === "none")) {
      expect(h.label).toBe("All-in cost per order");
      expect(h.qualifier).toBe("");
    }
    const noPallets = forecast(forecastAssumptions({ fulfillment: { ...forecastAssumptions().fulfillment, drivers: { pallets_stored: null, long_term_pallets: null, pallets_received: "4", cases_received: "20", returns_rate: "3" } } }));
    const h2 = headlineFigures(noPallets, "allin", { addHref: "/portal/model/forecast/p-1" });
    expect(h2.label).toMatch(/^All-in cost per order, without /);
    expect(h2.qualifier).toBe("At least");
    expect(h2.notIncluded.length).toBeGreaterThan(0);
    expect(h2.notIncluded.every((i) => i.addHref === "/portal/model/forecast/p-1")).toBe(true);
  });

  it("the sensitivity at 1x is the stored allocation, and the other rows re-evaluate the minimum in the engine", () => {
    const points = volumeSensitivity(summary);
    expect(points.map((p) => p.multiplier)).toEqual(["0.5", "1", "2", "4"]);
    expect(points[1]).toMatchObject({ monthlyOrders: "1250", monthlyTotal: summary.allocation!.monthly.total, allInPerOrder: summary.allocation!.perOrder.allIn, known: true });
    expect(points.every((p) => p.known)).toBe(true);
  });

  it("compare facts say it is a forecast over a typical month", () => {
    const f = compareFacts(summary);
    expect(f).toMatchObject({ source: "assumptions", sourceText: "Forecast from assumptions", periodText: "A typical month, as described", ordersPerMonthText: "1,250 (as described)" });
    expect(f.shippingPlusFees).not.toBeNull();
    expect(f.feeScheduleText).toContain("in effect from");
  });

  it("diffs two forecasts' assumptions in words", () => {
    const a = forecast().profile;
    const b = forecast(forecastAssumptions({ monthlyOrders: "1400", residentialPct: "60" })).profile;
    expect(diffForecastProfiles(a, b)).toEqual(["orders a month 1,250 → 1,400", "home deliveries 80% → 60%"]);
    expect(diffForecastProfiles(a, a)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Brand safety: nothing the customer sees carries a rule key, an id or a version
// ---------------------------------------------------------------------------
describe("customer-safe output", () => {
  const FORBIDDEN = /pick_order|pack_box|storage_pallet|returns_proc|packaging:[a-z_*]|\br-(pick|box|pallet|admin|min|ins|ret)\b|\bv-1\b|\bs-1\b/;
  const everything = (s: BulkSummary) =>
    JSON.stringify({
      headlines: (["shipping", "fees", "allin"] as const).map((v) => headlineFigures(s, v, { addHref: ADD }, "brand")),
      groups: notIncludedGroups(s, { addHref: ADD }, "brand"),
      monthly: monthlyCharges(s),
      rows: orderFeeRows(s),
      minimums: minimumViews(s),
      facts: compareFacts(s),
      sensitivity: volumeSensitivity(s),
      provenance: feeScheduleLine("Acme 3PL", s.provenance),
    });

  it("holds for every scenario", () => {
    for (const s of [complete, noStorageAnswer, noMinimumRun, undated, lowCoverage, skipped, noSchedule, noContent, notEffective, zeroVolume, noVolume, returnsRun]) {
      expect(everything(s)).not.toMatch(FORBIDDEN);
    }
  });

  it("holds for a packaging type nobody prices", () => {
    const tube = modeledOrder("T", 5, "2026-04-20", "9.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "packaging:tube", reason: "packaging_unmatched" }] }));
    const s = finalize([A, B, C, D2, tube], {}, { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 });
    expect(everything(s)).not.toMatch(FORBIDDEN);
    const h = headlineFigures(s, "allin", { addHref: ADD });
    expect(h.label).toBe("All-in cost per order, without packaging");
    // Not fixable by entering numbers, so it is listed as not covered by the schedule rather than offered an Add link.
    expect(h.notIncluded.map((i) => i.name)).not.toContain("Packaging (tube)");
    expect(notIncludedGroups(s, { addHref: ADD }).notOnSchedule.map((i) => i.label)).toContain("Packaging (tube)");
  });
});

// ---------------------------------------------------------------------------
// Compare two models (basis rows, the comparable row, greyed all-in rows, warnings, assumptions diff)
// ---------------------------------------------------------------------------
const FORBIDDEN_TEXT = /pick_order|pack_box|storage_pallet|returns_proc|packaging:[a-z_*]|\br-(pick|box|pallet|admin|min|ins|ret)\b|\bv-1\b|\bs-1\b/;
const baseRun: Omit<CompareRunInput, "summary" | "assumptions"> = { datasetId: "d1", datasetName: "March orders", rateCardName: "Fixture card", pricingBasis: "fixed_date", asOfDate: "2026-03-15", serviceOverrideId: null, serviceOverrideName: null, overrideAllServices: false };
const withAnswers = (drivers: Record<string, string | null>) => ({ fulfillment: { drivers, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } } });
const fileRun = (summary: BulkSummary, drivers: Record<string, string | null> | null = null, over: Partial<typeof baseRun> = {}): CompareRunInput => ({ ...baseRun, ...over, summary, assumptions: drivers ? withAnswers(drivers) : null });
const rowOf = (c: ReturnType<typeof buildComparison>, label: string) => c.rows.find((r) => r.label === label)!;

describe("buildComparison", () => {
  it("puts the basis rows first, then the per-order figures, then the all-in rows", () => {
    const c = buildComparison(fileRun(complete), fileRun(complete));
    expect(c.rows[0]).toMatchObject({ group: "basis", label: "Based on", a: "Orders file", b: "Orders file" });
    const order = c.rows.map((r) => r.group);
    expect(order).toEqual([...order].sort((x, y) => ["basis", "figures", "allin"].indexOf(x) - ["basis", "figures", "allin"].indexOf(y)));
    expect(c.rows.filter((r) => r.group === "basis").map((r) => r.label)).toEqual(["Based on", "Orders file", "Rate card", "Rates", "Priced on", "Orders a month", "Period", "Fee schedule", "Orders modeled", "Left out of the all-in", "Account minimum"]);
    expect(rowOf(c, "Orders a month")).toMatchObject({ a: "2 (from the file)", b: "2 (from the file)" });
    expect(rowOf(c, "Fee schedule").a).toBe("'Standard fulfillment', in effect from Jan 1, 2026");
    expect(rowOf(c, "Account minimum").a).toBe("Adds $316.13 a month");
  });

  it("two identical models: all-in rows comparable and nothing flagged", () => {
    const c = buildComparison(fileRun(complete, { pallets: "10" }), fileRun(complete, { pallets: "10" }));
    expect(c).toMatchObject({ warnings: [], changes: [], allInComparable: true, allInNote: null });
    expect(c.rows.every((r) => !r.muted && r.note === null)).toBe(true);
    expect(rowOf(c, "All-in cost per order").a).toBe("$275.00");
  });

  it("a model that left storage out: the all-in rows are greyed with a note and the comparable row is not; the changed answer is named", () => {
    const c = buildComparison(fileRun(complete, { pallets: "10" }), fileRun(noStorageAnswer, {}));
    expect(c.allInComparable).toBe(false);
    const allIn = c.rows.filter((r) => r.group === "allin");
    expect(allIn.length).toBeGreaterThan(0);
    expect(allIn.every((r) => r.muted)).toBe(true);
    // Not colour alone: the label and the note say it too.
    const headline = rowOf(c, "All-in cost per order (not comparable)");
    expect(headline).toMatchObject({ a: "$275.00", b: "At least $26.94 (without storage)" });
    expect(headline.note).toContain("leave out different things");
    expect(headline.note).toContain('Compare "Shipping + order fees" instead.');
    // Shipping + order fees is the same in both, and stays comparable.
    expect(rowOf(c, "Shipping + order fees (comparable)")).toMatchObject({ a: "$14.44", b: "$14.44", muted: false, note: null });
    expect(rowOf(c, "Left out of the all-in")).toMatchObject({ a: "Nothing left out", b: "storage" });
    expect(rowOf(c, "Account minimum")).toMatchObject({ a: "Adds $316.13 a month", b: "Up to $496.13 a month, not included" });
    expect(c.changes).toEqual(["pallet storage 10 → left out"]);
  });

  it("monthly charges that were all left out are Not computed on the spread-over-orders row, never $0.00; a partial set says At least", () => {
    const onlyStorage = { ...noMinimum, rules: noMinimum.rules.filter((r) => r.key !== "admin") };
    const nothing = finalize([A, B, C, D2], { monthlySchedule: onlyStorage, answers: { drivers: {}, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } } });
    expect(nothing.allocation?.perOrder.allocated).toBe("0.00"); // the allocation of nothing: an exact zero that must not be shown
    expect(compareFacts(nothing).monthlyChargesPerOrder).toBeNull();
    const c = buildComparison(fileRun(nothing), fileRun(noStorageAnswer));
    const spread = rowOf(c, "Monthly charges spread over orders (with any account minimum)");
    // Storage left out: only the $25.00 account fee over 2 orders a month is priced, so $12.50 is a lower bound.
    expect(spread).toMatchObject({ a: "Not computed", b: "At least $12.50" });
    expect(rowOf(c, "Monthly charges a month (without the account minimum)")).toMatchObject({ a: "Not computed", b: "At least $25.00 a month" });
    expect(buildComparison(fileRun(complete), fileRun(skipped)).rows.find((r) => r.label.startsWith("Monthly charges spread"))?.b).toBe("Not computed");
  });

  it("order fees that leave a category out read At least on the Order fees row, as on the model's own page", () => {
    const tube = modeledOrder("T", 5, "2026-04-20", "9.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "packaging:tube", reason: "packaging_unmatched" }] }));
    const withTube = finalize([A, B, C, D2, tube], {}, { ...counts, orders: 5, shipments: 5, packages: 5, rows: 5 });
    const c = buildComparison(fileRun(withTube), fileRun(complete));
    expect(rowOf(c, "Order fees per order")).toMatchObject({ a: "At least $1.85", b: "$1.94" });
    expect(rowOf(c, "Shipping + order fees (comparable)")).toMatchObject({ a: "At least $13.65", b: "$14.44" });
  });

  it("a changed answer to a question the summaries do not name is described generically, never by its key", () => {
    const a = { ...fileRun(complete), assumptions: { fulfillment: { drivers: { pallets: "10", ghost_driver_key: "4" }, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } } } };
    const b = { ...fileRun(complete), assumptions: { fulfillment: { drivers: { pallets: "10" }, orderShares: { inserts: { sharePct: "50.00", countPerOrder: 2 } } } } };
    const c = buildComparison(a, b);
    expect(c.changes).toEqual(["a fulfillment answer 4 → left out", "a fulfillment answer 25% of orders × 1 → 50% of orders × 2"]);
    expect(JSON.stringify(c)).not.toMatch(/ghost[_ ]driver/);
  });

  it("warns when the volumes differ by more than 5 %", () => {
    const c = buildComparison(fileRun(complete), fileRun(returnsRun));
    expect(c.warnings).toContain("The two models are at different volumes (2 and 1,000 orders a month), so monthly charges spread over orders are not directly comparable.");
    expect(buildComparison(fileRun(complete), fileRun(complete)).warnings.some((w) => w.includes("different volumes"))).toBe(false);
  });

  it("warns about different files, pricing dates, services and coverage", () => {
    const c = buildComparison(fileRun(complete), fileRun(lowCoverage, null, { datasetId: "d2", asOfDate: "2026-04-01", serviceOverrideId: "svc-9", serviceOverrideName: "UPS Ground", overrideAllServices: true }));
    expect(c.warnings).toEqual(expect.arrayContaining(["Different orders files were modeled, so the averages are not directly comparable.", "The share of orders that could be priced differs by more than 5 points.", "The two models use different pricing dates.", "The two models price shipments on different services (one is a what-if)."]));
    expect(rowOf(c, "Priced on")).toMatchObject({ a: "services in the file", b: "everything on UPS Ground" });
  });

  it("a model without fees has shipping but no fee figures, and the warning says only shipping can be compared", () => {
    const c = buildComparison(fileRun(complete), fileRun(skipped));
    expect(c.warnings).toContain("Order fees are not modeled in one of these (skipped, or no fee schedule in effect), so only shipping can be compared.");
    expect(rowOf(c, "Shipping + order fees (comparable)")).toMatchObject({ a: "$14.44", b: "Not computed" });
    expect(rowOf(c, "Order fees per order").b).toBe("Not computed");
    expect(rowOf(c, "Shipping per order").b).toBe("$12.50");
    expect(rowOf(c, "Fee schedule").b).toBe("Fulfillment costs skipped");
  });

  it("a forecast is compared through the same rows, and the warning says what kind of figure each is", () => {
    const forecastRun = { ...baseRun, datasetId: null, datasetName: null, summary: forecast(), assumptions: forecastAssumptions() as never };
    const c = buildComparison(forecastRun, fileRun(complete));
    expect(c.warnings[0]).toMatch(/^One of these is a forecast from assumptions and the other is built from an orders file/);
    expect(rowOf(c, "Based on")).toMatchObject({ a: "Forecast from assumptions", b: "Orders file" });
    expect(rowOf(c, "Orders file")).toMatchObject({ a: "—", b: "March orders" });
    expect(rowOf(c, "Period").a).toBe("A typical month, as described");
    expect(rowOf(c, "Orders modeled").a).toMatch(/% of the volume$/);
    expect(rowOf(c, "Per package").a).toBe("—");
    // A forecast's monthly "up to" amounts say they are monthly.
    expect(rowOf(c, "Could not be decided (up to)").a).toMatch(/ a month$/);
    expect(rowOf(c, "Shipping + order fees (comparable)").a).toMatch(/^\$\d/);
    expect(c.warnings.some((w) => w.includes("different volumes"))).toBe(true);
  });

  it("two forecasts: what differs in the profile and in the answers", () => {
    const a = { ...baseRun, datasetId: null, datasetName: null, summary: forecast(), assumptions: forecastAssumptions() as never };
    const changed = forecastAssumptions({ monthlyOrders: "1400", residentialPct: "60" });
    const b = { ...baseRun, datasetId: null, datasetName: null, summary: forecast(changed), assumptions: changed as never };
    const c = buildComparison(a, b);
    expect(c.changes).toEqual(["orders a month 1,250 → 1,400", "home deliveries 80% → 60%"]);
    expect(c.warnings).toEqual(["The two models are at different volumes (1,250 and 1,400 orders a month), so monthly charges spread over orders are not directly comparable."]);
    expect(c.allInComparable).toBe(true);
    const answers = forecastAssumptions({ fulfillment: { ...forecastAssumptions().fulfillment, drivers: { ...forecastAssumptions().fulfillment.drivers, pallets_stored: "14" } } });
    const d = buildComparison(a, { ...b, summary: forecast(answers), assumptions: answers as never });
    expect(d.changes).toEqual(["pallet storage 10 → 14"]);
  });

  it("never prints a rule key, an id or a version", () => {
    const runs = [complete, noStorageAnswer, noMinimumRun, undated, lowCoverage, skipped, noSchedule, noContent, notEffective, zeroVolume, noVolume, returnsRun].map((s) => fileRun(s, { pallets: "10" }));
    for (const x of runs) for (const y of runs) expect(JSON.stringify(buildComparison(x, y))).not.toMatch(FORBIDDEN_TEXT);
  });
});

// ---------------------------------------------------------------------------
// CSV exports
// ---------------------------------------------------------------------------
describe("csv helpers", () => {
  it("quotes what needs quoting and neutralises formulas in text from the customer's own file", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
    for (const bad of ["=SUM(A1)", "+1", "-1", "@cmd", "\tx"]) expect(csvText(bad)).toBe(`'${bad}`);
    expect(csvText("ORD-1001")).toBe("ORD-1001");
    expect(csvText("a=b")).toBe("a=b");
  });

  it("keeps a comment on one line, so a name with a line break cannot end it", () => {
    expect(csvComment('Plan "A"\r\n1,2\n3')).toBe('# Plan "A" 1,2 3');
  });
});

describe("orders.csv", () => {
  const names = ruleNameIndex(complete);
  const order = { externalOrderId: "ORD-1", orderDate: "2026-03-03", units: 3, lines: 2, packages: 1, shipments: 1, assumed: {}, feeStatus: "ok", definiteE4: 20000, estimatedE4: 0, shippingExpected: "10.00", unresolved: [] };

  it("has exactly the per-order columns: no allocated or all-in column, ever", () => {
    expect([...ORDERS_CSV_COLUMNS]).toEqual(["order_id", "order_date", "units", "lines", "packages", "shipments", "shipping_expected", "order_fees", "shipping_plus_fees", "fee_status", "not_computed"]);
    expect(ORDERS_CSV_COLUMNS.join(",")).not.toMatch(/all_in|allocated|monthly|per_order/);
  });

  it("a priced order: amounts to the cent, shipping + order fees rounded once", () => {
    expect(ordersCsvRecord(order, names)).toEqual(["ORD-1", "2026-03-03", "3", "2", "1", "1", "10.00", "2.00", "12.00", "priced", ""]);
    // $1.2345 of fees + $2.50 shipping: 3.7345 rounds to 3.73, fees alone 1.23.
    expect(ordersCsvRecord({ ...order, definiteE4: 12345, shippingExpected: "2.50" }, names).slice(6, 9)).toEqual(["2.50", "1.23", "3.73"]);
  });

  it("blank is not computed, never zero: unknown units, unpriced shipping, orders without fees", () => {
    const unknown = ordersCsvRecord({ ...order, units: null, lines: null, shippingExpected: null }, names);
    expect(unknown.slice(2, 4)).toEqual(["", ""]);
    expect(unknown.slice(6, 9)).toEqual(["", "2.00", ""]);
    const noFees = ordersCsvRecord({ ...order, feeStatus: "not_effective", definiteE4: 0 }, names);
    expect(noFees.slice(6, 11)).toEqual(["10.00", "", "", "not_computed", "No fee schedule was in effect on the order date"]);
    expect(ordersCsvRecord({ ...order, feeStatus: "skipped" }, names)[10]).toBe("Fulfillment costs were skipped");
  });

  it("assumed order content is marked and its units and lines left blank", () => {
    const r = ordersCsvRecord({ ...order, units: 2, lines: 1, assumed: { units: true, lines: true } }, names);
    expect(r.slice(2, 4)).toEqual(["", ""]);
    expect(r[9]).toBe("priced_on_assumed_content");
    expect(r[7]).toBe("2.00");
  });

  it("a rule that could not be computed makes the order partly priced and is named, joined by semicolons", () => {
    const r = ordersCsvRecord({ ...order, feeStatus: "partial", unresolved: [{ ruleKey: "pack_box", reason: "packaging_unknown" }, { ruleKey: "inserts", reason: "assumption_missing" }, { ruleKey: "pick_order", reason: "replaced" }] }, names);
    expect(r[9]).toBe("partly_priced");
    expect(r[10]).toBe("Box;Inserts");
    expect(r.join("|")).not.toMatch(FORBIDDEN_TEXT);
  });

  it("an order id that would run as a formula is neutralised", () => {
    expect(ordersCsvRecord({ ...order, externalOrderId: "=HYPERLINK(1)" }, names)[0]).toBe("'=HYPERLINK(1)");
  });

  it("the header comments carry the headline and its label, and say where the monthly charges are", () => {
    const meta = { scenarioName: "March plan", rateCardName: "Fixture card", feeScheduleLine: feeScheduleLine("Acme 3PL", complete.provenance) };
    const lines = ordersCsvComments(complete, meta);
    expect(lines.every((l) => l.startsWith("# ") && !l.includes("\n"))).toBe(true);
    expect(lines[0]).toBe("# Estimates for \"March plan\" from Fixture card and Acme 3PL fee schedule 'Standard fulfillment', in effect from Jan 1, 2026, not an invoice. Amounts in USD.");
    expect(lines[1]).toBe("# All-in cost per order: $275.00. 2 orders a month over Mar 1, 2026–Apr 30, 2026 (2 months).");
    expect(lines.join("\n")).toContain("monthly.csv");
    const incomplete = ordersCsvComments(noStorageAnswer, meta);
    expect(incomplete[1]).toMatch(/^# All-in cost per order, without storage: At least \$26\.94\./);
    expect(incomplete[1]).toContain("Not included yet: Pallet storage");
    expect(ordersCsvComments(skipped, meta)[1]).toMatch(/^# Estimated shipping cost per order: \$12\.50\./);
    expect(lines.join("\n")).not.toMatch(FORBIDDEN_TEXT);
  });
});

describe("monthly.csv", () => {
  const meta = { scenarioName: "March plan", rateCardName: "Fixture card", feeScheduleLine: feeScheduleLine("Acme 3PL", complete.provenance) };
  const lines = (csv: ReturnType<typeof monthlyCsv>) => csv.rows.map((r) => r.join(","));

  it("lists every monthly charge with quantity, rate, amount and class, then the minimum month by month", () => {
    const csv = monthlyCsv(complete, meta);
    expect([...MONTHLY_CSV_COLUMNS]).toEqual(["row_type", "name", "period", "status", "quantity", "unit_amount", "amount", "class", "note"]);
    expect(lines(csv)).toEqual([
      "charge,Pallet storage,a month,priced,10,18.00,180.00,based_on_assumptions,10 pallets × $18.00 = $180.00 a month.",
      "charge,Account fee,a month,priced,1,25.00,25.00,from_fee_schedule,$25.00 a month.",
      "total,Monthly charges priced,a month,priced,,,205.00,,",
      "minimum,Monthly minimum,2026-03,exact,,,316.50,,Counted $183.50 toward a $500.00 minimum; amount is what is added",
      "minimum,Monthly minimum,2026-04,exact,,,315.75,,Counted $184.25 toward a $500.00 minimum; amount is what is added",
    ]);
  });

  it("prints the period and volume in the header comments, and never a per-order amount", () => {
    const csv = monthlyCsv(complete, meta);
    expect(csv.comments).toContain("# Basis: 2 orders a month over Mar 1, 2026–Apr 30, 2026 (2 months).");
    expect(csv.comments.join("\n")).toContain("not per-order fees");
    expect(MONTHLY_CSV_COLUMNS.join(",")).not.toMatch(/per_order|all_in/);
  });

  it("a charge with no number given is listed as not modeled with its rate, blank, never zero; the minimum is an upper bound", () => {
    const csv = monthlyCsv(noStorageAnswer, meta);
    expect(lines(csv)).toEqual([
      "charge,Account fee,a month,priced,1,25.00,25.00,from_fee_schedule,$25.00 a month.",
      "charge,Pallet storage,a month,not_modeled,,,,,No number was given. Rate: $18.00 per pallet per month.",
      "total,Monthly charges priced,a month,priced,,,25.00,,Charges that are not modeled are not in this total",
      "minimum,Monthly minimum,,up_to,,,,,Could add up to $496.13 a month; not included in any all-in figure (Pallet storage is not modeled)",
    ]);
  });

  it("says so when fulfillment costs were skipped, and lists nothing", () => {
    const csv = monthlyCsv(skipped, meta);
    expect(csv.rows).toEqual([]);
    expect(csv.comments.join("\n")).toContain("Fulfillment costs were not modeled for this run");
  });

  it("holds no rule key, id or version for any scenario", () => {
    for (const s of [complete, noStorageAnswer, noMinimumRun, undated, lowCoverage, skipped, noSchedule, noContent, notEffective, zeroVolume, noVolume, returnsRun]) {
      const csv = monthlyCsv(s, meta);
      expect([...csv.comments, ...lines(csv)].join("\n")).not.toMatch(FORBIDDEN_TEXT);
    }
  });
});

describe("fee dates no schedule covered", () => {
  it("says nothing when every date was covered, one sentence otherwise", () => {
    expect(uncoveredFeeDatesNote(null)).toBeNull();
    expect(uncoveredFeeDatesNote({ from: "2026-03-03", to: "2026-03-03", dates: 1 })).toBe("No fee schedule was in effect on Mar 3, 2026, so orders dated then have no fees.");
    expect(uncoveredFeeDatesNote({ from: "2026-01-05", to: "2026-02-27", dates: 31 })).toBe("No fee schedule was in effect on 31 of the order dates (between Jan 5, 2026 and Feb 27, 2026), so orders dated then have no fees.");
  });

  it("names the rules an order could not be computed on, never keys, and skips a replaced rule", () => {
    const names = new Map([["a", "Box"]]);
    expect(unresolvedRuleNames([{ ruleKey: "a", reason: "packaging_unknown" }, { ruleKey: "a", reason: "units_unknown" }, { ruleKey: "zz_key", reason: "units_unknown" }, { ruleKey: "b", reason: "replaced" }], names)).toEqual(["Box", "A fee"]);
  });
});


// ---------------------------------------------------------------------------
// Adversarial review of the results screens: figures that must add up, lower bounds that say so
// ---------------------------------------------------------------------------
describe("the all-in split adds up to the all-in figure", () => {
  const partsTotal = (summary: BulkSummary) => {
    const h = headlineFigures(summary, "allin");
    return { h, sum: h.parts.reduce((t, p) => t + Number(p.amount ?? 0), 0).toFixed(2) };
  };

  it("below 80 % coverage the monthly figures count only the orders that were priced, so each part is the monthly figure over the volume", () => {
    // 3 of 5 orders priced, 5 orders a month over one month: shipping 30.00 + fees 5.00 a month, storage and account fee 205.00, spread over 5 orders.
    // The stored per-order averages of the 3 priced orders (10.00 and 1.67) would add up to 52.67, not to the 48.00 headline.
    const { h, sum } = partsTotal(lowCoverage);
    expect(h).toMatchObject({ amount: "48.00", qualifier: "At least" });
    expect(h.parts).toEqual([
      { label: "Shipping", amount: "6.00", note: "counts only the orders that could be priced" },
      { label: "Order fees", amount: "1.00", note: "counts only the orders that could be priced" },
      { label: "Monthly charges, spread over your orders", amount: "41.00", note: "at 5 orders a month" },
    ]);
    expect(sum).toBe("48.00");
  });

  it("when only some priced orders also got fees, the parts say they are averaged over those orders (the Shipping view averages over all of them)", () => {
    const e = modeledOrder("E", 5, "2026-03-28", "8.00", fees("not_effective"));
    const run = finalize([A, B, C, D2, e], { period: { ...period, population: 5, inPeriod: 5 } }, { ...counts, rows: 5, orders: 5, shipments: 5, packages: 5 });
    const { h, sum } = partsTotal(run);
    // 4 of the 5 priced orders have fees: 80 % coverage, so the average of those 4 is scaled to the volume.
    expect(h.parts[0]).toEqual({ label: "Shipping", amount: "12.50", note: "averaged over the 4 of 5 orders priced for both shipping and fees" });
    expect(h.parts[1]).toMatchObject({ label: "Order fees", amount: "1.94", note: "averaged over the 4 of 5 orders priced for both shipping and fees" });
    expect(headlineFigures(run, "shipping").amount).toBe("11.60"); // all 5 priced orders: 58.00 / 5
    expect(Math.abs(Number(sum) - Number(h.amount))).toBeLessThanOrEqual(0.01);
  });

  it("a complete run keeps plain parts with no scope note", () => {
    expect(headlineFigures(complete, "allin").parts.map((p) => p.note)).toEqual([null, null, "at 2 orders a month, with the account minimum"]);
  });

  it("when every monthly charge was left out the monthly part is not computed, never $0.00", () => {
    const storageOnly = { ...schedule, rules: schedule.rules.filter((r) => r.key !== "admin" && r.basis !== "minimum") };
    const run = finalize([A, B, C, D2], { monthlySchedule: storageOnly, answers: { drivers: {}, orderShares: { inserts: { sharePct: "25.00", countPerOrder: 1 } } } });
    const h = headlineFigures(run, "allin");
    expect(run.allocation?.perOrder.allocated).toBe("0.00"); // what the allocation stores: nothing was priced
    expect(h).toMatchObject({ label: "All-in cost per order, without storage", amount: "14.44", qualifier: "At least" });
    expect(h.parts.map((p) => [p.label, p.amount])).toEqual([["Shipping", "12.50"], ["Order fees", "1.94"], ["Monthly charges, spread over your orders", null]]);
    // A schedule that simply has no monthly charges is a known zero.
    const none = finalize([A, B, C, D2], { monthlySchedule: { ...schedule, rules: schedule.rules.filter((r) => r.scope === "order") } });
    expect(headlineFigures(none, "allin").parts[2]).toMatchObject({ amount: "0.00" });
  });
});

describe("compare: what is left out, and rows that are not like for like", () => {
  const run = (summary: BulkSummary): CompareRunInput => ({ summary, datasetId: "d-1", datasetName: "March orders", rateCardName: "Fixture card", pricingBasis: "fixed_date", asOfDate: "2026-03-15", serviceOverrideId: null, serviceOverrideName: null, overrideAllServices: false, assumptions: null });

  it("names the account minimum when it is the only thing left out of an all-in figure", () => {
    expect(compareFacts(lowCoverage).leftOutText).toBe("the account minimum (not worked out exactly)");
    expect(compareFacts(undated).leftOutText).toBe("the account minimum (not worked out exactly)");
    // A category that is left out explains the minimum too (its member is not modeled): the sentence stays as it was.
    expect(compareFacts(noStorageAnswer).leftOutText).toBe("storage");
    const c = buildComparison(run(lowCoverage), run(complete));
    expect(c.allInComparable).toBe(false);
    expect(c.allInNote).toContain("(the account minimum (not worked out exactly) in the first; Nothing left out in the second)");
    expect(c.allInNote).not.toContain("Nothing left out in the first");
  });

  it("explains a shipping figure that averages over fewer orders than the run page's Shipping figure", () => {
    const mixed = finalize([A, B, { ...C, fees: fees("not_effective") }, { ...D2, fees: fees("not_effective") }]);
    expect(headlineFigures(mixed, "shipping").amount).toBe("12.50"); // all 4 priced orders
    const c = buildComparison(run(mixed), run(complete));
    expect(rowOf(c, "Shipping per order")).toMatchObject({ a: "$11.00", b: "$12.50" }); // the 2 orders priced for fees as well
    expect(rowOf(c, "Shipping per order").note).toContain("can differ from the Shipping figure on the model's own page");
    expect(rowOf(buildComparison(run(complete), run(complete)), "Shipping per order").note).toBeNull();
  });

  it("the lower-bound note on shipping + order fees only appears when both runs have a figure", () => {
    const partial = finalize([A, B, C, modeledOrder("D", 4, "2026-04-18", "8.00", fees("partial", { lines: [feeLine(PICK, 15000)], unresolved: [{ ruleKey: "inserts", reason: "assumption_missing" }] }))]);
    const both = buildComparison(run(partial), run(complete));
    expect(rowOf(both, "Shipping + order fees (comparable)")).toMatchObject({ a: "At least $14.38", b: "$14.44" });
    expect(rowOf(both, "Shipping + order fees (comparable)").note).toContain("not like for like");
    // The skipped run has no figure: nothing to be a lower bound of.
    expect(rowOf(buildComparison(run(skipped), run(complete)), "Shipping + order fees (comparable)")).toMatchObject({ a: "Not computed", note: null });
  });

  it("monthly charges that leave a charge out say At least; a schedule with none says None, not Not computed", () => {
    const none = finalize([A, B, C, D2], { monthlySchedule: { ...schedule, rules: schedule.rules.filter((r) => r.scope === "order") } });
    const c = buildComparison(run(noStorageAnswer), run(none));
    expect(rowOf(c, "Monthly charges a month (without the account minimum)")).toMatchObject({ a: "At least $25.00 a month", b: "None on the fee schedule" });
    expect(rowOf(buildComparison(run(skipped), run(complete)), "Monthly charges a month (without the account minimum)").a).toBe("Not computed");
  });

  it("a forecast's monthly 'up to' amounts and a file's totals are labelled when they sit side by side", () => {
    const forecastRun = { ...run(complete), datasetId: null, datasetName: null, summary: forecast(), assumptions: forecastAssumptions() as never };
    const mixed = buildComparison(forecastRun, run(complete));
    expect(rowOf(mixed, "Could not be decided (up to)")).toMatchObject({ b: "$0.00 in the file" });
    expect(rowOf(mixed, "Could not be decided (up to)").a).toMatch(/ a month$/);
    // Two files: the totals need no label.
    expect(rowOf(buildComparison(run(complete), run(complete)), "Could not be decided (up to)")).toMatchObject({ a: "$0.00", b: "$0.00" });
  });
});

describe("CSV comments never end a sentence twice", () => {
  it("a basis sentence that already ends in a full stop is not given another", () => {
    const comments = ordersCsvComments(noVolume, { scenarioName: "S", rateCardName: "R", feeScheduleLine: null });
    expect(comments.join("\n")).not.toContain("..");
    expect(comments.join("\n")).toContain("No monthly volume is known, so monthly charges are not spread over your orders.");
    expect(monthlyCsv(noVolume, { scenarioName: "S", rateCardName: "R", feeScheduleLine: null }).comments.join("\n")).not.toContain("..");
  });
});
