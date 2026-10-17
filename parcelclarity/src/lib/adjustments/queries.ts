import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { resolveHandling } from "@/engine/adjustments/policy";
import type { HistoryBaseline, HistoryRecord, PolicyRow, PolicyType } from "@/engine/adjustments/types";
import { requireBrandContext } from "@/lib/auth/session";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { createClient } from "@/lib/supabase/server";
import type { ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";
import { POLICY_CELLS, dollarsToE4, todayIso, type ExampleListItem, type ExampleState, type PolicyRecord, type RiskRunVolume } from "./action-schemas";
import { detectAdjustmentFile } from "./mapping";
import { parseStoredMapping } from "./mapping-schema";
import { parseAdjustmentFile } from "./parse";
import { adjustmentRecordKey } from "./validate";
import type { AdjustmentDetection, AdjustmentMapping, BrandOption } from "./types";

/**
 * Read models for the adjustment module (Milestone 5). Every query runs under the CALLER's Row Level Security: the M5 tables are
 * staff-only (a customer has no policy and no grant on any of them), and every query also names the tenant the session is acting
 * in, so a user who belongs to two accounts only ever reads the one they are in. The shapes are lean: wide JSON (a saved result,
 * a stored mapping, a published payload) is selected only by the detail loaders that need it, and history records come through the
 * database's bulk reader, never `select *`.
 *
 * The one thing a customer may read is `brand_adjustment_examples`, called by `loadBrandExamples`. It never selects an M5 table.
 * A load that fails throws (or, for the customer page, says so); it is never reported as "nothing there".
 */

const PAGE = 1000;

/** A query that failed is an error, never an empty list. */
function failed(what: string, error: { message: string }): never {
  throw new Error(`${what} could not be loaded: ${error.message}`);
}

/** Every row of a query, one Data API page (1,000 rows) at a time in a stable order. */
async function pageAll<T>(what: string, page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) failed(what, error);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

const num = (v: string | number | null | undefined): string | null => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export interface AdjustmentBrand extends BrandOption {
  status: string;
}

export async function loadAdjustmentBrands(supabase: SupabaseClient, tenantId: string): Promise<AdjustmentBrand[]> {
  const rows = await pageAll<{ id: string; name: string; status: string }>("customers", (from, to) => supabase.from("brands").select("id, name, status").eq("tenant_id", tenantId).order("name").order("id").range(from, to).overrideTypes<{ id: string; name: string; status: string }[], { merge: false }>());
  return rows.map((b) => ({ id: b.id, name: b.name, status: b.status }));
}

// ---------------------------------------------------------------------------
// Policies and baselines
// ---------------------------------------------------------------------------
interface PolicyDbRow {
  id: string;
  brand_id: string | null;
  adjustment_type: PolicyType;
  component: PolicyRecord["component"];
  handling: PolicyRecord["handling"];
  valid_from: string;
  valid_to: string | null;
  internal_note: string | null;
  created_at: string;
}

/** Every decision of the account, newest first (ended ones included, so the screen can show what applied when). */
export async function loadPolicies(supabase: SupabaseClient, tenantId: string): Promise<PolicyRecord[]> {
  const rows = await pageAll<PolicyDbRow>("decisions on who pays", (from, to) =>
    supabase
      .from("adjustment_policies")
      .select("id, brand_id, adjustment_type, component, handling, valid_from, valid_to, internal_note, created_at")
      .eq("tenant_id", tenantId)
      .order("valid_from", { ascending: false })
      .order("id")
      .range(from, to)
      .overrideTypes<PolicyDbRow[], { merge: false }>(),
  );
  return rows.map((r) => ({ id: r.id, brandId: r.brand_id, adjustmentType: r.adjustment_type, component: r.component, handling: r.handling, validFrom: r.valid_from, validTo: r.valid_to, internalNote: r.internal_note, createdAt: r.created_at }));
}

/** The rows as the engine's resolver takes them. */
export function toPolicyRows(records: readonly PolicyRecord[]): PolicyRow[] {
  return records.map((r) => ({ brandId: r.brandId, adjustmentType: r.adjustmentType, component: r.component, handling: r.handling, validFrom: r.validFrom, validTo: r.validTo }));
}

export interface BaselineRecord {
  id: string;
  brandId: string | null;
  carrierCode: string | null;
  serviceId: string | null;
  periodStart: string;
  periodEnd: string;
  packagesTotal: number;
  labelsMissingWeight: number | null;
  note: string | null;
  createdAt: string;
}

interface BaselineDbRow {
  id: string;
  brand_id: string | null;
  carrier_code: string | null;
  service_id: string | null;
  period_start: string;
  period_end: string;
  packages_total: number;
  labels_missing_weight: number | null;
  note: string | null;
  created_at: string;
}

export async function loadBaselines(supabase: SupabaseClient, tenantId: string): Promise<BaselineRecord[]> {
  const rows = await pageAll<BaselineDbRow>("baselines", (from, to) =>
    supabase
      .from("adjustment_baselines")
      .select("id, brand_id, carrier_code, service_id, period_start, period_end, packages_total, labels_missing_weight, note, created_at")
      .eq("tenant_id", tenantId)
      .order("period_start", { ascending: false })
      .order("id")
      .range(from, to)
      .overrideTypes<BaselineDbRow[], { merge: false }>(),
  );
  return rows.map((r) => ({
    id: r.id,
    brandId: r.brand_id,
    carrierCode: r.carrier_code,
    serviceId: r.service_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    packagesTotal: r.packages_total,
    labelsMissingWeight: r.labels_missing_weight,
    note: r.note,
    createdAt: r.created_at,
  }));
}

export const toHistoryBaselines = (records: readonly BaselineRecord[]): HistoryBaseline[] =>
  records.map((r) => ({ id: r.id, brandId: r.brandId, carrierCode: r.carrierCode, serviceId: r.serviceId, periodStart: r.periodStart, periodEnd: r.periodEnd, packagesTotal: r.packagesTotal, labelsMissingWeight: r.labelsMissingWeight }));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
export type ImportStatus = "uploaded" | "mapped" | "validated" | "committing" | "committed" | "discarded" | "withdrawn";

export interface ImportListRow {
  id: string;
  name: string;
  status: ImportStatus;
  rowCount: number;
  acceptedCount: number;
  committedCount: number;
  skippedCount: number;
  attestedAt: string | null;
  createdAt: string;
  committedAt: string | null;
  /** Ship-date range of the file as validated (null before validation). */
  shipDateFrom: string | null;
  shipDateTo: string | null;
}

interface ImportListDbRow {
  id: string;
  name: string;
  status: ImportStatus;
  row_count: number;
  accepted_count: number;
  committed_count: number;
  skipped_count: number;
  attested_at: string | null;
  created_at: string;
  committed_at: string | null;
  range_min: string | null;
  range_max: string | null;
}

const IMPORT_LIST_COLUMNS = "id, name, status, row_count, accepted_count, committed_count, skipped_count, attested_at, created_at, committed_at, range_min:validation->shipDateRange->>min, range_max:validation->shipDateRange->>max";

const toImportListRow = (r: ImportListDbRow): ImportListRow => ({
  id: r.id,
  name: r.name,
  status: r.status,
  rowCount: r.row_count,
  acceptedCount: r.accepted_count,
  committedCount: r.committed_count,
  skippedCount: r.skipped_count,
  attestedAt: r.attested_at,
  createdAt: r.created_at,
  committedAt: r.committed_at,
  shipDateFrom: r.range_min,
  shipDateTo: r.range_max,
});

/** The account's imports, newest first, without the wide JSON (the detail page reads that for one import). */
export async function listImports(supabase: SupabaseClient, tenantId: string, limit = 200): Promise<ImportListRow[]> {
  const { data, error } = await supabase.from("adjustment_imports").select(IMPORT_LIST_COLUMNS).eq("tenant_id", tenantId).order("created_at", { ascending: false }).order("id").limit(limit).overrideTypes<ImportListDbRow[], { merge: false }>();
  if (error) failed("imports", error);
  return (data ?? []).map(toImportListRow);
}

export interface ImportDetail extends ImportListRow {
  fileId: string | null;
  duplicateHandling: "refuse" | "sum" | "first";
  /** Header names and at most 20 sample rows of the MAPPED columns (never anything from a column that is ignored). */
  detected: { sheet?: string; headerRow?: number; rowCount?: number; headers?: string[]; sampleRows?: Record<string, string>[]; kind?: string } | null;
  /** The mapping as stored (compact form); `parseStoredMapping` reads it. */
  mapping: unknown;
  /** The validation report as stored (the shape of AdjustmentValidationReport); null before a validation was saved. */
  validation: unknown;
}

interface ImportDetailDbRow extends ImportListDbRow {
  file_id: string | null;
  duplicate_handling: ImportDetail["duplicateHandling"];
  detected: ImportDetail["detected"];
  mapping: unknown;
  validation: unknown;
}

const IMPORT_DETAIL_COLUMNS = `${IMPORT_LIST_COLUMNS}, file_id, duplicate_handling, detected, mapping, validation`;

export async function loadImportDetail(supabase: SupabaseClient, tenantId: string, importId: string): Promise<ImportDetail | null> {
  const { data, error } = await supabase.from("adjustment_imports").select(IMPORT_DETAIL_COLUMNS).eq("id", importId).eq("tenant_id", tenantId).maybeSingle().overrideTypes<ImportDetailDbRow, { merge: false }>();
  if (error) failed("the import", error);
  if (!data) return null;
  return { ...toImportListRow(data), fileId: data.file_id, duplicateHandling: data.duplicate_handling, detected: data.detected, mapping: data.mapping, validation: data.validation };
}

/** The bytes of a stored upload (null when it is gone: committed, discarded and withdrawn imports delete their file). */
export async function readStoredUpload(supabase: SupabaseClient, tenantId: string, fileId: string): Promise<{ filename: string; mimeType: string; bytes: Uint8Array } | null> {
  const { data, error } = await supabase.from("uploaded_files").select("filename, mime_type, content").eq("id", fileId).eq("tenant_id", tenantId).eq("purpose", "adjustment_import").maybeSingle();
  if (error) failed("the uploaded file", error);
  if (!data) return null;
  const hex = String(data.content).replace(/^\\x/, "");
  return { filename: String(data.filename), mimeType: String(data.mime_type), bytes: new Uint8Array(Buffer.from(hex, "hex")) };
}

export interface ImportWizardView {
  import: ImportDetail;
  /** The stored mapping when it is a valid one. */
  mapping: AdjustmentMapping | null;
  /** A fresh reading of the stored file: the proposal and the values to match. Null when the file is gone, refused or unreadable. */
  detection: AdjustmentDetection | null;
  /** Why there is no detection (the file is gone, or a sentence about the file); null when there is one. */
  detectionProblem: string | null;
  brands: BrandOption[];
  catalog: ServiceCatalogEntry[];
}

const EDITABLE: readonly ImportStatus[] = ["uploaded", "mapped", "validated"];

/**
 * What the mapping step shows. The import row keeps only header names and sample rows of mapped columns, so the proposal and the
 * values to match (carriers, services, causes, customers) are read again from the stored file, under the caller's rights.
 */
export async function loadImportWizard(supabase: SupabaseClient, tenantId: string, importId: string): Promise<ImportWizardView | null> {
  const imp = await loadImportDetail(supabase, tenantId, importId);
  if (!imp) return null;
  const [brands, catalog] = await Promise.all([loadAdjustmentBrands(supabase, tenantId), loadServiceCatalog(supabase)]);
  const mapping = parseStoredMapping(imp.mapping);
  const brandOptions = brands.map((b) => ({ id: b.id, name: b.name }));
  const base = { import: imp, mapping, brands: brandOptions, catalog };
  if (!EDITABLE.includes(imp.status) || !imp.fileId) return { ...base, detection: null, detectionProblem: "The uploaded file is no longer kept: it is deleted when an import is finished, discarded or withdrawn." };
  const file = await readStoredUpload(supabase, tenantId, imp.fileId);
  if (!file) return { ...base, detection: null, detectionProblem: "The uploaded file is no longer available. Upload it again." };
  const parsed = await parseAdjustmentFile(file.bytes, { filename: file.filename, mimeType: file.mimeType });
  if (parsed.status !== "ok") return { ...base, detection: null, detectionProblem: parsed.message };
  return { ...base, detection: detectAdjustmentFile(parsed.tables, { catalog, brands: brandOptions }, mapping?.sheet), detectionProblem: null };
}

// ---------------------------------------------------------------------------
// History records (through the bulk reader) and the keys of what is already imported
// ---------------------------------------------------------------------------
/** One record as `adjustment_records_json` returns it. Money and weights are decimal text, dates are ISO dates. */
export interface BulkRecord {
  id: string;
  rowNo: number;
  brandId: string | null;
  shipDate: string;
  carrierCode: string;
  serviceId: string | null;
  adjustmentType: string;
  cause: string;
  packageRef: string | null;
  originalCharge: string | null;
  correctedCharge: string | null;
  separateFee: string | null;
  postageDifference: string | null;
}

export const toHistoryRecord = (r: BulkRecord): HistoryRecord => ({
  id: r.id,
  brandId: r.brandId ?? null,
  carrierCode: r.carrierCode,
  serviceId: r.serviceId ?? null,
  shipDate: r.shipDate,
  adjustmentType: r.adjustmentType,
  cause: r.cause,
  packageRef: r.packageRef ?? null,
  originalCharge: num(r.originalCharge),
  correctedCharge: num(r.correctedCharge),
  separateFee: num(r.separateFee),
  postageDifference: num(r.postageDifference),
});

/** More than the account can ever hold (200,000 records): reaching it means something is wrong, so reading stops instead of looping. */
export const MAX_RECORDS_READ = 250_000;

/** Committed imports of the account, with the ship-date range of each as validated (null when unknown). */
async function committedImports(supabase: SupabaseClient, tenantId: string): Promise<{ id: string; committedCount: number; from: string | null; to: string | null }[]> {
  const rows = await pageAll<ImportListDbRow>("imports", (from, to) =>
    supabase.from("adjustment_imports").select(IMPORT_LIST_COLUMNS).eq("tenant_id", tenantId).eq("status", "committed").order("created_at").order("id").range(from, to).overrideTypes<ImportListDbRow[], { merge: false }>(),
  );
  return rows.map((r) => ({ id: r.id, committedCount: r.committed_count, from: r.range_min, to: r.range_max }));
}

/** Pages one import's records (1,000 a call, in row order) through the database's bulk reader. */
async function* importRecords(supabase: SupabaseClient, importId: string): AsyncGenerator<BulkRecord[]> {
  for (let from = 1; ; ) {
    const { data, error } = await supabase.rpc("adjustment_records_json", { p_import: importId, p_from: from, p_limit: PAGE });
    if (error) failed("history records", error);
    if (!Array.isArray(data)) throw new Error("history records could not be loaded: unexpected answer");
    const page = data as BulkRecord[];
    if (page.length) yield page;
    if (page.length < PAGE) return;
    from = page[page.length - 1]!.rowNo + 1;
  }
}

export interface CommittedHistory {
  records: HistoryRecord[];
  /** Committed imports that supplied at least one record that passed `keep`. */
  importIds: string[];
  /** Records read before `keep`. */
  recordsRead: number;
}

/**
 * The account's committed history as the statistics read it. `keep` drops records the caller will never use (the numerator filters
 * of a statistic: customer, carrier, type, cause), which only saves memory: the statistic applies the same filters itself. Throws when
 * a page cannot be read or the history is larger than an account can hold, never truncates.
 */
export async function loadCommittedHistory(supabase: SupabaseClient, tenantId: string, keep: (r: BulkRecord) => boolean = () => true): Promise<CommittedHistory> {
  const imports = await committedImports(supabase, tenantId);
  const records: HistoryRecord[] = [];
  const importIds: string[] = [];
  let read = 0;
  for (const imp of imports) {
    if (imp.committedCount === 0) continue;
    let used = false;
    for await (const page of importRecords(supabase, imp.id)) {
      read += page.length;
      if (read > MAX_RECORDS_READ) throw new Error("history records could not be loaded: more records than an account can hold");
      for (const r of page) {
        if (!keep(r)) continue;
        records.push(toHistoryRecord(r));
        used = true;
      }
    }
    if (used) importIds.push(imp.id);
  }
  return { records, importIds, recordsRead: read };
}

/**
 * Keys (customer, carrier, package reference, type) of the records already committed, for the "already imported" count and so a
 * file is never imported twice. EVERY committed import is read: the unique key has no date in it, so a package of the new file can repeat
 * a package of an import whose ship dates do not overlap the new file's (a late adjustment of an old shipment), and a skipped-by-the-database
 * row that the report did not count would break the counts the 3PL approved (review finding F14). The references are compared in their
 * canonical form (the database stores that form), so a different spelling of the same package is the same key.
 */
export async function loadExistingKeys(supabase: SupabaseClient, tenantId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let read = 0;
  for (const imp of await committedImports(supabase, tenantId)) {
    if (imp.committedCount === 0) continue;
    for await (const page of importRecords(supabase, imp.id)) {
      read += page.length;
      if (read > MAX_RECORDS_READ) throw new Error("history records could not be loaded: more records than an account can hold");
      for (const r of page) {
        if (r.packageRef === null || r.packageRef === undefined) continue;
        keys.add(adjustmentRecordKey(r.brandId ?? null, r.carrierCode, r.packageRef, r.adjustmentType as Parameters<typeof adjustmentRecordKey>[3]));
      }
    }
  }
  return keys;
}

/** True when the record passes the numerator filters a statistic would apply first (customer, carrier, type, cause). */
export function numeratorKeep(f: { brandId: string | null; carrierCode?: string | null; adjustmentType?: string | null; cause?: string | null }): (r: BulkRecord) => boolean {
  return (r) => (f.brandId === null || r.brandId === f.brandId) && (!f.carrierCode || r.carrierCode === f.carrierCode) && (!f.adjustmentType || r.adjustmentType === f.adjustmentType) && (!f.cause || r.cause === f.cause);
}

// ---------------------------------------------------------------------------
// Saved examples (scenarios), estimates and published examples
// ---------------------------------------------------------------------------
export interface ScenarioListRow {
  id: string;
  brandId: string | null;
  name: string;
  adjustmentType: "reweight" | "remeasure" | "combined";
  pricedOn: string;
  archivedAt: string | null;
  createdAt: string;
  status: string | null;
  direction: string | null;
  basis: string | null;
}

interface ScenarioListDbRow {
  id: string;
  brand_id: string | null;
  name: string;
  adjustment_type: ScenarioListRow["adjustmentType"];
  priced_on: string;
  archived_at: string | null;
  created_at: string;
  r_status: string | null;
  r_direction: string | null;
  r_basis: string | null;
}

const SCENARIO_LIST_COLUMNS = "id, brand_id, name, adjustment_type, priced_on, archived_at, created_at, r_status:result->>status, r_direction:result->>direction, r_basis:result->>basis";

/** Saved examples, newest first; archived ones only when asked for. */
export async function listScenarios(supabase: SupabaseClient, tenantId: string, opts: { brandId?: string | null; includeArchived?: boolean; limit?: number } = {}): Promise<ScenarioListRow[]> {
  let q = supabase.from("adjustment_scenarios").select(SCENARIO_LIST_COLUMNS).eq("tenant_id", tenantId);
  if (opts.brandId) q = q.eq("brand_id", opts.brandId);
  if (!opts.includeArchived) q = q.is("archived_at", null);
  const { data, error } = await q.order("created_at", { ascending: false }).order("id").limit(opts.limit ?? 200).overrideTypes<ScenarioListDbRow[], { merge: false }>();
  if (error) failed("saved examples", error);
  return (data ?? []).map((r) => ({ id: r.id, brandId: r.brand_id, name: r.name, adjustmentType: r.adjustment_type, pricedOn: r.priced_on, archivedAt: r.archived_at, createdAt: r.created_at, status: r.r_status, direction: r.r_direction, basis: r.r_basis }));
}

export interface ScenarioDetail extends ScenarioListRow {
  /** The stored input and result (staff documents; see the migration header for the contract). */
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  engineVersion: string;
  rateCardVersionId: string | null;
  policySnapshot: Record<string, string>;
}

interface ScenarioDetailDbRow extends ScenarioListDbRow {
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  engine_version: string;
  rate_card_version_id: string | null;
  policy_snapshot: Record<string, string>;
}

export async function loadScenario(supabase: SupabaseClient, tenantId: string, id: string): Promise<ScenarioDetail | null> {
  const { data, error } = await supabase
    .from("adjustment_scenarios")
    .select(`${SCENARIO_LIST_COLUMNS}, input, result, engine_version, rate_card_version_id, policy_snapshot`)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
    .overrideTypes<ScenarioDetailDbRow, { merge: false }>();
  if (error) failed("the saved example", error);
  if (!data) return null;
  return {
    id: data.id,
    brandId: data.brand_id,
    name: data.name,
    adjustmentType: data.adjustment_type,
    pricedOn: data.priced_on,
    archivedAt: data.archived_at,
    createdAt: data.created_at,
    status: data.r_status,
    direction: data.r_direction,
    basis: data.r_basis,
    input: data.input,
    result: data.result,
    engineVersion: data.engine_version,
    rateCardVersionId: data.rate_card_version_id,
    policySnapshot: data.policy_snapshot,
  };
}

/** What one example of a saved scenario adds, per component, as ten-thousandths of a dollar: the amount when the component is a charge, else null (never 0). */
export function exampleSeverity(result: Record<string, unknown>, kind: "postage_difference" | "separate_fee"): number | null {
  const components = Array.isArray(result.components) ? (result.components as Record<string, unknown>[]) : [];
  const c = components.find((x) => x.kind === kind);
  if (!c || c.state !== "conditional" || typeof c.amount !== "string" || !/^\d{1,7}\.\d{2}$/.test(c.amount)) return null;
  return dollarsToE4(c.amount);
}

export interface EstimateListRow {
  id: string;
  brandId: string | null;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  basis: "declared_weights" | "actual_weights" | null;
  /** The counted-here total (E4) when the estimate computed one. */
  countedE4: number | null;
}

interface EstimateListDbRow {
  id: string;
  brand_id: string | null;
  name: string;
  created_at: string;
  archived_at: string | null;
  i_basis: EstimateListRow["basis"];
  r_counted: number | null;
}

const ESTIMATE_LIST_COLUMNS = "id, brand_id, name, created_at, archived_at, i_basis:inputs->>basis, r_counted:result->countedE4";

const toEstimateListRow = (r: EstimateListDbRow): EstimateListRow => ({ id: r.id, brandId: r.brand_id, name: r.name, createdAt: r.created_at, archivedAt: r.archived_at, basis: r.i_basis ?? null, countedE4: typeof r.r_counted === "number" ? r.r_counted : null });

export async function listRiskEstimates(supabase: SupabaseClient, tenantId: string, opts: { includeArchived?: boolean; limit?: number } = {}): Promise<EstimateListRow[]> {
  let q = supabase.from("risk_estimates").select(ESTIMATE_LIST_COLUMNS).eq("tenant_id", tenantId);
  if (!opts.includeArchived) q = q.is("archived_at", null);
  const { data, error } = await q.order("created_at", { ascending: false }).order("id").limit(opts.limit ?? 200).overrideTypes<EstimateListDbRow[], { merge: false }>();
  if (error) failed("saved estimates", error);
  return (data ?? []).map(toEstimateListRow);
}

export interface EstimateDetail extends EstimateListRow {
  inputs: Record<string, unknown>;
  result: Record<string, unknown>;
  engineVersion: string;
}

export async function loadRiskEstimate(supabase: SupabaseClient, tenantId: string, id: string): Promise<EstimateDetail | null> {
  const { data, error } = await supabase
    .from("risk_estimates")
    .select(`${ESTIMATE_LIST_COLUMNS}, inputs, result, engine_version`)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
    .overrideTypes<EstimateListDbRow & { inputs: Record<string, unknown>; result: Record<string, unknown>; engine_version: string }, { merge: false }>();
  if (error) failed("the saved estimate", error);
  if (!data) return null;
  return { ...toEstimateListRow(data), inputs: data.inputs, result: data.result, engineVersion: data.engine_version };
}

interface PublishedDbRow {
  id: string;
  brand_id: string;
  source_scenario_id: string;
  title: string;
  note_to_customer: string | null;
  internal_note: string | null;
  priced_on: string;
  rates_effective_from: string;
  valid_through: string;
  published_at: string;
  retired_at: string | null;
}

const PUBLISHED_COLUMNS = "id, brand_id, source_scenario_id, title, note_to_customer, internal_note, priced_on, rates_effective_from, valid_through, published_at, retired_at";

interface ExampleStateRow {
  id: string;
  brandId: string;
  state: "current" | "under_review" | "expired";
  causes: string[];
}

/**
 * The examples shared with customers, with the state the database computes at read time (current, under review with its causes, expired).
 * Stopped examples are listed only when asked for. A live example the state function did not report is shown as under review: the
 * safe reading for a statement a customer may be reading.
 */
export async function listExamples(supabase: SupabaseClient, tenantId: string, opts: { includeRetired?: boolean; limit?: number } = {}): Promise<ExampleListItem[]> {
  let q = supabase.from("published_adjustment_examples").select(PUBLISHED_COLUMNS).eq("tenant_id", tenantId);
  if (!opts.includeRetired) q = q.is("retired_at", null);
  const [{ data, error }, statesResult, brands] = await Promise.all([
    q.order("published_at", { ascending: false }).order("id").limit(opts.limit ?? 200).overrideTypes<PublishedDbRow[], { merge: false }>(),
    supabase.rpc("adjustment_example_states", { p_tenant: tenantId }),
    loadAdjustmentBrands(supabase, tenantId),
  ]);
  if (error) failed("shared examples", error);
  if (statesResult.error) failed("the state of shared examples", statesResult.error);
  const states = new Map(((statesResult.data ?? []) as ExampleStateRow[]).map((s) => [s.id, s] as const));
  const names = new Map(brands.map((b) => [b.id, b.name] as const));
  return (data ?? []).map((r) => {
    const live = states.get(r.id);
    const state: ExampleState = r.retired_at ? "retired" : (live?.state ?? "under_review");
    return {
      id: r.id,
      brandId: r.brand_id,
      brandName: names.get(r.brand_id) ?? null,
      sourceScenarioId: r.source_scenario_id,
      title: r.title,
      noteToCustomer: r.note_to_customer,
      internalNote: r.internal_note,
      pricedOn: r.priced_on,
      ratesEffectiveFrom: r.rates_effective_from,
      validThrough: r.valid_through,
      publishedAt: r.published_at,
      retiredAt: r.retired_at,
      state,
      causes: r.retired_at ? [] : (live?.causes ?? []),
    };
  });
}

// ---------------------------------------------------------------------------
// Overview (the checklist's inputs; computed, never stored)
// ---------------------------------------------------------------------------
const FEE_CATEGORY_TYPE: Record<string, PolicyType> = { reweight: "reweight", remeasure: "remeasure", shipping_charge_correction: "correction" };

export interface OverviewData {
  /** Step 1: a reweigh, remeasure or correction fee rule in force today. */
  feeRules: { count: number; byCategory: Record<string, number> };
  /** Step 2: the seven decisions for all customers, and the customers' own decisions in effect today. */
  policies: { cells: number; decided: number; undecided: number; exceptions: number };
  /** Steps 3 and 4. */
  scenarios: { active: number };
  examples: { live: number; current: number; underReview: number; expired: number };
  estimates: { active: number; latest: EstimateListRow | null };
  imports: { committed: number; records: number };
  /** Customers who can read a reweigh, remeasure or correction fee rule in their schedule although nobody has decided who pays it. */
  customersSeeingUndecidedRule: { brandId: string; brandName: string; categories: string[] }[];
}

interface RuleDbRow {
  id: string;
  category: string;
  carrier_code: string;
  brand_id: string | null;
  surcharge_rule_versions: { status: string; effective_date: string; expiration_date: string | null }[];
}

/**
 * Everything the Overview needs, in a handful of lean queries. "Sees an undecided rule" follows the rule that decides what a
 * customer's pricing context holds (`pricing_rules_for_card`): a published rule of one of the three fee categories, in force, of the
 * account or of that customer, on a carrier of a rate card the customer is assigned, is in the customer's schedule unless the decision
 * says the fee is absorbed; with no decision at all it is shown with nobody having chosen who pays.
 */
export async function loadOverview(supabase: SupabaseClient, tenantId: string, today: string = todayIso()): Promise<OverviewData> {
  const [policies, ruleRows, states, activeScenarios, activeEstimates, latest, imports, brands, assignments] = await Promise.all([
    loadPolicies(supabase, tenantId),
    pageAll<RuleDbRow>("fee rules", (from, to) =>
      supabase
        .from("surcharge_rules")
        .select("id, category, carrier_code, brand_id, surcharge_rule_versions!srv_rule_in_tenant(status, effective_date, expiration_date)")
        .in("category", Object.keys(FEE_CATEGORY_TYPE))
        .is("archived_at", null)
        .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
        .order("id")
        .range(from, to)
        .overrideTypes<RuleDbRow[], { merge: false }>(),
    ),
    supabase.rpc("adjustment_example_states", { p_tenant: tenantId }),
    supabase.from("adjustment_scenarios").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).is("archived_at", null),
    supabase.from("risk_estimates").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).is("archived_at", null),
    listRiskEstimates(supabase, tenantId, { limit: 1 }),
    committedImportTotals(supabase, tenantId),
    loadAdjustmentBrands(supabase, tenantId),
    pageAll<{ brand_id: string; rate_card_id: string }>("rate card assignments", (from, to) =>
      supabase.from("brand_rate_card_assignments").select("brand_id, rate_card_id").eq("tenant_id", tenantId).is("unassigned_at", null).order("brand_id").order("rate_card_id").range(from, to).overrideTypes<{ brand_id: string; rate_card_id: string }[], { merge: false }>(),
    ),
  ]);
  if (states.error) failed("the state of shared examples", states.error);
  if (activeScenarios.error) failed("saved examples", activeScenarios.error);
  if (activeEstimates.error) failed("saved estimates", activeEstimates.error);

  const inForce = (v: RuleDbRow["surcharge_rule_versions"][number]) => (v.status === "published" || v.status === "retired") && v.effective_date <= today && (v.expiration_date === null || v.expiration_date >= today);
  const rules = ruleRows.filter((r) => (r.surcharge_rule_versions ?? []).some(inForce));
  const byCategory: Record<string, number> = {};
  for (const r of rules) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;

  const policyRows = toPolicyRows(policies);
  const cells = POLICY_CELLS;
  const decided = cells.filter((c) => resolveHandling(policyRows, null, c.type, c.component, today) !== "unconfigured").length;
  const exceptions = policies.filter((p) => p.brandId !== null && p.validFrom <= today && (p.validTo === null || p.validTo >= today)).length;

  const stateList = (states.data ?? []) as ExampleStateRow[];
  const examples = {
    live: stateList.length,
    current: stateList.filter((s) => s.state === "current").length,
    underReview: stateList.filter((s) => s.state === "under_review").length,
    expired: stateList.filter((s) => s.state === "expired").length,
  };

  // Customers who see a fee rule although nobody decided who pays it.
  const cardCarriers = await carriersOfCards(supabase, tenantId, [...new Set(assignments.map((a) => a.rate_card_id))]);
  const seeing: OverviewData["customersSeeingUndecidedRule"] = [];
  for (const brand of brands) {
    if (brand.status !== "active") continue;
    const carriers = new Set(assignments.filter((a) => a.brand_id === brand.id).flatMap((a) => [...(cardCarriers.get(a.rate_card_id) ?? [])]));
    const categories = new Set<string>();
    for (const r of rules) {
      if (r.brand_id !== null && r.brand_id !== brand.id) continue;
      if (!carriers.has(r.carrier_code)) continue;
      if (resolveHandling(policyRows, brand.id, FEE_CATEGORY_TYPE[r.category]!, "separate_fee", today) === "unconfigured") categories.add(r.category);
    }
    if (categories.size) seeing.push({ brandId: brand.id, brandName: brand.name, categories: [...categories].sort() });
  }

  return {
    feeRules: { count: rules.length, byCategory },
    policies: { cells: cells.length, decided, undecided: cells.length - decided, exceptions },
    scenarios: { active: activeScenarios.count ?? 0 },
    examples,
    estimates: { active: activeEstimates.count ?? 0, latest: latest[0] ?? null },
    imports,
    customersSeeingUndecidedRule: seeing,
  };
}

async function committedImportTotals(supabase: SupabaseClient, tenantId: string): Promise<{ committed: number; records: number }> {
  const rows = await pageAll<{ committed_count: number }>("imports", (from, to) => supabase.from("adjustment_imports").select("committed_count").eq("tenant_id", tenantId).eq("status", "committed").order("id").range(from, to).overrideTypes<{ committed_count: number }[], { merge: false }>());
  return { committed: rows.length, records: rows.reduce((s, r) => s + r.committed_count, 0) };
}

/** The carriers each rate card prices, from the services of its active versions. */
async function carriersOfCards(supabase: SupabaseClient, tenantId: string, cardIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!cardIds.length) return out;
  const versions = await pageAll<{ id: string; rate_card_id: string }>("rate card versions", (from, to) =>
    supabase.from("rate_card_versions").select("id, rate_card_id").eq("tenant_id", tenantId).eq("status", "active").in("rate_card_id", cardIds).order("id").range(from, to).overrideTypes<{ id: string; rate_card_id: string }[], { merge: false }>(),
  );
  if (!versions.length) return out;
  const versionCard = new Map(versions.map((v) => [v.id, v.rate_card_id] as const));
  const [terms, catalog] = await Promise.all([
    pageAll<{ version_id: string; service_id: string }>("rate card services", (from, to) =>
      supabase.from("rate_card_service_terms").select("version_id, service_id").in("version_id", [...versionCard.keys()]).order("version_id").order("service_id").range(from, to).overrideTypes<{ version_id: string; service_id: string }[], { merge: false }>(),
    ),
    loadServiceCatalog(supabase),
  ]);
  const carrierOf = new Map(catalog.map((s) => [s.id, s.carrierCode] as const));
  for (const t of terms) {
    const card = versionCard.get(t.version_id);
    const carrier = carrierOf.get(t.service_id);
    if (!card || !carrier) continue;
    const set = out.get(card) ?? new Set<string>();
    set.add(carrier);
    out.set(card, set);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finished runs, for the risk form's volume
// ---------------------------------------------------------------------------
export interface RunVolumeOption extends RiskRunVolume {
  finishedAt: string | null;
}

interface RunDbRow {
  id: string;
  project_id: string;
  monthly_packages: string | number | null;
  finished_at: string | null;
  assumed_weight: number | string | null;
}

const RUN_COLUMNS = "id, project_id, monthly_packages, finished_at, assumed_weight:summary->assumptions->weight";

/** A decimal as text without trailing zeros ("1234.5000" is "1234.5"). */
function decimalText(v: string | number): string {
  const s = String(v);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function toRunVolume(r: RunDbRow, name: string | null): RiskRunVolume | null {
  if (r.monthly_packages === null || r.monthly_packages === undefined) return null;
  const monthly = decimalText(r.monthly_packages);
  if (!/^\d+(\.\d+)?$/.test(monthly) || Number(monthly) <= 0) return null;
  // The run counts the shipments it priced on weights derived from product weights; a run whose summary does not say is "not known".
  const derived = r.assumed_weight === null || r.assumed_weight === undefined ? null : Number(r.assumed_weight);
  return { runId: r.id, runName: name, monthlyPackages: monthly, weightsFromProductProfiles: derived === null || !Number.isFinite(derived) ? null : derived > 0 };
}

async function projectNames(supabase: SupabaseClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from("simulation_projects").select("id, name").eq("tenant_id", tenantId).in("id", ids).overrideTypes<{ id: string; name: string }[], { merge: false }>();
  if (error) failed("projects", error);
  return new Map((data ?? []).map((p) => [p.id, p.name] as const));
}

/** Finished file runs of a customer with a monthly package count, newest first. Forecasts and what-ifs on assumptions are not runs of the customer's file. */
export async function loadRunVolumeOptions(supabase: SupabaseClient, tenantId: string, brandId: string): Promise<RunVolumeOption[]> {
  const { data, error } = await supabase
    .from("simulation_runs")
    .select(RUN_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("brand_id", brandId)
    .eq("kind", "bulk")
    .eq("status", "completed")
    .not("monthly_packages", "is", null)
    .order("finished_at", { ascending: false })
    .limit(50)
    .overrideTypes<RunDbRow[], { merge: false }>();
  if (error) failed("finished runs", error);
  const rows = data ?? [];
  const names = await projectNames(supabase, tenantId, [...new Set(rows.map((r) => r.project_id))]);
  const out: RunVolumeOption[] = [];
  for (const r of rows) {
    const v = toRunVolume(r, names.get(r.project_id) ?? null);
    if (v) out.push({ ...v, finishedAt: r.finished_at });
  }
  return out;
}

/** One finished run of the customer as a monthly volume; null when it is not a finished file run of this customer with a monthly count. */
export async function loadRunVolume(supabase: SupabaseClient, tenantId: string, brandId: string, runId: string): Promise<RiskRunVolume | null> {
  const { data, error } = await supabase
    .from("simulation_runs")
    .select(RUN_COLUMNS)
    .eq("id", runId)
    .eq("tenant_id", tenantId)
    .eq("brand_id", brandId)
    .eq("kind", "bulk")
    .eq("status", "completed")
    .maybeSingle()
    .overrideTypes<RunDbRow, { merge: false }>();
  if (error) failed("the run", error);
  if (!data) return null;
  const names = await projectNames(supabase, tenantId, [data.project_id]);
  return toRunVolume(data, names.get(data.project_id) ?? null);
}

// ---------------------------------------------------------------------------
// The customer's side: published examples, through ONE function and nothing else
// ---------------------------------------------------------------------------
const money = z.string().regex(/^\d{1,7}\.\d{2}$/);
const dec = z.string().regex(/^\d{1,6}(\.\d{1,6})?$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const plain = (max: number) => z.string().min(1).max(max);
const examplePackage = z.object({ weightLb: dec, lengthIn: dec.optional(), widthIn: dec.optional(), heightIn: dec.optional() });

/** Zod's default (`z.object`) drops keys it does not list, so what comes out has exactly these fields whatever the database sent. */
const payloadSchema = z.object({
  v: z.literal(1),
  adjustmentType: z.enum(["reweight", "remeasure", "combined"]),
  pricedOn: isoDate,
  input: z.object({
    service: z.object({ carrier: plain(60), service: plain(60) }),
    direction: z.literal("increase"),
    residential: z.boolean(),
    zone: z.number().int().min(0).max(999_999).nullable(),
    declared: z.object({ packages: z.array(examplePackage).min(1).max(20) }),
    corrected: z.object({ packages: z.array(examplePackage).min(1).max(20) }),
  }),
  components: z
    .array(
      z.object({
        kind: z.enum(["postage_difference", "separate_fee"]),
        handling: z.enum(["pass_through", "manual_approval"]),
        amount: money,
        declaredTotal: money.optional(),
        correctedTotal: money.optional(),
      }),
    )
    .min(1)
    .max(2),
});

const brandExampleSchema = z.object({
  id: z.string().uuid(),
  title: plain(120),
  note: plain(300).nullable(),
  payload: payloadSchema.nullable(),
  pricedOn: isoDate,
  ratesEffectiveFrom: isoDate,
  validThrough: isoDate,
  publishedAt: z.string().min(10).max(40),
  state: z.enum(["current", "under_review", "expired"]),
});

export type BrandExample = z.infer<typeof brandExampleSchema>;
export type BrandExamplePayload = z.infer<typeof payloadSchema>;

export type BrandExamplesResult = { status: "ok"; examples: BrandExample[] } | { status: "load_failed" };

/** The explicit projection of `brand_adjustment_examples`, field by field. Null when anything in it is not what the database promises (nothing unchecked is ever handed to a page). */
export function projectBrandExamples(raw: unknown): BrandExample[] | null {
  const parsed = z.array(brandExampleSchema).max(25).safeParse(raw);
  if (!parsed.success) return null;
  // An example whose amounts are hidden (under review, expired) carries no payload; one that is current must carry it.
  if (parsed.data.some((e) => (e.state === "current") !== (e.payload !== null))) return null;
  return parsed.data;
}

/**
 * The customer's examples. The ONLY data source of the customer page: the database function `brand_adjustment_examples` (it authorizes the
 * caller on the brand and returns an empty list to anyone else). No M5 table is selected from here, ever.
 */
export async function loadBrandExamples(supabase: SupabaseClient, brandId: string): Promise<BrandExamplesResult> {
  const { data, error } = await supabase.rpc("brand_adjustment_examples", { p_brand: brandId });
  if (error) return { status: "load_failed" };
  const examples = projectBrandExamples(data);
  return examples ? { status: "ok", examples } : { status: "load_failed" };
}

/** The signed-in customer's examples: the brand comes from the session, never from a request. */
export async function loadSessionBrandExamples(): Promise<BrandExamplesResult & { brandName: string; tenantName: string }> {
  const ctx = await requireBrandContext("brand.view");
  const supabase = await createClient();
  const result = await loadBrandExamples(supabase, ctx.active.brandId);
  return { ...result, brandName: ctx.active.brandName, tenantName: ctx.active.tenantName };
}
