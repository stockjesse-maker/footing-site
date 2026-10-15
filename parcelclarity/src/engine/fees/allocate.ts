import { D, dec, type Dec } from "../money";
import { fromE4 } from "./tiers";
import type { AllocationInput, AllocationResult } from "./types";

/**
 * Turns period totals into monthly and per-order figures (RULES.md section D). Monthly figures
 * come from exact totals and are rounded once; a rounded per-order average is never multiplied
 * by anything. Allocated monthly charges are divided by the customer's real monthly order volume,
 * never by the modeled orders alone.
 */
export function allocate(input: AllocationInput): AllocationResult {
  const cents = (v: Dec) => v.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
  const months = dec(input.months);
  const V = input.monthlyOrders === null ? null : dec(input.monthlyOrders);
  const population = new D(input.populationOrders);
  const modeled = new D(input.modeledOrders);
  const coverage = population.isZero() ? new D(0) : modeled.times(100).div(population);
  const coveragePct = coverage.toDecimalPlaces(1, D.ROUND_HALF_UP).toFixed(1);
  const covered = coverage.gte(80);
  const extrapolated = V !== null && covered && modeled.lt(population);
  const caveats: string[] = [];

  const shipping = fromE4(input.shippingExpectedE4);
  const processing = fromE4(input.processingE4);
  const perOrderShipping = modeled.isZero() ? null : shipping.div(modeled);
  const perOrderProcessing = modeled.isZero() ? null : processing.div(modeled);

  let monthlyShipping: Dec | null = null;
  let monthlyProcessing: Dec | null = null;
  if (V !== null) {
    if (covered && !modeled.isZero()) {
      // (total × V) / modeled: one division at the end, the same operation order the database uses to recompute it.
      monthlyShipping = shipping.times(V).div(modeled);
      monthlyProcessing = processing.times(V).div(modeled);
    } else {
      monthlyShipping = shipping.div(months);
      monthlyProcessing = processing.div(months);
      caveats.push("at_least");
    }
  } else caveats.push("volume_unknown");

  const fixed = fromE4(input.monthlyFixedE4);
  const topUp = input.minimumStatus === "exact" ? fromE4(input.minimumTopUpE4).div(months) : null;
  if (input.minimumStatus === "upper_bound") caveats.push("minimum_upper_bound");
  const total = monthlyShipping !== null && monthlyProcessing !== null ? monthlyShipping.plus(monthlyProcessing).plus(fixed).plus(topUp ?? 0) : null;
  const allocatedPerOrder = V !== null && !V.isZero() ? fixed.plus(topUp ?? 0).div(V) : null;
  const allInPerOrder = V !== null && !V.isZero() && total !== null ? total.div(V) : null;
  if (V !== null) caveats.push("allocated");

  return {
    monthly: {
      shipping: monthlyShipping === null ? null : cents(monthlyShipping),
      processing: monthlyProcessing === null ? null : cents(monthlyProcessing),
      fixed: cents(fixed),
      minimumTopUp: topUp === null ? null : cents(topUp),
      total: total === null ? null : cents(total),
      annual: total === null ? null : cents(total.times(12)),
    },
    perOrder: {
      shipping: perOrderShipping === null ? null : cents(perOrderShipping),
      processing: perOrderProcessing === null ? null : cents(perOrderProcessing),
      allocated: allocatedPerOrder === null ? null : cents(allocatedPerOrder),
      allIn: allInPerOrder === null ? null : cents(allInPerOrder),
    },
    coveragePct,
    extrapolated,
    caveats,
  };
}
