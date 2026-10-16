import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculationBaseSchema, ruleConditionSchema } from "@/engine/validate";
import type { DimRules, PricingContext, RateCardSnapshot, RateRow, RuleCondition, ServiceTerms, SurchargeOverride, SurchargeRule, ZipList, ZoneRow } from "@/engine/types";

/**
 * Builds the engine's PricingContext from the database for one rate card and ship date.
 * Rate-card data is read through the caller's Row Level Security (a brand user only sees active
 * versions of assigned cards and only the services allowed for them). Surcharge rules and ZIP lists
 * come from `pricing_rules_for_card()`, which authorizes once and returns only what applies to the
 * caller (tenant-wide rules plus rules scoped to the brand being priced) together with that brand's
 * live exceptions. Nothing here widens access, and nothing is joined client-side that a brand could
 * not read (brands cannot read tenant rules, so the rule key is resolved inside the function).
 */

export interface ServiceOption {
  serviceId: string;
  carrierCode: string;
  serviceCode: string;
  serviceName: string;
}

export interface ActiveVersion {
  id: string;
  versionNumber: number;
  effectiveDate: string;
  expirationDate: string | null;
  status: string;
}

/** `load_failed` is a query or RPC error (an outage, a timeout): retryable, never a quote and never "not found". */
export type SnapshotError = "rate_card_not_found" | "no_version_in_effect" | "version_not_found" | "load_failed";

interface TermsRow {
  service_id: string;
  dim_divisor: string | number | null;
  dim_threshold_cubic_in: string | number | null;
  dimension_rounding: DimRules["dimensionRounding"];
  weight_rounding: DimRules["weightRounding"];
  min_billable_lb: string | number | null;
  dim_exempt: boolean;
  min_charge: string | number | null;
  included_surcharge_keys: string[];
  excluded_surcharge_keys: string[];
  zone_chart_key: string;
  zone_independent: boolean;
  surcharge_markup_percent: string | number | null;
  shipping_services: { id: string; carrier_code: string; code: string; name: string } | null;
}

/** Shape returned by public.pricing_rules_for_card(). */
interface RulesPayload {
  rules: Array<{
    key: string;
    ruleId: string;
    versionId: string;
    version: number;
    scope: "platform" | "tenant";
    brandId: string | null;
    carrierCode: string;
    category: SurchargeRule["category"];
    name: string;
    chargeClass: SurchargeRule["chargeClass"];
    method: SurchargeRule["method"];
    amount: string | null;
    percent: string | null;
    perUnit: { basis: "declared_value"; unitSize: string; freeAllowance: string; minimumCharge: string | null } | null;
    billableWeightFloorLb: string | null;
    base: unknown;
    conditions: unknown;
    appliesToServiceIds: string[] | null;
    exclusivityGroup: string | null;
    exclusivityPriority: number;
    excludesRuleKeys: string[] | null;
    perPackage: boolean;
    effectiveDate: string;
    expirationDate: string | null;
    sourceReference: string;
    sourceUrl: string | null;
    verificationStatus: SurchargeRule["verificationStatus"];
  }>;
  /** `entries` is null for lists the caller said it already holds (`p_known_lists`). */
  zipLists: Array<{ id: string; key: string; version: number; sourceReference: string; effectiveDate: string; expirationDate: string | null; entries: string[] | null }>;
  /**
   * The priced brand's live exceptions, already joined to rule keys inside the authorizing function. `reference` is a fixed
   * label: the 3PL's note lives in the staff-only `customer_surcharge_override_notes` and is never part of this payload.
   */
  overrides: Array<{ id: string; ruleKey: string; mode: SurchargeOverride["mode"]; amount: string | null; percent: string | null; effectiveDate: string; expirationDate: string | null; reference: string }>;
  brandId: string | null;
}

/**
 * Caches a bulk run keeps across many loads of the same card: rate rows, zones and terms per
 * version, and ZIP lists per id (the database skips entries for lists the cache already holds).
 */
export interface PricingLoadCache {
  versions: Map<string, { terms: ServiceTerms[]; rows: RateRow[]; zones: ZoneRow[] }>;
  zipLists: Map<string, ZipList>;
}

export function createPricingLoadCache(): PricingLoadCache {
  return { versions: new Map(), zipLists: new Map() };
}

/** Identifiers of everything a load used, pinned by bulk runs for reproducibility. */
export interface PricingPins {
  rateCardVersionId: string;
  ruleVersionIds: string[];
  zipListIds: string[];
  overrideIds: string[];
}

const num = (v: string | number | null | undefined): string | null => (v === null || v === undefined ? null : String(v));

/** Finds the version in effect on a date (or a specific version when `versionId` is given). */
export async function resolveVersion(
  supabase: SupabaseClient,
  rateCardId: string,
  shipDate: string,
  versionId?: string,
): Promise<{ ok: true; version: ActiveVersion } | { ok: false; error: SnapshotError }> {
  let query = supabase.from("rate_card_versions").select("id, version_number, effective_date, expiration_date, status").eq("rate_card_id", rateCardId);
  query = versionId
    ? query.eq("id", versionId)
    : query.eq("status", "active").lte("effective_date", shipDate).or(`expiration_date.is.null,expiration_date.gte.${shipDate}`);
  const { data, error } = await query.order("effective_date", { ascending: false }).limit(1).maybeSingle();
  if (error) return { ok: false, error: "load_failed" };
  if (!data) return { ok: false, error: versionId ? "version_not_found" : "no_version_in_effect" };
  return {
    ok: true,
    version: { id: data.id, versionNumber: data.version_number, effectiveDate: data.effective_date, expirationDate: data.expiration_date, status: data.status },
  };
}

/**
 * The service terms of a version. Brand-reachable (the calculator, runs and forecasts all load through here), so it never
 * reads `rate_card_service_term_sources`, the staff-only table holding each term's source note; `sourceReference` stays unset.
 */
export async function loadServiceTerms(supabase: SupabaseClient, versionId: string): Promise<ServiceTerms[]> {
  const { data, error } = await supabase
    .from("rate_card_service_terms")
    .select(
      "service_id, dim_divisor, dim_threshold_cubic_in, dimension_rounding, weight_rounding, min_billable_lb, dim_exempt, min_charge, included_surcharge_keys, excluded_surcharge_keys, zone_chart_key, zone_independent, surcharge_markup_percent, shipping_services(id, carrier_code, code, name)",
    )
    .eq("version_id", versionId)
    .overrideTypes<TermsRow[], { merge: false }>();
  if (error) throw new PricingLoadError(error.message);
  return (data ?? [])
    .filter((t) => t.shipping_services)
    .map((t) => ({
      serviceId: t.service_id,
      carrierCode: t.shipping_services!.carrier_code,
      serviceCode: t.shipping_services!.code,
      serviceName: t.shipping_services!.name,
      dim: {
        divisor: num(t.dim_divisor),
        thresholdCubicIn: num(t.dim_threshold_cubic_in),
        dimensionRounding: t.dimension_rounding,
        weightRounding: t.weight_rounding,
        minBillableLb: num(t.min_billable_lb),
        exempt: t.dim_exempt,
      },
      minCharge: num(t.min_charge),
      includedSurchargeKeys: t.included_surcharge_keys ?? [],
      excludedSurchargeKeys: t.excluded_surcharge_keys ?? [],
      zoneChartKey: t.zone_chart_key ?? "default",
      zoneIndependent: t.zone_independent ?? false,
      surchargeMarkupPercent: num(t.surcharge_markup_percent),
      termsVersion: `${versionId}:${t.service_id}`,
    }))
    .sort((a, b) => a.carrierCode.localeCompare(b.carrierCode) || a.serviceName.localeCompare(b.serviceName));
}

export interface LoadOptions {
  rateCardId: string;
  shipDate: string;
  /** Restrict to a specific version (staff previewing a draft). Default: the active version in effect. */
  versionId?: string;
  /** Price on behalf of a brand: its overrides, brand-scoped rules and allowed services apply. */
  brandId?: string | null;
  /** Only load rows for these service ids (faster for a single calculation). */
  serviceIds?: string[];
  /** Shared across loads by bulk runs; never shared between users. */
  cache?: PricingLoadCache;
  /**
   * Staff only: ask for the unfiltered context. A reweigh, remeasure or correction fee rule leaves a customer's pricing context when the
   * 3PL's decision for that customer says the fee is not billed to them; the adjustment screens need that rule to price it. The database
   * grants this only to staff who may view adjustments (anyone else gets the filtered context whatever they pass), and it is sent only
   * when true, so every other caller's request is exactly what it was.
   */
  adjustmentView?: boolean;
}

export interface LoadedSnapshot {
  context: PricingContext;
  version: ActiveVersion;
  services: ServiceOption[];
  tenantId: string;
  /** Rule versions that could not be used (malformed conditions or base); surfaced as warnings by callers. */
  issues: string[];
  /**
   * The rule version ids behind `issues`, one per issue and in the same order. Runs keep these (never the text, which names the
   * 3PL's rules) to count distinct problems without storing words a customer could read; the text goes to the staff-only run context.
   */
  issueVersionIds: string[];
  pins: PricingPins;
}

/** A query failed while loading pricing data; the caller retries rather than pricing on partial data. */
export class PricingLoadError extends Error {}

export async function loadPricingContext(supabase: SupabaseClient, opts: LoadOptions): Promise<{ ok: true; snapshot: LoadedSnapshot } | { ok: false; error: SnapshotError }> {
  try {
    return await loadPricingContextInner(supabase, opts);
  } catch (err) {
    if (err instanceof PricingLoadError) return { ok: false, error: "load_failed" };
    throw err;
  }
}

async function loadPricingContextInner(supabase: SupabaseClient, opts: LoadOptions): Promise<{ ok: true; snapshot: LoadedSnapshot } | { ok: false; error: SnapshotError }> {
  const { data: card, error: cardError } = await supabase.from("rate_cards").select("id, name, tenant_id, status").eq("id", opts.rateCardId).maybeSingle();
  if (cardError) return { ok: false, error: "load_failed" };
  if (!card) return { ok: false, error: "rate_card_not_found" };
  // A retired card stays readable to staff (history) but is never priced for a customer.
  if (opts.brandId && card.status !== "active") return { ok: false, error: "rate_card_not_found" };

  const resolved = await resolveVersion(supabase, card.id, opts.shipDate, opts.versionId);
  if (!resolved.ok) return resolved;
  const version = resolved.version;

  const cached = opts.cache?.versions.get(version.id);
  let terms = cached ? cached.terms : await loadServiceTerms(supabase, version.id);
  if (opts.brandId) {
    const { data: assignment, error: assignmentError } = await supabase
      .from("brand_rate_card_assignments")
      .select("allowed_service_ids")
      .eq("brand_id", opts.brandId)
      .eq("rate_card_id", card.id)
      .is("unassigned_at", null)
      .maybeSingle();
    if (assignmentError) return { ok: false, error: "load_failed" };
    if (assignment?.allowed_service_ids?.length) {
      const allowed = new Set(assignment.allowed_service_ids as string[]);
      terms = terms.filter((t) => allowed.has(t.serviceId));
    }
  }

  const knownLists = opts.cache ? [...opts.cache.zipLists.keys()] : null;
  const [rowsResult, zonesResult, rulesResult] = await Promise.all([
    cached && !opts.serviceIds ? Promise.resolve({ data: cached.rows, error: null }) : supabase.rpc("rate_card_rows_json", { p_version: version.id, p_service_ids: opts.serviceIds ?? null }),
    cached ? Promise.resolve({ data: cached.zones, error: null }) : supabase.rpc("rate_card_zones_json", { p_version: version.id }),
    supabase.rpc("pricing_rules_for_card", { p_rate_card: card.id, p_ship_date: opts.shipDate, p_brand: opts.brandId ?? null, p_known_lists: knownLists, ...(opts.adjustmentView ? { p_adjustment_view: true } : {}) }),
  ]);
  // A failed load is never priced as "no rules": the database refuses the call (P0003) when the caller
  // or the brand being priced has no right to this card; anything else is an outage, not a quote.
  if (rulesResult.error?.code === "P0003") return { ok: false, error: "rate_card_not_found" };
  if (rowsResult.error || zonesResult.error || rulesResult.error || !rulesResult.data) return { ok: false, error: "load_failed" };
  const rows = (rowsResult.data ?? []) as RateRow[];
  const zones = ((zonesResult.data ?? []) as ZoneRow[]).map((z) => ({ ...z, zoneChartKey: z.zoneChartKey ?? "default" }));
  if (opts.cache && !cached && !opts.serviceIds) opts.cache.versions.set(version.id, { terms: await loadServiceTerms(supabase, version.id), rows, zones });

  const issues: string[] = [];
  const issueVersionIds: string[] = [];
  const payload = rulesResult.data as RulesPayload;
  const serviceCodeById = new Map(terms.map((t) => [t.serviceId, t.serviceCode]));
  const rules = mapRules(payload, serviceCodeById, issues, issueVersionIds);
  const zipLists: ZipList[] = [];
  for (const l of payload.zipLists ?? []) {
    const known = opts.cache?.zipLists.get(l.id);
    if (known) {
      zipLists.push(known);
      continue;
    }
    const list: ZipList = { key: l.key, version: l.version, sourceReference: l.sourceReference, effectiveDate: l.effectiveDate, expirationDate: l.expirationDate, entries: l.entries ?? [] };
    opts.cache?.zipLists.set(l.id, list);
    zipLists.push(list);
  }
  const pins: PricingPins = {
    rateCardVersionId: version.id,
    ruleVersionIds: rules.map((r) => r.versionId),
    zipListIds: (payload.zipLists ?? []).map((l) => l.id),
    overrideIds: (payload.overrides ?? []).map((o) => o.id),
  };
  const overrides: SurchargeOverride[] = (payload.overrides ?? []).map((o) => ({
    ruleKey: o.ruleKey,
    mode: o.mode,
    amount: num(o.amount),
    percent: num(o.percent),
    effectiveDate: o.effectiveDate,
    expirationDate: o.expirationDate,
    reference: o.reference,
  }));

  const rateCard: RateCardSnapshot = {
    rateCardId: card.id,
    rateCardName: card.name,
    versionId: version.id,
    versionNumber: version.versionNumber,
    currency: "USD",
    effectiveDate: version.effectiveDate,
    expirationDate: version.expirationDate,
    services: terms,
    rows,
    zones,
  };
  return {
    ok: true,
    snapshot: {
      context: { rateCard, rules, zipLists, overrides },
      version,
      services: terms.map((t) => ({ serviceId: t.serviceId, carrierCode: t.carrierCode, serviceCode: t.serviceCode, serviceName: t.serviceName })),
      tenantId: card.tenant_id,
      issues,
      issueVersionIds,
      pins,
    },
  };
}

function mapRules(payload: RulesPayload, serviceCodeById: Map<string, string>, issues: string[], issueVersionIds: string[]): SurchargeRule[] {
  const rules: SurchargeRule[] = [];
  for (const v of payload.rules ?? []) {
    const conditions: RuleCondition[] = [];
    let bad = false;
    for (const c of Array.isArray(v.conditions) ? v.conditions : []) {
      const parsed = ruleConditionSchema.safeParse(c);
      if (parsed.success) conditions.push(parsed.data);
      else bad = true;
    }
    const base = calculationBaseSchema.safeParse(v.base ?? { kind: "base_rate" });
    if (bad || !base.success) {
      // Rules are named, never keyed, in anything a customer may read.
      issues.push(`The surcharge rule "${v.name}" has an invalid condition or base and was not applied.`);
      issueVersionIds.push(v.versionId);
      continue;
    }
    const serviceCodes = v.appliesToServiceIds ? v.appliesToServiceIds.map((id) => serviceCodeById.get(id)).filter((c): c is string => !!c) : null;
    if (serviceCodes && !serviceCodes.length) continue; // applies only to services not on this card
    rules.push({
      key: v.key,
      ruleId: v.ruleId,
      versionId: v.versionId,
      version: v.version,
      scope: v.scope,
      brandId: v.brandId,
      carrierCode: v.carrierCode,
      serviceCodes,
      category: v.category,
      name: v.name,
      chargeClass: v.chargeClass,
      method: v.method,
      amount: num(v.amount),
      percent: num(v.percent),
      perUnit: v.perUnit ? { basis: "declared_value", unitSize: String(v.perUnit.unitSize), freeAllowance: String(v.perUnit.freeAllowance ?? "0"), minimumCharge: num(v.perUnit.minimumCharge) } : null,
      billableWeightFloorLb: num(v.billableWeightFloorLb),
      base: base.data,
      conditions,
      exclusivityGroup: v.exclusivityGroup,
      exclusivityPriority: v.exclusivityPriority ?? 0,
      excludesRuleKeys: v.excludesRuleKeys ?? [],
      perPackage: v.perPackage,
      effectiveDate: v.effectiveDate,
      expirationDate: v.expirationDate,
      sourceReference: v.sourceReference,
      sourceUrl: v.sourceUrl,
      verificationStatus: v.verificationStatus,
    });
  }
  return rules;
}
