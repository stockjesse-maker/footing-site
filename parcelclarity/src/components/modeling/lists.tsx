import Link from "next/link";
import { archiveScenario, shareDataset, shareScenario } from "@/app/actions/modeling";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { formatMoney } from "@/components/pricing/calculation-result";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/format/date";
import type { DatasetListRow, ProjectListRow, RunListRow } from "@/lib/modeling/queries";

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

export function ScenarioList({ projects, basePath, brandId, staff, compareHref }: { projects: ProjectListRow[]; basePath: string; brandId?: string; staff: boolean; compareHref?: string }) {
  if (!projects.length) return <EmptyState title="No saved scenarios yet">Price a shipment and save it, or run a model on an orders file.</EmptyState>;
  return (
    <ul className="divide-y divide-line rounded-card border border-line bg-raised">
      {projects.map((p) => {
        const run = p.simulation_runs[0];
        const state = run ? runStateLabel(run) : null;
        const href = run ? `${basePath}/runs/${run.id}` : `${basePath}`;
        return (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <Link href={href} className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
                {p.name}
              </Link>
              <p className="text-sm text-muted">
                {p.kind === "single" ? "Single shipment" : "Orders file"} · {p.rate_cards?.name ?? "rate card"} · {formatDate(p.created_at)}
                {run?.status === "completed" && run.kind === "bulk" && run.modeled_orders !== null && run.summary
                  ? run.modeled_orders > 0
                    ? ` · estimated ${formatMoney({ amount: String(run.total_expected ?? "0.00"), currency: "USD" })} for ${run.modeled_orders.toLocaleString("en-US")} of ${run.summary.imported.orders.toLocaleString("en-US")} orders`
                    : " · no orders could be priced"
                  : ""}
                {staff && !p.shared_with_brand ? " · private to your team" : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
              {compareHref && run?.status === "completed" && run.kind === "bulk" ? (
                <Link href={`${compareHref}?a=${run.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline sm:min-h-9">
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
