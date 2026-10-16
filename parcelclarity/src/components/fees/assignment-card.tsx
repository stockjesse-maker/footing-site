import Link from "next/link";
import { assignFeeSchedule, unassignFeeSchedule } from "@/app/actions/fee-schedules";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { formatEffectivity } from "@/components/pricing/version-rows-table";
import { Alert } from "@/components/ui/alert";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select } from "@/components/ui/field";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { formatDate } from "@/lib/format/date";
import { listFeeSchedules, type FeeScheduleListRow } from "@/lib/fees/queries";
import { createClient } from "@/lib/supabase/server";

/**
 * "Fee schedule" section of the customer page: the schedule this customer is on, with the version in
 * effect, a select of the active schedules that have an active version, and the buttons that assign
 * or remove one. A Server Component: every query runs as the signed-in user (Row Level Security) and
 * the forms render only for people who may manage fees; assigning and removing are authorised again
 * by the server actions and the database functions behind them.
 */

interface AssignmentRow {
  id: string;
  schedule_id: string;
  assigned_at: string;
}

/** Where the schedule's active version stands today. */
function versionStanding(version: NonNullable<FeeScheduleListRow["activeVersion"]>, today: string): { inEffect: boolean; label: string } {
  const dates = formatEffectivity(version.effectiveDate, version.expirationDate);
  if (version.effectiveDate > today) return { inEffect: false, label: `Version ${version.versionNumber} scheduled · ${dates}` };
  if (version.expirationDate !== null && version.expirationDate < today) return { inEffect: false, label: `Version ${version.versionNumber} ended · ${dates}` };
  return { inEffect: true, label: `Version ${version.versionNumber} in effect · ${dates}` };
}

export async function FeeScheduleAssignmentCard({ brandId, tenantId }: { brandId: string; tenantId: string }) {
  const ctx = await requireTenantContext();
  // The page passes its own tenant; anything else is not ours to show.
  if (ctx.active.tenantId !== tenantId || !can(ctx.active.role, "ratecard.view")) return null;
  const manage = can(ctx.active.role, "ratecard.manage");
  const headingId = `fee-schedule-heading-${brandId}`;
  const supabase = await createClient();

  let schedules: FeeScheduleListRow[];
  let assignment: AssignmentRow | null;
  try {
    const [list, current] = await Promise.all([
      listFeeSchedules(supabase, tenantId),
      supabase.from("brand_fee_schedule_assignments").select("id, schedule_id, assigned_at").eq("brand_id", brandId).eq("tenant_id", tenantId).is("unassigned_at", null).maybeSingle().overrideTypes<AssignmentRow, { merge: false }>(),
    ]);
    if (current.error) throw new Error(current.error.message);
    schedules = list;
    assignment = current.data;
  } catch {
    // A failed load is reported as a failure, never as "no fee schedule".
    return (
      <section aria-labelledby={headingId} className="space-y-3">
        <h2 id={headingId} className="text-xl font-semibold tracking-tight">
          Fee schedule
        </h2>
        <Alert tone="danger">The fee schedule could not be loaded. Reload the page to try again.</Alert>
      </section>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const current = assignment ? (schedules.find((s) => s.id === assignment.schedule_id) ?? null) : null;
  const standing = current?.activeVersion ? versionStanding(current.activeVersion, today) : null;
  // The same rule assign_fee_schedule enforces: an active schedule with an active version.
  const offered = schedules.filter((s) => s.status === "active" && s.activeVersion !== null && s.id !== assignment?.schedule_id);

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h2 id={headingId} className="text-xl font-semibold tracking-tight">
          Fee schedule
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The fulfillment fees this customer is charged (picking, packaging, storage, receiving, returns and the like). They read them under &ldquo;Your fee schedule&rdquo; and cost models use them.
          {manage ? "" : " Only administrators can change it."}
        </p>
      </div>

      {assignment ? (
        <DataList>
          <DataRow>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                <Link href={`/app/fee-schedules/${assignment.schedule_id}`} className="inline-flex min-h-11 items-center text-accent-text hover:underline">
                  {current?.name ?? "Fee schedule"}
                </Link>
                {current ? <Badge tone={statusTone(current.status)}>{current.status}</Badge> : null}
              </p>
              <p className="text-sm text-muted">{standing ? standing.label : "No version has been activated yet"}</p>
              <p className="text-sm text-muted">Assigned {formatDate(assignment.assigned_at)}</p>
            </div>
            {manage ? (
              <ConfirmAction action={unassignFeeSchedule.bind(null, assignment.id)} label="Remove" confirmLabel="Remove fee schedule" variant="danger">
                The customer&apos;s models stop including fulfillment fees until you assign another schedule.
              </ConfirmAction>
            ) : null}
          </DataRow>
        </DataList>
      ) : (
        <EmptyState title="No fee schedule assigned">Without one, this customer&apos;s cost models cover shipping only and they see no fulfillment fees.</EmptyState>
      )}

      {assignment && !standing?.inEffect ? (
        <Alert tone="warning">No version of this fee schedule is in effect today, so fulfillment fees cannot be priced for this customer until one is active.</Alert>
      ) : null}

      {manage ? (
        <Card>
          <CardTitle>{assignment ? "Move to a different fee schedule" : "Assign a fee schedule"}</CardTitle>
          <CardDescription>Only active fee schedules with an active version can be assigned. A customer is on one fee schedule at a time.</CardDescription>
          {offered.length ? (
            <ActionForm action={assignFeeSchedule} className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,24rem)_auto] sm:items-end">
              <input type="hidden" name="brandId" value={brandId} />
              <Field id={`fee-schedule-select-${brandId}`} label="Fee schedule">
                {(aria) => (
                  <Select {...aria} name="scheduleId" defaultValue="">
                    <option value="">Choose a fee schedule…</option>
                    {offered.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <SubmitButton pendingLabel="Assigning…">Assign</SubmitButton>
            </ActionForm>
          ) : (
            <p className="mt-4 text-sm text-muted">
              {schedules.some((s) => s.status === "active") ? "There is no other active fee schedule with an active version." : "You have no active fee schedule with an active version yet."}{" "}
              <Link href="/app/fee-schedules" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
                Go to fee schedules
              </Link>
            </p>
          )}
        </Card>
      ) : null}
    </section>
  );
}
