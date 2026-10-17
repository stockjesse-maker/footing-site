"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { commitImport, saveImportMapping, validateImport } from "@/app/actions/adjustments";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { GENERIC_FAILURE } from "@/lib/adjustments/action-schemas";
import type { AdjustmentDetection, AdjustmentMapping, AdjustmentValidationReport } from "@/lib/adjustments/types";
import {
  ATTESTATION_TEXT,
  ATTEST_HINT,
  CHECK_BUTTON,
  CHECK_PENDING,
  COMMIT_BUTTON,
  READ_ONLY_NOTICE,
  UPLOAD_NOTHING_IMPORTED,
  WITHDRAW_BUTTON,
  formatCount,
  formatDateRange,
  pluralize,
  type ImportStatusKey,
} from "@/lib/adjustments/staff-copy";
import { FocusAlert } from "./focus-alert";
import { DiscardControl, ImportCommittedView, type CommittedSummary } from "./import-summary";
import { ImportSteps } from "./import-steps";
import { MappingEditor } from "./mapping-step";
import { canCheck, commitSummary, detectionHeaders, importOffered, missingChoices, stable, stepNumber, stepAfterCommit, type CatalogService } from "./import-model";
import { ValidationReportView } from "./validation-report";

/**
 * The import page of one history file: map the columns, tick the statement about what the amounts are, check the file, read the report,
 * import. `ImportWizardView` draws a given state (so every state renders without a browser); `ImportWizard` owns that state and calls the
 * actions. Nothing is imported until the person confirms at the last step, and the check is never offered before the statement is ticked.
 */
export interface WizardData {
  importId: string;
  name: string;
  status: ImportStatusKey;
  canManage: boolean;
  /** The file read again; null when the file is gone (committed, discarded, withdrawn) or cannot be read. */
  detection: AdjustmentDetection | null;
  /** Why there is no detection; shown instead of the mapping. */
  detectionProblem: string | null;
  sampleRows?: Record<string, string>[];
  brands: { id: string; name: string }[];
  catalog: CatalogService[];
  rowCount: number;
}

export type WizardPhase = "idle" | "checking" | "importing";

export interface WizardState {
  mapping: AdjustmentMapping | null;
  attested: boolean;
  phase: WizardPhase;
  error: { message: string; attempt: number } | null;
  report: AdjustmentValidationReport | null;
  /** The mapping on screen is newer than the report. */
  stale: boolean;
  dateUnchosen: boolean;
  unitUnchosen: boolean;
  /** Set once this session finished the import. */
  committed: (CommittedSummary & { message: string | null }) | null;
}

export interface WizardHandlers {
  onMapping: (m: AdjustmentMapping) => void;
  onAttest: (v: boolean) => void;
  onCheck: () => void;
  onImport: () => Promise<{ ok: boolean; message?: string }>;
  onChooseDate: () => void;
  onChooseUnit: () => void;
}

export const REPORT_HEADING_SUFFIX = "report";

export function ImportWizardView({ data, state, handlers, ids }: { data: WizardData; state: WizardState; handlers: WizardHandlers; ids: { prefix: string } }) {
  const { status, canManage, detection } = data;
  const mapping = state.mapping;
  const reportId = `${ids.prefix}-${REPORT_HEADING_SUFFIX}`;
  const importId = `${ids.prefix}-import`;
  const attestId = `${ids.prefix}-attest`;
  const hintId = `${ids.prefix}-check-hint`;
  const checking = state.phase === "checking";
  const importing = state.phase === "importing";

  if (state.committed) {
    return (
      <div className="space-y-6">
        <ImportSteps current={stepAfterCommit} />
        <ImportCommittedView summary={state.committed} message={state.committed.message} canManage={canManage} />
      </div>
    );
  }

  const report = state.report;
  const offered = importOffered(status, report, state.stale);
  const editable = (status === "uploaded" || status === "mapped" || status === "validated") && detection !== null && mapping !== null;
  const headers = detection && mapping ? detectionHeaders(detection, mapping.sheet) : [];
  const missing = mapping && editable ? missingChoices(mapping, headers, { dateUnchosen: state.dateUnchosen, unitUnchosen: state.unitUnchosen }) : [];
  const checkable = canCheck({ attested: state.attested, missing, pending: checking || importing });
  const summary = report ? commitSummary(report) : null;
  const range = summary ? formatDateRange(summary.from, summary.to) : null;

  if (!canManage) {
    return (
      <div className="space-y-6">
        <ImportSteps current={stepNumber(status)} />
        <Alert>{READ_ONLY_NOTICE}</Alert>
        {report ? <ValidationReportView report={report} headingId={reportId} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ImportSteps current={stepNumber(status)} />

      {state.error ? (
        <FocusAlert key={state.error.attempt}>{state.error.message}</FocusAlert>
      ) : null}

      {data.detectionProblem && !editable ? (
        <Alert tone={status === "committing" ? "warning" : "danger"} title={status === "committing" ? "An earlier import of this file did not finish" : "This file cannot be read now"}>
          {status === "committing"
            ? "Importing again starts over: nothing from the earlier attempt is kept, and rows already imported are not added twice."
            : data.detectionProblem}
        </Alert>
      ) : null}

      {editable && mapping && detection ? (
        <Card>
          <CardTitle>How we read your file</CardTitle>
          <CardDescription>
            {pluralize(data.rowCount, "row")} in the file. {UPLOAD_NOTHING_IMPORTED}
          </CardDescription>
          <div className="mt-5">
            <MappingEditor
              mapping={mapping}
              onChange={handlers.onMapping}
              detection={detection}
              headers={headers}
              sampleRows={data.sampleRows}
              brands={data.brands}
              catalog={data.catalog}
              dateUnchosen={state.dateUnchosen}
              unitUnchosen={state.unitUnchosen}
              onChooseDate={handlers.onChooseDate}
              onChooseUnit={handlers.onChooseUnit}
              disabled={checking || importing}
            />
          </div>

          <div className="mt-8 space-y-4 border-t border-line pt-6">
            <h3 className="text-base font-semibold">Check the file</h3>
            <label htmlFor={attestId} className="flex min-h-11 items-start gap-3 text-[15px]">
              <input id={attestId} type="checkbox" checked={state.attested} onChange={(e) => handlers.onAttest(e.target.checked)} disabled={checking || importing} aria-required="true" className="mt-0.5 size-5 shrink-0 accent-accent" />
              <span>{ATTESTATION_TEXT}</span>
            </label>
            {missing.length ? (
              <div id={hintId} className="text-sm text-muted">
                <p className="font-medium text-fg">Before you can check the file:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {missing.map((m) => (
                    <li key={m} className="[overflow-wrap:anywhere]">
                      {m}
                    </li>
                  ))}
                </ul>
              </div>
            ) : !state.attested ? (
              <p id={hintId} className="text-sm text-muted">
                {ATTEST_HINT}
              </p>
            ) : null}
            <Button onClick={handlers.onCheck} loading={checking} disabled={!checkable} aria-describedby={!checkable ? hintId : undefined}>
              {checking ? CHECK_PENDING : CHECK_BUTTON}
            </Button>
          </div>
        </Card>
      ) : null}

      {report ? <ValidationReportView report={report} headingId={reportId} dirty={state.stale} /> : null}

      {offered && summary ? (
        <Card role="region" aria-labelledby={importId}>
          <h2 id={importId} className="text-lg font-semibold tracking-tight">
            {COMMIT_BUTTON}
          </h2>
          <CardDescription>
            {pluralize(summary.rows, "row")} will be added to your history{range ? `, shipped ${range}` : ""}.
            {summary.skipped > 0 ? ` ${pluralize(summary.skipped, "row")} already imported ${summary.skipped === 1 ? "is" : "are"} skipped.` : ""} Only your team can see them.
          </CardDescription>
          {status === "committing" ? <p className="mt-2 text-sm text-muted">An earlier attempt did not finish. Importing again starts over and keeps nothing from it.</p> : null}
          <div className="mt-4">
            <ConfirmAction action={handlers.onImport} label={COMMIT_BUTTON} confirmLabel={`Import ${pluralize(summary.rows, "row")}`} variant="ghost">
              {`Import ${pluralize(summary.rows, "row")}${range ? ` shipped ${range}` : ""}? You can take them back with ${WITHDRAW_BUTTON}.`}
            </ConfirmAction>
          </div>
          {importing ? (
            <p role="status" aria-live="polite" className="mt-3 text-sm text-muted">
              {`Importing ${formatCount(summary.rows)} rows, in batches of up to 2,000. Keep this page open until it finishes.`}
            </p>
          ) : null}
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <DiscardControl importId={data.importId} />
        <p className="text-sm text-muted">Discarding deletes the uploaded file and everything read from it.</p>
      </div>
    </div>
  );
}

const reportKeyOf = (m: AdjustmentMapping | null) => (m ? stable(m) : null);

/** The stateful page: owns the mapping on screen, the statement, the latest report and what is running. */
export function ImportWizard(p: Omit<WizardData, "detectionProblem"> & { detectionProblem: string | null; storedMapping: AdjustmentMapping | null; storedReport: AdjustmentValidationReport | null }) {
  const prefix = useId();
  const initial = p.storedMapping ?? p.detection?.suggestion ?? null;
  const [mapping, setMapping] = useState<AdjustmentMapping | null>(initial);
  const [savedKey, setSavedKey] = useState<string | null>(p.storedMapping ? reportKeyOf(p.storedMapping) : null);
  const [reportKey, setReportKey] = useState<string | null>(p.storedReport ? reportKeyOf(p.storedMapping) : null);
  const [report, setReport] = useState<AdjustmentValidationReport | null>(p.storedReport);
  const [status, setStatus] = useState<ImportStatusKey>(p.status);
  const [attested, setAttested] = useState(false);
  const [phase, setPhase] = useState<WizardPhase>("idle");
  const [error, setError] = useState<{ message: string; attempt: number } | null>(null);
  const [committed, setCommitted] = useState<WizardState["committed"]>(null);
  const [, start] = useTransition();
  // Where the file cannot settle it, the person must choose: no silent default for an ambiguous date format or an unstated weight unit.
  const dateNeeded = !!p.detection?.dateFormatAmbiguous && !p.storedMapping;
  const unitNeeded = !!p.detection?.weightUnitMustBeChosen && !p.storedMapping;
  const [dateChosen, setDateChosen] = useState(!dateNeeded);
  const [unitChosen, setUnitChosen] = useState(!unitNeeded);
  const attempts = useRef(0);
  const reportHeading = `${prefix}-${REPORT_HEADING_SUFFIX}`;
  const focusReport = useRef(false);

  useEffect(() => {
    if (!focusReport.current || !report) return;
    focusReport.current = false;
    // The report sits below the mapping, which is long on a phone: bring it into view and hand it focus.
    requestAnimationFrame(() => {
      const heading = document.getElementById(reportHeading);
      heading?.scrollIntoView({ block: "start" });
      heading?.focus();
    });
  }, [report, reportHeading]);

  const fail = (message: string) => {
    attempts.current += 1;
    setError({ message, attempt: attempts.current });
  };

  const key = reportKeyOf(mapping);
  const stale = report !== null && reportKey !== key;

  // A different mapping may read a different column as an amount, so the statement is made again before the next check.
  const onMapping = (m: AdjustmentMapping) => {
    setError(null);
    setAttested(false);
    setMapping(m);
  };

  const onCheck = () => {
    if (!mapping) return;
    setError(null);
    setPhase("checking");
    start(async () => {
      try {
        // The check reads what is SAVED, so a mapping that is not saved yet (or has changed) is saved first.
        if (savedKey !== key) {
          const saved = await saveImportMapping(p.importId, mapping);
          if (!saved.ok) {
            fail(saved.message ?? GENERIC_FAILURE);
            return;
          }
          setSavedKey(key);
          if (saved.status === "mapped") setStatus("mapped");
        }
        const result = await validateImport(p.importId, true);
        if (result.report) {
          setReport(result.report);
          setReportKey(key);
          focusReport.current = true;
        }
        if (result.status === "validated" || result.status === "mapped" || result.status === "uploaded") setStatus(result.status);
        // A report with rows to fix is shown in the report itself; any other refusal is said here.
        if (!result.ok && !result.report) fail(result.message ?? GENERIC_FAILURE);
      } catch {
        fail(GENERIC_FAILURE);
      } finally {
        setPhase("idle");
      }
    });
  };

  const onImport = async () => {
    setError(null);
    setPhase("importing");
    try {
      const result = await commitImport(p.importId);
      if (!result.ok) return { ok: false, message: result.message ?? GENERIC_FAILURE };
      const rows = result.committed ?? report?.counts.accepted ?? 0;
      setCommitted({
        importId: p.importId,
        name: p.name,
        committedCount: rows,
        skippedCount: result.skipped ?? 0,
        committedAt: new Date().toISOString().slice(0, 10),
        shipDateFrom: report?.shipDateRange.min ?? null,
        shipDateTo: report?.shipDateRange.max ?? null,
        message: result.message ?? null,
      });
      return { ok: true };
    } catch {
      return { ok: false, message: GENERIC_FAILURE };
    } finally {
      setPhase("idle");
    }
  };

  const data: WizardData = { importId: p.importId, name: p.name, status, canManage: p.canManage, detection: p.detection, detectionProblem: p.detectionProblem, sampleRows: p.sampleRows, brands: p.brands, catalog: p.catalog, rowCount: p.rowCount };
  const state: WizardState = { mapping, attested, phase, error, report, stale, dateUnchosen: !dateChosen, unitUnchosen: !unitChosen, committed };
  return (
    <WizardFocus when={committed !== null}>
      <ImportWizardView
        data={data}
        state={state}
        handlers={{ onMapping, onAttest: setAttested, onCheck, onImport, onChooseDate: () => setDateChosen(true), onChooseUnit: () => setUnitChosen(true) }}
        ids={{ prefix }}
      />
    </WizardFocus>
  );
}

/** Moves focus to the wrapper when `when` turns true, so the finished import is announced where the person is. */
function WizardFocus({ when, children }: { when: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (when) ref.current?.focus();
  }, [when]);
  return (
    <div ref={ref} tabIndex={-1} className="outline-none">
      {children}
    </div>
  );
}
