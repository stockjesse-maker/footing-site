import type { Metadata } from "next";
import Link from "next/link";
import { createFeeSchedule } from "@/app/actions/fee-schedules";
import { NotSupportedPanel } from "@/components/fees/not-supported";
import { ROUNDING_OPTIONS } from "@/components/fees/shared";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/forms/action-form";
import { formatEffectivity } from "@/components/pricing/version-rows-table";
import { Alert } from "@/components/ui/alert";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { listFeeSchedules, type FeeScheduleListRow } from "@/lib/fees/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Fee schedules" };

/** Where the schedule's active version stands today, in words and as a badge. */
function standing(schedule: FeeScheduleListRow, today: string) {
  const v = schedule.activeVersion;
  if (!v) return { line: schedule.draftVersionId ? "No active version yet. A draft is waiting to be activated." : "No active version yet.", badge: <Badge tone="warning">No active version</Badge> };
  const dates = formatEffectivity(v.effectiveDate, v.expirationDate);
  if (v.effectiveDate > today) return { line: `Version ${v.versionNumber} scheduled · ${dates}`, badge: <Badge tone="accent">Scheduled</Badge> };
  if (v.expirationDate !== null && v.expirationDate < today) return { line: `Version ${v.versionNumber} ended · ${dates}`, badge: <Badge tone="warning">Ended</Badge> };
  return { line: `Version ${v.versionNumber} in effect · ${dates}`, badge: <Badge tone="success">In effect</Badge> };
}

export default async function FeeSchedulesPage() {
  const ctx = await requireTenantContext("ratecard.view");
  const manage = can(ctx.active.role, "ratecard.manage");
  const supabase = await createClient();

  let schedules: FeeScheduleListRow[] | null = null;
  try {
    schedules = await listFeeSchedules(supabase, ctx.active.tenantId);
  } catch {
    schedules = null;
  }
  const today = new Date().toISOString().slice(0, 10);
  const sorted = schedules ? [...schedules].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1)) : [];

  return (
    <>
      <PageHeader
        title="Fee schedules"
        description="The fulfillment fees you charge customers: picking, packaging, storage, receiving, returns and account fees. Each schedule is versioned. Draft a version, check it with a sample order, then activate it for a date range and assign it to customers."
      />

      {manage ? (
        <Card className="mb-8">
          <CardTitle>New fee schedule</CardTitle>
          <CardDescription>One schedule per pricing agreement, for example a customer tier. It starts with an empty draft you fill in on the next screen. Customers read the name and description.</CardDescription>
          <ActionForm action={createFeeSchedule} className="mt-5 grid gap-4 sm:grid-cols-2 sm:items-start">
            <TextField name="name" label="Name" autoComplete="off" required placeholder="e.g. Standard fulfillment 2026" />
            <TextField name="description" label="Description (optional)" autoComplete="off" placeholder="Who it applies to" />
            <SelectField name="rounding" label="Rounding" options={ROUNDING_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} hint="You can change this on any draft later." />
            <div className="sm:self-end">
              <SubmitButton pendingLabel="Creating…">Create fee schedule</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      ) : null}

      {schedules === null ? (
        <Alert tone="danger">Fee schedules could not be loaded. Reload the page to try again.</Alert>
      ) : sorted.length ? (
        <DataList>
          {sorted.map((schedule) => {
            const s = standing(schedule, today);
            return (
              <DataRow key={schedule.id} className="p-0 sm:p-0">
                <Link href={`/app/fee-schedules/${schedule.id}`} className="flex w-full flex-col gap-2 px-4 py-4 hover:bg-surface sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{schedule.name}</span>
                      {schedule.status !== "active" ? <Badge tone={statusTone(schedule.status)}>{schedule.status}</Badge> : null}
                      {schedule.draftVersionId ? <Badge tone="neutral">Draft present</Badge> : null}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted">{s.line}</span>
                    {schedule.description ? <span className="mt-0.5 block truncate text-sm text-muted">{schedule.description}</span> : null}
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted">
                    {schedule.status === "active" ? s.badge : null}
                    <span className="tabular">
                      {schedule.assignedBrands} {schedule.assignedBrands === 1 ? "customer" : "customers"}
                    </span>
                  </span>
                </Link>
              </DataRow>
            );
          })}
        </DataList>
      ) : (
        <EmptyState title="No fee schedules yet">
          A fee schedule lists the charges you make beyond shipping: for example a pick fee per order, a fee for each additional item, packaging, pallet storage and receiving, returns, and a monthly account
          minimum. Every amount is one you type; ParcelClarity never invents one. {manage ? "Create one above, then add its rules." : "Ask a 3PL administrator to create one."}
        </EmptyState>
      )}

      <NotSupportedPanel className="mt-8" />
    </>
  );
}
