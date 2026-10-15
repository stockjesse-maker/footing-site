import { FEE_CATEGORIES, allocate, calculateMonthlyFees, describeFeeRule, evaluateMinimums, fromE4 } from "../fees";
import type { AllocationResult, E4, FeeRule, MinimumResult, MonthBucket, MonthlyFeeResult } from "../fees/types";
import { D, dec, type Dec } from "../money";
import { compareKeys } from "../surcharges";
import type { DecimalString } from "../types";
import { PACKAGING_OTHER_KEY, WEIGHT_BRACKET_LABELS } from "./fold";
import type { BulkSummary, CategoryCompleteness, CompletenessState, DatasetCounts, FeeStatus, FeeSummary, FinalizeFeeInput, PartialSummary, SurchargeBucket } from "./types";

/**
 * Turns the running partial into the customer-facing `BulkSummary`. Averages are HALF_UP to cents
 * and null when their denominator is zero (never "0.00", which would read as a free shipment);
 * coverage and shares carry one decimal. Every record becomes a deterministically sorted array so
 * two runs over the same data render identically.
 *
 * Fees (Milestone 4): the processing figures come from the partial; the monthly charges, minimums
 * and allocation are computed here from the customer's answers and the pinned monthly version, with
 * the same arithmetic `finish_simulation_run` repeats in SQL before it trusts the summary.
 */

/**
 * The summary as stored and reconciled: `BulkSummary` plus a top-level `processing` mirror of
 * `fees.processing`, which `finish_simulation_run` reads at `{processing,orders|definite|estimated}`.
 */
export type FinalizedSummary = BulkSummary & { processing: FeeSummary["processing"] };

export function finalizeSummary(partial: PartialSummary, datasetCounts: DatasetCounts, loadIssues: string[], engineVersion: string, fees: FinalizeFeeInput): FinalizedSummary {
  if (partial.version !== 2) throw new RangeError(`partial summary version ${String((partial as { version: unknown }).version)} is not supported; the run must be started again`);
  const modeled = { orders: partial.orders.modeled, shipments: partial.shipments.modeled, packages: partial.packages.modeled };
  const expected = dec(partial.totals.expected);
  // Share of the modeled expected cost: the one basis every breakdown has, whether it is counted in orders, shipments or packages.
  const share = (amount: DecimalString) => pct(dec(amount), expected);
  const imported = { ...datasetCounts };
  // Orders the fold never saw have no shipments at all (nothing to ship, e.g. gift cards): they stay in
  // the imported count and are listed as excluded, so modeled + excluded always reconciles to imported.
  const exclusions: Record<string, { orders: number; shipments: number }> = { ...partial.exclusions };
  const unseen = imported.orders - partial.orders.seen;
  if (unseen > 0) exclusions.nothing_to_ship = { orders: (exclusions.nothing_to_ship?.orders ?? 0) + unseen, shipments: exclusions.nothing_to_ship?.shipments ?? 0 };

  const feeSections = finalizeFees(partial, fees);
  return {
    version: 2,
    engineVersion,
    feeEngineVersion: fees.feeEngineVersion,
    imported,
    modeled,
    coverage: { ordersPct: pct(dec(modeled.orders), dec(imported.orders)), shipmentsPct: pct(dec(modeled.shipments), dec(imported.shipments)) },
    totals: { ...partial.totals },
    averages: {
      expectedPerOrder: average(partial.totals.expected, modeled.orders),
      expectedPerShipment: average(partial.totals.expected, modeled.shipments),
      expectedPerPackage: average(partial.totals.expected, modeled.packages),
      definitePerOrder: average(partial.totals.definite, modeled.orders),
    },
    exposure: {
      conditional: { amount: partial.totals.conditionalExposure, shipments: partial.exposureShipments.conditional },
      unresolved: { amount: partial.totals.unresolved, shipments: partial.exposureShipments.unresolved, by: structuredClone(partial.unresolvedBy) },
    },
    pricedButExcluded: { ...partial.pricedButExcluded },
    exclusions: Object.entries(exclusions)
      .map(([reason, e]) => ({ reason, orders: e.orders, shipments: e.shipments, ordersPct: pct(dec(e.orders), dec(imported.orders)) }))
      .sort((a, b) => b.orders - a.orders || compareKeys(a.reason, b.reason)),
    byZone: Object.entries(partial.byZone)
      .map(([zone, b]) => ({ ...b, zone, sharePct: share(b.expected) }))
      .sort((a, b) => compareKeys(a.zone, b.zone)),
    byService: Object.values(partial.byService)
      .map((b) => ({ ...b, sharePct: share(b.expected) }))
      .sort((a, b) => dec(b.expected).comparedTo(dec(a.expected)) || compareKeys(a.name, b.name) || compareKeys(a.serviceId, b.serviceId)),
    byMonth: Object.entries(partial.byMonth)
      .map(([month, b]) => ({ ...b, month, sharePct: share(b.expected) }))
      .sort((a, b) => Number(a.month === "unknown") - Number(b.month === "unknown") || compareKeys(a.month, b.month)),
    byWeightBracket: Object.entries(partial.byWeightBracket)
      .map(([bracket, b]) => ({ ...b, bracket, sharePct: share(b.expected) }))
      .sort((a, b) => bracketIndex(a.bracket) - bracketIndex(b.bracket)),
    shipmentLevel: { ...partial.shipmentLevel },
    bySurcharge: Object.values(partial.bySurcharge)
      .map((b) => structuredClone(b))
      .sort((a, b) => chargedTotal(b).comparedTo(chargedTotal(a)) || compareKeys(a.key, b.key)),
    warnings: Object.entries(partial.warnings)
      .map(([stored, w]) => ({ ...splitWarningCode(stored), shipments: w.shipments }))
      .sort((a, b) => b.shipments - a.shipments || compareKeys(a.code, b.code) || compareKeys(a.ruleKey ?? "", b.ruleKey ?? "")),
    loadIssues: [...new Set([...partial.loadIssues, ...loadIssues])].sort(compareKeys),
    assumptions: { ...partial.assumptions },
    dictionary: partial.dictionary.map((e) => ({ ...e })),
    // --- Milestone 4 ---
    feeDictionary: partial.feeDictionary.map((e) => ({ ...e })),
    fees: feeSections.fees,
    processing: feeSections.fees.processing,
    monthly: feeSections.monthly,
    minimums: feeSections.minimums,
    minimumStatus: feeSections.minimumStatus,
    period: { ...fees.period, monthProfile: fees.period.monthProfile.map((m) => ({ ...m })) },
    allocation: feeSections.allocation,
    provenance: fees.provenance ? { scheduleName: fees.provenance.scheduleName, versions: fees.provenance.versions.map((v) => ({ ...v })) } : null,
  };
}

// ---------------------------------------------------------------------------
// Fees, monthly charges, minimums and allocation
// ---------------------------------------------------------------------------

interface FeeSections {
  fees: FeeSummary;
  monthly: MonthlyFeeResult | null;
  minimums: MinimumResult[];
  minimumStatus: BulkSummary["minimumStatus"];
  allocation: AllocationResult | null;
}

function finalizeFees(partial: PartialSummary, input: FinalizeFeeInput): FeeSections {
  const p = partial.fees;
  const period = input.period;
  const processingE4 = p.processing.definiteE4 + p.processing.estimatedE4;
  const processing: FeeSummary["processing"] = {
    orders: p.processing.orders,
    definiteE4: p.processing.definiteE4,
    estimatedE4: p.processing.estimatedE4,
    definite: dollars4(p.processing.definiteE4),
    estimated: dollars4(p.processing.estimatedE4),
    expected: dollars4(processingE4),
    perOrder: p.processing.orders === 0 ? null : cents(fromE4(processingE4).div(p.processing.orders)),
  };
  const byRule: FeeSummary["byRule"] = Object.entries(p.byRule)
    .map(([key, b]) => ({ ...structuredClone(b), key, definite: dollars4(b.definiteE4), estimated: dollars4(b.estimatedE4) }))
    .sort((a, b) => b.definiteE4 + b.estimatedE4 - (a.definiteE4 + a.estimatedE4) || compareKeys(a.key, b.key));

  const modeled = input.mode === "modeled";
  const schedule = input.monthlySchedule;
  const monthly = modeled && schedule ? calculateMonthlyFees(input.answers, schedule, period.monthlyOrders === null ? null : dec(period.monthlyOrders)) : null;

  // Month buckets: the period's calendar months (from the run row) joined with the processing orders dated in them.
  const buckets: MonthBucket[] = period.monthProfile.map((m) => {
    const folded = p.byMonth[m.month];
    return {
      month: m.month,
      fraction: m.fraction,
      orderVariableByRuleE4: { ...(folded?.byRuleE4 ?? {}) },
      modeledOrders: folded?.orders ?? 0,
      shippedOrders: m.orders,
      shippingExpectedE4: folded?.shippingExpectedE4 ?? 0,
      unresolvedRuleKeys: [...(folded?.unresolvedRuleKeys ?? [])],
    };
  });
  let minimums = monthly && schedule ? evaluateMinimums(buckets, schedule, monthly) : [];
  // The SQL recomputation reads every stored order result: a rule left unresolved on a processing order dated
  // outside the period's months (a trimmed outlier) or without a date makes the minimum an upper bound there too.
  const profileMonths = new Set(period.monthProfile.map((m) => m.month));
  const unresolvedElsewhere = new Set(
    Object.entries(p.byMonth)
      .filter(([month]) => !profileMonths.has(month))
      .flatMap(([, b]) => b.unresolvedRuleKeys),
  );
  const undated = p.byMonth.unknown?.orders ?? 0;
  minimums = minimums.map((m) => {
    if (m.status === "not_computed") return m;
    const reasons = [...m.reasons];
    const members = m.members.map((member) => {
      if (member.state !== "priced" || !unresolvedElsewhere.has(member.ruleKey)) return member;
      reasons.push(`${member.name} not modeled`);
      return { ...member, state: "not_modeled" as const };
    });
    if (undated > 0) reasons.push(`${undated} order${undated === 1 ? "" : "s"} without a date`);
    const unique = [...new Set(reasons)];
    return { ...m, members, reasons: unique, status: unique.length ? "upper_bound" : "exact" };
  });
  const hasMinimumRule = !!schedule?.rules.some((r) => r.basis === "minimum");
  const minimumStatus: BulkSummary["minimumStatus"] =
    monthly === null || !hasMinimumRule ? "none" : minimums.some((m) => m.status === "not_computed") ? "not_computed" : minimums.some((m) => m.status === "upper_bound") ? "upper_bound" : "exact";

  const allocation = modeled
    ? allocate({
        months: period.months ?? "1",
        monthlyOrders: period.monthlyOrders,
        modeledOrders: p.processing.orders,
        shippingExpectedE4: Object.values(p.byMonth).reduce((n, b) => n + b.shippingExpectedE4, 0),
        processingE4,
        populationOrders: period.population,
        monthlyFixedE4: monthly?.totalE4 ?? 0,
        minimumTopUpE4: minimums.reduce((n, m) => n + m.topUpE4, 0),
        minimumStatus: minimumStatus === "none" ? "exact" : minimumStatus,
      })
    : null;

  return {
    fees: {
      mode: input.mode,
      statusCounts: { ...p.statusCounts },
      processing,
      byRule,
      completeness: completeness(partial, input, monthly),
      warnings: Object.entries(p.warnings)
        .map(([code, orders]) => ({ code, orders }))
        .sort((a, b) => b.orders - a.orders || compareKeys(a.code, b.code)),
      assumed: { ...p.assumed },
    },
    monthly,
    minimums,
    minimumStatus,
    allocation,
  };
}

interface RuleRow {
  key: string;
  name: string;
  scope: FeeRule["scope"];
  state: CompletenessState;
  reason: string | null;
  describe: string;
  orders: number;
}

/**
 * Per category: `priced` when every rate-bearing rule of the pinned version is priced, `not_modeled` when
 * some rule could not be computed (an unanswered question, an unknown quantity on N processing orders),
 * `not_in_schedule` when the version has no rule in the category. Account minimums are reported through
 * `minimumStatus`, not here. A packaging type that no rule prices counts against the packaging category.
 *
 * An order rule is only ever `priced` over the processing orders. When there is no processing order at
 * all (every shipping-modeled order had no content to price, or no version in effect on its date), no
 * order rule was computed for anyone, and every one of them is `not_modeled` for that reason.
 */
function completeness(partial: PartialSummary, input: FinalizeFeeInput, monthly: MonthlyFeeResult | null): CategoryCompleteness[] {
  const rules = (input.monthlySchedule?.rules ?? []).filter((r) => r.basis !== "minimum").sort((a, b) => a.position - b.position || compareKeys(a.key, b.key));
  const pricedMonthly = new Set(monthly?.lines.map((l) => l.ruleKey) ?? []);
  const notModeledMonthly = new Map(monthly?.notModeled.map((n) => [n.ruleKey, n.reason]) ?? []);
  const noProcessing = partial.fees.processing.orders === 0 ? unpricedStatus(partial.fees.statusCounts) : null;
  const unmatchedPackaging = Object.entries(partial.fees.byRule)
    .filter(([key, b]) => key.startsWith("packaging:") && b.unresolvedOrders > 0)
    .sort(([a], [b]) => compareKeys(a, b));
  return FEE_CATEGORIES.map((category) => {
    const rows: RuleRow[] = rules
      .filter((r) => r.category === category)
      .map((rule) => {
        const base = { key: rule.key, name: rule.name, scope: rule.scope, describe: describeFeeRule(rule) };
        if (input.mode !== "modeled") return { ...base, state: "not_modeled", reason: input.mode, orders: 0 };
        if (rule.scope === "order") {
          const b = partial.fees.byRule[rule.key];
          const unresolved = b?.unresolvedOrders ?? 0;
          if (unresolved > 0) return { ...base, state: "not_modeled", reason: b ? topReason(b.unresolvedBy) : null, orders: unresolved };
          if (noProcessing) return { ...base, state: "not_modeled", reason: noProcessing.status, orders: noProcessing.orders };
          return { ...base, state: "priced", reason: null, orders: 0 };
        }
        if (pricedMonthly.has(rule.key)) return { ...base, state: "priced", reason: null, orders: 0 };
        return { ...base, state: "not_modeled", reason: notModeledMonthly.get(rule.key) ?? "no_answer", orders: 0 };
      });
    if (category === "packaging") {
      for (const [key, b] of unmatchedPackaging) {
        const describe = key === PACKAGING_OTHER_KEY ? "No charge on the fee schedule covers these packaging types." : "No charge on the fee schedule covers this packaging type.";
        rows.push({ key, name: b.name, scope: "order", state: "not_modeled", reason: "packaging_unmatched", describe, orders: b.unresolvedOrders });
      }
    }
    const state: CompletenessState = rows.length === 0 ? "not_in_schedule" : rows.every((r) => r.state === "priced") ? "priced" : "not_modeled";
    return {
      category,
      state,
      notModeledOrders: rows.reduce((n, r) => Math.max(n, r.orders), 0),
      rules: rows.map(({ orders: _orders, ...r }) => r),
    };
  });
}

/** The reason that blocked the most orders; ties go to the first alphabetically so the label is stable. */
function topReason(by: Record<string, number>): string | null {
  const entries = Object.entries(by).sort((a, b) => b[1] - a[1] || compareKeys(a[0], b[0]));
  return entries[0]?.[0] ?? null;
}

/**
 * Why no shipping-modeled order became a processing order: the fee status that kept the most orders out
 * (ties to the first alphabetically), with its count. `status` is null when no order was shipping-modeled.
 */
function unpricedStatus(counts: Partial<Record<FeeStatus, number>>): { status: string | null; orders: number } {
  const entries = Object.entries(counts)
    .filter(([status, n]) => status !== "ok" && status !== "partial" && n > 0)
    .sort((a, b) => b[1] - a[1] || compareKeys(a[0], b[0]));
  return entries[0] ? { status: entries[0][0], orders: entries[0][1] } : { status: null, orders: 0 };
}

/** Exact E4 amount as dollars with four decimals ("12.3400"). */
function dollars4(e4: E4): DecimalString {
  return fromE4(e4).toFixed(4);
}

function cents(value: Dec): DecimalString {
  return value.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
}

/** Percentage with one decimal, HALF_UP; "0.0" when there is nothing to divide by. */
function pct(numerator: Dec, denominator: Dec): DecimalString {
  if (denominator.isZero()) return "0.0";
  return numerator.times(100).div(denominator).toDecimalPlaces(1, D.ROUND_HALF_UP).toFixed(1);
}

function average(amount: DecimalString, count: number): DecimalString | null {
  if (count === 0) return null;
  return dec(amount).div(count).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
}

function chargedTotal(b: SurchargeBucket): Dec {
  return dec(b.charged.definite).plus(dec(b.charged.estimated));
}

/** Bracket rows keep the edge order of the table, not the alphabetical order of their labels. */
function bracketIndex(label: string): number {
  const index = WEIGHT_BRACKET_LABELS.indexOf(label as (typeof WEIGHT_BRACKET_LABELS)[number]);
  if (index < 0) throw new RangeError(`unknown weight bracket "${label}"`);
  return index;
}

/** Stored as "code" or "code:ruleKey"; rule keys never contain a colon, warning codes neither. */
function splitWarningCode(stored: string): { code: string; ruleKey: string | null } {
  const colon = stored.indexOf(":");
  return colon < 0 ? { code: stored, ruleKey: null } : { code: stored.slice(0, colon), ruleKey: stored.slice(colon + 1) };
}
