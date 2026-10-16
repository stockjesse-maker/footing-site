import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { allInAtVolumes, validateForecastAssumptions, type ForecastAssumptions, type ForecastSummary, type ForecastVolumePoint } from "@/engine/forecast";
import { forecastHeadline, notIncludedItems, scrubForecast, type Audience, type ForecastResultData } from "@/components/forecast/result-model";
import type { ForecastContext, ForecastContextResult, ForecastScheduleContext, ForecastServiceOption } from "@/components/forecast/forecast-model";
import { loadBrandFeeSchedule, driverQuestions } from "@/lib/fees/queries";
import { loadForecastZones, type ZoneServiceChart } from "@/lib/forecast/zones";
import { formatDate } from "@/lib/format/date";
import { scheduleReadsOrderContent } from "@/lib/modeling/assumptions";
import { boxOptionsFromSnapshot } from "@/lib/pricing/calculator-schema";
import { loadServiceTerms, resolveVersion } from "@/lib/pricing/snapshot";

/**
 * Read models for forecasts from assumptions (Milestone 4, design §7): what the form needs to ask
 * (services, zones, fee schedule questions), and saved forecasts. Every query runs under the caller's
 * Row Level Security; these helpers only shape rows and never widen what a user can see. A query that
 * fails is a failure the page reports, never "no services", "no zones" or "no fees".
 */

const ZIP = /^\d{5}$/;

interface AssignmentRow {
  rate_card_id: string;
  allowed_service_ids: string[] | null;
  default_origin_zip: string | null;
  rate_cards: { id: string; name: string; status: string } | null;
}

export interface ForecastContextInput {
  brandId: string;
  tenantDefaultOriginZip: string | null;
  /** The rate card to price on; the brand's first (by name) when absent or not assigned. */
  rateCardId?: string | null;
  asOfDate: string;
  /** The ship-from ZIP; the brand's default, then the tenant's, when absent or not a 5-digit ZIP. */
  originZip?: string | null;
}

function scheduleContext(schedule: Awaited<ReturnType<typeof loadBrandFeeSchedule>>): ForecastScheduleContext {
  switch (schedule.status) {
    case "no_schedule":
      return { status: "none" };
    case "not_effective":
      return { status: "not_effective", name: schedule.schedule.name };
    case "ok": {
      const box = boxOptionsFromSnapshot(schedule.activeVersion);
      return {
        status: "ok",
        name: schedule.schedule.name,
        effectiveDate: schedule.activeVersion.effectiveDate,
        questions: driverQuestions(schedule.activeVersion),
        packaging: box.packaging,
        allowOtherPackaging: box.allowOtherPackaging,
        readsOrderContent: scheduleReadsOrderContent(schedule.activeVersion),
      };
    }
    default:
      return { status: "unavailable" };
  }
}

/**
 * Everything the forecast form asks about, for one rate card, date and ship-from ZIP: the services the
 * brand may use with the zones the rate card prices for each, the fee schedule in effect on the date
 * (questions, packaging types) and notes about the origin. Loaded again by the form when the date,
 * origin or rate card changes, because each can change what there is to choose from.
 */
export async function loadForecastContext(supabase: SupabaseClient, input: ForecastContextInput): Promise<ForecastContextResult> {
  const { data, error } = await supabase
    .from("brand_rate_card_assignments")
    .select("rate_card_id, allowed_service_ids, default_origin_zip, rate_cards(id, name, status)")
    .eq("brand_id", input.brandId)
    .is("unassigned_at", null)
    .overrideTypes<AssignmentRow[], { merge: false }>();
  if (error) return { status: "failed", message: "Your rate card could not be loaded. Reload the page to try again." };
  const assignments = (data ?? []).filter((a) => a.rate_cards && a.rate_cards.status === "active").sort((a, b) => a.rate_cards!.name.localeCompare(b.rate_cards!.name));
  const cards = assignments.map((a) => ({ id: a.rate_card_id, name: a.rate_cards!.name }));
  const assignment = assignments.find((a) => a.rate_card_id === input.rateCardId) ?? assignments[0];
  if (!assignment) return { status: "no_card" };
  const card = assignment.rate_cards!;

  const resolved = await resolveVersion(supabase, card.id, input.asOfDate);
  if (!resolved.ok) {
    if (resolved.error === "load_failed") return { status: "failed", message: "Your rate card could not be loaded. Reload the page to try again." };
    return { status: "no_rates", cards, message: `${card.name} has no rates in effect on ${formatDate(input.asOfDate)}. Choose another date.` };
  }
  const version = resolved.version;

  const allowed = assignment.allowed_service_ids?.length ? new Set(assignment.allowed_service_ids) : null;
  let terms: Awaited<ReturnType<typeof loadServiceTerms>>;
  try {
    terms = (await loadServiceTerms(supabase, version.id)).filter((t) => !allowed || allowed.has(t.serviceId));
  } catch {
    return { status: "failed", message: "Your rate card could not be loaded. Reload the page to try again." };
  }

  const originZip = input.originZip && ZIP.test(input.originZip) ? input.originZip : (assignment.default_origin_zip ?? input.tenantDefaultOriginZip ?? "");
  const charts: ZoneServiceChart[] = terms.map((t) => ({ serviceId: t.serviceId, zoneIndependent: t.zoneIndependent, carrierCode: t.carrierCode, zoneChartKey: t.zoneChartKey }));
  const [zones, schedule] = await Promise.all([loadForecastZones(supabase, version.id, ZIP.test(originZip) ? originZip : null, charts), loadBrandFeeSchedule(supabase, input.brandId, input.asOfDate)]);
  if (!zones.ok) return { status: "failed", message: "The zones on your rate card could not be loaded. Reload the page to try again." };
  if (schedule.status === "not_found") return { status: "failed", message: "This customer could not be found." };

  const services: ForecastServiceOption[] = terms.map((t) => ({
    serviceId: t.serviceId,
    carrierCode: t.carrierCode,
    serviceCode: t.serviceCode,
    name: t.serviceName,
    zoneIndependent: t.zoneIndependent,
    dimExempt: t.dim.exempt,
    zones: zones.data.zonesByService[t.serviceId] ?? [],
  }));
  const warnings = zones.data.originNotOnChart.map((id) => {
    const name = services.find((s) => s.serviceId === id)?.name ?? "A service";
    return `${name}: ZIP code ${originZip} is not on the zone chart of this rate card, so real shipments from it could not be zoned and priced. Check the ZIP code you ship from.`;
  });
  const context: ForecastContext = {
    status: "ok",
    asOfDate: input.asOfDate,
    originZip,
    rateCard: { id: card.id, name: card.name, effectiveDate: version.effectiveDate, expirationDate: version.expirationDate },
    cards,
    services,
    schedule: scheduleContext(schedule),
    warnings,
  };
  return context;
}

// ---------------------------------------------------------------------------
// Result data (shared by the preview action and the saved page)
// ---------------------------------------------------------------------------
/** The headline, the not-included list and the sensitivity row from the unscrubbed summary (they read rule keys), then the summary scrubbed for the viewer. */
export function forecastResultData(summary: ForecastSummary, audience: Audience): ForecastResultData {
  const items = notIncludedItems(summary);
  const headline = forecastHeadline(summary, items);
  let sensitivity: ForecastVolumePoint[] = [];
  try {
    sensitivity = allInAtVolumes(summary);
  } catch {
    sensitivity = [];
  }
  return { summary: scrubForecast(summary, audience), headline, sensitivity };
}

// ---------------------------------------------------------------------------
// Saved forecasts
// ---------------------------------------------------------------------------
export interface SavedForecast {
  projectId: string;
  runId: string;
  name: string;
  createdAt: string;
  sharedWithBrand: boolean;
  archivedAt: string | null;
  /** The rate card the forecast was priced on (an edit starts from it while it is still assigned). */
  rateCardId: string | null;
  rateCardName: string | null;
  asOfDate: string;
  summary: ForecastSummary;
  /** The assumptions as saved, when they still validate (they prefill "Edit as new forecast"); null otherwise. */
  assumptions: ForecastAssumptions | null;
}

interface SavedRow {
  id: string;
  name: string;
  created_at: string;
  shared_with_brand: boolean;
  archived_at: string | null;
  rate_card_id: string | null;
  rate_cards: { name: string } | null;
  simulation_runs: { id: string; kind: string; status: string; as_of_date: string | null; created_at: string; summary: unknown; assumptions: unknown }[];
}

function isForecastSummary(value: unknown): value is ForecastSummary {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<ForecastSummary>;
  return s.basis === "assumptions" && s.version === 2 && typeof s.monthlyOrders === "string" && !!s.shipping && !!s.profile && Array.isArray(s.caveats) && Array.isArray(s.completeness);
}

/** One saved forecast of the brand, or null when it does not exist, is not a forecast or the caller may not see it. A failed query throws (the page shows its error state, never "not found"). */
export async function loadSavedForecast(supabase: SupabaseClient, brandId: string, projectId: string): Promise<SavedForecast | null> {
  const { data, error } = await supabase
    .from("simulation_projects")
    .select("id, name, created_at, shared_with_brand, archived_at, rate_card_id, rate_cards(name), simulation_runs(id, kind, status, as_of_date, created_at, summary, assumptions)")
    .eq("id", projectId)
    .eq("brand_id", brandId)
    .eq("kind", "forecast")
    .maybeSingle()
    .overrideTypes<SavedRow, { merge: false }>();
  if (error) throw new Error(`the forecast could not be loaded: ${error.message}`);
  if (!data) return null;
  const run = [...data.simulation_runs].filter((r) => r.kind === "forecast" && r.status === "completed" && isForecastSummary(r.summary)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  if (!run) return null;
  const summary = run.summary as ForecastSummary;
  const assumptions = validateForecastAssumptions(run.assumptions).length === 0 ? (run.assumptions as ForecastAssumptions) : null;
  return {
    projectId: data.id,
    runId: run.id,
    name: data.name,
    createdAt: data.created_at,
    sharedWithBrand: data.shared_with_brand,
    archivedAt: data.archived_at,
    rateCardId: data.rate_card_id ?? null,
    rateCardName: data.rate_cards?.name ?? null,
    asOfDate: run.as_of_date ?? summary.asOfDate,
    summary,
    assumptions,
  };
}
