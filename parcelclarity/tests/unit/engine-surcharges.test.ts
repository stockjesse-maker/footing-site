import { describe, expect, it } from "vitest";
import { calculateShipment, D } from "@/engine";
import type {
  ChargeLine,
  PackageInput,
  PricingContext,
  RateRow,
  ServiceTerms,
  ShipmentCalculation,
  ShipmentInput,
  SurchargeOverride,
  SurchargeRule,
  ZipList,
} from "@/engine/types";

/**
 * Surcharge evaluation tests (docs-m2-design.md §1.7, §1.8, §1.9, §1.10, §1.11), exercised through
 * calculateShipment with small hand-built contexts. Every expected value is derived by hand in a
 * comment next to the assertion; nothing was copied from engine output. All data is FICTIONAL.
 *
 * Arithmetic conventions used throughout:
 *  - The rate table prices zone 2 at 10.00 per billable pound: bracket (n−1, n] lb costs 10n.00.
 *    So a 1 lb package has a 10.00 base, a 2 lb package 20.00, a 3 lb package 30.00.
 *  - The test service is DIM-exempt (billable = actual weight rounded up to the whole pound), so
 *    dimensions never change the base price but are still measured for dimension conditions.
 *    DIM behaviour itself is covered in engine-dim.test.ts.
 *  - Rules default to a flat 1.00 per package with no conditions; tests override what they need.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE_ID = "svc-test";

/** Zone 2, any origin: bracket (n−1, n] lb costs 10n.00 for n = 1..100, i.e. base = 10 × billable lb. */
const ROWS: RateRow[] = Array.from({ length: 100 }, (_, i) => {
  const n = i + 1;
  return { serviceId: SERVICE_ID, originPrefix: null, zone: "2", weightMin: String(n - 1), weightMax: String(n), weightUnit: "lb", price: `${n * 10}.00`, minCharge: null };
});

function terms(overrides: Partial<ServiceTerms> = {}): ServiceTerms {
  return {
    serviceId: SERVICE_ID,
    carrierCode: "ups",
    serviceCode: "ground",
    serviceName: "Test Ground",
    dim: { divisor: "139", thresholdCubicIn: null, dimensionRounding: "nearest_whole", weightRounding: "up_whole_lb", minBillableLb: null, exempt: true },
    minCharge: null,
    includedSurchargeKeys: [],
    excludedSurchargeKeys: [],
    zoneChartKey: "default",
    zoneIndependent: false,
    surchargeMarkupPercent: null,
    sourceReference: "test terms",
    termsVersion: "test-terms-v1",
    ...overrides,
  };
}

function context(opts: { rules?: SurchargeRule[]; overrides?: SurchargeOverride[]; zipLists?: ZipList[]; service?: Partial<ServiceTerms> } = {}): PricingContext {
  return {
    rateCard: {
      rateCardId: "sur-card",
      rateCardName: "Surcharge test card (fictional)",
      versionId: "sur-card-v1",
      versionNumber: 1,
      currency: "USD",
      effectiveDate: "2026-01-01",
      expirationDate: null,
      services: [terms(opts.service)],
      rows: ROWS,
      zones: [],
    },
    rules: opts.rules ?? [],
    zipLists: opts.zipLists ?? [],
    overrides: opts.overrides ?? [],
  };
}

/** A flat 1.00 per-package rule with no conditions unless overridden. */
function rule(key: string, overrides: Partial<SurchargeRule> = {}): SurchargeRule {
  return {
    key,
    brandId: null,
    billableWeightFloorLb: null,
    ruleId: `id-${key}`,
    versionId: `id-${key}-v${overrides.version ?? 1}`,
    version: 1,
    scope: "tenant",
    carrierCode: "ups",
    serviceCodes: null,
    category: "other",
    name: `Rule ${key}`,
    chargeClass: "definite",
    method: "flat",
    amount: "1.00",
    percent: null,
    perUnit: null,
    base: { kind: "base_rate" },
    conditions: [],
    exclusivityGroup: null,
    exclusivityPriority: 0,
    excludesRuleKeys: [],
    perPackage: true,
    effectiveDate: "2026-01-01",
    expirationDate: null,
    sourceReference: "TEST: fictional amount",
    sourceUrl: null,
    verificationStatus: "approved_3pl_config",
    ...overrides,
  };
}

function fuel(percent: string, base: SurchargeRule["base"], overrides: Partial<SurchargeRule> = {}): SurchargeRule {
  return rule("fuel", { category: "fuel", name: "Fuel surcharge", method: "percent", amount: null, percent, base, ...overrides });
}

/** Residential flat 5.00 per package, applies when the shipment is residential. */
function residential(overrides: Partial<SurchargeRule> = {}): SurchargeRule {
  return rule("res", { category: "residential", name: "Residential surcharge", amount: "5.00", conditions: [{ type: "residential", value: true }], ...overrides });
}

function override(ruleKey: string, mode: SurchargeOverride["mode"], extra: Partial<SurchargeOverride> = {}): SurchargeOverride {
  return { ruleKey, mode, amount: null, percent: null, effectiveDate: "2026-01-01", expirationDate: null, reference: `AGREEMENT-${ruleKey}`, ...extra };
}

const ONE_LB: PackageInput = { weight: "1", weightUnit: "lb" };
/** Dimensions given out of order on purpose: sorted they are 30 × 20 × 10 in (6000 cu in, L+G = 30 + 2×20 + 2×10 = 90). */
const BIG_DIMS: Pick<PackageInput, "length" | "width" | "height"> = { length: "10", width: "30", height: "20" };

function shipment(packages: PackageInput[], extra: Partial<ShipmentInput> = {}): ShipmentInput {
  return { shipDate: "2026-10-15", originZip: "90001", destinationZone: "2", residential: false, carrierCode: "ups", serviceCode: "ground", packages, ...extra };
}

function calc(input: ShipmentInput, ctx: PricingContext): ShipmentCalculation {
  const r = calculateShipment(input, ctx);
  expect(r.status, r.unavailableMessage ?? "").toBe("ok");
  return r;
}

function linesFor(r: ShipmentCalculation, key: string): ChargeLine[] {
  return r.lines.filter((l) => l.rule?.key === key);
}

/** The single line for a rule on a package (or on the shipment when packageIndex is null); fails if absent. */
function lineFor(r: ShipmentCalculation, key: string, packageIndex: number | null = 0): ChargeLine {
  const l = linesFor(r, key).find((x) => x.packageIndex === packageIndex);
  expect(l, `expected a line for ${key} on ${packageIndex === null ? "the shipment" : `package ${packageIndex}`}`).toBeDefined();
  return l!;
}

function totals(r: ShipmentCalculation) {
  return { definite: r.totals.definite.amount, estimated: r.totals.estimated.amount, expected: r.totals.expected.amount, conditionalExposure: r.totals.conditionalExposure.amount };
}

/** Keys of rules that produced at least one counted line, sorted. */
function countedKeys(r: ShipmentCalculation): string[] {
  return [...new Set(r.lines.filter((l) => l.rule && l.counted).map((l) => l.rule!.key))].sort();
}

function warningCodes(r: ShipmentCalculation): string[] {
  return r.warnings.map((w) => w.code);
}

// ---------------------------------------------------------------------------
// Condition types: applies / not / unknown
// ---------------------------------------------------------------------------

describe("condition types", () => {
  it("shipment-level conditions: residential, signature_in, saturday_delivery, ship_date_between, package_count_gt", () => {
    const rules = [
      rule("res_t", { perPackage: false, conditions: [{ type: "residential", value: true }] }),
      rule("res_f", { perPackage: false, conditions: [{ type: "residential", value: false }] }),
      rule("sig_hit", { perPackage: false, conditions: [{ type: "signature_in", values: ["direct", "adult"] }] }),
      rule("sig_miss", { perPackage: false, conditions: [{ type: "signature_in", values: ["indirect"] }] }),
      rule("sig_none", { perPackage: false, conditions: [{ type: "signature_in", values: ["none"] }] }),
      rule("sat_t", { perPackage: false, conditions: [{ type: "saturday_delivery", value: true }] }),
      rule("sat_f", { perPackage: false, conditions: [{ type: "saturday_delivery", value: false }] }),
      rule("date_in", { perPackage: false, conditions: [{ type: "ship_date_between", from: "2026-10-15", to: "2026-10-15" }] }), // both bounds inclusive
      rule("date_before", { perPackage: false, conditions: [{ type: "ship_date_between", from: "2026-10-16", to: "2026-12-31" }] }),
      rule("date_after", { perPackage: false, conditions: [{ type: "ship_date_between", from: "2026-01-01", to: "2026-10-14" }] }),
      rule("count_gt1", { perPackage: false, conditions: [{ type: "package_count_gt", value: 1 }] }), // 2 packages > 1
      rule("count_gt2", { perPackage: false, conditions: [{ type: "package_count_gt", value: 2 }] }), // 2 > 2 is false
    ];
    const ctx = context({ rules });

    const withOptions = calc(shipment([ONE_LB, ONE_LB], { residential: true, options: { signature: "adult", saturdayDelivery: true } }), ctx);
    expect(countedKeys(withOptions)).toEqual(["count_gt1", "date_in", "res_t", "sat_t", "sig_hit"]);
    // base 10.00 + 10.00, plus 5 applying rules × 1.00 = 25.00; every condition had its input, so nothing is unknown
    expect(totals(withOptions)).toEqual({ definite: "25.00", estimated: "0.00", expected: "25.00", conditionalExposure: "0.00" });
    expect(withOptions.lines.every((l) => l.counted && l.chargeClass === "definite")).toBe(true);

    // No options and residential false: signature defaults to "none", saturday to false (§1.11: absent inputs are "not", never unknown).
    const withoutOptions = calc(shipment([ONE_LB, ONE_LB]), ctx);
    expect(countedKeys(withoutOptions)).toEqual(["count_gt1", "date_in", "res_f", "sat_f", "sig_none"]);
    // 20.00 + 5 × 1.00 = 25.00
    expect(totals(withoutOptions).expected).toBe("25.00");
    expect(withoutOptions.lines.filter((l) => l.chargeClass === "estimated")).toHaveLength(0);
  });

  it("package attribute conditions: package_type_in, flag_present, declared_value_gt (absent input is 'not', not unknown)", () => {
    const rules = [
      rule("type_hit", { conditions: [{ type: "package_type_in", types: ["tube", "pallet"] }] }),
      rule("type_miss", { conditions: [{ type: "package_type_in", types: ["envelope"] }] }),
      rule("type_parcel", { conditions: [{ type: "package_type_in", types: ["parcel"] }] }),
      rule("flag_hit", { conditions: [{ type: "flag_present", flag: "hazmat" }] }),
      rule("flag_miss", { conditions: [{ type: "flag_present", flag: "fragile" }] }),
      rule("dv_hit", { conditions: [{ type: "declared_value_gt", amount: "100" }] }), // 150 > 100
      rule("dv_eq", { conditions: [{ type: "declared_value_gt", amount: "150" }] }), // 150 > 150 is false (strict)
    ];
    const ctx = context({ rules });

    const tube = calc(shipment([{ weight: "1", weightUnit: "lb", packageType: "tube", flags: ["hazmat"], declaredValue: "150" }]), ctx);
    expect(countedKeys(tube)).toEqual(["dv_hit", "flag_hit", "type_hit"]);
    // 10.00 + 3 × 1.00 = 13.00
    expect(totals(tube).expected).toBe("13.00");

    // A bare package: packageType defaults to parcel; no flags and no declared value are definite "not"s.
    const bare = calc(shipment([ONE_LB]), ctx);
    expect(countedKeys(bare)).toEqual(["type_parcel"]);
    // 10.00 + 1.00 = 11.00
    expect(totals(bare).expected).toBe("11.00");
    expect(bare.lines.filter((l) => l.chargeClass === "estimated")).toHaveLength(0);
  });

  it("weight_gt / weight_lte compare actual or billable pounds per package (oz converted)", () => {
    const rules = [
      rule("gt_actual", { conditions: [{ type: "weight_gt", valueLb: "2.5", basis: "actual" }] }), // 2.5 > 2.5 false
      rule("gt_billable", { conditions: [{ type: "weight_gt", valueLb: "2.5", basis: "billable" }] }), // 3 > 2.5 true
      rule("lte_actual", { conditions: [{ type: "weight_lte", valueLb: "2.5", basis: "actual" }] }), // 2.5 ≤ 2.5 true
      rule("lte_billable", { conditions: [{ type: "weight_lte", valueLb: "2.5", basis: "billable" }] }), // 3 ≤ 2.5 false
    ];
    // Package 0 is 2.5 lb; package 1 is 40 oz = 40 ÷ 16 = 2.5 lb. Both round up to 3 lb billable (base 30.00 each).
    const r = calc(shipment([{ weight: "2.5", weightUnit: "lb" }, { weight: "40", weightUnit: "oz" }]), context({ rules }));
    expect(r.packages.map((p) => p.billableLb)).toEqual(["3.0", "3.0"]);
    for (const i of [0, 1]) {
      expect(linesFor(r, "gt_actual").filter((l) => l.packageIndex === i)).toHaveLength(0);
      expect(lineFor(r, "gt_billable", i).counted).toBe(true);
      expect(lineFor(r, "lte_actual", i).counted).toBe(true);
      expect(linesFor(r, "lte_billable").filter((l) => l.packageIndex === i)).toHaveLength(0);
    }
    // 30.00 + 30.00 + 2 packages × (1.00 + 1.00) = 64.00
    expect(totals(r).expected).toBe("64.00");
  });

  it("dimension conditions use the sorted, rounded dimensions: longest, second longest, length+girth, cubic", () => {
    const rules = [
      rule("long_hit", { conditions: [{ type: "longest_side_gt", inches: "29" }] }), // 30 > 29
      rule("long_miss", { conditions: [{ type: "longest_side_gt", inches: "30" }] }), // 30 > 30 false
      rule("second_hit", { conditions: [{ type: "second_longest_side_gt", inches: "19" }] }), // 20 > 19
      rule("second_miss", { conditions: [{ type: "second_longest_side_gt", inches: "20" }] }),
      rule("lg_hit", { conditions: [{ type: "length_plus_girth_gt", inches: "89" }] }), // 30 + 2×20 + 2×10 = 90 > 89
      rule("lg_miss", { conditions: [{ type: "length_plus_girth_gt", inches: "90" }] }),
      rule("cubic_hit", { conditions: [{ type: "cubic_in_gt", value: "5999" }] }), // 30 × 20 × 10 = 6000 > 5999
      rule("cubic_miss", { conditions: [{ type: "cubic_in_gt", value: "6000" }] }),
    ];
    // Package 0: 10 × 30 × 20 given out of order. Package 1: 9.5 × 29.5 × 19.5, which nearest_whole (HALF_UP)
    // rounds to 10 × 30 × 20, so both packages measure 30 × 20 × 10 sorted.
    const r = calc(shipment([{ weight: "1", weightUnit: "lb", ...BIG_DIMS }, { weight: "1", weightUnit: "lb", length: "9.5", width: "29.5", height: "19.5" }]), context({ rules }));
    expect(r.packages.map((p) => p.roundedDimensionsIn)).toEqual([
      ["30.0", "20.0", "10.0"],
      ["30.0", "20.0", "10.0"],
    ]);
    for (const i of [0, 1]) {
      const keysOnPackage = r.lines.filter((l) => l.rule && l.packageIndex === i).map((l) => l.rule!.key).sort();
      expect(keysOnPackage).toEqual(["cubic_hit", "lg_hit", "long_hit", "second_hit"]);
    }
    // 10.00 + 10.00 + 2 packages × 4 × 1.00 = 28.00
    expect(totals(r).expected).toBe("28.00");
    expect(r.lines.every((l) => l.counted)).toBe(true);
  });

  it("a dimension condition with no dimensions is unknown: estimated, uncounted, amount as if it applied, referenced", () => {
    const r = calc(shipment([ONE_LB]), context({ rules: [rule("long", { amount: "4.00", conditions: [{ type: "longest_side_gt", inches: "29" }] })] }));
    const l = lineFor(r, "long");
    expect(l.amount.amount).toBe("4.00"); // flat 4.00 computed as if it applied
    expect(l.chargeClass).toBe("estimated");
    expect(l.counted).toBe(false);
    expect(l.explanation).toContain("Could not confirm whether Rule long applies: package dimensions were not given");
    // The service is DIM-exempt, so the base is still definite; the unknown line is in no total: 10.00.
    expect(totals(r)).toEqual({ definite: "10.00", estimated: "0.00", expected: "10.00", conditionalExposure: "0.00" });
    expect(r.references.rules.map((x) => x.key)).toEqual(["long"]);
    expect(warningCodes(r)).toEqual([]);
  });

  it("zone_in matches the resolved zone after normalisation", () => {
    const rules = [
      rule("zone_hit", { conditions: [{ type: "zone_in", zones: ["2", "3"] }] }),
      rule("zone_norm", { conditions: [{ type: "zone_in", zones: ["Zone 2"] }] }), // "Zone 2" normalises to "2"
      rule("zone_miss", { conditions: [{ type: "zone_in", zones: ["5"] }] }),
    ];
    const r = calc(shipment([ONE_LB]), context({ rules }));
    expect(countedKeys(r)).toEqual(["zone_hit", "zone_norm"]);
    // 10.00 + 2 × 1.00 = 12.00
    expect(totals(r).expected).toBe("12.00");
  });

  const DAS_LIST: ZipList = { key: "test.das", version: 1, sourceReference: "TEST", effectiveDate: "2026-01-01", expirationDate: null, entries: ["93920", "9362", "958"] };
  const dasRule = () => rule("das", { category: "das", name: "Delivery area surcharge", amount: "4.00", conditions: [{ type: "destination_zip_in_list", listKey: "test.das" }] });

  it("destination_zip_in_list matches an exact 5-digit entry or a 3/4-digit prefix entry", () => {
    const ctx = context({ rules: [dasRule()], zipLists: [DAS_LIST] });
    const cases: [string, boolean][] = [
      ["93920", true], // exact entry
      ["93625", true], // 4-digit prefix entry "9362"
      ["95811", true], // 3-digit prefix entry "958"
      ["93921", false], // neither "93921", "9392" nor "939" is listed
      ["90001", false],
    ];
    for (const [zip, hit] of cases) {
      const r = calc(shipment([ONE_LB], { destinationZip: zip }), ctx);
      expect(linesFor(r, "das").length, zip).toBe(hit ? 1 : 0);
      if (hit) expect(lineFor(r, "das").counted).toBe(true);
      // 10.00 base, plus 4.00 when the ZIP is listed
      expect(totals(r).expected, zip).toBe(hit ? "14.00" : "10.00");
      expect(warningCodes(r), zip).toEqual([]);
    }
  });

  it("destination_zip_in_list with no ZIP lists loaded is unknown and warns zip_list_missing", () => {
    const r = calc(shipment([ONE_LB], { destinationZip: "93920" }), context({ rules: [dasRule()], zipLists: [] }));
    const l = lineFor(r, "das");
    expect(l.chargeClass).toBe("estimated");
    expect(l.counted).toBe(false);
    expect(l.amount.amount).toBe("4.00");
    expect(l.explanation).toContain('the ZIP list "test.das" is not loaded');
    expect(totals(r)).toEqual({ definite: "10.00", estimated: "0.00", expected: "10.00", conditionalExposure: "0.00" });
    expect(warningCodes(r)).toEqual(["zip_list_missing"]);
  });

  // ENGINE DEFECT: §1.11 says zip_list_missing is warned "only when a referenced list is absent from the
  // context". The engine only warns when the context holds no ZIP lists at all (calculate.ts step 9 checks
  // `evalCtx.zipLists.size === 0`), so a rule whose own list is missing produces an estimated line with
  // "is not loaded" in its explanation but no warning as soon as any unrelated list is loaded.
  it("destination_zip_in_list warns zip_list_missing when the referenced list is absent even if other lists are loaded", () => {
    const other: ZipList = { key: "other.list", version: 1, sourceReference: "TEST", effectiveDate: "2026-01-01", expirationDate: null, entries: ["10001"] };
    const r = calc(shipment([ONE_LB], { destinationZip: "93920" }), context({ rules: [dasRule()], zipLists: [other] }));
    const l = lineFor(r, "das");
    expect(l.chargeClass).toBe("estimated");
    expect(l.counted).toBe(false);
    expect(l.explanation).toContain('the ZIP list "test.das" is not loaded');
    expect(warningCodes(r)).toEqual(["zip_list_missing"]);
  });

  it("ZIP conditions are unknown without a destination ZIP (zone entered directly) and produce no warning", () => {
    const rules = [dasRule(), rule("prefix", { conditions: [{ type: "destination_zip_prefix_in", prefixes: ["939"] }] })];
    const r = calc(shipment([ONE_LB]), context({ rules, zipLists: [DAS_LIST] })); // destinationZone "2", no destinationZip
    for (const key of ["das", "prefix"]) {
      const l = lineFor(r, key);
      expect(l.chargeClass, key).toBe("estimated");
      expect(l.counted, key).toBe(false);
      expect(l.explanation, key).toContain("no destination ZIP was given");
    }
    expect(totals(r).expected).toBe("10.00");
    expect(warningCodes(r)).toEqual([]);
  });

  it("destination_zip_prefix_in matches any listed prefix of the destination ZIP", () => {
    const rules = [
      rule("p3", { conditions: [{ type: "destination_zip_prefix_in", prefixes: ["939"] }] }),
      rule("p4", { conditions: [{ type: "destination_zip_prefix_in", prefixes: ["100", "9392"] }] }),
      rule("p_miss", { conditions: [{ type: "destination_zip_prefix_in", prefixes: ["93921", "940"] }] }),
    ];
    const r = calc(shipment([ONE_LB], { destinationZip: "93920" }), context({ rules }));
    expect(countedKeys(r)).toEqual(["p3", "p4"]);
    // 10.00 + 2 × 1.00 = 12.00
    expect(totals(r).expected).toBe("12.00");
  });

  it("conditions are ANDed: any 'not' wins over unknown, otherwise any unknown makes the rule unknown", () => {
    const rules = [
      rule("and_not", { conditions: [{ type: "longest_side_gt", inches: "29" }, { type: "residential", value: false }] }), // unknown AND not → not
      rule("and_unknown", { conditions: [{ type: "residential", value: true }, { type: "longest_side_gt", inches: "29" }] }), // applies AND unknown → unknown
      rule("and_applies", { conditions: [{ type: "residential", value: true }, { type: "weight_lte", valueLb: "5", basis: "actual" }] }), // applies AND applies
    ];
    const r = calc(shipment([ONE_LB], { residential: true }), context({ rules }));
    expect(linesFor(r, "and_not")).toHaveLength(0);
    expect(lineFor(r, "and_unknown").chargeClass).toBe("estimated");
    expect(lineFor(r, "and_unknown").counted).toBe(false);
    expect(lineFor(r, "and_applies").counted).toBe(true);
    // 10.00 + 1.00 (and_applies) = 11.00
    expect(totals(r).expected).toBe("11.00");
  });
});

// ---------------------------------------------------------------------------
// Per-package vs per-shipment rules
// ---------------------------------------------------------------------------

describe("per-package vs per-shipment rules", () => {
  it("a per-package rule is evaluated and charged per package; a per-shipment rule once with packageIndex null", () => {
    const rules = [
      rule("pp", { amount: "5.00", conditions: [{ type: "weight_gt", valueLb: "2", basis: "actual" }] }),
      rule("ps", { amount: "6.50", perPackage: false }),
    ];
    const r = calc(shipment([ONE_LB, { weight: "3", weightUnit: "lb" }]), context({ rules }));
    expect(linesFor(r, "pp").map((l) => l.packageIndex)).toEqual([1]); // only the 3 lb package exceeds 2 lb
    expect(linesFor(r, "ps").map((l) => l.packageIndex)).toEqual([null]);
    expect(lineFor(r, "ps", null).explanation).toContain("per shipment");
    expect(lineFor(r, "pp", 1).explanation).toContain("per package");
    // 10.00 + 30.00 + 5.00 + 6.50 = 51.50
    expect(totals(r).expected).toBe("51.50");
  });

  it("per-shipment rules in multi-package shipments: greater-than holds if any package satisfies it, lte only if all do", () => {
    const rules = [
      rule("any_gt", { perPackage: false, conditions: [{ type: "weight_gt", valueLb: "2", basis: "actual" }] }), // [not, applies] → applies
      rule("all_lte_fail", { perPackage: false, conditions: [{ type: "weight_lte", valueLb: "2", basis: "actual" }] }), // [applies, not] → not
      rule("all_lte_ok", { perPackage: false, conditions: [{ type: "weight_lte", valueLb: "3", basis: "actual" }] }), // [applies, applies] → applies
      rule("any_dims_hit", { perPackage: false, conditions: [{ type: "longest_side_gt", inches: "29" }] }), // [unknown, applies] → applies
      rule("any_dims_unknown", { perPackage: false, conditions: [{ type: "longest_side_gt", inches: "30" }] }), // [unknown, not] → unknown
    ];
    // Package 0: 1 lb, no dimensions. Package 1: 3 lb, 30 × 20 × 10 in.
    const r = calc(shipment([ONE_LB, { weight: "3", weightUnit: "lb", ...BIG_DIMS }]), context({ rules }));
    expect(countedKeys(r)).toEqual(["all_lte_ok", "any_dims_hit", "any_gt"]);
    expect(linesFor(r, "all_lte_fail")).toHaveLength(0);
    const unknown = lineFor(r, "any_dims_unknown", null);
    expect(unknown.chargeClass).toBe("estimated");
    expect(unknown.counted).toBe(false);
    // 10.00 + 30.00 + 3 × 1.00 = 43.00
    expect(totals(r)).toEqual({ definite: "43.00", estimated: "0.00", expected: "43.00", conditionalExposure: "0.00" });
  });
});

// ---------------------------------------------------------------------------
// Exclusivity groups
// ---------------------------------------------------------------------------

describe("exclusivity groups", () => {
  it("the highest priority applying rule wins and the loser is absent from the itemization", () => {
    const rules = [
      rule("lo", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "20.00" }),
      rule("hi", { exclusivityGroup: "grp", exclusivityPriority: 2, amount: "6.00" }),
    ];
    const r = calc(shipment([ONE_LB]), context({ rules }));
    expect(lineFor(r, "hi").amount.amount).toBe("6.00");
    expect(linesFor(r, "lo")).toHaveLength(0);
    expect(r.references.rules.map((x) => x.key)).toEqual(["hi"]);
    // 10.00 + 6.00 = 16.00 (not the larger 20.00: priority beats amount)
    expect(totals(r).expected).toBe("16.00");
  });

  it("equal priority: the higher amount wins, counting a customer override_amount", () => {
    const rules = [
      rule("a", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "20.00" }),
      rule("b", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "28.00" }),
    ];
    const plain = calc(shipment([ONE_LB]), context({ rules }));
    expect(lineFor(plain, "b").amount.amount).toBe("28.00");
    expect(linesFor(plain, "a")).toHaveLength(0);
    // 10.00 + 28.00 = 38.00
    expect(totals(plain).expected).toBe("38.00");

    // With a's amount overridden to 30.00 for this customer, a (30.00) now beats b (28.00).
    const overridden = calc(shipment([ONE_LB]), context({ rules, overrides: [override("a", "override_amount", { amount: "30.00" })] }));
    expect(lineFor(overridden, "a").amount.amount).toBe("30.00");
    expect(linesFor(overridden, "b")).toHaveLength(0);
    // 10.00 + 30.00 = 40.00
    expect(totals(overridden).expected).toBe("40.00");
  });

  it("equal priority and amount: the lexically first key wins regardless of rule order", () => {
    const rules = [
      rule("zz.rule", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "5.00" }),
      rule("aa.rule", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "5.00" }),
    ];
    const r = calc(shipment([ONE_LB]), context({ rules }));
    expect(lineFor(r, "aa.rule").counted).toBe(true);
    expect(linesFor(r, "zz.rule")).toHaveLength(0);
    // 10.00 + 5.00 = 15.00
    expect(totals(r).expected).toBe("15.00");
  });

  it("exclusivity is resolved per package for per-package rules", () => {
    const rules = [
      rule("a", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "20.00", conditions: [{ type: "weight_gt", valueLb: "2", basis: "actual" }] }),
      rule("b", { exclusivityGroup: "grp", exclusivityPriority: 2, amount: "6.00", conditions: [{ type: "flag_present", flag: "x" }] }),
    ];
    // Package 0: 3 lb, no flag → only a applies. Package 1: 1 lb with flag x → only b applies.
    const r = calc(shipment([{ weight: "3", weightUnit: "lb" }, { weight: "1", weightUnit: "lb", flags: ["x"] }]), context({ rules }));
    expect(linesFor(r, "a").map((l) => [l.packageIndex, l.amount.amount])).toEqual([[0, "20.00"]]);
    expect(linesFor(r, "b").map((l) => [l.packageIndex, l.amount.amount])).toEqual([[1, "6.00"]]);
    // (30.00 + 20.00) + (10.00 + 6.00) = 66.00
    expect(totals(r).expected).toBe("66.00");
  });

  it("a group with only an unknown member keeps its estimated line; a member waived by override cannot win", () => {
    const unknownOnly = calc(
      shipment([ONE_LB]),
      context({
        rules: [
          rule("a", { exclusivityGroup: "grp", exclusivityPriority: 2, amount: "20.00", conditions: [{ type: "longest_side_gt", inches: "29" }] }), // unknown (no dims)
          rule("b", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "6.00", conditions: [{ type: "flag_present", flag: "nope" }] }), // not
        ],
      }),
    );
    expect(lineFor(unknownOnly, "a").chargeClass).toBe("estimated");
    expect(lineFor(unknownOnly, "a").counted).toBe(false);
    expect(linesFor(unknownOnly, "b")).toHaveLength(0);
    expect(totals(unknownOnly).expected).toBe("10.00"); // base only

    const waived = calc(
      shipment([ONE_LB]),
      context({
        rules: [rule("a", { exclusivityGroup: "grp", exclusivityPriority: 2, amount: "20.00" }), rule("b", { exclusivityGroup: "grp", exclusivityPriority: 1, amount: "6.00" })],
        overrides: [override("a", "exclude")],
      }),
    );
    expect(lineFor(waived, "b").counted).toBe(true);
    expect(linesFor(waived, "a").filter((l) => l.counted)).toHaveLength(0);
    expect(waived.warnings).toContainEqual(expect.objectContaining({ code: "rule_overridden", ruleKey: "a" }));
    // 10.00 + 6.00 = 16.00
    expect(totals(waived).expected).toBe("16.00");
  });
});

// ---------------------------------------------------------------------------
// Bundling: excludesRuleKeys
// ---------------------------------------------------------------------------

describe("excludesRuleKeys bundling", () => {
  it("an applying rule suppresses the keys it lists (absent); an unknown rule bundles nothing", () => {
    const applying = calc(shipment([ONE_LB]), context({ rules: [rule("a", { amount: "8.00", excludesRuleKeys: ["b"] }), rule("b", { amount: "3.00" })] }));
    expect(lineFor(applying, "a").amount.amount).toBe("8.00");
    expect(linesFor(applying, "b")).toHaveLength(0);
    expect(applying.references.rules.map((x) => x.key)).toEqual(["a"]);
    // 10.00 + 8.00 = 18.00
    expect(totals(applying).expected).toBe("18.00");

    const unknown = calc(
      shipment([ONE_LB]),
      context({ rules: [rule("a", { amount: "8.00", excludesRuleKeys: ["b"], conditions: [{ type: "longest_side_gt", inches: "29" }] }), rule("b", { amount: "3.00" })] }),
    );
    expect(lineFor(unknown, "a").counted).toBe(false);
    expect(lineFor(unknown, "b").counted).toBe(true);
    // 10.00 + 3.00 = 13.00 (a is only an uncounted estimate)
    expect(totals(unknown).expected).toBe("13.00");
  });

  it("per-package bundling only suppresses the same package; shipment-level bundling suppresses every package", () => {
    const perPackage = calc(
      shipment([{ weight: "1", weightUnit: "lb", flags: ["x"] }, ONE_LB]),
      context({ rules: [rule("a", { amount: "8.00", excludesRuleKeys: ["b"], conditions: [{ type: "flag_present", flag: "x" }] }), rule("b", { amount: "3.00" })] }),
    );
    expect(linesFor(perPackage, "a").map((l) => l.packageIndex)).toEqual([0]);
    expect(linesFor(perPackage, "b").map((l) => l.packageIndex)).toEqual([1]); // b survives on package 1 only
    // (10.00 + 8.00) + (10.00 + 3.00) = 31.00
    expect(totals(perPackage).expected).toBe("31.00");

    const shipmentLevel = calc(shipment([ONE_LB, ONE_LB]), context({ rules: [rule("a", { amount: "8.00", perPackage: false, excludesRuleKeys: ["b"] }), rule("b", { amount: "3.00" })] }));
    expect(linesFor(shipmentLevel, "a").map((l) => l.packageIndex)).toEqual([null]);
    expect(linesFor(shipmentLevel, "b")).toHaveLength(0);
    // 10.00 + 10.00 + 8.00 = 28.00
    expect(totals(shipmentLevel).expected).toBe("28.00");
  });
});

// ---------------------------------------------------------------------------
// Service terms: included and excluded surcharge keys
// ---------------------------------------------------------------------------

describe("included and excluded surcharge keys", () => {
  it("includedSurchargeKeys: the line is listed with counted false and its own class, and still referenced", () => {
    const r = calc(shipment([ONE_LB], { residential: true }), context({ rules: [residential()], service: { includedSurchargeKeys: ["res"] } }));
    const l = lineFor(r, "res");
    expect(l.amount.amount).toBe("5.00");
    expect(l.counted).toBe(false);
    expect(l.chargeClass).toBe("definite");
    expect(l.explanation).toContain("Included in the base rate under the rate card terms; not charged separately");
    expect(totals(r)).toEqual({ definite: "10.00", estimated: "0.00", expected: "10.00", conditionalExposure: "0.00" });
    expect(r.references.rules.map((x) => x.key)).toEqual(["res"]);
    expect(warningCodes(r)).toEqual([]);
  });

  it("excludedSurchargeKeys: the rule is neither listed nor referenced", () => {
    const r = calc(shipment([ONE_LB], { residential: true }), context({ rules: [residential()], service: { excludedSurchargeKeys: ["res"] } }));
    expect(linesFor(r, "res")).toHaveLength(0);
    expect(r.references.rules).toEqual([]);
    expect(totals(r).expected).toBe("10.00");
  });
});

// ---------------------------------------------------------------------------
// Customer overrides
// ---------------------------------------------------------------------------

describe("customer overrides", () => {
  it("exclude: the line is listed uncounted with the rule's class and warns rule_overridden; no warning when the rule does not apply anyway", () => {
    const ctx = context({ rules: [residential()], overrides: [override("res", "exclude", { reference: "AGREEMENT-1" })] });
    const r = calc(shipment([ONE_LB], { residential: true }), ctx);
    const l = lineFor(r, "res");
    expect(l.amount.amount).toBe("5.00");
    expect(l.counted).toBe(false);
    expect(l.chargeClass).toBe("definite");
    expect(l.explanation).toContain("Waived for this customer (AGREEMENT-1); not charged");
    expect(totals(r).expected).toBe("10.00");
    expect(r.warnings).toEqual([{ code: "rule_overridden", ruleKey: "res", message: "Residential surcharge is waived for this customer (AGREEMENT-1)." }]);

    const commercial = calc(shipment([ONE_LB], { residential: false }), ctx);
    expect(linesFor(commercial, "res")).toHaveLength(0);
    expect(warningCodes(commercial)).toEqual([]);
  });

  it("override_amount and override_percent replace the rule's figures, name the agreement, and add no warning", () => {
    const rules = [residential(), fuel("20", { kind: "base_rate" })];
    const overrides = [override("res", "override_amount", { amount: "7.25", reference: "AGREEMENT-RES" }), override("fuel", "override_percent", { percent: "10", reference: "AGREEMENT-FUEL" })];
    const r = calc(shipment([ONE_LB], { residential: true }), context({ rules, overrides }));
    const res = lineFor(r, "res");
    expect(res.amount.amount).toBe("7.25"); // 5.00 replaced by 7.25
    expect(res.counted).toBe(true);
    expect(res.explanation).toContain("Customer-specific rate applied (AGREEMENT-RES)");
    const f = lineFor(r, "fuel");
    expect(f.amount.amount).toBe("1.00"); // 10% of the 10.00 base (not the rule's 20%)
    expect(f.basis).toBe("10.0% of 10.0"); // basis strings use fmt(): trailing zeros trimmed, one decimal kept
    expect(f.explanation).toContain("Customer-specific rate applied (AGREEMENT-FUEL)");
    // 10.00 + 7.25 + 1.00 = 18.25
    expect(totals(r)).toEqual({ definite: "18.25", estimated: "0.00", expected: "18.25", conditionalExposure: "0.00" });
    expect(warningCodes(r)).toEqual([]);
  });

  it("overrides apply only inside their date window (both bounds inclusive); the latest effective one wins on overlap", () => {
    const total = (overrides: SurchargeOverride[]) => totals(calc(shipment([ONE_LB], { residential: true }), context({ rules: [residential()], overrides }))).expected;
    const nine = (extra: Partial<SurchargeOverride>) => override("res", "override_amount", { amount: "9.00", ...extra });
    // Ship date 2026-10-15. Inactive override → 10.00 + 5.00 = 15.00; active → 10.00 + 9.00 = 19.00.
    expect(total([nine({ effectiveDate: "2026-10-16" })])).toBe("15.00"); // starts tomorrow
    expect(total([nine({ effectiveDate: "2026-01-01", expirationDate: "2026-10-14" })])).toBe("15.00"); // ended yesterday
    expect(total([nine({ effectiveDate: "2026-10-15" })])).toBe("19.00"); // starts today
    expect(total([nine({ effectiveDate: "2026-01-01", expirationDate: "2026-10-15" })])).toBe("19.00"); // ends today
    // Two active amount overrides: the one effective later (9.00 from 2026-06-01) beats 7.00 from 2026-01-01.
    expect(total([override("res", "override_amount", { amount: "7.00", effectiveDate: "2026-01-01" }), nine({ effectiveDate: "2026-06-01" })])).toBe("19.00");
  });
});

// ---------------------------------------------------------------------------
// Effective dates, carrier/service filters and historical versions
// ---------------------------------------------------------------------------

describe("rule candidacy", () => {
  it("rules apply only when effective on the ship date (inclusive) and for the shipment's carrier and service", () => {
    const applies = (overrides: Partial<SurchargeRule>) => linesFor(calc(shipment([ONE_LB]), context({ rules: [rule("r", overrides)] })), "r").length === 1;
    // Ship date 2026-10-15, carrier ups, service ground.
    expect(applies({ effectiveDate: "2026-10-16" })).toBe(false);
    expect(applies({ effectiveDate: "2026-01-01", expirationDate: "2026-10-14" })).toBe(false);
    expect(applies({ effectiveDate: "2026-10-15" })).toBe(true);
    expect(applies({ effectiveDate: "2026-01-01", expirationDate: "2026-10-15" })).toBe(true);
    expect(applies({ carrierCode: "fedex" })).toBe(false);
    expect(applies({ serviceCodes: ["second_day_air"] })).toBe(false);
    expect(applies({ serviceCodes: ["ground", "second_day_air"] })).toBe(true);
    expect(applies({ serviceCodes: null })).toBe(true);
  });

  it("historical versions: the highest effective version of a key is used, the older one when the newer is not yet in force", () => {
    const v1 = rule("k", { version: 1, amount: "5.00", effectiveDate: "2026-01-01" });
    const bothEffective = calc(shipment([ONE_LB]), context({ rules: [v1, rule("k", { version: 2, amount: "6.00", effectiveDate: "2026-01-01" })] }));
    expect(linesFor(bothEffective, "k").map((l) => [l.amount.amount, l.rule!.version])).toEqual([["6.00", 2]]);
    expect(bothEffective.references.rules.map((x) => [x.key, x.version])).toEqual([["k", 2]]);
    // 10.00 + 6.00 = 16.00
    expect(totals(bothEffective).expected).toBe("16.00");

    const v2Future = calc(shipment([ONE_LB]), context({ rules: [v1, rule("k", { version: 2, amount: "6.00", effectiveDate: "2026-11-01" })] }));
    expect(linesFor(v2Future, "k").map((l) => [l.amount.amount, l.rule!.version])).toEqual([["5.00", 1]]);
    // 10.00 + 5.00 = 15.00
    expect(totals(v2Future).expected).toBe("15.00");
  });
});

// ---------------------------------------------------------------------------
// Charge classes: conditional
// ---------------------------------------------------------------------------

describe("conditional rules", () => {
  it("conditional lines are uncounted and summed only into conditionalExposure (per shipment and per package)", () => {
    const rules = [
      rule("ac", { category: "address_correction", chargeClass: "conditional", amount: "21.00", perPackage: false }),
      rule("rw", { category: "reweight", chargeClass: "conditional", amount: "2.00" }),
    ];
    const r = calc(shipment([ONE_LB, ONE_LB]), context({ rules }));
    const ac = lineFor(r, "ac", null);
    expect(ac.chargeClass).toBe("conditional");
    expect(ac.counted).toBe(false);
    expect(ac.explanation).toContain("shown as potential exposure, not included in the total");
    expect(linesFor(r, "rw").map((l) => [l.packageIndex, l.counted])).toEqual([
      [0, false],
      [1, false],
    ]);
    // definite = 10.00 + 10.00 = 20.00; exposure = 21.00 + 2 × 2.00 = 25.00
    expect(totals(r)).toEqual({ definite: "20.00", estimated: "0.00", expected: "20.00", conditionalExposure: "25.00" });
  });

  it("a conditional rule with an unknown outcome is classed estimated and is in no total", () => {
    const r = calc(shipment([ONE_LB]), context({ rules: [rule("ac", { chargeClass: "conditional", amount: "21.00", conditions: [{ type: "longest_side_gt", inches: "29" }] })] }));
    const l = lineFor(r, "ac");
    expect(l.chargeClass).toBe("estimated");
    expect(l.counted).toBe(false);
    expect(totals(r)).toEqual({ definite: "10.00", estimated: "0.00", expected: "10.00", conditionalExposure: "0.00" });
  });
});

// ---------------------------------------------------------------------------
// per_unit declared value
// ---------------------------------------------------------------------------

describe("per_unit declared value", () => {
  const declaredValue = (overrides: Partial<SurchargeRule> = {}) =>
    rule("dv", {
      category: "declared_value",
      name: "Declared value",
      method: "per_unit",
      amount: "1.05",
      perUnit: { basis: "declared_value", unitSize: "100", freeAllowance: "100", minimumCharge: null },
      conditions: [{ type: "declared_value_gt", amount: "100" }],
      ...overrides,
    });

  it("charges amount × ceil((value − allowance) ÷ unit)", () => {
    const ctx = context({ rules: [declaredValue()] });
    const amountFor = (value: string) => lineFor(calc(shipment([{ ...ONE_LB, declaredValue: value }]), ctx), "dv");
    expect(amountFor("350").amount.amount).toBe("3.15"); // (350 − 100) ÷ 100 = 2.5 → 3 units × 1.05 = 3.15
    expect(amountFor("350").basis).toBe("1.05 × 3 units");
    expect(amountFor("300").amount.amount).toBe("2.10"); // 200 ÷ 100 = 2 exactly → 2 × 1.05 = 2.10
    expect(amountFor("300.01").amount.amount).toBe("3.15"); // 200.01 ÷ 100 = 2.0001 → 3 units
    expect(amountFor("100.01").amount.amount).toBe("1.05"); // 0.01 ÷ 100 → ceil = 1 unit
    // 10.00 + 3.15 = 13.15
    expect(totals(calc(shipment([{ ...ONE_LB, declaredValue: "350" }]), ctx)).expected).toBe("13.15");
  });

  it("charges nothing when the declared value is at or below the free allowance, or absent", () => {
    for (const rules of [[declaredValue()], [declaredValue({ conditions: [] })]]) {
      for (const pkg of [{ ...ONE_LB, declaredValue: "100" }, { ...ONE_LB, declaredValue: "50" }, ONE_LB]) {
        const r = calc(shipment([pkg]), context({ rules }));
        expect(linesFor(r, "dv"), JSON.stringify(pkg)).toHaveLength(0);
        expect(totals(r).expected).toBe("10.00");
      }
    }
  });

  it("per-shipment rules sum the units of every package into one line; per-package rules emit one line per package", () => {
    // Packages: 150 → (150 − 100) ÷ 100 = 0.5 → 1 unit; 350 → 3 units; no declared value → 0 units.
    const packages: PackageInput[] = [{ ...ONE_LB, declaredValue: "150" }, { ...ONE_LB, declaredValue: "350" }, ONE_LB];

    const perShipment = calc(shipment(packages), context({ rules: [declaredValue({ perPackage: false })] }));
    expect(linesFor(perShipment, "dv").map((l) => [l.packageIndex, l.amount.amount, l.basis])).toEqual([[null, "4.20", "1.05 × 4 units"]]); // 4 × 1.05
    // 3 × 10.00 + 4.20 = 34.20
    expect(totals(perShipment).expected).toBe("34.20");

    const perPackage = calc(shipment(packages), context({ rules: [declaredValue()] }));
    expect(linesFor(perPackage, "dv").map((l) => [l.packageIndex, l.amount.amount])).toEqual([
      [0, "1.05"], // 1 unit
      [1, "3.15"], // 3 units
    ]);
    expect(totals(perPackage).expected).toBe("34.20");

    // override_amount replaces the per-unit amount: 4 units × 2.00 = 8.00; 30.00 + 8.00 = 38.00
    const overridden = calc(shipment(packages), context({ rules: [declaredValue({ perPackage: false })], overrides: [override("dv", "override_amount", { amount: "2.00" })] }));
    expect(lineFor(overridden, "dv", null).amount.amount).toBe("8.00");
    expect(totals(overridden).expected).toBe("38.00");
  });
});

// ---------------------------------------------------------------------------
// Percent rules and fuel
// ---------------------------------------------------------------------------

describe("percent rules and fuel", () => {
  it("base_rate: the base is the base line plus any minimum-charge line, surcharges excluded", () => {
    const r = calc(shipment([ONE_LB], { residential: true }), context({ rules: [residential(), fuel("20", { kind: "base_rate" })], service: { minCharge: "12.00" } }));
    const minimum = r.lines.find((l) => l.kind === "minimum_charge")!;
    expect(minimum.amount.amount).toBe("2.00"); // 12.00 minimum − 10.00 bracket price
    const f = lineFor(r, "fuel");
    expect(f.kind).toBe("fuel");
    expect(f.amount.amount).toBe("2.40"); // 20% × (10.00 + 2.00) = 2.40; the 5.00 residential is not in the base
    expect(f.basis).toBe("20.0% of 12.0"); // fmt() trims trailing zeros: 12.00 → "12.0"
    expect(f.chargeClass).toBe("definite");
    // 10.00 + 2.00 + 5.00 + 2.40 = 19.40
    expect(totals(r)).toEqual({ definite: "19.40", estimated: "0.00", expected: "19.40", conditionalExposure: "0.00" });
  });

  it("base_plus_all_surcharges includes every counted non-fuel line, including a percent surcharge evaluated before fuel", () => {
    const otherPercent = rule("handling_pct", { method: "percent", amount: null, percent: "10", base: { kind: "base_rate" } });
    const r = calc(shipment([ONE_LB], { residential: true }), context({ rules: [residential(), otherPercent, fuel("20", { kind: "base_plus_all_surcharges" })] }));
    expect(lineFor(r, "handling_pct").amount.amount).toBe("1.00"); // 10% × 10.00 base
    expect(lineFor(r, "handling_pct").kind).toBe("surcharge");
    const f = lineFor(r, "fuel");
    expect(f.amount.amount).toBe("3.20"); // 20% × (10.00 + 5.00 + 1.00) = 20% × 16.00 = 3.20
    expect(f.basis).toBe("20.0% of 16.0");
    // 10.00 + 5.00 + 1.00 + 3.20 = 19.20
    expect(totals(r).expected).toBe("19.20");
  });

  it("base_plus_categories adds only counted lines of the listed categories, in the line's own package scope", () => {
    const rules = [residential(), rule("handling", { category: "other", amount: "2.00" }), rule("sig", { category: "signature", amount: "6.50", perPackage: false })];
    const input = shipment([ONE_LB], { residential: true });

    const residentialOnly = calc(input, context({ rules: [...rules, fuel("20", { kind: "base_plus_categories", categories: ["residential"] })] }));
    expect(lineFor(residentialOnly, "fuel").amount.amount).toBe("3.00"); // 20% × (10.00 + 5.00)
    // 10.00 + 5.00 + 2.00 + 6.50 + 3.00 = 26.50
    expect(totals(residentialOnly).expected).toBe("26.50");

    const residentialAndOther = calc(input, context({ rules: [...rules, fuel("20", { kind: "base_plus_categories", categories: ["residential", "other"] })] }));
    expect(lineFor(residentialAndOther, "fuel").amount.amount).toBe("3.40"); // 20% × (10.00 + 5.00 + 2.00) = 3.40
    // 10.00 + 5.00 + 2.00 + 6.50 + 3.40 = 26.90
    expect(totals(residentialAndOther).expected).toBe("26.90");

    // Shipment-level fuel listing "signature": per package 20% × 10.00 = 2.00; shipment level 20% × 6.50 = 1.30.
    const signature = calc(input, context({ rules: [...rules, fuel("20", { kind: "base_plus_categories", categories: ["signature"] }, { perPackage: false })] }));
    expect(linesFor(signature, "fuel").map((l) => [l.packageIndex, l.amount.amount])).toEqual([
      [0, "2.00"],
      [null, "1.30"],
    ]);
    // 10.00 + 5.00 + 2.00 + 6.50 + 2.00 + 1.30 = 26.80
    expect(totals(signature).expected).toBe("26.80");
  });

  it("uncounted lines (included, conditional, unknown) are never part of a percent base", () => {
    const rules = [
      residential(), // included in the base price → uncounted
      rule("ac", { chargeClass: "conditional", amount: "21.00" }), // conditional → uncounted
      rule("long", { amount: "4.00", conditions: [{ type: "longest_side_gt", inches: "29" }] }), // unknown → uncounted
      fuel("20", { kind: "base_plus_all_surcharges" }),
    ];
    const r = calc(shipment([ONE_LB], { residential: true }), context({ rules, service: { includedSurchargeKeys: ["res"] } }));
    expect(lineFor(r, "res").counted).toBe(false);
    expect(lineFor(r, "ac").counted).toBe(false);
    expect(lineFor(r, "long").counted).toBe(false);
    expect(lineFor(r, "fuel").amount.amount).toBe("2.00"); // 20% × 10.00 only
    expect(lineFor(r, "fuel").chargeClass).toBe("definite"); // the unknown line is not in the base, so fuel stays definite
    // definite = 10.00 + 2.00 = 12.00; exposure = 21.00
    expect(totals(r)).toEqual({ definite: "12.00", estimated: "0.00", expected: "12.00", conditionalExposure: "21.00" });
  });

  it("percent lines are rounded HALF_UP to the cent once, and totals add the rounded lines", () => {
    const halfCent = calc(shipment([ONE_LB]), context({ rules: [rule("s", { amount: "0.30" }), fuel("15", { kind: "base_plus_all_surcharges" })] }));
    expect(lineFor(halfCent, "fuel").amount.amount).toBe("1.55"); // 15% × 10.30 = 1.545 → HALF_UP → 1.55 (not 1.54)
    expect(lineFor(halfCent, "fuel").basis).toBe("15.0% of 10.3"); // fmt() trims the trailing zero of 10.30
    // 10.00 + 0.30 + 1.55 = 11.85
    expect(totals(halfCent).expected).toBe("11.85");

    const fractional = calc(shipment([ONE_LB]), context({ rules: [rule("s", { amount: "32.10" }), fuel("16.5", { kind: "base_plus_all_surcharges" })] }));
    expect(lineFor(fractional, "fuel").amount.amount).toBe("6.95"); // 16.5% × 42.10 = 6.9465 → 6.95
    expect(lineFor(fractional, "fuel").basis).toBe("16.5% of 42.1");
    // 10.00 + 32.10 + 6.95 = 49.05
    expect(totals(fractional).expected).toBe("49.05");
  });

  it("fuel is computed per package, plus one shipment-level line over shipment-level charges (skipped when there are none)", () => {
    const rules = [residential(), rule("sig", { category: "signature", amount: "6.50", perPackage: false })];
    const input = shipment([ONE_LB, { weight: "2", weightUnit: "lb" }], { residential: true });

    // Per-shipment fuel: package 0 → 20% × (10.00 + 5.00) = 3.00; package 1 → 20% × (20.00 + 5.00) = 5.00; shipment → 20% × 6.50 = 1.30.
    const perShipment = calc(input, context({ rules: [...rules, fuel("20", { kind: "base_plus_all_surcharges" }, { perPackage: false })] }));
    expect(linesFor(perShipment, "fuel").map((l) => [l.packageIndex, l.amount.amount])).toEqual([
      [0, "3.00"],
      [1, "5.00"],
      [null, "1.30"],
    ]);
    // 10.00 + 20.00 + 5.00 + 5.00 + 6.50 + 3.00 + 5.00 + 1.30 = 55.80
    expect(totals(perShipment).expected).toBe("55.80");

    // Per-package fuel: each package gets its own line, and the counted shipment-level signature still
    // carries fuel on one shipment-level line (a per-package rule never silently skips shipment charges).
    const perPackage = calc(input, context({ rules: [...rules, fuel("20", { kind: "base_plus_all_surcharges" })] }));
    expect(linesFor(perPackage, "fuel").map((l) => [l.packageIndex, l.amount.amount])).toEqual([
      [0, "3.00"],
      [1, "5.00"],
      [null, "1.30"],
    ]);
    expect(totals(perPackage).expected).toBe("55.80");

    // Per-shipment fuel with no shipment-level charges: the shipment-level fuel line is not emitted (zero base).
    const noShipmentLines = calc(input, context({ rules: [residential(), fuel("20", { kind: "base_plus_all_surcharges" }, { perPackage: false })] }));
    expect(linesFor(noShipmentLines, "fuel").map((l) => l.packageIndex)).toEqual([0, 1]);
    // 10.00 + 20.00 + 5.00 + 5.00 + 3.00 + 5.00 = 48.00
    expect(totals(noShipmentLines).expected).toBe("48.00");
  });

  it("fuel is estimated when any line in its base is estimated: an estimated base rate, or an estimated-class surcharge", () => {
    // Dimensions given but the card states no DIM divisor → base line estimated (§1.4 step 3).
    const noDivisor = calc(
      shipment([{ weight: "1", weightUnit: "lb", length: "10", width: "8", height: "6" }]),
      context({ rules: [fuel("20", { kind: "base_rate" })], service: { dim: { divisor: null, thresholdCubicIn: null, dimensionRounding: "nearest_whole", weightRounding: "up_whole_lb", minBillableLb: null, exempt: false } } }),
    );
    expect(noDivisor.packages[0]!.basis).toBe("no_divisor");
    expect(noDivisor.lines.find((l) => l.kind === "base")!.chargeClass).toBe("estimated");
    const f = lineFor(noDivisor, "fuel");
    expect(f.amount.amount).toBe("2.00"); // 20% × 10.00
    expect(f.chargeClass).toBe("estimated");
    expect(f.counted).toBe(true);
    expect(f.explanation).toContain("Marked as an estimate because part of its base is estimated");
    // everything is an estimate: definite 0.00, estimated 10.00 + 2.00 = 12.00
    expect(totals(noDivisor)).toEqual({ definite: "0.00", estimated: "12.00", expected: "12.00", conditionalExposure: "0.00" });
    expect(warningCodes(noDivisor)).toEqual(["dim_divisor_missing"]);

    // A counted surcharge whose rule is classed estimated drags the fuel on it into the estimated total.
    const estimatedSurcharge = calc(shipment([ONE_LB]), context({ rules: [rule("est", { chargeClass: "estimated", amount: "5.00" }), fuel("20", { kind: "base_plus_all_surcharges" })] }));
    expect(lineFor(estimatedSurcharge, "est").counted).toBe(true);
    expect(lineFor(estimatedSurcharge, "fuel").amount.amount).toBe("3.00"); // 20% × (10.00 + 5.00)
    expect(lineFor(estimatedSurcharge, "fuel").chargeClass).toBe("estimated");
    // definite = 10.00 base; estimated = 5.00 + 3.00 = 8.00; expected = 18.00
    expect(totals(estimatedSurcharge)).toEqual({ definite: "10.00", estimated: "8.00", expected: "18.00", conditionalExposure: "0.00" });
  });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe("warnings", () => {
  it("unverified_rule_applied is raised once per rule when a counted line uses an unverified rule, and not when the line is uncounted", () => {
    const unverified = rule("unv", { amount: "0.75", verificationStatus: "unverified", sourceReference: "TEST: deliberately unverified" });

    const counted = calc(shipment([ONE_LB, ONE_LB]), context({ rules: [unverified] }));
    expect(linesFor(counted, "unv").map((l) => [l.packageIndex, l.counted, l.rule!.verificationStatus])).toEqual([
      [0, true, "unverified"],
      [1, true, "unverified"],
    ]);
    expect(counted.warnings).toEqual([{ code: "unverified_rule_applied", ruleKey: "unv", message: '"Rule unv" uses a rule that has not been verified (TEST: deliberately unverified); it is counted as an estimate.' }]);
    // 10.00 + 10.00 + 2 × 0.75 = 21.50
    expect(totals(counted).expected).toBe("21.50");

    const included = calc(shipment([ONE_LB]), context({ rules: [unverified], service: { includedSurchargeKeys: ["unv"] } }));
    expect(lineFor(included, "unv").counted).toBe(false);
    expect(warningCodes(included)).toEqual([]);

    const unknown = calc(shipment([ONE_LB]), context({ rules: [{ ...unverified, conditions: [{ type: "longest_side_gt", inches: "29" }] }] }));
    expect(lineFor(unknown, "unv").counted).toBe(false);
    expect(warningCodes(unknown)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

describe("totals", () => {
  it("definite, estimated and conditionalExposure are the sums of the counted (or conditional) rounded lines; expected = definite + estimated", () => {
    const rules = [
      residential({ amount: "0.30" }), // definite, per package
      rule("estflag", { chargeClass: "estimated", amount: "0.70", conditions: [{ type: "flag_present", flag: "est" }] }), // estimated-class, counted where it applies
      rule("ac", { chargeClass: "conditional", amount: "21.00", perPackage: false }), // conditional exposure
      rule("long", { amount: "4.00", conditions: [{ type: "longest_side_gt", inches: "29" }] }), // unknown (no dims): uncounted
      fuel("15", { kind: "base_plus_all_surcharges" }, { perPackage: false }),
    ];
    const r = calc(shipment([ONE_LB, { weight: "2", weightUnit: "lb", flags: ["est"] }], { residential: true }), context({ rules }));

    // Package 0: base 10.00 D + residential 0.30 D; fuel 15% × 10.30 = 1.545 → 1.55 D. "long" 4.00 is an uncounted estimate.
    // Package 1: base 20.00 D + residential 0.30 D + estflag 0.70 E (counted); fuel 15% × 21.00 = 3.15, estimated because its base holds an estimate.
    // Shipment: address correction 21.00 conditional; no counted shipment-level line, so no shipment-level fuel.
    expect(linesFor(r, "fuel").map((l) => [l.packageIndex, l.amount.amount, l.chargeClass])).toEqual([
      [0, "1.55", "definite"],
      [1, "3.15", "estimated"],
    ]);
    // definite = 10.00 + 0.30 + 1.55 + 20.00 + 0.30 = 32.15
    // estimated = 0.70 + 3.15 = 3.85
    // expected = 32.15 + 3.85 = 36.00
    // conditionalExposure = 21.00
    expect(totals(r)).toEqual({ definite: "32.15", estimated: "3.85", expected: "36.00", conditionalExposure: "21.00" });

    // The same identities recomputed from the itemization (exact decimal sums of the rounded line amounts).
    const sum = (pred: (l: ChargeLine) => boolean) => r.lines.filter(pred).reduce((acc, l) => acc.plus(l.amount.amount), new D(0)).toFixed(2);
    expect(sum((l) => l.counted && l.chargeClass === "definite")).toBe(r.totals.definite.amount);
    expect(sum((l) => l.counted && l.chargeClass === "estimated")).toBe(r.totals.estimated.amount);
    expect(sum((l) => l.counted)).toBe(r.totals.expected.amount);
    expect(sum((l) => l.chargeClass === "conditional")).toBe(r.totals.conditionalExposure.amount);
    expect(r.lines.filter((l) => l.chargeClass === "conditional").every((l) => !l.counted)).toBe(true);
    expect(r.lines.every((l) => /^\d+\.\d{2}$/.test(l.amount.amount))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exceptions that do not fit the rule's method
// ---------------------------------------------------------------------------

describe("customer exceptions that cannot change the figure", () => {
  it("a percentage exception on a flat rule is ignored with a warning, and is not claimed as applied", () => {
    const r = calc(shipment([ONE_LB]), context({ rules: [rule("res", { amount: "5.55" })], overrides: [override("res", "add_percent_points", { percent: "2" })] }));
    const line = lineFor(r, "res");
    expect(line.amount.amount).toBe("5.55");
    expect(line.explanation).not.toContain("Customer-specific rate applied");
    expect(r.references.overrides).toEqual([]);
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: "override_not_applicable", ruleKey: "res" }));
  });

  it("an amount exception on a percent rule is ignored; a markup or waiver fits any method", () => {
    const pct = calc(shipment([ONE_LB]), context({ rules: [fuel("20", { kind: "base_rate" })], overrides: [override("fuel", "override_amount", { amount: "1.00" })] }));
    expect(lineFor(pct, "fuel").amount.amount).toBe("2.00"); // 20% × 10.00, the published figure
    expect(pct.warnings.map((w) => w.code)).toContain("override_not_applicable");
    const marked = calc(shipment([ONE_LB]), context({ rules: [fuel("20", { kind: "base_rate" })], overrides: [override("fuel", "markup_percent", { percent: "50" })] }));
    expect(lineFor(marked, "fuel").amount.amount).toBe("3.00"); // 30% × 10.00
    expect(marked.references.overrides).toEqual([expect.objectContaining({ ruleKey: "fuel", mode: "markup_percent" })]);
    expect(marked.warnings.map((w) => w.code)).not.toContain("override_not_applicable");
  });
});
