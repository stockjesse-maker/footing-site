import { NextResponse, type NextRequest } from "next/server";
import type { BulkSummary } from "@/engine/modeling/types";
import { getContext, getUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { uuidSchema } from "@/lib/auth/validation";
import { MONTHLY_CSV_COLUMNS, feeScheduleLine, monthlyCsv } from "@/lib/modeling/headline";
import { fileSummaryOf } from "@/lib/modeling/queries";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

/**
 * Monthly charges of a completed fee-aware run: every monthly charge with its quantity, rate, amount, class
 * (from the rate card or based on assumptions) and status, a charge with no number given listed as not
 * modeled with its rate, then the account minimum month by month. The period and volume the charges are
 * spread over are in the header comments. Monthly charges never appear as per-order amounts here or in
 * orders.csv. Same sign-in, scoping and audit as the other exports; customer-facing wording only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const user = await getUser();
  const ctx = user ? await getContext() : null;
  if (!ctx || !can(ctx.active.role, "simulation.run") || !uuidSchema.safeParse(runId).success) return new NextResponse("Not found", { status: 404 });
  const supabase = await createClient();
  const { data: run } = await supabase.from("simulation_runs").select("id, tenant_id, brand_id, status, kind, summary, simulation_projects(name, rate_cards(name))").eq("id", runId).maybeSingle();
  if (!run || run.tenant_id !== ctx.active.tenantId || run.status !== "completed" || run.kind !== "bulk") return new NextResponse("Not found", { status: 404 });
  if (ctx.active.portal === "brand" && run.brand_id !== ctx.active.brandId) return new NextResponse("Not found", { status: 404 });
  const brandParam = request.nextUrl.searchParams.get("brandId");
  if (ctx.active.portal === "tenant" && brandParam && brandParam !== run.brand_id) return new NextResponse("Not found", { status: 404 });
  const summary: BulkSummary | null = fileSummaryOf({ kind: "bulk", summary: run.summary as BulkSummary | null });
  if (!summary) return new NextResponse("Not found", { status: 404 });
  const project = run.simulation_projects as unknown as { name: string; rate_cards: { name: string } | null } | null;

  const { error: auditError } = await supabase.rpc("log_audit_event", {
    p_tenant: run.tenant_id,
    p_brand: run.brand_id,
    p_action: "export.run_monthly",
    p_entity_type: "simulation_run",
    p_entity_id: runId,
    p_metadata: { kind: "monthly_csv" },
  });
  if (auditError) return new NextResponse("Export unavailable", { status: 503 });

  const csv = monthlyCsv(summary, {
    scenarioName: project?.name ?? "model",
    rateCardName: project?.rate_cards?.name ?? "your rate card",
    feeScheduleLine: feeScheduleLine(ctx.active.tenantName, summary.provenance),
    audience: ctx.active.portal === "tenant" ? "staff" : "brand",
  });
  const body = [...csv.comments, MONTHLY_CSV_COLUMNS.join(","), ...csv.rows.map((r) => r.join(","))].join("\r\n");
  return new NextResponse(`${body}\r\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="parcelclarity-monthly-${runId.slice(0, 8)}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
