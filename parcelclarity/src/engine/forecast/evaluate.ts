import { calculateShipment } from "../calculate";
import { allocate } from "../fees/allocate";
import { calculateOrderFees } from "../fees/calculate";
import { describeFeeRule } from "../fees/describe";
import { calculateMonthlyFees, evaluateMinimums } from "../fees/monthly";
import { e4ToCents, fromE4, resolveMonthlyRate } from "../fees/tiers";
import { FEE_CATEGORIES, type E4, type FeeRule, type FeeScheduleSnapshot, type FulfillmentAnswers, type MinimumStatus, type MonthBucket, type MonthlyFeeResult, type OrderFeeContext, type OrderFeeInput } from "../fees/types";
import type { CategoryCompleteness, CompletenessState } from "../modeling/types";
import { D } from "../money";
import { compareKeys } from "../surcharges";
import type { PackageInput, ShipmentInput } from "../types";
import { normalizeZone } from "../zones";
import { buildGrid, canonicalizeAssumptions, compareZones, contentRows, stableStringify, validateForecastAssumptions, X, type Xd } from "./grid";
import {
  EXPECTED_VALUE_ORDINAL,
  FORECAST_ENGINE_VERSION,
  type ForecastAssumptions,
  type ForecastCaveat,
  type ForecastCellRecord,
  type ForecastDeps,
  type ForecastFeeMode,
  type ForecastMinimum,
  type ForecastOptions,
  type ForecastProcessing,
  type ForecastProfile,
  type ForecastResult,
  type ForecastRuleFigure,
  type ForecastShipping,
  type ForecastSummary,
  type ForecastUnpriceable,
  type ForecastUnresolvedRule,
  type ForecastVolumePoint,
} from "./types";

/**
 * Prices a forecast from assumptions (design §7).
 *
 * Every cell of the profile grid is one shipment of k identical packages priced once with
 * `calculateShipment`, every input flagged as assumed; the counted shipping lines (definite and
 * estimated) are summed as the cell's expected shipping and classed estimated, so nothing in a
 * forecast is ever definite. Conditional exposure and surcharges that could not be decided are
 * carried as upper bounds and never added. Per content row and cell, the fee engine prices one order
 * with the cell's packages and shipping; order-share drivers are turned into expected values (see
 * `EXPECTED_VALUE_ORDINAL`). Aggregates are Σ weight × amount in exact decimals, rounded once per
 * reported figure. A rule the fee engine could not compute is reported with the share of volume it
 * affects, never priced as $0.
 */

const HALF_UP = X.ROUND_HALF_UP;
const ASSUMED_ALL = { residential: true, originZip: true, weight: true, dimensions: true } as const;
const FEES_ASSUMED_ALL = { units: true, lines: true, skus: true, packaging: true } as const;

function cents(x: Xd): string {
  return x.toDecimalPlaces(2, HALF_UP).toFixed(2);
}

function centsOf(x: Xd): Xd {
  return x.toDecimalPlaces(2, HALF_UP);
}

/** An exact E4 sum rounded once to a whole number of ten-thousandths. */
function wholeE4(x: Xd): E4 {
  const n = x.toDecimalPlaces(0, HALF_UP).toNumber();
  if (!Number.isSafeInteger(n)) throw new RangeError("a forecast amount is too large to carry exactly");
  return n;
}

/** The shipping engine's cents strings as exact E4 integers. */
function moneyE4(amount: string): E4 {
  const v = new X(amount).times(10000);
  if (!v.isInteger()) throw new RangeError(`amount "${amount}" is not a whole number of ten-thousandths`);
  return v.toNumber();
}

function pct2(part: Xd, whole: Xd): string {
  return whole.isZero() ? "0.00" : cents(part.times(100).div(whole));
}

function wholeOrders(weight: Xd): number {
  return weight.toDecimalPlaces(0, HALF_UP).toNumber();
}

function bump(map: Map<string, Xd>, key: string, weight: Xd): void {
  map.set(key, (map.get(key) ?? new X(0)).plus(weight));
}

function topReason(byReason: Map<string, Xd>): string {
  const entries = [...byReason.entries()].sort((a, b) => b[1].cmp(a[1]) || compareKeys(a[0], b[0]));
  return entries[0]?.[0] ?? "unknown";
}

interface RuleAccumulator {
  rule: FeeRule;
  /** Σ weight × line amount, in E4 units (exact). */
  amountE4: Xd;
  /** Σ weight × chargeable quantity (exact). */
  quantity: Xd;
  /** Σ weight of orders that got a line. */
  lineWeight: Xd;
}

interface UnresolvedAccumulator {
  weight: Xd;
  byReason: Map<string, Xd>;
}

export function evaluateForecast(input: unknown, deps: ForecastDeps, options: ForecastOptions = {}): ForecastResult {
  const problems = validateForecastAssumptions(input);
  if (problems.length) return { status: "invalid", problems };
  const a = canonicalizeAssumptions(input as ForecastAssumptions);
  const assumptionsHash = deps.hash(stableStringify(a));
  const card = deps.pricing.rateCard;
  const termsById = new Map(card.services.map((s) => [s.serviceId, s] as const));

  // Pre-flight: a parcel needs its size wherever a selected service bills dimensional weight, unless the brand said it does not know it.
  const sizeProblems: string[] = [];
  a.parcels.forEach((p, i) => {
    if (p.lengthIn !== undefined || p.unknownSize) return;
    const bySize = a.services.filter((s) => {
      const t = termsById.get(s.serviceId);
      return t !== undefined && !t.dim.exempt;
    });
    if (bySize.length) sizeProblems.push(`parcels.${i}: ${bySize.map((s) => s.name).join(", ")} ${bySize.length === 1 ? "prices" : "price"} by size; give the parcel's dimensions or tick "I don't know the size"`);
  });
  if (sizeProblems.length) return { status: "invalid", problems: sizeProblems };

  const skip = a.fulfillment.skip === true;
  const schedule: FeeScheduleSnapshot | null = skip ? null : deps.schedule;
  const feeMode: ForecastFeeMode = skip ? "skipped" : deps.schedule ? "modeled" : "no_schedule";
  const answers: FulfillmentAnswers = { drivers: a.fulfillment.drivers, orderShares: a.fulfillment.orderShares };
  if (schedule) {
    const longTermProblems = longTermProblemsOf(schedule, answers);
    if (longTermProblems.length) return { status: "invalid", problems: longTermProblems };
  }

  const grid = buildGrid(a);
  const rows = contentRows(a.content);
  const volume = new X(a.monthlyOrders);
  const orders = volume.toNumber();

  // Order-share drivers as expected values: every forecast order is priced as an ordinal that qualifies, then scaled by the share.
  const orderShareByRuleKey = new Map<string, Xd>();
  if (schedule) {
    for (const rule of schedule.rules) {
      if (rule.scope !== "order" || rule.basis !== "order_driver") continue;
      const answer = a.fulfillment.orderShares[rule.driver?.key ?? rule.key];
      if (!answer) continue;
      const p = new X(answer.sharePct).div(100);
      const qualifies = new X(EXPECTED_VALUE_ORDINAL).times(p).floor().gt(new X(EXPECTED_VALUE_ORDINAL - 1).times(p).floor());
      if (p.gt(0) && !qualifies) throw new RangeError(`order share ${answer.sharePct}% cannot be priced as an expected value`);
      orderShareByRuleKey.set(rule.key, p);
    }
  }
  const feeContext: OrderFeeContext = { orderShares: a.fulfillment.orderShares, pinnedRates: deps.pinnedRates, packagingDefault: a.fulfillment.packagingDefault ?? null };

  // Accumulators: every money figure in E4 units, every weight in orders, all exact.
  let pricedWeight = new X(0);
  let shippingE4 = new X(0);
  let baseFreightE4 = new X(0);
  let conditionalE4 = new X(0);
  let unresolvedE4 = new X(0);
  const shippingWarnings = new Map<string, Xd>();
  const byRule = new Map<string, RuleAccumulator>();
  const unresolvedByRule = new Map<string, UnresolvedAccumulator>();
  const unmatchedPackaging = new Map<string, { name: string; weight: Xd }>();
  const feeWarnings = new Map<string, Xd>();
  const cellRecords: ForecastCellRecord[] = [];
  const unpriceableMap = new Map<string, { serviceIndex: number; serviceId: string; serviceName: string; zone: string; reason: string; message: string; weight: Xd }>();

  for (const cell of grid.cells) {
    const parcel = a.parcels[cell.parcelIndex]!;
    const service = a.services[cell.serviceIndex]!;
    const terms = termsById.get(service.serviceId);
    const weight = new X(cell.weight);
    const unpriceable = (reason: string, message: string) => {
      const key = `${cell.serviceIndex}|${cell.zone}|${reason}`;
      const existing = unpriceableMap.get(key);
      if (existing) existing.weight = existing.weight.plus(weight);
      else unpriceableMap.set(key, { serviceIndex: cell.serviceIndex, serviceId: service.serviceId, serviceName: service.name, zone: cell.zone, reason, message, weight });
      cellRecords.push([cell.key, cell.weight, null]);
    };

    const zip = deps.destinationZipForZone?.(cell.zone) ?? null;
    const destination: Pick<ShipmentInput, "destinationZip" | "destinationZone"> = zip !== null ? { destinationZip: zip } : { destinationZone: cell.zone };
    const dims = parcel.lengthIn !== undefined && parcel.widthIn !== undefined && parcel.heightIn !== undefined ? { length: parcel.lengthIn, width: parcel.widthIn, height: parcel.heightIn, dimensionUnit: "in" as const } : {};
    const pkg: PackageInput = { weight: parcel.weightLb, weightUnit: "lb", ...dims };
    const shipment: ShipmentInput = {
      shipDate: a.asOfDate,
      originZip: a.originZip,
      ...destination,
      residential: cell.residential,
      carrierCode: service.carrierCode,
      serviceCode: service.serviceCode,
      packages: Array.from({ length: cell.packages }, () => ({ ...pkg })),
      assumed: { ...ASSUMED_ALL },
    };
    const calc = calculateShipment(shipment, deps.pricing);
    if (calc.status !== "ok") {
      unpriceable(calc.unavailableReason ?? "invalid_input", calc.unavailableMessage ?? "The shipment could not be priced.");
      continue;
    }
    if (calc.service && calc.service.serviceId !== service.serviceId) {
      unpriceable("service_mismatch", `${service.name} is not the service the rate card prices under these codes.`);
      continue;
    }
    if (zip !== null && terms && !terms.zoneIndependent && calc.zone && normalizeZone(calc.zone.zone) !== cell.zone) {
      unpriceable("zone_mismatch", `The destination ZIP ${zip} used for zone ${cell.zone} falls in zone ${calc.zone.zone} on this rate card.`);
      continue;
    }

    // Shipping: counted lines (definite + estimated) are the cell's expected cost, all of it an estimate.
    const expectedE4 = moneyE4(calc.totals.expected.amount);
    const cellBaseFreightE4 = calc.lines.filter((l) => l.counted && (l.kind === "base" || l.kind === "minimum_charge")).reduce((n, l) => n + moneyE4(l.amount.amount), 0);
    const cellConditionalE4 = moneyE4(calc.totals.conditionalExposure.amount);
    const cellUnresolvedE4 = moneyE4(calc.totals.unresolved.amount);
    const hasExposure = cellConditionalE4 > 0 || cellUnresolvedE4 > 0;
    pricedWeight = pricedWeight.plus(weight);
    shippingE4 = shippingE4.plus(weight.times(expectedE4));
    baseFreightE4 = baseFreightE4.plus(weight.times(cellBaseFreightE4));
    conditionalE4 = conditionalE4.plus(weight.times(cellConditionalE4));
    unresolvedE4 = unresolvedE4.plus(weight.times(cellUnresolvedE4));
    for (const code of new Set(calc.warnings.map((w) => w.code))) bump(shippingWarnings, code, weight);
    cellRecords.push([cell.key, cell.weight, expectedE4]);
    if (!schedule) continue;

    // Fees: one order per content row, weighted by the row's share of the cell.
    for (const row of rows) {
      const rowWeight = weight.times(row.sharePct).div(100);
      const feeInput: OrderFeeInput = {
        units: row.units,
        lines: row.lines,
        distinctSkus: row.lines,
        packages: Array.from({ length: cell.packages }, () => ({ packagingType: parcel.packagingType })),
        shipments: 1,
        shipping: { totalE4: expectedE4, baseFreightE4: cellBaseFreightE4, estimated: true, hasExposure },
        assumed: { ...FEES_ASSUMED_ALL },
        ordinal: EXPECTED_VALUE_ORDINAL,
      };
      const result = calculateOrderFees(feeInput, schedule, feeContext);
      for (const line of result.lines) {
        let amountE4 = new X(line.amountE4);
        let quantity = new X(line.quantity);
        if (line.basis === "order_driver") {
          // The engine priced this order as one that qualifies; the expected value over all orders is the share of orders that do.
          const p = orderShareByRuleKey.get(line.ruleKey);
          if (p === undefined) throw new RangeError("an order-driver line was priced without an answered share");
          amountE4 = amountE4.times(p);
          quantity = quantity.times(p);
        }
        let acc = byRule.get(line.ruleKey);
        if (!acc) {
          const rule = schedule.rules.find((r) => r.key === line.ruleKey);
          if (!rule) throw new RangeError("a fee line names a rule that is not on the schedule");
          acc = { rule, amountE4: new X(0), quantity: new X(0), lineWeight: new X(0) };
          byRule.set(line.ruleKey, acc);
        }
        acc.amountE4 = acc.amountE4.plus(rowWeight.times(amountE4));
        acc.quantity = acc.quantity.plus(rowWeight.times(quantity));
        acc.lineWeight = acc.lineWeight.plus(rowWeight);
      }
      for (const u of result.unresolved) {
        if (u.reason === "replaced") continue;
        if (u.ruleKey.startsWith("packaging:")) {
          const existing = unmatchedPackaging.get(u.ruleKey);
          if (existing) existing.weight = existing.weight.plus(rowWeight);
          else unmatchedPackaging.set(u.ruleKey, { name: u.name, weight: rowWeight });
          continue;
        }
        let acc = unresolvedByRule.get(u.ruleKey);
        if (!acc) {
          acc = { weight: new X(0), byReason: new Map() };
          unresolvedByRule.set(u.ruleKey, acc);
        }
        acc.weight = acc.weight.plus(rowWeight);
        bump(acc.byReason, u.reason, rowWeight);
      }
      for (const code of result.warnings) bump(feeWarnings, code, rowWeight);
    }
  }

  const unpriceable: ForecastUnpriceable[] = [...unpriceableMap.values()]
    .sort((p, q) => p.serviceIndex - q.serviceIndex || compareZones(p.zone, q.zone) || compareKeys(p.reason, q.reason))
    .map((u) => ({ serviceId: u.serviceId, serviceName: u.serviceName, zone: u.zone, reason: u.reason, message: u.message, weight: u.weight.toFixed(), sharePct: pct2(u.weight, volume) }));
  const unpricedWeight = volume.minus(pricedWeight);
  if (unpriceable.length && (!options.priceOnlyCovered || pricedWeight.isZero())) {
    return { status: "blocked", assumptionsHash, cellCount: grid.cells.length, unpriceable, unpriceableSharePct: pct2(unpricedWeight, volume) };
  }
  const partial = unpriceable.length > 0;
  const denominator = partial ? pricedWeight : volume;
  const pricedSharePct = pct2(pricedWeight, volume);
  const perOrderOf = (e4: E4) => cents(new X(e4).div(10000).div(denominator));
  const warningList = (map: Map<string, Xd>) =>
    [...map.entries()].sort((p, q) => compareKeys(p[0], q[0])).map(([code, weight]) => ({ code, sharePct: pct2(weight, denominator) }));

  const shippingExpectedE4 = wholeE4(shippingE4);
  const conditionalUpToE4 = wholeE4(conditionalE4);
  const unresolvedUpToE4 = wholeE4(unresolvedE4);

  // Monthly charges, minimums and allocation.
  const monthly: MonthlyFeeResult | null = schedule ? calculateMonthlyFees(answers, schedule, new D(a.monthlyOrders)) : null;
  const processingTotalE4 = [...byRule.values()].reduce((s, r) => s.plus(r.amountE4), new X(0));
  const processingE4 = wholeE4(processingTotalE4);

  let minimums: ForecastMinimum[] = [];
  let minimumStatus: MinimumStatus | "none" = "none";
  if (schedule && monthly) {
    const minimumRules = schedule.rules.filter((r) => r.basis === "minimum" && r.minimum);
    if (minimumRules.length) {
      const orderVariableByRuleE4: Record<string, E4> = {};
      for (const [key, acc] of byRule) if (acc.rule.scope === "order") orderVariableByRuleE4[key] = wholeE4(acc.amountE4);
      const bucket: MonthBucket = {
        month: "average",
        fraction: "1",
        orderVariableByRuleE4,
        modeledOrders: orders,
        shippedOrders: orders,
        shippingExpectedE4,
        unresolvedRuleKeys: [...unresolvedByRule.keys()].sort(compareKeys),
      };
      const includesShipping = new Map(minimumRules.map((r) => [r.key, r.minimum!.includesShipping] as const));
      minimums = evaluateMinimums([bucket], schedule, monthly).map((m) => ({ ...m, includesShipping: includesShipping.get(m.ruleKey) ?? false }));
      if (partial) {
        // Fees were summed over the priced part of the volume only, so the counted amount is understated and the top-up is at most this.
        minimums = minimums.map((m) => (m.status === "not_computed" ? m : { ...m, status: "upper_bound", reasons: [...m.reasons, `shipping priced for ${pricedSharePct}% of orders`] }));
      }
      minimumStatus = minimums.some((m) => m.status === "not_computed") ? "not_computed" : minimums.some((m) => m.status === "upper_bound") ? "upper_bound" : "exact";
    }
  }
  const minimumTopUpE4 = minimums.reduce((n, m) => n + m.topUpE4, 0);

  const allocation =
    schedule && monthly && !partial
      ? allocate({
          months: "1.000000",
          monthlyOrders: a.monthlyOrders,
          modeledOrders: orders,
          shippingExpectedE4,
          processingE4,
          populationOrders: orders,
          monthlyFixedE4: monthly.totalE4,
          minimumTopUpE4,
          minimumStatus: minimumStatus === "none" ? "exact" : minimumStatus,
        })
      : null;

  const shipping: ForecastShipping = {
    expectedE4: shippingExpectedE4,
    expected: e4ToCents(shippingExpectedE4),
    estimated: fromE4(shippingExpectedE4).toFixed(4),
    definite: "0.00",
    perOrder: allocation?.perOrder.shipping ?? perOrderOf(shippingExpectedE4),
    baseFreightE4: wholeE4(baseFreightE4),
    conditionalUpToE4,
    conditionalUpTo: e4ToCents(conditionalUpToE4),
    unresolvedUpToE4,
    unresolvedUpTo: e4ToCents(unresolvedUpToE4),
    warnings: warningList(shippingWarnings),
  };

  let processing: ForecastProcessing | null = null;
  if (schedule) {
    const figures: ForecastRuleFigure[] = [...byRule.values()]
      .sort((p, q) => p.rule.position - q.rule.position || compareKeys(p.rule.key, q.rule.key))
      .map((acc) => {
        const expectedE4 = wholeE4(acc.amountE4);
        return {
          key: acc.rule.key,
          name: acc.rule.name,
          category: acc.rule.category,
          basis: acc.rule.basis,
          expectedE4,
          expected: e4ToCents(expectedE4),
          perOrder: perOrderOf(expectedE4),
          quantityPerOrder: acc.quantity.div(denominator).toDecimalPlaces(4, HALF_UP).toFixed(4),
          ordersSharePct: pct2(acc.lineWeight, denominator),
        };
      });
    const positionOf = new Map(schedule.rules.map((r) => [r.key, r.position] as const));
    const unresolved: ForecastUnresolvedRule[] = [...unresolvedByRule.entries()]
      .sort((p, q) => (positionOf.get(p[0]) ?? 0) - (positionOf.get(q[0]) ?? 0) || compareKeys(p[0], q[0]))
      .map(([key, acc]) => ({ key, name: schedule.rules.find((r) => r.key === key)?.name ?? key, reason: topReason(acc.byReason), sharePct: pct2(acc.weight, denominator), orders: wholeOrders(acc.weight) }));
    for (const [key, u] of [...unmatchedPackaging.entries()].sort((p, q) => compareKeys(p[0], q[0]))) {
      unresolved.push({ key, name: u.name, reason: "packaging_unmatched", sharePct: pct2(u.weight, denominator), orders: wholeOrders(u.weight) });
    }
    processing = {
      expectedE4: processingE4,
      expected: e4ToCents(processingE4),
      estimated: fromE4(processingE4).toFixed(4),
      definite: "0.00",
      perOrder: allocation?.perOrder.processing ?? perOrderOf(processingE4),
      byRule: figures,
      unresolved,
      warnings: warningList(feeWarnings),
    };
  }

  const completeness = completenessOf(deps.schedule, feeMode, monthly, unresolvedByRule, unmatchedPackaging);
  const complete = feeMode === "modeled" && !partial && completeness.every((c) => c.state !== "not_modeled");
  const allIn = complete && allocation && allocation.perOrder.allIn !== null && allocation.monthly.total !== null && allocation.monthly.annual !== null ? { perOrder: allocation.perOrder.allIn, monthly: allocation.monthly.total, annual: allocation.monthly.annual } : null;
  const allocated = allocation ? { perOrder: allocation.perOrder.allocated, monthly: cents(new X(allocation.monthly.fixed).plus(allocation.monthly.minimumTopUp ?? "0")) } : null;

  const caveats: ForecastCaveat[] = ["expected_values", "independent_distributions", "one_shipment_per_order", "exact_weights", "no_shipment_options", "delivery_area_undecided", "effective_dates"];
  if (partial) caveats.push("priced_only_covered");
  if (feeMode === "no_schedule") caveats.push("no_fee_schedule");
  if (feeMode === "skipped") caveats.push("fulfillment_skipped");
  if (feeMode === "modeled" && completeness.some((c) => c.state === "not_modeled")) caveats.push("not_all_categories_priced");
  if (minimumStatus === "upper_bound") caveats.push("minimum_upper_bound");

  const profile: ForecastProfile = {
    monthlyOrders: a.monthlyOrders,
    asOfDate: a.asOfDate,
    originZip: a.originZip,
    parcels: a.parcels,
    zones: a.zones,
    services: a.services,
    residentialPct: a.residentialPct,
    multiPackage: a.multiPackage,
    content: {
      source: "rows" in a.content ? "rows" : "averages",
      averageUnits: "averageUnits" in a.content ? a.content.averageUnits : null,
      averageLines: "averageLines" in a.content ? a.content.averageLines : null,
      rows,
    },
  };

  const summary: ForecastSummary = {
    version: 2,
    basis: "assumptions",
    forecastEngineVersion: FORECAST_ENGINE_VERSION,
    engineVersion: deps.engineVersion,
    feeEngineVersion: deps.feeEngineVersion,
    assumptionsHash,
    asOfDate: a.asOfDate,
    monthlyOrders: a.monthlyOrders,
    weightSum: grid.weightSum,
    pricedWeight: pricedWeight.toFixed(),
    pricedSharePct,
    counts: grid.counts,
    cells: cellRecords,
    priceOnlyCovered: options.priceOnlyCovered === true,
    unpriceable,
    shipping,
    feeMode,
    processing,
    monthly: monthly ? { ...monthly, total: e4ToCents(monthly.totalE4) } : null,
    minimums,
    minimumStatus,
    minimum: { status: minimumStatus, topUpE4: minimumTopUpE4, topUp: minimumStatus === "none" ? "0.00" : minimumStatus === "not_computed" ? null : e4ToCents(minimumTopUpE4) },
    allocation,
    allocated,
    allIn,
    complete,
    completeness,
    caveats,
    provenance: {
      rateCardName: card.rateCardName,
      rateCardEffectiveDate: card.effectiveDate,
      rateCardExpirationDate: card.expirationDate,
      feeScheduleName: deps.schedule?.name ?? null,
      feeScheduleEffectiveDate: deps.schedule?.effectiveDate ?? null,
      feeScheduleExpirationDate: deps.schedule?.expirationDate ?? null,
    },
    profile,
  };
  return { status: "ok", summary };
}

/** A long-term storage answer larger than the stored quantity it is part of, in the customer's words (the fee engine would throw with rule keys). */
function longTermProblemsOf(schedule: FeeScheduleSnapshot, answers: FulfillmentAnswers): string[] {
  const problems: string[] = [];
  for (const rule of schedule.rules) {
    const lt = rule.driver?.longTerm;
    if (!lt || lt.mode !== "replace" || rule.scope !== "monthly") continue;
    const replaced = schedule.rules.find((r) => r.key === lt.replacesRuleKey);
    const answer = answers.drivers[rule.driver!.key];
    const stored = replaced?.driver ? answers.drivers[replaced.driver.key] : undefined;
    if (answer === null || answer === undefined || stored === null || stored === undefined) continue;
    if (new X(answer).gt(stored)) problems.push(`fulfillment: "${rule.name}" (${answer}) cannot exceed "${replaced!.name}" (${stored})`);
  }
  return problems;
}

type RuleRow = CategoryCompleteness["rules"][number] & { orders: number };

/**
 * Per category, as in file runs: `priced` when every rate-bearing rule of the version is priced,
 * `not_modeled` when some rule could not be computed (its expected number of affected orders is
 * reported), `not_in_schedule` when the version has no rule in the category. Account minimums are
 * reported through `minimumStatus`. A packaging type no rule prices counts against packaging.
 */
function completenessOf(
  schedule: FeeScheduleSnapshot | null,
  feeMode: ForecastFeeMode,
  monthly: MonthlyFeeResult | null,
  unresolved: Map<string, UnresolvedAccumulator>,
  unmatchedPackaging: Map<string, { name: string; weight: Xd }>,
): CategoryCompleteness[] {
  const rules = (schedule?.rules ?? []).filter((r) => r.basis !== "minimum").sort((p, q) => p.position - q.position || compareKeys(p.key, q.key));
  const pricedMonthly = new Set(monthly?.lines.map((l) => l.ruleKey) ?? []);
  const notModeledMonthly = new Map(monthly?.notModeled.map((n) => [n.ruleKey, n.reason] as const) ?? []);
  return FEE_CATEGORIES.map((category) => {
    const rows: RuleRow[] = rules
      .filter((r) => r.category === category)
      .map((rule): RuleRow => {
        const base = { key: rule.key, name: rule.name, scope: rule.scope, describe: describeFeeRule(rule) };
        if (feeMode !== "modeled") return { ...base, state: "not_modeled", reason: feeMode, orders: 0 };
        if (rule.scope === "order") {
          const u = unresolved.get(rule.key);
          return u ? { ...base, state: "not_modeled", reason: topReason(u.byReason), orders: wholeOrders(u.weight) } : { ...base, state: "priced", reason: null, orders: 0 };
        }
        if (pricedMonthly.has(rule.key)) return { ...base, state: "priced", reason: null, orders: 0 };
        return { ...base, state: "not_modeled", reason: notModeledMonthly.get(rule.key) ?? "no_answer", orders: 0 };
      });
    if (category === "packaging" && feeMode === "modeled") {
      for (const [key, u] of [...unmatchedPackaging.entries()].sort((p, q) => compareKeys(p[0], q[0]))) {
        rows.push({ key, name: u.name, scope: "order", state: "not_modeled", reason: "packaging_unmatched", describe: "No charge on the fee schedule covers this packaging type.", orders: wholeOrders(u.weight) });
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

// ---------------------------------------------------------------------------
// Sensitivity: the all-in at other volumes
// ---------------------------------------------------------------------------

export const DEFAULT_VOLUME_MULTIPLIERS: readonly string[] = ["0.5", "1", "2", "4"];

/**
 * The all-in per order at k × the forecast volume, holding the per-order shipping and processing
 * constant: shipping and processing scale linearly, monthly lines scale only when their quantity
 * follows volume (a returns rate), the other monthly charges stay fixed, and every exact account
 * minimum is re-evaluated at the new volume. A minimum that is not exact stays out of the all-in,
 * as in the summary. At k = 1 the figures reproduce `summary.allocation`. Empty when the summary
 * carries no allocation (fees not modeled or only part of the volume priced).
 */
export function allInAtVolumes(summary: ForecastSummary, multipliers: readonly string[] = DEFAULT_VOLUME_MULTIPLIERS): ForecastVolumePoint[] {
  const { allocation, processing, monthly } = summary;
  if (!allocation || !processing || !monthly) return [];
  const volume = new X(summary.monthlyOrders);
  const orderRuleE4 = new Map(processing.byRule.map((r) => [r.key, r.expectedE4] as const));
  const monthlyLineByKey = new Map(monthly.lines.map((l) => [l.ruleKey, l] as const));
  return multipliers.map((multiplier) => {
    if (!/^\d+(\.\d+)?$/.test(multiplier) || !/[1-9]/.test(multiplier)) throw new RangeError(`volume multiplier "${multiplier}" must be a positive decimal`);
    const k = new X(multiplier);
    const orders = volume.times(k);
    const shipping = new X(summary.shipping.expectedE4).times(k).div(10000);
    const processingAmount = new X(processing.expectedE4).times(k).div(10000);
    const fixed = monthly.lines.reduce((s, l) => s.plus(new X(l.amountE4).times(l.scalesWithVolume ? k : 1)), new X(0)).div(10000);
    let topUp: Xd | null = new X(0);
    for (const m of summary.minimums) {
      if (m.status !== "exact") {
        topUp = null;
        break;
      }
      let counted = new X(0);
      for (const member of m.members) {
        const orderE4 = orderRuleE4.get(member.ruleKey);
        if (orderE4 !== undefined) {
          counted = counted.plus(centsOf(new X(orderE4).times(k).div(10000)));
          continue;
        }
        const line = monthlyLineByKey.get(member.ruleKey);
        if (line) counted = counted.plus(centsOf(new X(line.amountE4).times(line.scalesWithVolume ? k : 1).div(10000)));
      }
      if (m.includesShipping) counted = counted.plus(centsOf(shipping));
      const minimum = new X(m.minimumE4).div(10000);
      topUp = topUp.plus(X.max(0, minimum.minus(counted)));
    }
    const total = shipping.plus(processingAmount).plus(fixed).plus(topUp ?? 0);
    return {
      multiplier,
      monthlyOrders: orders.toFixed(),
      monthly: { shipping: cents(shipping), processing: cents(processingAmount), fixed: cents(fixed), minimumTopUp: topUp === null ? null : cents(topUp), total: cents(total) },
      perOrder: { shipping: cents(shipping.div(orders)), processing: cents(processingAmount.div(orders)), allocated: cents(fixed.plus(topUp ?? 0).div(orders)), allIn: cents(total.div(orders)) },
      minimumStatus: summary.minimumStatus,
    };
  });
}

// ---------------------------------------------------------------------------
// Pinned monthly-volume rates
// ---------------------------------------------------------------------------

/**
 * The rates of order-scope rules tiered on the monthly quantity, read at this forecast's volume:
 * orders (and shipments) = monthlyOrders, items = monthlyOrders × the expected items per order from
 * the content, packages = monthlyOrders × the expected packages per order from the multi-package
 * share. The caller passes the result as `deps.pinnedRates` (and persists it as the run's pins).
 */
export function forecastPinnedRates(assumptions: ForecastAssumptions, schedule: FeeScheduleSnapshot | null): OrderFeeContext["pinnedRates"] {
  const pins: OrderFeeContext["pinnedRates"] = {};
  if (!schedule) return pins;
  const problems = validateForecastAssumptions(assumptions);
  if (problems.length) throw new RangeError(problems[0]);
  const a = canonicalizeAssumptions(assumptions);
  const volume = new X(a.monthlyOrders);
  const unitsPerOrder = contentRows(a.content).reduce((s, r) => s.plus(new X(r.units).times(r.sharePct).div(100)), new X(0));
  const packagesPerOrder = new X(1).plus(new X(a.multiPackage.pct).div(100).times(a.multiPackage.packagesPerOrder - 1));
  for (const rule of schedule.rules) {
    if (rule.scope !== "order" || rule.method !== "tiered" || !rule.tiers || rule.tiers.on !== "monthly_quantity") continue;
    const quantity = rule.basis === "unit" ? volume.times(unitsPerOrder) : rule.basis === "package" ? volume.times(packagesPerOrder) : volume;
    const rateE4 = resolveMonthlyRate(rule.tiers, new D(quantity.toFixed()));
    if (rateE4 !== null) pins[rule.key] = { rateE4, monthlyQuantity: quantity.toFixed() };
  }
  return pins;
}
