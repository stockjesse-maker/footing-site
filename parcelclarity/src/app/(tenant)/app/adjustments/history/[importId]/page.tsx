import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { adjustmentAccess } from "@/components/adjustments/staff/access";
import { ImportEndedView, ImportCommittedView } from "@/components/adjustments/staff/import-summary";
import { ImportSteps, ImportStatusBadge } from "@/components/adjustments/staff/import-steps";
import { ImportWizard } from "@/components/adjustments/staff/import-wizard";
import { parseStoredReport, stepNumber } from "@/components/adjustments/staff/import-model";
import { LoadFailed } from "@/components/adjustments/staff/load-failed";
import { PrivateNotice } from "@/components/adjustments/staff/private-notice";
import { AdjustmentsRestricted } from "@/components/adjustments/staff/restricted";
import { loadImportWizard, type ImportWizardView } from "@/lib/adjustments/queries";
import { uuidSchema } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adjustments: import" };

/**
 * One import: the wizard while it is open (map the columns, check, import), the result when it is committed, and a plain notice once it was
 * discarded or withdrawn. The id comes from the URL and is only ever a request: the query names the session's workspace and a row of
 * another account reads as "not found".
 */
export default async function AdjustmentImportPage({ params }: { params: Promise<{ importId: string }> }) {
  const access = await adjustmentAccess();
  if (!access.canView) return <AdjustmentsRestricted />;
  const { importId } = await params;
  if (!uuidSchema.safeParse(importId).success) notFound();
  let view: ImportWizardView | null;
  try {
    view = await loadImportWizard(await createClient(), access.tenantId, importId);
  } catch {
    return <LoadFailed what="the import" />;
  }
  if (!view) notFound();
  const imp = view.import;

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/app/adjustments/history" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← Past adjustments
        </Link>
      </p>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{imp.name}</h2>
          <ImportStatusBadge status={imp.status} />
        </div>
        <PrivateNotice />
      </div>

      {imp.status === "committed" ? (
        <>
          <ImportSteps current={stepNumber(imp.status)} />
          <ImportCommittedView
            canManage={access.canManage}
            summary={{ importId: imp.id, name: imp.name, committedCount: imp.committedCount, skippedCount: imp.skippedCount, committedAt: imp.committedAt, shipDateFrom: imp.shipDateFrom, shipDateTo: imp.shipDateTo }}
          />
        </>
      ) : imp.status === "discarded" || imp.status === "withdrawn" ? (
        <ImportEndedView status={imp.status} />
      ) : (
        <ImportWizard
          importId={imp.id}
          name={imp.name}
          status={imp.status}
          canManage={access.canManage}
          detection={view.detection}
          detectionProblem={view.detectionProblem}
          sampleRows={imp.detected?.sampleRows}
          brands={view.brands}
          catalog={view.catalog}
          rowCount={imp.rowCount}
          storedMapping={view.mapping}
          storedReport={parseStoredReport(imp.validation)}
        />
      )}
    </div>
  );
}
