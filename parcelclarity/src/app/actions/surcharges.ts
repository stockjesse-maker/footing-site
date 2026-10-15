"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { SURCHARGE_CATEGORIES } from "@/engine/types";
import { calculationBaseSchema, ruleConditionSchema } from "@/engine/validate";
import type { ActionState } from "@/lib/actions";
import { fieldErrors, nameSchema, uuidSchema } from "@/lib/auth/validation";
import { requireTenantContext } from "@/lib/auth/session";
import { LIMITS, ParseError, detectFileKind, parseTables } from "@/lib/import/parse-table";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

const GENERIC_FAILURE = "Something went wrong. Please try again.";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");
const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/, "Enter a number.");
const optionalDecimal = z.preprocess((v) => (v === "" || v === null ? null : v), decimal.nullable());



const ruleVersionFields = z
  .object({
    name: nameSchema,
    carrierCode: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
    category: z.enum(SURCHARGE_CATEGORIES),
    chargeClass: z.enum(["definite", "estimated", "conditional"]),
    method: z.enum(["flat", "percent", "per_unit"]),
    amount: optionalDecimal,
    percent: optionalDecimal,
    perUnitSize: optionalDecimal,
    perUnitFreeAllowance: optionalDecimal,
    perUnitMinimumCharge: optionalDecimal,
    billableWeightFloorLb: optionalDecimal,
    brandId: z.preprocess((v) => (v === "" || v === null ? null : v), uuidSchema.nullable()),
    base: calculationBaseSchema,
    conditions: z.array(ruleConditionSchema).max(10),
    appliesToServiceIds: z.array(uuidSchema).max(50),
    exclusivityGroup: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/, "Use lowercase letters, digits, dots and underscores.").nullable()),
    exclusivityPriority: z.coerce.number().int().min(0).max(100),
    excludesRuleKeys: z.array(z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/)).max(20),
    perPackage: z.boolean(),
    effectiveDate: isoDate,
    expirationDate: z.preprocess((v) => (v === "" ? null : v), isoDate.nullable()),
    sourceReference: z.string().trim().min(1, "State where this amount comes from (e.g. customer agreement, carrier bulletin and date).").max(500),
    sourceUrl: z.preprocess((v) => (v === "" ? null : v), z.url().nullable()),
  })
  .superRefine((v, ctx) => {
    if (v.method === "flat" && v.amount === null) ctx.addIssue({ code: "custom", path: ["amount"], message: "Enter the flat amount." });
    if (v.method === "percent" && v.percent === null) ctx.addIssue({ code: "custom", path: ["percent"], message: "Enter the percentage." });
    if (v.method === "per_unit" && (v.amount === null || v.perUnitSize === null)) ctx.addIssue({ code: "custom", path: ["amount"], message: "Enter the amount per unit and the unit size." });
    if (v.expirationDate && v.expirationDate < v.effectiveDate) ctx.addIssue({ code: "custom", path: ["expirationDate"], message: "Expiration must not precede the effective date." });
  });

function parseJsonField(formData: FormData, name: string, fallback: unknown): unknown {
  const raw = formData.get(name);
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readRuleFields(formData: FormData) {
  return ruleVersionFields.safeParse({
    name: formData.get("name"),
    carrierCode: formData.get("carrierCode"),
    category: formData.get("category"),
    chargeClass: formData.get("chargeClass"),
    method: formData.get("method"),
    amount: formData.get("amount"),
    percent: formData.get("percent"),
    perUnitSize: formData.get("perUnitSize"),
    perUnitFreeAllowance: formData.get("perUnitFreeAllowance") || "0",
    perUnitMinimumCharge: formData.get("perUnitMinimumCharge") ?? "",
    billableWeightFloorLb: formData.get("billableWeightFloorLb") ?? "",
    brandId: formData.get("brandId") ?? "",
    base: parseJsonField(formData, "base", { kind: "base_rate" }),
    conditions: parseJsonField(formData, "conditions", []),
    appliesToServiceIds: formData.getAll("appliesToServiceIds").map(String).filter(Boolean),
    exclusivityGroup: formData.get("exclusivityGroup") ?? "",
    exclusivityPriority: formData.get("exclusivityPriority") || "0",
    excludesRuleKeys: String(formData.get("excludesRuleKeys") ?? "").split(/[\s,]+/).filter(Boolean),
    perPackage: formData.get("perPackage") !== "off",
    effectiveDate: formData.get("effectiveDate"),
    expirationDate: formData.get("expirationDate") ?? "",
    sourceReference: formData.get("sourceReference"),
    sourceUrl: formData.get("sourceUrl") ?? "",
  });
}

function versionRow(v: z.infer<typeof ruleVersionFields>, tenantId: string, ruleId: string, versionNumber: number) {
  return {
    rule_id: ruleId,
    tenant_id: tenantId,
    version_number: versionNumber,
    charge_class: v.chargeClass,
    applies_to_service_ids: v.appliesToServiceIds.length ? v.appliesToServiceIds : null,
    method: v.method,
    amount: v.method === "percent" ? null : v.amount,
    percent: v.method === "percent" ? v.percent : null,
    per_unit_basis: v.method === "per_unit" ? "declared_value" : null,
    per_unit_size: v.method === "per_unit" ? v.perUnitSize : null,
    per_unit_free_allowance: v.method === "per_unit" ? (v.perUnitFreeAllowance ?? "0") : null,
    per_unit_minimum_charge: v.method === "per_unit" ? v.perUnitMinimumCharge : null,
    billable_weight_floor_lb: v.billableWeightFloorLb,
    calculation_base: v.base,
    conditions: v.conditions,
    exclusivity_group: v.exclusivityGroup,
    exclusivity_priority: v.exclusivityPriority,
    excludes_rule_keys: v.excludesRuleKeys,
    per_package: v.perPackage,
    effective_date: v.effectiveDate,
    expiration_date: v.expirationDate,
    source_reference: v.sourceReference,
    source_url: v.sourceUrl,
    verification_status: "approved_3pl_config",
  };
}

function slugKey(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "rule";
  return /^[a-z]/.test(slug) ? slug : `r_${slug}`;
}

/** Creates a tenant rule with its first draft version. */
export async function createSurchargeRule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = readRuleFields(formData);
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "rule.create", 60, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };

  const ruleKey = `${v.carrierCode}.${slugKey(v.name)}`;
  let ruleId: string | null = null;
  for (let attempt = 0; attempt < 5 && !ruleId; attempt++) {
    const key = attempt === 0 ? ruleKey : `${ruleKey}_${attempt + 1}`;
    const { data, error } = await supabase.from("surcharge_rules").insert({ scope: "tenant", tenant_id: ctx.active.tenantId, carrier_code: v.carrierCode, rule_key: key, category: v.category, name: v.name, brand_id: v.brandId }).select("id").single();
    if (data) ruleId = data.id;
    else if (error?.code === "42501" || error?.code === "23503") return { ok: false, errors: { brandId: "That customer is not in your workspace." } };
    else if (error?.code !== "23505") return { ok: false, message: GENERIC_FAILURE };
  }
  if (!ruleId) return { ok: false, message: "Could not create a unique key for this rule. Try a different name." };

  const { data: version, error } = await supabase.from("surcharge_rule_versions").insert(versionRow(v, ctx.active.tenantId, ruleId, 1)).select("id").single();
  if (error || !version) return { ok: false, message: GENERIC_FAILURE };
  revalidatePath("/app/surcharges");
  redirect(`/app/surcharges/${ruleId}`);
}

/** Adds a new draft version to an existing rule (published versions are immutable). */
export async function addSurchargeRuleVersion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const ruleId = String(formData.get("ruleId") ?? "");
  if (!uuidSchema.safeParse(ruleId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data: rule } = await supabase.from("surcharge_rules").select("id, tenant_id, scope, carrier_code").eq("id", ruleId).maybeSingle();
  if (!rule || rule.tenant_id !== ctx.active.tenantId || rule.scope !== "tenant") return { ok: false, message: "Rule not found." };
  formData.set("carrierCode", rule.carrier_code);
  const parsed = readRuleFields(formData);
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  if (parsed.data.name) await supabase.from("surcharge_rules").update({ name: parsed.data.name }).eq("id", ruleId);
  const { data: latest } = await supabase.from("surcharge_rule_versions").select("version_number").eq("rule_id", ruleId).order("version_number", { ascending: false }).limit(1).maybeSingle();
  const { error } = await supabase.from("surcharge_rule_versions").insert(versionRow({ ...parsed.data, carrierCode: rule.carrier_code }, ctx.active.tenantId, ruleId, (latest?.version_number ?? 0) + 1));
  if (error) return { ok: false, message: GENERIC_FAILURE };
  revalidatePath(`/app/surcharges/${ruleId}`);
  return { ok: true, message: "Draft version added." };
}

export async function publishRuleVersion(versionId: string): Promise<{ ok: boolean; message?: string }> {
  await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(versionId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_surcharge_rule_version", { p_version: versionId });
  if (error) {
    if (error.message.includes("already covers")) return { ok: false, message: "Another published version already covers these dates. Retire it first or change the dates." };
    if (error.message.includes("only a draft")) return { ok: false, message: "Only a draft can be published." };
    return { ok: false, message: "Rule version not found." };
  }
  revalidatePath("/app/surcharges", "layout");
  return { ok: true };
}

/** Retires a published version as of `lastEffective` (default: today, UTC); it stays available for historical calculations. */
export async function retireRuleVersion(versionId: string, lastEffective?: string): Promise<{ ok: boolean; message?: string }> {
  await requireTenantContext("ratecard.manage");
  const parsed = z.object({ versionId: uuidSchema, lastEffective: isoDate.optional() }).safeParse({ versionId, lastEffective });
  if (!parsed.success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { error } = await supabase.rpc("retire_surcharge_rule_version", { p_version: parsed.data.versionId, p_last_effective: parsed.data.lastEffective ?? new Date().toISOString().slice(0, 10) });
  if (error) {
    if (error.message.includes("only a published")) return { ok: false, message: "Only a published version can be retired." };
    if (error.message.includes("precedes")) return { ok: false, message: "The last effective date cannot be before the version's effective date." };
    return { ok: false, message: "Rule version not found." };
  }
  revalidatePath("/app/surcharges", "layout");
  return { ok: true };
}

export async function archiveSurchargeRule(ruleId: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(ruleId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data: published } = await supabase.from("surcharge_rule_versions").select("id").eq("rule_id", ruleId).eq("status", "published");
  for (const v of published ?? []) await supabase.rpc("retire_surcharge_rule_version", { p_version: v.id, p_last_effective: new Date().toISOString().slice(0, 10) });
  const { data, error } = await supabase.from("surcharge_rules").update({ archived_at: new Date().toISOString() }).eq("id", ruleId).eq("tenant_id", ctx.active.tenantId).select("id");
  if (error || !data?.length) return { ok: false, message: "Rule not found." };
  revalidatePath("/app/surcharges", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Customer-specific exceptions
// ---------------------------------------------------------------------------
export async function createOverride(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z
    .object({
      brandId: uuidSchema,
      ruleId: uuidSchema,
      mode: z.enum(["exclude", "override_amount", "override_percent", "markup_percent", "add_percent_points"]),
      amount: optionalDecimal,
      percent: optionalDecimal,
      effectiveDate: isoDate,
      expirationDate: z.preprocess((v) => (v === "" ? null : v), isoDate.nullable()),
      reference: z.string().trim().min(1, "Reference the agreement that grants this exception.").max(300),
    })
    .superRefine((v, c) => {
      if (v.mode === "override_amount" && v.amount === null) c.addIssue({ code: "custom", path: ["amount"], message: "Enter the amount." });
      if ((v.mode === "override_percent" || v.mode === "markup_percent" || v.mode === "add_percent_points") && v.percent === null) c.addIssue({ code: "custom", path: ["percent"], message: "Enter the percentage." });
      if (v.expirationDate && v.expirationDate < v.effectiveDate) c.addIssue({ code: "custom", path: ["expirationDate"], message: "Expiration must not precede the effective date." });
    })
    .safeParse({
      brandId: formData.get("brandId"),
      ruleId: formData.get("ruleId"),
      mode: formData.get("mode"),
      amount: formData.get("amount") ?? "",
      percent: formData.get("percent") ?? "",
      effectiveDate: formData.get("effectiveDate"),
      expirationDate: formData.get("expirationDate") ?? "",
      reference: formData.get("reference"),
    });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.from("customer_surcharge_overrides").insert({
    tenant_id: ctx.active.tenantId,
    brand_id: v.brandId,
    rule_id: v.ruleId,
    mode: v.mode,
    amount: v.mode === "override_amount" ? v.amount : null,
    percent: v.mode === "override_percent" || v.mode === "markup_percent" || v.mode === "add_percent_points" ? v.percent : null,
    effective_date: v.effectiveDate,
    expiration_date: v.expirationDate,
    reference: v.reference,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, message: "That rule cannot be overridden for this customer." };
    if (error.code === "23P01") return { ok: false, errors: { effectiveDate: "Another exception for this surcharge already covers these dates. End it first." } };
    return { ok: false, message: GENERIC_FAILURE };
  }
  revalidatePath(`/app/customers/${v.brandId}`);
  return { ok: true, message: "Exception saved." };
}

export async function endOverride(overrideId: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(overrideId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data, error } = await supabase.from("customer_surcharge_overrides").update({ ended_at: new Date().toISOString() }).eq("id", overrideId).eq("tenant_id", ctx.active.tenantId).is("ended_at", null).select("brand_id");
  if (error || !data?.length) return { ok: false, message: "Exception not found." };
  revalidatePath(`/app/customers/${data[0]!.brand_id}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ZIP lists (e.g. delivery area surcharge ZIP codes) uploaded by the 3PL
// ---------------------------------------------------------------------------
export async function uploadZipList(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z
    .object({
      key: z.string().trim().regex(/^[a-z][a-z0-9_.]{1,60}$/, "Use lowercase letters, digits, dots and underscores (e.g. ups.das_2026)."),
      name: nameSchema,
      carrierCode: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^[a-z][a-z0-9_]{1,30}$/).nullable()),
      sourceReference: z.string().trim().min(1, "State the source (carrier bulletin name and date).").max(500),
      effectiveDate: isoDate,
      expirationDate: z.preprocess((v) => (v === "" ? null : v), isoDate.nullable()),
    })
    .safeParse({
      key: formData.get("key"),
      name: formData.get("name"),
      carrierCode: formData.get("carrierCode") ?? "",
      sourceReference: formData.get("sourceReference"),
      effectiveDate: formData.get("effectiveDate"),
      expirationDate: formData.get("expirationDate") ?? "",
    });
  const file = formData.get("file");
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  if (!(file instanceof File) || file.size === 0) return { ok: false, errors: { file: "Choose a .csv or .xlsx file with one ZIP code or prefix per row." } };
  if (file.size > LIMITS.maxBytes) return { ok: false, errors: { file: "Files must be 5 MB or smaller." } };

  let entries: string[];
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const tables = await parseTables(bytes, detectFileKind(file.name, file.type, bytes));
    const set = new Set<string>();
    for (const t of tables) for (const row of t.rows) {
      const cell = (row[0] ?? "").trim().replace(/-\d{4}$/, "");
      if (/^\d{3,5}$/.test(cell)) set.add(cell);
    }
    entries = [...set];
  } catch (err) {
    return { ok: false, errors: { file: err instanceof ParseError ? err.message : "The file could not be read." } };
  }
  if (!entries.length) return { ok: false, errors: { file: "No ZIP codes or 3–5 digit prefixes were found in the first column." } };

  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "ziplist.upload", 20, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const { data: prev } = await supabase.from("zip_lists").select("version").eq("tenant_id", ctx.active.tenantId).eq("key", parsed.data.key).order("version", { ascending: false }).limit(1).maybeSingle();
  const { data: list, error } = await supabase
    .from("zip_lists")
    .insert({
      tenant_id: ctx.active.tenantId,
      carrier_code: parsed.data.carrierCode,
      key: parsed.data.key,
      name: parsed.data.name,
      version: (prev?.version ?? 0) + 1,
      source_reference: parsed.data.sourceReference,
      verification_status: "approved_3pl_config",
      effective_date: parsed.data.effectiveDate,
      expiration_date: parsed.data.expirationDate,
    })
    .select("id")
    .single();
  if (error || !list) return { ok: false, message: GENERIC_FAILURE };
  for (let i = 0; i < entries.length; i += 2000) {
    const { error: eError } = await supabase.from("zip_list_entries").insert(entries.slice(i, i + 2000).map((entry) => ({ list_id: list.id, entry })));
    if (eError) return { ok: false, message: GENERIC_FAILURE };
  }
  const { error: pError } = await supabase.rpc("publish_zip_list", { p_list: list.id });
  if (pError) {
    if (pError.message.includes("already covers")) return { ok: false, errors: { effectiveDate: "A published version of this list already covers these dates. Give the new version a later effective date (the previous one is ended automatically only when you set its expiration)." } };
    return { ok: false, message: GENERIC_FAILURE };
  }
  revalidatePath("/app/surcharges", "layout");
  return { ok: true, message: `ZIP list "${parsed.data.name}" saved with ${entries.length} entries (version ${(prev?.version ?? 0) + 1}).` };
}
