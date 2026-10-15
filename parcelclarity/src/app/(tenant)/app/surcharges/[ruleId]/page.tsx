import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { archiveSurchargeRule, publishRuleVersion } from "@/app/actions/surcharges";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { CategoryLabel, RetireVersionForm, RuleForm, RuleStatusBadge, VerificationBadge, VersionTerms, type CarrierOption, type RuleFormInitial, type RuleVersionView } from "@/components/pricing/rule-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { carrierProfile } from "@/engine/carriers";
import type { CalculationBase, CalculationMethod, ChargeClass, RuleCondition, SurchargeCategory } from "@/engine/types";
import { calculationBaseSchema, ruleConditionSchema } from "@/engine/validate";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { formatDate } from "@/lib/format/date";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Surcharge rule" };

interface RuleRow {
  id: string;
  scope: "platform" | "tenant";
  tenant_id: string | null;
  carrier_code: string;
  rule_key: string;
  category: string;
  name: string;
  brand_id: string | null;
  archived_at: string | null;
  created_at: string;
}

interface VersionRow {
  id: string;
  version_number: number;
  status: string;
  charge_class: ChargeClass;
  applies_to_service_ids: string[] | null;
  method: CalculationMethod;
  amount: string | number | null;
  percent: string | number | null;
  per_unit_size: string | number | null;
  per_unit_free_allowance: string | number | null;
  per_unit_minimum_charge: string | number | null;
  billable_weight_floor_lb: string | number | null;
  calculation_base: unknown;
  conditions: unknown;
  exclusivity_group: string | null;
  exclusivity_priority: number;
  excludes_rule_keys: string[] | null;
  per_package: boolean;
  effective_date: string;
  expiration_date: string | null;
  source_reference: string;
  source_url: string | null;
  verification_status: string;
  published_at: string | null;
  retired_at: string | null;
  created_at: string;
}

const VERSION_COLUMNS =
  "id, version_number, status, charge_class, applies_to_service_ids, method, amount, percent, per_unit_size, per_unit_free_allowance, per_unit_minimum_charge, billable_weight_floor_lb, calculation_base, conditions, exclusivity_group, exclusivity_priority, excludes_rule_keys, per_package, effective_date, expiration_date, source_reference, source_url, verification_status, published_at, retired_at, created_at";

const num = (v: string | number | null | undefined): string | null => (v === null || v === undefined ? null : String(v));
const inEffect = (v: VersionRow, today: string) => v.status === "published" && v.effective_date <= today && (!v.expiration_date || v.expiration_date >= today);

/** Stored JSON is validated before it reaches the UI; malformed rows are shown as unreadable rather than guessed at. */
const parseBase = (raw: unknown): CalculationBase | null => {
  const parsed = calculationBaseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};
const parseConditions = (raw: unknown): RuleCondition[] | null => {
  const parsed = z.array(ruleConditionSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export default async function SurchargeRuleDetail({ params }: { params: Promise<{ ruleId: string }> }) {
  const ctx = await requireTenantContext("ratecard.view");
  const { ruleId } = await params;
  if (!uuidSchema.safeParse(ruleId).success) notFound();

  const supabase = await createClient();
  // Row Level Security hides other tenants' rules, so a guessed ID is a 404; platform rules are visible to everyone.
  const { data: ruleData } = await supabase.from("surcharge_rules").select("id, scope, tenant_id, carrier_code, rule_key, category, name, brand_id, archived_at, created_at").eq("id", ruleId).maybeSingle();
  const rule = ruleData as RuleRow | null;
  if (!rule || (rule.tenant_id !== null && rule.tenant_id !== ctx.active.tenantId)) notFound();

  const own = rule.scope === "tenant" && rule.tenant_id === ctx.active.tenantId;
  const archived = rule.archived_at !== null;
  const manage = own && !archived && can(ctx.active.role, "ratecard.manage");
  const today = new Date().toISOString().slice(0, 10);

  const [versionsRes, catalog, carriersRes, brandRes, zipListsRes] = await Promise.all([
    supabase.from("surcharge_rule_versions").select(VERSION_COLUMNS).eq("rule_id", rule.id).order("version_number", { ascending: false }).overrideTypes<VersionRow[], { merge: false }>(),
    loadServiceCatalog(supabase),
    supabase.from("carriers").select("code, name").order("name").overrideTypes<CarrierOption[], { merge: false }>(),
    rule.brand_id ? supabase.from("brands").select("name").eq("id", rule.brand_id).maybeSingle() : Promise.resolve({ data: null as { name: string } | null }),
    manage
      ? supabase.from("zip_lists").select("key").or(`tenant_id.is.null,tenant_id.eq.${ctx.active.tenantId}`).eq("status", "published").overrideTypes<{ key: string }[], { merge: false }>()
      : Promise.resolve({ data: null as { key: string }[] | null }),
  ]);
  const versions = versionsRes.data ?? [];
  const carriers = carriersRes.data ?? [];
  const carrierName = carriers.find((c) => c.code === rule.carrier_code)?.name ?? rule.carrier_code;
  const serviceName = new Map(catalog.map((s) => [s.id, s.name]));
  const brandName = brandRes.data?.name ?? null;

  const views = versions.map((v): { row: VersionRow; view: RuleVersionView } => ({
    row: v,
    view: {
      versionNumber: v.version_number,
      status: v.status,
      chargeClass: v.charge_class,
      terms: {
        method: v.method,
        amount: num(v.amount),
        percent: num(v.percent),
        perUnitSize: num(v.per_unit_size),
        perUnitFreeAllowance: num(v.per_unit_free_allowance),
        perUnitMinimumCharge: num(v.per_unit_minimum_charge),
        base: parseBase(v.calculation_base),
        perPackage: v.per_package,
      },
      serviceNames: v.applies_to_service_ids ? v.applies_to_service_ids.map((id) => serviceName.get(id) ?? "Unknown service") : null,
      carrierName,
      billableWeightFloorLb: num(v.billable_weight_floor_lb),
      conditions: parseConditions(v.conditions),
      exclusivityGroup: v.exclusivity_group,
      exclusivityPriority: v.exclusivity_priority,
      excludesRuleKeys: v.excludes_rule_keys ?? [],
      effectiveDate: v.effective_date,
      expirationDate: v.expiration_date,
      sourceReference: v.source_reference,
      sourceUrl: v.source_url,
      verificationStatus: v.verification_status,
      publishedAt: v.published_at,
      retiredAt: v.retired_at,
      createdAt: v.created_at,
    },
  }));

  // The next version starts from the latest one. A published or retired version's dates would overlap, so suggest today.
  const latest = versions[0];
  const initial: RuleFormInitial = {
    name: rule.name,
    carrierCode: rule.carrier_code,
    category: rule.category as SurchargeCategory,
    chargeClass: latest?.charge_class ?? "definite",
    method: latest?.method ?? "flat",
    amount: num(latest?.amount),
    percent: num(latest?.percent),
    perUnitSize: num(latest?.per_unit_size),
    perUnitFreeAllowance: num(latest?.per_unit_free_allowance),
    perUnitMinimumCharge: num(latest?.per_unit_minimum_charge),
    billableWeightFloorLb: num(latest?.billable_weight_floor_lb),
    base: (latest ? parseBase(latest.calculation_base) : null) ?? { kind: "base_rate" },
    conditions: (latest ? parseConditions(latest.conditions) : null) ?? [],
    appliesToServiceIds: latest?.applies_to_service_ids ?? [],
    exclusivityGroup: latest?.exclusivity_group ?? null,
    exclusivityPriority: latest?.exclusivity_priority ?? 0,
    excludesRuleKeys: latest?.excludes_rule_keys ?? [],
    perPackage: latest?.per_package ?? true,
    effectiveDate: !latest || latest.status === "draft" || latest.effective_date > today ? (latest?.effective_date ?? today) : today,
    expirationDate: latest?.expiration_date ?? null,
    sourceReference: latest?.source_reference ?? "",
    sourceUrl: latest?.source_url ?? null,
  };
  const hasPublished = versions.some((v) => v.status === "published");
  const current = versions.find((v) => inEffect(v, today));

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/app/surcharges" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← Surcharges
        </Link>
      </p>
      <PageHeader
        title={rule.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={own ? "neutral" : "accent"}>{own ? "Your rule" : "Published carrier rule"}</Badge>
            {archived ? <Badge tone="danger">archived</Badge> : null}
            {brandName ? <Badge tone="accent">Only {brandName}</Badge> : null}
            <span>
              {carrierName} · <CategoryLabel category={rule.category} /> · <span className="tabular">{rule.rule_key}</span>
            </span>
          </span>
        }
        actions={
          manage ? (
            <ConfirmAction action={archiveSurchargeRule.bind(null, rule.id)} label="Archive rule" confirmLabel="Archive" variant="danger">
              Published versions are retired as of today. Past calculations keep their history.
            </ConfirmAction>
          ) : undefined
        }
      />

      {archived && rule.archived_at ? (
        <Alert tone="warning" className="mb-6">
          This rule was archived on {formatDate(rule.archived_at)}. Its versions remain for calculations dated before then; it no longer applies to new shipments and cannot receive versions.
        </Alert>
      ) : null}
      {!own ? (
        <Alert className="mb-6">
          This rule is published by ParcelClarity and cannot be edited here. Each version shows its own source and verification status. To charge a customer something different, add an exception from the customer&apos;s page or create your own rule.
        </Alert>
      ) : null}
      {own && !archived && versions.length > 0 && !current ? (
        <Alert className="mb-6">{hasPublished ? "No published version covers today, so this rule does not apply to shipments dated today." : "Nothing is published yet. Calculations ignore this rule until a version is published."}</Alert>
      ) : null}

      <div className="space-y-10">
        <section aria-labelledby="versions-heading" className="space-y-3">
          <h2 id="versions-heading" className="text-xl font-semibold tracking-tight">
            Versions
          </h2>
          {views.length ? (
            <DataList>
              {views.map(({ row, view }) => (
                <DataRow key={row.id}>
                  <div className="min-w-0 flex-1 space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Version {row.version_number}</span>
                      <RuleStatusBadge status={row.status} />
                      <VerificationBadge status={row.verification_status} />
                      {current?.id === row.id ? <Badge tone="success">In effect today</Badge> : null}
                    </div>
                    <VersionTerms version={view} />
                    {manage && row.status === "draft" ? (
                      <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm text-muted">Drafts are never used in calculations. Publishing locks these terms; a later change needs a new version.</p>
                        <ConfirmAction action={publishRuleVersion.bind(null, row.id)} label="Publish" confirmLabel="Publish version" variant="ghost">
                          Applies from {formatDate(row.effective_date)}.
                        </ConfirmAction>
                      </div>
                    ) : null}
                    {manage && row.status === "published" ? (
                      <div className="space-y-2 border-t border-line pt-4">
                        <p className="text-sm text-muted">Retiring ends this version on a day you choose. It stays in force for calculations dated up to that day and remains in the history.</p>
                        <RetireVersionForm versionId={row.id} effectiveDate={row.effective_date} today={today} />
                      </div>
                    ) : null}
                  </div>
                </DataRow>
              ))}
            </DataList>
          ) : (
            <EmptyState title="No versions">{own ? "This rule has no versions yet. Add one below." : "No published version of this rule is visible."}</EmptyState>
          )}
        </section>

        {manage ? (
          <section aria-labelledby="new-version-heading">
            <Card>
              <CardTitle id="new-version-heading">Add a new version</CardTitle>
              <CardDescription>Change an amount, a condition or the dates by adding a version. It starts from the latest version&apos;s values and is saved as a draft until you publish it.</CardDescription>
              <div className="mt-5">
                <RuleForm
                  mode="version"
                  ruleId={rule.id}
                  catalog={catalog.filter((s) => s.carrierCode === rule.carrier_code)}
                  carriers={carriers.length ? carriers : [{ code: rule.carrier_code, name: carrierName }]}
                  knownGroups={{ [rule.carrier_code]: carrierProfile(rule.carrier_code).knownExclusivityGroups }}
                  zipListKeys={[...new Set((zipListsRes.data ?? []).map((l) => l.key))].sort()}
                  initial={initial}
                  today={today}
                  basedOnVersion={latest ? { number: latest.version_number, status: latest.status } : undefined}
                />
              </div>
            </Card>
          </section>
        ) : null}
      </div>
    </>
  );
}
