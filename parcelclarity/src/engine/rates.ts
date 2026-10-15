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
 * Finds the rate-card cell for a service / origin / zone / billable weight.
 * Bracket semantics: weightMin < weight ≤ weightMax, compared in the row's unit with exact decimals.
 */
export function lookupRate(rows: RateRow[], serviceId: string, originZip: string, zone: string, billableLb: Dec): RateLookup | RateMiss {
  const serviceRows = rows.filter((r) => r.serviceId === serviceId);
  if (!serviceRows.length) return { ok: false, reason: "service_not_on_rate_card", message: "The rate card has no rows for this service." };

  let scoped: RateRow[] = [];
  let originScope: RateLookup["originScope"] = "any_origin";
  const origin5 = serviceRows.filter((r) => r.originPrefix === originZip);
  const origin3 = serviceRows.filter((r) => r.originPrefix === originZip.slice(0, 3));
  const anyOrigin = serviceRows.filter((r) => r.originPrefix === null);
  if (origin5.length) {
    scoped = origin5;
    originScope = "origin_5";
  } else if (origin3.length) {
    scoped = origin3;
    originScope = "origin_3";
  } else if (anyOrigin.length) {
    scoped = anyOrigin;
  } else {
    return { ok: false, reason: "no_rate_for_origin", message: `The rate card prices this service by origin and has no rates for origin ZIP ${originZip}.` };
  }

  const wantedZone = normalizeZone(zone);
  const zoneRows = scoped.filter((r) => normalizeZone(r.zone) === wantedZone);
  if (!zoneRows.length) {
    const zonesOffered = [...new Set(scoped.map((r) => normalizeZone(r.zone)))].sort();
    return { ok: false, reason: "no_rate_for_zone", message: `The rate card has no rates for zone ${wantedZone} on this service (zones covered: ${zonesOffered.join(", ")}).` };
  }

  const matches = zoneRows
    .map((row) => ({ row, w: fromLb(billableLb, row.weightUnit) }))
    .filter(({ row, w }) => w.greaterThan(dec(row.weightMin)) && w.lessThanOrEqualTo(dec(row.weightMax)))
    .sort((a, b) => dec(a.row.weightMax).comparedTo(dec(b.row.weightMax)));
  const best = matches[0];
  if (!best) {
    const maxRow = zoneRows.reduce((m, r) => (dec(r.weightMax).greaterThan(dec(m.weightMax)) ? r : m));
    const maxLb = maxRow.weightUnit === "oz" ? dec(maxRow.weightMax).div(16) : dec(maxRow.weightMax);
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
