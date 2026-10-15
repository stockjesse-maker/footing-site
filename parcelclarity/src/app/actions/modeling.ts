"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { calculateShipment } from "@/engine/calculate";
import { ENGINE_VERSION, type ShipmentInput } from "@/engine/types";
import type { ActionState } from "@/lib/actions";
import { getContext, requireUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { fieldErrors, uuidSchema } from "@/lib/auth/validation";
import { ORDER_FILE_LIMITS, ParseError, detectFileKind, parseTables, type Table } from "@/lib/import/parse-table";
import { priceBatchCore, createBatchCaches, type ProjectRecord, type RunProgress, type RunRecord } from "@/lib/modeling/run";
import { detectOrderFile } from "@/lib/orders/mapping";
import { orderMappingSchema, runSettingsSchema } from "@/lib/orders/mapping-schema";
import { buildMaterialisePayloads } from "@/lib/orders/materialise";
import type { OrderMapping, SkuProfileInput } from "@/lib/orders/types";
import { applyOrderMapping } from "@/lib/orders/validate";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { calculatorRequestSchema } from "@/lib/pricing/calculator-schema";
import { loadPricingContext } from "@/lib/pricing/snapshot";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for customer shipping modeling (Milestone 3). Brand members act for their own
 * brand; 3PL staff act on behalf of a customer by naming the brand. Every query runs under the
 * caller's Row Level Security and every lifecycle change goes through a database function that
 * authorises on the row, so a forged brand id can only ever return "not found".
 */

const GENERIC_FAILURE = "Something went wrong. Please try again.";

interface ModelingContext {
  tenantId: string;
  brandId: string;
  staff: boolean;
  basePath: string;
}

/** Resolves who is modeling for which brand. Staff must name a brand of their tenant; brand members are bound to their own. */
async function modelingContext(brandIdFromForm: unknown): Promise<ModelingContext | null> {
  await requireUser();
  const ctx = await getContext();
  if (!ctx || !can(ctx.active.role, "simulation.run")) return null;
  if (ctx.active.portal === "brand") {
    return { tenantId: ctx.active.tenantId, brandId: ctx.active.brandId!, staff: false, basePath: "/portal/model" };
  }
  const brandId = String(brandIdFromForm ?? "");
  if (!uuidSchema.safeParse(brandId).success) return null;
  const supabase = await createClient();
  const { data: brand } = await supabase.from("brands").select("id, tenant_id, status").eq("id", brandId).maybeSingle();
  if (!brand || brand.tenant_id !== ctx.active.tenantId) return null;
  return { tenantId: ctx.active.tenantId, brandId, staff: true, basePath: `/app/customers/${brandId}/model` };
}

function revalidateModeling(m: ModelingContext) {
  revalidatePath(m.basePath, "layout");
  revalidatePath(m.staff ? `/app/customers/${m.brandId}` : "/portal", "layout");
}

// ---------------------------------------------------------------------------
// Order files: upload → mapping → validation → materialise
// ---------------------------------------------------------------------------
export async function uploadOrderFile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const m = await modelingContext(formData.get("brandId"));
  if (!m) return { ok: false, message: "You don't have permission to model costs for this customer." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, errors: { file: "Choose a .csv or .xlsx orders file." } };
  if (file.size > ORDER_FILE_LIMITS.maxBytes) return { ok: false, errors: { file: "Order files must be 15 MB or smaller; split the export by month." } };

  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "modeling.upload", 30, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };

  const bytes = new Uint8Array(await file.arrayBuffer());
  let detection;
  let kind;
  try {
    kind = detectFileKind(file.name, file.type, bytes);
    const tables = await parseTables(bytes, kind, ORDER_FILE_LIMITS);
    detection = detectOrderFile(tables, await loadServiceCatalog(supabase));
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, errors: { file: err.message } };
    return { ok: false, errors: { file: "The file could not be read." } };
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { data: stored, error: fileError } = await supabase
    .from("uploaded_files")
    .insert({
      tenant_id: m.tenantId,
      brand_id: m.brandId,
      purpose: "order_import",
      filename: file.name.slice(0, 255),
      mime_type: (file.type || (kind === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).slice(0, 120),
      byte_size: bytes.length,
      sha256: `\\x${sha256}`,
      content: `\\x${Buffer.from(bytes).toString("hex")}`,
    })
    .select("id")
    .single();
  if (fileError || !stored) return { ok: false, message: GENERIC_FAILURE };

  const { data: dataset, error } = await supabase
    .from("order_datasets")
    .insert({ tenant_id: m.tenantId, brand_id: m.brandId, file_id: stored.id, name: file.name.replace(/\.(csv|xlsx|txt)$/i, "").slice(0, 160) || "Orders", detected: { ...detection, kind, filename: file.name } })
    .select("id")
    .single();
  if (error || !dataset) return { ok: false, message: GENERIC_FAILURE };
  redirect(`${m.basePath}/orders/${dataset.id}`);
}

interface DatasetRow {
  id: string;
  tenant_id: string;
  brand_id: string;
  file_id: string;
  status: string;
  mapping: OrderMapping | null;
  shared_with_brand: boolean;
}

async function loadDataset(datasetId: string, m: ModelingContext) {
  const supabase = await createClient();
  const { data } = await supabase.from("order_datasets").select("id, tenant_id, brand_id, file_id, status, mapping, shared_with_brand").eq("id", datasetId).maybeSingle();
  const ds = data as DatasetRow | null;
  if (!ds || ds.tenant_id !== m.tenantId || ds.brand_id !== m.brandId) return null;
  return { supabase, ds };
}

async function loadDatasetTables(supabase: Awaited<ReturnType<typeof createClient>>, fileId: string): Promise<Table[] | null> {
  const { data: file } = await supabase.from("uploaded_files").select("filename, mime_type, content").eq("id", fileId).maybeSingle();
  if (!file) return null;
  const hex = String(file.content).replace(/^\\x/, "");
  const bytes = new Uint8Array(Buffer.from(hex, "hex"));
  return parseTables(bytes, detectFileKind(file.filename, file.mime_type, bytes), ORDER_FILE_LIMITS);
}

async function loadSkuProfiles(supabase: Awaited<ReturnType<typeof createClient>>, brandId: string): Promise<SkuProfileInput[]> {
  const { data } = await supabase.from("sku_profiles").select("sku, unit_weight, weight_unit, length_in, width_in, height_in").eq("brand_id", brandId).limit(20000);
  return (data ?? []).map((p) => ({
    sku: String(p.sku),
    unitWeightLb: p.weight_unit === "oz" ? String(Number(p.unit_weight) / 16) : String(p.unit_weight),
    lengthIn: p.length_in === null ? null : String(p.length_in),
    widthIn: p.width_in === null ? null : String(p.width_in),
    heightIn: p.height_in === null ? null : String(p.height_in),
  }));
}

export async function saveOrderMapping(datasetId: string, mappingJson: unknown, brandId?: string): Promise<{ ok: boolean; message?: string }> {
  const m = await modelingContext(brandId);
  if (!m || !uuidSchema.safeParse(datasetId).success) return { ok: false, message: "Not found." };
  const parsed = orderMappingSchema.safeParse(mappingJson);
  if (!parsed.success) return { ok: false, message: `The mapping is incomplete: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
  const loaded = await loadDataset(datasetId, m);
  if (!loaded) return { ok: false, message: "Orders file not found." };
  const { supabase, ds } = loaded;
  if (!["uploaded", "mapped", "validated"].includes(ds.status)) return { ok: false, message: "This file has already been processed." };

  let tables;
  try {
    tables = await loadDatasetTables(supabase, ds.file_id);
  } catch (err) {
    return { ok: false, message: err instanceof ParseError ? err.message : GENERIC_FAILURE };
  }
  if (!tables) return { ok: false, message: "The uploaded file is no longer available." };
  const skuProfiles = parsed.data.useSkuProfiles ? await loadSkuProfiles(supabase, m.brandId) : [];
  const result = applyOrderMapping(tables, parsed.data, { skuProfiles });
  const { error } = await supabase
    .from("order_datasets")
    .update({ mapping: parsed.data, validation: { ...result.report, sampleOrders: result.orders.slice(0, 5) }, status: result.report.ok ? "validated" : "mapped" })
    .eq("id", datasetId);
  if (error) return { ok: false, message: GENERIC_FAILURE };
  revalidateModeling(m);
  return { ok: true };
}

/** Turns the validated file into orders/shipments/packages rows (whole orders per chunk, one transaction each). */
export async function materialiseDataset(datasetId: string, brandId?: string): Promise<{ ok: boolean; message?: string }> {
  const m = await modelingContext(brandId);
  if (!m || !uuidSchema.safeParse(datasetId).success) return { ok: false, message: "Not found." };
  const loaded = await loadDataset(datasetId, m);
  if (!loaded) return { ok: false, message: "Orders file not found." };
  const { supabase, ds } = loaded;
  if (ds.status !== "validated" || !ds.mapping) return { ok: false, message: "Review and save the mapping first." };
  if (!(await withinRateLimit(supabase, "modeling.materialise", 20, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };

  let tables;
  try {
    tables = await loadDatasetTables(supabase, ds.file_id);
  } catch (err) {
    return { ok: false, message: err instanceof ParseError ? err.message : GENERIC_FAILURE };
  }
  if (!tables) return { ok: false, message: "The uploaded file is no longer available." };
  const skuProfiles = ds.mapping.useSkuProfiles ? await loadSkuProfiles(supabase, m.brandId) : [];
  const result = applyOrderMapping(tables, ds.mapping, { skuProfiles });
  if (!result.report.ok) return { ok: false, message: "The file no longer validates; review the mapping." };

  for (const payload of buildMaterialisePayloads(result.orders)) {
    const { error } = await supabase.rpc("materialise_order_rows", {
      p_dataset: datasetId,
      p_orders: payload.orders,
      p_lines: payload.lines,
      p_shipments: payload.shipments,
      p_packages: payload.packages,
    });
    if (error) return { ok: false, message: error.message.includes("not ready") ? "This file has already been processed." : GENERIC_FAILURE };
  }
  const { error: finError } = await supabase.rpc("finalize_order_dataset", { p_dataset: datasetId });
  if (finError) return { ok: false, message: GENERIC_FAILURE };
  revalidateModeling(m);
  return { ok: true };
}

export async function discardDataset(datasetId: string, brandId?: string): Promise<{ ok: boolean; message?: string }> {
  const m = await modelingContext(brandId);
  if (!m || !uuidSchema.safeParse(datasetId).success) return { ok: false, message: "Not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("discard_order_dataset", { p_dataset: datasetId });
  if (error) return { ok: false, message: error.message.includes("used by a scenario") ? "This file is used by a saved scenario; archive the scenario first." : "Orders file not found." };
  revalidateModeling(m);
  return { ok: true };
}

/** Staff only: make a dataset they prepared visible to the customer. */
export async function shareDataset(datasetId: string, shared: boolean, brandId: string): Promise<{ ok: boolean; message?: string }> {
  const m = await modelingContext(brandId);
  if (!m || !m.staff || !uuidSchema.safeParse(datasetId).success) return { ok: false, message: "Not found." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("order_datasets").update({ shared_with_brand: shared }).eq("id", datasetId).eq("brand_id", m.brandId).select("id");
  if (error || !data?.length) return { ok: false, message: "Orders file not found." };
  revalidateModeling(m);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Scenarios and runs
// ---------------------------------------------------------------------------
function readRunSettings(formData: FormData) {
  return runSettingsSchema.safeParse({
    pricingBasis: formData.get("pricingBasis") ?? "fixed_date",
    asOfDate: formData.get("asOfDate") ?? "",
    serviceOverrideId: formData.get("serviceOverrideId") ?? "",
    unmappedPolicy: formData.get("unmappedPolicy") ?? "exclude",
    overrideAllServices: formData.get("overrideAllServices") === "on",
    residentialDefault: formData.get("residentialDefault") === "yes" ? true : formData.get("residentialDefault") === "no" ? false : null,
    originZipDefault: formData.get("originZipDefault") ?? "",
  });
}

/** Creates a bulk scenario for a ready orders file and starts its first run. */
export async function createBulkScenario(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const m = await modelingContext(formData.get("brandId"));
  if (!m) return { ok: false, message: "You don't have permission to model costs for this customer." };
  const ids = z.object({ datasetId: uuidSchema, rateCardId: uuidSchema, name: z.string().trim().max(160) }).safeParse({ datasetId: formData.get("datasetId"), rateCardId: formData.get("rateCardId"), name: formData.get("name") ?? "" });
  const settings = readRunSettings(formData);
  if (!ids.success) return { ok: false, message: "Choose a rate card." };
  if (!settings.success) return { ok: false, errors: fieldErrors(settings.error) };
  if (settings.data.pricingBasis === "fixed_date" && !settings.data.asOfDate) return { ok: false, errors: { asOfDate: "Choose the date whose rates to use." } };

  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "modeling.run", 60, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const { data: ds } = await supabase.from("order_datasets").select("id, name, brand_id, status").eq("id", ids.data.datasetId).maybeSingle();
  if (!ds || ds.brand_id !== m.brandId || ds.status !== "ready") return { ok: false, message: "The orders file is not ready." };
  const name = ids.data.name || `${ds.name} · ${settings.data.serviceOverrideId && settings.data.overrideAllServices ? "one service" : "services in file"} · ${settings.data.pricingBasis === "fixed_date" ? `rates as of ${settings.data.asOfDate}` : "rates on each ship date"}`;

  const { data: project, error } = await supabase
    .from("simulation_projects")
    .insert({ tenant_id: m.tenantId, brand_id: m.brandId, kind: "bulk", name: name.slice(0, 160), dataset_id: ds.id, rate_card_id: ids.data.rateCardId })
    .select("id")
    .single();
  if (error || !project) return { ok: false, message: error?.code === "42501" ? "That rate card is not assigned to this customer." : GENERIC_FAILURE };

  const started = await startRun(supabase, project.id, settings.data);
  if (!started.ok) return { ok: false, message: started.message };
  redirect(`${m.basePath}/runs/${started.runId}`);
}

async function startRun(supabase: Awaited<ReturnType<typeof createClient>>, projectId: string, s: z.infer<typeof runSettingsSchema>): Promise<{ ok: true; runId: string } | { ok: false; message: string }> {
  const { data, error } = await supabase.rpc("start_simulation_run", {
    p_project: projectId,
    p_pricing_basis: s.pricingBasis,
    p_as_of_date: s.asOfDate,
    p_service_override: s.serviceOverrideId,
    p_unmapped_policy: s.unmappedPolicy,
    p_assumptions: { residentialDefault: s.residentialDefault, originZipDefault: s.originZipDefault, overrideAllServices: s.overrideAllServices },
  });
  if (error) {
    const msg = error.message;
    if (msg.includes("not assigned")) return { ok: false, message: "That rate card is not assigned to this customer." };
    if (msg.includes("not available on")) return { ok: false, message: "That service is not on the customer's rate card." };
    if (msg.includes("as-of date")) return { ok: false, message: "Choose the date whose rates to use." };
    if (msg.includes("not ready")) return { ok: false, message: "The orders file is not ready." };
    return { ok: false, message: GENERIC_FAILURE };
  }
  return { ok: true, runId: String(data) };
}

/** Starts another run of an existing scenario with new settings (the previous runs are kept). */
export async function rerunScenario(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const m = await modelingContext(formData.get("brandId"));
  if (!m) return { ok: false, message: "You don't have permission to model costs for this customer." };
  const projectId = String(formData.get("projectId") ?? "");
  const settings = readRunSettings(formData);
  if (!uuidSchema.safeParse(projectId).success) return { ok: false, message: GENERIC_FAILURE };
  if (!settings.success) return { ok: false, errors: fieldErrors(settings.error) };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "modeling.run", 60, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const started = await startRun(supabase, projectId, settings.data);
  if (!started.ok) return { ok: false, message: started.message };
  redirect(`${m.basePath}/runs/${started.runId}`);
}

export type AdvanceResponse = { ok: true; progress: RunProgress } | { ok: false; message: string; retryable: boolean };

/** Prices the next windows of a run (≈4 s of work) and returns the server's view of progress. */
export async function advanceRun(runId: string, brandId?: string): Promise<AdvanceResponse> {
  const m = await modelingContext(brandId);
  if (!m || !uuidSchema.safeParse(runId).success) return { ok: false, message: "Run not found.", retryable: false };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "modeling.batch", 3000, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE, retryable: true };
  const { data: run } = await supabase
    .from("simulation_runs")
    .select("id, tenant_id, brand_id, project_id, kind, status, pricing_basis, as_of_date, service_override_id, unmapped_policy, assumptions, total_shipments, processed_shipments, next_row_no, partial_summary")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.brand_id !== m.brandId || run.tenant_id !== m.tenantId) return { ok: false, message: "Run not found.", retryable: false };
  const { data: project } = await supabase.from("simulation_projects").select("id, rate_card_id, dataset_id").eq("id", run.project_id).maybeSingle();
  if (!project) return { ok: false, message: "Scenario not found.", retryable: false };
  if (run.status !== "running") return { ok: true, progress: { status: run.status, nextRow: run.next_row_no, processed: run.processed_shipments, total: run.total_shipments, batchMs: 0 } };
  try {
    const progress = await priceBatchCore(supabase, run as RunRecord, project as ProjectRecord, { caches: createBatchCaches() });
    if (progress.status !== "running") revalidateModeling(m);
    return { ok: true, progress };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // Authorization and data problems cannot be retried into success; everything else can.
    const permanent = /unavailable \(rate_card_not_found\)|does not start at the cursor|needs \d+ results/.test(message);
    if (permanent) await supabase.rpc("fail_simulation_run", { p_run: runId, p_error: message });
    return { ok: false, message: permanent ? "The run could not continue: the rate card is no longer available to this customer." : "The run paused; it will resume automatically.", retryable: !permanent };
  }
}

export async function cancelRun(runId: string, brandId?: string): Promise<{ ok: boolean; message?: string }> {
  const m = await modelingContext(brandId);
  if (!m || !uuidSchema.safeParse(runId).success) return { ok: false, message: "Not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_simulation_run", { p_run: runId });
  if (error) return { ok: false, message: "Run not found." };
  revalidateModeling(m);
  return { ok: true };
}

export async function renameScenario(projectId: string, name: string, brandId?: string): Promise<{ ok: boolean; message?: string }> {
  const m = await modelingContext(brandId);
  const parsed = z.object({ projectId: uuidSchema, name: z.string().trim().min(1).max(160) }).safeParse({ projectId, name });
  if (!m || !parsed.success) return { ok: false, message: "Enter a name of up to 160 characters." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("simulation_projects").update({ name: parsed.data.name }).eq("id", projectId).eq("brand_id", m.brandId).select("id");
  if (error || !data?.length) return { ok: false, message: "Scenario not found." };
  revalidateModeling(m);
  return { ok: true };
}

export async function archiveScenario(projectId: string, brandId?: string): Promise<{ ok: boolean; message?: string }> {
  const m = await modelingContext(brandId);
  if (!m || !uuidSchema.safeParse(projectId).success) return { ok: false, message: "Not found." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("simulation_projects").update({ archived_at: new Date().toISOString() }).eq("id", projectId).eq("brand_id", m.brandId).is("archived_at", null).select("id");
  if (error || !data?.length) return { ok: false, message: "Scenario not found." };
  revalidateModeling(m);
  return { ok: true };
}

/** Staff only: make a scenario they prepared visible to the customer (or hide it again). */
export async function shareScenario(projectId: string, shared: boolean, brandId: string): Promise<{ ok: boolean; message?: string }> {
  const m = await modelingContext(brandId);
  if (!m || !m.staff || !uuidSchema.safeParse(projectId).success) return { ok: false, message: "Not found." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("simulation_projects").update({ shared_with_brand: shared }).eq("id", projectId).eq("brand_id", m.brandId).select("id");
  if (error || !data?.length) return { ok: false, message: "Scenario not found." };
  revalidateModeling(m);
  return { ok: true };
}

/**
 * Saves a single-shipment calculation as a scenario. The shipment is priced again on the server
 * from the request (never from a client-supplied result), so what is stored is what the engine said.
 */
export async function saveSingleScenario(request: unknown, name: string, brandId?: string): Promise<{ ok: boolean; message?: string; projectId?: string }> {
  const m = await modelingContext(brandId);
  if (!m) return { ok: false, message: "You don't have permission to model costs for this customer." };
  const parsedName = z.string().trim().min(1, "Give the scenario a name.").max(160).safeParse(name);
  const parsed = calculatorRequestSchema.safeParse(request);
  if (!parsedName.success) return { ok: false, message: parsedName.error.issues[0]?.message };
  if (!parsed.success || parsed.data.service === "*") return { ok: false, message: "Choose one service to save." };
  const req = parsed.data;
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "modeling.save", 120, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const loaded = await loadPricingContext(supabase, { rateCardId: req.rateCardId, shipDate: req.shipDate, brandId: m.brandId });
  if (!loaded.ok) return { ok: false, message: "That rate card is not available to this customer." };
  const service = loaded.snapshot.services.find((s) => `${s.carrierCode}/${s.serviceCode}` === req.service);
  if (!service) return { ok: false, message: "That service is not on the rate card." };
  const input: ShipmentInput = {
    shipDate: req.shipDate,
    originZip: req.originZip,
    destinationZip: req.destinationZip,
    destinationZone: req.destinationZone,
    residential: req.residential,
    carrierCode: service.carrierCode,
    serviceCode: service.serviceCode,
    packages: req.packages.map((p) => ({ weight: p.weight, weightUnit: p.weightUnit, length: p.length, width: p.width, height: p.height, declaredValue: p.declaredValue, packageType: p.packageType, flags: p.flags })),
    options: { signature: req.signature, saturdayDelivery: req.saturdayDelivery },
  };
  const result = calculateShipment(input, loaded.snapshot.context);
  const { data, error } = await supabase.rpc("save_single_simulation", {
    p_brand: m.brandId,
    p_rate_card: req.rateCardId,
    p_name: parsedName.data,
    p_input: input,
    p_result: result,
    p_engine_version: ENGINE_VERSION,
  });
  if (error) return { ok: false, message: error.message.includes("not assigned") ? "That rate card is not assigned to this customer." : GENERIC_FAILURE };
  revalidateModeling(m);
  return { ok: true, projectId: String(data) };
}

// ---------------------------------------------------------------------------
// Product weights (sku_profiles) and settings
// ---------------------------------------------------------------------------
const skuRowSchema = z.object({
  sku: z.string().trim().min(1).max(120),
  unit_weight: z.string().regex(/^\d+(\.\d{1,6})?$/),
  weight_unit: z.enum(["lb", "oz"]),
  length_in: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable(),
  width_in: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable(),
  height_in: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable(),
});

/** Uploads a CSV/XLSX of product weights: columns sku, weight, unit (lb/oz/g/kg), length, width, height (inches). */
export async function uploadSkuProfiles(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const m = await modelingContext(formData.get("brandId"));
  if (!m) return { ok: false, message: "You don't have permission to model costs for this customer." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, errors: { file: "Choose a .csv or .xlsx file with sku and weight columns." } };
  if (file.size > ORDER_FILE_LIMITS.maxBytes) return { ok: false, errors: { file: "Files must be 15 MB or smaller." } };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "modeling.upload", 30, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };

  let tables: Table[];
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    tables = await parseTables(bytes, detectFileKind(file.name, file.type, bytes), ORDER_FILE_LIMITS);
  } catch (err) {
    return { ok: false, errors: { file: err instanceof ParseError ? err.message : "The file could not be read." } };
  }
  const table = tables[0]!;
  const headers = (table.rows[0] ?? []).map((h) => h.toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, ""));
  const col = (...names: string[]) => headers.findIndex((h) => names.includes(h));
  const cSku = col("sku", "variant_sku", "lineitem_sku", "product_sku");
  const cWeight = col("weight", "unit_weight", "variant_grams", "grams", "weight_lb", "weight_oz");
  const cUnit = col("unit", "weight_unit");
  const cL = col("length", "length_in");
  const cW = col("width", "width_in");
  const cH = col("height", "height_in");
  if (cSku === -1 || cWeight === -1) return { ok: false, errors: { file: "Expected columns: sku, weight (and optionally unit, length, width, height)." } };
  const headerUnit: "lb" | "oz" | "g" | "kg" = headers[cWeight]?.includes("grams") ? "g" : headers[cWeight]?.endsWith("_oz") ? "oz" : "lb";

  const rows: z.infer<typeof skuRowSchema>[] = [];
  const problems: string[] = [];
  for (let i = 1; i < table.rows.length && rows.length < 20000; i++) {
    const r = table.rows[i]!;
    if (r.every((c) => c === "")) continue;
    const unitCell = cUnit === -1 ? "" : (r[cUnit] ?? "").trim().toLowerCase();
    const unit: "lb" | "oz" | "g" | "kg" = /^(oz|ozs|ounces?)$/.test(unitCell) ? "oz" : /^(lbs?|pounds?)$/.test(unitCell) ? "lb" : /^(g|grams?)$/.test(unitCell) ? "g" : /^(kg|kilograms?)$/.test(unitCell) ? "kg" : headerUnit;
    const raw = (r[cWeight] ?? "").trim().replace(/,/g, "");
    if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
      problems.push(`Row ${i + 1}: weight "${r[cWeight] ?? ""}" is not a positive number.`);
      continue;
    }
    // Metric units are converted to pounds (six decimals, half up); lb/oz are kept as given.
    const weightLb = unit === "g" ? (Number(raw) / 453.59237).toFixed(6) : unit === "kg" ? ((Number(raw) * 1000) / 453.59237).toFixed(6) : null;
    const dims = [cL, cW, cH].map((c) => (c === -1 ? "" : (r[c] ?? "").trim()));
    const dimsGiven = dims.filter(Boolean).length;
    if (dimsGiven !== 0 && dimsGiven !== 3) {
      problems.push(`Row ${i + 1}: give all three dimensions or none.`);
      continue;
    }
    const candidate = skuRowSchema.safeParse({
      sku: r[cSku] ?? "",
      unit_weight: weightLb ?? raw,
      weight_unit: weightLb ? "lb" : unit,
      length_in: dimsGiven ? dims[0] : null,
      width_in: dimsGiven ? dims[1] : null,
      height_in: dimsGiven ? dims[2] : null,
    });
    if (!candidate.success) {
      problems.push(`Row ${i + 1}: ${candidate.error.issues[0]?.path.join(".")} is not valid.`);
      continue;
    }
    rows.push(candidate.data);
  }
  if (!rows.length) return { ok: false, errors: { file: problems[0] ?? "No product rows were found." } };

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from("sku_profiles")
      .upsert(rows.slice(i, i + 500).map((p) => ({ ...p, tenant_id: m.tenantId, brand_id: m.brandId, source: "file_upload" })), { onConflict: "brand_id,sku_normalized" });
    if (error) return { ok: false, message: GENERIC_FAILURE };
  }
  revalidateModeling(m);
  return { ok: true, message: `${rows.length} product weights saved${problems.length ? `; ${problems.length} rows skipped (first: ${problems[0]})` : "."}` };
}

/** 3PL setting: the warehouse ZIP assumed when an order file carries no origin. */
export async function updateDefaultOriginZip(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();
  const ctx = await getContext();
  if (!ctx || ctx.active.portal !== "tenant" || !can(ctx.active.role, "ratecard.manage")) return { ok: false, message: "You don't have permission to change pricing settings." };
  const parsed = z.object({ zip: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d{5}$/, "Enter a 5-digit ZIP code.").nullable()) }).safeParse({ zip: String(formData.get("defaultOriginZip") ?? "").trim() });
  if (!parsed.success) return { ok: false, errors: { defaultOriginZip: parsed.error.issues[0]?.message ?? "Enter a 5-digit ZIP code." } };
  const supabase = await createClient();
  const { data, error } = await supabase.from("tenants").update({ default_origin_zip: parsed.data.zip }).eq("id", ctx.active.tenantId).select("id");
  if (error || !data?.length) return { ok: false, message: GENERIC_FAILURE };
  revalidatePath("/app/settings");
  return { ok: true, message: "Saved." };
}
