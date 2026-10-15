import type { Metadata } from "next";
import Link from "next/link";
import { CategoryLabel, ChargeSummary, RuleStatusBadge, VerificationBadge, ZipListUploadForm, type ChargeTerms } from "@/components/pricing/rule-form";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { calculationBaseSchema } from "@/engine/validate";
import type { CalculationMethod } from "@/engine/types";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { formatDate } from "@/lib/format/date";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Surcharges" };

interface RuleRow {
  id: string;
  carrier_code: string;
  rule_key: string;
  category: string;
  name: string;
  brand_id: string | null;
}

interface VersionRow {
  id: string;
  rule_id: string;
  version_number: number;
  status: string;
  method: CalculationMethod;
  amount: string | number | null;
  percent: string | number | null;
  per_unit_size: string | number | null;
  per_unit_free_allowance: string | number | null;
  per_unit_minimum_charge: string | number | null;
  calculation_base: unknown;
  per_package: boolean;
  effective_date: string;
  expiration_date: string | null;
  verification_status: string;
  source_reference: string;
}

interface ZipListRow {
  id: string;
  tenant_id: string | null;
  carrier_code: string | null;
  key: string;
  name: string;
  version: number;
  source_reference: string;
  source_url: string | null;
  verification_status: string;
  effective_date: string;
  expiration_date: string | null;
  entry_count: number;
  status: string;
}

interface CarrierRow {
  code: string;
  name: string;
}

const VERSION_COLUMNS = "id, rule_id, version_number, status, method, amount, percent, per_unit_size, per_unit_free_allowance, per_unit_minimum_charge, calculation_base, per_package, effective_date, expiration_date, verification_status, source_reference";
const RULE_COLUMNS = "id, carrier_code, rule_key, category, name, brand_id";

const num = (v: string | number | null | undefined): string | null => (v === null || v === undefined ? null : String(v));
const effectivity = (effective: string, expiration: string | null) => (expiration ? `${formatDate(effective)} – ${formatDate(expiration)}` : `From ${formatDate(effective)}`);
const inEffect = (v: { status: string; effective_date: string; expiration_date: string | null }, today: string) => v.status === "published" && v.effective_date <= today && (!v.expiration_date || v.expiration_date >= today);

function chargeTerms(v: VersionRow): ChargeTerms {
  const base = calculationBaseSchema.safeParse(v.calculation_base);
  return {
    method: v.method,
    amount: num(v.amount),
    percent: num(v.percent),
    perUnitSize: num(v.per_unit_size),
    perUnitFreeAllowance: num(v.per_unit_free_allowance),
    perUnitMinimumCharge: num(v.per_unit_minimum_charge),
    base: base.success ? base.data : null,
    perPackage: v.per_package,
  };
}

function groupByRule(versions: VersionRow[]): Map<string, VersionRow[]> {
  const byRule = new Map<string, VersionRow[]>();
  for (const v of versions) byRule.set(v.rule_id, [...(byRule.get(v.rule_id) ?? []), v]);
  return byRule;
}

export default async function SurchargesPage() {
  const ctx = await requireTenantContext("ratecard.view");
  const supabase = await createClient();
  const tenantId = ctx.active.tenantId;
  const manage = can(ctx.active.role, "ratecard.manage");
  const today = new Date().toISOString().slice(0, 10);

  // Row Level Security already limits rules and lists to platform rows plus this tenant's; the filters make the intent explicit.
  const [rulesRes, versionsRes, platformRulesRes, platformVersionsRes, zipListsRes, carriersRes, brandsRes] = await Promise.all([
    supabase.from("surcharge_rules").select(RULE_COLUMNS).eq("tenant_id", tenantId).is("archived_at", null).order("carrier_code").order("name").overrideTypes<RuleRow[], { merge: false }>(),
    supabase.from("surcharge_rule_versions").select(VERSION_COLUMNS).eq("tenant_id", tenantId).order("version_number", { ascending: false }).overrideTypes<VersionRow[], { merge: false }>(),
    supabase.from("surcharge_rules").select(RULE_COLUMNS).is("tenant_id", null).is("archived_at", null).order("carrier_code").order("name").overrideTypes<RuleRow[], { merge: false }>(),
    supabase.from("surcharge_rule_versions").select(VERSION_COLUMNS).is("tenant_id", null).eq("status", "published").order("effective_date", { ascending: false }).overrideTypes<VersionRow[], { merge: false }>(),
    supabase
      .from("zip_lists")
      .select("id, tenant_id, carrier_code, key, name, version, source_reference, source_url, verification_status, effective_date, expiration_date, entry_count, status")
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
      .order("key")
      .order("version", { ascending: false })
      .overrideTypes<ZipListRow[], { merge: false }>(),
    supabase.from("carriers").select("code, name").order("name").overrideTypes<CarrierRow[], { merge: false }>(),
    supabase.from("brands").select("id, name").eq("tenant_id", tenantId).overrideTypes<{ id: string; name: string }[], { merge: false }>(),
  ]);

  const rules = rulesRes.data ?? [];
  const versions = versionsRes.data ?? [];
  const versionsByRule = groupByRule(versions);
  const platformVersionsByRule = groupByRule(platformVersionsRes.data ?? []);
  const platformRules = (platformRulesRes.data ?? []).filter((r) => (platformVersionsByRule.get(r.id) ?? []).length > 0);
  const zipLists = zipListsRes.data ?? [];
  const carriers = carriersRes.data ?? [];
  const carrierName = new Map(carriers.map((c) => [c.code, c.name]));
  const brandName = new Map((brandsRes.data ?? []).map((b) => [b.id, b.name]));

  const rulesInEffect = rules.filter((r) => (versionsByRule.get(r.id) ?? []).some((v) => inEffect(v, today))).length;
  const drafts = versions.filter((v) => v.status === "draft").length;
  const publishedLists = zipLists.filter((l) => l.status === "published").length;

  return (
    <>
      <PageHeader
        title="Surcharges"
        description="Rules come from published carrier sources or from your own customer-facing configuration. Every version records its source and verification status; ParcelClarity never invents an amount."
        actions={manage ? <ButtonLink href="/app/surcharges/new">New rule</ButtonLink> : undefined}
      />

      <div className="space-y-10">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Rules in effect today" value={rulesInEffect} note="Your rules with a published version covering today" />
          <Stat label="Drafts awaiting publication" value={drafts} note="Draft versions are never used in calculations" />
          <Stat label="ZIP lists published" value={publishedLists} note="Yours and ParcelClarity's" />
        </div>

        <section aria-labelledby="rules-heading" className="space-y-3">
          <div>
            <h2 id="rules-heading" className="text-xl font-semibold tracking-tight">
              Your rules
            </h2>
            <p className="text-sm text-muted">Surcharges you charge customers under your agreements. Each rule is versioned; only published versions apply.</p>
          </div>
          {rules.length ? (
            <DataList>
              {rules.map((r) => {
                const ruleVersions = versionsByRule.get(r.id) ?? [];
                const latest = ruleVersions[0];
                const current = ruleVersions.find((v) => inEffect(v, today));
                const brand = r.brand_id ? brandName.get(r.brand_id) : null;
                return (
                  <DataRow key={r.id} className="p-0 sm:p-0">
                    <Link href={`/app/surcharges/${r.id}`} className="flex w-full flex-col gap-2 px-4 py-4 hover:bg-surface sm:flex-row sm:items-center sm:justify-between sm:px-6">
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{r.name}</span>
                          {latest ? <RuleStatusBadge status={latest.status} /> : <Badge tone="warning">No version</Badge>}
                          {current ? <Badge tone="success">In effect today</Badge> : null}
                          {brand ? <Badge tone="accent">Only {brand}</Badge> : null}
                        </span>
                        <span className="mt-0.5 block text-sm text-muted">
                          {carrierName.get(r.carrier_code) ?? r.carrier_code} · <CategoryLabel category={r.category} /> · <span className="tabular">{r.rule_key}</span>
                        </span>
                        {latest ? (
                          <span className="mt-0.5 block text-sm text-muted">
                            <ChargeSummary terms={chargeTerms(latest)} /> · {effectivity(latest.effective_date, latest.expiration_date)}
                          </span>
                        ) : null}
                      </span>
                      {latest ? (
                        <span className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted">
                          <VerificationBadge status={latest.verification_status} />
                          <span className="tabular">Version {latest.version_number}</span>
                        </span>
                      ) : null}
                    </Link>
                  </DataRow>
                );
              })}
            </DataList>
          ) : (
            <EmptyState title="No rules yet" action={manage ? <ButtonLink href="/app/surcharges/new">Create the first rule</ButtonLink> : undefined}>
              A rule describes one surcharge you charge customers: a residential fee, a fuel percentage, a large-package minimum. Each one names the agreement or bulletin its amount comes from.
              {manage ? "" : " Ask a 3PL administrator to create one."}
            </EmptyState>
          )}
        </section>

        <section aria-labelledby="platform-heading" className="space-y-3">
          <div>
            <h2 id="platform-heading" className="text-xl font-semibold tracking-tight">
              Published carrier rules
            </h2>
            <p className="text-sm text-muted">Verified by ParcelClarity from the carriers&apos; published bulletins. Read-only; adjust them per customer with exceptions from the customer&apos;s page.</p>
          </div>
          {platformRules.length ? (
            <DataList>
              {platformRules.map((r) => {
                const published = platformVersionsByRule.get(r.id) ?? [];
                const current = published.find((v) => inEffect(v, today)) ?? published[0];
                return (
                  <DataRow key={r.id} className="p-0 sm:p-0">
                    <Link href={`/app/surcharges/${r.id}`} className="flex w-full flex-col gap-2 px-4 py-4 hover:bg-surface sm:flex-row sm:items-center sm:justify-between sm:px-6">
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{r.name}</span>
                          {current && inEffect(current, today) ? <Badge tone="success">In effect today</Badge> : null}
                        </span>
                        <span className="mt-0.5 block text-sm text-muted">
                          {carrierName.get(r.carrier_code) ?? r.carrier_code} · <CategoryLabel category={r.category} /> · <span className="tabular">{r.rule_key}</span>
                        </span>
                        {current ? (
                          <span className="mt-0.5 block text-sm text-muted">
                            <ChargeSummary terms={chargeTerms(current)} /> · {effectivity(current.effective_date, current.expiration_date)} · {current.source_reference}
                          </span>
                        ) : null}
                      </span>
                      {current ? (
                        <span className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted">
                          <VerificationBadge status={current.verification_status} />
                          <span className="tabular">
                            {published.length} published {published.length === 1 ? "version" : "versions"}
                          </span>
                        </span>
                      ) : null}
                    </Link>
                  </DataRow>
                );
              })}
            </DataList>
          ) : (
            <EmptyState title="No carrier rules have been published yet">
              ParcelClarity publishes a carrier&apos;s surcharge rules only after a reviewed verification of the carrier&apos;s own bulletin. Until then, calculations use the rules you configure above.
            </EmptyState>
          )}
        </section>

        <section aria-labelledby="ziplists-heading" className="space-y-3">
          <div>
            <h2 id="ziplists-heading" className="text-xl font-semibold tracking-tight">
              ZIP code lists
            </h2>
            <p className="text-sm text-muted">Destination ZIP codes that a rule can test, for example delivery area or remote area surcharges. Rules reference a list by its key; each upload is a new version.</p>
          </div>
          {zipLists.length ? (
            <DataList>
              {zipLists.map((l) => (
                <DataRow key={l.id}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span>{l.name}</span>
                      <RuleStatusBadge status={l.status} />
                      {l.tenant_id === null ? <Badge tone="accent">Published by ParcelClarity</Badge> : null}
                    </p>
                    <p className="text-sm text-muted">
                      <span className="tabular">{l.key}</span> · version {l.version} · {l.carrier_code ? (carrierName.get(l.carrier_code) ?? l.carrier_code) : "Any carrier"} · {effectivity(l.effective_date, l.expiration_date)}
                    </p>
                    <p className="text-sm text-muted">
                      Source: {l.source_reference}
                      {l.source_url ? (
                        <>
                          {" "}
                          <a href={l.source_url} target="_blank" rel="noreferrer" className="break-all text-accent-text hover:underline">
                            Open source
                          </a>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted">
                    <VerificationBadge status={l.verification_status} />
                    <span className="tabular">
                      {l.entry_count.toLocaleString("en-US")} {l.entry_count === 1 ? "entry" : "entries"}
                    </span>
                  </div>
                </DataRow>
              ))}
            </DataList>
          ) : (
            <EmptyState title="No ZIP code lists yet">A list holds the ZIP codes or prefixes a surcharge applies to. {manage ? "Upload one below from the carrier bulletin or your agreement." : "Ask a 3PL administrator to upload one."}</EmptyState>
          )}
          {manage ? (
            <Card>
              <CardTitle>Upload a ZIP code list</CardTitle>
              <CardDescription>One ZIP code or 3 to 5 digit prefix per row in the first column. Reference the bulletin the codes come from; the list is recorded as your approved configuration.</CardDescription>
              <div className="mt-5">
                <ZipListUploadForm carriers={carriers} today={today} />
              </div>
            </Card>
          ) : null}
        </section>
      </div>
    </>
  );
}
