import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FeeScheduleView } from "@/components/fees/schedule-view";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/format/date";
import { loadBrandFeeSchedule } from "@/lib/fees/queries";
import { brandModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Your fee schedule" };

/**
 * The fulfillment fees the customer's 3PL charges them, as the version in effect today reads. The
 * query authorises on the caller (`brand_fee_schedule_on`) and returns a customer-safe snapshot; the
 * view prints only customer-facing wording, never rule keys, ids, version numbers, notes or sources.
 */
export default async function BrandFeeSchedulePage() {
  const v = await brandModelingView();
  const result = await loadBrandFeeSchedule(v.supabase, v.brandId);
  if (result.status === "not_found") notFound();

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href={v.basePath} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← Model Costs
        </Link>
      </p>
      <PageHeader
        title="Your fee schedule"
        description={`The fulfillment charges ${v.tenantName} makes for your account, beyond shipping. Cost models use these figures; a model is an estimate, never an invoice.`}
      />

      {result.status === "load_failed" ? (
        <Alert tone="danger">We could not load your fee schedule. Reload the page to try again.</Alert>
      ) : result.status === "no_schedule" ? (
        <EmptyState title="No fee schedule yet">
          {v.tenantName} has not set up fulfillment fees for your account, so your cost models cover shipping only. Ask {v.tenantName} when yours will be ready.
        </EmptyState>
      ) : result.status === "not_effective" ? (
        <div className="space-y-4">
          {result.schedule.name ? <h2 className="text-xl font-semibold tracking-tight">{result.schedule.name}</h2> : null}
          <Alert tone="warning">
            {v.tenantName} has assigned this fee schedule to you, but none of its fees is in effect today. A cost model includes fulfillment fees only for dates this schedule covers. Ask {v.tenantName} for the current
            schedule.
          </Alert>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">{result.schedule.name}</h2>
            {result.schedule.description ? <p className="max-w-2xl text-[15px] text-muted">{result.schedule.description}</p> : null}
            <p className="text-sm text-muted">
              {v.tenantName} fee schedule &ldquo;{result.schedule.name}&rdquo;, in effect from {formatDate(result.activeVersion.effectiveDate)}
              {result.assignment ? `. Assigned to you on ${formatDate(result.assignment.assignedAt)}.` : "."}
            </p>
          </div>
          <FeeScheduleView snapshot={result.activeVersion} audience="brand" />
          <Card>
            <p className="text-sm font-medium">What this page does not cover</p>
            <p className="mt-1 text-sm text-muted">
              Your shipping charges come from your rate card. Special projects, return shipping, taxes, carrier adjustments after shipping and anything else outside this schedule are quoted by{" "}
              {v.tenantName} separately. Amounts that depend on what you store, receive or return are worked out from the numbers you give when you run a model.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
