import { AdjustmentOverflowError, D, daysBetween, dec, toE4 } from "./num";
import { incidenceConfidence, incidencePct, wilsonBounds } from "./wilson";
import {
  ADJUSTMENT_ENGINE_VERSION,
  type ConfidenceLevel,
  type DirectionGroup,
  type E4,
  type HistoryBaseline,
  type HistoryFilters,
  type HistoryRecord,
  type HistoryRefusalCode,
  type HistoryRefused,
  type HistoryStatistics,
  type SeverityStat,
} from "./types";

/**
 * History statistics (design v2 section 3.2): how often, and how much, did past adjustments move this customer's
 * (or the account's) charges? Pure over the records and typed baselines it is given.
 *
 *  - The cohort key is the SHIP date; an incidence window is by ship date. A baseline is packages shipped in a
 *    window (typed by the 3PL); the unit is the carrier package, never an order.
 *  - Numerator filters: customer, carrier, service, type, cause, window. Denominator filters: customer, carrier,
 *    service, window only. A customer statistic uses only that customer's baselines; a tenant-wide one only
 *    baselines that cover all customers. Scopes are NEVER summed; a numerator and a denominator of different
 *    scope are refused.
 *  - `affected` (k) counts distinct (customer, carrier, package reference); a record without a reference counts
 *    once by itself ("per adjustment record, not per package").
 *  - Credits (postage difference below zero) are a separate group: they never enter exposure.
 *  - Money is integer E4. Null money is UNKNOWN: excluded from a mean (n is reported), never 0.
 *  - Input is checked before it is used: a malformed amount or date, a baseline that cannot be a denominator (not a positive whole
 *    number of packages), a maturity check without today's date and a missing filters object are named refusals, never an
 *    exception or a NaN. Anything the engine cannot add exactly throws `AdjustmentOverflowError` (a RangeError).
 */

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const refused = (code: HistoryRefusalCode, message: string, extra: Partial<HistoryRefused> = {}): HistoryRefused => ({ engineVersion: ADJUSTMENT_ENGINE_VERSION, status: "refused", code, message, ...extra });

/** Distinct package key: (customer, carrier, package reference); a record with no reference is its own key. */
export function affectedKey(r: Pick<HistoryRecord, "id" | "brandId" | "carrierCode" | "packageRef">): string {
  return r.packageRef === null || r.packageRef === undefined ? `id:${r.id}` : `ref:${r.brandId ?? ZERO_UUID}|${r.carrierCode}|${r.packageRef}`;
}

function groupOf(r: HistoryRecord): DirectionGroup {
  if (r.postageDifference === null || r.postageDifference === undefined) return "unknown";
  const d = dec(r.postageDifference);
  return d.greaterThan(0) ? "increase" : d.lessThan(0) ? "decrease" : "zero";
}

const amountE4 = (value: string | null | undefined): E4 | null => (value === null || value === undefined ? null : toE4(dec(value)));

function severity(values: E4[], withExtremes: boolean): SeverityStat {
  const n = values.length;
  if (n === 0) return withExtremes ? { n: 0, sumE4: null, meanE4: null, medianE4: null, p90E4: null, maxE4: null } : { n: 0, sumE4: null, meanE4: null, medianE4: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  if (!Number.isSafeInteger(sum)) throw new AdjustmentOverflowError("a history amount is too large to carry exactly");
  const mean = new D(sum).div(n).toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber();
  const median = n % 2 === 1 ? sorted[(n - 1) / 2]! : new D(sorted[n / 2 - 1]!).plus(sorted[n / 2]!).div(2).toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber();
  const base: SeverityStat = { n, sumE4: sum, meanE4: mean === 0 ? 0 : mean, medianE4: median === 0 ? 0 : median };
  if (!withExtremes) return base;
  // p90 by nearest rank: the ceil(0.9 n)-th smallest value.
  const rank = Math.floor((9 * n + 9) / 10);
  return { ...base, p90E4: sorted[Math.min(n, Math.max(1, rank)) - 1]!, maxE4: sorted[n - 1]! };
}

/** True when the largest amount is strictly more than 25 percent of the summed amounts (one record dominates the mean). */
function dominated(values: E4[]): boolean {
  if (values.length === 0) return false;
  // A loop, never Math.max(...values): spreading an array of ~125,000 numbers into a call overflows the stack, and the account cap is 200,000 records.
  let max = values[0]!;
  let sum = 0;
  for (const v of values) {
    if (v > max) max = v;
    sum += v;
  }
  if (!Number.isSafeInteger(sum)) throw new AdjustmentOverflowError("a history amount is too large to carry exactly");
  return new D(max).greaterThan(new D(sum).times("0.25"));
}

function severityConfidence(n: number): ConfidenceLevel {
  return n === 0 ? "none" : n < 30 ? "low" : "adequate";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

/** A real calendar date in ISO form ("2026-02-30" is not one). */
function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

const moneyText = (value: unknown): boolean => value === null || value === undefined || (typeof value === "string" && DECIMAL_STRING.test(value));

/** The first problem with the records the statistics read (the amounts and the ship date), or null. Never names a value. */
function recordsProblem(records: readonly HistoryRecord[]): string | null {
  for (const r of records) {
    if (r === null || typeof r !== "object") return "A history record is missing.";
    if (!isoDate(r.shipDate)) return "A history record has a ship date that is not a date.";
    if (!moneyText(r.postageDifference) || !moneyText(r.separateFee)) return "A history record has an amount that is not a number.";
  }
  return null;
}

/** The first problem that stops a baseline from being a denominator, or null. */
function baselineProblem(b: HistoryBaseline): string | null {
  if (b === null || typeof b !== "object") return "A baseline is missing.";
  if (!Number.isSafeInteger(b.packagesTotal) || b.packagesTotal <= 0) return "A baseline needs a whole number of packages shipped above zero.";
  if (!isoDate(b.periodStart) || !isoDate(b.periodEnd) || b.periodStart > b.periodEnd) return "A baseline needs a start date that is not after its end date.";
  if (b.labelsMissingWeight !== null && b.labelsMissingWeight !== undefined && (!Number.isSafeInteger(b.labelsMissingWeight) || b.labelsMissingWeight < 0 || b.labelsMissingWeight > b.packagesTotal)) {
    return "A baseline's labels without a weight must be a whole number from zero to the packages shipped.";
  }
  return null;
}

const percent4 = (num: number, den: number): string => new D(num).times(100).div(den).toDecimalPlaces(4, D.ROUND_HALF_UP).toFixed(4);

export function summariseHistory(records: readonly HistoryRecord[], baselines: readonly HistoryBaseline[], filters: HistoryFilters): HistoryStatistics | HistoryRefused {
  // 0. Input shape and values, before anything is read.
  if (filters === null || filters === undefined || typeof filters !== "object" || Array.isArray(filters)) return refused("invalid_filters", "The statistics need filters (a customer, or null for the whole account).");
  if (!Array.isArray(records)) return refused("invalid_records", "The history records are missing.");
  if (!Array.isArray(baselines)) return refused("invalid_baselines", "The baselines are missing.");
  const brandId = filters.brandId ?? null;
  const carrier = filters.carrierCode ?? null;
  const serviceId = filters.serviceId ?? null;
  const window = filters.window ?? null;
  const notes: string[] = ["range_reflects_incidence_uncertainty_only", "credits_never_enter_exposure"];

  if (window !== null && (typeof window !== "object" || !isoDate(window.from) || !isoDate(window.to))) return refused("invalid_filters", "The window needs a start date and an end date.");
  if (window && window.from > window.to) return refused("invalid_filters", "The window ends before it starts.");
  if (filters.baselineIds !== undefined && filters.baselineIds !== null && (!Array.isArray(filters.baselineIds) || filters.baselineIds.some((id) => typeof id !== "string"))) {
    return refused("invalid_filters", "The chosen baselines must be a list of baseline ids.");
  }
  if (filters.maturityDays !== undefined && filters.maturityDays !== null) {
    if (!Number.isSafeInteger(filters.maturityDays) || filters.maturityDays < 0) return refused("invalid_filters", "The days a window needs to mature must be a whole number, zero or more.");
    // A statistic without a clock cannot be called mature: an immature window must never look mature because today was left out.
    if (!isoDate(filters.today)) return refused("invalid_filters", "Checking whether a window has matured needs today's date.");
  }
  const recordProblem = recordsProblem(records);
  if (recordProblem) return refused("invalid_records", recordProblem);

  // 1. Baselines: exactly the ones whose (customer, carrier, service) key equals the numerator's scope.
  let selected: HistoryBaseline[];
  if (filters.baselineIds !== undefined && filters.baselineIds !== null) {
    // An explicit list is exactly these baselines; an explicit EMPTY list is "no baselines", never "choose for me".
    const wanted = new Set(filters.baselineIds);
    selected = baselines.filter((b) => wanted.has(b.id));
    if (selected.length !== wanted.size) return refused("baseline_not_found", "A chosen baseline does not exist.");
    if (selected.some((b) => (b.brandId ?? null) !== brandId || (b.carrierCode ?? null) !== carrier || (b.serviceId ?? null) !== serviceId)) {
      return refused("scope_mismatch", "A baseline for a different customer, carrier or service cannot be the denominator of this statistic.", { ids: selected.filter((b) => (b.brandId ?? null) !== brandId || (b.carrierCode ?? null) !== carrier || (b.serviceId ?? null) !== serviceId).map((b) => b.id) });
    }
  } else {
    selected = baselines.filter((b) => (b.brandId ?? null) === brandId && (b.carrierCode ?? null) === carrier && (b.serviceId ?? null) === serviceId);
  }
  for (const b of selected) {
    const problem = baselineProblem(b);
    if (problem) return refused("invalid_baselines", problem, { ids: [b.id] });
  }
  let outsideWindowCount = 0;
  if (window) {
    const inside = selected.filter((b) => window.from <= b.periodStart && b.periodEnd <= window.to);
    outsideWindowCount = selected.length - inside.length;
    selected = inside;
  }
  selected = [...selected].sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : a.id < b.id ? -1 : 1));
  // Sorted by start, and every period valid (start not after end, checked above): a baseline overlaps an earlier one exactly when it starts on or
  // before the PREVIOUS one ends (a baseline that starts after the previous end also ends after it, so the previous one is always the furthest-reaching).
  let previous: HistoryBaseline | null = null;
  for (const b of selected) {
    if (previous && b.periodStart <= previous.periodEnd) return refused("baselines_overlap", "Two baselines for the same scope cover some of the same days; they cannot be added.", { ids: [previous.id, b.id] });
    previous = b;
  }
  const hasBaseline = selected.length > 0;

  // 2. Numerator candidates: customer, carrier, type, cause.
  let candidates = records.filter(
    (r) =>
      (brandId === null || r.brandId === brandId) &&
      (carrier === null || r.carrierCode === carrier) &&
      (!filters.adjustmentType || r.adjustmentType === filters.adjustmentType) &&
      (!filters.cause || r.cause === filters.cause),
  );
  // Date scope: inside a selected baseline period; with no baseline, inside the window when one is given, else all.
  const inScopeDate = (r: HistoryRecord): boolean => {
    if (hasBaseline) return selected.some((b) => b.periodStart <= r.shipDate && r.shipDate <= b.periodEnd);
    if (window) return window.from <= r.shipDate && r.shipDate <= window.to;
    return true;
  };
  const dated = candidates.filter(inScopeDate);
  // Service filter: disabled (refused) unless every record in scope has a resolved service.
  if (serviceId !== null) {
    const unresolved = dated.filter((r) => r.serviceId === null || r.serviceId === undefined).length;
    if (unresolved > 0) return refused("service_unresolved", "Some adjustment records have no service we could match, so a service filter would be wrong. Match the service names first or remove the filter.", { unresolvedCount: unresolved });
    candidates = candidates.filter((r) => r.serviceId === serviceId);
  }
  const numerator = candidates.filter(inScopeDate);
  const excludedOutsideBaseline = candidates.length - numerator.length;

  const keys = new Set(numerator.map(affectedKey));
  const k = keys.size;
  const perRecordCounting = numerator.some((r) => r.packageRef === null || r.packageRef === undefined);
  const N = selected.reduce((s, b) => s + b.packagesTotal, 0);
  if (!Number.isSafeInteger(N)) return refused("invalid_baselines", "The packages shipped in the chosen baselines are too many to add exactly.");
  if (hasBaseline && k > N) return refused("k_exceeds_n", "More affected packages than packages shipped: check the baseline and the filters.", { k, N });

  // 3. Severity per direction group and parameter.
  const byGroup: Record<DirectionGroup, HistoryRecord[]> = { increase: [], decrease: [], zero: [], unknown: [] };
  for (const r of numerator) byGroup[groupOf(r)].push(r);
  const postageOf = (rs: HistoryRecord[]) => rs.map((r) => amountE4(r.postageDifference)).filter((v): v is E4 => v !== null);
  const feeOf = (rs: HistoryRecord[]) => rs.map((r) => amountE4(r.separateFee)).filter((v): v is E4 => v !== null);
  const block = (g: DirectionGroup) => ({ postage: severity(postageOf(byGroup[g]), g === "increase"), fee: severity(feeOf(byGroup[g]), g === "increase") });
  const sev = { increase: block("increase"), decrease: block("decrease"), zero: block("zero"), unknown: block("unknown") };

  const withPostage = [...byGroup.increase, ...byGroup.decrease, ...byGroup.zero];
  const net = severity(postageOf(withPostage), false);

  // 4. Incidence (exact from k and N), by direction, with Wilson intervals.
  let incidence: HistoryStatistics["incidence"] = null;
  let byDirection: HistoryStatistics["incidenceByDirection"] = null;
  if (hasBaseline) {
    incidence = { k, N, pct4dp: incidencePct(k, N), wilson: wilsonBounds(k, N)! };
    const group = (g: DirectionGroup) => {
      const gk = new Set(byGroup[g].map(affectedKey)).size;
      return { k: gk, pct4dp: incidencePct(gk, N), wilson: wilsonBounds(gk, N)! };
    };
    byDirection = { increase: group("increase"), decrease: group("decrease"), zero: group("zero"), unknown: group("unknown") };
  }

  // 5. Maturity: a window ending within `maturityDays` of today is still collecting adjustments.
  let maturity: HistoryStatistics["maturity"] = null;
  if (filters.maturityDays !== undefined && filters.maturityDays !== null && filters.today) {
    // (Both are validated above: a maturity check without a valid today is refused, never skipped.)
    const windowEnd = window ? window.to : hasBaseline ? selected.reduce((m, b) => (b.periodEnd > m ? b.periodEnd : m), selected[0]!.periodEnd) : null;
    if (windowEnd) {
      const days = daysBetween(windowEnd, filters.today);
      maturity = { windowEnd, daysSinceWindowEnd: days, maturityDays: filters.maturityDays, immature: days < filters.maturityDays };
      if (maturity.immature) notes.push("window_immature_adjustments_still_posting");
    }
  }

  // 6. Missing-weight rates: only when EVERY selected baseline typed them; never inferred from adjustments alone.
  const typedAll = hasBaseline && selected.every((b) => b.labelsMissingWeight !== null && b.labelsMissingWeight !== undefined);
  const labelsMissing = typedAll ? selected.reduce((s, b) => s + (b.labelsMissingWeight ?? 0), 0) : null;
  const wmsKeys = new Set(numerator.filter((r) => r.cause === "wms_no_weight").map(affectedKey)).size;
  const causeFiltered = Boolean(filters.cause);
  const wmsNoWeightAffected = typedAll && !causeFiltered ? wmsKeys : null;
  const missingRatePct = typedAll && N > 0 ? percent4(labelsMissing!, N) : null;
  const correctionRatePct = typedAll && !causeFiltered && labelsMissing! > 0 ? percent4(wmsKeys, labelsMissing!) : null;

  if (perRecordCounting) notes.push("counted_per_adjustment_record_not_per_package");
  if (hasBaseline) notes.push("packages_are_the_unit");

  return {
    engineVersion: ADJUSTMENT_ENGINE_VERSION,
    status: "ok",
    scope: brandId === null ? "tenant" : "brand",
    baseline: {
      present: hasBaseline,
      ids: selected.map((b) => b.id),
      packagesTotal: hasBaseline ? N : null,
      periods: selected.map((b) => ({ start: b.periodStart, end: b.periodEnd })),
      outsideWindowCount,
    },
    excludedOutsideBaseline,
    recordsInScope: numerator.length,
    affected: k,
    perRecordCounting,
    incidence,
    incidenceByDirection: byDirection,
    incidenceReason: hasBaseline ? null : "no_baseline",
    severity: sev,
    chargesOnly: { n: sev.increase.postage.n, meanE4: sev.increase.postage.meanE4 },
    netOfCredits: { n: net.n, sumE4: net.sumE4, meanE4: net.meanE4 },
    topRecordOver25Pct: { postage: dominated(postageOf(byGroup.increase)), fee: dominated(feeOf(byGroup.increase)) },
    confidence: {
      incidence: hasBaseline ? incidenceConfidence(k, N) : "none",
      postage: severityConfidence(sev.increase.postage.n),
      fee: severityConfidence(sev.increase.fee.n),
    },
    maturity,
    missingRatePct,
    correctionRatePct,
    labelsMissingWeight: labelsMissing,
    wmsNoWeightAffected,
    notes,
  };
}

