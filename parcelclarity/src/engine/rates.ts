import { dec, fmt, fromLb, type Dec } from "./money";
import { normalizeZone } from "./zones";
import type { RateRow, UnavailableReason } from "./types";

export interface RateLookup {
  ok: true;
  row: RateRow;
  /** Billable weight expressed in the row's unit, for the explanation. */
  comparedWeight: Dec;
  originScope: "origin_5" | "origin_3" | "any_origin";
}

export interface RateMiss {
  ok: false;
  reason: UnavailableReason;
  message: string;
}

/**
 * Finds the rate-card cell for a service / zone / origin / billable weight.
 * Zone first, then the most specific origin scope among that zone's rows (5-digit > 3-digit > any
 * origin), then the bracket with weightMin < weight ≤ weightMax compared in the row's unit with
 * exact decimals. Overlapping brackets cannot exist on an activated card; if they did, the
 * lightest matching bracket would win.
 */
export function lookupRate(rows: RateRow[], serviceId: string, originZip: string, zone: string, billableLb: Dec): RateLookup | RateMiss {
  const serviceRows = rows.filter((r) => r.serviceId === serviceId);
  if (!serviceRows.length) return { ok: false, reason: "service_not_on_rate_card", message: "The rate card has no rows for this service." };

  const wantedZone = normalizeZone(zone);
  const zoneRows = serviceRows.filter((r) => normalizeZone(r.zone) === wantedZone);
  if (!zoneRows.length) {
    const zonesOffered = [...new Set(serviceRows.map((r) => normalizeZone(r.zone)))].sort();
    return { ok: false, reason: "no_rate_for_zone", message: `The rate card has no rates for zone ${wantedZone} on this service (zones covered: ${zonesOffered.join(", ")}).` };
  }

  let scoped: RateRow[] = [];
  let originScope: RateLookup["originScope"] = "any_origin";
  const origin5 = zoneRows.filter((r) => r.originPrefix === originZip);
  const origin3 = zoneRows.filter((r) => r.originPrefix === originZip.slice(0, 3));
  const anyOrigin = zoneRows.filter((r) => r.originPrefix === null);
  if (origin5.length) {
    scoped = origin5;
    originScope = "origin_5";
  } else if (origin3.length) {
    scoped = origin3;
    originScope = "origin_3";
  } else if (anyOrigin.length) {
    scoped = anyOrigin;
  } else {
    return { ok: false, reason: "no_rate_for_origin", message: `The rate card prices this service by origin and has no rates for origin ZIP ${originZip} in zone ${wantedZone}.` };
  }

  const matches = scoped
    .map((row) => ({ row, w: fromLb(billableLb, row.weightUnit) }))
    .filter(({ row, w }) => w.greaterThan(dec(row.weightMin)) && w.lessThanOrEqualTo(dec(row.weightMax)))
    .sort((a, b) => toLbDec(a.row.weightMax, a.row.weightUnit).comparedTo(toLbDec(b.row.weightMax, b.row.weightUnit)) || toLbDec(a.row.weightMin, a.row.weightUnit).comparedTo(toLbDec(b.row.weightMin, b.row.weightUnit)));
  const best = matches[0];
  if (!best) {
    const maxRow = scoped.reduce((m, r) => (toLbDec(r.weightMax, r.weightUnit).greaterThan(toLbDec(m.weightMax, m.weightUnit)) ? r : m));
    const maxLb = toLbDec(maxRow.weightMax, maxRow.weightUnit);
    return {
      ok: false,
      reason: "no_rate_for_weight",
      message: billableLb.greaterThan(maxLb)
        ? `Billable weight ${fmt(billableLb, 3)} lb exceeds the heaviest bracket on the rate card for zone ${wantedZone} (${fmt(dec(maxRow.weightMax), 3)} ${maxRow.weightUnit}). Rates are not extrapolated.`
        : `The rate card has no bracket covering ${fmt(billableLb, 3)} lb for zone ${wantedZone}.`,
    };
  }
  return { ok: true, row: best.row, comparedWeight: best.w, originScope };
}

function toLbDec(value: string, unit: RateRow["weightUnit"]): Dec {
  return unit === "oz" ? dec(value).div(16) : dec(value);
}
