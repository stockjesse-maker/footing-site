import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription } from "@/components/ui/card";
import type { AdjustmentValidationReport, CodeSummary } from "@/lib/adjustments/types";
import { IMPORT_LIMITS, PRIVATE_NOTICE, formatCount, formatDateRange, pluralize } from "@/lib/adjustments/staff-copy";
import { splitCodes } from "./import-model";

const TYPE_WORDS: Record<string, string> = { reweight: "reweigh", remeasure: "remeasure", combined: "both together", correction: "other correction fee" };

function rowList(report: AdjustmentValidationReport, code: string): string | null {
  const nums = report.rowNumbers[code as keyof typeof report.rowNumbers];
  if (!nums || !nums.length) return null;
  const shown = nums.slice(0, 20);
  const more = (report.byCode[code as keyof typeof report.byCode] ?? nums.length) - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${formatCount(more)} more` : ""}`;
}

function CodeList({ codes, report, tone }: { codes: CodeSummary[]; report: AdjustmentValidationReport; tone: "error" | "information" }) {
  return (
    <ul className="space-y-3">
      {codes.map((c) => {
        const rows = tone === "error" ? rowList(report, c.code) : null;
        return (
          <li key={c.code} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3" data-testid={`report-code-${c.code}`}>
            <Badge tone={tone === "error" ? "warning" : "neutral"} className="self-start whitespace-nowrap">
              {tone === "error" ? "Fix before importing" : "For your information"}
            </Badge>
            <div className="min-w-0 text-sm [overflow-wrap:anywhere]">
              <p>{c.message}</p>
              {rows ? <p className="mt-0.5 text-muted">Data rows: {rows}</p> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "What we found": one plain sentence per code with its count, errors first and information after, the private-data notice, and the figures
 * the import will commit. Nothing here holds a cell value. `dirty` says the mapping on screen is newer than this report.
 */
export function ValidationReportView({
  report,
  headingId,
  dirty = false,
  brandNames = {},
}: {
  report: AdjustmentValidationReport;
  headingId: string;
  dirty?: boolean;
  brandNames?: Record<string, string>;
}) {
  const { errors, information } = splitCodes(report);
  const c = report.counts;
  const range = formatDateRange(report.shipDateRange.min, report.shipDateRange.max);
  const types = Object.entries(report.byType).filter(([, n]) => (n ?? 0) > 0);
  return (
    <Card role="region" aria-labelledby={headingId}>
      <h2 id={headingId} tabIndex={-1} className="scroll-mt-4 text-lg font-semibold tracking-tight">
        What we found
      </h2>
      <CardDescription>{PRIVATE_NOTICE}</CardDescription>
      {dirty ? (
        <Alert tone="warning" className="mt-3">
          You changed how the file is read. Check the file again to update this report; it describes the last saved choices.
        </Alert>
      ) : null}

      {!report.ok ? (
        <Alert tone="danger" className="mt-4" title="The mapping cannot be applied to this file">
          <ul className="list-disc space-y-1 pl-5">
            {report.mappingIssues.map((i) => (
              <li key={`${i.code}-${i.field ?? ""}`} className="[overflow-wrap:anywhere]">
                {i.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : (
        <>
          <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted">Rows in the file</dt>
              <dd className="tabular text-lg font-semibold">{formatCount(c.rows)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Rows that can be imported</dt>
              <dd className="tabular text-lg font-semibold">{formatCount(c.accepted)}</dd>
            </div>
            {range ? (
              <div>
                <dt className="text-sm text-muted">Ship dates</dt>
                <dd className="text-lg font-semibold">{range}</dd>
              </div>
            ) : null}
            {types.length ? (
              <div>
                <dt className="text-sm text-muted">Kinds of adjustment</dt>
                <dd className="text-[15px]">{types.map(([t, n]) => `${formatCount(n ?? 0)} ${TYPE_WORDS[t] ?? t}`).join(", ")}</dd>
              </div>
            ) : null}
            {c.alreadyImported > 0 ? (
              <div>
                <dt className="text-sm text-muted">Already imported</dt>
                <dd className="tabular text-[15px]">{pluralize(c.alreadyImported, "row")} skipped</dd>
              </div>
            ) : null}
            {c.merged + c.ignored > 0 ? (
              <div>
                <dt className="text-sm text-muted">Repeated packages</dt>
                <dd className="tabular text-[15px]">
                  {c.merged > 0 ? `${pluralize(c.merged, "row")} combined` : ""}
                  {c.merged > 0 && c.ignored > 0 ? ", " : ""}
                  {c.ignored > 0 ? `${pluralize(c.ignored, "row")} ignored` : ""}
                </dd>
              </div>
            ) : null}
          </dl>

          {report.committable ? (
            <Alert tone="success" className="mt-4">
              No problems block this import. Nothing is imported until you confirm it below.
            </Alert>
          ) : (
            <Alert tone="warning" className="mt-4">
              {c.accepted === 0 && c.errorRows === 0 ? "There is nothing to import: every row was skipped or left out." : `${pluralize(c.errorRows, "row")} need fixing before this file can be imported. Fix the file and upload it again, or change how it is read.`}
            </Alert>
          )}

          {errors.length ? (
            <section className="mt-5 space-y-3" aria-label="Problems to fix">
              <h3 className="text-base font-semibold">Fix before importing</h3>
              <CodeList codes={errors} report={report} tone="error" />
            </section>
          ) : null}
          {information.length ? (
            <section className="mt-5 space-y-3" aria-label="For your information">
              <h3 className="text-base font-semibold">For your information</h3>
              <CodeList codes={information} report={report} tone="information" />
            </section>
          ) : null}
          {!errors.length && !information.length ? <p className="mt-4 text-sm text-muted">No problems found.</p> : null}

          {report.customers.length ? (
            <section className="mt-5 space-y-2" aria-label="Customers named in the file">
              <h3 className="text-base font-semibold">Customers named in the file</h3>
              <ul className="divide-y divide-line text-sm">
                {report.customers.map((cu) => (
                  <li key={cu.text} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between">
                    <span className="[overflow-wrap:anywhere]">
                      {cu.text} <span className="text-muted">({pluralize(cu.rows, "row")})</span>
                    </span>
                    <span className="text-muted [overflow-wrap:anywhere]">{cu.brandId ? `Matched to ${brandNames[cu.brandId] ?? "a customer"}` : "Not matched: stays unassigned"}</span>
                  </li>
                ))}
              </ul>
              {report.unassignedRows > 0 ? <p className="text-sm text-muted">{pluralize(report.unassignedRows, "row")} name no customer and stay unassigned.</p> : null}
            </section>
          ) : null}
        </>
      )}
      <p className="mt-5 text-sm text-muted">Limits: {report.limits || IMPORT_LIMITS}.</p>
    </Card>
  );
}
