import type { CarrierCode, ZoneResult, ZoneRow } from "./types";

export type ZoneLookup = { ok: true; zone: ZoneResult } | { ok: false; reason: "no_chart" | "no_match" | "ambiguous"; message: string };

/**
 * Resolves a zone from the rate card's zone chart for the service's chart key.
 * Candidates are ordered deterministically: longer origin prefix first, then longer destination
 * prefix, then the narrower destination range. A destination matches a row when its first N digits
 * (N = the row's range length) fall inside [destPrefixFrom, destPrefixTo]. If the best candidates are
 * equally specific but name different zones the chart is ambiguous and no zone is returned.
 */
export function resolveZone(zones: ZoneRow[], carrierCode: CarrierCode, zoneChartKey: string, originZip: string, destinationZip: string): ZoneLookup {
  const chart = zones.filter((z) => z.carrierCode === carrierCode && (z.zoneChartKey ?? "default") === zoneChartKey);
  if (!chart.length) return { ok: false, reason: "no_chart", message: `The rate card has no "${zoneChartKey}" zone chart for ${carrierCode}.` };

  const matches = chart
    .filter((z) => originZip.startsWith(z.originPrefix) && (z.originPrefix.length === 5 || z.originPrefix.length === 3))
    .filter((z) => {
      const n = z.destPrefixFrom.length;
      const probe = destinationZip.slice(0, n);
      return probe.length === n && probe >= z.destPrefixFrom && probe <= z.destPrefixTo;
    })
    .sort((a, b) => b.originPrefix.length - a.originPrefix.length || b.destPrefixFrom.length - a.destPrefixFrom.length || rangeWidth(a) - rangeWidth(b) || a.zone.localeCompare(b.zone));
  const best = matches[0];
  if (!best) return { ok: false, reason: "no_match", message: `No zone chart row covers origin ${originZip} to destination ${destinationZip}.` };
  const peers = matches.filter((m) => m.originPrefix.length === best.originPrefix.length && m.destPrefixFrom.length === best.destPrefixFrom.length && rangeWidth(m) === rangeWidth(best));
  if (peers.some((m) => m.zone !== best.zone)) {
    return { ok: false, reason: "ambiguous", message: `The zone chart names different zones (${[...new Set(peers.map((p) => p.zone))].join(", ")}) for ${originZip} to ${destinationZip}; fix the chart.` };
  }
  return {
    ok: true,
    zone: {
      zone: best.zone,
      source: "zone_chart",
      explanation: `Zone ${best.zone} from the rate card zone chart: origin ${best.originPrefix} to destinations ${best.destPrefixFrom}–${best.destPrefixTo}.`,
    },
  };
}

function rangeWidth(z: ZoneRow): number {
  return Number(z.destPrefixTo) - Number(z.destPrefixFrom);
}

export function normalizeZone(zone: string): string {
  return zone.trim().toUpperCase().replace(/^ZONE\s*/, "");
}
