import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { loadOverview } from "@/lib/adjustments/queries";
import { createClient } from "@/lib/supabase/server";
import { BASIS_LABELS, PRIVATE_NOTICE, formatCount, formatIsoDate } from "@/lib/adjustments/staff-copy";

/** What the tile on the account overview shows: counts and one name, never a money figure. */
export interface TileData {
  undecided: number;
  cells: number;
  sharedExamples: number;
  latestEstimate: { name: string; basis: "declared_weights" | "actual_weights" | null; createdAt: string } | null;
}

export type TileState = { kind: "ok"; data: TileData } | { kind: "failed" };

/** The estimate's basis in words, so it is never read as a forecast of the whole shipping bill. */
export const estimateBasisText = (basis: "declared_weights" | "actual_weights" | null): string => (basis ? (BASIS_LABELS[basis] ?? "Basis not recorded") : "Basis not recorded");

export function AdjustmentsTileView({ state }: { state: TileState }) {
  return (
    <Card role="region" aria-labelledby="adjustments-tile-heading" className="mt-6">
      <CardTitle id="adjustments-tile-heading">Adjustments</CardTitle>
      <CardDescription>Who pays when a package&apos;s weight or size is corrected after it was labelled. {PRIVATE_NOTICE}</CardDescription>
      {state.kind === "failed" ? (
        <Alert tone="danger" className="mt-4">
          The adjustments summary could not be loaded. Reload the page to try again.
        </Alert>
      ) : (
        <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted">Decisions not made yet</dt>
            <dd className="tabular text-lg font-semibold">{`${formatCount(state.data.undecided)} of ${formatCount(state.data.cells)}`}</dd>
            <dd className="text-sm text-muted">{state.data.undecided === 0 ? "Every decision for all customers is made." : "Shown as Not decided on the Policies tab."}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Examples shared with customers</dt>
            <dd className="tabular text-lg font-semibold">{formatCount(state.data.sharedExamples)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-sm text-muted">Latest saved estimate</dt>
            {state.data.latestEstimate ? (
              <>
                <dd className="font-semibold [overflow-wrap:anywhere]">{state.data.latestEstimate.name}</dd>
                <dd className="text-sm text-muted">{`${estimateBasisText(state.data.latestEstimate.basis)}, saved ${formatIsoDate(state.data.latestEstimate.createdAt)}`}</dd>
              </>
            ) : (
              <dd className="text-lg font-semibold">None saved</dd>
            )}
          </div>
        </dl>
      )}
      <p className="mt-4">
        <Link href="/app/adjustments" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          Open adjustments
        </Link>
      </p>
    </Card>
  );
}

/**
 * The tile on /app, for people who hold adjustment.view and nobody else (it renders nothing otherwise, so a hidden tile is never the
 * security: the data is read through the caller's own Row Level Security and loadOverview names the session's workspace).
 */
export async function AdjustmentsTile() {
  const ctx = await requireTenantContext();
  if (!can(ctx.active.role, "adjustment.view")) return null;
  let state: TileState;
  try {
    const o = await loadOverview(await createClient(), ctx.active.tenantId);
    const latest = o.estimates.latest;
    state = {
      kind: "ok",
      data: {
        undecided: o.policies.undecided,
        cells: o.policies.cells,
        sharedExamples: o.examples.live,
        latestEstimate: latest ? { name: latest.name, basis: latest.basis, createdAt: latest.createdAt } : null,
      },
    };
  } catch {
    // A failed load is a failure, never "nothing decided" or "no examples".
    state = { kind: "failed" };
  }
  return <AdjustmentsTileView state={state} />;
}
