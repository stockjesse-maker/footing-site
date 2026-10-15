import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";

/** Carrier/service reference data as the import heuristics and forms consume it. */
export async function loadServiceCatalog(supabase: SupabaseClient): Promise<ServiceCatalogEntry[]> {
  const { data } = await supabase
    .from("shipping_services")
    .select("id, carrier_code, code, name, is_active, carriers(name)")
    .eq("is_active", true)
    .order("carrier_code")
    .order("name")
    .overrideTypes<{ id: string; carrier_code: string; code: string; name: string; carriers: { name: string } | null }[], { merge: false }>();
  return (data ?? []).map((s) => ({ id: s.id, carrierCode: s.carrier_code, carrierName: s.carriers?.name ?? s.carrier_code, code: s.code, name: s.name }));
}
