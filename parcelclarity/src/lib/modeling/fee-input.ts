import type { OrderFeeInput, OrderShippingInput } from "@/engine/fees/types";
import { moneyToCents } from "@/engine/modeling/encode";
import type { FoldShipment } from "@/engine/modeling/types";
import { dec } from "@/engine/money";
import type { DecimalString } from "@/engine/types";

/**
 * Pure helpers that turn one order's batch rows into the fee engine's `OrderFeeInput`. No I/O: the
 * batch core (run.ts) reads the rows and calls these; the unit tests call them directly.
 *
 * Quantities come from the file whenever the file has them. When the file carries no item counts
 * (or no line data) and the customer described the typical order content as rows of
 * `{ units, lines, sharePct }`, each order is assigned one row by a deterministic apportionment of
 * its ordinal, and the quantities taken from that row are flagged as assumed. An unknown quantity
 * with no such assumption stays null: the engine reports the rule as not computed, never as $0.
 */

export interface OrderContentRow {
  units: number;
  lines: number;
  /** Share of orders with this content, percent with up to two decimals; the rows add up to exactly 100. */
  sharePct: DecimalString;
}

/** `assumptions.fulfillment` of a run, as `start_simulation_run` validated it. */
export interface FulfillmentAssumptions {
  skip?: boolean;
  monthlyOrders?: DecimalString | null;
  drivers?: Record<string, DecimalString | null>;
  orderShares?: Record<string, { sharePct: DecimalString; countPerOrder: number } | null>;
  packagingDefault?: string | null;
  orderContent?: { rows: OrderContentRow[] } | null;
}

/** The content fields of one order as `simulation_batch_input` returns them on every shipment row. */
export interface OrderContentSource {
  /** null = the file has no item counts. */
  orderUnits: number | null;
  /** null = the file has no line data (then `orderSkus` is null too). */
  orderLines: number | null;
  orderSkus: number | null;
  orderShipments: number;
  /** Dense 1-based ordinal of the order within its file (orders.seq). */
  orderSeq: number | null;
  /** Every package of every shipment of the order, in row then package order. */
  packages: { packagingTypeNormalized: string | null }[];
}

/**
 * Assigns ordinals 1, 2, 3, … to content rows so that the rows' shares are met as closely as a whole
 * number of orders allows at every point of the sequence: ordinal i goes to the row that is furthest
 * behind its share (i × share − orders assigned so far), ties to the earlier row. Shares are kept as
 * exact integers (hundredths of a percent), so the assignment depends on nothing but the ordinal and
 * the rows: splitting a run into batches, or resuming it, never changes which row an order gets.
 */
export interface Apportionment {
  readonly rows: readonly OrderContentRow[];
  /** Index into `rows` for a 1-based ordinal. */
  rowFor(ordinal: number): number;
}

export function createApportionment(rows: OrderContentRow[]): Apportionment {
  if (rows.length === 0) throw new RangeError("order content needs at least one row");
  const shares = rows.map((r) => {
    const hundredths = dec(r.sharePct).times(100);
    if (!hundredths.isInteger() || hundredths.lt(0)) throw new RangeError(`order content share "${r.sharePct}" must be a percentage with at most two decimals`);
    return hundredths.toNumber();
  });
  const total = shares.reduce((a, b) => a + b, 0);
  if (total !== 10000) throw new RangeError(`order content shares add up to ${dec(total).div(100).toFixed(2)}%, not 100.00%`);
  const assigned: number[] = [];
  const counts = shares.map(() => 0);
  const extend = (upTo: number) => {
    for (let i = assigned.length + 1; i <= upTo; i++) {
      let best = 0;
      let bestDeficit = Number.NEGATIVE_INFINITY;
      for (let r = 0; r < shares.length; r++) {
        // Both terms are exact integers: i × share (in hundredths of a percent) minus assigned × 100%.
        const deficit = i * shares[r]! - counts[r]! * 10000;
        if (deficit > bestDeficit) {
          best = r;
          bestDeficit = deficit;
        }
      }
      counts[best] = counts[best]! + 1;
      assigned.push(best);
    }
  };
  return {
    rows,
    rowFor(ordinal) {
      if (!Number.isInteger(ordinal) || ordinal < 1) throw new RangeError(`order ordinal must be a positive whole number, got ${ordinal}`);
      extend(ordinal);
      return assigned[ordinal - 1]!;
    },
  };
}

/**
 * The order's shipping figures for percent-of-shipping rules, or null when any shipment of the order
 * was not priced ok (the order is then not shipping-modeled and its shipping cost is unknown).
 * `baseFreightE4` is the base-rate and minimum-charge lines (dictionary entries 0 and 1) only.
 */
export function buildOrderShippingInput(shipments: FoldShipment[]): OrderShippingInput | null {
  let totalE4 = 0;
  let baseFreightE4 = 0;
  let estimated = false;
  let hasExposure = false;
  for (const s of shipments) {
    if (s.excludedReason !== null || s.result === null || s.result.status !== "ok") return null;
    const r = s.result;
    const estimatedCents = moneyToCents(r.estimated);
    totalE4 += (moneyToCents(r.definite) + estimatedCents) * 100;
    for (const [index, cents, status] of r.lines) if (status === "c" && (index === 0 || index === 1)) baseFreightE4 += cents * 100;
    if (estimatedCents > 0) estimated = true;
    if (moneyToCents(r.conditionalExposure) > 0 || moneyToCents(r.unresolved) > 0) hasExposure = true;
  }
  return { totalE4, baseFreightE4, estimated, hasExposure };
}

/**
 * The engine input for one order. Units, lines and distinct SKUs come from the file when it has them;
 * otherwise from the apportioned content row (flagged assumed) when the customer described the typical
 * order; otherwise they stay unknown. Lines and SKUs are taken from the row only when the file gives
 * this order no counted line (no line data at all, or no line rows for the order), and never exceed the
 * file's item count. `advance_simulation_run` accepts an assumed quantity only where the file has none.
 */
export function buildOrderFeeInput(order: OrderContentSource, shipping: OrderShippingInput | null, apportionment: Apportionment | null): OrderFeeInput {
  if (order.orderSeq === null || !Number.isInteger(order.orderSeq) || order.orderSeq < 1) {
    throw new RangeError("the order has no ordinal (orders.seq); prepare the orders file again");
  }
  const assumed: OrderFeeInput["assumed"] = {};
  let units = order.orderUnits;
  let lines = order.orderLines;
  let distinctSkus = order.orderSkus;
  if (apportionment && (units === null || lines === null)) {
    const row = apportionment.rows[apportionment.rowFor(order.orderSeq)]!;
    if (units === null) {
      units = row.units;
      assumed.units = true;
    }
    if (lines === null) {
      // The file knows the item count but not the lines: an order cannot have more lines than items, nor none when it has items.
      lines = units === null ? row.lines : Math.max(units > 0 ? 1 : 0, Math.min(row.lines, units));
      assumed.lines = true;
      distinctSkus = lines;
      assumed.skus = true;
    }
  }
  return {
    units,
    lines,
    distinctSkus,
    packages: order.packages.map((p) => ({ packagingType: p.packagingTypeNormalized })),
    shipments: order.orderShipments,
    shipping,
    assumed,
    ordinal: order.orderSeq,
  };
}

/** "YYYY-MM" of the order date, else of the first ship date; null when the order has neither (mirrors simulation_order_results.order_month). */
export function orderMonthOf(orderDate: string | null, firstShipDate: string | null): string | null {
  const date = orderDate ?? firstShipDate;
  return date !== null && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null;
}
