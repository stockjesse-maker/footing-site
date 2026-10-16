import { compareZones } from "@/engine/forecast/grid";
import type { RateRow, ZoneRow } from "@/engine/types";
import { normalizeZone, resolveZone } from "@/engine/zones";

/**
 * Pure zone helpers for forecasts (Milestone 4, design §7): which zones a rate card prices for a
 * service from an origin, and one representative destination ZIP per zone. No I/O, no framework
 * imports: `zones.ts` (server-only) loads the rows and calls these, the unit tests call them directly.
 *
 * Representative ZIPs say "this zone is reachable from the origin on the carrier's zone chart" and give
 * a ZIP that resolves to it. They are never used to price a forecast cell by default: a ZIP picked for a
 * zone would decide delivery-area surcharges for one arbitrary address, so cells are priced by zone and
 * those surcharges stay "could not be decided" (design §10).
 */

/** The zone-independent services' zone: their rate rows carry "ALL". */
export const ALL_ZONES = "ALL";

/** A destination prefix as a 5-digit ZIP: "901" → "90100", "005" → "00500"; a 5-digit prefix is a ZIP already. */
export function prefixToZip(prefix: string): string {
  return prefix.length >= 5 ? prefix.slice(0, 5) : prefix.padEnd(5, "0");
}

/**
 * The representative destination ZIP of each zone on one carrier's zone chart, for an origin ZIP:
 * among the chart rows whose origin prefix the origin ZIP starts with, the lowest destination prefix of
 * the zone, padded to a 5-digit ZIP. A ZIP that a more specific row sends to another zone is skipped (the
 * next-lowest prefix of the zone is tried), so every ZIP returned resolves to its zone through the same
 * lookup the pricing engine uses. A zone with no such ZIP is left out.
 */
export function representativeZips(zones: ZoneRow[], carrierCode: string, zoneChartKey: string, originZip: string): Record<string, string> {
  const chart = zones.filter((z) => z.carrierCode === carrierCode && (z.zoneChartKey ?? "default") === zoneChartKey && originZip.startsWith(z.originPrefix));
  const candidates = new Map<string, Set<string>>();
  for (const row of chart) {
    const zone = normalizeZone(row.zone);
    const set = candidates.get(zone) ?? new Set<string>();
    set.add(prefixToZip(row.destPrefixFrom));
    candidates.set(zone, set);
  }
  const out: Record<string, string> = {};
  for (const zone of [...candidates.keys()].sort(compareZones)) {
    for (const zip of [...candidates.get(zone)!].sort()) {
      const lookup = resolveZone(zones, carrierCode, zoneChartKey, originZip, zip);
      if (lookup.ok && normalizeZone(lookup.zone.zone) === zone) {
        out[zone] = zip;
        break;
      }
    }
  }
  return out;
}

/** True when the zone chart has any row for the origin ZIP (a prefix of it), i.e. real shipments from there could be zoned. */
export function originOnChart(zones: ZoneRow[], carrierCode: string, zoneChartKey: string, originZip: string): boolean {
  return zones.some((z) => z.carrierCode === carrierCode && (z.zoneChartKey ?? "default") === zoneChartKey && originZip.startsWith(z.originPrefix));
}

export interface ZoneServiceRef {
  serviceId: string;
  zoneIndependent: boolean;
}

/**
 * The zones the rate card prices for each service from the origin, read from the rate rows: a row
 * applies when it has no origin prefix or the origin ZIP starts with it (`originZip` null = no origin
 * known yet: every row counts). Zone-independent services have the single zone "ALL". Zones are in
 * numeric-then-text order ("2" before "10").
 */
export function zonesFromRows(rows: Pick<RateRow, "serviceId" | "originPrefix" | "zone">[], originZip: string | null, services: ZoneServiceRef[]): Record<string, string[]> {
  const byService = new Map<string, Set<string>>();
  for (const row of rows) {
    if (originZip !== null && row.originPrefix !== null && !originZip.startsWith(row.originPrefix)) continue;
    const zone = normalizeZone(row.zone);
    if (zone === ALL_ZONES) continue;
    const set = byService.get(row.serviceId) ?? new Set<string>();
    set.add(zone);
    byService.set(row.serviceId, set);
  }
  const out: Record<string, string[]> = {};
  for (const s of services) out[s.serviceId] = s.zoneIndependent ? [ALL_ZONES] : [...(byService.get(s.serviceId) ?? [])].sort(compareZones);
  return out;
}
