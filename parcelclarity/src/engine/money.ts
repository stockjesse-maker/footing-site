import Decimal from "decimal.js";
import type { CurrencyCode, DecimalString, Money, WeightUnit } from "./types";

/**
 * Decimal arithmetic for the engine. One configured Decimal class keeps every calculation
 * deterministic: 28 significant digits, HALF_UP rounding where rounding is explicit.
 */
export const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -20, toExpPos: 40 });
export type Dec = InstanceType<typeof D>;

const DECIMAL_RE = /^-?(\d+)(\.\d+)?$/;

/** Parses a decimal string strictly (no exponents, no whitespace, no thousands separators). */
export function dec(value: DecimalString | number): Dec {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
    return new D(value);
  }
  if (!DECIMAL_RE.test(value)) throw new RangeError(`not a decimal string: "${value}"`);
  return new D(value);
}

export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === "string" && DECIMAL_RE.test(value);
}

/** Money is rounded HALF_UP to cents exactly once, when a line is created. */
export function toMoney(value: Dec, currency: CurrencyCode = "USD"): Money {
  return { amount: value.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2), currency };
}

export function moneyDec(m: Money): Dec {
  return new D(m.amount);
}

export function zeroMoney(currency: CurrencyCode = "USD"): Money {
  return { amount: "0.00", currency };
}

export function sumMoney(items: Money[], currency: CurrencyCode = "USD"): Money {
  let total = new D(0);
  for (const m of items) {
    if (m.currency !== currency) throw new RangeError(`currency mismatch: ${m.currency} vs ${currency}`);
    total = total.plus(m.amount);
  }
  return { amount: total.toFixed(2), currency };
}

export function toLb(weight: Dec, unit: WeightUnit): Dec {
  return unit === "oz" ? weight.div(16) : weight;
}

export function fromLb(weightLb: Dec, unit: WeightUnit): Dec {
  return unit === "oz" ? weightLb.times(16) : weightLb;
}

/**
 * Weight for display/result fields: exact when it terminates within 12 decimals, otherwise rounded
 * UP at the 12th decimal so the reported weight never falls below the exact value (and so never
 * outside the bracket that was priced, whose minimum is exclusive).
 */
export function fmtWeight(value: Dec): DecimalString {
  const s = value.toDecimalPlaces(12, D.ROUND_UP).toFixed(12).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  return s.includes(".") ? s : `${s}.0`;
}

/** Fixed-point string with trailing zeros trimmed but at least one decimal digit kept: "12.5", "3.0". */
export function fmt(value: Dec, maxDp = 6): DecimalString {
  const s = value.toDecimalPlaces(maxDp, D.ROUND_HALF_UP).toFixed(maxDp).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  return s.includes(".") ? s : `${s}.0`;
}
