import Link from "next/link";
import { archiveScenario, shareDataset, shareScenario } from "@/app/actions/modeling";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { formatMoney } from "@/components/pricing/calculation-result";
import type { BulkSummary } from "@/engine/modeling/types";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Stat } from "@/components/ui/stat";
import { formatDate } from "@/lib/format/date";
import { defaultView, endSentence, headlineFigures, headlineReason, headlineText, monthlyCharges, usd, type HeadlineAudience, type HeadlineSummary } from "@/lib/modeling/headline";
import { fileSummaryOf, forecastSummaryOf, latestCompletedBulkRun, latestCompletedForecast, latestCompletedWhatIf, type DatasetListRow, type ProjectListRow, type RunListRow } from "@/lib/modeling/queries";

/** Lists shared by the customer portal and the 3PL's on-behalf view. */

const DATASET_STATUS: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  uploaded: { label: "Needs review", tone: "warning" },
  mapped: { label: "Needs fixes", tone: "warning" },
  validated: { label: "Checked", tone: "accent" },
  materialising: { label: "Preparing", tone: "accent" },
  ready: { label: "Ready", tone: "success" },
  discarded: { label: "Discarded", tone: "neutral" },
};

export function runStateLabel(run: RunListRow, now = Date.now()): { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" } {
  if (run.status === "running") {
    const stale = now - new Date(run.last_progress_at).getTime() > 2 * 60_000;
    return stale ? { label: "Paused · open to continue", tone: "warning" } : { label: "Pricing…", tone: "accent" };
  }
  if (run.status === "completed") return { label: "Done", tone: "success" };
  if (run.status === "failed") return { label: "Could not finish", tone: "danger" };
  if (run.status === "cancelled") return { label: "Cancelled", tone: "neutral" };
  return { label: run.status, tone: statusTone(run.status) };
}

export function DatasetList({ datasets, basePath, brandId, staff }: { datasets: DatasetListRow[]; basePath: string; brandId?: string; staff: boolean }) {
  if (!datasets.length) return <EmptyState title="No orders files yet">Upload an orders file to model what a month of real orders would cost.</EmptyState>;
  return (
    <ul className="divide-y divide-line rounded-card border border-line bg-raised">
      {datasets.map((d) => {
        const s = DATASET_STATUS[d.status] ?? { label: d.status, tone: "neutral" as const };
        return (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <Link href={`${basePath}/orders/${d.id}`} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
                {d.name}
              </Link>
              <p className="text-sm text-muted">
                {formatDate(d.created_at)}
                {d.status === "ready" ? ` · ${d.order_count.toLocaleString("en-US")} orders · ${d.shipment_count.toLocaleString("en-US")} shipments · ${d.package_count.toLocaleString("en-US")} packages` : ""}
                {staff && !d.shared_with_brand ? " · private to your team" : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={s.tone}>{s.label}</Badge>
              {staff && brandId && d.status === "ready" ? (
                <ConfirmAction action={shareDataset.bind(null, d.id, !d.shared_with_brand, brandId)} label={d.shared_with_brand ? "Hide from customer" : "Share with customer"} confirmLabel={d.shared_with_brand ? "Hide" : "Share"} variant="ghost" />
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const KIND_BADGE: Record<ProjectListRow["kind"], { label: string; tone: "neutral" | "accent" | "success" }> = {
  single: { label: "Single shipment", tone: "neutral" },
  bulk: { label: "Orders file", tone: "accent" },
  forecast: { label: "Forecast", tone: "success" },
};

/** What the headline says for a run, in one line: "All-in cost per order, without storage: At least $26.94". */
export function headlineLine(summary: HeadlineSummary, audience: HeadlineAudience = "brand"): string {
  const h = headlineFigures(summary, defaultView(summary), {}, audience);
  return `${h.label}: ${headlineText(h)}`;
}

function runSummaryLine(project: ProjectListRow, run: RunListRow, audience: HeadlineAudience): string {
  if (run.status !== "completed") return "";
  const forecast = forecastSummaryOf(run);
  if (forecast) return ` · Forecast at ${Number(forecast.monthlyOrders).toLocaleString("en-US")} orders a month · ${headlineLine(forecast, audience)}`;
  if (run.kind !== "bulk" || run.modeled_orders === null || !run.summary) return "";
  if (run.modeled_orders === 0) return " · no orders could be priced";
  const file = fileSummaryOf(run);
  // A model priced before fulfillment fees existed keeps its shipping line and says so.
  if (!file) return ` · estimated ${formatMoney({ amount: String(run.total_expected ?? "0.00"), currency: "USD" })} shipping for ${run.modeled_orders.toLocaleString("en-US")} orders (priced before fulfillment fees; run it again to add them)`;
  // An all-in figure carries monthly charges spread over orders, so the line prints the volume and period it was spread over.
  const h = headlineFigures(file, defaultView(file), {}, audience);
  const basis = h.view === "allin" && h.amount !== null ? ` · ${h.basisSentence}` : "";
  return ` · ${h.label}: ${headlineText(h)}${basis} · ${run.modeled_orders.toLocaleString("en-US")} of ${file.imported.orders.toLocaleString("en-US")} orders`;
}

export function ScenarioList({ projects, basePath, brandId, staff, compareHref }: { projects: ProjectListRow[]; basePath: string; brandId?: string; staff: boolean; compareHref?: string }) {
  if (!projects.length) return <EmptyState title="No saved scenarios yet">Price a shipment and save it, run a model on an orders file, or forecast from your assumptions.</EmptyState>;
  const audience: HeadlineAudience = staff ? "staff" : "brand";
  return (
    <ul className="divide-y divide-line rounded-card border border-line bg-raised">
      {projects.map((p) => {
        const run = p.simulation_runs[0];
        const state = run ? runStateLabel(run) : null;
        const href = p.kind === "forecast" ? `${basePath}/forecast/${p.id}` : run ? `${basePath}/runs/${run.id}` : `${basePath}`;
        const badge = KIND_BADGE[p.kind];
        return (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <Link href={href} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
                {p.name}
              </Link>
              <p className="text-sm text-muted">
                <Badge tone={badge.tone} className="mr-2 align-middle">
                  {badge.label}
                </Badge>
                {p.rate_cards?.name ?? "rate card"} · {formatDate(p.created_at)}
                {run ? runSummaryLine(p, run, audience) : ""}
                {staff && !p.shared_with_brand ? " · private to your team" : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
              {compareHref && run?.status === "completed" && (run.kind === "bulk" || run.kind === "forecast") ? (
                <Link href={`${compareHref}?a=${run.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline">
                  Compare
                </Link>
              ) : null}
              {staff && brandId ? <ConfirmAction action={shareScenario.bind(null, p.id, !p.shared_with_brand, brandId)} label={p.shared_with_brand ? "Hide from customer" : "Share with customer"} confirmLabel={p.shared_with_brand ? "Hide" : "Share"} variant="ghost" /> : null}
              <ConfirmAction action={archiveScenario.bind(null, p.id, brandId)} label="Archive" confirmLabel="Archive" variant="ghost">
                Hidden from lists; its results are kept.
              </ConfirmAction>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Tiles for the hub, the overview and the customer page
// ---------------------------------------------------------------------------
/**
 * The figures of one file run: the headline with its completeness label and the reason it is not the plain
 * all-in figure, then shipping, order fees and monthly charges. Every figure is from the stored summary, so
 * all tiles describe the same run and the same orders.
 */
export function ModelTiles({ summary, audience = "brand" }: { summary: BulkSummary; audience?: HeadlineAudience }) {
  const allIn = headlineFigures(summary, "allin", {}, audience);
  const shipping = headlineFigures(summary, "shipping", {}, audience);
  const fees = headlineFigures(summary, "fees", {}, audience);
  const monthly = monthlyCharges(summary);
  const reason = headlineReason(allIn);
  // A schedule with no monthly charges is a known absence ("None"), not a missing number; charges left out make the figure a lower bound.
  const noMonthlyCharges = !!monthly && monthly.lines.length === 0 && monthly.notModeled.length === 0;
  const monthlyLeftOut = !!monthly && monthly.notModeled.length > 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label={allIn.label}
        value={headlineText(allIn)}
        note={
          allIn.complete || allIn.amount === null ? (
            (allIn.complete ? allIn.basisSentence : (reason ?? allIn.basisSentence))
          ) : (
            <>
              {reason}
              <span className="block">{allIn.basisSentence}</span>
            </>
          )
        }
      />
      <Stat label={shipping.label} value={headlineText(shipping)} note={shipping.basisSentence} />
      <Stat label={fees.label} value={headlineText(fees)} note={fees.amount === null ? fees.unavailable : fees.basisSentence} />
      <Stat
        label="Monthly charges"
        value={noMonthlyCharges ? "None" : monthly && monthly.totalPerMonth !== null ? `${monthlyLeftOut ? "At least " : ""}${usd(monthly.totalPerMonth)} a month` : "Not computed"}
        note={
          noMonthlyCharges
            ? "The fee schedule has no monthly charges."
            : monthly
              ? monthly.perOrder !== null
                ? `${monthlyLeftOut ? "at least " : ""}about ${usd(monthly.perOrder)} per order, spread over your orders (${monthly.basisSentence})`
                : monthly.basisSentence
              : "Fulfillment costs were not modeled for this run."
        }
      />
    </div>
  );
}

function ForecastTile({ project, run, basePath, audience }: { project: ProjectListRow; run: RunListRow; basePath: string; audience: HeadlineAudience }) {
  const summary = forecastSummaryOf(run);
  if (!summary) return null;
  const view = defaultView(summary);
  const h = headlineFigures(summary, view, {}, audience);
  return (
    <Stat
      label={`Forecast from assumptions: ${h.label}`}
      value={headlineText(h)}
      note={
        <>
          {endSentence(h.basisSentence)}{" "}
          <Link href={`${basePath}/forecast/${project.id}`} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            {project.name}
          </Link>
          <span className="block">Expected values over the mix you described, never an invoice.</span>
        </>
      }
    />
  );
}

function WhatIfTile({ project, run, basePath, audience }: { project: ProjectListRow; run: RunListRow; basePath: string; audience: HeadlineAudience }) {
  const summary = fileSummaryOf(run);
  if (!summary) return null;
  const h = headlineFigures(summary, defaultView(summary), {}, audience);
  return (
    <Stat
      label={`What-if${run.shipping_services?.name ? ` on ${run.shipping_services.name}` : ""}: ${h.label}`}
      value={headlineText(h)}
      note={
        <>
          Every shipment priced on {run.shipping_services?.name ?? "the chosen service"}.{" "}
          <Link href={`${basePath}/runs/${run.id}`} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            {project.name}
          </Link>
        </>
      }
    />
  );
}

/** The models an overview draws on: the latest baseline file run, and the latest forecast and what-if as their own tiles. */
export function overviewModels(projects: ProjectListRow[]) {
  return { latest: latestCompletedBulkRun(projects, { excludeWhatIf: true }), forecast: latestCompletedForecast(projects), whatIf: latestCompletedWhatIf(projects) };
}

/**
 * Overview figures: all of them from one run (the latest completed orders-file run that is not a what-if),
 * with its completeness label and reason; forecasts and what-ifs are separate, labelled tiles and are never
 * mixed into those figures.
 */
export function OverviewFigures({ projects, basePath, tenantName, audience }: { projects: ProjectListRow[]; basePath: string; tenantName: string; audience: HeadlineAudience }) {
  const { latest, forecast, whatIf } = overviewModels(projects);
  const summary = latest ? fileSummaryOf(latest.run) : null;
  return (
    <>
      {latest && summary ? (
        <section className="space-y-3" aria-labelledby="overview-latest">
          <h2 id="overview-latest" className="text-xl font-semibold tracking-tight">
            From your latest model
          </h2>
          <ModelTiles summary={summary} audience={audience} />
          <p className="text-sm text-muted">
            <Link href={`${basePath}/runs/${latest.run.id}`} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
              {latest.project.name}
            </Link>
            {latest.run.finished_at ? ` · priced ${formatDate(latest.run.finished_at)}` : ""} · estimates {audience === "brand" ? `from the rates and fee schedule ${tenantName} assigned to you` : "from the rates and fee schedule assigned to this customer"}, never an invoice.
          </p>
        </section>
      ) : null}
      {forecast || whatIf ? (
        <section className="mt-8 space-y-3" aria-labelledby="overview-other">
          <h2 id="overview-other" className="text-xl font-semibold tracking-tight">
            Forecasts and what-ifs
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {forecast ? <ForecastTile project={forecast.project} run={forecast.run} basePath={basePath} audience={audience} /> : null}
            {whatIf ? <WhatIfTile project={whatIf.project} run={whatIf.run} basePath={basePath} audience={audience} /> : null}
          </div>
        </section>
      ) : null}
    </>
  );
}

export function HubCard({ title, description, href, cta }: { title: string; description: string; href: string; cta: string }) {
  return (
    <Card className="flex flex-col gap-3">
      <div>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
      <Link href={href} className="inline-flex min-h-11 items-center self-start font-medium text-accent-text hover:underline">
        {cta} →
      </Link>
    </Card>
  );
}
