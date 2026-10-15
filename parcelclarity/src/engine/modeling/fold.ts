import { dec, type Dec } from "../money";
import type { DecimalString, SurchargeCategory } from "../types";
import { createDictionary } from "./encode";
import {
  WEIGHT_BRACKET_EDGES,
  type CompactLine,
  type CompactLineClass,
  type CompactResult,
  type CountBucket,
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
 * never mutated; the result is a new object that shares only the dictionary with it (the batch core
 * appends to that array through `encodeResult`, and the fold only reads it).
 *
 * Counting rules: an order is modeled when it is not cancelled and every one of its shipments priced
 * `ok`. Totals and every breakdown cover modeled orders only. An order that is not modeled is listed
 * once under one reason (`order_cancelled`, else its first failing shipment's reason); its failing
 * shipments are listed under their own reasons and its ok shipments under `pricedButExcluded`, so
 * nothing that was priced disappears from the report. Inconsistent input (a shipment neither priced
 * nor excluded, a line pointing at a package or dictionary entry that does not exist) throws instead
 * of being skipped: a run must fail loudly rather than report a number that is wrong.
 */

const ZERO: DecimalString = "0.00";

/** One label per edge, then the open-ended top bracket; same order as `WEIGHT_BRACKET_EDGES`. */
export const WEIGHT_BRACKET_LABELS: readonly WeightBracketLabel[] = ["≤1 lb", "≤2 lb", "≤3 lb", "≤5 lb", "≤10 lb", "≤20 lb", "≤50 lb", "≤70 lb", "≤150 lb", ">150 lb"];

export function emptyPartial(): PartialSummary {
  return {
    version: 1,
    dictionary: createDictionary(),
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
  };
}

/** The lowest bracket whose upper edge is at or above the billable weight; beyond the last edge, the open-ended top bracket. */
export function weightBracket(billableLb: DecimalString): WeightBracketLabel {
  const weight = dec(billableLb);
  const index = WEIGHT_BRACKET_EDGES.findIndex((edge) => weight.lessThanOrEqualTo(dec(edge)));
  return index >= 0 ? WEIGHT_BRACKET_LABELS[index]! : ">150 lb";
}

export function foldBatch(partial: PartialSummary, orders: FoldOrder[]): PartialSummary {
  const next = cloneForFold(partial);
  for (const order of orders) foldOrder(next, order);
  return next;
}

/** Copies everything the fold writes to. The dictionary is shared, not copied: it is the run's live array and the fold never changes it. */
function cloneForFold(partial: PartialSummary): PartialSummary {
  const { dictionary, ...rest } = partial;
  return { ...structuredClone(rest), dictionary };
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
  for (const s of states) if (s.kind === "ok") foldModeledShipment(p, s.shipment, s.result, month, buckets);
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
