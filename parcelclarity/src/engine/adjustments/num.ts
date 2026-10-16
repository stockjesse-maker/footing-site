import Decimal from "decimal.js";
import { D, dec, type Dec } from "../money";
import { fromE4, toE4 } from "../fees/tiers";
import type { E4 } from "./types";

/**
 * Number helpers for the adjustment engine. Shipping and fee arithmetic reuse the engine's 28-digit decimal class
 * (`D`) and the E4 helpers of the fee engine (`toE4`, `fromE4`). Only the Wilson interval needs more digits
 * (60 significant digits, so its square root is well inside the 10 decimals the goldens compare).
 */
export { D, dec, toE4, fromE4 };
export type { Dec };

/**
 * 60-significant-digit decimal class (HALF_UP): the Wilson interval (Decimal sqrt) and the whole risk forecast, whose
 * amounts are multiplied first and divided once so a result that is exactly a half is never nudged by an earlier rounding.
 */
export const D60 = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -80, toExpPos: 80 });
export type Dec60 = InstanceType<typeof D60>;

/**
 * Raised on purpose when an amount cannot be carried exactly as a safe integer number of ten-thousandths of a dollar.
 * It is a `RangeError` (callers that catch `RangeError` keep working) but a distinct class, so a caller can tell this
 * deliberate refusal from an accidental engine fault such as a call-stack overflow, which is also a `RangeError`.
 */
export class AdjustmentOverflowError extends RangeError {
  constructor(message = "an adjustment amount is too large to carry exactly") {
    super(message);
    this.name = "AdjustmentOverflowError";
  }
}

/**
 * An exact E4 amount (possibly fractional) rounded ONCE, HALF_UP, to a whole number of ten-thousandths. Throws an
 * `AdjustmentOverflowError` (a RangeError) when the figure is not a safe integer, exactly as the forecast engine's
 * `wholeE4` does (that helper is private to its module, so the rule is restated here rather than imported).
 */
export function wholeE4(x: Decimal): E4 {
  const n = x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(n)) throw new AdjustmentOverflowError();
  return n === 0 ? 0 : n; // never -0
}

/** A dollars-and-cents string for an E4 figure (cents are the display of E4, rounded once HALF_UP). */
export function e4Cents(e4: E4): string {
  return fromE4(e4).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
}

/** Whole days from `from` to `to` (ISO dates; negative when `to` is earlier). Pure calendar arithmetic, no clock. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

