import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { archiveFeeVersion } from "@/app/actions/fee-schedules";
import { NotSupportedPanel } from "@/components/fees/not-supported";
import { FeeScheduleView } from "@/components/fees/schedule-view";
import { RulesWorkspace } from "@/components/fees/rules-workspace";
import { TryOrderPanel } from "@/components/fees/try-order-panel";
import { ActivateVersionButton, EndVersionButton, RoundingSelect, VersionNotesForm } from "@/components/fees/version-controls";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { formatEffectivity } from "@/components/pricing/version-rows-table";
import { Alert } from "@/components/ui/alert";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { formatDate, formatDateTime } from "@/lib/format/date";
import { loadFeeVersion, packagingTypes } from "@/lib/fees/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Fee schedule version" };

export default async function FeeVersionPage({ params }: { params: Promise<{ scheduleId: string; versionId: string }> }) {
  const ctx = await requireTenantContext("ratecard.view");
  const { scheduleId, versionId } = await params;
  if (!uuidSchema.safeParse(scheduleId).success || !uuidSchema.safeParse(versionId).success) notFound();
  const manage = can(ctx.active.role, "ratecard.manage");

  const supabase = await createClient();
  const version = await loadFeeVersion(supabase, versionId, { staff: true });
  // Row Level Security already hides other tenants' versions; the explicit checks make a mismatched pair a 404 too.
  if (!version || version.scheduleId !== scheduleId || version.tenantId !== ctx.active.tenantId) notFound();

  const draft = version.status === "draft";
  const active = version.status === "active";
  const scheduleArchived = version.scheduleStatus === "archived";
  const editable = manage && draft && !scheduleArchived;
  const sources = version.sources ?? {};

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href={`/app/fee-schedules/${version.scheduleId}`} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← {version.scheduleName}
        </Link>
      </p>
      <PageHeader
        title={`Version ${version.versionNumber}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(version.status)}>{version.status}</Badge>
            <span>
              {version.scheduleName} · {formatEffectivity(version.effectiveDate, version.expirationDate)}
            </span>
          </span>
        }
        actions={
          manage && !scheduleArchived ? (
            <>
              {draft ? <ActivateVersionButton versionId={version.id} versionNumber={version.versionNumber} /> : null}
              {draft ? (
                <ConfirmAction action={archiveFeeVersion.bind(null, version.id)} label="Discard draft" confirmLabel="Discard" variant="danger">
                  Permanent. A discarded draft can no longer be edited or activated.
                </ConfirmAction>
              ) : null}
              {active ? <EndVersionButton versionId={version.id} versionNumber={version.versionNumber} expirationDate={version.expirationDate} /> : null}
              {active ? (
                <ConfirmAction action={archiveFeeVersion.bind(null, version.id)} label="Archive version" confirmLabel="Archive" variant="danger">
                  Its dates still apply unless another active version covers them; end the version to stop that. An archived version cannot be reactivated.
                </ConfirmAction>
              ) : null}
            </>
          ) : undefined
        }
      />

      {draft ? (
        <Alert className="mb-6">
          This is a draft: customers cannot see it. Add the rules, check them with a sample order below, then activate it for a date range. Activation locks the rules.
          {manage ? "" : " Only administrators can edit a draft."}
        </Alert>
      ) : null}
      {version.status === "discarded" ? <Alert tone="warning" className="mb-6">This draft was discarded. Its rules are kept for reference only.</Alert> : null}
      {version.status === "archived" ? (
        <Alert className="mb-6">
          This version is archived and can no longer change. Its dates stay as they were ({formatEffectivity(version.effectiveDate, version.expirationDate)}): orders and models dated inside them are still priced on it unless an
          active version covers them, so past models stay explainable.
        </Alert>
      ) : null}
      {scheduleArchived ? <Alert tone="warning" className="mb-6">The fee schedule itself is archived.</Alert> : null}

      <dl className="mb-8 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted">Created</dt>
          <dd className="font-medium">{formatDateTime(version.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-muted">Activated</dt>
          <dd className="font-medium">{version.activatedAt ? formatDateTime(version.activatedAt) : "Not yet"}</dd>
        </div>
        <div>
          <dt className="text-muted">Rules</dt>
          <dd className="tabular font-medium">{version.rules.length.toLocaleString("en-US")}</dd>
        </div>
      </dl>

      <div className="space-y-10">
        <RulesWorkspace versionId={version.id} editable={editable} rules={version.rules} sources={sources} />

        <section aria-labelledby="rounding-heading" className="space-y-3">
          <h2 id="rounding-heading" className="text-xl font-semibold tracking-tight">
            Rounding
          </h2>
          <div className="sm:max-w-xl">
            <RoundingSelect versionId={version.id} value={version.rounding} editable={editable} />
          </div>
        </section>

        <section aria-labelledby="try-heading" className="space-y-3">
          <div>
            <h2 id="try-heading" className="text-xl font-semibold tracking-tight">
              Try an order
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">Check this version against an order before you activate it. Nothing is saved, and nothing here reaches a customer.</p>
          </div>
          <Card>
            <TryOrderPanel versionId={version.id} rules={version.rules} packagingTypes={packagingTypes(version.snapshot)} />
          </Card>
        </section>

        <section aria-labelledby="preview-heading" className="space-y-3">
          <div>
            <h2 id="preview-heading" className="text-xl font-semibold tracking-tight">
              What your customer will read
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              This is how a customer on this schedule sees this version, generated from the rules above. They never see rule keys, staff notes or sources.
              {version.effectiveDate ? ` In effect from ${formatDate(version.effectiveDate)}.` : ""}
            </p>
          </div>
          <Card>
            <FeeScheduleView snapshot={version.snapshot} audience="staff" idPrefix="preview" />
          </Card>
        </section>

        <section aria-labelledby="notes-heading" className="space-y-3">
          <div>
            <h2 id="notes-heading" className="text-xl font-semibold tracking-tight">
              Staff notes
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">Only your team can read these, never customers. {editable ? "Editable until the version is activated." : "Locked because the version is no longer a draft."}</p>
          </div>
          <Card>
            <VersionNotesForm versionId={version.id} notes={version.notes ?? null} editable={editable} />
          </Card>
        </section>

        <NotSupportedPanel />
      </div>
    </>
  );
}
