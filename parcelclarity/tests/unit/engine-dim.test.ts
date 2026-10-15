import { describe, expect, it } from "vitest";
import { calculateShipment, dec, lengthPlusGirth, measurePackage, roundDimension, roundWeightLb } from "@/engine";
import type { DimRules, PackageInput, PricingContext, RateRow, ServiceTerms, ShipmentInput } from "@/engine/types";
import { fixtureContext, loadFixtureRateCard } from "../fixtures/pricing/load";

/**
 * Dimensional-weight and billable-weight tests (docs-m2-design.md §1.4, §1.9, §1.11).
 * Every expected value is derived by hand in a comment next to the assertion; nothing here was
 * copied from engine output. Fixture data is FICTIONAL.
 *
 * Result formatting reminder (money.ts `fmt`): fixed-point, trailing zeros trimmed, at least one
 * decimal digit kept, so 4 → "4.0", 10.40 → "10.4". Weights that do not terminate within 12 decimals
 * are rounded UP at the 12th decimal (never below the exact value), e.g. 480/139 → "3.453237410072".
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UPS-style parcel defaults with a 139 divisor; override per test. */
function rules(overrides: Partial<DimRules> = {}): DimRules {
  return {
    divisor: "139",
    thresholdCubicIn: null,
    dimensionRounding: "nearest_whole",
    weightRounding: "up_whole_lb",
    minBillableLb: null,
    exempt: false,
    ...overrides,
  };
}

function pkg(weight: string, weightUnit: "lb" | "oz", dims?: [string, string, string]): PackageInput {
  return dims ? { weight, weightUnit, length: dims[0], width: dims[1], height: dims[2] } : { weight, weightUnit };
}

function terms(serviceCode: string, dim: DimRules): ServiceTerms {
  return {
    serviceId: `svc-${serviceCode}`,
    carrierCode: "ups",
    serviceCode,
    serviceName: `Test ${serviceCode}`,
    dim,
    minCharge: null,
    includedSurchargeKeys: [],
    excludedSurchargeKeys: [],
    zoneChartKey: "default",
    zoneIndependent: false,
    surchargeMarkupPercent: null,
    sourceReference: "test terms",
    termsVersion: "test-terms-v1",
  };
}

/**
 * Minimal rate table for zone 2, any origin: bracket (n−1, n] lb costs (4 + n).00, i.e.
 * 0–1 lb 5.00, 1–2 lb 6.00, 2–3 lb 7.00, 3–4 lb 8.00, 4–5 lb 9.00, 5–6 lb 10.00.
 */
function rows(serviceId: string): RateRow[] {
  return [
    { serviceId, originPrefix: null, zone: "2", weightMin: "0", weightMax: "1", weightUnit: "lb", price: "5.00", minCharge: null },
    { serviceId, originPrefix: null, zone: "2", weightMin: "1", weightMax: "2", weightUnit: "lb", price: "6.00", minCharge: null },
    { serviceId, originPrefix: null, zone: "2", weightMin: "2", weightMax: "3", weightUnit: "lb", price: "7.00", minCharge: null },
    { serviceId, originPrefix: null, zone: "2", weightMin: "3", weightMax: "4", weightUnit: "lb", price: "8.00", minCharge: null },
    { serviceId, originPrefix: null, zone: "2", weightMin: "4", weightMax: "5", weightUnit: "lb", price: "9.00", minCharge: null },
    { serviceId, originPrefix: null, zone: "2", weightMin: "5", weightMax: "6", weightUnit: "lb", price: "10.00", minCharge: null },
  ];
}

/** A context with no surcharge rules at all, so the itemization is base lines only. */
function customContext(dim: DimRules): PricingContext {
  const service = terms("test", dim);
  return {
    rateCard: {
      rateCardId: "dim-card",
      rateCardName: "DIM test card (fictional)",
      versionId: "dim-card-v1",
      versionNumber: 1,
      currency: "USD",
      effectiveDate: "2026-01-01",
      expirationDate: null,
      services: [service],
      rows: rows(service.serviceId),
      zones: [],
    },
    rules: [],
    zipLists: [],
    overrides: [],
  };
}

function shipment(packages: PackageInput[]): ShipmentInput {
  return { shipDate: "2026-10-15", originZip: "90001", destinationZone: "2", residential: false, carrierCode: "ups", serviceCode: "test", packages };
}

const BOX_10_8_6: [string, string, string] = ["10", "8", "6"]; // 10 × 8 × 6 = 480 cu in

// ---------------------------------------------------------------------------
// roundDimension
// ---------------------------------------------------------------------------

describe("roundDimension", () => {
  it("nearest_whole rounds HALF_UP to an integer, including the .5 cases", () => {
    expect(roundDimension(dec("10.4"), "nearest_whole").toString()).toBe("10"); // 10.4 → 10
    expect(roundDimension(dec("10.49"), "nearest_whole").toString()).toBe("10"); // 10.49 → 10 (below the half)
    expect(roundDimension(dec("10.5"), "nearest_whole").toString()).toBe("11"); // exactly .5 → up
    expect(roundDimension(dec("11.5"), "nearest_whole").toString()).toBe("12"); // .5 on an odd base → up (HALF_UP, not half-even)
    expect(roundDimension(dec("2.5"), "nearest_whole").toString()).toBe("3"); // .5 on an even base → up too (not banker's 2)
    expect(roundDimension(dec("0.5"), "nearest_whole").toString()).toBe("1"); // 0.5 → 1
    expect(roundDimension(dec("7.4999"), "nearest_whole").toString()).toBe("7"); // just under the half → down
    expect(roundDimension(dec("10"), "nearest_whole").toString()).toBe("10"); // integer unchanged
  });

  it("up_whole always rounds up to the next integer unless already whole", () => {
    expect(roundDimension(dec("10.01"), "up_whole").toString()).toBe("11"); // any fraction → next integer
    expect(roundDimension(dec("10.5"), "up_whole").toString()).toBe("11"); // .5 → 11 (same as nearest here)
    expect(roundDimension(dec("0.1"), "up_whole").toString()).toBe("1"); // 0.1 → 1
    expect(roundDimension(dec("10"), "up_whole").toString()).toBe("10"); // whole stays whole
    expect(roundDimension(dec("10.0"), "up_whole").toString()).toBe("10"); // "10.0" is whole too
  });

  it("none leaves the value untouched", () => {
    expect(roundDimension(dec("10.25"), "none").toString()).toBe("10.25");
    expect(roundDimension(dec("10.5"), "none").toString()).toBe("10.5");
    expect(roundDimension(dec("0.001"), "none").toString()).toBe("0.001");
  });
});

// ---------------------------------------------------------------------------
// roundWeightLb
// ---------------------------------------------------------------------------

describe("roundWeightLb", () => {
  it("up_whole_lb ceils to the next whole pound", () => {
    expect(roundWeightLb(dec("3.0001"), "up_whole_lb").toString()).toBe("4"); // 3.0001 → 4
    expect(roundWeightLb(dec("3"), "up_whole_lb").toString()).toBe("3"); // whole stays
    expect(roundWeightLb(dec("0.375"), "up_whole_lb").toString()).toBe("1"); // 6 oz → 1 lb
    expect(roundWeightLb(dec("25.8993"), "up_whole_lb").toString()).toBe("26"); // 25.8993 → 26
  });

  it("up_whole_oz keeps an exact whole number of ounces unchanged", () => {
    // 0.375 lb × 16 = 6 oz exactly → ceil(6) = 6 → 6 / 16 = 0.375
    expect(roundWeightLb(dec("0.375"), "up_whole_oz").toString()).toBe("0.375");
    // 1.25 lb × 16 = 20 oz exactly → 20 / 16 = 1.25
    expect(roundWeightLb(dec("1.25"), "up_whole_oz").toString()).toBe("1.25");
    // 3 lb = 48 oz → 3
    expect(roundWeightLb(dec("3"), "up_whole_oz").toString()).toBe("3");
  });

  it("up_whole_oz ceils a fractional ounce to the next ounce, expressed in pounds", () => {
    // 1.2 lb × 16 = 19.2 oz → ceil → 20 oz → 20 / 16 = 1.25 lb
    expect(roundWeightLb(dec("1.2"), "up_whole_oz").toString()).toBe("1.25");
    // 0.40625 lb × 16 = 6.5 oz → 7 oz → 7 / 16 = 0.4375 lb
    expect(roundWeightLb(dec("0.40625"), "up_whole_oz").toString()).toBe("0.4375");
    // 0.0001 lb × 16 = 0.0016 oz → 1 oz → 1 / 16 = 0.0625 lb
    expect(roundWeightLb(dec("0.0001"), "up_whole_oz").toString()).toBe("0.0625");
    // 14.17 lb × 16 = 226.72 oz → 227 oz → 227 / 16 = 14.1875 lb
    expect(roundWeightLb(dec("14.17"), "up_whole_oz").toString()).toBe("14.1875");
  });

  it("none returns the exact value", () => {
    expect(roundWeightLb(dec("3.4532"), "none").toString()).toBe("3.4532");
    expect(roundWeightLb(dec("1.2"), "none").toString()).toBe("1.2");
  });
});

// ---------------------------------------------------------------------------
// Ounce input conversion
// ---------------------------------------------------------------------------

describe("measurePackage: weight unit conversion", () => {
  it("converts oz input to pounds exactly (÷ 16)", () => {
    const none = rules({ weightRounding: "none" });
    // 6 oz / 16 = 0.375 lb
    expect(measurePackage(pkg("6", "oz"), 0, none).result.actualLb).toBe("0.375");
    // 19.2 oz / 16 = 1.2 lb
    expect(measurePackage(pkg("19.2", "oz"), 0, none).result.actualLb).toBe("1.2");
    // 1 oz / 16 = 0.0625 lb
    expect(measurePackage(pkg("1", "oz"), 0, none).result.actualLb).toBe("0.0625");
    // lb input is taken as is
    expect(measurePackage(pkg("3.25", "lb"), 0, none).result.actualLb).toBe("3.25");
    // with no weight rounding the billable weight is the exact converted value
    expect(measurePackage(pkg("19.2", "oz"), 0, none).result.billableLb).toBe("1.2");
  });

  it("an ounce weight under a pound bills as 1 lb under up_whole_lb", () => {
    // 6 oz = 0.375 lb → ceil → 1 lb
    const m = measurePackage(pkg("6", "oz"), 0, rules({ weightRounding: "up_whole_lb" }));
    expect(m.result.actualLb).toBe("0.375");
    expect(m.result.billableLb).toBe("1.0");
    expect(m.result.basis).toBe("no_dimensions");
    expect(m.result.explanation).toContain("Rounded up to the next pound: 1.0 lb billable");
  });

  it("a fractional ounce bills at the next whole ounce under up_whole_oz", () => {
    // 6.5 oz = 0.40625 lb → 6.5 oz → ceil → 7 oz = 0.4375 lb.
    // actualLb is reported exactly when it terminates: 6.5 / 16 = 0.40625.
    const m = measurePackage(pkg("6.5", "oz"), 0, rules({ weightRounding: "up_whole_oz" }));
    expect(m.actualLb.toString()).toBe("0.40625");
    expect(m.result.actualLb).toBe("0.40625");
    expect(m.result.billableLb).toBe("0.4375");
    expect(m.result.explanation).toContain("Rounded up to the next ounce: 0.4375 lb billable");
  });
});

// ---------------------------------------------------------------------------
// DIM vs actual weight
// ---------------------------------------------------------------------------

describe("measurePackage: DIM versus actual weight", () => {
  it("DIM wins when the unrounded DIM weight exceeds the actual weight; the winner is then rounded", () => {
    // 10 × 8 × 6 = 480 cu in; 480 / 139 = 3.4532374… lb > 3 lb actual → DIM; ceil(3.4532…) = 4 lb
    const m = measurePackage(pkg("3", "lb", BOX_10_8_6), 0, rules());
    expect(m.result.basis).toBe("dim");
    expect(m.result.actualLb).toBe("3.0");
    expect(m.result.roundedDimensionsIn).toEqual(["10.0", "8.0", "6.0"]);
    expect(m.result.cubicIn).toBe("480.0");
    expect(m.result.dimLb).toBe("3.453237410072"); // 3.4532374100719… rounded up at 12 dp
    expect(m.result.billableLb).toBe("4.0");
    expect(m.result.explanation).toContain("Dimensional weight 3.453 lb");
    expect(m.result.explanation).toContain("exceeds actual weight 3.0 lb");
    expect(m.result.explanation).toContain("Rounded up to the next pound: 4.0 lb billable");
  });

  it("actual wins when it is at least the unrounded DIM weight, even though both round to the same pound", () => {
    // Same box: DIM 3.4532… lb; actual 3.5 lb > 3.4532 → actual is the basis.
    // Both candidates would round to 4 lb, so the comparison must be made before rounding to
    // attribute the basis correctly.
    const m = measurePackage(pkg("3.5", "lb", BOX_10_8_6), 0, rules());
    expect(m.result.basis).toBe("actual");
    expect(m.result.dimLb).toBe("3.453237410072"); // still reported for transparency
    expect(m.result.billableLb).toBe("4.0"); // ceil(3.5) = 4
    expect(m.result.explanation).toContain("Actual weight 3.5 lb is at least the dimensional weight 3.453 lb");
  });

  it("an exact tie goes to actual weight (DIM must strictly exceed)", () => {
    // 10 × 10 × 10 = 1000 cu in; divisor 100 → DIM = 10 lb exactly; actual 10 lb → not exceeded.
    const m = measurePackage(pkg("10", "lb", ["10", "10", "10"]), 0, rules({ divisor: "100" }));
    expect(m.result.basis).toBe("actual");
    expect(m.result.dimLb).toBe("10.0");
    expect(m.result.billableLb).toBe("10.0");
  });

  it("dimensions are rounded before the cube: nearest_whole shrinks 10.4³ so actual wins", () => {
    // 10.4 → 10 each; 10 × 10 × 10 = 1000; 1000 / 139 = 7.1942446… < 7.5 actual → actual; ceil(7.5) = 8
    const m = measurePackage(pkg("7.5", "lb", ["10.4", "10.4", "10.4"]), 0, rules({ dimensionRounding: "nearest_whole" }));
    expect(m.result.roundedDimensionsIn).toEqual(["10.0", "10.0", "10.0"]);
    expect(m.result.cubicIn).toBe("1000.0");
    expect(m.result.dimLb).toBe("7.194244604317");
    expect(m.result.basis).toBe("actual");
    expect(m.result.billableLb).toBe("8.0");
  });

  it("dimensions are rounded before the cube: with no rounding the same 10.4³ box makes DIM win", () => {
    // 10.4 × 10.4 × 10.4 = 1124.864; 1124.864 / 139 = 8.0925468… > 7.5 → DIM; ceil → 9
    const m = measurePackage(pkg("7.5", "lb", ["10.4", "10.4", "10.4"]), 0, rules({ dimensionRounding: "none" }));
    expect(m.result.roundedDimensionsIn).toEqual(["10.4", "10.4", "10.4"]);
    expect(m.result.cubicIn).toBe("1124.86"); // 1124.864 → 2 dp
    expect(m.result.dimLb).toBe("8.09254676259");
    expect(m.result.basis).toBe("dim");
    expect(m.result.billableLb).toBe("9.0");
  });

  it("dimensions are rounded before the cube: up_whole grows 10.4³ to 11³", () => {
    // 10.4 → 11 each; 11 × 11 × 11 = 1331; 1331 / 139 = 9.5755396… > 7.5 → DIM; ceil → 10
    const m = measurePackage(pkg("7.5", "lb", ["10.4", "10.4", "10.4"]), 0, rules({ dimensionRounding: "up_whole" }));
    expect(m.result.roundedDimensionsIn).toEqual(["11.0", "11.0", "11.0"]);
    expect(m.result.cubicIn).toBe("1331.0");
    expect(m.result.dimLb).toBe("9.575539568346");
    expect(m.result.basis).toBe("dim");
    expect(m.result.billableLb).toBe("10.0");
  });

  it("weightRounding none bills the exact DIM weight and adds no rounding note", () => {
    // 480 / 139 = 3.4532374100719… → billable reported rounded up at 12 dp "3.453237410072"
    const m = measurePackage(pkg("3", "lb", BOX_10_8_6), 0, rules({ weightRounding: "none" }));
    expect(m.result.basis).toBe("dim");
    expect(m.result.billableLb).toBe("3.453237410072");
    expect(m.billableLb.equals(m.dimLb!)).toBe(true);
    expect(m.result.explanation).not.toContain("Rounded");
  });

  it("DIM weight is rounded up to the next ounce under up_whole_oz", () => {
    // 14 × 14 × 12 = 2352 cu in; 2352 / 166 = 14.1686747… lb > 2 lb → DIM.
    // × 16 = 226.698… oz → 227 oz → 227 / 16 = 14.1875 lb.
    const m = measurePackage(pkg("2", "lb", ["14", "14", "12"]), 0, rules({ divisor: "166", weightRounding: "up_whole_oz" }));
    expect(m.result.cubicIn).toBe("2352.0");
    expect(m.result.dimLb).toBe("14.168674698796"); // 14.1686746987951… rounded up at 12 dp
    expect(m.result.basis).toBe("dim");
    expect(m.result.billableLb).toBe("14.1875");
    expect(m.result.explanation).toContain("Rounded up to the next ounce: 14.1875 lb billable");
  });

  it("sorts the rounded dimensions longest first regardless of input order", () => {
    // length 6, width 10, height 8 → sorted [10, 8, 6]
    const m = measurePackage(pkg("3", "lb", ["6", "10", "8"]), 0, rules());
    expect(m.result.roundedDimensionsIn).toEqual(["10.0", "8.0", "6.0"]);
    expect(m.result.cubicIn).toBe("480.0");
  });
});

// ---------------------------------------------------------------------------
// thresholdCubicIn
// ---------------------------------------------------------------------------

describe("measurePackage: thresholdCubicIn", () => {
  const usps = rules({ divisor: "166", thresholdCubicIn: "1728", weightRounding: "up_whole_oz" });

  it("volume exactly at the threshold does not trigger DIM (strictly greater)", () => {
    // 12 × 12 × 12 = 1728 = threshold → not above → actual 1 lb; dimLb not computed
    const m = measurePackage(pkg("1", "lb", ["12", "12", "12"]), 0, usps);
    expect(m.result.cubicIn).toBe("1728.0");
    expect(m.result.dimLb).toBeNull();
    expect(m.result.basis).toBe("actual");
    expect(m.result.billableLb).toBe("1.0");
    expect(m.result.explanation).toContain("does not exceed the 1728");
  });

  it("volume below the threshold bills on actual weight", () => {
    // 12 × 12 × 11 = 1584 < 1728 → actual
    const m = measurePackage(pkg("1", "lb", ["12", "12", "11"]), 0, usps);
    expect(m.result.cubicIn).toBe("1584.0");
    expect(m.result.dimLb).toBeNull();
    expect(m.result.basis).toBe("actual");
    expect(m.result.billableLb).toBe("1.0");
  });

  it("volume just above the threshold computes DIM", () => {
    // 12 × 12 × 13 = 1872 > 1728; 1872 / 166 = 11.2771084… lb > 1 lb → DIM.
    // × 16 = 180.43… oz → 181 oz → 181 / 16 = 11.3125 lb.
    const m = measurePackage(pkg("1", "lb", ["12", "12", "13"]), 0, usps);
    expect(m.result.cubicIn).toBe("1872.0");
    expect(m.result.dimLb).toBe("11.277108433735");
    expect(m.result.basis).toBe("dim");
    expect(m.result.billableLb).toBe("11.3125");
  });

  it("the threshold test uses the rounded dimensions", () => {
    // 12.4 × 12 × 12: nearest_whole → 12 × 12 × 12 = 1728 → NOT above the threshold → actual.
    const rounded = measurePackage(pkg("1", "lb", ["12.4", "12", "12"]), 0, usps);
    expect(rounded.result.cubicIn).toBe("1728.0");
    expect(rounded.result.basis).toBe("actual");
    expect(rounded.result.billableLb).toBe("1.0");

    // Same box with dimensionRounding none: 12.4 × 12 × 12 = 1785.6 > 1728 → DIM.
    // 1785.6 / 166 = 10.7566265… lb; × 16 = 172.1… → 173 oz → 173 / 16 = 10.8125 lb.
    const exact = measurePackage(pkg("1", "lb", ["12.4", "12", "12"]), 0, { ...usps, dimensionRounding: "none" });
    expect(exact.result.cubicIn).toBe("1785.6");
    expect(exact.result.dimLb).toBe("10.756626506025");
    expect(exact.result.basis).toBe("dim");
    expect(exact.result.billableLb).toBe("10.8125");
  });

  it("a null threshold means DIM always applies", () => {
    // 480 cu in would be far below 1728, but with no threshold: 480 / 166 = 2.8915663… > 1 lb → DIM.
    // × 16 = 46.26… → 47 oz → 47 / 16 = 2.9375 lb.
    const m = measurePackage(pkg("1", "lb", BOX_10_8_6), 0, { ...usps, thresholdCubicIn: null });
    expect(m.result.dimLb).toBe("2.891566265061");
    expect(m.result.basis).toBe("dim");
    expect(m.result.billableLb).toBe("2.9375");
  });
});

// ---------------------------------------------------------------------------
// Exempt services
// ---------------------------------------------------------------------------

describe("measurePackage: exempt services", () => {
  it("an exempt service bills actual weight even when DIM would be heavier", () => {
    // Box 480 cu in / 139 = 3.45 lb would exceed 3 lb, but exempt → no DIM; billable 3 lb.
    const m = measurePackage(pkg("3", "lb", BOX_10_8_6), 0, rules({ exempt: true }));
    expect(m.result.basis).toBe("exempt");
    expect(m.result.dimLb).toBeNull();
    expect(m.result.billableLb).toBe("3.0");
    // Dimensions are still measured (surcharge conditions such as longest side need them).
    expect(m.result.roundedDimensionsIn).toEqual(["10.0", "8.0", "6.0"]);
    expect(m.result.cubicIn).toBe("480.0");
    expect(m.result.explanation).toContain("exempt from dimensional weight");
  });

  it("an exempt service without dimensions reports exempt, not no_dimensions", () => {
    // 8 oz = 0.5 lb → ceil → 1 lb
    const m = measurePackage(pkg("8", "oz"), 0, rules({ exempt: true }));
    expect(m.result.basis).toBe("exempt");
    expect(m.result.roundedDimensionsIn).toBeNull();
    expect(m.result.cubicIn).toBeNull();
    expect(m.result.billableLb).toBe("1.0");
  });

  it("calculateShipment: exempt service with no dimensions prices as definite with no warning (§1.4 step 4)", () => {
    // 3 lb → bracket 2–3 lb → 7.00
    const result = calculateShipment(shipment([pkg("3", "lb")]), customContext(rules({ exempt: true })));
    expect(result.status).toBe("ok");
    expect(result.packages[0]?.basis).toBe("exempt");
    const base = result.lines.find((l) => l.kind === "base")!;
    expect(base.amount.amount).toBe("7.00");
    expect(base.chargeClass).toBe("definite");
    expect(result.warnings).toEqual([]);
    expect(result.totals.definite.amount).toBe("7.00");
    expect(result.totals.estimated.amount).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// Missing dimensions / missing divisor
// ---------------------------------------------------------------------------

describe("missing dimensions and missing divisor", () => {
  it("measurePackage: no dimensions → basis no_dimensions, nothing dimensional reported", () => {
    // 3.2 lb → ceil → 4 lb
    const m = measurePackage(pkg("3.2", "lb"), 0, rules());
    expect(m.result.basis).toBe("no_dimensions");
    expect(m.result.roundedDimensionsIn).toBeNull();
    expect(m.result.cubicIn).toBeNull();
    expect(m.result.dimLb).toBeNull();
    expect(m.result.billableLb).toBe("4.0");
    expect(m.result.explanation).toContain("No dimensions were given");
  });

  it("measurePackage: dimensions but no divisor → basis no_divisor, volume reported, no DIM weight", () => {
    // 480 cu in is measured; without a divisor DIM cannot be computed; actual 3 lb → 3 lb
    const m = measurePackage(pkg("3", "lb", BOX_10_8_6), 0, rules({ divisor: null }));
    expect(m.result.basis).toBe("no_divisor");
    expect(m.result.roundedDimensionsIn).toEqual(["10.0", "8.0", "6.0"]);
    expect(m.result.cubicIn).toBe("480.0");
    expect(m.result.dimLb).toBeNull();
    expect(m.result.billableLb).toBe("3.0");
    expect(m.result.explanation).toContain("does not state a DIM divisor");
  });

  it("calculateShipment: no dimensions → base line estimated and warning dimensions_missing", () => {
    // 3 lb → bracket 2–3 lb → 7.00; classed estimated, so definite 0.00, estimated 7.00, expected 7.00
    const result = calculateShipment(shipment([pkg("3", "lb")]), customContext(rules()));
    expect(result.status).toBe("ok");
    expect(result.packages[0]?.basis).toBe("no_dimensions");
    const base = result.lines.find((l) => l.kind === "base")!;
    expect(base.amount.amount).toBe("7.00");
    expect(base.chargeClass).toBe("estimated");
    expect(base.counted).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(["dimensions_missing"]);
    expect(result.totals).toEqual({
      definite: { amount: "0.00", currency: "USD" },
      estimated: { amount: "7.00", currency: "USD" },
      expected: { amount: "7.00", currency: "USD" },
      conditionalExposure: { amount: "0.00", currency: "USD" },
      unresolved: { amount: "0.00", currency: "USD" },
    });
  });

  it("calculateShipment: divisor missing → base line estimated and warning dim_divisor_missing", () => {
    // Dims given, divisor null → actual 3 lb → bracket 2–3 lb → 7.00, estimated
    const result = calculateShipment(shipment([pkg("3", "lb", BOX_10_8_6)]), customContext(rules({ divisor: null })));
    expect(result.status).toBe("ok");
    expect(result.packages[0]?.basis).toBe("no_divisor");
    expect(result.packages[0]?.cubicIn).toBe("480.0");
    const base = result.lines.find((l) => l.kind === "base")!;
    expect(base.amount.amount).toBe("7.00");
    expect(base.chargeClass).toBe("estimated");
    expect(result.warnings.map((w) => w.code)).toEqual(["dim_divisor_missing"]);
    expect(result.totals.definite.amount).toBe("0.00");
    expect(result.totals.estimated.amount).toBe("7.00");
  });

  it("calculateShipment: the dimensions_missing warning is emitted once for several packages", () => {
    // Package 1: 3 lb → 7.00; package 2: 1 lb → bracket 0–1 → 5.00; both estimated → estimated 12.00
    const result = calculateShipment(shipment([pkg("3", "lb"), pkg("1", "lb")]), customContext(rules()));
    expect(result.status).toBe("ok");
    expect(result.warnings.map((w) => w.code)).toEqual(["dimensions_missing"]);
    const bases = result.lines.filter((l) => l.kind === "base");
    expect(bases.map((l) => [l.packageIndex, l.amount.amount, l.chargeClass])).toEqual([
      [0, "7.00", "estimated"],
      [1, "5.00", "estimated"],
    ]);
    expect(result.totals.estimated.amount).toBe("12.00");
  });

  // ENGINE DEFECT: calculateShipment keeps one `baseClass` for the whole shipment, so a package whose
  // DIM was fully evaluated is still classed "estimated" when any other package lacks dimensions.
  // Design §1.6 prices each package independently and §1.9 ties the estimated class to the package
  // whose DIM could not be evaluated. Conservative (money total unchanged) but mis-splits
  // definite/estimated.
  it("calculateShipment: only the package without dimensions gets an estimated base line (each package priced independently)", () => {
    // Package 1: 10 × 8 × 6, 3 lb → DIM 3.45 → 4 lb → bracket 3–4 → 8.00, DIM evaluated → definite.
    // Package 2: 3 lb, no dims → bracket 2–3 → 7.00 → estimated.
    const result = calculateShipment(shipment([pkg("3", "lb", BOX_10_8_6), pkg("3", "lb")]), customContext(rules()));
    expect(result.status).toBe("ok");
    expect(result.packages.map((p) => [p.basis, p.billableLb])).toEqual([
      ["dim", "4.0"],
      ["no_dimensions", "3.0"],
    ]);
    expect(result.warnings.map((w) => w.code)).toEqual(["dimensions_missing"]);
    const bases = result.lines.filter((l) => l.kind === "base");
    expect(bases.map((l) => [l.packageIndex, l.amount.amount, l.chargeClass])).toEqual([
      [0, "8.00", "definite"],
      [1, "7.00", "estimated"],
    ]);
    expect(result.totals.definite.amount).toBe("8.00");
    expect(result.totals.estimated.amount).toBe("7.00");
    expect(result.totals.expected.amount).toBe("15.00");
  });

  // ENGINE DEFECT: the dimensions_missing warning and the estimated class are derived from the final
  // package basis, which `minBillableLb` overwrites with "minimum". Design §1.4 lists the warning at
  // step 4 and the minimum floor at step 5, so raising the weight to the minimum must not hide that
  // DIM could not be checked (a DIM weight could exceed the minimum too). Same hole for no_divisor.
  it("calculateShipment: a minimum-weight floor does not hide that dimensions were missing", () => {
    // 8 oz = 0.5 lb, no dims, minBillableLb 1 → raised to 1 lb (basis minimum) → bracket 0–1 → 5.00.
    // DIM could not be checked, so the base line is still an estimate with warning dimensions_missing.
    const result = calculateShipment(shipment([pkg("8", "oz")]), customContext(rules({ minBillableLb: "1" })));
    expect(result.status).toBe("ok");
    expect(result.packages[0]?.basis).toBe("minimum");
    expect(result.packages[0]?.billableLb).toBe("1.0");
    const base = result.lines.find((l) => l.kind === "base")!;
    expect(base.amount.amount).toBe("5.00");
    expect(result.warnings.map((w) => w.code)).toEqual(["dimensions_missing"]);
    expect(base.chargeClass).toBe("estimated");
  });
});

// ---------------------------------------------------------------------------
// minBillableLb
// ---------------------------------------------------------------------------

describe("measurePackage: minBillableLb", () => {
  it("raises a light package to the minimum and reports basis minimum", () => {
    // 8 oz = 0.5 lb < 1 → raw 1 lb → ceil(1) = 1 → "1.0"
    const m = measurePackage(pkg("8", "oz"), 0, rules({ minBillableLb: "1" }));
    expect(m.result.actualLb).toBe("0.5");
    expect(m.result.basis).toBe("minimum");
    expect(m.result.billableLb).toBe("1.0");
    expect(m.result.explanation).toContain("Raised to the service minimum billable weight of 1.0 lb");
  });

  it("a package exactly at the minimum is not raised (strictly less than)", () => {
    // 16 oz = 1 lb, minimum 1 → not below → basis stays no_dimensions
    const m = measurePackage(pkg("16", "oz"), 0, rules({ minBillableLb: "1" }));
    expect(m.result.basis).toBe("no_dimensions");
    expect(m.result.billableLb).toBe("1.0");
    expect(m.result.explanation).not.toContain("Raised");
  });

  it("DIM above the minimum is unaffected by the floor", () => {
    // 480 / 139 = 3.4532… > 0.5 actual and > 1 minimum → basis dim; ceil → 4
    const m = measurePackage(pkg("8", "oz", BOX_10_8_6), 0, rules({ minBillableLb: "1" }));
    expect(m.result.basis).toBe("dim");
    expect(m.result.billableLb).toBe("4.0");
  });

  it("the floor applies after the DIM/actual comparison: a DIM winner below the minimum is raised", () => {
    // 10 × 8 × 1 = 80 cu in; divisor 100 → DIM 0.8 lb > 0.5 lb actual → DIM wins; 0.8 < 1 → raised to 1
    const m = measurePackage(pkg("8", "oz", ["10", "8", "1"]), 0, rules({ divisor: "100", minBillableLb: "1" }));
    expect(m.result.dimLb).toBe("0.8");
    expect(m.result.basis).toBe("minimum");
    expect(m.result.billableLb).toBe("1.0");
    expect(m.result.explanation).toContain("Dimensional weight 0.8 lb");
    expect(m.result.explanation).toContain("Raised to the service minimum billable weight of 1.0 lb");
  });

  it("the minimum is applied before weight rounding", () => {
    // minimum 1.5 lb, 8 oz actual → raw 1.5 → up_whole_lb → ceil(1.5) = 2
    const lb = measurePackage(pkg("8", "oz"), 0, rules({ minBillableLb: "1.5", weightRounding: "up_whole_lb" }));
    expect(lb.result.basis).toBe("minimum");
    expect(lb.result.billableLb).toBe("2.0");
    // up_whole_oz: 1.5 lb = 24 oz exactly → stays 1.5
    const oz = measurePackage(pkg("8", "oz"), 0, rules({ minBillableLb: "1.5", weightRounding: "up_whole_oz" }));
    expect(oz.result.billableLb).toBe("1.5");
  });
});

// ---------------------------------------------------------------------------
// Service-specific divisors on one rate card (fixture)
// ---------------------------------------------------------------------------

describe("service-specific DIM rules on one rate card (fixture)", () => {
  // Fixture terms: ups/ground divisor 139, no threshold, up_whole_lb;
  //                usps/ground_advantage divisor 166, threshold 1728, up_whole_oz.
  // Package 20 × 15 × 12 = 3600 cu in, 5 lb actual.
  const BIG: [string, string, string] = ["20", "15", "12"];

  it("measurePackage gives different billable weights for the two services' divisors", () => {
    const card = loadFixtureRateCard();
    const ups = card.services.find((s) => s.carrierCode === "ups" && s.serviceCode === "ground")!.dim;
    const usps = card.services.find((s) => s.carrierCode === "usps" && s.serviceCode === "ground_advantage")!.dim;
    expect(ups.divisor).toBe("139");
    expect(usps.divisor).toBe("166");

    // UPS: 3600 / 139 = 25.8992806… > 5 → DIM; ceil → 26 lb
    const mUps = measurePackage(pkg("5", "lb", BIG), 0, ups);
    expect(mUps.result.dimLb).toBe("25.89928057554");
    expect(mUps.result.basis).toBe("dim");
    expect(mUps.result.billableLb).toBe("26.0");

    // USPS: 3600 > 1728 threshold; 3600 / 166 = 21.6867470… > 5 → DIM;
    // × 16 = 346.98… → 347 oz → 347 / 16 = 21.6875 lb
    const mUsps = measurePackage(pkg("5", "lb", BIG), 0, usps);
    expect(mUsps.result.dimLb).toBe("21.686746987952");
    expect(mUsps.result.basis).toBe("dim");
    expect(mUsps.result.billableLb).toBe("21.6875");
  });

  it("calculateShipment prices UPS Ground on the 26 lb bracket", () => {
    // 90001 → 85001: UPS chart origin 900, dest 850 in 800–899 → zone 5.
    // UPS Ground zone 5 bracket 25 < 26 ≤ 26 lb → 21.85 (fixture-rate-card.csv).
    const result = calculateShipment(
      { shipDate: "2026-10-15", originZip: "90001", destinationZip: "85001", residential: false, carrierCode: "ups", serviceCode: "ground", packages: [pkg("5", "lb", BIG)] },
      fixtureContext(),
    );
    expect(result.status).toBe("ok");
    expect(result.zone?.zone).toBe("5");
    expect(result.packages[0]?.billableLb).toBe("26.0");
    expect(result.packages[0]?.basis).toBe("dim");
    const base = result.lines.find((l) => l.kind === "base")!;
    expect(base.amount.amount).toBe("21.85");
    expect(base.chargeClass).toBe("definite");
  });

  it("calculateShipment prices USPS Ground Advantage on the 21–22 lb bracket for the same box", () => {
    // USPS chart origin 900, dest 850 → zone 5; USPS GA rows are origin-specific (900).
    // Bracket 21 < 21.6875 ≤ 22 lb → 23.43 (fixture-rate-card.csv).
    const result = calculateShipment(
      { shipDate: "2026-10-15", originZip: "90001", destinationZip: "85001", residential: false, carrierCode: "usps", serviceCode: "ground_advantage", packages: [pkg("5", "lb", BIG)] },
      fixtureContext(),
    );
    expect(result.status).toBe("ok");
    expect(result.zone?.zone).toBe("5");
    expect(result.packages[0]?.billableLb).toBe("21.6875");
    expect(result.packages[0]?.basis).toBe("dim");
    const base = result.lines.find((l) => l.kind === "base")!;
    expect(base.amount.amount).toBe("23.43");
    expect(base.chargeClass).toBe("definite");
  });
});

// ---------------------------------------------------------------------------
// lengthPlusGirth
// ---------------------------------------------------------------------------

describe("lengthPlusGirth", () => {
  it("is longest + 2 × (second + third)", () => {
    // 20 + 2 × 15 + 2 × 12 = 20 + 30 + 24 = 74
    expect(lengthPlusGirth([dec("20"), dec("15"), dec("12")]).toString()).toBe("74");
    // 61 + 2 × 20 + 2 × 15 = 61 + 40 + 30 = 131 (the fixture large-package box)
    expect(lengthPlusGirth([dec("61"), dec("20"), dec("15")]).toString()).toBe("131");
  });

  it("uses the longest side as length whatever order the caller entered the dimensions", () => {
    // length 12, width 20, height 15 → sorted [20, 15, 12] → 20 + 30 + 24 = 74 (not 12 + 40 + 30 = 82)
    const m = measurePackage(pkg("5", "lb", ["12", "20", "15"]), 0, rules());
    expect(lengthPlusGirth(m.dimsIn!).toString()).toBe("74");
  });

  it("works on the rounded dimensions", () => {
    // 20.4 → 20, 15.5 → 16, 12.49 → 12 → 20 + 32 + 24 = 76
    const m = measurePackage(pkg("5", "lb", ["20.4", "15.5", "12.49"]), 0, rules({ dimensionRounding: "nearest_whole" }));
    expect(m.result.roundedDimensionsIn).toEqual(["20.0", "16.0", "12.0"]);
    expect(lengthPlusGirth(m.dimsIn!).toString()).toBe("76");
  });
});
