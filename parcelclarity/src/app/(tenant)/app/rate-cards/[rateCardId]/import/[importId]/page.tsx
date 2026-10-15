import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ImportStatusBadge, ImportWizard, type ImportRow } from "@/components/pricing/import-wizard";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireTenantContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { formatDateTime } from "@/lib/format/date";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Review import" };

/** The `detected` jsonb was written by uploadRateCardFile; a light shape check keeps a corrupt row from crashing the page. */
function readDetected(value: unknown): ImportRow["detected"] | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Partial<ImportRow["detected"]>;
  if (!Array.isArray(d.sheets) || !Array.isArray(d.serviceStrings) || typeof d.filename !== "string" || typeof d.kind !== "string") return null;
  return d as ImportRow["detected"];
}

export default async function ImportReviewPage({ params }: { params: Promise<{ rateCardId: string; importId: string }> }) {
  const ctx = await requireTenantContext("ratecard.manage");
  const { rateCardId, importId } = await params;
  if (!uuidSchema.safeParse(rateCardId).success || !uuidSchema.safeParse(importId).success) notFound();

  const supabase = await createClient();
  const [{ data: imp }, { data: card }, catalog] = await Promise.all([
    supabase.from("rate_card_imports").select("id, tenant_id, rate_card_id, status, detected, mapping, validation, version_id, created_at").eq("id", importId).maybeSingle(),
    supabase.from("rate_cards").select("id, name, tenant_id").eq("id", rateCardId).maybeSingle(),
    loadServiceCatalog(supabase),
  ]);
  // Row Level Security hides other tenants' rows; the explicit checks make a guessed or mismatched ID a 404 regardless.
  if (!imp || imp.tenant_id !== ctx.active.tenantId || imp.rate_card_id !== rateCardId) notFound();
  if (!card || card.tenant_id !== ctx.active.tenantId) notFound();

  const detected = readDetected(imp.detected);
  const backHref = `/app/rate-cards/${card.id}`;
  const uploadHref = `${backHref}/import`;

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href={backHref} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← {card.name}
        </Link>
      </p>
      <PageHeader
        title="Review import"
        description={
          <>
            {detected?.filename ?? "Uploaded file"} · uploaded {formatDateTime(imp.created_at)} <ImportStatusBadge status={imp.status} />
          </>
        }
      />

      {imp.status === "imported" ? (
        <Alert tone="success" title="This import is complete">
          <p>The file became a draft version of {card.name}. Review its service terms, then activate it when you are ready.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {imp.version_id ? <ButtonLink href={`${backHref}/versions/${imp.version_id}`}>Open the draft version</ButtonLink> : null}
            <ButtonLink href={backHref} variant="secondary">
              Back to the rate card
            </ButtonLink>
          </div>
        </Alert>
      ) : imp.status === "discarded" ? (
        <Alert tone="warning" title="This import was discarded">
          <p>Nothing was added to {card.name}.</p>
          <div className="mt-3">
            <ButtonLink href={uploadHref} variant="secondary">
              Upload another file
            </ButtonLink>
          </div>
        </Alert>
      ) : !detected ? (
        <Alert tone="danger" title="This import cannot be reviewed">
          <p>The detection data for this upload could not be read. Upload the file again to start over.</p>
          <div className="mt-3">
            <ButtonLink href={uploadHref} variant="secondary">
              Upload again
            </ButtonLink>
          </div>
        </Alert>
      ) : (
        <ImportWizard
          importRow={{
            id: imp.id,
            status: imp.status,
            rate_card_id: imp.rate_card_id,
            version_id: imp.version_id ?? null,
            detected,
            mapping: (imp.mapping ?? null) as ImportRow["mapping"],
            validation: (imp.validation ?? null) as ImportRow["validation"],
          }}
          catalog={catalog}
          rateCardId={card.id}
        />
      )}
    </>
  );
}
