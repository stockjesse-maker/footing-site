import { D, D60, wholeE4, type Dec60 } from "./num";
import { incidenceConfidence, incidencePct, pctString, wilsonFraction } from "./wilson";
import {
  ADJUSTMENT_ENGINE_VERSION,
  HANDLINGS,
  type ConfidenceLevel,
  type E4,
  type ForecastBasis,
  type Handling,
  type HandlingBuckets,
  type RiskComponent,
  type RiskForecast,
  type RiskInputs,
  type RiskRange,
  type RiskRefusalCode,
  type RiskRefused,
  type RiskSeverityInput,
} from "./types";

/**
 * Risk forecast (design v2 section 3.3): what could adjustments add each month, given how often they happen
 * (incidence) and how much each one moves (severity)? An estimate from numbers the user supplied, never a
 * forecast of the customer's invoice and never added to a shipping or all-in figure.
 *
 * Arithmetic is exact. Per component: amount = V x p x severity, where V x p = V x k / N exactly for a history
 * incidence (or V x pct / 100 as typed), so the rounded 4-dp percent is display only. Each reported E4 figure is
 * rounded ONCE, HALF_UP. The total is the sum of the rounded components; per shipment, per 1,000 shipments and
 * annual figures come from the EXACT unrounded sum (annual = exact monthly x 12, never a rounded monthly x 12).
 *
 * Truth table (basis x handling), per component:
 *   - separate fee: never in a forecast, so always counted here, bucketed by handling.
 *   - postage under `declared_weights`: counted here, bucketed by handling.
 *   - postage under `actual_weights`: already inside the user's forecast, so NOT counted here; when its handling
 *     is absorbed or manual_approval the amount is reported as a staff memo with a warning.
 * The four buckets (customer pays, decided case by case, not billed to the customer, not decided) always sum to the
 * counted total in E4 (asserted). Credits never enter exposure; an optional memo shows them separately.
 */

export const MAX_MONTHLY_VOLUME = 5_000_000;

const DECIMAL = /^-?\d+(\.\d+)?$/;
const refused = (code: RiskRefusalCode, message: string): RiskRefused => ({ engineVersion: ADJUSTMENT_ENGINE_VERSION, status: "refused", code, message });
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const RANK: Record<ConfidenceLevel, number> = { none: 0, low: 1, moderate: 2, adequate: 3 };

function severityProblem(s: RiskSeverityInput | undefined): RiskRefused | null {
  if (!s || (s.source !== "entered" && s.source !== "history" && s.source !== "example")) return refused("severity_invalid", "Each severity needs a source (entered, history or example).");
  if (s.e4 !== null && s.e4 !== undefined) {
    if (!isInt(s.e4)) return refused("severity_invalid", "A severity must be a whole number of ten-thousandths of a dollar.");
    if (s.e4 < 0) return refused("severity_negative", "A severity cannot be negative: credits are never an exposure input.");
  }
  if (s.n !== undefined && s.n !== null && (!isInt(s.n) || s.n < 0)) return refused("severity_invalid", "The number of records behind a severity must be a whole number, zero or more.");
  return null;
}

function addToBucket(b: HandlingBuckets, handling: Handling, e4: E4): void {
  if (handling === "pass_through") b.customerPays += e4;
  else if (handling === "manual_approval") b.decidedCaseByCase += e4;
  else if (handling === "absorbed") b.notBilledToCustomer += e4;
  else b.notDecided += e4;
}

const COMPONENTS = ["postage_difference", "separate_fee"] as const;

export function forecastAdjustmentRisk(inputs: RiskInputs): RiskForecast | RiskRefused {
  try {
    return compute(inputs);
  } catch (err) {
    if (err instanceof RangeError) return refused("overflow", "An amount is too large to carry exactly. Check the volume and the severities.");
    throw err;
  }
}

function compute(inputs: RiskInputs): RiskForecast | RiskRefused {
  // 1. Validation (every refusal names a code the screen turns into one sentence).
  if (typeof inputs.monthlyVolume !== "string" || !DECIMAL.test(inputs.monthlyVolume)) return refused("volume_invalid", "The monthly volume must be a number.");
  const V = new D60(inputs.monthlyVolume);
  if (V.lessThan(0)) return refused("volume_negative", "The monthly volume cannot be negative.");
  if (V.greaterThan(MAX_MONTHLY_VOLUME)) return refused("volume_too_large", `The monthly volume is limited to ${MAX_MONTHLY_VOLUME.toLocaleString("en-US")} packages.`);
  const basis: ForecastBasis | null = inputs.basis === "declared_weights" || inputs.basis === "actual_weights" ? inputs.basis : null;
  if (basis === null) return refused("basis_required", "Choose whether your shipping forecast uses declared weights or actual weights. There is no default.");
  for (const c of COMPONENTS) {
    if (!HANDLINGS.includes(inputs.handling?.[c] as Handling)) return refused("handling_invalid", "Each component needs a handling decision (or not decided).");
    const problem = severityProblem(inputs.severity?.[c]);
    if (problem) return problem;
  }

  const inc = inputs.incidence;
  let history: { k: number; N: number } | null = null;
  let entered: { pct: string; value: Dec60 } | null = null;
  if (inc && inc.source === "history") {
    if (!isInt(inc.k) || !isInt(inc.N) || inc.N < 0) return refused("incidence_invalid", "The incidence needs a whole number of affected packages and of packages shipped.");
    if (inc.k < 0) return refused("k_negative", "The number of affected packages cannot be negative.");
    if (inc.k > inc.N) return refused("k_exceeds_n", "More affected packages than packages shipped.");
    history = { k: inc.k, N: inc.N };
  } else if (inc && inc.source === "entered") {
    if (typeof inc.pct !== "string" || !DECIMAL.test(inc.pct)) return refused("p_invalid", "The incidence must be a percentage between 0 and 100.");
    const value = new D60(inc.pct);
    if (value.lessThan(0) || value.greaterThan(100)) return refused("p_out_of_range", "The incidence must be between 0 and 100 percent.");
    entered = { pct: inc.pct, value };
  } else {
    return refused("incidence_invalid", "Choose where the incidence comes from: your history or a percentage you enter.");
  }
  const credits = inputs.credits ?? null;
  if (credits) {
    if (!isInt(credits.k) || credits.k < 0 || !isInt(credits.severityE4) || credits.severityE4 > 0) return refused("credits_invalid", "Credits need a whole number of records and a negative amount each.");
    if (history && history.k + credits.k > history.N) return refused("k_exceeds_n", "More affected packages (charges plus credits) than packages shipped.");
  }

  // 2. Incidence and affected packages. Everything below is exact: each amount is V x m x severity / d for the
  //    incidence m / d (k / N for a history incidence, pct / 100 as typed), multiplied first and divided ONCE, at
  //    60 digits, so a result that is exactly a half (a tie) is never nudged by an earlier rounding.
  const incidenceKnown = entered !== null || (history !== null && history.N > 0);
  let m: Dec60 | null = null;
  let d: Dec60 = new D60(1);
  if (entered) {
    m = entered.value;
    d = new D60(100);
  } else if (history && history.N > 0) {
    m = new D60(history.k);
    d = new D60(history.N);
  }
  const affected: Dec60 | null = m ? V.times(m).div(d) : null;
  const zeroMultiplier = m !== null && (m.isZero() || V.isZero());

  // 3. Components.
  const comps = {} as Record<(typeof COMPONENTS)[number], RiskComponent>;
  /** V x m x severity (the numerator of the exact amount; its denominator is d). */
  const numerator = {} as Record<(typeof COMPONENTS)[number], Dec60 | null>;
  const countedHereOf = (c: (typeof COMPONENTS)[number]) => c === "separate_fee" || basis === "declared_weights";
  for (const c of COMPONENTS) {
    const handling = inputs.handling[c];
    const severityE4 = inputs.severity[c].e4 ?? null;
    numerator[c] = null;
    if (!incidenceKnown || m === null) {
      comps[c] = { handling, severityE4, amountE4: null, state: "not_computed", reason: "incidence_unknown" };
      continue;
    }
    const doneState = countedHereOf(c) ? "computed" : "in_forecast";
    if (zeroMultiplier) {
      comps[c] = { handling, severityE4, amountE4: 0, state: doneState };
      numerator[c] = new D60(0);
      continue;
    }
    if (severityE4 === null) {
      comps[c] = { handling, severityE4, amountE4: null, state: "not_computed", reason: "severity_unknown" };
      continue;
    }
    const num = V.times(m).times(severityE4);
    numerator[c] = num;
    comps[c] = { handling, severityE4, amountE4: wholeE4(num.div(d)), state: doneState };
  }

  // 4. Totals, buckets, memo.
  const counted = COMPONENTS.filter((c) => countedHereOf(c));
  const computedHere = counted.filter((c) => comps[c].state === "computed");
  const countedHereE4: E4 | null = computedHere.length > 0 ? computedHere.reduce((s, c) => s + comps[c].amountE4!, 0) : null;
  if (countedHereE4 !== null && !Number.isSafeInteger(countedHereE4)) throw new RangeError("total too large");
  const sumNumerator: Dec60 | null = computedHere.length > 0 ? computedHere.reduce((s, c) => s.plus(numerator[c]!), new D60(0)) : null;
  const exactSum: Dec60 | null = sumNumerator ? sumNumerator.div(d) : null;

  let buckets: HandlingBuckets | null = null;
  if (countedHereE4 !== null) {
    buckets = { customerPays: 0, decidedCaseByCase: 0, notBilledToCustomer: 0, notDecided: 0 };
    for (const c of computedHere) addToBucket(buckets, comps[c].handling, comps[c].amountE4!);
    const sum = buckets.customerPays + buckets.decidedCaseByCase + buckets.notBilledToCustomer + buckets.notDecided;
    if (sum !== countedHereE4) throw new Error("adjustment risk: the four buckets do not add up to the counted total");
  }

  let memo: RiskForecast["inForecastMemoE4"] = null;
  const warnings: RiskForecast["warnings"] = [];
  if (incidenceKnown) {
    memo = { inForecastNotBilledE4: 0, inForecastDecidedCaseByCaseE4: 0 };
    const p = comps.postage_difference;
    if (basis === "actual_weights" && p.state === "in_forecast" && p.amountE4 !== null) {
      if (p.handling === "absorbed") memo.inForecastNotBilledE4 = p.amountE4;
      else if (p.handling === "manual_approval") memo.inForecastDecidedCaseByCaseE4 = p.amountE4;
      if (p.amountE4 > 0 && (p.handling === "absorbed" || p.handling === "manual_approval")) warnings.push("forecast_includes_unbilled_postage");
    }
  }

  const notComputedHere = counted.some((c) => comps[c].state === "not_computed" && comps[c].reason === "severity_unknown");
  const atLeast = notComputedHere && computedHere.length > 0;
  const soFar = buckets !== null && buckets.notDecided > 0;
  const known = computedHere.map((c) => comps[c].severityE4).filter((s): s is E4 => s !== null);
  const perAffectedE4 = known.length > 0 ? known.reduce((s, v) => s + v, 0) : null;
  // Per shipment, per 1,000 shipments and annual come from the EXACT sum, rounded once (never from a rounded monthly total).
  const perShipmentE4 = sumNumerator !== null && !V.isZero() ? wholeE4(sumNumerator.div(d.times(V))) : null;
  const per1000E4 = sumNumerator !== null && !V.isZero() ? wholeE4(sumNumerator.times(1000).div(d.times(V))) : null;
  const annualE4 = sumNumerator !== null ? wholeE4(sumNumerator.times(12).div(d)) : null;

  // 5. History-derived range (incidence uncertainty only).
  let range: RiskRange | null = null;
  if (history && history.N > 0) {
    const f = wilsonFraction(history.k, history.N)!;
    const low = V.times(f.lower);
    const high = V.times(f.upper);
    const s60 = known.length > 0 ? new D60(known.reduce((s, v) => s + v, 0)) : null;
    range = {
      incidenceLowPct4dp: pctString(f.lower, 4),
      incidenceHighPct4dp: pctString(f.upper, 4),
      lowAffected1dp: low.toDecimalPlaces(1, D60.ROUND_HALF_UP).toFixed(1),
      highAffected1dp: high.toDecimalPlaces(1, D60.ROUND_HALF_UP).toFixed(1),
      lowE4: s60 !== null ? wholeE4(low.times(s60)) : f.lower.isZero() ? 0 : null,
      highE4: s60 !== null ? wholeE4(high.times(s60)) : null,
    };
  }

  // 6. Credits memo (history only; never part of exposure).
  let creditsMemoE4: E4 | null = null;
  let netMemoE4: E4 | null = null;
  if (credits && history && history.N > 0) {
    creditsMemoE4 = wholeE4(V.times(credits.k).times(credits.severityE4).div(history.N));
    netMemoE4 = countedHereE4 === null ? null : countedHereE4 + creditsMemoE4;
  }

  // 7. Confidence per parameter; the weakest rated one is the overall.
  let incidenceLevel: ConfidenceLevel | "entered";
  if (entered) incidenceLevel = "entered";
  else if (history!.N === 0) incidenceLevel = "none";
  else if (history!.k === 0) incidenceLevel = COMPONENTS.some((c) => inputs.severity[c].source === "entered") ? "low" : "none";
  else incidenceLevel = incidenceConfidence(history!.k, history!.N);
  const severityLevel = (s: RiskSeverityInput): ConfidenceLevel | "entered" | "example" => {
    if (s.source === "entered") return "entered";
    if (s.source === "example") return "example";
    const n = s.n ?? 0;
    return n === 0 ? "none" : n < 30 ? "low" : "adequate";
  };
  const levels = { postage_difference: severityLevel(inputs.severity.postage_difference), separate_fee: severityLevel(inputs.severity.separate_fee) };
  const rated = [incidenceLevel, levels.postage_difference, levels.separate_fee].filter((l): l is ConfidenceLevel => l !== "entered" && l !== "example");
  const overall: ConfidenceLevel | "entered" = rated.length === 0 ? "entered" : rated.reduce((w, l) => (RANK[l] < RANK[w] ? l : w));

  return {
    engineVersion: ADJUSTMENT_ENGINE_VERSION,
    status: "ok",
    basis,
    incidence: entered ? { source: "entered", pctAsEntered: entered.pct } : history!.N > 0 ? { source: "history", k: history!.k, N: history!.N, pct4dp: incidencePct(history!.k, history!.N) } : null,
    incidenceReason: incidenceKnown ? null : "no_baseline",
    affected: affected ? { exact: affected.toFixed(), display1dp: affected.toDecimalPlaces(1, D.ROUND_HALF_UP).toFixed(1) } : null,
    components: comps,
    countedHereE4,
    exactCountedHereE4: exactSum ? exactSum.toFixed() : null,
    buckets,
    decidedCaseByCaseRangeE4: buckets ? { lowE4: 0, highE4: buckets.decidedCaseByCase } : null,
    inForecastMemoE4: memo,
    soFar,
    atLeast,
    perAffectedE4,
    perShipmentE4,
    per1000E4,
    annualE4,
    warnings,
    range,
    creditsMemoE4,
    netMemoE4,
    confidence: { incidence: incidenceLevel, postage_difference: levels.postage_difference, separate_fee: levels.separate_fee, overall },
  };
}
