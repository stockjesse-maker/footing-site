import { describe, expect, it } from "vitest";
import { D, dec, fmt, fromLb, isDecimalString, moneyDec, sumMoney, toLb, toMoney, zeroMoney } from "@/engine/money";
import { calculationBaseSchema, isValidShipment, packageSchema, ruleConditionSchema, shipmentSchema, validateShipment, zipSchema } from "@/engine/validate";
import type { CalculationBase, CurrencyCode, Money, RuleCondition, ShipmentInput } from "@/engine/types";
import { loadFixtureRules } from "../fixtures/pricing/load";

/**
 * money.ts and validate.ts (docs-m2-design.md §1 preamble and §1.1): decimal strings in, money
 * rounded HALF_UP to cents exactly once when a line is created, totals as sums of rounded lines,
 * strict input validation. Every expected value is derived by hand in a comment next to the
 * assertion; nothing here was copied from engine output. Fixture data is FICTIONAL.
 */

const money = (amount: string, currency: CurrencyCode = "USD"): Money => ({ amount, currency });

const validShipment: ShipmentInput = {
  shipDate: "2026-10-15",
  originZip: "90001",
  destinationZip: "85001",
  residential: true,
  carrierCode: "ups",
  serviceCode: "ground",
  packages: [{ weight: "3", weightUnit: "lb" }],
};

// ---------------------------------------------------------------------------
// D: the configured Decimal class
// ---------------------------------------------------------------------------

describe("D (the engine's configured Decimal class)", () => {
  it("keeps 28 significant digits and rounds HALF_UP by default", () => {
    expect(D.precision).toBe(28);
    expect(D.rounding).toBe(D.ROUND_HALF_UP);
    // 1/3 = 0.333… kept to 28 significant digits: 28 threes.
    expect(new D(1).div(3).toString()).toBe(`0.${"3".repeat(28)}`);
    // 2/3 = 0.666…; the 29th digit (a 6) rounds the 28th up: 27 sixes then a 7.
    expect(new D(2).div(3).toString()).toBe(`0.${"6".repeat(27)}7`);
    // HALF_UP, not banker's rounding: 2.5 → 3 (HALF_EVEN would give 2) and 3.5 → 4.
    expect(new D("2.5").toDecimalPlaces(0).toString()).toBe("3");
    expect(new D("3.5").toDecimalPlaces(0).toString()).toBe("4");
  });
});

// ---------------------------------------------------------------------------
// dec()
// ---------------------------------------------------------------------------

describe("dec()", () => {
  it("accepts plain decimal strings, including negatives and leading zeros", () => {
    expect(dec("0").isZero()).toBe(true);
    expect(dec("12").toString()).toBe("12");
    expect(dec("12.50").toString()).toBe("12.5");
    expect(dec("-3.25").toString()).toBe("-3.25");
    expect(dec("007").toString()).toBe("7");
    expect(dec("0.000").isZero()).toBe(true);
    expect(dec("-0").isZero()).toBe(true);
    // 24 integer digits + 4 decimals = 28 significant digits: all survive.
    expect(dec("123456789012345678901234.5678").toFixed(4)).toBe("123456789012345678901234.5678");
  });

  it("rejects exponent notation", () => {
    for (const s of ["1e5", "1E5", "2.5e-3", "1e+2", "e5"]) {
      expect(() => dec(s), s).toThrow(RangeError);
      expect(() => dec(s), s).toThrow(/not a decimal string/);
    }
  });

  it("rejects whitespace and thousands separators", () => {
    for (const s of [" 1", "1 ", " 1 ", "\t1", "1\n", "1 000", "1,000", "1_000", "1'000"]) {
      expect(() => dec(s), JSON.stringify(s)).toThrow(RangeError);
    }
  });

  it("rejects NaN, Infinity and malformed strings", () => {
    for (const s of ["NaN", "Infinity", "-Infinity", "", "-", ".", ".5", "5.", "+5", "--5", "0x10", "abc", "1.2.3", "½", "１"]) {
      expect(() => dec(s), JSON.stringify(s)).toThrow(RangeError);
    }
  });

  it("accepts finite numbers and rejects NaN and ±Infinity", () => {
    expect(dec(2.5).toString()).toBe("2.5");
    expect(dec(-0.125).toFixed(3)).toBe("-0.125");
    expect(dec(0).isZero()).toBe(true);
    // Numbers are converted from their shortest round-trip representation, so 1.005 stays 1.005
    // rather than becoming the binary value 1.00499999999999989…
    expect(dec(1.005).toFixed(3)).toBe("1.005");
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => dec(n), String(n)).toThrow(RangeError);
      expect(() => dec(n), String(n)).toThrow(/not a finite number/);
    }
  });

  it("isDecimalString mirrors dec()'s acceptance and rejects non-strings", () => {
    for (const s of ["0", "12.5", "-0.5", "007", "100"]) expect(isDecimalString(s), s).toBe(true);
    const rejected: unknown[] = ["1e5", " 1", "1 ", "", ".5", "5.", "NaN", "Infinity", 12.5, 0, null, undefined, {}, ["1"]];
    for (const v of rejected) expect(isDecimalString(v), String(v)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toMoney()
// ---------------------------------------------------------------------------

describe("toMoney()", () => {
  it("rounds HALF_UP at the .005 boundaries", () => {
    const cases: [string, string][] = [
      ["2.49085", "2.49"], // third decimal is 0 → down
      ["0.125", "0.13"], // exactly half a cent → up
      ["1.005", "1.01"], // exactly half a cent → up
      ["2.675", "2.68"],
      ["0.005", "0.01"],
      ["0.0049999", "0.00"], // just under half a cent → down
      ["0.0050001", "0.01"], // just over half a cent → up
      ["1.995", "2.00"], // carries into the units
      ["99.995", "100.00"], // carries into a new digit
      ["0.015", "0.02"],
      ["10.455", "10.46"],
      ["0.004", "0.00"],
    ];
    for (const [input, expected] of cases) expect(toMoney(dec(input)).amount, input).toBe(expected);
  });

  it("rounds the exact decimal, not the binary float", () => {
    // Number.prototype.toFixed rounds the binary value: 1.005 is stored as 1.00499999999999989…
    // and 2.675 as 2.67499999999999982…, so both round DOWN in floating point.
    expect((1.005).toFixed(2)).toBe("1.00");
    expect((2.675).toFixed(2)).toBe("2.67");
    // The engine rounds the decimal the caller wrote: half a cent goes up.
    expect(toMoney(dec("1.005")).amount).toBe("1.01");
    expect(toMoney(dec("2.675")).amount).toBe("2.68");
  });

  it("rounds negative amounts HALF_UP away from zero and never yields -0.00", () => {
    expect(toMoney(dec("-0.125")).amount).toBe("-0.13"); // |−0.125| → 0.13, sign kept
    expect(toMoney(dec("-2.675")).amount).toBe("-2.68");
    expect(toMoney(dec("-0.005")).amount).toBe("-0.01");
    expect(toMoney(dec("-1.994")).amount).toBe("-1.99");
    // −0.004 rounds to zero: a credit of nothing prints as 0.00, not "-0.00".
    expect(toMoney(dec("-0.004")).amount).toBe("0.00");
    expect(toMoney(dec("-0")).amount).toBe("0.00");
  });

  it("pads to two decimals, defaults the currency to USD and keeps large magnitudes exact", () => {
    expect(toMoney(dec("5"))).toEqual({ amount: "5.00", currency: "USD" });
    expect(toMoney(dec("5.1")).amount).toBe("5.10");
    expect(toMoney(dec("0")).amount).toBe("0.00");
    expect(toMoney(dec("12.34")).amount).toBe("12.34"); // already at 2 dp: unchanged
    expect(toMoney(dec("123456789.125")).amount).toBe("123456789.13"); // 25 significant digits in
    // 1e21 + half a cent (25 significant digits): rounds up, stays fixed-point (no exponent).
    expect(toMoney(dec("1000000000000000000000.005")).amount).toBe("1000000000000000000000.01");
    expect(toMoney(dec("5"), "USD").currency).toBe("USD");
  });

  it("rounds once: rounding to cents directly differs from rounding through an intermediate precision", () => {
    // 1.0049 → 1.00 when rounded to cents in one step (the contract: round once, when the line is created).
    expect(toMoney(dec("1.0049")).amount).toBe("1.00");
    // Rounding first to 3 dp (1.0049 → 1.005) and then to cents gives 1.01: the double-rounding hazard.
    expect(toMoney(dec("1.0049").toDecimalPlaces(3)).amount).toBe("1.01");
    // Re-rounding an amount that is already money is a no-op.
    expect(toMoney(moneyDec(toMoney(dec("1.0049")))).amount).toBe("1.00");
  });

  it("zeroMoney() is 0.00 USD and moneyDec() reads an amount back exactly", () => {
    expect(zeroMoney()).toEqual({ amount: "0.00", currency: "USD" });
    expect(zeroMoney("USD").currency).toBe("USD");
    expect(moneyDec(money("12.30")).equals(dec("12.3"))).toBe(true);
    expect(moneyDec(money("-0.01")).toFixed(2)).toBe("-0.01");
    expect(moneyDec(toMoney(dec("7.125"))).toFixed(2)).toBe("7.13"); // 7.125 → 7.13
  });
});

// ---------------------------------------------------------------------------
// sumMoney()
// ---------------------------------------------------------------------------

describe("sumMoney()", () => {
  it("sums 0.10 ten times to exactly 1.00 (no float drift)", () => {
    const lines = Array.from({ length: 10 }, () => money("0.10"));
    expect(sumMoney(lines)).toEqual({ amount: "1.00", currency: "USD" });
    // The same sum in IEEE-754 doubles is 0.9999999999999999.
    const floatSum = Array.from({ length: 10 }, () => 0.1).reduce((a, b) => a + b, 0);
    expect(floatSum).not.toBe(1);
  });

  it("is exact over thousands of lines", () => {
    // 1000 × 0.01 = 10.00
    expect(sumMoney(Array.from({ length: 1000 }, () => money("0.01"))).amount).toBe("10.00");
    // 300 × 0.07 = 21.00
    expect(sumMoney(Array.from({ length: 300 }, () => money("0.07"))).amount).toBe("21.00");
    // 10000 × 0.03 = 300.00
    expect(sumMoney(Array.from({ length: 10000 }, () => money("0.03"))).amount).toBe("300.00");
    // 1 + 2 + … + 200 cents = 200 × 201 / 2 = 20100 cents = 201.00
    const cents = Array.from({ length: 200 }, (_, i) => i + 1).map((c) => money(`${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`));
    expect(cents[0]!.amount).toBe("0.01");
    expect(cents[199]!.amount).toBe("2.00");
    expect(sumMoney(cents).amount).toBe("201.00");
  });

  it("handles negative lines, mixed magnitudes and an empty list exactly", () => {
    // 1234567.89 − 0.01 = 1234567.88; + 0.12 = 1234568.00; + 1000000.00 = 2234568.00; + 0.00
    expect(sumMoney([money("1234567.89"), money("-0.01"), money("0.12"), money("1000000.00"), money("0.00")]).amount).toBe("2234568.00");
    // 5.00 − 2.50 − 2.50 = 0.00
    expect(sumMoney([money("5.00"), money("-2.50"), money("-2.50")]).amount).toBe("0.00");
    // −0.01 − 0.02 = −0.03
    expect(sumMoney([money("-0.01"), money("-0.02")]).amount).toBe("-0.03");
    // Nothing to add: zero in the requested currency.
    expect(sumMoney([])).toEqual({ amount: "0.00", currency: "USD" });
    expect(sumMoney([], "USD").currency).toBe("USD");
  });

  it("throws RangeError on a currency mismatch instead of mixing currencies", () => {
    const eur = { amount: "1.00", currency: "EUR" as unknown as CurrencyCode };
    expect(() => sumMoney([eur])).toThrow(RangeError);
    expect(() => sumMoney([eur])).toThrow("currency mismatch: EUR vs USD");
    // The explicit target currency is checked too.
    expect(() => sumMoney([money("1.00")], "EUR" as unknown as CurrencyCode)).toThrow("currency mismatch: USD vs EUR");
    // A mismatch after valid items still throws; nothing is silently skipped.
    expect(() => sumMoney([money("1.00"), money("2.00"), eur])).toThrow(RangeError);
    expect(sumMoney([money("1.00"), money("2.00")]).amount).toBe("3.00");
  });

  it("totals are sums of rounded lines, so the itemization always adds up (§1)", () => {
    // 10 ÷ 3 = 3.333… → each line is 3.33; three lines sum to 9.99, not the unrounded 10.00.
    const third = toMoney(dec("10").div(3));
    expect(third.amount).toBe("3.33");
    expect(sumMoney([third, third, third]).amount).toBe("9.99");
    // Had the rounding happened only at the end, (10 ÷ 3) × 3 = 9.999… would have given 10.00.
    expect(toMoney(dec("10").div(3).times(3)).amount).toBe("10.00");
  });
});

// ---------------------------------------------------------------------------
// toLb() / fromLb()
// ---------------------------------------------------------------------------

describe("toLb() and fromLb()", () => {
  it("converts ounces to pounds exactly and passes pounds through", () => {
    const cases: [string, string][] = [
      ["16", "1"], // 16 ÷ 16
      ["8", "0.5"],
      ["1", "0.0625"],
      ["10", "0.625"],
      ["3", "0.1875"],
      ["15.9", "0.99375"], // 15.9 ÷ 16 (check: 0.99375 × 16 = 15.9)
      ["0.1", "0.00625"],
      ["0", "0"],
    ];
    for (const [oz, lb] of cases) expect(toLb(dec(oz), "oz").equals(dec(lb)), `${oz} oz`).toBe(true);
    expect(toLb(dec("2.75"), "lb").equals(dec("2.75"))).toBe(true);
    expect(toLb(dec("0.4"), "lb").toString()).toBe("0.4");
  });

  it("converts pounds to ounces exactly and passes ounces through", () => {
    const cases: [string, string][] = [
      ["1", "16"],
      ["0.0625", "1"],
      ["2.5", "40"], // 2.5 × 16
      ["0.03125", "0.5"], // 1/32 lb × 16
      ["0.99375", "15.9"],
      ["3.4532", "55.2512"], // 3 × 16 = 48; 0.4532 × 16 = 7.2512; total 55.2512
    ];
    for (const [lb, oz] of cases) expect(fromLb(dec(lb), "oz").equals(dec(oz)), `${lb} lb`).toBe(true);
    expect(fromLb(dec("2.75"), "lb").equals(dec("2.75"))).toBe(true);
  });

  it("round-trips exactly because ÷16 always terminates (16 = 2^4)", () => {
    for (const oz of ["0.1", "12.3", "7", "0.03125", "123.4567"]) {
      expect(fromLb(toLb(dec(oz), "oz"), "oz").equals(dec(oz)), `${oz} oz`).toBe(true);
    }
    for (const lb of ["0.3", "4.1234"]) expect(toLb(fromLb(dec(lb), "oz"), "oz").equals(dec(lb)), `${lb} lb`).toBe(true);
    // 1 oz = 0.0625 lb: exactly four decimal places, so nothing is lost.
    expect(toLb(dec("1"), "oz").decimalPlaces()).toBe(4);
    // 123.4567 oz ÷ 16 = 7.71604375 lb (8 decimal places, still exact).
    expect(toLb(dec("123.4567"), "oz").toString()).toBe("7.71604375");
  });
});

// ---------------------------------------------------------------------------
// fmt()
// ---------------------------------------------------------------------------

describe("fmt()", () => {
  it("trims trailing zeros but keeps at least one decimal digit", () => {
    const cases: [string, string][] = [
      ["12.5", "12.5"],
      ["3", "3.0"],
      ["0", "0.0"],
      ["10.40", "10.4"],
      ["100", "100.0"], // integer-part zeros are not trailing decimal zeros
      ["1.230", "1.23"],
      ["1.00001", "1.00001"], // zeros between the point and a nonzero digit stay
      ["12.05", "12.05"],
      ["0.5", "0.5"],
      ["4", "4.0"],
    ];
    for (const [input, expected] of cases) expect(fmt(dec(input)), input).toBe(expected);
  });

  it("rounds HALF_UP at maxDp", () => {
    expect(fmt(dec("3.45323741"), 4)).toBe("3.4532"); // 5th decimal is 3 → down
    expect(fmt(dec("3.45325"), 4)).toBe("3.4533"); // exactly half → up
    expect(fmt(dec("2.5"), 0)).toBe("3.0"); // 0 dp still gets the ".0"
    expect(fmt(dec("2.4"), 0)).toBe("2.0");
    expect(fmt(dec("0.125"), 2)).toBe("0.13");
    expect(fmt(dec("1.23456789"), 2)).toBe("1.23");
    expect(fmt(dec("0.0000005"))).toBe("0.000001"); // default 6 dp: 7th decimal is 5 → up
    expect(fmt(dec("0.0000004"))).toBe("0.0"); // rounds to zero
    expect(fmt(dec("1.0000001"))).toBe("1.0");
    expect(fmt(dec("0.1234565"))).toBe("0.123457");
    expect(fmt(dec("9.9999995"))).toBe("10.0"); // 9.999999|5 → 10.000000 → "10.0"
  });

  it("defaults to 6 dp, never uses exponent notation, and formats negatives", () => {
    expect(fmt(dec("0.000001"))).toBe("0.000001");
    expect(fmt(dec("0.0000001"))).toBe("0.0"); // below 6 dp → 0
    expect(fmt(dec("1000000000000000000000"))).toBe("1000000000000000000000.0"); // 1e21 stays fixed-point
    expect(fmt(dec("0.000001").times(dec("0.000001")))).toBe("0.0"); // 1e-12 → 0 at 6 dp
    expect(fmt(dec("-1.50"))).toBe("-1.5");
    expect(fmt(dec("-3"))).toBe("-3.0");
    expect(fmt(dec("-0.0000004"))).toBe("0.0"); // a negative that rounds to zero: no "-0.0"
    expect(fmt(dec("-0.125"), 2)).toBe("-0.13");
  });

  it("produces strict decimal strings that dec() accepts and that round-trip", () => {
    for (const s of ["12.5", "3", "0", "-1.5", "0.000001", "1234567.891"]) {
      const out = fmt(dec(s));
      expect(isDecimalString(out), s).toBe(true);
      expect(dec(out).equals(dec(s)), s).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// zipSchema
// ---------------------------------------------------------------------------

describe("zipSchema", () => {
  it("accepts 5-digit, ZIP+4 and 9-digit forms and yields the 5-digit ZIP", () => {
    const cases: [string, string][] = [
      ["12345", "12345"],
      ["12345-6789", "12345"],
      ["123456789", "12345"],
      ["12345 6789", "12345"],
      [" 12345 ", "12345"],
      ["\t90001-1234\n", "90001"],
      ["02134", "02134"], // leading zeros are preserved
      ["00501", "00501"],
    ];
    for (const [input, expected] of cases) expect(zipSchema.parse(input), JSON.stringify(input)).toBe(expected);
  });

  it("rejects letters, wrong lengths and non-strings", () => {
    const rejected: unknown[] = ["1234A", "ABCDE", "1234", "123456", "1234567", "12345-678", "12345-67890", "12345-678A", "", "   ", "1234.5", "１２３４５", 12345, null, undefined, ["12345"]];
    for (const v of rejected) expect(zipSchema.safeParse(v).success, JSON.stringify(v)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// packageSchema
// ---------------------------------------------------------------------------

describe("packageSchema", () => {
  it("accepts weight-only and fully dimensioned packages, trimming flags", () => {
    expect(packageSchema.parse({ weight: "3", weightUnit: "lb" })).toEqual({ weight: "3", weightUnit: "lb" });
    const full = {
      weight: "48",
      weightUnit: "oz",
      length: "10",
      width: "8.5",
      height: "6",
      dimensionUnit: "in",
      packageType: "parcel",
      declaredValue: "250.00",
      flags: [" fragile ", "hazmat"],
      reference: "SKU-1",
    };
    expect(packageSchema.parse(full)).toEqual({ ...full, flags: ["fragile", "hazmat"] });
  });

  it("rejects partial dimensions, reporting the problem at `length`", () => {
    for (const dims of [{ length: "10", width: "8" }, { height: "6" }, { length: "10", height: "6" }, { width: "8" }]) {
      const result = packageSchema.safeParse({ weight: "3", weightUnit: "lb", ...dims });
      expect(result.success, JSON.stringify(dims)).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]!.path).toEqual(["length"]);
        expect(result.error.issues[0]!.message).toBe("provide all three dimensions or none");
      }
    }
    expect(packageSchema.safeParse({ weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" }).success).toBe(true);
    // Dimensions must themselves be positive decimal strings.
    expect(packageSchema.safeParse({ weight: "3", weightUnit: "lb", length: "0", width: "8", height: "6" }).success).toBe(false);
    expect(packageSchema.safeParse({ weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6e0" }).success).toBe(false);
  });

  it("requires a strictly positive decimal-string weight and a known unit", () => {
    for (const w of ["0.001", "0.5", "150", "70.0"]) expect(packageSchema.safeParse({ weight: w, weightUnit: "lb" }).success, w).toBe(true);
    const rejected: unknown[] = ["0", "0.00", "-1", "1e3", "1.", ".5", " 1", "1,000", "abc", 5, null, undefined];
    for (const w of rejected) expect(packageSchema.safeParse({ weight: w, weightUnit: "lb" }).success, JSON.stringify(w)).toBe(false);
    const zero = packageSchema.safeParse({ weight: "0", weightUnit: "lb" });
    if (!zero.success) expect(zero.error.issues.map((i) => i.message)).toEqual(["must be greater than zero"]);
    for (const u of ["kg", "g", "LB", "", undefined]) expect(packageSchema.safeParse({ weight: "1", weightUnit: u }).success, String(u)).toBe(false);
    for (const u of ["lb", "oz"]) expect(packageSchema.safeParse({ weight: "1", weightUnit: u }).success, u).toBe(true);
  });

  it("validates the enumerations and the declared value", () => {
    const base = { weight: "1", weightUnit: "lb" };
    expect(packageSchema.safeParse({ ...base, dimensionUnit: "cm" }).success).toBe(false);
    expect(packageSchema.safeParse({ ...base, dimensionUnit: "in" }).success).toBe(true);
    for (const t of ["parcel", "carrier_flat_rate", "envelope", "tube", "pallet"]) expect(packageSchema.safeParse({ ...base, packageType: t }).success, t).toBe(true);
    for (const t of ["box", "PARCEL", ""]) expect(packageSchema.safeParse({ ...base, packageType: t }).success, t).toBe(false);
    // Declared value may be zero (non-negative) but must be a decimal string.
    for (const v of ["0", "100", "250.00"]) expect(packageSchema.safeParse({ ...base, declaredValue: v }).success, v).toBe(true);
    const rejected: unknown[] = ["-5", "1e2", "$100", "", 100];
    for (const v of rejected) expect(packageSchema.safeParse({ ...base, declaredValue: v }).success, JSON.stringify(v)).toBe(false);
  });

  it("bounds flags (≤ 20 of 1–40 characters after trimming) and reference (≤ 120 characters)", () => {
    const base = { weight: "1", weightUnit: "lb" };
    expect(packageSchema.safeParse({ ...base, flags: [] }).success).toBe(true);
    expect(packageSchema.safeParse({ ...base, flags: Array.from({ length: 20 }, (_, i) => `f${i}`) }).success).toBe(true);
    expect(packageSchema.safeParse({ ...base, flags: Array.from({ length: 21 }, (_, i) => `f${i}`) }).success).toBe(false);
    expect(packageSchema.safeParse({ ...base, flags: ["x".repeat(40)] }).success).toBe(true);
    expect(packageSchema.safeParse({ ...base, flags: ["x".repeat(41)] }).success).toBe(false);
    expect(packageSchema.safeParse({ ...base, flags: [""] }).success).toBe(false);
    expect(packageSchema.safeParse({ ...base, flags: ["   "] }).success).toBe(false); // blank after trim
    expect(packageSchema.safeParse({ ...base, flags: "fragile" }).success).toBe(false); // must be an array
    expect(packageSchema.safeParse({ ...base, reference: "x".repeat(120) }).success).toBe(true);
    expect(packageSchema.safeParse({ ...base, reference: "x".repeat(121) }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shipmentSchema / validateShipment()
// ---------------------------------------------------------------------------

describe("shipmentSchema and validateShipment()", () => {
  it("accepts a valid shipment and normalizes ZIPs and the zone", () => {
    const result = validateShipment({
      ...validShipment,
      originZip: "90001-1234",
      destinationZip: "850011234",
      destinationZone: "  5 ",
      destinationCountry: "US",
      options: { signature: "adult", saturdayDelivery: true },
      orderId: "ORD-1",
      shipmentId: "SHP-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.originZip).toBe("90001");
      expect(result.value.destinationZip).toBe("85001");
      expect(result.value.destinationZone).toBe("5");
      expect(result.value.options).toEqual({ signature: "adult", saturdayDelivery: true });
      expect(result.value.packages).toEqual([{ weight: "3", weightUnit: "lb" }]);
      expect(result.value.orderId).toBe("ORD-1");
    }
    expect(shipmentSchema.safeParse(validShipment).success).toBe(true);
  });

  it("requires a destination ZIP or a destination zone", () => {
    const noDestination = { ...validShipment, destinationZip: undefined };
    const result = validateShipment(noDestination);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toEqual(["destinationZip: provide a destination ZIP or a destination zone"]);
    // A zone alone is enough.
    const zoneOnly = validateShipment({ ...noDestination, destinationZone: "8" });
    expect(zoneOnly.ok).toBe(true);
    if (zoneOnly.ok) expect(zoneOnly.value.destinationZip).toBeUndefined();
    // A blank zone is not a zone.
    const blank = validateShipment({ ...noDestination, destinationZone: "   " });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.problems[0]!.startsWith("destinationZone:")).toBe(true);
    // Zones are at most 12 characters.
    expect(validateShipment({ ...noDestination, destinationZone: "x".repeat(13) }).ok).toBe(false);
    expect(validateShipment({ ...noDestination, destinationZone: "x".repeat(12) }).ok).toBe(true);
  });

  it("requires shipDate to be a real YYYY-MM-DD calendar date", () => {
    for (const d of ["2026-10-15", "2024-02-29", "2026-12-31", "2026-01-01"]) expect(validateShipment({ ...validShipment, shipDate: d }).ok, d).toBe(true);
    const leap = validateShipment({ ...validShipment, shipDate: "2026-02-29" }); // 2026 is not a leap year
    expect(leap.ok).toBe(false);
    if (!leap.ok) expect(leap.problems).toEqual(["shipDate: must be a real calendar date"]);
    for (const d of ["2026-02-30", "2026-13-01", "2026-04-31", "2026-00-10", "2026-10-00"]) expect(validateShipment({ ...validShipment, shipDate: d }).ok, d).toBe(false);
    const shape = validateShipment({ ...validShipment, shipDate: "2026-1-5" });
    expect(shape.ok).toBe(false);
    if (!shape.ok) expect(shape.problems[0]).toBe("shipDate: must be a YYYY-MM-DD date");
    const rejected: unknown[] = ["10/15/2026", "2026-10-15T00:00:00Z", "20261015", "", 20261015, undefined];
    for (const d of rejected) expect(validateShipment({ ...validShipment, shipDate: d }).ok, String(d)).toBe(false);
  });

  it("requires between 1 and 200 packages", () => {
    const pkg = { weight: "1", weightUnit: "lb" as const };
    const none = validateShipment({ ...validShipment, packages: [] });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.problems).toContain("packages: at least one package");
    expect(validateShipment({ ...validShipment, packages: Array.from({ length: 200 }, () => pkg) }).ok).toBe(true);
    const many = validateShipment({ ...validShipment, packages: Array.from({ length: 201 }, () => pkg) });
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.problems).toContain("packages: at most 200 packages per shipment");
    expect(validateShipment({ ...validShipment, packages: pkg }).ok).toBe(false); // must be an array
  });

  it("reports at most 8 problems, each prefixed with its dotted path", () => {
    // 10 zero-weight packages → 10 issues, capped at the first 8.
    const result = validateShipment({ ...validShipment, packages: Array.from({ length: 10 }, () => ({ weight: "0", weightUnit: "lb" })) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toHaveLength(8);
      expect(result.problems[0]).toBe("packages.0.weight: must be greater than zero");
      expect(result.problems[7]).toBe("packages.7.weight: must be greater than zero");
    }
  });

  it("enforces field constraints: boolean residential, US only, signature enum, code and id lengths", () => {
    const cases: [Partial<Record<keyof ShipmentInput, unknown>>, string][] = [
      [{ residential: "yes" }, "residential"],
      [{ residential: undefined }, "residential"],
      [{ destinationCountry: "CA" }, "destinationCountry"],
      [{ options: { signature: "any" } }, "options.signature"],
      [{ options: { saturdayDelivery: "no" } }, "options.saturdayDelivery"],
      [{ carrierCode: "" }, "carrierCode"],
      [{ carrierCode: "x".repeat(41) }, "carrierCode"],
      [{ serviceCode: "" }, "serviceCode"],
      [{ orderId: "x".repeat(121) }, "orderId"],
      [{ shipmentId: 42 }, "shipmentId"],
      [{ originZip: "9000" }, "originZip"],
      [{ destinationZip: "8500A" }, "destinationZip"],
    ];
    for (const [patch, path] of cases) {
      const result = validateShipment({ ...validShipment, ...patch });
      expect(result.ok, JSON.stringify(patch)).toBe(false);
      if (!result.ok) expect(result.problems.some((p) => p.startsWith(`${path}:`)), JSON.stringify(patch)).toBe(true);
    }
    expect(validateShipment({ ...validShipment, destinationCountry: "US", carrierCode: "x".repeat(40), orderId: "x".repeat(120), options: {} }).ok).toBe(true);
  });

  it("rejects non-object input with an `input:` problem; isValidShipment() is the boolean form", () => {
    for (const v of [null, undefined, "shipment", 42, []]) {
      const result = validateShipment(v);
      expect(result.ok, String(v)).toBe(false);
      if (!result.ok) {
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]!.startsWith("input: ")).toBe(true);
      }
    }
    expect(isValidShipment(validShipment)).toBe(true);
    expect(isValidShipment({})).toBe(false);
    expect(isValidShipment({ ...validShipment, packages: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ruleConditionSchema
// ---------------------------------------------------------------------------

describe("ruleConditionSchema", () => {
  it("accepts every condition in the fixture rules unchanged", () => {
    const conditions = loadFixtureRules().flatMap((r) => r.conditions);
    // Fixture rules: residential ×2 (residential, peak), destination_zip_in_list ×2 (das, das_extended),
    // longest_side_gt ×2 (additional handling length, USPS nonstandard length), weight_gt,
    // length_plus_girth_gt, signature_in, declared_value_gt, flag_present = 11 conditions.
    expect(conditions).toHaveLength(11);
    expect([...new Set(conditions.map((c) => c.type))].sort()).toEqual([
      "declared_value_gt",
      "destination_zip_in_list",
      "flag_present",
      "length_plus_girth_gt",
      "longest_side_gt",
      "residential",
      "signature_in",
      "weight_gt",
    ]);
    for (const c of conditions) {
      const result = ruleConditionSchema.safeParse(c);
      expect(result.success, JSON.stringify(c)).toBe(true);
      if (result.success) expect(result.data).toEqual(c);
    }
  });

  it("accepts a well-formed example of all 17 condition types", () => {
    const examples: RuleCondition[] = [
      { type: "residential", value: false },
      { type: "weight_gt", valueLb: "50", basis: "actual" },
      { type: "weight_lte", valueLb: "0.5", basis: "billable" },
      { type: "longest_side_gt", inches: "48" },
      { type: "second_longest_side_gt", inches: "30" },
      { type: "length_plus_girth_gt", inches: "130" },
      { type: "cubic_in_gt", value: "1728" },
      { type: "zone_in", zones: ["2", "3", "ZONE 4"] },
      { type: "destination_zip_in_list", listKey: "fixture.ups.das_zips" },
      { type: "destination_zip_prefix_in", prefixes: ["900", "9000", "90001"] },
      { type: "declared_value_gt", amount: "100" },
      { type: "signature_in", values: ["none", "indirect", "direct", "adult"] },
      { type: "saturday_delivery", value: true },
      { type: "package_type_in", types: ["parcel", "carrier_flat_rate", "envelope", "tube", "pallet"] },
      { type: "flag_present", flag: "hazmat" },
      { type: "ship_date_between", from: "2026-11-01", to: "2027-01-15" },
      { type: "package_count_gt", value: 1 },
    ];
    expect(new Set(examples.map((c) => c.type)).size).toBe(17);
    for (const c of examples) {
      const result = ruleConditionSchema.safeParse(c);
      expect(result.success, c.type).toBe(true);
      if (result.success) expect(result.data).toEqual(c);
    }
    // Boundaries of package_count_gt: 0 and 200 are allowed.
    expect(ruleConditionSchema.safeParse({ type: "package_count_gt", value: 0 }).success).toBe(true);
    expect(ruleConditionSchema.safeParse({ type: "package_count_gt", value: 200 }).success).toBe(true);
  });

  it("accepts any_of groups of 1–10 conditions (nesting allowed) and rejects empty, oversized or malformed groups", () => {
    // The 18th variant: an OR group over other conditions (types.ts RuleCondition, validate.ts z.lazy).
    const group: RuleCondition = {
      type: "any_of",
      conditions: [
        { type: "longest_side_gt", inches: "48" },
        { type: "weight_gt", valueLb: "50", basis: "actual" },
      ],
    };
    const single: RuleCondition = { type: "any_of", conditions: [{ type: "residential", value: true }] }; // min 1
    const nested: RuleCondition = { type: "any_of", conditions: [group, { type: "saturday_delivery", value: true }] }; // a group inside a group
    const ten: RuleCondition = { type: "any_of", conditions: Array.from({ length: 10 }, (_, i) => ({ type: "flag_present", flag: `f${i}` })) }; // max 10
    for (const c of [group, single, nested, ten]) {
      const result = ruleConditionSchema.safeParse(c);
      expect(result.success, JSON.stringify(c)).toBe(true);
      if (result.success) expect(result.data).toEqual(c);
    }
    const rejected: unknown[] = [
      { type: "any_of", conditions: [] }, // 0 < min 1
      { type: "any_of", conditions: Array.from({ length: 11 }, (_, i) => ({ type: "flag_present", flag: `f${i}` })) }, // 11 > max 10
      { type: "any_of", conditions: [{ type: "weight_gt", valueLb: "50" }] }, // inner condition missing basis
      { type: "any_of", conditions: [{ type: "any_of", conditions: [] }] }, // empty inner group
      { type: "any_of", conditions: [{ type: "residential", value: true }, "residential"] }, // a non-object member
      { type: "any_of" }, // conditions missing
      { type: "any_of", conditions: { type: "residential", value: true } }, // must be an array
      { type: "all_of", conditions: [{ type: "residential", value: true }] }, // AND is the rule's own list, not a condition type
    ];
    for (const c of rejected) expect(ruleConditionSchema.safeParse(c).success, JSON.stringify(c)).toBe(false);
  });

  it("rejects malformed conditions", () => {
    const rejected: unknown[] = [
      { type: "weight_gt", valueLb: "50" }, // missing basis
      { type: "weight_gt", valueLb: "50", basis: "dim" }, // unknown basis
      { type: "weight_lte", valueLb: "1e1", basis: "actual" }, // exponent
      { type: "weight_lte", valueLb: "-1", basis: "actual" }, // negative
      { type: "longest_side_gt", inches: "-48" },
      { type: "longest_side_gt", inches: 48 }, // number, not a decimal string
      { type: "cubic_in_gt", inches: "1728" }, // wrong key: `value` missing
      { type: "zone_in", zones: [] },
      { type: "zone_in", zones: ["2", "   "] }, // blank zone
      { type: "zone_in", zones: ["x".repeat(13)] }, // 13 > 12 characters
      { type: "destination_zip_in_list", listKey: "Fixture.ups.das_zips" }, // uppercase
      { type: "destination_zip_in_list", listKey: "ups-das" }, // hyphen
      { type: "destination_zip_in_list", listKey: "1ups" }, // starts with a digit
      { type: "destination_zip_in_list", listKey: "u" }, // too short
      { type: "destination_zip_prefix_in", prefixes: ["12"] }, // 2 digits
      { type: "destination_zip_prefix_in", prefixes: ["123456"] }, // 6 digits
      { type: "destination_zip_prefix_in", prefixes: ["90O01"] }, // letter O
      { type: "destination_zip_prefix_in", prefixes: [] },
      { type: "declared_value_gt", amount: "$100" },
      { type: "signature_in", values: [] },
      { type: "signature_in", values: ["any"] },
      { type: "saturday_delivery", value: "yes" },
      { type: "package_type_in", types: ["box"] },
      { type: "package_type_in", types: [] },
      { type: "flag_present", flag: "   " },
      { type: "flag_present", flag: "x".repeat(41) },
      { type: "ship_date_between", from: "2026-02-30", to: "2026-03-01" }, // not a real date
      { type: "ship_date_between", from: "2026-11-01" }, // missing `to`
      { type: "package_count_gt", value: 1.5 },
      { type: "package_count_gt", value: -1 },
      { type: "package_count_gt", value: 201 },
      { type: "package_count_gt", value: "1" },
      { type: "residential", value: "yes" },
      { type: "residential" },
      { type: "weight_between", valueLb: "1" }, // unknown type
      { value: true }, // missing type
      null,
      "residential",
    ];
    for (const c of rejected) expect(ruleConditionSchema.safeParse(c).success, JSON.stringify(c)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calculationBaseSchema
// ---------------------------------------------------------------------------

describe("calculationBaseSchema", () => {
  it("accepts the fixture bases and all three kinds, including every surcharge category", () => {
    const bases = loadFixtureRules().map((r) => r.base);
    // 14 fixture rule versions: 12 use base_rate, the two fuel versions use base_plus_categories.
    expect(bases).toHaveLength(14);
    expect(bases.filter((b) => b.kind === "base_plus_categories")).toHaveLength(2);
    expect(bases.filter((b) => b.kind === "base_rate")).toHaveLength(12);
    for (const b of bases) {
      const result = calculationBaseSchema.safeParse(b);
      expect(result.success, JSON.stringify(b)).toBe(true);
      if (result.success) expect(result.data).toEqual(b);
    }
    const all: CalculationBase = {
      kind: "base_plus_categories",
      categories: [
        "fuel",
        "residential",
        "das",
        "das_extended",
        "remote_area",
        "additional_handling",
        "oversize",
        "peak",
        "address_correction",
        "signature",
        "declared_value",
        "saturday_delivery",
        "reweight",
        "remeasure",
        "shipping_charge_correction",
        "other",
      ],
    };
    expect(all.kind === "base_plus_categories" ? all.categories.length : 0).toBe(16);
    const kinds: CalculationBase[] = [{ kind: "base_rate" }, { kind: "base_plus_all_surcharges" }, all];
    for (const b of kinds) {
      const result = calculationBaseSchema.safeParse(b);
      expect(result.success, b.kind).toBe(true);
      if (result.success) expect(result.data).toEqual(b);
    }
  });

  it("rejects malformed bases", () => {
    const rejected: unknown[] = [
      { kind: "base_plus_categories", categories: [] }, // at least one category
      { kind: "base_plus_categories", categories: ["fuel", "bogus"] },
      { kind: "base_plus_categories", categories: ["base"] }, // "base" is a line category, not a surcharge category
      { kind: "base_plus_categories" }, // categories missing
      { kind: "base_plus_categories", categories: "fuel" }, // must be an array
      { kind: "percent_of_total" }, // unknown kind
      { kind: "BASE_RATE" },
      {},
      null,
      "base_rate",
    ];
    for (const b of rejected) expect(calculationBaseSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });
});
