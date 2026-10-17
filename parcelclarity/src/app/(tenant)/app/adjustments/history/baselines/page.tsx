import type { Metadata } from "next";
import { adjustmentAccess } from "@/components/adjustments/staff/access";
import { BaselinesPanel } from "@/components/adjustments/staff/baselines-panel";
import { HistoryNav } from "@/components/adjustments/staff/history-nav";
import { LoadFailed } from "@/components/adjustments/staff/load-failed";
import { PrivateNotice } from "@/components/adjustments/staff/private-notice";
import { AdjustmentsRestricted } from "@/components/adjustments/staff/restricted";
import { loadAdjustmentBrands, loadBaselines } from "@/lib/adjustments/queries";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adjustments: packages shipped" };

/** Packages shipped: the denominator of how often adjustments happen, typed by the 3PL for a period (never inferred from adjustments). */
export default async function AdjustmentBaselinesPage() {
  const access = await adjustmentAccess();
  if (!access.canView) return <AdjustmentsRestricted />;
  const supabase = await createClient();
  const loaded = await Promise.all([loadBaselines(supabase, access.tenantId), loadAdjustmentBrands(supabase, access.tenantId), loadServiceCatalog(supabase)]).catch(() => null);
  if (!loaded) {
    return (
      <>
        <HistoryNav current="baselines" />
        <LoadFailed what="the packages-shipped figures" />
      </>
    );
  }
  const [baselines, brands, catalog] = loaded;
  return (
    <div className="space-y-6">
      <HistoryNav current="baselines" />
      <PrivateNotice />
      <BaselinesPanel baselines={baselines} brands={brands.map((b) => ({ id: b.id, name: b.name }))} catalog={catalog} canManage={access.canManage} />
    </div>
  );
}
