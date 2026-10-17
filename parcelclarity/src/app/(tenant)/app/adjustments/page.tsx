import type { Metadata } from "next";
import { adjustmentAccess } from "@/components/adjustments/staff/access";
import { parseLegacyFeeRules, type LegacyFeeRule } from "@/components/adjustments/staff/checklist-model";
import { LoadFailed } from "@/components/adjustments/staff/load-failed";
import { OverviewView } from "@/components/adjustments/staff/overview-view";
import { AdjustmentsRestricted } from "@/components/adjustments/staff/restricted";
import { todayIso } from "@/lib/adjustments/action-schemas";
import { loadOverview, type OverviewData } from "@/lib/adjustments/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adjustments" };

type Db = Awaited<ReturnType<typeof createClient>>;

/** Published fee rules that are not conditional charges (an RPC of the migration), or null when the check could not run: never "none" by default. */
async function legacyFeeRules(supabase: Db, tenantId: string): Promise<LegacyFeeRule[] | null> {
  try {
    const { data, error } = await supabase.rpc("adjustment_legacy_fee_rules", { p_tenant: tenantId });
    return error ? null : parseLegacyFeeRules(data);
  } catch {
    return null;
  }
}

/** Overview: the computed checklist, what customers can see today, and where things stand. */
export default async function AdjustmentsOverviewPage() {
  const access = await adjustmentAccess();
  if (!access.canView) return <AdjustmentsRestricted />;
  const supabase = await createClient();
  let data: OverviewData;
  try {
    data = await loadOverview(supabase, access.tenantId, todayIso());
  } catch {
    return <LoadFailed what="the overview" />;
  }
  const legacy = await legacyFeeRules(supabase, access.tenantId);
  return <OverviewView data={data} legacy={legacy} canManage={access.canManage} />;
}
