import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { uploadRateCardFile } from "@/app/actions/rate-cards";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { ImportStatusBadge, ImportSteps, RateCardFileField } from "@/components/pricing/import-wizard";
import { Alert } from "@/components/ui/alert";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { PageHeader } from "@/components/ui/page-header";
import { requireTenantContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { formatDateTime } from "@/lib/format/date";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Import rates" };

interface PendingImport {
  id: string;
  status: string;
  detected: { filename?: string } | null;
  created_at: string;
}

export default async function ImportUploadPage({ params }: { params: Promise<{ rateCardId: string }> }) {
  // Uploading is a write step, so the page itself needs ratecard.manage (the action re-checks it).
  const ctx = await requireTenantContext("ratecard.manage");
  const { rateCardId } = await params;
  if (!uuidSchema.safeParse(rateCardId).success) notFound();

  const supabase = await createClient();
  const [{ data: card }, { data: pending }] = await Promise.all([
    supabase.from("rate_cards").select("id, name, status, tenant_id").eq("id", rateCardId).maybeSingle(),
    supabase.from("rate_card_imports").select("id, status, detected, created_at").eq("rate_card_id", rateCardId).in("status", ["uploaded", "mapped", "validated"]).order("created_at", { ascending: false }).limit(5),
  ]);
  // Row Level Security hides other tenants' cards; the explicit check makes a guessed ID a 404 regardless.
  if (!card || card.tenant_id !== ctx.active.tenantId) notFound();
  const inProgress = (pending ?? []) as PendingImport[];
  const backHref = `/app/rate-cards/${card.id}`;

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href={backHref} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← {card.name}
        </Link>
      </p>
      <PageHeader title="Import rates" description={`Upload the customer-facing rates for ${card.name} as a CSV or Excel file. The result is a draft version you review before activating.`} />
      <ImportSteps current={1} />

      {card.status === "archived" ? (
        <Alert tone="warning">This rate card is archived, so new versions cannot be imported into it. Create a new rate card instead.</Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <div className="space-y-6">
            <Card>
              <CardTitle>Upload a file</CardTitle>
              <CardDescription>We read the headers and propose a column mapping. You approve it before anything is imported.</CardDescription>
              <ActionForm action={uploadRateCardFile} className="mt-5 space-y-4">
                <input type="hidden" name="rateCardId" value={card.id} />
                <RateCardFileField />
                <SubmitButton pendingLabel="Reading file…">Upload and detect columns</SubmitButton>
              </ActionForm>
            </Card>

            {inProgress.length ? (
              <section aria-labelledby="pending-imports-heading" className="space-y-3">
                <h2 id="pending-imports-heading" className="text-sm font-semibold text-muted">
                  Imports in progress
                </h2>
                <DataList>
                  {inProgress.map((imp) => (
                    <DataRow key={imp.id}>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{imp.detected?.filename ?? "Uploaded file"}</p>
                        <p className="text-sm text-muted">Uploaded {formatDateTime(imp.created_at)}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <ImportStatusBadge status={imp.status} />
                        <ButtonLink href={`${backHref}/import/${imp.id}`} variant="secondary">
                          Resume
                        </ButtonLink>
                      </div>
                    </DataRow>
                  ))}
                </DataList>
              </section>
            ) : null}
          </div>

          <aside className="space-y-6">
            <Card>
              <CardTitle>Supported layouts</CardTitle>
              <dl className="mt-4 space-y-5 text-sm">
                <div>
                  <dt className="font-semibold">Long</dt>
                  <dd className="mt-1 text-muted">
                    One row per service, zone and weight bracket. Columns: carrier, service, origin ZIP, zone, weight from, weight to, weight unit, price, minimum charge and DIM divisor. Only service, zone, weight to and price are required.
                  </dd>
                  <dd className="mt-3">
                    <a href="/api/templates/rate-card.csv" download className={buttonClasses("secondary")}>
                      Download the CSV template
                    </a>
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold">Grid</dt>
                  <dd className="mt-1 text-muted">Weights down the first column and zones across the top, one service per sheet. Name each sheet after its service so it can be matched.</dd>
                </div>
              </dl>
            </Card>
            <Card>
              <CardTitle>What to expect</CardTitle>
              <ul className="mt-4 list-disc space-y-2.5 pl-5 text-sm text-muted">
                <li>.csv or .xlsx files up to 5 MB, with up to 50,000 rows per sheet.</li>
                <li>An administrator approves the column and service mapping. The whole file is validated before a draft version is created.</li>
                <li>No AI reads the file. Headers are matched by simple name rules and every cell is treated as data, never as an instruction.</li>
                <li>The import creates a draft version. Customers see nothing until you activate it.</li>
              </ul>
            </Card>
          </aside>
        </div>
      )}
    </>
  );
}
