import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describeFeeRule, describeMonthlyRate } from "@/engine/fees";
import type { BillingPeriod, FeeCategory, FeeDriver, FeeRule, FeeScheduleSnapshot, FeeScope } from "@/engine/fees/types";

/**
 * Read models for fee schedules (Milestone 4). Every query runs under the caller's Row Level
 * Security: staff with `ratecard.view` see their tenant's schedules, every version and the staff-only
 * sources and notes; a brand member sees only the schedule the brand is on, its active and archived
 * versions, and never a draft, a source or a note (the tables have no brand policy at all). These
 * helpers shape rows for pages and never widen what a user can see. A load that fails is reported
 * as a failure, never as "no schedule" or "no rules".
 */

export type FeeScheduleStatus = "active" | "archived";
export type FeeVersionStatus = "draft" | "active" | "archived" | "discarded";
export type FeeRounding = FeeScheduleSnapshot["rounding"];

/** `fee_schedule_snapshot` of a draft carries no effective date yet. */
export type FeeVersionSnapshot = Omit<FeeScheduleSnapshot, "effectiveDate"> & { effectiveDate: string | null };

// ---------------------------------------------------------------------------
// Staff: list and detail
// ---------------------------------------------------------------------------
export interface FeeScheduleListRow {
  id: string;
  name: string;
  description: string | null;
  status: FeeScheduleStatus;
  createdAt: string;
  updatedAt: string;
  versions: { total: number; draft: number; active: number; archived: number };
  /** The active version in effect today, else the latest active one. */
  activeVersion: { id: string; versionNumber: number; effectiveDate: string; expirationDate: string | null } | null;
  draftVersionId: string | null;
  /** Brands currently on this schedule. */
  assignedBrands: number;
}

interface ListVersionRow {
  id: string;
  version_number: number;
  status: FeeVersionStatus;
  effective_date: string | null;
  expiration_date: string | null;
}

interface ListRow {
  id: string;
  name: string;
  description: string | null;
  status: FeeScheduleStatus;
  created_at: string;
  updated_at: string;
  fee_schedule_versions: ListVersionRow[];
  brand_fee_schedule_assignments: { id: string; unassigned_at: string | null }[];
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function activeVersionOf(versions: ListVersionRow[], today: string): FeeScheduleListRow["activeVersion"] {
  const active = versions.filter((v) => v.status === "active" && v.effective_date);
  const inEffect = active.filter((v) => v.effective_date! <= today && (v.expiration_date === null || v.expiration_date >= today));
  const pick = (inEffect.length ? inEffect : active).sort((a, b) => b.version_number - a.version_number)[0];
  return pick ? { id: pick.id, versionNumber: pick.version_number, effectiveDate: pick.effective_date!, expirationDate: pick.expiration_date } : null;
}

export async function listFeeSchedules(supabase: SupabaseClient, tenantId: string): Promise<FeeScheduleListRow[]> {
  const { data, error } = await supabase
    .from("fee_schedules")
    .select("id, name, description, status, created_at, updated_at, fee_schedule_versions!fsv_schedule_in_tenant(id, version_number, status, effective_date, expiration_date), brand_fee_schedule_assignments!bfsa_schedule_in_tenant(id, unassigned_at)")
    .eq("tenant_id", tenantId)
    .order("name")
    .overrideTypes<ListRow[], { merge: false }>();
  if (error) throw new Error(`fee schedules could not be loaded: ${error.message}`);
  const today = todayUtc();
  return (data ?? []).map((s) => {
    const versions = s.fee_schedule_versions ?? [];
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      status: s.status,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      versions: {
        total: versions.length,
        draft: versions.filter((v) => v.status === "draft").length,
        active: versions.filter((v) => v.status === "active").length,
        archived: versions.filter((v) => v.status === "archived").length,
      },
      activeVersion: activeVersionOf(versions, today),
      draftVersionId: versions.find((v) => v.status === "draft")?.id ?? null,
      assignedBrands: (s.brand_fee_schedule_assignments ?? []).filter((a) => a.unassigned_at === null).length,
    };
  });
}

export interface FeeVersionSummary {
  id: string;
  versionNumber: number;
  status: FeeVersionStatus;
  effectiveDate: string | null;
  expirationDate: string | null;
  rounding: FeeRounding;
  ruleCount: number;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeeScheduleDetail {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: FeeScheduleStatus;
  createdAt: string;
  updatedAt: string;
  /** Newest first. */
  versions: FeeVersionSummary[];
  /** Brands currently on the schedule (brand names resolve only for callers who may read the brand). */
  assignments: { id: string; brandId: string; brandName: string | null; assignedAt: string }[];
}

interface DetailRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: FeeScheduleStatus;
  created_at: string;
  updated_at: string;
  fee_schedule_versions: Array<ListVersionRow & { rounding: FeeRounding; rule_count: number; activated_at: string | null; created_at: string; updated_at: string }>;
  brand_fee_schedule_assignments: { id: string; brand_id: string; assigned_at: string; unassigned_at: string | null; brands: { id: string; name: string } | null }[];
}

/** One schedule with its versions and current assignments; null when the caller may not see it. */
export async function loadFeeSchedule(supabase: SupabaseClient, scheduleId: string): Promise<FeeScheduleDetail | null> {
  const { data, error } = await supabase
    .from("fee_schedules")
    .select(
      "id, tenant_id, name, description, status, created_at, updated_at, fee_schedule_versions!fsv_schedule_in_tenant(id, version_number, status, effective_date, expiration_date, rounding, rule_count, activated_at, created_at, updated_at), brand_fee_schedule_assignments!bfsa_schedule_in_tenant(id, brand_id, assigned_at, unassigned_at, brands!bfsa_brand_in_tenant(id, name))",
    )
    .eq("id", scheduleId)
    .maybeSingle()
    .overrideTypes<DetailRow, { merge: false }>();
  if (error) throw new Error(`fee schedule could not be loaded: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    tenantId: data.tenant_id,
    name: data.name,
    description: data.description,
    status: data.status,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    versions: (data.fee_schedule_versions ?? [])
      .map((v) => ({
        id: v.id,
        versionNumber: v.version_number,
        status: v.status,
        effectiveDate: v.effective_date,
        expirationDate: v.expiration_date,
        rounding: v.rounding,
        ruleCount: v.rule_count,
        activatedAt: v.activated_at,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      }))
      .sort((a, b) => b.versionNumber - a.versionNumber),
    assignments: (data.brand_fee_schedule_assignments ?? [])
      .filter((a) => a.unassigned_at === null)
      .map((a) => ({ id: a.id, brandId: a.brand_id, brandName: a.brands?.name ?? null, assignedAt: a.assigned_at }))
      .sort((a, b) => (a.brandName ?? "").localeCompare(b.brandName ?? "")),
  };
}

export interface FeeVersionDetail extends FeeVersionSummary {
  scheduleId: string;
  scheduleName: string;
  scheduleStatus: FeeScheduleStatus;
  tenantId: string;
  /** Customer-safe by construction (`fee_schedule_snapshot` never carries sources or notes). */
  snapshot: FeeVersionSnapshot;
  /** The version's rules in position order, each with its database id. */
  rules: FeeRule[];
  /** Staff only: rule id → where the 3PL's number comes from. Absent for brand callers. */
  sources?: Record<string, string>;
  /** Staff only: version notes. Absent for brand callers; null when none were written. */
  notes?: string | null;
}

interface VersionRow {
  id: string;
  schedule_id: string;
  tenant_id: string;
  version_number: number;
  status: FeeVersionStatus;
  effective_date: string | null;
  expiration_date: string | null;
  rounding: FeeRounding;
  rule_count: number;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
  fee_schedules: { id: string; name: string; status: FeeScheduleStatus } | null;
}

function asSnapshot(data: unknown, versionId: string): FeeVersionSnapshot {
  const s = data as Partial<FeeVersionSnapshot> | null;
  if (!s || typeof s !== "object" || s.versionId !== versionId || !Array.isArray(s.rules)) throw new Error("fee schedule snapshot has an unexpected shape");
  return s as FeeVersionSnapshot;
}

/**
 * One version with its rules (from the snapshot function, so numerics are exact decimal text).
 * `staff` adds sources and notes; even then RLS returns none for a caller without `ratecard.view`.
 */
export async function loadFeeVersion(supabase: SupabaseClient, versionId: string, opts: { staff: boolean }): Promise<FeeVersionDetail | null> {
  const { data: v, error } = await supabase
    .from("fee_schedule_versions")
    .select("id, schedule_id, tenant_id, version_number, status, effective_date, expiration_date, rounding, rule_count, activated_at, created_at, updated_at, fee_schedules!fsv_schedule_in_tenant(id, name, status)")
    .eq("id", versionId)
    .maybeSingle()
    .overrideTypes<VersionRow, { merge: false }>();
  if (error) throw new Error(`fee schedule version could not be loaded: ${error.message}`);
  if (!v || !v.fee_schedules) return null;

  const { data: snap, error: snapError } = await supabase.rpc("fee_schedule_snapshot", { p_version: versionId });
  if (snapError) {
    if (snapError.code === "P0002") return null;
    throw new Error(`fee schedule snapshot could not be loaded: ${snapError.message}`);
  }
  const snapshot = asSnapshot(snap, versionId);
  const rules = [...snapshot.rules].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));

  const detail: FeeVersionDetail = {
    id: v.id,
    scheduleId: v.schedule_id,
    scheduleName: v.fee_schedules.name,
    scheduleStatus: v.fee_schedules.status,
    tenantId: v.tenant_id,
    versionNumber: v.version_number,
    status: v.status,
    effectiveDate: v.effective_date,
    expirationDate: v.expiration_date,
    rounding: v.rounding,
    ruleCount: v.rule_count,
    activatedAt: v.activated_at,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    snapshot,
    rules,
  };
  if (!opts.staff) return detail;

  const ruleIds = rules.map((r) => r.id).filter((id): id is string => !!id);
  const [sourcesResult, notesResult] = await Promise.all([
    ruleIds.length ? supabase.from("fee_rule_sources").select("rule_id, source_reference").in("rule_id", ruleIds) : Promise.resolve({ data: [] as { rule_id: string; source_reference: string }[], error: null }),
    supabase.from("fee_schedule_version_notes").select("notes").eq("version_id", versionId).maybeSingle(),
  ]);
  if (sourcesResult.error) throw new Error(`fee rule sources could not be loaded: ${sourcesResult.error.message}`);
  if (notesResult.error) throw new Error(`fee schedule notes could not be loaded: ${notesResult.error.message}`);
  const sources: Record<string, string> = {};
  for (const s of (sourcesResult.data ?? []) as { rule_id: string; source_reference: string }[]) sources[s.rule_id] = s.source_reference;
  detail.sources = sources;
  detail.notes = (notesResult.data as { notes: string } | null)?.notes ?? null;
  return detail;
}

// ---------------------------------------------------------------------------
// Brand: the schedule a brand is on
// ---------------------------------------------------------------------------
export interface BrandFeeAssignment {
  id: string;
  scheduleId: string;
  assignedAt: string;
}

export type BrandFeeSchedule =
  /** The caller may not model this brand (or it does not exist). */
  | { status: "not_found" }
  /** A query failed; the page retries rather than showing "no fees". */
  | { status: "load_failed" }
  | { status: "no_schedule" }
  /** On a schedule, but no version is in effect on the date. */
  | { status: "not_effective"; assignment: BrandFeeAssignment | null; schedule: { id: string; name: string; description: string | null } }
  | { status: "ok"; assignment: BrandFeeAssignment | null; schedule: { id: string; name: string; description: string | null }; activeVersion: FeeScheduleSnapshot };

interface AssignmentRow {
  id: string;
  schedule_id: string;
  assigned_at: string;
  fee_schedules: { id: string; name: string; description: string | null } | null;
}

/**
 * The brand's fee schedule and the version in effect on `date` (today by default), through
 * `brand_fee_schedule_on`, which authorises on the caller and the brand and returns a customer-safe
 * snapshot. The assignment row is read under RLS for the "since" date.
 */
export async function loadBrandFeeSchedule(supabase: SupabaseClient, brandId: string, date: string = todayUtc()): Promise<BrandFeeSchedule> {
  const [{ data, error }, assignmentResult] = await Promise.all([
    supabase.rpc("brand_fee_schedule_on", { p_brand: brandId, p_date: date }),
    supabase.from("brand_fee_schedule_assignments").select("id, schedule_id, assigned_at, fee_schedules!bfsa_schedule_in_tenant(id, name, description)").eq("brand_id", brandId).is("unassigned_at", null).maybeSingle().overrideTypes<AssignmentRow, { merge: false }>(),
  ]);
  if (error) return error.code === "P0002" ? { status: "not_found" } : { status: "load_failed" };
  if (assignmentResult.error) return { status: "load_failed" };
  const payload = data as { status: "no_schedule" } | { status: "not_effective"; scheduleId: string; name: string | null } | { status: "ok"; snapshot: FeeScheduleSnapshot } | null;
  if (!payload) return { status: "load_failed" };
  if (payload.status === "no_schedule") return { status: "no_schedule" };

  const a = assignmentResult.data;
  const assignment: BrandFeeAssignment | null = a ? { id: a.id, scheduleId: a.schedule_id, assignedAt: a.assigned_at } : null;
  if (payload.status === "not_effective") {
    const schedule = { id: payload.scheduleId, name: a?.fee_schedules?.name ?? payload.name ?? "", description: a?.fee_schedules?.description ?? null };
    return { status: "not_effective", assignment, schedule };
  }
  const snapshot = payload.snapshot;
  const schedule = { id: snapshot.scheduleId, name: snapshot.name, description: a?.fee_schedules?.description ?? null };
  return { status: "ok", assignment, schedule, activeVersion: snapshot };
}

// ---------------------------------------------------------------------------
// Pure helpers over a snapshot (run setup questions, packaging selects)
// ---------------------------------------------------------------------------
/**
 * One question the customer answers at run setup. Carries no rule keys or ids: the rules that read
 * the answer are described by name and rate only, so the same object can feed brand-facing screens.
 */
export interface DriverQuestion {
  /** The answer's key in `assumptions.fulfillment.drivers` / `.orderShares`. */
  key: string;
  label: string;
  unit: string;
  kind: FeeDriver["kind"];
  /** Which answer block the key belongs to: order_share answers go to `orderShares`, the rest to `drivers`. */
  answers: "drivers" | "orderShares";
  scope: FeeScope;
  billingPeriod: BillingPeriod | null;
  /** What the 3PL tells the customer about answering (first help text among the rules that read it). */
  helpText: string | null;
  /** The rules priced from this answer, in schedule order, each with the rate in the customer's words. */
  rules: { name: string; category: FeeCategory; describe: string; description: string | null }[];
  /** Long-term storage: the answer is a part of another question's quantity. */
  longTerm: { mode: "replace" | "surcharge"; thresholdDays: number; partOf: { key: string; label: string } | null } | null;
}

/** The questions a customer answers for a version: one per distinct driver key, in position order. */
export function driverQuestions(snapshot: FeeVersionSnapshot | FeeScheduleSnapshot): DriverQuestion[] {
  const rules = [...snapshot.rules].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
  const byKey = new Map<string, DriverQuestion>();
  const ruleByKey = new Map(rules.map((r) => [r.key, r]));
  for (const rule of rules) {
    const d = rule.driver;
    if (!d || (rule.basis !== "driver" && rule.basis !== "order_driver")) continue;
    const describe = rule.scope === "monthly" ? describeMonthlyRate(rule) : describeFeeRule(rule);
    const entry = { name: rule.name, category: rule.category, describe, description: rule.description ?? null };
    const existing = byKey.get(d.key);
    if (existing) {
      existing.rules.push(entry);
      if (existing.helpText === null && rule.helpText) existing.helpText = rule.helpText;
      continue;
    }
    let longTerm: DriverQuestion["longTerm"] = null;
    if (d.longTerm) {
      const replaced = ruleByKey.get(d.longTerm.replacesRuleKey);
      longTerm = { mode: d.longTerm.mode, thresholdDays: d.longTerm.thresholdDays, partOf: replaced?.driver ? { key: replaced.driver.key, label: replaced.driver.label } : null };
    }
    byKey.set(d.key, {
      key: d.key,
      label: d.label,
      unit: d.unit,
      kind: d.kind,
      answers: d.kind === "order_share" ? "orderShares" : "drivers",
      scope: rule.scope,
      billingPeriod: d.billingPeriod ?? null,
      helpText: rule.helpText ?? null,
      rules: [entry],
      longTerm,
    });
  }
  return [...byKey.values()];
}

/**
 * The normalised packaging types the version prices, in schedule order ("*" catch-alls excluded),
 * for packaging selects in run setup, the calculator and forecasts.
 */
export function packagingTypes(snapshot: FeeVersionSnapshot | FeeScheduleSnapshot): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rule of [...snapshot.rules].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))) {
    if (rule.scope !== "order" || rule.basis !== "package") continue;
    for (const t of rule.conditions?.packagingTypes ?? []) {
      if (t === "*" || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** True when a package-basis rule prices every other packaging type ("*"). */
export function hasPackagingCatchAll(snapshot: FeeVersionSnapshot | FeeScheduleSnapshot): boolean {
  return snapshot.rules.some((r) => r.scope === "order" && r.basis === "package" && (r.conditions?.packagingTypes ?? []).includes("*"));
}
