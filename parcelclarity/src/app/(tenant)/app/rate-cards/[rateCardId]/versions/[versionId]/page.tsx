import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { activateVersion, archiveVersion, endVersion } from "@/app/actions/rate-cards";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { ZoneChartUploadForm } from "@/components/pricing/zone-chart-upload";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { DateField, ServiceTermsForm, type ServiceCoverage, type ServiceTermsRecord } from "@/components/pricing/service-terms-form";
import { ROWS_PAGE_SIZE, VersionRowsBrowser, ZoneChartSummary, formatDecimal, formatEffectivity, parseRowsFilter, type RateRowRecord, type ZoneRowRecord } from "@/components/pricing/version-rows-table";
import { Alert } from "@/components/ui/alert";
import { Badge, statusTone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { carrierProfile } from "@/engine/carriers";
import type { DimensionRounding, WeightRounding } from "@/engine/types";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { formatDate, formatDateTime } from "@/lib/format/date";
import type { ServiceSummary } from "@/lib/import/rate-card-validate";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Rate card version" };

interface CardRow {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
}

interface VersionRow {
  id: string;
  rate_card_id: string;
  tenant_id: string;
  version_number: number;
  status: string;
  effective_date: string | null;
  expiration_date: string | null;
  currency: string;
  row_count: number;
  validation_summary: { rowCount?: number; warningCount?: number; services?: ServiceSummary[] } | null;
  activated_at: string | null;
  created_at: string;
}

interface TermsRow {
  service_id: string;
  dim_divisor: string | number | null;
  dim_threshold_cubic_in: string | number | null;
  dimension_rounding: DimensionRounding;
  weight_rounding: WeightRounding;
  min_billable_lb: string | number | null;
  dim_exempt: boolean;
  min_charge: string | number | null;
  included_surcharge_keys: string[] | null;
  excluded_surcharge_keys: string[] | null;
  shipping_services: { id: string; carrier_code: string; code: string; name: string } | null;
}

interface RuleRow {
  rule_key: string;
  carrier_code: string;
}

const decimalOrNull = (v: string | number | null) => (v === null ? null : formatDecimal(v));

export default async function VersionPage({ params, searchParams }: { params: Promise<{ rateCardId: string; versionId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireTenantContext("ratecard.view");
  const { rateCardId, versionId } = await params;
  if (!uuidSchema.safeParse(rateCardId).success || !uuidSchema.safeParse(versionId).success) notFound();

  const supabase = await createClient();
  const [cardRes, versionRes] = await Promise.all([
    supabase.from("rate_cards").select("id, tenant_id, name, status").eq("id", rateCardId).maybeSingle(),
    supabase
      .from("rate_card_versions")
      .select("id, rate_card_id, tenant_id, version_number, status, effective_date, expiration_date, currency, row_count, validation_summary, activated_at, created_at")
      .eq("id", versionId)
      .maybeSingle(),
  ]);
  const card = cardRes.data as CardRow | null;
  const version = versionRes.data as VersionRow | null;
  // RLS already hides other tenants' rows; the explicit checks make a mismatched card/version pair a 404 too.
  if (!card || card.tenant_id !== ctx.active.tenantId || !version || version.rate_card_id !== card.id || version.tenant_id !== card.tenant_id) notFound();

  const role = ctx.active.role;
  const manage = can(role, "ratecard.manage");
  const filter = parseRowsFilter(await searchParams);
  const from = (filter.page - 1) * ROWS_PAGE_SIZE;

  let rowsQuery = supabase.from("rate_card_rows").select("id, service_id, origin_prefix, zone, weight_min, weight_max, weight_unit, price, min_charge", { count: "exact" }).eq("version_id", version.id);
  if (filter.service) rowsQuery = rowsQuery.eq("service_id", filter.service);
  if (filter.zone) rowsQuery = rowsQuery.eq("zone", filter.zone);
  if (filter.origin) rowsQuery = rowsQuery.eq("origin_prefix", filter.origin);

  const [termsRes, rowsRes, zonesRes, rulesRes] = await Promise.all([
    supabase
      .from("rate_card_service_terms")
      .select("service_id, dim_divisor, dim_threshold_cubic_in, dimension_rounding, weight_rounding, min_billable_lb, dim_exempt, min_charge, included_surcharge_keys, excluded_surcharge_keys, shipping_services(id, carrier_code, code, name)")
      .eq("version_id", version.id)
      .overrideTypes<TermsRow[], { merge: false }>(),
    rowsQuery
      .order("service_id")
      .order("origin_prefix", { nullsFirst: true })
      .order("zone")
      .order("weight_max")
      .range(from, from + ROWS_PAGE_SIZE - 1)
      .overrideTypes<RateRowRecord[], { merge: false }>(),
    supabase
      .from("rate_card_zones")
      .select("id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone", { count: "exact" })
      .eq("version_id", version.id)
      .order("id")
      .limit(5)
      .overrideTypes<ZoneRowRecord[], { merge: false }>(),
    // Platform and tenant rule keys, offered as hints for the included/waived surcharge fields.
    supabase.from("surcharge_rules").select("rule_key, carrier_code").is("archived_at", null).order("rule_key").overrideTypes<RuleRow[], { merge: false }>(),
  ]);

  const terms: ServiceTermsRecord[] = (termsRes.data ?? [])
    .flatMap((t) => {
      const s = t.shipping_services;
      if (!s) return [];
      const record: ServiceTermsRecord = {
        serviceId: t.service_id,
        serviceName: s.name,
        carrierCode: s.carrier_code,
        carrierName: carrierProfile(s.carrier_code).name,
        dimDivisor: decimalOrNull(t.dim_divisor),
        dimThresholdCubicIn: decimalOrNull(t.dim_threshold_cubic_in),
        dimensionRounding: t.dimension_rounding,
        weightRounding: t.weight_rounding,
        minBillableLb: decimalOrNull(t.min_billable_lb),
        dimExempt: t.dim_exempt,
        minCharge: decimalOrNull(t.min_charge),
        includedSurchargeKeys: t.included_surcharge_keys ?? [],
        excludedSurchargeKeys: t.excluded_surcharge_keys ?? [],
      };
      return [record];
    })
    .sort((a, b) => a.carrierName.localeCompare(b.carrierName) || a.serviceName.localeCompare(b.serviceName));

  const keysByCarrier = new Map<string, string[]>();
  for (const r of rulesRes.data ?? []) keysByCarrier.set(r.carrier_code, [...(keysByCarrier.get(r.carrier_code) ?? []), r.rule_key]);

  const importedServices = version.validation_summary?.services ?? [];
  const coverageByService = new Map<string, ServiceCoverage>(importedServices.map((s) => [s.serviceId, { rowCount: s.rowCount, zones: s.zones, originPrefixes: s.originPrefixes, maxWeight: s.maxWeight }]));
  const missingTerms = importedServices.filter((s) => !terms.some((t) => t.serviceId === s.serviceId));
  const withoutDivisor = terms.filter((t) => t.dimDivisor === null && !t.dimExempt);
  const carriers = [...new Set(terms.map((t) => t.carrierName))];

  const draft = version.status === "draft";
  const active = version.status === "active";
  const basePath = `/app/rate-cards/${card.id}/versions/${version.id}`;
  const zoneCount = zonesRes.count ?? 0;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href={`/app/rate-cards/${card.id}`} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← {card.name}
        </Link>
      </p>
      <PageHeader
        title={`Version ${version.version_number}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(version.status)}>{version.status}</Badge>
            <span>
              {card.name} · {formatEffectivity(version.effective_date, version.expiration_date)}
            </span>
          </span>
        }
        actions={
          <>
            {can(role, "simulation.run") && (draft || active) ? (
              <ButtonLink href={`/app/calculator?rateCardId=${card.id}&versionId=${version.id}`} variant="secondary">
                Test in calculator
              </ButtonLink>
            ) : null}
            {manage && draft ? (
              <ConfirmAction action={archiveVersion.bind(null, version.id)} label="Discard draft" confirmLabel="Discard" variant="danger">
                Permanent. A discarded draft can no longer be edited or activated.
              </ConfirmAction>
            ) : null}
            {manage && active ? (
              <ConfirmAction action={archiveVersion.bind(null, version.id)} label="Archive version" confirmLabel="Archive" variant="danger">
                Customers lose these prices immediately. Archived versions cannot be reactivated.
              </ConfirmAction>
            ) : null}
          </>
        }
      />

      {draft ? (
        <Alert className="mb-6">
          This is a draft: customers cannot see it and the calculator only uses it when you test it explicitly. Review the service terms and rows, then activate it for a date range.
        </Alert>
      ) : null}
      {version.status === "discarded" ? <Alert tone="warning" className="mb-6">This draft was discarded. Its rows and terms are kept for reference only.</Alert> : null}
      {version.status === "archived" ? (
        <Alert className="mb-6">
          This version is archived. It was in effect {formatEffectivity(version.effective_date, version.expiration_date).toLowerCase()} and is kept so past quotes stay traceable.
        </Alert>
      ) : null}
      {card.status === "archived" ? <Alert tone="warning" className="mb-6">The rate card itself is archived.</Alert> : null}

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Rate rows" value={version.row_count.toLocaleString("en-US")} note="Base prices by service, zone and weight bracket" />
        <Stat label="Services" value={terms.length} note={carriers.length ? carriers.join(", ") : "No service terms"} />
        <Stat label="Zone chart entries" value={zoneCount.toLocaleString("en-US")} note={zoneCount ? "ZIP-to-zone lookup available" : "Quotes must state the destination zone"} />
      </div>

      <dl className="mb-8 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted">Created</dt>
          <dd className="font-medium">{formatDateTime(version.created_at)}</dd>
        </div>
        <div>
          <dt className="text-muted">Activated</dt>
          <dd className="font-medium">{version.activated_at ? formatDateTime(version.activated_at) : "Not yet"}</dd>
        </div>
        <div>
          <dt className="text-muted">Currency</dt>
          <dd className="font-medium">{version.currency}</dd>
        </div>
        
      </dl>

      {manage && draft ? (
        <Card className="mb-10">
          <CardTitle>Activate this version</CardTitle>
          <CardDescription>
            Activation locks the rows and terms and puts these prices into effect for assigned customers between the dates below. Two active versions of a card can never cover the same
            day, so expire or archive the current one first if the dates overlap.
          </CardDescription>
          {missingTerms.length ? (
            <Alert tone="danger" className="mt-4">
              Service terms are missing for {missingTerms.map((s) => s.serviceName).join(", ")}. Activation is refused until every service on the card has terms; re-import the file to recreate them.
            </Alert>
          ) : null}
          {withoutDivisor.length ? (
            <Alert tone="warning" className="mt-4">
              No DIM divisor for {withoutDivisor.map((t) => t.serviceName).join(", ")}. You can still activate, but results for these services will be estimates based on actual weight.
            </Alert>
          ) : null}
          <ActionForm action={activateVersion} className="mt-5 space-y-4">
            <input type="hidden" name="versionId" value={version.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <DateField name="effectiveDate" label="Effective date" defaultValue={today} required hint="First ship date priced with this version (UTC calendar date)." />
              <DateField name="expirationDate" label="Expiration date" hint="Optional. Leave empty if the prices have no agreed end date." />
            </div>
            <SubmitButton pendingLabel="Activating…">Activate version</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {manage && version.status === "active" ? (
        <Card className="mb-10">
          <CardTitle>End this version</CardTitle>
          <CardDescription>
            Set the last ship date these prices apply to. The version stays available for calculations dated up to that day, and a new version can be activated from the next day.
          </CardDescription>
          <ActionForm action={endVersion} className="mt-5 space-y-4">
            <input type="hidden" name="versionId" value={version.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <DateField name="expirationDate" label="Last effective date" defaultValue={version.expiration_date ?? today} required hint="UTC calendar date." />
            </div>
            <SubmitButton variant="secondary" pendingLabel="Saving…">End version on this date</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      <section aria-labelledby="terms-heading" className="mb-10 space-y-4">
        <div>
          <h2 id="terms-heading" className="text-xl font-semibold tracking-tight">
            Service terms
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            How billable weight is worked out and which surcharges the base price already covers, per service.{" "}
            {draft ? (manage ? "Editable until the version is activated." : "Only administrators can edit a draft.") : "Locked because the version is no longer a draft."}
          </p>
        </div>
        {terms.length ? (
          terms.map((t) => (
            <ServiceTermsForm
              key={t.serviceId}
              versionId={version.id}
              terms={t}
              coverage={coverageByService.get(t.serviceId) ?? null}
              editable={manage && draft}
              carrierNotes={carrierProfile(t.carrierCode).notes}
              knownRuleKeys={keysByCarrier.get(t.carrierCode) ?? []}
            />
          ))
        ) : (
          <EmptyState title="No service terms">This version has no per-service terms, so it cannot be activated. Re-import the file to recreate them.</EmptyState>
        )}
      </section>

      <section id="rows" aria-labelledby="rows-heading" className="mb-10 scroll-mt-24 space-y-4">
        <h2 id="rows-heading" className="text-xl font-semibold tracking-tight">
          Rate rows
        </h2>
        <VersionRowsBrowser basePath={basePath} services={terms.map((t) => ({ id: t.serviceId, label: t.serviceName }))} filter={filter} rows={rowsRes.data ?? []} total={rowsRes.count ?? 0} />
      </section>

      <section aria-labelledby="zones-heading" className="space-y-4">
        <h2 id="zones-heading" className="text-xl font-semibold tracking-tight">
          Zone chart
        </h2>
        <ZoneChartSummary count={zoneCount} sample={zonesRes.data ?? []} />
        {manage && draft ? <ZoneChartUploadForm versionId={version.id} hasChart={zoneCount > 0} /> : null}
      </section>

      {!draft && version.effective_date ? <p className="mt-8 text-xs text-muted">Effective {formatDate(version.effective_date)}; dates are UTC calendar dates.</p> : null}
    </>
  );
}
