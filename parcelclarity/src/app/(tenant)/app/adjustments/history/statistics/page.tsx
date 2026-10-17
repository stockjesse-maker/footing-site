import type { Metadata } from "next";
import Link from "next/link";
import { adjustmentAccess } from "@/components/adjustments/staff/access";
import { HistoryNav } from "@/components/adjustments/staff/history-nav";
import { LoadFailed } from "@/components/adjustments/staff/load-failed";
import { PrivateNotice } from "@/components/adjustments/staff/private-notice";
import { AdjustmentsRestricted } from "@/components/adjustments/staff/restricted";
import { StatsWorkspace } from "@/components/adjustments/staff/stats-workspace";
import { EmptyState } from "@/components/ui/empty-state";
import { listImports, loadAdjustmentBrands } from "@/lib/adjustments/queries";
import { STATS_EMPTY_BODY, STATS_EMPTY_TITLE } from "@/lib/adjustments/staff-copy";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adjustments: how often" };

/** How often adjustments happen and what they add, from the committed history. Incidence needs the packages shipped for the same period. */
export default async function AdjustmentStatisticsPage() {
  const access = await adjustmentAccess();
  if (!access.canView) return <AdjustmentsRestricted />;
  const supabase = await createClient();
  let hasHistory: boolean;
  let brands;
  let catalog;
  try {
    const [imports, b, c] = await Promise.all([listImports(supabase, access.tenantId), loadAdjustmentBrands(supabase, access.tenantId), loadServiceCatalog(supabase)]);
    // `listImports` returns the newest 200: a full page may hide a committed import further back, so it is not read as "no history".
    hasHistory = imports.some((i) => i.status === "committed") || imports.length >= 200;
    brands = b.map((x) => ({ id: x.id, name: x.name }));
    catalog = c;
  } catch {
    return (
      <>
        <HistoryNav current="statistics" />
        <LoadFailed what="the history" />
      </>
    );
  }
  return (
    <div className="space-y-6">
      <HistoryNav current="statistics" />
      <PrivateNotice />
      {hasHistory ? (
        <StatsWorkspace brands={brands} catalog={catalog} />
      ) : (
        <EmptyState
          title={STATS_EMPTY_TITLE}
          action={
            <Link href="/app/adjustments/history" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
              Upload a history file
            </Link>
          }
        >
          {STATS_EMPTY_BODY}
        </EmptyState>
      )}
    </div>
  );
}
