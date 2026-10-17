import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription } from "@/components/ui/card";
import type { ConfidenceLevel, DirectionGroup, HistoryStatistics, SeverityStat } from "@/engine/adjustments/types";
import {
  CONFIDENCE_LABELS,
  DIRECTION_HELP,
  DIRECTION_LABELS,
  NOTES_PRINTED_ELSEWHERE,
  NOTE_TEXT,
  PER_RECORD_NOTE,
  RANGE_SENTENCE,
  STATS_NO_BASELINE,
  STATS_NO_BASELINE_HINT,
  STATS_TITLE,
  formatCount,
  formatPct,
  pluralize,
} from "@/lib/adjustments/staff-copy";
import { DIRECTION_ORDER, amountText, directionLine, maturityWarning, severityRow } from "./stats-model";

const CONFIDENCE_TONE: Record<ConfidenceLevel, "neutral" | "warning" | "accent" | "success"> = { none: "neutral", low: "warning", moderate: "accent", adequate: "success" };

/** Confidence is a word and a badge, never a colour alone. */
function Confidence({ level, what }: { level: ConfidenceLevel; what: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">{what}</span>
      <Badge tone={CONFIDENCE_TONE[level]}>{`${CONFIDENCE_LABELS[level]} confidence`}</Badge>
    </p>
  );
}

function Figure({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="tabular text-[15px] font-semibold [overflow-wrap:anywhere]">{children}</dd>
      {note ? <dd className="text-xs text-muted">{note}</dd> : null}
    </div>
  );
}

function SeverityBlock({ title, stat, id }: { title: string; stat: SeverityStat; id: string }) {
  const row = severityRow(stat);
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h4 id={id} className="text-sm font-semibold">
        {title}
      </h4>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
        <Figure label="Records with an amount">{formatCount(row.n)}</Figure>
        <Figure label="Average">{row.mean}</Figure>
        <Figure label="Middle value">{row.median}</Figure>
        {row.p90 !== null ? <Figure label="9 in 10 are at or below">{row.p90}</Figure> : null}
        {row.largest !== null ? <Figure label="Largest">{row.largest}</Figure> : null}
      </dl>
    </section>
  );
}

/**
 * What the imported history shows for the chosen filters. Incidence appears only when typed packages-shipped figures cover the window;
 * without them the screen says so and shows averages only. A figure that could not be computed reads "Not computed", never $0.00.
 * Everything here is private to the 3PL's team.
 */
export function StatisticsView({ stats, scopeName, headingId }: { stats: HistoryStatistics; scopeName: string; headingId: string }) {
  const warn = maturityWarning(stats);
  const unit = stats.perRecordCounting ? "adjustment records" : "packages";
  const printed = new Set(NOTES_PRINTED_ELSEWHERE);
  const otherNotes = stats.notes.filter((n) => !printed.has(n) && NOTE_TEXT[n]);
  const inc = stats.incidence;
  const groups = DIRECTION_ORDER;

  return (
    <section aria-labelledby={headingId} className="space-y-6" data-testid="statistics-result">
      <div>
        <h2 id={headingId} tabIndex={-1} className="scroll-mt-4 text-xl font-semibold tracking-tight">
          {STATS_TITLE}
        </h2>
        <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">
          {`${scopeName}. ${pluralize(stats.recordsInScope, "adjustment record")} match; ${formatCount(stats.affected)} ${stats.affected === 1 ? (stats.perRecordCounting ? "adjustment record" : "package") : unit} adjusted.`}
        </p>
      </div>

      {warn ? (
        <Alert tone="warning" title="This period may not be complete">
          {warn}
        </Alert>
      ) : null}

      {stats.recordsInScope === 0 ? (
        <Alert tone="info">No adjustment records match these filters. Change the filters, or import more history.</Alert>
      ) : null}

      <Card role="region" aria-labelledby={`${headingId}-often`}>
        <h3 id={`${headingId}-often`} className="text-base font-semibold">
          How often
        </h3>
        {inc ? (
          <div className="mt-3 space-y-3">
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
              <Figure label="Adjusted" note={`${formatCount(inc.k)} of ${formatCount(inc.N)} ${unit === "packages" ? "packages shipped" : "packages shipped (counted per record)"}`}>
                {formatPct(inc.pct4dp)}
              </Figure>
              <Figure label="Range">{`${formatPct(inc.wilson.lowerPct4dp)} to ${formatPct(inc.wilson.upperPct4dp)}`}</Figure>
              <div className="min-w-0">
                <dt className="text-sm text-muted">Packages shipped in these periods</dt>
                <dd className="tabular text-[15px] font-semibold">{stats.baseline.packagesTotal === null ? "Not computed" : formatCount(stats.baseline.packagesTotal)}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted">{RANGE_SENTENCE}</p>
            <Confidence level={stats.confidence.incidence} what="How much to trust how often:" />
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="font-medium">{STATS_NO_BASELINE}</p>
            <p className="text-sm text-muted">{STATS_NO_BASELINE_HINT}</p>
            <Link href="/app/adjustments/history/baselines" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
              Add packages shipped
            </Link>
          </div>
        )}
        {stats.baseline.outsideWindowCount > 0 ? (
          <p className="mt-3 text-sm text-muted">{`${pluralize(stats.baseline.outsideWindowCount, "packages-shipped period")} ${stats.baseline.outsideWindowCount === 1 ? "does" : "do"} not lie wholly inside the window, so ${stats.baseline.outsideWindowCount === 1 ? "it is" : "they are"} not used.`}</p>
        ) : null}
        {stats.excludedOutsideBaseline > 0 ? (
          <p className="mt-2 text-sm text-muted">{`${pluralize(stats.excludedOutsideBaseline, "adjustment record")} ${stats.excludedOutsideBaseline === 1 ? "falls" : "fall"} outside the periods you gave packages shipped for, so ${stats.excludedOutsideBaseline === 1 ? "it is" : "they are"} left out of how often.`}</p>
        ) : null}
        {stats.perRecordCounting ? <p className="mt-2 text-sm text-muted">{PER_RECORD_NOTE}</p> : null}
      </Card>

      {inc && stats.incidenceByDirection ? (
        <section aria-labelledby={`${headingId}-direction`} className="space-y-2">
          <h3 id={`${headingId}-direction`} className="text-base font-semibold">
            By direction
          </h3>
          <ul className="grid gap-3 sm:grid-cols-2">
            {groups.map((g: DirectionGroup) => (
              <li key={g} className="rounded-card border border-line bg-raised p-4">
                <p className="font-medium">{DIRECTION_LABELS[g]}</p>
                <p className="tabular mt-0.5 text-[15px]">{directionLine(stats, g)}</p>
                <p className="mt-1 text-sm text-muted">{DIRECTION_HELP[g]}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Card role="region" aria-labelledby={`${headingId}-adds`}>
        <h3 id={`${headingId}-adds`} className="text-base font-semibold">
          What an adjustment adds
        </h3>
        <CardDescription>Amounts are what your customer was charged, from the history you imported. Credits are shown separately and never reduce what a risk estimate counts.</CardDescription>
        <div className="mt-4 space-y-6">
          <SeverityBlock id={`${headingId}-post`} title="Shipping charge difference, charges only" stat={stats.severity.increase.postage} />
          <SeverityBlock id={`${headingId}-fee`} title="Separate adjustment fee, on charges" stat={stats.severity.increase.fee} />
          <div className="grid gap-x-8 gap-y-3 border-t border-line pt-4 sm:grid-cols-2">
            <div>
              <p className="text-sm font-semibold">Charges only</p>
              <p className="tabular text-[15px]">
                {amountText(stats.chargesOnly.meanE4)} <span className="text-sm font-normal text-muted">{`average of ${pluralize(stats.chargesOnly.n, "record")}`}</span>
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold">Net of credits</p>
              <p className="tabular text-[15px]">
                {amountText(stats.netOfCredits.meanE4)} <span className="text-sm font-normal text-muted">{`average of ${pluralize(stats.netOfCredits.n, "record")}`}</span>
              </p>
              <p className="text-xs text-muted">A memo that assumes credits are returned to the customer. It is not used in an estimate.</p>
            </div>
          </div>
          {stats.severity.decrease.postage.n > 0 || stats.severity.decrease.fee.n > 0 ? (
            <SeverityBlock id={`${headingId}-credit`} title="Credits (the corrected charge is lower)" stat={stats.severity.decrease.postage} />
          ) : null}
          <div className="space-y-1 border-t border-line pt-4">
            <Confidence level={stats.confidence.postage} what="Shipping charge difference:" />
            <Confidence level={stats.confidence.fee} what="Separate adjustment fee:" />
          </div>
          {stats.topRecordOver25Pct.postage ? <p className="text-sm text-muted">One record is more than a quarter of the shipping charge differences, so the average moves a lot with that one record.</p> : null}
          {stats.topRecordOver25Pct.fee ? <p className="text-sm text-muted">One record is more than a quarter of the separate adjustment fees, so the average moves a lot with that one record.</p> : null}
        </div>
      </Card>

      {stats.missingRatePct !== null || stats.labelsMissingWeight !== null ? (
        <Card role="region" aria-labelledby={`${headingId}-weights`}>
          <h3 id={`${headingId}-weights`} className="text-base font-semibold">
            Labels printed without a weight
          </h3>
          <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-3">
            {stats.labelsMissingWeight !== null ? <Figure label="Labels without a weight">{formatCount(stats.labelsMissingWeight)}</Figure> : null}
            {stats.missingRatePct !== null ? <Figure label="Share of packages shipped">{formatPct(stats.missingRatePct)}</Figure> : null}
            {stats.correctionRatePct !== null ? (
              <Figure label="Of those, corrected later" note={stats.wmsNoWeightAffected !== null ? `${pluralize(stats.wmsNoWeightAffected, "package")}` : undefined}>
                {formatPct(stats.correctionRatePct)}
              </Figure>
            ) : null}
          </dl>
        </Card>
      ) : null}

      {otherNotes.length ? (
        <ul className="space-y-1 text-sm text-muted">
          {otherNotes.map((n) => (
            <li key={n}>{NOTE_TEXT[n]}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
