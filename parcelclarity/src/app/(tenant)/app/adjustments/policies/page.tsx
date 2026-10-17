import type { Metadata } from "next";
import { adjustmentAccess } from "@/components/adjustments/staff/access";
import { LoadFailed } from "@/components/adjustments/staff/load-failed";
import { PoliciesWorkspace } from "@/components/adjustments/staff/policies-workspace";
import { AdjustmentsRestricted } from "@/components/adjustments/staff/restricted";
import { todayIso } from "@/lib/adjustments/action-schemas";
import { loadAdjustmentBrands, loadPolicies } from "@/lib/adjustments/queries";
import { uuidSchema } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adjustments: who pays" };

/** Policies: who pays for each kind of correction, for all customers and then for one customer. `?customer=<id>` opens that customer's decisions. */
export default async function AdjustmentPoliciesPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const access = await adjustmentAccess();
  if (!access.canView) return <AdjustmentsRestricted />;
  const { customer } = await searchParams;
  const supabase = await createClient();
  const loaded = await Promise.all([loadPolicies(supabase, access.tenantId), loadAdjustmentBrands(supabase, access.tenantId)]).catch(() => null);
  if (!loaded) return <LoadFailed what="the decisions on who pays" />;
  const [policies, brands] = loaded;
  // A guessed id opens nothing: the workspace only preselects an id that is one of this account's customers.
  const initialCustomerId = customer && uuidSchema.safeParse(customer).success ? customer : null;
  return <PoliciesWorkspace policies={policies} brands={brands} today={todayIso()} canManage={access.canManage} initialCustomerId={initialCustomerId} />;
}
