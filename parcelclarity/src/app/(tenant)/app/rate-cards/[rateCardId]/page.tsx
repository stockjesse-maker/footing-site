import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { archiveRateCard, renameRateCard, unassignRateCard } from "@/app/actions/rate-cards";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { ImportStatusBadge } from "@/components/pricing/import-wizard";
import { formatEffectivity } from "@/components/pricing/version-rows-table";
import { Alert } from "@/components/ui/alert";
import { Badge, statusTone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { formatDate, formatDateTime } from "@/lib/format/date";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Rate card" };

interface CardRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
}

interface VersionRow {
  id: string;
  version_number: number;
  status: string;
  effective_date: string | null;
  expiration_date: string | null;
  row_count: number;
  created_at: string;
}

interface ImportRow {
  id: string;
  status: string;
  created_at: string;
  detected: { filename?: string } | null;
}

interface AssignmentRow {
  id: string;
  brand_id: string;
  allowed_service_ids: string[] | null;
  assigned_at: string;
  brands: { name: string; status: string } | null;
}

const IMPORT_STATUS: Record<string, string> = {
  uploaded: "Uploaded, mapping not yet approved",
  mapped: "Mapping saved, validation found problems",
  validated: "Validated, ready to become a draft version",
};

export default async function RateCardDetail({ params }: { params: Promise<{ rateCardId: string }> }) {
  const ctx = await requireTenantContext("ratecard.view");
  const { rateCardId } = await params;
  if (!uuidSchema.safeParse(rateCardId).success) notFound();

  const supabase = await createClient();
  // Row Level Security hides cards of other tenants, so a guessed ID is a 404.
  const { data: cardData } = await supabase.from("rate_cards").select("id, tenant_id, name, description, status, created_at").eq("id", rateCardId).maybeSingle();
  const card = cardData as CardRow | null;
  if (!card || card.tenant_id !== ctx.active.tenantId) notFound();

  const role = ctx.active.role;
  const manage = can(role, "ratecard.manage");
  const [versionsRes, importsRes, assignmentsRes] = await Promise.all([
    supabase
      .from("rate_card_versions")
      .select("id, version_number, status, effective_date, expiration_date, row_count, created_at")
      .eq("rate_card_id", card.id)
      .order("version_number", { ascending: false })
      .overrideTypes<VersionRow[], { merge: false }>(),
    // Imports are readable only with ratecard.manage; skip the query for everyone else.
    manage
      ? supabase
          .from("rate_card_imports")
          .select("id, status, created_at, detected")
          .eq("rate_card_id", card.id)
          .in("status", ["uploaded", "mapped", "validated"])
          .order("created_at", { ascending: false })
          .overrideTypes<ImportRow[], { merge: false }>()
      : Promise.resolve({ data: null as ImportRow[] | null }),
    supabase
      .from("brand_rate_card_assignments")
      .select("id, brand_id, allowed_service_ids, assigned_at, brands!brca_brand_in_tenant(name, status)")
      .eq("rate_card_id", card.id)
      .is("unassigned_at", null)
      .order("assigned_at", { ascending: true })
      .overrideTypes<AssignmentRow[], { merge: false }>(),
  ]);
  const versions = versionsRes.data ?? [];
  const imports = importsRes.data ?? [];
  const assignments = assignmentsRes.data ?? [];

  // Names for "only some services" assignments; one small lookup covers every assignment.
  const serviceNames = new Map<string, string>();
  const restrictedIds = [...new Set(assignments.flatMap((a) => a.allowed_service_ids ?? []))];
  if (restrictedIds.length) {
    const { data: services } = await supabase.from("shipping_services").select("id, name").in("id", restrictedIds);
    for (const s of services ?? []) serviceNames.set(s.id, s.name);
  }

  const today = new Date().toISOString().slice(0, 10);
  const hasActive = versions.some((v) => v.status === "active");
  const inEffect = versions.find((v) => v.status === "active" && (v.effective_date ?? "") <= today && (!v.expiration_date || v.expiration_date >= today));
  const archived = card.status === "archived";

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/app/rate-cards" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← Rate cards
        </Link>
      </p>
      <PageHeader
        title={card.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(card.status)}>{card.status}</Badge>
            <span>{card.description || `Created ${formatDate(card.created_at)}`}</span>
          </span>
        }
        actions={
          <>
            {can(role, "simulation.run") && hasActive && !archived ? (
              <ButtonLink href={`/app/calculator?rateCardId=${card.id}`} variant="secondary">
                Test in calculator
              </ButtonLink>
            ) : null}
            {manage && !archived ? <ButtonLink href={`/app/rate-cards/${card.id}/import`}>Import a new version</ButtonLink> : null}
          </>
        }
      />

      {archived ? (
        <Alert tone="warning" className="mb-6">
          This rate card is archived. It cannot receive new versions or assignments; customers still assigned keep seeing its active versions until you remove them below.
        </Alert>
      ) : null}
      {!archived && versions.length > 0 && !inEffect ? (
        <Alert className="mb-6">No version of this card is in effect today. Customers assigned to it cannot be priced until an active version covers the ship date.</Alert>
      ) : null}

      <div className="space-y-10">
        <section aria-labelledby="versions-heading" className="space-y-3">
          <h2 id="versions-heading" className="text-xl font-semibold tracking-tight">
            Versions
          </h2>
          {versions.length ? (
            <DataList>
              {versions.map((v) => (
                <DataRow key={v.id} className="p-0 sm:p-0">
                  <Link href={`/app/rate-cards/${card.id}/versions/${v.id}`} className="flex w-full flex-col gap-2 px-4 py-4 hover:bg-surface sm:flex-row sm:items-center sm:justify-between sm:px-6">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">Version {v.version_number}</span>
                        <Badge tone={statusTone(v.status)}>{v.status}</Badge>
                        {inEffect?.id === v.id ? <Badge tone="success">In effect today</Badge> : null}
                      </span>
                      <span className="mt-0.5 block text-sm text-muted">{formatEffectivity(v.effective_date, v.expiration_date)}</span>
                    </span>
                    <span className="tabular shrink-0 text-sm text-muted">
                      {v.row_count.toLocaleString("en-US")} {v.row_count === 1 ? "row" : "rows"} · created {formatDate(v.created_at)}
                    </span>
                  </Link>
                </DataRow>
              ))}
            </DataList>
          ) : (
            <EmptyState title="No versions yet" action={manage && !archived ? <ButtonLink href={`/app/rate-cards/${card.id}/import`}>Import a spreadsheet</ButtonLink> : undefined}>
              A version is one imported price table: every service, zone and weight bracket with its base rate. Drafts can be reviewed and tested before you activate them for a date range.
            </EmptyState>
          )}
        </section>

        {imports.length ? (
          <section aria-labelledby="imports-heading" className="space-y-3">
            <h2 id="imports-heading" className="text-xl font-semibold tracking-tight">
              Imports in progress
            </h2>
            <DataList>
              {imports.map((imp) => (
                <DataRow key={imp.id} className="p-0 sm:p-0">
                  <Link href={`/app/rate-cards/${card.id}/import/${imp.id}`} className="flex w-full flex-col gap-2 px-4 py-4 hover:bg-surface sm:flex-row sm:items-center sm:justify-between sm:px-6">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{imp.detected?.filename ?? "Uploaded file"}</span>
                      <span className="mt-0.5 block text-sm text-muted">{IMPORT_STATUS[imp.status] ?? imp.status}</span>
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted">
                      <ImportStatusBadge status={imp.status} />
                      <span className="tabular">{formatDateTime(imp.created_at)}</span>
                    </span>
                  </Link>
                </DataRow>
              ))}
            </DataList>
          </section>
        ) : null}

        <section aria-labelledby="customers-heading" className="space-y-3">
          <h2 id="customers-heading" className="text-xl font-semibold tracking-tight">
            Assigned customers
          </h2>
          {assignments.length ? (
            <DataList>
              {assignments.map((a) => {
                const allowed = a.allowed_service_ids ?? [];
                return (
                  <DataRow key={a.id}>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <Link href={`/app/customers/${a.brand_id}`} className="inline-flex min-h-11 items-center text-accent-text hover:underline">
                          {a.brands?.name ?? "Customer"}
                        </Link>
                        {a.brands && a.brands.status !== "active" ? <Badge tone={statusTone(a.brands.status)}>{a.brands.status}</Badge> : null}
                      </p>
                      <p className="text-sm text-muted">
                        {allowed.length ? `Only ${allowed.map((id) => serviceNames.get(id) ?? "unknown service").join(", ")}` : "All services on the card"} · assigned {formatDate(a.assigned_at)}
                      </p>
                    </div>
                    {manage ? (
                      <ConfirmAction action={unassignRateCard.bind(null, a.id)} label="Unassign" confirmLabel="Remove assignment" variant="danger">
                        They lose these prices immediately.
                      </ConfirmAction>
                    ) : null}
                  </DataRow>
                );
              })}
            </DataList>
          ) : (
            <EmptyState title="No customers assigned">Assign this rate card from a customer&apos;s page. Customers can only see the prices on cards assigned to them.</EmptyState>
          )}
        </section>

        {manage ? (
          <Card>
            <CardTitle>Settings</CardTitle>
            <CardDescription>Renaming does not change versions, prices or assignments.</CardDescription>
            <ActionForm action={renameRateCard} className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <input type="hidden" name="id" value={card.id} />
              <TextField name="name" label="Name" defaultValue={card.name} autoComplete="off" required />
              <SubmitButton variant="secondary" pendingLabel="Saving…">
                Rename
              </SubmitButton>
            </ActionForm>
            {!archived ? (
              <div className="mt-6 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">Archive this rate card</p>
                  <p className="text-sm text-muted">Archiving hides the card from new assignments and imports. Unassign customers first so nobody keeps pricing on it.</p>
                </div>
                <ConfirmAction action={archiveRateCard.bind(null, card.id)} label="Archive rate card" confirmLabel="Archive" variant="danger">
                  This cannot be undone.
                </ConfirmAction>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
