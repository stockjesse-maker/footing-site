import type { Metadata } from "next";
import { adjustmentAccess } from "@/components/adjustments/staff/access";
import { HistoryList } from "@/components/adjustments/staff/history-list";
import { HistoryNav } from "@/components/adjustments/staff/history-nav";
import { LoadFailed } from "@/components/adjustments/staff/load-failed";
import { PrivateNotice } from "@/components/adjustments/staff/private-notice";
import { AdjustmentsRestricted } from "@/components/adjustments/staff/restricted";
import { HistoryUploadForm } from "@/components/adjustments/staff/upload-form";
import { listImports } from "@/lib/adjustments/queries";
import { HISTORY_INTRO, HISTORY_TITLE } from "@/lib/adjustments/staff-copy";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adjustments: history" };

/** History: past adjustments imported from a file, newest first, and the upload that starts an import. */
export default async function AdjustmentHistoryPage() {
  const access = await adjustmentAccess();
  if (!access.canView) return <AdjustmentsRestricted />;
  let imports;
  try {
    imports = await listImports(await createClient(), access.tenantId);
  } catch {
    return (
      <>
        <HistoryNav current="imports" />
        <LoadFailed what="the imports" />
      </>
    );
  }
  return (
    <div className="space-y-6">
      <HistoryNav current="imports" />
      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">{HISTORY_TITLE}</h2>
        <p className="max-w-2xl text-[15px] text-muted">{HISTORY_INTRO}</p>
        <PrivateNotice />
      </div>
      <HistoryUploadForm canManage={access.canManage} />
      <section aria-labelledby="imports-heading" className="space-y-3">
        <h2 id="imports-heading" className="text-xl font-semibold tracking-tight">
          Imports
        </h2>
        <HistoryList imports={imports} />
      </section>
    </div>
  );
}
