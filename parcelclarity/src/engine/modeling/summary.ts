import { D, dec, type Dec } from "../money";
import { compareKeys } from "../surcharges";
import type { DecimalString } from "../types";
import { WEIGHT_BRACKET_LABELS } from "./fold";
import type { BulkSummary, DatasetCounts, PartialSummary, SurchargeBucket } from "./types";

/**
 * Turns the running partial into the customer-facing `BulkSummary`. Averages are HALF_UP to cents
 * and null when their denominator is zero (never "0.00", which would read as a free shipment);
 * coverage and shares carry one decimal. Every record becomes a deterministically sorted array so
 * two runs over the same data render identically.
 */
export function finalizeSummary(partial: PartialSummary, datasetCounts: DatasetCounts, loadIssues: string[], engineVersion: string): BulkSummary {
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
  return {
    engineVersion,
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
  };
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
