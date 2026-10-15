"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { carrierProfile } from "@/engine/carriers";
import type { ActionState } from "@/lib/actions";
import { fieldErrors, nameSchema, uuidSchema } from "@/lib/auth/validation";
import { requireTenantContext } from "@/lib/auth/session";
import { LIMITS, ParseError, detectFileKind, parseTables } from "@/lib/import/parse-table";
import { detectRateCard, type RateCardMapping } from "@/lib/import/rate-card-mapping";
import { mappingSchema } from "@/lib/import/mapping-schema";
import { applyMapping } from "@/lib/import/rate-card-validate";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

const GENERIC_FAILURE = "Something went wrong. Please try again.";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------
export async function createRateCard(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ name: nameSchema, description: z.string().trim().max(1000).optional() }).safeParse({ name: formData.get("name"), description: formData.get("description") ?? undefined });
  const values = { name: String(formData.get("name") ?? "") };
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error), values };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "ratecard.create", 60, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE, values };
  const { data, error } = await supabase.from("rate_cards").insert({ tenant_id: ctx.active.tenantId, name: parsed.data.name, description: parsed.data.description || null }).select("id").single();
  if (error) {
    if (error.code === "23505") return { ok: false, errors: { name: "You already have a rate card with that name." }, values };
    return { ok: false, message: GENERIC_FAILURE, values };
  }
  revalidatePath("/app/rate-cards");
  redirect(`/app/rate-cards/${data.id}`);
}

export async function renameRateCard(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ id: uuidSchema, name: nameSchema }).safeParse({ id: formData.get("id"), name: formData.get("name") });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { data, error } = await supabase.from("rate_cards").update({ name: parsed.data.name }).eq("id", parsed.data.id).eq("tenant_id", ctx.active.tenantId).select("id");
  if (error?.code === "23505") return { ok: false, errors: { name: "You already have a rate card with that name." } };
  if (error || !data?.length) return { ok: false, message: GENERIC_FAILURE };
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
// Import step 1: upload and detect
// ---------------------------------------------------------------------------
export async function uploadRateCardFile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const rateCardId = String(formData.get("rateCardId") ?? "");
  const file = formData.get("file");
  if (!uuidSchema.safeParse(rateCardId).success) return { ok: false, message: GENERIC_FAILURE };
  if (!(file instanceof File) || file.size === 0) return { ok: false, errors: { file: "Choose a .csv or .xlsx file." } };
  if (file.size > LIMITS.maxBytes) return { ok: false, errors: { file: "Files must be 5 MB or smaller." } };

  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "ratecard.upload", 30, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const { data: card } = await supabase.from("rate_cards").select("id, tenant_id").eq("id", rateCardId).maybeSingle();
  if (!card || card.tenant_id !== ctx.active.tenantId) return { ok: false, message: "Rate card not found." };

  const bytes = new Uint8Array(await file.arrayBuffer());
  let detection;
  let kind;
  try {
    kind = detectFileKind(file.name, file.type, bytes);
    const tables = await parseTables(bytes, kind);
    detection = detectRateCard(tables, await loadServiceCatalog(supabase));
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, errors: { file: err.message } };
    return { ok: false, errors: { file: "The file could not be read." } };
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { data: stored, error: fileError } = await supabase
    .from("uploaded_files")
    .insert({
      tenant_id: ctx.active.tenantId,
      purpose: "rate_card",
      filename: file.name.slice(0, 255),
      mime_type: (file.type || (kind === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).slice(0, 120),
      byte_size: bytes.length,
      sha256: `\\x${sha256}`,
      content: `\\x${Buffer.from(bytes).toString("hex")}`,
    })
    .select("id")
    .single();
  if (fileError || !stored) return { ok: false, message: GENERIC_FAILURE };

  const { data: imp, error: impError } = await supabase
    .from("rate_card_imports")
    .insert({ tenant_id: ctx.active.tenantId, rate_card_id: rateCardId, file_id: stored.id, detected: { ...detection, kind, filename: file.name } })
    .select("id")
    .single();
  if (impError || !imp) return { ok: false, message: GENERIC_FAILURE };
  redirect(`/app/rate-cards/${rateCardId}/import/${imp.id}`);
}

// ---------------------------------------------------------------------------
// Import step 2: approve mapping and validate
// ---------------------------------------------------------------------------

async function loadImport(importId: string, tenantId: string) {
  const supabase = await createClient();
  const { data: imp } = await supabase.from("rate_card_imports").select("id, tenant_id, rate_card_id, file_id, status, detected, mapping, validation, version_id").eq("id", importId).maybeSingle();
  if (!imp || imp.tenant_id !== tenantId) return null;
  return { supabase, imp };
}

async function loadImportTables(supabase: Awaited<ReturnType<typeof createClient>>, fileId: string) {
  const { data: file } = await supabase.from("uploaded_files").select("filename, mime_type, content").eq("id", fileId).maybeSingle();
  if (!file) return null;
  const hex = String(file.content).replace(/^\\x/, "");
  const bytes = new Uint8Array(Buffer.from(hex, "hex"));
  const kind = detectFileKind(file.filename, file.mime_type, bytes);
  return parseTables(bytes, kind);
}

export async function saveMappingAndValidate(importId: string, mappingJson: unknown): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(importId).success) return { ok: false, message: GENERIC_FAILURE };
  const parsedMapping = mappingSchema.safeParse(mappingJson);
  if (!parsedMapping.success) return { ok: false, message: `The mapping is incomplete: ${parsedMapping.error.issues[0]?.path.join(".")} ${parsedMapping.error.issues[0]?.message}` };
  const loaded = await loadImport(importId, ctx.active.tenantId);
  if (!loaded) return { ok: false, message: "Import not found." };
  const { supabase, imp } = loaded;
  if (imp.status === "imported" || imp.status === "discarded") return { ok: false, message: "This import is already finished." };

  let tables;
  try {
    tables = await loadImportTables(supabase, imp.file_id);
  } catch (err) {
    return { ok: false, message: err instanceof ParseError ? err.message : GENERIC_FAILURE };
  }
  if (!tables) return { ok: false, message: "The uploaded file is no longer available." };
  const catalog = await loadServiceCatalog(supabase);
  const result = applyMapping(tables, parsedMapping.data as RateCardMapping, catalog);
  const { error } = await supabase
    .from("rate_card_imports")
    .update({ status: result.report.ok ? "validated" : "mapped", mapping: parsedMapping.data, validation: { ...result.report, sampleRows: result.rows.slice(0, 25) } })
    .eq("id", importId);
  if (error) return { ok: false, message: GENERIC_FAILURE };
  revalidatePath(`/app/rate-cards/${imp.rate_card_id}/import/${importId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Import step 3: create a draft version from a validated import
// ---------------------------------------------------------------------------
export async function createDraftFromImport(importId: string): Promise<{ ok: boolean; message?: string; versionId?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(importId).success) return { ok: false, message: GENERIC_FAILURE };
  const loaded = await loadImport(importId, ctx.active.tenantId);
  if (!loaded) return { ok: false, message: "Import not found." };
  const { supabase, imp } = loaded;
  if (imp.status !== "validated" || !imp.mapping) return { ok: false, message: "Validate the mapping first." };

  let tables;
  try {
    tables = await loadImportTables(supabase, imp.file_id);
  } catch (err) {
    return { ok: false, message: err instanceof ParseError ? err.message : GENERIC_FAILURE };
  }
  if (!tables) return { ok: false, message: "The uploaded file is no longer available." };
  const catalog = await loadServiceCatalog(supabase);
  const result = applyMapping(tables, imp.mapping as RateCardMapping, catalog);
  if (!result.report.ok) return { ok: false, message: "The file no longer validates; review the mapping." };

  const { data: latest } = await supabase.from("rate_card_versions").select("version_number").eq("rate_card_id", imp.rate_card_id).order("version_number", { ascending: false }).limit(1).maybeSingle();
  const versionNumber = (latest?.version_number ?? 0) + 1;
  const { data: version, error: vError } = await supabase
    .from("rate_card_versions")
    .insert({ rate_card_id: imp.rate_card_id, tenant_id: ctx.active.tenantId, version_number: versionNumber, source_file_id: imp.file_id, import_mapping: imp.mapping, validation_summary: { rowCount: result.report.rowCount, warningCount: result.report.warningCount, services: result.report.services }, row_count: result.rows.length })
    .select("id")
    .single();
  if (vError || !version) return { ok: false, message: GENERIC_FAILURE };

  const discard = async () => {
    await supabase.rpc("archive_rate_card_version", { p_version: version.id });
  };

  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const termsRows = result.report.services.map((s) => {
    const carrier = catalogById.get(s.serviceId)?.carrierCode ?? "generic";
    const defaults = carrierProfile(carrier).structuralDefaults;
    const t = result.terms[s.serviceId];
    return {
      version_id: version.id,
      service_id: s.serviceId,
      dim_divisor: t?.dimDivisor ?? null,
      dim_threshold_cubic_in: defaults.thresholdCubicIn,
      dimension_rounding: defaults.dimensionRounding,
      weight_rounding: defaults.weightRounding,
      min_billable_lb: defaults.minBillableLb,
      dim_exempt: defaults.exempt,
      min_charge: t?.minCharge ?? null,
    };
  });
  const { error: tError } = await supabase.from("rate_card_service_terms").insert(termsRows);
  if (tError) {
    await discard();
    return { ok: false, message: GENERIC_FAILURE };
  }

  const BATCH = 1000;
  for (let i = 0; i < result.rows.length; i += BATCH) {
    const batch = result.rows.slice(i, i + BATCH).map((r) => ({
      version_id: version.id,
      service_id: r.serviceId,
      origin_prefix: r.originPrefix,
      zone: r.zone,
      weight_min: r.weightMin,
      weight_max: r.weightMax,
      weight_unit: r.weightUnit,
      price: r.price,
      min_charge: r.minCharge,
    }));
    const { error: rError } = await supabase.from("rate_card_rows").insert(batch);
    if (rError) {
      await discard();
      return { ok: false, message: rError.code === "23505" ? "The file contains duplicate brackets for the same service and zone." : GENERIC_FAILURE };
    }
  }

  await supabase.from("rate_card_imports").update({ status: "imported", version_id: version.id }).eq("id", importId);
  revalidatePath(`/app/rate-cards/${imp.rate_card_id}`, "layout");
  return { ok: true, versionId: version.id };
}

export async function discardImport(importId: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(importId).success) return { ok: false, message: GENERIC_FAILURE };
  const loaded = await loadImport(importId, ctx.active.tenantId);
  if (!loaded) return { ok: false, message: "Import not found." };
  const { supabase, imp } = loaded;
  if (imp.status === "imported") return { ok: false, message: "This import already produced a version." };
  await supabase.from("rate_card_imports").update({ status: "discarded" }).eq("id", importId);
  revalidatePath(`/app/rate-cards/${imp.rate_card_id}`, "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Versions: terms, activation, archiving
// ---------------------------------------------------------------------------
const termsSchema = z.object({
  versionId: uuidSchema,
  serviceId: uuidSchema,
  dimDivisor: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d+(\.\d+)?$/, "Enter a number.").nullable()),
  dimThresholdCubicIn: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d+(\.\d+)?$/, "Enter a number.").nullable()),
  dimensionRounding: z.enum(["none", "nearest_whole", "up_whole"]),
  weightRounding: z.enum(["none", "up_whole_lb", "up_whole_oz"]),
  minBillableLb: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d+(\.\d+)?$/, "Enter a number.").nullable()),
  dimExempt: z.boolean(),
  minCharge: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d+(\.\d+)?$/, "Enter an amount.").nullable()),
  includedSurchargeKeys: z.array(z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/)).max(50),
  excludedSurchargeKeys: z.array(z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/)).max(50),
});

export async function updateServiceTerms(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireTenantContext("ratecard.manage");
  const keys = (name: string) => String(formData.get(name) ?? "").split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
  const parsed = termsSchema.safeParse({
    versionId: formData.get("versionId"),
    serviceId: formData.get("serviceId"),
    dimDivisor: formData.get("dimDivisor"),
    dimThresholdCubicIn: formData.get("dimThresholdCubicIn"),
    dimensionRounding: formData.get("dimensionRounding"),
    weightRounding: formData.get("weightRounding"),
    minBillableLb: formData.get("minBillableLb"),
    dimExempt: formData.get("dimExempt") === "on",
    minCharge: formData.get("minCharge"),
    includedSurchargeKeys: keys("includedSurchargeKeys"),
    excludedSurchargeKeys: keys("excludedSurchargeKeys"),
  });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const t = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rate_card_service_terms")
    .update({
      dim_divisor: t.dimDivisor,
      dim_threshold_cubic_in: t.dimThresholdCubicIn,
      dimension_rounding: t.dimensionRounding,
      weight_rounding: t.weightRounding,
      min_billable_lb: t.minBillableLb,
      dim_exempt: t.dimExempt,
      min_charge: t.minCharge,
      included_surcharge_keys: t.includedSurchargeKeys,
      excluded_surcharge_keys: t.excludedSurchargeKeys,
    })
    .eq("version_id", t.versionId)
    .eq("service_id", t.serviceId)
    .select("id");
  if (error) return { ok: false, message: error.message.includes("not a draft") ? "Only draft versions can be edited." : GENERIC_FAILURE };
  if (!data?.length) return { ok: false, message: "Only draft versions can be edited." };
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: "Saved." };
}

export async function activateVersion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireTenantContext("ratecard.manage");
  const parsed = z
    .object({ versionId: uuidSchema, effectiveDate: isoDate, expirationDate: z.preprocess((v) => (v === "" ? null : v), isoDate.nullable()) })
    .safeParse({ versionId: formData.get("versionId"), effectiveDate: formData.get("effectiveDate"), expirationDate: formData.get("expirationDate") });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("activate_rate_card_version", { p_version: parsed.data.versionId, p_effective: parsed.data.effectiveDate, p_expiration: parsed.data.expirationDate });
  if (error) {
    const m = error.message;
    if (m.includes("already covers")) return { ok: false, errors: { effectiveDate: "Another active version already covers these dates. Archive it or choose different dates." } };
    if (m.includes("needs service terms")) return { ok: false, message: "Every service on the card needs service terms before activation." };
    if (m.includes("no rate rows")) return { ok: false, message: "This version has no rate rows." };
    if (m.includes("only a draft")) return { ok: false, message: "Only a draft version can be activated." };
    if (m.includes("expiration")) return { ok: false, errors: { expirationDate: "Expiration must not precede the effective date." } };
    return { ok: false, message: GENERIC_FAILURE };
  }
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: "Version activated." };
}

export async function archiveVersion(versionId: string): Promise<{ ok: boolean; message?: string }> {
  await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(versionId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_rate_card_version", { p_version: versionId });
  if (error) return { ok: false, message: error.message.includes("already closed") ? "This version is already closed." : "Version not found." };
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true };
}

export async function archiveRateCard(rateCardId: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(rateCardId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data, error } = await supabase.from("rate_cards").update({ status: "archived" }).eq("id", rateCardId).eq("tenant_id", ctx.active.tenantId).select("id");
  if (error || !data?.length) return { ok: false, message: "Rate card not found." };
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Brand assignments
// ---------------------------------------------------------------------------
export async function assignRateCard(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ brandId: uuidSchema, rateCardId: uuidSchema, allowedServiceIds: z.array(uuidSchema).max(100) }).safeParse({
    brandId: formData.get("brandId"),
    rateCardId: formData.get("rateCardId"),
    allowedServiceIds: formData.getAll("allowedServiceIds").map(String).filter(Boolean),
  });
  if (!parsed.success) return { ok: false, message: "Choose a rate card." };
  const supabase = await createClient();
  const { error } = await supabase.from("brand_rate_card_assignments").insert({
    tenant_id: ctx.active.tenantId,
    brand_id: parsed.data.brandId,
    rate_card_id: parsed.data.rateCardId,
    allowed_service_ids: parsed.data.allowedServiceIds.length ? parsed.data.allowedServiceIds : null,
  });
  if (error) {
    if (error.code === "23505") return { ok: false, message: "This rate card is already assigned to the customer." };
    return { ok: false, message: GENERIC_FAILURE };
  }
  revalidatePath(`/app/customers/${parsed.data.brandId}`);
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true, message: "Rate card assigned." };
}

export async function unassignRateCard(assignmentId: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(assignmentId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("brand_rate_card_assignments")
    .update({ unassigned_at: new Date().toISOString(), unassigned_by: ctx.user.id })
    .eq("id", assignmentId)
    .eq("tenant_id", ctx.active.tenantId)
    .is("unassigned_at", null)
    .select("id, brand_id");
  if (error || !data?.length) return { ok: false, message: "Assignment not found." };
  revalidatePath(`/app/customers/${data[0]!.brand_id}`);
  revalidatePath("/app/rate-cards", "layout");
  return { ok: true };
}
