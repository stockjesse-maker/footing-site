import { D60, type Dec60 } from "./num";
import type { ConfidenceLevel, WilsonBounds } from "./types";

/**
 * Wilson score interval for a proportion k / N at 95 percent (z = 1.96 exactly), closed form:
 *   ((p + z^2 / 2N) +- z * sqrt(p (1 - p) / N + z^2 / 4N^2)) / (1 + z^2 / N)
 * evaluated with 60 significant digits (Decimal sqrt). The lower bound is clamped at 0 and the upper at 1.
 * The interval reflects INCIDENCE uncertainty only (severity uncertainty is not included).
 */
export const WILSON_Z = "1.96";

export interface WilsonFraction {
  lower: Dec60;
  upper: Dec60;
}

/** Exact bounds as fractions in [0, 1]. null unless N >= 1 and 0 <= k <= N (both integers). */
export function wilsonFraction(k: number, N: number): WilsonFraction | null {
  if (!Number.isInteger(k) || !Number.isInteger(N) || N < 1 || k < 0 || k > N) return null;
  const n = new D60(N);
  const p = new D60(k).div(n);
  const z = new D60(WILSON_Z);
  const z2 = z.times(z);
  const denominator = new D60(1).plus(z2.div(n));
  const centre = p.plus(z2.div(n.times(2)));
  const radius = z.times(p.times(new D60(1).minus(p)).div(n).plus(z2.div(n.times(n).times(4))).sqrt());
  const lower = D60.max(new D60(0), centre.minus(radius).div(denominator));
  const upper = D60.min(new D60(1), centre.plus(radius).div(denominator));
  return { lower, upper };
}

/** A fraction as a percent string, rounded HALF_UP once. */
export function pctString(fraction: Dec60, dp: number): string {
  return fraction.times(100).toDecimalPlaces(dp, D60.ROUND_HALF_UP).toFixed(dp);
}

/** k / N as a percent, HALF_UP at `dp` decimals ("0.0313" for 1 of 3200). */
export function incidencePct(k: number, N: number, dp = 4): string {
  return new D60(k).times(100).div(N).toDecimalPlaces(dp, D60.ROUND_HALF_UP).toFixed(dp); // multiply first, divide once
}

/** Wilson bounds as percents at 4 and 10 decimals (null when the inputs are not a valid k, N). */
export function wilsonBounds(k: number, N: number): WilsonBounds | null {
  const f = wilsonFraction(k, N);
  if (!f) return null;
  return { lowerPct4dp: pctString(f.lower, 4), upperPct4dp: pctString(f.upper, 4), lowerPct10dp: pctString(f.lower, 10), upperPct10dp: pctString(f.upper, 10) };
}

/**
 * Confidence in a history-derived incidence by the relative half-width of its Wilson interval,
 * (upper - lower) / 2 / (k / N): none when k = 0; low above 50 percent; moderate above 25 up to 50; adequate at 25 or less.
 */
export function incidenceConfidence(k: number, N: number): ConfidenceLevel {
  const f = wilsonFraction(k, N);
  if (!f || k === 0) return "none";
  const relative = f.upper.minus(f.lower).div(2).div(new D60(k).div(new D60(N)));
  if (relative.greaterThan("0.5")) return "low";
  if (relative.greaterThan("0.25")) return "moderate";
  return "adequate";
}
