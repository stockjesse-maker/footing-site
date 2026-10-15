import { uploadZoneChart } from "@/app/actions/rate-cards";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { FileField } from "@/components/pricing/file-field";

/** Replaces a draft version's zone chart from an uploaded file (managers only; the page decides when to show it). */
export function ZoneChartUploadForm({ versionId, hasChart }: { versionId: string; hasChart: boolean }) {
  return (
    <Card>
      <CardTitle>{hasChart ? "Replace the zone chart" : "Add a zone chart"}</CardTitle>
      <CardDescription>
        A CSV or XLSX with the columns <code className="text-xs">carrier, origin_prefix, dest_prefix_from, dest_prefix_to, zone</code> and an optional <code className="text-xs">chart_key</code> when
        different services use different charts. Prefixes are 3 or 5 digits; destination ranges within one chart and origin must not overlap. Without a chart, the calculator needs the zone entered
        directly.
      </CardDescription>
      <ActionForm action={uploadZoneChart} className="mt-5 space-y-4">
        <input type="hidden" name="versionId" value={versionId} />
        <FileField name="file" label="Zone chart file" accept=".csv,.xlsx" />
        <SubmitButton variant="secondary" pendingLabel="Uploading…">
          {hasChart ? "Replace zone chart" : "Upload zone chart"}
        </SubmitButton>
      </ActionForm>
    </Card>
  );
}
