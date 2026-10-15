import { D, dec, type Dec } from "../money";
import type { E4, FeeTiers } from "./types";

/**
 * Tier arithmetic shared by order-scope and monthly rules (RULES.md A4, B2, E). Bracket i covers
 * (upTo[i-1], upTo[i]]; the last bracket is open-ended. Everything is decimal; callers round once.
 */

/** Amount in dollars (exact decimal) for a quantity under the brackets. */
export function tierAmount(tiers: FeeTiers, quantity: Dec): Dec {
  if (quantity.lte(0)) return new D(0);
  if (tiers.mode === "graduated") {
    let total = new D(0);
    let lower = new D(0);
    for (const bracket of tiers.brackets) {
      const upper = bracket.upTo === null ? quantity : dec(bracket.upTo);
      const inBracket = D.min(quantity, upper).minus(lower);
      if (inBracket.gt(0)) total = total.plus(inBracket.times(dec(bracket.amount)));
      if (bracket.upTo === null || quantity.lte(upper)) break;
      lower = upper;
    }
    return total;
  }
  const bracket = bracketFor(tiers, quantity);
  return tiers.pricing === "flat" ? dec(bracket.amount) : quantity.times(dec(bracket.amount));
}

/** The bracket a quantity falls in (volume mode): the first with quantity ≤ upTo, else the last. */
export function bracketFor(tiers: FeeTiers, quantity: Dec): FeeTiers["brackets"][number] {
  for (const bracket of tiers.brackets) if (bracket.upTo === null || quantity.lte(dec(bracket.upTo))) return bracket;
  return tiers.brackets[tiers.brackets.length - 1]!;
}

/**
 * The effective per-unit rate for a monthly-quantity tier read at the month's quantity (RULES.md E):
 * graduated → graduated(Q) / Q rounded HALF_UP to E4; volume → the rate of Q's bracket. null when Q ≤ 0.
 */
export function resolveMonthlyRate(tiers: FeeTiers, monthlyQuantity: Dec): E4 | null {
  if (monthlyQuantity.lte(0)) return null;
  if (tiers.mode === "graduated") return toE4(tierAmount(tiers, monthlyQuantity).div(monthlyQuantity));
  return toE4(dec(bracketFor(tiers, monthlyQuantity).amount));
}

/** Dollars → integer E4, HALF_UP at the fourth decimal. */
export function toE4(dollars: Dec): E4 {
  return dollars.times(10000).toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber();
}

/** Integer E4 → exact dollars. */
export function fromE4(e4: E4): Dec {
  return new D(e4).div(10000);
}

/** E4 → cents-rounded dollars as a 2-dp string. */
export function e4ToCents(e4: E4): string {
  return fromE4(e4).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
}

/** Rounds an E4 amount to a whole number of cents (a multiple of 100), HALF_UP. */
export function roundE4ToCents(e4: E4): E4 {
  return new D(e4).div(100).toDecimalPlaces(0, D.ROUND_HALF_UP).times(100).toNumber();
}
