import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { archiveFeeSchedule, archiveFeeVersion, renameFeeSchedule, unassignFeeSchedule } from "@/app/actions/fee-schedules";
import { NotSupportedPanel } from "@/components/fees/not-supported";
import { countsRules, versionInEffect } from "@/components/fees/shared";
import { ActivateVersionButton, EndVersionButton, NewDraftControl } from "@/components/fees/version-controls";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { ConfirmAction } from "@/components/forms/confirm-action";
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
import { formatDate } from "@/lib/format/date";
import { loadFeeSchedule } from "@/lib/fees/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Fee schedule" };

const roundingText = (rounding: string) => (rounding === "transaction" ? "rounded per order" : "rounded per invoice line");

export default async function FeeScheduleDetail({ params }: { params: Promise<{ scheduleId: string }> }) {
  const ctx = await requireTenantContext("ratecard.view");
  const { scheduleId } = await params;
  if (!uuidSchema.safeParse(scheduleId).success) notFound();
  const manage = can(ctx.active.role, "ratecard.manage");

  const supabase = await createClient();
  // Row Level Security hides other tenants' schedules, so a guessed id is a 404.
  const schedule = await loadFeeSchedule(supabase, scheduleId);
  if (!schedule || schedule.tenantId !== ctx.active.tenantId) notFound();

  const today = new Date().toISOString().slice(0, 10);
  const archived = schedule.status === "archived";
  const draft = schedule.versions.find((v) => v.status === "draft") ?? null;
  const inEffect = versionInEffect(schedule.versions, today);
  const hasActive = schedule.versions.some((v) => v.status === "active");
  const copyable = schedule.versions.map((v) => ({ id: v.id, versionNumber: v.versionNumber, status: v.status }));

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/app/fee-schedules" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← Fee schedules
        </Link>
      </p>
      <PageHeader
        title={schedule.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(schedule.status)}>{schedule.status}</Badge>
            <span>{schedule.description || `Created ${formatDate(schedule.createdAt)}`}</span>
          </span>
        }
      />

      {archived ? (
        <Alert tone="warning" className="mb-6">
          This fee schedule is archived. It cannot receive new versions or customers; its versions stay readable for history.
        </Alert>
      ) : null}
      {!archived && !inEffect ? (
        <Alert className="mb-6">
          {hasActive
            ? "No active version is in effect today. Customers on this schedule cannot be priced for fulfillment fees until one covers the date."
            : draft
              ? "Nothing is active yet. Add the rules to the draft, try an order, then activate it."
              : "This schedule has no active version."}
        </Alert>
      ) : null}

      <div className="space-y-10">
        <section aria-labelledby="versions-heading" className="space-y-3">
          <h2 id="versions-heading" className="text-xl font-semibold tracking-tight">
            Versions
          </h2>
          {schedule.versions.length ? (
            <DataList>
              {schedule.versions.map((v) => (
                <DataRow key={v.id}>
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2">
                      <Link href={`/app/fee-schedules/${schedule.id}/versions/${v.id}`} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
                        Version {v.versionNumber}
                      </Link>
                      <Badge tone={statusTone(v.status)}>{v.status}</Badge>
                      {inEffect?.id === v.id ? <Badge tone="success">In effect today</Badge> : null}
                    </p>
                    <p className="text-sm text-muted">{formatEffectivity(v.effectiveDate, v.expirationDate)}</p>
                    <p className="tabular text-sm text-muted">
                      {countsRules(v) ? `${v.ruleCount.toLocaleString("en-US")} ${v.ruleCount === 1 ? "rule" : "rules"} · ` : ""}
                      {roundingText(v.rounding)} · created {formatDate(v.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {v.status === "draft" ? (
                      <>
                        <ButtonLink href={`/app/fee-schedules/${schedule.id}/versions/${v.id}`} variant="secondary" size="sm" className="min-h-11 sm:min-h-9">
                          {manage ? "Edit draft" : "View draft"}
                        </ButtonLink>
                        {manage && !archived ? <ActivateVersionButton versionId={v.id} versionNumber={v.versionNumber} /> : null}
                        {manage ? (
                          <ConfirmAction action={archiveFeeVersion.bind(null, v.id)} label="Discard draft" confirmLabel="Discard" variant="danger">
                            Permanent. A discarded draft can no longer be edited or activated.
                          </ConfirmAction>
                        ) : null}
                      </>
                    ) : null}
                    {v.status === "active" ? (
                      <>
                        <ButtonLink href={`/app/fee-schedules/${schedule.id}/versions/${v.id}`} variant="secondary" size="sm" className="min-h-11 sm:min-h-9">
                          View
                        </ButtonLink>
                        {manage ? <EndVersionButton versionId={v.id} versionNumber={v.versionNumber} expirationDate={v.expirationDate} /> : null}
                        {manage ? (
                          <ConfirmAction action={archiveFeeVersion.bind(null, v.id)} label="Archive" confirmLabel="Archive version" variant="danger">
                            Its dates still apply unless another active version covers them; end the version to stop that. An archived version cannot be reactivated.
                          </ConfirmAction>
                        ) : null}
                      </>
                    ) : null}
                    {v.status === "archived" || v.status === "discarded" ? (
                      <ButtonLink href={`/app/fee-schedules/${schedule.id}/versions/${v.id}`} variant="secondary" size="sm" className="min-h-11 sm:min-h-9">
                        View
                      </ButtonLink>
                    ) : null}
                  </div>
                </DataRow>
              ))}
            </DataList>
          ) : (
            <EmptyState title="No versions yet">A version is one complete list of charges. Create a draft below to start one.</EmptyState>
          )}
        </section>

        {manage && !archived ? (
          <Card>
            <CardTitle>New draft</CardTitle>
            {draft ? (
              <>
                <CardDescription>A schedule has one draft at a time. Finish this one, or discard it, before starting another.</CardDescription>
                <div className="mt-4">
                  <ButtonLink href={`/app/fee-schedules/${schedule.id}/versions/${draft.id}`}>Open the draft (version {draft.versionNumber})</ButtonLink>
                </div>
              </>
            ) : (
              <>
                <CardDescription>
                  Changing fees means a new version: active versions never change, so past models stay explainable. Copy the current version, edit the copy, then activate it from the date the change starts.
                </CardDescription>
                <div className="mt-5 sm:max-w-xl">
                  <NewDraftControl scheduleId={schedule.id} versions={copyable} />
                </div>
              </>
            )}
          </Card>
        ) : null}

        <section aria-labelledby="customers-heading" className="space-y-3">
          <h2 id="customers-heading" className="text-xl font-semibold tracking-tight">
            Assigned customers
          </h2>
          {schedule.assignments.length ? (
            <DataList>
              {schedule.assignments.map((a) => (
                <DataRow key={a.id}>
                  <div className="min-w-0">
                    <p className="font-medium">
                      <Link href={`/app/customers/${a.brandId}`} className="inline-flex min-h-11 items-center text-accent-text hover:underline">
                        {a.brandName ?? "Customer"}
                      </Link>
                    </p>
                    <p className="text-sm text-muted">Assigned {formatDate(a.assignedAt)}</p>
                  </div>
                  {manage ? (
                    <ConfirmAction action={unassignFeeSchedule.bind(null, a.id)} label="Remove" confirmLabel="Remove fee schedule" variant="danger">
                      They stop seeing these fees, and new cost models for them stop including them. Models already saved keep the fees they were priced with.
                    </ConfirmAction>
                  ) : null}
                </DataRow>
              ))}
            </DataList>
          ) : (
            <EmptyState title="No customers assigned">Assign this fee schedule from a customer&apos;s page, once it has an active version. Customers see only the schedule they are assigned.</EmptyState>
          )}
        </section>

        {manage ? (
          <Card>
            <CardTitle>Settings</CardTitle>
            <CardDescription>Customers read the name and description. Renaming does not change versions, rules or assignments.</CardDescription>
            <ActionForm action={renameFeeSchedule} className="mt-5 grid gap-4 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
              <input type="hidden" name="id" value={schedule.id} />
              <TextField name="name" label="Name" defaultValue={schedule.name} autoComplete="off" required />
              <TextField name="description" label="Description (optional)" defaultValue={schedule.description ?? ""} autoComplete="off" />
              <SubmitButton variant="secondary" pendingLabel="Saving…">
                Rename
              </SubmitButton>
            </ActionForm>
            {!archived ? (
              <div className="mt-6 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">Archive this fee schedule</p>
                  <p className="text-sm text-muted">Archiving stops new assignments and versions. Move every customer to another schedule first; the draft, if any, is discarded.</p>
                </div>
                <ConfirmAction action={archiveFeeSchedule.bind(null, schedule.id)} label="Archive fee schedule" confirmLabel="Archive" variant="danger">
                  Its versions stay readable for history.
                </ConfirmAction>
              </div>
            ) : null}
          </Card>
        ) : null}

        <NotSupportedPanel />
      </div>
    </>
  );
}
