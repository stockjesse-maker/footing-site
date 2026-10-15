import type { Metadata } from "next";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireBrandContext } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Overview" };

export default async function BrandOverview({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  const ctx = await requireBrandContext();
  const flash = (await searchParams).password === "updated";
  return (
    <>
      <PageHeader
        title={`Welcome${ctx.profile.fullName ? `, ${ctx.profile.fullName.split(" ")[0]}` : ""}`}
        description={`Model your shipping and fulfillment costs with ${ctx.active.tenantName}'s pricing for ${ctx.active.brandName}.`}
      />
      {flash ? <Alert tone="success" className="mb-6">Your password was updated.</Alert> : null}
      <EmptyState title="No cost models yet">
        Cost modeling isn&apos;t available in this release yet. When it is, your average shipping cost per order, fulfillment cost per order
        and projected monthly spend will appear here, calculated only from the pricing {ctx.active.tenantName} has assigned to you.
      </EmptyState>
    </>
  );
}
