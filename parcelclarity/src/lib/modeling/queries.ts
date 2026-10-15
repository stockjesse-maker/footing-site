import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BulkSummary } from "@/engine/modeling/types";
import type { CalculatorCard, CalculatorVersion } from "@/components/pricing/calculator-form";

/**
 * Read models for the modeling pages. Every query runs under the caller's Row Level Security;
 * these helpers only shape rows for the components and never widen what a user can see.
 */

interface AssignmentRow {
  rate_card_id: string;
  allowed_service_ids: string[] | null;
  default_origin_zip: string | null;
  rate_cards: { id: string; name: string; status: string } | null;
}

interface VersionRow {
  id: string;
  rate_card_id: string;
  version_number: number;
  status: string;
  effective_date: string | null;
  expiration_date: string | null;
}

interface TermRow {
  version_id: string;
  service_id: string;
  shipping_services: { carrier_code: string; code: string; name: string } | null;
}

export interface AssignedCards {
  cards: CalculatorCard[];
  /** Service options across the brand's cards (deduplicated), for the service-map and override selects. */
  services: { id: string; carrierCode: string; code: string; name: string }[];
  defaultOriginZip: string | null;
}

/** The rate cards actively assigned to a brand, with their active versions and the services the brand may use. */
export async function loadAssignedCards(supabase: SupabaseClient, brandId: string, tenantDefaultOriginZip: string | null): Promise<AssignedCards> {
  const { data: assignments } = await supabase
    .from("brand_rate_card_assignments")
    .select("rate_card_id, allowed_service_ids, default_origin_zip, rate_cards(id, name, status)")
    .eq("brand_id", brandId)
    .is("unassigned_at", null)
    .overrideTypes<AssignmentRow[], { merge: false }>();
  const active = (assignments ?? []).filter((a) => a.rate_cards && a.rate_cards.status === "active");
  if (!active.length) return { cards: [], services: [], defaultOriginZip: tenantDefaultOriginZip };
  const cardIds = active.map((a) => a.rate_card_id);
  const { data: versions } = await supabase
    .from("rate_card_versions")
    .select("id, rate_card_id, version_number, status, effective_date, expiration_date")
    .in("rate_card_id", cardIds)
    .eq("status", "active")
    .order("version_number", { ascending: false })
    .overrideTypes<VersionRow[], { merge: false }>();
  const versionIds = (versions ?? []).map((v) => v.id);
  const { data: terms } = versionIds.length
    ? await supabase.from("rate_card_service_terms").select("version_id, service_id, shipping_services(carrier_code, code, name)").in("version_id", versionIds).overrideTypes<TermRow[], { merge: false }>()
    : { data: [] as TermRow[] };

  const allowedByCard = new Map(active.map((a) => [a.rate_card_id, a.allowed_service_ids ? new Set(a.allowed_service_ids) : null]));
  const servicesByVersion = new Map<string, CalculatorVersion["services"]>();
  const seenServices = new Map<string, AssignedCards["services"][number]>();
  for (const t of terms ?? []) {
    if (!t.shipping_services) continue;
    const version = (versions ?? []).find((v) => v.id === t.version_id);
    const allowed = version ? allowedByCard.get(version.rate_card_id) : null;
    if (allowed && !allowed.has(t.service_id)) continue;
    const s = { serviceId: t.service_id, carrierCode: t.shipping_services.carrier_code, code: t.shipping_services.code, name: t.shipping_services.name };
    servicesByVersion.set(t.version_id, [...(servicesByVersion.get(t.version_id) ?? []), s]);
    seenServices.set(t.service_id, { id: t.service_id, carrierCode: s.carrierCode, code: s.code, name: s.name });
  }
  const cards: CalculatorCard[] = active.map((a) => ({
    id: a.rate_card_id,
    name: a.rate_cards!.name,
    versions: (versions ?? [])
      .filter((v) => v.rate_card_id === a.rate_card_id)
      .map((v) => ({ id: v.id, versionNumber: v.version_number, status: v.status, effectiveDate: v.effective_date, expirationDate: v.expiration_date, services: (servicesByVersion.get(v.id) ?? []).sort((x, y) => (x.name < y.name ? -1 : 1)) })),
  }));
  const services = [...seenServices.values()].sort((a, b) => (a.carrierCode < b.carrierCode ? -1 : a.carrierCode > b.carrierCode ? 1 : a.name < b.name ? -1 : 1));
  const defaultOriginZip = active.find((a) => a.default_origin_zip)?.default_origin_zip ?? tenantDefaultOriginZip;
  return { cards, services, defaultOriginZip };
}

export interface DatasetListRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  order_count: number;
  shipment_count: number;
  package_count: number;
  shared_with_brand: boolean;
}

export interface ProjectListRow {
  id: string;
  kind: "single" | "bulk";
  name: string;
  created_at: string;
  shared_with_brand: boolean;
  archived_at: string | null;
  dataset_id: string | null;
  rate_cards: { name: string } | null;
  order_datasets: { name: string } | null;
  simulation_runs: RunListRow[];
}

export interface RunListRow {
  id: string;
  status: string;
  kind: "single" | "bulk";
  pricing_basis: "ship_date" | "fixed_date";
  as_of_date: string | null;
  created_at: string;
  finished_at: string | null;
  last_progress_at: string;
  total_shipments: number;
  processed_shipments: number;
  modeled_orders: number | null;
  total_expected: string | number | null;
  summary: BulkSummary | null;
  service_override_id: string | null;
  assumptions: { residentialDefault?: boolean | null; originZipDefault?: string | null; overrideAllServices?: boolean } | null;
  shipping_services: { name: string } | null;
}

export async function loadModelingLists(supabase: SupabaseClient, brandId: string): Promise<{ datasets: DatasetListRow[]; projects: ProjectListRow[] }> {
  const [{ data: datasets }, { data: projects }] = await Promise.all([
    supabase.from("order_datasets").select("id, name, status, created_at, order_count, shipment_count, package_count, shared_with_brand").eq("brand_id", brandId).neq("status", "discarded").order("created_at", { ascending: false }).limit(50).overrideTypes<DatasetListRow[], { merge: false }>(),
    supabase
      .from("simulation_projects")
      .select("id, kind, name, created_at, shared_with_brand, archived_at, dataset_id, rate_cards(name), order_datasets(name), simulation_runs(id, status, kind, pricing_basis, as_of_date, created_at, finished_at, last_progress_at, total_shipments, processed_shipments, modeled_orders, total_expected, summary, service_override_id, assumptions, shipping_services(name))")
      .eq("brand_id", brandId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(50)
      .overrideTypes<ProjectListRow[], { merge: false }>(),
  ]);
  for (const p of projects ?? []) p.simulation_runs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { datasets: datasets ?? [], projects: projects ?? [] };
}

/** The most recent completed bulk run the viewer may see, for the headline figures. */
export function latestCompletedBulkRun(projects: ProjectListRow[]): { project: ProjectListRow; run: RunListRow } | null {
  let best: { project: ProjectListRow; run: RunListRow } | null = null;
  for (const project of projects) {
    for (const run of project.simulation_runs) {
      // A run in which nothing could be priced has no headline figure to show.
      if (run.kind !== "bulk" || run.status !== "completed" || !run.summary || !run.summary.modeled.orders) continue;
      if (!best || (run.finished_at ?? run.created_at) > (best.run.finished_at ?? best.run.created_at)) best = { project, run };
    }
  }
  return best;
}
