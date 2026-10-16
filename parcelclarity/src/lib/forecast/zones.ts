import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RateRow, ZoneRow } from "@/engine/types";
import { originOnChart, representativeZips, zonesFromRows, type ZoneServiceRef } from "@/lib/forecast/zone-model";

/**
 * Zone data for forecasts, read under the caller's Row Level Security (a brand member reads only the
 * versions of the cards assigned to the brand). A failed read is reported as a failure, never as "no
 * zones": the form would otherwise offer nothing to choose and say so as if the card were empty.
 */

export interface ZoneServiceChart extends ZoneServiceRef {
  carrierCode: string;
  zoneChartKey: string;
}

export interface ForecastZoneData {
  /** Service id → the zones its rate rows price from the origin ("ALL" for zone-independent services). */
  zonesByService: Record<string, string[]>;
  /** Service id → zone → representative destination ZIP (zone-dependent services only; see `zone-model.ts`). */
  zipsByService: Record<string, Record<string, string>>;
  /** Service ids whose carrier's zone chart has no entry for the origin. */
  originNotOnChart: string[];
}

/** One representative destination ZIP per zone for the origin, per service (the lowest destination prefix of each zone, padded to 5 digits). */
export async function loadZoneZips(supabase: SupabaseClient, versionId: string, originZip: string, services: ZoneServiceChart[]): Promise<{ ok: true; zips: ForecastZoneData["zipsByService"]; originNotOnChart: string[] } | { ok: false }> {
  const { data, error } = await supabase.rpc("rate_card_zones_json", { p_version: versionId });
  if (error) return { ok: false };
  return { ok: true, ...zipsFrom((data ?? []) as ZoneRow[], originZip, services) };
}

function zipsFrom(zones: ZoneRow[], originZip: string, services: ZoneServiceChart[]): { zips: ForecastZoneData["zipsByService"]; originNotOnChart: string[] } {
  const zips: ForecastZoneData["zipsByService"] = {};
  const originNotOnChart: string[] = [];
  for (const s of services) {
    if (s.zoneIndependent) continue;
    zips[s.serviceId] = representativeZips(zones, s.carrierCode, s.zoneChartKey, originZip);
    if (!originOnChart(zones, s.carrierCode, s.zoneChartKey, originZip)) originNotOnChart.push(s.serviceId);
  }
  return { zips, originNotOnChart };
}

/** The zones available per service from the rate card's rows, and the representative ZIPs, for one rate card version and origin (null = no origin known yet). */
export async function loadForecastZones(supabase: SupabaseClient, versionId: string, originZip: string | null, services: ZoneServiceChart[]): Promise<{ ok: true; data: ForecastZoneData } | { ok: false }> {
  const [rowsResult, zonesResult] = await Promise.all([
    supabase.rpc("rate_card_rows_json", { p_version: versionId, p_service_ids: services.map((s) => s.serviceId) }),
    supabase.rpc("rate_card_zones_json", { p_version: versionId }),
  ]);
  if (rowsResult.error || zonesResult.error) return { ok: false };
  const zonesByService = zonesFromRows((rowsResult.data ?? []) as RateRow[], originZip, services);
  // Without a known origin there is no chart lookup to make: zones come from the rate rows alone.
  const charts = originZip === null ? { zips: {}, originNotOnChart: [] } : zipsFrom((zonesResult.data ?? []) as ZoneRow[], originZip, services);
  return { ok: true, data: { zonesByService, zipsByService: charts.zips, originNotOnChart: charts.originNotOnChart } };
}
