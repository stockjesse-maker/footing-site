import type { Metadata } from "next";
import Link from "next/link";
import { OverviewFigures, ScenarioList, overviewModels } from "@/components/modeling/lists";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireBrandContext } from "@/lib/auth/session";
import { loadModelingLists } from "@/lib/modeling/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Overview" };

/**
 * The customer's overview. Every headline figure comes from one run, the latest completed orders-file model
 * that is not a what-if, with its own completeness label and the reason it is not the plain all-in figure;
 * forecasts from assumptions and what-ifs are separate, labelled tiles and never mixed into those figures.
 */
export default async function BrandOverview({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  const ctx = await requireBrandContext();
  const flash = (await searchParams).password === "updated";
  const supabase = await createClient();
  const { projects } = await loadModelingLists(supabase, ctx.active.brandId);
  const models = overviewModels(projects);
  const any = models.latest || models.forecast || models.whatIf;
  return (
    <>
      <PageHeader
        title={`Welcome${ctx.profile.fullName ? `, ${ctx.profile.fullName.split(" ")[0]}` : ""}`}
        description={`Model your shipping and fulfillment costs with ${ctx.active.tenantName}'s pricing for ${ctx.active.brandName}.`}
      />
      {flash ? <Alert tone="success" className="mb-6">Your password was updated.</Alert> : null}
      {any ? (
        <OverviewFigures projects={projects} basePath="/portal/model" tenantName={ctx.active.tenantName} audience="brand" />
      ) : (
        <EmptyState title="No cost models yet" action={<Link href="/portal/model" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">Model your costs →</Link>}>
          Price a shipment, upload an orders file, or forecast from your assumptions to see your shipping and all-in cost per order here, calculated only from the rates and fee schedule {ctx.active.tenantName} has assigned to you.
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
