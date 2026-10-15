import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculationBaseSchema, ruleConditionSchema } from "@/engine/validate";
import type { DimRules, PricingContext, RateCardSnapshot, RateRow, RuleCondition, ServiceTerms, SurchargeOverride, SurchargeRule, ZipList, ZoneRow } from "@/engine/types";

/**
 * Builds the engine's PricingContext from the database for one rate card and ship date.
 * Rate-card data is read through the caller's Row Level Security (a brand user only sees active
 * versions of assigned cards and only the services allowed for them). Surcharge rules and ZIP lists
 * come from `pricing_rules_for_card()`, which authorizes once and returns only what applies to the
 * caller (tenant-wide rules plus rules scoped to the brand being priced). Nothing here widens access.
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

export type SnapshotError = "rate_card_not_found" | "no_version_in_effect" | "version_not_found";

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
  source_reference: string;
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
  zipLists: Array<{ key: string; version: number; sourceReference: string; effectiveDate: string; expirationDate: string | null; entries: string[] }>;
  brandId: string | null;
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
  if (error || !data) return { ok: false, error: versionId ? "version_not_found" : "no_version_in_effect" };
  return {
    ok: true,
    version: { id: data.id, versionNumber: data.version_number, effectiveDate: data.effective_date, expirationDate: data.expiration_date, status: data.status },
  };
}

export async function loadServiceTerms(supabase: SupabaseClient, versionId: string): Promise<ServiceTerms[]> {
  const { data } = await supabase
    .from("rate_card_service_terms")
    .select(
      "service_id, dim_divisor, dim_threshold_cubic_in, dimension_rounding, weight_rounding, min_billable_lb, dim_exempt, min_charge, included_surcharge_keys, excluded_surcharge_keys, zone_chart_key, zone_independent, surcharge_markup_percent, source_reference, shipping_services(id, carrier_code, code, name)",
    )
    .eq("version_id", versionId)
    .overrideTypes<TermsRow[], { merge: false }>();
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
      sourceReference: t.source_reference,
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
}

export interface LoadedSnapshot {
  context: PricingContext;
  version: ActiveVersion;
  services: ServiceOption[];
  tenantId: string;
  /** Rule versions that could not be used (malformed conditions or base); surfaced as warnings by callers. */
  issues: string[];
}

export async function loadPricingContext(supabase: SupabaseClient, opts: LoadOptions): Promise<{ ok: true; snapshot: LoadedSnapshot } | { ok: false; error: SnapshotError }> {
  const { data: card } = await supabase.from("rate_cards").select("id, name, tenant_id, status").eq("id", opts.rateCardId).maybeSingle();
  if (!card) return { ok: false, error: "rate_card_not_found" };

  const resolved = await resolveVersion(supabase, card.id, opts.shipDate, opts.versionId);
  if (!resolved.ok) return resolved;
  const version = resolved.version;

  let terms = await loadServiceTerms(supabase, version.id);
  if (opts.brandId) {
    const { data: assignment } = await supabase
      .from("brand_rate_card_assignments")
      .select("allowed_service_ids")
      .eq("brand_id", opts.brandId)
      .eq("rate_card_id", card.id)
      .is("unassigned_at", null)
      .maybeSingle();
    if (assignment?.allowed_service_ids?.length) {
      const allowed = new Set(assignment.allowed_service_ids as string[]);
      terms = terms.filter((t) => allowed.has(t.serviceId));
    }
  }

  const [{ data: rowsJson }, { data: zonesJson }, rulesResult] = await Promise.all([
    supabase.rpc("rate_card_rows_json", { p_version: version.id, p_service_ids: opts.serviceIds ?? null }),
    supabase.rpc("rate_card_zones_json", { p_version: version.id }),
    supabase.rpc("pricing_rules_for_card", { p_rate_card: card.id, p_ship_date: opts.shipDate, p_brand: opts.brandId ?? null }),
  ]);
  const rows = (rowsJson ?? []) as RateRow[];
  const zones = ((zonesJson ?? []) as ZoneRow[]).map((z) => ({ ...z, zoneChartKey: z.zoneChartKey ?? "default" }));

  const issues: string[] = [];
  const payload = (rulesResult.data ?? { rules: [], zipLists: [], brandId: null }) as RulesPayload;
  const serviceCodeById = new Map(terms.map((t) => [t.serviceId, t.serviceCode]));
  const rules = mapRules(payload, serviceCodeById, issues);
  const zipLists: ZipList[] = (payload.zipLists ?? []).map((l) => ({
    key: l.key,
    version: l.version,
    sourceReference: l.sourceReference,
    effectiveDate: l.effectiveDate,
    expirationDate: l.expirationDate,
    entries: l.entries ?? [],
  }));
  const overrides = opts.brandId ? await loadOverrides(supabase, opts.brandId, opts.shipDate) : [];

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
    },
  };
}

function mapRules(payload: RulesPayload, serviceCodeById: Map<string, string>, issues: string[]): SurchargeRule[] {
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
      issues.push(`Rule ${v.key} v${v.version} has an invalid condition or base and was not applied.`);
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

async function loadOverrides(supabase: SupabaseClient, brandId: string, shipDate: string): Promise<SurchargeOverride[]> {
  const { data } = await supabase
    .from("customer_surcharge_overrides")
    .select("mode, amount, percent, effective_date, expiration_date, reference, surcharge_rules!inner(rule_key)")
    .eq("brand_id", brandId)
    .is("ended_at", null)
    .lte("effective_date", shipDate)
    .or(`expiration_date.is.null,expiration_date.gte.${shipDate}`)
    .overrideTypes<{ mode: SurchargeOverride["mode"]; amount: string | number | null; percent: string | number | null; effective_date: string; expiration_date: string | null; reference: string; surcharge_rules: { rule_key: string } | null }[], { merge: false }>();
  return (data ?? [])
    .filter((o) => o.surcharge_rules)
    .map((o) => ({ ruleKey: o.surcharge_rules!.rule_key, mode: o.mode, amount: num(o.amount), percent: num(o.percent), effectiveDate: o.effective_date, expirationDate: o.expiration_date, reference: o.reference }));
}
