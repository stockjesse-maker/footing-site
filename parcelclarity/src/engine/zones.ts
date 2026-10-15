import type { CarrierCode, ZoneResult, ZoneRow } from "./types";

/**
 * Resolves a zone from the rate card's own zone chart.
 * Matching: origin rows for the 5-digit prefix win over 3-digit; within those, a destination
 * matches when its first N digits (N = length of the row's range bounds) fall inside
 * [destPrefixFrom, destPrefixTo] as same-length strings; 5-digit ranges beat 3-digit ranges.
 */
export function resolveZone(zones: ZoneRow[], carrierCode: CarrierCode, originZip: string, destinationZip: string): ZoneResult | null {
  const candidates = zones.filter((z) => z.carrierCode === carrierCode);
  if (!candidates.length) return null;
  for (const originPrefix of [originZip, originZip.slice(0, 3)]) {
    const rows = candidates.filter((z) => z.originPrefix === originPrefix);
    if (!rows.length) continue;
    const matches = rows.filter((z) => {
      const n = z.destPrefixFrom.length;
      const probe = destinationZip.slice(0, n);
      return probe.length === n && probe >= z.destPrefixFrom && probe <= z.destPrefixTo;
    });
    if (!matches.length) continue;
    const best = matches.sort((a, b) => b.destPrefixFrom.length - a.destPrefixFrom.length)[0]!;
    return {
      zone: best.zone,
      source: "zone_chart",
      explanation: `Zone ${best.zone} from the rate card zone chart: origin ${originPrefix} to destinations ${best.destPrefixFrom}–${best.destPrefixTo}.`,
    };
  }
  return null;
}

export function normalizeZone(zone: string): string {
  return zone.trim().toUpperCase().replace(/^ZONE\s*/, "");
}
