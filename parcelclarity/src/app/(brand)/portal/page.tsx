import type { Metadata } from "next";
import Link from "next/link";
import { ScenarioList } from "@/components/modeling/lists";
import { formatMoney } from "@/components/pricing/calculation-result";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { requireBrandContext } from "@/lib/auth/session";
import { formatDate } from "@/lib/format/date";
import { latestCompletedBulkRun, loadModelingLists } from "@/lib/modeling/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Overview" };

export default async function BrandOverview({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  const ctx = await requireBrandContext();
  const flash = (await searchParams).password === "updated";
  const supabase = await createClient();
  const { projects } = await loadModelingLists(supabase, ctx.active.brandId);
  const latest = latestCompletedBulkRun(projects);
  const summary = latest?.run.summary ?? null;
  return (
    <>
      <PageHeader
        title={`Welcome${ctx.profile.fullName ? `, ${ctx.profile.fullName.split(" ")[0]}` : ""}`}
        description={`Model your shipping and fulfillment costs with ${ctx.active.tenantName}'s pricing for ${ctx.active.brandName}.`}
      />
      {flash ? <Alert tone="success" className="mb-6">Your password was updated.</Alert> : null}
      {summary && latest ? (
        <section className="space-y-3" aria-labelledby="overview-latest">
          <h2 id="overview-latest" className="text-xl font-semibold tracking-tight">
            Shipping, from your latest model
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Estimated shipping cost per order" value={summary.averages.expectedPerOrder ? formatMoney({ amount: summary.averages.expectedPerOrder, currency: "USD" }) : "—"} note={`${summary.modeled.orders.toLocaleString("en-US")} of ${summary.imported.orders.toLocaleString("en-US")} orders (${summary.coverage.ordersPct}%)`} />
            <Stat label="Projected shipping spend" value={summary.modeled.orders ? formatMoney({ amount: summary.totals.expected, currency: "USD" }) : "—"} note={summary.modeled.orders ? `for the ${summary.modeled.orders.toLocaleString("en-US")} of ${summary.imported.orders.toLocaleString("en-US")} orders that could be priced` : "no orders could be priced"} />
            <Stat label="Fulfillment cost per order" value="—" note="Processing fees arrive in a later release." />
          </div>
          <p className="text-sm text-muted">
            <Link href={`/portal/model/runs/${latest.run.id}`} className="font-medium text-accent-text hover:underline">
              {latest.project.name}
            </Link>
            {latest.run.finished_at ? ` · priced ${formatDate(latest.run.finished_at)}` : ""} · estimates from the rates {ctx.active.tenantName} assigned to you, never an invoice.
          </p>
        </section>
      ) : (
        <EmptyState title="No cost models yet" action={<Link href="/portal/model" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">Model your costs →</Link>}>
          Price a shipment or upload an orders file to see your average shipping cost per order here, calculated only from the pricing {ctx.active.tenantName} has assigned to you. Processing fees and all-in cost per order arrive in a later release.
        </EmptyState>
      )}
      <section className="mt-8 space-y-3" aria-labelledby="overview-scenarios">
        <h2 id="overview-scenarios" className="text-xl font-semibold tracking-tight">
          Saved scenarios
        </h2>
        <ScenarioList projects={projects.slice(0, 5)} basePath="/portal/model" staff={false} compareHref="/portal/reports" />
      </section>
    </>
  );
}
