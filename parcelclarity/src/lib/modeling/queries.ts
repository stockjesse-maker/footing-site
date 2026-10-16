import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ForecastSummary } from "@/engine/forecast/types";
import type { BulkSummary, FeeStatus } from "@/engine/modeling/types";
import { D } from "@/engine/money";
import type { CalculatorCard, CalculatorVersion } from "@/components/pricing/calculator-form";
import { driverQuestions, loadBrandFeeSchedule, packagingTypes } from "@/lib/fees/queries";
import { scheduleReadsOrderContent, type RunSetupData, type RunSetupPeriod, type RunSetupSchedule } from "@/lib/modeling/assumptions";
import type { HeadlineBulkInput, HeadlineForecastInput, HeadlineInput } from "@/lib/modeling/headline";
import type { RunAssumptions } from "@/lib/modeling/run";

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
  kind: "single" | "bulk" | "forecast";
  name: string;
  created_at: string;
  shared_with_brand: boolean;
  archived_at: string | null;
  dataset_id: string | null;
  rate_cards: { name: string } | null;
  order_datasets: { name: string } | null;
  simulation_runs: RunListRow[];
}

/**
 * A run as the lists read it: the run's own columns and the headline inputs of its summary (never the whole
 * summary, whose breakdowns and, for a forecast, grid of cells can be large; see `SUMMARY_PARTS`). The pages
 * that need a whole summary (a run's own page, a comparison) read that run alone.
 */
export interface RunListRow {
  id: string;
  status: string;
  kind: "single" | "bulk" | "forecast";
  pricing_basis: "ship_date" | "fixed_date";
  as_of_date: string | null;
  created_at: string;
  finished_at: string | null;
  last_progress_at: string;
  total_shipments: number;
  processed_shipments: number;
  modeled_orders: number | null;
  total_expected: string | number | null;
  /**
   * The headline inputs of a file run's current (version 2) summary or of a forecast's; null while the run has no
   * summary, and for a summary of an older shape (a model priced before fulfillment fees existed).
   */
  summary: HeadlineInput | null;
  service_override_id: string | null;
  /** The only part of the run's assumptions the lists read: whether every shipment was priced on one chosen service (a what-if). */
  assumptions: { overrideAllServices?: boolean } | null;
  shipping_services: { name: string } | null;
}

// ---------------------------------------------------------------------------
// Lean summaries: the headline inputs, selected as JSON paths of `summary`
// ---------------------------------------------------------------------------
/**
 * The parts of a stored run summary the headline functions read, as `[column alias, path]`. A list selects each as
 * `alias:summary->path` (PostgREST returns the part of the document under the alias, null when the summary lacks
 * it), so the lists never transfer the whole summary. Both shapes are listed: a file run fills the first group, a
 * forecast the second. Adding a field to `HeadlineBulkInput` or `HeadlineForecastInput` means adding it here and in
 * `summaryFromColumns`.
 */
export const SUMMARY_PARTS = [
  ["s_version", "version"],
  ["s_basis", "basis"],
  ["s_imported", "imported"],
  ["s_modeled", "modeled"],
  ["s_coverage", "coverage"],
  ["s_averages", "averages"],
  ["s_feesMode", "fees->mode"],
  ["s_feesProcessing", "fees->processing"],
  ["s_feesCompleteness", "fees->completeness"],
  ["s_feesStatusCounts", "fees->statusCounts"],
  ["s_feesAssumed", "fees->assumed"],
  ["s_feesWarnings", "fees->warnings"],
  ["s_minimums", "minimums"],
  ["s_minimumStatus", "minimumStatus"],
  ["s_period", "period"],
  ["s_allocation", "allocation"],
  ["s_monthly", "monthly"],
  ["s_asOfDate", "asOfDate"],
  ["s_completeness", "completeness"],
  ["s_monthlyOrders", "monthlyOrders"],
  ["s_pricedSharePct", "pricedSharePct"],
  ["s_priceOnlyCovered", "priceOnlyCovered"],
  ["s_feeMode", "feeMode"],
  ["s_shippingPerOrder", "shipping->perOrder"],
  ["s_processingPerOrder", "processing->perOrder"],
] as const;

type SummaryColumn = (typeof SUMMARY_PARTS)[number][0];
export type SummaryColumns = Partial<Record<SummaryColumn, unknown>>;

/** The select list for the headline inputs of a run's summary. */
export const SUMMARY_HEADLINE_SELECT = SUMMARY_PARTS.map(([alias, path]) => `${alias}:summary->${path}`).join(", ");

/** The part of a run's assumptions the lists read, selected the same way. */
const ASSUMPTIONS_SELECT = "a_overrideAllServices:assumptions->overrideAllServices";

const RUN_LIST_COLUMNS = "id, status, kind, pricing_basis, as_of_date, created_at, finished_at, last_progress_at, total_shipments, processed_shipments, modeled_orders, total_expected, service_override_id, shipping_services(name)";

/**
 * Rebuilds the headline inputs from the selected columns: a forecast (`basis` "assumptions") or a file run's current
 * (version 2) summary; null for no summary, an older shape, or a document that lacks something the headline needs
 * (nothing is guessed). A whole `BulkSummary` or `ForecastSummary` is never involved.
 */
export function summaryFromColumns(c: SummaryColumns): HeadlineInput | null {
  if (c.s_basis === "assumptions") {
    if ([c.s_asOfDate, c.s_monthlyOrders, c.s_pricedSharePct, c.s_feeMode, c.s_completeness, c.s_minimums, c.s_minimumStatus, c.s_shippingPerOrder].some((v) => v === undefined || v === null)) return null;
    const forecast: HeadlineForecastInput = {
      version: 2,
      basis: "assumptions",
      asOfDate: c.s_asOfDate as HeadlineForecastInput["asOfDate"],
      monthlyOrders: c.s_monthlyOrders as HeadlineForecastInput["monthlyOrders"],
      pricedSharePct: c.s_pricedSharePct as HeadlineForecastInput["pricedSharePct"],
      priceOnlyCovered: c.s_priceOnlyCovered === true,
      feeMode: c.s_feeMode as HeadlineForecastInput["feeMode"],
      completeness: c.s_completeness as HeadlineForecastInput["completeness"],
      minimums: c.s_minimums as HeadlineForecastInput["minimums"],
      minimumStatus: c.s_minimumStatus as HeadlineForecastInput["minimumStatus"],
      allocation: (c.s_allocation ?? null) as HeadlineForecastInput["allocation"],
      monthly: (c.s_monthly ?? null) as HeadlineForecastInput["monthly"],
      shipping: { perOrder: c.s_shippingPerOrder as string },
      processing: c.s_processingPerOrder === null || c.s_processingPerOrder === undefined ? null : { perOrder: c.s_processingPerOrder as string },
    };
    return forecast;
  }
  if (c.s_version !== 2) return null;
  const required = [c.s_imported, c.s_modeled, c.s_coverage, c.s_averages, c.s_feesMode, c.s_feesProcessing, c.s_feesCompleteness, c.s_feesStatusCounts, c.s_feesAssumed, c.s_feesWarnings, c.s_minimums, c.s_minimumStatus, c.s_period];
  if (required.some((v) => v === undefined || v === null)) return null;
  const file: HeadlineBulkInput = {
    version: 2,
    imported: c.s_imported as HeadlineBulkInput["imported"],
    modeled: c.s_modeled as HeadlineBulkInput["modeled"],
    coverage: c.s_coverage as HeadlineBulkInput["coverage"],
    averages: c.s_averages as HeadlineBulkInput["averages"],
    fees: {
      mode: c.s_feesMode as HeadlineBulkInput["fees"]["mode"],
      processing: c.s_feesProcessing as HeadlineBulkInput["fees"]["processing"],
      completeness: c.s_feesCompleteness as HeadlineBulkInput["fees"]["completeness"],
      statusCounts: c.s_feesStatusCounts as HeadlineBulkInput["fees"]["statusCounts"],
      assumed: c.s_feesAssumed as HeadlineBulkInput["fees"]["assumed"],
      warnings: c.s_feesWarnings as HeadlineBulkInput["fees"]["warnings"],
    },
    minimums: c.s_minimums as HeadlineBulkInput["minimums"],
    minimumStatus: c.s_minimumStatus as HeadlineBulkInput["minimumStatus"],
    period: c.s_period as HeadlineBulkInput["period"],
    allocation: (c.s_allocation ?? null) as HeadlineBulkInput["allocation"],
    monthly: (c.s_monthly ?? null) as HeadlineBulkInput["monthly"],
  };
  return file;
}

type RunDbRow = Omit<RunListRow, "summary" | "assumptions"> & SummaryColumns & { a_overrideAllServices?: boolean | null };

interface ProjectDbRow extends Omit<ProjectListRow, "simulation_runs"> {
  simulation_runs: RunDbRow[];
}

/** One embedded run row (the run's columns plus the selected parts of its summary and assumptions) as a `RunListRow`. */
function runFromDb(row: RunDbRow): RunListRow {
  const base = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("s_") && !key.startsWith("a_"))) as Omit<RunListRow, "summary" | "assumptions">;
  return { ...base, summary: summaryFromColumns(row), assumptions: row.a_overrideAllServices === true ? { overrideAllServices: true } : null };
}

export async function loadModelingLists(supabase: SupabaseClient, brandId: string): Promise<{ datasets: DatasetListRow[]; projects: ProjectListRow[] }> {
  const [{ data: datasets }, { data: projects }] = await Promise.all([
    supabase.from("order_datasets").select("id, name, status, created_at, order_count, shipment_count, package_count, shared_with_brand").eq("brand_id", brandId).neq("status", "discarded").order("created_at", { ascending: false }).limit(50).overrideTypes<DatasetListRow[], { merge: false }>(),
    supabase
      .from("simulation_projects")
      .select(`id, kind, name, created_at, shared_with_brand, archived_at, dataset_id, rate_cards(name), order_datasets(name), simulation_runs(${RUN_LIST_COLUMNS}, ${ASSUMPTIONS_SELECT}, ${SUMMARY_HEADLINE_SELECT})`)
      .eq("brand_id", brandId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(50)
      .overrideTypes<ProjectDbRow[], { merge: false }>(),
  ]);
  const rows: ProjectListRow[] = (projects ?? []).map((p) => ({ ...p, simulation_runs: p.simulation_runs.map(runFromDb) }));
  for (const p of rows) p.simulation_runs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { datasets: datasets ?? [], projects: rows };
}

/** A what-if prices every shipment on one chosen service: it is a comparison, never the baseline. */
export function isWhatIf(run: Pick<RunListRow, "assumptions">): boolean {
  return run.assumptions?.overrideAllServices === true;
}

/**
 * The run's summary as a file run's current (version 2) summary; null for forecasts, single runs, older shapes or no
 * summary. A list row carries the headline inputs (`HeadlineBulkInput`), a run read whole carries a `BulkSummary`:
 * the same shape comes back.
 */
export function fileSummaryOf<S extends HeadlineInput>(run: { kind: string; summary: S | null }): Extract<S, { fees: unknown }> | null {
  const s = run.summary;
  if (run.kind !== "bulk" || !s || (s as { version?: number }).version !== 2 || (s as { basis?: string }).basis === "assumptions" || !(s as { fees?: unknown }).fees) return null;
  return s as Extract<S, { fees: unknown }>;
}

/** The run's summary as a forecast's (the headline inputs of one on a list row, a `ForecastSummary` when read whole); null otherwise. */
export function forecastSummaryOf<S extends HeadlineInput>(run: { kind: string; summary: S | null }): Extract<S, { basis: "assumptions" }> | null {
  const s = run.summary;
  return run.kind === "forecast" && s && (s as { basis?: string }).basis === "assumptions" ? (s as Extract<S, { basis: "assumptions" }>) : null;
}

/** A completed run read whole for a comparison: the whole summary and every assumption it was run with. */
export interface CompareRunRow {
  id: string;
  summary: BulkSummary | ForecastSummary;
  assumptions: RunAssumptions | null;
}

interface CompareDbRow {
  id: string;
  kind: "single" | "bulk" | "forecast";
  summary: BulkSummary | ForecastSummary | null;
  assumptions: RunAssumptions | null;
}

/**
 * The whole summaries and assumptions of the runs a comparison puts side by side, under the caller's Row Level
 * Security. Lists carry only headline inputs, so a comparison reads its two runs here. null when the read fails
 * or a run is missing or has no current summary: the page then says so rather than comparing less.
 */
export async function loadRunsForCompare(supabase: SupabaseClient, brandId: string, runIds: string[]): Promise<Map<string, CompareRunRow> | null> {
  const { data, error } = await supabase.from("simulation_runs").select("id, kind, summary, assumptions").eq("brand_id", brandId).in("id", runIds).overrideTypes<CompareDbRow[], { merge: false }>();
  if (error) return null;
  const rows = new Map<string, CompareRunRow>();
  for (const r of data ?? []) {
    if (!runIds.includes(r.id)) continue;
    const summary = fileSummaryOf(r) ?? forecastSummaryOf(r);
    if (summary) rows.set(r.id, { id: r.id, summary, assumptions: r.assumptions });
  }
  return runIds.every((id) => rows.has(id)) ? rows : null;
}

function newest<T extends { run: RunListRow }>(a: T | null, b: T): T {
  return !a || (b.run.finished_at ?? b.run.created_at) > (a.run.finished_at ?? a.run.created_at) ? b : a;
}

/**
 * The most recent completed orders-file run the viewer may see, for the headline figures. A run in which
 * nothing could be priced has no headline figure to show. `excludeWhatIf` skips runs that price every
 * shipment on one chosen service (they are shown as their own labelled tile).
 */
export function latestCompletedBulkRun(projects: ProjectListRow[], opts: { excludeWhatIf?: boolean } = {}): { project: ProjectListRow; run: RunListRow } | null {
  let best: { project: ProjectListRow; run: RunListRow } | null = null;
  for (const project of projects) {
    for (const run of project.simulation_runs) {
      if (run.status !== "completed" || !fileSummaryOf(run)?.modeled.orders) continue;
      if (opts.excludeWhatIf && isWhatIf(run)) continue;
      best = newest(best, { project, run });
    }
  }
  return best;
}

/** The latest completed what-if (every shipment priced on one chosen service). */
export function latestCompletedWhatIf(projects: ProjectListRow[]): { project: ProjectListRow; run: RunListRow } | null {
  let best: { project: ProjectListRow; run: RunListRow } | null = null;
  for (const project of projects) {
    for (const run of project.simulation_runs) {
      if (run.status !== "completed" || !fileSummaryOf(run)?.modeled.orders || !isWhatIf(run)) continue;
      best = newest(best, { project, run });
    }
  }
  return best;
}

/** The latest completed forecast from assumptions. */
export function latestCompletedForecast(projects: ProjectListRow[]): { project: ProjectListRow; run: RunListRow } | null {
  let best: { project: ProjectListRow; run: RunListRow } | null = null;
  for (const project of projects) {
    for (const run of project.simulation_runs) {
      if (run.kind !== "forecast" || run.status !== "completed" || !forecastSummaryOf(run)) continue;
      best = newest(best, { project, run });
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Run setup, step 2 "Fulfillment costs": what the form needs to ask
// ---------------------------------------------------------------------------
interface PeriodPayload {
  population?: number | null;
  dated?: number | null;
  undated?: number | null;
  from?: string | null;
  to?: string | null;
  days?: number | null;
  months?: number | string | null;
  inPeriod?: number | null;
  trimmed?: number | null;
}

function toPeriod(data: unknown): RunSetupPeriod | null {
  if (!data || typeof data !== "object") return null;
  const p = data as PeriodPayload;
  return {
    population: Number(p.population ?? 0),
    dated: Number(p.dated ?? 0),
    undated: Number(p.undated ?? 0),
    from: p.from ?? null,
    to: p.to ?? null,
    days: p.days === null || p.days === undefined ? null : Number(p.days),
    months: p.months === null || p.months === undefined ? null : String(p.months),
    inPeriod: Number(p.inPeriod ?? 0),
    trimmed: Number(p.trimmed ?? 0),
  };
}

interface DatasetSetupRow {
  line_count: number | null;
  validation: { counts?: { lines?: number; units?: number } } | null;
}

/**
 * Everything run setup step 2 asks and explains, read under the caller's Row Level Security:
 * the file's forecast period (`dataset_forecast_period`, computed in SQL and never recomputed here), the
 * fee schedule version in effect on `date` (today by default) for the brand (`brand_fee_schedule_on`) as customer-safe questions and
 * packaging types (no rule keys, ids, version numbers, notes or sources), and what the file does and
 * does not say about item counts, line data and packaging. A query that fails is reported as such (a
 * null period, an `unavailable` schedule), never as "no fees" or "no data".
 */
export async function loadRunSetupData(supabase: SupabaseClient, brandId: string, datasetId: string, date: string = new Date().toISOString().slice(0, 10)): Promise<RunSetupData> {
  const [periodResult, schedule, datasetResult, untypedResult] = await Promise.all([
    supabase.rpc("dataset_forecast_period", { p_dataset: datasetId }),
    loadBrandFeeSchedule(supabase, brandId, date),
    supabase.from("order_datasets").select("line_count, validation").eq("id", datasetId).eq("brand_id", brandId).maybeSingle().overrideTypes<DatasetSetupRow, { merge: false }>(),
    supabase.from("packages").select("id").eq("dataset_id", datasetId).is("packaging_type", null).limit(1),
  ]);

  let setupSchedule: RunSetupSchedule;
  switch (schedule.status) {
    case "no_schedule":
      setupSchedule = { status: "none" };
      break;
    case "not_effective":
      setupSchedule = { status: "not_effective", name: schedule.schedule.name };
      break;
    case "ok":
      setupSchedule = {
        status: "ok",
        name: schedule.schedule.name,
        effectiveDate: schedule.activeVersion.effectiveDate,
        questions: driverQuestions(schedule.activeVersion),
        packagingTypes: packagingTypes(schedule.activeVersion),
        readsOrderContent: scheduleReadsOrderContent(schedule.activeVersion),
      };
      break;
    default:
      setupSchedule = { status: "unavailable" };
  }

  const counts = datasetResult.data?.validation?.counts;
  return {
    date,
    period: periodResult.error ? null : toPeriod(periodResult.data),
    schedule: setupSchedule,
    hasUnits: Number(counts?.units ?? 0) > 0,
    hasLines: Number(counts?.lines ?? datasetResult.data?.line_count ?? 0) > 0,
    // When the check cannot be made the question is asked: an optional default is harmless, a silently missing one is not.
    untypedPackages: untypedResult.error ? true : (untypedResult.data?.length ?? 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// Results of a fee-aware run: orders, fee contexts, the fee schedule today
// ---------------------------------------------------------------------------
/** One order of a run with its fee result (`simulation_order_results`), as stored: amounts in ten-thousandths of a dollar. */
export interface OrderResultRow {
  orderId: string;
  externalOrderId: string;
  orderDate: string | null;
  firstRowNo: number;
  /** null = the file has no such figure (shown as unknown, never 0). */
  units: number | null;
  lines: number | null;
  packages: number;
  shipments: number;
  /** Which figures came from the typical order the customer described rather than from the file. */
  assumed: { units?: boolean; lines?: boolean; skus?: boolean; packaging?: boolean };
  feeStatus: FeeStatus;
  definiteE4: number;
  estimatedE4: number;
  unresolved: { ruleKey: string; reason: string; replacedBy?: string }[];
  inTotals: boolean;
}

interface OrderResultDbRow {
  order_id: string;
  first_row_no: number | string;
  units: number | null;
  lines: number | null;
  packages: number;
  shipments: number;
  assumed: OrderResultRow["assumed"] | null;
  fee_status: FeeStatus;
  processing_definite: number | string;
  processing_estimated: number | string;
  unresolved: OrderResultRow["unresolved"] | null;
  in_totals: boolean;
  orders: { external_order_id: string; order_date: string | null } | null;
}

/**
 * A page of the run's orders in file order, under the caller's Row Level Security. `error` is set when the
 * read fails: the page then says so rather than showing an empty table.
 */
export async function loadOrderResults(supabase: SupabaseClient, runId: string, range: { from: number; to: number }): Promise<{ rows: OrderResultRow[]; count: number | null; error: string | null }> {
  const { data, error, count } = await supabase
    .from("simulation_order_results")
    .select("order_id, first_row_no, units, lines, packages, shipments, assumed, fee_status, processing_definite, processing_estimated, unresolved, in_totals, orders(external_order_id, order_date)", { count: "exact" })
    .eq("run_id", runId)
    .order("first_row_no")
    .range(range.from, range.to)
    .overrideTypes<OrderResultDbRow[], { merge: false }>();
  if (error) return { rows: [], count: null, error: error.message };
  return {
    count,
    error: null,
    rows: (data ?? []).map((r) => ({
      orderId: r.order_id,
      externalOrderId: r.orders?.external_order_id ?? "—",
      orderDate: r.orders?.order_date ?? null,
      firstRowNo: Number(r.first_row_no),
      units: r.units,
      lines: r.lines,
      packages: r.packages,
      shipments: r.shipments,
      assumed: r.assumed ?? {},
      feeStatus: r.fee_status,
      definiteE4: Number(r.processing_definite),
      estimatedE4: Number(r.processing_estimated),
      unresolved: r.unresolved ?? [],
      inTotals: r.in_totals,
    })),
  };
}

/** The expected shipping of each order (exact decimal text) when every one of its shipments priced; null when any did not. */
export type OrderShipping = Map<string, { expected: string | null }>;

interface OrderShipmentDbRow {
  order_id: string;
  status: "ok" | "unavailable";
  expected: string | number;
}

/** Order ids travel in the request URL: 100 of them stay far below any URL limit. */
const SHIPPING_CHUNK = 100;
/** Rows per read; the server may cap a read, so a short page is the only sign of the end. */
const SHIPPING_PAGE = 1000;
/** Chunks read at the same time. */
const SHIPPING_PARALLEL = 4;

async function readShippingChunk(supabase: SupabaseClient, runId: string, orderIds: string[]): Promise<{ rows: OrderShipmentDbRow[]; error: string | null }> {
  const rows: OrderShipmentDbRow[] = [];
  for (let from = 0; ; from += SHIPPING_PAGE) {
    const { data, error } = await supabase
      .from("simulation_results")
      .select("order_id, status, expected")
      .eq("run_id", runId)
      .in("order_id", orderIds)
      .order("row_no")
      .range(from, from + SHIPPING_PAGE - 1)
      .overrideTypes<OrderShipmentDbRow[], { merge: false }>();
    if (error) return { rows: [], error: error.message };
    rows.push(...(data ?? []));
    if (!data || data.length < SHIPPING_PAGE) return { rows, error: null };
  }
}

/**
 * Shipping per order for a set of orders, summed from the stored shipment results (decimal arithmetic, no
 * floats). An order with any unpriced shipment has no shipping figure: it is not shown as a partial sum.
 * The ids are read in chunks (and each chunk page by page), so a page of the screen and a 1,000-order page of
 * an export use the same function.
 */
export async function loadOrderShipping(supabase: SupabaseClient, runId: string, orderIds: string[]): Promise<{ shipping: OrderShipping; error: string | null }> {
  const shipping: OrderShipping = new Map();
  if (!orderIds.length) return { shipping, error: null };
  const chunks: string[][] = [];
  for (let i = 0; i < orderIds.length; i += SHIPPING_CHUNK) chunks.push(orderIds.slice(i, i + SHIPPING_CHUNK));
  const sums = new Map<string, { total: InstanceType<typeof D>; ok: boolean }>();
  for (let i = 0; i < chunks.length; i += SHIPPING_PARALLEL) {
    const results = await Promise.all(chunks.slice(i, i + SHIPPING_PARALLEL).map((ids) => readShippingChunk(supabase, runId, ids)));
    for (const result of results) {
      if (result.error) return { shipping, error: result.error };
      for (const r of result.rows) {
        const entry = sums.get(r.order_id) ?? { total: new D(0), ok: true };
        if (r.status === "ok") entry.total = entry.total.plus(String(r.expected));
        else entry.ok = false;
        sums.set(r.order_id, entry);
      }
    }
  }
  for (const [orderId, entry] of sums) shipping.set(orderId, { expected: entry.ok ? entry.total.toFixed(2) : null });
  return { shipping, error: null };
}

/** Which fee schedule version priced which dates of a run, and the dates no version covered. */
export interface RunFeeContexts {
  /** Versions the run priced orders with, with the dates they were in effect (null when the viewer may no longer read the version). */
  versions: { versionId: string; effectiveDate: string | null; expirationDate: string | null }[];
  /** Fee dates on which the brand had no fee schedule or none was in effect, as a range with a count of distinct dates. */
  uncovered: { from: string; to: string; dates: number } | null;
}

interface FeeContextDbRow {
  fee_date: string;
  fee_schedule_version_id: string | null;
  unavailable_reason: "no_schedule" | "not_effective" | null;
}

/** `simulation_run_fee_contexts` of a run plus the effective dates of the versions it names; null when a read fails. */
export async function loadRunFeeContexts(supabase: SupabaseClient, runId: string): Promise<RunFeeContexts | null> {
  const { data, error } = await supabase.from("simulation_run_fee_contexts").select("fee_date, fee_schedule_version_id, unavailable_reason").eq("run_id", runId).order("fee_date").overrideTypes<FeeContextDbRow[], { merge: false }>();
  if (error) return null;
  const rows = data ?? [];
  const versionIds = [...new Set(rows.map((r) => r.fee_schedule_version_id).filter((id): id is string => id !== null))];
  let dates = new Map<string, { effective_date: string | null; expiration_date: string | null }>();
  if (versionIds.length) {
    const { data: versions } = await supabase.from("fee_schedule_versions").select("id, effective_date, expiration_date").in("id", versionIds);
    dates = new Map((versions ?? []).map((v) => [String(v.id), { effective_date: (v.effective_date as string | null) ?? null, expiration_date: (v.expiration_date as string | null) ?? null }] as const));
  }
  const missing = rows.filter((r) => r.fee_schedule_version_id === null).map((r) => r.fee_date);
  return {
    versions: versionIds
      .map((versionId) => ({ versionId, effectiveDate: dates.get(versionId)?.effective_date ?? null, expirationDate: dates.get(versionId)?.expiration_date ?? null }))
      .sort((a, b) => (a.effectiveDate ?? "") .localeCompare(b.effectiveDate ?? "")),
    uncovered: missing.length ? { from: missing[0]!, to: missing[missing.length - 1]!, dates: missing.length } : null,
  };
}

/**
 * The fee schedule version in effect for the customer today, for the "Fees have changed since this model
 * was priced" notice. `unknown` when the lookup fails (never reported as a change).
 */
export async function loadCurrentFeeVersion(supabase: SupabaseClient, brandId: string): Promise<{ status: "ok"; versionId: string } | { status: "none" | "unknown" }> {
  const result = await loadBrandFeeSchedule(supabase, brandId);
  if (result.status === "ok") return { status: "ok", versionId: result.activeVersion.versionId };
  if (result.status === "no_schedule" || result.status === "not_effective") return { status: "none" };
  return { status: "unknown" };
}

/** Who entered the assumptions of a run, from the viewer's side. */
export type AssumptionsAuthor = "you" | "tenant" | "other";

/**
 * "Assumptions entered by you / by {tenant} / by another user". The viewer's own runs are "you". For anyone
 * else the answer needs the memberships of the run's customer, which only a viewer who may see members can
 * read: when the creator is not a member of the customer the run was prepared by the 3PL's team ("tenant");
 * when the viewer cannot tell (no permission, or the read fails) the honest answer is "another user", never a guess.
 */
export async function loadAssumptionsAuthor(supabase: SupabaseClient, input: { createdBy: string | null; viewerId: string; viewerCanSeeMembers: boolean; brandId: string }): Promise<AssumptionsAuthor> {
  if (!input.createdBy) return "other";
  if (input.createdBy === input.viewerId) return "you";
  if (!input.viewerCanSeeMembers) return "other";
  const { data, error } = await supabase.from("memberships").select("id").eq("user_id", input.createdBy).eq("brand_id", input.brandId).limit(1);
  if (error) return "other";
  return (data?.length ?? 0) > 0 ? "other" : "tenant";
}
