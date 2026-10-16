"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { calculateOrderFees } from "@/engine/fees";
import type { FeeScheduleSnapshot, OrderFeeResult } from "@/engine/fees/types";
import type { ActionState } from "@/lib/actions";
import { requireTenantContext } from "@/lib/auth/session";
import { fieldErrors, nameSchema, uuidSchema, type FieldErrors } from "@/lib/auth/validation";
import { feeRuleInputSchema, ruleFieldErrors, ruleFormToRow, tryOrderInputSchema, tryOrderProblems, tryOrderToEngine } from "@/lib/fees/schema";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for the 3PL's fee schedules (Milestone 4). Every caller must be 3PL staff with
 * `ratecard.manage` (rate cards and fee schedules share the permission); every write runs under the
 * caller's Row Level Security or through a database function that authorises on the row, so a forged
 * id can only ever come back as "not found". Lifecycle changes (activate, end, archive, assign) go
 * through those functions only: the tables refuse direct status changes.
 *
 * Amounts here are what the 3PL typed for its customers; nothing reads or stores a carrier buy rate.
 */

const GENERIC_FAILURE = "Something went wrong. Please try again.";
const NOT_DRAFT = "Only a draft version can be edited.";
const LIST_PATH = "/app/fee-schedules";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");
const roundingSchema = z.enum(["invoice_line", "transaction"], { error: "Choose how amounts are rounded." });

export interface FeeActionResult {
  ok: boolean;
  message?: string;
  errors?: FieldErrors;
}

interface DbError {
  code?: string;
  message: string;
}

function revalidateSchedules(brandId?: string) {
  revalidatePath(LIST_PATH, "layout");
  if (brandId) revalidatePath(`/app/customers/${brandId}`, "layout");
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------
export async function createFeeSchedule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const values = { name: String(formData.get("name") ?? ""), description: String(formData.get("description") ?? ""), rounding: String(formData.get("rounding") ?? "invoice_line") };
  const parsed = z
    .object({ name: nameSchema, description: z.string().trim().max(1000, "Use at most 1,000 characters.").optional(), rounding: roundingSchema.default("invoice_line") })
    .safeParse({ name: formData.get("name"), description: formData.get("description") ?? undefined, rounding: formData.get("rounding") ?? undefined });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error), values };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "feeschedule.create", 60, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE, values };
  const { data, error } = await supabase.rpc("create_fee_schedule", { p_tenant: ctx.active.tenantId, p_name: parsed.data.name, p_description: parsed.data.description || null, p_rounding: parsed.data.rounding });
  if (error) {
    if (error.code === "23505" || error.message.includes("fee_schedules_tenant_name_key")) return { ok: false, errors: { name: "You already have a fee schedule with that name." }, values };
    if (error.code === "42501") return { ok: false, message: "You don't have permission to create fee schedules.", values };
    return { ok: false, message: GENERIC_FAILURE, values };
  }
  const created = data as { scheduleId?: string } | null;
  if (!created?.scheduleId) return { ok: false, message: GENERIC_FAILURE, values };
  revalidateSchedules();
  redirect(`${LIST_PATH}/${created.scheduleId}`);
}

export async function renameFeeSchedule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z
    .object({ id: uuidSchema, name: nameSchema, description: z.string().trim().max(1000, "Use at most 1,000 characters.").optional() })
    .safeParse({ id: formData.get("id"), name: formData.get("name"), description: formData.get("description") ?? undefined });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fee_schedules")
    .update({ name: parsed.data.name, description: parsed.data.description || null })
    .eq("id", parsed.data.id)
    .eq("tenant_id", ctx.active.tenantId)
    .select("id");
  if (error?.code === "23505") return { ok: false, errors: { name: "You already have a fee schedule with that name." } };
  if (error || !data?.length) return { ok: false, message: error ? GENERIC_FAILURE : "Fee schedule not found." };
  revalidateSchedules();
  return { ok: true, message: "Saved." };
}

/** Archives a schedule no customer is on; versions stay readable for history. */
export async function archiveFeeSchedule(scheduleId: string): Promise<FeeActionResult> {
  await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(scheduleId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_fee_schedule", { p_schedule: scheduleId });
  if (error) {
    if (error.message.includes("still on this fee schedule")) return { ok: false, message: "Customers are still on this fee schedule. Move them to another schedule first." };
    return { ok: false, message: "Fee schedule not found." };
  }
  revalidateSchedules();
  return { ok: true, message: "Fee schedule archived." };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------
/** A new draft of a schedule, empty or copied from a version (rules keep their keys and get new ids). */
export async function createDraftVersion(scheduleId: string, fromVersionId: string | null): Promise<FeeActionResult & { versionId?: string }> {
  await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(scheduleId).success || (fromVersionId !== null && !uuidSchema.safeParse(fromVersionId).success)) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("copy_fee_schedule_version", { p_schedule: scheduleId, p_from_version: fromVersionId });
  if (error) {
    if (error.message.includes("already has a draft")) return { ok: false, message: "This schedule already has a draft. Edit it, or discard it first." };
    if (error.message.includes("archived schedule")) return { ok: false, message: "An archived schedule cannot get new versions." };
    if (error.message.includes("version not found")) return { ok: false, message: "The version to copy was not found." };
    return { ok: false, message: "Fee schedule not found." };
  }
  if (typeof data !== "string") return { ok: false, message: GENERIC_FAILURE };
  revalidateSchedules();
  return { ok: true, versionId: data };
}

export async function updateDraftRounding(versionId: string, rounding: string): Promise<FeeActionResult> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ versionId: uuidSchema, rounding: roundingSchema }).safeParse({ versionId, rounding });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { data, error } = await supabase.from("fee_schedule_versions").update({ rounding: parsed.data.rounding }).eq("id", parsed.data.versionId).eq("tenant_id", ctx.active.tenantId).select("id");
  if (error) return { ok: false, message: error.code === "42501" ? NOT_DRAFT : GENERIC_FAILURE };
  if (!data?.length) return { ok: false, message: NOT_DRAFT };
  revalidateSchedules();
  return { ok: true, message: "Saved." };
}

export async function activateFeeVersion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireTenantContext("ratecard.manage");
  const parsed = z
    .object({ versionId: uuidSchema, effectiveDate: isoDate, expirationDate: z.preprocess((v) => (v === "" || v === undefined ? null : v), isoDate.nullable()) })
    .safeParse({ versionId: formData.get("versionId"), effectiveDate: formData.get("effectiveDate"), expirationDate: formData.get("expirationDate") });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("activate_fee_schedule_version", { p_version: parsed.data.versionId, p_effective: parsed.data.effectiveDate, p_expiration: parsed.data.expirationDate });
  if (error) {
    const m = error.message;
    if (error.code === "P0007" || m.includes("already covers")) return { ok: false, errors: { effectiveDate: "Another active version already covers these dates. End it or choose different dates." } };
    if (error.code === "P0005") return { ok: false, message: `This version cannot be activated yet: ${m}.` };
    if (m.includes("only a draft")) return { ok: false, message: "Only a draft version can be activated." };
    if (m.includes("precede")) return { ok: false, errors: { expirationDate: "The end date cannot be before the effective date." } };
    if (m.includes("effective date is required")) return { ok: false, errors: { effectiveDate: "Enter a date." } };
    if (error.code === "P0003") return { ok: false, message: "Version not found." };
    return { ok: false, message: GENERIC_FAILURE };
  }
  revalidateSchedules();
  return { ok: true, message: "Version activated." };
}

/** Ends an active version on a date so a successor can start the next day; history stays intact. */
export async function endFeeVersion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireTenantContext("ratecard.manage");
  const parsed = z.object({ versionId: uuidSchema, expirationDate: isoDate }).safeParse({ versionId: formData.get("versionId"), expirationDate: formData.get("expirationDate") });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("end_fee_schedule_version", { p_version: parsed.data.versionId, p_expiration: parsed.data.expirationDate });
  if (error) {
    if (error.message.includes("only an active")) return { ok: false, message: "Only an active version can be ended." };
    if (error.message.includes("precede")) return { ok: false, errors: { expirationDate: "The end date cannot be before the effective date." } };
    if (error.code === "23P01" || error.message.includes("already covers")) return { ok: false, errors: { expirationDate: "Another active version already covers that date." } };
    return { ok: false, message: "Version not found." };
  }
  revalidateSchedules();
  return { ok: true, message: "Version ended." };
}

/** Archives an active version or discards a draft. */
export async function archiveFeeVersion(versionId: string): Promise<FeeActionResult> {
  await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(versionId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_fee_schedule_version", { p_version: versionId });
  if (error) return { ok: false, message: error.message.includes("already closed") ? "This version is already closed." : "Version not found." };
  revalidateSchedules();
  return { ok: true };
}

export async function saveVersionNotes(versionId: string, text: string | null): Promise<FeeActionResult> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ versionId: uuidSchema, notes: z.string().trim().max(4000, "Use at most 4,000 characters.").nullable() }).safeParse({ versionId, notes: text });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const notes = parsed.data.notes || null;
  if (notes === null) {
    const { error } = await supabase.from("fee_schedule_version_notes").delete().eq("version_id", parsed.data.versionId).eq("tenant_id", ctx.active.tenantId);
    if (error) return { ok: false, message: error.code === "42501" ? NOT_DRAFT : GENERIC_FAILURE };
    revalidateSchedules();
    return { ok: true, message: "Notes cleared." };
  }
  // The update grant covers the text only, so an upsert (which also sets the key columns) is split in two.
  const updated = await supabase.from("fee_schedule_version_notes").update({ notes }).eq("version_id", parsed.data.versionId).eq("tenant_id", ctx.active.tenantId).select("version_id");
  if (updated.error) return { ok: false, message: updated.error.code === "42501" ? NOT_DRAFT : GENERIC_FAILURE };
  if (!updated.data?.length) {
    const inserted = await supabase.from("fee_schedule_version_notes").insert({ version_id: parsed.data.versionId, tenant_id: ctx.active.tenantId, notes });
    if (inserted.error) return { ok: false, message: inserted.error.code === "42501" ? NOT_DRAFT : inserted.error.code === "23503" ? "Version not found." : GENERIC_FAILURE };
  }
  revalidateSchedules();
  return { ok: true, message: "Notes saved." };
}

// ---------------------------------------------------------------------------
// Rules of a draft
// ---------------------------------------------------------------------------
/**
 * Maps the database's rule problem (SQLSTATE 22023, from app.fee_rule_problem) to the form field it
 * concerns, on the same field feeRuleInputSchema reports it. Order matters: every "minimum.…" message
 * starts with "minimum" (the per-occurrence "a minimum charge …" does not), "choose what the percent
 * is taken of" is about the base, and "a tiered rule has no free allowance (use a first bracket …)"
 * is about the allowance, not the brackets.
 */
function ruleProblemField(message: string): string | null {
  const m = message.toLowerCase();
  const table: [RegExp, string][] = [
    [/^minimum/, "minimum"],
    [/^key /, "key"],
    [/^name /, "name"],
    [/^unknown category/, "category"],
    [/^unknown scope/, "scope"],
    [/basis does not match|cannot be tiered/, "basis"],
    [/^unknown method|the percent method|the minimum method/, "method"],
    [/^amount/, "amount"],
    [/^percent base|percent base applies|choose what the percent/, "percentBase"],
    [/^percent/, "percent"],
    [/free allowance|includedper/, "includedQuantity"],
    [/minimum charge/, "minimumCharge"],
    [/^tiers|bracket|graduated tiers|monthly rules tier|monthly-volume tiers/, "tiers"],
    [/^conditions|packaging|must be a whole number|exceeds max/, "conditions"],
    [/needs a priority|^priority/, "priority"],
    [/exclusive group/, "exclusiveGroup"],
    [/^driver|longterm|billingperiod|per-order driver|monthly driver/, "driver"],
  ];
  for (const [re, field] of table) if (re.test(m)) return field;
  return null;
}

function ruleWriteError(error: DbError): FeeActionResult & { ruleId?: string } {
  if (error.code === "22023") {
    const field = ruleProblemField(error.message);
    return field ? { ok: false, errors: { [field]: error.message } } : { ok: false, message: error.message };
  }
  if (error.code === "23505") return { ok: false, errors: { key: "Another rule of this version already uses this key." } };
  if (error.code === "42501" || error.message.includes("not a draft")) return { ok: false, message: NOT_DRAFT };
  if (error.code === "23503") return { ok: false, message: "Version not found." };
  if (error.code === "22003") return { ok: false, errors: { amount: "This amount is too large." } };
  return { ok: false, message: GENERIC_FAILURE };
}

/**
 * Inserts (ruleId null) or updates one rule of a draft. The form input is validated here first so the
 * editor gets field-level messages; the database runs the same checks again and its 22023 messages are
 * mapped back to fields where possible.
 */
export async function saveFeeRule(versionId: string, ruleId: string | null, input: unknown): Promise<FeeActionResult & { ruleId?: string }> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(versionId).success || (ruleId !== null && !uuidSchema.safeParse(ruleId).success)) return { ok: false, message: GENERIC_FAILURE };
  const parsed = feeRuleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: ruleFieldErrors(parsed.error) };
  const supabase = await createClient();

  if (ruleId === null) {
    const { data: last, error: lastError } = await supabase.from("fee_rules").select("position").eq("version_id", versionId).order("position", { ascending: false }).limit(1).maybeSingle();
    if (lastError) return { ok: false, message: GENERIC_FAILURE };
    const position = last ? Number(last.position) + 1 : 0;
    const row = ruleFormToRow(parsed.data, { versionId, tenantId: ctx.active.tenantId, position });
    const { data, error } = await supabase.from("fee_rules").insert(row).select("id").single();
    if (error) return ruleWriteError(error);
    revalidateSchedules();
    return { ok: true, ruleId: data.id as string, message: "Rule added." };
  }

  // The key is fixed once the rule exists (the editor says so, and other rules refer to it), so an edit never rewrites it.
  const { version_id: _v, tenant_id: _t, position: _p, key: _k, ...columns } = ruleFormToRow(parsed.data, { versionId, tenantId: ctx.active.tenantId, position: 0 });
  const { data, error } = await supabase.from("fee_rules").update(columns).eq("id", ruleId).eq("version_id", versionId).eq("tenant_id", ctx.active.tenantId).select("id");
  if (error) return ruleWriteError(error);
  if (!data?.length) return { ok: false, message: "Rule not found." };
  revalidateSchedules();
  return { ok: true, ruleId, message: "Rule saved." };
}

export async function deleteFeeRule(ruleId: string): Promise<FeeActionResult> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(ruleId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data, error } = await supabase.from("fee_rules").delete().eq("id", ruleId).eq("tenant_id", ctx.active.tenantId).select("id");
  if (error) return { ok: false, message: error.code === "42501" ? NOT_DRAFT : GENERIC_FAILURE };
  if (!data?.length) return { ok: false, message: "Rule not found." };
  revalidateSchedules();
  return { ok: true, message: "Rule removed." };
}

/** `ruleIds` lists every rule of the draft in its new order. */
export async function reorderFeeRules(versionId: string, ruleIds: string[]): Promise<FeeActionResult> {
  await requireTenantContext("ratecard.manage");
  const parsed = z.object({ versionId: uuidSchema, ruleIds: z.array(uuidSchema).min(1).max(500) }).safeParse({ versionId, ruleIds });
  if (!parsed.success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { error } = await supabase.rpc("reorder_fee_rules", { p_version: parsed.data.versionId, p_rule_ids: parsed.data.ruleIds });
  if (error) {
    if (error.message.includes("exactly once")) return { ok: false, message: "The order must name every rule of the version exactly once. Reload and try again." };
    if (error.message.includes("only a draft")) return { ok: false, message: NOT_DRAFT };
    return { ok: false, message: "Version not found." };
  }
  revalidateSchedules();
  return { ok: true };
}

/** Staff-only note on where a rule's number comes from; null clears it. Never shown to customers. */
export async function saveRuleSource(ruleId: string, text: string | null): Promise<FeeActionResult> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ ruleId: uuidSchema, source: z.string().trim().max(1000, "Use at most 1,000 characters.").nullable() }).safeParse({ ruleId, source: text });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const source = parsed.data.source || null;
  if (source === null) {
    const { error } = await supabase.from("fee_rule_sources").delete().eq("rule_id", parsed.data.ruleId).eq("tenant_id", ctx.active.tenantId);
    if (error) return { ok: false, message: error.code === "42501" ? NOT_DRAFT : GENERIC_FAILURE };
    revalidateSchedules();
    return { ok: true, message: "Source cleared." };
  }
  const updated = await supabase.from("fee_rule_sources").update({ source_reference: source }).eq("rule_id", parsed.data.ruleId).eq("tenant_id", ctx.active.tenantId).select("rule_id");
  if (updated.error) return { ok: false, message: updated.error.code === "42501" ? NOT_DRAFT : GENERIC_FAILURE };
  if (!updated.data?.length) {
    const inserted = await supabase.from("fee_rule_sources").insert({ rule_id: parsed.data.ruleId, tenant_id: ctx.active.tenantId, source_reference: source });
    if (inserted.error) return { ok: false, message: inserted.error.code === "42501" ? NOT_DRAFT : inserted.error.code === "23503" ? "Rule not found." : GENERIC_FAILURE };
  }
  revalidateSchedules();
  return { ok: true, message: "Source saved." };
}

// ---------------------------------------------------------------------------
// Brand assignments
// ---------------------------------------------------------------------------
/** Puts a customer on a schedule; the database ends the current assignment in the same transaction. */
export async function assignFeeSchedule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireTenantContext("ratecard.manage");
  const parsed = z.object({ brandId: uuidSchema, scheduleId: uuidSchema }).safeParse({ brandId: formData.get("brandId"), scheduleId: formData.get("scheduleId") });
  if (!parsed.success) return { ok: false, message: "Choose a fee schedule." };
  const supabase = await createClient();
  // The brand id comes from the form: it must be a customer of the workspace the caller is acting in (the database checks the caller's rights on it too).
  const { data: brand, error: brandError } = await supabase.from("brands").select("id").eq("id", parsed.data.brandId).eq("tenant_id", ctx.active.tenantId).maybeSingle();
  if (brandError) return { ok: false, message: GENERIC_FAILURE };
  if (!brand) return { ok: false, message: "Customer not found." };
  const { error } = await supabase.rpc("assign_fee_schedule", { p_brand: parsed.data.brandId, p_schedule: parsed.data.scheduleId });
  if (error) {
    if (error.message.includes("archived schedule")) return { ok: false, message: "An archived fee schedule cannot be assigned." };
    if (error.message.includes("activate a version")) return { ok: false, message: "Activate a version of this fee schedule before assigning it." };
    if (error.message.includes("customer not found")) return { ok: false, message: "Customer not found." };
    return { ok: false, message: "Fee schedule not found." };
  }
  revalidateSchedules(parsed.data.brandId);
  return { ok: true, message: "Fee schedule assigned." };
}

export async function unassignFeeSchedule(assignmentId: string): Promise<FeeActionResult> {
  const ctx = await requireTenantContext("ratecard.manage");
  if (!uuidSchema.safeParse(assignmentId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { data: assignment, error: loadError } = await supabase.from("brand_fee_schedule_assignments").select("brand_id, tenant_id").eq("id", assignmentId).maybeSingle();
  if (loadError) return { ok: false, message: GENERIC_FAILURE };
  if (!assignment || assignment.tenant_id !== ctx.active.tenantId) return { ok: false, message: "Assignment not found." };
  const { error } = await supabase.rpc("unassign_fee_schedule", { p_assignment: assignmentId });
  if (error) return { ok: false, message: "Assignment not found." };
  revalidateSchedules(assignment.brand_id as string);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// "Try an order" (editor panel): price one typed order on a version, drafts included
// ---------------------------------------------------------------------------
export type TryFeeOrderResult = { ok: true; result: OrderFeeResult; versionNumber: number } | { ok: false; message?: string; errors?: FieldErrors };

/** Staff only: a pure engine call on the version's snapshot; nothing is stored. */
export async function tryFeeOrder(versionId: string, input: unknown): Promise<TryFeeOrderResult> {
  const ctx = await requireTenantContext("ratecard.view");
  if (!uuidSchema.safeParse(versionId).success) return { ok: false, message: "Version not found." };
  const parsed = tryOrderInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: ruleFieldErrors(parsed.error) };
  const supabase = await createClient();
  // The version id comes from the client: it must be one of the active workspace's own versions (the snapshot function authorises the caller as well).
  const owned = await supabase.from("fee_schedule_versions").select("id").eq("id", versionId).eq("tenant_id", ctx.active.tenantId).maybeSingle();
  if (owned.error) return { ok: false, message: GENERIC_FAILURE };
  if (!owned.data) return { ok: false, message: "Version not found." };
  const { data, error } = await supabase.rpc("fee_schedule_snapshot", { p_version: versionId });
  if (error) return { ok: false, message: error.code === "P0002" ? "Version not found." : GENERIC_FAILURE };
  const snapshot = data as FeeScheduleSnapshot | null;
  if (!snapshot || snapshot.versionId !== versionId || !Array.isArray(snapshot.rules)) return { ok: false, message: GENERIC_FAILURE };
  const problems = tryOrderProblems(parsed.data, snapshot);
  if (Object.keys(problems).length) return { ok: false, errors: problems };
  // A draft has no effective date yet; the order engine never reads it.
  const { input: order, context } = tryOrderToEngine(parsed.data, snapshot);
  return { ok: true, result: calculateOrderFees(order, snapshot, context), versionNumber: snapshot.versionNumber };
}
