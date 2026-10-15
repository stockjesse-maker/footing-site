import type { FeeUnresolvedReason } from "../fees/types";
import { dec, type Dec } from "../money";
import type { DecimalString, SurchargeCategory } from "../types";
import { createDictionary } from "./encode";
import {
  WEIGHT_BRACKET_EDGES,
  type CompactLine,
  type CompactLineClass,
  type CompactResult,
  type CountBucket,
  type FeeDictionaryEntry,
  type FeeMonthPartial,
  type FeePartial,
  type FeeRulePartial,
  type FoldOrder,
  type FoldShipment,
  type LineDictionaryEntry,
  type MoneyBucket,
  type PartialSummary,
  type RunExclusion,
  type SurchargeBucket,
  type WeightBracketLabel,
} from "./types";

/**
 * Folds priced orders into the running `PartialSummary` (spec §2, §9). Pure: the partial given is
 * never mutated; the result is a new object that shares only the two dictionaries with it (the batch
 * core appends to those arrays through `encodeResult` / `encodeOrderFees`, and the fold only reads them).
 *
 * Counting rules: an order is modeled when it is not cancelled and every one of its shipments priced
 * `ok`. Totals and every breakdown cover modeled orders only. An order that is not modeled is listed
 * once under one reason (`order_cancelled`, else its first failing shipment's reason); its failing
 * shipments are listed under their own reasons and its ok shipments under `pricedButExcluded`, so
 * nothing that was priced disappears from the report. Inconsistent input (a shipment neither priced
 * nor excluded, a line pointing at a package or dictionary entry that does not exist) throws instead
 * of being skipped: a run must fail loudly rather than report a number that is wrong.
 *
 * Fees (Milestone 4): the fee status of every shipping-modeled order is counted; an order whose fees
 * priced `ok` or `partial` is a "processing order" and its fee lines, unresolved rules, month bucket,
 * warnings and assumptions are folded. Orders that are not shipping-modeled contribute nothing to the
 * fee figures, so "shipping + order fees" is always over one population.
 */

const ZERO: DecimalString = "0.00";

/** One label per edge, then the open-ended top bracket; same order as `WEIGHT_BRACKET_EDGES`. */
export const WEIGHT_BRACKET_LABELS: readonly WeightBracketLabel[] = ["≤1 lb", "≤2 lb", "≤3 lb", "≤5 lb", "≤10 lb", "≤20 lb", "≤50 lb", "≤70 lb", "≤150 lb", ">150 lb"];

/**
 * A run reports at most this many unmatched packaging types by name (`packaging:<type>`); every
 * further type folds into `PACKAGING_OTHER_KEY`, so a free-text packaging column cannot grow the
 * partial summary without bound (design D22). The raw types stay on each order's stored result.
 */
export const PACKAGING_UNMATCHED_CAP = 50;
export const PACKAGING_OTHER_KEY = "packaging:other";

export function emptyPartial(): PartialSummary {
  return {
    version: 2,
    dictionary: createDictionary(),
    feeDictionary: [],
    fees: emptyFees(),
    orders: { seen: 0, modeled: 0, cancelled: 0 },
    shipments: { seen: 0, ok: 0, unavailable: 0, excludedBeforePricing: 0, modeled: 0 },
    packages: { seen: 0, modeled: 0 },
    totals: { definite: ZERO, estimated: ZERO, expected: ZERO, conditionalExposure: ZERO, unresolved: ZERO },
    pricedButExcluded: { shipments: 0, expected: ZERO },
    exclusions: {},
    byZone: {},
    byService: {},
    byMonth: {},
    byWeightBracket: {},
    shipmentLevel: { shipments: 0, definite: ZERO, estimated: ZERO, expected: ZERO },
    bySurcharge: {},
    warnings: {},
    assumptions: { residential: 0, originZip: 0, weight: 0, dimensions: 0, packagesWithoutDimensions: 0 },
    unresolvedBy: { dimensions_missing: { shipments: 0, amount: ZERO }, zip_list_missing: { shipments: 0, amount: ZERO }, other: { shipments: 0, amount: ZERO } },
    exposureShipments: { conditional: 0, unresolved: 0 },
    loadIssues: [],
  };
}

/** The lowest bracket whose upper edge is at or above the billable weight; beyond the last edge, the open-ended top bracket. */
export function weightBracket(billableLb: DecimalString): WeightBracketLabel {
  const weight = dec(billableLb);
  const index = WEIGHT_BRACKET_EDGES.findIndex((edge) => weight.lessThanOrEqualTo(dec(edge)));
  return index >= 0 ? WEIGHT_BRACKET_LABELS[index]! : ">150 lb";
}

function emptyFees(): FeePartial {
  return {
    statusCounts: {},
    processing: { orders: 0, definiteE4: 0, estimatedE4: 0 },
    byRule: {},
    byMonth: {},
    warnings: {},
    assumed: { units: 0, lines: 0, skus: 0, packaging: 0 },
  };
}

export function foldBatch(partial: PartialSummary, orders: FoldOrder[]): PartialSummary {
  if (partial.version !== 2) throw new RangeError(`partial summary version ${String((partial as { version: unknown }).version)} is not supported; the run must be started again`);
  const next = cloneForFold(partial);
  for (const order of orders) foldOrder(next, order);
  return next;
}

/** Copies everything the fold writes to. The dictionaries are shared, not copied: they are the run's live arrays and the fold never changes them. */
function cloneForFold(partial: PartialSummary): PartialSummary {
  const { dictionary, feeDictionary, ...rest } = partial;
  return { ...structuredClone(rest), dictionary, feeDictionary };
}

type ShipmentState =
  | { kind: "ok"; shipment: FoldShipment; result: CompactResult }
  | { kind: "unavailable"; shipment: FoldShipment; result: CompactResult; reason: RunExclusion }
  | { kind: "excluded"; shipment: FoldShipment; reason: RunExclusion };
type FailedState = Exclude<ShipmentState, { kind: "ok" }>;

/** Classifies a shipment and refuses the combinations the batch core must never produce. */
function shipmentState(shipment: FoldShipment): ShipmentState {
  const { excludedReason, result, rowNo } = shipment;
  if (excludedReason !== null) {
    if (result !== null) throw new RangeError(`row ${rowNo}: excluded before pricing (${excludedReason}) but carries a result`);
    return { kind: "excluded", shipment, reason: excludedReason };
  }
  if (result === null) throw new RangeError(`row ${rowNo}: neither priced nor excluded`);
  if (result.status === "ok") {
    if (result.billableLb.length !== shipment.packageCount) throw new RangeError(`row ${rowNo}: ${shipment.packageCount} package(s) but ${result.billableLb.length} billable weight(s)`);
    return { kind: "ok", shipment, result };
  }
  if (result.unavailableReason === null) throw new RangeError(`row ${rowNo}: priced unavailable without a reason`);
  return { kind: "unavailable", shipment, result, reason: result.unavailableReason };
}

/** Buckets this order has already been counted in, so an order counts once per zone/service/month/bracket however many shipments it has. */
interface OrderBuckets {
  zones: Set<string>;
  services: Set<string>;
  months: Set<string>;
  brackets: Set<string>;
}

function foldOrder(p: PartialSummary, order: FoldOrder): void {
  if (order.shipments.length === 0) throw new RangeError(`order ${order.orderKey} has no shipments`);
  const states = order.shipments.map(shipmentState);
  p.orders.seen += 1;
  if (order.cancelled) p.orders.cancelled += 1;
  for (const s of states) {
    p.shipments.seen += 1;
    p.packages.seen += s.shipment.packageCount;
    if (s.kind === "ok") p.shipments.ok += 1;
    else if (s.kind === "unavailable") p.shipments.unavailable += 1;
    else p.shipments.excludedBeforePricing += 1;
  }

  const firstFailing = states.find((s): s is FailedState => s.kind !== "ok");
  const orderReason: RunExclusion | null = order.cancelled ? "order_cancelled" : firstFailing ? firstFailing.reason : null;
  if (orderReason !== null) {
    exclusion(p, orderReason).orders += 1;
    for (const s of states) {
      // A cancelled order's shipments are all unmodeled because of the cancellation, whatever else happened to them.
      if (order.cancelled) exclusion(p, "order_cancelled").shipments += 1;
      else if (s.kind !== "ok") exclusion(p, s.reason).shipments += 1;
      if (s.kind === "ok") {
        p.pricedButExcluded.shipments += 1;
        p.pricedButExcluded.expected = add(p.pricedButExcluded.expected, s.result.expected);
      }
    }
    return;
  }

  p.orders.modeled += 1;
  const month = monthOf(order.orderDate);
  const buckets: OrderBuckets = { zones: new Set(), services: new Set(), months: new Set(), brackets: new Set() };
  let shippingExpectedCents = 0;
  for (const s of states) {
    if (s.kind !== "ok") continue;
    foldModeledShipment(p, s.shipment, s.result, month, buckets);
    shippingExpectedCents += moneyCents(s.result.expected, s.shipment.rowNo);
  }
  foldOrderFees(p, order, shippingExpectedCents);
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

/** Folds the fee result of a shipping-modeled order. Only `ok` and `partial` results carry figures; the other statuses are counted and nothing else. */
function foldOrderFees(p: PartialSummary, order: FoldOrder, shippingExpectedCents: number): void {
  const fees = order.fees;
  const f = p.fees;
  f.statusCounts[fees.status] = (f.statusCounts[fees.status] ?? 0) + 1;
  if (fees.status !== "ok" && fees.status !== "partial") {
    if (fees.lines.length || fees.definiteE4 !== 0 || fees.estimatedE4 !== 0) throw new RangeError(`order ${order.orderKey}: fee status ${fees.status} but carries fee lines`);
    return;
  }

  let definite = 0;
  let estimated = 0;
  for (const [, amountE4, cls] of fees.lines) {
    if (!Number.isSafeInteger(amountE4) || amountE4 < 0) throw new RangeError(`order ${order.orderKey}: fee line amount ${amountE4} is not a whole non-negative number of ten-thousandths`);
    if (cls === "d") definite += amountE4;
    else estimated += amountE4;
  }
  if (definite !== fees.definiteE4 || estimated !== fees.estimatedE4) {
    throw new RangeError(`order ${order.orderKey}: fee lines add up to ${definite} definite and ${estimated} estimated, but the order says ${fees.definiteE4} and ${fees.estimatedE4}`);
  }

  f.processing.orders += 1;
  f.processing.definiteE4 += fees.definiteE4;
  f.processing.estimatedE4 += fees.estimatedE4;

  const month = touch(f.byMonth, order.orderMonth ?? "unknown", emptyFeeMonth);
  month.orders += 1;
  month.shippingExpectedE4 += shippingExpectedCents * 100;

  const countedRules = new Set<string>();
  for (const [index, amountE4, cls] of fees.lines) {
    const entry = p.feeDictionary[index];
    if (!entry) throw new RangeError(`order ${order.orderKey}: a fee line refers to fee dictionary entry ${index}, which does not exist`);
    const bucket = touch(f.byRule, entry.key, () => emptyFeeRule(entry));
    if (!bucket.ruleIds.includes(entry.ruleId)) bucket.ruleIds = [...bucket.ruleIds, entry.ruleId];
    if (cls === "d") bucket.definiteE4 += amountE4;
    else bucket.estimatedE4 += amountE4;
    bucket.lines += 1;
    if (firstTime(countedRules, entry.key)) bucket.orders += 1;
    month.byRuleE4[entry.key] = (month.byRuleE4[entry.key] ?? 0) + amountE4;
  }

  const seenUnresolved = new Set<string>();
  for (const u of fees.unresolved) {
    const key = unresolvedKeyFor(f.byRule, u.ruleKey, u.reason);
    if (!firstTime(seenUnresolved, key)) continue;
    const named = feeEntryFor(p.feeDictionary, key, u.reason, order.orderKey);
    const bucket = touch(f.byRule, key, () => emptyFeeRule(named.entry));
    if (named.ruleId !== null && !bucket.ruleIds.includes(named.ruleId)) bucket.ruleIds = [...bucket.ruleIds, named.ruleId];
    if (u.reason === "replaced") {
      bucket.replacedOrders += 1;
      continue;
    }
    bucket.unresolvedOrders += 1;
    bucket.unresolvedBy[u.reason] = (bucket.unresolvedBy[u.reason] ?? 0) + 1;
    if (!month.unresolvedRuleKeys.includes(key)) month.unresolvedRuleKeys = [...month.unresolvedRuleKeys, key];
  }

  for (const code of new Set(fees.warnings)) f.warnings[code] = (f.warnings[code] ?? 0) + 1;
  if (fees.assumed.units) f.assumed.units += 1;
  if (fees.assumed.lines) f.assumed.lines += 1;
  if (fees.assumed.skus) f.assumed.skus += 1;
  if (fees.assumed.packaging) f.assumed.packaging += 1;
}

type NamedFeeEntry = Pick<FeeDictionaryEntry, "key" | "name" | "category" | "basis" | "scope">;

/**
 * The per-rule row an unresolved entry counts under. Rules count under their key. An unmatched
 * packaging type counts under `packaging:<type>` while the run has fewer than `PACKAGING_UNMATCHED_CAP`
 * such rows, else under `PACKAGING_OTHER_KEY`. Which types keep a row of their own depends only on the
 * order they were first seen in, so a run split into batches folds to the same partial as one batch.
 */
function unresolvedKeyFor(byRule: Record<string, FeeRulePartial>, ruleKey: string, reason: FeeUnresolvedReason): string {
  if (reason !== "packaging_unmatched" || !ruleKey.startsWith("packaging:") || ruleKey === PACKAGING_OTHER_KEY || byRule[ruleKey] !== undefined) return ruleKey;
  let named = 0;
  for (const key of Object.keys(byRule)) if (key.startsWith("packaging:") && key !== PACKAGING_OTHER_KEY) named += 1;
  return named >= PACKAGING_UNMATCHED_CAP ? PACKAGING_OTHER_KEY : ruleKey;
}

/**
 * What an unresolved key stands for. Rules are named from the fee dictionary (the batch core adds every
 * unresolved rule to it); `packaging:<type>` entries are not rules but a packaging type no rule prices,
 * and are named from the key. Anything else is inconsistent input.
 */
function feeEntryFor(feeDictionary: FeeDictionaryEntry[], key: string, reason: FeeUnresolvedReason, orderKey: string): { entry: NamedFeeEntry; ruleId: string | null } {
  const entry = feeDictionary.find((e) => e.key === key);
  if (entry) return { entry, ruleId: entry.ruleId };
  if (reason === "packaging_unmatched" && key.startsWith("packaging:")) {
    const name = key === PACKAGING_OTHER_KEY ? "Packaging (other types)" : `Packaging (${key.slice("packaging:".length)})`;
    return { entry: { key, name, category: "packaging", basis: "package", scope: "order" }, ruleId: null };
  }
  throw new RangeError(`order ${orderKey}: unresolved fee rule "${key}" is not in the fee dictionary`);
}

function emptyFeeRule(entry: NamedFeeEntry): FeeRulePartial {
  return { ruleIds: [], name: entry.name, category: entry.category, basis: entry.basis, scope: entry.scope, definiteE4: 0, estimatedE4: 0, orders: 0, lines: 0, unresolvedOrders: 0, unresolvedBy: {}, replacedOrders: 0 };
}

function emptyFeeMonth(): FeeMonthPartial {
  return { orders: 0, byRuleE4: {}, shippingExpectedE4: 0, unresolvedRuleKeys: [] };
}

/** Exact integer cents of an engine amount; a fraction of a cent here is a bug in the input, not a value to round. */
function moneyCents(amount: DecimalString, rowNo: number): number {
  const cents = dec(amount).times(100);
  if (!cents.isInteger()) throw new RangeError(`row ${rowNo}: amount "${amount}" is not a whole number of cents`);
  return cents.toNumber();
}

function foldModeledShipment(p: PartialSummary, shipment: FoldShipment, result: CompactResult, month: string, order: OrderBuckets): void {
  p.shipments.modeled += 1;
  // Counted from the engine's per-package weights, the same way finish_simulation_run recomputes them.
  p.packages.modeled += result.billableLb.length;
  p.totals = {
    definite: add(p.totals.definite, result.definite),
    estimated: add(p.totals.estimated, result.estimated),
    expected: add(p.totals.expected, result.expected),
    conditionalExposure: add(p.totals.conditionalExposure, result.conditionalExposure),
    unresolved: add(p.totals.unresolved, result.unresolved),
  };

  const money: MoneyBucket = { definite: result.definite, estimated: result.estimated, expected: result.expected };
  const zone = result.zone ?? "unknown";
  countInto(touch(p.byZone, zone, emptyCount), money, shipment, firstTime(order.zones, zone));
  const serviceId = shipment.serviceId ?? result.serviceId ?? "unknown";
  const service = touch(p.byService, serviceId, () => ({ ...emptyCount(), serviceId, name: shipment.serviceName ?? "Unknown service", carrierCode: shipment.carrierCode ?? "unknown" }));
  countInto(service, money, shipment, firstTime(order.services, serviceId));
  countInto(touch(p.byMonth, month, emptyCount), money, shipment, firstTime(order.months, month));

  // A package belongs to the bracket of its own billable weight and its charged lines follow it; shipment-level lines have their own row.
  const brackets = result.billableLb.map(weightBracket);
  const shipmentBrackets = new Set<string>();
  for (const label of brackets) {
    const bucket = touch(p.byWeightBracket, label, emptyCount);
    bucket.packages += 1;
    if (firstTime(shipmentBrackets, label)) bucket.shipments += 1;
    if (firstTime(order.brackets, label)) bucket.orders += 1;
  }
  let hasShipmentLevelLine = false;
  for (const [, cents, status, cls, packageIndex] of result.lines) {
    if (packageIndex === null) {
      hasShipmentLevelLine = true;
      if (status === "c") addCharged(p.shipmentLevel, cls, cents);
      continue;
    }
    const label = brackets[packageIndex];
    if (label === undefined) throw new RangeError(`row ${shipment.rowNo}: a line refers to package ${packageIndex + 1}, but the result has ${brackets.length} package(s)`);
    if (status === "c") addCharged(p.byWeightBracket[label]!, cls, cents);
  }
  if (hasShipmentLevelLine) p.shipmentLevel.shipments += 1;

  foldSurchargeLines(p, shipment.rowNo, result.lines);

  for (const code of new Set(result.warningCodes)) touch(p.warnings, code, () => ({ shipments: 0 })).shipments += 1;

  if (shipment.assumed.residential) p.assumptions.residential += 1;
  if (shipment.assumed.originZip) p.assumptions.originZip += 1;
  if (shipment.assumed.weight) p.assumptions.weight += 1;
  if (shipment.assumed.dimensions) p.assumptions.dimensions += 1;
  p.assumptions.packagesWithoutDimensions += shipment.packagesWithoutDimensions;

  if (!dec(result.unresolved).isZero()) {
    const group = hasWarning(result, "dimensions_missing") ? "dimensions_missing" : hasWarning(result, "zip_list_missing") ? "zip_list_missing" : "other";
    p.unresolvedBy[group].shipments += 1;
    p.unresolvedBy[group].amount = add(p.unresolvedBy[group].amount, result.unresolved);
    p.exposureShipments.unresolved += 1;
  }
  if (!dec(result.conditionalExposure).isZero()) p.exposureShipments.conditional += 1;
}

/** Per-rule figures from the compact lines. A rule counts a shipment (and a package) once per status however many lines it produced. */
function foldSurchargeLines(p: PartialSummary, rowNo: number, lines: CompactLine[]): void {
  const seen = new Set<string>();
  const once = (key: string, what: string) => {
    const tag = `${key}|${what}`;
    if (seen.has(tag)) return false;
    seen.add(tag);
    return true;
  };
  for (const [index, cents, status, cls, packageIndex] of lines) {
    const entry = ruleEntryAt(p.dictionary, index, rowNo);
    if (!entry) continue;
    const bucket = touch(p.bySurcharge, entry.key, () => emptySurcharge(entry));
    if (!bucket.versions.includes(entry.version)) bucket.versions = [...bucket.versions, entry.version].sort((a, b) => a - b);
    const amount = centsDec(cents);
    switch (status) {
      case "c":
        bucket.charged.lines += 1;
        if (cls === "d") bucket.charged.definite = add(bucket.charged.definite, amount);
        else if (cls === "e") bucket.charged.estimated = add(bucket.charged.estimated, amount);
        if (once(entry.key, "charged")) bucket.charged.shipments += 1;
        if (packageIndex !== null && once(entry.key, `charged:${packageIndex}`)) bucket.charged.packages += 1;
        break;
      case "u":
        bucket.unknown.amount = add(bucket.unknown.amount, amount);
        if (once(entry.key, "unknown")) bucket.unknown.shipments += 1;
        break;
      case "n":
        bucket.conditional.amount = add(bucket.conditional.amount, amount);
        if (once(entry.key, "conditional")) bucket.conditional.shipments += 1;
        break;
      case "i":
        if (once(entry.key, "included")) bucket.included.shipments += 1;
        break;
      case "w":
        if (once(entry.key, "waived")) bucket.waived.shipments += 1;
        break;
    }
  }
}

interface RuleEntry {
  key: string;
  version: number;
  name: string;
  category: SurchargeCategory;
  scope: "carrier" | "3pl";
}

/** The rule behind a line, or null for base and minimum-charge lines (which are not surcharges). */
function ruleEntryAt(dictionary: LineDictionaryEntry[], index: number, rowNo: number): RuleEntry | null {
  const entry = dictionary[index];
  if (!entry) throw new RangeError(`row ${rowNo}: a line refers to dictionary entry ${index}, which does not exist`);
  if (entry.kind !== "rule") return null;
  if (entry.key === null || entry.version === null || entry.category === "base" || entry.scope === null) throw new RangeError(`dictionary entry ${index} is not a complete rule entry`);
  return { key: entry.key, version: entry.version, name: entry.name, category: entry.category, scope: entry.scope };
}

function emptySurcharge(entry: RuleEntry): SurchargeBucket {
  return {
    key: entry.key,
    name: entry.name,
    category: entry.category,
    scope: entry.scope,
    versions: [],
    charged: { definite: ZERO, estimated: ZERO, shipments: 0, packages: 0, lines: 0 },
    unknown: { amount: ZERO, shipments: 0 },
    conditional: { amount: ZERO, shipments: 0 },
    included: { shipments: 0 },
    waived: { shipments: 0 },
  };
}

function emptyCount(): CountBucket {
  return { orders: 0, shipments: 0, packages: 0, definite: ZERO, estimated: ZERO, expected: ZERO };
}

function countInto(bucket: CountBucket, money: MoneyBucket, shipment: FoldShipment, firstForOrder: boolean): void {
  if (firstForOrder) bucket.orders += 1;
  bucket.shipments += 1;
  bucket.packages += shipment.packageCount;
  bucket.definite = add(bucket.definite, money.definite);
  bucket.estimated = add(bucket.estimated, money.estimated);
  bucket.expected = add(bucket.expected, money.expected);
}

/** Adds one charged line by its class. A charged line is definite or estimated; a conditional class never reaches status charged, exactly as in the engine's totals. */
function addCharged(bucket: MoneyBucket, cls: CompactLineClass, cents: number): void {
  const amount = centsDec(cents);
  if (cls === "d") bucket.definite = add(bucket.definite, amount);
  else if (cls === "e") bucket.estimated = add(bucket.estimated, amount);
  else return;
  bucket.expected = add(bucket.expected, amount);
}

function exclusion(p: PartialSummary, reason: RunExclusion): { orders: number; shipments: number } {
  return touch(p.exclusions, reason, () => ({ orders: 0, shipments: 0 }));
}

function hasWarning(result: CompactResult, code: string): boolean {
  return result.warningCodes.some((w) => w === code || w.startsWith(`${code}:`));
}

/** "YYYY-MM" of a calendar date read as written; anything else is reported as unknown rather than guessed. */
function monthOf(orderDate: string | null): string {
  return orderDate !== null && /^\d{4}-\d{2}/.test(orderDate) ? orderDate.slice(0, 7) : "unknown";
}

function touch<T>(record: Record<string, T>, key: string, create: () => T): T {
  const existing = record[key];
  if (existing !== undefined) return existing;
  const created = create();
  record[key] = created;
  return created;
}

function firstTime(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

function centsDec(cents: number): Dec {
  return dec(cents).div(100);
}

function add(total: DecimalString, amount: DecimalString | Dec): DecimalString {
  return dec(total).plus(typeof amount === "string" ? dec(amount) : amount).toFixed(2);
}
