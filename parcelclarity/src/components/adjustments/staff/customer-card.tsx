import Link from "next/link";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";

/** The two routes the card links to, for a customer. The examples route filters its list to this customer. */
export const customerExamplesHref = (brandId: string): string => `/app/adjustments/examples?brand=${encodeURIComponent(brandId)}`;
export const customerPoliciesHref = (brandId: string): string => `/app/adjustments/policies?customer=${encodeURIComponent(brandId)}`;

export function CustomerAdjustmentsCardView({ brandId, brandName }: { brandId: string; brandName: string }) {
  const headingId = `adjustments-card-heading-${brandId}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid="customer-adjustments-card">
      <h2 id={headingId} className="text-xl font-semibold tracking-tight">
        Adjustments
      </h2>
      <Card>
        <CardTitle className="text-base">{`Adjustment examples for ${brandName}`}</CardTitle>
        <CardDescription>Price a package that is corrected after labelling at this customer&apos;s rates, and share the result with them. Decisions, history and estimates stay private to your team.</CardDescription>
        <p className="mt-3 flex flex-wrap gap-x-6">
          <Link href={customerExamplesHref(brandId)} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            Open examples
          </Link>
          <Link href={customerPoliciesHref(brandId)} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            Decide who pays
          </Link>
        </p>
      </Card>
    </section>
  );
}

/** The card on the customer page, next to the fee schedule: for people who hold adjustment.view; nothing for anyone else. */
export async function CustomerAdjustmentsCard({ brandId, brandName }: { brandId: string; brandName: string }) {
  const ctx = await requireTenantContext();
  if (!can(ctx.active.role, "adjustment.view")) return null;
  return <CustomerAdjustmentsCardView brandId={brandId} brandName={brandName} />;
}
