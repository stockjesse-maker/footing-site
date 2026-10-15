import { D, dec, fmt, toLb, type Dec } from "./money";
import type { DimRules, DimensionRounding, PackageInput, PackageWeightResult, WeightRounding } from "./types";

export interface PackageMeasurements {
  actualLb: Dec;
  /** Rounded dimensions sorted descending (longest first), or null when not provided. */
  dimsIn: [Dec, Dec, Dec] | null;
  cubicIn: Dec | null;
  dimLb: Dec | null;
  billableLb: Dec;
  result: PackageWeightResult;
}

export function roundDimension(value: Dec, mode: DimensionRounding): Dec {
  switch (mode) {
    case "none":
      return value;
    case "nearest_whole":
      return value.toDecimalPlaces(0, D.ROUND_HALF_UP);
    case "up_whole":
      return value.toDecimalPlaces(0, D.ROUND_CEIL);
  }
}

export function roundWeightLb(value: Dec, mode: WeightRounding): Dec {
  switch (mode) {
    case "none":
      return value;
    case "up_whole_lb":
      return value.toDecimalPlaces(0, D.ROUND_CEIL);
    case "up_whole_oz":
      // Round up to the next whole ounce, expressed in pounds (1 oz = 1/16 lb).
      return value.times(16).toDecimalPlaces(0, D.ROUND_CEIL).div(16);
  }
}

/**
 * Billable weight for one package under the service's DIM rules.
 * Order of operations (see PRICING_ENGINE.md): convert actual weight → round dimensions → cubic
 * volume → threshold test → DIM weight → compare unrounded candidates → apply minimum → round the
 * winner per the service's weight rounding.
 */
export function measurePackage(pkg: PackageInput, index: number, rules: DimRules): PackageMeasurements {
  const actualLb = toLb(dec(pkg.weight), pkg.weightUnit);
  const hasDims = pkg.length !== undefined && pkg.width !== undefined && pkg.height !== undefined;

  let dimsIn: [Dec, Dec, Dec] | null = null;
  let cubicIn: Dec | null = null;
  if (hasDims) {
    const sorted = [dec(pkg.length!), dec(pkg.width!), dec(pkg.height!)]
      .map((d) => roundDimension(d, rules.dimensionRounding))
      .sort((a, b) => b.comparedTo(a));
    dimsIn = [sorted[0]!, sorted[1]!, sorted[2]!];
    cubicIn = dimsIn[0].times(dimsIn[1]).times(dimsIn[2]);
  }

  let dimLb: Dec | null = null;
  let basis: PackageWeightResult["basis"];
  let explanation: string;

  if (rules.exempt) {
    basis = "exempt";
    explanation = "This service is exempt from dimensional weight; billed on actual weight.";
  } else if (!hasDims) {
    basis = "no_dimensions";
    explanation = "No dimensions were given, so dimensional weight could not be checked; billed on actual weight.";
  } else if (rules.divisor === null) {
    basis = "no_divisor";
    explanation = "The rate card does not state a DIM divisor for this service, so dimensional weight could not be checked; billed on actual weight.";
  } else {
    const divisor = dec(rules.divisor);
    const aboveThreshold = rules.thresholdCubicIn === null || cubicIn!.greaterThan(dec(rules.thresholdCubicIn));
    if (!aboveThreshold) {
      basis = "actual";
      explanation = `Package volume ${fmt(cubicIn!, 2)} cu in does not exceed the ${fmt(dec(rules.thresholdCubicIn!), 0)} cu in DIM threshold; billed on actual weight.`;
    } else {
      dimLb = cubicIn!.div(divisor);
      if (dimLb.greaterThan(actualLb)) {
        basis = "dim";
        explanation = `Dimensional weight ${fmt(dimLb, 3)} lb (${fmt(dimsIn![0], 1)} × ${fmt(dimsIn![1], 1)} × ${fmt(dimsIn![2], 1)} in ÷ ${fmt(divisor, 0)}) exceeds actual weight ${fmt(actualLb, 3)} lb.`;
      } else {
        basis = "actual";
        explanation = `Actual weight ${fmt(actualLb, 3)} lb is at least the dimensional weight ${fmt(dimLb, 3)} lb (÷ ${fmt(divisor, 0)}).`;
      }
    }
  }

  let raw = dimLb && dimLb.greaterThan(actualLb) ? dimLb : actualLb;
  if (rules.minBillableLb !== null) {
    const min = dec(rules.minBillableLb);
    if (raw.lessThan(min)) {
      raw = min;
      basis = "minimum";
      explanation = `${explanation} Raised to the service minimum billable weight of ${fmt(min, 3)} lb.`;
    }
  }
  const billableLb = roundWeightLb(raw, rules.weightRounding);
  if (!billableLb.equals(raw)) {
    explanation = `${explanation} Rounded ${rules.weightRounding === "up_whole_oz" ? "up to the next ounce" : "up to the next pound"}: ${fmt(billableLb, 4)} lb billable.`;
  }

  return {
    actualLb,
    dimsIn,
    cubicIn,
    dimLb,
    billableLb,
    result: {
      packageIndex: index,
      actualLb: fmt(actualLb, 4),
      roundedDimensionsIn: dimsIn ? [fmt(dimsIn[0], 2), fmt(dimsIn[1], 2), fmt(dimsIn[2], 2)] : null,
      cubicIn: cubicIn ? fmt(cubicIn, 2) : null,
      dimLb: dimLb ? fmt(dimLb, 4) : null,
      billableLb: fmt(billableLb, 4),
      basis,
      explanation,
    },
  };
}

/** Length + girth (2 × width + 2 × height) using the sorted rounded dimensions. */
export function lengthPlusGirth(dims: [Dec, Dec, Dec]): Dec {
  return dims[0].plus(dims[1].times(2)).plus(dims[2].times(2));
}
