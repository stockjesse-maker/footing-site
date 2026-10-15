import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireBrandContext } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  await requireBrandContext("report.view");
  return (
    <>
      <PageHeader title="Reports" description="Saved simulations, comparisons and PDF reports." />
      <EmptyState title="No reports yet">Reports appear here after you run a cost model.</EmptyState>
    </>
  );
}
