"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  ADJUSTMENT_ENGINE_VERSION,
  AdjustmentOverflowError,
  evaluateAdjustmentScenario,
  forecastAdjustmentRisk,
  policyFnFor,
  resolveHandling,
  riskStorageResult,
  scenarioStorageInput,
  scenarioStorageResult,
  summariseHistory,
  type AdjustmentScenarioResult,
  type Handling,
  type PolicyComponent,
} from "@/engine/adjustments";
import { can } from "@/lib/auth/permissions";
import { getContext, requireUser } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import {
  ATTESTATION_REQUIRED,
  CUSTOMER_NOT_FOUND,
  GENERIC_FAILURE,
  HISTORY_PATH,
  ADJUSTMENTS_PATH,
  ITEM_NOT_FOUND,
  NO_PERMISSION_MANAGE,
  NO_PERMISSION_VIEW,
  RATE_LIMITS,
  baselineSchema,
  estimateNameSchema,
  historyFiltersSchema,
  publishSchema,
  riskHistoryCounts,
  riskInputSchema,
  riskInputsFrom,
  rpcFailure,
  scenarioInputSchema,
  scenarioNameSchema,
  setPolicySchema,
  todayIso,
  zodFieldErrors,
  zodProblems,
  type AdjustmentActionResult,
  type CommitActionResult,
  type DbError,
  type ExampleListItem,
  type ExamplePreview,
  type HistoryFiltersInput,
  type HistoryStatsResponse,
  type MappingActionResult,
  type RiskFormInput,
  type RiskForecastResponse,
  type RiskRunVolume,
  type SaveEstimateResult,
  type SaveScenarioResult,
  type ScenarioBuilderInput,
  type ScenarioEvalResponse,
  type StoredRiskInputs,
  type UploadState,
  type ValidateActionResult,
} from "@/lib/adjustments/action-schemas";
import { buildScenarioInput, loadScenarioContext, scenarioPins, type ScenarioContext } from "@/lib/adjustments/context";
import { cleanText } from "@/lib/adjustments/cells";
import { ENCODING_MESSAGE, FILE_NOT_REMOVED, IMPORT_LIMITS } from "@/lib/adjustments/copy";
import { scrubJsonb } from "@/lib/adjustments/jsonb-size";
import { flaggedMappingMessage, refusalMessage } from "@/lib/adjustments/header-guard";
import { buildDetected, detectAdjustmentFile, toStoredMapping, validateMapping } from "@/lib/adjustments/mapping";
import { adjustmentMappingSchema, parseStoredMapping } from "@/lib/adjustments/mapping-schema";
import { parseAdjustmentFile } from "@/lib/adjustments/parse";
import { ChunkError, buildAppendChunks, reconcileCommit, type AppendResult } from "@/lib/adjustments/payload";
import {
  exampleSeverity,
  listExamples as listExampleRows,
  loadAdjustmentBrands,
  loadBaselines,
  loadCommittedHistory,
  loadExistingKeys,
  loadImportDetail,
  loadPolicies,
  loadRunVolume,
  loadScenario,
  numeratorKeep,
  readStoredUpload,
  toHistoryBaselines,
  toPolicyRows,
  type ImportDetail,
} from "@/lib/adjustments/queries";
import { applyAdjustmentMapping, toStoredValidation } from "@/lib/adjustments/validate";
import type { AdjustmentContext, AdjustmentImportResult, AdjustmentMapping } from "@/lib/adjustments/types";
import { ADJUSTMENT_FILE_LIMITS, type Table } from "@/lib/import/parse-table";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions of the adjustment module (Milestone 5). Staff only: `adjustment.view` reads (and prices an example, which stores
 * nothing), `adjustment.manage` writes. The tenant is ALWAYS the session's active workspace and the customer is checked against it;
 * a customer id, a rate card id, a file id or a row id from the browser is only ever a request, re-checked here and again by the
 * database function that authorizes on the row, so a forged id comes back as "not found". Every write goes through a database
 * function (the M5 tables have no write grant for any role the Data API uses); nothing here writes an audit row (the database does,
 * from triggers, and refuses `adjustment.*` from clients).
 *
 * Nothing here reads, stores or computes a carrier buy rate. Every amount is what a customer is, or would be, charged under the
 * 3PL's own rate card and rules. A history file is parsed and its headers guarded BEFORE a byte of it is stored. A figure that
 * cannot be computed is "not computed", never zero.
 *
 * Result shapes: writes return `{ ok, message?, errors? }` (plus an id or counts); the three calculations (history statistics, an
 * example, a risk forecast) return `{ status: "ok" | "invalid" | "error" | ... }` like the forecast actions.
 */

type Db = Awaited<ReturnType<typeof createClient>>;

interface Actor {
  tenantId: string;
}

/** The signed-in 3PL staff member acting in their active workspace, if they hold the permission; null otherwise (a customer's member, an employee, nobody). */
async function actor(permission: "adjustment.view" | "adjustment.manage"): Promise<Actor | null> {
  await requireUser();
  const ctx = await getContext();
  if (!ctx || ctx.active.portal !== "tenant" || !can(ctx.active.role, permission)) return null;
  return { tenantId: ctx.active.tenantId };
}

function revalidateAdjustments(opts: { customers?: boolean } = {}): void {
  revalidatePath(ADJUSTMENTS_PATH, "layout");
  revalidatePath("/app");
  if (opts.customers) {
    revalidatePath("/portal/model", "layout");
    revalidatePath("/portal");
  }
}

const idOk = (id: unknown): id is string => uuidSchema.safeParse(id).success;

/** A customer of the session's workspace (the filter is the session's tenant; the database checks the caller's rights on it again). */
async function ownBrand(supabase: Db, tenantId: string, brandId: string): Promise<{ ok: true; id: string; name: string } | { ok: false; message: string }> {
  const { data, error } = await supabase.from("brands").select("id, name, status").eq("id", brandId).eq("tenant_id", tenantId).maybeSingle();
  if (error) return { ok: false, message: GENERIC_FAILURE };
  if (!data) return { ok: false, message: CUSTOMER_NOT_FOUND };
  return { ok: true, id: String(data.id), name: String(data.name) };
}

type OwnedTable = "adjustment_policies" | "adjustment_imports" | "adjustment_baselines" | "adjustment_scenarios" | "risk_estimates" | "published_adjustment_examples";

/**
 * A row of the session's workspace. The database authorizes on the row's own account, which would let a person who belongs to two
 * accounts act on the other one's row from this workspace; this keeps every action inside the workspace they are in.
 */
async function ownsRow(supabase: Db, table: OwnedTable, id: string, tenantId: string): Promise<"yes" | "no" | "failed"> {
  const { data, error } = await supabase.from(table).select("id").eq("id", id).eq("tenant_id", tenantId).maybeSingle();
  if (error) return "failed";
  return data ? "yes" : "no";
}

async function limited(supabase: Db, limit: (typeof RATE_LIMITS)[keyof typeof RATE_LIMITS]): Promise<boolean> {
  return !(await withinRateLimit(supabase, limit.action, limit.limit, limit.windowSeconds));
}

/** The sentence for a database refusal; a mapped column that looks like carrier cost data names the header (from the person's own file). */
function failure(error: DbError, wording: Parameters<typeof rpcFailure>[1] = {}): string {
  if (error.code === "P0001" && /carrier cost data/i.test(error.message) && error.details) return flaggedMappingMessage(String(error.details).slice(0, 120), true);
  return rpcFailure(error, wording);
}

// ---------------------------------------------------------------------------
// Policies: who pays
// ---------------------------------------------------------------------------
/** Sets who pays for one component of one kind of adjustment, from today: for all customers (brandId null) or for one customer. */
export async function setPolicy(input: unknown): Promise<AdjustmentActionResult & { policyId?: string }> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  const parsed = setPolicySchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodFieldErrors(parsed.error) };
  const v = parsed.data;
  const supabase = await createClient();
  if (v.brandId) {
    const brand = await ownBrand(supabase, who.tenantId, v.brandId);
    if (!brand.ok) return { ok: false, message: brand.message };
  }
  const { data, error } = await supabase.rpc("set_adjustment_policy", {
    p_tenant: who.tenantId,
    p_brand: v.brandId,
    p_type: v.adjustmentType,
    p_component: v.component,
    p_handling: v.handling,
    p_note: v.note ?? null,
  });
  if (error) return { ok: false, message: failure(error, { notFound: CUSTOMER_NOT_FOUND, overlap: "This overlaps another decision for the same adjustment. End that one first." }) };
  if (typeof data !== "string") return { ok: false, message: GENERIC_FAILURE };
  revalidateAdjustments();
  return { ok: true, policyId: data, message: "Saved." };
}

/** Ends a decision (it reads "Not decided" afterwards). */
export async function endPolicy(policyId: string): Promise<AdjustmentActionResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(policyId)) return { ok: false, message: ITEM_NOT_FOUND };
  const supabase = await createClient();
  const owned = await ownsRow(supabase, "adjustment_policies", policyId, who.tenantId);
  if (owned !== "yes") return { ok: false, message: owned === "no" ? "Decision not found." : GENERIC_FAILURE };
  const { error } = await supabase.rpc("end_adjustment_policy", { p_policy: policyId });
  if (error) return { ok: false, message: failure(error, { notFound: "Decision not found." }) };
  revalidateAdjustments();
  return { ok: true, message: "Decision ended." };
}

// ---------------------------------------------------------------------------
// History import: upload -> mapping -> validation -> commit
// ---------------------------------------------------------------------------
const EDITABLE = ["uploaded", "mapped", "validated"] as const;
const FILENAME_MAX_CHARS = 255;
const MIME_MAX_CHARS = 120;
const IMPORT_NAME_MAX_CHARS = 160;
/** The extension a file name loses when it becomes an import's name: ".csv" in "August history.csv"; "history.pdf" keeps its end. */
const EXTENSION = /\.(csv|xlsx|txt)$/i;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Step 1. The file is parsed and every header of every sheet is run through the guard BEFORE anything is stored: a file that looks like
 * carrier cost data leaves no uploaded_files row and no import row (and the message says so). Only then is it stored, as the caller
 * (brand_id null, purpose adjustment_import), and registered as an import. Redirects to the import's page.
 */
export async function uploadAdjustmentFile(_prev: UploadState, formData: FormData): Promise<UploadState> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, errors: { file: "Choose a .csv or .xlsx file of what your customers were charged for past adjustments." } };
  if (file.size > ADJUSTMENT_FILE_LIMITS.maxBytes) return { ok: false, errors: { file: `The file is larger than 5 MB. Split it by month and import each part. The limits are ${IMPORT_LIMITS}.` } };

  const supabase = await createClient();
  if (await limited(supabase, RATE_LIMITS.upload)) return { ok: false, message: RATE_LIMITED_MESSAGE };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = await parseAdjustmentFile(bytes, { filename: file.name, mimeType: file.type }).catch(() => null);
  if (!parsed) return { ok: false, errors: { file: "The file could not be read." } };
  // The guard has run over every header. A refusal stores nothing: no file, no import, no header list, no cell.
  if (parsed.status === "refused") return { ok: false, refused: true, message: parsed.message };
  if (parsed.status === "error") return { ok: false, errors: { file: parsed.message } };

  const { count, error: countError } = await supabase.from("adjustment_imports").select("id", { count: "exact", head: true }).eq("tenant_id", who.tenantId).in("status", ["uploaded", "mapped", "validated", "committing"]);
  if (countError) return { ok: false, message: GENERIC_FAILURE };
  // Checked before the file is stored: everything that can be known without storing anything is known first.
  if ((count ?? 0) >= 5) return { ok: false, message: "You already have five imports in progress. Finish or discard one first." };

  const detected = await (async () => {
    const [catalog, brands] = await Promise.all([loadServiceCatalog(supabase), loadAdjustmentBrands(supabase, who.tenantId)]);
    const detection = detectAdjustmentFile(parsed.tables, { catalog, brands: brands.map((b) => ({ id: b.id, name: b.name })) });
    return { ...buildDetected(parsed.tables, detection.suggestion), kind: parsed.kind };
  })().catch(() => null);
  if (!detected) return { ok: false, errors: { file: "The file could not be read." } };

  // The order that cannot leave a file behind: (1) everything above ran without storing a byte; (2) the file is stored (the database scans its
  // bytes again in a trigger and refuses a cost-looking header or an unreadable encoding); (3) the import is created from it. A failure at
  // step 3, a thrown error included, removes the file through `discard_unattached_adjustment_file` (the Data API roles hold no DELETE).
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // The file's name is the browser's text: control characters (a NUL would fail the whole insert) are replaced before anything is sent.
  const safeFilename = cleanText(file.name, FILENAME_MAX_CHARS).text ?? "upload";
  const { data: stored, error: fileError } = await supabase
    .from("uploaded_files")
    .insert({
      tenant_id: who.tenantId,
      purpose: "adjustment_import",
      filename: safeFilename,
      mime_type: cleanText(file.type, MIME_MAX_CHARS).text ?? (parsed.kind === "csv" ? "text/csv" : XLSX_MIME),
      byte_size: bytes.length,
      sha256: `\\x${sha256}`,
      content: `\\x${Buffer.from(bytes).toString("hex")}`,
    })
    .select("id")
    .single();
  if (fileError || !stored) return fileInsertFailure(fileError);
  const fileId = String(stored.id);

  const name = safeFilename.replace(EXTENSION, "").trim().slice(0, IMPORT_NAME_MAX_CHARS) || "Adjustment history";
  const created = await createImport(supabase, fileId, name, detected);
  if (created.kind === "refused") return { ok: false, refused: true, message: created.message };
  if (created.kind === "failed") return { ok: false, message: created.message };
  revalidateAdjustments();
  redirect(`${HISTORY_PATH}/${created.importId}`);
}

/** What an uploaded_files insert that the database refused means for the person (the insert trigger writes its reason in the hint). */
function fileInsertFailure(error: DbError | null): UploadState {
  if (error?.code === "P0001" && error.hint === "forbidden_header") return { ok: false, refused: true, message: refusalMessage(String(error.details ?? "")) };
  if (error?.code === "P0001" && error.hint === "unsupported_encoding") return { ok: false, errors: { file: ENCODING_MESSAGE } };
  if (error?.code === "P0001" && error.hint === "too_many_unattached_files") return { ok: false, message: "You already have uploaded files waiting for an import. Finish or discard an import first." };
  if (error?.code === "42501") return { ok: false, message: NO_PERMISSION_MANAGE };
  return { ok: false, message: GENERIC_FAILURE };
}

type CreatedImport = { kind: "created"; importId: string } | { kind: "refused"; message: string } | { kind: "failed"; message: string };

/**
 * Registers the stored file as an import. Whatever goes wrong, the file does not stay behind: the database deletes it itself when it refuses a
 * header or an encoding (create_adjustment_import returns {ok:false}); for every other failure (an error from the database, an answer we cannot
 * read, a thrown error, a refused rate limit) it is discarded here. When even that fails the person is told, so the file is not silently left.
 */
async function createImport(supabase: Db, fileId: string, name: string, detected: unknown): Promise<CreatedImport> {
  const discard = async (message: string): Promise<CreatedImport> => {
    let removed = false;
    try {
      const { error } = await supabase.rpc("discard_unattached_adjustment_file", { p_file: fileId });
      // "Not found" (P0002) is the same answer for a file that is gone and for one an import holds now: neither is an unattached file left behind.
      removed = !error || error.code === "P0002";
    } catch {
      removed = false;
    }
    return { kind: "failed", message: removed ? message : `${message} ${FILE_NOT_REMOVED}` };
  };
  try {
    const { data, error } = await supabase.rpc("create_adjustment_import", { p_file: fileId, p_name: name, p_detected: scrubJsonb(detected) });
    if (error) return await discard(failure(error, { notFound: "The uploaded file was not found. Upload it again." }));
    const created = data as { ok?: boolean; reason?: string; header?: string; importId?: string } | null;
    // The database ran its own scan over the stored file and deleted the file itself whenever it answers {ok:false} (nothing to discard then).
    if (created?.ok === false && created.reason === "forbidden_header") return { kind: "refused", message: refusalMessage(String(created.header ?? "")) };
    if (created?.ok === false && created.reason === "unsupported_encoding") return { kind: "failed", message: ENCODING_MESSAGE };
    if (created?.ok === false) return { kind: "failed", message: GENERIC_FAILURE };
    if (!created?.ok || !idOk(created.importId)) return await discard(GENERIC_FAILURE);
    return { kind: "created", importId: created.importId };
  } catch {
    return await discard(GENERIC_FAILURE);
  }
}

type ImportFile = { ok: true; tables: Table[] } | { ok: false; message: string };

/** The stored file read again (the header guard runs again, over every sheet). */
async function readImportFile(supabase: Db, tenantId: string, imp: ImportDetail): Promise<ImportFile> {
  if (!imp.fileId) return { ok: false, message: "The uploaded file is no longer available. Upload it again." };
  const file = await readStoredUpload(supabase, tenantId, imp.fileId).catch(() => "failed" as const);
  if (file === "failed") return { ok: false, message: GENERIC_FAILURE };
  if (!file) return { ok: false, message: "The uploaded file is no longer available. Upload it again." };
  const parsed = await parseAdjustmentFile(file.bytes, { filename: file.filename, mimeType: file.mimeType }).catch(() => null);
  if (!parsed) return { ok: false, message: "The file could not be read." };
  if (parsed.status !== "ok") return { ok: false, message: parsed.message };
  return { ok: true, tables: parsed.tables };
}

/** The mapping stored on the import and the header row it reads, or why there is none. */
function storedMapping(imp: ImportDetail, tables: Table[]): { ok: true; mapping: AdjustmentMapping; headers: string[] } | { ok: false; message: string } {
  const mapping = parseStoredMapping(imp.mapping);
  if (!mapping) return { ok: false, message: "Save the mapping first." };
  const table = tables.find((t) => t.name === mapping.sheet);
  const headers = table?.rows[mapping.headerRow];
  if (!headers) return { ok: false, message: "The sheet in the saved mapping is not in the file any more. Save the mapping again." };
  return { ok: true, mapping, headers };
}

/** Step 2. Saves what the 3PL chose. The mapping is checked against the file again here (and its headers against the guard); a flagged header can never reach a money field. */
export async function saveImportMapping(importId: string, mappingJson: unknown): Promise<MappingActionResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(importId)) return { ok: false, message: "Import not found." };
  const parsedMapping = adjustmentMappingSchema.safeParse(mappingJson);
  if (!parsedMapping.success) return { ok: false, message: `The mapping is incomplete: ${parsedMapping.error.issues[0]?.path.join(".")} ${parsedMapping.error.issues[0]?.message}` };
  const mapping = parsedMapping.data;
  const supabase = await createClient();
  if (await limited(supabase, RATE_LIMITS.mapping)) return { ok: false, message: RATE_LIMITED_MESSAGE };

  const imp = await loadImportDetail(supabase, who.tenantId, importId).catch(() => "failed" as const);
  if (imp === "failed") return { ok: false, message: GENERIC_FAILURE };
  if (!imp) return { ok: false, message: "Import not found." };
  if (!(EDITABLE as readonly string[]).includes(imp.status)) return { ok: false, message: "This import is no longer being edited." };

  const read = await readImportFile(supabase, who.tenantId, imp);
  if (!read.ok) return { ok: false, message: read.message };
  const context = await importContext(supabase, who.tenantId).catch(() => null);
  if (!context) return { ok: false, message: GENERIC_FAILURE };
  const issues = validateMapping(mapping, read.tables, context);
  if (issues.length) return { ok: false, message: issues[0]!.message, issues };

  const headers = read.tables.find((t) => t.name === mapping.sheet)!.rows[mapping.headerRow]!;
  // The mapping is compacted: only the value-map entries that applying it would not work out by itself are stored.
  const { data, error } = await supabase.rpc("set_adjustment_import_mapping", {
    p_import: importId,
    p_mapping: scrubJsonb(toStoredMapping(mapping, headers, context)),
    p_validation: null,
    p_duplicate_handling: mapping.duplicateHandling,
    p_attested: false,
  });
  if (error) return { ok: false, message: failure(error, { notFound: "Import not found.", state: "This import is no longer being edited." }) };
  revalidateAdjustments();
  return { ok: true, status: typeof data === "string" ? data : "mapped", message: "Mapping saved." };
}

/** What the mapping needs from outside the file: the service catalog and the account's customers. */
async function importContext(supabase: Db, tenantId: string): Promise<Pick<AdjustmentContext, "catalog" | "brands">> {
  const [catalog, brands] = await Promise.all([loadServiceCatalog(supabase), loadAdjustmentBrands(supabase, tenantId)]);
  return { catalog, brands: brands.map((b) => ({ id: b.id, name: b.name })) };
}

/**
 * The file with the saved mapping applied, "already imported" rows left out. Reads the history already committed (every committed import, through
 * the bulk reader: the unique key has no date, so a package can repeat one of an import that does not overlap in time) so a file is never imported
 * twice and the counts the 3PL approves are the counts that commit.
 */
async function prepareImport(supabase: Db, tenantId: string, tables: Table[], mapping: AdjustmentMapping): Promise<AdjustmentImportResult & { context: Pick<AdjustmentContext, "catalog" | "brands"> }> {
  const context = await importContext(supabase, tenantId);
  const ctx = { ...context, today: todayIso() };
  const first = applyAdjustmentMapping(tables, mapping, ctx);
  if (!first.report.ok) return { ...first, context };
  const existingKeys = await loadExistingKeys(supabase, tenantId);
  return { ...(existingKeys.size ? applyAdjustmentMapping(tables, mapping, { ...ctx, existingKeys }) : first), context };
}

/**
 * Step 3. Reads the stored file again, applies the saved mapping, builds the report and stores it. The attestation (these columns hold what
 * the customer was charged, not what the carrier billed) is required before anything is validated; it is stored with the import and audited.
 * The import is marked validated only when the file can be committed; a report with rows to fix is returned but not stored.
 */
export async function validateImport(importId: string, attested: boolean): Promise<ValidateActionResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(importId)) return { ok: false, message: "Import not found." };
  if (attested !== true) return { ok: false, errors: { attested: ATTESTATION_REQUIRED }, message: ATTESTATION_REQUIRED };
  const supabase = await createClient();
  if (await limited(supabase, RATE_LIMITS.validate)) return { ok: false, message: RATE_LIMITED_MESSAGE };

  const imp = await loadImportDetail(supabase, who.tenantId, importId).catch(() => "failed" as const);
  if (imp === "failed") return { ok: false, message: GENERIC_FAILURE };
  if (!imp) return { ok: false, message: "Import not found." };
  if (!(EDITABLE as readonly string[]).includes(imp.status)) return { ok: false, message: "This import is no longer being edited." };
  const file = await readImportFile(supabase, who.tenantId, imp);
  if (!file.ok) return { ok: false, message: file.message };
  const saved = storedMapping(imp, file.tables);
  if (!saved.ok) return { ok: false, message: saved.message };
  const result = await prepareImport(supabase, who.tenantId, file.tables, saved.mapping).catch(() => null);
  if (!result) return { ok: false, message: GENERIC_FAILURE };

  const report = result.report;
  if (!report.ok) return { ok: false, message: report.mappingIssues[0]?.message ?? "The mapping cannot be applied to this file.", report };
  if (!report.committable) {
    // A report with rows to fix is shown, not stored; an earlier "validated" mark no longer holds.
    if (imp.status === "validated") {
      await supabase.rpc("set_adjustment_import_mapping", { p_import: importId, p_mapping: imp.mapping, p_validation: null, p_duplicate_handling: imp.duplicateHandling, p_attested: false });
      revalidateAdjustments();
    }
    return { ok: false, status: imp.status === "validated" ? "mapped" : imp.status, message: "Some rows need fixing before this file can be imported.", report };
  }

  const { data, error } = await supabase.rpc("set_adjustment_import_mapping", {
    p_import: importId,
    p_mapping: scrubJsonb(toStoredMapping(saved.mapping, saved.headers, result.context)),
    p_validation: scrubJsonb(toStoredValidation(report)),
    p_duplicate_handling: saved.mapping.duplicateHandling,
    p_attested: true,
  });
  if (error) return { ok: false, message: failure(error, { notFound: "Import not found.", state: "This import is no longer being edited." }), report };
  revalidateAdjustments();
  return { ok: true, status: typeof data === "string" ? data : "validated", report, message: "Checked. Nothing is imported until you confirm." };
}

/**
 * Step 4. Sends the validated rows in chunks of at most 2,000, in order, to the database, checks that what was stored plus what was already
 * imported equals what the 3PL validated, then finalizes (which deletes the uploaded file). On any failure the import is reset and nothing of
 * it stays. The file is read again and must read exactly as it did when it was approved.
 */
export async function commitImport(importId: string): Promise<CommitActionResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(importId)) return { ok: false, message: "Import not found." };
  const supabase = await createClient();
  if (await limited(supabase, RATE_LIMITS.commit)) return { ok: false, message: RATE_LIMITED_MESSAGE };

  const imp = await loadImportDetail(supabase, who.tenantId, importId).catch(() => "failed" as const);
  if (imp === "failed") return { ok: false, message: GENERIC_FAILURE };
  if (!imp) return { ok: false, message: "Import not found." };
  if (imp.status === "committed") return { ok: false, message: "This import has already been committed." };
  if (imp.status !== "validated" && imp.status !== "committing") return { ok: false, message: "Check the file first: nothing is imported until it has been validated." };
  if (!imp.attestedAt) return { ok: false, message: ATTESTATION_REQUIRED };
  const file = await readImportFile(supabase, who.tenantId, imp);
  if (!file.ok) return { ok: false, message: file.message };
  const saved = storedMapping(imp, file.tables);
  if (!saved.ok) return { ok: false, message: saved.message };
  const result = await prepareImport(supabase, who.tenantId, file.tables, saved.mapping).catch(() => null);
  if (!result) return { ok: false, message: GENERIC_FAILURE };
  // What is sent must be what the 3PL checked and attested to: the same rows, the same number to add.
  if (!result.report.ok || !result.report.committable || result.report.counts.accepted !== imp.acceptedCount || result.report.counts.rows !== imp.rowCount) {
    return { ok: false, message: "The file reads differently now (something was imported since it was checked). Validate it again before importing." };
  }
  let plan;
  try {
    plan = buildAppendChunks(result);
  } catch (err) {
    return { ok: false, message: err instanceof ChunkError ? err.message : GENERIC_FAILURE };
  }

  const rollBack = async (): Promise<boolean> => {
    const { error } = await supabase.rpc("reset_adjustment_import", { p_import: importId });
    return !error;
  };
  const stopped = async (message: string): Promise<CommitActionResult> => {
    const reset = await rollBack();
    return { ok: false, message: reset ? message : `${message} The import could not be rolled back automatically: discard it and upload the file again.` };
  };

  // An interrupted commit (a closed tab, an error in a later chunk) is rolled back and started over.
  if (imp.status === "committing" && !(await rollBack())) return { ok: false, message: GENERIC_FAILURE };

  let last: AppendResult | null = null;
  try {
    for (const chunk of plan.chunks) {
      const { data, error } = await supabase.rpc("append_adjustment_records", { p_import: importId, p_from_row: chunk.fromRow, p_rows: chunk.rows });
      if (error) return await stopped(failure(error, { notFound: "Import not found.", state: "This import is not accepting rows." }));
      last = data as AppendResult;
      // The database's cursor must stand where the chunk ends; anything else means rows were lost or repeated.
      if (typeof last?.nextRow === "number" && last.nextRow !== chunk.fromRow + chunk.rows.length) return await stopped("The upload got out of step and was reset. Start the import again.");
    }
  } catch {
    return await stopped(GENERIC_FAILURE);
  }
  const reconciled = reconcileCommit(plan.accepted, last);
  if (!reconciled.ok) return await stopped(reconciled.message);

  const { error: finalizeError } = await supabase.rpc("finalize_adjustment_import", { p_import: importId });
  if (finalizeError) return await stopped(failure(finalizeError, { notFound: "Import not found.", state: "This import is not being committed.", reconcile: "The rows stored do not match the rows checked, so the import was not finished." }));
  revalidateAdjustments();
  return { ok: true, committed: reconciled.committed, skipped: reconciled.skipped, message: reconciled.message };
}

/** Throws away an import that is not committed: its rows and its uploaded file are deleted and it cannot be reopened. */
export async function discardImport(importId: string): Promise<AdjustmentActionResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(importId)) return { ok: false, message: "Import not found." };
  const supabase = await createClient();
  const owned = await ownsRow(supabase, "adjustment_imports", importId, who.tenantId);
  if (owned !== "yes") return { ok: false, message: owned === "no" ? "Import not found." : GENERIC_FAILURE };
  const { error } = await supabase.rpc("discard_adjustment_import", { p_import: importId });
  if (error) return { ok: false, message: failure(error, { notFound: "Import not found.", state: "A committed import is withdrawn, not discarded." }) };
  revalidateAdjustments();
  return { ok: true, message: "Import discarded." };
}

/** Takes a committed import back: its records are deleted. Refused while a saved risk estimate was made from it. */
export async function withdrawImport(importId: string): Promise<AdjustmentActionResult & { deleted?: number }> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(importId)) return { ok: false, message: "Import not found." };
  const supabase = await createClient();
  const owned = await ownsRow(supabase, "adjustment_imports", importId, who.tenantId);
  if (owned !== "yes") return { ok: false, message: owned === "no" ? "Import not found." : GENERIC_FAILURE };
  const { data, error } = await supabase.rpc("withdraw_adjustment_import", { p_import: importId });
  if (error) return { ok: false, message: failure(error, { notFound: "Import not found.", state: "Only a committed import can be withdrawn." }) };
  revalidateAdjustments();
  const deleted = (data as { deleted?: number } | null)?.deleted;
  return { ok: true, deleted: typeof deleted === "number" ? deleted : undefined, message: "Import withdrawn. Its records were deleted." };
}

// ---------------------------------------------------------------------------
// Baselines: how many packages shipped (the denominator of how often adjustments happen)
// ---------------------------------------------------------------------------
/** Saves a baseline (a new one, or an edit when `id` is given). The unit is the carrier package. */
export async function saveBaseline(input: unknown): Promise<AdjustmentActionResult & { baselineId?: string }> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  const parsed = baselineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodFieldErrors(parsed.error) };
  const v = parsed.data;
  const supabase = await createClient();
  if (v.brandId) {
    const brand = await ownBrand(supabase, who.tenantId, v.brandId);
    if (!brand.ok) return { ok: false, message: brand.message };
  }
  if (v.id) {
    const owned = await ownsRow(supabase, "adjustment_baselines", v.id, who.tenantId);
    if (owned !== "yes") return { ok: false, message: owned === "no" ? "Baseline not found." : GENERIC_FAILURE };
  }
  const { data, error } = await supabase.rpc("save_adjustment_baseline", {
    p_tenant: who.tenantId,
    p_brand: v.brandId,
    p_carrier: v.carrierCode,
    p_service: v.serviceId,
    p_start: v.periodStart,
    p_end: v.periodEnd,
    p_packages: v.packagesTotal,
    p_missing: v.labelsMissingWeight,
    p_note: v.note ?? null,
    p_id: v.id ?? null,
  });
  if (error) return { ok: false, message: failure(error, { notFound: "The customer, carrier, service or baseline was not found.", overlap: "This overlaps another baseline for the same customer, carrier and service. Change the dates or edit that one." }) };
  if (typeof data !== "string") return { ok: false, message: GENERIC_FAILURE };
  revalidateAdjustments();
  return { ok: true, baselineId: data, message: "Baseline saved." };
}

export async function deleteBaseline(baselineId: string): Promise<AdjustmentActionResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(baselineId)) return { ok: false, message: "Baseline not found." };
  const supabase = await createClient();
  const owned = await ownsRow(supabase, "adjustment_baselines", baselineId, who.tenantId);
  if (owned !== "yes") return { ok: false, message: owned === "no" ? "Baseline not found." : GENERIC_FAILURE };
  const { error } = await supabase.rpc("delete_adjustment_baseline", { p_id: baselineId });
  if (error) return { ok: false, message: failure(error, { notFound: "Baseline not found." }) };
  revalidateAdjustments();
  return { ok: true, message: "Baseline deleted." };
}

// ---------------------------------------------------------------------------
// History statistics
// ---------------------------------------------------------------------------
/**
 * How often, and how much: the statistics of the account's committed history for the chosen filters, with the typed baselines as the
 * denominator. The records are read through the database's bulk reader (1,000 a call) and summarised here; only the summary comes back,
 * never a record. A statistic without a baseline has no incidence (it says so); nothing is guessed.
 */
async function statisticsFor(supabase: Db, tenantId: string, f: HistoryFiltersInput): Promise<HistoryStatsResponse> {
  const today = todayIso();
  try {
    const [history, baselines] = await Promise.all([loadCommittedHistory(supabase, tenantId, numeratorKeep(f)), loadBaselines(supabase, tenantId)]);
    const statistics = summariseHistory(history.records, toHistoryBaselines(baselines), {
      brandId: f.brandId,
      carrierCode: f.carrierCode ?? null,
      serviceId: f.serviceId ?? null,
      adjustmentType: f.adjustmentType ?? null,
      cause: f.cause ?? null,
      window: f.window ?? null,
      baselineIds: f.baselineIds ?? null,
      maturityDays: f.maturityDays ?? null,
      today,
    });
    if (statistics.status === "refused") return { status: "refused", refusal: statistics };
    return { status: "ok", statistics, importIds: history.importIds, recordsRead: history.recordsRead, asOf: today };
  } catch (err) {
    // Only the engine's own refusal is "too large"; any other RangeError (a call stack, an array length) is a fault, not a statement about the history.
    if (err instanceof AdjustmentOverflowError) return { status: "error", message: "An amount in the history is too large to add up exactly." };
    return { status: "error", message: "Your history could not be read. Please try again." };
  }
}

export async function loadHistoryStatistics(input: unknown): Promise<HistoryStatsResponse> {
  const who = await actor("adjustment.view");
  if (!who) return { status: "error", message: NO_PERMISSION_VIEW };
  const parsed = historyFiltersSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", problems: zodProblems(parsed.error), errors: zodFieldErrors(parsed.error) };
  const supabase = await createClient();
  if (await limited(supabase, RATE_LIMITS.statistics)) return { status: "error", message: RATE_LIMITED_MESSAGE };
  if (parsed.data.brandId) {
    const brand = await ownBrand(supabase, who.tenantId, parsed.data.brandId);
    if (!brand.ok) return { status: "error", message: brand.message };
  }
  return statisticsFor(supabase, who.tenantId, parsed.data);
}

// ---------------------------------------------------------------------------
// Examples (scenarios): what would it cost if this package is corrected
// ---------------------------------------------------------------------------
type Evaluated =
  | {
      kind: "ok";
      result: AdjustmentScenarioResult;
      input: ReturnType<typeof buildScenarioInput>;
      context: Extract<ScenarioContext, { ok: true }>;
      brandId: string | null;
      brandName: string | null;
      shipDate: string;
    }
  | { kind: "invalid"; problems: string[]; errors?: Record<string, string> }
  | { kind: "error"; message: string };

/**
 * Prices the example on the server: the customer's own pricing context with the unfiltered rule set (an absorbed fee rule is still visible to
 * the staff evaluation), the decisions on who pays as they stand today, and the fee schedule's percent-of-shipping count for the notice. The
 * browser supplies the package and the correction; names and codes of the service come from the rate card.
 */
async function evaluateOnServer(supabase: Db, who: Actor, form: ScenarioBuilderInput): Promise<Evaluated> {
  let brandName: string | null = null;
  if (form.brandId) {
    const brand = await ownBrand(supabase, who.tenantId, form.brandId);
    if (!brand.ok) return { kind: "error", message: brand.message };
    brandName = brand.name;
  }
  const shipDate = form.shipDate ?? todayIso();
  const context = await loadScenarioContext(supabase, { tenantId: who.tenantId, brandId: form.brandId, rateCardId: form.rateCardId ?? null, serviceId: form.serviceId, shipDate });
  if (!context.ok) {
    const field = context.error === "no_version_in_effect" ? "shipDate" : context.error === "service_not_available" ? "serviceId" : context.error === "card_not_assigned" || context.error === "no_card" ? "rateCardId" : null;
    return field ? { kind: "invalid", problems: [`${field}: ${context.message}`], errors: { [field]: context.message } } : { kind: "error", message: context.message };
  }
  let policies;
  try {
    policies = await loadPolicies(supabase, who.tenantId);
  } catch {
    return { kind: "error", message: "The decisions on who pays could not be loaded. Please try again." };
  }
  // Resolved for TODAY, as the database does when it saves and when it publishes (a decision that changes in between is refused there).
  const policyFn = policyFnFor(toPolicyRows(policies), form.brandId, todayIso());
  const input = buildScenarioInput(form, context.service, shipDate);
  let result: AdjustmentScenarioResult;
  try {
    result = evaluateAdjustmentScenario(input, context.snapshot.context, policyFn, { percentOfShippingFeeCount: context.percentOfShippingFeeCount });
  } catch {
    // The engine throws only for a state it cannot price exactly; the person sees a sentence, never a stack.
    return { kind: "error", message: "This example could not be priced. Check the numbers and try again." };
  }
  return { kind: "ok", result, input, context, brandId: form.brandId, brandName, shipDate };
}

/** Prices an example without storing anything. Needs `adjustment.view`. */
export async function evaluateScenario(input: unknown): Promise<ScenarioEvalResponse> {
  const who = await actor("adjustment.view");
  if (!who) return { status: "error", message: NO_PERMISSION_VIEW };
  const parsed = scenarioInputSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", problems: zodProblems(parsed.error), errors: zodFieldErrors(parsed.error) };
  const supabase = await createClient();
  if (await limited(supabase, RATE_LIMITS.evaluate)) return { status: "error", message: RATE_LIMITED_MESSAGE };
  const e = await evaluateOnServer(supabase, who, parsed.data);
  if (e.kind === "invalid") return { status: "invalid", problems: e.problems, errors: e.errors };
  if (e.kind === "error") return { status: "error", message: e.message };
  return {
    status: "ok",
    result: e.result,
    context: {
      brandId: e.brandId,
      brandName: e.brandName,
      rateCardId: e.context.card.id,
      rateCardName: e.context.card.name,
      rateCardVersionNumber: e.context.snapshot.version.versionNumber,
      pricedOn: e.shipDate,
      loadIssues: e.context.snapshot.issues,
    },
  };
}

const SAVE_REASONS: Record<string, string> = {
  not_priced: "This example could not be priced, so it cannot be saved.",
  no_service: "This example has no service, so it cannot be saved.",
  amount_out_of_range: "An amount in this example is too large to save.",
};

/**
 * Prices the example again on the server (never trusting a result from the browser) and stores it through `save_adjustment_scenario`, which
 * checks every pin against the account and resolves the decisions itself. Needs `adjustment.manage`.
 */
export async function saveScenario(input: unknown, name: string): Promise<SaveScenarioResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  const parsedName = scenarioNameSchema.safeParse(name);
  if (!parsedName.success) return { ok: false, errors: { name: parsedName.error.issues[0]?.message ?? "Give the example a name." } };
  const parsed = scenarioInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodFieldErrors(parsed.error), message: zodProblems(parsed.error)[0] };
  const supabase = await createClient();
  if (await limited(supabase, RATE_LIMITS.save)) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const e = await evaluateOnServer(supabase, who, parsed.data);
  if (e.kind === "invalid") return { ok: false, errors: e.errors, message: e.problems[0] };
  if (e.kind === "error") return { ok: false, message: e.message };

  const storedInput = scenarioStorageInput(e.input, e.result);
  const storedResult = scenarioStorageResult(e.result);
  if (!storedInput.ok || !storedResult.ok) {
    const reason = !storedInput.ok ? storedInput.reason : !storedResult.ok ? storedResult.reason : "not_priced";
    return { ok: false, message: `${SAVE_REASONS[reason] ?? SAVE_REASONS.not_priced}${e.result.message ? ` ${e.result.message}` : ""}` };
  }
  const pins = scenarioPins(e.context.snapshot, e.input.shipment, storedResult.value.adjustmentType, e.brandId);
  const { data, error } = await supabase.rpc("save_adjustment_scenario", {
    p_tenant: who.tenantId,
    p_brand: e.brandId,
    p_name: parsedName.data,
    p_type: storedResult.value.adjustmentType,
    p_input: storedInput.value,
    p_result: storedResult.value,
    p_pins: pins,
    p_engine_version: ADJUSTMENT_ENGINE_VERSION,
  });
  if (error) return { ok: false, message: failure(error, { notFound: "The customer, rate card or rule was not found.", reconcile: "The decision on who pays changed while the example was being built. Price it again." }) };
  if (typeof data !== "string") return { ok: false, message: GENERIC_FAILURE };
  revalidateAdjustments();
  return { ok: true, scenarioId: data, message: "Example saved." };
}

export async function archiveScenario(scenarioId: string): Promise<AdjustmentActionResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(scenarioId)) return { ok: false, message: "Example not found." };
  const supabase = await createClient();
  const owned = await ownsRow(supabase, "adjustment_scenarios", scenarioId, who.tenantId);
  if (owned !== "yes") return { ok: false, message: owned === "no" ? "Example not found." : GENERIC_FAILURE };
  const { error } = await supabase.rpc("archive_adjustment_scenario", { p_id: scenarioId });
  if (error) return { ok: false, message: failure(error, { notFound: "Example not found." }) };
  revalidateAdjustments();
  return { ok: true, message: "Example archived." };
}

// ---------------------------------------------------------------------------
// Sharing an example with a customer
// ---------------------------------------------------------------------------
/** The scenario and the customer must both be the session workspace's own. */
async function ownScenarioAndBrand(supabase: Db, tenantId: string, scenarioId: string, brandId: string): Promise<string | null> {
  if (!idOk(scenarioId)) return "Example not found.";
  if (!idOk(brandId)) return CUSTOMER_NOT_FOUND;
  const owned = await ownsRow(supabase, "adjustment_scenarios", scenarioId, tenantId);
  if (owned !== "yes") return owned === "no" ? "Example not found." : GENERIC_FAILURE;
  const brand = await ownBrand(supabase, tenantId, brandId);
  return brand.ok ? null : brand.message;
}

/** Exactly what the customer would read (the same builder as the share, in SQL), and what is withheld. Stores nothing; a refusal to share is data, not an error. */
export async function previewExample(scenarioId: string, brandId: string): Promise<AdjustmentActionResult & { preview?: ExamplePreview }> {
  const who = await actor("adjustment.view");
  if (!who) return { ok: false, message: NO_PERMISSION_VIEW };
  const supabase = await createClient();
  const problem = await ownScenarioAndBrand(supabase, who.tenantId, scenarioId, brandId);
  if (problem) return { ok: false, message: problem };
  const { data, error } = await supabase.rpc("preview_customer_example", { p_source: scenarioId, p_brand: brandId });
  if (error) return { ok: false, message: error.code === "42501" ? NO_PERMISSION_VIEW : failure(error, { notFound: "Example not found." }) };
  const raw = data as Record<string, unknown> | null;
  if (!raw || typeof raw.ok !== "boolean" || !Array.isArray(raw.problems)) return { ok: false, message: GENERIC_FAILURE };
  const preview: ExamplePreview = {
    ok: raw.ok,
    problems: (raw.problems as { code?: unknown; message?: unknown }[]).map((p) => ({ code: String(p.code ?? ""), message: String(p.message ?? "") })),
    ...(raw.payload !== undefined ? { payload: raw.payload } : {}),
    ...(Array.isArray(raw.hidden) ? { hidden: (raw.hidden as { kind?: unknown; reason?: unknown }[]).map((h) => ({ kind: String(h.kind ?? ""), reason: String(h.reason ?? "") })) } : {}),
    ...(Array.isArray(raw.warnings) ? { warnings: (raw.warnings as unknown[]).map(String) } : {}),
    ...(typeof raw.pricedOn === "string" ? { pricedOn: raw.pricedOn } : {}),
    ...(typeof raw.ratesEffectiveFrom === "string" ? { ratesEffectiveFrom: raw.ratesEffectiveFrom } : {}),
    ...(typeof raw.validThrough === "string" ? { validThrough: raw.validThrough } : {}),
  };
  return { ok: true, preview };
}

/**
 * Shares a saved example with one customer. Only text comes from here (a title, an optional note the customer reads, an optional shorter
 * "shown until" date, an optional private note): the database builds what the customer sees from the stored example, refuses anything that
 * is not shareable (naming why) and stops the previous copy in the same transaction.
 */
export async function publishExample(input: unknown): Promise<AdjustmentActionResult & { exampleId?: string }> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodFieldErrors(parsed.error) };
  const v = parsed.data;
  const supabase = await createClient();
  const problem = await ownScenarioAndBrand(supabase, who.tenantId, v.scenarioId, v.brandId);
  if (problem) return { ok: false, message: problem };
  const { data, error } = await supabase.rpc("publish_customer_example", {
    p_source: v.scenarioId,
    p_brand: v.brandId,
    p_title: v.title,
    p_note: v.note ?? null,
    p_valid_through: v.validThrough ?? null,
    p_internal_note: v.internalNote ?? null,
  });
  if (error) return { ok: false, message: failure(error, { notFound: "The example or the customer was not found.", badInput: "The title or the note was not accepted. Use plain text." }) };
  if (typeof data !== "string") return { ok: false, message: GENERIC_FAILURE };
  revalidateAdjustments({ customers: true });
  return { ok: true, exampleId: data, message: "Shared with the customer." };
}

/** Stops sharing an example; the customer stops seeing it at once, and the row stays so you can show what they saw on a given date. */
export async function retireExample(exampleId: string): Promise<AdjustmentActionResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(exampleId)) return { ok: false, message: "Shared example not found." };
  const supabase = await createClient();
  const owned = await ownsRow(supabase, "published_adjustment_examples", exampleId, who.tenantId);
  if (owned !== "yes") return { ok: false, message: owned === "no" ? "Shared example not found." : GENERIC_FAILURE };
  const { error } = await supabase.rpc("retire_customer_example", { p_example: exampleId });
  if (error) return { ok: false, message: failure(error, { notFound: "Shared example not found." }) };
  revalidateAdjustments({ customers: true });
  return { ok: true, message: "No longer shared." };
}

/** The examples shared with customers, each with the state the database computes now (current, under review with its causes, expired). */
export async function listExamples(): Promise<AdjustmentActionResult & { examples?: ExampleListItem[] }> {
  const who = await actor("adjustment.view");
  if (!who) return { ok: false, message: NO_PERMISSION_VIEW };
  const supabase = await createClient();
  try {
    return { ok: true, examples: await listExampleRows(supabase, who.tenantId) };
  } catch {
    return { ok: false, message: "The shared examples could not be loaded. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Risk estimate
// ---------------------------------------------------------------------------
const COMPONENTS: readonly PolicyComponent[] = ["postage_difference", "separate_fee"];
const WEIGHTS_FROM_PRODUCTS = "That run priced packages on weights worked out from product weights, so it is not a forecast on actual weights. Choose declared weights, or enter the volume yourself.";
const WEIGHTS_UNKNOWN = "That run does not say whether its weights came from product weights, so it cannot be used as a forecast on actual weights. Choose declared weights, or enter the volume yourself.";

type RiskEvaluated =
  | { kind: "ok"; response: Extract<RiskForecastResponse, { status: "ok" }>; stored: StoredRiskInputs; brandId: string | null }
  | Exclude<RiskForecastResponse, { status: "ok" }>;

async function riskOnServer(supabase: Db, who: Actor, form: RiskFormInput): Promise<RiskEvaluated> {
  if (form.brandId) {
    const brand = await ownBrand(supabase, who.tenantId, form.brandId);
    if (!brand.ok) return { status: "error", message: brand.message };
  }
  const today = todayIso();

  // Who pays, from the decisions as they stand today (the database compares them again when an estimate is saved).
  let policyRows;
  try {
    policyRows = toPolicyRows(await loadPolicies(supabase, who.tenantId));
  } catch {
    return { status: "error", message: "The decisions on who pays could not be loaded. Please try again." };
  }
  const handling = Object.fromEntries(COMPONENTS.map((c) => [c, resolveHandling(policyRows, form.brandId, form.adjustmentType, c, today)])) as Record<PolicyComponent, Handling>;

  // Volume: typed, or the monthly packages of a finished run of this customer's file.
  let volume: string;
  let run: RiskRunVolume | null = null;
  if (form.volume.source === "entered") volume = form.volume.packagesPerMonth;
  else {
    try {
      run = await loadRunVolume(supabase, who.tenantId, form.brandId!, form.volume.runId);
    } catch {
      return { status: "error", message: "The run could not be loaded. Please try again." };
    }
    if (!run) return { status: "invalid", problems: ["volume: That run is not available for this customer."], errors: { volume: "That run is not available for this customer." } };
    volume = run.monthlyPackages;
    // A run priced on weights derived from product weights is not a forecast on actual weights: the postage difference would be counted twice or not at all.
    if (form.basis === "actual_weights" && run.weightsFromProductProfiles !== false) {
      const message = run.weightsFromProductProfiles ? WEIGHTS_FROM_PRODUCTS : WEIGHTS_UNKNOWN;
      return { status: "invalid", problems: [`basis: ${message}`], errors: { basis: message } };
    }
  }

  // History: one reading serves the incidence and every severity that comes from it.
  let stats: Extract<HistoryStatsResponse, { status: "ok" }> | null = null;
  let usedFilters: HistoryFiltersInput | null = null;
  const usesHistory = form.incidence.source === "history" || COMPONENTS.some((c) => form.severity[c].source === "history");
  if (usesHistory) {
    const h = form.history!;
    const filters: HistoryFiltersInput = {
      brandId: form.brandId,
      carrierCode: h.carrierCode ?? null,
      serviceId: h.serviceId ?? null,
      adjustmentType: h.adjustmentType === undefined ? form.adjustmentType : h.adjustmentType,
      cause: h.cause ?? null,
      window: h.window ?? null,
      baselineIds: h.baselineIds ?? null,
      maturityDays: h.maturityDays ?? null,
    };
    usedFilters = filters;
    const s = await statisticsFor(supabase, who.tenantId, filters);
    if (s.status === "refused") return { status: "invalid", problems: [s.refusal.message], errors: { history: s.refusal.message } };
    if (s.status !== "ok") return { status: "error", message: s.status === "error" ? s.message : GENERIC_FAILURE };
    stats = s;
  }

  // "One example shipment" severities come from a saved example of this kind of adjustment and this customer.
  const exampleSeverities: Partial<Record<PolicyComponent, number | null>> = {};
  for (const c of COMPONENTS) {
    const choice = form.severity[c];
    if (choice.source !== "example") continue;
    let scenario;
    try {
      scenario = await loadScenario(supabase, who.tenantId, choice.scenarioId);
    } catch {
      return { status: "error", message: "The saved example could not be loaded. Please try again." };
    }
    if (!scenario) return { status: "invalid", problems: [`severity: ${ITEM_NOT_FOUND}`], errors: { severity: "That saved example was not found." } };
    if (scenario.adjustmentType !== form.adjustmentType || (scenario.brandId !== null && scenario.brandId !== form.brandId)) {
      const message = "That saved example is for a different kind of adjustment or a different customer.";
      return { status: "invalid", problems: [`severity: ${message}`], errors: { severity: message } };
    }
    exampleSeverities[c] = exampleSeverity(scenario.result, c);
  }

  const built = riskInputsFrom(form, { volume, handling, statistics: stats?.statistics ?? null, exampleSeverity: exampleSeverities });
  if (!built.ok) return { status: "invalid", problems: built.problems };
  let forecast;
  try {
    forecast = forecastAdjustmentRisk(built.inputs);
  } catch {
    return { status: "error", message: "This estimate could not be calculated. Check the numbers and try again." };
  }
  if (forecast.status === "refused") return { status: "refused", code: forecast.code, message: forecast.message };

  const inc = built.inputs.incidence;
  const severity = Object.fromEntries(
    COMPONENTS.map((c) => {
      const s = built.inputs.severity[c];
      const choice = form.severity[c];
      return [c, { source: s.source, e4: s.e4, n: s.n ?? null, ...(choice.source === "example" ? { scenarioId: choice.scenarioId } : {}) }];
    }),
  ) as StoredRiskInputs["severity"];
  const importIds = stats?.importIds ?? [];
  const stored: StoredRiskInputs = {
    v: 1,
    adjustmentType: form.adjustmentType,
    basis: form.basis,
    credits: form.credits,
    volume: { source: form.volume.source, monthlyPackages: volume, ...(run ? { runId: run.runId } : {}) },
    incidence: inc.source === "history" ? { source: "history", k: inc.k, N: inc.N } : { source: "entered", pct: inc.pct },
    severity,
    history: stats
      ? {
          // The filters as they were applied (the type defaults to the estimate's own), so the saved estimate says what it counted.
          filters: { ...usedFilters },
          recordsInScope: stats.statistics.recordsInScope,
          affected: stats.statistics.affected,
          baselineIds: stats.statistics.baseline.ids,
          periods: stats.statistics.baseline.periods,
          counts: riskHistoryCounts(stats.statistics),
        }
      : null,
    importIds,
  };
  return {
    kind: "ok",
    brandId: form.brandId,
    stored,
    response: {
      status: "ok",
      forecast,
      sources: {
        volume: { source: form.volume.source, monthlyPackages: volume, run },
        incidence:
          inc.source === "history"
            ? { source: "history", k: inc.N > 0 ? inc.k : (stats?.statistics.affected ?? null), N: inc.N > 0 ? inc.N : null, pctAsEntered: null, history: stats ? riskHistoryCounts(stats.statistics) : null }
            : { source: "entered", k: null, N: null, pctAsEntered: inc.pct, history: null },
        severity: Object.fromEntries(COMPONENTS.map((c) => [c, { source: severity[c].source, e4: severity[c].e4, n: severity[c].n ?? null }])) as Extract<RiskForecastResponse, { status: "ok" }>["sources"]["severity"],
        handling,
        credits: form.credits,
        statistics: stats?.statistics ?? null,
        importIds,
      },
    },
  };
}

/**
 * What adjustments could add each month: volume x incidence x severity, bucketed by who pays, with the weights basis required (no default) so
 * a postage difference is counted exactly once. An estimate from the numbers supplied: never a forecast of an invoice, never added to a
 * shipping or all-in figure. Stores nothing.
 */
export async function forecastRisk(input: unknown): Promise<RiskForecastResponse> {
  const who = await actor("adjustment.view");
  if (!who) return { status: "error", message: NO_PERMISSION_VIEW };
  const parsed = riskInputSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", problems: zodProblems(parsed.error), errors: zodFieldErrors(parsed.error) };
  const supabase = await createClient();
  if (await limited(supabase, RATE_LIMITS.forecast)) return { status: "error", message: RATE_LIMITED_MESSAGE };
  const r = await riskOnServer(supabase, who, parsed.data);
  return "kind" in r ? r.response : (r as Exclude<RiskForecastResponse, { status: "ok" }>);
}

/** Calculates the estimate again on the server and stores it, with its inputs BY VALUE (so a later change of the history cannot change it). */
export async function saveRiskEstimate(input: unknown, name: string): Promise<SaveEstimateResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  const parsedName = estimateNameSchema.safeParse(name);
  if (!parsedName.success) return { ok: false, errors: { name: parsedName.error.issues[0]?.message ?? "Give the estimate a name." } };
  const parsed = riskInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodFieldErrors(parsed.error), message: zodProblems(parsed.error)[0] };
  const supabase = await createClient();
  if (await limited(supabase, RATE_LIMITS.save)) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const r = await riskOnServer(supabase, who, parsed.data);
  if (!("kind" in r)) {
    if (r.status === "invalid") return { ok: false, errors: r.errors, message: r.problems[0] };
    return { ok: false, message: r.status === "refused" ? r.message : r.status === "error" ? r.message : GENERIC_FAILURE };
  }
  // A saved estimate names the imports it was made from (withdrawing one is refused while it is cited); the database holds at most 50.
  if (r.stored.importIds.length > 50) return { ok: false, message: "This estimate draws on more than 50 imports. Narrow the window or the filters, then save it again." };
  const { data, error } = await supabase.rpc("save_risk_estimate", {
    p_tenant: who.tenantId,
    p_brand: r.brandId,
    p_name: parsedName.data,
    p_inputs: r.stored,
    p_result: riskStorageResult(r.response.forecast),
    p_engine_version: ADJUSTMENT_ENGINE_VERSION,
  });
  if (error) return { ok: false, message: failure(error, { notFound: "The customer or an import was not found.", reconcile: "The decision on who pays changed while the estimate was being made. Calculate it again." }) };
  if (typeof data !== "string") return { ok: false, message: GENERIC_FAILURE };
  revalidateAdjustments();
  return { ok: true, estimateId: data, message: "Estimate saved." };
}

export async function archiveRiskEstimate(estimateId: string): Promise<AdjustmentActionResult> {
  const who = await actor("adjustment.manage");
  if (!who) return { ok: false, message: NO_PERMISSION_MANAGE };
  if (!idOk(estimateId)) return { ok: false, message: "Estimate not found." };
  const supabase = await createClient();
  const owned = await ownsRow(supabase, "risk_estimates", estimateId, who.tenantId);
  if (owned !== "yes") return { ok: false, message: owned === "no" ? "Estimate not found." : GENERIC_FAILURE };
  const { error } = await supabase.rpc("archive_risk_estimate", { p_id: estimateId });
  if (error) return { ok: false, message: failure(error, { notFound: "Estimate not found." }) };
  revalidateAdjustments();
  return { ok: true, message: "Estimate archived." };
}
