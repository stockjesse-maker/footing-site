import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CalculationBase, DimRules, PricingContext, RateCardSnapshot, RateRow, RuleCondition, ServiceTerms, SurchargeOverride, SurchargeRule, ZipList, ZoneRow } from "@/engine/types";

/**
 * Builds the engine's PricingContext from the database for one rate card and ship date.
 * Every query runs with the caller's JWT, so Row Level Security decides what is visible: a brand
 * user only ever gets active versions of cards assigned to their brand, published rules, and their
 * own overrides. Nothing here widens access.
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
  dim_divisor: string | null;
  dim_threshold_cubic_in: string | null;
  dimension_rounding: DimRules["dimensionRounding"];
  weight_rounding: DimRules["weightRounding"];
  min_billable_lb: string | null;
  dim_exempt: boolean;
  min_charge: string | null;
  included_surcharge_keys: string[];
  excluded_surcharge_keys: string[];
  shipping_services: { id: string; carrier_code: string; code: string; name: string } | null;
}

interface RuleVersionRow {
  id: string;
  rule_id: string;
  version_number: number;
  charge_class: SurchargeRule["chargeClass"];
  applies_to_service_ids: string[] | null;
  method: SurchargeRule["method"];
  amount: string | null;
  percent: string | null;
  per_unit_basis: "declared_value" | null;
  per_unit_size: string | null;
  per_unit_free_allowance: string | null;
  calculation_base: CalculationBase;
  conditions: RuleCondition[];
  exclusivity_group: string | null;
  exclusivity_priority: number;
  excludes_rule_keys: string[];
  per_package: boolean;
  effective_date: string;
  expiration_date: string | null;
  source_reference: string;
  source_url: string | null;
  verification_status: SurchargeRule["verificationStatus"];
  surcharge_rules: { rule_key: string; scope: "platform" | "tenant"; carrier_code: string; category: SurchargeRule["category"]; name: string; tenant_id: string | null } | null;
}

const num = (v: string | number | null): string | null => (v === null || v === undefined ? null : String(v));

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
    .select("service_id, dim_divisor, dim_threshold_cubic_in, dimension_rounding, weight_rounding, min_billable_lb, dim_exempt, min_charge, included_surcharge_keys, excluded_surcharge_keys, shipping_services(id, carrier_code, code, name)")
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
      termsVersion: `${versionId}:${t.service_id}`,
    }))
    .sort((a, b) => a.carrierCode.localeCompare(b.carrierCode) || a.serviceName.localeCompare(b.serviceName));
}

export interface LoadOptions {
  rateCardId: string;
  shipDate: string;
  /** Restrict to a specific version (staff previewing a draft). Default: the active version in effect. */
  versionId?: string;
  /** Load the brand's customer-specific overrides and honour its allowed services. */
  brandId?: string | null;
  /** Only load rows for these service ids (faster for a single calculation). */
  serviceIds?: string[];
}

export interface LoadedSnapshot {
  context: PricingContext;
  version: ActiveVersion;
  services: ServiceOption[];
  tenantId: string;
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

  const [{ data: rowsJson }, { data: zonesJson }] = await Promise.all([
    supabase.rpc("rate_card_rows_json", { p_version: version.id, p_service_ids: opts.serviceIds ?? null }),
    supabase.rpc("rate_card_zones_json", { p_version: version.id }),
  ]);
  const rows = (rowsJson ?? []) as RateRow[];
  const zones = (zonesJson ?? []) as ZoneRow[];

  const carrierCodes = [...new Set(terms.map((t) => t.carrierCode))];
  const rules = carrierCodes.length ? await loadRules(supabase, card.tenant_id, carrierCodes, opts.shipDate, terms) : [];
  const zipLists = await loadZipLists(supabase, card.tenant_id, rules);
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
    },
  };
}

async function loadRules(supabase: SupabaseClient, tenantId: string, carrierCodes: string[], shipDate: string, terms: ServiceTerms[]): Promise<SurchargeRule[]> {
  const { data } = await supabase
    .from("surcharge_rule_versions")
    .select(
      "id, rule_id, version_number, charge_class, applies_to_service_ids, method, amount, percent, per_unit_basis, per_unit_size, per_unit_free_allowance, calculation_base, conditions, exclusivity_group, exclusivity_priority, excludes_rule_keys, per_package, effective_date, expiration_date, source_reference, source_url, verification_status, surcharge_rules!inner(rule_key, scope, carrier_code, category, name, tenant_id)",
    )
    .eq("status", "published")
    .lte("effective_date", shipDate)
    .or(`expiration_date.is.null,expiration_date.gte.${shipDate}`)
    .in("surcharge_rules.carrier_code", carrierCodes)
    .overrideTypes<RuleVersionRow[], { merge: false }>();
  const serviceCodeById = new Map(terms.map((t) => [t.serviceId, t.serviceCode]));
  const rules: SurchargeRule[] = [];
  for (const v of data ?? []) {
    const r = v.surcharge_rules;
    if (!r || (r.tenant_id !== null && r.tenant_id !== tenantId)) continue; // RLS already enforces this; belt and braces
    const serviceCodes = v.applies_to_service_ids ? v.applies_to_service_ids.map((id) => serviceCodeById.get(id)).filter((c): c is string => !!c) : null;
    if (serviceCodes && !serviceCodes.length) continue; // applies only to services not on this card
    rules.push({
      key: r.rule_key,
      ruleId: v.rule_id,
      versionId: v.id,
      version: v.version_number,
      scope: r.scope,
      carrierCode: r.carrier_code,
      serviceCodes,
      category: r.category,
      name: r.name,
      chargeClass: v.charge_class,
      method: v.method,
      amount: num(v.amount),
      percent: num(v.percent),
      perUnit: v.method === "per_unit" && v.per_unit_basis && v.per_unit_size ? { basis: v.per_unit_basis, unitSize: String(v.per_unit_size), freeAllowance: String(v.per_unit_free_allowance ?? "0") } : null,
      base: v.calculation_base ?? { kind: "base_rate" },
      conditions: Array.isArray(v.conditions) ? v.conditions : [],
      exclusivityGroup: v.exclusivity_group,
      exclusivityPriority: v.exclusivity_priority ?? 0,
      excludesRuleKeys: v.excludes_rule_keys ?? [],
      perPackage: v.per_package,
      effectiveDate: v.effective_date,
      expirationDate: v.expiration_date,
      sourceReference: v.source_reference,
      sourceUrl: v.source_url,
      verificationStatus: v.verification_status,
    });
  }
  return rules;
}

async function loadZipLists(supabase: SupabaseClient, tenantId: string, rules: SurchargeRule[]): Promise<ZipList[]> {
  const keys = [...new Set(rules.flatMap((r) => r.conditions.filter((c): c is Extract<RuleCondition, { type: "destination_zip_in_list" }> => c.type === "destination_zip_in_list").map((c) => c.listKey)))];
  if (!keys.length) return [];
  const { data: lists } = await supabase
    .from("zip_lists")
    .select("id, key, version, source_reference, tenant_id")
    .in("key", keys)
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
    .order("version", { ascending: false });
  const chosen = new Map<string, { id: string; key: string; version: number; source_reference: string }>();
  for (const l of lists ?? []) if (!chosen.has(l.key)) chosen.set(l.key, l);
  const out: ZipList[] = [];
  for (const l of chosen.values()) {
    const { data: entries } = await supabase.rpc("zip_list_entries_array", { p_list: l.id });
    out.push({ key: l.key, version: l.version, sourceReference: l.source_reference, entries: (entries ?? []) as string[] });
  }
  return out;
}

async function loadOverrides(supabase: SupabaseClient, brandId: string, shipDate: string): Promise<SurchargeOverride[]> {
  const { data } = await supabase
    .from("customer_surcharge_overrides")
    .select("mode, amount, percent, effective_date, expiration_date, reference, surcharge_rules!inner(rule_key)")
    .eq("brand_id", brandId)
    .is("ended_at", null)
    .lte("effective_date", shipDate)
    .or(`expiration_date.is.null,expiration_date.gte.${shipDate}`)
    .overrideTypes<{ mode: SurchargeOverride["mode"]; amount: string | null; percent: string | null; effective_date: string; expiration_date: string | null; reference: string; surcharge_rules: { rule_key: string } | null }[], { merge: false }>();
  return (data ?? [])
    .filter((o) => o.surcharge_rules)
    .map((o) => ({ ruleKey: o.surcharge_rules!.rule_key, mode: o.mode, amount: num(o.amount), percent: num(o.percent), effectiveDate: o.effective_date, expirationDate: o.expiration_date, reference: o.reference }));
}
